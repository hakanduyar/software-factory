/**
 * Protected gates and human approvals (C1, C5, docs/DOMAIN_MODEL.md).
 */

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
 * What a WORK_ITEM approval was actually granted for, captured by
 * FactoryService from live state at decision time — never supplied by the
 * caller.
 *
 * `statusWhenDecided` records that the item really was at the status where
 * that gate is meaningful; FactoryService refuses to record the approval
 * otherwise, so an approval cannot be pre-recorded at IDEA and cashed in
 * later.
 *
 * `specRevision` binds a PLAN_APPROVAL to the exact plan reviewed.
 * `snapshotId` binds a RELEASE_APPROVAL to the exact implementation +
 * verification + criterion-verification + review combination reviewed; see
 * src/domain/executionSnapshot.ts.
 */
export interface ApprovalContext {
  readonly statusWhenDecided: string;
  readonly specRevision: number;
  readonly snapshotId?: string;
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

/** The work item status at which each work-item gate may legitimately be decided. */
export const GATE_DECISION_STATUS: Partial<Record<ProtectedGate, string>> = {
  PLAN_APPROVAL: "PLAN_REVIEW",
  RELEASE_APPROVAL: "WAITING_FOR_HUMAN",
};
