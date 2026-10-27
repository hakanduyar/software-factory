/**
 * Read-only consumer that resolves the records behind an already-DONE work
 * item from a FactoryService and hands them to projectAcceptedResultNote.
 *
 * It only calls public read APIs (getWorkItem, releaseSnapshot, listRuns,
 * listReviews, listEvidence) and observes the already-recorded
 * RELEASE_APPROVAL through assertGateSatisfied. It never records or rewrites
 * an approval, writes, dispatches, or issues any acknowledgement. Lineage and
 * independence rules stay in the projector and the core resolvers.
 *
 * The reads are separate calls, so this is NOT an atomic multi-read snapshot:
 * a final identity recheck can detect drift that happened mid-read, nothing
 * more. The result is a draft only; it is not full MEM03, outbox persistence,
 * remote sync, or a cost/hallucination proof.
 */

import type { FactoryService } from "../../app/factoryService.js";
import type { WorkItemId } from "../../domain/ids.js";
import {
  AcceptedResultNoteRefusal,
  projectAcceptedResultNote,
  type AcceptedResultNoteDraft,
} from "./acceptedResultNote.js";

export interface AcceptedResultNoteRequest {
  readonly workItemId: WorkItemId;
  readonly expectedSnapshotId: string;
  readonly decision: string;
  readonly lesson: string;
}

function refuse(message: string): never {
  throw new AcceptedResultNoteRefusal(message);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function read<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    return refuse(`could not read ${label}: ${describe(error)}`);
  }
}

export async function buildAcceptedResultNoteDraft(
  factory: FactoryService,
  request: AcceptedResultNoteRequest,
): Promise<AcceptedResultNoteDraft> {
  if (typeof request !== "object" || request === null) refuse("request is missing");
  const { workItemId, expectedSnapshotId, decision, lesson } = request;
  if (typeof workItemId !== "string" || workItemId.trim() === "") refuse("workItemId must be a non-empty string");
  if (typeof expectedSnapshotId !== "string" || expectedSnapshotId.trim() === "") {
    refuse("expectedSnapshotId must be a non-empty string");
  }

  const item = await read("work item", () => factory.getWorkItem(workItemId));
  if (item.status !== "DONE") refuse(`work item ${workItemId} must be DONE, got ${item.status}`);

  const snapshot = await read("release snapshot", () => factory.releaseSnapshot(workItemId));
  if (snapshot === undefined) refuse(`work item ${workItemId} has no resolvable release snapshot`);
  if (snapshot.id !== expectedSnapshotId) {
    refuse(`expected snapshot ${expectedSnapshotId} is stale; current snapshot is ${snapshot.id}`);
  }

  // Observe the already-recorded human release decision bound to this snapshot.
  try {
    await factory.assertGateSatisfied("RELEASE_APPROVAL", factory.workItemSubject(workItemId), {
      snapshotId: snapshot.id,
      specRevision: snapshot.components.specRevision,
    });
  } catch (error) {
    refuse(`RELEASE_APPROVAL is not satisfied for snapshot ${snapshot.id}: ${describe(error)}`);
  }

  const runs = await read("runs", () => factory.listRuns(workItemId));
  const reviews = await read("reviews", () => factory.listReviews(workItemId));
  const evidence = await read("evidence", () => factory.listEvidence(workItemId));

  const implementationRun = runs.find((r) => r.id === snapshot.components.implementationRunId);
  if (implementationRun === undefined) {
    refuse(`implementation run ${snapshot.components.implementationRunId} named by the snapshot was not found`);
  }
  const review = reviews.find((r) => r.id === snapshot.components.semanticReviewId);
  if (review === undefined) {
    refuse(`semantic review ${snapshot.components.semanticReviewId} named by the snapshot was not found`);
  }
  const reviewerRun = runs.find((r) => r.id === review.reviewerRunId);
  if (reviewerRun === undefined) {
    refuse(`reviewer run ${review.reviewerRunId} named by the semantic review was not found`);
  }

  const resolvedEvidence = implementationRun.evidenceIds.map((id) => {
    const found = evidence.find((e) => e.id === id);
    if (found === undefined) refuse(`evidence ${id} referenced by the implementation run was not found`);
    return found;
  });

  const draft = projectAcceptedResultNote({
    snapshot: {
      id: snapshot.id,
      workItemId: item.id,
      specRevision: snapshot.components.specRevision,
      implementationRunId: snapshot.components.implementationRunId,
    },
    implementationRun,
    reviewerRun,
    review,
    evidence: resolvedEvidence,
    decision,
    lesson,
  });

  // Detects drift between the reads above; it does not make them atomic.
  const after = await read("release snapshot (recheck)", () => factory.releaseSnapshot(workItemId));
  if (after === undefined || after.id !== snapshot.id) {
    refuse("release snapshot changed while it was being read");
  }
  const itemAfter = await read("work item (recheck)", () => factory.getWorkItem(workItemId));
  if (itemAfter.status !== "DONE") refuse("work item left DONE while it was being read");

  return draft;
}
