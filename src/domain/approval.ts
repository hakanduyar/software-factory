/**
 * Protected gates and human approvals (C1, C5, docs/DOMAIN_MODEL.md).
 */

import { createHash } from "node:crypto";

import type { Actor } from "./actor.js";
import type { ApprovalId } from "./ids.js";
import type { Timestamp } from "./time.js";

export const PROTECTED_GATES = [
  "PLAN_APPROVAL",
  "RELEASE_APPROVAL",
  "PUBLISH_APPROVAL",
  "CONSTITUTION_CHANGE",
] as const;

export type ProtectedGate = (typeof PROTECTED_GATES)[number];

export const APPROVAL_DECISIONS = ["APPROVED", "REJECTED"] as const;

export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const SUBJECT_TYPES = ["WORK_ITEM", "PLAN", "ARTIFACT", "CONSTITUTION"] as const;

export type SubjectType = (typeof SUBJECT_TYPES)[number];

/** What an approval is about. Gates are not global switches. */
export interface SubjectRef {
  readonly type: SubjectType;
  readonly id: string;
}

/**
 * What an approval was actually granted for, captured by FactoryService from
 * live state at decision time — never supplied by the caller.
 *
 * `statusWhenDecided` records that the subject really was at the state where
 * that gate is meaningful; FactoryService refuses to record the approval
 * otherwise, so an approval cannot be pre-recorded at IDEA and cashed in
 * later.
 *
 * `specRevision` binds a PLAN_APPROVAL to the exact plan reviewed.
 * `snapshotId` binds a RELEASE_APPROVAL to the exact implementation +
 * verification + criterion-verification + review combination reviewed; see
 * src/domain/executionSnapshot.ts.
 *
 * The remaining fields exist for TASK-005 (durable planner). A PLAN-subject
 * approval additionally binds `planContentDigest` — the content hash of the
 * exact plan revision reviewed — for the same reason a RELEASE_APPROVAL binds
 * `snapshotId` rather than a counter: revision numbers alone cannot prove the
 * content did not change. A per-WorkItem approval *derived* from such a plan
 * approval records `derivedFromApprovalId`/`planId`/`planRevision`, so the
 * human decision it descends from is always auditable (C8) and never
 * inventable — see FactoryService.recordDerivedPlanApproval.
 */
export interface ApprovalContext {
  readonly statusWhenDecided: string;
  readonly specRevision: number;
  readonly snapshotId?: string;
  /** PLAN subjects: content hash of the exact approved plan revision. */
  readonly planContentDigest?: string;
  /** Derived WORK_ITEM approvals: the human PLAN approval this descends from. */
  readonly derivedFromApprovalId?: ApprovalId;
  readonly planId?: string;
  readonly planRevision?: number;
}

export function planSubject(id: string): SubjectRef {
  return { type: "PLAN", id };
}

export interface Approval {
  readonly id: ApprovalId;
  readonly gate: ProtectedGate;
  readonly subject: SubjectRef;
  readonly decision: ApprovalDecision;
  /** Always a HUMAN actor holding a verified TrustedHumanToken. */
  readonly decidedBy: Actor;
  /** Present for WORK_ITEM subjects; see ApprovalContext. */
  readonly context?: ApprovalContext;
  readonly note?: string;
  readonly decidedAt: Timestamp;
}

export function sameSubject(a: SubjectRef, b: SubjectRef): boolean {
  return a.type === b.type && a.id === b.id;
}

export function workItemSubject(id: string): SubjectRef {
  return { type: "WORK_ITEM", id };
}

/**
 * The canonical id of a DERIVED plan approval (TASK-005 remediation round 1,
 * HIGH 2).
 *
 * Derived rather than generated, for the same reason a materialization
 * correlation tag is: it makes idempotence a property of the record's IDENTITY
 * instead of a check-then-act race. Two callers deriving the same approval for
 * the same work item compute the same id, so the second insert is refused by
 * the store's own append-only rule — in memory and in SQLite alike — rather
 * than appending a second grant of the same authority.
 *
 * Every coordinate that would make this a genuinely DIFFERENT authorization is
 * in the hash: another plan, revision, source decision, target work item or
 * spec revision all produce a different id, and therefore a separate record.
 */
export function derivedPlanApprovalId(input: {
  readonly planId: string;
  readonly planRevision: number;
  readonly sourceApprovalId: string;
  readonly workItemId: string;
  readonly specRevision: number;
}): ApprovalId {
  const canonical = [
    "derived-plan-approval-v1",
    `plan:${input.planId.length}:${input.planId}`,
    `rev:${input.planRevision}`,
    `src:${input.sourceApprovalId.length}:${input.sourceApprovalId}`,
    `wi:${input.workItemId.length}:${input.workItemId}`,
    `spec:${input.specRevision}`,
  ].join("|");
  return `apr-d-${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`;
}

/** The work item status at which each work-item gate may legitimately be decided. */
export const GATE_DECISION_STATUS: Partial<Record<ProtectedGate, string>> = {
  PLAN_APPROVAL: "PLAN_REVIEW",
  RELEASE_APPROVAL: "WAITING_FOR_HUMAN",
};
