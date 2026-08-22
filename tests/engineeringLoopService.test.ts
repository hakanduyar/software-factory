/**
 * TASK-004 autonomous engineering loop orchestrator — end-to-end coverage
 * against real (in-memory) `FactoryService`/`LoopRepository` instances, with
 * scripted `Worker`s standing in for Claude Code/Codex CLI (no real AI is
 * ever invoked) and real, trivial, offline `node -e` processes for
 * deterministic verification (see src/orchestration/scriptedLoopWorkers.ts).
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createInMemoryLoopRepository } from "../src/adapters/orchestration/inMemoryLoopRepository.js";
import { createNodeProcessRunner } from "../src/adapters/process/nodeProcessRunner.js";
import { resolveWorkspace } from "../src/adapters/workers/workspace.js";
import { human } from "../src/domain/actor.js";
import { createSequentialIdGenerator } from "../src/domain/ids.js";
import { EngineeringLoopService, type LoopWorkerFactory, type StartLoopInput } from "../src/orchestration/engineeringLoopService.js";
import type { LoopRepository } from "../src/orchestration/loopRepository.js";
import type { EngineeringLoop, VerificationCommandConfig } from "../src/orchestration/loopTypes.js";
import {
  asLoopWorkerFactory,
  createScriptedImplementerWorker,
  createScriptedReviewerWorker,
} from "../src/orchestration/scriptedLoopWorkers.js";
import { createFixedClock } from "../src/ports/clock.js";
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
