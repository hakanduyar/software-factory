/**
 * DEFECT-DURABLE-WORKER-RUN-ENVELOPE AC-7, AC-8, AC-10, AC-12 — worker-run
 * recovery against a REAL SQLite-backed `SupervisorRepository`, surviving a
 * simulated restart (a fresh `SupervisorService` instance opened against the
 * same durable file).
 *
 * OFFLINE THROUGHOUT. No process is spawned here: a launch's durable identity
 * (PREPARED -> RUNNING) is recorded directly through `createWorkerRunLifecycle`,
 * exactly as `createChildPlanAdvancer` would from a real spawn, and liveness is
 * decided by a SCRIPTED probe rather than `/proc`. `supervisorWorkerRunRealKill.test.ts`
 * is the sibling that proves the same mechanism end to end against a REAL
 * offline child process and a REAL SIGKILL.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createSqliteSupervisorRepository } from "../src/adapters/supervision/sqliteSupervisorRepository.js";
import { createWorkerRunLifecycle } from "../src/adapters/supervision/workerRunLifecycle.js";
import { workerRunArtifactPath, writeWorkerRunArtifact } from "../src/adapters/supervision/workerRunArtifact.js";
import type { ActivityLease, Liveness, LivenessProbe } from "../src/supervision/activity.js";
import { createSequentialIdGenerator } from "../src/domain/ids.js";
import { DEFAULT_ROUTING_POLICY } from "../src/supervision/modelRouting.js";
import { SupervisorService, type SupervisorServiceDeps } from "../src/supervision/supervisorService.js";
import type { RoadmapItem } from "../src/supervision/supervisorTypes.js";
import { canonicalWorkerRunId } from "../src/supervision/workerRunEnvelope.js";
import { manualClock, scriptedExecutor, scriptedProbe, TEST_CATALOG } from "./support/supervisorFixtures.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created: string[] = [];
after(() => {
  cleanupTempDbs();
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * ALREADY DONE, deliberately: every case here is about the DURABLE WORKER-RUN
 * RECORD, a mechanism entirely separate from the roadmap's own claim/execute
 * cycle (see `workerRunEnvelope.ts`'s own header: this is provider-specific,
 * `Activity`/roadmap scheduling is generic). Leaving the item schedulable
 * would let the ORDINARY scheduler launch a fresh attempt on the very same
 * tick a worker run reconciles, which is correct behaviour but would make
 * "the executor was never called" assertions meaningless noise unrelated to
 * what these tests are proving.
 */
const ITEM: RoadmapItem = {
  key: "ITEM",
  title: "a roadmap item no test here actually drives",
  dependsOn: [],
  status: "DONE",
  workClass: "NORMAL_IMPLEMENTATION",
  order: 1,
};

function fixedProbe(answer: Liveness): LivenessProbe {
  return { check: () => answer };
}

function lease(overrides: Partial<ActivityLease> = {}): ActivityLease {
  return { pid: 424242, processStartedAt: 5_000, machine: "recovery-test-machine", boot: "boot-recovery-1", claimedAt: 0, ...overrides };
}

function artifactDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-worker-run-recovery-"));
  created.push(dir);
  return dir;
}

/** A fresh `SupervisorService`, as if a new process just opened the same durable file. */
function openService(
  dbPath: string,
  clock: { now(): number },
  opts: { readonly liveness?: LivenessProbe; readonly artifactDir?: string; readonly stallAfterMs?: number } = {},
): {
  readonly service: SupervisorService;
  readonly repository: ReturnType<typeof createSqliteSupervisorRepository>;
  readonly executor: ReturnType<typeof scriptedExecutor>;
} {
  const repository = createSqliteSupervisorRepository(dbPath);
  const executor = scriptedExecutor();
  const deps: SupervisorServiceDeps = {
    repository,
    roadmapCatalog: [ITEM],
    probe: scriptedProbe(),
    // ITEM is already DONE (see its own comment), so this is never reached.
    executor,
    clock,
    ids: createSequentialIdGenerator(),
    routingPolicy: DEFAULT_ROUTING_POLICY,
    resourceCatalog: TEST_CATALOG,
    ...(opts.liveness === undefined ? {} : { liveness: opts.liveness }),
    ...(opts.artifactDir === undefined ? {} : { workerRunArtifactDir: opts.artifactDir }),
    ...(opts.stallAfterMs === undefined ? {} : { stallAfterMs: opts.stallAfterMs }),
  };
  return { service: new SupervisorService(deps), repository, executor };
}

describe("DEFECT-DURABLE-WORKER-RUN-ENVELOPE: recovery survives a restart", () => {
  for (const maxTurns of [false, true]) {
    it(`C6-H5: PREPARED crash-window artifact recovers ${maxTurns ? "MAX_TURNS" : "normal completion"} with original timestamp`, async () => {
      const db = tempDbPath("c6-prepared-recovery-");
      const clock = manualClock();
      const directory = artifactDir();
      const before = openService(db, clock);
      await before.service.ensureInitialized();
      const lifecycle = createWorkerRunLifecycle({ repository: before.repository, clock });
      const run = await lifecycle.prepare({ actionId: "ITEM:LAUNCH_AI_WORKER:a1", roadmapKey: "ITEM",
        attempt: 1, provider: "claude-code", model: "offline" });
      const at = clock.now() + 20;
      writeWorkerRunArtifact(workerRunArtifactPath(directory, run.runId), {
        runId: run.runId, actionId: run.actionId, exitCode: 0, signal: null, terminationReason: "EXITED",
        ...(maxTurns ? { terminalReason: "MAX_TURNS" as const, providerSessionId: "offline-session" } : {}),
        detail: "offline crash-window terminal", at,
      });
      before.repository.close();
      clock.advance(1000);
      const fresh = openService(db, clock, { artifactDir: directory });
      try {
        await fresh.service.tick(); await fresh.service.tick();
        const state = (await fresh.repository.load())!;
        assert.equal(state.workerRuns![0]!.state, maxTurns ? "AWAITING_CONTROLLER" : "COMPLETED");
        assert.equal(state.workerRuns![0]!.finishedAt, at);
        assert.equal(state.workerRuns![0]!.wrapperLease, undefined);
        assert.equal(state.workerRunNotifications?.length ?? 0, maxTurns ? 1 : 0);
        assert.equal(fresh.executor.calls().length, 0);
      } finally { fresh.repository.close(); }
    });
  }
  for (const foreign of [false, true]) {
    it(`C6-H4: ${foreign ? "freshly rehashed foreign action" : "torn artifact"} becomes AMBIGUOUS with one refusal event`, async () => {
      const db = tempDbPath("c6-artifact-refusal-");
      const clock = manualClock(); const directory = artifactDir();
      const owner = openService(db, clock, { artifactDir: directory, liveness: fixedProbe("ALIVE") });
      try {
        await owner.service.ensureInitialized();
        const run = await createWorkerRunLifecycle({ repository: owner.repository, clock }).prepare({
          actionId: "ITEM:LAUNCH_AI_WORKER:a1", roadmapKey: "ITEM", attempt: 1, provider: "claude-code", model: "offline" });
        const path = workerRunArtifactPath(directory, run.runId);
        if (foreign) writeWorkerRunArtifact(path, { runId: run.runId, actionId: "foreign", exitCode: 0,
          signal: null, terminationReason: "EXITED", at: clock.now(), detail: "foreign" });
        else writeFileSync(path, "{torn");
        await owner.service.tick(); await owner.service.tick();
        const state = (await owner.repository.load())!;
        assert.equal(state.workerRuns![0]!.state, "AMBIGUOUS");
        assert.equal(state.workerRunNotifications?.length, 1);
        assert.equal(owner.executor.calls().length, 0);
      } finally { owner.repository.close(); }
    });
  }
  it("AC-7/AC-10: a RUNNING run whose owner is gone becomes LOST, and never launches anything", async () => {
    const dbPath = tempDbPath("sf-worker-run-recovery-");
    const clock = manualClock();

    // "Before the restart": PREPARE and ACK a launch, exactly as
    // `createChildPlanAdvancer` would from a real spawn.
    const before = openService(dbPath, clock);
    await before.service.ensureInitialized();
    const lifecycle = createWorkerRunLifecycle({ repository: before.repository, clock });
    await lifecycle.prepare({
      actionId: "ITEM:LAUNCH_AI_WORKER:a1",
      roadmapKey: "ITEM",
      attempt: 1,
      provider: "claude-code",
      model: "opus",
    });
    const runningLease = lease();
    await lifecycle.adopt({ runId: canonicalWorkerRunId("ITEM:LAUNCH_AI_WORKER:a1"), lease: runningLease });
    const runId = canonicalWorkerRunId("ITEM:LAUNCH_AI_WORKER:a1");
    const runningState = await before.repository.load();
    assert.equal(runningState?.workerRuns?.find((run) => run.runId === runId)?.state, "RUNNING");
    before.repository.close();

    // "After the restart": a fresh SupervisorService, told the owner is GONE.
    const after1 = openService(dbPath, clock, { liveness: fixedProbe("GONE") });
    await after1.service.tick();
    const reconciled = await after1.repository.load();
    const run = reconciled?.workerRuns?.find((entry) => entry.runId === runId);
    assert.equal(run?.state, "LOST", "a dead owner must be recorded LOST, never silently forgotten");

    const notifications = reconciled?.workerRunNotifications ?? [];
    assert.equal(notifications.length, 1, "exactly one pending notification for this run/kind");
    assert.equal(notifications[0]?.kind, "LOST");
    assert.equal(notifications[0]?.runId, runId);
    after1.repository.close();

    // TICKING AGAIN — AND EVEN FROM ANOTHER FRESH SERVICE — MUST NOT DUPLICATE
    // THE NOTIFICATION OR LAUNCH ANYTHING (AC-8, AC-10).
    const after2 = openService(dbPath, clock, { liveness: fixedProbe("GONE") });
    await after2.service.tick();
    await after2.service.tick();
    const settled = await after2.repository.load();
    assert.equal(settled?.workerRunNotifications?.length, 1, "a repeated reconcile must not enqueue a second notification");
    assert.equal(settled?.workerRuns?.find((entry) => entry.runId === runId)?.state, "LOST");
    assert.deepEqual(after2.executor.callsFor("ITEM"), [], "reconciling a worker run must never itself call the executor");
    after2.repository.close();
  });

  it("AC-7: reconcile reads a valid completion artifact FIRST, before consulting liveness at all", async () => {
    const dbPath = tempDbPath("sf-worker-run-recovery-artifact-");
    const clock = manualClock();
    const dir = artifactDir();

    const before = openService(dbPath, clock, { artifactDir: dir });
    await before.service.ensureInitialized();
    const lifecycle = createWorkerRunLifecycle({ repository: before.repository, clock });
    const actionId = "ITEM:LAUNCH_AI_WORKER:a1";
    const runId = canonicalWorkerRunId(actionId);
    await lifecycle.prepare({ actionId, roadmapKey: "ITEM", attempt: 1, provider: "claude-code", model: "opus" });
    await lifecycle.adopt({ runId, lease: lease() });
    before.repository.close();

    // The wrapper finished and left a REAL completion artifact behind, but
    // (simulating a crash) nothing ever recorded that durably as a completion.
    const path = workerRunArtifactPath(dir, runId);
    writeWorkerRunArtifact(path, {
      runId,
      actionId,
      exitCode: 0,
      signal: null,
      terminationReason: "EXITED",
      detail: "sf plan resume exited 0",
      at: clock.now(),
    });

    // A probe that would say GONE — proving the artifact, not liveness, is
    // what actually decided the outcome (AC-7's own ordering).
    const after1 = openService(dbPath, clock, { liveness: fixedProbe("GONE"), artifactDir: dir });
    await after1.service.tick();
    const reconciled = await after1.repository.load();
    const run = reconciled?.workerRuns?.find((entry) => entry.runId === runId);
    assert.equal(run?.state, "COMPLETED", "a real completion artifact must settle the run, not liveness");
    assert.equal(run?.exitCode, 0);
    assert.equal((reconciled?.workerRunNotifications ?? []).length, 0, "a normal COMPLETED produces no notification");
    after1.repository.close();
  });

  it("AC-6: a verified MAX_TURNS artifact recovers as AWAITING_CONTROLLER, with one MAX_TURNS notification", async () => {
    const dbPath = tempDbPath("sf-worker-run-recovery-maxturns-");
    const clock = manualClock();
    const dir = artifactDir();

    const before = openService(dbPath, clock, { artifactDir: dir });
    await before.service.ensureInitialized();
    const lifecycle = createWorkerRunLifecycle({ repository: before.repository, clock });
    const actionId = "ITEM:LAUNCH_AI_WORKER:a1";
    const runId = canonicalWorkerRunId(actionId);
    await lifecycle.prepare({ actionId, roadmapKey: "ITEM", attempt: 1, provider: "claude-code", model: "opus" });
    await lifecycle.adopt({ runId, lease: lease() });
    before.repository.close();

    writeWorkerRunArtifact(workerRunArtifactPath(dir, runId), {
      runId,
      actionId,
      exitCode: 0,
      signal: null,
      terminationReason: "EXITED",
      providerSessionId: "sess-max",
      terminalReason: "MAX_TURNS",
      detail: "structured terminal_reason=max_turns",
      at: clock.now(),
    });

    const after1 = openService(dbPath, clock, { liveness: fixedProbe("ALIVE"), artifactDir: dir });
    await after1.service.tick();
    const reconciled = await after1.repository.load();
    const run = reconciled?.workerRuns?.find((entry) => entry.runId === runId);
    assert.equal(run?.state, "AWAITING_CONTROLLER", "verified MAX_TURNS must never be treated as an ordinary failure");
    assert.equal(run?.terminalReason, "MAX_TURNS");
    assert.equal(run?.providerSessionId, "sess-max");

    const notifications = reconciled?.workerRunNotifications ?? [];
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.kind, "MAX_TURNS");

    // NEVER AUTO-CONTINUES: repeated ticks must not move it off AWAITING_CONTROLLER.
    await after1.service.tick();
    await after1.service.tick();
    const settled = await after1.repository.load();
    assert.equal(settled?.workerRuns?.find((entry) => entry.runId === runId)?.state, "AWAITING_CONTROLLER");
    assert.equal(settled?.workerRunNotifications?.length, 1);
    after1.repository.close();
  });

  it("AC-4/AC-7: a live owner that stopped reporting becomes STALLED, not LOST", async () => {
    const dbPath = tempDbPath("sf-worker-run-recovery-stalled-");
    const clock = manualClock();

    const before = openService(dbPath, clock, { stallAfterMs: 1_000 });
    await before.service.ensureInitialized();
    const lifecycle = createWorkerRunLifecycle({ repository: before.repository, clock });
    const actionId = "ITEM:LAUNCH_AI_WORKER:a1";
    const runId = canonicalWorkerRunId(actionId);
    await lifecycle.prepare({ actionId, roadmapKey: "ITEM", attempt: 1, provider: "claude-code", model: "opus" });
    const runLease = lease();
    await lifecycle.adopt({ runId, lease: runLease });
    before.repository.close();

    clock.advance(60_000);

    const after1 = openService(dbPath, clock, { liveness: fixedProbe("ALIVE"), stallAfterMs: 1_000 });
    await after1.service.tick();
    const reconciled = await after1.repository.load();
    const run = reconciled?.workerRuns?.find((entry) => entry.runId === runId);
    assert.equal(run?.state, "STALLED", "a live owner that stopped reporting is STALLED, not LOST");
    assert.equal(reconciled?.workerRunNotifications?.[0]?.kind, "STALLED");
    after1.repository.close();
  });

  it("AC-3: a different identity for the same run is refused, never a second worker", async () => {
    const dbPath = tempDbPath("sf-worker-run-recovery-ambiguous-");
    const clock = manualClock();

    const before = openService(dbPath, clock);
    await before.service.ensureInitialized();
    const lifecycle = createWorkerRunLifecycle({ repository: before.repository, clock });
    const actionId = "ITEM:LAUNCH_AI_WORKER:a1";
    const runId = canonicalWorkerRunId(actionId);
    await lifecycle.prepare({ actionId, roadmapKey: "ITEM", attempt: 1, provider: "claude-code", model: "opus" });
    await lifecycle.adopt({ runId, lease: lease({ pid: 1 }) });

    await assert.rejects(
      () => lifecycle.adopt({ runId, lease: lease({ pid: 1, processStartedAt: 999 }) }),
      /refusing to adopt a different process/,
    );
    before.repository.close();
  });

  it("AC-12: durable state written before this defect existed still loads and schedules normally", async () => {
    const dbPath = tempDbPath("sf-worker-run-recovery-legacy-");
    const clock = manualClock();
    const repository = createSqliteSupervisorRepository(dbPath);
    const service = new SupervisorService({
      repository,
      roadmapCatalog: [ITEM],
      probe: scriptedProbe(),
      executor: scriptedExecutor(),
      clock,
      ids: createSequentialIdGenerator(),
      routingPolicy: DEFAULT_ROUTING_POLICY,
      resourceCatalog: TEST_CATALOG,
    });
    // No workerRuns/workerRunNotifications field is ever written by this
    // installation — the exact shape of a database from before this defect.
    const state = await service.ensureInitialized();
    assert.equal(state.workerRuns, undefined);
    const result = await service.tick();
    assert.notEqual(result.kind, "RECOVERY_REQUIRED");
    repository.close();
  });
});
