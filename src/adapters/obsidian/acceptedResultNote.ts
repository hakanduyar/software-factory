/**
 * Pure projection of an already-accepted implementation/review/evidence
 * snapshot into an inert, attributable note draft.
 *
 * Trust boundary: every input record is a CALLER-AUTHENTICATED FACT. This
 * helper cannot authenticate the worker registry or storage, cannot verify
 * that the snapshot was really accepted, and issues no acceptance. It only
 * refuses inputs whose records are structurally inconsistent with each other
 * (identity, spec revision, role, status, independence).
 *
 * The draft is data only: no IO, no network, no ACK, no dispatch grant. It
 * does not claim complete MEM03, remote sync, or cost savings.
 */

import type { Evidence } from "../../domain/evidence.js";
import type { EvidenceId, RunId, WorkItemId } from "../../domain/ids.js";
import type { Review } from "../../domain/review.js";
import type { Run } from "../../domain/run.js";

export interface AcceptedSnapshotIdentity {
  readonly id: string;
  readonly workItemId: WorkItemId;
  readonly specRevision: number;
  readonly implementationRunId: RunId;
}

export interface AcceptedResultNoteInput {
  readonly snapshot: AcceptedSnapshotIdentity;
  readonly implementationRun: Run;
  readonly reviewerRun: Run;
  readonly review: Review;
  readonly evidence: readonly Evidence[];
  readonly decision: string;
  readonly lesson: string;
}

export interface AcceptedResultNoteEvidenceRef {
  readonly id: EvidenceId;
  readonly kind: Evidence["kind"];
  readonly reference: string;
  readonly summary: string;
}

export interface AcceptedResultNoteDraft {
  readonly inert: true;
  readonly title: string;
  readonly source: {
    readonly snapshotId: string;
    readonly workItemId: WorkItemId;
    readonly specRevision: number;
    readonly implementationRunId: RunId;
    readonly implementationPrincipalId: string;
    readonly reviewerRunId: RunId;
    readonly reviewerPrincipalId: string;
    readonly reviewId: string;
    readonly reviewKind: "SEMANTIC";
    readonly reviewVerdict: "PASS";
  };
  readonly evidence: readonly AcceptedResultNoteEvidenceRef[];
  readonly decision: string;
  readonly lesson: string;
  readonly body: string;
}

export class AcceptedResultNoteRefusal extends Error {
  constructor(message: string) {
    super(`accepted result note refused: ${message}`);
    this.name = "AcceptedResultNoteRefusal";
  }
}

function refuse(message: string): never {
  throw new AcceptedResultNoteRefusal(message);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    refuse(`${label} must be a non-empty string`);
  }
  return value;
}

function isObject(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null) refuse(`${label} is missing`);
}

function checkRun(run: Run, label: string, role: Run["role"]): void {
  isObject(run, label);
  nonEmptyString(run.id, `${label}.id`);
  nonEmptyString(run.workItemId, `${label}.workItemId`);
  nonEmptyString(run.workerPrincipalId, `${label}.workerPrincipalId`);
  if (!Number.isInteger(run.specRevision)) refuse(`${label}.specRevision must be an integer`);
  if (run.role !== role) refuse(`${label} must have role ${role}, got ${String(run.role)}`);
  if (run.status !== "SUCCEEDED") {
    refuse(`${label} must be SUCCEEDED, got ${String(run.status)}`);
  }
}

export function projectAcceptedResultNote(
  input: AcceptedResultNoteInput,
): AcceptedResultNoteDraft {
  isObject(input, "input");
  const { snapshot, implementationRun: impl, reviewerRun: rev, review, evidence } = input;
  isObject(snapshot, "snapshot");
  nonEmptyString(snapshot.id, "snapshot.id");
  const decision = nonEmptyString(input.decision, "decision");
  const lesson = nonEmptyString(input.lesson, "lesson");

  checkRun(impl, "implementationRun", "IMPLEMENTER");
  checkRun(rev, "reviewerRun", "REVIEWER");
  isObject(review, "review");

  if (snapshot.implementationRunId !== impl.id) {
    refuse("snapshot.implementationRunId does not match implementationRun.id (stale snapshot)");
  }
  if (snapshot.workItemId !== impl.workItemId) {
    refuse("snapshot.workItemId does not match implementationRun.workItemId");
  }
  if (snapshot.specRevision !== impl.specRevision) {
    refuse("snapshot.specRevision does not match implementationRun.specRevision");
  }
  if (
    rev.workItemId !== impl.workItemId ||
    review.workItemId !== impl.workItemId
  ) {
    refuse("runs and review must share the same work item");
  }
  if (rev.specRevision !== impl.specRevision || review.specRevision !== impl.specRevision) {
    refuse("runs and review must share the same spec revision");
  }
  if (rev.targetRunId !== impl.id) {
    refuse("reviewerRun.targetRunId does not match implementationRun.id");
  }
  if (review.reviewedRunId !== impl.id) {
    refuse("review.reviewedRunId does not match implementationRun.id");
  }
  if (review.reviewerRunId !== rev.id) {
    refuse("review.reviewerRunId does not match reviewerRun.id");
  }
  if (review.kind !== "SEMANTIC") refuse("review.kind must be SEMANTIC");
  if (review.verdict !== "PASS") refuse(`review.verdict must be PASS, got ${String(review.verdict)}`);
  if (review.implementerPrincipalId !== impl.workerPrincipalId) {
    refuse("review.implementerPrincipalId does not match the implementation run principal");
  }
  if (review.reviewerPrincipalId !== rev.workerPrincipalId) {
    refuse("review.reviewerPrincipalId does not match the reviewer run principal");
  }
  if (impl.workerPrincipalId === rev.workerPrincipalId) {
    refuse("reviewer principal equals implementer principal (self-review)");
  }

  if (!Array.isArray(evidence) || evidence.length === 0) {
    refuse("at least one referenced evidence record is required");
  }
  const seen = new Set<EvidenceId>();
  for (const e of evidence) {
    isObject(e, "evidence entry");
    nonEmptyString(e.id, "evidence.id");
    if (seen.has(e.id)) refuse(`duplicate evidence id ${e.id}`);
    seen.add(e.id);
    if (e.workItemId !== snapshot.workItemId) {
      refuse(`evidence ${e.id} workItemId does not match the snapshot`);
    }
    if (e.runId !== snapshot.implementationRunId) {
      refuse(`evidence ${e.id} runId does not match the snapshot implementation run`);
    }
    if (!impl.evidenceIds.includes(e.id)) {
      refuse(`evidence ${e.id} is not referenced by the implementation run`);
    }
  }

  const refs: AcceptedResultNoteEvidenceRef[] = evidence.map((e) =>
    Object.freeze({ id: e.id, kind: e.kind, reference: e.reference, summary: e.summary }),
  );
  const source = Object.freeze({
    snapshotId: snapshot.id,
    workItemId: snapshot.workItemId,
    specRevision: snapshot.specRevision,
    implementationRunId: impl.id,
    implementationPrincipalId: impl.workerPrincipalId,
    reviewerRunId: rev.id,
    reviewerPrincipalId: rev.workerPrincipalId,
    reviewId: review.id,
    reviewKind: "SEMANTIC" as const,
    reviewVerdict: "PASS" as const,
  });

  const title = `Accepted result ${snapshot.workItemId} r${snapshot.specRevision}`;
  const body = [
    `# ${title}`,
    "",
    "Draft only. Attribution below is caller-authenticated; this note grants no acceptance.",
    "",
    "## Source",
    `- snapshot: ${source.snapshotId}`,
    `- work item: ${source.workItemId}`,
    `- spec revision: ${source.specRevision}`,
    `- implementation run: ${source.implementationRunId} (principal ${source.implementationPrincipalId})`,
    `- reviewer run: ${source.reviewerRunId} (principal ${source.reviewerPrincipalId})`,
    `- review: ${source.reviewId} (${source.reviewKind} ${source.reviewVerdict})`,
    "",
    "## Evidence",
    ...refs.map((r) => `- ${r.id} [${r.kind}] ${r.reference} — ${r.summary}`),
    "",
    "## Decision",
    decision,
    "",
    "## Lesson",
    lesson,
    "",
  ].join("\n");

  return Object.freeze({
    inert: true as const,
    title,
    source,
    evidence: Object.freeze(refs),
    decision,
    lesson,
    body,
  });
}
