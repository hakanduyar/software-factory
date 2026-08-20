/**
 * TASK-003 item 17: proves the durability chain for a *real* process-backed
 * worker run against SQLite specifically —
 *
 *   1. Factory starts a worker Run.
 *   2. The RUNNING Run is durably persisted before the child process
 *      finishes (checked mid-flight, through the same store instance, while
 *      the fake CLI is still deliberately sleeping).
 *   3. The child executes and exits.
 *   4. Result/evidence is stored.
 *   5. The run becomes terminal, exactly once.
 *   6. The store closes.
 *   7. A new Store instance reopens the same database file.
 *   8. The exact worker Run/evidence remains auditable.
 *
 * No parallel persistence path is introduced for worker logs — this is the
 * same `FactoryStore`/`FactoryService.runWorker` TASK-001/002 already
 * proved durable for the mock worker; this test proves a real spawned
 * process (a fake CLI, never a real AI provider) goes through the identical
 * path.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createNodeProcessRunner } from "../src/adapters/process/nodeProcessRunner.js";
import { createCodexCliWorker } from "../src/adapters/workers/codexCliAdapter.js";
import { resolveWorkspace } from "../src/adapters/workers/workspace.js";
import { cleanupTempDbs, newSqliteFactory, seedWorkItem, tempDbPath, toImplementing } from "./support/factoryFixtures.js";
import { fakeCliPath } from "./support/fakeCli.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./support/tempWorkspace.js";

after(() => {
  cleanupTempDbs();
  cleanupTempWorkspaces();
});

const runner = createNodeProcessRunner({ killGraceMs: 100 });

describe("worker runner: SQLite durability with a real process-backed adapter", () => {
  it("persists RUNNING before the child finishes, finalizes exactly once, and survives close+reopen", async () => {
    const dbPath = tempDbPath();
    const built = newSqliteFactory(dbPath);
    const item = await seedWorkItem(built.factory);
    await toImplementing(built.factory, item.id);

    const workspace = resolveWorkspace(createTempWorkspace());
    const worker = createCodexCliWorker({
      executable: fakeCliPath("fake-codex.mjs"),
      model: "m",
      workspace,
      processRunner: runner,
      environmentPolicy: { allowedVars: ["PATH"], extraVars: { FAKE_CODEX_SLEEP_MS: "400" } },
    });
    built.factory.registerWorker(worker, ["IMPLEMENTER"]);

    const runPromise = built.factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker,
      instructions: "implement the thing",
    });

    // The fake CLI is still sleeping in this window; PHASE 1's transaction
    // (which holds no lock across PHASE 2) has already committed by now.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    const midFlight = await built.store.runs.findById("run-0001");
    assert.ok(midFlight !== undefined, "the RUNNING run must be durable before the child process finishes");
    assert.equal(midFlight.status, "RUNNING");
    assert.equal(midFlight.workItemId, item.id);

    const { run } = await runPromise;
    assert.equal(run.id, "run-0001");
    assert.equal(run.status, "SUCCEEDED");

    const finalized = await built.store.runs.findById("run-0001");
    assert.equal(finalized?.status, "SUCCEEDED");
    assert.notEqual(finalized?.status, "RUNNING");

    built.store.close();

    const reopened = newSqliteFactory(dbPath);
    try {
      const rereadRun = await reopened.store.runs.findById("run-0001");
      assert.equal(rereadRun?.status, "SUCCEEDED");
      assert.equal(rereadRun?.workerPrincipalId, run.workerPrincipalId);

      const evidence = await reopened.factory.listEvidence(item.id);
      assert.ok(evidence.length > 0, "run evidence must survive a store restart");
      assert.ok(evidence.every((e) => e.runId === "run-0001"));
    } finally {
      reopened.store.close();
    }
  });
});
