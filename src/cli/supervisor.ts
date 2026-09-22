/**
 * `sf supervisor` — running the Factory, and reading what it is doing
 * (TASK-019 AC-3, AC-20, AC-21).
 *
 * THREE VERBS, and the separation between them is the point:
 *
 *   `run`     the deterministic loop. This is the thing an OS service manager
 *             starts, and the thing that must survive every restart. It spends
 *             no model tokens: it ticks, writes, and sleeps.
 *   `status`  reads durable state and prints it. No model, no side effect, and
 *             deliberately usable from a shell script — the previous generation
 *             of this machinery was "readable" only by asking a language model
 *             to look at a log, which cost money to answer "nothing changed".
 *   `review`  files a durable request for an independent review of a candidate.
 *             Deciding that work is ready to review belongs to whoever did it;
 *             everything after that belongs to the supervisor.
 *
 * WHAT `status` REPORTS IS MEASURED, NEVER INTENDED (AC-20). Every line comes
 * from a row: a review reads RUNNING because a worker acknowledged it, not
 * because something tried to start one.
 */

import { hostname } from "node:os";

import { createProcLivenessProbe, leaseForThisProcess } from "../adapters/supervision/procLiveness.js";
import { isTerminal } from "../supervision/activity.js";
import {
  DEFAULT_TICK_INTERVAL_MS,
  runSupervisorLoop,
  type LoopOutcome,
} from "../supervision/supervisorLoop.js";
import type { ReviewRequest, SupervisorState } from "../supervision/supervisorTypes.js";

import {
  buildSupervisorService,
  openSupervisorRepository,
  type SuperviseCliOptions,
} from "./supervise.js";

export interface SupervisorRunOptions extends SuperviseCliOptions {
  readonly intervalMs?: number;
  readonly maxTicks?: number;
  /** Resolves true once the process has been asked to stop. */
  readonly stopping?: () => boolean;
}

/** A name a human can recognise in `status`; identity is still the lease. */
function ownerName(): string {
  return `${hostname()}:${process.pid}`;
}

export async function runSupervisorService(options: SupervisorRunOptions = {}): Promise<LoopOutcome> {
  const log = options.log ?? ((line: string) => console.log(line));
  const repository = openSupervisorRepository(options);

  /**
   * SIGTERM IS HOW A SERVICE MANAGER ASKS, and it is asked politely: the loop
   * finishes the tick it is in, releases its lease and exits. Killing it
   * mid-tick is also safe — that is what the lease and the compare-and-set are
   * for — but a clean stop leaves nothing for the next supervisor to reason
   * about, which is worth the few seconds.
   */
  let asked = false;
  const stop = () => {
    asked = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  try {
    const service = buildSupervisorService(repository, log);
    return await runSupervisorLoop(
      {
        repository,
        service,
        clock: { now: () => Date.now() },
        sleep: (ms) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ms);
            // Never hold the process open for a sleep: a stop request should
            // not have to wait out a forty-five second nap.
            timer.unref?.();
            const poll = setInterval(() => {
              if (asked) {
                clearInterval(poll);
                clearTimeout(timer);
                resolve();
              }
            }, 250);
            poll.unref?.();
          }),
        liveness: createProcLivenessProbe(),
        lease: (at) => leaseForThisProcess(at),
        ownerId: ownerName(),
        intervalMs: options.intervalMs ?? DEFAULT_TICK_INTERVAL_MS,
        ...(options.maxTicks === undefined ? {} : { maxTicks: options.maxTicks }),
        log,
      },
      () => asked || (options.stopping?.() ?? false),
    );
  } finally {
    repository.close();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}

export interface SupervisorStatusView {
  readonly owner?: {
    readonly ownerId: string;
    readonly pid: number;
    readonly machine: string;
    readonly acquiredAt: number;
    readonly renewedAt: number;
    readonly liveness: string;
  };
  readonly reviews: readonly {
    readonly id: string;
    readonly state: string;
    readonly model: string;
    readonly effort: string;
    readonly candidate: string;
    readonly heartbeatAt?: number;
    readonly progress?: number;
    readonly outcome?: string;
    readonly observed: boolean;
  }[];
  readonly requests: readonly ReviewRequest[];
  readonly nextWakeAt?: number;
  readonly openEscalations: number;
}

/** Reads durable state and says what is true. No model, no writes. */
export function supervisorStatus(state: SupervisorState): SupervisorStatusView {
  const probe = createProcLivenessProbe();
  const owner = state.supervisor;
  const reviews = (state.activities ?? [])
    .filter((activity) => activity.review !== undefined)
    .map((activity) => ({
      id: activity.id,
      state: activity.state,
      model: activity.review?.model ?? "unknown",
      effort: activity.review?.effort ?? "unknown",
      candidate: activity.review?.candidate.commit ?? "unknown",
      ...(activity.heartbeat === undefined
        ? {}
        : { heartbeatAt: activity.heartbeat.at, progress: activity.heartbeat.progress }),
      ...(activity.completion === undefined ? {} : { outcome: activity.completion.outcome }),
      observed: isTerminal(activity.state) && activity.observedAt !== undefined,
    }));

  return {
    ...(owner === undefined
      ? {}
      : {
          owner: {
            ownerId: owner.ownerId,
            pid: owner.lease.pid,
            machine: owner.lease.machine,
            acquiredAt: owner.acquiredAt,
            renewedAt: owner.renewedAt,
            // MEASURED: the lease is checked, not assumed live because a row exists.
            liveness: probe.check(owner.lease),
          },
        }),
    reviews,
    requests: state.reviewRequests ?? [],
    ...(state.nextWakeAt === undefined ? {} : { nextWakeAt: state.nextWakeAt }),
    openEscalations: state.escalations.filter((entry) => !entry.resolved).length,
  };
}

export async function runSupervisorStatus(options: SuperviseCliOptions = {}): Promise<SupervisorStatusView | undefined> {
  const repository = openSupervisorRepository(options);
  try {
    const state = await repository.load();
    if (state === undefined) {
      return undefined;
    }
    return supervisorStatus(state);
  } finally {
    repository.close();
  }
}

export interface RequestReviewOptions extends SuperviseCliOptions {
  readonly roadmapKey: string;
  readonly commit: string;
  readonly tree: string;
  readonly fingerprint: string;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
}

/**
 * Files a durable request for an independent review.
 *
 * Idempotent on the candidate: asking twice for the same commit/tree/fingerprint
 * does not queue two reviews. Asking for a DIFFERENT candidate of the same item
 * is a new attempt, which is how a remediated candidate gets a fresh review
 * without anything having to remember that the previous one happened.
 */
export async function requestReview(options: RequestReviewOptions): Promise<ReviewRequest> {
  const repository = openSupervisorRepository(options);
  try {
    const state = await repository.load();
    if (state === undefined) {
      throw new Error("this Factory has no durable state; nothing to review");
    }
    if (!state.roadmap.some((item) => item.key === options.roadmapKey)) {
      throw new Error(`no roadmap item is called ${JSON.stringify(options.roadmapKey)}`);
    }

    const existing = state.reviewRequests ?? [];
    const candidate = { commit: options.commit, tree: options.tree, fingerprint: options.fingerprint };
    const already = existing.find(
      (entry) =>
        entry.roadmapKey === options.roadmapKey &&
        entry.candidate.commit === candidate.commit &&
        entry.candidate.tree === candidate.tree &&
        entry.candidate.fingerprint === candidate.fingerprint,
    );
    if (already !== undefined) {
      return already;
    }

    /**
     * The attempt number is derived from what has already been reviewed for
     * this item, so the review's identity — and therefore its verdict's path —
     * cannot collide with a previous round's.
     */
    const attempts = [
      ...existing.filter((entry) => entry.roadmapKey === options.roadmapKey).map((entry) => entry.attempt),
      ...(state.activities ?? [])
        .filter((activity) => activity.roadmapKey === options.roadmapKey && activity.review !== undefined)
        .map((activity) => activity.review?.attempt ?? 0),
    ];
    const request: ReviewRequest = {
      roadmapKey: options.roadmapKey,
      candidate,
      attempt: attempts.length === 0 ? 1 : Math.max(...attempts) + 1,
      requestedAt: Date.now(),
      provider: options.provider ?? "codex-cli",
      model: options.model ?? "gpt-5.6-luna",
      effort: options.effort ?? "xhigh",
    };

    await repository.compareAndSave(
      { ...state, version: state.version + 1, reviewRequests: [...existing, request] },
      state.version,
    );
    return request;
  } finally {
    repository.close();
  }
}
