/**
 * TASK-018 PART B — DURABLE ORCHESTRATION, as pure logic.
 *
 * ================================================================
 * WHAT THIS IS FOR
 * ================================================================
 * TASK-017 took twenty-four review rounds, and a large share of the wall-clock
 * cost was not review or remediation. It was orchestration failing unobserved:
 *
 *   - the continuation owner was a shell script in a scratchpad with no schema,
 *     no tests and no recovery, so when it died nothing knew;
 *   - a finished review sat unnoticed for hours, because nothing emitted a
 *     completion event and the only way to learn of it was for a human to ask;
 *   - work was reported as running three times when no process had been
 *     started, and the correction was a discipline note — a promise, where a
 *     lease with a live PID would have been a fact;
 *   - a killed mutation run left the tree poisoned twice.
 *
 * The durable state this repository defends — SQLite, the hash chain, the
 * roadmap — was never the problem. The state of work IN FLIGHT was.
 *
 * ================================================================
 * WHY THIS IS NOT `SupervisorActionClaim`
 * ================================================================
 * That type already records a durable claim, and reusing it was the first
 * thing considered. It cannot serve, for three reasons that are about the
 * QUESTION being asked rather than about convenience:
 *
 *   1. There is exactly one `activeClaim`. An activity is one of several
 *      long-running things that can be in flight at once.
 *   2. Its `ownerId` is an opaque string. AC-12 requires that holding a lease
 *      be a FACT about a process that is still alive, and a string cannot be
 *      checked against the process table.
 *   3. A claim is about an action the supervisor LAUNCHES and then awaits. An
 *      activity is work whose completion must be discoverable by a process that
 *      was never told about it (AC-15, AC-19).
 *
 * Claims are untouched. This sits beside them.
 *
 * ================================================================
 * THE INVARIANT
 * ================================================================
 * Recovery restores knowledge, never authority. Nothing here infers that an
 * unfinished thing succeeded, resumes a step whose evidence is gone, or changes
 * an item's status. Every unknown resolves to REFUSE — which is why `UNKNOWN`
 * liveness produces `AMBIGUOUS` and not a guess in either direction.
 *
 * PURE. No clock, no filesystem, no process table: every fact arrives as an
 * argument, so each refusal can be driven directly in a test, and so the caller
 * that owns the transaction is the only thing that can write.
 */

import type { Timestamp } from "../domain/time.js";

import type { ReviewBinding } from "./acceptance.js";

/**
 * The states an activity is RECORDED in.
 *
 * Deliberately four, and deliberately not including "crashed" or "stalled":
 * those are not things an activity does, they are conclusions a later observer
 * DRAWS about a record its owner stopped updating. Storing them as states would
 * mean a dead process had to write its own death certificate.
 */
export const ACTIVITY_STATES = [
  /** A lease exists and no work has been reported yet. Nothing external ran. */
  "CLAIMED",
  /** Progress has been reported at least once. */
  "RUNNING",
  /** Finished, with an outcome its owner recorded. */
  "COMPLETED",
  /** Finished, and its owner recorded that it did not succeed. */
  "FAILED",
] as const;

export type ActivityState = (typeof ACTIVITY_STATES)[number];

/** The states from which nothing further happens. */
export const TERMINAL_ACTIVITY_STATES: readonly ActivityState[] = ["COMPLETED", "FAILED"];

export function isTerminal(state: ActivityState): boolean {
  return TERMINAL_ACTIVITY_STATES.includes(state);
}

/**
 * WHO holds an activity, in terms that can be CHECKED rather than believed.
 *
 * `pid` alone is not an identity: process ids are reused, and a lease naming a
 * pid that now belongs to an unrelated process would read as alive forever
 * (AC-16 names exactly that case). `startedAt` is the owning process's own
 * start time, which together with the pid is unique on a machine for as long as
 * anyone cares. `machine` is recorded because a pid from another host says
 * nothing here, and "not this machine" must be UNKNOWN rather than dead.
 */
export interface ActivityLease {
  readonly pid: number;
  /** The OWNING PROCESS's start time, not the lease's. This is the anti-reuse half. */
  readonly processStartedAt: number;
  readonly machine: string;
  /**
   * WHICH BOOT of that machine (round-2 review, HIGH 2).
   *
   * `processStartedAt` comes from `/proc/<pid>/stat` field 22, which counts
   * ticks SINCE BOOT. After a restart the counter starts again, so an unrelated
   * process can legitimately hold the same pid AND the same start tick — and
   * `machine` does not separate them, because a machine identity is stable
   * across reboots by design. All three matched and the lease read ALIVE for a
   * process that had never existed when it was written.
   *
   * A boot identity is the missing third of the tuple: pid and start tick are
   * unique WITHIN a boot, and this says which boot. It also makes the WSL
   * restart of AC-18 decidable rather than argued — every lease from a previous
   * boot is knowably dead.
   */
  readonly boot: string;
  readonly claimedAt: Timestamp;
}

export interface ActivityHeartbeat {
  readonly at: Timestamp;
  /**
   * Monotonic count of units of work reported.
   *
   * A COUNT rather than a timestamp alone, because "the owner is alive" and
   * "the owner is getting somewhere" are different questions and AC-14 asks the
   * second one. A process that heartbeats forever without this moving is
   * stalled, and a stall that only a human notices is the failure this task
   * exists to remove.
   */
  readonly progress: number;
}

export interface ActivityCompletion {
  readonly outcome: string;
  readonly detail: string;
  readonly at: Timestamp;
}

/** What a later observer concluded about a record nobody is updating. */
export const RECONCILIATION_VERDICTS = ["LIVE", "CRASHED", "AMBIGUOUS", "STALLED", "NEVER_STARTED"] as const;
export type ReconciliationVerdict = (typeof RECONCILIATION_VERDICTS)[number];

export interface ActivityReconciliation {
  readonly verdict: ReconciliationVerdict;
  readonly at: Timestamp;
  readonly detail: string;
}

export interface Activity {
  /** Derived from what the activity IS, never random — the TASK-004 lesson. */
  readonly id: string;
  readonly kind: string;
  readonly roadmapKey: string;
  readonly state: ActivityState;
  readonly lease?: ActivityLease;
  readonly heartbeat?: ActivityHeartbeat;
  readonly completion?: ActivityCompletion;
  /**
   * When something OTHER than the owner noticed the completion (AC-19).
   *
   * Absent on a completed activity means the result exists and nobody has acted
   * on it — precisely the state that went unnoticed for hours during TASK-017,
   * and the one reconciliation exists to surface.
   */
  readonly observedAt?: Timestamp;
  readonly reconciliation?: ActivityReconciliation;
  /**
   * Present when this activity IS a review, and says what it reviews and where
   * it will report (TASK-018 round-7 gap).
   *
   * Recorded when the review is launched, so the binding survives the process
   * that launched it. A later supervisor — a cold start, hours afterwards, with
   * no memory and no notification — has everything it needs to find the verdict
   * and to refuse one that belongs to a different candidate.
   */
  readonly review?: ReviewBinding;
  readonly updatedAt: Timestamp;
}

/**
 * The reviews whose verdicts are still worth reading.
 *
 * A review that has already reached a terminal state is finished business, and
 * re-reading its source would let a verdict file that outlives its round be
 * applied twice. Idempotence is expressed here, as "which activities do we even
 * look at", rather than inside the consumer: the consumer runs on every tick
 * forever, and the cheapest guard is the one that cannot be forgotten.
 */
export function reviewsAwaitingVerdict(activities: readonly Activity[]): readonly Activity[] {
  return activities.filter((activity) => activity.review !== undefined && !isTerminal(activity.state));
}

/** THE only legitimate way an activity id comes into existence. */
export function canonicalActivityId(roadmapKey: string, kind: string, attempt: number): string {
  return `${roadmapKey}:${kind}:r${attempt}`;
}

/**
 * Whether the process named by a lease is still there.
 *
 * `UNKNOWN` is a first-class answer and not a failure of the check: a lease
 * from another machine, or a process table this process may not read, is
 * genuinely unknowable from here, and the invariant says an unknown refuses
 * rather than being resolved in whichever direction is convenient.
 */
export type Liveness = "ALIVE" | "GONE" | "UNKNOWN";

export interface LivenessProbe {
  check(lease: ActivityLease): Liveness;
}

export type ClaimVerdict =
  | { readonly ok: true; readonly activities: readonly Activity[]; readonly activity: Activity }
  | { readonly ok: false; readonly problem: string };

/**
 * Takes ownership of an activity, or explains who has it (AC-12, AC-13).
 *
 * REFUSES rather than waiting, stealing or proceeding alongside. Waiting would
 * make a second supervisor hang on a first that may never finish; stealing is
 * how two mutation runs poisoned the same tree; and proceeding alongside is the
 * duplicate-owner state this exists to make impossible.
 */
export function claimActivity(
  activities: readonly Activity[],
  request: {
    readonly id: string;
    readonly kind: string;
    readonly roadmapKey: string;
    readonly lease: ActivityLease;
    readonly now: Timestamp;
  },
  probe: LivenessProbe,
): ClaimVerdict {
  if (activities.filter((entry) => entry.id === request.id).length > 1) {
    return { ok: false, problem: `durable state holds ${JSON.stringify(request.id)} more than once` };
  }

  /**
   * THE INCOMING LEASE MUST NAME A LIVE PROCESS (round-1 review, HIGH 2).
   *
   * Liveness was checked only for the EXISTING holder, so a claim carrying a
   * lease for a process that had already died — or one this host cannot check —
   * was accepted and written. The record then says an activity is owned by
   * something that will never report progress, never complete it, and never
   * release it, and the next reconciliation has to discover that separately.
   *
   * A claim is a statement that THIS process is about to do the work. If the
   * process it names is not running, the statement is already false.
   */
  const mine = probe.check(request.lease);
  if (mine !== "ALIVE") {
    return {
      ok: false,
      problem:
        `refusing to claim ${JSON.stringify(request.id)} for pid ${request.lease.pid} on ` +
        `${JSON.stringify(request.lease.machine)}: that process is ${mine === "GONE" ? "not running" : "not checkable from here"}`,
    };
  }

  const existing = activities.find((entry) => entry.id === request.id);

  if (existing !== undefined) {
    if (isTerminal(existing.state)) {
      /**
       * A finished activity is not re-claimable under the same id. Ids are
       * derived from (item, kind, attempt), so a legitimate retry is a NEW
       * attempt with a new id; re-claiming this one would overwrite a result
       * that something may not have observed yet.
       */
      return {
        ok: false,
        problem:
          `activity ${JSON.stringify(request.id)} already finished as ${existing.state}; ` +
          "a retry is a new attempt, not a second claim on this one",
      };
    }
    /**
     * The lease is HOISTED, and that is not a style choice.
     *
     * Reading `existing.lease.pid` inside each branch makes the narrowing
     * depend on the branches, so removing one — which is precisely what a
     * mutation does — stops the file compiling and the harness reports
     * UNMEASURED instead of measuring the guard. Preflight caught exactly that
     * on three of these. A guard that cannot be mutated is a guard nothing
     * proves, so the code is shaped to let each one be removed on its own.
     */
    const held = existing.lease;
    if (held === undefined) {
      /**
       * A NON-TERMINAL ACTIVITY WITH NO LEASE IS AMBIGUOUS, NOT FREE (round-1
       * review, HIGH 2). Nothing here can say whether something is working on
       * it, and "no owner is recorded" is not the same fact as "no owner
       * exists". Taking it would be resolving an unknown in the convenient
       * direction, which is the one thing this mechanism may never do.
       */
      return {
        ok: false,
        problem:
          `activity ${JSON.stringify(request.id)} is ${existing.state} with no lease recorded, so whether ` +
          "anything is still working on it cannot be established",
      };
    }
    {
      const liveness = probe.check(held);
      if (liveness === "ALIVE") {
        return {
          ok: false,
          problem:
            `activity ${JSON.stringify(request.id)} is held by pid ${held.pid} on ` +
            `${JSON.stringify(held.machine)}, which is still running`,
        };
      }
      if (liveness === "UNKNOWN") {
        /**
         * The ONLY safe answer. Taking a lease whose holder cannot be checked
         * is how two owners end up writing at once, and the whole point of this
         * mechanism is that a second owner is refused rather than merged.
         */
        return {
          ok: false,
          problem:
            `activity ${JSON.stringify(request.id)} is held by pid ${held.pid} on ` +
            `${JSON.stringify(held.machine)}, and whether it is still running cannot be established here`,
        };
      }
    }
  }

  const claimed: Activity = {
    id: request.id,
    kind: request.kind,
    roadmapKey: request.roadmapKey,
    state: "CLAIMED",
    lease: request.lease,
    updatedAt: request.now,
  };
  const activity = existing === undefined ? claimed : { ...claimed, ...carriedForward(existing) };
  return {
    ok: true,
    activity,
    activities:
      existing === undefined
        ? [...activities, activity]
        : activities.map((entry) => (entry.id === activity.id ? activity : entry)),
  };
}

/**
 * What survives a re-claim after the previous holder died.
 *
 * Progress facts, and nothing that confers authority: no completion, no
 * observation, and no stale reconciliation verdict about a holder that is now
 * gone. Recovery restores knowledge, never authority.
 */
function carriedForward(previous: Activity): Partial<Activity> {
  return previous.heartbeat === undefined ? {} : { heartbeat: previous.heartbeat };
}

/**
 * Classifies an activity nobody is necessarily updating (AC-14, AC-16).
 *
 * The order matters and is the argument for the whole function. A TERMINAL
 * record is a fact its owner wrote, so it is never reinterpreted. Otherwise
 * liveness decides first — a dead owner is CRASHED however recent its last
 * heartbeat — because "it was making progress a moment ago" says nothing about
 * whether anything is still running. Only a LIVE owner can be STALLED, and only
 * a live owner that never reported anything is NEVER_STARTED, which is the
 * state "I said I was launching it but no process was actually started" leaves
 * behind.
 */
export function classifyActivity(
  activity: Activity,
  input: { readonly now: Timestamp; readonly stallAfterMs: number },
  probe: LivenessProbe,
): { readonly verdict: ReconciliationVerdict; readonly detail: string } | undefined {
  if (isTerminal(activity.state)) {
    return undefined;
  }
  // HOISTED for the same reason as in `claimActivity`: so that each branch
  // below can be removed by a mutation without the file ceasing to compile.
  const held = activity.lease;
  if (held === undefined) {
    return {
      verdict: "AMBIGUOUS",
      detail: `activity ${JSON.stringify(activity.id)} is ${activity.state} with no lease, so no owner can be checked`,
    };
  }

  const liveness = probe.check(held);
  if (liveness === "GONE") {
    return {
      verdict: "CRASHED",
      detail:
        `activity ${JSON.stringify(activity.id)} was ${activity.state} and its owner (pid ${held.pid}) ` +
        "is gone, so what it had done is unknown",
    };
  }
  if (liveness === "UNKNOWN") {
    return {
      verdict: "AMBIGUOUS",
      detail:
        `activity ${JSON.stringify(activity.id)} is held by pid ${held.pid} on ` +
        `${JSON.stringify(held.machine)}, and whether it is still running cannot be established here`,
    };
  }

  if (activity.heartbeat === undefined) {
    const waited = input.now - held.claimedAt;
    if (waited > input.stallAfterMs) {
      return {
        verdict: "NEVER_STARTED",
        detail:
          `activity ${JSON.stringify(activity.id)} has been claimed for ${waited}ms by a live pid ` +
          `${held.pid} and has never reported progress`,
      };
    }
    return { verdict: "LIVE", detail: `activity ${JSON.stringify(activity.id)} was claimed ${waited}ms ago` };
  }

  const since = input.now - activity.heartbeat.at;
  if (since > input.stallAfterMs) {
    return {
      verdict: "STALLED",
      detail:
        `activity ${JSON.stringify(activity.id)} last reported progress ${since}ms ago ` +
        `(threshold ${input.stallAfterMs}ms), and its owner is still running`,
    };
  }
  return {
    verdict: "LIVE",
    detail: `activity ${JSON.stringify(activity.id)} reported progress ${since}ms ago`,
  };
}

/**
 * Completions nothing has acted on yet (AC-19).
 *
 * The answer to "the result has existed for hours but nobody noticed". A
 * notification that is never delivered changes nothing here, because this reads
 * the record rather than waiting to be told.
 */
export function unobservedCompletions(activities: readonly Activity[]): readonly Activity[] {
  return activities.filter((entry) => isTerminal(entry.state) && entry.observedAt === undefined);
}

/**
 * The ONLY status recovery may move an item out of, and the only one it may
 * move it to (AC-20).
 *
 * A crashed owner's item goes ACTIVE -> PENDING and nothing else. That single
 * pair is what makes the Factory self-healing — without it a crash parks the
 * item until a human notices, which is the state this whole task exists to
 * remove — and it is also what makes recovery safe, because it only ever moves
 * an item BACKWARDS into the queue it came from.
 *
 * A LIST OF PROTECTED STATUSES WAS WRITTEN HERE FIRST AND THEN DELETED, which
 * is worth recording because the deletion is the finding. It named DONE,
 * BLOCKED and WAITING_FOR_HUMAN_REQUIRED and refused them — and an item cannot
 * be ACTIVE and also be any of those, so `status === "ACTIVE"` below already
 * excluded every one of them. The clause could never be the sole reason for a
 * refusal, and this repository has deleted five such clauses already. Keeping a
 * sixth because it reads like a safety check is how a register of guards turns
 * into decoration, and a mutation aimed at it would have been caught by the
 * ACTIVE test instead — the sibling masking found in round 1 of Part A,
 * repeated deliberately.
 *
 * What AC-20 actually requires is proven by the direction of the move, and the
 * mutation that matters turns PENDING into anything further forward.
 */
export const RECOVERY_FROM_STATUS = "ACTIVE" as const;
export const RECOVERY_TO_STATUS = "PENDING" as const;

/**
 * Which roadmap items a crashed activity should return to the queue.
 *
 * This is the only thing in this module that proposes an ACTION rather than
 * recording a fact. It proposes; the caller decides and writes.
 */
export function crashedItemsToRequeue(
  activities: readonly Activity[],
  roadmap: readonly { readonly key: string; readonly status: string }[],
): readonly string[] {
  const requeue = new Set<string>();

  for (const activity of activities) {
    if (activity.reconciliation?.verdict !== "CRASHED") continue;
    const item = roadmap.find((entry) => entry.key === activity.roadmapKey);
    if (item === undefined) continue;
    /**
     * Only an item the crashed owner was actually working on. Every other
     * status is one somebody else put it in — a human gate, a blocker, a
     * result — and moving it would be recovery taking a decision instead of
     * restoring knowledge.
     */
    if (item.status !== RECOVERY_FROM_STATUS) continue;
    requeue.add(item.key);
  }
  return [...requeue];
}

export type TransitionVerdict =
  | { readonly ok: true; readonly activities: readonly Activity[]; readonly changed: boolean }
  | { readonly ok: false; readonly problem: string };

function locate(
  activities: readonly Activity[],
  id: string,
): { readonly ok: true; readonly activity: Activity } | { readonly ok: false; readonly problem: string } {
  const found = activities.filter((entry) => entry.id === id);
  if (found.length === 0) {
    return { ok: false, problem: `durable state holds no activity ${JSON.stringify(id)}` };
  }
  if (found.length > 1) {
    return { ok: false, problem: `durable state holds ${JSON.stringify(id)} ${found.length} times` };
  }
  return { ok: true, activity: found[0]! };
}

function replace(activities: readonly Activity[], next: Activity): readonly Activity[] {
  return activities.map((entry) => (entry.id === next.id ? next : entry));
}

/**
 * Whether two leases name the same holder.
 *
 * All four fields, because each closes a different way of being a different
 * process: the pid, the start tick that separates a reused pid, the machine,
 * and the boot that separates a restart. `claimedAt` is deliberately NOT
 * compared — it is when the lease was taken, not who took it.
 */
function sameHolder(a: ActivityLease, b: ActivityLease): boolean {
  return (
    a.pid === b.pid &&
    a.processStartedAt === b.processStartedAt &&
    a.machine === b.machine &&
    a.boot === b.boot
  );
}

/**
 * REFUSES A WRITE FROM ANYONE BUT THE CURRENT HOLDER (round-5 review, HIGH 2).
 *
 * `completeActivity` was keyed only by activity id, so a completion computed
 * before a re-claim could be applied after it: the reviewer drove exactly that
 * and got a COMPLETED activity whose lease belonged to one process and whose
 * outcome had been produced by another. The retry added in round 4 made it
 * reachable, because re-applying against fresher state is precisely the moment
 * the holder may have changed underneath.
 *
 * So progress and completion now carry the lease their writer believes it
 * holds, and a disagreement refuses. An id says WHICH activity; it has never
 * said who is entitled to write to it.
 */
function heldBy(
  activity: Activity,
  holder: ActivityLease,
): { readonly ok: true } | { readonly ok: false; readonly problem: string } {
  if (activity.lease === undefined) {
    return {
      ok: false,
      problem: `activity ${JSON.stringify(activity.id)} records no lease, so no writer can be the holder`,
    };
  }
  if (!sameHolder(activity.lease, holder)) {
    return {
      ok: false,
      problem:
        `activity ${JSON.stringify(activity.id)} is held by pid ${activity.lease.pid} on ` +
        `${JSON.stringify(activity.lease.machine)}; refusing a write from pid ${holder.pid} on ` +
        `${JSON.stringify(holder.machine)}`,
    };
  }
  return { ok: true };
}

/**
 * IDEMPOTENCE, AS ONE RULE RATHER THAN FOUR (AC-17).
 *
 * Every transition below answers the same three-way question: is this already
 * done (no-op), not yet done (apply), or done DIFFERENTLY (refuse)? The third
 * branch is the one that matters. "Applying twice has the same effect as once"
 * is easy to satisfy by making the second write win, and that would silently
 * accept two owners disagreeing about what happened — which is exactly the
 * half-applied state the criterion is about.
 *
 * So a repeat with the same content is free, and a repeat with different
 * content is a refusal naming both.
 */
/**
 * A record's content, independent of the order its keys were written in.
 *
 * `JSON.stringify` preserves insertion order, so two records that are the same
 * record refused each other as a disagreement if their fields had been built in
 * a different sequence (round-4 review, non-blocking note). That is fail-closed
 * and so not dangerous, but it is wrong: it would make a legitimate replay —
 * the very thing AC-17 asks to be free — look like two owners contradicting
 * each other.
 *
 * Sorting the keys removes the ordering without weakening the comparison: the
 * field boundaries stay escaped, so the delimiter collision that HIGH 3 of
 * round 1 found stays closed.
 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (nested === null || typeof nested !== "object" || Array.isArray(nested)) {
      return nested;
    }
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(nested as Record<string, unknown>).sort()) {
      ordered[key] = (nested as Record<string, unknown>)[key];
    }
    return ordered;
  });
}

function settle<T>(
  current: T | undefined,
  incoming: T,
  describe: (value: T) => string,
  what: string,
  id: string,
): { readonly kind: "noop" } | { readonly kind: "apply" } | { readonly kind: "refuse"; readonly problem: string } {
  if (current === undefined) {
    return { kind: "apply" };
  }
  /**
   * COMPARED STRUCTURALLY, NOT BY A CONCATENATED STRING (round-1 review, HIGH 3).
   *
   * `describe` joined the fields with delimiters, and delimiters collide:
   * `{outcome: "a/b", detail: "c"}` and `{outcome: "a", detail: "b/c"}`
   * produced the same text, so two genuinely different completions were
   * accepted as an idempotent repeat and the disagreement vanished silently.
   * That is precisely the "two owners disagree and nobody hears about it" case
   * this function exists to refuse.
   *
   * `JSON.stringify` of the value escapes the field boundaries, so no choice of
   * content can make two different records look alike. `describe` survives for
   * the MESSAGE, where readability is the only requirement.
   */
  if (canonical(current) === canonical(incoming)) {
    return { kind: "noop" };
  }
  return {
    kind: "refuse",
    problem:
      `activity ${JSON.stringify(id)} already recorded ${what} as ${describe(current)}; ` +
      `refusing to replace it with ${describe(incoming)}`,
  };
}

/** Records that the owner got somewhere. Progress may not go backwards. */
export function reportProgress(
  activities: readonly Activity[],
  id: string,
  heartbeat: ActivityHeartbeat,
  holder: ActivityLease,
): TransitionVerdict {
  const found = locate(activities, id);
  if (!found.ok) return found;
  const activity = found.activity;

  const owned = heldBy(activity, holder);
  if (!owned.ok) return owned;

  if (isTerminal(activity.state)) {
    return { ok: false, problem: `activity ${JSON.stringify(id)} already finished as ${activity.state}` };
  }
  const previous = activity.heartbeat;
  if (previous !== undefined && heartbeat.progress < previous.progress) {
    /**
     * Progress that goes backwards means two owners, or a replay of an older
     * report. Either way the record would stop meaning what AC-14 needs it to
     * mean, so it is refused rather than accepted as the newest word.
     */
    return {
      ok: false,
      problem:
        `activity ${JSON.stringify(id)} reported progress ${heartbeat.progress} after ${previous.progress}; ` +
        "progress does not go backwards",
    };
  }
  /**
   * A REPEAT OF THE SAME COUNT CHANGES NOTHING, WHATEVER ITS TIMESTAMP
   * (round-6 review, HIGH 1).
   *
   * This used to refresh `at` whenever the timestamp moved, even with the count
   * unchanged — so a process that heartbeated forever without getting anywhere
   * never became STALLED. That defeats the whole of AC-14, and it contradicts
   * the reason `progress` is a COUNT rather than a timestamp, which is written
   * three fields above this line: "the owner is alive" and "the owner is
   * getting somewhere" are different questions, and only the second one is
   * being asked here.
   *
   * `heartbeat.at` therefore means "when progress last MOVED". A live owner
   * that has stopped moving is exactly what STALLED is for.
   */
  if (previous !== undefined && previous.progress === heartbeat.progress) {
    return { ok: true, activities, changed: false };
  }
  return {
    ok: true,
    changed: true,
    activities: replace(activities, { ...activity, state: "RUNNING", heartbeat, updatedAt: heartbeat.at }),
  };
}

/** Records the outcome its owner saw. The completion event of AC-15. */
export function completeActivity(
  activities: readonly Activity[],
  id: string,
  input: {
    readonly state: "COMPLETED" | "FAILED";
    readonly completion: ActivityCompletion;
    /** The lease the writer believes it holds. A disagreement refuses. */
    readonly holder: ActivityLease;
  },
): TransitionVerdict {
  const found = locate(activities, id);
  if (!found.ok) return found;
  const activity = found.activity;

  const owned = heldBy(activity, input.holder);
  if (!owned.ok) return owned;

  const settled = settle(
    activity.completion,
    input.completion,
    (value) => `${value.outcome}/${value.detail}@${value.at}`,
    "a completion",
    id,
  );
  if (settled.kind === "refuse") return { ok: false, problem: settled.problem };
  if (settled.kind === "noop") {
    if (activity.state !== input.state) {
      return {
        ok: false,
        problem: `activity ${JSON.stringify(id)} is ${activity.state} but the same completion says ${input.state}`,
      };
    }
    return { ok: true, activities, changed: false };
  }
  return {
    ok: true,
    changed: true,
    activities: replace(activities, {
      ...activity,
      state: input.state,
      completion: input.completion,
      updatedAt: input.completion.at,
    }),
  };
}

/**
 * Settles a REVIEW from the artefact it produced, without being its owner.
 *
 * THE HOLDER RULE IS NOT BEING WEAKENED, so it is worth being exact about why
 * this is allowed to exist. `completeActivity` requires the writer's lease
 * because the outcome there is something the writer COMPUTED: a process that
 * lost ownership while its work ran must not apply a conclusion only it
 * believes, which is round-5's HIGH 2.
 *
 * A review verdict is not computed by anyone in the Factory. It is a durable
 * artefact, written by an independent process, naming the exact candidate it
 * judged — and the caller has already checked that naming against the binding
 * recorded when the review was launched. Requiring the reviewer's own lease to
 * apply it would mean a verdict is only usable while its author is still alive,
 * which is precisely the twenty-two-hour failure this exists to remove: the
 * reviewer exits the moment it writes.
 *
 * So the guard is different, not absent. The activity must BE a review, its
 * owner must not still be working (the caller establishes that; a live owner is
 * skipped, never overruled), and a settlement that DISAGREES with one already
 * recorded refuses exactly as `completeActivity` does. The observation is
 * written in the same breath, because whoever applies a verdict is by
 * definition the thing that noticed it.
 */
export function settleReview(
  activities: readonly Activity[],
  id: string,
  input: {
    readonly state: "COMPLETED" | "FAILED";
    readonly completion: ActivityCompletion;
    readonly at: Timestamp;
  },
): TransitionVerdict {
  const found = locate(activities, id);
  if (!found.ok) return found;
  const activity = found.activity;

  if (activity.review === undefined) {
    return {
      ok: false,
      problem: `activity ${JSON.stringify(id)} is not a review, so no verdict can settle it`,
    };
  }

  const settled = settle(
    activity.completion,
    input.completion,
    (value) => `${value.outcome}/${value.detail}@${value.at}`,
    "a completion",
    id,
  );
  if (settled.kind === "refuse") return { ok: false, problem: settled.problem };
  if (settled.kind === "noop") {
    if (activity.state !== input.state) {
      return {
        ok: false,
        problem: `activity ${JSON.stringify(id)} is ${activity.state} but the same verdict says ${input.state}`,
      };
    }
    return activity.observedAt === undefined
      ? { ok: true, changed: true, activities: replace(activities, { ...activity, observedAt: input.at }) }
      : { ok: true, activities, changed: false };
  }
  return {
    ok: true,
    changed: true,
    activities: replace(activities, {
      ...activity,
      state: input.state,
      completion: input.completion,
      observedAt: input.at,
      updatedAt: input.completion.at,
    }),
  };
}

/**
 * Records that something acted on a finished activity (AC-19).
 *
 * Separate from completing it, because the two are done by different processes
 * at different times — and collapsing them is what made a finished review
 * invisible: the owner knew, and nothing else did.
 */
export function observeCompletion(activities: readonly Activity[], id: string, at: Timestamp): TransitionVerdict {
  const found = locate(activities, id);
  if (!found.ok) return found;
  const activity = found.activity;

  if (!isTerminal(activity.state)) {
    return { ok: false, problem: `activity ${JSON.stringify(id)} is ${activity.state} and has nothing to observe` };
  }
  if (activity.observedAt !== undefined) {
    return { ok: true, activities, changed: false };
  }
  return { ok: true, changed: true, activities: replace(activities, { ...activity, observedAt: at }) };
}

/**
 * Writes down what a later observer concluded (AC-16).
 *
 * It records the VERDICT and nothing else. It does not finish the activity,
 * free the lease, or touch the roadmap — a conclusion about a dead process is
 * knowledge, and acting on it is a decision with its own gates.
 */
export function recordReconciliation(
  activities: readonly Activity[],
  id: string,
  reconciliation: ActivityReconciliation,
): TransitionVerdict {
  const found = locate(activities, id);
  if (!found.ok) return found;
  const activity = found.activity;

  const previous = activity.reconciliation;
  if (previous !== undefined && previous.verdict === reconciliation.verdict && previous.detail === reconciliation.detail) {
    return { ok: true, activities, changed: false };
  }
  return {
    ok: true,
    changed: true,
    activities: replace(activities, { ...activity, reconciliation }),
  };
}
