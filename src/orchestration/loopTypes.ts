/**
 * TASK-004 autonomous engineering loop — persisted state types.
 *
 * Deliberately not part of `src/domain/`: these are orchestration-layer
 * concepts (they coordinate multiple trusted `FactoryService` calls) rather
 * than the accepted TASK-001/002/003 domain model (docs/DOMAIN_MODEL.md),
 * which this task does not modify. See
 * docs/tasks/TASK-004-autonomous-engineering-loop.md for the full design.
 *
 * REMEDIATION ROUND 1 (independent review findings HIGH 1/5/6): every
 * external side effect the loop performs — launching a worker, recording a
 * review — now has an explicit, durable *action claim* persisted via CAS
 * BEFORE the side effect starts, carrying a stable identity
 * (`actionId`/`attempt`) and a correlation tag that `FactoryService.runWorker`
 * durably records as the Run's `declaredWorkerId` in PHASE 1, before
 * execution. Crash recovery reconciles claims against authoritative Factory
 * state by exact tag match — never by role/latest/title/timestamp guessing —
 * and the single-row CAS (`version`) is the linearization point between
 * claiming a launch and committing a cancellation.
 */

import type { EvidenceKind } from "../domain/evidence.js";
import type { ReviewId, RunId, WorkItemId } from "../domain/ids.js";
import type { Actor } from "../domain/actor.js";
import type { Timestamp } from "../domain/time.js";
import type { WorkerTool } from "../adapters/workers/workerModelConfig.js";

export const LOOP_PHASES = [
  "READY",
  "IMPLEMENTING",
  "VERIFYING",
  "REVIEWING",
  "WAITING_FOR_HUMAN",
  "EXHAUSTED",
  "FAILED",
  "CANCELLED",
  "RECOVERY_REQUIRED",
] as const;

export type LoopPhase = (typeof LOOP_PHASES)[number];

/** Phases the loop performs no further automatic action in. */
export const TERMINAL_LOOP_PHASES: readonly LoopPhase[] = [
  "WAITING_FOR_HUMAN",
  "EXHAUSTED",
  "FAILED",
  "CANCELLED",
  "RECOVERY_REQUIRED",
];

/** Phases eligible for the persistence-level one-active-loop-per-work-item uniqueness rule. */
export const ACTIVE_LOOP_PHASES: readonly LoopPhase[] = ["READY", "IMPLEMENTING", "VERIFYING", "REVIEWING"];

export function isTerminalLoopPhase(phase: LoopPhase): boolean {
  return TERMINAL_LOOP_PHASES.includes(phase);
}

export const LOOP_REVIEW_VERDICTS = ["PASS", "PASS_WITH_NON_BLOCKING_NOTES", "CHANGES_REQUIRED"] as const;

export type LoopReviewVerdict = (typeof LOOP_REVIEW_VERDICTS)[number];

export const LOOP_OUTCOMES = ["WAITING_FOR_HUMAN", "EXHAUSTED", "FAILED", "CANCELLED", "RECOVERY_REQUIRED"] as const;

export type LoopOutcome = (typeof LOOP_OUTCOMES)[number];

export const EXHAUSTION_KINDS = ["ITERATIONS", "TOTAL_RUNS", "WALL_CLOCK"] as const;

export type ExhaustionKind = (typeof EXHAUSTION_KINDS)[number];

export interface LoopWorkerConfig {
  readonly tool: WorkerTool;
  readonly model: string;
  readonly effort?: string;
  readonly timeoutMs?: number;
}

export interface VerificationCommandConfig {
  readonly id: string;
  readonly executable: string;
  readonly argv: readonly string[];
  /**
   * Relative to the workspace root; must stay inside it (validated with real
   * paths at start AND again immediately before execution — see
   * verificationWorker.ts). Defaults to the workspace root itself.
   */
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly evidenceKind?: EvidenceKind;
}

export interface VerificationCommandResult {
  readonly commandId: string;
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly terminationReason: string;
  readonly durationMs: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface LoopBudget {
  /** Hard ceiling on the number of IMPLEMENTER attempts (first attempt + remediations). Always >= 1. */
  readonly maxIterations: number;
  /** Optional additional ceiling on total worker runs (implementer + verifier + reviewer) across the loop. */
  readonly maxTotalRuns?: number;
  readonly maxWallClockMs?: number;
  /** Default per-worker timeout when a LoopWorkerConfig does not specify its own. */
  readonly workerTimeoutMs?: number;
  /** Default per-command verification timeout when a VerificationCommandConfig does not specify its own. */
  readonly verificationTimeoutMs?: number;
}

export const DEFAULT_LOOP_BUDGET: LoopBudget = {
  maxIterations: 3,
};

export const WORKER_ACTION_KINDS = ["IMPLEMENT", "VERIFY", "REVIEW"] as const;

export type WorkerActionKind = (typeof WORKER_ACTION_KINDS)[number];

/**
 * A durable claim on one external worker launch. Persisted via CAS BEFORE
 * `FactoryService.runWorker` is invoked; its `correlationTag` becomes the
 * launched Worker object's `id` and is therefore durably recorded as the
 * Run's `declaredWorkerId` in PHASE 1 — the stable pre-execution identity
 * crash reconciliation matches on. Never expires by time: recovery is by
 * explicit reconciliation against Factory state (see engineeringLoopService).
 */
export interface WorkerActionClaim {
  readonly actionId: string;
  readonly kind: WorkerActionKind;
  /** >= 1; bumped only by a crashed-owner takeover re-claim. */
  readonly attempt: number;
  /** Identifies the drive() invocation that owns the launch. Coordination data, never a trust decision. */
  readonly ownerToken: string;
  readonly claimedAt: Timestamp;
  readonly correlationTag: string;
  /** True when the completion was adopted from Factory state by reconciliation rather than observed in-process (telemetry: not a fresh model call). */
  readonly recovered?: boolean;
  /** FAILED runs from superseded attempts of this action (aborted/failed before the current attempt) — audit, never counted as fresh work. */
  readonly supersededRunIds?: readonly RunId[];
}

/** A durable claim on recording one Review (a Factory side effect that must not be duplicated). */
export interface ReviewRecordClaim {
  readonly ownerToken: string;
  readonly claimedAt: Timestamp;
}

/**
 * The ONLY legitimate way an action identity may come into existence
 * (remediation round 2, HIGH 2): a pure function of immutable action
 * coordinates — never a random token (`ids.next(...)` was the round-1
 * design; a random actionId is exactly the "arbitrary trusted text" the
 * round-2 review found could be forged to reference a different action's
 * identity), never model-controlled text.
 *
 * Two different (loopId, iteration, kind) tuples can never collide: `kind`
 * is one of three fixed literals and `iteration` is validated elsewhere
 * (loopSerialization.ts) to be a strictly-1..n-ordered positive integer with
 * no duplicates, and the format itself is unambiguous (kind is always
 * uppercase letters, iteration always digits). This is what lets
 * `loopSerialization.ts` recompute the EXPECTED actionId/correlationTag for
 * every claim it parses and reject any stored value that doesn't match
 * exactly — a corrupted claim can no longer reference a different action's
 * (or a different loop's, or a superseded attempt's) identity, because there
 * is exactly one legal identity for each position and it is derived, not
 * stored as trusted free text.
 */
export function canonicalActionId(loopId: string, iteration: number, kind: WorkerActionKind): string {
  return `${loopId}:i${iteration}:${kind}`;
}

/**
 * Attempt is part of the TAG (not the actionId): retrying the same logical
 * action under a new attempt yields a new tag, never colliding with a
 * superseded attempt's. Takes only `actionId` — not a separate `loopId` —
 * because `canonicalActionId` already embeds the loop id; a second `loopId`
 * parameter here would double-embed it redundantly rather than add any
 * distinguishing information.
 */
export function correlationTag(actionId: string, attempt: number): string {
  return `sf-loop:${actionId}:a${attempt}`;
}

/** Prefix shared by every attempt of one action — used to find runs from superseded attempts. */
export function correlationPrefix(actionId: string): string {
  return `sf-loop:${actionId}:a`;
}

export interface LoopIterationRecord {
  readonly iteration: number;

  readonly implementClaim?: WorkerActionClaim;
  readonly implementerRunId?: RunId;
  readonly implementerOutcome?: "SUCCEEDED" | "FAILED";

  readonly verifyClaim?: WorkerActionClaim;
  readonly verificationRunId?: RunId;
  readonly verificationCommandResults?: readonly VerificationCommandResult[];
  readonly deterministicReviewClaim?: ReviewRecordClaim;
  readonly verificationReviewId?: ReviewId;
  readonly verificationPassed?: boolean;

  readonly reviewClaim?: WorkerActionClaim;
  readonly reviewerRunId?: RunId;
  readonly semanticReviewClaim?: ReviewRecordClaim;
  readonly reviewRecordId?: ReviewId;
  readonly reviewVerdict?: LoopReviewVerdict;
  readonly reviewFindings?: readonly string[];
  readonly reviewParseError?: string;
}

export function openIteration(iteration: number): LoopIterationRecord {
  return { iteration };
}

export interface EngineeringLoop {
  readonly id: string;
  readonly workItemId: WorkItemId;
  /**
   * Optimistic-concurrency token AND the loop's coordination linearization
   * point: claims, phase changes and cancellation all CAS on it, so exactly
   * one writer wins any given step and a durably-committed cancellation
   * always defeats a stale claim attempt.
   */
  readonly version: number;
  readonly phase: LoopPhase;
  readonly budget: LoopBudget;
  readonly implementer: LoopWorkerConfig;
  readonly reviewer: LoopWorkerConfig;
  readonly verificationCommands: readonly VerificationCommandConfig[];
  readonly workspaceRoot: string;
  readonly taskInstructions: string;
  readonly iterations: readonly LoopIterationRecord[];
  /** Completed claimed-action worker runs (fresh or adopted — each counted exactly once). */
  readonly totalRunCount: number;
  readonly outcome?: LoopOutcome;
  readonly failureReason?: string;
  readonly exhaustionKind?: ExhaustionKind;
  readonly cancelRequested: boolean;
  readonly startedBy: Actor;
  readonly startedAt: Timestamp;
  readonly lastTransitionAt: Timestamp;
}

/** Safe, minimal projection for `sf loop status` — no raw transcripts, no secrets. */
export interface LoopStatusView {
  readonly id: string;
  readonly workItemId: WorkItemId;
  readonly phase: LoopPhase;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly lastImplementerRunId?: RunId;
  readonly lastImplementerOutcome?: "SUCCEEDED" | "FAILED";
  readonly lastVerificationPassed?: boolean;
  readonly lastVerificationFailedCommandIds?: readonly string[];
  readonly lastReviewVerdict?: LoopReviewVerdict;
  readonly outcome?: LoopOutcome;
  readonly failureReason?: string;
  readonly totalRunCount: number;
  readonly humanActionRequired: boolean;
}

export function toStatusView(loop: EngineeringLoop): LoopStatusView {
  const last = loop.iterations.at(-1);
  const failedCommandIds = last?.verificationCommandResults?.filter((r) => !r.passed).map((r) => r.commandId);
  return {
    id: loop.id,
    workItemId: loop.workItemId,
    phase: loop.phase,
    iteration: loop.iterations.length,
    maxIterations: loop.budget.maxIterations,
    ...(last?.implementerRunId === undefined ? {} : { lastImplementerRunId: last.implementerRunId }),
    ...(last?.implementerOutcome === undefined ? {} : { lastImplementerOutcome: last.implementerOutcome }),
    ...(last?.verificationPassed === undefined ? {} : { lastVerificationPassed: last.verificationPassed }),
    ...(failedCommandIds === undefined || failedCommandIds.length === 0
      ? {}
      : { lastVerificationFailedCommandIds: failedCommandIds }),
    ...(last?.reviewVerdict === undefined ? {} : { lastReviewVerdict: last.reviewVerdict }),
    ...(loop.outcome === undefined ? {} : { outcome: loop.outcome }),
    ...(loop.failureReason === undefined ? {} : { failureReason: loop.failureReason }),
    totalRunCount: loop.totalRunCount,
    humanActionRequired: isTerminalLoopPhase(loop.phase) && loop.phase !== "CANCELLED",
  };
}
