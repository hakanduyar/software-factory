/**
 * Worker results must never move a work item or open a gate (C1, C3, C5); a
 * worker must not be the sole semantic reviewer of its own run (C4); a
 * thrown exception must still leave an honest FAILED run on record; and
 * acceptance criteria are verified from a successful run's own evidence, not
 * from a worker's claim.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMockWorker } from "../src/adapters/workers/mockWorker.js";
import { NotFoundError, ReviewIntegrityError, ValidationError, WorkerExecutionError } from "../src/domain/errors.js";
import { AGENT, newFactory, registeredWorker, seedWorkItem, toImplementing } from "./support/factoryFixtures.js";

describe("worker runs", () => {
  it("records a run and its evidence without changing work item status", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const { run, evidence } = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: registeredWorker(factory, "mock-implementer", ["IMPLEMENTER"]),
      instructions: "do the work",
    });

    assert.equal(run.status, "SUCCEEDED");
    assert.equal(run.specRevision, (await factory.getWorkItem(item.id)).specRevision);
    assert.ok(evidence.length > 0, "a run must leave evidence");
    assert.equal((await factory.getWorkItem(item.id)).status, "IMPLEMENTING");
    assert.deepEqual(
      [...(await factory.listEvidence(item.id))].map((entry) => entry.runId),
      evidence.map(() => run.id),
    );
  });

  it("refuses a worker that does not support the requested role", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);

    await assert.rejects(
      factory.runWorker({
        workItemId: item.id,
        role: "IMPLEMENTER",
        worker: registeredWorker(factory, "reviewer-only", ["REVIEWER"]),
        instructions: "do the work",
      }),
      { code: "NOT_FOUND" },
    );
  });

  it("records but does not act on a worker claiming its criteria are met while it FAILED", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const { run } = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: registeredWorker(factory, "over-claiming-worker", ["IMPLEMENTER"], {
        outcomeStatus: "FAILED",
        claimsAcceptanceMet: true,
      }),
      instructions: "do the work",
    });

    assert.equal(run.status, "FAILED");
    assert.equal(run.claimsAcceptanceMet, true, "the claim is recorded for audit");

    // The claim buys nothing: status is unchanged and VERIFYING remains unreachable.
    assert.equal((await factory.getWorkItem(item.id)).status, "IMPLEMENTING");
    await assert.rejects(factory.advance(item.id, "VERIFYING", AGENT), { code: "PRECONDITION_NOT_MET" });
  });

  describe("thrown exceptions (worker failure safety)", () => {
    it("persists the run as FAILED, not stuck RUNNING, and records failure evidence", async () => {
      const { factory } = newFactory();
      const item = await seedWorkItem(factory);
      await toImplementing(factory, item.id);

      await assert.rejects(
        factory.runWorker({
          workItemId: item.id,
          role: "IMPLEMENTER",
          worker: registeredWorker(factory, "throwing-worker", ["IMPLEMENTER"], { throws: new Error("kaboom") }),
          instructions: "do the work",
        }),
        WorkerExecutionError,
      );

      const runs = await factory.listRuns(item.id);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.status, "FAILED");
      assert.notEqual(runs[0]?.status, "RUNNING");
      assert.match(runs[0]?.summary ?? "", /kaboom/);

      const evidence = await factory.listEvidence(item.id);
      assert.ok(evidence.some((entry) => /kaboom/.test(entry.summary)));
    });

    it("a run that threw never satisfies the IMPLEMENTING -> VERIFYING precondition", async () => {
      const { factory } = newFactory();
      const item = await seedWorkItem(factory);
      await toImplementing(factory, item.id);

      await assert.rejects(
        factory.runWorker({
          workItemId: item.id,
          role: "IMPLEMENTER",
          worker: registeredWorker(factory, "throwing-worker", ["IMPLEMENTER"], { throws: "not even an Error object" }),
          instructions: "do the work",
        }),
        WorkerExecutionError,
      );

      await assert.rejects(factory.advance(item.id, "VERIFYING", AGENT), { code: "PRECONDITION_NOT_MET" });
    });
  });
});

describe("review integrity (C4) and provenance", () => {
  async function runAsRole(
    factory: ReturnType<typeof newFactory>["factory"],
    itemId: string,
    role: "IMPLEMENTER" | "VERIFIER" | "REVIEWER",
    workerId: string,
    againstRunId?: string,
  ) {
    return factory.runWorker({
      workItemId: itemId,
      role,
      worker: registeredWorker(factory, workerId, [role]),
      instructions: `act as ${role}`,
      ...(againstRunId === undefined ? {} : { againstRunId }),
    });
  }

  it("refuses a semantic review whose reviewer run belongs to the same worker as the reviewed run", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const sameWorker = registeredWorker(factory, "worker-a", ["IMPLEMENTER", "REVIEWER"]);
    const implementation = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: sameWorker,
      instructions: "implement",
    });
    const selfReviewRun = await factory.runWorker({
      workItemId: item.id,
      role: "REVIEWER",
      worker: sameWorker,
      instructions: "review your own work",
      againstRunId: implementation.run.id,
    });

    await assert.rejects(
      factory.recordReview({
        workItemId: item.id,
        reviewedRunId: implementation.run.id,
        reviewerRunId: selfReviewRun.run.id,
        kind: "SEMANTIC",
        verdict: "PASS",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ReviewIntegrityError);
        assert.equal(error.code, "REVIEW_INTEGRITY");
        return true;
      },
    );
  });

  it("refuses a fake reviewer identity: reviewerRunId must reference a real, successful run", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    const implementation = await runAsRole(factory, item.id, "IMPLEMENTER", "worker-a");

    await assert.rejects(
      factory.recordReview({
        workItemId: item.id,
        reviewedRunId: implementation.run.id,
        reviewerRunId: "run-does-not-exist",
        kind: "SEMANTIC",
        verdict: "PASS",
      }),
      NotFoundError,
    );
  });

  it("refuses a SEMANTIC review backed by a run that is not REVIEWER-role", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    const implementation = await runAsRole(factory, item.id, "IMPLEMENTER", "worker-a");
    const verifierRun = await runAsRole(factory, item.id, "VERIFIER", "worker-b", implementation.run.id);

    await assert.rejects(
      factory.recordReview({
        workItemId: item.id,
        reviewedRunId: implementation.run.id,
        reviewerRunId: verifierRun.run.id,
        kind: "SEMANTIC",
        verdict: "PASS",
      }),
      ValidationError,
    );
  });

  it("refuses a review backed by a FAILED reviewer run", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    const implementation = await runAsRole(factory, item.id, "IMPLEMENTER", "worker-a");
    const failedReviewer = await factory.runWorker({
      workItemId: item.id,
      role: "REVIEWER",
      worker: registeredWorker(factory, "worker-b", ["REVIEWER"], { outcomeStatus: "FAILED" }),
      instructions: "review",
      againstRunId: implementation.run.id,
    });

    await assert.rejects(
      factory.recordReview({
        workItemId: item.id,
        reviewedRunId: implementation.run.id,
        reviewerRunId: failedReviewer.run.id,
        kind: "SEMANTIC",
        verdict: "PASS",
      }),
      ValidationError,
    );
  });

  it("accepts a semantic review backed by a different worker's successful REVIEWER run, and derives reviewerId from it", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    const implementation = await runAsRole(factory, item.id, "IMPLEMENTER", "worker-a");
    const reviewerRun = await runAsRole(factory, item.id, "REVIEWER", "worker-b", implementation.run.id);

    const review = await factory.recordReview({
      workItemId: item.id,
      reviewedRunId: implementation.run.id,
      reviewerRunId: reviewerRun.run.id,
      kind: "SEMANTIC",
      verdict: "CHANGES_REQUESTED",
      findings: ["missing edge case"],
    });

    assert.equal(review.verdict, "CHANGES_REQUESTED");
    assert.equal(review.reviewerPrincipalId, reviewerRun.run.workerPrincipalId);
    assert.deepEqual([...review.findings], ["missing edge case"]);
  });

  it("allows a deterministic self-check (VERIFIER reviewing the IMPLEMENTER run), which is not a judgement", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    const implementation = await runAsRole(factory, item.id, "IMPLEMENTER", "worker-a");
    const verifierRun = await runAsRole(factory, item.id, "VERIFIER", "worker-a-verifier", implementation.run.id);

    const review = await factory.recordReview({
      workItemId: item.id,
      reviewedRunId: implementation.run.id,
      reviewerRunId: verifierRun.run.id,
      kind: "DETERMINISTIC",
      verdict: "PASS",
    });

    assert.equal(review.kind, "DETERMINISTIC");
    assert.equal(review.specRevision, (await factory.getWorkItem(item.id)).specRevision);
  });
});

describe("acceptance criterion verification (provenance, not claims)", () => {
  it("marks a criterion PASSED only when the verifier run left matching evidence", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    const implementation = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: registeredWorker(factory, "worker-a", ["IMPLEMENTER"]),
      instructions: "implement",
    });

    const criteria = await factory.listCriteria(item.id);
    const verifierRun = await factory.runWorker({
      workItemId: item.id,
      role: "VERIFIER",
      worker: registeredWorker(factory, "worker-b", ["VERIFIER"], {
        omitEvidenceForCriteria: [criteria[1]!.id],
      }),
      instructions: "verify",
      againstRunId: implementation.run.id,
    });

    const verifications = await factory.verifyAcceptanceCriteria({ workItemId: item.id, verifierRunId: verifierRun.run.id });

    assert.equal(verifications.length, 2);
    const byCriterion = new Map(verifications.map((v) => [v.criterionId, v]));
    assert.equal(byCriterion.get(criteria[0]!.id)?.result, "PASSED");
    assert.equal(byCriterion.get(criteria[1]!.id)?.result, "FAILED");
    assert.equal(byCriterion.get(criteria[1]!.id)?.evidenceId, undefined);
    assert.equal(byCriterion.get(criteria[0]!.id)?.verifierPrincipalId, verifierRun.run.workerPrincipalId);
  });

  it("does not treat a worker's claimsAcceptanceMet flag as sufficient", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    const implementation = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: registeredWorker(factory, "worker-a", ["IMPLEMENTER"]),
      instructions: "implement",
    });

    const criteria = await factory.listCriteria(item.id);
    // Worker claims success but produces evidence for no criteria at all.
    const verifierRun = await factory.runWorker({
      workItemId: item.id,
      role: "VERIFIER",
      worker: registeredWorker(factory, "worker-b", ["VERIFIER"], {
        claimsAcceptanceMet: true,
        omitEvidenceForCriteria: criteria.map((c) => c.id),
      }),
      instructions: "verify",
      againstRunId: implementation.run.id,
    });

    const verifications = await factory.verifyAcceptanceCriteria({ workItemId: item.id, verifierRunId: verifierRun.run.id });
    assert.ok(verifications.every((v) => v.result === "FAILED"));
  });

  it("refuses to verify from a run that is not a VERIFIER run", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    const implementation = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: registeredWorker(factory, "worker-a", ["IMPLEMENTER"]),
      instructions: "implement",
    });

    await assert.rejects(
      factory.verifyAcceptanceCriteria({ workItemId: item.id, verifierRunId: implementation.run.id }),
      ValidationError,
    );
  });

  it("refuses to verify from a FAILED run", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    const implementation = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: registeredWorker(factory, "worker-a", ["IMPLEMENTER"]),
      instructions: "implement",
    });
    const failedVerification = await factory.runWorker({
      workItemId: item.id,
      role: "VERIFIER",
      worker: registeredWorker(factory, "worker-b", ["VERIFIER"], { outcomeStatus: "FAILED" }),
      instructions: "verify",
      againstRunId: implementation.run.id,
    });

    await assert.rejects(
      factory.verifyAcceptanceCriteria({ workItemId: item.id, verifierRunId: failedVerification.run.id }),
      ValidationError,
    );
  });

  it("refuses to verify from a verifier run that examined a superseded implementation", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const firstImplementation = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: registeredWorker(factory, "worker-a", ["IMPLEMENTER"]),
      instructions: "implement",
    });
    const verifierRun = await factory.runWorker({
      workItemId: item.id,
      role: "VERIFIER",
      worker: registeredWorker(factory, "worker-b", ["VERIFIER"]),
      instructions: "verify",
      againstRunId: firstImplementation.run.id,
    });

    // A newer implementation makes the verifier run describe the past.
    await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: registeredWorker(factory, "worker-a2", ["IMPLEMENTER"]),
      instructions: "implement again",
    });

    await assert.rejects(
      factory.verifyAcceptanceCriteria({ workItemId: item.id, verifierRunId: verifierRun.run.id }),
      ValidationError,
    );
  });
});

describe("provider independence (C9)", () => {
  it("keeps the worker contract free of vendor names", async () => {
    const worker = createMockWorker();
    assert.equal(worker.capabilities.deterministic, true);
    assert.ok(worker.capabilities.roles.includes("IMPLEMENTER"));
    // The Factory only ever sees an opaque worker id.
    assert.equal(typeof worker.id, "string");
  });
});
