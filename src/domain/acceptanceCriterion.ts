import type { AcceptanceCriterionId, WorkItemId } from "./ids.js";

/**
 * A behaviour that must be proven, not claimed (C2, C3).
 *
 * `verifiedByEvidenceId` may only be set from recorded evidence; there is no
 * API on this type that lets a worker mark itself satisfied.
 */
export interface AcceptanceCriterion {
  readonly id: AcceptanceCriterionId;
  readonly workItemId: WorkItemId;
  readonly text: string;
  /** How the criterion is intended to be proven, e.g. "npm test". */
  readonly verificationHint: string;
  readonly verifiedByEvidenceId?: string;
}
