/**
 * Pure structural projection from a WorkItem runtime status to the public
 * (PublicStatus, NextAction) pair accepted by
 * scripts/github/sync-github-task-status.ps1.
 *
 * This is prospective INPUT for the existing durable status transport. It does
 * no IO, holds no lease, mutates nothing and cannot prove remote delivery or
 * issue approval: callers authenticate the actual acceptance and delivery
 * artifacts and pass in only the identities they verified. A "DONE" string or
 * an LLM report is never acceptance. RESUME_AUTHORIZED_WORK is public display
 * vocabulary, not dispatch authorization.
 */

import { WORK_ITEM_STATUSES } from "../../domain/status.js";
import type { WorkItemStatus } from "../../domain/status.js";

export type PublicStatus = "IN_PROGRESS" | "WAITING_FOR_REVIEW" | "BLOCKED" | "ACCEPTED_SCOPED";
export type NextAction =
  | "RUN_FOCUSED_CHECKS"
  | "INDEPENDENT_REVIEW"
  | "RESUME_AUTHORIZED_WORK"
  | "WAIT_FOR_DEPENDENCY";

/** Identity of one caller-authenticated artifact reference. */
export interface ReferenceSnapshot {
  readonly taskId: string;
  readonly specRevision: number;
  readonly runId: string;
  readonly referenceId: string;
}

/** What the caller independently verified for a DONE item. */
export interface DoneEvidenceSnapshot {
  readonly acceptance: ReferenceSnapshot;
  readonly delivery: ReferenceSnapshot;
}

export interface StatusProjectionInput {
  readonly taskId: string;
  /** Untrusted on purpose: an unknown runtime status must be REFUSED. */
  readonly status: string;
  readonly specRevision: number;
  readonly runId: string;
  readonly doneEvidence?: DoneEvidenceSnapshot;
}

export type RefusalCode =
  | "INPUT_MALFORMED"
  | "STATUS_UNKNOWN"
  | "DONE_EVIDENCE_MISSING"
  | "DONE_EVIDENCE_MALFORMED"
  | "DONE_EVIDENCE_MISMATCH";

export type StatusProjection =
  | { readonly kind: "PUBLISHABLE"; readonly publicStatus: PublicStatus; readonly nextAction: NextAction }
  | { readonly kind: "NOT_PUBLISHABLE"; readonly status: WorkItemStatus }
  | { readonly kind: "REFUSED"; readonly code: RefusalCode };

// Same id grammar as the transport's checkpoint/task validation.
const ID_RX = /^[A-Za-z0-9._:-]{1,128}$/;

const NOT_PUBLISHABLE: ReadonlySet<string> = new Set<WorkItemStatus>([
  "IDEA",
  "ANALYSIS",
  "PLAN_REVIEW",
  "READY",
  "IMPLEMENTING",
  "WAITING_FOR_HUMAN",
  "CANCELLED",
]);

const PAIRS: Readonly<Record<"VERIFYING" | "REVIEW" | "BLOCKED", { publicStatus: PublicStatus; nextAction: NextAction }>> = {
  VERIFYING: { publicStatus: "IN_PROGRESS", nextAction: "RUN_FOCUSED_CHECKS" },
  REVIEW: { publicStatus: "WAITING_FOR_REVIEW", nextAction: "INDEPENDENT_REVIEW" },
  BLOCKED: { publicStatus: "BLOCKED", nextAction: "WAIT_FOR_DEPENDENCY" },
};

function isId(v: unknown): v is string {
  return typeof v === "string" && ID_RX.test(v);
}

function isRevision(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function wellFormedRef(v: unknown): v is ReferenceSnapshot {
  return (
    isPlainObject(v) &&
    isId(v["taskId"]) &&
    isRevision(v["specRevision"]) &&
    isId(v["runId"]) &&
    isId(v["referenceId"])
  );
}

const refused = (code: RefusalCode): StatusProjection => ({ kind: "REFUSED", code });

export function projectWorkItemStatus(input: StatusProjectionInput): StatusProjection {
  if (
    !isPlainObject(input) ||
    !isId(input.taskId) ||
    typeof input.status !== "string" ||
    !isRevision(input.specRevision) ||
    !isId(input.runId)
  ) {
    return refused("INPUT_MALFORMED");
  }
  const status = input.status;
  if (!(WORK_ITEM_STATUSES as readonly string[]).includes(status)) return refused("STATUS_UNKNOWN");
  if (NOT_PUBLISHABLE.has(status)) return { kind: "NOT_PUBLISHABLE", status: status as WorkItemStatus };

  if (status === "VERIFYING" || status === "REVIEW" || status === "BLOCKED") {
    return { kind: "PUBLISHABLE", ...PAIRS[status] };
  }

  // Remaining status is DONE: structural match of caller-verified evidence only.
  const ev = input.doneEvidence;
  if (ev === undefined) return refused("DONE_EVIDENCE_MISSING");
  if (!isPlainObject(ev) || !wellFormedRef(ev.acceptance) || !wellFormedRef(ev.delivery)) {
    return refused("DONE_EVIDENCE_MALFORMED");
  }
  for (const ref of [ev.acceptance, ev.delivery]) {
    if (ref.taskId !== input.taskId || ref.specRevision !== input.specRevision || ref.runId !== input.runId) {
      return refused("DONE_EVIDENCE_MISMATCH");
    }
  }
  if (ev.acceptance.referenceId === ev.delivery.referenceId) return refused("DONE_EVIDENCE_MISMATCH");
  return { kind: "PUBLISHABLE", publicStatus: "ACCEPTED_SCOPED", nextAction: "RESUME_AUTHORIZED_WORK" };
}
