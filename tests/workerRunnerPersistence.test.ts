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
 *
 * D1: the worker is registered `requiresDirectAdmission: true` and the run
 * carries a trusted, test-configured DirectWorkerTicket bound to this exact
 * WorkItem/specRevision/role/principal/criteria.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createNodeProcessRunner } from "../src/adapters/process/nodeProcessRunner.js";
import { createCodexCliWorker } from "../src/adapters/workers/codexCliAdapter.js";
import { resolveWorkspace } from "../src/adapters/workers/workspace.js";
import { cleanupTempDbs, newSqliteFactory, seedWorkItem, tempDbPath, toImplementing } from "./support/factoryFixtures.js";
import { fakeCliPath } from "./support/fakeCli.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./support/tempWorkspace.js";
import {
  buildRuntimeWithStore,
  makeRetainedAuthority,
  TICKET,
  TICKET_REFERENCE,
  PRESTART_TICKET_REFERENCE,
} from "./support/directRuntimeFixture.js";

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

    const { authority } = makeRetainedAuthority();
    const { factory, channel, registerApprovedPrestart } = buildRuntimeWithStore(authority, built.store);

    const [fixtureModel] = TICKET.model.eligibleModels;
    assert.ok(fixtureModel !== undefined, "fixture TICKET.model.eligibleModels must declare at least one model");

    const workspace = resolveWorkspace(createTempWorkspace());
    const worker = createCodexCliWorker({
      executable: fakeCliPath("fake-codex.mjs"),
      model: fixtureModel,
      workspace,
      processRunner: runner,
      environmentPolicy: { allowedVars: ["PATH"], extraVars: { FAKE_CODEX_SLEEP_MS: "400" } },
      ...(channel === undefined ? {} : { directAdmissionChannel: channel }),
    });
    const principal = factory.registerWorker(worker, ["IMPLEMENTER"], { requiresDirectAdmission: true });
    const criteria = await built.store.criteria.listByWorkItem(item.id);
    registerApprovedPrestart({
      reference: PRESTART_TICKET_REFERENCE,
      item: { id: item.id, specRevision: item.specRevision },
      principal,
      role: "IMPLEMENTER",
      criteria,
      dependencyWorkItemIds: item.dependencies,
    });

    const runPromise = factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker,
      instructions: "implement the thing",
      directTicketReference: TICKET_REFERENCE,
      expectedModel: TICKET.model,
      expectedScope: TICKET.scope,
      expectedBudgets: TICKET.budgets,
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

  it("refuses a direct-admission-required worker with a stale specRevision approval before any RUNNING row persists", async () => {
    const dbPath = tempDbPath();
    const built = newSqliteFactory(dbPath);
    const item = await seedWorkItem(built.factory);
    await toImplementing(built.factory, item.id);

    const { authority, calls } = makeRetainedAuthority();
    const { factory, channel, registerApprovedPrestart } = buildRuntimeWithStore(authority, built.store);
    assert.ok(channel !== undefined, "the shared direct admission channel must be genuinely configured");

    const [fixtureModel] = TICKET.model.eligibleModels;
    assert.ok(fixtureModel !== undefined, "fixture TICKET.model.eligibleModels must declare at least one model");

    const workspace = resolveWorkspace(createTempWorkspace());
    let realRunnerInvocations = 0;
    const countingRunner = {
      run(request: Parameters<typeof runner.run>[0]) {
        realRunnerInvocations++;
        return runner.run(request);
      },
    };
    const worker = createCodexCliWorker({
      executable: fakeCliPath("fake-codex.mjs"),
      model: fixtureModel,
      workspace,
      processRunner: countingRunner,
      directAdmissionChannel: channel,
    });
    const principal = factory.registerWorker(worker, ["IMPLEMENTER"], { requiresDirectAdmission: true });
    const criteria = await built.store.criteria.listByWorkItem(item.id);
    registerApprovedPrestart({
      reference: PRESTART_TICKET_REFERENCE,
      item: { id: item.id, specRevision: item.specRevision + 1 },
      principal,
      role: "IMPLEMENTER",
      criteria,
      dependencyWorkItemIds: item.dependencies,
    });

    try {
      await assert.rejects(
        factory.runWorker({
          workItemId: item.id,
          role: "IMPLEMENTER",
          worker,
          instructions: "implement the thing",
          directTicketReference: TICKET_REFERENCE,
          expectedModel: TICKET.model,
          expectedScope: TICKET.scope,
          expectedBudgets: TICKET.budgets,
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal((error as { code?: unknown }).code, "VALIDATION");
          assert.match(error.message, /stale against the current WorkItem specRevision/);
          return true;
        },
      );
      assert.equal(calls.resolveAndReserve, 0);
      assert.equal(realRunnerInvocations, 0, "the real process-runner boundary must never be reached");
      assert.equal((await factory.listRuns(item.id)).length, 0);
      assert.equal((await built.store.runs.listByWorkItem(item.id)).length, 0);
    } finally {
      built.store.close();
    }
  });
});
