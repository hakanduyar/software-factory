import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AcceptedResultNoteRefusal,
  projectAcceptedResultNote,
  type AcceptedResultNoteInput,
} from "../src/adapters/obsidian/acceptedResultNote.js";
import type { Evidence } from "../src/domain/evidence.js";
import type { Review } from "../src/domain/review.js";
import type { Run } from "../src/domain/run.js";

function fixture(): AcceptedResultNoteInput {
  const implementationRun: Run = {
    id: "run-impl", workItemId: "wi-1", specRevision: 2, role: "IMPLEMENTER",
    workerPrincipalId: "principal-a", declaredWorkerId: "claude", status: "SUCCEEDED",
    claimsAcceptanceMet: true, evidenceIds: ["ev-1", "ev-2"], startedAt: 1, finishedAt: 2,
  };
  const reviewerRun: Run = {
    id: "run-rev", workItemId: "wi-1", specRevision: 2, role: "REVIEWER",
    workerPrincipalId: "principal-b", declaredWorkerId: "codex", status: "SUCCEEDED",
    targetRunId: "run-impl", claimsAcceptanceMet: false, evidenceIds: [], startedAt: 3, finishedAt: 4,
  };
  const review: Review = {
    id: "rv-1", workItemId: "wi-1", specRevision: 2, reviewedRunId: "run-impl",
    reviewerRunId: "run-rev", kind: "SEMANTIC", reviewerPrincipalId: "principal-b",
    implementerPrincipalId: "principal-a", verdict: "PASS", findings: [], createdAt: 5,
  };
  const evidence: Evidence[] = [
    { id: "ev-1", workItemId: "wi-1", runId: "run-impl", kind: "TEST_OUTPUT", summary: "tests pass", reference: "npm test", createdAt: 2 },
    { id: "ev-2", workItemId: "wi-1", runId: "run-impl", kind: "COMMIT", summary: "commit", reference: "abc123", createdAt: 2 },
  ];
  return {
    snapshot: { id: "snap-1", workItemId: "wi-1", specRevision: 2, implementationRunId: "run-impl" },
    implementationRun, reviewerRun, review, evidence,
    decision: "Use pure projection.", lesson: "Bind identities structurally.",
  };
}

function refused(input: AcceptedResultNoteInput, pattern: RegExp): void {
  assert.throws(() => projectAcceptedResultNote(input), (e: unknown) => {
    assert.ok(e instanceof AcceptedResultNoteRefusal);
    assert.match((e as Error).message, pattern);
    return true;
  });
}

describe("projectAcceptedResultNote", () => {
  it("projects a deterministic attributable inert draft", () => {
    const a = projectAcceptedResultNote(fixture());
    const b = projectAcceptedResultNote(fixture());
    assert.deepEqual(a, b);
    assert.equal(a.inert, true);
    assert.equal(a.source.snapshotId, "snap-1");
    assert.equal(a.source.specRevision, 2);
    assert.equal(a.source.implementationPrincipalId, "principal-a");
    assert.equal(a.source.reviewerPrincipalId, "principal-b");
    assert.deepEqual(a.evidence.map((e) => e.id), ["ev-1", "ev-2"]);
    for (const needle of ["run-impl", "run-rev", "rv-1", "ev-1", "Use pure projection.", "Bind identities structurally."]) {
      assert.ok(a.body.includes(needle), needle);
    }
    assert.equal(Object.keys(a).includes("ack"), false);
  });

  it("does not mutate inputs and does not alias them", () => {
    const input = fixture();
    const snapshot = structuredClone(input);
    const draft = projectAcceptedResultNote(input);
    assert.deepEqual(input, snapshot);
    assert.ok(Object.isFrozen(draft) && Object.isFrozen(draft.evidence) && Object.isFrozen(draft.source));
    (input.evidence[0] as { summary: string }).summary = "changed later";
    assert.equal(draft.evidence[0]?.summary, "tests pass");
  });

  it("refuses self-review and principal mismatches", () => {
    const i = fixture();
    refused({ ...i, reviewerRun: { ...i.reviewerRun, workerPrincipalId: "principal-a" },
      review: { ...i.review, reviewerPrincipalId: "principal-a" } }, /self-review/);
    refused({ ...i, review: { ...i.review, reviewerPrincipalId: "forged" } }, /reviewerPrincipalId/);
    refused({ ...i, review: { ...i.review, implementerPrincipalId: "forged" } }, /implementerPrincipalId/);
  });

  it("refuses identity, stale and spec mismatches", () => {
    const i = fixture();
    refused({ ...i, review: { ...i.review, reviewedRunId: "other" } }, /reviewedRunId/);
    refused({ ...i, review: { ...i.review, reviewerRunId: "other" } }, /reviewerRunId/);
    refused({ ...i, reviewerRun: { ...i.reviewerRun, targetRunId: "other" } }, /targetRunId/);
    refused({ ...i, snapshot: { ...i.snapshot, implementationRunId: "run-old" } }, /stale/);
    refused({ ...i, snapshot: { ...i.snapshot, specRevision: 1 } }, /specRevision/);
    refused({ ...i, review: { ...i.review, specRevision: 3 } }, /spec revision/);
    refused({ ...i, reviewerRun: { ...i.reviewerRun, workItemId: "wi-2" } }, /work item/);
  });

  it("refuses wrong roles, non-succeeded runs, and non-PASS or non-semantic reviews", () => {
    const i = fixture();
    refused({ ...i, implementationRun: { ...i.implementationRun, status: "RUNNING" } }, /SUCCEEDED/);
    refused({ ...i, implementationRun: { ...i.implementationRun, status: "FAILED" } }, /SUCCEEDED/);
    refused({ ...i, reviewerRun: { ...i.reviewerRun, status: "FAILED" } }, /SUCCEEDED/);
    refused({ ...i, implementationRun: { ...i.implementationRun, role: "REVIEWER" } }, /IMPLEMENTER/);
    refused({ ...i, reviewerRun: { ...i.reviewerRun, role: "IMPLEMENTER" } }, /REVIEWER/);
    refused({ ...i, review: { ...i.review, verdict: "FAIL" } }, /PASS/);
    refused({ ...i, review: { ...i.review, verdict: "CHANGES_REQUESTED" } }, /PASS/);
    refused({ ...i, review: { ...i.review, kind: "DETERMINISTIC" } }, /SEMANTIC/);
  });

  it("refuses evidence not bound to the accepted snapshot", () => {
    const i = fixture();
    const [e1, e2] = i.evidence as [Evidence, Evidence];
    refused({ ...i, evidence: [] }, /evidence/);
    refused({ ...i, evidence: [{ ...e1, runId: "run-other" }] }, /runId/);
    refused({ ...i, evidence: [{ ...e1, workItemId: "wi-2" }] }, /workItemId/);
    const { runId: _omit, ...noRun } = e1;
    refused({ ...i, evidence: [noRun as Evidence] }, /runId/);
    refused({ ...i, evidence: [{ ...e1, id: "ev-unlisted" }] }, /not referenced/);
    refused({ ...i, evidence: [e1, e1] }, /duplicate/);
    assert.ok(e2);
  });

  it("refuses malformed input and empty text", () => {
    const i = fixture();
    refused({ ...i, decision: " " }, /decision/);
    refused({ ...i, lesson: "" }, /lesson/);
    refused({ ...i, snapshot: { ...i.snapshot, id: "" } }, /snapshot.id/);
    refused({ ...i, review: undefined as unknown as Review }, /review is missing/);
    refused(undefined as unknown as AcceptedResultNoteInput, /input/);
  });

  it("refuses missing or empty review id and evidence reference", () => {
    const i = fixture();
    const { id: _id, ...noId } = i.review;
    refused({ ...i, review: noId as Review }, /review\.id/);
    refused({ ...i, review: { ...i.review, id: "" } }, /review\.id/);
    const [e1, e2] = i.evidence as [Evidence, Evidence];
    const { reference: _ref, ...noRef } = e1;
    refused({ ...i, evidence: [noRef as Evidence, e2] }, /reference/);
    refused({ ...i, evidence: [e1, { ...e2, reference: "" }] }, /reference/);
    refused({ ...i, evidence: [{ ...e1, reference: "  " }, e2] }, /reference/);
  });
});
