/**
 * DEFECT-DURABLE-WORKER-RUN-ENVELOPE — the real-process proof.
 *
 * `supervisorWorkerRunRecovery.test.ts` proves the reconciliation MECHANISM
 * against scripted liveness. This file proves it against a REAL offline Node
 * child process, a REAL SQLite-backed `SupervisorRepository`, a REAL SIGKILL,
 * and the REAL `/proc`-reading liveness probe (`createProcLivenessProbe`) —
 * no fakes anywhere in the liveness path. No AI is invoked anywhere in this
 * file; the "worker" is a Node fixture script that ignores SIGTERM.
 *
 * Three things this file exists to prove, each named by the frozen task:
 *
 *   1. A real child, killed with SIGKILL, is reconciled from SQLite after a
 *      simulated restart with exactly one terminal result and one event —
 *      repeated reconciliation and a second restart change neither count.
 *   2. PID-reuse refusal: a process now holding the dead child's exact pid,
 *      with a different `/proc` start tick (built deterministically via a
 *      `procRoot` fixture, precisely as `procLiveness.ts`'s own tests do,
 *      rather than relying on the OS to reuse a pid on a schedule no test can
 *      control), is never mistaken for the run's real owner.
 *   3. Racing two independent connections to the SAME durable file for the
 *      SAME launch results in at most one PREPARED write — the CAS guarantee
 *      AC-1 depends on, proven under real concurrency rather than asserted.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createNodeProcessRunner } from "../src/adapters/process/nodeProcessRunner.js";
import { createProcLivenessProbe, bootIdentity, machineIdentity, processStartTime } from "../src/adapters/supervision/procLiveness.js";
import { createSqliteSupervisorRepository } from "../src/adapters/supervision/sqliteSupervisorRepository.js";
import { createWorkerRunLifecycle, createProviderLifecycle } from "../src/adapters/supervision/workerRunLifecycle.js";
import type { ActivityLease } from "../src/supervision/activity.js";
import { createSequentialIdGenerator } from "../src/domain/ids.js";
import { DEFAULT_ROUTING_POLICY } from "../src/supervision/modelRouting.js";
import { SupervisorService, type SupervisorServiceDeps } from "../src/supervision/supervisorService.js";
import type { RoadmapItem } from "../src/supervision/supervisorTypes.js";
import { canonicalWorkerRunId } from "../src/supervision/workerRunEnvelope.js";
import { manualClock, scriptedExecutor, scriptedProbe, TEST_CATALOG } from "./support/supervisorFixtures.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import { fakeCliInvocation } from "./support/fakeCli.js";
import { createChildPlanAdvancer } from "../src/adapters/supervision/childPlanAdvancer.js";
import { ConcurrencyError } from "../src/domain/errors.js";
import type { Plan } from "../src/planning/planTypes.js";
import type { ProcessRunner } from "../src/ports/processRunner.js";
import type { SupervisorRepository, WorkExecutor } from "../src/supervision/supervisorPorts.js";

const createdDirs: string[] = [];

it("C6-H1: provider-intent CAS failure prevents real provider spawn after parent PREPARED", async () => {
  const fixture = c6Fixture("normal");
  const db = tempDbPath("c6-provider-cas-");
  const owner = openService(db);
  try {
    await owner.service.ensureInitialized();
    await createWorkerRunLifecycle({ repository: owner.repository, clock: { now: () => Date.now() } }).prepare(c6Context);
    const broken: SupervisorRepository = { ...owner.repository, load: () => owner.repository.load(),
      async compareAndSave() { throw new ConcurrencyError("offline provider CAS refusal"); } };
    let launches = 0;
    await assert.rejects(createProviderLifecycle({ repository: broken, clock: { now: () => Date.now() },
      actionId: c6Context.actionId, artifactDir: fixture.dir }).run({ provider: "offline", model: "offline" },
      { async run(request) { launches += 1; return createNodeProcessRunner().run(request); } },
      { executable: fixture.provider, argv: [], cwd: fixture.dir, env: {}, timeoutMs: 1000 }, () => ({})));
    assert.equal(launches, 0);
    assert.equal(launchCount(fixture.counter), 0);
  } finally { owner.repository.close(); }
});

it("C6-H3: silent real provider heartbeats do not invent progress and settlement stops all timer writes", async () => {
  const fixture = c6Fixture("normal");
  const db = tempDbPath("c6-heartbeat-");
  const owner = openService(db);
  try {
    await owner.service.ensureInitialized();
    await createWorkerRunLifecycle({ repository: owner.repository, clock: { now: () => Date.now() } }).prepare(c6Context);
    const lifecycle = createProviderLifecycle({ repository: owner.repository, clock: { now: () => Date.now() },
      actionId: c6Context.actionId, artifactDir: fixture.dir, heartbeatIntervalMs: 2 });
    const pending = lifecycle.run({ provider: "offline", model: "offline" }, createNodeProcessRunner(), {
      executable: process.execPath, argv: ["-e", "setTimeout(()=>process.stdout.write('measured'),100);setTimeout(()=>{},200)"],
      cwd: fixture.dir, env: {}, timeoutMs: 2000,
    }, () => ({}));
    await until(async () => (await owner.repository.load())?.workerRuns?.[0]?.heartbeat !== undefined);
    const silent = (await owner.repository.load())!.workerRuns![0]!.heartbeat!;
    assert.equal(silent.progress, 0);
    assert.equal(silent.lastProgressAt, undefined);
    await pending;
    const settled = (await owner.repository.load())!;
    assert.ok(settled.workerRuns![0]!.heartbeat!.progress > 0);
    assert.ok(settled.workerRuns![0]!.heartbeat!.lastProgressAt !== undefined);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await owner.repository.load())!.version, settled.version);
  } finally { owner.repository.close(); }
});

it("C6-H3: early exit and ACK callback failure leave no heartbeat writer", async () => {
  for (const fail of [false, true]) {
    const fixture = c6Fixture("normal"); const db = tempDbPath("c6-ack-race-");
    const owner = openService(db);
    try {
      await owner.service.ensureInitialized();
      await createWorkerRunLifecycle({ repository: owner.repository, clock: { now: () => Date.now() } }).prepare(c6Context);
      const lifecycle = createProviderLifecycle({ repository: owner.repository, clock: { now: () => Date.now() },
        actionId: c6Context.actionId, artifactDir: fixture.dir, heartbeatIntervalMs: 1 });
      const run = lifecycle.run({ provider: "offline", model: "offline" }, createNodeProcessRunner(), {
        executable: process.execPath, argv: ["-e", ""], cwd: fixture.dir, env: {}, timeoutMs: 2000,
        onSpawn() { if (fail) throw new Error("offline ACK consumer failed"); },
      }, () => ({}));
      if (fail) await assert.rejects(run); else await run;
      const version = (await owner.repository.load())!.version;
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal((await owner.repository.load())!.version, version);
    } finally { owner.repository.close(); }
  }
});

/** Offline executable travels through childPlanAdvancer -> plan scope -> cliWorker -> real Node spawn. */
function c6Fixture(mode: "normal" | "max" | "hang", count = 1) {
  const dir = mkdtempSync(join(tmpdir(), "sf-c6-production-"));
  createdDirs.push(dir);
  const counter = join(dir, "launches");
  const ordering = join(dir, "ordering");
  const provider = join(dir, "provider.mjs");
  const wrapper = join(dir, "wrapper.mjs");
  writeFileSync(provider, "#!" + process.execPath + "\n" +
    'import { appendFileSync } from "node:fs";\n' +
    "appendFileSync(" + JSON.stringify(counter) + ", String(process.pid)+'\\n');\n" +
    (mode === "hang" ? 'setInterval(() => {}, 1000);\n' :
      "setTimeout(() => process.stdout.write(JSON.stringify({type:'result',result:'offline',session_id:'session-'+process.pid," +
      (mode === "max" ? "terminal_reason:'max_turns'" : "terminal_reason:'end_turn'") + "})), 40);\n"));
  chmodSync(provider, 0o700);
  const moduleUrl = (name: string) => JSON.stringify(new URL("../src/" + name + ".js", import.meta.url).href);
  writeFileSync(wrapper, [
    "import assert from 'node:assert/strict';",
    "import { appendFileSync } from 'node:fs';",
    "import { withWorkerRunEnvironment } from " + moduleUrl("adapters/supervision/workerRunLifecycle") + ";",
    "import { createSqliteSupervisorRepository } from " + moduleUrl("adapters/supervision/sqliteSupervisorRepository") + ";",
    "import { createClaudeCodeWorker } from " + moduleUrl("adapters/workers/claudeCodeAdapter") + ";",
    "import { createNodeProcessRunner } from " + moduleUrl("adapters/process/nodeProcessRunner") + ";",
    "const binding=JSON.parse(process.env.FACTORY_WORKER_RUN_BINDING);",
    "const repo=createSqliteSupervisorRepository(binding.database);",
    "const runner=createNodeProcessRunner({killGraceMs:20});",
    "const checkedRunner={async run(request) {",
    "  const state=await repo.load(); const run=state.workerRuns.find(r=>r.runId===binding.runId);",
    "  assert.equal(run.actionId,binding.actionId); const child=run.invocations.at(-1);",
    "  assert.ok(child); assert.equal(child.lease,undefined);",
    "  appendFileSync(" + JSON.stringify(ordering) + ", JSON.stringify({state:run.state,sequence:child.sequence,maxTurns:child.maxTurns})+'\\n');",
    "  return runner.run(request); }};",
    "const worker=createClaudeCodeWorker({executable:" + JSON.stringify(provider) + ",model:'offline',maxTurns:7,",
    "  workspace:{root:" + JSON.stringify(dir) + "},processRunner:checkedRunner,timeoutMs:20000});",
    "try { await withWorkerRunEnvironment(async()=>{ for(let i=0;i<" + count + ";i++) {",
    "  const result=await worker.execute({runId:'r'+i,workItemId:'w',role:'IMPLEMENTER',title:'offline',instructions:'offline',acceptanceCriteria:[]});",
    "  if (" + JSON.stringify(mode) + "==='max') assert.equal(result.status,'FAILED');",
    "} }); } catch { process.exitCode=1; } finally {repo.close();}",
  ].join("\n"));
  return { dir, counter, ordering, provider, wrapper };
}
function launchCount(path: string): number {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length : 0;
}
function c6Advancer(fixture: ReturnType<typeof c6Fixture>, repository: SupervisorRepository,
  dbPath: string, runner: ProcessRunner = createNodeProcessRunner()) {
  return createChildPlanAdvancer({
    processRunner: runner, plans: { async findById() { return { execution: {} } as Plan; } },
    cwd: fixture.dir, plansDbPath: join(fixture.dir, "unused-plans.db"),
    supervisorDbPath: dbPath, artifactDir: join(fixture.dir, "artifacts"),
    cliEntry: fixture.wrapper, workerRuns: createWorkerRunLifecycle({ repository, clock: { now: () => Date.now() } }),
    clock: { now: () => Date.now() }, timeoutMs: 25000,
  });
}
const c6Context = { actionId: "ITEM:LAUNCH_AI_WORKER:a1", roadmapKey: "ITEM", attempt: 1,
  provider: "claude-code", model: "offline" };
function c6SchedulerService(db: string, fixture: ReturnType<typeof c6Fixture>, executor: WorkExecutor) {
  return openService(db, { workerRunArtifactDir: join(fixture.dir, "artifacts"), executor,
    activityLease: (at) => ({ pid: process.pid, processStartedAt: processStartTime(process.pid)!,
      machine: machineIdentity(), boot: bootIdentity()!, claimedAt: at }) });
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 15000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "bounded wait for real provider ACK");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

it("C6-H1: production launcher binds real provider ACK, PREPARED ordering, maxTurns and ordered sessions", async () => {
  const fixture = c6Fixture("normal", 2);
  const db = tempDbPath("c6-provider-binding-");
  const owner = openService(db);
  try {
    await owner.service.ensureInitialized();
    await c6Advancer(fixture, owner.repository, db).resume("offline", undefined, c6Context);
    const run = (await owner.repository.load())!.workerRuns![0]!;
    assert.equal(run.state, "COMPLETED");
    assert.equal(run.invocations?.length, 2);
    const ordered = readFileSync(fixture.ordering, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(ordered[0].state, "PREPARED");
    assert.deepEqual(ordered.map(row => row.sequence), [1, 2]);
    for (const child of run.invocations!) {
      assert.ok(child.lease);
      assert.notEqual(child.lease.pid, run.wrapperLease?.pid);
      assert.equal(child.maxTurns, 7);
      assert.equal(child.providerSessionId, "session-" + child.lease.pid);
      assert.ok(child.lease.processStartedAt > 0);
    }
    assert.notEqual(run.invocations![0]!.lease!.pid, run.invocations![1]!.lease!.pid);
    assert.equal(launchCount(fixture.counter), 2);
  } finally { owner.repository.close(); }
});

it("C6-H1: failed PREPARED CAS produces zero wrapper and provider launches", async () => {
  const fixture = c6Fixture("normal");
  const db = tempDbPath("c6-cas-failure-");
  const owner = openService(db);
  try {
    await owner.service.ensureInitialized();
    const broken: SupervisorRepository = { ...owner.repository,
      load: () => owner.repository.load(),
      async compareAndSave() { throw new ConcurrencyError("offline CAS refusal"); },
    };
    let launches = 0;
    await assert.rejects(c6Advancer(fixture, broken, db, { async run(request) {
      launches += 1; return createNodeProcessRunner().run(request);
    } }).resume("offline", undefined, c6Context));
    assert.equal(launches, 0);
    assert.equal(launchCount(fixture.counter), 0);
    assert.equal((await owner.repository.load())?.workerRuns?.length ?? 0, 0);
  } finally { owner.repository.close(); }
});

it("C6-H1 C6-H2: exit-zero structured MAX_TURNS gates next provider and repeated eligible scheduler ticks across restart", async () => {
  const fixture = c6Fixture("max", 2);
  const db = tempDbPath("c6-max-gate-");
  let calls = 0;
  const owner = openService(db);
  await owner.service.ensureInitialized();
  await assert.rejects(c6Advancer(fixture, owner.repository, db).resume("offline", undefined, c6Context));
  const prior = (await owner.repository.load())!;
  assert.equal(prior.roadmap[0]!.status, "ELIGIBLE");
  assert.equal(prior.workerRuns![0]!.state, "AWAITING_CONTROLLER");
  assert.equal(prior.workerRuns![0]!.invocations!.length, 1);
  assert.equal(prior.workerRuns![0]!.exitCode, 0);
  owner.repository.close();
  for (let restart = 0; restart < 2; restart += 1) {
    const fresh = c6SchedulerService(db, fixture,
      { async execute() { calls += 1; return { kind: "CHANGES_REQUIRED", findings: [] }; } });
    try {
      for (let tick = 0; tick < 2; tick += 1) {
        const result = await fresh.service.tick();
        assert.equal(result.kind, "WAITING_FOR_HUMAN");
        if (result.kind !== "WAITING_FOR_HUMAN") assert.fail("MAX_TURNS must refuse every tick");
        assert.equal(result.reason, "HUMAN_DECISION_REQUIRED");
        assert.equal(result.humanActionRequired,
          `1 worker run cannot be established as running or finished (${prior.workerRuns![0]!.runId}); refusing to schedule further work`);
      }
      const current = (await fresh.repository.load())!;
      assert.equal(current.roadmap[0]!.attempts, prior.roadmap[0]!.attempts);
      assert.deepEqual(current.activeClaim, prior.activeClaim);
      assert.equal(current.workerRunNotifications?.length, 1);
      assert.equal(current.workerRunNotifications![0]!.kind, "MAX_TURNS");
    } finally { fresh.repository.close(); }
  }
  assert.equal(calls, 0);
  assert.equal(launchCount(fixture.counter), 1);
});

it("C6-C05 unblocked control: identical scheduler lease setup calls the offline executor", async () => {
  const fixture = c6Fixture("normal");
  const db = tempDbPath("c6-unblocked-control-");
  let calls = 0;
  const fresh = c6SchedulerService(db, fixture,
    { async execute() { calls += 1; return { kind: "CHANGES_REQUIRED", findings: [] }; } });
  try {
    await fresh.service.ensureInitialized();
    const prior = (await fresh.repository.load())!;
    assert.equal(prior.roadmap[0]!.status, "ELIGIBLE");
    assert.equal(prior.workerRuns?.length ?? 0, 0);
    await fresh.service.tick();
    assert.equal(calls, 1, "valid lease must allow this offline scheduler to reach its executor");
    assert.equal(launchCount(fixture.counter), 0);
  } finally { fresh.repository.close(); }
});
it("C6-M1: production ACK then real SIGKILL reconciles once after SQLite restart", async () => {
  const fixture = c6Fixture("hang");
  const db = tempDbPath("c6-real-kill-");
  const owner = openService(db);
  await owner.service.ensureInitialized();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let wrapperPid = 0;
  const runner: ProcessRunner = { async run(request) {
    const result = await createNodeProcessRunner().run({ ...request, onSpawn: ({ pid }) => { wrapperPid = pid; } });
    await held; return result;
  } };
  const pending = c6Advancer(fixture, owner.repository, db, runner).resume("offline", undefined, c6Context);
  const caught = pending.catch(() => undefined);
  let providerPid = 0;
  try {
    await until(async () => {
      providerPid = (await owner.repository.load())?.workerRuns?.[0]?.invocations?.[0]?.lease?.pid ?? 0;
      return providerPid > 0 && launchCount(fixture.counter) === 1;
    });
    const lease = (await owner.repository.load())!.workerRuns![0]!.invocations![0]!.lease!;
    assert.notEqual(providerPid, wrapperPid);
    process.kill(wrapperPid, "SIGKILL");
    process.kill(providerPid, "SIGKILL");
    await until(async () => createProcLivenessProbe().check(lease) === "GONE");
    owner.repository.close();
    const fresh = openService(db, { workerRunArtifactDir: join(fixture.dir, "artifacts") });
    try {
      await fresh.service.tick(); await fresh.service.tick();
      const state = (await fresh.repository.load())!;
      assert.equal(state.workerRuns?.length, 1);
      assert.equal(state.workerRuns![0]!.state, "LOST");
      assert.equal(state.workerRunNotifications?.length, 1);
      assert.equal(state.workerRunNotifications![0]!.kind, "LOST");
      assert.equal(launchCount(fixture.counter), 1);
    } finally { fresh.repository.close(); }
  } finally {
    for (const pid of [wrapperPid, providerPid]) if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch {} }
    release(); await caught;
    try { owner.repository.close(); } catch {}
  }
});

it("C6-M1: racing two real supervisors for one SQLite action launches at most one fake provider", async () => {
  const fixture = c6Fixture("normal");
  const db = tempDbPath("c6-supervisor-race-");
  const seed = openService(db);
  await seed.service.ensureInitialized(); seed.repository.close();
  let executions = 0;
  const make = (id: string) => {
    const repository = createSqliteSupervisorRepository(db);
    const advancer = c6Advancer(fixture, repository, db);
    const executor: WorkExecutor = { async execute(input) {
      executions += 1;
      await advancer.resume("offline", undefined, { ...c6Context, actionId: input.actionId, attempt: input.item.attempts ?? 1 });
      return { kind: "CHANGES_REQUIRED", findings: ["offline fixture settled"] };
    } };
    const service = new SupervisorService({ repository, roadmapCatalog: [ITEM], probe: scriptedProbe(),
      executor, clock: { now: () => Date.now() }, ids: createSequentialIdGenerator(),
      routingPolicy: DEFAULT_ROUTING_POLICY, resourceCatalog: TEST_CATALOG, ownerId: id,
      liveness: createProcLivenessProbe(), activityLease: (at) => ({ pid: process.pid,
        processStartedAt: processStartTime(process.pid)!, machine: machineIdentity(), boot: bootIdentity()!, claimedAt: at }),
      workerRunArtifactDir: join(fixture.dir, "artifacts") });
    return { service, repository };
  };
  const a = make("c6-supervisor-a"); const b = make("c6-supervisor-b");
  try {
    const results = await Promise.allSettled([a.service.tick(), b.service.tick()]);
    for (const result of results) if (result.status === "rejected") assert.ok(result.reason instanceof ConcurrencyError);
    assert.equal(executions, 1);
    assert.equal(launchCount(fixture.counter), 1);
    assert.equal((await a.repository.load())!.workerRuns!.length, 1);
  } finally { a.repository.close(); b.repository.close(); }
});
after(() => {
  cleanupTempDbs();
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ITEM: RoadmapItem = {
  key: "ITEM",
  // Already DONE: see the identical reasoning in supervisorWorkerRunRecovery.test.ts.
  title: "a roadmap item no test here actually drives",
  dependsOn: [],
  status: "ELIGIBLE",
  workClass: "NORMAL_IMPLEMENTATION",
  order: 1,
};

function openService(
  dbPath: string,
  overrides: Partial<SupervisorServiceDeps> = {},
): { readonly service: SupervisorService; readonly repository: ReturnType<typeof createSqliteSupervisorRepository> } {
  const repository = createSqliteSupervisorRepository(dbPath);
  const deps: SupervisorServiceDeps = {
    repository,
    roadmapCatalog: [ITEM],
    probe: scriptedProbe(),
    executor: scriptedExecutor(),
    clock: manualClock(),
    ids: createSequentialIdGenerator(),
    routingPolicy: DEFAULT_ROUTING_POLICY,
    resourceCatalog: TEST_CATALOG,
    liveness: createProcLivenessProbe(),
    ...overrides,
  };
  return { service: new SupervisorService(deps), repository };
}

/**
 * Spawns the real `never-exits.mjs` fixture through the REAL `ProcessRunner`,
 * captures its real pid via the new `onSpawn` hook (DEFECT-DURABLE-WORKER-RUN-ENVELOPE
 * AC-2), and returns once the runner has SIGKILLed it — proving the whole
 * spawn -> ACK -> real-SIGKILL path with no fake anywhere in it.
 */
async function spawnAndKill(): Promise<{ readonly pid: number; readonly lease: ActivityLease }> {
  const runner = createNodeProcessRunner({ killGraceMs: 200 });
  let pid: number | undefined;
  // Read WHILE THE PROCESS IS ALIVE, inside `onSpawn` — exactly the real
  // production path (`childPlanAdvancer.ts`'s own `onSpawn` handler). Reading
  // it back after the child has been reaped would find nothing: `/proc/<pid>`
  // no longer exists once `close` fires, which is precisely why this durable
  // identity must be captured at spawn time and not reconstructed later.
  let startedAt: number | undefined;
  const claimedAt = Date.now();
  const result = await runner.run({
    ...fakeCliInvocation("never-exits.mjs"),
    cwd: process.cwd(),
    env: {},
    timeoutMs: 400,
    onSpawn: (info) => {
      pid = info.pid;
      startedAt = processStartTime(info.pid);
    },
  });
  assert.equal(result.terminationReason, "TIMEOUT");
  assert.equal(result.signal, "SIGKILL", "the real child must have needed a real SIGKILL, not merely SIGTERM");
  assert.ok(pid !== undefined, "onSpawn must have fired with the real OS pid");
  assert.ok(startedAt !== undefined, "this run's own /proc start tick must have been readable while it was alive");
  const boot = bootIdentity();
  assert.ok(boot !== undefined, "this test machine must be able to report a boot identity");

  return {
    pid,
    lease: { pid, processStartedAt: startedAt, machine: machineIdentity(), boot, claimedAt },
  };
}

describe("DEFECT-DURABLE-WORKER-RUN-ENVELOPE: the real-process proof", () => {
  it("1) a real SIGKILLed child is reconciled from SQLite after a restart, with one result and one event — idempotently", async () => {
    const dbPath = tempDbPath("sf-worker-run-real-kill-");
    const actionId = "ITEM:LAUNCH_AI_WORKER:a1";
    const runId = canonicalWorkerRunId(actionId);

    const before = openService(dbPath);
    await before.service.ensureInitialized();
    const lifecycle = createWorkerRunLifecycle({ repository: before.repository, clock: { now: () => Date.now() } });
    await lifecycle.prepare({ actionId, roadmapKey: "ITEM", attempt: 1, provider: "claude-code", model: "opus" });

    const { pid, lease } = await spawnAndKill();
    await lifecycle.adopt({ runId, lease });

    const runningState = await before.repository.load();
    assert.equal(runningState?.workerRuns?.find((run) => run.runId === runId)?.state, "RUNNING");
    before.repository.close();

    // The real probe must independently agree the real pid is really gone.
    const realProbe = createProcLivenessProbe();
    assert.equal(realProbe.check(lease), "GONE", `pid ${pid} must be confirmed dead by the real liveness probe`);

    // "AFTER A RESTART": a fresh SupervisorService, the REAL probe, no fakes.
    const after1 = openService(dbPath);
    const firstTick = await after1.service.tick();
    assert.notEqual(firstTick.kind, "RECOVERY_REQUIRED");
    const reconciled = await after1.repository.load();
    const run = reconciled?.workerRuns?.find((entry) => entry.runId === runId);
    assert.equal(run?.state, "LOST", "a really-dead real owner must be recorded LOST");
    const notifications = reconciled?.workerRunNotifications ?? [];
    assert.equal(notifications.length, 1, "exactly one event for this run");
    assert.equal(notifications[0]?.kind, "LOST");
    after1.repository.close();

    // REPEATED RECONCILIATION, AND A SECOND RESTART, CHANGE NEITHER COUNT.
    const after2 = openService(dbPath);
    await after2.service.tick();
    await after2.service.tick();
    const after3 = openService(dbPath);
    await after3.service.tick();
    const settled = await after3.repository.load();
    assert.equal(settled?.workerRunNotifications?.length, 1, "idempotent: still exactly one event");
    assert.equal(settled?.workerRuns?.filter((entry) => entry.runId === runId).length, 1, "idempotent: still exactly one result record for this run");
    assert.equal(settled?.workerRuns?.find((entry) => entry.runId === runId)?.state, "LOST");
    after2.repository.close();
    after3.repository.close();
  });

  it("2) a process now holding the dead child's exact pid, with a different /proc start tick, is never mistaken for the run's real owner", async () => {
    const { pid, lease } = await spawnAndKill();

    // A deterministic pid-reuse fixture: the SAME pid, a DIFFERENT start tick
    // — precisely `procLiveness.ts`'s own measured collision case (a lease
    // whose pid was recycled by an unrelated process), built the same way its
    // own tests do rather than left to whatever the OS schedules next.
    const procRoot = mkdtempSync(join(tmpdir(), "sf-worker-run-pid-reuse-"));
    createdDirs.push(procRoot);
    const procDir = join(procRoot, String(pid));
    mkdirSync(procDir, { recursive: true });
    const differentStartTick = lease.processStartedAt + 999_999;
    const fields = ["R", ...Array.from({ length: 18 }, () => "0"), String(differentStartTick)];
    writeFileSync(join(procDir, "stat"), `${pid} (unrelated-process) ${fields.join(" ")}`);

    const reusedProbe = createProcLivenessProbe({ procRoot, machine: lease.machine, boot: lease.boot });
    assert.equal(
      reusedProbe.check(lease),
      "GONE",
      "a pid now held by a process with a different start tick must never read as the original owner",
    );
  });

  it("3) racing two independent connections to the SAME durable file launches at most one worker", async () => {
    const dbPath = tempDbPath("sf-worker-run-race-");
    const actionId = "ITEM:LAUNCH_AI_WORKER:a1";

    const seed = openService(dbPath);
    await seed.service.ensureInitialized();
    seed.repository.close();

    // TWO INDEPENDENT CONNECTIONS to the same file — the two-supervisor race.
    const repoA = createSqliteSupervisorRepository(dbPath);
    const repoB = createSqliteSupervisorRepository(dbPath);
    const clock = { now: () => Date.now() };
    const lifecycleA = createWorkerRunLifecycle({ repository: repoA, clock });
    const lifecycleB = createWorkerRunLifecycle({ repository: repoB, clock });

    const request = { actionId, roadmapKey: "ITEM", attempt: 1, provider: "claude-code", model: "opus" } as const;
    const results = await Promise.allSettled([lifecycleA.prepare(request), lifecycleB.prepare(request)]);

    const fulfilled = results.filter((entry) => entry.status === "fulfilled");
    const rejected = results.filter((entry) => entry.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one racing PREPARE must win — never zero, never both");
    assert.equal(rejected.length, 1, "the loser must be told it lost, not silently merged");

    const finalState = await repoA.load();
    const runs = (finalState?.workerRuns ?? []).filter((run) => run.actionId === actionId);
    assert.equal(runs.length, 1, "at most one durable worker-run record for this action, however many raced to create it");
    assert.equal(runs[0]?.state, "PREPARED");

    repoA.close();
    repoB.close();
  });
});

for (const window of ["invocation", "artifact"] as const) {
  it(`C6-R1: wrapper-only kill after MAX_TURNS ${window} publication preserves the controller gate`, async () => {
    const fixture = c6Fixture("max");
    const db = tempDbPath("c6-max-crash-");
    const marker = join(fixture.dir, "paused");
    const moduleUrl = (name: string) => JSON.stringify(new URL("../src/" + name + ".js", import.meta.url).href);
    writeFileSync(fixture.wrapper, [
      "import {writeFileSync} from 'node:fs';",
      "import {createProviderLifecycle} from " + moduleUrl("adapters/supervision/workerRunLifecycle") + ";",
      "import {createSqliteSupervisorRepository} from " + moduleUrl("adapters/supervision/sqliteSupervisorRepository") + ";",
      "import {createNodeProcessRunner} from " + moduleUrl("adapters/process/nodeProcessRunner") + ";",
      "const binding=JSON.parse(process.env.FACTORY_WORKER_RUN_BINDING);",
      "const repo=createSqliteSupervisorRepository(binding.database);",
      "const pause=async()=>{writeFileSync(" + JSON.stringify(marker) + ",'ready');setInterval(()=>{},1000);await new Promise(()=>{});};",
      "const intercepted={load:()=>repo.load(),async compareAndSave(state,version){",
      "const run=state.workerRuns.find(r=>r.runId===binding.runId);",
      "if(" + JSON.stringify(window) + "==='artifact' && run.state==='AWAITING_CONTROLLER') await pause();",
      "await repo.compareAndSave(state,version);",
      "if(" + JSON.stringify(window) + "==='invocation' && run.state==='RUNNING' && run.invocations?.[0]?.terminalReason==='MAX_TURNS') await pause();}};",
      "await createProviderLifecycle({repository:intercepted,clock:{now:()=>Date.now()},actionId:binding.actionId,artifactDir:binding.artifactDir}).run(",
      "{provider:'offline',model:'offline',maxTurns:7},createNodeProcessRunner(),",
      "{executable:" + JSON.stringify(fixture.provider) + ",argv:[],cwd:" + JSON.stringify(fixture.dir) + ",env:{},timeoutMs:10000},",
      "result=>{const data=JSON.parse(result.stdout);return {providerSessionId:data.session_id,...(data.terminal_reason==='max_turns'?{terminalReason:'MAX_TURNS'}:{})};});",
    ].join("\n"));
    const owner = openService(db);
    let wrapperPid = 0;
    await owner.service.ensureInitialized();
    const pending = c6Advancer(fixture, owner.repository, db, { run(request) {
      return createNodeProcessRunner().run({ ...request, onSpawn: ({pid}) => { wrapperPid = pid; } });
    } }).resume("offline", undefined, c6Context);
    const caught = pending.catch(() => undefined);
    try {
      await until(async () => existsSync(marker));
      const atCrash = (await owner.repository.load())!.workerRuns![0]!;
      assert.equal(atCrash.state, "RUNNING");
      assert.equal(atCrash.invocations![0]!.terminalReason, "MAX_TURNS");
      const artifactPath = join(fixture.dir, "artifacts", encodeURIComponent(atCrash.runId) + ".json");
      const artifactBefore = existsSync(artifactPath) ? readFileSync(artifactPath, "utf8") : undefined;
      process.kill(wrapperPid, "SIGKILL");
      await caught;
      assert.equal((await owner.repository.load())!.workerRuns![0]!.state, "AWAITING_CONTROLLER");
      if (artifactBefore !== undefined) assert.equal(readFileSync(artifactPath, "utf8"), artifactBefore);
      owner.repository.close();
      let calls = 0;
      for (let restart = 0; restart < 2; restart += 1) {
        const fresh = c6SchedulerService(db, fixture, { async execute() { calls += 1; return {kind:"CHANGES_REQUIRED",findings:[]}; } });
        try {
          for (let tick = 0; tick < 2; tick += 1) {
            const result = await fresh.service.tick();
            assert.equal(result.kind, "WAITING_FOR_HUMAN");
            if (result.kind === "WAITING_FOR_HUMAN") assert.match(result.humanActionRequired ?? "", /worker run.*refusing to schedule/);
          }
          const state = (await fresh.repository.load())!;
          assert.equal(state.workerRuns![0]!.state, "AWAITING_CONTROLLER");
          assert.equal(state.workerRuns![0]!.finishedAt, atCrash.invocations![0]!.finishedAt);
          assert.deepEqual(state.workerRunNotifications?.map(event => event.kind), ["MAX_TURNS"]);
        } finally { fresh.repository.close(); }
      }
      assert.equal(calls, 0);
      assert.equal(launchCount(fixture.counter), 1);
    } finally {
      if (wrapperPid > 0) { try { process.kill(wrapperPid, "SIGKILL"); } catch {} }
      await caught;
      try { owner.repository.close(); } catch {}
    }
  });
}

for (const termination of ["kill", "timeout"] as const) {
  it(`C6-R2: wrapper-only ${termination} leaves a detached provider protected across SQLite restart`, async () => {
    const fixture = c6Fixture("hang");
    const db = tempDbPath("c6-detached-provider-");
    const owner = openService(db);
    await owner.service.ensureInitialized();
    let wrapperPid = 0;
    let providerLease: ActivityLease | undefined;
    const pending = c6Advancer(fixture, owner.repository, db, { run(request) {
      return createNodeProcessRunner({killGraceMs:20}).run({...request,
        timeoutMs: termination === "timeout" ? 2000 : 15000,
        onSpawn: ({pid}) => { wrapperPid = pid; }});
    } }).resume("offline", undefined, c6Context);
    const caught = pending.catch(() => undefined);
    try {
      await until(async () => {
        providerLease = (await owner.repository.load())?.workerRuns?.[0]?.invocations?.[0]?.lease;
        return providerLease !== undefined && launchCount(fixture.counter) === 1;
      });
      assert.notEqual(providerLease!.pid, wrapperPid);
      if (termination === "kill") process.kill(wrapperPid, "SIGKILL");
      await caught;
      assert.equal(createProcLivenessProbe().check(providerLease!), "ALIVE");
      const prior = (await owner.repository.load())!;
      assert.notEqual(prior.workerRuns![0]!.state, "FAILED");
      assert.notEqual(prior.workerRuns![0]!.state, "COMPLETED");
      owner.repository.close();
      let calls = 0;
      for (const unknown of [false, true]) {
        const fresh = c6SchedulerService(db, fixture, {async execute(){ calls += 1; return {kind:"CHANGES_REQUIRED",findings:[]}; }});
        try {
          if (unknown) {
            // A different machine identity is real probe uncertainty, never evidence of death.
            const state = (await fresh.repository.load())!;
            await fresh.repository.compareAndSave({...state,version:state.version+1,workerRuns:state.workerRuns!.map(run=>({...run,
              invocations:run.invocations!.map(child=>({...child,lease:{...child.lease!,machine:"unverifiable-offline-machine"}}))}))},state.version);
          }
          for (let tick=0;tick<2;tick+=1) {
            const result=await fresh.service.tick();
            assert.equal(result.kind,"WAITING_FOR_HUMAN");
            if(result.kind==="WAITING_FOR_HUMAN") assert.match(result.humanActionRequired ?? "",/worker run.*refusing to schedule/);
          }
          assert.equal((await fresh.repository.load())!.roadmap[0]!.attempts,prior.roadmap[0]!.attempts);
        } finally {fresh.repository.close();}
      }
      assert.equal(calls,0);
      assert.equal(launchCount(fixture.counter),1);
    } finally {
      for(const pid of [wrapperPid,providerLease?.pid ?? 0]) if(pid>0) {try {process.kill(pid,"SIGKILL");} catch {}}
      await caught;
      if(providerLease !== undefined) await until(async()=>createProcLivenessProbe().check(providerLease!)==="GONE");
      try {owner.repository.close();} catch {}
    }
  });
}