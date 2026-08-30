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
import type { BillingMode, SupervisedAction } from "./financialSafety.js";
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

/**
 * One AI resource a piece of work will launch, named by the ROLE that launches
 * it (TASK-015 AC-2).
 *
 * Roles are not aliases. A plan's planner, implementer and reviewer are three
 * different jobs that may legitimately run on three different models — and for
 * critical work C4 REQUIRES the reviewer to differ from the implementer. The
 * role travels with the identity so provenance can say which role used which
 * resource, rather than recording a set and losing who was who.
 */
export interface RequiredResource {
  readonly role: string;
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
}

/**
 * A resource the supervisor has INDIVIDUALLY probed and gated for this action.
 *
 * Membership is the authority. There is no "same provider, therefore allowed"
 * and no inheriting permission from a sibling that passed: every member of this
 * list went through the same probe, the same billing observation and the same
 * financial gate as a single routed resource does.
 */
export interface AuthorizedResource extends RequiredResource {
  /** Observed in-process immediately before the gate, never read from a row. */
  readonly billingMode: BillingMode;
}

export interface WorkExecutionInput {
  readonly item: RoadmapItem;
  readonly actionId: string;
  /** Absent for DETERMINISTIC work, which needs no AI resource at all. */
  readonly config?: AiRunConfigRecord;
  /**
   * EVERY resource this action may launch, one entry per role (TASK-015).
   *
   * The executor declared what the work needs; the supervisor decided. An
   * executor may not launch a resource that is absent from this list, and the
   * list is exact — it is not a hint, a preference or a starting point.
   */
  readonly authorizedResources?: readonly AuthorizedResource[];
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
  /**
   * What this work will launch, stated BEFORE anything launches (TASK-015 AC-2).
   *
   * The supervisor cannot know a plan's worker configuration — the plan is the
   * executor's business — so it asks. It then authorises exactly this set, or
   * refuses the whole action. Declaring is not permission: an executor that
   * under-declares does not thereby gain the right to launch the rest, because
   * the executor re-checks what it is about to run against
   * `input.authorizedResources` at the last point before launch.
   *
   * OPTIONAL, and its absence is today's behaviour exactly: an executor that
   * declares nothing gets the single routed resource and nothing changes.
   */
  declareResources?(item: RoadmapItem): Promise<readonly RequiredResource[]>;
  execute(input: WorkExecutionInput): Promise<WorkOutcome>;
}
