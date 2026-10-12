/**
 * TASK-003 remediation round 1, HIGH finding (independent Codex review,
 * 2026-08-20): captured worker output was redacted before becoming
 * transcript Evidence, but NOT before becoming `Run.summary` —
 * `src/adapters/workers/cliWorker.ts`'s `buildSummary()` used the raw
 * parsed message directly. `FactoryService.runWorker()` persists that
 * summary as `Run.summary`, and it survived a real SQLite close/reopen.
 *
 * This suite reproduces the bug end-to-end (a fake CLI emits a synthetic,
 * clearly-not-real, secret-shaped value; the value must never reach
 * `Run.summary` or Evidence, before or after a real SQLite restart), and
 * proves the fix without regressing ordinary (non-secret) output.
 *
 * The synthetic value below is not a real credential — it exists only to
 * exercise the `sk-ant-...` redaction pattern already asserted directly in
 * environmentPolicy.test.ts.
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
  buildRuntime,
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
const SYNTHETIC_SECRET = "sk-ant-test-1234567890abcdefghijklmnop";

describe("worker output redaction: Run.summary must never carry unredacted worker output", () => {
  it("redacts the synthetic secret from both Run.summary and Evidence, and it stays redacted after a real SQLite close/reopen", async () => {
    const dbPath = tempDbPath();
    const built = newSqliteFactory(dbPath);
    const item = await seedWorkItem(built.factory);
    await toImplementing(built.factory, item.id);

    const retained = makeRetainedAuthority();
    const runtime = buildRuntimeWithStore(retained.authority, built.store);

    const criteria = await built.store.criteria.listByWorkItem(item.id);

    const workspace = resolveWorkspace(createTempWorkspace());
    assert.ok(runtime.channel !== undefined, "trusted direct-admission channel must be present on the real Factory");
    const eligibleModel = TICKET.model.eligibleModels[0];
    assert.ok(eligibleModel !== undefined, "TICKET.model.eligibleModels must contain at least one model");
    const worker = createCodexCliWorker({
      executable: fakeCliPath("fake-codex.mjs"),
      model: eligibleModel,
      workspace,
      processRunner: runner,
      environmentPolicy: { allowedVars: ["PATH"], extraVars: { FAKE_CODEX_MESSAGE: SYNTHETIC_SECRET } },
      directAdmissionChannel: runtime.channel,
    });
    const workerPrincipal = runtime.factory.registerWorker(worker, ["IMPLEMENTER"]);
    assert.ok(workerPrincipal.requiresDirectAdmission, "a real Codex worker must require direct admission");

    runtime.registerApprovedPrestart({
      reference: PRESTART_TICKET_REFERENCE,
      item: { id: item.id, specRevision: item.specRevision },
      principal: workerPrincipal,
      role: "IMPLEMENTER",
      criteria,
      dependencyWorkItemIds: item.dependencies,
    });

    const { run: outcomeRun, evidence: outcomeEvidence } = await runtime.factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker,
      instructions: "implement the thing",
      directTicketReference: TICKET_REFERENCE,
      expectedModel: TICKET.model,
      expectedScope: TICKET.scope,
      expectedBudgets: TICKET.budgets,
    });

    assert.equal(retained.calls.atomicConsumeLaunch, 1, "admission must have actually reached the real child via one real consume");

    // Before persistence round-trip: the returned WorkerOutcome-derived Run/Evidence.
    assert.doesNotMatch(outcomeRun.summary ?? "", /sk-ant-test-/, "Run.summary must not carry the raw synthetic secret");
    assert.match(outcomeRun.summary ?? "", /\[REDACTED\]/, "Run.summary must show the redaction marker in its place");
    for (const entry of outcomeEvidence) {
      assert.doesNotMatch(entry.summary, /sk-ant-test-/, "Evidence.summary must not carry the raw synthetic secret");
    }
    assert.ok(
      outcomeEvidence.some((entry) => /\[REDACTED\]/.test(entry.summary)),
      "at least the transcript Evidence entry must show the redaction marker",
    );

    // Re-read directly from the live store (bypassing the returned objects
    // entirely), then close and reopen against the same file — the
    // strongest available proof persisted state itself is clean.
    const liveRun = await built.store.runs.findById(outcomeRun.id);
    assert.doesNotMatch(liveRun?.summary ?? "", /sk-ant-test-/);
    assert.match(liveRun?.summary ?? "", /\[REDACTED\]/);

    built.store.close();

    const reopened = newSqliteFactory(dbPath);
    try {
      const rereadRun = await reopened.store.runs.findById(outcomeRun.id);
      assert.ok(rereadRun !== undefined);
      assert.doesNotMatch(rereadRun.summary ?? "", /sk-ant-test-/, "reopened Run.summary must not carry the raw synthetic secret");
      assert.match(rereadRun.summary ?? "", /\[REDACTED\]/, "reopened Run.summary must still show the redaction marker");

      const rereadEvidence = await reopened.factory.listEvidence(item.id);
      assert.ok(rereadEvidence.length > 0);
      for (const entry of rereadEvidence) {
        assert.doesNotMatch(entry.summary, /sk-ant-test-/, "reopened Evidence.summary must not carry the raw synthetic secret");
      }
    } finally {
      reopened.store.close();
    }
  });

  it("does not mangle ordinary, non-secret worker output in Run.summary", async () => {
    const retained = makeRetainedAuthority();
    const runtime = buildRuntime(retained.authority);

    const item = await seedWorkItem(runtime.factory);
    await toImplementing(runtime.factory, item.id);

    const criteria = await runtime.store.criteria.listByWorkItem(item.id);

    const workspace = resolveWorkspace(createTempWorkspace());
    assert.ok(runtime.factory.sharedDirectAdmissionChannel !== undefined, "trusted direct-admission channel must be present on the real Factory");
    const eligibleModel = TICKET.model.eligibleModels[0];
    assert.ok(eligibleModel !== undefined, "TICKET.model.eligibleModels must contain at least one model");
    const worker = createCodexCliWorker({
      executable: fakeCliPath("fake-codex.mjs"),
      model: eligibleModel,
      workspace,
      processRunner: runner,
      environmentPolicy: { allowedVars: ["PATH"], extraVars: { FAKE_CODEX_MESSAGE: "All 12 tests passed, no issues found." } },
      directAdmissionChannel: runtime.factory.sharedDirectAdmissionChannel,
    });
    const workerPrincipal = runtime.factory.registerWorker(worker, ["IMPLEMENTER"]);
    assert.ok(workerPrincipal.requiresDirectAdmission, "a real Codex worker must require direct admission");

    runtime.registerApprovedPrestart({
      reference: PRESTART_TICKET_REFERENCE,
      item: { id: item.id, specRevision: item.specRevision },
      principal: workerPrincipal,
      role: "IMPLEMENTER",
      criteria,
      dependencyWorkItemIds: item.dependencies,
    });

    const { run } = await runtime.factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker,
      instructions: "implement the thing",
      directTicketReference: TICKET_REFERENCE,
      expectedModel: TICKET.model,
      expectedScope: TICKET.scope,
      expectedBudgets: TICKET.budgets,
    });

    assert.equal(retained.calls.atomicConsumeLaunch, 1, "admission must have actually reached the real child via one real consume");

    assert.match(run.summary ?? "", /All 12 tests passed, no issues found\./);
    assert.doesNotMatch(run.summary ?? "", /\[REDACTED\]/);
  });
});
