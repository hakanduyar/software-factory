import type { AcceptanceCriterionId, EvidenceId, RunId, WorkItemId } from "./ids.js";
import type { Timestamp } from "./time.js";

export const EVIDENCE_KINDS = [
  "COMMIT",
  "TEST_OUTPUT",
  "LINT_OUTPUT",
  "BUILD_OUTPUT",
  "REVIEW_REPORT",
  "SCREENSHOT",
  "DECISION",
  "NOTE",
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** A draft carries no id yet: ids are assigned when the Factory records it. */
export interface EvidenceDraft {
  readonly kind: EvidenceKind;
  readonly summary: string;
  /** Pointer to the real artifact (path, command, commit sha). Never a secret (C6). */
  readonly reference: string;
  /** Set when this evidence is proof for one specific acceptance criterion. */
  readonly criterionId?: AcceptanceCriterionId;
}

export interface Evidence extends EvidenceDraft {
  readonly id: EvidenceId;
  readonly workItemId: WorkItemId;
  readonly runId?: RunId;
  readonly createdAt: Timestamp;
}
