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
  createSupervisorExecutor,
  openSupervisorRepository,
  type SuperviseCliOptions,
  type SupervisorExecutorWiring,
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

/** The daemon's wait owns its lifetime, and every wake releases its timers. */
export function createSupervisorWaiter(stopping?: () => boolean): {
  sleep(ms: number): Promise<void>;
  stopping(): boolean;
  dispose(): void;
} {
  let asked = false;
  let wake: (() => void) | undefined;
  const isStopping = () => asked || (stopping?.() ?? false);
  const stop = () => {
    asked = true;
    wake?.();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  return {
    stopping: isStopping,
    sleep(ms) {
      if (isStopping()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let poll: ReturnType<typeof setInterval> | undefined;
        const finish = () => {
          clearTimeout(timer);
          if (poll !== undefined) clearInterval(poll);
          if (wake === finish) wake = undefined;
          resolve();
        };
        // This referenced timer keeps an otherwise idle supervisor alive.
        // A signal wakes it directly; a caller's stop callback is polled locally.
        const timer = setTimeout(finish, ms);
        wake = finish;
        if (stopping !== undefined) {
          poll = setInterval(() => {
            if (isStopping()) finish();
          }, 250);
        }
      });
    },
    dispose() {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      wake?.();
    },
  };
}

export async function runSupervisorService(options: SupervisorRunOptions = {}): Promise<LoopOutcome> {
  const log = options.log ?? ((line: string) => console.log(line));
  let repository: ReturnType<typeof openSupervisorRepository> | undefined;
  let wiring: SupervisorExecutorWiring | undefined;
  let waiter: ReturnType<typeof createSupervisorWaiter> | undefined;

  try {
    repository = openSupervisorRepository(options);
    wiring = createSupervisorExecutor(options, log, repository);
    waiter = createSupervisorWaiter(options.stopping);
    const service = buildSupervisorService(repository, log, wiring.executor, options);
    return await runSupervisorLoop(
      {
        repository,
        service,
        clock: { now: () => Date.now() },
        sleep: waiter.sleep,
        liveness: createProcLivenessProbe(),
        lease: (at) => leaseForThisProcess(at),
        ownerId: ownerName(),
        intervalMs: options.intervalMs ?? DEFAULT_TICK_INTERVAL_MS,
        ...(options.maxTicks === undefined ? {} : { maxTicks: options.maxTicks }),
        log,
      },
      waiter.stopping,
    );
  } finally {
    waiter?.dispose();
    try {
      wiring?.close();
    } finally {
      repository?.close();
    }
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

/**
 * The narrow, read-only view `sf supervisor notifications --json` prints
 * (DEFECT-DURABLE-WORKER-RUN-ENVELOPE AC-9).
 *
 * A pure projection over already-loaded durable state, exactly like
 * `supervisorStatus` above: no provider call, no reconciliation, no write.
 * Showing a pending notification is not the same act as resolving one — this
 * view exists so an operator or a controller can SEE what MAX_TURNS/LOST/
 * STALLED/AMBIGUOUS events are outstanding without a supervisor tick running.
 */
export interface WorkerRunNotificationView {
  readonly key: string;
  readonly runId: string;
  readonly roadmapKey: string;
  readonly kind: string;
  readonly detail: string;
  readonly createdAt: number;
}

export interface WorkerRunStatusView {
  readonly runId: string;
  readonly actionId: string;
  readonly roadmapKey: string;
  readonly state: string;
  readonly provider: string;
  readonly model: string;
  readonly updatedAt: number;
}

export interface SupervisorWorkerRunNotificationsView {
  readonly pending: readonly WorkerRunNotificationView[];
  readonly runs: readonly WorkerRunStatusView[];
}

export function supervisorWorkerRunNotifications(state: SupervisorState): SupervisorWorkerRunNotificationsView {
  return {
    pending: (state.workerRunNotifications ?? []).map((notification) => ({
      key: notification.key,
      runId: notification.runId,
      roadmapKey: notification.roadmapKey,
      kind: notification.kind,
      detail: notification.detail,
      createdAt: notification.createdAt,
    })),
    runs: (state.workerRuns ?? []).map((run) => ({
      runId: run.runId,
      actionId: run.actionId,
      roadmapKey: run.roadmapKey,
      state: run.state,
      provider: run.provider,
      model: run.model,
      updatedAt: run.updatedAt,
    })),
  };
}

/** READ-ONLY: durable reads only, no provider call and no state mutation (AC-9). */
export async function runSupervisorWorkerRunNotifications(
  options: SuperviseCliOptions = {},
): Promise<SupervisorWorkerRunNotificationsView | undefined> {
  const repository = openSupervisorRepository(options);
  try {
    const state = await repository.load();
    if (state === undefined) {
      return undefined;
    }
    return supervisorWorkerRunNotifications(state);
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
