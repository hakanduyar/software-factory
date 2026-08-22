/**
 * TASK-004 remediation round 4 — permanent reproductions for the two HIGH
 * findings the independent Codex re-review (GPT-5.6 Luna, xhigh) returned.
 * Round 3's two blockers were independently confirmed closed; these are new.
 *
 * HIGH 1 — `EngineeringLoopService.status()` returned a persisted
 *   `WAITING_FOR_HUMAN` loop without re-deriving current Factory authority, so
 *   any read client (CLI, UI, Telegram, Control Room, future orchestration
 *   client) could treat a stale or corrupted checkpoint as a live human/release
 *   gate. `status()` now asks the Factory Core to prove the current
 *   independent-review lineage and fails closed to a NON-PERSISTED
 *   `RECOVERY_REQUIRED` projection — `status` stays read-only; `resume()`/
 *   `drive()` remain the operations that durably demote.
 *
 * HIGH 2 — `resolveVerification()` / `resolveSemanticReview()` filtered reviews
 *   by kind and reviewed run but never by the Review record's OWN
 *   `specRevision`, so an off-revision Review could be selected as
 *   authoritative — both to authorize a transition and to MASK a
 *   current-revision blocking review. The review's own revision is now part of
 *   applicability in the shared resolver, so every caller (preconditions, the
 *   release snapshot, and the round-3 WAITING_FOR_HUMAN authority resolver)
 *   inherits the rule.
 *
 * No real Claude/Codex model is invoked anywhere in this file.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createInMemoryLoopRepository } from "../src/adapters/orchestration/inMemoryLoopRepository.js";
import { createSqliteLoopRepository } from "../src/adapters/orchestration/sqliteLoopRepository.js";
import { createNodeProcessRunner } from "../src/adapters/process/nodeProcessRunner.js";
import type { FactoryService } from "../src/app/factoryService.js";
import { human } from "../src/domain/actor.js";
import { createSequentialIdGenerator } from "../src/domain/ids.js";
import type { Run } from "../src/domain/run.js";
import { EngineeringLoopService, type LoopWorkerFactory } from "../src/orchestration/engineeringLoopService.js";
import type { LoopRepository } from "../src/orchestration/loopRepository.js";
import { canonicalActionId, correlationTag, toStatusView, type EngineeringLoop } from "../src/orchestration/loopTypes.js";
import type { Clock } from "../src/ports/clock.js";
import type { FactoryStore } from "../src/ports/repositories.js";
import {
  AGENT,
  cleanupTempDbs,
  newFactory,
  newSqliteFactory,
  registeredWorker,
  seedWorkItem,
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

/**
 * A strictly-valid persisted loop row at terminal phase WAITING_FOR_HUMAN.
 * Its stored run/review ids are deliberately not real Factory records: the
 * authority resolver reads the WorkItem's own Factory lineage, never the
 * loop's cached ids — which is the entire point of both findings.
 */
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

/** Writes a Review straight into the store, so its own `specRevision` can be controlled (recordReview always stamps the current one). */
async function saveReviewAtRevision(
  store: FactoryStore,
  clock: Clock,
  input: {
    id: string;
    workItemId: string;
    specRevision: number;
    implementation: Run;
    reviewerRun: Run;
    kind: "DETERMINISTIC" | "SEMANTIC";
    verdict: "PASS" | "CHANGES_REQUESTED" | "FAIL";
  },
): Promise<void> {
  await store.reviews.save({
    id: input.id,
    workItemId: input.workItemId,
    specRevision: input.specRevision,
    reviewedRunId: input.implementation.id,
    reviewerRunId: input.reviewerRun.id,
    kind: input.kind,
    reviewerPrincipalId: input.reviewerRun.workerPrincipalId,
    implementerPrincipalId: input.implementation.workerPrincipalId,
    verdict: input.verdict,
    findings: [],
    createdAt: clock.now(),
  });
}

interface Lineage {
  readonly implementation: Run;
  readonly verifierRun: Run;
  readonly reviewerRun: Run;
}

/**
 * Runs a real implementer + verifier + reviewer against `itemId` (all three
 * roles are startable in any execution state, see rolePolicy.ts), recording NO
 * reviews. The caller then writes exactly the reviews the scenario needs, at
 * exactly the revisions it wants to test.
 */
async function runsWithoutReviews(factory: FactoryService, itemId: string, suffix = ""): Promise<Lineage> {
  await toImplementing(factory, itemId);
  const implementation = await factory.runWorker({
    workItemId: itemId,
    role: "IMPLEMENTER",
    worker: registeredWorker(factory, `w-impl${suffix}`, ["IMPLEMENTER"]),
    instructions: "implement",
  });
  await factory.advance(itemId, "VERIFYING", AGENT);
  const verification = await factory.runWorker({
    workItemId: itemId,
    role: "VERIFIER",
    worker: registeredWorker(factory, `w-verify${suffix}`, ["VERIFIER"]),
    instructions: "verify",
    againstRunId: implementation.run.id,
  });
  const review = await factory.runWorker({
    workItemId: itemId,
    role: "REVIEWER",
    worker: registeredWorker(factory, `w-review${suffix}`, ["REVIEWER"]),
    instructions: "review",
    againstRunId: implementation.run.id,
  });
  return { implementation: implementation.run, verifierRun: verification.run, reviewerRun: review.run };
}

// =====================================================================
// HIGH 1 — status() must never expose cached WAITING_FOR_HUMAN authority
// =====================================================================

describe("remediation round 4 — HIGH 1: status() re-derives WAITING_FOR_HUMAN authority", () => {
  it("A: persisted WAITING_FOR_HUMAN referencing a nonexistent review/work item is NOT exposed as authoritative", async () => {
    const { factory, clock } = newFactory();
    const loops = createInMemoryLoopRepository();
    await loops.create(waitingLoopRow("loop-ghost", "wi-never-existed", clock.now()));

    const status = await makeService(factory, loops, clock).status("loop-ghost");

    assert.equal(status.phase, "RECOVERY_REQUIRED", "status() must not present unbacked WAITING_FOR_HUMAN as authoritative");
    assert.equal(status.outcome, "RECOVERY_REQUIRED");
    assert.equal(toStatusView(status).phase, "RECOVERY_REQUIRED", "the projected status view must fail closed too");
  });

  it("B: a superseding (newer) implementation makes the cached WAITING_FOR_HUMAN non-authoritative in status()", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    await toWaitingForHuman(factory, item.id);
    const loops = createInMemoryLoopRepository();
    await loops.create(waitingLoopRow("loop-superseded", item.id, clock.now()));

    // A newer IMPLEMENTER attempt becomes the lineage head, orphaning all proof.
    await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: registeredWorker(factory, "w-impl-newer", ["IMPLEMENTER"]),
      instructions: "newer implementation",
    });
    void store;

    const status = await makeService(factory, loops, clock).status("loop-superseded");
    assert.equal(status.phase, "RECOVERY_REQUIRED");
  });

  it("C: a stale/failing deterministic verification makes status() fail closed", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const fx = await toWaitingForHuman(factory, item.id);
    const loops = createInMemoryLoopRepository();
    await loops.create(waitingLoopRow("loop-detfail", item.id, clock.now()));

    const runs = await factory.listRuns(item.id);
    await saveReviewAtRevision(store, clock, {
      id: "rev-det-fail",
      workItemId: item.id,
      specRevision: 1,
      implementation: runs.find((r) => r.id === fx.implementationRunId)!,
      reviewerRun: runs.find((r) => r.id === fx.verifierRunId)!,
      kind: "DETERMINISTIC",
      verdict: "FAIL",
    });

    const status = await makeService(factory, loops, clock).status("loop-detfail");
    assert.equal(status.phase, "RECOVERY_REQUIRED");
  });

  it("D: a newer blocking semantic review makes status() fail closed", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const fx = await toWaitingForHuman(factory, item.id);
    const loops = createInMemoryLoopRepository();
    await loops.create(waitingLoopRow("loop-semfail", item.id, clock.now()));

    const runs = await factory.listRuns(item.id);
    await saveReviewAtRevision(store, clock, {
      id: "rev-sem-blocking",
      workItemId: item.id,
      specRevision: 1,
      implementation: runs.find((r) => r.id === fx.implementationRunId)!,
      reviewerRun: runs.find((r) => r.id === fx.reviewerRunId)!,
      kind: "SEMANTIC",
      verdict: "CHANGES_REQUESTED",
    });

    const status = await makeService(factory, loops, clock).status("loop-semfail");
    assert.equal(status.phase, "RECOVERY_REQUIRED");
  });

  it("E: a wrong-specRevision lineage makes status() fail closed (HIGH 1 + HIGH 2 together)", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const lineage = await runsWithoutReviews(factory, item.id);
    const loops = createInMemoryLoopRepository();
    await loops.create(waitingLoopRow("loop-wrongrev", item.id, clock.now()));

    // The ONLY reviews on record carry a wrong revision.
    await saveReviewAtRevision(store, clock, {
      id: "rev-det-wrongrev",
      workItemId: item.id,
      specRevision: 999,
      implementation: lineage.implementation,
      reviewerRun: lineage.verifierRun,
      kind: "DETERMINISTIC",
      verdict: "PASS",
    });
    await saveReviewAtRevision(store, clock, {
      id: "rev-sem-wrongrev",
      workItemId: item.id,
      specRevision: 999,
      implementation: lineage.implementation,
      reviewerRun: lineage.reviewerRun,
      kind: "SEMANTIC",
      verdict: "PASS",
    });

    const status = await makeService(factory, loops, clock).status("loop-wrongrev");
    assert.equal(status.phase, "RECOVERY_REQUIRED", "an off-revision review may never make status() report WAITING_FOR_HUMAN");
  });

  it("F: a fully current authoritative lineage IS still exposed as WAITING_FOR_HUMAN", async () => {
    const { factory, clock } = newFactory();
    const item = await seedWorkItem(factory);
    await toWaitingForHuman(factory, item.id);
    const loops = createInMemoryLoopRepository();
    await loops.create(waitingLoopRow("loop-valid", item.id, clock.now()));

    const status = await makeService(factory, loops, clock).status("loop-valid");
    assert.equal(status.phase, "WAITING_FOR_HUMAN", "a genuinely authoritative loop must still report WAITING_FOR_HUMAN");
    assert.equal(status.outcome, "WAITING_FOR_HUMAN");
    assert.equal(toStatusView(status).humanActionRequired, true);
  });

  it("G+H: status() launches zero workers and performs zero durable mutations (read-only contract)", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    await toWaitingForHuman(factory, item.id);
    const loops = createInMemoryLoopRepository();
    await loops.create(waitingLoopRow("loop-readonly", item.id, clock.now()));

    // Force the fail-closed branch: a newer implementation orphans the proof.
    await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: registeredWorker(factory, "w-impl-newer", ["IMPLEMENTER"]),
      instructions: "newer implementation",
    });

    const loopBefore = (await loops.findById("loop-readonly"))!;
    const itemBefore = await factory.getWorkItem(item.id);
    const runsBefore = (await factory.listRuns(item.id)).length;
    const reviewsBefore = (await factory.listReviews(item.id)).length;
    const evidenceBefore = (await factory.listEvidence(item.id)).length;

    // throwingWorkers: constructing any worker would throw, so completing at
    // all proves zero worker/model launches.
    const status = await makeService(factory, loops, clock).status("loop-readonly");
    assert.equal(status.phase, "RECOVERY_REQUIRED");

    const loopAfter = (await loops.findById("loop-readonly"))!;
    assert.equal(loopAfter.version, loopBefore.version, "status() must not bump the loop version");
    assert.equal(loopAfter.phase, "WAITING_FOR_HUMAN", "status() must not persist the demotion — it is read-only");
    const itemAfter = await factory.getWorkItem(item.id);
    assert.equal(itemAfter.version, itemBefore.version, "status() must not mutate the WorkItem");
    assert.equal(itemAfter.status, itemBefore.status);
    assert.equal((await factory.listRuns(item.id)).length, runsBefore, "status() must not create Runs");
    assert.equal((await factory.listReviews(item.id)).length, reviewsBefore, "status() must not create Reviews");
    assert.equal((await factory.listEvidence(item.id)).length, evidenceBefore, "status() must not create Evidence");
    assert.equal(loopAfter.totalRunCount, loopBefore.totalRunCount, "status() must not consume budget");
    void store;
  });

  it("I: after status() reports the failure, resume() still durably demotes to RECOVERY_REQUIRED (round-3 behaviour intact)", async () => {
    const { factory, clock } = newFactory();
    const loops = createInMemoryLoopRepository();
    await loops.create(waitingLoopRow("loop-then-resume", "wi-never-existed", clock.now()));
    const service = makeService(factory, loops, clock);

    const status = await service.status("loop-then-resume");
    assert.equal(status.phase, "RECOVERY_REQUIRED");
    assert.equal((await loops.findById("loop-then-resume"))!.phase, "WAITING_FOR_HUMAN", "status() left the row untouched");

    const resumed = await service.resume("loop-then-resume");
    assert.equal(resumed.phase, "RECOVERY_REQUIRED");
    assert.equal((await loops.findById("loop-then-resume"))!.phase, "RECOVERY_REQUIRED", "resume() performs the durable demotion");
  });

  it("J: the CLI `sf loop status` path cannot bypass the authority rule", async () => {
    const { runLoopStatus } = await import("../src/cli/loop.js");
    const factoryDbPath = tempDbPath();
    const loopsDbPath = tempDbPath();
    const seed = createSqliteLoopRepository(loopsDbPath);
    await seed.create(waitingLoopRow("loop-cli-status", "wi-not-in-factory-db"));
    seed.close();

    const view = await runLoopStatus("loop-cli-status", { factoryDbPath, loopsDbPath, log: () => {} });
    assert.equal(view.phase, "RECOVERY_REQUIRED", "the CLI must not print an unbacked WAITING_FOR_HUMAN as authoritative");
  });
});

// =====================================================================
// HIGH 2 — a Review's own specRevision is part of lineage authority
// =====================================================================

describe("remediation round 4 — HIGH 2: Review.specRevision is authoritative", () => {
  it("A/D: a deterministic review at an old revision (referencing the current runs) is NOT authoritative", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const lineage = await runsWithoutReviews(factory, item.id);

    await saveReviewAtRevision(store, clock, {
      id: "rev-det-old",
      workItemId: item.id,
      specRevision: 0,
      implementation: lineage.implementation,
      reviewerRun: lineage.verifierRun,
      kind: "DETERMINISTIC",
      verdict: "PASS",
    });

    const check = await factory.checkTransition(item.id, "REVIEW", AGENT);
    assert.equal(check.allowed, false, "VERIFYING -> REVIEW must not be unlocked by an off-revision deterministic review");
    assert.match(check.reason, /no deterministic review/);
  });

  it("B/D: a semantic review at an old revision is NOT authoritative", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const lineage = await runsWithoutReviews(factory, item.id);

    // Current-revision deterministic PASS so verification itself is genuine,
    // and the item genuinely reaches REVIEW — so the ONLY thing that can fail
    // the authority check below is the semantic review's own revision.
    await factory.recordReview({
      workItemId: item.id,
      reviewedRunId: lineage.implementation.id,
      reviewerRunId: lineage.verifierRun.id,
      kind: "DETERMINISTIC",
      verdict: "PASS",
    });
    await factory.advance(item.id, "REVIEW", AGENT);
    // …but the only semantic review carries the wrong revision.
    await saveReviewAtRevision(store, clock, {
      id: "rev-sem-old",
      workItemId: item.id,
      specRevision: 0,
      implementation: lineage.implementation,
      reviewerRun: lineage.reviewerRun,
      kind: "SEMANTIC",
      verdict: "PASS",
    });

    const authority = await factory.resolveWaitingForHumanAuthority(item.id);
    assert.equal(authority.ok, false, "an off-revision semantic review may not prove WAITING_FOR_HUMAN authority");
    assert.match(authority.ok === false ? authority.reason : "", /no semantic review/);
  });

  it("C: a FUTURE/wrong specRevision review is NOT authoritative", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const lineage = await runsWithoutReviews(factory, item.id);

    await saveReviewAtRevision(store, clock, {
      id: "rev-det-future",
      workItemId: item.id,
      specRevision: 999,
      implementation: lineage.implementation,
      reviewerRun: lineage.verifierRun,
      kind: "DETERMINISTIC",
      verdict: "PASS",
    });

    const check = await factory.checkTransition(item.id, "REVIEW", AGENT);
    assert.equal(check.allowed, false, "a future-revision review is just as inapplicable as an old one");
  });

  it("E: a stale deterministic PASS cannot combine with a current semantic PASS", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const lineage = await runsWithoutReviews(factory, item.id);

    await saveReviewAtRevision(store, clock, {
      id: "rev-det-stale",
      workItemId: item.id,
      specRevision: 0,
      implementation: lineage.implementation,
      reviewerRun: lineage.verifierRun,
      kind: "DETERMINISTIC",
      verdict: "PASS",
    });
    await saveReviewAtRevision(store, clock, {
      id: "rev-sem-current",
      workItemId: item.id,
      specRevision: 1,
      implementation: lineage.implementation,
      reviewerRun: lineage.reviewerRun,
      kind: "SEMANTIC",
      verdict: "PASS",
    });

    // The deterministic half is the stale one, so the block must appear at
    // VERIFYING -> REVIEW: a current semantic PASS cannot compensate for it.
    const check = await factory.checkTransition(item.id, "REVIEW", AGENT);
    assert.equal(check.allowed, false, "no cross-revision mixing: a stale deterministic PASS cannot back a current semantic PASS");
    assert.match(check.reason, /no deterministic review/);
  });

  it("F: a current deterministic PASS cannot combine with a stale semantic PASS", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const lineage = await runsWithoutReviews(factory, item.id);

    await saveReviewAtRevision(store, clock, {
      id: "rev-det-current",
      workItemId: item.id,
      specRevision: 1,
      implementation: lineage.implementation,
      reviewerRun: lineage.verifierRun,
      kind: "DETERMINISTIC",
      verdict: "PASS",
    });
    await factory.advance(item.id, "REVIEW", AGENT); // the current deterministic proof is genuine
    await saveReviewAtRevision(store, clock, {
      id: "rev-sem-stale",
      workItemId: item.id,
      specRevision: 0,
      implementation: lineage.implementation,
      reviewerRun: lineage.reviewerRun,
      kind: "SEMANTIC",
      verdict: "PASS",
    });

    const authority = await factory.resolveWaitingForHumanAuthority(item.id);
    assert.equal(authority.ok, false, "a stale semantic PASS cannot ride on a current deterministic PASS");
    assert.match(authority.ok === false ? authority.reason : "", /no semantic review/);
  });

  it("G: a wrong-revision PASS cannot unlock REVIEW -> WAITING_FOR_HUMAN", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const lineage = await runsWithoutReviews(factory, item.id);

    await factory.recordReview({
      workItemId: item.id,
      reviewedRunId: lineage.implementation.id,
      reviewerRunId: lineage.verifierRun.id,
      kind: "DETERMINISTIC",
      verdict: "PASS",
    });
    await factory.advance(item.id, "REVIEW", AGENT);
    await saveReviewAtRevision(store, clock, {
      id: "rev-sem-wrongrev",
      workItemId: item.id,
      specRevision: 999,
      implementation: lineage.implementation,
      reviewerRun: lineage.reviewerRun,
      kind: "SEMANTIC",
      verdict: "PASS",
    });

    await assert.rejects(factory.advance(item.id, "WAITING_FOR_HUMAN", AGENT), { code: "PRECONDITION_NOT_MET" });
  });

  it("H: a wrong-revision PASS masking a current blocking review cannot make status() expose WAITING_FOR_HUMAN", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const fx = await toWaitingForHuman(factory, item.id);
    const runs = await factory.listRuns(item.id);
    const implementation = runs.find((r) => r.id === fx.implementationRunId)!;
    const reviewerRun = runs.find((r) => r.id === fx.reviewerRunId)!;

    // A genuine current-revision blocking review …
    await saveReviewAtRevision(store, clock, {
      id: "rev-sem-current-block",
      workItemId: item.id,
      specRevision: 1,
      implementation,
      reviewerRun,
      kind: "SEMANTIC",
      verdict: "CHANGES_REQUESTED",
    });
    // … which a LATER off-revision PASS must not mask (the harmful shape).
    await saveReviewAtRevision(store, clock, {
      id: "rev-sem-wrongrev-mask",
      workItemId: item.id,
      specRevision: 999,
      implementation,
      reviewerRun,
      kind: "SEMANTIC",
      verdict: "PASS",
    });

    const loops = createInMemoryLoopRepository();
    await loops.create(waitingLoopRow("loop-masked", item.id, clock.now()));
    const status = await makeService(factory, loops, clock).status("loop-masked");

    assert.equal(status.phase, "RECOVERY_REQUIRED", "an off-revision PASS must not mask a current-revision blocking review");
  });

  it("I: a wrong-revision PASS cannot qualify a releasable snapshot", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const lineage = await runsWithoutReviews(factory, item.id);

    await factory.recordReview({
      workItemId: item.id,
      reviewedRunId: lineage.implementation.id,
      reviewerRunId: lineage.verifierRun.id,
      kind: "DETERMINISTIC",
      verdict: "PASS",
    });
    await saveReviewAtRevision(store, clock, {
      id: "rev-sem-wrongrev-release",
      workItemId: item.id,
      specRevision: 999,
      implementation: lineage.implementation,
      reviewerRun: lineage.reviewerRun,
      kind: "SEMANTIC",
      verdict: "PASS",
    });
    await factory.verifyAcceptanceCriteria({ workItemId: item.id, verifierRunId: lineage.verifierRun.id });

    assert.equal(await factory.releaseSnapshot(item.id), undefined, "no release candidate may rest on an off-revision review");
  });

  it("J: a fully current same-revision deterministic + semantic lineage still works", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toWaitingForHuman(factory, item.id);

    const authority = await factory.resolveWaitingForHumanAuthority(item.id);
    assert.equal(authority.ok, true, "the ordinary, fully-current lineage must remain authoritative");
    assert.ok(await factory.releaseSnapshot(item.id), "and must still produce a releasable snapshot");
  });

  it("K: a later current-revision PASS legitimately supersedes earlier off-revision proof", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const lineage = await runsWithoutReviews(factory, item.id);

    // Off-revision proof first (invisible), then genuine current-revision proof.
    await saveReviewAtRevision(store, clock, {
      id: "rev-det-wrongrev-first",
      workItemId: item.id,
      specRevision: 999,
      implementation: lineage.implementation,
      reviewerRun: lineage.verifierRun,
      kind: "DETERMINISTIC",
      verdict: "FAIL",
    });
    await factory.recordReview({
      workItemId: item.id,
      reviewedRunId: lineage.implementation.id,
      reviewerRunId: lineage.verifierRun.id,
      kind: "DETERMINISTIC",
      verdict: "PASS",
    });
    await factory.advance(item.id, "REVIEW", AGENT);
    await factory.recordReview({
      workItemId: item.id,
      reviewedRunId: lineage.implementation.id,
      reviewerRunId: lineage.reviewerRun.id,
      kind: "SEMANTIC",
      verdict: "PASS",
    });

    const authority = await factory.resolveWaitingForHumanAuthority(item.id);
    assert.equal(authority.ok, true, "current-revision proof is authoritative regardless of off-revision records");
    assert.equal(authority.ok === true ? authority.value.semanticReview.specRevision : -1, 1);
    assert.equal(authority.ok === true ? authority.value.deterministicReview.specRevision : -1, 1);
  });

  it("L: the revision rule survives a store restart (durable, not an in-memory artifact)", async () => {
    const dbPath = tempDbPath("factory-round4-");
    const first = newSqliteFactory(dbPath);
    const item = await seedWorkItem(first.factory);
    const lineage = await runsWithoutReviews(first.factory, item.id);
    // Genuine current deterministic proof, so the item really reaches REVIEW
    // and the off-revision SEMANTIC review below is the only thing that could
    // grant authority — isolating the revision rule across the restart.
    await first.factory.recordReview({
      workItemId: item.id,
      reviewedRunId: lineage.implementation.id,
      reviewerRunId: lineage.verifierRun.id,
      kind: "DETERMINISTIC",
      verdict: "PASS",
    });
    await first.factory.advance(item.id, "REVIEW", AGENT);
    await saveReviewAtRevision(first.store, first.clock, {
      id: "rev-sem-wrongrev-restart",
      workItemId: item.id,
      specRevision: 999,
      implementation: lineage.implementation,
      reviewerRun: lineage.reviewerRun,
      kind: "SEMANTIC",
      verdict: "PASS",
    });
    first.store.close();

    const reopened = newSqliteFactory(dbPath);
    try {
      const authority = await reopened.factory.resolveWaitingForHumanAuthority(item.id);
      assert.equal(authority.ok, false, "after restart, off-revision reviews must still be inapplicable");
    } finally {
      reopened.store.close();
    }
  });
});
