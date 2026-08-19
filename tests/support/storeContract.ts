/**
 * The behavioral contract every FactoryStore adapter must satisfy, run
 * against both the in-memory adapter and the SQLite adapter to prove parity
 * (TASK-002 acceptance criterion 5). Each `it` creates its own store via
 * `makeStore()` so adapters that hold a real connection (SQLite) get a fresh
 * one per test.
 */

import assert from "node:assert/strict";
import { it } from "node:test";

import type { Approval } from "../../src/domain/approval.js";
import type { Evidence } from "../../src/domain/evidence.js";
import type { Review } from "../../src/domain/review.js";
import type { Run } from "../../src/domain/run.js";
import type { AcceptanceCriterionVerification } from "../../src/domain/acceptanceCriterionVerification.js";
import type { FactoryStore } from "../../src/ports/repositories.js";
import { HUMAN } from "./factoryFixtures.js";
import { workItemAt } from "./factoryFixtures.js";

const AT = 1_800_000_000_000;

function run(overrides: Partial<Run> & Pick<Run, "id" | "status">): Run {
  return {
    workItemId: "wi-contract",
    specRevision: 1,
    role: "IMPLEMENTER",
    workerPrincipalId: "wp-a",
    declaredWorkerId: "worker-a",
    claimsAcceptanceMet: false,
    evidenceIds: [],
    startedAt: AT,
    ...overrides,
  };
}

function evidence(id: string, overrides: Partial<Evidence> = {}): Evidence {
  return {
    id,
    workItemId: "wi-contract",
    kind: "NOTE",
    summary: "s",
    reference: "mock://x",
    createdAt: AT,
    ...overrides,
  };
}

function review(id: string, overrides: Partial<Review> = {}): Review {
  return {
    id,
    workItemId: "wi-contract",
    specRevision: 1,
    reviewedRunId: "run-impl",
    reviewerRunId: "run-review",
    kind: "DETERMINISTIC",
    reviewerPrincipalId: "wp-b",
    implementerPrincipalId: "wp-a",
    verdict: "PASS",
    findings: [],
    createdAt: AT,
    ...overrides,
  };
}

function approval(id: string, overrides: Partial<Approval> = {}): Approval {
  return {
    id,
    gate: "PUBLISH_APPROVAL",
    subject: { type: "WORK_ITEM", id: "wi-contract" },
    decision: "APPROVED",
    decidedBy: HUMAN,
    decidedAt: AT,
    ...overrides,
  };
}

function verification(id: string, overrides: Partial<AcceptanceCriterionVerification> = {}): AcceptanceCriterionVerification {
  return {
    id,
    criterionId: "ac-1",
    workItemId: "wi-contract",
    specRevision: 1,
    implementationRunId: "run-impl",
    result: "PASSED",
    verifierPrincipalId: "wp-b",
    verifierRunId: "run-verify",
    verifiedAt: AT,
    ...overrides,
  };
}

export function runStoreContractTests(makeStore: () => FactoryStore): void {
  it("WorkItem.create rejects a duplicate id", async () => {
    const store = makeStore();
    const item = workItemAt("IDEA", "wi-dup");
    await store.workItems.create(item);
    await assert.rejects(store.workItems.create(item), { code: "CONCURRENCY_CONFLICT" });
  });

  it("WorkItem.compareAndSave accepts the matching version and rejects a stale one", async () => {
    const store = makeStore();
    const item = workItemAt("IDEA", "wi-cas");
    await store.workItems.create(item);

    const updated = { ...item, status: "ANALYSIS" as const, version: item.version + 1 };
    await store.workItems.compareAndSave(updated, item.version);

    const staleAttempt = { ...item, status: "BLOCKED" as const, version: item.version + 1 };
    await assert.rejects(store.workItems.compareAndSave(staleAttempt, item.version), { code: "CONCURRENCY_CONFLICT" });

    const current = await store.workItems.findById(item.id);
    assert.equal(current?.status, "ANALYSIS", "the winning write must survive, the stale one must not overwrite it");
  });

  it("Run.create rejects a non-RUNNING initial status", async () => {
    const store = makeStore();
    await assert.rejects(store.runs.create(run({ id: "run-bad-initial", status: "SUCCEEDED" })), {
      code: "RUN_LIFECYCLE",
    });
  });

  it("Run.create rejects a duplicate id", async () => {
    const store = makeStore();
    const r = run({ id: "run-dup", status: "RUNNING" });
    await store.runs.create(r);
    await assert.rejects(store.runs.create(r), { code: "APPEND_ONLY_VIOLATION" });
  });

  it("Run.complete transitions RUNNING -> terminal exactly once and rejects a second completion", async () => {
    const store = makeStore();
    await store.runs.create(run({ id: "run-once", status: "RUNNING" }));
    const completed = await store.runs.complete("run-once", {
      status: "SUCCEEDED",
      summary: "ok",
      claimsAcceptanceMet: true,
      evidenceIds: [],
      finishedAt: AT + 1000,
    });
    assert.equal(completed.status, "SUCCEEDED");

    await assert.rejects(
      store.runs.complete("run-once", {
        status: "FAILED",
        summary: "tampered",
        claimsAcceptanceMet: false,
        evidenceIds: [],
        finishedAt: AT + 2000,
      }),
      { code: "RUN_LIFECYCLE" },
    );

    const stored = await store.runs.findById("run-once");
    assert.equal(stored?.status, "SUCCEEDED", "the terminal record must not be rewritten");
  });

  it("Run.complete rejects a non-terminal or invalid runtime status", async () => {
    const store = makeStore();
    await store.runs.create(run({ id: "run-invalid-complete", status: "RUNNING" }));
    for (const bogus of ["RUNNING", "BANANA", ""]) {
      await assert.rejects(
        store.runs.complete("run-invalid-complete", {
          status: bogus as never,
          summary: "s",
          claimsAcceptanceMet: false,
          evidenceIds: [],
          finishedAt: AT,
        }),
        { code: "RUN_LIFECYCLE" },
      );
    }
  });

  it("Evidence/Review/Approval/AcceptanceCriterionVerification reject id reuse", async () => {
    const store = makeStore();
    await store.evidence.save(evidence("ev-dup"));
    await assert.rejects(store.evidence.save(evidence("ev-dup", { summary: "tampered" })), {
      code: "APPEND_ONLY_VIOLATION",
    });

    await store.reviews.save(review("rev-dup"));
    await assert.rejects(store.reviews.save(review("rev-dup", { verdict: "FAIL" })), {
      code: "APPEND_ONLY_VIOLATION",
    });

    await store.approvals.save(approval("apr-dup"));
    await assert.rejects(store.approvals.save(approval("apr-dup", { decision: "REJECTED" })), {
      code: "APPEND_ONLY_VIOLATION",
    });

    await store.verifications.save(verification("acv-dup"));
    await assert.rejects(store.verifications.save(verification("acv-dup", { result: "FAILED" })), {
      code: "APPEND_ONLY_VIOLATION",
    });
  });

  it("transaction() is atomic: a failure partway through leaves no earlier write in that unit of work", async () => {
    const store = makeStore();
    await assert.rejects(
      store.transaction(async (repos) => {
        await repos.evidence.save(evidence("ev-atomic-1"));
        await repos.evidence.save(evidence("ev-atomic-2"));
        // This one collides with an id used inside the SAME transaction.
        await repos.evidence.save(evidence("ev-atomic-1", { summary: "collides" }));
      }),
      { code: "APPEND_ONLY_VIOLATION" },
    );

    assert.equal(await store.evidence.findById("ev-atomic-1"), undefined, "even the first successful write must roll back");
    assert.equal(await store.evidence.findById("ev-atomic-2"), undefined, "every write in the failed unit of work must roll back");
  });

  it("a run created but never attached does not corrupt the WorkItem when attachment fails", async () => {
    const store = makeStore();
    const item = workItemAt("IMPLEMENTING", "wi-attach");
    await store.workItems.create(item);

    await assert.rejects(
      store.transaction(async (repos) => {
        await repos.runs.create(run({ id: "run-orphan-attempt", workItemId: item.id, status: "RUNNING" }));
        // Stale CAS: someone else's version, so attachment fails.
        await repos.workItems.compareAndSave(
          { ...item, runIds: [...item.runIds, "run-orphan-attempt"], version: item.version + 1 },
          item.version + 5,
        );
      }),
      { code: "CONCURRENCY_CONFLICT" },
    );

    assert.equal(await store.runs.findById("run-orphan-attempt"), undefined, "the run must not survive its failed unit of work");
    const stored = await store.workItems.findById(item.id);
    assert.deepEqual([...(stored?.runIds ?? ["not-empty"])], [], "the WorkItem must be untouched");
  });

  it("returns frozen values that cannot be mutated by the caller", async () => {
    const store = makeStore();
    const item = await store.workItems.create(workItemAt("IDEA", "wi-frozen-contract"));
    assert.ok(Object.isFrozen(item));
    assert.ok(Object.isFrozen(item.history));
    assert.throws(() => {
      (item as { status: string }).status = "DONE";
    }, TypeError);

    const a = await store.approvals.save(approval("apr-frozen-contract", { subject: { type: "WORK_ITEM", id: item.id } }));
    assert.ok(Object.isFrozen(a));
  });

  it("refuses to persist a Date anywhere in audit state", async () => {
    const store = makeStore();
    await assert.rejects(
      store.evidence.save({ ...evidence("ev-date-contract"), createdAt: new Date() as unknown as number }),
      /mutable Date/,
    );
  });

  it("listByWorkItem / listBySubject preserve append order", async () => {
    const store = makeStore();
    await store.evidence.save(evidence("ev-order-1"));
    await store.evidence.save(evidence("ev-order-2"));
    await store.evidence.save(evidence("ev-order-3"));
    const list = await store.evidence.listByWorkItem("wi-contract");
    assert.deepEqual(
      list.map((entry) => entry.id),
      ["ev-order-1", "ev-order-2", "ev-order-3"],
    );

    const subject = { type: "WORK_ITEM" as const, id: "wi-order-subject" };
    await store.approvals.save(approval("apr-order-1", { subject }));
    await store.approvals.save(approval("apr-order-2", { subject }));
    const approvals = await store.approvals.listBySubject(subject);
    assert.deepEqual(
      approvals.map((entry) => entry.id),
      ["apr-order-1", "apr-order-2"],
    );
  });
}
