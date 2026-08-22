/**
 * TASK-005 durable planner — persisted state types.
 *
 * Like `src/orchestration/loopTypes.ts` (TASK-004), these are
 * orchestration-layer concepts: they coordinate multiple trusted
 * `FactoryService` calls and sit ABOVE the accepted TASK-001 domain model
 * (docs/DOMAIN_MODEL.md), which this task does not modify. See
 * docs/tasks/TASK-005-planner-task-generator.md for the full design.
 *
 * The load-bearing idea, inherited from TASK-004's remediation history: a
 * persisted phase is a CHECKPOINT, never authority. `APPROVED` in this table
 * does not mean a human approved anything — it means the last writer believed
 * so. Authority is always re-derived from the Factory's own append-only
 * approval records through the accepted central gate, and every approved
 * revision is additionally bound by a CONTENT DIGEST so that "the revision
 * number is unchanged" can never stand in for "the content is unchanged".
 */

import type { Actor } from "../domain/actor.js";
import type { ApprovalId, ProjectId, WorkItemId } from "../domain/ids.js";
import type { Timestamp } from "../domain/time.js";
import type { Priority, WorkItemType } from "../domain/workItem.js";
import type { MaterializedItemShape } from "../ports/planBindingResolver.js";

export const PLAN_PHASES = [
  "DRAFT",
  "PLANNING",
  "NEEDS_CLARIFICATION",
  "PLAN_REVIEW",
  "APPROVED",
  "MATERIALIZING",
  "EXECUTING",
  "WAITING_FOR_HUMAN",
  "COMPLETED",
  "REJECTED",
  "BLOCKED",
  "CANCELLED",
  "RECOVERY_REQUIRED",
] as const;

export type PlanPhase = (typeof PLAN_PHASES)[number];

/**
 * Phases in which the plan is finished for good. `BLOCKED` and
 * `WAITING_FOR_HUMAN` are deliberately NOT here: both take no further
 * automatic action, but a later `resume` legitimately re-derives them from
 * authoritative state (a human may have released a blocking item since).
 */
export const TERMINAL_PLAN_PHASES: readonly PlanPhase[] = [
  "COMPLETED",
  "REJECTED",
  "CANCELLED",
  "RECOVERY_REQUIRED",
];

/**
 * Phases eligible for the persistence-level one-active-plan-per-request
 * uniqueness rule (mirrors ACTIVE_LOOP_PHASES). `WAITING_FOR_HUMAN` and
 * `BLOCKED` are excluded so a stalled plan does not permanently prevent a new
 * plan for the same request being started after the human resolves it.
 */
export const ACTIVE_PLAN_PHASES: readonly PlanPhase[] = [
  "DRAFT",
  "PLANNING",
  "NEEDS_CLARIFICATION",
  "PLAN_REVIEW",
  "APPROVED",
  "MATERIALIZING",
  "EXECUTING",
];

export function isTerminalPlanPhase(phase: PlanPhase): boolean {
  return TERMINAL_PLAN_PHASES.includes(phase);
}

export const PLAN_OUTCOMES = ["COMPLETED", "REJECTED", "CANCELLED", "BLOCKED", "RECOVERY_REQUIRED"] as const;

export type PlanOutcome = (typeof PLAN_OUTCOMES)[number];

export const PLAN_EXHAUSTION_KINDS = ["PLANNER_ATTEMPTS", "CLARIFICATION_CYCLES", "TOTAL_PLANNER_RUNS", "WALL_CLOCK"] as const;

export type PlanExhaustionKind = (typeof PLAN_EXHAUSTION_KINDS)[number];

/**
 * Planner budgets, deliberately SEPARATE from `LoopBudget`: a planning retry
 * and an implementation remediation are different resources with different
 * failure modes, and mixing them would let a chatty planner silently consume
 * the implementation allowance (or vice versa).
 */
export interface PlanBudget {
  /** Ceiling on planner attempts for ONE revision, including parse-failure retries. Always >= 1. */
  readonly maxPlannerAttempts: number;
  /** Ceiling on how many times the plan may go round the clarification loop. */
  readonly maxClarificationCycles: number;
  /** Ceiling on planner actions across the whole plan's life. */
  readonly maxTotalPlannerRuns: number;
  readonly maxWallClockMs?: number;
}

export const DEFAULT_PLAN_BUDGET: PlanBudget = {
  maxPlannerAttempts: 2,
  maxClarificationCycles: 2,
  maxTotalPlannerRuns: 6,
};

/** Provider-neutral planner configuration (C9): no vendor name appears in the planning layer. */
export interface PlannerConfig {
  readonly tool: string;
  readonly model: string;
  readonly effort?: string;
  readonly timeoutMs?: number;
}

/**
 * How approved work items are to be executed. Captured at plan start and
 * persisted, so a restart dispatches with byte-identical configuration rather
 * than whatever the current process defaults happen to be.
 */
export interface PlanExecutionConfig {
  readonly implementer: PlannerConfig;
  readonly reviewer: PlannerConfig;
  readonly verificationCommands: readonly {
    readonly id: string;
    readonly executable: string;
    readonly argv: readonly string[];
    readonly cwd?: string;
    readonly timeoutMs?: number;
  }[];
  readonly workspaceRoot: string;
  readonly loopBudget?: {
    readonly maxIterations?: number;
    readonly maxTotalRuns?: number;
    readonly maxWallClockMs?: number;
    readonly workerTimeoutMs?: number;
    readonly verificationTimeoutMs?: number;
  };
}

/** One proposed work item inside a plan revision. Plan-local until materialized. */
export interface PlannedWorkItem {
  /** Plan-local identifier, unique within the revision (e.g. "WI-A"). Never a Factory id. */
  readonly key: string;
  readonly title: string;
  readonly type: WorkItemType;
  readonly priority: Priority;
  /** The explicit Spec. A work item with no spec is refused by planValidation. */
  readonly spec: string;
  readonly acceptanceCriteria: readonly { readonly text: string; readonly verificationHint: string }[];
  /** Plan-local keys of prerequisites; validated to exist, be acyclic and non-self-referential. */
  readonly dependsOn: readonly string[];
}

/**
 * An immutable generated plan. Revisions are append-only; a material change
 * produces revision N+1 and re-enters PLAN_REVIEW, and an approval of N never
 * authorizes N+1 (the gate binding compares both the number and the digest).
 */
export interface PlanRevision {
  /** 1-based, strictly increasing with no gaps (validated on read). */
  readonly revision: number;
  readonly summary: string;
  /** Conventional reversible choices the planner made instead of interrupting the human. */
  readonly assumptions: readonly string[];
  readonly constraints: readonly string[];
  readonly risks: readonly string[];
  readonly items: readonly PlannedWorkItem[];
  /**
   * SHA-256 over a canonical serialization of everything semantically
   * authoritative in this revision (see planDigest.ts). Derived, never trusted:
   * `planSerialization` recomputes it on every read and refuses a mismatch.
   */
  readonly contentDigest: string;
  /** Audit reference to the planner action that produced this revision. */
  readonly plannerRunRef: string;
  readonly generatedAt: Timestamp;
}

export interface ClarificationQuestion {
  /** Stable within the revision that asked it; answers bind to (plan, revision, id). */
  readonly id: string;
  readonly question: string;
  readonly why: string;
}

export interface ClarificationAnswer {
  readonly questionId: string;
  /**
   * The clarification round that asked this question (1-based, monotonic).
   *
   * Question ids are chosen by the planner and are only unique WITHIN a round —
   * a planner may legitimately call its first question "q1" in every round. So
   * the round number, not the id, is what makes an answer's lineage
   * identifiable, and `(questionId, askedAtCycle)` is the real key.
   */
  readonly askedAtCycle: number;
  /** How many approvable revisions existed when the question was asked. */
  readonly askedAtRevision: number;
  readonly question: string;
  readonly answer: string;
  readonly answeredBy: Actor;
  readonly answeredAt: Timestamp;
}

export const PLANNER_ACTION_STATES = ["CLAIMED", "RUNNING"] as const;

export type PlannerActionState = (typeof PLANNER_ACTION_STATES)[number];

/**
 * A durable lease on ONE external planner invocation (remediation round 1,
 * HIGH 5).
 *
 * Before this existed, `PLANNING` simply meant "retryable", so a second caller
 * arriving while the first planner was still in flight claimed another attempt
 * and a second real model run was launched for one logical action. That is the
 * same external-side-effect hazard TASK-004 solved with action claims, and it
 * is solved the same way here.
 *
 * The two states are what preserve safe retry without ever risking a duplicate:
 *
 *   CLAIMED — written BEFORE anything external happens. Finding this after a
 *             restart PROVES no planner was launched, so a bounded, budgeted
 *             retry is safe.
 *   RUNNING — written immediately before the planner is invoked. Finding this
 *             owned by a process that is gone means the outcome is unknowable,
 *             so the plan fails closed to RECOVERY_REQUIRED rather than
 *             spending a second model run to find out.
 *
 * `ownerId` identifies the PlanningService instance holding the lease. It is
 * durable, so it survives restart; liveness within one process is tracked
 * separately in memory, because "is that owner still running?" is not a
 * question durable state can answer.
 */
export interface PlannerAction {
  readonly revision: number;
  readonly attempt: number;
  readonly correlationTag: string;
  readonly ownerId: string;
  readonly state: PlannerActionState;
  readonly claimedAt: Timestamp;
}

/**
 * A durable claim on creating ONE work item, written via CAS BEFORE the
 * creation is attempted. Its `correlationTag` becomes the created WorkItem's
 * `planVersion` — durably recorded by the accepted `createWorkItem` in the same
 * transaction — which is the stable identity crash reconciliation matches on.
 * The same technique TASK-004 used with `declaredWorkerId`.
 */
export interface MaterializationClaim {
  readonly planItemKey: string;
  readonly correlationTag: string;
  readonly claimedAt: Timestamp;
}

/** A committed plan-item -> Factory WorkItem mapping. Append-only in practice. */
export interface MaterializedItem {
  readonly planItemKey: string;
  readonly workItemId: WorkItemId;
  readonly correlationTag: string;
  readonly materializedAt: Timestamp;
  /** True once the derived PLAN_APPROVAL was recorded and the item reached READY. */
  readonly readied: boolean;
}

/**
 * A durable claim on dispatching ONE readied item, written via CAS BEFORE the
 * loop is started. This is what makes the cancel-vs-dispatch race safe: a
 * cancellation that commits first bumps the version, so this claim's CAS loses
 * and the loop is never started at all. If instead the claim wins, the loop
 * starts and a later cancellation correctly means "no NEW dispatch", leaving
 * the running loop to TASK-004's own accepted cancellation semantics rather
 * than attempting an unsafe hard kill.
 */
export interface DispatchClaim {
  readonly planItemKey: string;
  readonly workItemId: WorkItemId;
  readonly claimedAt: Timestamp;
}

/** A committed dispatch of one materialized item to the TASK-004 engineering loop. */
export interface DispatchRecord {
  readonly planItemKey: string;
  readonly workItemId: WorkItemId;
  readonly loopId: string;
  readonly dispatchedAt: Timestamp;
  /** True when the dispatch was adopted from an existing loop rather than freshly started. */
  readonly adopted: boolean;
}

export const PLAN_EVENT_KINDS = [
  "REQUEST_CREATED",
  "PLANNER_RUN_STARTED",
  "PLANNER_RUN_FAILED",
  "PLANNER_OUTPUT_REJECTED",
  "REVISION_GENERATED",
  "CLARIFICATION_REQUESTED",
  "CLARIFICATION_ANSWERED",
  "ENTERED_PLAN_REVIEW",
  "APPROVED",
  "REJECTED",
  "MATERIALIZATION_STARTED",
  "WORK_ITEM_MATERIALIZED",
  "WORK_ITEM_READIED",
  "DISPATCHED",
  "ITEM_TERMINAL",
  "BUDGET_EXHAUSTED",
  "BLOCKED",
  "CANCELLED",
  "RECOVERY_REQUIRED",
  "COMPLETED",
] as const;

export type PlanEventKind = (typeof PLAN_EVENT_KINDS)[number];

/** Append-only audit record (C8). `detail` is bounded and never carries credentials (C6). */
export interface PlanEvent {
  /** 1-based, strictly increasing with no gaps (validated on read). */
  readonly seq: number;
  readonly kind: PlanEventKind;
  readonly detail: string;
  readonly at: Timestamp;
}

/** Bound applied to every event detail before it is persisted — audit data, not a transcript. */
export const MAX_EVENT_DETAIL_LENGTH = 500;

export interface Plan {
  readonly id: string;
  readonly projectId: ProjectId;
  /**
   * Deterministic identity of the human request (see canonicalRequestKey).
   * Carries the database's active-plan uniqueness constraint, so starting the
   * same intent twice adopts the existing plan instead of duplicating it.
   */
  readonly requestKey: string;
  /**
   * Optimistic-concurrency token AND the plan's coordination linearization
   * point: claims, phase changes, approvals and cancellation all CAS on it, so
   * exactly one writer wins any step and a durably-committed cancellation
   * always defeats a stale claim.
   */
  readonly version: number;
  readonly phase: PlanPhase;
  /** The original, verbatim human goal. Never rewritten by any model. */
  readonly intent: string;
  readonly declaredConstraints: readonly string[];
  readonly budget: PlanBudget;
  readonly planner: PlannerConfig;
  readonly execution: PlanExecutionConfig;

  readonly revisions: readonly PlanRevision[];
  readonly openQuestions: readonly ClarificationQuestion[];
  readonly answers: readonly ClarificationAnswer[];

  /**
   * The in-flight planner lease. Present exactly while `phase === "PLANNING"`
   * (a presupposition `planSerialization` enforces on read), absent otherwise.
   */
  readonly plannerAction?: PlannerAction;

  /** Planner attempts spent on the revision currently being generated. */
  readonly attemptsForCurrentRevision: number;
  readonly clarificationCycles: number;
  readonly totalPlannerRuns: number;

  /**
   * The Factory approval id a human recorded for `approvedRevision`. Present
   * only after approval — and still never trusted on its own: it is re-read
   * from the append-only approvals table and re-checked against the live
   * revision digest on every use.
   */
  readonly approvalId?: ApprovalId;
  readonly approvedRevision?: number;
  readonly approvedDigest?: string;

  readonly materializationClaim?: MaterializationClaim;
  readonly materialized: readonly MaterializedItem[];
  readonly dispatchClaim?: DispatchClaim;
  readonly dispatches: readonly DispatchRecord[];

  readonly outcome?: PlanOutcome;
  readonly failureReason?: string;
  readonly exhaustionKind?: PlanExhaustionKind;
  readonly cancelRequested: boolean;

  readonly events: readonly PlanEvent[];
  readonly startedBy: Actor;
  readonly startedAt: Timestamp;
  readonly lastTransitionAt: Timestamp;
}

/**
 * THE only legitimate way a materialization correlation tag comes into
 * existence — a pure function of immutable coordinates, never random and never
 * model-controlled text (the TASK-004 round-2 lesson: a random claim id is
 * arbitrary trusted text that corruption could point at another action's
 * identity). Because it is derived, `planSerialization` can recompute the
 * EXPECTED tag for every claim/mapping it reads and reject any stored value
 * that does not match exactly.
 *
 * This value is written into the created WorkItem's `planVersion`, so it is
 * also the human-readable provenance of every materialized item.
 */
export function canonicalCorrelationTag(planId: string, revision: number, planItemKey: string): string {
  return `${planId}:r${revision}:${planItemKey}`;
}

/**
 * The same discipline for a planner lease's identity: derived from immutable
 * coordinates, so `planSerialization` can recompute the expected value and
 * reject a stored lease that names another action.
 */
export function canonicalPlannerActionTag(planId: string, revision: number, attempt: number): string {
  return `${planId}:r${revision}:planner:a${attempt}`;
}

/**
 * THE single definition of what an approved plan item must look like once it
 * exists as a Factory WorkItem (remediation round 1, HIGH 1/HIGH 3).
 *
 * Creation, crash reconciliation, adoption of a pre-existing candidate, derived
 * approval and read-time mapping validation all compare against this — so there
 * is exactly one answer to "is this work item the approved item?", and adding a
 * field here automatically tightens every one of those paths at once.
 *
 * `specRevision` is 1 by construction: `createWorkItem` starts every item at 1
 * and only the plan-rework edge bumps it.
 */
export function expectedMaterializedItemShape(
  projectId: ProjectId,
  correlationTag: string,
  item: PlannedWorkItem,
  dependencyWorkItemIds: readonly WorkItemId[],
): MaterializedItemShape {
  return {
    projectId,
    correlationTag,
    title: item.title,
    type: item.type,
    priority: item.priority,
    specRevision: 1,
    dependencyWorkItemIds: [...dependencyWorkItemIds],
    acceptanceCriteria: item.acceptanceCriteria.map((criterion) => ({
      text: criterion.text,
      verificationHint: criterion.verificationHint,
    })),
  };
}

/**
 * Deterministic identity of a human request. Two `plan start` calls with the
 * same project and the same intent text produce the same key, which is what
 * makes duplicate planning start a database-level impossibility rather than a
 * check-then-insert race.
 */
export function canonicalRequestKey(projectId: ProjectId, intent: string, hash: (input: string) => string): string {
  return `req-${hash(`${projectId}|${intent}`).slice(0, 16)}`;
}

/** Safe, minimal projection for `sf plan status` — no raw planner transcripts, no secrets. */
export interface PlanStatusView {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly phase: PlanPhase;
  readonly revision: number;
  readonly approvedRevision?: number;
  readonly summary?: string;
  readonly openQuestionCount: number;
  readonly itemCount: number;
  readonly materializedCount: number;
  readonly dispatchedCount: number;
  readonly outcome?: PlanOutcome;
  readonly failureReason?: string;
  readonly totalPlannerRuns: number;
  readonly humanActionRequired: boolean;
}

export function toPlanStatusView(plan: Plan): PlanStatusView {
  const latest = plan.revisions.at(-1);
  const humanActionRequired =
    plan.phase === "PLAN_REVIEW" || plan.phase === "NEEDS_CLARIFICATION" || plan.phase === "WAITING_FOR_HUMAN" || plan.phase === "BLOCKED" || plan.phase === "RECOVERY_REQUIRED";
  return {
    id: plan.id,
    projectId: plan.projectId,
    phase: plan.phase,
    revision: latest?.revision ?? 0,
    ...(plan.approvedRevision === undefined ? {} : { approvedRevision: plan.approvedRevision }),
    ...(latest?.summary === undefined ? {} : { summary: latest.summary }),
    openQuestionCount: plan.openQuestions.length,
    itemCount: latest?.items.length ?? 0,
    materializedCount: plan.materialized.length,
    dispatchedCount: plan.dispatches.length,
    ...(plan.outcome === undefined ? {} : { outcome: plan.outcome }),
    ...(plan.failureReason === undefined ? {} : { failureReason: plan.failureReason }),
    totalPlannerRuns: plan.totalPlannerRuns,
    humanActionRequired,
  };
}
