/**
 * DEFECT-DURABLE-WORKER-RUN-ENVELOPE — the first durable, provider-independent
 * run record for an external Claude/Codex process.
 *
 * ================================================================
 * WHAT THIS IS FOR
 * ================================================================
 * `ProcessRunner` (TASK-003) is exact about the OS facts of one invocation and
 * returns them once, in memory, after the child closes. `SupervisorActionClaim`
 * (TASK-006) is durable but records that the SUPERVISOR launched something, not
 * that a worker exists. `Activity` (TASK-018/019) is durable, has a real
 * lease/heartbeat/reconciliation model, and is the closest existing thing to
 * this — but it is generic to any long-running unit of work and carries nothing
 * about what an AI CLI specifically reports: a provider session id, a
 * configured max-turn ceiling, or a structured MAX_TURNS terminal reason that
 * must never be confused with an ordinary failure or a free-text mention of the
 * words "max turns".
 *
 * A `WorkerRunEnvelope` is that missing record: written durably BEFORE a
 * Claude/Codex-launching process is spawned, updated only from evidence the
 * launched process itself produces (an OS-level spawn confirmation, a
 * heartbeat, a completion artifact), and reconciled deterministically when that
 * evidence stops arriving.
 *
 * ================================================================
 * WHY THIS REUSES `ActivityLease`/`LivenessProbe` RATHER THAN INVENTING THEM
 * ================================================================
 * "Is the process that holds this identity still running" has exactly one
 * correct answer on this machine, and `procLiveness.ts` already computes it
 * from `/proc/<pid>/stat` plus machine/boot identity, closing PID reuse and
 * cross-reboot collisions. Duplicating that logic here would be a second
 * implementation of the same fact, and TASK-018/019's own history is what a
 * fact with two implementations costs.
 *
 * ================================================================
 * THE INVARIANT
 * ================================================================
 * Every transition here is PURE and REFUSES rather than guesses: no clock, no
 * filesystem, no process table. Ambiguity resolves to `AMBIGUOUS`, a dead
 * owner resolves to `LOST`, and a live owner that stopped reporting resolves to
 * `STALLED` — and none of the three ever increases a launch count, because
 * reconciliation restores knowledge, not authority to try again.
 */

import type { Timestamp } from "../domain/time.js";

import type { ActivityLease, Liveness, LivenessProbe } from "./activity.js";

// =====================================================================
// Lifecycle
// =====================================================================

/**
 * `PREPARED` and `RUNNING` are the two-phase handshake (AC-1, AC-2): a durable
 * intent, then durable proof. Everything after that is terminal — an envelope
 * never returns to work once it reaches one of these, and none of them may be
 * used to launch a second worker.
 *
 * `AWAITING_CONTROLLER` is the MAX_TURNS state: the run is over, its result is
 * preserved, and nothing in this module or its callers may treat it as a
 * failure to retry automatically or a success to continue from. A human or an
 * explicit later decision is the only thing that moves an item past it.
 */
export const WORKER_RUN_STATES = [
  "PREPARED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "LOST",
  "STALLED",
  "AMBIGUOUS",
  "AWAITING_CONTROLLER",
] as const;

export type WorkerRunState = (typeof WORKER_RUN_STATES)[number];

export const TERMINAL_WORKER_RUN_STATES: readonly WorkerRunState[] = [
  "COMPLETED",
  "FAILED",
  "LOST",
  "STALLED",
  "AMBIGUOUS",
  "AWAITING_CONTROLLER",
];

export function isTerminalWorkerRunState(state: WorkerRunState): boolean {
  return TERMINAL_WORKER_RUN_STATES.includes(state);
}

/**
 * Terminal reasons this module will record. Deliberately a closed set of one:
 * widening it is a decision about what else counts, not a parsing detail, and
 * MAX_TURNS is the only reason AC-6 requires to survive from structured
 * provider output into durable state.
 */
export const WORKER_RUN_TERMINAL_REASONS = ["MAX_TURNS"] as const;
export type WorkerRunTerminalReason = (typeof WORKER_RUN_TERMINAL_REASONS)[number];

/** What reconciliation may conclude without ever launching anything (AC-7). */
export const WORKER_RUN_RECONCILE_VERDICTS = ["LOST", "STALLED", "AMBIGUOUS"] as const;
export type WorkerRunReconcileVerdict = (typeof WORKER_RUN_RECONCILE_VERDICTS)[number];

export interface WorkerRunHeartbeat {
  readonly at: Timestamp;
  /** Monotonic. A repeated value proves liveness only (AC-4); it does not move this clock. */
  readonly progress: number;
  /** Time of the last measured increase; absent when no increase was observed. */
  readonly lastProgressAt?: Timestamp;
}

/**
 * The bounded, redacted, hashed terminal artifact this run left behind
 * (AC-5). The hash is recomputed by the reader at every use — never trusted
 * from the value alone — so a torn or foreign file is caught by the reader
 * (`workerRunArtifact.ts`), and this record only says where to look.
 */
export interface WorkerRunArtifactRef {
  readonly path: string;
  readonly hash: string;
}

export interface WorkerRunEnvelope {
  /** Ordered provider invocations belonging to this one plan-resume action. */
  readonly invocations?: readonly WorkerInvocation[];
  /** Canonical, derived from the action — never random. */
  readonly runId: string;
  readonly actionId: string;
  readonly roadmapKey: string;
  readonly attempt: number;
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
  /** The ceiling this run was CONFIGURED with, so AC-6 can be checked against a fact, not a guess. */
  readonly maxTurns?: number;
  readonly state: WorkerRunState;
  /**
   * The launched process's own identity, once it has ACKed (AC-2). Absent
   * while `state` is still `PREPARED` — launcher intent is never written here.
   */
  readonly wrapperLease?: ActivityLease;
  /**
   * The AI CLI process's own pid, when the wrapper is able to report it
   * (informational: liveness is always checked against `wrapperLease`, the
   * one identity this module can independently verify from `/proc`).
   */
  readonly childPid?: number;
  /** This Factory's own identity for the run. Equal to `runId` unless a caller says otherwise. */
  readonly factorySessionId?: string;
  /** The provider's OWN structured `session_id`, parsed and never inferred from free text. */
  readonly providerSessionId?: string;
  readonly terminalReason?: WorkerRunTerminalReason;
  readonly preparedAt: Timestamp;
  readonly heartbeat?: WorkerRunHeartbeat;
  readonly startedAt?: Timestamp;
  readonly finishedAt?: Timestamp;
  readonly reconciledAt?: Timestamp;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly artifact?: WorkerRunArtifactRef;
  readonly detail?: string;
  readonly updatedAt: Timestamp;
}

export interface WorkerInvocation {
  readonly sequence: number;
  readonly provider: string;
  readonly model: string;
  readonly maxTurns?: number;
  readonly preparedAt: Timestamp;
  readonly lease?: ActivityLease;
  readonly finishedAt?: Timestamp;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly terminationReason?: string;
  readonly providerSessionId?: string;
  readonly terminalReason?: WorkerRunTerminalReason;
}

/** THE only legitimate way a run id comes into existence (the TASK-004 lesson, repeated here). */
export function canonicalWorkerRunId(actionId: string): string {
  return `${actionId}:wr1`;
}

// =====================================================================
// Notification outbox (AC-8, AC-9)
// =====================================================================

export const WORKER_RUN_NOTIFICATION_KINDS = ["MAX_TURNS", "LOST", "STALLED", "AMBIGUOUS"] as const;
export type WorkerRunNotificationKind = (typeof WORKER_RUN_NOTIFICATION_KINDS)[number];

export interface WorkerRunNotification {
  /** The dedupe key. Stable across restarts because it is a pure function of (runId, kind). */
  readonly key: string;
  readonly runId: string;
  readonly roadmapKey: string;
  readonly kind: WorkerRunNotificationKind;
  readonly detail: string;
  readonly createdAt: Timestamp;
}

/** Pure and total: the same (runId, kind) always produces the same key, forever. */
export function workerRunNotificationKey(runId: string, kind: WorkerRunNotificationKind): string {
  return `${runId}:${kind}`;
}

/**
 * Adds a notification exactly once per (runId, kind), however many times
 * reconciliation runs or the supervisor restarts (AC-8).
 */
export function enqueueWorkerRunNotification(
  outbox: readonly WorkerRunNotification[],
  notification: WorkerRunNotification,
): { readonly outbox: readonly WorkerRunNotification[]; readonly changed: boolean } {
  if (outbox.some((entry) => entry.key === notification.key)) {
    return { outbox, changed: false };
  }
  return { outbox: [...outbox, notification], changed: true };
}

// =====================================================================
// Preparing and adopting (AC-1, AC-2, AC-3)
// =====================================================================

export type WorkerRunVerdict =
  | { readonly ok: true; readonly runs: readonly WorkerRunEnvelope[]; readonly run: WorkerRunEnvelope }
  | { readonly ok: false; readonly problem: string };

function locate(
  runs: readonly WorkerRunEnvelope[],
  runId: string,
): { readonly ok: true; readonly run: WorkerRunEnvelope } | { readonly ok: false; readonly problem: string } {
  const found = runs.filter((entry) => entry.runId === runId);
  if (found.length === 0) {
    return { ok: false, problem: `durable state holds no worker run ${JSON.stringify(runId)}` };
  }
  if (found.length > 1) {
    return { ok: false, problem: `durable state holds worker run ${JSON.stringify(runId)} more than once` };
  }
  return { ok: true, run: found[0]! };
}

function replace(runs: readonly WorkerRunEnvelope[], next: WorkerRunEnvelope): readonly WorkerRunEnvelope[] {
  return runs.map((entry) => (entry.runId === next.runId ? next : entry));
}

function sameHolder(a: ActivityLease, b: ActivityLease): boolean {
  return a.pid === b.pid && a.processStartedAt === b.processStartedAt && a.machine === b.machine && a.boot === b.boot;
}

/**
 * Writes the durable PREPARED record BEFORE anything is spawned (AC-1).
 *
 * The caller commits this with compare-and-set before calling the process
 * runner; a CAS failure here means the write never happened, and the whole
 * point of ordering it first is that a write that never happened is a launch
 * that never happened either — nothing downstream of a failed prepare may spawn
 * a process.
 */
export function prepareWorkerRun(
  runs: readonly WorkerRunEnvelope[],
  request: {
    readonly actionId: string;
    readonly roadmapKey: string;
    readonly attempt: number;
    readonly provider: string;
    readonly model: string;
    readonly effort?: string;
    readonly maxTurns?: number;
    readonly factorySessionId?: string;
    readonly now: Timestamp;
  },
): WorkerRunVerdict {
  const runId = canonicalWorkerRunId(request.actionId);
  const existing = runs.find((entry) => entry.runId === runId);
  if (existing !== undefined) {
    if (!isTerminalWorkerRunState(existing.state)) {
      return {
        ok: false,
        problem:
          `worker run ${JSON.stringify(runId)} is already ${existing.state}; refusing to prepare a second launch ` +
          "for the same action",
      };
    }
    return {
      ok: false,
      problem: `worker run ${JSON.stringify(runId)} already finished as ${existing.state}; a retry needs a new attempt`,
    };
  }
  const prepared: WorkerRunEnvelope = {
    runId,
    actionId: request.actionId,
    roadmapKey: request.roadmapKey,
    attempt: request.attempt,
    provider: request.provider,
    model: request.model,
    ...(request.effort === undefined ? {} : { effort: request.effort }),
    ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
    ...(request.factorySessionId === undefined ? {} : { factorySessionId: request.factorySessionId }),
    state: "PREPARED",
    preparedAt: request.now,
    updatedAt: request.now,
  };
  return { ok: true, runs: [...runs, prepared], run: prepared };
}

/**
 * The second half of the handshake: a real OS process has proven it is this
 * run (AC-2). `input.lease` must come from evidence the launched process
 * itself produced — an OS `spawn` confirmation carrying its own pid and
 * `/proc` start tick, never a value the launcher merely intended to use.
 *
 * A DIFFERENT identity for the SAME run id is never accepted as an update and
 * never treated as a second worker: it is AMBIGUOUS and refused, closing AC-3
 * (a recycled pid, or two processes racing to claim one prepared run).
 */
export function adoptWorkerRun(
  runs: readonly WorkerRunEnvelope[],
  runId: string,
  input: {
    readonly lease: ActivityLease;
    readonly at: Timestamp;
    readonly childPid?: number;
    readonly providerSessionId?: string;
  },
): WorkerRunVerdict {
  const found = locate(runs, runId);
  if (!found.ok) return found;
  const run = found.run;

  if (run.state === "RUNNING" && run.wrapperLease !== undefined) {
    if (sameHolder(run.wrapperLease, input.lease)) {
      // Re-adoption from the same holder: idempotent, not a second adoption.
      return { ok: true, runs, run };
    }
    return {
      ok: false,
      problem:
        `worker run ${JSON.stringify(runId)} is already running as pid ${run.wrapperLease.pid} on ` +
        `${JSON.stringify(run.wrapperLease.machine)}; refusing to adopt a different process for the same run`,
    };
  }
  if (run.state !== "PREPARED") {
    return {
      ok: false,
      problem: `worker run ${JSON.stringify(runId)} is ${run.state} and can no longer be adopted as running`,
    };
  }

  const next: WorkerRunEnvelope = {
    ...run,
    state: "RUNNING",
    wrapperLease: input.lease,
    ...(input.childPid === undefined ? {} : { childPid: input.childPid }),
    ...(input.providerSessionId === undefined ? {} : { providerSessionId: input.providerSessionId }),
    startedAt: input.at,
    updatedAt: input.at,
  };
  return { ok: true, runs: replace(runs, next), run: next };
}

// =====================================================================
// Heartbeat (AC-4)
// =====================================================================

export type WorkerRunTransition =
  | { readonly ok: true; readonly runs: readonly WorkerRunEnvelope[]; readonly changed: boolean }
  | { readonly ok: false; readonly problem: string };

function heldBy(
  run: WorkerRunEnvelope,
  holder: ActivityLease,
): { readonly ok: true } | { readonly ok: false; readonly problem: string } {
  if (run.wrapperLease === undefined) {
    return { ok: false, problem: `worker run ${JSON.stringify(run.runId)} records no lease, so no writer can be the holder` };
  }
  if (!sameHolder(run.wrapperLease, holder)) {
    return {
      ok: false,
      problem:
        `worker run ${JSON.stringify(run.runId)} is held by pid ${run.wrapperLease.pid}; refusing a write from ` +
        `pid ${holder.pid}`,
    };
  }
  return { ok: true };
}

/**
 * Wrapper heartbeat, independent of model output (AC-4). A repeated identical
 * progress value proves liveness only and does not move the progress clock; an
 * increasing value does. Mirrors `activity.ts#reportProgress` exactly, because
 * this is the same fact about a different kind of record.
 */
export function reportWorkerRunHeartbeat(
  runs: readonly WorkerRunEnvelope[],
  runId: string,
  heartbeat: WorkerRunHeartbeat,
  holder: ActivityLease,
): WorkerRunTransition {
  const found = locate(runs, runId);
  if (!found.ok) return found;
  const run = found.run;

  const owned = heldBy(run, holder);
  if (!owned.ok) return owned;

  if (isTerminalWorkerRunState(run.state)) {
    return { ok: false, problem: `worker run ${JSON.stringify(runId)} already finished as ${run.state}` };
  }
  const previous = run.heartbeat;
  if (previous !== undefined && heartbeat.progress < previous.progress) {
    return {
      ok: false,
      problem: `worker run ${JSON.stringify(runId)} reported progress ${heartbeat.progress} after ${previous.progress}`,
    };
  }
  if (previous !== undefined && heartbeat.at < previous.at) {
    return { ok: false, problem: "worker heartbeat time regressed" };
  }
  const lastProgressAt = heartbeat.progress > (previous?.progress ?? 0)
    ? heartbeat.at : previous?.lastProgressAt;
  const measured = { at: heartbeat.at, progress: heartbeat.progress,
    ...(lastProgressAt === undefined ? {} : { lastProgressAt }) };
  return { ok: true, changed: true, runs: replace(runs, { ...run, heartbeat: measured, updatedAt: heartbeat.at }) };
}

// =====================================================================
// Completion (AC-5, AC-6)
// =====================================================================

function canonicalJson(value: unknown): string {
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

export interface WorkerRunCompletionInput {
  /** `AWAITING_CONTROLLER` is the ONLY legal terminal state for a verified MAX_TURNS (AC-6). */
  readonly state: "COMPLETED" | "FAILED" | "AWAITING_CONTROLLER";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly artifact?: WorkerRunArtifactRef;
  readonly providerSessionId?: string;
  readonly terminalReason?: WorkerRunTerminalReason;
  readonly detail: string;
  readonly at: Timestamp;
}

/**
 * Records what actually happened to the process — exit 0, nonzero, signal,
 * timeout, spawn error or wrapper error all arrive through this one function,
 * because AC-5 requires each of them to produce a bounded, redacted, atomic
 * completion and none of them is special-cased into a different code path.
 *
 * `AWAITING_CONTROLLER` may be reached even on `exitCode === 0` (AC-6): a
 * successful process exit is not evidence against a verified MAX_TURNS, and
 * this function never infers MAX_TURNS on its own — `terminalReason` must
 * already have been decided, structurally, by the caller's parsing of the
 * provider's own JSON.
 *
 * Idempotent: a repeat with the SAME content is a no-op (a second reconcile
 * tick reading the same artifact); a repeat that DISAGREES is refused, because
 * two disagreeing completions for one run means one of them is wrong and this
 * function cannot tell which.
 */
export function completeWorkerRun(
  runs: readonly WorkerRunEnvelope[],
  runId: string,
  input: WorkerRunCompletionInput,
): WorkerRunTransition {
  const found = locate(runs, runId);
  if (!found.ok) return found;
  const run = found.run;

  if (run.state === "PREPARED" && input.artifact === undefined) {
    return { ok: false, problem: "PREPARED completion requires a verified terminal artifact" };
  }
  if ((input.state === "AWAITING_CONTROLLER") !== (input.terminalReason === "MAX_TURNS")) {
    return { ok: false, problem: "MAX_TURNS requires AWAITING_CONTROLLER" };
  }

  if (isTerminalWorkerRunState(run.state)) {
    const already = canonicalJson({
      state: run.state,
      exitCode: run.exitCode,
      signal: run.signal,
      artifact: run.artifact,
      terminalReason: run.terminalReason,
      detail: run.detail,
    });
    const incoming = canonicalJson({
      state: input.state,
      exitCode: input.exitCode,
      signal: input.signal,
      artifact: input.artifact,
      terminalReason: input.terminalReason,
      detail: input.detail,
    });
    if (already === incoming) {
      return { ok: true, runs, changed: false };
    }
    return {
      ok: false,
      problem:
        `worker run ${JSON.stringify(runId)} already recorded a completion (${run.state}); refusing to replace it ` +
        `with a disagreeing one (${input.state})`,
    };
  }

  const next: WorkerRunEnvelope = {
    ...run,
    state: input.state,
    exitCode: input.exitCode,
    signal: input.signal,
    ...(input.artifact === undefined ? {} : { artifact: input.artifact }),
    ...(input.providerSessionId !== undefined
      ? { providerSessionId: input.providerSessionId }
      : run.providerSessionId !== undefined
        ? { providerSessionId: run.providerSessionId }
        : {}),
    ...(input.terminalReason === undefined ? {} : { terminalReason: input.terminalReason }),
    detail: input.detail,
    finishedAt: input.at,
    updatedAt: input.at,
  };
  return { ok: true, changed: true, runs: replace(runs, next) };
}

// =====================================================================
// Reconciliation (AC-7)
// =====================================================================

export interface WorkerRunReconcileInput {
  readonly now: Timestamp;
  readonly stallAfterMs: number;
}

/**
 * Classifies a run nobody may currently be updating, WITHOUT writing anything
 * (mirrors `activity.ts#classifyActivity`). `undefined` means "nothing to
 * conclude yet" — a terminal run is left alone, and a live, on-time owner is
 * simply still working.
 *
 * ARTIFACT FIRST: the caller passes `hasValidArtifact` computed from
 * `workerRunArtifact.ts` BEFORE calling this, and a `true` here means the
 * caller should call `completeWorkerRun` from the artifact instead of asking
 * this function at all — identity is only consulted when there is no artifact
 * to settle from (AC-7's ordering).
 */
export function classifyWorkerRun(
  run: WorkerRunEnvelope,
  input: WorkerRunReconcileInput,
  probe: LivenessProbe,
): { readonly verdict: WorkerRunReconcileVerdict; readonly detail: string } | undefined {
  if (isTerminalWorkerRunState(run.state)) {
    return undefined;
  }
  if (run.state === "PREPARED") {
    // Not yet adopted. Whether the launch ever happened is unknowable from
    // identity alone (there is none yet); a caller with a stall budget on the
    // prepare-to-adopt window decides that separately.
    return undefined;
  }
  const active = run.invocations?.find((entry) => entry.finishedAt === undefined);
  const held = active?.lease ?? run.wrapperLease;
  if (held === undefined) {
    return { verdict: "AMBIGUOUS", detail: `worker run ${JSON.stringify(run.runId)} is RUNNING with no lease recorded` };
  }

  const liveness: Liveness = probe.check(held);
  if (liveness === "GONE") {
    return {
      verdict: "LOST",
      detail: `worker run ${JSON.stringify(run.runId)}'s owner (pid ${held.pid}) is gone; its outcome could not be observed`,
    };
  }
  if (liveness === "UNKNOWN") {
    return {
      verdict: "AMBIGUOUS",
      detail: `worker run ${JSON.stringify(run.runId)} is held by pid ${held.pid} on ${JSON.stringify(held.machine)}, and whether it is still running cannot be established here`,
    };
  }

  const lastSeen = run.heartbeat?.lastProgressAt ?? run.startedAt ?? run.preparedAt;
  const since = input.now - lastSeen;
  if (since > input.stallAfterMs) {
    return {
      verdict: "STALLED",
      detail: `worker run ${JSON.stringify(run.runId)} last reported progress ${since}ms ago (threshold ${input.stallAfterMs}ms), and its owner is still running`,
    };
  }
  return undefined;
}

/**
 * Writes a reconciliation verdict as the run's terminal state (AC-7, AC-8).
 *
 * NEVER increases a launch count and never re-launches anything — it only
 * records a conclusion. Idempotent: applying the same verdict twice changes
 * nothing (so a repeated reconcile tick and a restart both cost nothing extra
 * to the outbox either, once paired with `enqueueWorkerRunNotification`).
 *
 * BETTER EVIDENCE MAY STILL SUPERSEDE ONE OF THESE THREE: if a genuine
 * completion artifact turns up later for a run already marked LOST, STALLED or
 * AMBIGUOUS, `completeWorkerRun` is the function that applies it — this
 * function's own states are not treated as a firmer fact than a real
 * completion artifact, only as firmer than nothing.
 */
export function applyWorkerRunReconciliation(
  runs: readonly WorkerRunEnvelope[],
  runId: string,
  verdict: WorkerRunReconcileVerdict,
  detail: string,
  at: Timestamp,
): WorkerRunTransition {
  const found = locate(runs, runId);
  if (!found.ok) return found;
  const run = found.run;

  if (run.state === verdict) {
    return { ok: true, runs, changed: false };
  }
  if (isTerminalWorkerRunState(run.state)) {
    // A firmer, disagreeing terminal state already exists (e.g. COMPLETED via
    // an artifact that arrived between classification and this write). Never
    // overwrite a real completion with a liveness guess.
    return { ok: true, runs, changed: false };
  }
  return {
    ok: true,
    changed: true,
    runs: replace(runs, { ...run, state: verdict, detail, reconciledAt: at, updatedAt: at }),
  };
}
