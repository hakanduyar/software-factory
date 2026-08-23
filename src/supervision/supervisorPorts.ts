/**
 * The narrow seams between the supervisor and everything it drives.
 *
 * These exist so the supervisor can be tested — and reasoned about — without a
 * real provider, a real model or a real clock, and so that TASK-006
 * re-implements neither TASK-004's engineering loop nor TASK-005's planner. It
 * SCHEDULES them through `WorkExecutor`; it does not know what they do.
 */

import type { Timestamp } from "../domain/time.js";
import type { AiRunConfigRecord } from "./modelEnforcement.js";
import type { Classification } from "./resourceClassifier.js";
import type { SupervisedAction } from "./financialSafety.js";
import type { RoadmapItem, SessionCheckpoint, SupervisorState } from "./supervisorTypes.js";

export interface SupervisorRepository {
  load(): Promise<SupervisorState | undefined>;
  create(state: SupervisorState): Promise<SupervisorState>;
  /** CAS on `version`; throws ConcurrencyError when the expected version is stale. */
  compareAndSave(next: SupervisorState, expectedVersion: number): Promise<SupervisorState>;
}

/**
 * A ZERO-TOKEN availability probe.
 *
 * Implementations must not invoke a model. The real adapter uses the measured
 * commands `codex doctor --json` and `claude auth status`, both of which are
 * local/auth checks that cost nothing. Using a model to find out whether a
 * model is available is the exact anti-pattern TASK-006 exists to remove.
 */
export interface ResourceProbe {
  probe(provider: string, model: string): Promise<Classification>;
}

export interface WorkExecutionInput {
  readonly item: RoadmapItem;
  readonly actionId: string;
  /** Absent for DETERMINISTIC work, which needs no AI resource at all. */
  readonly config?: AiRunConfigRecord;
  /** Present when resuming: what a previous session got done. */
  readonly checkpoint?: SessionCheckpoint;
}

/**
 * What the executor reports back. Every variant is a fact about the work, never
 * an instruction about what the supervisor should do next — that decision
 * belongs to the supervisor, from durable state.
 */
/**
 * What the provider said it actually was, when it says anything at all.
 *
 * Review finding F4-9 (HIGH): the supervisor built a launch configuration and
 * had no way to learn what was really run, so a worker could launch a different
 * model or effort, report COMPLETED, and be believed. This is the channel for
 * that evidence. It is OPTIONAL and it is a CLAIM, not proof — an executor is
 * trusted code and could lie — but a claim that CONTRADICTS the request is
 * something the supervisor can and now does refuse to accept.
 */
export interface ReportedRunIdentity {
  /**
   * F5-ID-1: provider was not a dimension at all, so a worker could run on a
   * different provider entirely while echoing a matching model name.
   */
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
}

export type WorkOutcome =
  /** The item is finished and independently accepted. */
  | { readonly kind: "COMPLETED"; readonly detail: string; readonly reportedIdentity?: ReportedRunIdentity }
  /** Independent review found blockers; remediation is required. */
  | { readonly kind: "CHANGES_REQUIRED"; readonly findings: readonly string[] }
  /**
   * The provider failed. The raw process facts are handed back so the
   * SUPERVISOR classifies them — the executor never decides what a failure
   * means about a resource.
   */
  | {
      readonly kind: "RESOURCE_FAILURE";
      readonly process: {
        readonly terminationReason: "EXITED" | "TIMEOUT" | "CANCELLED" | "SPAWN_ERROR";
        readonly exitCode: number | null;
        readonly stdout: string;
        readonly stderr: string;
      };
      /** Only when the provider genuinely stated one. Never invented. */
      readonly retryAt?: Timestamp;
    }
  /** Progress was made, but the session must roll over (context exhausted). */
  | {
      readonly kind: "CHECKPOINT";
      readonly checkpoint: SessionCheckpoint;
      readonly detail: string;
      readonly reportedIdentity?: ReportedRunIdentity;
    }
  /** The work needs something only a human can do. */
  | { readonly kind: "HUMAN_REQUIRED"; readonly action: SupervisedAction; readonly detail: string };

export interface WorkExecutor {
  execute(input: WorkExecutionInput): Promise<WorkOutcome>;
}
