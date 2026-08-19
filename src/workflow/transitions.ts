/**
 * The single source of truth for WorkItem status changes.
 *
 * Every legal move is a row in this table. Anything absent is illegal, which
 * is what makes acceptance criterion 5 ("invalid state transitions fail
 * deterministically") checkable rather than aspirational.
 *
 * Four kinds of guard can sit on a row, all enforced by WorkflowService:
 *   - `requiredGate`: a granted, non-stale human approval must exist.
 *   - `requiresHumanAuthorization`: only a HUMAN actor may perform it.
 *   - `precondition`: real evidence (a successful run, a passing review, a
 *     verified criterion) must exist at the work item's current revision.
 *     Without this, an agent could walk IDEA -> ... -> DONE by traversing
 *     the table alone with zero runs and zero evidence — the CRITICAL
 *     finding this table now closes.
 *   - `resetsSpecRevision`: bumps WorkItem.specRevision, invalidating a
 *     PLAN_APPROVAL for the superseded plan. Only the plan-rework edge sets
 *     it. Implementation staleness is decided by content, not by this
 *     counter — see src/workflow/releaseSnapshotResolver.ts.
 *
 * Two rows carry both a gate and (for RELEASE_APPROVAL) an evidence
 * precondition:
 *   PLAN_REVIEW -> READY          requires PLAN_APPROVAL
 *   WAITING_FOR_HUMAN -> DONE     requires RELEASE_APPROVAL + all criteria verified
 *
 * Note there is deliberately no IMPLEMENTING -> DONE row, and no path to DONE
 * that skips WAITING_FOR_HUMAN.
 *
 * BLOCKED is intentionally reachable from several statuses but, per row,
 * only resumable to that same status — WorkflowService additionally checks
 * `item.blockedFrom` at runtime so a block can never be used to re-enter the
 * workflow at a different (and possibly less-guarded) status than the one it
 * left (remediation of "BLOCKED must never be usable to bypass PLAN_REVIEW
 * or PLAN_APPROVAL": previously BLOCKED -> READY was a bare row that let
 * ANALYSIS -> BLOCKED -> READY skip PLAN_REVIEW and PLAN_APPROVAL entirely).
 */

import type { ProtectedGate } from "../domain/approval.js";
import type { WorkItemStatus } from "../domain/status.js";
import {
  requireIndependentSemanticReview,
  requireReleasableSnapshot,
  requireSuccessfulImplementationRun,
  requireSuccessfulVerification,
  type Precondition,
} from "./preconditions.js";

export interface TransitionRule {
  readonly from: WorkItemStatus;
  readonly to: WorkItemStatus;
  /** When set, a granted, non-stale human approval for this gate is mandatory. */
  readonly requiredGate?: ProtectedGate;
  /**
   * When true, this transition is a protected human decision: the caller must
   * present a TrustedHumanToken that verifies for a HUMAN actor. A caller-made
   * `{ kind: "HUMAN" }` object is not sufficient — that was a Round-2 exploit
   * against cancellation, which is now held to the same boundary as approvals.
   */
  readonly requiresHumanAuthorization?: boolean;
  /** When set, must be satisfied in addition to any gate before the transition is allowed. */
  readonly precondition?: Precondition;
  /**
   * When true, this edge invalidates the current plan: it bumps
   * `WorkItem.specRevision`, which makes a PLAN_APPROVAL for the previous
   * plan stale. Only the plan-rework edge sets it.
   *
   * Implementation staleness is deliberately NOT expressed here. A counter
   * cannot see implementation work, which happens between transitions; the
   * release gate compares content instead (see releaseSnapshotResolver.ts).
   */
  readonly resetsSpecRevision?: boolean;
  readonly description: string;
}

/** Statuses BLOCKED may be entered from and resumed back to (see module docs). */
export const BLOCKABLE_STATUSES: readonly WorkItemStatus[] = [
  "ANALYSIS",
  "PLAN_REVIEW",
  "READY",
  "IMPLEMENTING",
  "VERIFYING",
  "REVIEW",
];

const blockRules: TransitionRule[] = BLOCKABLE_STATUSES.flatMap((status) => [
  { from: status, to: "BLOCKED", description: `Blocked during ${status}` } satisfies TransitionRule,
  { from: "BLOCKED", to: status, description: `Resumed to ${status}` } satisfies TransitionRule,
]);

const cancelRules: TransitionRule[] = (
  [
    "IDEA",
    "ANALYSIS",
    "PLAN_REVIEW",
    "READY",
    "IMPLEMENTING",
    "VERIFYING",
    "REVIEW",
    "WAITING_FOR_HUMAN",
    "BLOCKED",
  ] as const
).map((status) => ({
  from: status,
  to: "CANCELLED",
  requiresHumanAuthorization: true,
  description: "Cancelled by human",
}));

export const TRANSITION_RULES: readonly TransitionRule[] = [
  { from: "IDEA", to: "ANALYSIS", description: "Intent picked up for analysis" },
  { from: "ANALYSIS", to: "PLAN_REVIEW", description: "Plan drafted, awaiting review" },
  { from: "PLAN_REVIEW", to: "ANALYSIS", resetsSpecRevision: true, description: "Plan sent back for rework" },
  {
    from: "PLAN_REVIEW",
    to: "READY",
    requiredGate: "PLAN_APPROVAL",
    description: "Plan approved by a human, work item is ready",
  },
  { from: "READY", to: "IMPLEMENTING", description: "Implementation run started" },
  {
    from: "IMPLEMENTING",
    to: "VERIFYING",
    precondition: requireSuccessfulImplementationRun,
    description: "Implementation finished, checks pending",
  },
  { from: "VERIFYING", to: "IMPLEMENTING", description: "Checks failed, back to implementation" },
  {
    from: "VERIFYING",
    to: "REVIEW",
    precondition: requireSuccessfulVerification,
    description: "Checks passed, awaiting review",
  },
  { from: "REVIEW", to: "IMPLEMENTING", description: "Reviewer requested changes" },
  {
    from: "REVIEW",
    to: "WAITING_FOR_HUMAN",
    precondition: requireIndependentSemanticReview,
    description: "Review passed, awaiting human decision",
  },
  { from: "WAITING_FOR_HUMAN", to: "IMPLEMENTING", description: "Human rejected, rework required" },
  {
    from: "WAITING_FOR_HUMAN",
    to: "DONE",
    requiredGate: "RELEASE_APPROVAL",
    precondition: requireReleasableSnapshot,
    description: "Human accepted the work item",
  },

  ...blockRules,
  ...cancelRules,
];

export function findRule(from: WorkItemStatus, to: WorkItemStatus): TransitionRule | undefined {
  return TRANSITION_RULES.find((rule) => rule.from === from && rule.to === to);
}

export function allowedTargets(from: WorkItemStatus): readonly WorkItemStatus[] {
  return TRANSITION_RULES.filter((rule) => rule.from === from).map((rule) => rule.to);
}

/** Every transition that a protected gate guards, for reporting/inspection. */
export function gatedTransitions(): readonly TransitionRule[] {
  return TRANSITION_RULES.filter((rule) => rule.requiredGate !== undefined);
}
