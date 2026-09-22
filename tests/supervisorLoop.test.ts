/**
 * TASK-019 — the supervisor as a process that owns the Factory.
 *
 * WHAT THESE PROVE, and why they are not the TASK-018 tests again. TASK-018
 * proved that a verdict already on disk is consumed correctly by a cold
 * supervisor. It did not, and could not, prove that anything RUNS: three of its
 * own acceptance rounds ended with a correct verdict sitting unread for twenty
 * hours because the only thing that launched reviewers was a shell script whose
 * lifetime was a terminal session.
 *
 * So these tests are about ownership and about the launch handshake: who is
 * allowed to decide, what happens when that process dies, and what counts as
 * evidence that a worker exists. Everything is asserted against durable state
 * read back through a fresh repository.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createCodexReviewLauncher } from "../src/adapters/supervision/codexReviewLauncher.js";
import { createSqliteSupervisorRepository } from "../src/adapters/supervision/sqliteSupervisorRepository.js";
import { bootIdentity, machineIdentity } from "../src/adapters/supervision/procLiveness.js";
import { createSequentialIdGenerator } from "../src/domain/ids.js";
import type { ActivityLease, Liveness } from "../src/supervision/activity.js";
import { anchorFor } from "../src/supervision/provenanceChain.js";
import { DEFAULT_ROUTING_POLICY } from "../src/supervision/modelRouting.js";
import { acquireSupervisorLease } from "../src/supervision/supervisorLease.js";
import { runSupervisorLoop, type LoopDeps } from "../src/supervision/supervisorLoop.js";
import type { LaunchAcknowledgement } from "../src/supervision/acceptance.js";
import type { ReviewLauncher, ReviewLaunchRequest } from "../src/supervision/supervisorPorts.js";
import { SupervisorService } from "../src/supervision/supervisorService.js";
import type { ReviewRequest, RoadmapItem, SupervisorState } from "../src/supervision/supervisorTypes.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import { scriptedProbe, TEST_CATALOG } from "./support/supervisorFixtures.js";

const scratch = mkdtempSync(join(tmpdir(), "sf-loop-"));

after(() => {
  cleanupTempDbs();
});

const ROADMAP: readonly RoadmapItem[] = [
  { key: "A", title: "Work", dependsOn: [], status: "ACTIVE", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
];

const CANDIDATE = { commit: "abc1234", tree: "def5678", fingerprint: "0123456789ab" } as const;

function lease(pid: number, startedAt = 1_000, machine = "test-machine", boot = "boot-a"): ActivityLease {
  return { pid, processStartedAt: startedAt, machine, boot, claimedAt: 500 };
}

function request(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    roadmapKey: "A",
    candidate: { ...CANDIDATE },
    attempt: 1,
    requestedAt: 1_000,
    provider: "codex-cli",
    model: "gpt-5.6-luna",
    effort: "xhigh",
    ...overrides,
  };
}

function baseState(overrides: Partial<SupervisorState> = {}): SupervisorState {
  return {
    version: 1,
    financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
    resources: [],
    roadmap: ROADMAP,
    checkpoints: [],
    escalations: [],
    provenance: [],
    provenanceAnchor: anchorFor([]),
    updatedAt: 1_000,
    ...overrides,
  };
}

async function seed(overrides: Partial<SupervisorState> = {}): Promise<string> {
  const path = tempDbPath();
  const repository = createSqliteSupervisorRepository(path);
  try {
    await repository.create(baseState(overrides));
  } finally {
    repository.close();
  }
  return path;
}

async function durable(path: string): Promise<SupervisorState> {
  const repository = createSqliteSupervisorRepository(path);
  try {
    const state = await repository.load();
    assert.ok(state, "durable state disappeared");
    return state;
  } finally {
    repository.close();
  }
}

// =====================================================================
// AC-17 — exactly one owner
// =====================================================================

describe("TASK-019 AC-17: exactly one supervisor owns a Factory", () => {
  const alive: { check: (l: ActivityLease) => Liveness } = { check: () => "ALIVE" };
  const gone: { check: (l: ActivityLease) => Liveness } = { check: () => "GONE" };
  const unknowable: { check: (l: ActivityLease) => Liveness } = { check: () => "UNKNOWN" };

  it("takes a free lease", () => {
    const verdict = acquireSupervisorLease(undefined, { lease: lease(11), ownerId: "first", now: 10 }, gone);
    assert.equal(verdict.ok, true);
    if (!verdict.ok) throw new Error("unreachable");
    assert.equal(verdict.changed, true);
    assert.equal(verdict.owner.lease.pid, 11);
  });

  it("STANDS DOWN when the holder is still running, and names it", () => {
    const held = { lease: lease(11), ownerId: "first", acquiredAt: 10, renewedAt: 20 };
    const verdict = acquireSupervisorLease(held, { lease: lease(22), ownerId: "second", now: 30 }, alive);
    assert.equal(verdict.ok, false);
    if (verdict.ok) throw new Error("unreachable");
    assert.match(verdict.problem, /pid 11/);
    assert.match(verdict.problem, /standing down/);
  });

  /** Unknown refuses, here as everywhere else in this mechanism. */
  it("REFUSES to take over a lease whose holder cannot be checked", () => {
    const held = { lease: lease(11, 1_000, "another-machine"), ownerId: "first", acquiredAt: 10, renewedAt: 20 };
    const verdict = acquireSupervisorLease(held, { lease: lease(22), ownerId: "second", now: 30 }, unknowable);
    assert.equal(verdict.ok, false);
    if (verdict.ok) throw new Error("unreachable");
    assert.match(verdict.problem, /cannot be established/);
  });

  it("takes over a lease whose holder is gone", () => {
    const held = { lease: lease(11), ownerId: "first", acquiredAt: 10, renewedAt: 20 };
    const verdict = acquireSupervisorLease(held, { lease: lease(22), ownerId: "second", now: 30 }, gone);
    assert.equal(verdict.ok, true);
    if (!verdict.ok) throw new Error("unreachable");
    assert.equal(verdict.owner.lease.pid, 22);
    assert.equal(verdict.owner.acquiredAt, 30);
  });

  /**
   * A RESTARTED PROCESS MUST NOT INHERIT THE DEAD ONE'S IDENTITY. Compared by
   * the lease rather than by `ownerId`, because an owner name is a label a new
   * process can legitimately reuse.
   */
  it("treats the same owner NAME with a different lease as a different process", () => {
    const held = { lease: lease(11), ownerId: "sf-supervisor", acquiredAt: 10, renewedAt: 20 };
    const verdict = acquireSupervisorLease(held, { lease: lease(12), ownerId: "sf-supervisor", now: 30 }, alive);
    assert.equal(verdict.ok, false, "a restarted process inherited a live lease by name");
  });

  it("renews its OWN lease without taking it again", () => {
    const held = { lease: lease(11), ownerId: "first", acquiredAt: 10, renewedAt: 20 };
    const verdict = acquireSupervisorLease(held, { lease: lease(11), ownerId: "first", now: 40 }, alive);
    assert.equal(verdict.ok, true);
    if (!verdict.ok) throw new Error("unreachable");
    assert.equal(verdict.owner.acquiredAt, 10, "a renewal reset the acquisition time");
    assert.equal(verdict.owner.renewedAt, 40);
  });
});

// =====================================================================
// AC-9, AC-18 — the loop, and its disposability
// =====================================================================

describe("TASK-019 AC-9/AC-18: the loop owns the Factory and is disposable", () => {
  function loopDeps(
    path: string,
    overrides: Partial<LoopDeps> & { readonly tick: () => Promise<unknown> },
  ): { readonly deps: LoopDeps; close(): void } {
    const repository = createSqliteSupervisorRepository(path);
    let now = 1_000;
    const deps: LoopDeps = {
      repository,
      service: { tick: overrides.tick },
      clock: { now: () => (now += 1_000) },
      sleep: async () => {},
      liveness: { check: () => "ALIVE" },
      lease: (at) => ({ ...lease(4_242), claimedAt: at }),
      ownerId: "test-supervisor",
      intervalMs: 1,
      log: () => {},
      ...overrides,
    };
    return { deps, close: () => repository.close() };
  }

  it("ticks, records itself as the owner, and releases on a clean stop", async () => {
    const path = await seed();
    let ticks = 0;
    const { deps, close } = loopDeps(path, { tick: async () => void (ticks += 1), maxTicks: 3 });
    let outcome;
    try {
      outcome = await runSupervisorLoop(deps, () => false);
    } finally {
      close();
    }

    assert.equal(outcome.kind, "STOPPED");
    assert.equal(ticks, 3);
    assert.equal((await durable(path)).supervisor, undefined, "a clean stop left the lease behind");
  });

  /**
   * A TICK THAT THROWS MUST NOT END THE SUPERVISOR. Every refusal this Factory
   * produces comes back as a RESULT, so an exception means something
   * unforeseen — and the response to unforeseen is to look again shortly, not
   * to exit and leave nothing running, which is the failure this task exists to
   * remove.
   */
  it("survives a tick that throws, and keeps ticking", async () => {
    const path = await seed();
    let ticks = 0;
    const { deps, close } = loopDeps(path, {
      maxTicks: 3,
      tick: async () => {
        ticks += 1;
        if (ticks === 1) throw new Error("something unforeseen");
      },
    });
    let outcome;
    try {
      outcome = await runSupervisorLoop(deps, () => false);
    } finally {
      close();
    }
    assert.equal(outcome.kind, "STOPPED");
    assert.equal(ticks, 3, "a thrown tick stopped the supervisor");
  });

  it("STANDS DOWN rather than racing a live supervisor", async () => {
    const path = await seed({
      supervisor: { lease: lease(9_999), ownerId: "the-incumbent", acquiredAt: 10, renewedAt: 20 },
    });
    let ticks = 0;
    const { deps, close } = loopDeps(path, { tick: async () => void (ticks += 1), maxTicks: 3 });
    let outcome;
    try {
      outcome = await runSupervisorLoop(deps, () => false);
    } finally {
      close();
    }

    assert.equal(outcome.kind, "STOOD_DOWN");
    assert.equal(ticks, 0, "a second supervisor ticked while another held the lease");
    assert.equal((await durable(path)).supervisor?.ownerId, "the-incumbent", "the incumbent's lease was taken");
  });

  it("REFUSES to supervise when it cannot establish its own identity", async () => {
    const path = await seed();
    const { deps, close } = loopDeps(path, { tick: async () => {}, lease: () => undefined });
    let outcome;
    try {
      outcome = await runSupervisorLoop(deps, () => false);
    } finally {
      close();
    }
    assert.equal(outcome.kind, "REFUSED");
  });

  it("stops when asked, between ticks", async () => {
    const path = await seed();
    let ticks = 0;
    let stop = false;
    const { deps, close } = loopDeps(path, {
      tick: async () => {
        ticks += 1;
        stop = true;
      },
    });
    try {
      await runSupervisorLoop(deps, () => stop);
    } finally {
      close();
    }
    assert.equal(ticks, 1);
  });
});

// =====================================================================
// AC-2, AC-4, AC-5, AC-6 — the launch handshake
// =====================================================================

describe("TASK-019 AC-2/AC-4: the supervisor owns the review it launches", () => {
  const SUPERVISOR_PID = 777_001;
  const WORKER_PID = 777_002;

  function recordingLauncher(options: {
    readonly ack?: (request: ReviewLaunchRequest) => LaunchAcknowledgement | undefined;
    readonly fail?: string;
    readonly exhausted?: boolean;
  } = {}): ReviewLauncher & { readonly launches: ReviewLaunchRequest[] } {
    const launches: ReviewLaunchRequest[] = [];
    let started = false;
    return {
      launches,
      launch: async (req) => {
        launches.push(req);
        if (options.fail !== undefined) {
          return { ok: false, problem: options.fail, ...(options.exhausted === true ? { exhausted: true } : {}) };
        }
        started = true;
        return { ok: true, detail: "spawned" };
      },
      /**
       * NOTHING ACKNOWLEDGES A LAUNCH THAT DID NOT HAPPEN. The acknowledgement
       * is written by the worker, so a fake that produces one without a
       * successful launch models a world that cannot exist — and it hid a
       * correct refusal to relaunch behind an apparent failure to relaunch.
       */
      acknowledgement: (req) => (started ? options.ack?.(req) : undefined),
    };
  }

  function supervisorOver(
    path: string,
    launcher: ReviewLauncher | undefined,
    options: { readonly startedAt?: number; readonly pid?: number; readonly deadPids?: readonly number[] } = {},
  ) {
    const self = options.pid ?? SUPERVISOR_PID;
    const dead = new Set(options.deadPids ?? []);
    const repository = createSqliteSupervisorRepository(path);
    const probe = scriptedProbe();
    for (const entry of TEST_CATALOG) {
      probe.set(entry.provider, entry.model, {
        state: "AVAILABLE",
        reason: "scripted",
        billingMode: "INCLUDED_SUBSCRIPTION",
      });
    }
    let reading = 0;
    const base = options.startedAt ?? 10_000;
    const service = new SupervisorService({
      repository,
      roadmapCatalog: [...ROADMAP],
      probe,
      executor: { execute: async () => ({ kind: "COMPLETED", detail: "ran" }) },
      clock: { now: () => base + reading++ * 1_000 },
      ids: createSequentialIdGenerator(),
      routingPolicy: DEFAULT_ROUTING_POLICY,
      resourceCatalog: TEST_CATALOG,
      liveness: {
        check: (l) => (dead.has(l.pid) ? "GONE" : l.pid === self || l.pid === WORKER_PID ? "ALIVE" : "GONE"),
      },
      activityLease: (at) => ({ ...lease(self), claimedAt: at }),
      ...(launcher === undefined ? {} : { reviewLauncher: launcher }),
      log: () => {},
    });
    return { service, close: () => repository.close() };
  }

  /**
   * THE RECORD PRECEDES THE PROCESS. This is the whole of AC-2: a review the
   * supervisor cannot find afterwards is a review the Factory cannot recover,
   * and "afterwards" includes "after this process dies mid-launch".
   */
  it("commits the review record BEFORE anything is spawned", async () => {
    const path = await seed({ reviewRequests: [request()] });
    const seen: SupervisorState[] = [];
    const launcher = recordingLauncher();
    const spy: ReviewLauncher = {
      launch: async (req) => {
        seen.push(await durable(path));
        return launcher.launch(req);
      },
      acknowledgement: () => undefined,
    };

    const { service, close } = supervisorOver(path, spy);
    try {
      await service.tick();
    } finally {
      close();
    }

    assert.equal(seen.length, 1, "nothing was launched");
    const atLaunch = seen[0]!;
    const review = (atLaunch.activities ?? [])[0];
    assert.ok(review, "the review was spawned before its record existed");
    assert.equal(review.id, "A:REVIEW:r1");
    assert.equal(review.state, "CLAIMED", "the record said RUNNING before the worker proved anything");
    assert.equal(review.review?.model, "gpt-5.6-luna");
    assert.equal(review.review?.effort, "xhigh");
    assert.equal(review.review?.provider, "codex-cli");
    assert.equal(review.review?.attempt, 1);
    assert.deepEqual(review.review?.candidate, { ...CANDIDATE });
    assert.ok(review.review?.ack, "no acknowledgement path was recorded");
    assert.ok(review.review?.source, "no verdict location was recorded");
  });

  it("stays CLAIMED until the worker proves it exists", async () => {
    const path = await seed({ reviewRequests: [request()] });
    const { service, close } = supervisorOver(path, recordingLauncher());
    try {
      await service.tick();
      await service.tick();
    } finally {
      close();
    }
    const review = (await durable(path)).activities?.[0];
    assert.equal(review?.state, "CLAIMED", "a spawn call was treated as evidence of a running reviewer");
  });

  it("adopts the worker when it acknowledges, and takes ITS lease", async () => {
    const path = await seed({ reviewRequests: [request()] });
    const ack: LaunchAcknowledgement = {
      runId: "A:REVIEW:r1",
      pid: WORKER_PID,
      processStartedAt: 9_999,
      machine: "test-machine",
      boot: "boot-a",
      at: 12_000,
    };
    const { service, close } = supervisorOver(path, recordingLauncher({ ack: () => ack }));
    try {
      // The launch happens first; adoption is a SEPARATE observation, because an
      // acknowledgement that exists before the record does not belong to it.
      await service.tick();
      await service.tick();
    } finally {
      close();
    }

    const review = (await durable(path)).activities?.[0];
    assert.equal(review?.state, "RUNNING");
    assert.equal(review?.lease?.pid, WORKER_PID, "the supervisor's own lease was left on a running reviewer");
    assert.equal(review?.lease?.processStartedAt, 9_999);
  });

  /**
   * AC-6. A recycled pid is the classic way a dead worker reads as alive; the
   * proof is the RUN ID, which predates the worker and cannot be inherited.
   */
  it("REFUSES an acknowledgement that names a different run", async () => {
    const path = await seed({ reviewRequests: [request()] });
    const stranger: LaunchAcknowledgement = {
      runId: "SOMETHING:REVIEW:r9",
      pid: WORKER_PID,
      processStartedAt: 9_999,
      machine: "test-machine",
      boot: "boot-a",
      at: 12_000,
    };
    const { service, close } = supervisorOver(path, recordingLauncher({ ack: () => stranger }));
    let result;
    try {
      await service.tick();
      result = await service.tick();
    } finally {
      close();
    }

    assert.match(JSON.stringify(result), /acknowledgement names/, JSON.stringify(result));
    const review = (await durable(path)).activities?.[0];
    assert.equal(review?.state, "CLAIMED", "an unrelated process was adopted as the reviewer");
  });

  it("does not launch a second reviewer for a review it already recorded", async () => {
    const path = await seed({ reviewRequests: [request()] });
    const launcher = recordingLauncher();
    const { service, close } = supervisorOver(path, launcher);
    try {
      await service.tick();
      await service.tick();
      await service.tick();
    } finally {
      close();
    }
    assert.equal(launcher.launches.length, 1, `launched ${launcher.launches.length} reviewers for one request`);
  });

  /**
   * A SUPERVISOR THAT DIED MID-LAUNCH leaves a record with no acknowledgement.
   * A fresh one must be able to try again — that is the retryable arm of AC-5 —
   * and it must not conclude that a reviewer is running.
   */
  it("retries a launch the previous supervisor may never have completed", async () => {
    const path = await seed({ reviewRequests: [request()] });
    const first = recordingLauncher({ fail: "the machine was rebooted mid-spawn" });
    const one = supervisorOver(path, first);
    try {
      await one.service.tick();
    } finally {
      one.close();
    }
    assert.equal((await durable(path)).activities?.[0]?.state, "CLAIMED");

    // A different process, later, with a working launcher.
    const second = recordingLauncher({
      ack: () => ({
        runId: "A:REVIEW:r1",
        pid: WORKER_PID,
        processStartedAt: 5_555,
        machine: "test-machine",
        boot: "boot-a",
        at: 30_000,
      }),
    });
    /**
     * A DIFFERENT PROCESS, and the first one is gone — which is what makes the
     * relaunch safe. Were the first still alive, a reviewer might be about to
     * acknowledge, and starting a second would be the duplicate AC-16 forbids.
     */
    const two = supervisorOver(path, second, {
      startedAt: 30_000,
      pid: SUPERVISOR_PID + 50,
      deadPids: [SUPERVISOR_PID],
    });
    const results: unknown[] = [];
    try {
      results.push(await two.service.tick());
      results.push(await two.service.tick());
    } finally {
      two.close();
    }

    assert.equal(second.launches.length, 1, `the retry did not happen: ${JSON.stringify(results)}`);
    assert.equal((await durable(path)).activities?.[0]?.state, "RUNNING");
  });

  it("REFUSES to decide anything when a review is requested and nothing can launch one", async () => {
    const path = await seed({ reviewRequests: [request()] });
    const { service, close } = supervisorOver(path, undefined);
    let result;
    try {
      result = await service.tick();
    } finally {
      close();
    }
    assert.match(JSON.stringify(result), /no way to launch one/, JSON.stringify(result));
    // ...and it recorded nothing: a refusal before any launch leaves no review.
    assert.deepEqual((await durable(path)).activities ?? [], []);
  });
});

// =====================================================================
// A REAL process, writing a real acknowledgement
// =====================================================================

describe("TASK-019 AC-4: a real worker proves its own existence", () => {
  it("writes an acknowledgement naming its run, its pid and its start tick", async () => {
    const dir = mkdtempSync(join(scratch, "real-"));
    const plan: ReviewLaunchRequest = {
      reviewId: "A:REVIEW:r1",
      roadmapKey: "A",
      activityId: "A:REVIEW:r1",
      provider: "codex-cli",
      model: "gpt-5.6-luna",
      effort: "xhigh",
      candidate: { ...CANDIDATE },
      source: join(dir, "verdict.txt"),
      ack: join(dir, "ack.json"),
    };

    const launcher = createCodexReviewLauncher({
      packet: () => "this packet is never read by the stand-in",
      repository: dir,
      // A stand-in for the reviewer: the acknowledgement is written by the
      // wrapper BEFORE this runs, which is exactly what is being checked.
      command: () => ["true"],
    });

    const started = await launcher.launch(plan);
    assert.equal(started.ok, true, JSON.stringify(started));

    // The wrapper is detached; wait for the file it writes first.
    const deadline = Date.now() + 10_000;
    while (!existsSync(plan.ack) && Date.now() < deadline) {
      execFileSync("sleep", ["0.05"]);
    }

    const ack = launcher.acknowledgement(plan);
    assert.ok(ack, `no acknowledgement was written: ${readFileSync(`${plan.source}.run.log`, "utf8").slice(0, 200)}`);
    assert.equal(ack.runId, "A:REVIEW:r1");
    assert.ok(ack.pid > 0, "the acknowledgement names no process");
    assert.ok(ack.processStartedAt > 0, "the acknowledgement carries no start tick, so a reused pid would match");
    assert.equal(ack.machine, machineIdentity());
    assert.equal(ack.boot, bootIdentity());
  });

  it("reports a half-written acknowledgement as no proof at all", () => {
    const dir = mkdtempSync(join(scratch, "torn-"));
    const plan: ReviewLaunchRequest = {
      reviewId: "A:REVIEW:r1",
      roadmapKey: "A",
      activityId: "A:REVIEW:r1",
      provider: "codex-cli",
      model: "gpt-5.6-luna",
      effort: "xhigh",
      candidate: { ...CANDIDATE },
      source: join(dir, "verdict.txt"),
      ack: join(dir, "ack.json"),
    };
    writeFileSync(plan.ack, '{"runId":"A:REVIEW:r1","pid":12', "utf8");
    const launcher = createCodexReviewLauncher({ packet: () => "", repository: dir, command: () => ["true"] });
    assert.equal(launcher.acknowledgement(plan), undefined);
  });
});
