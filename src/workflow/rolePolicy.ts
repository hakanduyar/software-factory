/**
 * The single role/state policy: in which workflow states each FactoryRole may
 * START a run. One table, enforced inside runWorker's start transaction — not
 * scattered "not DONE" checks.
 *
 * The principle: execution-phase roles (IMPLEMENTER/VERIFIER/REVIEWER) are
 * startable in any execution-phase state, because a newer attempt superseding
 * the current proof — even while the item waits for a human — is exactly how
 * lineage authority works. They are NOT startable before PLAN_APPROVAL has
 * gated the item into execution: no implementation, verification or review
 * work may begin against an unapproved plan (C1/C2). Planning roles mirror
 * the planning states. CONTENT has no startable state in TASK-001 — the
 * content pipeline is Roadmap Phase 11 and gets its own policy then.
 *
 * BLOCKED intentionally allows nothing: a blocked item is paused, and work
 * arriving while paused would bypass the reason it was blocked. Terminal
 * states are excluded here AND by the terminal-work-item policy in
 * FactoryService (defence in depth).
 */

import { OperationStateError } from "../domain/errors.js";
import type { FactoryRole } from "../domain/role.js";
import type { WorkItemStatus } from "../domain/status.js";

const EXECUTION_STATES: readonly WorkItemStatus[] = ["IMPLEMENTING", "VERIFYING", "REVIEW", "WAITING_FOR_HUMAN"];

export const ROLE_STARTABLE_STATES: Readonly<Record<FactoryRole, readonly WorkItemStatus[]>> = {
  ANALYST: ["IDEA", "ANALYSIS"],
  PLANNER: ["ANALYSIS", "PLAN_REVIEW"],
  IMPLEMENTER: EXECUTION_STATES,
  VERIFIER: EXECUTION_STATES,
  REVIEWER: EXECUTION_STATES,
  CONTENT: [],
};

export function assertRoleStartable(role: FactoryRole, status: WorkItemStatus): void {
  const allowed = ROLE_STARTABLE_STATES[role];
  if (!allowed.includes(status)) {
    throw new OperationStateError(
      `a ${role} run cannot start while the work item is ${status}; allowed states: ${allowed.length > 0 ? allowed.join(", ") : "none in TASK-001"}`,
    );
  }
}
