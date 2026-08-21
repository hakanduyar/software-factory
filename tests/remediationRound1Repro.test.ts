/**
 * TASK-004 remediation round 1 — permanent regression suite for the six HIGH
 * findings of the independent Codex review (2026-08-20, preserved verbatim in
 * AI-HANDOFF.md).
 *
 * PHASE 0 DISCIPLINE: every test here asserts the *correct* (post-remediation)
 * behavior and was first run against the unfixed TASK-004 implementation to
 * prove it reproduces the finding (recorded in AI-HANDOFF.md). These tests are
 * permanent — they must stay green from now on.
 *
 * Crash simulation is condition-based, not write-count-based: a repository
 * wrapper throws (instead of writing) on the first loop checkpoint attempted
 * AFTER an authoritative Factory-side condition becomes true — e.g. "an
 * IMPLEMENTER run is terminal". That pins each crash to the exact
 * cross-database window the reviewer exploited, independent of how many
 * checkpoints the implementation happens to perform, so the same test is
 * meaningful both pre-fix and post-fix.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createInMemoryLoopRepository } from "../src/adapters/orchestration/inMemoryLoopRepository.js";
import { createSqliteLoopRepository } from "../src/adapters/orchestration/sqliteLoopRepository.js";
import { createNodeProcessRunner } from "../src/adapters/process/nodeProcessRunner.js";
import { createCodexCliWorker } from "../src/adapters/workers/codexCliAdapter.js";
import { resolveWorkspace } from "../src/adapters/workers/workspace.js";
import { human } from "../src/domain/actor.js";
import { createSequentialIdGenerator } from "../src/domain/ids.js";
import { EngineeringLoopService, type StartLoopInput } from "../src/orchestration/engineeringLoopService.js";
import type { LoopRepository } from "../src/orchestration/loopRepository.js";
import type { VerificationCommandConfig } from "../src/orchestration/loopTypes.js";
import { createVerificationWorker } from "../src/orchestration/verificationWorker.js";
import {
  asLoopWorkerFactory,
  createScriptedImplementerWorker,
  createScriptedReviewerWorker,
} from "../src/orchestration/scriptedLoopWorkers.js";
import { newFactory, seedWorkItem, tempDbPath, cleanupTempDbs, toReady, type TestFactory } from "./support/factoryFixtures.js";
import { fakeCliPath } from "./support/fakeCli.js";
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
  readonly implementerFactory?: ConstructorParameters<typeof EngineeringLoopService>[0]["createImplementerWorker"];
  readonly reviewerFactory?: ConstructorParameters<typeof EngineeringLoopService>[0]["createReviewerWorker"];
  /**
   * Distinguishes the id space of a second "process". Without this, two test
   * services would both mint `loop-0001` and collide on the PRIMARY KEY —
   * accidentally masking the absence of real active-loop uniqueness (real
   * deployments use non-colliding id generators; see src/cli/loop.ts).
   */
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

/**
 * Crash (throw instead of writing) on the first checkpoint attempted after
 * `condition` holds — and from that moment on, EVERY repository operation
 * throws: a dead process can neither write its would-be checkpoint nor any
 * later "mark the loop FAILED" bookkeeping, nor read. Without full
 * poisoning, the orchestrator's own failure handling would use the same
 * "dead" store and the simulation would not be a crash at all.
 */
function crashWhen(repo: LoopRepository, condition: () => Promise<boolean>): LoopRepository {
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
      if (await condition()) {
        crashed = true;
        dead();
      }
      return repo.compareAndSave(loop, expectedVersion);
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

async function runsByRole(fx: TestFactory, workItemId: string, role: string) {
  return (await fx.factory.listRuns(workItemId)).filter((run) => run.role === role);
}

describe("remediation round 1 — HIGH 1: cross-database crash windows must not duplicate completed work", () => {
  it("R1: implementer run terminal + crash before loop checkpoint — resume recovers the run instead of relaunching", async () => {
    const fx = newFactory();
    const item = await seedWorkItem(fx.factory);
    await toReady(fx.factory, item.id);
    const realLoops = createInMemoryLoopRepository();

    const crashingLoops = crashWhen(realLoops, async () => {
      const implementers = await runsByRole(fx, item.id, "IMPLEMENTER");
      return implementers.length > 0 && implementers.every((run) => run.status !== "RUNNING");
    });
    const crashingService = makeService(fx, crashingLoops);
    await assert.rejects(crashingService.start(baseInput(item.id)));

    assert.equal((await runsByRole(fx, item.id, "IMPLEMENTER")).length, 1, "sanity: the implementer run committed before the crash");

    const resumedService = makeService(fx, realLoops);
    const loopId = (await realLoops.listByWorkItem(item.id))[0]!.id;
    const resumed = await resumedService.resume(loopId);

    assert.equal(
      (await runsByRole(fx, item.id, "IMPLEMENTER")).length,
      1,
      "resume must adopt the already-committed implementer run, never launch a duplicate",
    );
    assert.equal(resumed.phase, "WAITING_FOR_HUMAN");
  });

  it("R2a: reviewer run terminal + crash before loop checkpoint — resume recovers the reviewer run instead of relaunching", async () => {
    const fx = newFactory();
    const item = await seedWorkItem(fx.factory);
    await toReady(fx.factory, item.id);
    const realLoops = createInMemoryLoopRepository();

    const crashingLoops = crashWhen(realLoops, async () => {
      const reviewers = await runsByRole(fx, item.id, "REVIEWER");
      return reviewers.length > 0 && reviewers.every((run) => run.status !== "RUNNING");
    });
    const crashingService = makeService(fx, crashingLoops);
    await assert.rejects(crashingService.start(baseInput(item.id)));

    const resumedService = makeService(fx, realLoops);
    const loopId = (await realLoops.listByWorkItem(item.id))[0]!.id;
    const resumed = await resumedService.resume(loopId);

    assert.equal((await runsByRole(fx, item.id, "REVIEWER")).length, 1, "resume must not launch a second reviewer run");
    assert.equal(resumed.phase, "WAITING_FOR_HUMAN");
  });

  it("R2b: semantic Review persisted + crash before verdict checkpoint — resume adopts the existing Review", async () => {
    const fx = newFactory();
    const item = await seedWorkItem(fx.factory);
    await toReady(fx.factory, item.id);
    const realLoops = createInMemoryLoopRepository();

    const crashingLoops = crashWhen(realLoops, async () => {
      const reviews = await fx.store.reviews.listByWorkItem(item.id);
      return reviews.some((review) => review.kind === "SEMANTIC");
    });
    const crashingService = makeService(fx, crashingLoops);
    await assert.rejects(crashingService.start(baseInput(item.id)));

    assert.equal(
      (await fx.store.reviews.listByWorkItem(item.id)).filter((review) => review.kind === "SEMANTIC").length,
      1,
      "sanity: exactly one semantic review committed before the crash",
    );

    const resumedService = makeService(fx, realLoops);
    const loopId = (await realLoops.listByWorkItem(item.id))[0]!.id;
    const resumed = await resumedService.resume(loopId);

    assert.equal(
      (await fx.store.reviews.listByWorkItem(item.id)).filter((review) => review.kind === "SEMANTIC").length,
      1,
      "resume must adopt the already-persisted semantic Review, never record a duplicate",
    );
    assert.equal((await runsByRole(fx, item.id, "REVIEWER")).length, 1, "and must not launch another reviewer run either");
    assert.equal(resumed.phase, "WAITING_FOR_HUMAN");
  });

  it("R3: durable RUNNING implementer run + orchestration crash — resume fails closed, never launches a replacement", async () => {
    const fx = newFactory();
    const item = await seedWorkItem(fx.factory);
    await toReady(fx.factory, item.id);
    const realLoops = createInMemoryLoopRepository();

    // An implementer whose child "process" never finishes: PHASE 1 commits a
    // durable RUNNING run, then the orchestration "process" dies (we abandon
    // the start() promise, which can never settle).
    const neverResolves = {
      id: "never-resolves",
      capabilities: { roles: ["IMPLEMENTER"] as const, deterministic: true },
      execute(): Promise<never> {
        return new Promise<never>(() => {});
      },
    };
    const hungService = makeService(fx, realLoops, { implementerFactory: () => neverResolves });
    const abandoned = hungService.start(baseInput(item.id));
    abandoned.catch(() => {}); // never settles; the "crashed" process's work

    // Wait until the RUNNING run is durably visible, as it would be on disk.
    for (let i = 0; i < 200; i++) {
      const runs = await runsByRole(fx, item.id, "IMPLEMENTER");
      if (runs.length === 1 && runs[0]!.status === "RUNNING") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal((await runsByRole(fx, item.id, "IMPLEMENTER"))[0]?.status, "RUNNING", "sanity: a durable RUNNING run exists");

    const resumedService = makeService(fx, realLoops);
    const loopId = (await realLoops.listByWorkItem(item.id))[0]!.id;
    const resumed = await resumedService.resume(loopId);

    const implementers = await runsByRole(fx, item.id, "IMPLEMENTER");
    assert.equal(implementers.length, 1, "resume must NOT launch a second implementer while one is durably RUNNING");
    assert.equal(resumed.phase, "RECOVERY_REQUIRED", "an unprovable in-flight outcome must fail closed into an explicit recovery state");
  });
});

describe("remediation round 1 — HIGH 2: loops.db must reject unsafe valid-JSON rows", () => {
  function rawLoopRow(overrides: Record<string, unknown>): { json: string; phaseColumn: string } {
    const base: Record<string, unknown> = {
      id: "loop-corrupt",
      workItemId: "wi-corrupt",
      version: 1,
      phase: "READY",
      budget: { maxIterations: 3 },
      implementer: { tool: "claude-code", model: "m" },
      reviewer: { tool: "codex-cli", model: "m" },
      verificationCommands: [{ id: "c", executable: "node", argv: ["-e", "1"] }],
      workspaceRoot: "/tmp/x",
      taskInstructions: "do it",
      iterations: [],
      totalRunCount: 0,
      cancelRequested: false,
      startedBy: { id: "user:x", kind: "HUMAN", displayName: "X" },
      startedAt: 1000,
      lastTransitionAt: 2000,
      ...overrides,
    };
    return { json: JSON.stringify(base), phaseColumn: String(base.phase) };
  }

  async function expectRowRejected(overrides: Record<string, unknown>, phaseColumnOverride?: string): Promise<void> {
    const dbPath = tempDbPath();
    const seed = createSqliteLoopRepository(dbPath);
    seed.close(); // creates the schema, then releases the file
    const db = new DatabaseSync(dbPath);
    const { json, phaseColumn } = rawLoopRow(overrides);
    db.prepare("INSERT INTO engineering_loops (id, work_item_id, phase, version, data) VALUES (?, ?, ?, ?, ?)").run(
      String(overrides.id ?? "loop-corrupt"),
      String(overrides.workItemId ?? "wi-corrupt"),
      phaseColumnOverride ?? phaseColumn,
      Number(overrides.version ?? 1),
      json,
    );
    db.close();

    const repo = createSqliteLoopRepository(dbPath);
    try {
      await assert.rejects(repo.findById(String(overrides.id ?? "loop-corrupt")), { code: "PERSISTENCE_CORRUPTION" });
    } finally {
      repo.close();
    }
  }

  it("R4a: rejects a malformed iteration record (non-object entries)", async () => {
    await expectRowRejected({ iterations: ["not-an-iteration-record"] });
  });

  it("R4b: rejects impossible iteration numbering (duplicates / out of order)", async () => {
    await expectRowRejected({ iterations: [{ iteration: 2 }, { iteration: 2 }] });
  });

  it("R4c: rejects negative timestamps", async () => {
    await expectRowRejected({ startedAt: -5 });
  });

  it("R4d: rejects WAITING_FOR_HUMAN without any authoritative review reference", async () => {
    await expectRowRejected({
      phase: "WAITING_FOR_HUMAN",
      outcome: "WAITING_FOR_HUMAN",
      iterations: [{ iteration: 1 }],
    });
  });

  it("R4e: rejects EXHAUSTED whose stored budget is demonstrably not exhausted", async () => {
    await expectRowRejected({
      phase: "EXHAUSTED",
      outcome: "EXHAUSTED",
      failureReason: "iteration budget exhausted",
      exhaustionKind: "ITERATIONS",
      iterations: [{ iteration: 1 }],
      budget: { maxIterations: 5 },
    });
  });

  it("R4f: rejects malformed verification command config shapes", async () => {
    await expectRowRejected({ verificationCommands: [{ id: "c", executable: "node", argv: "not-an-array" }] });
  });

  it("R5: rejects a row whose SQL phase column disagrees with the JSON phase", async () => {
    await expectRowRejected({ phase: "WAITING_FOR_HUMAN", outcome: "WAITING_FOR_HUMAN" }, "READY");
  });
});

describe("remediation round 1 — HIGH 3: malformed structured CLI output must never yield PASS", () => {
  it("R6: a codex-backed reviewer that violates its JSONL contract but prints a PASS tag to raw stdout fails closed", async () => {
    const fx = newFactory();
    const item = await seedWorkItem(fx.factory);
    await toReady(fx.factory, item.id);
    const loops = createInMemoryLoopRepository();

    const service = makeService(fx, loops, {
      reviewerFactory: (_config, options) =>
        createCodexCliWorker({
          executable: fakeCliPath("fake-codex.mjs"),
          model: "test-model",
          workspace: options.workspace,
          processRunner: options.processRunner,
          roles: options.roles,
          environmentPolicy: {
            allowedVars: ["PATH"],
            extraVars: {
              FAKE_CODEX_MODE: "raw",
              FAKE_CODEX_MESSAGE: "definitely not json\nFACTORY_REVIEW_VERDICT: PASS\nFACTORY_REVIEW_FINDINGS:\n- none",
            },
          },
        }),
    });

    const loop = await service.start(baseInput(item.id, { budget: { maxIterations: 1 } }));

    assert.notEqual(loop.phase, "WAITING_FOR_HUMAN", "a structured-contract violation must never be accepted as PASS");
    assert.equal(loop.phase, "EXHAUSTED");
    assert.ok(loop.iterations[0]?.reviewParseError !== undefined, "the failure must be recorded as a parse/protocol error");
    assert.equal(loop.iterations[0]?.reviewVerdict, undefined);
  });
});

describe("remediation round 1 — HIGH 4: verification cwd must stay inside the approved workspace", () => {
  it("R7: a ../ escape cwd is rejected and the command never executes outside", async () => {
    const parent = mkdtempSync(join(tmpdir(), "sf-cwd-escape-"));
    const workspaceDir = join(parent, "workspace");
    const outsideDir = join(parent, "outside");
    mkdirSync(workspaceDir);
    mkdirSync(outsideDir);
    try {
      writeFileSync(join(workspaceDir, "README.md"), "workspace\n");
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init", "--quiet"], { cwd: workspaceDir });
      const workspace = resolveWorkspace(workspaceDir);

      const worker = createVerificationWorker({
        commands: [
          {
            id: "escapee",
            executable: process.execPath,
            argv: ["-e", "require('fs').writeFileSync('escaped-marker.txt', 'outside')"],
            cwd: "../outside",
          },
        ],
        workspace,
        processRunner,
      });

      await assert.rejects(
        worker.execute({ runId: "run-x", workItemId: "wi-x", role: "VERIFIER", title: "t", instructions: "verify", acceptanceCriteria: [] }),
        { code: "VALIDATION" },
      );

      const { existsSync } = await import("node:fs");
      assert.equal(existsSync(join(outsideDir, "escaped-marker.txt")), false, "the command must never have executed outside the workspace");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("remediation round 1 — HIGH 5: start/resume concurrency must be claimed durably", () => {
  it("R8: two concurrent start() calls yield exactly one active loop and exactly one implementer run", async () => {
    const fx = newFactory();
    const item = await seedWorkItem(fx.factory);
    await toReady(fx.factory, item.id);
    const realLoops = createInMemoryLoopRepository();

    // Barrier: both start() calls must pass the friendly active-loop pre-check
    // before either reaches create(), so the race is decided at the
    // persistence layer, deterministically — never by lucky interleaving.
    let arrivals = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const gatedLoops: LoopRepository = {
      create: (loop) => realLoops.create(loop),
      compareAndSave: (loop, expectedVersion) => realLoops.compareAndSave(loop, expectedVersion),
      findById: (id) => realLoops.findById(id),
      async listByWorkItem(workItemId) {
        const result = await realLoops.listByWorkItem(workItemId);
        arrivals += 1;
        if (arrivals >= 2) releaseBarrier();
        await barrier;
        return result;
      },
    };

    const serviceA = makeService(fx, gatedLoops, { idPrefix: "pa" });
    const serviceB = makeService(fx, gatedLoops, { idPrefix: "pb" });
    const results = await Promise.allSettled([serviceA.start(baseInput(item.id)), serviceB.start(baseInput(item.id))]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one start() must win");
    assert.equal(rejected.length, 1, "the losing start() must fail safely before launching anything");
    assert.equal((await realLoops.listByWorkItem(item.id)).length, 1, "exactly one loop row must exist");
    assert.equal((await runsByRole(fx, item.id, "IMPLEMENTER")).length, 1, "exactly one implementer run must have launched");
  });

  it("R9: two concurrent resume() calls launch exactly one implementer run", async () => {
    const fx = newFactory();
    const item = await seedWorkItem(fx.factory);
    await toReady(fx.factory, item.id);
    const realLoops = createInMemoryLoopRepository();

    // Persist a loop that crashed right after committing phase=IMPLEMENTING
    // with iteration 1 open and nothing launched yet. Fully poisoned after
    // the crash, like crashWhen above: the dead process can do nothing more.
    let crashed = false;
    const dead = (): never => {
      throw new Error("simulated crash: this process is dead");
    };
    const crashAfterPhaseWrite: LoopRepository = {
      async create(loop) {
        if (crashed) dead();
        return realLoops.create(loop);
      },
      async compareAndSave(loop, expectedVersion) {
        if (crashed) dead();
        const saved = await realLoops.compareAndSave(loop, expectedVersion);
        if (saved.phase === "IMPLEMENTING") {
          crashed = true;
          dead();
        }
        return saved;
      },
      async findById(id) {
        if (crashed) dead();
        return realLoops.findById(id);
      },
      async listByWorkItem(workItemId) {
        if (crashed) dead();
        return realLoops.listByWorkItem(workItemId);
      },
    };
    await assert.rejects(makeService(fx, crashAfterPhaseWrite).start(baseInput(item.id)));
    const loopId = (await realLoops.listByWorkItem(item.id))[0]!.id;

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

    const serviceA = makeService(fx, realLoops, { implementerFactory: () => gatedImplementer, idPrefix: "pa" });
    const serviceB = makeService(fx, realLoops, { implementerFactory: () => gatedImplementer, idPrefix: "pb" });

    const resumeA = serviceA.resume(loopId);
    const resumeB = serviceB.resume(loopId);
    // Give both resumes time to fight over the claim while the winner's
    // worker is gated open; then release the gate.
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseExecute();
    await Promise.allSettled([resumeA, resumeB]);

    assert.equal(executeCalls, 1, "exactly one resume may launch the implementer");
    assert.equal((await runsByRole(fx, item.id, "IMPLEMENTER")).length, 1, "exactly one implementer run must exist");

    // Whoever won, driving the loop onward must still complete cleanly.
    const settled = await makeService(fx, realLoops).resume(loopId);
    assert.equal(settled.phase, "WAITING_FOR_HUMAN");
    assert.equal((await runsByRole(fx, item.id, "IMPLEMENTER")).length, 1);
  });
});

describe("remediation round 1 — HIGH 6: a durably-committed cancellation must prevent any new launch", () => {
  it("R10: cancel committing between the step's state read and the launch prevents the worker from ever starting", async () => {
    const fx = newFactory();
    const item = await seedWorkItem(fx.factory);
    await toReady(fx.factory, item.id);
    const realLoops = createInMemoryLoopRepository();

    let executeCalls = 0;
    const countingImplementer = {
      id: "counting-implementer",
      capabilities: { roles: ["IMPLEMENTER"] as const, deterministic: true },
      async execute(request: { runId: string }) {
        executeCalls += 1;
        return {
          status: "SUCCEEDED" as const,
          summary: "done",
          evidence: [{ kind: "NOTE" as const, summary: "done", reference: `scripted://implementer/${request.runId}/transcript` }],
          claimsAcceptanceMet: true,
        };
      },
    };

    // The cancel service shares only the durable repository, like a separate
    // OS process would.
    const cancelService = makeService(fx, realLoops);

    // Race injection: the first time the driving service reads a loop that is
    // IMPLEMENTING with nothing launched yet, a cancel is durably committed
    // AFTER the read returns its (now stale) snapshot — the exact
    // read-then-cancel-then-launch interleaving of the finding.
    let fired = false;
    const rachetLoops: LoopRepository = {
      create: (loop) => realLoops.create(loop),
      compareAndSave: (loop, expectedVersion) => realLoops.compareAndSave(loop, expectedVersion),
      listByWorkItem: (workItemId) => realLoops.listByWorkItem(workItemId),
      async findById(id) {
        const snapshot = await realLoops.findById(id);
        if (
          !fired &&
          snapshot !== undefined &&
          snapshot.phase === "IMPLEMENTING" &&
          !snapshot.cancelRequested &&
          (await runsByRole(fx, item.id, "IMPLEMENTER")).length === 0
        ) {
          fired = true;
          await cancelService.cancel(snapshot.id, human("user:test", "Test Operator"));
        }
        return snapshot; // stale pre-cancel snapshot, exactly as a racing reader would hold
      },
    };

    const drivingService = makeService(fx, rachetLoops, { implementerFactory: () => countingImplementer });
    const loop = await drivingService.start(baseInput(item.id));

    assert.equal(executeCalls, 0, "no worker may begin once cancellation intent is durable");
    assert.equal((await runsByRole(fx, item.id, "IMPLEMENTER")).length, 0, "no Factory run may be created after a durable cancel");
    assert.equal(loop.phase, "CANCELLED");
  });
});
