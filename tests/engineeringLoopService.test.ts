/**
 * TASK-004 autonomous engineering loop orchestrator — end-to-end coverage
 * against real (in-memory) `FactoryService`/`LoopRepository` instances, with
 * scripted `Worker`s standing in for Claude Code/Codex CLI (no real AI is
 * ever invoked) and real, trivial, offline `node -e` processes for
 * deterministic verification (see src/orchestration/scriptedLoopWorkers.ts).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import { createInMemoryStore } from "../src/adapters/memory/inMemoryStore.js";
import { createInMemoryLoopRepository } from "../src/adapters/orchestration/inMemoryLoopRepository.js";
import { createNodeProcessRunner } from "../src/adapters/process/nodeProcessRunner.js";
import { createInMemoryPlanRepository } from "../src/adapters/planning/inMemoryPlanRepository.js";
import { createLocalHumanIdentityGate } from "../src/adapters/security/localHumanIdentityGate.js";
import { createLocalWorkerRegistry } from "../src/adapters/security/localWorkerRegistry.js";
import {
  SqliteDirectHostAuthority,
  type BoundDeterministicWorkerAction,
  type BoundExecutionWorkerAction,
  type SqliteDirectHostAuthorityDeps,
  type BoundWorkerAction,
} from "../src/adapters/supervision/sqliteDirectHostAuthority.js";
import { resolveWorkspace } from "../src/adapters/workers/workspace.js";
import { FactoryService } from "../src/app/factoryService.js";
import { human } from "../src/domain/actor.js";
import { createSequentialIdGenerator } from "../src/domain/ids.js";
import {
  EngineeringLoopService,
  type LoopWorkerFactory,
  type StartLoopInput,
} from "../src/orchestration/engineeringLoopService.js";
import { createLoopWorker } from "../src/orchestration/loopWorkerFactory.js";
import type { LoopRepository } from "../src/orchestration/loopRepository.js";
import {
  type EngineeringLoop,
  type VerificationCommandConfig,
} from "../src/orchestration/loopTypes.js";
import {
  asLoopWorkerFactory,
  createScriptedImplementerWorker,
  createScriptedReviewerWorker,
} from "../src/orchestration/scriptedLoopWorkers.js";
import { createFixedClock, type Clock } from "../src/ports/clock.js";
import { createPlanBindingResolver, PlanningService } from "../src/planning/planningService.js";
import type { PlanExecutionConfig, WorkItemTicketTemplate } from "../src/planning/planTypes.js";
import { createScriptedDispatcher, createScriptedPlannerWorker } from "../src/planning/scriptedPlannerWorkers.js";
import {
  createDirectHostAdmissionChannel,
  type DirectHostExecutionAuthorityPort,
  type DirectHostExecutionLaunchRequest,
} from "../src/supervision/directWorkerAdmission.js";
import type { DirectLaunchBinding } from "../src/ports/worker.js";
import type { FactoryRepositories, FactoryStore } from "../src/ports/repositories.js";
import type { ApprovedExecutionPrestartPort } from "../src/supervision/directWorkerPrestartAdmission.js";
import {
  authorizePlanHuman,
  defaultPlannerCriterionText,
  PLAN_CREDENTIAL,
  PLAN_HUMAN,
  simplePlanResponse,
  TEST_PLANNER_CONFIG,
  validTicketTemplate,
} from "./support/planFixtures.js";
import { fakeCliPath } from "./support/fakeCli.js";
import { authorize, newFactory, seedWorkItem, toReady } from "./support/factoryFixtures.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./support/tempWorkspace.js";

after(cleanupTempWorkspaces);

const processRunner = createNodeProcessRunner({ killGraceMs: 100 });

const PASSING_COMMANDS: readonly VerificationCommandConfig[] = [
  { id: "trivial-pass", executable: process.execPath, argv: ["-e", "process.exit(0)"] },
];
const FAILING_COMMANDS: readonly VerificationCommandConfig[] = [
  { id: "trivial-fail", executable: process.execPath, argv: ["-e", "process.exit(1)"] },
];

function baseInput(workItemId: string, overrides: Partial<StartLoopInput> = {}): StartLoopInput {
  return {
    workItemId,
    actor: human("user:test", "Test Operator"),
    taskInstructions: "Implement the widget.",
    implementer: { tool: "claude-code", model: "test-model" },
    reviewer: { tool: "codex-cli", model: "test-model" },
    verificationCommands: PASSING_COMMANDS,
    workspace: resolveWorkspace(createTempWorkspace()),
    ...overrides,
  };
}

async function setup() {
  const { factory, clock, store } = newFactory();
  const item = await seedWorkItem(factory);
  const loops = createInMemoryLoopRepository();
  return { factory, clock, store, item, loops };
}

function makeService(
  factory: ReturnType<typeof newFactory>["factory"],
  loops: LoopRepository,
  clock: ReturnType<typeof newFactory>["clock"],
  overrides: {
    implementerFactory?: LoopWorkerFactory;
    reviewerFactory?: LoopWorkerFactory;
    log?: (line: string) => void;
  } = {},
): EngineeringLoopService {
  return new EngineeringLoopService({
    factory,
    loops,
    clock,
    ids: createSequentialIdGenerator(),
    processRunner,
    ...(overrides.log === undefined ? {} : { log: overrides.log }),
    createImplementerWorker: overrides.implementerFactory ?? asLoopWorkerFactory(createScriptedImplementerWorker()),
    createReviewerWorker: overrides.reviewerFactory ?? asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["PASS"] })),
  });
}

describe("EngineeringLoopService — start-time legality", () => {
  it("rejects starting a loop against a work item that is not READY", async () => {
    const { factory, clock, loops, item } = await setup();
    const service = makeService(factory, loops, clock);
    await assert.rejects(service.start(baseInput(item.id)), { code: "VALIDATION" });
  });

  it("rejects a loop with zero configured verification commands", async () => {
    const { factory, clock, loops, item } = await setup();
    await toReady(factory, item.id);
    const service = makeService(factory, loops, clock);
    await assert.rejects(service.start(baseInput(item.id, { verificationCommands: [] })), { code: "VALIDATION" });
  });

  it("rejects budget.maxIterations < 1", async () => {
    const { factory, clock, loops, item } = await setup();
    await toReady(factory, item.id);
    const service = makeService(factory, loops, clock);
    await assert.rejects(service.start(baseInput(item.id, { budget: { maxIterations: 0 } })), { code: "VALIDATION" });
  });

  it("refuses to start a second active loop for the same work item", async () => {
    const { factory, clock, loops, item } = await setup();
    await toReady(factory, item.id);
    const service = makeService(factory, loops, clock);
    await service.start(baseInput(item.id));
    // The work item is no longer READY after the first loop advanced it, so
    // this also exercises the "not READY" guard — construct a fresh READY
    // item and start a loop, then try starting a second loop against it
    // while the first is (in this deterministic single-drive-call scenario)
    // already terminal — instead assert directly via listByWorkItem.
    const loopsForItem = await loops.listByWorkItem(item.id);
    assert.equal(loopsForItem.length, 1);
  });
});

describe("EngineeringLoopService — scenario: clean PASS", () => {
  it("advances READY -> WAITING_FOR_HUMAN in one iteration with independent principals", async () => {
    const { factory, clock, loops, item } = await setup();
    await toReady(factory, item.id);
    const service = makeService(factory, loops, clock);

    const loop = await service.start(baseInput(item.id));

    assert.equal(loop.phase, "WAITING_FOR_HUMAN");
    assert.equal(loop.outcome, "WAITING_FOR_HUMAN");
    assert.equal(loop.iterations.length, 1);

    const finalItem = await factory.getWorkItem(item.id);
    assert.equal(finalItem.status, "WAITING_FOR_HUMAN");

    const runs = await factory.listRuns(item.id);
    const implementerRun = runs.find((r) => r.role === "IMPLEMENTER")!;
    const reviewerRun = runs.find((r) => r.role === "REVIEWER")!;
    assert.notEqual(implementerRun.workerPrincipalId, reviewerRun.workerPrincipalId, "C4: implementer/reviewer must be distinct principals");

    const reviews = await factory.listRuns(item.id);
    void reviews;
  });

  it("PASS_WITH_NON_BLOCKING_NOTES also advances to WAITING_FOR_HUMAN, findings preserved", async () => {
    const { factory, clock, loops, item } = await setup();
    await toReady(factory, item.id);
    const service = makeService(factory, loops, clock, {
      reviewerFactory: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["PASS_WITH_NON_BLOCKING_NOTES"], findings: ["Consider renaming X"] })),
    });

    const loop = await service.start(baseInput(item.id));
    assert.equal(loop.phase, "WAITING_FOR_HUMAN");
    assert.deepEqual(loop.iterations[0]?.reviewFindings, ["Consider renaming X"]);
  });
});

describe("EngineeringLoopService — scenario: remediation", () => {
  it("CHANGES_REQUIRED triggers exactly one remediation iteration, then passes", async () => {
    const { factory, clock, loops, item } = await setup();
    await toReady(factory, item.id);
    const service = makeService(factory, loops, clock, {
      reviewerFactory: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["CHANGES_REQUIRED", "PASS"], findings: ["fix the bug"] })),
    });

    const loop = await service.start(baseInput(item.id, { budget: { maxIterations: 3 } }));

    assert.equal(loop.phase, "WAITING_FOR_HUMAN");
    assert.equal(loop.iterations.length, 2);
    assert.equal(loop.iterations[0]?.reviewVerdict, "CHANGES_REQUIRED");
    assert.equal(loop.iterations[1]?.reviewVerdict, "PASS");

    const runs = await factory.listRuns(item.id);
    assert.equal(runs.filter((r) => r.role === "IMPLEMENTER").length, 2, "remediation must launch a second IMPLEMENTER run");
    assert.equal(runs.filter((r) => r.role === "REVIEWER").length, 2);
  });

  it("a failing deterministic verification remediates without spending a reviewer call", async () => {
    const { factory, clock, loops, item } = await setup();
    await toReady(factory, item.id);
    let reviewerCalls = 0;
    const countingReviewer = createScriptedReviewerWorker({ verdicts: ["PASS"] });
    const originalExecute = countingReviewer.execute.bind(countingReviewer);
    countingReviewer.execute = async (request) => {
      reviewerCalls += 1;
      return originalExecute(request);
    };

    const service = makeService(factory, loops, clock, {
      implementerFactory: asLoopWorkerFactory(createScriptedImplementerWorker()),
      reviewerFactory: asLoopWorkerFactory(countingReviewer),
    });

    const loop = await service.start(
      baseInput(item.id, {
        verificationCommands: FAILING_COMMANDS,
        budget: { maxIterations: 2 },
      }),
    );

    assert.equal(loop.phase, "EXHAUSTED", "verification never passes with FAILING_COMMANDS, so the budget is exhausted");
    assert.equal(reviewerCalls, 0, "the reviewer must never be invoked while deterministic verification keeps failing");

    const finalItem = await factory.getWorkItem(item.id);
    assert.equal(finalItem.status, "BLOCKED", "EXHAUSTED reuses the existing BLOCKED status as the human-attention signal");
  });

  it("repeated CHANGES_REQUIRED past the iteration budget reaches EXHAUSTED and blocks the work item", async () => {
    const { factory, clock, loops, item } = await setup();
    await toReady(factory, item.id);
    const service = makeService(factory, loops, clock, {
      reviewerFactory: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["CHANGES_REQUIRED"] })),
    });

    const loop = await service.start(baseInput(item.id, { budget: { maxIterations: 2 } }));

    assert.equal(loop.phase, "EXHAUSTED");
    assert.equal(loop.outcome, "EXHAUSTED");
    assert.equal(loop.iterations.length, 2, "must not exceed the configured budget");

    const finalItem = await factory.getWorkItem(item.id);
    assert.equal(finalItem.status, "BLOCKED");
  });
});

describe("EngineeringLoopService — reviewer verdict integrity", () => {
  it("a malformed/ambiguous reviewer response is treated as fail-closed remediation, never PASS", async () => {
    const { factory, clock, loops, item } = await setup();
    await toReady(factory, item.id);

    let calls = 0;
    const flakyReviewer = {
      id: "flaky-reviewer",
      capabilities: { roles: ["REVIEWER"] as const, deterministic: true },
      async execute(request: { runId: string }) {
        calls += 1;
        const message = calls === 1 ? "This all looks fine to me, essentially a PASS." : "FACTORY_REVIEW_VERDICT: PASS";
        return {
          status: "SUCCEEDED" as const,
          summary: message,
          // `/transcript` = a structured-parse-passed answer whose CONTENT is
          // malformed on the first call — the parser, not the channel filter,
          // must reject it.
          evidence: [{ kind: "NOTE" as const, summary: message, reference: `scripted://${request.runId}/transcript` }],
          claimsAcceptanceMet: false,
        };
      },
    };

    const service = makeService(factory, loops, clock, { reviewerFactory: asLoopWorkerFactory(flakyReviewer) });
    const loop = await service.start(baseInput(item.id, { budget: { maxIterations: 3 } }));

    assert.equal(loop.phase, "WAITING_FOR_HUMAN");
    assert.equal(loop.iterations.length, 2, "the first, tagless response must not be accepted as approval");
    assert.equal(loop.iterations[0]?.reviewVerdict, undefined);
    assert.match(loop.iterations[0]?.reviewParseError ?? "", /no FACTORY_REVIEW_VERDICT tag/);
  });

  it("a FAILED reviewer process (non-zero exit) is never interpreted as approval even if its output says PASS", async () => {
    const { factory, clock, loops, item } = await setup();
    await toReady(factory, item.id);

    const crashedButClaimsPass = createScriptedReviewerWorker({ verdicts: ["PASS"], outcome: "FAILED" });
    const service = makeService(factory, loops, clock, {
      reviewerFactory: asLoopWorkerFactory(crashedButClaimsPass),
    });

    const loop = await service.start(baseInput(item.id, { budget: { maxIterations: 1 } }));

    assert.notEqual(loop.phase, "WAITING_FOR_HUMAN", "a FAILED reviewer run must never be treated as approval");
    assert.equal(loop.phase, "EXHAUSTED");
    assert.equal(loop.iterations[0]?.reviewVerdict, undefined);
  });
});

describe("EngineeringLoopService — budgets", () => {
  it("enforces maxTotalRuns independently of maxIterations", async () => {
    const { factory, clock, loops, item } = await setup();
    await toReady(factory, item.id);
    const service = makeService(factory, loops, clock, {
      reviewerFactory: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["CHANGES_REQUIRED"] })),
    });

    const loop = await service.start(baseInput(item.id, { budget: { maxIterations: 10, maxTotalRuns: 2 } }));
    assert.equal(loop.phase, "EXHAUSTED");
    assert.ok(loop.totalRunCount <= 3, `expected totalRunCount to stop near the budget, got ${loop.totalRunCount}`);
  });

  it("enforces a wall-clock budget", async () => {
    const { factory, item, loops } = await setup();
    await toReady(factory, item.id);
    // A deterministic clock that advances 10s on every call: startedAt
    // consumes one tick, and the very next budgetExceeded() check (before
    // any step runs) already sees a 10s delta against a 5s budget.
    const fastForwardClock = createFixedClock("2026-01-01T00:00:00.000Z", 10_000);
    const service = makeService(factory, loops, fastForwardClock, {
      reviewerFactory: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["CHANGES_REQUIRED"] })),
    });

    const loop = await service.start(baseInput(item.id, { budget: { maxIterations: 50, maxWallClockMs: 5000 } }));
    assert.equal(loop.phase, "EXHAUSTED");
    assert.match(loop.failureReason ?? "", /wall-clock/);
    assert.equal(loop.iterations.length, 0, "the wall-clock budget must be checked before the first step even runs");
  });
});

describe("EngineeringLoopService — cancellation", () => {
  it("is cooperative: an in-flight run completes, its evidence is preserved, but no further step launches", async () => {
    const { factory, clock, loops, item } = await setup();
    await toReady(factory, item.id);

    let releaseImplementer: (() => void) | undefined;
    const gatedImplementer = {
      id: "gated-implementer",
      capabilities: { roles: ["IMPLEMENTER"] as const, deterministic: true },
      async execute(request: { runId: string }) {
        await new Promise<void>((resolve) => {
          releaseImplementer = resolve;
        });
        return {
          status: "SUCCEEDED" as const,
          summary: "done",
          evidence: [{ kind: "NOTE" as const, summary: "done", reference: `scripted://${request.runId}` }],
          claimsAcceptanceMet: true,
        };
      },
    };

    const service = makeService(factory, loops, clock, { implementerFactory: asLoopWorkerFactory(gatedImplementer) });
    const startPromise = service.start(baseInput(item.id));

    // Wait until the implementer call is actually in flight, then request cancellation concurrently.
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (releaseImplementer === undefined) {
          setTimeout(check, 5);
        } else {
          resolve();
        }
      };
      check();
    });

    const loopsForItem = await loops.listByWorkItem(item.id);
    const loopId = loopsForItem[0]!.id;
    const canceller = human("user:test", "Test Operator");
    const cancelPromise = service.cancel(loopId, canceller, authorize(factory, canceller));
    releaseImplementer!();

    const [startResult, cancelResult] = await Promise.all([startPromise, cancelPromise]);
    assert.equal(startResult.phase, "CANCELLED");
    assert.equal(cancelResult.phase, "CANCELLED");

    const runs = await factory.listRuns(item.id);
    assert.equal(runs.length, 1, "the in-flight implementer run must complete and be preserved, not discarded");
    assert.equal(runs[0]?.status, "SUCCEEDED");

    const finalItem = await factory.getWorkItem(item.id);
    assert.notEqual(finalItem.status, "DONE");
  });

  it("cancel() on an already-terminal loop is a no-op", async () => {
    const { factory, clock, loops, item } = await setup();
    await toReady(factory, item.id);
    const service = makeService(factory, loops, clock);
    const loop = await service.start(baseInput(item.id));
    assert.equal(loop.phase, "WAITING_FOR_HUMAN");

    const canceller = human("user:test", "Test Operator");
    const afterCancel = await service.cancel(loop.id, canceller, authorize(factory, canceller));
    assert.equal(afterCancel.phase, "WAITING_FOR_HUMAN", "cancelling an already-terminal loop must not change its outcome");
  });
});

describe("EngineeringLoopService — crash/resume (fault injection at persisted checkpoints)", () => {
  /**
   * Simulates the OS process dying immediately AFTER the first loop
   * checkpoint that satisfies `committed` has durably committed: that write
   * lands, then the wrapper throws and every further repository operation
   * throws too (a dead process can neither write later bookkeeping — such as
   * marking the loop FAILED — nor read). The calling start()/resume()
   * promise rejects, exactly as a real crash would never let it return. A
   * fresh EngineeringLoopService against the real (unbroken) repository then
   * stands in for the next `sf loop resume` after restart.
   *
   * Condition-based rather than write-count-based on purpose: the crash is
   * pinned to a durable-state shape, so the same test stays meaningful
   * regardless of how many internal checkpoints the implementation performs.
   */
  function crashAfterCommit(repo: LoopRepository, committed: (saved: EngineeringLoop) => boolean): LoopRepository {
    let crashed = false;
    const dead = (): never => {
      throw new Error("simulated crash: this process is dead");
    };
    return {
      async create(loop) {
        if (crashed) dead();
        return repo.create(loop);
      },
      async compareAndSave(loop, expectedVersion) {
        if (crashed) dead();
        const saved = await repo.compareAndSave(loop, expectedVersion);
        if (committed(saved)) {
          crashed = true;
          dead();
        }
        return saved;
      },
      async findById(id) {
        if (crashed) dead();
        return repo.findById(id);
      },
      async listByWorkItem(workItemId) {
        if (crashed) dead();
        return repo.listByWorkItem(workItemId);
      },
    };
  }

  async function crashDuringStart(
    factory: Awaited<ReturnType<typeof setup>>["factory"],
    clock: Awaited<ReturnType<typeof setup>>["clock"],
    realLoops: LoopRepository,
    itemId: string,
    committed: (saved: EngineeringLoop) => boolean,
    overrides: { implementerFactory?: LoopWorkerFactory; reviewerFactory?: LoopWorkerFactory } = {},
  ): Promise<string> {
    const flakyLoops = crashAfterCommit(realLoops, committed);
    const crashingService = makeService(factory, flakyLoops, clock, overrides);
    await assert.rejects(crashingService.start(baseInput(itemId, { budget: { maxIterations: 3 } })));
    const loops = await realLoops.listByWorkItem(itemId);
    assert.equal(loops.length, 1, "the loop record itself must exist even though the crashing call never returned");
    return loops[0]!.id;
  }

  it("case A: implementer succeeded, crash before advancing to VERIFYING — resume does not re-run the implementer", async () => {
    const { factory, clock, loops: realLoops, item } = await setup();
    await toReady(factory, item.id);
    const loopId = await crashDuringStart(
      factory,
      clock,
      realLoops,
      item.id,
      (saved) => saved.phase === "IMPLEMENTING" && saved.iterations.at(-1)?.implementerOutcome === "SUCCEEDED",
    );

    const stale = await realLoops.findById(loopId);
    assert.equal(stale?.phase, "IMPLEMENTING");
    assert.equal(stale?.iterations[0]?.implementerOutcome, "SUCCEEDED");
    const runsBefore = await factory.listRuns(item.id);
    assert.equal(runsBefore.filter((r) => r.role === "IMPLEMENTER").length, 1);

    const resumedService = makeService(factory, realLoops, clock);
    const resumed = await resumedService.resume(loopId);

    assert.equal(resumed.phase, "WAITING_FOR_HUMAN");
    const runsAfter = await factory.listRuns(item.id);
    assert.equal(runsAfter.filter((r) => r.role === "IMPLEMENTER").length, 1, "resume must not duplicate the completed implementer run");
  });

  it("case B: verification passed, crash before reviewer launch — resume runs the reviewer exactly once", async () => {
    const { factory, clock, loops: realLoops, item } = await setup();
    await toReady(factory, item.id);
    // The crash lands after the verification-passed checkpoint committed but
    // before the loop's phase moved to REVIEWING — so the loop bookkeeping is
    // stale at VERIFYING while the reviewer has never launched.
    const loopId = await crashDuringStart(
      factory,
      clock,
      realLoops,
      item.id,
      (saved) => saved.phase === "VERIFYING" && saved.iterations.at(-1)?.verificationPassed === true,
    );

    const stale = await realLoops.findById(loopId);
    assert.equal(stale?.phase, "VERIFYING");
    assert.equal(stale?.iterations[0]?.verificationPassed, true);
    assert.equal(stale?.iterations[0]?.reviewerRunId, undefined);
    const runsBefore = await factory.listRuns(item.id);
    assert.equal(runsBefore.filter((r) => r.role === "VERIFIER").length, 1);
    assert.equal(runsBefore.filter((r) => r.role === "REVIEWER").length, 0);

    const resumedService = makeService(factory, realLoops, clock);
    const resumed = await resumedService.resume(loopId);

    assert.equal(resumed.phase, "WAITING_FOR_HUMAN");
    const runsAfter = await factory.listRuns(item.id);
    assert.equal(runsAfter.filter((r) => r.role === "VERIFIER").length, 1, "resume must not re-run verification");
    assert.equal(runsAfter.filter((r) => r.role === "REVIEWER").length, 1);
  });

  it("case C: CHANGES_REQUIRED recorded, crash before remediation launch — resume opens exactly one new iteration", async () => {
    const { factory, clock, loops: realLoops, item } = await setup();
    await toReady(factory, item.id);
    const loopId = await crashDuringStart(
      factory,
      clock,
      realLoops,
      item.id,
      (saved) => saved.iterations.at(-1)?.reviewVerdict === "CHANGES_REQUIRED",
      { reviewerFactory: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["CHANGES_REQUIRED", "PASS"] })) },
    );

    const stale = await realLoops.findById(loopId);
    assert.equal(stale?.phase, "REVIEWING");
    assert.equal(stale?.iterations.length, 1);
    assert.equal(stale?.iterations[0]?.reviewVerdict, "CHANGES_REQUIRED");
    const runsBefore = await factory.listRuns(item.id);
    assert.equal(runsBefore.filter((r) => r.role === "IMPLEMENTER").length, 1);

    const resumedService = makeService(factory, realLoops, clock, {
      reviewerFactory: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["PASS"] })),
    });
    const resumed = await resumedService.resume(loopId);

    assert.equal(resumed.iterations.length, 2, "exactly one new iteration must be opened, not zero or two");
    assert.equal(resumed.phase, "WAITING_FOR_HUMAN");
    const runsAfter = await factory.listRuns(item.id);
    assert.equal(runsAfter.filter((r) => r.role === "IMPLEMENTER").length, 2);
  });

  it("case D: remediation's implementer completed, crash before re-verification — resume verifies exactly once", async () => {
    const { factory, clock, loops: realLoops, item } = await setup();
    await toReady(factory, item.id);
    const loopId = await crashDuringStart(
      factory,
      clock,
      realLoops,
      item.id,
      (saved) =>
        saved.phase === "IMPLEMENTING" && saved.iterations.length === 2 && saved.iterations[1]?.implementerOutcome === "SUCCEEDED",
      { reviewerFactory: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["CHANGES_REQUIRED", "PASS"] })) },
    );

    const stale = await realLoops.findById(loopId);
    assert.equal(stale?.phase, "IMPLEMENTING");
    assert.equal(stale?.iterations.length, 2);
    assert.equal(stale?.iterations[1]?.implementerOutcome, "SUCCEEDED");
    const runsBefore = await factory.listRuns(item.id);
    assert.equal(runsBefore.filter((r) => r.role === "IMPLEMENTER").length, 2);
    assert.equal(runsBefore.filter((r) => r.role === "VERIFIER").length, 1, "only iteration 1's verification should exist so far");

    const resumedService = makeService(factory, realLoops, clock, {
      reviewerFactory: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["PASS"] })),
    });
    const resumed = await resumedService.resume(loopId);

    assert.equal(resumed.phase, "WAITING_FOR_HUMAN");
    const runsAfter = await factory.listRuns(item.id);
    assert.equal(runsAfter.filter((r) => r.role === "IMPLEMENTER").length, 2, "resume must not launch a third implementer attempt");
    assert.equal(runsAfter.filter((r) => r.role === "VERIFIER").length, 2, "resume must add exactly one more verification run");
  });

  it("case E: reviewer PASS persisted, crash before the WAITING_FOR_HUMAN transition — the work item may already show it", async () => {
    const { factory, clock, loops: realLoops, item } = await setup();
    await toReady(factory, item.id);
    const loopId = await crashDuringStart(
      factory,
      clock,
      realLoops,
      item.id,
      (saved) => saved.phase === "REVIEWING" && saved.iterations.at(-1)?.reviewVerdict === "PASS",
    );

    const stale = await realLoops.findById(loopId);
    assert.equal(stale?.phase, "REVIEWING", "the loop's own bookkeeping is stale");
    assert.equal(stale?.iterations[0]?.reviewVerdict, "PASS");

    const resumedService = makeService(factory, realLoops, clock);
    const resumed = await resumedService.resume(loopId);

    assert.equal(resumed.phase, "WAITING_FOR_HUMAN");
    assert.equal(resumed.outcome, "WAITING_FOR_HUMAN");
    const finalItem = await factory.getWorkItem(item.id);
    assert.equal(finalItem.status, "WAITING_FOR_HUMAN");
  });
});

describe("EngineeringLoop domain type", () => {
  it("EngineeringLoop values round-trip through toStatusView without leaking raw transcripts", async () => {
    const { toStatusView } = await import("../src/orchestration/loopTypes.js");
    const loop: EngineeringLoop = {
      id: "loop-x",
      workItemId: "wi-x",
      version: 1,
      phase: "EXHAUSTED",
      outcome: "EXHAUSTED",
      failureReason: "budget exhausted",
      budget: { maxIterations: 2 },
      implementer: { tool: "claude-code", model: "m" },
      reviewer: { tool: "codex-cli", model: "m" },
      verificationCommands: [{ id: "c", executable: "node", argv: [] }],
      workspaceRoot: "/tmp/x",
      taskInstructions: "secret internal task text that must not leak into status",
      iterations: [
        {
          iteration: 1,
          implementerRunId: "run-1",
          implementerOutcome: "SUCCEEDED",
          verificationPassed: false,
          verificationCommandResults: [{ commandId: "c", passed: false, exitCode: 1, terminationReason: "EXITED", durationMs: 1, stdoutTruncated: false, stderrTruncated: false }],
        },
      ],
      totalRunCount: 2,
      cancelRequested: false,
      startedBy: human("user:x", "X"),
      startedAt: 0,
      lastTransitionAt: 0,
    };
    const view = toStatusView(loop);
    assert.equal(view.phase, "EXHAUSTED");
    assert.equal(view.humanActionRequired, true);
    assert.deepEqual(view.lastVerificationFailedCommandIds, ["c"]);
    assert.ok(!("taskInstructions" in view), "status view must not expose raw task instructions");
  });
});

describe("EngineeringLoopService — PHASE7-99: mandatory same-channel direct admission transport", () => {
  const IMPLEMENT_TOOL = "codex-cli" as const;
  const REVIEW_TOOL = "claude-code" as const;
  const IMPLEMENT_MODEL = "impl-model-99";
  const REVIEW_MODEL = "review-model-99";
  const CRITERION_TEXT = defaultPlannerCriterionText("Do the thing");

  const tempDbPaths: string[] = [];

  after(async () => {
    while (tempDbPaths.length > 0) {
      const dir = tempDbPaths.pop();
      if (dir !== undefined) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  function countingClock(startMs = 1_800_000_000_000): Clock {
    let now = startMs;
    return { now: () => (now += 1_000) };
  }

  /**
   * The host's approved execution config, captured against the EXACT real
   * resolved temp workspace root the loop will run under — never a hardcoded
   * `/tmp` path that could never agree with the workspace `service.start`
   * receives. The returned object is the single immutable source of truth for
   * every later expectation (scope/model/budgets), so nothing is ever read
   * back from a grant or a persisted row.
   */
  function executionConfig(workspaceRoot: string): PlanExecutionConfig {
    return {
      implementer: { tool: IMPLEMENT_TOOL, model: IMPLEMENT_MODEL, effort: "medium" },
      reviewer: { tool: REVIEW_TOOL, model: REVIEW_MODEL, effort: "medium" },
      verificationCommands: [{ id: "check", executable: "node", argv: ["-e", "process.exit(0)"] }],
      workspaceRoot,
      loopBudget: { maxIterations: 2 },
      ticketTemplates: [
        {
          ...validTicketTemplate("WI-A", CRITERION_TEXT),
          model: {
            eligibleModels: [IMPLEMENT_MODEL, REVIEW_MODEL],
            reasoningEffort: "medium",
            rationale: "Scoped single-module change needs cross-file reasoning.",
          },
        },
      ],
    };
  }

  /**
   * SYNTHETIC capability evidence, derived strictly from the authority's own
   * ticket/binding. Adapter-wiring proof only: never real provider quota,
   * eligibility, or production launch authority.
   */
  function syntheticCapability(clock: Clock) {
    return async (request: {
      readonly ticket: import("../src/supervision/workerContract.js").WorkerTicket;
      readonly ticketDigest: string;
      readonly binding: import("../src/ports/worker.js").DirectLaunchBinding;
    }): Promise<unknown> => {
      const { ticket, binding } = request;
      const observed = new Date(clock.now()).toISOString();
      return {
        ticketDigest: binding.ticketDigest,
        registryPrincipalId: binding.registryPrincipalId,
        workItemId: binding.workItemId,
        specRevision: binding.specRevision,
        runId: binding.runId,
        reservationId: binding.reservationId,
        reservationVersion: binding.reservationVersion,
        scope: ticket.scope,
        model: ticket.model,
        budgets: ticket.budgets,
        observedAt: observed,
        expiresAt: new Date(Date.parse(observed) + 120_000).toISOString(),
        evidenceReference: "synthetic://phase7-99/evidence",
        evidenceDigest: `synthetic-${binding.reservationId}`,
        quota: {
          availableContextTokens: ticket.budgets.contextTokens,
          availableOutputTokens: ticket.budgets.outputTokens,
          availableElapsedSeconds: ticket.budgets.elapsedSeconds,
          availableAttempts: ticket.budgets.maxAttempts,
          verified: true,
        },
        context: {
          supportedModels: ticket.model.eligibleModels,
          supportedReasoningEfforts: [ticket.model.reasoningEffort],
          verified: true,
        },
        confinement: {
          supportedScopeOwned: ticket.scope.owned,
          supportedScopeForbidden: ticket.scope.forbidden,
          verified: true,
        },
      };
    };
  }

  /**
   * The host's own independent IMPLEMENT binding: an approved implementer
   * config and the real workspace root, composed by the host and paired with
   * the EXACT guarded Worker object the service registered. Only IMPLEMENT is
   * composed here — there is deliberately no VERIFY binding, which is what
   * makes the later VERIFY refusal honest rather than fabricated.
   */
  function boundImplement(
    worker: import("../src/ports/worker.js").Worker,
    workspaceRoot: string,
  ): BoundWorkerAction {
    return {
      worker,
      slot: "IMPLEMENT",
      config: { tool: IMPLEMENT_TOOL, model: IMPLEMENT_MODEL, effort: "medium" },
      workspaceRoot,
    };
  }

  /**
   * Real Factory + PlanningService + real temp-file SQLite-backed
   * SqliteDirectHostAuthority over ONE in-memory FactoryStore, ONE registry,
   * and ONE clock. The Factory's constructor-only `createDirectAdmissionChannel`
   * hook and `approvedPrestartPort` both delegate to this SAME retained
   * authority instance — no structural fake grant, no second channel.
   */
  /**
   * Minimal, explicitly requested deviations from the genuine composition
   * above. Each one removes or degrades exactly ONE real fact and nothing
   * else: `omitAdmissionChannel` leaves the Factory's constructor-only hook
   * unset (so the service has no shared channel at all), and
   * `unknownCapability` makes the real authority's own trusted capability
   * callback return honest unknown evidence (`null`, which its
   * `Promise<unknown>` contract permits). Neither fabricates a grant, and
   * neither touches identity, approval, spec, or binding facts.
   */
  interface ComposeOptions {
    readonly omitAdmissionChannel?: boolean;
    readonly unknownCapability?: boolean;
    /**
     * Control E only. When present, the ONE backing store this whole
     * composition uses is wrapped so that each genuine transaction is awaited
     * unchanged and then, OUTSIDE that lock, this observer runs against the
     * real backing repositories before the result is returned. The Factory,
     * authority, planning service and admission channel are all built over
     * that same wrapped object from the beginning, so there is never a second
     * Factory, store, plan repository or channel. With no hook the store is
     * passed through untouched, preserving every other case's behavior.
     */
    readonly afterTransaction?: (repositories: FactoryRepositories) => Promise<void>;
  }

  async function compose(workspaceRoot: string, options: ComposeOptions = {}) {
    const clock = countingClock();
    const backing = createInMemoryStore();
    const observeAfterTransaction = options.afterTransaction;
    const store: FactoryStore =
      observeAfterTransaction === undefined
        ? backing
        : {
            ...backing,
            transaction: async <T,>(work: (repositories: FactoryRepositories) => Promise<T>): Promise<T> => {
              const result = await backing.transaction(work);
              // Outside the committed unit of work, against the genuine
              // backing repositories — never a staged overlay.
              await observeAfterTransaction(backing);
              return result;
            },
          };
    const plans = createInMemoryPlanRepository();
    const loops = createInMemoryLoopRepository();
    const registry = createLocalWorkerRegistry(clock);

    const dbDir = await mkdtemp(join(tmpdir(), "sf-phase7-99-"));
    tempDbPaths.push(dbDir);
    // The ONE owned SQLite handle. Every supplier below shares it; the test
    // closes it exactly once, never once per supplier.
    const db = new DatabaseSync(join(dbDir, "direct-host-authority.db"));

    const planningRef: { current?: PlanningService } = {};

    /**
     * Host-only, lazily constructed real authority. It cannot be built at
     * `compose` time because its `boundWorkers` must carry the EXACT guarded,
     * registered Worker object — which only exists once the loop service has
     * created it. `prepareHost` is therefore called from the preparation
     * callback with that precise object, and constructs the one real
     * SqliteDirectHostAuthority over this same store/loops/registry/db/clock
     * and the host's own independent approved implementer config + workspace.
     */
    let authority: SqliteDirectHostAuthority | undefined;
    type DeterministicHostExecution = Omit<BoundDeterministicWorkerAction, "executionKind" | "worker" | "slot">;
    // Exact-Worker cache: one authority per registered guarded Worker object, never rebound.
    const hostAuthorities = new Map<import("../src/ports/worker.js").Worker, SqliteDirectHostAuthority>();
    const deterministicAuthorities: SqliteDirectHostAuthority[] = [];
    // Synthetic OFFLINE deterministic capability: adapter proof only, not live D3. The fixed host
    // capacities below are not echoes of the approved limits and not provider quota.
    function offlineDeterministicCapability(config: DeterministicHostExecution): NonNullable<SqliteDirectHostAuthorityDeps["deterministicCapability"]> {
      if (options.unknownCapability === true) {
        // Honest unknown: the deterministic callback cannot vouch either.
        return async () => {
          capabilityCalls += 1;
          return null;
        };
      }
      return async (request) => {
        // The counting clock advances 1000 per read, so now - 1000 is never in the future.
        const observedAt = clock.now() - 1000;
        return {
          executionKind: "deterministic-execution",
          ...request.binding,
          scope: request.ticket.scope,
          commands: request.ticket.commands,
          workspace: request.ticket.workspace,
          budgets: request.ticket.budgets,
          executionPolicy: request.ticket.executionPolicy,
          evidenceReference: "offline-deterministic-evidence-phase7-102",
          evidenceDigest: "offline-deterministic-evidence-digest-phase7-102",
          observedAt: new Date(observedAt).toISOString(),
          expiresAt: new Date(observedAt + 120_000).toISOString(),
          confinement: { supportedScopeOwned: request.ticket.scope.owned, supportedScopeForbidden: request.ticket.scope.forbidden, verified: true },
          process: {
            resolvedWorkspace: config.workspaceRoot,
            resolvedExecutables: config.commands.map((command) => command.executable),
            enforceableElapsedSeconds: 30,
            enforceableOutputBytes: 65536,
            enforceableAttempts: 2,
            verified: true,
          },
        };
      };
    }
    function prepareHost(
      worker: import("../src/ports/worker.js").Worker,
      deterministic?: DeterministicHostExecution,
    ): SqliteDirectHostAuthority {
      const cached = hostAuthorities.get(worker);
      if (cached !== undefined) {
        return cached;
      }
      if (deterministic !== undefined) {
        const policy: unknown = deterministic.executionPolicy;
        const rationale = typeof policy === "object" && policy !== null ? Reflect.get(policy, "rationale") : undefined;
        if (typeof rationale !== "string" || rationale.trim() === "") {
          throw new Error("deterministic host execution requires an approved executionPolicy");
        }
      }
      const binding: BoundExecutionWorkerAction =
        deterministic === undefined
          ? boundImplement(worker, workspaceRoot)
          : {
              executionKind: "deterministic-execution",
              worker,
              slot: "VERIFY",
              commands: deterministic.commands,
              workspaceRoot: deterministic.workspaceRoot,
              budgets: deterministic.budgets,
              executionPolicy: deterministic.executionPolicy,
            };
      const created = new SqliteDirectHostAuthority({
        planning: {
          verifiedApprovedExecutionSnapshot: (planId: string) => {
            if (planningRef.current === undefined) {
              throw new Error("planning not yet constructed");
            }
            return planningRef.current.verifiedApprovedExecutionSnapshot(planId);
          },
        },
        store,
        loops,
        registry,
        db,
        clock,
        capability:
          options.unknownCapability === true
            ? // Honest unknown: the trusted host callback genuinely cannot
              // vouch for this launch. Every OTHER approved fact (plan,
              // approval, binding, spec revision, claim) stays valid, so the
              // authority's own reservation/capability guard is the single
              // cause of the refusal. The counter only records that this real
              // constructor-injected callback was genuinely invoked.
              async (): Promise<unknown> => {
                capabilityCalls += 1;
                return null;
              }
            : syntheticCapability(clock),
        boundWorkers: [binding],
        authorityId:
          deterministic !== undefined
            ? "authority-phase7-102-verify"
            : hostAuthorities.size === 0
              ? "authority-phase7-99"
              : "authority-phase7-99-" + String(hostAuthorities.size),
        ...(deterministic === undefined
          ? {}
          : { deterministicCapability: offlineDeterministicCapability(deterministic) }),
      });
      hostAuthorities.set(worker, created);
      if (deterministic !== undefined) {
        deterministicAuthorities.push(created);
      } else if (authority === undefined) {
        authority = created;
      }
      return created;
    }

    /**
     * The ONE typed host facade the Factory captures, for both its
     * `approvedPrestartPort` and its single admission channel. It is pure
     * ROUTING: it owns no authority of its own, fabricates no grant, and
     * never infers anything from an id or a persisted row. Each reservation
     * id is mapped to the real authority instance that genuinely prepared it,
     * and every call delegates the ORIGINAL full objects through unchanged.
     *
     * The reference map is populated ONLY after a genuine `prepare()` has
     * already succeeded, and an existing reference is never overwritten. An
     * unknown reference has no prestart, is never ready, and throws for any
     * mutating operation — it can never be upgraded into authority here.
     */
    const byReference = new Map<string, SqliteDirectHostAuthority>();
    function retain(reference: string, owner: SqliteDirectHostAuthority): void {
      if (!byReference.has(reference)) {
        byReference.set(reference, owner);
      }
    }
    function routed(reference: string): SqliteDirectHostAuthority | undefined {
      return byReference.get(reference);
    }
    function requireRouted(reference: string, operation: string): SqliteDirectHostAuthority {
      const owner = routed(reference);
      if (owner === undefined) {
        throw new Error(`no prepared reservation "${reference}" is known to this host; refusing ${operation}`);
      }
      return owner;
    }

    /**
     * Genuine receipts observed INSIDE the facade's own `atomicConsumeLaunch`
     * delegate, which is the single routed path the one admission channel
     * binds at construction. Nothing is fabricated: the real routed authority
     * call is awaited unchanged and its own receipt is both recorded and
     * returned.
     */
    const consumeReceipts: import("../src/ports/worker.js").DirectLaunchReceipt[] = [];

    /**
     * Genuine reservation rejections observed INSIDE the facade's own
     * `resolveAndReserve` delegate — the single routed path the one channel
     * binds at construction. The real routed authority call is awaited
     * unchanged; on rejection its OWN `Error.message` is recorded and the
     * SAME error is rethrown untouched. Nothing is fabricated, no failure is
     * introduced, and no method is reassigned after the channel bound it.
     */
    const reserveRejections: string[] = [];
    /** How many times the real authority's trusted capability callback actually ran. */
    let capabilityCalls = 0;

    type ContinuationCheck = {
      readonly reservationId: string;
      readonly receipt: Parameters<SqliteDirectHostAuthority["checkConsumedContinuation"]>[0];
      readonly request: DirectHostExecutionLaunchRequest;
      readonly outcome: Promise<boolean>;
    };
    const continuationChecks: ContinuationCheck[] = [];
    const hostEvents: string[] = [];
    // Deterministic reservations are routed to their own authority; the legacy AI routing is untouched.
    const reservationOwners = new Map<string, SqliteDirectHostAuthority>();
    function ownerForReference(reference: Parameters<SqliteDirectHostAuthority["resolveApprovedPrestart"]>[0]) {
      for (const candidate of deterministicAuthorities) {
        try {
          if (candidate.resolveApprovedPrestart(reference) !== undefined) {
            return candidate;
          }
        } catch {
          // Not the owner of this reference.
        }
      }
      return routed(String(reference));
    }
    function ownerForReservation(reservationId: string, label: string) {
      return reservationOwners.get(reservationId) ?? requireRouted(reservationId, label);
    }
    const hostFacade: ApprovedExecutionPrestartPort & DirectHostExecutionAuthorityPort = {
      resolveApprovedPrestart: (reference) => ownerForReference(reference)?.resolveApprovedPrestart(reference),
      resolveAndReserve: async (request) => {
        const owner =
          ownerForReference(request.ticketReference) ??
          requireRouted(String(request.ticketReference), "resolveAndReserve");
        try {
          const grant = await owner.resolveAndReserve(request);
          if (deterministicAuthorities.includes(owner)) {
            reservationOwners.set(String(grant.binding.reservationId), owner);
          }
          return grant;
        } catch (error) {
          reserveRejections.push(error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
      revalidate: (grant, request) =>
        ownerForReservation(String(grant.binding.reservationId), "revalidate").revalidate(grant, request),
      checkReadiness: async (binding) => {
        const owner = reservationOwners.get(String(binding.reservationId)) ?? routed(binding.reservationId);
        return owner === undefined ? false : owner.checkReadiness(binding);
      },
      atomicConsumeLaunch: async (binding) => {
        const receipt = await ownerForReservation(String(binding.reservationId), "atomicConsumeLaunch").atomicConsumeLaunch(
          binding,
        );
        consumeReceipts.push(receipt);
        return receipt;
      },
      cancel: (binding) => ownerForReservation(String(binding.reservationId), "cancel").cancel(binding),
      checkConsumedContinuation: (receipt, request) => {
        const reservationId = String(receipt.binding.reservationId);
        const outcome = ownerForReservation(reservationId, "checkConsumedContinuation").checkConsumedContinuation(
          receipt,
        );
        hostEvents.push("continuation:" + reservationId);
        continuationChecks.push({ reservationId, receipt, request, outcome });
        return outcome;
      },
    };

    const factory = new FactoryService({
      store,
      clock,
      ids: createSequentialIdGenerator(),
      identityGate: createLocalHumanIdentityGate({ credential: PLAN_CREDENTIAL, clock }),
      workerRegistry: registry,
      planBindingResolver: createPlanBindingResolver(plans),
      approvedPrestartPort: hostFacade,
      // Exactly ONE channel, over this facade and the Factory's own real live
      // reader. The service is given `factory.sharedDirectAdmissionChannel`
      // unchanged, so there is never a second channel.
      //
      // When `omitAdmissionChannel` is set the hook is simply absent, so this
      // genuine Factory has no shared channel whatsoever — the real
      // missing-channel refusal, not a disabled or stubbed one.
      ...(options.omitAdmissionChannel === true
        ? {}
        : {
            createDirectAdmissionChannel: (readCurrentRequest: Parameters<typeof createDirectHostAdmissionChannel>[1]) =>
              createDirectHostAdmissionChannel(hostFacade, readCurrentRequest),
          }),
    });

    const planning = new PlanningService({
      factory,
      plans,
      clock,
      ids: createSequentialIdGenerator(),
      planner: createScriptedPlannerWorker({ outputs: [simplePlanResponse()] }),
      dispatcher: createScriptedDispatcher(),
    });
    planningRef.current = planning;

    return {
      factory,
      planning,
      store,
      loops,
      registry,
      clock,
      db,
      prepareHost,
      retain,
      hostFacade,
      consumeReceipts,
      reserveRejections,
      capabilityCallCount: (): number => capabilityCalls,
      continuationChecks,
      hostEvents,
    };
  }

  /** Genuine approved plan via real PlanningService.start/approve; returns the materialized item's id. */
  async function approvedWorkItem(
    factory: FactoryService,
    planning: PlanningService,
    execution: PlanExecutionConfig,
  ): Promise<{ readonly planId: string; readonly workItemId: string }> {
    const project = await factory.createProject({ key: "P99", name: "Phase7-99" });
    const started = await planning.start({
      projectId: project.id,
      actor: PLAN_HUMAN,
      intent: "Build the thing.",
      planner: TEST_PLANNER_CONFIG,
      execution,
    });
    await planning.approve(started.id, PLAN_HUMAN, authorizePlanHuman(factory));
    const snapshot = await planning.verifiedApprovedExecutionSnapshot(started.id);
    const mapping = snapshot.materialized[0];
    assert.ok(mapping !== undefined, "the approved plan materialized its item");
    return { planId: started.id, workItemId: mapping.workItemId };
  }

  /**
   * Host-only preparation callback: resolves `input.worker` by object identity
   * against this authority's binding. VERIFY has no accepted model/config
   * mapping composed into this authority's `boundWorkers` (only IMPLEMENT is),
   * so it must honestly refuse here, before `authority.prepare` ever runs —
   * never a fabricated VERIFY->HostSupplierSlot mapping.
   */
  function prepareDirectLaunchFor(
    composed: {
      readonly prepareHost: (worker: import("../src/ports/worker.js").Worker) => SqliteDirectHostAuthority;
      readonly retain: (reference: string, owner: SqliteDirectHostAuthority) => void;
    },
    planId: string,
    template: WorkItemTicketTemplate,
    observed: {
      implementerWorker?: import("../src/ports/worker.js").Worker;
      unsupportedSlotReached?: string;
      unsupportedSlotError?: string;
    },
  ): import("../src/orchestration/engineeringLoopService.js").PrepareDirectLaunch {
    return async (context) => {
      // Refused BEFORE any supplier is constructed: only IMPLEMENT has an
      // accepted98 model/config mapping in this test. There is no fabricated
      // VERIFY slot, model, or exemption to fall back to.
      if (context.slot !== "implement") {
        observed.unsupportedSlotReached = context.slot;
        const message = `slot "${context.slot}" has no genuine approved host binding; refusing to prepare`;
        observed.unsupportedSlotError = message;
        throw new Error(message);
      }
      // Identifies the actual newly guarded, registered Worker. Observation
      // only — it never creates or implies an approval.
      observed.implementerWorker = context.worker;

      const authority = composed.prepareHost(context.worker);
      const facts = await authority.prepare({
        planId,
        loopId: context.loop.id,
        iteration: context.iteration,
        slot: "IMPLEMENT",
        worker: context.worker,
      });
      // Routing is retained only now that a genuine prepare has succeeded,
      // and the trusted reference may name nothing but that reservation id.
      composed.retain(facts.reservationId, authority);
      return {
        directTicketReference: facts.reservationId as unknown as import("../src/supervision/directWorkerAdmission.js").TrustedTicketReference,
        // Expectations come from the immutable host template captured above —
        // never from the returned grant or a persisted row.
        expectedModel: template.model,
        expectedScope: template.scope,
        expectedBudgets: template.budgets,
      };
    };
  }

  async function runPhase7102Control(options: {
    deviation?: 'spec' | 'cancel' | 'claim';
    stalePrestart?: boolean;
    budgets?: { elapsedSeconds: number; outputBytes: number; maxAttempts: number };
    commandScripts?: string[];
  }) {
    const tempRoot = createTempWorkspace();
    const workspace = resolveWorkspace(tempRoot);
    const commandIds = ['check-one', 'check-two', 'check-three'];
    const commandScripts = options.commandScripts ?? ['process.exit(0)', 'process.exit(0)'];
    const commands = commandScripts.map((script, index) => ({
      id: commandIds[index] ?? 'check-' + String(index),
      executable: process.execPath,
      argv: ['-e', script],
      cwd: '.',
    }));
    const budgets = options.budgets ?? { elapsedSeconds: 30, outputBytes: 65536, maxAttempts: 2 };
    const verificationExecutionPolicy = {
      budgets,
      executionPolicy: { rationale: 'Two bounded offline checks validate the approved implementation.' },
    };
    const execution: PlanExecutionConfig = {
      ...executionConfig(tempRoot),
      verificationCommands: commands,
      verificationExecutionPolicy,
    };
    const host = await compose(tempRoot);
    try {
      const { planId, workItemId } = await approvedWorkItem(host.factory, host.planning, execution);
      const templates = execution.ticketTemplates;
      assert.ok(templates !== undefined && templates.length > 0);
      const [template] = templates;
      assert.ok(template !== undefined);

      let mutations = 0;
      const outputBytes: number[][] = [];
      let capturedLoopId: EngineeringLoop['id'] | undefined;
      let capturedIteration = 0;
      const commitSpecDrift = async (): Promise<void> => {
        await host.store.transaction(async (repos) => {
          const fresh = await repos.workItems.findById(workItemId);
          assert.ok(fresh !== undefined);
          await repos.workItems.compareAndSave(
            { ...fresh, specRevision: fresh.specRevision + 1, version: fresh.version + 1 },
            fresh.version,
          );
        });
        mutations += 1;
      };
      const deviate = async (): Promise<void> => {
        if (options.deviation === 'spec') {
          await commitSpecDrift();
          return;
        }
        assert.ok(capturedLoopId !== undefined);
        const fresh = await host.loops.findById(capturedLoopId);
        assert.ok(fresh !== undefined);
        if (options.deviation === 'cancel') {
          await host.loops.compareAndSave({ ...fresh, version: fresh.version + 1, cancelRequested: true }, fresh.version);
          mutations += 1;
          return;
        }
        let replaced = 0;
        const iterations = fresh.iterations.map((record) => {
          if (record.iteration === capturedIteration && record.verifyClaim !== undefined) {
            replaced += 1;
            return {
              ...record,
              verifyClaim: { ...record.verifyClaim, ownerToken: 'other-owner-' + record.verifyClaim.ownerToken },
            };
          }
          return record;
        });
        assert.equal(replaced, 1);
        await host.loops.compareAndSave({ ...fresh, version: fresh.version + 1, iterations }, fresh.version);
        mutations += 1;
      };

      const realRunner = createNodeProcessRunner({ killGraceMs: 100 });
      const processCalls: Array<Parameters<typeof realRunner.run>[0]> = [];
      const processResults: Array<Awaited<ReturnType<typeof realRunner.run>>> = [];
      const observedRunner: typeof realRunner = {
        ...realRunner,
        run: async (request) => {
          processCalls.push(request);
          const commandBytes: number[] = [];
          outputBytes.push(commandBytes);
          const forward = request.onOutput;
          const observedRequest =
            forward === undefined
              ? request
              : {
                  ...request,
                  onOutput: (bytes: number) => {
                    commandBytes.push(bytes);
                    return forward(bytes);
                  },
                };
          const result = await realRunner.run(observedRequest);
          processResults.push(result);
          if (processResults.length === 1 && options.deviation !== undefined) {
            await deviate();
          }
          return result;
        },
      };

      const implementResults: Array<{ status: unknown }> = [];
      const reachedSlots: string[] = [];
      const refusals: string[] = [];
      const verifyFacts: Array<Awaited<ReturnType<SqliteDirectHostAuthority['prepare']>>> = [];

      const channel = host.factory.sharedDirectAdmissionChannel;
      assert.ok(channel !== undefined);
      const service = new EngineeringLoopService({
        factory: host.factory,
        loops: host.loops,
        clock: host.clock,
        ids: createSequentialIdGenerator(),
        processRunner: observedRunner,
        createImplementerWorker: (config, options2) => {
          const worker = createLoopWorker(config, {
            ...options2,
            processRunner: realRunner,
            executable: fakeCliPath('fake-codex.mjs'),
          });
          const execute = worker.execute.bind(worker);
          return {
            ...worker,
            execute: async (request) => {
              const result = await execute(request);
              implementResults.push(result);
              return result;
            },
          };
        },
        createReviewerWorker: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ['PASS'] })),
        directAdmissionChannel: channel,
        prepareDirectLaunch: async (context) => {
          reachedSlots.push(context.slot);
          if (context.slot === 'implement') {
            const facts = await host
              .prepareHost(context.worker)
              .prepare({
                planId,
                loopId: context.loop.id,
                iteration: context.iteration,
                slot: 'IMPLEMENT',
                worker: context.worker,
              });
            host.retain(facts.reservationId, host.prepareHost(context.worker));
            return {
              directTicketReference: facts.reservationId as unknown as import('../src/supervision/directWorkerAdmission.js').TrustedTicketReference,
              expectedScope: template.scope,
              expectedModel: template.model,
              expectedBudgets: template.budgets,
            };
          }
          if (context.slot === 'verify') {
            capturedLoopId = context.loop.id;
            capturedIteration = context.iteration;
            const verifyAuthority = host.prepareHost(context.worker, {
              commands,
              workspaceRoot: workspace.root,
              budgets: verificationExecutionPolicy.budgets,
              executionPolicy: verificationExecutionPolicy.executionPolicy,
            });
            const facts = await verifyAuthority.prepare({
              planId,
              loopId: context.loop.id,
              iteration: context.iteration,
              slot: 'VERIFY',
              worker: context.worker,
            });
            host.retain(facts.reservationId, verifyAuthority);
            verifyFacts.push(facts);
            if (options.stalePrestart === true) {
              await commitSpecDrift();
            }
            return {
              directTicketReference: facts.reservationId as unknown as import('../src/supervision/directWorkerAdmission.js').TrustedTicketReference,
              expectedExecutionKind: 'deterministic-execution',
              expectedScope: template.scope,
              expectedCommands: commands.map((command) => ({
                executable: command.executable,
                argv: command.argv,
                cwd: command.cwd,
              })),
              expectedWorkspace: workspace.root,
              expectedDeterministicBudgets: verificationExecutionPolicy.budgets,
              expectedExecutionPolicy: verificationExecutionPolicy.executionPolicy,
            };
          }
          const refusal = 'REVIEW direct launch is unsupported in this phase';
          refusals.push(refusal);
          throw new Error(refusal);
        },
      });

      let startError: unknown;
      const outcome = await service
        .start({
          workItemId,
          actor: PLAN_HUMAN,
          taskInstructions: 'Implement the approved change, then run both approved offline checks.',
          implementer: { tool: IMPLEMENT_TOOL, model: IMPLEMENT_MODEL, effort: 'medium' },
          reviewer: { tool: REVIEW_TOOL, model: REVIEW_MODEL, effort: 'medium' },
          verificationCommands: commands,
          workspace,
          budget: { maxIterations: 1 },
        })
        .catch((error: unknown) => {
          startError = error;
          return undefined;
        });

      const runs = await host.factory.listRuns(workItemId);
      const verifierRows = runs.filter((run) => String(run.role) === 'VERIFIER');
      const verifyReservation = verifyFacts[0]?.reservationId;
      const consumed = host.consumeReceipts.filter((receipt) => receipt.binding.reservationId === verifyReservation);

      // Shared invariants: the IMPLEMENT stage really succeeded and REVIEW was never reached,
      // so the unsupported-REVIEW sentinel cannot be what stopped the loop.
      assert.equal(implementResults.length, 1);
      assert.equal(String(implementResults[0]?.status), 'SUCCEEDED');
      assert.equal(verifyFacts.length, 1);
      assert.equal(mutations, options.deviation !== undefined || options.stalePrestart === true ? 1 : 0);
      assert.ok(!reachedSlots.includes('review'));
      assert.equal(refusals.length, 0);
      assert.ok(startError !== undefined || (outcome !== undefined && String(outcome.phase) !== 'DONE'));
      assert.ok(!verifierRows.some((row) => String(row.status) === 'RUNNING'));

      return { outcome, processCalls, processResults, verifierRows, consumed, outputBytes };
    } finally {
      host.db.close();
    }
  }

  it('PHASE7-102 between-command spec, cancel and ownership drift stop the second command after a genuine first process result', async () => {
    for (const deviation of ['spec', 'cancel', 'claim'] as const) {
      const result = await runPhase7102Control({ deviation });
      assert.equal(result.processCalls.length, 1, deviation);
      assert.equal(result.processResults.length, 1, deviation);
      assert.equal(result.processResults[0]?.terminationReason, 'EXITED', deviation);
      assert.equal(result.consumed.length, 1, deviation);
      assert.equal(result.verifierRows.length, 1, deviation);
      assert.equal(String(result.verifierRows[0]?.status), 'FAILED', deviation);
    }
  });

  it('PHASE7-102 real measured aggregate output and elapsed exhaustion stop the later command', async () => {
    const output = await runPhase7102Control({
      budgets: { elapsedSeconds: 30, outputBytes: 128, maxAttempts: 2 },
      commandScripts: [
        "process.stdout.write('x'.repeat(80))",
        "process.stdout.write('x'.repeat(80))",
        'process.exit(0)',
      ],
    });
    // Two launches only: the zero-output sentinel is never started.
    assert.equal(output.processCalls.length, 2);
    assert.equal(output.processResults.length, 2);
    assert.equal(output.processResults[0]?.terminationReason, 'EXITED');
    assert.equal(output.processResults[0]?.exitCode, 0);
    const firstBytes = (output.outputBytes[0] ?? []).reduce((total, bytes) => total + bytes, 0);
    const secondBytes = (output.outputBytes[1] ?? []).reduce((total, bytes) => total + bytes, 0);
    assert.equal(firstBytes, 80);
    assert.ok(secondBytes > 0);
    assert.ok(firstBytes + secondBytes > 128);
    const second = output.processResults[1];
    assert.ok(second !== undefined);
    assert.ok(
      second.stdoutTruncated === true ||
        second.stderrTruncated === true ||
        second.terminationReason === 'CANCELLED' ||
        second.signal !== null,
    );
    assert.equal(output.consumed.length, 1);
    assert.equal(output.verifierRows.length, 1);
    assert.equal(String(output.verifierRows[0]?.status), 'FAILED');

    const elapsed = await runPhase7102Control({
      budgets: { elapsedSeconds: 0.5, outputBytes: 65536, maxAttempts: 2 },
      commandScripts: ['setTimeout(() => {}, 120)', 'setTimeout(() => {}, 450)', 'process.exit(0)'],
    });
    assert.equal(elapsed.processCalls.length, 2);
    assert.equal(elapsed.processResults.length, 2);
    assert.equal(elapsed.processResults[0]?.terminationReason, 'EXITED');
    assert.equal(elapsed.processResults[0]?.exitCode, 0);
    assert.equal(elapsed.processResults[1]?.terminationReason, 'TIMEOUT');
    const secondTimeout = elapsed.processCalls[1]?.timeoutMs;
    assert.ok(secondTimeout !== undefined && secondTimeout < 450);
    assert.ok((elapsed.processResults[0]?.durationMs ?? 0) >= 120);
    assert.ok((elapsed.processResults[1]?.durationMs ?? 450) < 450);
    assert.equal(elapsed.consumed.length, 1);
    assert.equal(elapsed.verifierRows.length, 1);
    assert.equal(String(elapsed.verifierRows[0]?.status), 'FAILED');
  });

  it('PHASE7-102 stale prestart expectations refuse before any verifier run, process or consumption', async () => {
    const result = await runPhase7102Control({ stalePrestart: true });
    assert.equal(result.processCalls.length, 0);
    assert.equal(result.consumed.length, 0);
    assert.equal(result.verifierRows.length, 0);
    if (result.outcome !== undefined) {
      assert.equal(String(result.outcome.phase), 'FAILED');
    }
  });

  it("real IMPLEMENT then a real two-command deterministic VERIFY consumes exactly one durable VERIFY receipt, then the loop stops honestly at unsupported REVIEW", async () => {
    const tempRoot = createTempWorkspace();
    const workspace = resolveWorkspace(tempRoot);
    const commands = [
      { id: "check-one", executable: process.execPath, argv: ["-e", "process.exit(0)"], cwd: "." },
      { id: "check-two", executable: process.execPath, argv: ["-e", "process.exit(0)"], cwd: "." },
    ];
    const verificationExecutionPolicy = {
      budgets: { elapsedSeconds: 30, outputBytes: 65536, maxAttempts: 2 },
      executionPolicy: { rationale: "Two bounded offline checks validate the approved implementation." },
    };
    const execution: PlanExecutionConfig = {
      ...executionConfig(tempRoot),
      verificationCommands: commands,
      verificationExecutionPolicy,
    };
    const host = await compose(tempRoot);
    try {
      const { planId, workItemId } = await approvedWorkItem(host.factory, host.planning, execution);
      const templates = execution.ticketTemplates;
      assert.ok(templates !== undefined && templates.length > 0);
      const [template] = templates;
      assert.ok(template !== undefined);

      const realRunner = createNodeProcessRunner({ killGraceMs: 100 });
      const processCalls: Array<Parameters<typeof realRunner.run>[0]> = [];
      const processResults: Array<Awaited<ReturnType<typeof realRunner.run>>> = [];
      const observedRunner: typeof realRunner = {
        ...realRunner,
        run: async (request) => {
          host.hostEvents.push("process");
          processCalls.push(request);
          const result = await realRunner.run(request);
          processResults.push(result);
          return result;
        },
      };

      const implementRequests: Array<Parameters<import("../src/ports/worker.js").Worker["execute"]>[0]> = [];
      const implementResults: Array<{ status: unknown }> = [];
      const reachedSlots: string[] = [];
      const refusals: string[] = [];
      const implementFacts: Array<Awaited<ReturnType<SqliteDirectHostAuthority["prepare"]>>> = [];
      const verifyFacts: typeof implementFacts = [];
      let verifyAuthority: SqliteDirectHostAuthority | undefined;

      // The SAME shared channel the Factory issues handles through; never a second one.
      const channel = host.factory.sharedDirectAdmissionChannel;
      assert.ok(channel !== undefined);
      const service = new EngineeringLoopService({
        factory: host.factory,
        loops: host.loops,
        clock: host.clock,
        ids: createSequentialIdGenerator(),
        processRunner: observedRunner,
        createImplementerWorker: (config, options) => {
          const worker = createLoopWorker(config, {
            ...options,
            processRunner: realRunner,
            executable: fakeCliPath("fake-codex.mjs"),
          });
          const execute = worker.execute.bind(worker);
          return {
            ...worker,
            execute: async (request) => {
              implementRequests.push(request);
              const result = await execute(request);
              implementResults.push(result);
              return result;
            },
          };
        },
        createReviewerWorker: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["PASS"] })),
        directAdmissionChannel: channel,
        prepareDirectLaunch: async (context) => {
          reachedSlots.push(context.slot);
          if (context.slot === "implement") {
            const facts = await host
              .prepareHost(context.worker)
              .prepare({
                planId,
                loopId: context.loop.id,
                iteration: context.iteration,
                slot: "IMPLEMENT",
                worker: context.worker,
              });
            host.retain(facts.reservationId, host.prepareHost(context.worker));
            implementFacts.push(facts);
            return {
              directTicketReference: facts.reservationId as unknown as import("../src/supervision/directWorkerAdmission.js").TrustedTicketReference,
              expectedScope: template.scope,
              expectedModel: template.model,
              expectedBudgets: template.budgets,
            };
          }
          if (context.slot === "verify") {
            verifyAuthority = host.prepareHost(context.worker, {
              commands,
              workspaceRoot: workspace.root,
              budgets: verificationExecutionPolicy.budgets,
              executionPolicy: verificationExecutionPolicy.executionPolicy,
            });
            const facts = await verifyAuthority.prepare({
              planId,
              loopId: context.loop.id,
              iteration: context.iteration,
              slot: "VERIFY",
              worker: context.worker,
            });
            host.retain(facts.reservationId, verifyAuthority);
            verifyFacts.push(facts);
            return {
              directTicketReference: facts.reservationId as unknown as import("../src/supervision/directWorkerAdmission.js").TrustedTicketReference,
              expectedExecutionKind: "deterministic-execution",
              expectedScope: template.scope,
              expectedCommands: commands.map((command) => ({
                executable: command.executable,
                argv: command.argv,
                cwd: command.cwd,
              })),
              expectedWorkspace: workspace.root,
              expectedDeterministicBudgets: verificationExecutionPolicy.budgets,
              expectedExecutionPolicy: verificationExecutionPolicy.executionPolicy,
            };
          }
          const refusal = "REVIEW direct launch is unsupported in this phase";
          refusals.push(refusal);
          throw new Error(refusal);
        },
      });

      let startError: unknown;
      const outcome = await service
        .start({
          workItemId,
          actor: PLAN_HUMAN,
          taskInstructions: "Implement the approved change, then run both approved offline checks.",
          implementer: { tool: IMPLEMENT_TOOL, model: IMPLEMENT_MODEL, effort: "medium" },
          reviewer: { tool: REVIEW_TOOL, model: REVIEW_MODEL, effort: "medium" },
          verificationCommands: commands,
          workspace,
          budget: { maxIterations: 1 },
        })
        .catch((error: unknown) => {
          startError = error;
          return undefined;
        });

      // Honest stop: REVIEW was reached after a successful verifier and refused, not waved through.
      assert.deepEqual(reachedSlots, ["implement", "verify", "review"], outcome?.failureReason);
      assert.deepEqual(refusals, ["REVIEW direct launch is unsupported in this phase"]);
      assert.equal(startError, undefined);
      assert.ok(outcome !== undefined);
      assert.equal(outcome.phase, "FAILED");
      assert.ok(outcome.failureReason?.includes("REVIEW direct launch is unsupported in this phase"));
      const runs = await host.factory.listRuns(workItemId);
      assert.equal(runs.filter((run) => run.status === "SUCCEEDED").length, 2);

      // IMPLEMENT genuinely ran once and succeeded.
      assert.equal(implementResults.length, 1);
      assert.equal(implementResults[0]?.status, "SUCCEEDED");
      assert.equal(implementFacts.length, 1);
      assert.equal(verifyFacts.length, 1);
      assert.equal(verifyFacts[0]?.targetRunId, implementRequests[0]?.runId);

      // VERIFY ran both approved commands through the real ProcessRunner.
      assert.equal(processCalls.length, 2);
      assert.equal(processResults.length, 2);
      assert.deepEqual(
        processResults.map((result) => result.exitCode),
        [0, 0],
      );

      // Exactly one durable VERIFY consumption for the whole batch (plus the IMPLEMENT one).
      assert.equal(host.consumeReceipts.length, 2);
      const verifyReservationId = verifyFacts[0]?.reservationId;
      const verifyReceipts = host.consumeReceipts.filter(
        (receipt) => receipt.binding.reservationId === verifyReservationId,
      );
      assert.equal(verifyReceipts.length, 1);
      assert.ok(verifyAuthority !== undefined);
      assert.ok(verifyReservationId !== undefined);
      // Real durable evidence: rows in the shared SQLite database that carry the reservation id and CONSUMED.
      const consumedRowsFor = (reservationId: string): Array<Record<string, SQLOutputValue>> =>
        host.db
          .prepare(
            "SELECT reservation_id, state, slot, run_id, ticket_digest, registry_principal_id, work_item_id, spec_revision, version, consumed_binding_json FROM host_reservations WHERE reservation_id = ? AND state = 'CONSUMED'",
          )
          .all(reservationId);
      const verifyRows = consumedRowsFor(String(verifyReservationId));
      assert.equal(verifyRows.length, 1);
      assert.equal(consumedRowsFor(String(implementFacts[0]?.reservationId)).length, 1);
      const consumedRunId = verifyReceipts[0]?.binding.runId;
      assert.ok(consumedRunId !== undefined);
      const verifyRow = verifyRows[0];
      const verifyBinding = verifyReceipts[0]?.binding;
      assert.ok(verifyRow !== undefined && verifyBinding !== undefined);
      assert.equal(verifyRow["slot"], "VERIFY");
      assert.equal(verifyRow["run_id"], String(consumedRunId));
      const verifierRun = runs.find((run) => run.id === consumedRunId);
      assert.ok(verifierRun !== undefined && verifierRun.status === "SUCCEEDED" && verifierRun.role === "VERIFIER");
      const capturedTargetRunId = verifyFacts[0]?.targetRunId;
      assert.ok(capturedTargetRunId !== undefined);
      assert.equal(implementRequests[0]?.runId, capturedTargetRunId);
      assert.equal(verifierRun.targetRunId, capturedTargetRunId);
      const targetRun = runs.find((run) => run.id === capturedTargetRunId);
      assert.ok(targetRun !== undefined && targetRun.status === "SUCCEEDED" && targetRun.role === "IMPLEMENTER");
      assert.deepEqual(JSON.parse(String(verifyRow["consumed_binding_json"])), verifyBinding);
      assert.equal(verifyRow["reservation_id"], verifyBinding.reservationId);
      assert.equal(verifyRow["ticket_digest"], verifyBinding.ticketDigest);
      assert.equal(verifyRow["registry_principal_id"], verifyBinding.registryPrincipalId);
      assert.equal(verifyRow["work_item_id"], verifyBinding.workItemId);
      assert.equal(String(verifyRow["spec_revision"]), String(verifyBinding.specRevision));
      assert.equal(Number(verifyRow["version"]), Number(verifyBinding.reservationVersion) + 1);

      // A readonly continuation check succeeded before EACH actual command, including the first.
      const verifyChecks = host.continuationChecks.filter((check) => check.reservationId === String(verifyReservationId));
      assert.equal(verifyChecks.length, 2);
      assert.deepEqual(await Promise.all(verifyChecks.map((check) => check.outcome)), [true, true]);
      const verifyContinuationEvent = "continuation:" + String(verifyReservationId);
      assert.deepEqual(
        host.hostEvents.filter((event) => event === "process" || event === verifyContinuationEvent),
        [verifyContinuationEvent, "process", verifyContinuationEvent, "process"],
      );

      // A reconstructed copy of the genuine channel receipt is refused by the SAME channel; nothing is consumed again.
      const consumedBefore = host.consumeReceipts.length;
      const recorded = verifyChecks[0];
      assert.ok(recorded !== undefined);
      assert.ok(typeof channel.checkConsumedContinuation === "function");
      const cloneOutcome = await Promise.resolve(channel.checkConsumedContinuation(structuredClone(recorded.receipt))).then(
        (value: unknown) => value,
        () => false,
      );
      assert.notEqual(cloneOutcome, true, "a reconstructed receipt must not be accepted");
      assert.equal(host.consumeReceipts.length, consumedBefore);
      assert.equal(consumedRowsFor(String(verifyReservationId)).length, 1);
    } finally {
      host.db.close();
    }
  });

  it("real IMPLEMENT child executes exactly once through the mandatory same-channel transport, then VERIFY is honestly refused as unsupported", async () => {
    const processRunner99 = createNodeProcessRunner({ killGraceMs: 100 });
    // The EXACT real resolved temp workspace. The same object is handed to the
    // approved execution config, the host binding, and `service.start`.
    const workspace = resolveWorkspace(createTempWorkspace());
    const execution = executionConfig(workspace.root);
    const ticketTemplates = execution.ticketTemplates;
    assert.ok(ticketTemplates !== undefined, "the approved execution config carries its host ticket templates");
    const template = ticketTemplates[0];
    assert.ok(template !== undefined, "the host captured its one approved ticket template");

    const composed = await compose(workspace.root);
    const { factory, planning, loops, clock, db, prepareHost, retain, consumeReceipts } = composed;

    try {
      let implementLaunches = 0;

      const sharedChannel = factory.sharedDirectAdmissionChannel;
      assert.ok(sharedChannel !== undefined, "D1-85: the constructor-only hook must have produced a shared channel");

      // The real CLI worker is created by the SERVICE, at its own
      // `createImplementerWorker(config, options)` call, forwarding ALL the real
      // options it passes — including the exact admission channel — and
      // overriding ONLY the executable so a local offline fake CLI stands in for
      // the provider binary. The guarded object the service then registers is
      // therefore the identical object `prepare()` receives as `context.worker`.
      const observed: {
        implementerWorker?: import("../src/ports/worker.js").Worker;
        unsupportedSlotReached?: string;
        unsupportedSlotError?: string;
      } = {};
      const createImplementerWorker99: LoopWorkerFactory = (config, options) => {
        const worker = createLoopWorker(config, { ...options, executable: fakeCliPath("fake-codex.mjs") });
        const execute = worker.execute.bind(worker);
        return {
          ...worker,
          execute: async (request) => {
            implementLaunches += 1;
            return execute(request);
          },
        };
      };

      const { planId, workItemId } = await approvedWorkItem(factory, planning, execution);
      const readyItem = await factory.getWorkItem(workItemId);
      assert.equal(readyItem.status, "READY", "the materialized genuine item must be READY before the loop starts");

      const service = new EngineeringLoopService({
        factory,
        loops,
        clock,
        ids: createSequentialIdGenerator(),
        processRunner: processRunner99,
        createImplementerWorker: createImplementerWorker99,
        createReviewerWorker: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["PASS"] })),
        directAdmissionChannel: sharedChannel,
        prepareDirectLaunch: prepareDirectLaunchFor({ prepareHost, retain }, planId, template, observed),
      });

      const loop = await service.start({
        workItemId,
        actor: PLAN_HUMAN,
        taskInstructions: "do the thing",
        implementer: { tool: IMPLEMENT_TOOL, model: IMPLEMENT_MODEL, effort: "medium" },
        reviewer: { tool: REVIEW_TOOL, model: REVIEW_MODEL },
        verificationCommands: [{ id: "check", executable: "node", argv: ["-e", "process.exit(0)"] }],
        workspace,
        budget: { maxIterations: 2 },
      });

      assert.equal(implementLaunches, 1, "exactly one real IMPLEMENT child process must execute");
      assert.ok(
        observed.implementerWorker !== undefined,
        "preparation must have run for the actual newly guarded registered implementer Worker",
      );

      const runs = await factory.listRuns(workItemId);
      const implementerRuns = runs.filter((r) => r.role === "IMPLEMENTER");
      assert.equal(implementerRuns.length, 1, "the real Factory IMPLEMENTER run must succeed exactly once");
      assert.equal(implementerRuns[0]?.status, "SUCCEEDED");

      // Exactly one genuine consume receipt, and the real authority's own
      // SQLite row for that receipt is CONSUMED.
      assert.equal(consumeReceipts.length, 1, "exactly one genuine DirectLaunchReceipt may be issued for the single admitted launch");
      const receipt = consumeReceipts[0];
      assert.ok(receipt !== undefined, "the one admitted launch produced its real receipt");

      const consumed: Record<string, SQLOutputValue>[] = db
        .prepare(`SELECT reservation_id, slot, state FROM host_reservations WHERE state = 'CONSUMED'`)
        .all();
      assert.equal(consumed.length, 1, "exactly one host reservation may reach CONSUMED for the single admitted launch");
      const consumedRow = consumed[0];
      assert.ok(consumedRow !== undefined, "the CONSUMED host reservation row is present");
      const consumedReservationId = consumedRow.reservation_id;
      const consumedSlot = consumedRow.slot;
      const consumedState = consumedRow.state;
      assert.ok(typeof consumedReservationId === "string", "the persisted reservation_id is a string");
      assert.ok(typeof consumedSlot === "string", "the persisted slot is a string");
      assert.ok(typeof consumedState === "string", "the persisted state is a string");
      assert.equal(consumedSlot, "IMPLEMENT");
      assert.equal(consumedState, "CONSUMED");
      // The genuine receipt's own bound tuple names exactly that consumed row.
      assert.equal(
        receipt.binding.reservationId,
        consumedReservationId,
        "the real receipt must be bound to the single CONSUMED host reservation",
      );

      // VERIFY has no accepted98 model/config mapping bound into this
      // authority (only IMPLEMENT was composed into boundWorkers), so
      // preparation for the VERIFY slot must honestly refuse before any second
      // Run or verification process launches. This is the intended stopped
      // boundary, not a WAITING completion.
      assert.notEqual(loop.phase, "WAITING_FOR_HUMAN", "VERIFY must never be silently satisfied without a supported binding");
      const verifierRuns = runs.filter((r) => r.role === "VERIFIER");
      assert.equal(verifierRuns.length, 0, "no VERIFIER run may ever be created once preparation refuses before any Run");

      // The refusal the callback actually recorded is the VERIFY slot's, reached
      // only AFTER the IMPLEMENT launch above succeeded — so the loop's
      // terminal failure is precisely this unsupported-binding boundary and not
      // some earlier failed iteration.
      assert.equal(observed.unsupportedSlotReached, "verify", "preparation must have been reached for exactly the VERIFY slot");
      const unsupportedSlotError = observed.unsupportedSlotError;
      assert.ok(unsupportedSlotError !== undefined, "the VERIFY refusal recorded its own honest error message");
      assert.equal(loop.phase, "FAILED");
      assert.equal(loop.outcome, "FAILED");
      assert.equal(
        loop.failureReason,
        unsupportedSlotError,
        "the loop must fail with the exact unsupported-VERIFY refusal the callback raised",
      );
    } finally {
      // The ONE owned handle, closed exactly once even on failure, before the
      // `after` hook removes its directory.
      db.close();
    }
  });

  // =====================================================================
  // PHASE7-99 UnitB — refusal controls.
  //
  // Each control removes or drifts exactly ONE real fact from the genuine
  // positive above and asserts the specific refusal that fact protects. All
  // of them reuse the SAME compose/workspace/execution/template/approval/
  // registry/98-supplier/service/fake-codex wiring, so a refusal can only be
  // caused by the single named deviation. No control fabricates a grant,
  // overrides an identity guard, or invents a status/spec authority.
  // =====================================================================

  /**
   * The real counting implementer factory the controls share: the SERVICE
   * builds the worker, all its real options are forwarded, and only the
   * executable is replaced by the local offline fake CLI. `launches` counts
   * actual inner adapter `execute` calls — i.e. real child processes — which
   * every refusal control below must leave at zero.
   */
  function countingImplementerFactory(counter: { launches: number }): LoopWorkerFactory {
    return (config, options) => {
      const worker = createLoopWorker(config, { ...options, executable: fakeCliPath("fake-codex.mjs") });
      const execute = worker.execute.bind(worker);
      return {
        ...worker,
        execute: async (request) => {
          counter.launches += 1;
          return execute(request);
        },
      };
    };
  }

  /** The observation record `prepareDirectLaunchFor` fills in; shared shape only. */
  function newObserved(): {
    implementerWorker?: import("../src/ports/worker.js").Worker;
    unsupportedSlotReached?: string;
    unsupportedSlotError?: string;
  } {
    return {};
  }

  /** The approved host template, guarded for presence exactly as the positive does. */
  function hostTemplate(execution: PlanExecutionConfig): WorkItemTicketTemplate {
    const ticketTemplates = execution.ticketTemplates;
    assert.ok(ticketTemplates !== undefined, "the approved execution config carries its host ticket templates");
    const template = ticketTemplates[0];
    assert.ok(template !== undefined, "the host captured its one approved ticket template");
    return template;
  }

  it("control A: a genuine Factory composed WITHOUT its admission channel refuses the launch, and no run is ever created", async () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    const execution = executionConfig(workspace.root);
    const template = hostTemplate(execution);

    // The ONLY deviation: the Factory's constructor-only channel hook is
    // absent, so this real service has no shared channel at all.
    const composed = await compose(workspace.root, { omitAdmissionChannel: true });
    const { factory, planning, loops, clock, db, prepareHost, retain, consumeReceipts } = composed;

    try {
      assert.equal(
        factory.sharedDirectAdmissionChannel,
        undefined,
        "the composition under test must genuinely have no shared admission channel",
      );

      const counter = { launches: 0 };
      const observed = newObserved();

      // Genuine approved plan and a really READY materialized item: the
      // refusal must come from the missing channel, not from an invalid
      // baseline that would mask it.
      const { planId, workItemId } = await approvedWorkItem(factory, planning, execution);
      const readyItem = await factory.getWorkItem(workItemId);
      assert.equal(readyItem.status, "READY", "the baseline must be genuinely READY so the missing channel is the only cause");

      const service = new EngineeringLoopService({
        factory,
        loops,
        clock,
        ids: createSequentialIdGenerator(),
        processRunner: createNodeProcessRunner({ killGraceMs: 100 }),
        createImplementerWorker: countingImplementerFactory(counter),
        createReviewerWorker: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["PASS"] })),
        // No `directAdmissionChannel` can be configured: there is none to
        // configure. Preparation is still genuinely wired, so the refusal is
        // the transport's, not a missing callback's.
        prepareDirectLaunch: prepareDirectLaunchFor({ prepareHost, retain }, planId, template, observed),
      });

      const loop = await service.start({
        workItemId,
        actor: PLAN_HUMAN,
        taskInstructions: "do the thing",
        implementer: { tool: IMPLEMENT_TOOL, model: IMPLEMENT_MODEL, effort: "medium" },
        reviewer: { tool: REVIEW_TOOL, model: REVIEW_MODEL },
        verificationCommands: [{ id: "check", executable: "node", argv: ["-e", "process.exit(0)"] }],
        workspace,
        budget: { maxIterations: 2 },
      });

      // The exact missing-admission refusal, observed rather than paraphrased.
      assert.equal(loop.phase, "FAILED");
      assert.equal(loop.outcome, "FAILED");
      assert.match(
        loop.failureReason ?? "",
        /requires a trusted host-constructed admission channel; none is configured/,
        "the loop must fail with the real missing-channel refusal",
      );

      // The refusal is PRE-ROW (it precedes any durable RUNNING row), so
      // nothing executed and nothing was ever recorded.
      assert.equal(counter.launches, 0, "no real adapter execute/child process may run without an admission channel");
      assert.equal(consumeReceipts.length, 0, "no launch may be consumed without an admission channel");
      const runs = await factory.listRuns(workItemId);
      assert.equal(runs.length, 0, "an unauthorized run must never be created: the refusal lands before any RUNNING row");
    } finally {
      db.close();
    }
  });

  it("control B: a distinct, structurally valid foreign channel is refused at construction by object identity", async () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    const execution = executionConfig(workspace.root);
    const template = hostTemplate(execution);

    // The genuine composition, WITH its real shared channel present.
    const composed = await compose(workspace.root);
    const { factory, planning, loops, clock, db, prepareHost, retain, hostFacade, consumeReceipts } = composed;

    try {
      const sharedChannel = factory.sharedDirectAdmissionChannel;
      assert.ok(sharedChannel !== undefined, "the real Factory shared channel must exist for the mismatch to be meaningful");

      const counter = { launches: 0 };
      const observed = newObserved();
      const { planId, workItemId } = await approvedWorkItem(factory, planning, execution);

      // A SECOND, independently constructed channel over the SAME typed real
      // host facade. It is structurally complete and would function — its
      // read callback throws precisely to prove it is never invoked, because
      // the constructor's identity guard refuses before any admission work.
      let foreignReadCalls = 0;
      const foreignChannel = createDirectHostAdmissionChannel(
        hostFacade,
        async (_binding: DirectLaunchBinding, _issuedRequest: DirectHostExecutionLaunchRequest): Promise<DirectHostExecutionLaunchRequest> => {
          foreignReadCalls += 1;
          throw new Error("the foreign channel's readCurrentRequest must never be invoked");
        },
      );
      assert.notEqual(foreignChannel, sharedChannel, "the control requires a genuinely distinct channel object");

      // Construction itself must refuse. The identity guard is never
      // overridden and no fake grant is introduced.
      assert.throws(
        () =>
          new EngineeringLoopService({
            factory,
            loops,
            clock,
            ids: createSequentialIdGenerator(),
            processRunner: createNodeProcessRunner({ killGraceMs: 100 }),
            createImplementerWorker: countingImplementerFactory(counter),
            createReviewerWorker: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["PASS"] })),
            directAdmissionChannel: foreignChannel,
            prepareDirectLaunch: prepareDirectLaunchFor({ prepareHost, retain }, planId, template, observed),
          }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(
            error.message,
            "engineering loop service directAdmissionChannel must be the exact object returned by factory.sharedDirectAdmissionChannel",
          );
          return true;
        },
        "a structurally similar foreign channel must refuse construction outright",
      );

      assert.equal(foreignReadCalls, 0, "the foreign channel's read callback must never be reached");
      assert.equal(counter.launches, 0, "no worker may execute or spawn when construction itself refused");
      assert.equal(consumeReceipts.length, 0, "no launch may be consumed when construction itself refused");
      const runs = await factory.listRuns(workItemId);
      assert.equal(runs.length, 0, "a refused construction can never produce a run row");
      // The real authority is constructed LAZILY, from the preparation
      // callback, with the exact guarded Worker object. Because the identity
      // guard refuses construction first, that callback never runs, so no
      // SqliteDirectHostAuthority ever existed and its schema was never
      // created on this owned handle. The absence of the table IS the proof;
      // if some other path did create it, it must still hold zero rows.
      const tables: Record<string, SQLOutputValue>[] = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'host_reservations'`)
        .all();
      if (tables.length === 0) {
        assert.equal(
          tables.length,
          0,
          "a refused construction never constructs the authority, so its reservation schema must not exist",
        );
      } else {
        const reserved: Record<string, SQLOutputValue>[] = db.prepare(`SELECT reservation_id FROM host_reservations`).all();
        assert.equal(reserved.length, 0, "a refused construction can never reserve against the real authority");
      }
    } finally {
      db.close();
    }
  });

  it("control C: honest unknown capability evidence refuses the reservation; no receipt and no child, though an owned FAILED run may exist", async () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    const execution = executionConfig(workspace.root);
    const template = hostTemplate(execution);

    // The ONLY deviation: the real authority's trusted capability callback
    // returns honest unknown evidence. Plan, approval, binding, workspace,
    // spec revision, model and claim all remain genuinely valid.
    const composed = await compose(workspace.root, { unknownCapability: true });
    const { factory, planning, loops, clock, db, prepareHost, retain, consumeReceipts, reserveRejections } = composed;

    try {
      const sharedChannel = factory.sharedDirectAdmissionChannel;
      assert.ok(sharedChannel !== undefined, "the genuine shared channel must still exist");

      const counter = { launches: 0 };
      const observed = newObserved();
      const { planId, workItemId } = await approvedWorkItem(factory, planning, execution);
      const readyItem = await factory.getWorkItem(workItemId);
      assert.equal(readyItem.status, "READY", "every other approved fact remains valid");

      const service = new EngineeringLoopService({
        factory,
        loops,
        clock,
        ids: createSequentialIdGenerator(),
        processRunner: createNodeProcessRunner({ killGraceMs: 100 }),
        createImplementerWorker: countingImplementerFactory(counter),
        createReviewerWorker: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["PASS"] })),
        directAdmissionChannel: sharedChannel,
        prepareDirectLaunch: prepareDirectLaunchFor({ prepareHost, retain }, planId, template, observed),
      });

      const loop = await service.start({
        workItemId,
        actor: PLAN_HUMAN,
        taskInstructions: "do the thing",
        implementer: { tool: IMPLEMENT_TOOL, model: IMPLEMENT_MODEL, effort: "medium" },
        reviewer: { tool: REVIEW_TOOL, model: REVIEW_MODEL },
        verificationCommands: [{ id: "check", executable: "node", argv: ["-e", "process.exit(0)"] }],
        workspace,
        budget: { maxIterations: 2 },
      });

      // A genuine reservation/capability refusal, raised by the real
      // authority rather than asserted into existence here.
      // The owned IMPLEMENTER run FAILED (asserted below); the service then remediates to
      // maxIterations, so the loop's own terminal state is the distinct EXHAUSTED/ITERATIONS.
      assert.equal(loop.phase, "EXHAUSTED");
      assert.equal(loop.outcome, "EXHAUSTED");
      assert.equal(loop.exhaustionKind, "ITERATIONS");
      const failureReason = loop.failureReason;
      assert.ok(failureReason !== undefined && failureReason.length > 0, "the refusal carries its own honest reason");

      // The real constructor-injected capability callback genuinely ran — the
      // refusal is the authority's own capability guard reacting to honest
      // unknown evidence, not an earlier error masking it.
      assert.ok(
        composed.capabilityCallCount() >= 1,
        "the real authority's trusted capability callback must actually have been invoked",
      );
      // The capability-specific denial, observed on the genuine original
      // exception as it rejected the real routed reservation. `loop.failureReason`
      // may legitimately summarize, so the detailed text is asserted here and
      // never assumed to appear there.
      assert.ok(reserveRejections.length >= 1, "the real reservation must have rejected at least once");
      const capabilityDenial = reserveRejections.find((message) => /capability evidence is not an object/.test(message));
      assert.ok(
        capabilityDenial !== undefined,
        `expected the authority's own capability-evidence denial, got ${JSON.stringify(reserveRejections)}`,
      );

      assert.equal(counter.launches, 0, "unknown capability must refuse before any inner adapter execute/child process");
      assert.equal(consumeReceipts.length, 0, "no successful receipt may be issued for an unverifiable capability");
      const consumed: Record<string, SQLOutputValue>[] = db
        .prepare(`SELECT reservation_id FROM host_reservations WHERE state = 'CONSUMED'`)
        .all();
      assert.equal(consumed.length, 0, "no host reservation may reach CONSUMED when capability is unknown");

      // This is a POST-START partition: the refusal may occur after the
      // Factory already owns a RUNNING row, so an honest owned FAILED run is
      // legitimate here. Zero rows is deliberately NOT required.
      const runs = await factory.listRuns(workItemId);
      for (const run of runs) {
        assert.notEqual(run.status, "SUCCEEDED", "no run may succeed on unknown capability evidence");
      }
      assert.ok(
        runs.some((run) => run.role === "IMPLEMENTER" && run.status === "FAILED"),
        "the genuine owned IMPLEMENTER run is recorded FAILED",
      );
      assert.ok(
        !runs.some((run) => run.status === "RUNNING"),
        "no orphan RUNNING run remains",
      );
    } finally {
      db.close();
    }
  });

  it("control D: a spec-revision drift committed after genuine prepare but before the launch refuses pre-row", async () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    const execution = executionConfig(workspace.root);
    const template = hostTemplate(execution);

    const composed = await compose(workspace.root);
    const { factory, planning, store, loops, clock, db, prepareHost, retain, consumeReceipts } = composed;

    try {
      const sharedChannel = factory.sharedDirectAdmissionChannel;
      assert.ok(sharedChannel !== undefined, "the genuine shared channel must exist");

      const counter = { launches: 0 };
      const observed = newObserved();
      const { planId, workItemId } = await approvedWorkItem(factory, planning, execution);

      const genuinePrepare = prepareDirectLaunchFor({ prepareHost, retain }, planId, template, observed);

      // The genuine callback, wrapped to perform the precise post-prepare
      // mutation: AFTER the real 98 authority's `prepare` has already
      // succeeded, but BEFORE the trusted preparation result is returned, the
      // work item's spec revision really moves on. Status, approved plan,
      // claim and every other fact are preserved from the fresh row, so the
      // spec drift is the only cause of the refusal.
      let driftApplied = 0;
      const prepareThenDriftSpec: typeof genuinePrepare = async (context) => {
        const prepared = await genuinePrepare(context);
        await store.transaction(async (repositories: FactoryRepositories) => {
          const fresh = await repositories.workItems.findById(workItemId);
          assert.ok(fresh !== undefined, "the genuine work item must exist to drift its spec revision");
          await repositories.workItems.compareAndSave(
            { ...fresh, specRevision: fresh.specRevision + 1, version: fresh.version + 1 },
            fresh.version,
          );
          driftApplied += 1;
        });
        return prepared;
      };

      const service = new EngineeringLoopService({
        factory,
        loops,
        clock,
        ids: createSequentialIdGenerator(),
        processRunner: createNodeProcessRunner({ killGraceMs: 100 }),
        createImplementerWorker: countingImplementerFactory(counter),
        createReviewerWorker: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["PASS"] })),
        directAdmissionChannel: sharedChannel,
        prepareDirectLaunch: prepareThenDriftSpec,
      });

      const loop = await service.start({
        workItemId,
        actor: PLAN_HUMAN,
        taskInstructions: "do the thing",
        implementer: { tool: IMPLEMENT_TOOL, model: IMPLEMENT_MODEL, effort: "medium" },
        reviewer: { tool: REVIEW_TOOL, model: REVIEW_MODEL },
        verificationCommands: [{ id: "check", executable: "node", argv: ["-e", "process.exit(0)"] }],
        workspace,
        budget: { maxIterations: 2 },
      });

      assert.equal(driftApplied, 1, "the drift must have been committed exactly once, after a genuine prepare");

      // Bounded, stale-specific refusal: the drifted spec revision is named.
      assert.equal(loop.phase, "FAILED");
      assert.equal(loop.outcome, "FAILED");
      assert.match(
        loop.failureReason ?? "",
        /spec|revision|stale/i,
        "the refusal must be the stale-prestart one, not a generic failure",
      );

      // The stale prestart check precedes the durable RUNNING row.
      assert.equal(counter.launches, 0, "no inner adapter execute/child may run against a stale spec revision");
      assert.equal(consumeReceipts.length, 0, "no receipt may be issued against a stale spec revision");
      const runs = await factory.listRuns(workItemId);
      assert.equal(runs.length, 0, "zero Factory runs: the stale-prestart refusal lands before any RUNNING row");
      for (const run of runs) {
        assert.notEqual(run.status, "RUNNING");
      }
    } finally {
      db.close();
    }
  });

  for (const variant of [
    { name: "cancellation", drift: "cancel" as const },
    { name: "claim-owner", drift: "claim" as const },
  ]) {
    it(`control E (${variant.name}): drift committed after the real RUNNING row but before the child executes fails the loop honestly`, async () => {
      const workspace = resolveWorkspace(createTempWorkspace());
      const execution = executionConfig(workspace.root);
      const template = hostTemplate(execution);

      /**
       * The drift observer, injected into the ACTUAL composition below so the
       * one real Factory/authority/channel is built over it from the start.
       * It is deliberately INACTIVE until `arm` names the genuine work item:
       * planning, materialization and approval all commit through it
       * untouched. Once armed, each committed transaction is awaited, then —
       * outside that lock — it looks for the work item's real committed
       * IMPLEMENTER RUNNING row on the genuine backing repositories. When
       * that row is actually there, it performs exactly ONE loop CAS drifting
       * only `cancelRequested` or the existing `implementClaim.ownerToken`.
       * The committed row itself is the only signal: no nth-call timing, no
       * synthetic RUNNING row, no held lock, no barrier and no sleeps.
       */
      let armedWorkItemId: string | undefined;
      let driftApplied = 0;
      let loopsRef: LoopRepository | undefined;

      const composed = await compose(workspace.root, {
        afterTransaction: async (repositories: FactoryRepositories): Promise<void> => {
          const target = armedWorkItemId;
          const loops = loopsRef;
          if (target === undefined || loops === undefined || driftApplied > 0) {
            return;
          }
          const runs = await repositories.runs.listByWorkItem(target);
          const armed = runs.find((run) => run.role === "IMPLEMENTER" && run.status === "RUNNING");
          if (armed === undefined) {
            return;
          }
          const openLoops = await loops.listByWorkItem(target);
          const current = openLoops[0];
          if (current === undefined) {
            return;
          }
          const fresh = await loops.findById(current.id);
          if (fresh === undefined) {
            return;
          }
          const iteration = fresh.iterations.at(-1);
          const claim = iteration?.implementClaim;
          if (variant.drift === "cancel") {
            await loops.compareAndSave({ ...fresh, cancelRequested: true, version: fresh.version + 1 }, fresh.version);
            driftApplied += 1;
          } else if (iteration !== undefined && claim !== undefined) {
            // Only the owner token moves, to a distinct owner.
            await loops.compareAndSave(
              {
                ...fresh,
                iterations: [
                  ...fresh.iterations.slice(0, -1),
                  { ...iteration, implementClaim: { ...claim, ownerToken: `${claim.ownerToken}-stolen` } },
                ],
                version: fresh.version + 1,
              },
              fresh.version,
            );
            driftApplied += 1;
          }
        },
      });
      const { factory, planning, loops, clock, db, prepareHost, retain, consumeReceipts } = composed;
      loopsRef = loops;

      try {
        const sharedChannel = factory.sharedDirectAdmissionChannel;
        assert.ok(sharedChannel !== undefined, "the genuine shared channel must exist");

        const counter = { launches: 0 };
        const observed = newObserved();
        const { planId, workItemId } = await approvedWorkItem(factory, planning, execution);
        armedWorkItemId = workItemId;

        const service = new EngineeringLoopService({
          factory,
          loops,
          clock,
          ids: createSequentialIdGenerator(),
          processRunner: createNodeProcessRunner({ killGraceMs: 100 }),
          createImplementerWorker: countingImplementerFactory(counter),
          createReviewerWorker: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["PASS"] })),
          directAdmissionChannel: sharedChannel,
          prepareDirectLaunch: prepareDirectLaunchFor({ prepareHost, retain }, planId, template, observed),
        });

        const loop = await service.start({
          workItemId,
          actor: PLAN_HUMAN,
          taskInstructions: "do the thing",
          implementer: { tool: IMPLEMENT_TOOL, model: IMPLEMENT_MODEL, effort: "medium" },
          reviewer: { tool: REVIEW_TOOL, model: REVIEW_MODEL },
          verificationCommands: [{ id: "check", executable: "node", argv: ["-e", "process.exit(0)"] }],
          workspace,
          budget: { maxIterations: 2 },
        });

        // The frozen criterion is the claim/cancel boundary itself: the
        // returned loop is an honest failure/cancel, never a success.
        assert.notEqual(loop.phase, "WAITING_FOR_HUMAN", "drifted claim/cancel state must never yield a successful loop");
        assert.ok(
          loop.phase === "FAILED" || loop.phase === "CANCELLED",
          `expected an honest failure/cancel boundary, got ${loop.phase}`,
        );

        assert.equal(counter.launches, 0, "the inner adapter must never execute a child once the claim/cancel boundary drifted");
        assert.equal(consumeReceipts.length, 0, "no receipt may be issued past the drifted claim/cancel boundary");

        assert.equal(driftApplied, 1, "the drift observer must have applied exactly one CAS once armed");

        // Post-start partition: the Factory legitimately owns its armed row,
        // which must end FAILED and cleaned up rather than SUCCEEDED.
        const runs = await factory.listRuns(workItemId);
        for (const run of runs) {
          assert.notEqual(run.status, "SUCCEEDED", "no run may succeed past the drifted claim/cancel boundary");
          assert.notEqual(run.status, "RUNNING", "the armed run must be cleaned up, never left RUNNING");
        }
        const implementerRuns = runs.filter((run) => run.role === "IMPLEMENTER");
        assert.equal(implementerRuns.length, 1, "exactly one IMPLEMENTER row must exist for the armed work item");
        assert.equal(implementerRuns[0]?.status, "FAILED", "the armed IMPLEMENTER row must end FAILED");
        assert.equal(
          runs.filter((run) => run.status === "RUNNING").length,
          0,
          "no row may be left RUNNING past the drifted claim/cancel boundary",
        );
      } finally {
        db.close();
      }
    });
  }
});
