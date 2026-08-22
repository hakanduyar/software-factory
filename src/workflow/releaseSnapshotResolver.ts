/**
 * Resolves the current release candidate from live records.
 *
 * This is the single definition of "what is the implementation right now, and
 * what has been proven about it". Every workflow precondition and the release
 * gate read it, so there is exactly one notion of currency in the system
 * rather than one per transition.
 *
 * Two principles drive every rule here:
 *
 * 1. LINEAGE HEAD, NOT LATEST SUCCESS. The current implementation is the most
 *    recent IMPLEMENTER *attempt* at the current spec revision, whatever its
 *    outcome. If that attempt FAILED, there is no releasable implementation —
 *    the resolver must never skip a failed newer attempt and quietly fall
 *    back to an older successful one (a Round-3 exploit did exactly that).
 *    The same rule applies to verifier attempts against that implementation,
 *    and — Round 4 — to criterion verification: only records produced by the
 *    current verifier attempt count. One coherent verification generation:
 *
 *        CURRENT IMPLEMENTATION
 *            -> CURRENT VERIFIER ATTEMPT
 *            -> CRITERION RESULTS PRODUCED BY THAT VERIFIER
 *            -> CURRENT REVIEW
 *            -> RELEASE SNAPSHOT
 *
 *    No cross-generation mixing: an older generation's PASS can neither fill
 *    a gap in the current generation nor override its FAIL. "Find the latest
 *    PASS per criterion" is specifically the unsafe shape this forbids.
 *
 * 2. LATEST APPLICABLE REVIEW IS AUTHORITATIVE. Reviews are append-only and
 *    listByWorkItem preserves insertion order, so "authoritative" is the last
 *    applicable review in that deterministic order — never "the last one that
 *    happened to PASS". A newer FAIL supersedes an older PASS; a still-newer
 *    PASS may supersede the FAIL.
 *
 *    "Applicable" is decided by the review's own recorded identity, not only
 *    by what it points at: kind, the exact implementation run reviewed, AND
 *    the review's own `specRevision` (round-4 HIGH 2 — previously a Review
 *    stamped at another revision could be selected as authoritative, letting
 *    an off-revision PASS both authorize a transition and mask a
 *    current-revision blocking review). Every artifact in a lineage must
 *    belong to the same current revision: WorkItem, implementer run, verifier
 *    run, deterministic review, reviewer run, semantic review.
 *
 * Each stage depends on the id produced by the stage before it, so running a
 * new implementer immediately orphans all prior proof — not because anything
 * bumps a counter, but because the thing the proof points at is no longer
 * current.
 */

import type { AcceptanceCriterion } from "../domain/acceptanceCriterion.js";
import type { AcceptanceCriterionVerification } from "../domain/acceptanceCriterionVerification.js";
import { makeSnapshot, type ReleaseSnapshot } from "../domain/executionSnapshot.js";
import type { WorkItemId } from "../domain/ids.js";
import type { Review } from "../domain/review.js";
import type { Run } from "../domain/run.js";
import type { WorkItem } from "../domain/workItem.js";

export interface WorkflowReadContext {
  readonly runs: { listByWorkItem(workItemId: WorkItemId): Promise<readonly Run[]> };
  readonly reviews: { listByWorkItem(workItemId: WorkItemId): Promise<readonly Review[]> };
  readonly criteria: { listByWorkItem(workItemId: WorkItemId): Promise<readonly AcceptanceCriterion[]> };
  readonly verifications: {
    listByWorkItem(workItemId: WorkItemId): Promise<readonly AcceptanceCriterionVerification[]>;
  };
}

export type Resolved<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

function fail<T>(reason: string): Resolved<T> {
  return { ok: false, reason };
}

function ok<T>(value: T): Resolved<T> {
  return { ok: true, value };
}

/**
 * The implementation currently under consideration: the most recent
 * IMPLEMENTER *attempt* at the work item's current spec revision, which must
 * itself have SUCCEEDED. A newer attempt — successful or failed — is the
 * lineage head; a FAILED head means nothing is releasable until a fresh
 * successful implementation is produced and re-proven.
 */
export async function resolveCurrentImplementation(
  item: WorkItem,
  ctx: WorkflowReadContext,
): Promise<Resolved<Run>> {
  const runs = await ctx.runs.listByWorkItem(item.id);
  const attempts = runs.filter((run) => run.role === "IMPLEMENTER" && run.specRevision === item.specRevision);
  const head = attempts.at(-1);
  if (head === undefined) {
    return fail(`no IMPLEMENTER attempt recorded at spec revision ${item.specRevision}`);
  }
  if (head.status !== "SUCCEEDED") {
    return fail(
      `the current implementation attempt ${head.id} is ${head.status}; a newer attempt supersedes all older runs, so nothing is releasable until a fresh implementation succeeds and is re-verified`,
    );
  }
  return ok(head);
}

export interface ResolvedVerification {
  readonly implementation: Run;
  readonly verifierRun: Run;
  readonly deterministicReview: Review;
}

/** Deterministic verification of the current implementation, with evidence. */
export async function resolveVerification(
  item: WorkItem,
  ctx: WorkflowReadContext,
): Promise<Resolved<ResolvedVerification>> {
  const implementation = await resolveCurrentImplementation(item, ctx);
  if (!implementation.ok) {
    return fail(implementation.reason);
  }

  const runs = await ctx.runs.listByWorkItem(item.id);
  // Same lineage rule as implementations: the newest verifier ATTEMPT against
  // this implementation is authoritative, whatever its outcome.
  const verifierAttempts = runs.filter(
    (run) =>
      run.role === "VERIFIER" &&
      run.specRevision === item.specRevision &&
      run.targetRunId === implementation.value.id,
  );
  const verifierRun = verifierAttempts.at(-1);
  if (verifierRun === undefined) {
    return fail(`no VERIFIER run targeting implementation run ${implementation.value.id}`);
  }
  if (verifierRun.status !== "SUCCEEDED") {
    return fail(`the current verifier attempt ${verifierRun.id} is ${verifierRun.status}`);
  }
  if (verifierRun.evidenceIds.length === 0) {
    return fail(`verifier run ${verifierRun.id} recorded no evidence`);
  }

  const reviews = await ctx.reviews.listByWorkItem(item.id);
  // Authoritative = the LATEST applicable deterministic review, in append
  // order — not the latest one that happened to pass.
  //
  // "Applicable" includes the review's OWN specRevision (round-4 HIGH 2): a
  // Review record carries the revision it was recorded at, and a record from
  // another revision belongs to another generation entirely. Filtering it out
  // here — rather than merely inspecting the latest record's revision — is
  // what makes an off-revision review unable to authorize anything AND unable
  // to mask a current failure: it is invisible, exactly like the older
  // criterion-verification generations in resolveReleaseSnapshot.
  const applicableDeterministic = reviews.filter(
    (review) =>
      review.kind === "DETERMINISTIC" &&
      review.reviewedRunId === implementation.value.id &&
      review.specRevision === item.specRevision,
  );
  const deterministicReview = applicableDeterministic.at(-1);
  if (deterministicReview === undefined) {
    return fail(`no deterministic review of implementation run ${implementation.value.id}`);
  }
  if (deterministicReview.verdict !== "PASS") {
    return fail(
      `the authoritative deterministic review ${deterministicReview.id} is ${deterministicReview.verdict}; a newer failing review supersedes any earlier pass`,
    );
  }
  if (deterministicReview.reviewerRunId !== verifierRun.id) {
    return fail(
      `the authoritative deterministic review ${deterministicReview.id} was produced by ${deterministicReview.reviewerRunId}, not the current verifier attempt ${verifierRun.id}`,
    );
  }

  return ok({ implementation: implementation.value, verifierRun, deterministicReview });
}

export interface ResolvedReview extends ResolvedVerification {
  readonly semanticReview: Review;
}

/** Independent, passing semantic review of the current implementation (C4). */
export async function resolveSemanticReview(
  item: WorkItem,
  ctx: WorkflowReadContext,
): Promise<Resolved<ResolvedReview>> {
  const verification = await resolveVerification(item, ctx);
  if (!verification.ok) {
    return fail(verification.reason);
  }

  const runs = await ctx.runs.listByWorkItem(item.id);
  // ROUND-5 HIGH 2: resolve the authoritative REVIEWER *attempt* from the runs
  // themselves first, exactly as resolveVerification does for the verifier —
  // then require the review to have been produced by that run. `recordReview`
  // validates the backing run at creation time, but a resolver reading durable
  // state must re-prove it: a directly-written or corrupted Review row can
  // carry entirely plausible copied fields (current revision, the right
  // reviewedRunId, distinct-looking principal strings) while pointing at a
  // reviewer run that does not exist, failed, is still running, has the wrong
  // role/revision, or examined something else. Copied principal strings are
  // never trusted as identity; identity is derived from the Run record, which
  // carries the registry-issued principal.
  const reviewerAttempts = runs.filter(
    (run) =>
      run.role === "REVIEWER" &&
      run.specRevision === item.specRevision &&
      run.targetRunId === verification.value.implementation.id,
  );
  const reviewerRun = reviewerAttempts.at(-1);
  if (reviewerRun === undefined) {
    return fail(`no REVIEWER run targeting implementation run ${verification.value.implementation.id}`);
  }
  if (reviewerRun.status !== "SUCCEEDED") {
    return fail(`the current reviewer attempt ${reviewerRun.id} is ${reviewerRun.status}`);
  }
  if (reviewerRun.workerPrincipalId === verification.value.implementation.workerPrincipalId) {
    // C4, proven from the Run records rather than from anything the Review copied.
    return fail(
      `reviewer run ${reviewerRun.id} was executed by the same worker principal as implementation run ${verification.value.implementation.id}; a worker may not be the sole semantic reviewer of its own work (C4)`,
    );
  }

  const reviews = await ctx.reviews.listByWorkItem(item.id);
  // Authoritative = the LATEST applicable semantic review, in append order.
  // A newer FAIL supersedes an older PASS; a still-newer PASS may supersede
  // the FAIL. Never "find a PASS that matches".
  //
  // The review's own specRevision is part of applicability (round-4 HIGH 2) —
  // see the equivalent filter in resolveVerification.
  const applicableSemantic = reviews.filter(
    (review) =>
      review.kind === "SEMANTIC" &&
      review.reviewedRunId === verification.value.implementation.id &&
      review.specRevision === item.specRevision,
  );
  const semanticReview = applicableSemantic.at(-1);
  if (semanticReview === undefined) {
    return fail(`no semantic review of implementation run ${verification.value.implementation.id}`);
  }
  if (semanticReview.verdict !== "PASS") {
    return fail(
      `the authoritative semantic review ${semanticReview.id} is ${semanticReview.verdict}; a newer blocking review supersedes any earlier pass`,
    );
  }
  // The review must have been produced by the authoritative reviewer attempt
  // resolved above — the same pinning resolveVerification applies to the
  // deterministic review. A newer reviewer attempt supersedes an older
  // review's verdict, so nothing is authoritative until that attempt's own
  // review is recorded.
  if (semanticReview.reviewerRunId !== reviewerRun.id) {
    return fail(
      `the authoritative semantic review ${semanticReview.id} was produced by ${semanticReview.reviewerRunId}, not the current reviewer attempt ${reviewerRun.id}`,
    );
  }
  // Copied principal fields are audit/display data: they must agree with the
  // Run records they claim to describe, and may never substitute for them.
  if (semanticReview.reviewerPrincipalId !== reviewerRun.workerPrincipalId) {
    return fail(
      `semantic review ${semanticReview.id} records reviewer principal ${semanticReview.reviewerPrincipalId}, but reviewer run ${reviewerRun.id} was executed by ${reviewerRun.workerPrincipalId}`,
    );
  }
  if (semanticReview.implementerPrincipalId !== verification.value.implementation.workerPrincipalId) {
    return fail(
      `semantic review ${semanticReview.id} records implementer principal ${semanticReview.implementerPrincipalId}, but implementation run ${verification.value.implementation.id} was executed by ${verification.value.implementation.workerPrincipalId}`,
    );
  }

  return ok({ ...verification.value, semanticReview });
}

/**
 * The full release candidate: everything above, plus a PASSED verification
 * for every acceptance criterion against this exact implementation run.
 */
export async function resolveReleaseSnapshot(
  item: WorkItem,
  ctx: WorkflowReadContext,
): Promise<Resolved<ReleaseSnapshot>> {
  // Nothing is releasable while ANY attempt is still in flight. A durable
  // RUNNING run — implementer, verifier or reviewer — means the proof set is
  // about to change; releasing against the old proof would race the outcome.
  const allRuns = await ctx.runs.listByWorkItem(item.id);
  const inFlight = allRuns.find((run) => run.status === "RUNNING");
  if (inFlight !== undefined) {
    return fail(`run ${inFlight.id} (${inFlight.role}) is still RUNNING; nothing is releasable while an attempt is in flight`);
  }

  const reviewed = await resolveSemanticReview(item, ctx);
  if (!reviewed.ok) {
    return fail(reviewed.reason);
  }

  const criteria = await ctx.criteria.listByWorkItem(item.id);
  if (criteria.length === 0) {
    return fail("work item has no acceptance criteria to verify");
  }

  const verifications = await ctx.verifications.listByWorkItem(item.id);
  // Only the current verification generation counts: records produced by the
  // authoritative verifier attempt, for the current implementation, at the
  // current spec revision. Older generations are invisible here — they can
  // neither fill gaps nor override a current FAIL.
  const currentGeneration = verifications.filter(
    (verification) =>
      verification.verifierRunId === reviewed.value.verifierRun.id &&
      verification.implementationRunId === reviewed.value.implementation.id &&
      verification.specRevision === item.specRevision,
  );

  const accepted: AcceptanceCriterionVerification[] = [];
  const unverified: string[] = [];
  const failed: string[] = [];
  for (const criterion of criteria) {
    // Latest record for this criterion within the generation is authoritative
    // (append order; a re-run of verifyAcceptanceCriteria supersedes).
    const authoritative = currentGeneration.filter((verification) => verification.criterionId === criterion.id).at(-1);
    if (authoritative === undefined) {
      unverified.push(criterion.id);
    } else if (authoritative.result !== "PASSED") {
      failed.push(criterion.id);
    } else {
      accepted.push(authoritative);
    }
  }
  if (failed.length > 0) {
    return fail(
      `acceptance criteria FAILED in the current verification generation (verifier run ${reviewed.value.verifierRun.id}): ${failed.join(", ")}`,
    );
  }
  if (unverified.length > 0) {
    return fail(
      `acceptance criteria not verified by the current verifier attempt ${reviewed.value.verifierRun.id}: ${unverified.join(", ")}`,
    );
  }

  return ok(
    makeSnapshot({
      specRevision: item.specRevision,
      implementationRunId: reviewed.value.implementation.id,
      verifierRunId: reviewed.value.verifierRun.id,
      deterministicReviewId: reviewed.value.deterministicReview.id,
      semanticReviewId: reviewed.value.semanticReview.id,
      criterionVerificationIds: accepted.map((verification) => verification.id),
    }),
  );
}
