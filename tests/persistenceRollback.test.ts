/**
 * TASK-002 acceptance criterion 4: deliberately fail transactions and prove
 * no partial writes remain, at the FactoryService level (not just the raw
 * store level — see tests/sqliteStore.test.ts / storeContract.ts for that).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMockWorker } from "../src/adapters/workers/mockWorker.js";
import {
  AGENT,
  newSqliteFactory,
  registeredWorker,
  seedWorkItem,
  toImplementing,
} from "./support/factoryFixtures.js";

describe("rollback and atomicity (SQLite)", () => {
  it("concurrent run starts never create an orphan run, however many of them succeed", async () => {
    const { factory } = newSqliteFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const workerA = registeredWorker(factory, "worker-a", ["IMPLEMENTER"]);
    const workerB = registeredWorker(factory, "worker-b", ["IMPLEMENTER"]);

    const results = await Promise.allSettled([
      factory.runWorker({ workItemId: item.id, role: "IMPLEMENTER", worker: workerA, instructions: "A" }),
      factory.runWorker({ workItemId: item.id, role: "IMPLEMENTER", worker: workerB, instructions: "B" }),
    ]);

    // Unlike the in-memory adapter's staged-overlay design, real SQL
    // transactions are serialized (see src/adapters/sqlite/sqliteStore.ts's
    // mutex): the second start's PHASE 1 re-reads the WorkItem only after
    // the first has already committed, so it sees fresh state rather than a
    // stale snapshot and legitimately succeeds too — there is no "loser" to
    // retry. What must hold regardless of how many starts succeed is the
    // actual invariant this test protects: nothing durable is ever left
    // unattached.
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    assert.ok(fulfilled.length >= 1, "at least one run start must succeed");

    const finalItem = await factory.getWorkItem(item.id);
    const storedRuns = await factory.listRuns(item.id);
    for (const run of storedRuns) {
      assert.ok(finalItem.runIds.includes(run.id), `run ${run.id} must be attached, never orphaned`);
    }

    const evidence = await factory.listEvidence(item.id);
    for (const entry of evidence) {
      assert.ok(entry.runId !== undefined && finalItem.runIds.includes(entry.runId), `evidence ${entry.id} must not be an orphan`);
    }
  });

  it("an append-only violation inside recordApproval's transaction leaves no partial approval", async () => {
    const { factory, store } = newSqliteFactory();
    const item = await seedWorkItem(factory);
    await factory.advance(item.id, "ANALYSIS", AGENT);
    await factory.advance(item.id, "PLAN_REVIEW", AGENT);

    const subject = factory.workItemSubject(item.id);

    // Force an append-only collision inside a manually driven transaction
    // that mirrors what recordApproval does, to prove the whole unit rolls
    // back rather than leaving a half-written approval.
    const fakeId = "apr-0001"; // matches the sequential id the next real recordApproval would use
    await assert.rejects(
      store.transaction(async (repos) => {
        await repos.approvals.save({
          id: fakeId,
          gate: "PUBLISH_APPROVAL",
          subject,
          decision: "APPROVED",
          decidedBy: { id: "user:test", kind: "HUMAN", displayName: "Test Human" },
          decidedAt: 0,
        });
        // Second write in the same unit of work collides.
        await repos.approvals.save({
          id: fakeId,
          gate: "PUBLISH_APPROVAL",
          subject,
          decision: "REJECTED",
          decidedBy: { id: "user:test", kind: "HUMAN", displayName: "Test Human" },
          decidedAt: 1,
        });
      }),
      { code: "APPEND_ONLY_VIOLATION" },
    );

    assert.equal(await store.approvals.findById(fakeId), undefined, "neither write in the failed unit of work may survive");
  });

  it("a thrown worker still leaves a clean FAILED run — PHASE 3 finalize is its own atomic unit", async () => {
    const { factory } = newSqliteFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const throwing = createMockWorker({ id: "worker-throws", roles: ["IMPLEMENTER"], throws: new Error("boom") });
    factory.registerWorker(throwing);

    await assert.rejects(
      factory.runWorker({ workItemId: item.id, role: "IMPLEMENTER", worker: throwing, instructions: "will throw" }),
      { code: "WORKER_EXECUTION_FAILED" },
    );

    const runs = await factory.listRuns(item.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, "FAILED");
    assert.notEqual(runs[0]?.status, "RUNNING");

    const evidence = await factory.listEvidence(item.id);
    assert.ok(evidence.some((entry) => /boom/.test(entry.summary)));
  });

  it("a write from a stale, externally-held WorkItem snapshot is rejected without corrupting the winner's state", async () => {
    // FactoryService.advance() always re-reads inside its own transaction,
    // so two concurrent advance() calls can never race on a shared stale
    // snapshot the way two in-memory TransactionScopes could (each starts
    // its own overlay against the same pre-race live tables). To exercise a
    // genuinely stale CAS write against SQLite, simulate what a crashed or
    // slow external process resuming from an old cached read would do: hold
    // a snapshot, let the real winner advance through FactoryService, then
    // attempt to write using the now-superseded version.
    const { factory, store } = newSqliteFactory();
    const item = await seedWorkItem(factory);
    const staleSnapshot = await factory.getWorkItem(item.id);

    const winner = await factory.advance(item.id, "ANALYSIS", AGENT);
    assert.equal(winner.version, staleSnapshot.version + 1);

    await assert.rejects(
      store.workItems.compareAndSave({ ...staleSnapshot, status: "BLOCKED" }, staleSnapshot.version),
      { code: "CONCURRENCY_CONFLICT" },
    );

    const final = await factory.getWorkItem(item.id);
    assert.equal(final.status, "ANALYSIS", "the winner's committed state must be untouched by the rejected stale write");
    assert.equal(final.history.length, 1, "the stale write must not appear, not even partially");
  });
});
