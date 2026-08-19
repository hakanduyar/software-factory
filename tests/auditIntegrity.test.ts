/**
 * Audit records must not be silently replaced, and nothing returned by the
 * store may be mutable by a caller holding a reference — including through a
 * retained timestamp, which was a Round-2 escape.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createInMemoryStore } from "../src/adapters/memory/inMemoryStore.js";
import { AppendOnlyViolationError } from "../src/domain/errors.js";
import {
  AGENT,
  FIXTURE_START_MS,
  HUMAN,
  authorize,
  newFactory,
  registeredWorker,
  seedWorkItem,
  toImplementing,
} from "./support/factoryFixtures.js";

describe("append-only tables refuse to overwrite an existing id", () => {
  it("Evidence", async () => {
    const store = createInMemoryStore();
    const draft = {
      id: "ev-1",
      workItemId: "wi-1",
      kind: "NOTE" as const,
      summary: "first",
      reference: "mock://a",
      createdAt: FIXTURE_START_MS,
    };
    await store.evidence.save(draft);
    await assert.rejects(store.evidence.save({ ...draft, summary: "tampered" }), AppendOnlyViolationError);
    assert.equal((await store.evidence.findById("ev-1"))?.summary, "first");
  });

  it("Review", async () => {
    const store = createInMemoryStore();
    const draft = {
      id: "rev-1",
      workItemId: "wi-1",
      specRevision: 1,
      reviewedRunId: "run-1",
      reviewerRunId: "run-2",
      kind: "DETERMINISTIC" as const,
      reviewerPrincipalId: "wp-b",
      implementerPrincipalId: "wp-a",
      verdict: "PASS" as const,
      findings: [],
      createdAt: FIXTURE_START_MS,
    };
    await store.reviews.save(draft);
    await assert.rejects(store.reviews.save({ ...draft, verdict: "FAIL" }), AppendOnlyViolationError);
    assert.equal((await store.reviews.findById("rev-1"))?.verdict, "PASS");
  });

  it("Approval", async () => {
    const store = createInMemoryStore();
    const draft = {
      id: "apr-1",
      gate: "PLAN_APPROVAL" as const,
      subject: { type: "WORK_ITEM" as const, id: "wi-1" },
      decision: "APPROVED" as const,
      decidedBy: HUMAN,
      decidedAt: FIXTURE_START_MS,
    };
    await store.approvals.save(draft);
    await assert.rejects(store.approvals.save({ ...draft, decision: "REJECTED" }), AppendOnlyViolationError);
    assert.equal((await store.approvals.findById("apr-1"))?.decision, "APPROVED");
  });

  it("AcceptanceCriterionVerification", async () => {
    const store = createInMemoryStore();
    const draft = {
      id: "acv-1",
      criterionId: "ac-1",
      workItemId: "wi-1",
      specRevision: 1,
      implementationRunId: "run-1",
      result: "PASSED" as const,
      verifierPrincipalId: "wp-b",
      verifierRunId: "run-2",
      verifiedAt: FIXTURE_START_MS,
    };
    await store.verifications.save(draft);
    await assert.rejects(store.verifications.save({ ...draft, result: "FAILED" }), AppendOnlyViolationError);
  });
});

describe("persisted timestamps are immutable primitives", () => {
  it("stores every audit timestamp as a number, never a Date", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    const worker = registeredWorker(factory, "worker-a", ["IMPLEMENTER"]);
    const { run } = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker,
      instructions: "implement",
    });

    const stored = await factory.getWorkItem(item.id);
    assert.equal(typeof stored.createdAt, "number");
    assert.equal(typeof stored.updatedAt, "number");
    assert.equal(typeof stored.history[0]?.at, "number");
    assert.equal(typeof run.startedAt, "number");
    assert.equal(typeof run.finishedAt, "number");

    for (const evidence of await factory.listEvidence(item.id)) {
      assert.equal(typeof evidence.createdAt, "number");
    }
  });

  it("refuses to persist a Date in any audit table", async () => {
    const store = createInMemoryStore();
    const withDate = { createdAt: new Date() as unknown as number };

    await assert.rejects(
      store.evidence.save({ id: "ev-x", workItemId: "wi-1", kind: "NOTE", summary: "s", reference: "r", ...withDate }),
      /mutable Date/,
    );
    await assert.rejects(
      store.approvals.save({
        id: "apr-x",
        gate: "PLAN_APPROVAL",
        subject: { type: "WORK_ITEM", id: "wi-1" },
        decision: "APPROVED",
        decidedBy: HUMAN,
        decidedAt: new Date() as unknown as number,
      }),
      /mutable Date/,
    );
  });
});

describe("stored objects are frozen against caller mutation", () => {
  it("a WorkItem returned from create/compareAndSave/findById cannot be mutated", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);

    assert.ok(Object.isFrozen(item));
    assert.throws(() => {
      (item as { status: string }).status = "DONE";
    }, TypeError);
    assert.ok(Object.isFrozen(item.history));
    assert.ok(Object.isFrozen(item.runIds));
    assert.ok(Object.isFrozen(item.acceptanceCriteriaIds));

    const advanced = await factory.advance(item.id, "ANALYSIS", AGENT);
    assert.throws(() => {
      (advanced.history as unknown as { push(entry: unknown): void }).push({});
    }, TypeError);
    assert.throws(() => {
      (advanced.history[0] as { at: number }).at = 0;
    }, TypeError);

    const reread = await factory.getWorkItem(item.id);
    assert.ok(Object.isFrozen(reread));
    assert.equal(reread.history.length, 1);
  });

  it("a Review's findings array cannot be mutated by a holder of the returned reference", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const implementer = registeredWorker(factory, "worker-a", ["IMPLEMENTER"]);
    const reviewer = registeredWorker(factory, "worker-b", ["REVIEWER"]);
    const implementation = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: implementer,
      instructions: "implement",
    });
    const reviewerRun = await factory.runWorker({
      workItemId: item.id,
      role: "REVIEWER",
      worker: reviewer,
      instructions: "review",
      againstRunId: implementation.run.id,
    });
    const review = await factory.recordReview({
      workItemId: item.id,
      reviewedRunId: implementation.run.id,
      reviewerRunId: reviewerRun.run.id,
      kind: "SEMANTIC",
      verdict: "PASS",
      findings: ["a finding"],
    });

    assert.ok(Object.isFrozen(review));
    assert.ok(Object.isFrozen(review.findings));
    assert.throws(() => {
      (review.findings as unknown as { push(entry: unknown): void }).push("injected");
    }, TypeError);
    assert.throws(() => {
      (review as { createdAt: number }).createdAt = 0;
    }, TypeError);
  });

  it("an Approval and its context cannot be mutated", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await factory.advance(item.id, "ANALYSIS", AGENT);
    await factory.advance(item.id, "PLAN_REVIEW", AGENT);

    const approval = await factory.recordApproval({
      gate: "PLAN_APPROVAL",
      subject: factory.workItemSubject(item.id),
      decision: "APPROVED",
      actor: HUMAN,
      authorization: authorize(factory),
    });

    assert.ok(Object.isFrozen(approval));
    assert.ok(approval.context !== undefined && Object.isFrozen(approval.context));
    assert.throws(() => {
      (approval as { decision: string }).decision = "REJECTED";
    }, TypeError);
    assert.throws(() => {
      (approval.context as unknown as { specRevision: number }).specRevision = 99;
    }, TypeError);
    assert.throws(() => {
      (approval as { decidedAt: number }).decidedAt = 0;
    }, TypeError);
  });

  it("a stored Run cannot be mutated through the returned reference", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    const worker = registeredWorker(factory, "worker-a", ["IMPLEMENTER"]);
    const { run } = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker,
      instructions: "implement",
    });

    assert.ok(Object.isFrozen(run));
    assert.throws(() => {
      (run as { status: string }).status = "FAILED";
    }, TypeError);
    assert.throws(() => {
      (run as { workerPrincipalId: string }).workerPrincipalId = "wp-someone-else";
    }, TypeError);
  });
});
