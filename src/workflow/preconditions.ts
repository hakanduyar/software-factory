/**
 * Real-world prerequisites for the transitions that would otherwise be
 * satisfiable by traversal alone.
 *
 * Each precondition is a thin wrapper over the release-snapshot resolver
 * (src/workflow/releaseSnapshotResolver.ts), so "is this current?" has one
 * definition shared by every transition and by the release gate, rather than
 * a per-transition rule that can drift.
 */

import type { WorkItem } from "../domain/workItem.js";
import {
  resolveCurrentImplementation,
  resolveReleaseSnapshot,
  resolveSemanticReview,
  resolveVerification,
  type WorkflowReadContext,
} from "./releaseSnapshotResolver.js";

export type { WorkflowReadContext } from "./releaseSnapshotResolver.js";

export interface PreconditionResult {
  readonly satisfied: boolean;
  readonly reason: string;
}

export type Precondition = (item: WorkItem, ctx: WorkflowReadContext) => Promise<PreconditionResult>;

/** IMPLEMENTING -> VERIFYING: a completed, successful implementation run at the current spec revision. */
export const requireSuccessfulImplementationRun: Precondition = async (item, ctx) => {
  const resolved = await resolveCurrentImplementation(item, ctx);
  return resolved.ok
    ? { satisfied: true, reason: `implementation run ${resolved.value.id} succeeded` }
    : { satisfied: false, reason: resolved.reason };
};

/** VERIFYING -> REVIEW: evidenced deterministic verification of that exact implementation. */
export const requireSuccessfulVerification: Precondition = async (item, ctx) => {
  const resolved = await resolveVerification(item, ctx);
  return resolved.ok
    ? { satisfied: true, reason: `verifier run ${resolved.value.verifierRun.id} passed with evidence` }
    : { satisfied: false, reason: resolved.reason };
};

/** REVIEW -> WAITING_FOR_HUMAN: an independent, passing semantic review of that exact implementation. */
export const requireIndependentSemanticReview: Precondition = async (item, ctx) => {
  const resolved = await resolveSemanticReview(item, ctx);
  return resolved.ok
    ? { satisfied: true, reason: `semantic review ${resolved.value.semanticReview.id} passed independently` }
    : { satisfied: false, reason: resolved.reason };
};

/** WAITING_FOR_HUMAN -> DONE: a complete release snapshot exists (all criteria verified). */
export const requireReleasableSnapshot: Precondition = async (item, ctx) => {
  const resolved = await resolveReleaseSnapshot(item, ctx);
  return resolved.ok
    ? { satisfied: true, reason: `release snapshot ${resolved.value.id} is complete` }
    : { satisfied: false, reason: resolved.reason };
};
