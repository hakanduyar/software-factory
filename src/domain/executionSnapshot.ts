/**
 * The immutable identity of "the exact thing being released".
 *
 * Round-2 review showed that binding an approval to a revision counter is not
 * enough: the implementation could change without the counter moving, so a
 * release approval granted for one state still satisfied the gate for a
 * different one. Counting is the wrong mechanism — the gate must compare the
 * *content* of what was approved against the content of what is now current.
 *
 * A ReleaseSnapshot is derived, never stored as authority: it is recomputed
 * from live records every time a gate is evaluated, and its `id` is a hash of
 * the exact component record ids. Adding a new implementation run, a new
 * verification, or a new review changes at least one component id, therefore
 * changes the snapshot id, therefore invalidates every approval bound to the
 * old one — automatically, with no per-case bookkeeping.
 */

import { createHash } from "node:crypto";

import type { ReviewId, RunId } from "./ids.js";

export interface ReleaseSnapshotComponents {
  readonly specRevision: number;
  readonly implementationRunId: RunId;
  readonly verifierRunId: RunId;
  readonly deterministicReviewId: ReviewId;
  readonly semanticReviewId: ReviewId;
  /** Sorted for a stable hash. */
  readonly criterionVerificationIds: readonly string[];
}

export interface ReleaseSnapshot {
  readonly id: string;
  readonly components: ReleaseSnapshotComponents;
}

/**
 * Deterministic content hash. Field order is fixed here rather than relying
 * on object key order, so the id is stable across refactors.
 */
export function computeSnapshotId(components: ReleaseSnapshotComponents): string {
  const canonical = [
    `spec:${components.specRevision}`,
    `impl:${components.implementationRunId}`,
    `verify:${components.verifierRunId}`,
    `dreview:${components.deterministicReviewId}`,
    `sreview:${components.semanticReviewId}`,
    `criteria:${[...components.criterionVerificationIds].sort().join(",")}`,
  ].join("|");
  return `snap-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

export function makeSnapshot(components: ReleaseSnapshotComponents): ReleaseSnapshot {
  const sorted: ReleaseSnapshotComponents = {
    ...components,
    criterionVerificationIds: [...components.criterionVerificationIds].sort(),
  };
  return { id: computeSnapshotId(sorted), components: sorted };
}
