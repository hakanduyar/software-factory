/**
 * TASK-018 Part B — a verdict that exists is a verdict that gets consumed.
 *
 * WHAT THESE TESTS ARE ABOUT. Round 7 of this task produced a valid
 * CHANGES_REQUIRED verdict at 22:15. The chain validated it against an unchanged
 * fingerprint, wrote it to its status file and exited, because consuming a
 * verdict had never been anybody's job. Remediation started twenty-two hours
 * later, when a person sent a message.
 *
 * Nothing crashed, so nothing that watches for crashes would have helped, and no
 * always-on process fixes it either — that process is one more thing that can
 * die in the gap. What cannot be lost is DURABLE STATE, so these tests drive the
 * transition the only way that survives: from a cold supervisor, against a real
 * database, with no notification and no memory of what launched the review.
 *
 * Every test therefore asserts DURABLE STATE read back through a fresh
 * repository, never a function's return value.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createSqliteSupervisorRepository } from "../src/adapters/supervision/sqliteSupervisorRepository.js";
import { createFileVerdictSource } from "../src/adapters/supervision/fileVerdictSource.js";
import { completionDetail } from "../src/supervision/acceptance.js";
import type { Activity } from "../src/supervision/activity.js";
import { anchorFor } from "../src/supervision/provenanceChain.js";
import { SupervisorService } from "../src/supervision/supervisorService.js";
import { createSequentialIdGenerator } from "../src/domain/ids.js";
import { DEFAULT_ROUTING_POLICY } from "../src/supervision/modelRouting.js";
import type { RoadmapItem, SupervisorState } from "../src/supervision/supervisorTypes.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import { scriptedProbe, TEST_CATALOG } from "./support/supervisorFixtures.js";

const scratch = mkdtempSync(join(tmpdir(), "sf-verdict-"));

after(() => {
  cleanupTempDbs();
});

const CANDIDATE = { commit: "339ae83", tree: "3fd1ecb", fingerprint: "e3bb12ea62ef" } as const;
const REVIEW_ID = "t018b-r7";
const ACTIVITY_ID = "A:REVIEW:r1";

const ROADMAP: readonly RoadmapItem[] = [
  { key: "A", title: "Work", dependsOn: [], status: "ACTIVE", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
];

/** A lease naming a process that is NOT this one; liveness is scripted. */
const REVIEWER_LEASE = {
  pid: 999_001,
  processStartedAt: 5_000,
  machine: "test-machine",
  boot: "boot-a",
  claimedAt: 1_000,
} as const;

/** This supervisor's own pid, kept apart from the reviewer's. */
const SUPERVISOR_PID = 999_002;

let file = 0;
function verdictFile(body: string): string {
  file += 1;
  const path = join(scratch, `verdict-${file}.txt`);
  writeFileSync(path, body, "utf8");
  return path;
}

function verdictText(options: {
  readonly verdict: string;
  readonly safe: string;
  readonly critical: number;
  readonly high: number;
  readonly candidate?: { readonly commit: string; readonly tree: string; readonly fingerprint: string };
}): string {
  const candidate = options.candidate ?? CANDIDATE;
  return [
    `VERDICT: ${options.verdict}`,
    `Safe to commit: ${options.safe}`,
    "",
    "Some prose the reviewer wrote, which is not parsed.",
    "",
    `FACTORY_ACCEPTANCE_COUNTS: CRITICAL=${options.critical} HIGH=${options.high}`,
    `FACTORY_ACCEPTANCE_CANDIDATE: ${candidate.commit} ${candidate.tree} ${candidate.fingerprint}`,
    "",
  ].join("\n");
}

function reviewActivity(source: string, overrides: Partial<Activity> = {}): Activity {
  return {
    id: ACTIVITY_ID,
    kind: "REVIEW",
    roadmapKey: "A",
    state: "RUNNING",
    lease: { ...REVIEWER_LEASE },
    heartbeat: { at: 1_100, progress: 1 },
    review: { reviewId: REVIEW_ID, source, candidate: { ...CANDIDATE } },
    updatedAt: 1_100,
    ...overrides,
  };
}

function baseState(activities: readonly Activity[]): SupervisorState {
  return {
    version: 1,
    financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
    resources: [],
    roadmap: ROADMAP,
    checkpoints: [],
    escalations: [],
    provenance: [],
    provenanceAnchor: anchorFor([]),
    activities,
    activeClaim: {
      actionId: "A:REVIEW:a1",
      roadmapKey: "A",
      kind: "REVIEW",
      state: "RUNNING",
      ownerId: "the-process-that-launched-the-review",
      attempt: 1,
      claimedAt: 1_000,
    },
    updatedAt: 1_000,
  };
}

async function seed(activities: readonly Activity[]): Promise<string> {
  const path = tempDbPath();
  const repository = createSqliteSupervisorRepository(path);
  try {
    await repository.create(baseState(activities));
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

/**
 * A COLD supervisor: it has never seen this database, never launched the review,
 * and has been told nothing. Everything it does comes from durable state.
 */
function coldSupervisor(
  path: string,
  options: {
    readonly liveness?: "ALIVE" | "GONE" | "UNKNOWN";
    readonly onExecute?: () => void;
    /**
     * A LATER PROCESS HAS A LATER CLOCK, and the default hid a real defect: two
     * cold supervisors both starting at 10_000 stamped an identical `raisedAt`,
     * so re-raising the integration gate was indistinguishable from not raising
     * it, and the mutation that removed the idempotence filter SURVIVED.
     */
    readonly startedAt?: number;
    /** Counts every read of a review's source. */
    readonly reads?: { count: number };
  } = {},
): { readonly service: SupervisorService; close(): void } {
  const repository = createSqliteSupervisorRepository(path);
  const probe = scriptedProbe();
  for (const entry of TEST_CATALOG) {
    probe.set(entry.provider, entry.model, {
      state: "AVAILABLE",
      reason: "scripted",
      billingMode: "INCLUDED_SUBSCRIPTION",
    });
  }
  const base = options.startedAt ?? 10_000;
  let reading = 0;
  const service = new SupervisorService({
    repository,
    roadmapCatalog: [...ROADMAP],
    probe,
    executor: {
      execute: async () => {
        options.onExecute?.();
        return { kind: "COMPLETED", detail: "remediation ran" };
      },
    },
    clock: { now: () => base + reading++ * 1_000 },
    ids: createSequentialIdGenerator(),
    routingPolicy: DEFAULT_ROUTING_POLICY,
    resourceCatalog: TEST_CATALOG,
    /**
     * Answers about the REVIEWER as the test asks, and about this supervisor's
     * OWN lease truthfully — a supervisor whose own lease reads dead cannot
     * claim anything, and the first version of this fixture made the remediation
     * launch look impossible for a reason that had nothing to do with verdicts.
     */
    liveness: { check: (lease) => (lease.pid === SUPERVISOR_PID ? "ALIVE" : (options.liveness ?? "GONE")) },
    activityLease: (claimedAt) => ({ ...REVIEWER_LEASE, pid: SUPERVISOR_PID, claimedAt }),
    acceptanceVerdicts: {
      read: (review) => {
        if (options.reads !== undefined) options.reads.count += 1;
        return createFileVerdictSource().read(review);
      },
    },
    log: () => {},
  });
  return { service, close: () => repository.close() };
}

function reviewIn(state: SupervisorState): Activity {
  const activity = (state.activities ?? []).find((entry) => entry.id === ACTIVITY_ID);
  assert.ok(activity, "the review activity vanished");
  return activity;
}

// =====================================================================
// A — the notification is lost; the verdict is consumed anyway
// =====================================================================

describe("TASK-018: a verdict nobody was told about is consumed from durable state", () => {
  it("A. consumes CHANGES_REQUIRED on a cold tick, with no notification at all", async () => {
    const source = verdictFile(verdictText({ verdict: "CHANGES_REQUIRED", safe: "NO", critical: 0, high: 3 }));
    const path = await seed([reviewActivity(source)]);

    let executed = 0;
    const cold = coldSupervisor(path, { onExecute: () => (executed += 1) });
    try {
      await cold.service.tick();
    } finally {
      cold.close();
    }

    const state = await durable(path);
    const review = reviewIn(state);
    assert.equal(review.state, "COMPLETED", "the review was not settled");
    assert.equal(review.completion?.outcome, "CHANGES_REQUIRED");
    assert.ok(review.observedAt !== undefined, "the verdict was applied but not marked observed");
    assert.equal(state.activeClaim, undefined, "the review's claim outlived the review");
    assert.notEqual(state.roadmap[0]?.status, "DONE", "a CHANGES_REQUIRED verdict advanced the item");
    /**
     * THE POINT OF THE WHOLE EXERCISE: remediation started, in the same tick,
     * with no user message and nothing kept awake.
     */
    assert.equal(executed, 1, "remediation did not become claimable and launchable");
  });

  it("B. a genuine PASS reaches the integration gate and stops there", async () => {
    const source = verdictFile(verdictText({ verdict: "PASS", safe: "YES", critical: 0, high: 0 }));
    const path = await seed([reviewActivity(source)]);

    let executed = 0;
    const cold = coldSupervisor(path, { onExecute: () => (executed += 1) });
    try {
      await cold.service.tick();
    } finally {
      cold.close();
    }

    const state = await durable(path);
    assert.equal(reviewIn(state).completion?.outcome, "PASS");
    assert.equal(
      state.roadmap[0]?.status,
      "WAITING_FOR_HUMAN_REQUIRED",
      "an accepted candidate did not reach the integration gate",
    );
    const raised = state.escalations.filter((entry) => !entry.resolved);
    assert.equal(raised.length, 1, "the integration gate left no record");
    assert.match(raised[0]?.humanActionRequired ?? "", /339ae83/, "the gate does not name the candidate");
    /**
     * ADR-0002 IS NOT BEING BYPASSED. Consuming a PASS records that a review
     * accepted a candidate; it does not integrate anything, and it certainly
     * does not run more work on an item whose candidate is awaiting its gate.
     */
    assert.equal(executed, 0, "work ran past an accepted candidate's integration gate");
    assert.notEqual(state.roadmap[0]?.status, "DONE");
  });

  it("C. a reviewer that died without writing anything is NEVER a PASS", async () => {
    const source = join(scratch, "a-verdict-that-was-never-written.txt");
    const path = await seed([reviewActivity(source)]);

    const cold = coldSupervisor(path, { liveness: "GONE" });
    try {
      await cold.service.tick();
    } finally {
      cold.close();
    }

    const state = await durable(path);
    const review = reviewIn(state);
    assert.equal(review.state, "FAILED", "a review that produced nothing was not recorded as failed");
    assert.equal(review.completion?.outcome, "NO_VERDICT");
    assert.notEqual(review.completion?.outcome, "PASS");
    assert.notEqual(state.roadmap[0]?.status, "DONE", "a review that produced nothing advanced the item");
  });

  it("C2. ...and a reviewer still running is left alone, not declared failed", async () => {
    const source = join(scratch, "not-written-yet.txt");
    const path = await seed([reviewActivity(source)]);

    const cold = coldSupervisor(path, { liveness: "ALIVE" });
    try {
      await cold.service.tick();
    } finally {
      cold.close();
    }

    const state = await durable(path);
    const review = reviewIn(state);
    assert.equal(review.state, "RUNNING", "a live reviewer was concluded on");
    assert.equal(review.completion, undefined);
  });

  it("C3. an owner whose liveness is UNKNOWN is not concluded on either", async () => {
    const source = join(scratch, "unknowable.txt");
    const path = await seed([reviewActivity(source)]);

    const cold = coldSupervisor(path, { liveness: "UNKNOWN" });
    try {
      await cold.service.tick();
    } finally {
      cold.close();
    }

    assert.equal(reviewIn(await durable(path)).completion, undefined, "an unknown owner's review was settled");
  });

  it("D. a verdict that landed before this process existed is consumed at startup", async () => {
    // Written BEFORE any supervisor is constructed — the round-7 shape exactly.
    const source = verdictFile(verdictText({ verdict: "CHANGES_REQUIRED", safe: "NO", critical: 0, high: 2 }));
    const path = await seed([reviewActivity(source)]);

    const cold = coldSupervisor(path);
    try {
      await cold.service.tick();
    } finally {
      cold.close();
    }

    assert.equal(reviewIn(await durable(path)).completion?.outcome, "CHANGES_REQUIRED");
  });

  it("E. two supervisors seeing one verdict produce exactly one transition", async () => {
    const source = verdictFile(verdictText({ verdict: "PASS", safe: "YES", critical: 0, high: 0 }));
    const path = await seed([reviewActivity(source)]);

    const first = coldSupervisor(path);
    const second = coldSupervisor(path);
    try {
      // Both tick against the same database, through separate connections.
      await Promise.all([first.service.tick(), second.service.tick()]);
    } catch (error) {
      // A loser may legitimately fail its tick; what it may NOT do is write a
      // second transition. That is what is asserted below.
      void error;
    } finally {
      first.close();
      second.close();
    }

    const state = await durable(path);
    const reviews = (state.activities ?? []).filter((entry) => entry.id === ACTIVITY_ID);
    assert.equal(reviews.length, 1, "the activity was duplicated");
    assert.equal(reviews[0]?.completion?.outcome, "PASS");
    assert.equal(
      state.escalations.filter((entry) => !entry.resolved).length,
      1,
      "one verdict produced more than one open escalation",
    );
  });

  /**
   * ROUND-8 REVIEW, HIGH 3. Test E used the SAME clock for both supervisors,
   * which is the one thing two processes can never share — and it hid a real
   * defect: the completion recorded the consuming supervisor's local time, so a
   * second consumer's replay of the very same verdict was rejected as a
   * DISAGREEMENT (`PASS@10000` versus `PASS@20000`). Replayability across
   * processes is exactly what AC-17 asks for.
   *
   * The moment is not part of the verdict. A different outcome or a different
   * detail still refuses; a different clock does not.
   */
  it("E2. two supervisors on DIFFERENT clocks still produce exactly one transition", async () => {
    const source = verdictFile(verdictText({ verdict: "PASS", safe: "YES", critical: 0, high: 0 }));
    const path = await seed([reviewActivity(source)]);

    const first = coldSupervisor(path, { startedAt: 10_000 });
    const second = coldSupervisor(path, { startedAt: 20_000 });
    try {
      await Promise.all([first.service.tick(), second.service.tick()]);
    } catch (error) {
      // A loser may fail its tick; it may not write a second transition, and it
      // may certainly not refuse the verdict it agrees with.
      void error;
    } finally {
      first.close();
      second.close();
    }

    const state = await durable(path);
    const review = reviewIn(state);
    assert.equal(review.completion?.outcome, "PASS", "a verdict was lost between two clocks");
    assert.equal(
      state.escalations.filter((entry) => !entry.resolved).length,
      1,
      "one verdict produced more than one open escalation",
    );

    // ...and a third, later process replays it without refusing.
    const third = coldSupervisor(path, { startedAt: 30_000 });
    let replay;
    try {
      replay = await third.service.tick();
    } finally {
      third.close();
    }
    assert.doesNotMatch(
      JSON.stringify(replay),
      /disagrees|already/,
      `a settled verdict was refused by a later clock: ${JSON.stringify(replay)}`,
    );
    assert.deepEqual(reviewIn(await durable(path)).completion, review.completion);
  });

  /**
   * The same collision, made deterministic.
   *
   * E2's race only reaches the retry if the two ticks interleave just so, and a
   * guard that is only sometimes exercised is not a guard: restoring the clock
   * to the comparison SURVIVED E2. Here the rival settles the identical verdict
   * with an earlier timestamp WHILE this supervisor is writing, so the retry is
   * guaranteed to meet an already-settled review — and must recognise it as the
   * same verdict rather than as a disagreement.
   */
  it("E3. a retry that meets its own verdict already settled by another clock does not refuse", async () => {
    const source = verdictFile(verdictText({ verdict: "PASS", safe: "YES", critical: 0, high: 0 }));
    const path = await seed([reviewActivity(source)]);

    const real = createSqliteSupervisorRepository(path);
    const RIVAL_AT = 5_000;
    let interfered = false;
    const contended = {
      load: () => real.load(),
      create: (state: SupervisorState) => real.create(state),
      readCatalogVersion: () => real.readCatalogVersion(),
      applyCatalogUpgrade: (next: SupervisorState, expected: number, to: number) =>
        real.applyCatalogUpgrade(next, expected, to),
      compareAndSave: async (next: SupervisorState, expected: number) => {
        if (!interfered && (next.activities ?? []).some((entry) => entry.completion !== undefined)) {
          interfered = true;
          const rival = createSqliteSupervisorRepository(path);
          try {
            const seen = await rival.load();
            if (seen !== undefined) {
              await rival.compareAndSave(
                {
                  ...seen,
                  version: seen.version + 1,
                  updatedAt: seen.updatedAt + 1,
                  activities: (seen.activities ?? []).map((entry) =>
                    entry.id === ACTIVITY_ID
                      ? {
                          ...entry,
                          state: "COMPLETED" as const,
                          // The SAME verdict, read off the same file, by a
                          // process whose clock is its own.
                          completion: {
                            outcome: "PASS",
                            detail: completionDetail({
                              verdict: "PASS",
                              critical: 0,
                              high: 0,
                              safeToCommit: true,
                              candidate: { ...CANDIDATE },
                            }),
                            at: RIVAL_AT,
                          },
                          observedAt: RIVAL_AT,
                          updatedAt: RIVAL_AT,
                        }
                      : entry,
                  ),
                },
                seen.version,
              );
            }
          } finally {
            rival.close();
          }
        }
        return real.compareAndSave(next, expected);
      },
    };

    const probe = scriptedProbe();
    for (const entry of TEST_CATALOG) {
      probe.set(entry.provider, entry.model, {
        state: "AVAILABLE",
        reason: "scripted",
        billingMode: "INCLUDED_SUBSCRIPTION",
      });
    }
    let reading = 0;
    let result;
    try {
      const service = new SupervisorService({
        repository: contended,
        roadmapCatalog: [...ROADMAP],
        probe,
        executor: { execute: async () => ({ kind: "COMPLETED", detail: "should not run" }) },
        clock: { now: () => 90_000 + reading++ * 1_000 },
        ids: createSequentialIdGenerator(),
        routingPolicy: DEFAULT_ROUTING_POLICY,
        resourceCatalog: TEST_CATALOG,
        liveness: { check: (lease) => (lease.pid === SUPERVISOR_PID ? "ALIVE" : "GONE") },
        activityLease: (claimedAt) => ({ ...REVIEWER_LEASE, pid: SUPERVISOR_PID, claimedAt }),
        acceptanceVerdicts: createFileVerdictSource(),
        log: () => {},
      });
      result = await service.tick();
    } finally {
      real.close();
    }

    assert.equal(interfered, true, "the premise is wrong: no collision happened");
    assert.doesNotMatch(
      JSON.stringify(result),
      /could not be recorded/,
      `the same verdict, read by a different clock, was refused as a disagreement: ${JSON.stringify(result)}`,
    );

    const state = await durable(path);
    assert.equal(reviewIn(state).completion?.at, RIVAL_AT, "the first settlement's moment was overwritten");
    assert.equal(
      state.roadmap[0]?.status,
      "WAITING_FOR_HUMAN_REQUIRED",
      "the accepted candidate never reached its gate",
    );
  });

  it("F. a verdict for a different candidate is REFUSED, not applied", async () => {
    const source = verdictFile(
      verdictText({
        verdict: "PASS",
        safe: "YES",
        critical: 0,
        high: 0,
        // A previous round's file, left on disk.
        candidate: { commit: "041b4c3", tree: "3fd1ecb", fingerprint: "e3bb12ea62ef" },
      }),
    );
    const path = await seed([reviewActivity(source)]);

    let executed = 0;
    const cold = coldSupervisor(path, { onExecute: () => (executed += 1) });
    let result;
    try {
      result = await cold.service.tick();
    } finally {
      cold.close();
    }

    assert.match(JSON.stringify(result), /041b4c3/, "the refusal does not say which candidate it refused");
    const state = await durable(path);
    assert.equal(reviewIn(state).completion, undefined, "a verdict for another candidate was applied");
    assert.equal(state.roadmap[0]?.status, "ACTIVE", "the item moved on a verdict that was refused");
    assert.equal(executed, 0);
    /**
     * This refusal stops every tick until someone looks, so the reason has to
     * outlive the process that formed it — the same rule as AC-16's.
     */
    assert.equal(
      reviewIn(state).reconciliation?.verdict,
      "AMBIGUOUS",
      "a refusal that halts the Factory left no durable reason",
    );
    assert.match(reviewIn(state).reconciliation?.detail ?? "", /041b4c3/);
  });

  it("F2. ...including when only the fingerprint differs", async () => {
    const source = verdictFile(
      verdictText({
        verdict: "PASS",
        safe: "YES",
        critical: 0,
        high: 0,
        // Same commit, same tree, uncommitted work on top.
        candidate: { commit: CANDIDATE.commit, tree: CANDIDATE.tree, fingerprint: "deadbeefcafe" },
      }),
    );
    const path = await seed([reviewActivity(source)]);

    const cold = coldSupervisor(path);
    try {
      await cold.service.tick();
    } finally {
      cold.close();
    }

    assert.equal(reviewIn(await durable(path)).completion, undefined, "a verdict for another tree was applied");
  });

  it("G. re-reconciling an already-consumed verdict changes nothing", async () => {
    const source = verdictFile(verdictText({ verdict: "PASS", safe: "YES", critical: 0, high: 0 }));
    const path = await seed([reviewActivity(source)]);

    const firstRun = coldSupervisor(path);
    try {
      await firstRun.service.tick();
    } finally {
      firstRun.close();
    }
    const once = await durable(path);

    // H, in the same breath: a brand-new process, after the write landed.
    // A different process, an hour later. Its reads are counted, because that is
    // the question: does a settled review get looked at again at all?
    const reads = { count: 0 };
    const secondRun = coldSupervisor(path, { startedAt: 3_600_000, reads });
    try {
      await secondRun.service.tick();
      await secondRun.service.tick();
    } finally {
      secondRun.close();
    }
    const twice = await durable(path);

    assert.deepEqual(reviewIn(twice), reviewIn(once), "re-consumption rewrote a settled review");
    /**
     * ROUND-8 MUTATION RUN. Dropping the terminal filter from
     * `reviewsAwaitingVerdict` SURVIVED, because re-reading a settled verdict
     * re-derives the same activity and the same roadmap patch — the shapes all
     * match. What it does NOT re-derive is the moment: consuming again raises
     * the integration gate again, with a new `raisedAt`. The state version is no
     * use here (an ordinary tick writes its wake time anyway); the timestamp on
     * the escalation is exactly the thing that only moves when the verdict is
     * applied a second time.
     */
    assert.deepEqual(
      twice.escalations,
      once.escalations,
      "a settled verdict was applied again: the integration gate was re-raised",
    );
    /**
     * ROUND-8 MUTATION RUN. Dropping the terminal filter from
     * `reviewsAwaitingVerdict` SURVIVED every assertion above, because
     * re-consuming a settled verdict re-derives values that all compare equal.
     * The observable difference is upstream of all of it: a review that is
     * finished is not LOOKED AT again. Asked directly, there is nothing left for
     * an equal-looking result to hide behind.
     */
    assert.equal(reads.count, 0, "a settled review's verdict source was read again");
    assert.equal(
      twice.escalations.filter((entry) => !entry.resolved).length,
      once.escalations.filter((entry) => !entry.resolved).length,
      "re-consumption raised the gate a second time",
    );
  });

  it("H. a supervisor that has no way to read verdicts REFUSES rather than passing over one", async () => {
    const source = verdictFile(verdictText({ verdict: "PASS", safe: "YES", critical: 0, high: 0 }));
    const path = await seed([reviewActivity(source)]);

    const repository = createSqliteSupervisorRepository(path);
    const probe = scriptedProbe();
    for (const entry of TEST_CATALOG) {
      probe.set(entry.provider, entry.model, {
        state: "AVAILABLE",
        reason: "scripted",
        billingMode: "INCLUDED_SUBSCRIPTION",
      });
    }
    let executed = 0;
    let result;
    try {
      const service = new SupervisorService({
        repository,
        roadmapCatalog: [...ROADMAP],
        probe,
        executor: {
          execute: async () => {
            executed += 1;
            return { kind: "COMPLETED", detail: "should not run" };
          },
        },
        clock: { now: () => 20_000 },
        ids: createSequentialIdGenerator(),
        routingPolicy: DEFAULT_ROUTING_POLICY,
        resourceCatalog: TEST_CATALOG,
        liveness: { check: (lease) => (lease.pid === SUPERVISOR_PID ? "ALIVE" : "GONE") },
        activityLease: (claimedAt) => ({ ...REVIEWER_LEASE, pid: SUPERVISOR_PID, claimedAt }),
        // ...and no `acceptanceVerdicts` at all.
        log: () => {},
      });
      result = await service.tick();
    } finally {
      repository.close();
    }

    assert.match(JSON.stringify(result), /no way to read a verdict back/, JSON.stringify(result));
    assert.equal(executed, 0, "work was scheduled while a review's result was unreachable");
    const stopped = await durable(path);
    assert.equal(reviewIn(stopped).completion, undefined);
    /**
     * ROUND-8 REVIEW, HIGH 2. This refusal returns BEFORE reconciliation, so it
     * used to leave the review with no `reconciliation` at all — and AC-16 asks
     * that every non-terminal activity carry a durable conclusion. "The tick
     * stopped for execution reasons" does not exempt the activity it stopped
     * over; a fresh process must find the reason on the record.
     */
    assert.equal(
      reviewIn(stopped).reconciliation?.verdict,
      "AMBIGUOUS",
      "a review the Factory stopped over was left unclassified",
    );
    assert.match(reviewIn(stopped).reconciliation?.detail ?? "", /verdict back/);
  });
});
