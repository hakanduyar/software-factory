/**
 * The live-state bindings a PLAN-derived approval is judged against (TASK-005).
 *
 * `FactoryService.recordApproval` stamps a WORK_ITEM approval's context from
 * live state — `specRevision` for a plan gate, `snapshotId` for a release gate
 * — precisely so an approving caller cannot make an approval look current for
 * something it never saw. A PLAN subject needs the same treatment, but the
 * durable Plan lives in the TASK-005 orchestration layer, above the domain and
 * above `app/`. Injecting this narrow read-only port keeps the direction of
 * dependency correct: `FactoryService` asks for a binding, it never learns what
 * a Plan is.
 *
 * A `FactoryService` configured without a resolver refuses to record or derive
 * a PLAN approval at all, rather than proceeding with no binding — an unbound
 * approval would satisfy a digest-checked gate vacuously, which is exactly the
 * failure mode `GateBinding.planContentDigest` exists to prevent.
 *
 * REMEDIATION ROUND 1, HIGH 1. This port originally described only "what would
 * a plan approval be granted for". That let `recordDerivedPlanApproval` accept
 * a bare `workItemId` from its caller as proof of membership, and independent
 * review derived one plan's approval onto unrelated work items — including work
 * items in a different project. Membership is now a QUESTION ANSWERED BY
 * DURABLE PLAN STATE (`resolveMaterializationTarget`), and the answer carries
 * the complete expected content, so the app layer can compare what the approved
 * plan says against what the Factory actually stored.
 */

import { createHash } from "node:crypto";

export interface PlanApprovalBinding {
  /** The revision currently awaiting a human decision. */
  readonly planRevision: number;
  /**
   * The digest of everything that human is approving: the revision's content
   * AND the plan configuration that decides where and how it will be executed
   * (see `computePlanApprovalDigest` in src/planning/planDigest.ts). Named
   * `approvalDigest`, not `contentDigest`, because round 1 proved that a name
   * saying "content" invites leaving execution configuration out of it.
   */
  readonly approvalDigest: string;
}

/**
 * The complete, execution-authoritative shape of ONE materialized work item.
 *
 * This is the single canonical definition used by creation, by crash
 * reconciliation, by adoption of a pre-existing candidate and by derived
 * approval — so "the same item" means exactly one thing everywhere. A
 * correlation tag identifies a CANDIDATE; only this shape proves the candidate
 * is the approved item (remediation round 1, HIGH 3).
 */
export interface MaterializedItemShape {
  readonly projectId: string;
  readonly correlationTag: string;
  readonly title: string;
  readonly type: string;
  readonly priority: string;
  /**
   * Always 1 for a plan-materialized item: the only edge that bumps
   * `specRevision` is PLAN_REVIEW -> ANALYSIS (plan rework), and an item whose
   * spec was reworked outside the plan is no longer the thing the human
   * approved.
   */
  readonly specRevision: number;
  /** Factory ids, in the approved `dependsOn` order. A sequence, not a set. */
  readonly dependencyWorkItemIds: readonly string[];
  readonly acceptanceCriteria: readonly { readonly text: string; readonly verificationHint: string }[];
}

/** What the approved plan says work item X must be. Resolved from durable plan state only. */
export interface ApprovedMaterializationTarget {
  readonly planRevision: number;
  readonly approvalDigest: string;
  readonly planItemKey: string;
  readonly expected: MaterializedItemShape;
}

export type BindingResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export interface PlanBindingResolver {
  /**
   * Resolves what a PLAN approval would be granted for right now. Returns
   * `ok: false` — refusing the approval — when the plan does not exist, is not
   * currently awaiting a human decision, or has no validated revision to
   * approve. Never throws for those cases: a refusal reason is data.
   */
  resolveApprovalBinding(planId: string): Promise<BindingResult<PlanApprovalBinding>>;

  /**
   * Proves, from durable plan state alone, that `workItemId` is EXACTLY the
   * materialization of one item of this plan's currently approved revision —
   * and returns the complete content that item is required to have.
   *
   * `ok: false` for every other case: unknown plan, no recorded approval, an
   * approval superseded by a newer revision, a durable cancellation request, or
   * a work item that simply is not one of this plan's materialized targets. The
   * caller may not substitute its own judgement for a refusal here.
   */
  resolveMaterializationTarget(planId: string, workItemId: string): Promise<BindingResult<ApprovedMaterializationTarget>>;
}

// =====================================================================
// Canonical fingerprint (shared by the planning layer and the app layer)
// =====================================================================

function seg(value: string): string {
  return `${value.length}:${value}`;
}

function segList(values: readonly string[]): string {
  return `${values.length}[${values.map(seg).join("")}]`;
}

/**
 * One deterministic string for one materialized item shape. Length-prefixed
 * throughout so two different shapes can never serialize identically.
 */
export function materializedItemFingerprint(shape: MaterializedItemShape): string {
  const criteria = shape.acceptanceCriteria.map((criterion) => `${seg(criterion.text)}${seg(criterion.verificationHint)}`);
  const canonical = [
    "mitem-v1",
    `projectId:${seg(shape.projectId)}`,
    `correlationTag:${seg(shape.correlationTag)}`,
    `title:${seg(shape.title)}`,
    `type:${seg(shape.type)}`,
    `priority:${seg(shape.priority)}`,
    `specRevision:${shape.specRevision}`,
    `dependencies:${segList(shape.dependencyWorkItemIds)}`,
    `ac:${criteria.length}[${criteria.join("")}]`,
  ].join("|");
  return `mitem-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Field-by-field first (so a mismatch produces a usable recovery diagnostic),
 * then a whole-shape fingerprint equality as the backstop — if a field is ever
 * added to the shape and forgotten here, the fingerprint still refuses.
 */
export function compareMaterializedItemShape(
  expected: MaterializedItemShape,
  actual: MaterializedItemShape,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (expected.projectId !== actual.projectId) {
    return { ok: false, reason: `project ${actual.projectId} is not the approved project ${expected.projectId}` };
  }
  if (expected.correlationTag !== actual.correlationTag) {
    return { ok: false, reason: `planVersion "${actual.correlationTag}" is not the approved "${expected.correlationTag}"` };
  }
  if (expected.title !== actual.title) {
    return { ok: false, reason: `title "${actual.title}" is not the approved "${expected.title}"` };
  }
  if (expected.type !== actual.type) {
    return { ok: false, reason: `type ${actual.type} is not the approved ${expected.type}` };
  }
  if (expected.priority !== actual.priority) {
    return { ok: false, reason: `priority ${actual.priority} is not the approved ${expected.priority}` };
  }
  if (expected.specRevision !== actual.specRevision) {
    return {
      ok: false,
      reason: `spec revision ${actual.specRevision} is not the approved ${expected.specRevision}; the spec was revised outside this plan`,
    };
  }
  if (!sameStrings(expected.dependencyWorkItemIds, actual.dependencyWorkItemIds)) {
    return {
      ok: false,
      reason: `dependencies [${actual.dependencyWorkItemIds.join(", ")}] are not the approved [${expected.dependencyWorkItemIds.join(", ")}]`,
    };
  }
  if (expected.acceptanceCriteria.length !== actual.acceptanceCriteria.length) {
    return {
      ok: false,
      reason: `${actual.acceptanceCriteria.length} acceptance criteria, not the approved ${expected.acceptanceCriteria.length}`,
    };
  }
  for (const [index, criterion] of expected.acceptanceCriteria.entries()) {
    const found = actual.acceptanceCriteria[index];
    if (found === undefined || found.text !== criterion.text || found.verificationHint !== criterion.verificationHint) {
      return { ok: false, reason: `acceptance criterion ${index + 1} is not the approved one (C2)` };
    }
  }
  const expectedPrint = materializedItemFingerprint(expected);
  const actualPrint = materializedItemFingerprint(actual);
  if (expectedPrint !== actualPrint) {
    return { ok: false, reason: `materialization fingerprint ${actualPrint} is not the approved ${expectedPrint}` };
  }
  return { ok: true };
}
