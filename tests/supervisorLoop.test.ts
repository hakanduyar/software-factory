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
import type { AcceptanceVerdictSource, LaunchAcknowledgement } from "../src/supervision/acceptance.js";
import type { ReviewCompletionReading, ReviewLauncher, ReviewLaunchRequest } from "../src/supervision/supervisorPorts.js";
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

const SUPERVISOR_PID = 777_001;
const WORKER_PID = 777_002;

/**
 * Lifted out of the AC-2/AC-4 describe block (SF-R3 round 2) so the cold
 * failed-completion proofs below can reuse the exact same launcher and
 * service fixtures rather than inventing parallel ones.
 */
function recordingLauncher(options: {
    readonly ack?: (request: ReviewLaunchRequest) => LaunchAcknowledgement | undefined;
    readonly fail?: string;
    readonly exhausted?: boolean;
    /** What the finished process published about itself, if it finished. */
    readonly completion?: () => ReviewCompletionReading;
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
      /**
       * ...and nothing completes a launch that did not happen either. A cold
       * supervisor reading a completion for a run it never started is the
       * foreign case, which the real adapter refuses by run id.
       */
      completion: () => (started ? options.completion?.() ?? { kind: "NONE" } : { kind: "NONE" }),
    };
}

function supervisorOver(
    path: string,
    launcher: ReviewLauncher | undefined,
    options: {
      readonly startedAt?: number;
      readonly pid?: number;
      readonly deadPids?: readonly number[];
      /** Narrowed so "no other resource is usable" can be stated deliberately. */
      readonly resourceCatalog?: typeof TEST_CATALOG;
      /**
       * Only where a test must read a verdict back at all (SF-R3 round 2):
       * `consumeAcceptanceVerdicts` treats an absent source as "unreachable"
       * and never reaches `settleFailedReviewFromCompletion`, so the cold
       * failed-completion proofs supply one that reports no verdict was ever
       * published — true for every completion these tests construct.
       */
      readonly acceptanceVerdicts?: AcceptanceVerdictSource;
      /** Lets a test move the clock past a recorded `retryAt` deliberately. */
      readonly now?: () => number;
    } = {},
  ) {
    const self = options.pid ?? SUPERVISOR_PID;
    const dead = new Set(options.deadPids ?? []);
    const repository = createSqliteSupervisorRepository(path);
    const catalog = options.resourceCatalog ?? TEST_CATALOG;
    const probe = scriptedProbe();
    for (const entry of catalog) {
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
      clock: { now: options.now ?? (() => base + reading++ * 1_000) },
      ids: createSequentialIdGenerator(),
      routingPolicy: DEFAULT_ROUTING_POLICY,
      resourceCatalog: catalog,
      liveness: {
        check: (l) => (dead.has(l.pid) ? "GONE" : l.pid === self || l.pid === WORKER_PID ? "ALIVE" : "GONE"),
      },
      activityLease: (at) => ({ ...lease(self), claimedAt: at }),
      ...(launcher === undefined ? {} : { reviewLauncher: launcher }),
      ...(options.acceptanceVerdicts === undefined ? {} : { acceptanceVerdicts: options.acceptanceVerdicts }),
      log: () => {},
    });
    return { service, close: () => repository.close(), probe };
}

describe("TASK-019 AC-2/AC-4: the supervisor owns the review it launches", () => {
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
      completion: () => ({ kind: "NONE" }),
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

  it("refuses a duplicate when the parent died before ACK, then adopts a late ACK", async () => {
    const path = await seed({ reviewRequests: [request()] });
    const first = recordingLauncher();
    const one = supervisorOver(path, first);
    try { await one.service.tick(); } finally { one.close(); }
    assert.equal(first.launches.length, 1);
    let lateAck: LaunchAcknowledgement | undefined;
    let duplicateLaunches = 0;
    const second: ReviewLauncher = {
      launch: async () => { duplicateLaunches++; return { ok: true, detail: "duplicate" }; },
      acknowledgement: () => lateAck,
      completion: () => ({ kind: "NONE" }),
    };
    const two = supervisorOver(path, second, {
      startedAt: 30_000, pid: SUPERVISOR_PID + 50, deadPids: [SUPERVISOR_PID],
    });
    try {
      const result = await two.service.tick();
      assert.match(JSON.stringify(result), /automatic relaunch is refused/);
      const waiting = (await durable(path)).activities?.[0];
      assert.equal(waiting?.state, "CLAIMED");
      assert.equal(waiting?.reconciliation?.verdict, "AMBIGUOUS");
      assert.equal(duplicateLaunches, 0);
      // A detached worker can outlive its parent and only now finish startup.
      lateAck = { runId: "A:REVIEW:r1", pid: WORKER_PID, processStartedAt: 5_555,
        machine: "test-machine", boot: "boot-a", at: 40_000 };
      await two.service.tick();
      const adopted = (await durable(path)).activities?.[0];
      assert.equal(adopted?.state, "RUNNING");
      assert.equal(adopted?.lease?.pid, WORKER_PID);
      assert.equal(duplicateLaunches, 0);
    } finally { two.close(); }
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
// TASK-019 AC-14/15/16/18/20 — cold reconciliation of a finished-badly review
// (SF-R3 correction round 2, review items 2 and 3)
// =====================================================================

describe("TASK-019 AC-14/15/16/18/20: cold reconciliation of a review that finished badly", () => {
  /**
   * `consumeAcceptanceVerdicts` treats a missing `acceptanceVerdicts` source
   * as "unreachable" and marks every in-flight review AMBIGUOUS before it ever
   * asks the launcher for a completion — never wrong for these tests, since
   * none of them publish a verdict, but it would hide the very path under
   * test. This reports exactly that: no verdict was ever read.
   */
  const NO_VERDICT_SOURCE: AcceptanceVerdictSource = { read: () => ({ kind: "ABSENT" }) };
  const RESOURCE_KEY = "codex-cli:gpt-5.6-luna";
  /**
   * Narrowed to the ONE resource under test. `promoteWaitingItems` re-arms
   * every `WAITING_FOR_RESOURCE` item the instant ANY catalogued resource is
   * usable, which — with the full `TEST_CATALOG` — reopened roadmap item "A"
   * for a brand new IMPLEMENTATION attempt inside the very same settling
   * tick, an unrelated mechanism this proof must not exercise.
   */
  const SINGLE_RESOURCE_CATALOG = TEST_CATALOG.filter((entry) => entry.provider === "codex-cli");

  /** Launches and ACK-adopts a review, with nothing published about it yet. */
  async function adopted(path: string): Promise<void> {
    const ack: LaunchAcknowledgement = {
      runId: "A:REVIEW:r1", pid: WORKER_PID, processStartedAt: 9_999,
      machine: "test-machine", boot: "boot-a", at: 12_000,
    };
    const { service, close } = supervisorOver(path, recordingLauncher({ ack: () => ack }), {
      acceptanceVerdicts: NO_VERDICT_SOURCE,
    });
    try {
      await service.tick();
      await service.tick();
    } finally {
      close();
    }
    const review = (await durable(path)).activities?.[0];
    assert.equal(review?.state, "RUNNING", "setup: the review was not adopted before its completion was supplied");
  }

  it("settles an unverified quota-like completion as UNKNOWN_FAILURE, WAITING_FOR_RESOURCE, backoff attempt 1", async () => {
    const path = await seed({ reviewRequests: [request()] });
    await adopted(path);

    // A COLD tick: a fresh service and repository handle over the same
    // database, matching a supervisor restart that only just learned the
    // worker finished. `launch` throws: nothing here may relaunch.
    const launcher: ReviewLauncher = {
      launch: async () => { throw new Error("a finished-badly review must not be relaunched in the same pass"); },
      acknowledgement: () => undefined,
      completion: () => ({
        kind: "COMPLETED",
        evidence: {
          runId: "A:REVIEW:r1",
          exitCode: 1,
          // PROVISIONAL signatures are untrusted by default (resourceClassifier.ts):
          // this must NOT classify as USAGE_LIMIT_REACHED.
          failure: "You have exceeded your usage limit for this billing period",
          verdictPublished: false,
          at: 20_000,
        },
      }),
    };
    const { service, close } = supervisorOver(path, launcher, {
      startedAt: 20_000, pid: SUPERVISOR_PID + 90, acceptanceVerdicts: NO_VERDICT_SOURCE,
      resourceCatalog: SINGLE_RESOURCE_CATALOG,
    });
    try {
      await service.tick();
    } finally {
      close();
    }

    const state = await durable(path);
    const activity = state.activities?.[0];
    assert.equal(activity?.state, "FAILED");
    assert.equal(activity?.completion?.outcome, "NO_VERDICT");
    assert.match(activity?.completion?.detail ?? "", /UNKNOWN_FAILURE/);

    const resource = state.resources.find((r) => r.key === RESOURCE_KEY);
    assert.equal(resource?.state, "UNKNOWN_FAILURE", "an unverified quota signature was believed");
    assert.equal(resource?.backoff.attempt, 1);
    assert.equal(resource?.retryAt, (resource?.lastCheckedAt ?? 0) + 300_000, "attempt 1 did not use the first backoff rung");
    assert.ok((resource?.diagnostic?.length ?? 0) > 0 && (resource?.diagnostic?.length ?? 0) <= 300, "the diagnostic is not bounded");

    assert.equal(state.roadmap[0]?.status, "WAITING_FOR_RESOURCE");
  });

  it("does not relaunch before its local retry is due", async () => {
    const path = await seed({ reviewRequests: [request()] });
    await adopted(path);
    const settle: ReviewLauncher = {
      launch: async () => { throw new Error("must not relaunch while settling"); },
      acknowledgement: () => undefined,
      completion: () => ({
        kind: "COMPLETED",
        evidence: { runId: "A:REVIEW:r1", exitCode: 1, failure: "unrecognised failure text", verdictPublished: false, at: 20_000 },
      }),
    };
    const first = supervisorOver(path, settle, {
      startedAt: 20_000, pid: SUPERVISOR_PID + 91, acceptanceVerdicts: NO_VERDICT_SOURCE, resourceCatalog: SINGLE_RESOURCE_CATALOG,
    });
    try { await first.service.tick(); } finally { first.close(); }
    const retryAt = (await durable(path)).resources.find((r) => r.key === RESOURCE_KEY)?.retryAt;
    assert.ok(typeof retryAt === "number", "setup: no local retry was scheduled");

    const launcher: ReviewLauncher = {
      launch: async () => { throw new Error("relaunched before the local retry was due"); },
      acknowledgement: () => undefined,
      completion: () => ({ kind: "NONE" }),
    };
    const early = supervisorOver(path, launcher, {
      now: () => retryAt! - 1_000, acceptanceVerdicts: NO_VERDICT_SOURCE, pid: SUPERVISOR_PID + 92,
      resourceCatalog: SINGLE_RESOURCE_CATALOG,
    });
    try {
      await early.service.tick();
    } finally {
      early.close();
    }
    assert.equal(early.probe.totalProbes(), 0, "probed a resource still inside its backoff window");
    assert.equal((await durable(path)).roadmap[0]?.status, "WAITING_FOR_RESOURCE");

    let dueLaunches = 0;
    const dueLauncher: ReviewLauncher = {
      launch: async () => { dueLaunches += 1; return { ok: true, detail: "must be blocked by billing" }; },
      acknowledgement: () => undefined,
      completion: () => ({ kind: "NONE" }),
    };
    const due = supervisorOver(path, dueLauncher, {
      now: () => retryAt!, acceptanceVerdicts: NO_VERDICT_SOURCE, pid: SUPERVISOR_PID + 97,
      resourceCatalog: SINGLE_RESOURCE_CATALOG,
    });
    due.probe.set("codex-cli", "gpt-5.6-luna", {
      state: "AVAILABLE", reason: "metered at retry", billingMode: "USAGE_BILLED",
    });
    try {
      await due.service.tick();
    } finally {
      due.close();
    }
    assert.ok(due.probe.totalProbes() >= 1, "the due retry did not use the zero-token availability probe");
    assert.equal(dueLaunches, 0, "the due retry bypassed the ordinary billing gate");
    assert.ok((await durable(path)).escalations.some((entry) => entry.reason === "FINANCIAL_ACTION_REQUIRED"));
  });

  it("settles UNUSABLE completion evidence as durable AMBIGUOUS, refuses, and never writes ELIGIBLE", async () => {
    const path = await seed({ reviewRequests: [request()] });
    await adopted(path);

    const launcher: ReviewLauncher = {
      launch: async () => { throw new Error("an AMBIGUOUS review must not be relaunched"); },
      acknowledgement: () => undefined,
      completion: () => ({ kind: "UNUSABLE", reason: "review completion is not parseable JSON" }),
    };
    const { service, close } = supervisorOver(path, launcher, {
      startedAt: 20_000, pid: SUPERVISOR_PID + 93, acceptanceVerdicts: NO_VERDICT_SOURCE,
    });
    let result;
    try {
      result = await service.tick();
    } finally {
      close();
    }

    assert.match(JSON.stringify(result), /cannot be used/, JSON.stringify(result));
    const state = await durable(path);
    const activity = state.activities?.[0];
    assert.equal(activity?.reconciliation?.verdict, "AMBIGUOUS");
    assert.notEqual(activity?.state, "FAILED", "unusable evidence was settled as if it were a verdict");
    assert.notEqual(state.roadmap[0]?.status, "ELIGIBLE", "unusable evidence re-armed the item for another launch");
  });

  it("replays the same failed-review completion through a reopened repository without a second settlement", async () => {
    const path = await seed({ reviewRequests: [request()] });
    await adopted(path);

    const evidence = {
      runId: "A:REVIEW:r1", exitCode: 1,
      failure: "unrecognised failure text", verdictPublished: false, at: 20_000,
    } as const;
    const launcherOver = (pid: number, now: number) =>
      supervisorOver(
        path,
        {
          launch: async () => { throw new Error("must not relaunch a terminal review"); },
          acknowledgement: () => undefined,
          completion: () => ({ kind: "COMPLETED", evidence }),
        },
        { startedAt: now, pid, acceptanceVerdicts: NO_VERDICT_SOURCE, resourceCatalog: SINGLE_RESOURCE_CATALOG },
      );

    const first = launcherOver(SUPERVISOR_PID + 94, 20_000);
    try { await first.service.tick(); } finally { first.close(); }
    const once = await durable(path);
    const resourceOnce = once.resources.find((r) => r.key === RESOURCE_KEY);
    assert.equal(resourceOnce?.backoff.attempt, 1);

    // REOPENED: a fresh repository handle, a fresh service, the SAME durable
    // database and the same completion evidence — no in-memory state carries
    // over, only what was written.
    const second = launcherOver(SUPERVISOR_PID + 95, 21_000);
    try { await second.service.tick(); } finally { second.close(); }
    const twice = await durable(path);

    assert.deepEqual(twice.activities?.[0]?.completion, once.activities?.[0]?.completion, "the second pass settled the review again");
    const resourceTwice = twice.resources.find((r) => r.key === RESOURCE_KEY);
    assert.equal(resourceTwice?.backoff.attempt, 1, "a replayed completion advanced the backoff ladder a second time");
    assert.equal(resourceTwice?.retryAt, resourceOnce?.retryAt, "a replayed completion rescheduled the local retry");
    assert.equal(twice.roadmap[0]?.status, "WAITING_FOR_RESOURCE");
  });

  it("settles the measured Claude OAuth-expired completion as AUTH_REQUIRED and WAITING_FOR_HUMAN_REQUIRED, not quota or billing", async () => {
    const path = await seed({ reviewRequests: [request({ provider: "claude-code", model: "opus" })] });
    await adopted(path);

    const fixture = JSON.parse(
      readFileSync(join(process.cwd(), "tests/fixtures/claude-code-auth-expired-result.json"), "utf8"),
    ) as { readonly result: string };
    const launcher: ReviewLauncher = {
      launch: async () => { throw new Error("must not relaunch after AUTH_REQUIRED"); },
      acknowledgement: () => undefined,
      completion: () => ({
        kind: "COMPLETED",
        evidence: {
          runId: "A:REVIEW:r1", exitCode: 1, failure: "",
          providerError: fixture.result, verdictPublished: false, at: 20_000,
        },
      }),
    };
    const { service, close } = supervisorOver(path, launcher, {
      startedAt: 20_000, pid: SUPERVISOR_PID + 96, acceptanceVerdicts: NO_VERDICT_SOURCE,
    });
    try {
      await service.tick();
    } finally {
      close();
    }

    const state = await durable(path);
    const resource = state.resources.find((r) => r.key === "claude-code:opus");
    assert.equal(resource?.state, "AUTH_REQUIRED");
    assert.equal(resource?.backoff.attempt, 0, "AUTH_REQUIRED scheduled a timed retry");
    assert.equal(resource?.retryAt, undefined, "AUTH_REQUIRED scheduled a retry time");
    assert.equal(state.roadmap[0]?.status, "WAITING_FOR_HUMAN_REQUIRED");
    assert.ok(state.escalations.some((entry) => entry.reason === "HUMAN_CREDENTIAL_REQUIRED" && entry.roadmapKey === "A"));
    assert.equal(
      state.escalations.some((entry) => entry.reason === "FINANCIAL_ACTION_REQUIRED"),
      false,
      "an auth failure was treated as a financial/billing matter",
    );
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
