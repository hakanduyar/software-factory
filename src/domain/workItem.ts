import type {
  AcceptanceCriterionId,
  ProjectId,
  RunId,
  WorkItemId,
} from "./ids.js";
import type { FactoryRole } from "./role.js";
import type { WorkItemStatus } from "./status.js";
import type { Timestamp } from "./time.js";

export const WORK_ITEM_TYPES = ["FEATURE", "BUG", "REFACTOR", "RESEARCH", "CONTENT", "CHORE"] as const;

export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

export type Priority = (typeof PRIORITIES)[number];

export interface StatusChange {
  readonly from: WorkItemStatus;
  readonly to: WorkItemStatus;
  readonly actorId: string;
  readonly reason?: string;
  readonly at: Timestamp;
}

/**
 * The atomic tracked unit (docs/DOMAIN_MODEL.md). Treated as immutable: the
 * workflow service returns a new, deep-frozen value rather than mutating in
 * place, so an audit trail (C8) cannot be silently overwritten.
 */
export interface WorkItem {
  readonly id: WorkItemId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly type: WorkItemType;
  readonly status: WorkItemStatus;
  /**
   * The identity of the current plan/spec. Bumped when the plan is sent back
   * for rework (PLAN_REVIEW -> ANALYSIS), which is what makes a PLAN_APPROVAL
   * for the previous plan stale.
   *
   * This counter deliberately does NOT try to express "has the implementation
   * changed" — Round-2 review proved a counter cannot be trusted for that,
   * because implementation work happens without any transition. Release
   * staleness is decided by content instead; see
   * src/domain/executionSnapshot.ts.
   */
  readonly specRevision: number;
  /**
   * Bumped by every persisted write to this work item, including ones that
   * do not change `specRevision` (e.g. attaching a run's id to `runIds`).
   * `WorkItemRepository.compareAndSave` uses this purely as an optimistic
   * concurrency token so two concurrent writers cannot silently overwrite
   * each other's change. Never use `version` to reason about staleness of
   * runs, reviews or approvals — use `specRevision` for plan identity and a
   * ReleaseSnapshot for implementation identity.
   */
  readonly version: number;
  /**
   * Set only while status === "BLOCKED": the status the item was blocked
   * from. Resuming is only legal back to this exact status, so a block
   * cannot be used to skip statuses (remediation of "BLOCKED must never be
   * usable to bypass PLAN_REVIEW or PLAN_APPROVAL").
   */
  readonly blockedFrom?: WorkItemStatus;
  readonly priority: Priority;
  readonly planVersion: string;
  readonly dependencies: readonly WorkItemId[];
  readonly acceptanceCriteriaIds: readonly AcceptanceCriterionId[];
  readonly assignedRole?: FactoryRole;
  readonly runIds: readonly RunId[];
  readonly history: readonly StatusChange[];
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}
