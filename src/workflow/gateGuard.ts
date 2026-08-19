/**
 * The one place that decides whether a protected gate is satisfied.
 *
 * A gate is satisfied only by the latest decision for that (gate, subject)
 * pair, only when it is APPROVED, only when a HUMAN recorded it, and only
 * when what was approved is still what is current.
 *
 * "Still current" is deliberately not a counter comparison. Round-2 review
 * showed a counter can stay put while the implementation changes underneath
 * it. Instead the caller supplies an `expected` binding describing the
 * present:
 *   - PLAN_APPROVAL binds `specRevision` — the identity of the plan.
 *   - RELEASE_APPROVAL binds `snapshotId` — a content hash of the exact
 *     implementation run, verification, criterion verifications and reviews
 *     being released (src/domain/executionSnapshot.ts).
 * Both are stamped into the Approval by FactoryService from live state at
 * decision time, never supplied by the approving caller.
 */

import { sameSubject, type Approval, type ProtectedGate, type SubjectRef } from "../domain/approval.js";
import { ApprovalRequiredError } from "../domain/errors.js";

export interface ApprovalReader {
  listBySubject(subject: SubjectRef): Promise<readonly Approval[]>;
}

/** What the gate must currently match. Omit a field to leave it unchecked. */
export interface GateBinding {
  readonly specRevision?: number;
  readonly snapshotId?: string;
}

export interface GateStatus {
  readonly satisfied: boolean;
  readonly reason: string;
  readonly approval?: Approval;
}

export async function evaluateGate(
  approvals: ApprovalReader,
  gate: ProtectedGate,
  subject: SubjectRef,
  expected: GateBinding = {},
): Promise<GateStatus> {
  const relevant = (await approvals.listBySubject(subject)).filter(
    (approval) => approval.gate === gate && sameSubject(approval.subject, subject),
  );

  const latest = relevant.at(-1);

  if (latest === undefined) {
    return { satisfied: false, reason: "no human decision recorded" };
  }
  if (latest.decision !== "APPROVED") {
    return { satisfied: false, reason: "latest human decision was REJECTED", approval: latest };
  }
  if (latest.decidedBy.kind !== "HUMAN") {
    // Defence in depth: FactoryService.recordApproval already refuses to store these.
    return { satisfied: false, reason: "decision was not made by a human", approval: latest };
  }

  if (expected.specRevision !== undefined) {
    const approved = latest.context?.specRevision;
    if (approved !== expected.specRevision) {
      return {
        satisfied: false,
        reason: `approval is stale: granted for spec revision ${String(approved)}, current spec revision is ${expected.specRevision}`,
        approval: latest,
      };
    }
  }

  if (expected.snapshotId !== undefined) {
    const approved = latest.context?.snapshotId;
    if (approved === undefined) {
      return {
        satisfied: false,
        reason: "approval is not bound to a release snapshot and cannot authorise a release",
        approval: latest,
      };
    }
    if (approved !== expected.snapshotId) {
      return {
        satisfied: false,
        reason: `approval is stale: granted for release snapshot ${approved}, current release snapshot is ${expected.snapshotId}`,
        approval: latest,
      };
    }
  }

  return { satisfied: true, reason: `approved by ${latest.decidedBy.displayName}`, approval: latest };
}

export async function requireGate(
  approvals: ApprovalReader,
  gate: ProtectedGate,
  subject: SubjectRef,
  expected: GateBinding = {},
): Promise<Approval> {
  const status = await evaluateGate(approvals, gate, subject, expected);
  if (!status.satisfied || status.approval === undefined) {
    throw new ApprovalRequiredError(gate, subject.id, status.reason);
  }
  return status.approval;
}
