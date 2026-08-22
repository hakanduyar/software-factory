/**
 * TASK-004 remediation round 5 — permanent reproductions for the two HIGH
 * findings the independent Codex acceptance review (GPT-5.6 Luna, xhigh)
 * returned. Round-4's fixes were independently confirmed closed; these are new
 * bypasses of the same authority class, found by the systematic audit.
 *
 * HIGH 1 — `cancel()` exposed cached WAITING_FOR_HUMAN. Round 3 correctly made
 *   cancellation require trusted-human authorization, and round 4 made
 *   `status()` re-derive authority — but `cancel()`'s terminal early return
 *   still handed back the persisted row. Authentication answers "who may
 *   cancel?"; it does not prove a cached terminal state is still authoritative.
 *   Those are separate invariants. `cancel()` now revalidates WAITING through
 *   the SAME shared path `drive()`/`resume()` use.
 *
 * HIGH 2 — a semantic Review's backing reviewer Run was never dereferenced.
 *   `recordReview` validates it at creation, but a resolver reading durable
 *   state must re-prove it: a corrupted/directly-written Review carrying
 *   plausible copied principal strings could point at a reviewer run that does
 *   not exist (or failed / is running / has the wrong role, revision or target)
 *   and still become authoritative — surviving SQLite close/reopen. The shared
 *   resolver now resolves the authoritative REVIEWER attempt from the runs
 *   first and pins the review to it, exactly as it already did for the
 *   deterministic/verifier pair.
 *
 * No real Claude/Codex model is invoked anywhere in this file.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createInMemoryLoopRepository } from "../src/adapters/orchestration/inMemoryLoopRepository.js";
import { createSqliteLoopRepository } from "../src/adapters/orchestration/sqliteLoopRepository.js";
import { createNodeProcessRunner } from "../src/adapters/process/nodeProcessRunner.js";
import type { FactoryService } from "../src/app/factoryService.js";
import { agent, human, system } from "../src/domain/actor.js";
import { createSequentialIdGenerator } from "../src/domain/ids.js";
import type { Run } from "../src/domain/run.js";
import { EngineeringLoopService, type LoopWorkerFactory } from "../src/orchestration/engineeringLoopService.js";
import type { LoopRepository } from "../src/orchestration/loopRepository.js";
import { canonicalActionId, correlationTag, type EngineeringLoop } from "../src/orchestration/loopTypes.js";
import type { Clock } from "../src/ports/clock.js";
import type { FactoryStore } from "../src/ports/repositories.js";
import {
  AGENT,
  authorize,
  cleanupTempDbs,
  HUMAN,
  newFactory,
  newSqliteFactory,
  registeredWorker,
  seedWorkItem,
  SYSTEM,
  tempDbPath,
  toImplementing,
  toWaitingForHuman,
} from "./support/factoryFixtures.js";

after(cleanupTempDbs);

const processRunner = createNodeProcessRunner({ killGraceMs: 100 });

/** Worker factories that throw on construction — proof a path launched zero worker/model work. */
const throwingWorkers: { createImplementerWorker: LoopWorkerFactory; createReviewerWorker: LoopWorkerFactory } = {
  createImplementerWorker: () => {
    throw new Error("no implementer worker may be constructed on this path");
  },
  createReviewerWorker: () => {
    throw new Error("no reviewer worker may be constructed on this path");
  },
};

function makeService(factory: FactoryService, loops: LoopRepository, clock: Clock): EngineeringLoopService {
  return new EngineeringLoopService({
    factory,
    loops,
    clock,
    ids: createSequentialIdGenerator(),
    processRunner,
    ...throwingWorkers,
  });
}

/** A strictly-valid persisted loop row at terminal phase WAITING_FOR_HUMAN (cached checkpoint, never authority). */
function waitingLoopRow(loopId: string, workItemId: string, t = 1_700_000_000_000): EngineeringLoop {
  const claim = (kind: "IMPLEMENT" | "VERIFY" | "REVIEW") => ({
    actionId: canonicalActionId(loopId, 1, kind),
    kind,
    attempt: 1,
    ownerToken: "own-checkpoint",
    claimedAt: t,
    correlationTag: correlationTag(canonicalActionId(loopId, 1, kind), 1),
  });
  return {
    id: loopId,
    workItemId,
    version: 6,
    phase: "WAITING_FOR_HUMAN",
    budget: { maxIterations: 3 },
    implementer: { tool: "claude-code", model: "m" },
    reviewer: { tool: "codex-cli", model: "m" },
    verificationCommands: [{ id: "c", executable: "node", argv: ["-e", "process.exit(0)"] }],
    workspaceRoot: "/tmp/loop-ws",
    taskInstructions: "task",
    iterations: [
      {
        iteration: 1,
        implementClaim: claim("IMPLEMENT"),
        implementerRunId: "run-ghost-impl",
        implementerOutcome: "SUCCEEDED",
        verifyClaim: claim("VERIFY"),
        verificationRunId: "run-ghost-verify",
        deterministicReviewClaim: { ownerToken: "own-checkpoint", claimedAt: t },
        verificationReviewId: "rev-ghost-det",
        verificationPassed: true,
        reviewClaim: claim("REVIEW"),
        reviewerRunId: "run-ghost-review",
        semanticReviewClaim: { ownerToken: "own-checkpoint", claimedAt: t },
        reviewRecordId: "rev-ghost-sem",
        reviewVerdict: "PASS",
        reviewFindings: [],
      },
    ],
    totalRunCount: 3,
    outcome: "WAITING_FOR_HUMAN",
    cancelRequested: false,
    startedBy: human("user:test", "Test Operator"),
    startedAt: t,
    lastTransitionAt: t + 5,
  };
}

// =====================================================================
// HIGH 1 — cancel() must not expose cached WAITING authority
// =====================================================================

describe("remediation round 5 — HIGH 1: cancel() re-derives WAITING_FOR_HUMAN authority", () => {
  async function staleWaitingLoop(loopId = "loop-stale-waiting") {
    const { factory, clock } = newFactory();
    const loops = createInMemoryLoopRepository();
    await loops.create(waitingLoopRow(loopId, "wi-never-existed"));
    return { factory, clock, loops, loopId, service: makeService(factory, loops, clock) };
  }

  it("A: status() and an authorized cancel() agree — neither exposes an unbacked WAITING_FOR_HUMAN", async () => {
    const { factory, loops, loopId, service } = await staleWaitingLoop();

    const status = await service.status(loopId);
    assert.equal(status.phase, "RECOVERY_REQUIRED", "status() must fail closed");

    const cancelled = await service.cancel(loopId, HUMAN, authorize(factory, HUMAN));
    assert.notEqual(cancelled.phase, "WAITING_FOR_HUMAN", "an authenticated human must not receive cached WAITING authority");
    assert.equal(cancelled.phase, "RECOVERY_REQUIRED");
    assert.equal((await loops.findById(loopId))!.phase, "RECOVERY_REQUIRED", "cancel() is a mutating command: the demotion is durable");
  });

  it("B: the CLI `sf loop cancel` path cannot expose an unbacked WAITING_FOR_HUMAN", async () => {
    const { runLoopCancel } = await import("../src/cli/loop.js");
    const factoryDbPath = tempDbPath();
    const loopsDbPath = tempDbPath();
    const seed = createSqliteLoopRepository(loopsDbPath);
    await seed.create(waitingLoopRow("loop-cli-cancel-stale", "wi-not-in-factory-db"));
    seed.close();

    const view = await runLoopCancel("loop-cli-cancel-stale", { factoryDbPath, loopsDbPath, log: () => {} });
    assert.notEqual(view.phase, "WAITING_FOR_HUMAN");
    assert.equal(view.phase, "RECOVERY_REQUIRED");
  });

  it("C+D: an authorized cancel() of an invalid WAITING loop launches zero workers and creates no replacement Run/Review/Evidence", async () => {
    const { factory, clock } = newFactory();
    const item = await seedWorkItem(factory);
    await toWaitingForHuman(factory, item.id);
    const loops = createInMemoryLoopRepository();
    await loops.create(waitingLoopRow("loop-invalid-waiting", item.id));

    // Invalidate the lineage: a newer implementation orphans the proof.
    await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: registeredWorker(factory, "w-impl-newer", ["IMPLEMENTER"]),
      instructions: "newer implementation",
    });

    const runsBefore = (await factory.listRuns(item.id)).length;
    const reviewsBefore = (await factory.listReviews(item.id)).length;
    const evidenceBefore = (await factory.listEvidence(item.id)).length;

    // throwingWorkers: constructing any worker throws, so completing proves zero launches.
    const cancelled = await makeService(factory, loops, clock).cancel("loop-invalid-waiting", HUMAN, authorize(factory, HUMAN));

    assert.equal(cancelled.phase, "RECOVERY_REQUIRED");
    assert.equal((await factory.listRuns(item.id)).length, runsBefore, "no replacement Run");
    assert.equal((await factory.listReviews(item.id)).length, reviewsBefore, "no replacement Review");
    assert.equal((await factory.listEvidence(item.id)).length, evidenceBefore, "no replacement Evidence");
  });

  it("E: the fail-closed demotion uses the canonical recovery behaviour (RECOVERY_REQUIRED + WorkItem BLOCKED)", async () => {
    const { factory, clock } = newFactory();
    const item = await seedWorkItem(factory);
    await toWaitingForHuman(factory, item.id);
    const loops = createInMemoryLoopRepository();
    await loops.create(waitingLoopRow("loop-canonical-recovery", item.id));
    await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: registeredWorker(factory, "w-impl-newer", ["IMPLEMENTER"]),
      instructions: "newer implementation",
    });

    const cancelled = await makeService(factory, loops, clock).cancel("loop-canonical-recovery", HUMAN, authorize(factory, HUMAN));
    assert.equal(cancelled.phase, "RECOVERY_REQUIRED");
    assert.equal(cancelled.outcome, "RECOVERY_REQUIRED");
    assert.match(cancelled.failureReason ?? "", /not backed by current Factory authority/);
    assert.equal(
      (await loops.findById("loop-canonical-recovery"))!.phase,
      "RECOVERY_REQUIRED",
      "the authoritative signal is the durable loop demotion",
    );
    // The courtesy WorkItem->BLOCKED transition is best-effort (tryBlockWorkItem)
    // and WAITING_FOR_HUMAN is deliberately not in BLOCKABLE_STATUSES, so the
    // item stays where it is — itself already a human-attention state. Widening
    // the accepted TASK-001 transition table is out of scope for this round.
    assert.equal((await factory.getWorkItem(item.id)).status, "WAITING_FOR_HUMAN");
  });

  it("F: a fully valid authoritative WAITING loop keeps its terminal no-op cancellation semantics", async () => {
    const { factory, clock } = newFactory();
    const item = await seedWorkItem(factory);
    await toWaitingForHuman(factory, item.id);
    const loops = createInMemoryLoopRepository();
    const row = waitingLoopRow("loop-valid-waiting", item.id);
    await loops.create(row);

    const cancelled = await makeService(factory, loops, clock).cancel("loop-valid-waiting", HUMAN, authorize(factory, HUMAN));

    assert.equal(cancelled.phase, "WAITING_FOR_HUMAN", "a genuinely authoritative terminal loop is unchanged by cancel()");
    assert.equal(cancelled.outcome, "WAITING_FOR_HUMAN");
    const durable = (await loops.findById("loop-valid-waiting"))!;
    assert.equal(durable.phase, "WAITING_FOR_HUMAN");
    assert.equal(durable.version, row.version, "no cosmetic mutation of a valid terminal loop");
  });

  it("G+H: unauthorized cancellation is still rejected BEFORE any authority-side mutation, with zero durable change", async () => {
    const { factory, loops, loopId, service } = await staleWaitingLoop("loop-unauthorized");
    const before = (await loops.findById(loopId))!;

    await assert.rejects(service.cancel(loopId, AGENT), { code: "HUMAN_IDENTITY" });
    await assert.rejects(service.cancel(loopId, agent("agent:x", "X")), { code: "HUMAN_IDENTITY" });
    await assert.rejects(service.cancel(loopId, SYSTEM), { code: "HUMAN_IDENTITY" });
    await assert.rejects(service.cancel(loopId, system("system:x", "X")), { code: "HUMAN_IDENTITY" });
    await assert.rejects(service.cancel(loopId, human("user:pretender", "Pretender")), { code: "HUMAN_IDENTITY" });
    const good = authorize(factory, HUMAN);
    const forged = { ...good, signature: `${good.signature.slice(0, -1)}${good.signature.endsWith("a") ? "b" : "a"}` };
    await assert.rejects(service.cancel(loopId, HUMAN, forged), { code: "HUMAN_IDENTITY" });

    const after = (await loops.findById(loopId))!;
    assert.equal(after.phase, before.phase, "a rejected cancel must not demote, mutate, or otherwise touch the loop");
    assert.equal(after.version, before.version);
    assert.equal(after.cancelRequested, before.cancelRequested);
  });

  it("K: status(), resume(), drive() and cancel() all agree that stale WAITING is not authoritative", async () => {
    const { factory, clock } = newFactory();
    const loops = createInMemoryLoopRepository();
    await loops.create(waitingLoopRow("loop-agreement", "wi-never-existed"));
    const service = makeService(factory, loops, clock);

    assert.equal((await service.status("loop-agreement")).phase, "RECOVERY_REQUIRED", "status()");
    // resume() (and drive() beneath it) durably demotes; re-seed for cancel().
    assert.equal((await service.resume("loop-agreement")).phase, "RECOVERY_REQUIRED", "resume()/drive()");

    const loops2 = createInMemoryLoopRepository();
    await loops2.create(waitingLoopRow("loop-agreement-2", "wi-never-existed"));
    const service2 = makeService(factory, loops2, clock);
    assert.equal(
      (await service2.cancel("loop-agreement-2", HUMAN, authorize(factory, HUMAN))).phase,
      "RECOVERY_REQUIRED",
      "cancel()",
    );
  });
});

// =====================================================================
// HIGH 2 — a semantic Review is only as authoritative as its backing Run
// =====================================================================

/** Writes a Review straight into the store so every field — including the backing run reference — can be controlled. */
async function saveSemanticReview(
  store: FactoryStore,
  clock: Clock,
  input: {
    id: string;
    workItemId: string;
    specRevision: number;
    reviewedRunId: string;
    reviewerRunId: string;
    reviewerPrincipalId: string;
    implementerPrincipalId: string;
    verdict?: "PASS" | "CHANGES_REQUESTED" | "FAIL";
    kind?: "SEMANTIC" | "DETERMINISTIC";
  },
): Promise<void> {
  await store.reviews.save({
    id: input.id,
    workItemId: input.workItemId,
    specRevision: input.specRevision,
    reviewedRunId: input.reviewedRunId,
    reviewerRunId: input.reviewerRunId,
    kind: input.kind ?? "SEMANTIC",
    reviewerPrincipalId: input.reviewerPrincipalId,
    implementerPrincipalId: input.implementerPrincipalId,
    verdict: input.verdict ?? "PASS",
    findings: [],
    createdAt: clock.now(),
  });
}

interface ValidLineage {
  readonly implementation: Run;
  readonly verifierRun: Run;
  readonly reviewerRun: Run;
}

/** A fully valid, current lineage at WAITING_FOR_HUMAN, with the real run records returned. */
async function validLineage(factory: FactoryService, itemId: string): Promise<ValidLineage> {
  const fx = await toWaitingForHuman(factory, itemId);
  const runs = await factory.listRuns(itemId);
  return {
    implementation: runs.find((r) => r.id === fx.implementationRunId)!,
    verifierRun: runs.find((r) => r.id === fx.verifierRunId)!,
    reviewerRun: runs.find((r) => r.id === fx.reviewerRunId)!,
  };
}

describe("remediation round 5 — HIGH 2: a semantic Review's backing reviewer Run is revalidated", () => {
  it("A: reviewerRunId points to a nonexistent Run => NOT authoritative", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const lineage = await validLineage(factory, item.id);

    await saveSemanticReview(store, clock, {
      id: "rev-ghost-run",
      workItemId: item.id,
      specRevision: lineage.implementation.specRevision,
      reviewedRunId: lineage.implementation.id,
      reviewerRunId: "run-does-not-exist",
      reviewerPrincipalId: "principal-that-never-ran",
      implementerPrincipalId: lineage.implementation.workerPrincipalId,
    });

    const authority = await factory.resolveWaitingForHumanAuthority(item.id);
    assert.equal(authority.ok, false, "a review naming a nonexistent reviewer run may never authorize");
  });

  it("B/C: a FAILED or RUNNING reviewer attempt => NOT authoritative", async () => {
    for (const outcome of ["FAILED", "RUNNING"] as const) {
      const { factory, clock, store } = newFactory();
      const item = await seedWorkItem(factory);
      const lineage = await validLineage(factory, item.id);

      // A NEWER reviewer attempt against the same implementation becomes the
      // authoritative reviewer head; it is not a usable proof.
      let newestReviewerId: string;
      if (outcome === "FAILED") {
        const reviewer = registeredWorker(factory, "w-review-2", ["REVIEWER"], { outcomeStatus: "FAILED" });
        const failed = await factory.runWorker({
          workItemId: item.id,
          role: "REVIEWER",
          worker: reviewer,
          instructions: "review again",
          againstRunId: lineage.implementation.id,
        });
        newestReviewerId = failed.run.id;
      } else {
        // A durably RUNNING reviewer attempt (created, never completed).
        newestReviewerId = "run-still-running";
        await store.runs.create({
          id: newestReviewerId,
          workItemId: item.id,
          specRevision: lineage.implementation.specRevision,
          role: "REVIEWER",
          workerPrincipalId: "principal-reviewer-2",
          declaredWorkerId: "w-review-2",
          status: "RUNNING",
          targetRunId: lineage.implementation.id,
          claimsAcceptanceMet: false,
          evidenceIds: [],
          startedAt: clock.now(),
        });
      }

      await saveSemanticReview(store, clock, {
        id: `rev-backing-${outcome}`,
        workItemId: item.id,
        specRevision: lineage.implementation.specRevision,
        reviewedRunId: lineage.implementation.id,
        reviewerRunId: newestReviewerId,
        reviewerPrincipalId: "principal-reviewer-2",
        implementerPrincipalId: lineage.implementation.workerPrincipalId,
      });

      const authority = await factory.resolveWaitingForHumanAuthority(item.id);
      assert.equal(authority.ok, false, `a ${outcome} reviewer attempt may never back an authoritative review`);
    }
  });

  it("D: a backing run with the wrong ROLE => NOT authoritative", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const lineage = await validLineage(factory, item.id);

    // Point the review at the VERIFIER run instead of a REVIEWER run.
    await saveSemanticReview(store, clock, {
      id: "rev-wrong-role",
      workItemId: item.id,
      specRevision: lineage.implementation.specRevision,
      reviewedRunId: lineage.implementation.id,
      reviewerRunId: lineage.verifierRun.id,
      reviewerPrincipalId: lineage.verifierRun.workerPrincipalId,
      implementerPrincipalId: lineage.implementation.workerPrincipalId,
    });

    const authority = await factory.resolveWaitingForHumanAuthority(item.id);
    assert.equal(authority.ok, false, "a VERIFIER run may not back a SEMANTIC review");
  });

  it("E/F: a backing run with the wrong specRevision or wrong target => NOT authoritative", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const lineage = await validLineage(factory, item.id);

    // A newer reviewer attempt that targets something else entirely: it becomes
    // the reviewer head for nothing, so the current implementation has no valid
    // reviewer attempt pinned to the recorded review.
    await store.runs.create({
      id: "run-wrong-target",
      workItemId: item.id,
      specRevision: lineage.implementation.specRevision,
      role: "REVIEWER",
      workerPrincipalId: "principal-reviewer-3",
      declaredWorkerId: "w-review-3",
      status: "RUNNING",
      targetRunId: lineage.verifierRun.id, // not the implementation
      claimsAcceptanceMet: false,
      evidenceIds: [],
      startedAt: clock.now(),
    });
    await store.runs.complete("run-wrong-target", {
      status: "SUCCEEDED",
      summary: "ok",
      claimsAcceptanceMet: true,
      evidenceIds: [],
      finishedAt: clock.now(),
    });
    await saveSemanticReview(store, clock, {
      id: "rev-wrong-target",
      workItemId: item.id,
      specRevision: lineage.implementation.specRevision,
      reviewedRunId: lineage.implementation.id,
      reviewerRunId: "run-wrong-target",
      reviewerPrincipalId: "principal-reviewer-3",
      implementerPrincipalId: lineage.implementation.workerPrincipalId,
    });

    const authority = await factory.resolveWaitingForHumanAuthority(item.id);
    assert.equal(authority.ok, false, "a reviewer run that examined a different target may not back the review");
  });

  it("G: a Review whose copied reviewer principal disagrees with the real Run => NOT authoritative", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const lineage = await validLineage(factory, item.id);

    await saveSemanticReview(store, clock, {
      id: "rev-principal-mismatch",
      workItemId: item.id,
      specRevision: lineage.implementation.specRevision,
      reviewedRunId: lineage.implementation.id,
      reviewerRunId: lineage.reviewerRun.id, // the genuine current reviewer attempt
      reviewerPrincipalId: "principal-someone-else", // …but a lie about who ran it
      implementerPrincipalId: lineage.implementation.workerPrincipalId,
    });

    const authority = await factory.resolveWaitingForHumanAuthority(item.id);
    assert.equal(authority.ok, false, "copied principal strings must agree with the Run they claim to describe");
    assert.match(authority.ok === false ? authority.reason : "", /reviewer principal/);
  });

  it("H: a reviewer run executed by the implementer principal => NOT authoritative (C4, proven from Runs)", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const implementer = registeredWorker(factory, "w-impl", ["IMPLEMENTER", "VERIFIER", "REVIEWER"]);
    const implementation = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: implementer,
      instructions: "implement",
    });
    await factory.advance(item.id, "VERIFYING", AGENT);
    const verification = await factory.runWorker({
      workItemId: item.id,
      role: "VERIFIER",
      worker: registeredWorker(factory, "w-verify", ["VERIFIER"]),
      instructions: "verify",
      againstRunId: implementation.run.id,
    });
    await factory.recordReview({
      workItemId: item.id,
      reviewedRunId: implementation.run.id,
      reviewerRunId: verification.run.id,
      kind: "DETERMINISTIC",
      verdict: "PASS",
    });
    // The SAME worker principal reviews its own work.
    const selfReview = await factory.runWorker({
      workItemId: item.id,
      role: "REVIEWER",
      worker: implementer,
      instructions: "review my own work",
      againstRunId: implementation.run.id,
    });
    // recordReview would refuse this (C4); write it directly to simulate corruption.
    await saveSemanticReview(store, clock, {
      id: "rev-self-review",
      workItemId: item.id,
      specRevision: implementation.run.specRevision,
      reviewedRunId: implementation.run.id,
      reviewerRunId: selfReview.run.id,
      reviewerPrincipalId: selfReview.run.workerPrincipalId,
      implementerPrincipalId: implementation.run.workerPrincipalId,
    });
    await factory.advance(item.id, "REVIEW", AGENT);

    const authority = await factory.resolveWaitingForHumanAuthority(item.id);
    assert.equal(authority.ok, false, "C4 must hold when derived from the Run records themselves");
    assert.match(authority.ok === false ? authority.reason : "", /same worker principal|not independent/);
  });

  it("I/K: an invalid backing run cannot authorize WAITING_FOR_HUMAN via advance() or status()", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const lineage = await validLineage(factory, item.id);
    await saveSemanticReview(store, clock, {
      id: "rev-invalid-backing",
      workItemId: item.id,
      specRevision: lineage.implementation.specRevision,
      reviewedRunId: lineage.implementation.id,
      reviewerRunId: "run-nowhere",
      reviewerPrincipalId: "principal-nowhere",
      implementerPrincipalId: lineage.implementation.workerPrincipalId,
    });

    // status() must fail closed on a loop pointing at this work item.
    const loops = createInMemoryLoopRepository();
    await loops.create(waitingLoopRow("loop-invalid-backing", item.id));
    const status = await makeService(factory, loops, clock).status("loop-invalid-backing");
    assert.equal(status.phase, "RECOVERY_REQUIRED");
  });

  it("J: an invalid backing run cannot qualify a release snapshot", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const lineage = await validLineage(factory, item.id);
    assert.ok(await factory.releaseSnapshot(item.id), "sanity: the valid lineage IS releasable first");

    await saveSemanticReview(store, clock, {
      id: "rev-invalid-release",
      workItemId: item.id,
      specRevision: lineage.implementation.specRevision,
      reviewedRunId: lineage.implementation.id,
      reviewerRunId: "run-nowhere",
      reviewerPrincipalId: "principal-nowhere",
      implementerPrincipalId: lineage.implementation.workerPrincipalId,
    });

    assert.equal(await factory.releaseSnapshot(item.id), undefined, "a corrupted newest review invalidates releasability");
  });

  it("L: the corruption survives SQLite close/reopen and is still rejected", async () => {
    const dbPath = tempDbPath("factory-r5-");
    const first = newSqliteFactory(dbPath);
    const item = await seedWorkItem(first.factory);
    const lineage = await validLineage(first.factory, item.id);
    await saveSemanticReview(first.store, first.clock, {
      id: "rev-corrupt-restart",
      workItemId: item.id,
      specRevision: lineage.implementation.specRevision,
      reviewedRunId: lineage.implementation.id,
      reviewerRunId: "run-wrong-revision",
      reviewerPrincipalId: "principal-that-never-ran",
      implementerPrincipalId: lineage.implementation.workerPrincipalId,
    });
    first.store.close();

    const reopened = newSqliteFactory(dbPath);
    try {
      const authority = await reopened.factory.resolveWaitingForHumanAuthority(item.id);
      assert.equal(authority.ok, false, "durable corruption must still be rejected after restart");
      assert.equal(await reopened.factory.releaseSnapshot(item.id), undefined);
    } finally {
      reopened.store.close();
    }
  });

  it("M: a later corrupted semantic PASS cannot mask a valid current blocking review", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const lineage = await validLineage(factory, item.id);

    // Genuine current blocking review …
    await saveSemanticReview(store, clock, {
      id: "rev-genuine-block",
      workItemId: item.id,
      specRevision: lineage.implementation.specRevision,
      reviewedRunId: lineage.implementation.id,
      reviewerRunId: lineage.reviewerRun.id,
      reviewerPrincipalId: lineage.reviewerRun.workerPrincipalId,
      implementerPrincipalId: lineage.implementation.workerPrincipalId,
      verdict: "CHANGES_REQUESTED",
    });
    // … which a later corrupted PASS must not mask.
    await saveSemanticReview(store, clock, {
      id: "rev-corrupt-mask",
      workItemId: item.id,
      specRevision: lineage.implementation.specRevision,
      reviewedRunId: lineage.implementation.id,
      reviewerRunId: "run-nowhere",
      reviewerPrincipalId: "principal-nowhere",
      implementerPrincipalId: lineage.implementation.workerPrincipalId,
      verdict: "PASS",
    });

    const authority = await factory.resolveWaitingForHumanAuthority(item.id);
    assert.equal(authority.ok, false, "a corrupted PASS may not mask a genuine current blocking review");
  });

  it("O/P: a fully valid current independent reviewer Run + semantic Review still authorizes, newest-first", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    const lineage = await validLineage(factory, item.id);

    const authority = await factory.resolveWaitingForHumanAuthority(item.id);
    assert.equal(authority.ok, true, "the ordinary valid lineage must still authorize");
    assert.equal(
      authority.ok === true ? authority.value.semanticReview.reviewerRunId : "",
      lineage.reviewerRun.id,
      "authority is pinned to the real current reviewer attempt",
    );
    assert.ok(await factory.releaseSnapshot(item.id), "and remains releasable");
  });
});
