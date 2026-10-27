import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectWorkItemStatus } from "../src/adapters/github/workItemStatusProjection.js";
import type {
  DoneEvidenceSnapshot,
  StatusProjectionInput,
} from "../src/adapters/github/workItemStatusProjection.js";
import { WORK_ITEM_STATUSES } from "../src/domain/status.js";

const ref = (referenceId: string) => ({ taskId: "T-1", specRevision: 2, runId: "run-1", referenceId });
const evidence = (): DoneEvidenceSnapshot => ({ acceptance: ref("acc-1"), delivery: ref("dlv-1") });
const input = (status: string, doneEvidence?: DoneEvidenceSnapshot): StatusProjectionInput => ({
  taskId: "T-1",
  status,
  specRevision: 2,
  runId: "run-1",
  ...(doneEvidence === undefined ? {} : { doneEvidence }),
});
const refusedCode = (i: unknown) => {
  const r = projectWorkItemStatus(i as StatusProjectionInput);
  assert.equal(r.kind, "REFUSED");
  return r.kind === "REFUSED" ? r.code : "";
};

describe("projectWorkItemStatus", () => {
  it("maps the publishable statuses to exact pairs", () => {
    assert.deepEqual(projectWorkItemStatus(input("VERIFYING")), {
      kind: "PUBLISHABLE", publicStatus: "IN_PROGRESS", nextAction: "RUN_FOCUSED_CHECKS" });
    assert.deepEqual(projectWorkItemStatus(input("REVIEW")), {
      kind: "PUBLISHABLE", publicStatus: "WAITING_FOR_REVIEW", nextAction: "INDEPENDENT_REVIEW" });
    assert.deepEqual(projectWorkItemStatus(input("BLOCKED")), {
      kind: "PUBLISHABLE", publicStatus: "BLOCKED", nextAction: "WAIT_FOR_DEPENDENCY" });
    assert.deepEqual(projectWorkItemStatus(input("DONE", evidence())), {
      kind: "PUBLISHABLE", publicStatus: "ACCEPTED_SCOPED", nextAction: "RESUME_AUTHORIZED_WORK" });
  });

  it("is exhaustive over every WorkItemStatus", () => {
    for (const s of WORK_ITEM_STATUSES) {
      const r = projectWorkItemStatus(input(s, s === "DONE" ? evidence() : undefined));
      if (["IDEA", "ANALYSIS", "PLAN_REVIEW", "READY", "IMPLEMENTING", "WAITING_FOR_HUMAN", "CANCELLED"].includes(s)) {
        assert.deepEqual(r, { kind: "NOT_PUBLISHABLE", status: s });
      } else {
        assert.equal(r.kind, "PUBLISHABLE", s);
      }
    }
  });

  it("refuses unknown or wrongly cased statuses", () => {
    for (const s of ["", "done", "Done", "SHIPPED", "constructor", "__proto__"]) {
      assert.equal(refusedCode(input(s)), "STATUS_UNKNOWN", s);
    }
  });

  it("refuses malformed identity", () => {
    assert.equal(refusedCode(null), "INPUT_MALFORMED");
    assert.equal(refusedCode({ ...input("REVIEW"), taskId: "bad id" }), "INPUT_MALFORMED");
    assert.equal(refusedCode({ ...input("REVIEW"), taskId: "" }), "INPUT_MALFORMED");
    assert.equal(refusedCode({ ...input("REVIEW"), runId: 5 }), "INPUT_MALFORMED");
    assert.equal(refusedCode({ ...input("REVIEW"), specRevision: 1.5 }), "INPUT_MALFORMED");
    assert.equal(refusedCode({ ...input("REVIEW"), specRevision: -1 }), "INPUT_MALFORMED");
    assert.equal(refusedCode({ ...input("REVIEW"), status: 7 }), "INPUT_MALFORMED");
  });

  it("refuses DONE without evidence (a DONE string alone is never acceptance)", () => {
    assert.equal(refusedCode(input("DONE")), "DONE_EVIDENCE_MISSING");
  });

  it("refuses malformed DONE evidence", () => {
    const e = evidence();
    assert.equal(refusedCode(input("DONE", { acceptance: e.acceptance } as DoneEvidenceSnapshot)), "DONE_EVIDENCE_MALFORMED");
    assert.equal(refusedCode(input("DONE", { ...e, delivery: { ...e.delivery, referenceId: "" } })), "DONE_EVIDENCE_MALFORMED");
    assert.equal(refusedCode(input("DONE", { ...e, acceptance: { ...e.acceptance, specRevision: "2" as unknown as number } })), "DONE_EVIDENCE_MALFORMED");
    assert.equal(refusedCode(input("DONE", "yes" as unknown as DoneEvidenceSnapshot)), "DONE_EVIDENCE_MALFORMED");
  });

  it("refuses stale or mismatched DONE evidence on either reference", () => {
    const e = evidence();
    for (const side of ["acceptance", "delivery"] as const) {
      for (const patch of [{ taskId: "T-2" }, { specRevision: 1 }, { runId: "run-0" }]) {
        const bad = { ...e, [side]: { ...e[side], ...patch } };
        assert.equal(refusedCode(input("DONE", bad)), "DONE_EVIDENCE_MISMATCH", `${side} ${JSON.stringify(patch)}`);
      }
    }
    assert.equal(refusedCode(input("DONE", { acceptance: ref("same"), delivery: ref("same") })), "DONE_EVIDENCE_MISMATCH");
  });

  it("ignores evidence for non-DONE statuses and never uses it to publish others", () => {
    assert.equal(projectWorkItemStatus(input("IMPLEMENTING", evidence())).kind, "NOT_PUBLISHABLE");
  });

  it("is deterministic and does not mutate or freeze-break its input", () => {
    const i = input("DONE", evidence());
    const snapshot = JSON.stringify(i);
    const a = projectWorkItemStatus(i);
    const b = projectWorkItemStatus(i);
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(i), snapshot);
    const frozen = Object.freeze({ ...i, doneEvidence: Object.freeze({
      acceptance: Object.freeze({ ...ref("acc-1") }), delivery: Object.freeze({ ...ref("dlv-1") }) }) });
    assert.deepEqual(projectWorkItemStatus(frozen), a);
  });
});
