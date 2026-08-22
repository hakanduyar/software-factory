/**
 * TASK-004 remediation round 3 — permanent reproductions for the two HIGH
 * findings the independent Codex review (GPT-5.6 Luna, xhigh) returned as
 * CHANGES_REQUIRED. Both are proven closed here; the tests fail against the
 * pre-fix implementation and pass after the fix.
 *
 * HIGH 1 — Untrusted cancellation. `EngineeringLoopService.cancel()` accepted
 *   an arbitrary Actor and durably cancelled a healthy loop. Cancellation is
 *   now held to the SAME trusted-human boundary (C1/C5) as WorkItem
 *   cancellation and every protected approval: a valid `TrustedHumanToken`
 *   verified by the Factory Core is required.
 *
 * HIGH 2 — Cached WAITING_FOR_HUMAN authority. A syntactically valid persisted
 *   loop could carry `phase = WAITING_FOR_HUMAN` (and a cached PASS verdict)
 *   with no current Factory backing and be exposed as authoritative with zero
 *   authoritative reads. The loop now re-derives the independent-review
 *   lineage from live Factory state before exposing or accepting
 *   WAITING_FOR_HUMAN, and fails closed to RECOVERY_REQUIRED — launching zero
 *   new worker/model work — when it cannot be proven.
 *
 * No real Claude/Codex model is invoked anywhere in this file.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createInMemoryLoopRepository } from "../src/adapters/orchestration/inMemoryLoopRepository.js";
import { createSqliteLoopRepository } from "../src/adapters/orchestration/sqliteLoopRepository.js";
import { createNodeProcessRunner } from "../src/adapters/process/nodeProcessRunner.js";
import { createInMemoryStore } from "../src/adapters/memory/inMemoryStore.js";
import { createLocalHumanIdentityGate } from "../src/adapters/security/localHumanIdentityGate.js";
import { createLocalWorkerRegistry } from "../src/adapters/security/localWorkerRegistry.js";
import { FactoryService } from "../src/app/factoryService.js";
import { agent, human, system } from "../src/domain/actor.js";
import { createSequentialIdGenerator } from "../src/domain/ids.js";
import type { EngineeringLoop } from "../src/orchestration/loopTypes.js";
import { canonicalActionId, correlationTag } from "../src/orchestration/loopTypes.js";
import { EngineeringLoopService, type LoopWorkerFactory } from "../src/orchestration/engineeringLoopService.js";
import type { LoopRepository } from "../src/orchestration/loopRepository.js";
import { createFixedClock, type Clock } from "../src/ports/clock.js";
import {
  authorize,
  cleanupTempDbs,
  newFactory,
  seedWorkItem,
  tempDbPath,
  toWaitingForHuman,
  TEST_CREDENTIAL,
  HUMAN,
  OTHER_HUMAN,
  AGENT,
  SYSTEM,
} from "./support/factoryFixtures.js";

after(cleanupTempDbs);

const processRunner = createNodeProcessRunner({ killGraceMs: 100 });

/** Worker factories that throw the moment they are constructed — proof that a code path launched zero worker/model work. */
const throwingWorkerFactories: { createImplementerWorker: LoopWorkerFactory; createReviewerWorker: LoopWorkerFactory } = {
  createImplementerWorker: () => {
    throw new Error("no implementer worker may be constructed on this path");
  },
  createReviewerWorker: () => {
    throw new Error("no reviewer worker may be constructed on this path");
  },
};

function makeService(
  factory: FactoryService,
  loops: LoopRepository,
  clock: Clock,
  overrides: Partial<{ createImplementerWorker: LoopWorkerFactory; createReviewerWorker: LoopWorkerFactory }> = {},
): EngineeringLoopService {
  return new EngineeringLoopService({
    factory,
    loops,
    clock,
    ids: createSequentialIdGenerator(),
    processRunner,
    createImplementerWorker: overrides.createImplementerWorker ?? throwingWorkerFactories.createImplementerWorker,
    createReviewerWorker: overrides.createReviewerWorker ?? throwingWorkerFactories.createReviewerWorker,
  });
}

/** A valid, active (non-terminal) loop row at phase READY — a healthy loop that has only just started. */
function seedReadyLoopRow(loopId: string, workItemId: string, clock: Clock): EngineeringLoop {
  const now = clock.now();
  return {
    id: loopId,
    workItemId,
    version: 1,
    phase: "READY",
    budget: { maxIterations: 3 },
    implementer: { tool: "claude-code", model: "m" },
    reviewer: { tool: "codex-cli", model: "m" },
    verificationCommands: [{ id: "c", executable: "node", argv: ["-e", "process.exit(0)"] }],
    workspaceRoot: "/tmp/loop-ws",
    taskInstructions: "task",
    iterations: [],
    totalRunCount: 0,
    cancelRequested: false,
    startedBy: human("user:test", "Test Operator"),
    startedAt: now,
    lastTransitionAt: now,
  };
}

/**
 * A valid, terminal loop row at phase WAITING_FOR_HUMAN whose last iteration
 * carries the canonical claims + an authoritative-looking passing review
 * reference — the exact shape that passes strict loopSerialization yet is
 * only a checkpoint, never authority.
 */
function seedWaitingLoopRow(loopId: string, workItemId: string, clock: Clock): EngineeringLoop {
  const t = clock.now();
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
// HIGH 1 — trusted-human cancellation
// =====================================================================

describe("remediation round 3 — HIGH 1: loop cancellation requires trusted-human authorization", () => {
  async function activeLoopSetup() {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const loops = createInMemoryLoopRepository();
    const loopId = "loop-cancel-1";
    await loops.create(seedReadyLoopRow(loopId, item.id, clock));
    const service = makeService(factory, loops, clock);
    return { factory, clock, store, item, loops, service, loopId };
  }

  it("A: an AGENT actor cannot cancel a healthy loop", async () => {
    const { service, loops, loopId } = await activeLoopSetup();
    await assert.rejects(service.cancel(loopId, agent("agent:rogue", "Rogue"), authorize(newFactory().factory)), {
      code: "HUMAN_IDENTITY",
    });
    // Even with a token, an AGENT is refused; verify the healthy loop is untouched.
    const after = await loops.findById(loopId);
    assert.equal(after?.phase, "READY");
    assert.equal(after?.cancelRequested, false);
  });

  it("A': an AGENT actor cannot cancel even when no token is supplied", async () => {
    const { service, loopId } = await activeLoopSetup();
    await assert.rejects(service.cancel(loopId, AGENT), { code: "HUMAN_IDENTITY" });
  });

  it("B: a SYSTEM actor cannot cancel", async () => {
    const { service, loopId } = await activeLoopSetup();
    await assert.rejects(service.cancel(loopId, system("system:rogue", "Rogue System")), { code: "HUMAN_IDENTITY" });
    await assert.rejects(service.cancel(loopId, SYSTEM), { code: "HUMAN_IDENTITY" });
  });

  it("C: a caller-constructed { kind: HUMAN } actor with no trusted token cannot cancel", async () => {
    const { service, loopId, loops } = await activeLoopSetup();
    await assert.rejects(service.cancel(loopId, human("user:pretender", "Pretender")), {
      code: "HUMAN_IDENTITY",
    });
    const after = await loops.findById(loopId);
    assert.equal(after?.phase, "READY", "a refused cancel must not change loop phase");
  });

  it("D: a forged token (tampered signature) cannot cancel", async () => {
    const { factory, service, loopId } = await activeLoopSetup();
    const good = authorize(factory, HUMAN);
    const forged = { ...good, signature: `${good.signature.slice(0, -1)}${good.signature.endsWith("a") ? "b" : "a"}` };
    await assert.rejects(service.cancel(loopId, HUMAN, forged), { code: "HUMAN_IDENTITY" });
  });

  it("E: a valid token issued to a DIFFERENT human cannot cancel as this actor", async () => {
    const { factory, service, loopId } = await activeLoopSetup();
    const tokenForOther = authorize(factory, OTHER_HUMAN);
    // Present OTHER_HUMAN's genuine token while claiming to be HUMAN: the gate
    // binds a token to one actor id, so it must not verify for a different one.
    await assert.rejects(service.cancel(loopId, HUMAN, tokenForOther), { code: "HUMAN_IDENTITY" });
  });

  it("F: an expired token cannot cancel", async () => {
    // A dedicated factory whose identity gate issues 1ms-lived tokens; the
    // fixture clock advances on every read, so any later verify sees an
    // expired token — the same TTL semantics accepted in TASK-001.
    const clock = createFixedClock("2026-01-01T00:00:00.000Z");
    const store = createInMemoryStore();
    const factory = new FactoryService({
      store,
      clock,
      ids: createSequentialIdGenerator(),
      identityGate: createLocalHumanIdentityGate({ credential: TEST_CREDENTIAL, clock, tokenTtlMs: 1 }),
      workerRegistry: createLocalWorkerRegistry(clock),
    });
    const item = await seedWorkItem(factory);
    const loops = createInMemoryLoopRepository();
    const loopId = "loop-cancel-expiry";
    await loops.create(seedReadyLoopRow(loopId, item.id, clock));
    const service = makeService(factory, loops, clock);

    const token = factory.authorizeHuman(HUMAN, TEST_CREDENTIAL); // valid at issue, but TTL is 1ms
    await assert.rejects(service.cancel(loopId, HUMAN, token), { code: "HUMAN_IDENTITY" });
    const after = await loops.findById(loopId);
    assert.equal(after?.phase, "READY");
  });

  it("G: a valid, currently-authorized trusted human CAN cancel", async () => {
    const { factory, service, loops, loopId } = await activeLoopSetup();
    const cancelled = await service.cancel(loopId, HUMAN, authorize(factory, HUMAN));
    assert.equal(cancelled.phase, "CANCELLED");
    assert.equal(cancelled.outcome, "CANCELLED");
    const durable = await loops.findById(loopId);
    assert.equal(durable?.phase, "CANCELLED");
  });

  it("H: a refused cancellation produces NO phase change, NO version change, and no worker side effect", async () => {
    const { service, loops, loopId } = await activeLoopSetup();
    const before = await loops.findById(loopId);
    assert.equal(before?.version, 1);
    await assert.rejects(service.cancel(loopId, AGENT), { code: "HUMAN_IDENTITY" });
    const afterAttempt = await loops.findById(loopId);
    assert.equal(afterAttempt?.version, 1, "an unauthorized cancel must not bump the loop version");
    assert.equal(afterAttempt?.phase, "READY", "an unauthorized cancel must not change loop phase");
    assert.equal(afterAttempt?.cancelRequested, false, "an unauthorized cancel must not record cancellation intent");
  });

  it("I: cancel-before-launch still produces zero children — and only a trusted human can trigger it", async () => {
    // A gated implementer that blocks in execute(); an authorized cancel while
    // it is gated must let the in-flight (already-authorized) run finish while
    // launching nothing after it. This preserves the round-1 linearization
    // guarantee under the new authorization requirement.
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const { toReady } = await import("./support/factoryFixtures.js");
    await toReady(factory, item.id);
    const loops = createInMemoryLoopRepository();

    let releaseImplementer!: () => void;
    const gate = new Promise<void>((resolve) => (releaseImplementer = resolve));
    let executeCalls = 0;
    const gatedImplementer = {
      id: "gated",
      capabilities: { roles: ["IMPLEMENTER"] as const, deterministic: true },
      async execute(request: { runId: string }) {
        executeCalls += 1;
        await gate;
        return {
          status: "SUCCEEDED" as const,
          summary: "done",
          evidence: [{ kind: "NOTE" as const, summary: "done", reference: `scripted://${request.runId}/transcript` }],
          claimsAcceptanceMet: true,
        };
      },
    };
    const { asLoopWorkerFactory, createScriptedReviewerWorker } = await import("../src/orchestration/scriptedLoopWorkers.js");
    const { resolveWorkspace } = await import("../src/adapters/workers/workspace.js");
    const { createTempWorkspace } = await import("./support/tempWorkspace.js");
    const service = new EngineeringLoopService({
      factory,
      loops,
      clock,
      ids: createSequentialIdGenerator(),
      processRunner,
      createImplementerWorker: () => gatedImplementer,
      createReviewerWorker: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["PASS"] })),
    });
    void store;
    const startPromise = service.start({
      workItemId: item.id,
      actor: HUMAN,
      taskInstructions: "Implement.",
      implementer: { tool: "claude-code", model: "test-model" },
      reviewer: { tool: "codex-cli", model: "test-model" },
      verificationCommands: [{ id: "trivial-pass", executable: process.execPath, argv: ["-e", "process.exit(0)"] }],
      workspace: resolveWorkspace(createTempWorkspace()),
    });

    await new Promise<void>((resolve) => {
      const check = (): void => {
        loops.listByWorkItem(item.id).then((found) => (found.length > 0 && executeCalls > 0 ? resolve() : setTimeout(check, 5)));
      };
      check();
    });
    const loopId = (await loops.listByWorkItem(item.id))[0]!.id;

    // Unauthorized cancel is refused even mid-flight.
    await assert.rejects(service.cancel(loopId, AGENT), { code: "HUMAN_IDENTITY" });
    // Authorized cancel is honored.
    const cancelled = await service.cancel(loopId, HUMAN, authorize(factory, HUMAN));
    releaseImplementer();
    const settled = await startPromise;

    assert.equal(cancelled.phase, "CANCELLED");
    assert.equal(settled.phase, "CANCELLED");
    const runs = await factory.listRuns(item.id);
    assert.equal(runs.filter((r) => r.role === "IMPLEMENTER").length, 1, "the in-flight run finishes; nothing launches after cancel");
    assert.equal(runs.filter((r) => r.role === "REVIEWER").length, 0, "no reviewer launches after cancellation");
  });

  it("J: the CLI cancellation path goes through the trusted-human boundary (supplies a valid token end to end)", async () => {
    // Seed a valid active loop directly into the SQLite loops DB the CLI will
    // open, then drive `sf loop cancel` through its real wiring. It succeeds
    // only because the CLI mints and presents a TrustedHumanToken — the
    // service would otherwise refuse with HUMAN_IDENTITY.
    const { runLoopCancel } = await import("../src/cli/loop.js");
    const factoryDbPath = tempDbPath();
    const loopsDbPath = tempDbPath();
    const loopsRepo = createSqliteLoopRepository(loopsDbPath);
    const clock = createFixedClock("2026-01-01T00:00:00.000Z");
    const loopId = "loop-cli-cancel";
    await loopsRepo.create(seedReadyLoopRow(loopId, "wi-cli", clock));
    loopsRepo.close();

    const view = await runLoopCancel(loopId, { factoryDbPath, loopsDbPath, log: () => {} });
    assert.equal(view.phase, "CANCELLED", "the CLI operator's minted trusted-human token authorizes cancellation");
  });
});

// =====================================================================
// HIGH 2 — WAITING_FOR_HUMAN authority re-derivation
// =====================================================================

describe("remediation round 3 — HIGH 2: WAITING_FOR_HUMAN is re-derived from current Factory authority", () => {
  it("A: a fabricated valid-serialization WAITING_FOR_HUMAN loop for an absent work item fails closed with ZERO reads/workers", async () => {
    // Uses the SQLite repo to prove the row genuinely passes strict
    // loopSerialization on read (the strongest form of the exploit).
    const { factory } = newFactory();
    const loopsDbPath = tempDbPath();
    const loops = createSqliteLoopRepository(loopsDbPath);
    const clock = createFixedClock("2026-01-01T00:00:00.000Z");
    const loopId = "loop-fabricated";
    await loops.create(seedWaitingLoopRow(loopId, "wi-never-existed", clock));

    // Parses back through strict validation as WAITING_FOR_HUMAN.
    assert.equal((await loops.findById(loopId))?.phase, "WAITING_FOR_HUMAN");

    const service = makeService(factory, loops, clock); // throwing worker factories
    const resumed = await service.resume(loopId);

    assert.equal(resumed.phase, "RECOVERY_REQUIRED", "an unbacked WAITING_FOR_HUMAN must fail closed, never be exposed as authoritative");
    assert.equal((await loops.findById(loopId))?.phase, "RECOVERY_REQUIRED", "the demotion is durable");
    loops.close();
  });

  it("B/C/L: a superseding (newer) implementation run invalidates the cached PASS — fail closed", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const fx = await toWaitingForHuman(factory, item.id);
    const loops = createInMemoryLoopRepository();
    await loops.create(seedWaitingLoopRow("loop-superseded", item.id, clock));

    // A newer IMPLEMENTER attempt becomes the lineage head; no verification or
    // review targets it, so the reviewed implementation is stale.
    await store.runs.create({
      id: "run-superseding-impl",
      workItemId: item.id,
      specRevision: 1,
      role: "IMPLEMENTER",
      workerPrincipalId: "principal-new",
      declaredWorkerId: "worker-new",
      status: "RUNNING",
      claimsAcceptanceMet: false,
      evidenceIds: [],
      startedAt: clock.now(),
    });
    await store.runs.complete("run-superseding-impl", {
      status: "SUCCEEDED",
      summary: "newer implementation",
      claimsAcceptanceMet: true,
      evidenceIds: [],
      finishedAt: clock.now(),
    });
    void fx;

    const resumed = await makeService(factory, loops, clock).resume("loop-superseded");
    assert.equal(resumed.phase, "RECOVERY_REQUIRED");
  });

  it("D: a bumped work-item specRevision makes the cached lineage stale — fail closed", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    await toWaitingForHuman(factory, item.id);
    const loops = createInMemoryLoopRepository();
    await loops.create(seedWaitingLoopRow("loop-staleRev", item.id, clock));

    const current = await factory.getWorkItem(item.id);
    await store.workItems.compareAndSave(
      { ...current, specRevision: current.specRevision + 1, version: current.version + 1, updatedAt: clock.now() },
      current.version,
    );

    const resumed = await makeService(factory, loops, clock).resume("loop-staleRev");
    assert.equal(resumed.phase, "RECOVERY_REQUIRED", "no implementation exists at the new spec revision — authority cannot be proven");
  });

  it("E: a non-independent semantic review (reviewer principal == implementer) is rejected — fail closed", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const fx = await toWaitingForHuman(factory, item.id);
    const loops = createInMemoryLoopRepository();
    await loops.create(seedWaitingLoopRow("loop-nonindependent", item.id, clock));

    const runs = await factory.listRuns(item.id);
    const implRun = runs.find((r) => r.id === fx.implementationRunId)!;
    // Append a newer (therefore authoritative) SEMANTIC review whose reviewer
    // principal equals the implementer's — the C4 violation resolveSemanticReview
    // must reject. recordReview itself refuses to create this, so it can only
    // arise from direct corruption; the loop must still fail closed.
    await store.reviews.save({
      id: "rev-nonindependent",
      workItemId: item.id,
      specRevision: implRun.specRevision,
      reviewedRunId: fx.implementationRunId,
      reviewerRunId: fx.reviewerRunId,
      kind: "SEMANTIC",
      reviewerPrincipalId: implRun.workerPrincipalId,
      implementerPrincipalId: implRun.workerPrincipalId,
      verdict: "PASS",
      findings: [],
      createdAt: clock.now(),
    });

    const resumed = await makeService(factory, loops, clock).resume("loop-nonindependent");
    assert.equal(resumed.phase, "RECOVERY_REQUIRED");
  });

  it("F: a newer FAILing deterministic review supersedes the cached PASS — fail closed", async () => {
    const { factory, clock, store } = newFactory();
    const item = await seedWorkItem(factory);
    const fx = await toWaitingForHuman(factory, item.id);
    const loops = createInMemoryLoopRepository();
    await loops.create(seedWaitingLoopRow("loop-detfail", item.id, clock));

    const runs = await factory.listRuns(item.id);
    const implRun = runs.find((r) => r.id === fx.implementationRunId)!;
    const verifierRun = runs.find((r) => r.id === fx.verifierRunId)!;
    await store.reviews.save({
      id: "rev-det-fail",
      workItemId: item.id,
      specRevision: verifierRun.specRevision,
      reviewedRunId: fx.implementationRunId,
      reviewerRunId: fx.verifierRunId,
      kind: "DETERMINISTIC",
      reviewerPrincipalId: verifierRun.workerPrincipalId,
      implementerPrincipalId: implRun.workerPrincipalId,
      verdict: "FAIL",
      findings: ["regression"],
      createdAt: clock.now(),
    });

    const resumed = await makeService(factory, loops, clock).resume("loop-detfail");
    assert.equal(resumed.phase, "RECOVERY_REQUIRED");
  });

  it("G: a cached PASS whose work item is not at REVIEW/WAITING_FOR_HUMAN (no current Factory review authority) fails closed", async () => {
    const { factory, clock } = newFactory();
    const item = await seedWorkItem(factory);
    const { toImplementing } = await import("./support/factoryFixtures.js");
    await toImplementing(factory, item.id); // item at IMPLEMENTING: no passing semantic review exists
    const loops = createInMemoryLoopRepository();
    await loops.create(seedWaitingLoopRow("loop-noreview", item.id, clock));

    const resumed = await makeService(factory, loops, clock).resume("loop-noreview");
    assert.equal(resumed.phase, "RECOVERY_REQUIRED", "loop-local PASS is never sufficient without current Factory authority");
  });

  it("I/J/K: a persisted WAITING_FOR_HUMAN with fully current authoritative lineage resumes unchanged — no duplicate model call, budget not double-counted", async () => {
    const { factory, clock } = newFactory();
    const item = await seedWorkItem(factory);
    await toWaitingForHuman(factory, item.id);
    const loops = createInMemoryLoopRepository();
    const row = seedWaitingLoopRow("loop-valid-waiting", item.id, clock);
    await loops.create(row);

    // throwing worker factories: a genuinely authoritative resume constructs
    // ZERO workers (the terminal path returns before any worker is built).
    const resumed = await makeService(factory, loops, clock).resume("loop-valid-waiting");

    assert.equal(resumed.phase, "WAITING_FOR_HUMAN", "a legitimately authoritative loop is still accepted");
    assert.equal(resumed.outcome, "WAITING_FOR_HUMAN");
    assert.equal(resumed.totalRunCount, row.totalRunCount, "recovered authoritative work must not be re-counted against budget");
  });

  it("stepReviewing branch: a stale REVIEWING checkpoint whose work item is already WAITING_FOR_HUMAN with valid lineage reconciles with no model call", async () => {
    // The reviewer specifically cited stepReviewing accepting a cached PASS
    // when the WorkItem is already WAITING_FOR_HUMAN. Build a genuinely
    // consistent stale-REVIEWING checkpoint by driving a real loop to
    // WAITING_FOR_HUMAN, then rewinding only the loop row's phase to REVIEWING
    // (its claims/runs stay consistent). Resume must re-derive authority
    // (valid here) and finish WITHOUT invoking the reviewer again.
    const { factory, clock } = newFactory();
    const item = await seedWorkItem(factory);
    const { toReady } = await import("./support/factoryFixtures.js");
    await toReady(factory, item.id);
    const loops = createInMemoryLoopRepository();
    const { asLoopWorkerFactory, createScriptedImplementerWorker, createScriptedReviewerWorker } = await import(
      "../src/orchestration/scriptedLoopWorkers.js"
    );
    const { resolveWorkspace } = await import("../src/adapters/workers/workspace.js");
    const { createTempWorkspace } = await import("./support/tempWorkspace.js");

    let reviewerCalls = 0;
    const countingReviewer = createScriptedReviewerWorker({ verdicts: ["PASS"] });
    const originalExecute = countingReviewer.execute.bind(countingReviewer);
    countingReviewer.execute = async (request) => {
      reviewerCalls += 1;
      return originalExecute(request);
    };

    const driveService = new EngineeringLoopService({
      factory,
      loops,
      clock,
      ids: createSequentialIdGenerator(),
      processRunner,
      createImplementerWorker: asLoopWorkerFactory(createScriptedImplementerWorker()),
      createReviewerWorker: asLoopWorkerFactory(countingReviewer),
    });
    const completed = await driveService.start({
      workItemId: item.id,
      actor: HUMAN,
      taskInstructions: "Implement.",
      implementer: { tool: "claude-code", model: "test-model" },
      reviewer: { tool: "codex-cli", model: "test-model" },
      verificationCommands: [{ id: "trivial-pass", executable: process.execPath, argv: ["-e", "process.exit(0)"] }],
      workspace: resolveWorkspace(createTempWorkspace()),
    });
    assert.equal(completed.phase, "WAITING_FOR_HUMAN");
    assert.equal(reviewerCalls, 1, "exactly one reviewer call during the real drive");

    // Rewind only the loop checkpoint to the stale REVIEWING shape (keeping the
    // consistent claims/runs + cached PASS), leaving the WorkItem at
    // WAITING_FOR_HUMAN — the exact crash window the reviewer cited.
    const staleReviewing: EngineeringLoop = {
      ...completed,
      phase: "REVIEWING",
      version: completed.version + 1,
    };
    // Strip the terminal-only field without assigning undefined (exactOptionalPropertyTypes).
    delete (staleReviewing as { outcome?: unknown }).outcome;
    await loops.compareAndSave(staleReviewing, completed.version);

    const resumed = await makeService(factory, loops, clock, {
      // scripted implementer/reviewer that would COUNT if invoked
      createImplementerWorker: asLoopWorkerFactory(createScriptedImplementerWorker()),
      createReviewerWorker: asLoopWorkerFactory(countingReviewer),
    }).resume(completed.id);

    assert.equal(resumed.phase, "WAITING_FOR_HUMAN", "valid lineage reconciles the stale checkpoint forward");
    assert.equal(reviewerCalls, 1, "reconciliation must NOT invoke the reviewer a second time");
  });
});
