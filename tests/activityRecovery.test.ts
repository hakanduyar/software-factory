/**
 * TASK-018 PART B, against a REAL database and REAL processes.
 *
 * `activity.test.ts` decides; `procLiveness.test.ts` observes processes. This
 * file is where the two meet the thing the criteria are actually about: work
 * that outlives the process doing it.
 *
 * Every child here is a real `node` process writing to a real SQLite file
 * through the production repository, and every death is a real SIGKILL, which
 * cannot be caught. Nothing simulates a crash by calling a function named
 * `simulateCrash`.
 *
 * Offline: no provider is contacted, no model is invoked, no money can be spent.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createSqliteSupervisorRepository } from "../src/adapters/supervision/sqliteSupervisorRepository.js";
import {
  createProcLivenessProbe,
  leaseForThisProcess,
  machineIdentity,
} from "../src/adapters/supervision/procLiveness.js";
import {
  claimActivity,
  completeActivity,
  crashedItemsToRequeue,
  observeCompletion,
  reportProgress,
  unobservedCompletions,
  type Activity,
} from "../src/supervision/activity.js";
import { anchorFor } from "../src/supervision/provenanceChain.js";
import { SupervisorService } from "../src/supervision/supervisorService.js";
import { createSequentialIdGenerator } from "../src/domain/ids.js";
import { DEFAULT_ROUTING_POLICY } from "../src/supervision/modelRouting.js";
import type { RoadmapItem, SupervisorState } from "../src/supervision/supervisorTypes.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import { manualClock, scriptedExecutor, scriptedProbe, TEST_CATALOG } from "./support/supervisorFixtures.js";

const scratch = mkdtempSync(join(tmpdir(), "sf-t018b-"));
const DIST = "/home/hakanduyar/GitHub/software-factory/dist/src";
const MACHINE = machineIdentity();

after(() => {
  cleanupTempDbs();
});

const ROADMAP: readonly RoadmapItem[] = [
  { key: "A", title: "Work", dependsOn: [], status: "ACTIVE", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
  { key: "B", title: "Other", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 2 },
];

function baseState(roadmap: readonly RoadmapItem[] = ROADMAP): SupervisorState {
  return {
    version: 1,
    // Both fields: a policy missing `autonomousSpendAllowed` does not parse, and
    // the supervisor correctly blocks the item before it ever runs — which is
    // what kept the production-path test seeing no activity at all.
    financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
    resources: [],
    roadmap,
    checkpoints: [],
    escalations: [],
    provenance: [],
    provenanceAnchor: anchorFor([]),
    updatedAt: 1_000,
  };
}

async function seed(roadmap: readonly RoadmapItem[] = ROADMAP): Promise<string> {
  const path = tempDbPath();
  const repository = createSqliteSupervisorRepository(path);
  try {
    await repository.create(baseState(roadmap));
  } finally {
    repository.close();
  }
  return path;
}

async function readActivities(path: string): Promise<readonly Activity[]> {
  const repository = createSqliteSupervisorRepository(path);
  try {
    return (await repository.load())?.activities ?? [];
  } finally {
    repository.close();
  }
}

/**
 * A real child that claims an activity, optionally reports progress, and then
 * either is SIGKILLed where it stands or finishes cleanly.
 *
 * It uses the production repository and the production claim logic. A child
 * that wrote the row itself would prove the test can write a row.
 */
interface ChildOptions {
  readonly path: string;
  readonly id: string;
  readonly kind: string;
  readonly roadmapKey: string;
  readonly progress?: number;
  /**
   * `hold` claims and then stays alive, so a rival really overlaps it.
   * `interrupt` computes a completion and is killed BEFORE it is written.
   */
  readonly ending: "die" | "complete" | "hold" | "interrupt";
}

interface ChildResult {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stderr: string;
}

/**
 * Starts a child WITHOUT waiting, so two of them can genuinely overlap.
 *
 * `runChild` runs one to completion and is the right tool for every sequential
 * case; a race needs both processes in flight before either finishes, and
 * `spawnSync` cannot express that.
 */
function spawnChild(options: ChildOptions): { readonly child: ChildProcess; readonly done: Promise<ChildResult> } {
  const script = writeChildScript(options);
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "pipe"] });
  const chunks: string[] = [];
  child.stderr?.on("data", (piece: Buffer) => chunks.push(piece.toString("utf8")));
  const done = once(child, "exit").then(() => ({
    status: child.exitCode,
    signal: child.signalCode,
    stderr: chunks.join(""),
  }));
  return { child, done };
}

/**
 * Writes the child's program and returns its path.
 *
 * ONE program for every case, so the sequential and the racing children differ
 * only in how they are started. A race against a differently-written child
 * would prove something about that child.
 *
 * The claim goes through `compareAndSave`, so a loser fails its CAS exactly as
 * a second supervisor would — which is the failure mode HIGH 5 was about, and
 * why the child re-reads and re-evaluates instead of reporting the conflict.
 */
function writeChildScript(options: ChildOptions): string {
  const script = join(scratch, `child-${options.id.replace(/[^a-z0-9]/gi, "_")}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    script,
    `
import { createSqliteSupervisorRepository } from ${JSON.stringify(`${DIST}/adapters/supervision/sqliteSupervisorRepository.js`)};
import { createProcLivenessProbe, leaseForThisProcess } from ${JSON.stringify(`${DIST}/adapters/supervision/procLiveness.js`)};
import { claimActivity, reportProgress, completeActivity } from ${JSON.stringify(`${DIST}/supervision/activity.js`)};

const repo = createSqliteSupervisorRepository(${JSON.stringify(options.path)});
const probe = createProcLivenessProbe();
const lease = leaseForThisProcess(Date.now());
if (lease === undefined) { console.error("no lease"); process.exit(3); }

const request = {
  id: ${JSON.stringify(options.id)},
  kind: ${JSON.stringify(options.kind)},
  roadmapKey: ${JSON.stringify(options.roadmapKey)},
  lease,
  now: Date.now(),
};

/**
 * Claim, write, and on a LOST CAS look again rather than reporting the
 * conflict: the winner's lease is what the refusal must name.
 */
let state = await repo.load();
let claimed;
let activities;
for (let attempt = 0; attempt < 5; attempt += 1) {
  claimed = claimActivity(state.activities ?? [], request, probe);
  if (!claimed.ok) { console.error("REFUSED: " + claimed.problem); process.exit(4); }
  activities = claimed.activities;
  ${options.ending === "hold" ? "await new Promise((r) => setTimeout(r, 120));" : ""}
  try {
    await repo.compareAndSave({ ...state, version: state.version + 1, activities }, state.version);
    break;
  } catch (error) {
    if (attempt === 4) { console.error("SAVE_ERROR: " + error); process.exit(7); }
    state = await repo.load();
  }
}
state = await repo.load();
${
  options.progress === undefined
    ? ""
    : `{
  const beat = reportProgress(state.activities ?? [], ${JSON.stringify(options.id)}, { at: Date.now(), progress: ${options.progress} });
  if (!beat.ok) { console.error("beat: " + beat.problem); process.exit(5); }
  await repo.compareAndSave({ ...state, version: state.version + 1, activities: beat.activities }, state.version);
  state = await repo.load();
}`
}
${
  options.ending === "complete"
    ? `{
  const done = completeActivity(state.activities ?? [], ${JSON.stringify(options.id)}, { state: "COMPLETED", completion: { outcome: "PASS", detail: "finished", at: Date.now() } });
  if (!done.ok) { console.error("done: " + done.problem); process.exit(6); }
  await repo.compareAndSave({ ...state, version: state.version + 1, activities: done.activities }, state.version);
}`
    : ""
}
${
  options.ending === "interrupt"
    ? `{
  // The EFFECT is computed and the process dies before the RECORD is written.
  const done = completeActivity(state.activities ?? [], ${JSON.stringify(options.id)}, { state: "COMPLETED", completion: { outcome: "PASS", detail: "never written", at: Date.now() } });
  if (!done.ok) { console.error("done: " + done.problem); process.exit(6); }
  process.kill(process.pid, "SIGKILL");
}`
    : ""
}
${
  options.ending === "hold"
    ? `/**
 * STAY ALIVE after winning, so the rival's retry finds a holder that is still
 * running. Without this the winner exits immediately, the loser re-reads, sees
 * a DEAD lease, and takes over -- which is correct behaviour and not the race
 * being tested. The first version of this test had exactly that hole and
 * reported two winners.
 */
await new Promise((r) => setTimeout(r, 2500));`
    : ""
}
repo.close();
${options.ending === "die" ? `process.kill(process.pid, "SIGKILL");` : `process.exit(0);`}
`,
    "utf8",
  );
  return script;
}

function runChild(options: ChildOptions): ChildResult {
  const script = writeChildScript(options);
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 60_000 });
  return { status: result.status, signal: result.signal, stderr: result.stderr ?? "" };
}

/**
 * The supervisor's clock must be in the SAME domain as the activity timestamps.
 *
 * The first version used `manualClock()` here while the children wrote
 * `Date.now()`, so "how long since the last heartbeat" compared a small fixture
 * number against a real epoch and a freshly-started activity was reported
 * STALLED. A stall is a measurement, and a measurement across two unrelated
 * clocks is not one.
 */
function supervisorOver(path: string, options: { readonly now?: number; readonly stallAfterMs?: number } = {}) {
  const repository = createSqliteSupervisorRepository(path);
  const base = options.now ?? Date.now();
  /**
   * MONOTONIC, not frozen. A fixed clock made every tick after the first
   * "not yet due" — the supervisor schedules a wake and then never reaches it —
   * so an item could be probed but never run, and the production-path test saw
   * no activity at all. Time advances a second per reading, which is enough for
   * a wake to fall due and still far too little to make anything look stalled.
   */
  let reading = 0;
  const now = () => base + reading++ * 1_000;
  const probe = scriptedProbe();
  for (const entry of TEST_CATALOG) {
    probe.set(entry.provider, entry.model, { state: "AVAILABLE", reason: "scripted", billingMode: "INCLUDED_SUBSCRIPTION" });
  }
  const service = new SupervisorService({
    repository,
    roadmapCatalog: [...ROADMAP],
    probe,
    executor: scriptedExecutor(),
    clock: { now },
    ids: createSequentialIdGenerator(),
    routingPolicy: DEFAULT_ROUTING_POLICY,
    resourceCatalog: TEST_CATALOG,
    liveness: createProcLivenessProbe(),
    activityLease: (claimedAt) => leaseForThisProcess(claimedAt),
    ...(options.stallAfterMs === undefined ? {} : { stallAfterMs: options.stallAfterMs }),
    log: () => {},
  });
  return { service, repository };
}

// =====================================================================
// AC-11/AC-15 — the PRODUCTION path records activities
// =====================================================================

describe("TASK-018 AC-11/AC-15: running an item records a durable activity", () => {
  /**
   * ROUND-1 REVIEW, CRITICAL. The first version of Part B built
   * `claimActivity`, `reportProgress` and `completeActivity` and called none of
   * them from `runItem`, so a real process could still die with no lease, no
   * heartbeat, no completion and nothing for reconciliation to find. Every
   * durable-orchestration property held in tests and in nothing that ran.
   *
   * This drives a REAL tick through the executor and reads what the database
   * holds afterwards.
   */
  it("a tick that runs an item leaves a lease, a heartbeat and a completion behind", async () => {
    const queued: readonly RoadmapItem[] = [
      { key: "A", title: "Work", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ];
    const path = await seed(queued);

    /**
     * SEVERAL TICKS, because the first ones do other work: the supervisor
     * probes its resources before it can route anything, so a single tick
     * proves nothing about the execution path. The loop stops as soon as an
     * activity exists, so a passing run is not waiting on a fixed count.
     */
    const { service, repository } = supervisorOver(path);
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await service.tick();
        if (((await repository.load())?.activities ?? []).length > 0) break;
      }
    } finally {
      repository.close();
    }

    const activities = await readActivities(path);
    assert.equal(activities.length, 1, "the production path recorded no activity");
    const activity = activities[0]!;
    assert.equal(activity.roadmapKey, "A");

    // A LEASE naming this very process, checkable against the process table.
    assert.ok(activity.lease, "no lease was recorded");
    assert.equal(activity.lease.pid, process.pid);
    assert.equal(activity.lease.machine, MACHINE);
    assert.equal(createProcLivenessProbe().check(activity.lease), "ALIVE");

    // A HEARTBEAT written before the launch, which is what separates
    // "claimed and never started" from "started and stopped reporting".
    assert.ok((activity.heartbeat?.progress ?? 0) >= 1, "no launch heartbeat was recorded");

    // A COMPLETION, whatever the outcome was: a failure nobody noticed is the
    // same problem as a success nobody noticed.
    assert.ok(activity.completion, "no completion was recorded");
    assert.ok(["COMPLETED", "FAILED"].includes(activity.state), `unexpected state ${activity.state}`);
    assert.deepEqual(
      unobservedCompletions(activities).map((entry) => entry.id),
      [activity.id],
      "the completion is not discoverable as outstanding",
    );
  });

  /**
   * ROUND-2 REVIEW, CRITICAL — the reviewer's own reproduction.
   *
   * The activity writes were guarded by `lease !== undefined && probe !==
   * undefined`, which reads as caution and is the opposite. With the production
   * probe and a lease source that cannot identify this process, the supervisor
   * RAN the work, completed it, and marked the item DONE with no activity, no
   * lease and nothing to reconcile. Unknown liveness ran the work.
   *
   * An installation that records no activities at all is a configuration; one
   * that is configured to and cannot is an unknown, and unknowns refuse.
   */
  it("REFUSES to run when it cannot establish its own process identity", async () => {
    const queued: readonly RoadmapItem[] = [
      { key: "A", title: "Work", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ];
    const path = await seed(queued);

    let executorCalls = 0;
    const repository = createSqliteSupervisorRepository(path);
    const base = Date.now();
    let reading = 0;
    const probe = scriptedProbe();
    for (const entry of TEST_CATALOG) {
      probe.set(entry.provider, entry.model, { state: "AVAILABLE", reason: "scripted", billingMode: "INCLUDED_SUBSCRIPTION" });
    }
    try {
      const service = new SupervisorService({
        repository,
        roadmapCatalog: [...queued],
        probe,
        executor: {
          execute: async () => {
            executorCalls += 1;
            return { kind: "COMPLETED", detail: "should never run" };
          },
        },
        clock: { now: () => base + reading++ * 1_000 },
        ids: createSequentialIdGenerator(),
        routingPolicy: DEFAULT_ROUTING_POLICY,
        resourceCatalog: TEST_CATALOG,
        liveness: createProcLivenessProbe(),
        // Configured to record activities, and unable to say who it is.
        activityLease: () => undefined,
        log: () => {},
      });
      for (let attempt = 0; attempt < 5; attempt += 1) await service.tick();
    } finally {
      repository.close();
    }

    assert.equal(executorCalls, 0, "work ran without a durable activity");
    assert.deepEqual(await readActivities(path), []);

    const after = createSqliteSupervisorRepository(path);
    try {
      const state = await after.load();
      assert.notEqual(
        state?.roadmap.find((item) => item.key === "A")?.status,
        "DONE",
        "an item was completed with nothing to reconcile",
      );
    } finally {
      after.close();
    }
  });

  it("refuses to start a second run while a live process holds the activity", async () => {
    const queued: readonly RoadmapItem[] = [
      { key: "A", title: "Work", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ];
    const path = await seed(queued);

    // This process takes the lease the production path would take.
    const repository = createSqliteSupervisorRepository(path);
    try {
      const state = await repository.load();
      assert.ok(state);
      const lease = leaseForThisProcess(Date.now());
      assert.ok(lease);
      const held = claimActivity(
        state.activities ?? [],
        { id: "A:PLAN:r1", kind: "PLAN", roadmapKey: "A", lease, now: Date.now() },
        createProcLivenessProbe(),
      );
      assert.equal(held.ok, true);
      if (!held.ok) throw new Error("unreachable");
      await repository.compareAndSave(
        { ...state, version: state.version + 1, activities: held.activities },
        state.version,
      );
    } finally {
      repository.close();
    }

    const { service: rival, repository: second } = supervisorOver(path);
    let result;
    try {
      result = await rival.tick();
    } finally {
      second.close();
    }

    // Either the tick refused to start beside the holder, or it chose a
    // different action id — what must NOT happen is two owners of one id.
    const activities = await readActivities(path);
    const perId = new Map<string, number>();
    for (const entry of activities) perId.set(entry.id, (perId.get(entry.id) ?? 0) + 1);
    for (const [id, count] of perId) assert.equal(count, 1, `${id} has ${count} owners`);
    assert.ok(result);
  });
});

// =====================================================================
// AC-11 — state outlives the process that owned it
// =====================================================================

describe("TASK-018 AC-11: an activity's state survives the death of its owner", () => {
  it("a killed owner leaves its claim and its progress readable by a fresh process", async () => {
    const path = await seed();
    const child = runChild({ path, id: "A:REVIEW:r1", kind: "REVIEW", roadmapKey: "A", progress: 3, ending: "die" });
    assert.equal(child.signal, "SIGKILL", `child did not die as arranged: ${child.stderr}`);

    // A DIFFERENT process, opening the same file, with nothing carried over.
    const activities = await readActivities(path);
    assert.equal(activities.length, 1);
    const activity = activities[0]!;
    assert.equal(activity.id, "A:REVIEW:r1");
    assert.equal(activity.state, "RUNNING");
    assert.equal(activity.heartbeat?.progress, 3);
    assert.ok(activity.lease, "the lease did not survive");
    assert.equal(activity.lease.machine, MACHINE);
  });
});

// =====================================================================
// AC-13 — two real processes, one owner
// =====================================================================

describe("TASK-018 AC-13: a second owner is refused, not merged", () => {
  it("REFUSES a second REAL process while the first is alive, naming the holder", async () => {
    const path = await seed();
    // The holder is this process, which is demonstrably alive.
    const repository = createSqliteSupervisorRepository(path);
    try {
      const state = await repository.load();
      assert.ok(state);
      const { leaseForThisProcess } = await import("../src/adapters/supervision/procLiveness.js");
      const lease = leaseForThisProcess(1_000);
      assert.ok(lease);
      const claimed = claimActivity(
        state.activities ?? [],
        { id: "A:REVIEW:r1", kind: "REVIEW", roadmapKey: "A", lease, now: 1_000 },
        createProcLivenessProbe(),
      );
      assert.equal(claimed.ok, true);
      if (!claimed.ok) throw new Error("unreachable");
      await repository.compareAndSave(
        { ...state, version: state.version + 1, activities: claimed.activities },
        state.version,
      );
    } finally {
      repository.close();
    }

    // A real second process attempts the same claim.
    const rival = runChild({ path, id: "A:REVIEW:r1", kind: "REVIEW", roadmapKey: "A", ending: "complete" });
    assert.equal(rival.status, 4, `the rival did not refuse: ${rival.stderr}`);
    assert.match(rival.stderr, /is held by pid \d+/);
    assert.match(rival.stderr, /still running/);

    // ...and it wrote nothing.
    const activities = await readActivities(path);
    assert.equal(activities.length, 1);
    assert.equal(activities[0]?.state, "CLAIMED", "the rival changed the record it was refused");
  });

  /**
   * ROUND-1 REVIEW, HIGH 5. The sequential case above proves the refusal
   * REASON; it does not prove what happens when two processes genuinely race.
   * The reviewer ran that race and got `SQLITE_BUSY — database is locked` in one
   * child and a bare `ConcurrencyError` in the other: both accurate, and
   * neither says who is running the work.
   *
   * Both children are started before either can finish, so the ordering is the
   * operating system's rather than the test's. Exactly one must win, the other
   * must refuse, and the database must end with ONE owner.
   */
  it("two REAL processes racing leave exactly one owner, and the loser is told who won", async () => {
    const path = await seed();
    const racers = [0, 1].map(() =>
      spawnChild({ path, id: "A:REVIEW:r1", kind: "REVIEW", roadmapKey: "A", progress: 1, ending: "hold" }),
    );
    const results = await Promise.all(racers.map((racer) => racer.done));

    const winners = results.filter((entry) => entry.status === 0);
    const losers = results.filter((entry) => entry.status !== 0);
    assert.equal(winners.length, 1, `expected one winner, got ${winners.length}: ${JSON.stringify(results)}`);
    assert.equal(losers.length, 1);

    /**
     * The loser must say WHO holds it. `SQLITE_BUSY` or a bare version conflict
     * would satisfy "it did not proceed" and fail this, which is the point.
     */
    const complaint = losers[0]!.stderr;
    assert.match(complaint, /REFUSED:/, `the loser did not refuse cleanly: ${complaint}`);
    assert.match(complaint, /is held by pid \d+/, `the loser did not name the holder: ${complaint}`);
    assert.match(complaint, /still running/, complaint);

    const activities = await readActivities(path);
    assert.equal(activities.length, 1, "a race produced more than one activity record");
    assert.equal(activities.filter((entry) => entry.id === "A:REVIEW:r1").length, 1, "two owners of one id");
  });

  it("ALLOWS a real process to take over once the holder is dead — the positive control", async () => {
    const path = await seed();
    const first = runChild({ path, id: "A:REVIEW:r1", kind: "REVIEW", roadmapKey: "A", progress: 1, ending: "die" });
    assert.equal(first.signal, "SIGKILL");

    const second = runChild({ path, id: "A:REVIEW:r1", kind: "REVIEW", roadmapKey: "A", ending: "complete" });
    assert.equal(second.status, 0, `takeover refused: ${second.stderr}`);

    const activities = await readActivities(path);
    assert.equal(activities.length, 1, "a takeover duplicated the record");
    assert.equal(activities[0]?.completion?.outcome, "PASS");
    assert.equal(activities[0]?.heartbeat?.progress, 1, "the dead owner's progress was lost");
  });
});

// =====================================================================
// AC-16 / AC-18 — a restarted supervisor works out what happened
// =====================================================================

describe("TASK-018 AC-16/AC-18: startup reconciliation after the deaths that happened", () => {
  it("a reviewer killed mid-review is recorded CRASHED, and its item returns to the queue", async () => {
    const path = await seed();
    assert.equal(
      runChild({ path, id: "A:REVIEW:r1", kind: "REVIEW", roadmapKey: "A", progress: 2, ending: "die" }).signal,
      "SIGKILL",
    );

    // A NEW supervisor process-equivalent: a fresh repository, fresh service.
    const { service, repository } = supervisorOver(path);
    try {
      await service.tick();
    } finally {
      repository.close();
    }

    const activities = await readActivities(path);
    assert.equal(activities[0]?.reconciliation?.verdict, "CRASHED");
    assert.match(activities[0]?.reconciliation?.detail ?? "", /is gone/);

    const after = createSqliteSupervisorRepository(path);
    try {
      const state = await after.load();
      /**
       * NOT PINNED TO "PENDING", and the first draft of this test was wrong to
       * pin it. Reconciliation returns the item to the queue, and the SAME tick
       * then legitimately carries it onward — eligibility, selection, the
       * executor — so the status at the end of the tick is the executor's
       * outcome, not reconciliation's. Asserting it would be testing the
       * executor and would break whenever its script changed.
       *
       * What reconciliation owns is that the item no longer sits in the state a
       * DEAD owner left it in. The exact re-queue is asserted where it is
       * unambiguous, in the AC-20 cases against `crashedItemsToRequeue`.
       */
      assert.notEqual(
        state?.roadmap.find((item) => item.key === "A")?.status,
        "ACTIVE",
        "the item was left in the state its dead owner held it in",
      );
      // ...and recovery did not finish the activity or invent a completion.
      assert.equal(activities[0]?.state, "RUNNING");
      assert.equal(activities[0]?.completion, undefined);
    } finally {
      after.close();
    }
  });

  /**
   * ROUND-1 REVIEW, HIGH 4. The restart case was a same-process "supervisor
   * equivalent" — a fresh repository and service inside the test runner — and
   * the reviewer was right that it does not exercise a restart. This runs the
   * tick in a REAL separate process that shares no memory with the parent, and
   * the parent then reads what it left behind.
   */
  it("a supervisor in a SEPARATE process reconciles what a dead owner left", async () => {
    const path = await seed();
    assert.equal(
      runChild({ path, id: "A:REVIEW:r1", kind: "REVIEW", roadmapKey: "A", progress: 5, ending: "die" }).signal,
      "SIGKILL",
    );

    const tick = join(scratch, `tick-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(
      tick,
      `
import { createSqliteSupervisorRepository } from ${JSON.stringify(`${DIST}/adapters/supervision/sqliteSupervisorRepository.js`)};
import { createProcLivenessProbe, leaseForThisProcess } from ${JSON.stringify(`${DIST}/adapters/supervision/procLiveness.js`)};
import { SupervisorService } from ${JSON.stringify(`${DIST}/supervision/supervisorService.js`)};
import { createSequentialIdGenerator } from ${JSON.stringify(`${DIST}/domain/ids.js`)};
import { DEFAULT_ROUTING_POLICY } from ${JSON.stringify(`${DIST}/supervision/modelRouting.js`)};

const repo = createSqliteSupervisorRepository(${JSON.stringify(path)});
const state = await repo.load();
const base = Date.now();
let reading = 0;
await new SupervisorService({
  repository: repo,
  roadmapCatalog: state.roadmap.map((item) => ({ ...item })),
  probe: { probe: async () => ({ state: "UNKNOWN_FAILURE", reason: "no resources in this fixture" }) },
  executor: { execute: async () => ({ kind: "FAILED", detail: "not reached" }) },
  clock: { now: () => base + reading++ * 1000 },
  ids: createSequentialIdGenerator(),
  routingPolicy: DEFAULT_ROUTING_POLICY,
  resourceCatalog: [],
  liveness: createProcLivenessProbe(),
  activityLease: (at) => leaseForThisProcess(at),
  log: () => {},
}).tick();
repo.close();
process.exit(0);
`,
      "utf8",
    );
    const restarted = spawnSync(process.execPath, [tick], { encoding: "utf8", timeout: 60_000 });
    assert.equal(restarted.status, 0, `the separate supervisor failed: ${restarted.stderr}`);

    const activities = await readActivities(path);
    assert.equal(activities[0]?.reconciliation?.verdict, "CRASHED", "a separate process drew no conclusion");
    assert.equal(activities[0]?.heartbeat?.progress, 5, "what the dead owner had done was lost");
  });

  it("a chain owner killed between its run and the freeze is CRASHED with its progress intact", async () => {
    const path = await seed();
    assert.equal(
      runChild({ path, id: "A:CHAIN:r1", kind: "CHAIN", roadmapKey: "A", progress: 94, ending: "die" }).signal,
      "SIGKILL",
    );
    const { service, repository } = supervisorOver(path);
    try {
      await service.tick();
    } finally {
      repository.close();
    }
    const activities = await readActivities(path);
    assert.equal(activities[0]?.reconciliation?.verdict, "CRASHED");
    assert.equal(activities[0]?.heartbeat?.progress, 94, "what it had done was lost");
  });

  it("a supervisor restarted with a LIVE activity in flight leaves it alone", async () => {
    // The positive control for every CRASHED case above: this process holds the
    // lease and is running, so nothing may be concluded about it.
    const path = await seed();
    const repository = createSqliteSupervisorRepository(path);
    try {
      const state = await repository.load();
      assert.ok(state);
      const { leaseForThisProcess } = await import("../src/adapters/supervision/procLiveness.js");
      const lease = leaseForThisProcess(Date.now());
      assert.ok(lease);
      const claimed = claimActivity(
        state.activities ?? [],
        { id: "A:REVIEW:r1", kind: "REVIEW", roadmapKey: "A", lease, now: Date.now() },
        createProcLivenessProbe(),
      );
      assert.equal(claimed.ok, true);
      if (!claimed.ok) throw new Error("unreachable");
      const beat = reportProgress(claimed.activities, "A:REVIEW:r1", { at: Date.now(), progress: 1 });
      assert.equal(beat.ok, true);
      if (!beat.ok) throw new Error("unreachable");
      await repository.compareAndSave(
        { ...state, version: state.version + 1, activities: beat.activities },
        state.version,
      );
    } finally {
      repository.close();
    }

    const { service, repository: second } = supervisorOver(path);
    try {
      await service.tick();
    } finally {
      second.close();
    }

    const activities = await readActivities(path);
    assert.equal(activities[0]?.reconciliation?.verdict, "LIVE");
    // The roadmap effect is asserted against `crashedItemsToRequeue` directly,
    // for the same reason as above: the tick continues past reconciliation and
    // the final status is not reconciliation's to own.
    assert.deepEqual(crashedItemsToRequeue(activities, [{ key: "A", status: "ACTIVE" }]), []);
  });

  it("a STALLED live owner is distinguished from a crashed one", async () => {
    const path = await seed();
    const repository = createSqliteSupervisorRepository(path);
    try {
      const state = await repository.load();
      assert.ok(state);
      const { leaseForThisProcess } = await import("../src/adapters/supervision/procLiveness.js");
      const lease = leaseForThisProcess(Date.now() - 10_000_000);
      assert.ok(lease);
      const claimed = claimActivity(
        state.activities ?? [],
        { id: "A:REVIEW:r1", kind: "REVIEW", roadmapKey: "A", lease, now: Date.now() },
        createProcLivenessProbe(),
      );
      assert.equal(claimed.ok, true);
      if (!claimed.ok) throw new Error("unreachable");
      const beat = reportProgress(claimed.activities, "A:REVIEW:r1", { at: Date.now() - 10_000_000, progress: 1 });
      assert.equal(beat.ok, true);
      if (!beat.ok) throw new Error("unreachable");
      await repository.compareAndSave(
        { ...state, version: state.version + 1, activities: beat.activities },
        state.version,
      );
    } finally {
      repository.close();
    }

    const { service, repository: second } = supervisorOver(path, { stallAfterMs: 1_000 });
    try {
      await service.tick();
    } finally {
      second.close();
    }

    const activities = await readActivities(path);
    assert.equal(activities[0]?.reconciliation?.verdict, "STALLED");
    // A stall is NOT a crash: the item stays where it is, because its owner is
    // still running and re-queueing would create a second one.
    const after = createSqliteSupervisorRepository(path);
    try {
      assert.equal((await after.load())?.roadmap.find((item) => item.key === "A")?.status, "ACTIVE");
    } finally {
      after.close();
    }
  });
});

// =====================================================================
// AC-17 — a transition interrupted before it is recorded
// =====================================================================

describe("TASK-018 AC-17: an interrupted transition is never half-applied", () => {
  /**
   * ROUND-1 REVIEW, HIGH 3 — "no interrupted-transition fixture exists".
   *
   * The criterion asks that a transition interrupted between its EFFECT and its
   * RECORD is replayable or detectably incomplete, never silently half-applied.
   * Here a real child computes a completion and is SIGKILLed before the write.
   *
   * The design makes the effect and the record the same single CAS write, which
   * is why there is nothing in between to be lost — but "by construction" is an
   * argument, and this is the measurement. What must be observable afterwards
   * is that the activity is exactly as the child found it, and that the
   * completion can still be applied by someone else.
   */
  it("a completion computed but never written leaves the activity untouched, and replayable", async () => {
    const path = await seed();
    const killed = runChild({
      path,
      id: "A:REVIEW:r1",
      kind: "REVIEW",
      roadmapKey: "A",
      progress: 2,
      ending: "interrupt",
    });
    assert.equal(killed.signal, "SIGKILL", `the child did not die as arranged: ${killed.stderr}`);

    const activities = await readActivities(path);
    assert.equal(activities.length, 1);
    const activity = activities[0]!;
    assert.equal(activity.state, "RUNNING", "an unwritten completion reached the database");
    assert.equal(activity.completion, undefined, "a half-applied completion is visible");
    assert.equal(activity.heartbeat?.progress, 2, "the progress the child DID record was lost");

    // REPLAYABLE: the same transition still applies cleanly afterwards.
    const replay = completeActivity(activities, "A:REVIEW:r1", {
      state: "COMPLETED",
      completion: { outcome: "PASS", detail: "applied by someone else", at: 9_000 },
    });
    assert.equal(replay.ok, true, replay.ok ? "" : replay.problem);
    if (!replay.ok) throw new Error("unreachable");
    assert.equal(replay.changed, true);
    assert.equal(replay.activities[0]?.state, "COMPLETED");
  });
});

// =====================================================================
// AC-19 — a lost notification changes nothing
// =====================================================================

describe("TASK-018 AC-19: a completion nobody was told about is still found", () => {
  it("is discoverable from the database by a process that was never notified", async () => {
    const path = await seed();
    const child = runChild({ path, id: "A:REVIEW:r1", kind: "REVIEW", roadmapKey: "A", progress: 1, ending: "complete" });
    assert.equal(child.status, 0, child.stderr);

    // No notification is delivered anywhere: this reads the record.
    const activities = await readActivities(path);
    const waiting = unobservedCompletions(activities);
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0]?.completion?.outcome, "PASS");

    // Once something acts on it, it stops being outstanding.
    const observed = observeCompletion(activities, "A:REVIEW:r1", 2_000);
    assert.equal(observed.ok, true);
    if (!observed.ok) throw new Error("unreachable");
    assert.deepEqual(unobservedCompletions(observed.activities), []);
  });

  it("a completed activity is never re-classified by reconciliation", async () => {
    const path = await seed();
    assert.equal(
      runChild({ path, id: "A:REVIEW:r1", kind: "REVIEW", roadmapKey: "A", ending: "complete" }).status,
      0,
    );
    const { service, repository } = supervisorOver(path);
    try {
      await service.tick();
    } finally {
      repository.close();
    }
    const activities = await readActivities(path);
    assert.equal(activities[0]?.state, "COMPLETED");
    assert.equal(activities[0]?.reconciliation, undefined, "a finished activity was reinterpreted");
  });
});

// =====================================================================
// AC-20 — recovery never crosses a human gate
// =====================================================================

describe("TASK-018 AC-20: recovery does not walk past a person", () => {
  const crashed: readonly Activity[] = [
    {
      id: "A:REVIEW:r1",
      kind: "REVIEW",
      roadmapKey: "A",
      state: "RUNNING",
      lease: { pid: 1, processStartedAt: 1, machine: MACHINE, boot: "any-boot", claimedAt: 1 },
      reconciliation: { verdict: "CRASHED", at: 2, detail: "owner gone" },
      updatedAt: 1,
    },
  ];

  it("RE-QUEUES an item whose owner crashed while it was ACTIVE — the positive control", () => {
    assert.deepEqual(crashedItemsToRequeue(crashed, [{ key: "A", status: "ACTIVE" }]), ["A"]);
  });

  for (const status of ["WAITING_FOR_HUMAN_REQUIRED", "BLOCKED", "DONE", "ELIGIBLE", "WAITING_FOR_RESOURCE"] as const) {
    it(`REFUSES to re-queue an item at ${status}`, () => {
      assert.deepEqual(
        crashedItemsToRequeue(crashed, [{ key: "A", status }]),
        [],
        `recovery moved an item at ${status}`,
      );
    });
  }

  /**
   * AC-20's actual requirement, and the one a mutation can reach.
   *
   * Recovery may move an item BACKWARDS into the queue it came from. Anything
   * further forward is recovery taking a decision — and `DONE` in particular
   * would make a crashed item's dependents eligible for work nothing did,
   * which is the forged-completion shape TASK-012 exists to refuse.
   */
  it("never advances an item: a crashed ACTIVE item goes back to PENDING and no further", async () => {
    /**
     * THE ITEM IS BLOCKED BEHIND AN UNFINISHED DEPENDENCY, deliberately.
     *
     * Recovery returns it to the queue and the SAME tick then carries it
     * onward, so a runnable item ends at whatever the executor produced — and
     * the first two drafts of this test asserted that instead, which is the
     * executor's business rather than recovery's. With `Z` not DONE, `A` can
     * never be promoted past PENDING, so the status observed afterwards is
     * exactly what recovery wrote and nothing else.
     */
    const gated: readonly RoadmapItem[] = [
      { key: "Z", title: "Blocker", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
      { key: "A", title: "Work", dependsOn: ["Z"], status: "ACTIVE", workClass: "NORMAL_IMPLEMENTATION", order: 2 },
    ];
    const path = await seed(gated);
    assert.equal(
      runChild({ path, id: "A:REVIEW:r1", kind: "REVIEW", roadmapKey: "A", progress: 1, ending: "die" }).signal,
      "SIGKILL",
    );

    const repository = createSqliteSupervisorRepository(path);
    const now = Date.now();
    try {
      await new SupervisorService({
        repository,
        roadmapCatalog: [...gated],
        probe: scriptedProbe(),
        executor: scriptedExecutor(),
        clock: { now: () => now },
        ids: createSequentialIdGenerator(),
        routingPolicy: DEFAULT_ROUTING_POLICY,
        resourceCatalog: TEST_CATALOG,
        liveness: createProcLivenessProbe(),
        log: () => {},
      }).tick();
    } finally {
      repository.close();
    }

    const after = createSqliteSupervisorRepository(path);
    try {
      const state = await after.load();
      const status = state?.roadmap.find((item) => item.key === "A")?.status;
      /**
       * BACK IN THE QUEUE, which is `PENDING` or the `ELIGIBLE` the same tick
       * promotes it to. Pinning one spelling would be asserting where the
       * eligibility pass happens to leave it; what AC-20 requires is that
       * recovery moved it BACKWARDS and never forwards.
       */
      assert.ok(
        status === "PENDING" || status === "ELIGIBLE",
        `expected the item back in the queue, found ${status}`,
      );
      assert.notEqual(status, "DONE", "recovery marked a crashed item complete");
      assert.notEqual(status, "ACTIVE", "the item was left in its dead owner's state");
      assert.equal(state?.activities?.[0]?.reconciliation?.verdict, "CRASHED");
    } finally {
      after.close();
    }
  });

  it("re-queues nothing for an activity that did not crash", () => {
    for (const verdict of ["LIVE", "STALLED", "AMBIGUOUS", "NEVER_STARTED"] as const) {
      const other = crashed.map((entry) => ({
        ...entry,
        reconciliation: { verdict, at: 2, detail: "x" },
      }));
      assert.deepEqual(crashedItemsToRequeue(other, [{ key: "A", status: "ACTIVE" }]), [], verdict);
    }
  });

  it("does not re-queue an item the crashed owner was not working on", () => {
    assert.deepEqual(crashedItemsToRequeue(crashed, [{ key: "A", status: "PENDING" }]), []);
    assert.deepEqual(crashedItemsToRequeue(crashed, [{ key: "B", status: "ACTIVE" }]), []);
  });

  it("a crash does NOT move a human-gated item, end to end through a real tick", async () => {
    const gated: readonly RoadmapItem[] = [
      {
        key: "A",
        title: "Work",
        dependsOn: [],
        status: "WAITING_FOR_HUMAN_REQUIRED",
        workClass: "NORMAL_IMPLEMENTATION",
        order: 1,
        humanActionRequired: "a person must decide",
      },
      ROADMAP[1]!,
    ];
    const path = await seed(gated);
    assert.equal(
      runChild({ path, id: "A:REVIEW:r1", kind: "REVIEW", roadmapKey: "A", progress: 1, ending: "die" }).signal,
      "SIGKILL",
    );

    const repository = createSqliteSupervisorRepository(path);
    const clock = manualClock();
    const probe = scriptedProbe();
    for (const entry of TEST_CATALOG) {
      probe.set(entry.provider, entry.model, { state: "AVAILABLE", reason: "scripted", billingMode: "INCLUDED_SUBSCRIPTION" });
    }
    try {
      await new SupervisorService({
        repository,
        roadmapCatalog: [...gated],
        probe,
        executor: scriptedExecutor(),
        clock: { now: () => clock.now() },
        ids: createSequentialIdGenerator(),
        routingPolicy: DEFAULT_ROUTING_POLICY,
        resourceCatalog: TEST_CATALOG,
        liveness: createProcLivenessProbe(),
        log: () => {},
      }).tick();
    } finally {
      repository.close();
    }

    const after = createSqliteSupervisorRepository(path);
    try {
      const state = await after.load();
      assert.equal(
        state?.roadmap.find((item) => item.key === "A")?.status,
        "WAITING_FOR_HUMAN_REQUIRED",
        "recovery walked past a human gate",
      );
      // The crash was still RECORDED: knowledge is restored, authority is not.
      assert.equal(state?.activities?.[0]?.reconciliation?.verdict, "CRASHED");
    } finally {
      after.close();
    }
  });
});
