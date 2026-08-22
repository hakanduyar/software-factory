/**
 * DOMAIN / ADAPTER PARITY GUARD for `ApprovalContext`.
 *
 * TASK-005 remediation round 3 exists because `ApprovalContext` gained four
 * authority fields while `src/adapters/sqlite/serialization.ts` kept an older
 * three-field whitelist. Nothing threw. Nothing was corrupted. The evidence a
 * PLAN approval carries was simply deleted in transit, and `gateGuard` — doing
 * exactly its job — then refused to treat the approval as authority. Every
 * durable SQLite-backed plan became permanently unable to leave approval, while
 * every in-memory-backed test stayed green.
 *
 * So this file's job is not to test today's fields. It is to make the NEXT
 * occurrence impossible to miss:
 *
 *   - `APPROVAL_CONTEXT_FIELDS` is typed `Record<keyof Required<ApprovalContext>, true>`,
 *     so adding a field to the domain type and not to this list is a COMPILE
 *     error;
 *   - the maximal fixture is built from that list, so a field this list knows
 *     about but the SQLite parser drops is a RUNTIME failure.
 *
 * Together: a new authority field cannot reach production without surviving a
 * real persistence round-trip. Chosen over a reflective schema system on
 * purpose — an explicit canonical list is what a reviewer can actually check.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encode, parseApproval } from "../src/adapters/sqlite/serialization.js";
import type { Approval, ApprovalContext } from "../src/domain/approval.js";
import { PersistenceCorruptionError } from "../src/domain/errors.js";

/**
 * EVERY field of `ApprovalContext`. TypeScript refuses to compile this object
 * if the domain type gains a field that is not listed here.
 */
const APPROVAL_CONTEXT_FIELDS: Record<keyof Required<ApprovalContext>, true> = {
  statusWhenDecided: true,
  specRevision: true,
  snapshotId: true,
  planContentDigest: true,
  derivedFromApprovalId: true,
  planId: true,
  planRevision: true,
};

/** A context in which every currently supported field is semantically present. */
const MAXIMAL_CONTEXT: Required<ApprovalContext> = {
  statusWhenDecided: "PLAN_REVIEW",
  specRevision: 3,
  snapshotId: "snap-abcdef0123456789",
  planContentDigest: "papr-0123456789abcdef0123456789abcdef",
  derivedFromApprovalId: "apr-source-0001",
  planId: "plan-0007",
  planRevision: 3,
};

function approvalWith(context: ApprovalContext): Approval {
  return {
    id: "apr-roundtrip-1",
    gate: "PLAN_APPROVAL",
    subject: { type: "WORK_ITEM", id: "wi-0001" },
    decision: "APPROVED",
    decidedBy: { id: "user:human", kind: "HUMAN", displayName: "Test Human" },
    context,
    note: "round-trip fixture",
    decidedAt: 1_800_000_000_000,
  };
}

function roundTrip(approval: Approval): Approval {
  return parseApproval(encode(approval), {
    id: approval.id,
    subjectType: approval.subject.type,
    subjectId: approval.subject.id,
  });
}

describe("ApprovalContext survives the production SQLite round-trip intact", () => {
  it("carries every field the domain type declares", () => {
    const declared = Object.keys(APPROVAL_CONTEXT_FIELDS).sort();
    assert.deepEqual(
      Object.keys(MAXIMAL_CONTEXT).sort(),
      declared,
      "the maximal fixture must exercise every declared field",
    );
  });

  it("round-trips a maximal context with no field lost or changed", () => {
    const original = approvalWith(MAXIMAL_CONTEXT);
    const parsed = roundTrip(original);

    assert.deepEqual(parsed, original, "encode -> parse must preserve the whole approval");
    assert.deepEqual(
      Object.keys(parsed.context!).sort(),
      Object.keys(APPROVAL_CONTEXT_FIELDS).sort(),
      "a field the domain declares must not disappear in the adapter",
    );
    // Field by field, so a failure names the field rather than dumping a diff.
    for (const field of Object.keys(APPROVAL_CONTEXT_FIELDS) as (keyof ApprovalContext)[]) {
      assert.equal(parsed.context?.[field], MAXIMAL_CONTEXT[field], `field "${field}" was not preserved`);
    }
  });

  it("round-trips a minimal context without inventing absent fields", () => {
    const minimal: ApprovalContext = { statusWhenDecided: "PLAN_REVIEW", specRevision: 1 };
    const parsed = roundTrip(approvalWith(minimal));

    assert.deepEqual(parsed.context, minimal);
    assert.deepEqual(Object.keys(parsed.context!).sort(), ["specRevision", "statusWhenDecided"]);
  });

  it("round-trips a release context, which carries no plan fields", () => {
    const release: ApprovalContext = {
      statusWhenDecided: "WAITING_FOR_HUMAN",
      specRevision: 2,
      snapshotId: "snap-release-1",
    };
    const parsed = roundTrip({ ...approvalWith(release), gate: "RELEASE_APPROVAL" });

    assert.deepEqual(parsed.context, release, "a non-plan approval is unaffected by the TASK-005 fields");
  });

  it("still rejects malformed values rather than coercing or dropping them", () => {
    const cases: readonly { readonly label: string; readonly context: Record<string, unknown> }[] = [
      { label: "planContentDigest not a string", context: { ...MAXIMAL_CONTEXT, planContentDigest: 42 } },
      { label: "derivedFromApprovalId not a string", context: { ...MAXIMAL_CONTEXT, derivedFromApprovalId: {} } },
      { label: "planId not a string", context: { ...MAXIMAL_CONTEXT, planId: ["plan-1"] } },
      { label: "planRevision not a number", context: { ...MAXIMAL_CONTEXT, planRevision: "3" } },
      { label: "planRevision zero", context: { ...MAXIMAL_CONTEXT, planRevision: 0 } },
      { label: "planRevision negative", context: { ...MAXIMAL_CONTEXT, planRevision: -1 } },
      { label: "planRevision fractional", context: { ...MAXIMAL_CONTEXT, planRevision: 1.5 } },
      { label: "planRevision null", context: { ...MAXIMAL_CONTEXT, planRevision: null } },
      { label: "statusWhenDecided unknown", context: { ...MAXIMAL_CONTEXT, statusWhenDecided: "NOT_A_STATUS" } },
      { label: "specRevision zero", context: { ...MAXIMAL_CONTEXT, specRevision: 0 } },
    ];

    for (const { label, context } of cases) {
      const json = encode({ ...approvalWith(MAXIMAL_CONTEXT), context });
      assert.throws(
        () => parseApproval(json, { id: "apr-roundtrip-1", subjectType: "WORK_ITEM", subjectId: "wi-0001" }),
        PersistenceCorruptionError,
        `${label} must be refused, not coerced`,
      );
    }
  });
});
