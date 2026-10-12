/**
 * TASK-018 PART B — durable orchestration, as pure logic.
 *
 * The decisions are separable from the transaction that writes them and from
 * the process table that answers liveness, and are driven here directly. The
 * things a pure test structurally cannot prove — a real process dying, two real
 * processes racing, a supervisor restarting — are proven elsewhere against real
 * processes, and this file does not claim them.
 *
 * EVERY REFUSAL IS PAIRED WITH A POSITIVE CONTROL. A mechanism that refused
 * everything would satisfy the first half of all of them.
 *
 * Offline: no provider is contacted, no model is invoked, no money can be spent.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canonicalActivityId,
  claimActivity,
  classifyActivity,
  completeActivity,
  isTerminal,
  observeCompletion,
  recordReconciliation,
  reportProgress,
  unobservedCompletions,
  type Activity,
  type ActivityLease,
  type Liveness,
  type LivenessProbe,
} from "../src/supervision/activity.js";

const MACHINE = "wsl-ubuntu";
const BOOT = "boot-aaaa";
const T0 = 1_000_000;

function lease(overrides: Partial<ActivityLease> = {}): ActivityLease {
  return { pid: 4242, processStartedAt: 99, machine: MACHINE, boot: BOOT, claimedAt: T0, ...overrides };
}

/** A probe whose answer the test chooses, because that is the fact under test. */
function probeSaying(answer: Liveness | ((held: ActivityLease) => Liveness)): LivenessProbe {
  return { check: (held) => (typeof answer === "function" ? answer(held) : answer) };
}

/** The pid a claimant uses below, kept distinct from the incumbent's 4242. */
const CLAIMANT_PID = 777;

/**
 * Answers per LEASE rather than globally.
 *
 * A claim now checks TWO things — that the incoming lease names a live process,
 * and what the incumbent is doing — so a probe that gives one answer to both
 * cannot express the cases. The claimant is alive unless a test says otherwise;
 * the incumbent is whatever the test is about.
 */
function probeWhere(incumbent: Liveness, claimant: Liveness = "ALIVE"): LivenessProbe {
  return { check: (held) => (held.pid === CLAIMANT_PID ? claimant : incumbent) };
}

function claimed(overrides: Partial<Activity> = {}): Activity {
  return {
    id: "CLEAN_ROOM_CI:REVIEW:r1",
    kind: "REVIEW",
    roadmapKey: "CLEAN_ROOM_CI",
    state: "CLAIMED",
    lease: lease(),
    updatedAt: T0,
    ...overrides,
  };
}

function problemOf(verdict: { ok: boolean; problem?: string }): string {
  assert.equal(verdict.ok, false, "expected a refusal");
  return verdict.problem ?? "";
}

// =====================================================================
// AC-12 / AC-13 — one owner, and holding is a fact
// =====================================================================

describe("TASK-018 AC-13: an activity has exactly one owner", () => {
  const request = {
    id: "CLEAN_ROOM_CI:REVIEW:r1",
    kind: "REVIEW",
    roadmapKey: "CLEAN_ROOM_CI",
    lease: lease({ pid: CLAIMANT_PID, processStartedAt: 5 }),
    now: T0 + 10,
  };

  it("CLAIMS an activity nothing holds — the positive control", () => {
    const verdict = claimActivity([], request, probeWhere("GONE"));
    assert.equal(verdict.ok, true);
    if (!verdict.ok) throw new Error("unreachable");
    assert.equal(verdict.activities.length, 1);
    assert.equal(verdict.activity.state, "CLAIMED");
    assert.equal(verdict.activity.lease?.pid, CLAIMANT_PID);
  });

  /**
   * ROUND-1 REVIEW, HIGH 2. Liveness was checked only for the INCUMBENT, so a
   * claim carrying a lease for a process that had already died was accepted and
   * written — and the record then said an activity was owned by something that
   * would never report progress, complete it, or release it.
   */
  it("REFUSES a claim whose OWN process is not running", () => {
    const problem = problemOf(claimActivity([], request, probeWhere("GONE", "GONE")));
    assert.match(problem, new RegExp(`refusing to claim .* for pid ${CLAIMANT_PID}`));
    assert.match(problem, /not running/);
  });

  it("REFUSES a claim whose own process cannot be checked from here", () => {
    const problem = problemOf(claimActivity([], request, probeWhere("GONE", "UNKNOWN")));
    assert.match(problem, /not checkable from here/);
  });

  it("REFUSES a second owner while the first is alive, and names the holder", () => {
    const problem = problemOf(claimActivity([claimed()], request, probeWhere("ALIVE")));
    assert.match(problem, /is held by pid 4242/);
    assert.match(problem, /"wsl-ubuntu"/);
    assert.match(problem, /still running/);
  });

  it("REFUSES when liveness cannot be established, rather than assuming either way", () => {
    const problem = problemOf(claimActivity([claimed()], request, probeWhere("UNKNOWN")));
    assert.match(problem, /cannot be established/);
  });

  /**
   * ROUND-1 REVIEW, HIGH 2. "No owner is recorded" is not the same fact as "no
   * owner exists", and taking it would resolve an unknown in the convenient
   * direction.
   */
  it("REFUSES an unfinished activity that records no lease at all", () => {
    const { lease: _none, ...orphaned } = claimed({ state: "RUNNING" });
    const problem = problemOf(claimActivity([orphaned], request, probeWhere("ALIVE")));
    assert.match(problem, /with no lease recorded/);
    assert.match(problem, /cannot be established/);
  });

  it("ALLOWS the claim once the previous holder is gone", () => {
    const verdict = claimActivity([claimed()], request, probeWhere("GONE"));
    assert.equal(verdict.ok, true);
    if (!verdict.ok) throw new Error("unreachable");
    assert.equal(verdict.activities.length, 1, "a re-claim must not duplicate the record");
    assert.equal(verdict.activity.lease?.pid, CLAIMANT_PID);
  });

  it("carries progress across a re-claim, but never a completion or an observation", () => {
    const previous = claimed({
      state: "RUNNING",
      heartbeat: { at: T0 + 1, progress: 7 },
      completion: { outcome: "PASS", detail: "stale", at: T0 + 2 },
      observedAt: T0 + 3,
      reconciliation: { verdict: "LIVE", at: T0 + 2, detail: "stale" },
    });
    const verdict = claimActivity([previous], request, probeWhere("GONE"));
    assert.equal(verdict.ok, true);
    if (!verdict.ok) throw new Error("unreachable");
    assert.deepEqual(verdict.activity.heartbeat, { at: T0 + 1, progress: 7 });
    assert.equal(verdict.activity.completion, undefined, "a dead owner's completion was carried forward");
    assert.equal(verdict.activity.observedAt, undefined);
    assert.equal(verdict.activity.reconciliation, undefined, "a stale verdict about a dead holder survived");
    assert.equal(verdict.activity.state, "CLAIMED");
  });

  it("REFUSES a second claim on an activity that already finished", () => {
    const problem = problemOf(
      claimActivity(
        [claimed({ state: "COMPLETED", completion: { outcome: "PASS", detail: "done", at: T0 } })],
        request,
        probeWhere("GONE"),
      ),
    );
    assert.match(problem, /already finished as COMPLETED/);
    assert.match(problem, /a retry is a new attempt/);
  });

  it("REFUSES to act on durable state holding the same id twice", () => {
    const problem = problemOf(claimActivity([claimed(), claimed()], request, probeWhere("GONE")));
    assert.match(problem, /more than once/);
  });

  it("gives every attempt its own id, so a retry cannot overwrite a result", () => {
    assert.equal(canonicalActivityId("CLEAN_ROOM_CI", "REVIEW", 1), "CLEAN_ROOM_CI:REVIEW:r1");
    assert.notEqual(canonicalActivityId("A", "REVIEW", 1), canonicalActivityId("A", "REVIEW", 2));
  });
});

// =====================================================================
// AC-14 / AC-16 — a stall is a measurement, and unknown refuses
// =====================================================================

describe("TASK-018 AC-14/AC-16: what a later observer may conclude", () => {
  /** An hour after T0, against the forty-minute threshold the watchdog used. */
  const window = { now: T0 + 60 * 60 * 1000, stallAfterMs: 40 * 60 * 1000 };
  /** A second after T0: inside the threshold, so nothing may be called stalled. */
  const recent = { now: T0 + 1_000, stallAfterMs: 40 * 60 * 1000 };

  it("says nothing about an activity its owner already finished", () => {
    for (const state of ["COMPLETED", "FAILED"] as const) {
      assert.equal(
        classifyActivity(claimed({ state, completion: { outcome: "x", detail: "y", at: T0 } }), window, probeSaying("GONE")),
        undefined,
        `${state} was reinterpreted`,
      );
    }
  });

  it("CRASHED when the owner is gone, however recent its last progress", () => {
    const verdict = classifyActivity(
      claimed({ state: "RUNNING", heartbeat: { at: window.now - 1, progress: 3 } }),
      window,
      probeSaying("GONE"),
    );
    assert.equal(verdict?.verdict, "CRASHED");
    assert.match(verdict?.detail ?? "", /is gone/);
  });

  it("AMBIGUOUS when liveness is unknown — never a guess in either direction", () => {
    const verdict = classifyActivity(claimed({ state: "RUNNING" }), window, probeSaying("UNKNOWN"));
    assert.equal(verdict?.verdict, "AMBIGUOUS");
    assert.match(verdict?.detail ?? "", /cannot be established/);
  });

  it("AMBIGUOUS when there is no lease at all, because no owner can be checked", () => {
    // The key is OMITTED rather than set to undefined: `exactOptionalPropertyTypes`
    // is on, and "absent" is the state a record written before a lease existed
    // would actually be in.
    const { lease: _none, ...withoutLease } = claimed({ state: "RUNNING" });
    const verdict = classifyActivity(withoutLease, window, probeSaying("ALIVE"));
    assert.equal(verdict?.verdict, "AMBIGUOUS");
    assert.match(verdict?.detail ?? "", /no lease/);
  });

  it("STALLED only when the owner is ALIVE and progress has stopped", () => {
    const verdict = classifyActivity(
      claimed({ state: "RUNNING", heartbeat: { at: T0, progress: 3 } }),
      window,
      probeSaying("ALIVE"),
    );
    assert.equal(verdict?.verdict, "STALLED");
    assert.match(verdict?.detail ?? "", /last reported progress/);
    assert.match(verdict?.detail ?? "", /still running/);
  });

  it("NEVER_STARTED when a live owner has held it without reporting anything", () => {
    const verdict = classifyActivity(claimed(), window, probeSaying("ALIVE"));
    assert.equal(verdict?.verdict, "NEVER_STARTED");
    assert.match(verdict?.detail ?? "", /never reported progress/);
  });

  it("LIVE while progress is recent — the positive control for both stalls", () => {
    const working = classifyActivity(
      claimed({ state: "RUNNING", heartbeat: { at: recent.now - 5, progress: 3 } }),
      recent,
      probeSaying("ALIVE"),
    );
    assert.equal(working?.verdict, "LIVE");

    const starting = classifyActivity(claimed(), recent, probeSaying("ALIVE"));
    assert.equal(starting?.verdict, "LIVE", "a freshly claimed activity is not yet NEVER_STARTED");
  });

  it("distinguishes finished, died, stalled and never-started from one another", () => {
    const seen = new Set(
      [
        classifyActivity(claimed({ state: "RUNNING", heartbeat: { at: T0, progress: 1 } }), window, probeSaying("GONE")),
        classifyActivity(claimed({ state: "RUNNING", heartbeat: { at: T0, progress: 1 } }), window, probeSaying("ALIVE")),
        classifyActivity(claimed(), window, probeSaying("ALIVE")),
      ].map((entry) => entry?.verdict),
    );
    assert.deepEqual([...seen].sort(), ["CRASHED", "NEVER_STARTED", "STALLED"]);
    // ...and the fourth is distinguished by producing no verdict at all.
    assert.equal(isTerminal("COMPLETED"), true);
  });
});

// =====================================================================
// AC-17 — transitions are idempotent, and disagreement refuses
// =====================================================================

describe("TASK-018 AC-17: applying a transition twice is applying it once", () => {
  const completion = { outcome: "PASS", detail: "round 2", at: T0 + 50 };

  it("completing twice with the same record changes nothing the second time", () => {
    const once = completeActivity([claimed()], claimed().id, { state: "COMPLETED", holder: lease(), completion });
    assert.equal(once.ok, true);
    if (!once.ok) throw new Error("unreachable");
    assert.equal(once.changed, true);

    const twice = completeActivity(once.activities, claimed().id, { state: "COMPLETED", holder: lease(), completion });
    assert.equal(twice.ok, true);
    if (!twice.ok) throw new Error("unreachable");
    assert.equal(twice.changed, false, "the second application changed something");
    assert.deepEqual(twice.activities, once.activities);
  });

  it("REFUSES a second completion that DISAGREES, rather than letting the later write win", () => {
    const once = completeActivity([claimed()], claimed().id, { state: "COMPLETED", holder: lease(), completion });
    assert.equal(once.ok, true);
    if (!once.ok) throw new Error("unreachable");
    const problem = problemOf(
      completeActivity(once.activities, claimed().id, {
        state: "COMPLETED",
        holder: lease(),
        completion: { ...completion, outcome: "FAIL" },
      }),
    );
    assert.match(problem, /already recorded a completion as PASS/);
    assert.match(problem, /refusing to replace it with FAIL/);
  });

  /**
   * ROUND-1 REVIEW, HIGH 3 — the reviewer's own reproduction.
   *
   * The comparison joined the fields with delimiters, and delimiters collide:
   * these two completions are genuinely different and produced identical text,
   * so the second was accepted as an idempotent repeat and a real disagreement
   * between two owners vanished without a word. Compared structurally now.
   */
  it("REFUSES two DIFFERENT completions whose fields would concatenate alike", () => {
    const first = { outcome: "a/b", detail: "c", at: 1 };
    const second = { outcome: "a", detail: "b/c", at: 1 };

    const once = completeActivity([claimed()], claimed().id, { state: "COMPLETED", holder: lease(), completion: first });
    assert.equal(once.ok, true);
    if (!once.ok) throw new Error("unreachable");

    const problem = problemOf(
      completeActivity(once.activities, claimed().id, { state: "COMPLETED", holder: lease(), completion: second }),
    );
    assert.match(problem, /already recorded a completion/);
    assert.match(problem, /refusing to replace it/);
  });

  /**
   * ROUND-5 REVIEW, HIGH 2 — the reviewer's own reproduction.
   *
   * `completeActivity` was keyed only by the activity id, so a completion
   * computed BEFORE a re-claim could be applied after it: a COMPLETED activity
   * whose lease belonged to one process and whose outcome had been produced by
   * another. The round-4 retry made it reachable, because re-applying against
   * fresher state is exactly the moment the holder may have changed underneath.
   *
   * An id says WHICH activity. It has never said who may write to it.
   */
  it("REFUSES a completion from a process that no longer holds the activity", () => {
    const successor = lease({ pid: 22, processStartedAt: 7 });
    const problem = problemOf(
      completeActivity([claimed({ state: "RUNNING", lease: successor })], claimed().id, {
        state: "COMPLETED",
        holder: lease(), // the ORIGINAL holder, whose work was superseded
        completion: { outcome: "STALE", detail: "computed before the re-claim", at: T0 + 99 },
      }),
    );
    assert.match(problem, /is held by pid 22/);
    assert.match(problem, /refusing a write from pid 4242/);
  });

  it("REFUSES progress from a process that no longer holds the activity", () => {
    const successor = lease({ pid: 22, processStartedAt: 7 });
    const problem = problemOf(
      reportProgress([claimed({ state: "RUNNING", lease: successor })], claimed().id, { at: T0, progress: 9 }, lease()),
    );
    assert.match(problem, /refusing a write from pid 4242/);
  });

  it("ALLOWS the holder's own writes — the positive control", () => {
    const beat = reportProgress([claimed()], claimed().id, { at: T0 + 1, progress: 1 }, lease());
    assert.equal(beat.ok, true, beat.ok ? "" : beat.problem);
  });

  it("tells holders apart by START TIME, MACHINE and BOOT, not by pid alone", () => {
    for (const impostor of [
      lease({ processStartedAt: 1 }),
      lease({ machine: "another-host" }),
      lease({ boot: "another-boot" }),
    ]) {
      const problem = problemOf(
        completeActivity([claimed()], claimed().id, {
          state: "COMPLETED",
          holder: impostor,
          completion: { outcome: "PASS", detail: "x", at: T0 },
        }),
      );
      assert.match(problem, /refusing a write from pid/, JSON.stringify(impostor));
    }
  });

  it("REFUSES the same completion recorded under a different state", () => {
    const once = completeActivity([claimed()], claimed().id, { state: "COMPLETED", holder: lease(), completion });
    assert.equal(once.ok, true);
    if (!once.ok) throw new Error("unreachable");
    const problem = problemOf(
      completeActivity(once.activities, claimed().id, { state: "FAILED", holder: lease(), completion }),
    );
    assert.match(problem, /is COMPLETED but the same completion says FAILED/);
  });

  it("observing twice is a no-op, and observing an unfinished activity refuses", () => {
    const done = completeActivity([claimed()], claimed().id, { state: "COMPLETED", holder: lease(), completion });
    assert.equal(done.ok, true);
    if (!done.ok) throw new Error("unreachable");

    const first = observeCompletion(done.activities, claimed().id, T0 + 60);
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    assert.equal(first.changed, true);

    const second = observeCompletion(first.activities, claimed().id, T0 + 70);
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error("unreachable");
    assert.equal(second.changed, false);
    assert.deepEqual(second.activities, first.activities);

    assert.match(problemOf(observeCompletion([claimed()], claimed().id, T0)), /has nothing to observe/);
  });

  it("REFUSES progress that goes backwards, and repeats of the same report are free", () => {
    const first = reportProgress([claimed()], claimed().id, { at: T0 + 10, progress: 5 }, lease());
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    assert.equal(first.activities[0]?.state, "RUNNING");

    const repeat = reportProgress(first.activities, claimed().id, { at: T0 + 10, progress: 5 }, lease());
    assert.equal(repeat.ok, true);
    if (!repeat.ok) throw new Error("unreachable");
    assert.equal(repeat.changed, false);

    const forward = reportProgress(first.activities, claimed().id, { at: T0 + 20, progress: 6 }, lease());
    assert.equal(forward.ok, true, "progress must still be allowed to move");

    assert.match(
      problemOf(reportProgress(first.activities, claimed().id, { at: T0 + 20, progress: 4 }, lease())),
      /progress does not go backwards/,
    );
  });

  /**
   * ROUND-6 REVIEW, HIGH 1 — the reviewer's own reproduction.
   *
   * `heartbeat.at` used to be refreshed whenever the TIMESTAMP moved, even
   * with the count unchanged, so a process that heartbeated forever without
   * getting anywhere never became STALLED. That defeats the whole of AC-14 and
   * contradicts the reason `progress` is a count rather than a timestamp: "the
   * owner is alive" and "the owner is getting somewhere" are different
   * questions, and only the second is being asked.
   */
  it("does NOT refresh the stall clock when the count has not moved", () => {
    const first = reportProgress([claimed()], claimed().id, { at: T0 + 10, progress: 1 }, lease());
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");

    const repeated = reportProgress(first.activities, claimed().id, { at: T0 + 40, progress: 1 }, lease());
    assert.equal(repeated.ok, true);
    if (!repeated.ok) throw new Error("unreachable");
    assert.equal(repeated.changed, false, "an unchanged count moved the stall clock");
    assert.equal(repeated.activities[0]?.heartbeat?.at, T0 + 10, "`at` must mean when progress last MOVED");

    // ...and the activity is therefore STALLED, which is the point.
    //
    // `now` is well past the threshold rather than exactly on it: the check is
    // strictly greater-than, and the first version of this test sat on the
    // boundary and read LIVE for a reason that had nothing to do with the
    // defect under test.
    const verdict = classifyActivity(
      repeated.activities[0]!,
      { now: T0 + 100, stallAfterMs: 50 },
      probeWhere("ALIVE"),
    );
    assert.equal(verdict?.verdict, "STALLED", "repeated identical heartbeats prevented a stall");
  });

  it("DOES move the stall clock when the count advances — the positive control", () => {
    const first = reportProgress([claimed()], claimed().id, { at: T0 + 10, progress: 1 }, lease());
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    const moved = reportProgress(first.activities, claimed().id, { at: T0 + 40, progress: 2 }, lease());
    assert.equal(moved.ok, true);
    if (!moved.ok) throw new Error("unreachable");
    assert.equal(moved.changed, true);
    assert.equal(moved.activities[0]?.heartbeat?.at, T0 + 40);
    assert.equal(
      classifyActivity(moved.activities[0]!, { now: T0 + 60, stallAfterMs: 50 }, probeWhere("ALIVE"))?.verdict,
      "LIVE",
    );
  });

  it("REFUSES progress on an activity that already finished", () => {
    const done = completeActivity([claimed()], claimed().id, { state: "FAILED", holder: lease(), completion });
    assert.equal(done.ok, true);
    if (!done.ok) throw new Error("unreachable");
    assert.match(
      problemOf(reportProgress(done.activities, claimed().id, { at: T0 + 99, progress: 9 }, lease())),
      /already finished as FAILED/,
    );
  });

  it("REFUSES every transition against an id durable state does not hold, or holds twice", () => {
    for (const verdict of [
      reportProgress([], "nope", { at: T0, progress: 1 }, lease()),
      completeActivity([], "nope", { state: "COMPLETED", holder: lease(), completion }),
      observeCompletion([], "nope", T0),
      recordReconciliation([], "nope", { verdict: "LIVE", at: T0, detail: "x" }),
    ]) {
      assert.match(problemOf(verdict), /holds no activity "nope"/);
    }
    assert.match(
      problemOf(reportProgress([claimed(), claimed()], claimed().id, { at: T0, progress: 1 }, lease())),
      /2 times/,
    );
  });
});

// =====================================================================
// AC-15 / AC-19 — a result that exists is discoverable
// =====================================================================

describe("TASK-018 AC-15/AC-19: a finished activity cannot sit unnoticed", () => {
  const completion = { outcome: "PASS", detail: "verdict", at: T0 + 50 };

  it("lists a completion nothing has acted on", () => {
    const done = completeActivity([claimed()], claimed().id, { state: "COMPLETED", holder: lease(), completion });
    assert.equal(done.ok, true);
    if (!done.ok) throw new Error("unreachable");
    assert.deepEqual(
      unobservedCompletions(done.activities).map((entry) => entry.id),
      [claimed().id],
    );
  });

  it("stops listing it once something has, and never listed unfinished work", () => {
    const done = completeActivity([claimed()], claimed().id, { state: "COMPLETED", holder: lease(), completion });
    assert.equal(done.ok, true);
    if (!done.ok) throw new Error("unreachable");
    const seen = observeCompletion(done.activities, claimed().id, T0 + 60);
    assert.equal(seen.ok, true);
    if (!seen.ok) throw new Error("unreachable");
    assert.deepEqual(unobservedCompletions(seen.activities), []);
    assert.deepEqual(unobservedCompletions([claimed()]), [], "unfinished work was listed as a result");
  });

  it("lists a FAILED activity too, because a failure nobody noticed is the same problem", () => {
    const failed = completeActivity([claimed()], claimed().id, {
      state: "FAILED",
      holder: lease(),
      completion: { outcome: "CRASHED", detail: "no verdict", at: T0 + 5 },
    });
    assert.equal(failed.ok, true);
    if (!failed.ok) throw new Error("unreachable");
    assert.equal(unobservedCompletions(failed.activities).length, 1);
  });
});

// =====================================================================
// AC-16 / AC-20 — recording a conclusion is not acting on it
// =====================================================================

describe("TASK-018 AC-16/AC-20: recovery records knowledge and takes no authority", () => {
  it("records a verdict, and is idempotent about it", () => {
    const first = recordReconciliation([claimed()], claimed().id, {
      verdict: "CRASHED",
      at: T0 + 5,
      detail: "owner gone",
    });
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    assert.equal(first.changed, true);
    assert.equal(first.activities[0]?.reconciliation?.verdict, "CRASHED");

    const again = recordReconciliation(first.activities, claimed().id, {
      verdict: "CRASHED",
      at: T0 + 9,
      detail: "owner gone",
    });
    assert.equal(again.ok, true);
    if (!again.ok) throw new Error("unreachable");
    assert.equal(again.changed, false);
  });

  it("does NOT finish the activity, free its lease, or invent a completion", () => {
    const recorded = recordReconciliation([claimed({ state: "RUNNING" })], claimed().id, {
      verdict: "CRASHED",
      at: T0 + 5,
      detail: "owner gone",
    });
    assert.equal(recorded.ok, true);
    if (!recorded.ok) throw new Error("unreachable");
    const activity = recorded.activities[0]!;
    assert.equal(activity.state, "RUNNING", "reconciliation finished the activity");
    assert.equal(activity.completion, undefined, "reconciliation invented a completion");
    assert.deepEqual(activity.lease, lease(), "reconciliation freed the lease");
    assert.equal(activity.observedAt, undefined);
    // ...and a CRASHED activity is still not a result anything may act on.
    assert.deepEqual(unobservedCompletions(recorded.activities), []);
  });
});
