import type { ReviewId, RunId, WorkItemId } from "./ids.js";
import type { Timestamp } from "./time.js";

export const REVIEW_KINDS = ["DETERMINISTIC", "SEMANTIC"] as const;

export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const REVIEW_VERDICTS = ["PASS", "CHANGES_REQUESTED", "FAIL"] as const;

export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/**
 * A review is always backed by two real Runs: `reviewedRunId` (the
 * implementation being judged) and `reviewerRunId` (the run that did the
 * judging). Both principal ids are copied from those runs by
 * FactoryService — never supplied by the caller.
 *
 * C4: for a SEMANTIC review, `reviewerPrincipalId` must differ from
 * `implementerPrincipalId`. Because principals are registry-issued and bound
 * to Worker object identity, a worker cannot become "independent" of itself
 * by renaming itself or changing its declared role.
 */
export interface Review {
  readonly id: ReviewId;
  readonly workItemId: WorkItemId;
  readonly specRevision: number;
  readonly reviewedRunId: RunId;
  readonly reviewerRunId: RunId;
  readonly kind: ReviewKind;
  readonly reviewerPrincipalId: string;
  readonly implementerPrincipalId: string;
  readonly verdict: ReviewVerdict;
  readonly findings: readonly string[];
  readonly createdAt: Timestamp;
}
