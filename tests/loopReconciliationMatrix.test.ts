/**
 * TASK-004 remediation round 1 — the expanded crash/concurrency matrix
 * (remediation brief PARTS K/L/M/N/O), beyond the six-finding reproductions
 * in tests/remediationRound1Repro.test.ts and the A–E window tests in
 * tests/engineeringLoopService.test.ts.
 *
 * Crash simulation uses the same discipline as those files: condition-based
 * fault injection with full post-crash poisoning (a dead process can neither
 * write later bookkeeping nor read), never write-count coupling.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createInMemoryLoopRepository } from "../src/adapters/orchestration/inMemoryLoopRepository.js";
import { createSqliteLoopRepository } from "../src/adapters/orchestration/sqliteLoopRepository.js";
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
import { cleanupTempDbs, newFactory, seedWorkItem, tempDbPath, toReady, type TestFactory } from "./support/factoryFixtures.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./support/tempWorkspace.js";

after(() => {
  cleanupTempWorkspaces();
  cleanupTempDbs();
});

const processRunner = createNodeProcessRunner({ killGraceMs: 100 });

const PASSING_COMMANDS: readonly VerificationCommandConfig[] = [
  { id: "trivial-pass", executable: process.execPath, argv: ["-e", "process.exit(0)"] },
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

interface ServiceOverrides {
  readonly implementerFactory?: LoopWorkerFactory;
  readonly reviewerFactory?: LoopWorkerFactory;
  readonly idPrefix?: string;
}

function makeService(fx: TestFactory, loops: LoopRepository, overrides: ServiceOverrides = {}): EngineeringLoopService {
  const sequential = createSequentialIdGenerator();
  const ids = overrides.idPrefix === undefined ? sequential : { next: (prefix: string) => `${overrides.idPrefix}-${sequential.next(prefix)}` };
  return new EngineeringLoopService({
    factory: fx.factory,
    loops,
    clock: fx.clock,
    ids,
    processRunner,
    createImplementerWorker: overrides.implementerFactory ?? asLoopWorkerFactory(createScriptedImplementerWorker()),
    createReviewerWorker: overrides.reviewerFactory ?? asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["PASS"] })),
  });
}

type CrashMode =
  | { readonly when: "before"; readonly condition: () => Promise<boolean> }
  | { readonly when: "after"; readonly committed: (saved: EngineeringLoop) => boolean };

/** Condition-based crash injection with full post-crash poisoning. */
function crashingRepo(repo: LoopRepository, mode: CrashMode): LoopRepository {
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
      if (mode.when === "before" && (await mode.condition())) {
        crashed = true;
        dead();
      }
      const saved = await repo.compareAndSave(loop, expectedVersion);
      if (mode.when === "after" && mode.committed(saved)) {
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

async function setup() {
  const fx = newFactory();
  const item = await seedWorkItem(fx.factory);
  await toReady(fx.factory, item.id);
  const realLoops = createInMemoryLoopRepository();
  return { fx, item, realLoops };
}

async function crashDuringStart(
  fx: TestFactory,
  realLoops: LoopRepository,
  itemId: string,
  mode: CrashMode,
  overrides: ServiceOverrides = {},
  input: Partial<StartLoopInput> = {},
): Promise<string> {
  const crashing = crashingRepo(realLoops, mode);
  await assert.rejects(makeService(fx, crashing, overrides).start(baseInput(itemId, { budget: { maxIterations: 3 }, ...input })));
  const loops = await realLoops.listByWorkItem(itemId);
  assert.equal(loops.length, 1);
  return loops[0]!.id;
}

async function runsByRole(fx: TestFactory, workItemId: string, role: string) {
  return (await fx.factory.listRuns(workItemId)).filter((run) => run.role === role);
}

describe("PART M — expanded crash matrix", () => {
  it("M-A: action claimed, crash before the Factory Run was created — resume relaunches exactly once under a bumped attempt", async () => {
    const { fx, item, realLoops } = await setup();
    const loopId = await crashDuringStart(fx, realLoops, item.id, {
      when: "after",
      committed: (saved) => {
        const last = saved.iterations.at(-1);
        return last?.implementClaim !== undefined && last.implementerRunId === undefined;
      },
    });

    const stale = await realLoops.findById(loopId);
    assert.equal(stale?.iterations[0]?.implementClaim?.attempt, 1);
    assert.equal((await runsByRole(fx, item.id, "IMPLEMENTER")).length, 0, "sanity: the crash preceded PHASE 1");

    const resumed = await makeService(fx, realLoops, { idPrefix: "p2" }).resume(loopId);

    assert.equal((await runsByRole(fx, item.id, "IMPLEMENTER")).length, 1, "exactly one implementer run — relaunched exactly once");
    assert.equal(resumed.phase, "WAITING_FOR_HUMAN");
    const claim = resumed.iterations[0]?.implementClaim;
    assert.equal(claim?.attempt, 2, "takeover must re-claim under a bumped attempt");
    assert.ok(claim?.correlationTag.endsWith(":a2"));
    const run = (await runsByRole(fx, item.id, "IMPLEMENTER"))[0]!;
    assert.equal(run.declaredWorkerId, claim!.correlationTag, "the launched run carries the current attempt's exact correlation tag");
  });

  it("M-D: verifier run terminal, crash before the loop checkpoint — resume adopts it, marked recovered, no relaunch", async () => {
    const { fx, item, realLoops } = await setup();
    const loopId = await crashDuringStart(fx, realLoops, item.id, {
      when: "before",
      condition: async () => {
        const verifiers = await runsByRole(fx, item.id, "VERIFIER");
        return verifiers.length > 0 && verifiers.every((run) => run.status !== "RUNNING");
      },
    });

    const resumed = await makeService(fx, realLoops, { idPrefix: "p2" }).resume(loopId);

    assert.equal((await runsByRole(fx, item.id, "VERIFIER")).length, 1, "resume must adopt the completed verifier run, never relaunch");
    assert.equal(resumed.phase, "WAITING_FOR_HUMAN");
    assert.equal(resumed.iterations[0]?.verifyClaim?.recovered, true, "telemetry must mark the adoption as recovered, not a fresh call");
  });

  it("M-F: DETERMINISTIC review persisted, crash before the loop checkpoint — resume adopts it, exactly one review", async () => {
    const { fx, item, realLoops } = await setup();
    const loopId = await crashDuringStart(fx, realLoops, item.id, {
      when: "before",
      condition: async () => (await fx.store.reviews.listByWorkItem(item.id)).some((review) => review.kind === "DETERMINISTIC"),
    });

    const resumed = await makeService(fx, realLoops, { idPrefix: "p2" }).resume(loopId);

    const deterministic = (await fx.store.reviews.listByWorkItem(item.id)).filter((review) => review.kind === "DETERMINISTIC");
    assert.equal(deterministic.length, 1, "resume must adopt the existing DETERMINISTIC review, never record a duplicate");
    assert.equal(resumed.iterations[0]?.verificationReviewId, deterministic[0]!.id);
    assert.equal(resumed.phase, "WAITING_FOR_HUMAN");
  });

  it("M-H: remediation implementer terminal, crash before checkpoint — resume adopts without double-counting budget (PART O)", async () => {
    const { fx, item, realLoops } = await setup();
    const loopId = await crashDuringStart(
      fx,
      realLoops,
      item.id,
      {
        when: "before",
        condition: async () => {
          const implementers = await runsByRole(fx, item.id, "IMPLEMENTER");
          return implementers.length === 2 && implementers.every((run) => run.status !== "RUNNING");
        },
      },
      { reviewerFactory: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["CHANGES_REQUIRED", "PASS"] })) },
    );

    const resumed = await makeService(fx, realLoops, {
      idPrefix: "p2",
      reviewerFactory: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["PASS"] })),
    }).resume(loopId);

    assert.equal(resumed.phase, "WAITING_FOR_HUMAN");
    assert.equal((await runsByRole(fx, item.id, "IMPLEMENTER")).length, 2, "the recovered remediation run must not be relaunched");
    assert.equal(resumed.iterations.length, 2, "the recovered run must not open a third iteration");
    // 2 iterations x (implement + verify + review), every action counted exactly once, recovered or fresh.
    assert.equal(resumed.totalRunCount, 6, "a recovered completion must count exactly once, never twice");
  });

  it("M-J: WorkItem already WAITING_FOR_HUMAN, loop still REVIEWING — resume reconciles the loop without another reviewer call", async () => {
    const { fx, item, realLoops } = await setup();
    // Crash after the PASS verdict checkpoint AND the WorkItem transition
    // both committed, before the loop's own phase write: the loop is stale
    // at REVIEWING while the WorkItem already shows WAITING_FOR_HUMAN.
    const loopId = await crashDuringStart(fx, realLoops, item.id, {
      when: "before",
      condition: async () => (await fx.factory.getWorkItem(item.id)).status === "WAITING_FOR_HUMAN",
    });

    const stale = await realLoops.findById(loopId);
    assert.equal(stale?.phase, "REVIEWING");
    assert.equal((await fx.factory.getWorkItem(item.id)).status, "WAITING_FOR_HUMAN");
    const reviewerRunsBefore = (await runsByRole(fx, item.id, "REVIEWER")).length;

    const resumed = await makeService(fx, realLoops, { idPrefix: "p2" }).resume(loopId);

    assert.equal(resumed.phase, "WAITING_FOR_HUMAN");
    assert.equal((await runsByRole(fx, item.id, "REVIEWER")).length, reviewerRunsBefore, "no additional reviewer call may be spent");
  });

  it("M-K: EXHAUSTED persisted, crash before the WorkItem BLOCKED transition — resume finishes it without any worker spend", async () => {
    const { fx, item, realLoops } = await setup();
    const loopId = await crashDuringStart(
      fx,
      realLoops,
      item.id,
      { when: "after", committed: (saved) => saved.phase === "EXHAUSTED" },
      { reviewerFactory: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["CHANGES_REQUIRED"] })) },
      { budget: { maxIterations: 1 } },
    );

    const stale = await realLoops.findById(loopId);
    assert.equal(stale?.phase, "EXHAUSTED", "exhaustion is durable");
    assert.notEqual((await fx.factory.getWorkItem(item.id)).status, "BLOCKED", "sanity: the courtesy transition was lost to the crash");
    const runsBefore = (await fx.factory.listRuns(item.id)).length;

    const resumed = await makeService(fx, realLoops, { idPrefix: "p2" }).resume(loopId);

    assert.equal(resumed.phase, "EXHAUSTED", "persisted exhaustion survives restart — counters are never reset");
    assert.equal((await fx.factory.getWorkItem(item.id)).status, "BLOCKED", "resume completes the pending transition");
    assert.equal((await fx.factory.listRuns(item.id)).length, runsBefore, "no worker may launch after the hard budget is exhausted");
  });
});

describe("PART K — reconciliation must not adopt artifacts from another action/generation", () => {
  it("a claimed-but-unlaunched remediation action never adopts the previous iteration's completed run", async () => {
    const { fx, item, realLoops } = await setup();
    const loopId = await crashDuringStart(
      fx,
      realLoops,
      item.id,
      {
        when: "after",
        committed: (saved) => {
          const second = saved.iterations[1];
          return second !== undefined && second.implementClaim !== undefined && second.implementerRunId === undefined;
        },
      },
      { reviewerFactory: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["CHANGES_REQUIRED", "PASS"] })) },
    );

    const iteration1RunId = (await realLoops.findById(loopId))?.iterations[0]?.implementerRunId;
    assert.ok(iteration1RunId !== undefined);
    assert.equal((await runsByRole(fx, item.id, "IMPLEMENTER")).length, 1, "sanity: only iteration 1's implementer exists");

    const resumed = await makeService(fx, realLoops, {
      idPrefix: "p2",
      reviewerFactory: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["PASS"] })),
    }).resume(loopId);

    assert.equal(resumed.phase, "WAITING_FOR_HUMAN");
    assert.equal((await runsByRole(fx, item.id, "IMPLEMENTER")).length, 2, "iteration 2 must launch its own run");
    assert.notEqual(
      resumed.iterations[1]?.implementerRunId,
      iteration1RunId,
      "iteration 2 must never adopt iteration 1's run — correlation is per action, not per role",
    );
  });
});

describe("PART L — the loop's own PASS is never authoritative", () => {
  it("a loop row claiming PASS with no authoritative Factory review fails closed instead of reaching the human gate", async () => {
    const { fx, item, realLoops } = await setup();
    // Reach REVIEWING legitimately (reviewer launched, no verdict yet), then
    // hand-tamper the loop row to claim a PASS verdict that Factory never
    // recorded. (The in-memory repository does not run the SQLite adapter's
    // corruption validation, which lets the tampering stand in for a
    // corrupted-but-plausible row.)
    const loopId = await crashDuringStart(fx, realLoops, item.id, {
      when: "before",
      condition: async () => {
        const reviewers = await runsByRole(fx, item.id, "REVIEWER");
        return reviewers.length > 0 && reviewers.every((run) => run.status !== "RUNNING");
      },
    });

    const stale = await realLoops.findById(loopId);
    assert.equal(stale?.phase, "REVIEWING");
    const last = stale!.iterations.at(-1)!;
    const reviewerRunId = (await runsByRole(fx, item.id, "REVIEWER"))[0]!.id;
    await realLoops.compareAndSave(
      {
        ...stale!,
        version: stale!.version + 1,
        iterations: [
          ...stale!.iterations.slice(0, -1),
          { ...last, reviewerRunId, reviewVerdict: "PASS", reviewRecordId: "rev-forged" },
        ],
      },
      stale!.version,
    );
    assert.equal((await fx.store.reviews.listByWorkItem(item.id)).filter((review) => review.kind === "SEMANTIC").length, 0);

    const resumed = await makeService(fx, realLoops, { idPrefix: "p2" }).resume(loopId);

    assert.equal(resumed.phase, "FAILED", "Factory authority wins: a loop-local PASS without a real review fails closed");
    assert.notEqual((await fx.factory.getWorkItem(item.id)).status, "WAITING_FOR_HUMAN");
  });
});

describe("PART N — cross-connection concurrency and corrupt-row safety", () => {
  it("two independent SQLite repository connections racing the same claim launch exactly one run", async () => {
    const fx = newFactory();
    const item = await seedWorkItem(fx.factory);
    await toReady(fx.factory, item.id);

    const dbPath = tempDbPath();
    const repoSeed = createSqliteLoopRepository(dbPath);
    // Persist a loop stranded at phase=IMPLEMENTING with nothing launched.
    await assert.rejects(
      makeService(fx, crashingRepo(repoSeed, { when: "after", committed: (saved) => saved.phase === "IMPLEMENTING" }), {
        idPrefix: "seed",
      }).start(baseInput(item.id)),
    );
    const loopId = (await repoSeed.listByWorkItem(item.id))[0]!.id;

    let executeCalls = 0;
    let releaseExecute!: () => void;
    const executeGate = new Promise<void>((resolve) => {
      releaseExecute = resolve;
    });
    const gatedImplementer = {
      id: "gated-implementer",
      capabilities: { roles: ["IMPLEMENTER"] as const, deterministic: true },
      async execute(request: { runId: string }) {
        executeCalls += 1;
        await executeGate;
        return {
          status: "SUCCEEDED" as const,
          summary: "done",
          evidence: [{ kind: "NOTE" as const, summary: "done", reference: `scripted://implementer/${request.runId}/transcript` }],
          claimsAcceptanceMet: true,
        };
      },
    };

    const repoA = createSqliteLoopRepository(dbPath);
    const repoB = createSqliteLoopRepository(dbPath);
    try {
      const serviceA = makeService(fx, repoA, { implementerFactory: () => gatedImplementer, idPrefix: "pa" });
      const serviceB = makeService(fx, repoB, { implementerFactory: () => gatedImplementer, idPrefix: "pb" });

      const resumeA = serviceA.resume(loopId);
      const resumeB = serviceB.resume(loopId);
      await new Promise((resolve) => setTimeout(resolve, 100));
      releaseExecute();
      await Promise.allSettled([resumeA, resumeB]);

      assert.equal(executeCalls, 1, "the SQLite-enforced claim CAS must let exactly one connection launch");
      assert.equal((await fx.factory.listRuns(item.id)).filter((run) => run.role === "IMPLEMENTER").length, 1);

      const settled = await makeService(fx, repoA, { idPrefix: "pc" }).resume(loopId);
      assert.equal(settled.phase, "WAITING_FOR_HUMAN");
      assert.equal((await fx.factory.listRuns(item.id)).filter((run) => run.role === "IMPLEMENTER").length, 1);
    } finally {
      repoA.close();
      repoB.close();
      repoSeed.close();
    }
  });

  it("a corrupted loop row blocks resume before any worker could launch", async () => {
    const fx = newFactory();
    const item = await seedWorkItem(fx.factory);
    await toReady(fx.factory, item.id);

    const dbPath = tempDbPath();
    const repo = createSqliteLoopRepository(dbPath);
    try {
      // Strand a valid loop at IMPLEMENTING, then corrupt its stored JSON directly.
      await assert.rejects(
        makeService(fx, crashingRepo(repo, { when: "after", committed: (saved) => saved.phase === "IMPLEMENTING" }), {
          idPrefix: "seed",
        }).start(baseInput(item.id)),
      );
      const loopId = (await repo.listByWorkItem(item.id))[0]!.id;

      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      const row = db.prepare("SELECT data FROM engineering_loops WHERE id = ?").get(loopId) as { data: string };
      const tampered = JSON.parse(row.data) as { iterations: unknown[] };
      tampered.iterations = [{ iteration: 1 }, { iteration: 1 }]; // impossible duplicate numbering
      db.prepare("UPDATE engineering_loops SET data = ? WHERE id = ?").run(JSON.stringify(tampered), loopId);
      db.close();

      await assert.rejects(makeService(fx, repo, { idPrefix: "p2" }).resume(loopId), { code: "PERSISTENCE_CORRUPTION" });
      assert.equal((await fx.factory.listRuns(item.id)).length, 0, "a corrupted row must never launch a worker");
    } finally {
      repo.close();
    }
  });
});
