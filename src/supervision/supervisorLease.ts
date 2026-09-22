/**
 * Exactly one supervisor owns a Factory at a time (TASK-019 AC-17).
 *
 * WHY THIS IS NOT `pgrep`. Every ownership question this repository has got
 * wrong was got wrong by asking the process table: a name matches a process
 * that is not ours, a pid is recycled, a second machine cannot see the first
 * one's table at all, and nothing in `ps` survives the answer being needed
 * after a reboot. Ownership is a fact about the FACTORY, so it lives in the
 * Factory's durable state, and it is taken by the same compare-and-set every
 * other durable fact is.
 *
 * The lease is the one TASK-018 already defined — pid, process start tick,
 * machine and boot id — because the question "is the holder still running" has
 * exactly one correct answer and it should not have two implementations.
 *
 * THE THREE OUTCOMES, and why there is no fourth:
 *
 *   - the holder is ALIVE: this process stands down. It does not wait, retry or
 *     proceed alongside. Two supervisors advancing one state machine is the
 *     duplicate-owner failure the whole mechanism exists to prevent.
 *   - the holder is GONE: the lease is dead and may be taken.
 *   - the holder is UNKNOWN: refuse. A lease this process cannot resolve —
 *     another machine, an unreadable `/proc` — settles nothing, and "unknown
 *     refuses" is the rule everywhere else here.
 */

import type { Timestamp } from "../domain/time.js";

import { type ActivityLease, type LivenessProbe } from "./activity.js";

export interface SupervisorOwner {
  /** Who holds it: the lease is the identity, `ownerId` is for humans reading. */
  readonly lease: ActivityLease;
  readonly ownerId: string;
  readonly acquiredAt: Timestamp;
  /**
   * When the holder last proved it was still working.
   *
   * A lease with a live pid and a stale heartbeat is a hung supervisor, which is
   * a different thing from a dead one and is not taken over here: killing the
   * holder is an operator's decision. What this records is the fact, so the
   * status command can show it and a human is not left guessing.
   */
  readonly renewedAt: Timestamp;
}

export type LeaseVerdict =
  | { readonly ok: true; readonly owner: SupervisorOwner; readonly changed: boolean }
  | { readonly ok: false; readonly problem: string; readonly heldBy?: SupervisorOwner };

function sameLease(a: ActivityLease, b: ActivityLease): boolean {
  return a.pid === b.pid && a.processStartedAt === b.processStartedAt && a.machine === b.machine && a.boot === b.boot;
}

/**
 * Takes the lease, renews it, or explains who has it.
 *
 * Pure: it decides, and the caller writes through compare-and-set. Two
 * processes reaching the same decision is therefore harmless — exactly one
 * write wins, and the loser re-reads and finds a live holder.
 */
export function acquireSupervisorLease(
  current: SupervisorOwner | undefined,
  input: {
    readonly lease: ActivityLease;
    readonly ownerId: string;
    readonly now: Timestamp;
  },
  probe: LivenessProbe,
): LeaseVerdict {
  const taken: SupervisorOwner = {
    lease: input.lease,
    ownerId: input.ownerId,
    acquiredAt: input.now,
    renewedAt: input.now,
  };

  if (current === undefined) {
    return { ok: true, owner: taken, changed: true };
  }

  /**
   * OURS ALREADY: this is a renewal, not an acquisition.
   *
   * Compared by the LEASE and not by `ownerId`, because a restarted process can
   * legitimately reuse an owner name and must not thereby inherit the identity
   * of the run that died.
   */
  if (sameLease(current.lease, input.lease)) {
    return {
      ok: true,
      owner: { ...current, renewedAt: input.now },
      changed: current.renewedAt !== input.now,
    };
  }

  const liveness = probe.check(current.lease);
  if (liveness === "ALIVE") {
    return {
      ok: false,
      problem:
        `this Factory is supervised by pid ${current.lease.pid} on ${JSON.stringify(current.lease.machine)} ` +
        `(${current.ownerId}), which is still running; standing down`,
      heldBy: current,
    };
  }
  if (liveness === "UNKNOWN") {
    return {
      ok: false,
      problem:
        `this Factory's supervisor lease names pid ${current.lease.pid} on ` +
        `${JSON.stringify(current.lease.machine)}, and whether that process is still running cannot be established ` +
        "from here; refusing to take over a lease that may still be someone's",
      heldBy: current,
    };
  }

  return { ok: true, owner: { ...taken, acquiredAt: input.now }, changed: true };
}

/**
 * Whether a lease should be released rather than renewed.
 *
 * Releasing on a clean exit is a courtesy, not a guarantee: a killed supervisor
 * releases nothing, which is precisely why the lease carries liveness rather
 * than depending on anyone tidying up after themselves.
 */
export function releasedBy(current: SupervisorOwner | undefined, lease: ActivityLease): boolean {
  return current !== undefined && sameLease(current.lease, lease);
}
