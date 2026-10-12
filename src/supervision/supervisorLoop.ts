/**
 * The process that owns a Factory and keeps it moving (TASK-019).
 *
 * WHAT THIS REPLACES, and why it is not another watcher. TASK-018 built durable
 * activity state and durable verdict consumption, proved both against a real
 * database from a cold start, and did not close the gap — because nothing in
 * production RAN. Three of its own acceptance rounds ended the same way: a
 * correct verdict on disk, no process whose job it was to notice, and
 * remediation beginning twenty-odd hours later when a person sent a message.
 *
 * The thing that was missing is not cleverness. It is a process whose lifetime
 * is not a chat session, not a terminal window, and not a shell script.
 *
 * THE DESIGN IS DELIBERATELY BORING:
 *
 *   - it ticks on a timer, and a tick is the supervisor's existing `tick()` —
 *     no second state machine, no second database, no parallel notion of what
 *     is happening;
 *   - it consumes results BEFORE it schedules, because a result that already
 *     exists outranks any conclusion about who is still alive;
 *   - it holds a DURABLE lease, so a second supervisor stands down rather than
 *     racing, and a dead one is taken over without a human deciding;
 *   - it spends no model tokens. Waiting is `setTimeout`. Deciding is
 *     arithmetic over rows. A model is invoked only when the state machine has
 *     actual work for one, and never to find out what is going on.
 *
 * LOSING AN EVENT MUST NOT LOSE PROGRESS. There are no events here at all: the
 * loop re-reads durable state every tick and re-derives everything. Anything
 * faster — inotify, a completion callback — is an accelerator that may be added
 * later and may fail silently without costing correctness, which is the only
 * kind of optimisation worth having in this position.
 */

import type { Timestamp } from "../domain/time.js";

import type { ActivityLease, LivenessProbe } from "./activity.js";
import { acquireSupervisorLease, releasedBy, type SupervisorOwner } from "./supervisorLease.js";
import type { SupervisorRepository } from "./supervisorPorts.js";

/** Roughly how often an idle Factory looks at itself. */
export const DEFAULT_TICK_INTERVAL_MS = 45_000;

/**
 * How long a supervisor waits before concluding its OWN tick has wedged.
 *
 * Not a kill: nothing here kills a tick in flight, because a tick that is slow
 * because a mutation run is slow is doing exactly what it should. It bounds how
 * long the loop will sit inside one tick before saying so out loud, which is
 * the difference between "working" and "stuck" that every previous generation
 * of this machinery got wrong by not asking.
 */
export const DEFAULT_SLOW_TICK_MS = 15 * 60_000;

export interface SupervisorTicker {
  tick(): Promise<unknown>;
}

export interface LoopDeps {
  readonly repository: SupervisorRepository;
  readonly service: SupervisorTicker;
  readonly clock: { now(): Timestamp };
  /** Waits, and resolves early when the loop is asked to stop. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly liveness: LivenessProbe;
  /** This process's own lease. Absent means it cannot prove its identity. */
  readonly lease: (at: Timestamp) => ActivityLease | undefined;
  readonly ownerId: string;
  readonly intervalMs?: number;
  readonly slowTickMs?: number;
  /** Stops after this many ticks. Absent means "until asked to stop". */
  readonly maxTicks?: number;
  readonly log?: (line: string) => void;
}

export type LoopOutcome =
  | { readonly kind: "STOPPED"; readonly ticks: number }
  | { readonly kind: "STOOD_DOWN"; readonly problem: string }
  | { readonly kind: "REFUSED"; readonly problem: string };

/**
 * Writes the lease through compare-and-set, or reports who won.
 *
 * The CAS is what makes two supervisors safe: both may DECIDE they can take a
 * free lease, and exactly one write lands. The loser re-reads, finds a live
 * holder, and stands down — which is the same path it would take if it had
 * been slower by a second.
 */
async function claimOwnership(
  deps: LoopDeps,
  lease: ActivityLease,
): Promise<{ readonly ok: true; readonly owner: SupervisorOwner } | { readonly ok: false; readonly problem: string }> {
  const state = await deps.repository.load();
  if (state === undefined) {
    return { ok: false, problem: "this Factory has no durable state; nothing to supervise" };
  }

  const verdict = acquireSupervisorLease(state.supervisor, { lease, ownerId: deps.ownerId, now: deps.clock.now() }, deps.liveness);
  if (!verdict.ok) {
    return { ok: false, problem: verdict.problem };
  }
  if (!verdict.changed) {
    return { ok: true, owner: verdict.owner };
  }

  try {
    await deps.repository.compareAndSave(
      { ...state, version: state.version + 1, supervisor: verdict.owner },
      state.version,
    );
    return { ok: true, owner: verdict.owner };
  } catch (error) {
    /**
     * Losing the race is not an error, it is an answer: somebody else got the
     * lease between the read and the write. Re-reading and reporting what is
     * there now is more useful than reporting the collision.
     */
    const after = await deps.repository.load();
    const holder = after?.supervisor;
    return {
      ok: false,
      problem:
        holder === undefined
          ? `could not take the supervisor lease: ${error instanceof Error ? error.message : String(error)}`
          : `another supervisor took the lease first: pid ${holder.lease.pid} (${holder.ownerId})`,
    };
  }
}

/** Renews the lease, and says nothing if it cannot: a renewal is not a decision. */
async function renewOwnership(deps: LoopDeps, lease: ActivityLease): Promise<boolean> {
  const state = await deps.repository.load();
  if (state === undefined) {
    return false;
  }
  const verdict = acquireSupervisorLease(state.supervisor, { lease, ownerId: deps.ownerId, now: deps.clock.now() }, deps.liveness);
  if (!verdict.ok) {
    deps.log?.(`[loop] lost the supervisor lease: ${verdict.problem}`);
    return false;
  }
  if (!verdict.changed) {
    return true;
  }
  try {
    await deps.repository.compareAndSave(
      { ...state, version: state.version + 1, supervisor: verdict.owner },
      state.version,
    );
    return true;
  } catch {
    // A conflicting write is ordinary; the next tick renews again.
    return true;
  }
}

async function releaseOwnership(deps: LoopDeps, lease: ActivityLease): Promise<void> {
  try {
    const state = await deps.repository.load();
    if (state === undefined || !releasedBy(state.supervisor, lease)) {
      return;
    }
    const { supervisor: _released, ...withoutOwner } = state;
    void _released;
    await deps.repository.compareAndSave({ ...withoutOwner, version: state.version + 1 }, state.version);
  } catch {
    /**
     * A release that fails changes nothing that matters. The lease carries
     * liveness, so the next supervisor finds a dead holder and takes over; this
     * is a courtesy to the reader of `status`, not a correctness requirement.
     */
  }
}

/**
 * Runs until asked to stop, or until the lease is lost.
 *
 * Returns rather than throwing on every foreseeable end, because "the loop
 * exited" is a fact an operator needs to read, and an exception that reaches a
 * service manager is a restart loop with no explanation in it.
 */
export async function runSupervisorLoop(deps: LoopDeps, stopping: () => boolean): Promise<LoopOutcome> {
  const lease = deps.lease(deps.clock.now());
  if (lease === undefined) {
    /**
     * A supervisor that cannot establish its own identity cannot hold a lease,
     * and a lease nobody can check is worse than no lease: the next process to
     * start would find a holder it cannot resolve and refuse forever.
     */
    return { kind: "REFUSED", problem: "this process cannot establish its own identity, so it cannot supervise" };
  }

  const claimed = await claimOwnership(deps, lease);
  if (!claimed.ok) {
    return { kind: "STOOD_DOWN", problem: claimed.problem };
  }
  deps.log?.(`[loop] supervising as ${deps.ownerId} (pid ${lease.pid})`);

  const interval = deps.intervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const slow = deps.slowTickMs ?? DEFAULT_SLOW_TICK_MS;
  let ticks = 0;

  try {
    while (!stopping() && (deps.maxTicks === undefined || ticks < deps.maxTicks)) {
      const startedAt = deps.clock.now();
      try {
        await deps.service.tick();
      } catch (error) {
        /**
         * A TICK THAT THROWS MUST NOT END THE SUPERVISOR.
         *
         * Every refusal this Factory can produce is a RESULT and comes back as
         * one; an exception here therefore means something unforeseen, and the
         * useful response to unforeseen is to record it and look again shortly —
         * not to exit and leave nothing running, which is the failure this whole
         * task exists to remove.
         */
        deps.log?.(`[loop] tick failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      ticks += 1;

      const took = deps.clock.now() - startedAt;
      if (took >= slow) {
        deps.log?.(`[loop] that tick took ${Math.round(took / 1_000)}s`);
      }

      if (!(await renewOwnership(deps, lease))) {
        return { kind: "STOOD_DOWN", problem: "the supervisor lease is no longer this process's" };
      }
      if (stopping() || (deps.maxTicks !== undefined && ticks >= deps.maxTicks)) {
        break;
      }
      await deps.sleep(interval);
    }
  } finally {
    await releaseOwnership(deps, lease);
  }

  return { kind: "STOPPED", ticks };
}
