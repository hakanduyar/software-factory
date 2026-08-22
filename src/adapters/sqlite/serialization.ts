/**
 * JSON codec and runtime validation for rows read back from SQLite.
 *
 * Domain values are already JSON-safe (no `Date`, only numeric `Timestamp`),
 * so encoding is a plain `JSON.stringify`. Decoding is not a plain cast: a
 * row is untrusted input the moment it comes from disk — it may have been
 * written by an old build, hand-edited, or corrupted — so every parser here
 * checks the shape and the fields the domain logic actually branches on
 * (status/kind/role enums, numeric revision/version fields, boolean flags,
 * array-typed fields) before returning something typed as a domain value.
 * A malformed row throws `PersistenceCorruptionError` rather than silently
 * becoming a value that passes TypeScript's structural type check without
 * actually having the right shape.
 */

import type { AcceptanceCriterion } from "../../domain/acceptanceCriterion.js";
import { VERIFICATION_RESULTS, type AcceptanceCriterionVerification } from "../../domain/acceptanceCriterionVerification.js";
import { ACTOR_KINDS, type Actor } from "../../domain/actor.js";
import { APPROVAL_DECISIONS, PROTECTED_GATES, SUBJECT_TYPES, type Approval, type ApprovalContext, type SubjectRef } from "../../domain/approval.js";
import { PersistenceCorruptionError } from "../../domain/errors.js";
import { EVIDENCE_KINDS, type Evidence } from "../../domain/evidence.js";
import type { Project } from "../../domain/project.js";
import { REVIEW_KINDS, REVIEW_VERDICTS, type Review } from "../../domain/review.js";
import { FACTORY_ROLES, type FactoryRole } from "../../domain/role.js";
import { RUN_STATUSES, type Run } from "../../domain/run.js";
import { WORK_ITEM_STATUSES } from "../../domain/status.js";
import { PRIORITIES, WORK_ITEM_TYPES, type StatusChange, type WorkItem } from "../../domain/workItem.js";

export function encode(value: unknown): string {
  return JSON.stringify(value);
}

function decode(json: string, context: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new PersistenceCorruptionError(`${context}: stored data is not valid JSON (${String(error)})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PersistenceCorruptionError(`${context}: stored data must decode to an object, got ${JSON.stringify(parsed)}`);
  }
  return parsed as Record<string, unknown>;
}

function str(row: Record<string, unknown>, field: string, context: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new PersistenceCorruptionError(`${context}: field "${field}" must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalStr(row: Record<string, unknown>, field: string, context: string): string | undefined {
  const value = row[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new PersistenceCorruptionError(`${context}: field "${field}" must be a string when present, got ${JSON.stringify(value)}`);
  }
  return value;
}

function num(row: Record<string, unknown>, field: string, context: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PersistenceCorruptionError(`${context}: field "${field}" must be a finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalNum(row: Record<string, unknown>, field: string, context: string): number | undefined {
  const value = row[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PersistenceCorruptionError(`${context}: field "${field}" must be a finite number when present, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * `WorkItem.version`/`specRevision` and `Run.specRevision` are always
 * positive integers starting at 1 (see src/app/factoryService.ts's
 * `createWorkItem`, and src/workflow/workflowService.ts's `version: item.
 * version + 1` — neither field is ever zero, negative or fractional).
 */
function positiveInt(row: Record<string, unknown>, field: string, context: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new PersistenceCorruptionError(
      `${context}: field "${field}" must be a positive integer, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function optionalPositiveInt(row: Record<string, unknown>, field: string, context: string): number | undefined {
  const value = row[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new PersistenceCorruptionError(
      `${context}: field "${field}" must be a positive integer when present, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Throws unless `actual === expected`, for indexed SQL columns that must agree with the JSON payload. */
function crossCheck(context: string, field: string, expected: string | number, actual: string | number): void {
  if (expected !== actual) {
    throw new PersistenceCorruptionError(
      `${context}: SQL column "${field}" is ${JSON.stringify(expected)} but the JSON payload's "${field}" is ` +
        `${JSON.stringify(actual)} — a row's indexed metadata must never disagree with its stored data`,
    );
  }
}

function bool(row: Record<string, unknown>, field: string, context: string): boolean {
  const value = row[field];
  if (typeof value !== "boolean") {
    throw new PersistenceCorruptionError(`${context}: field "${field}" must be a boolean, got ${JSON.stringify(value)}`);
  }
  return value;
}

function strArray(row: Record<string, unknown>, field: string, context: string): string[] {
  const value = row[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new PersistenceCorruptionError(`${context}: field "${field}" must be an array of strings, got ${JSON.stringify(value)}`);
  }
  return value;
}

function oneOf<T extends string>(row: Record<string, unknown>, field: string, allowed: readonly T[], context: string): T {
  const value = row[field];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new PersistenceCorruptionError(
      `${context}: field "${field}" must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`,
    );
  }
  return value as T;
}

function optionalOneOf<T extends string>(
  row: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  context: string,
): T | undefined {
  const value = row[field];
  if (value === undefined) {
    return undefined;
  }
  return oneOf(row, field, allowed, context);
}

export function parseProject(json: string, expected: { readonly id: string }): Project {
  const row = decode(json, "Project");
  const id = str(row, "id", "Project");
  crossCheck(`Project(${expected.id})`, "id", expected.id, id);
  return {
    id,
    key: str(row, "key", "Project"),
    name: str(row, "name", "Project"),
    createdAt: num(row, "createdAt", "Project"),
  };
}

function parseStatusChange(value: unknown, index: number): StatusChange {
  const context = `WorkItem.history[${index}]`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PersistenceCorruptionError(`${context}: must be an object, got ${JSON.stringify(value)}`);
  }
  const row = value as Record<string, unknown>;
  const from = oneOf(row, "from", WORK_ITEM_STATUSES, context);
  const to = oneOf(row, "to", WORK_ITEM_STATUSES, context);
  const actorId = str(row, "actorId", context);
  const reason = optionalStr(row, "reason", context);
  const at = num(row, "at", context);
  return { from, to, actorId, ...(reason === undefined ? {} : { reason }), at };
}

export function parseWorkItem(
  json: string,
  expected: { readonly id: string; readonly projectId: string; readonly version: number },
): WorkItem {
  const row = decode(json, "WorkItem");
  const historyRaw = row.history;
  if (!Array.isArray(historyRaw)) {
    throw new PersistenceCorruptionError(`WorkItem: field "history" must be an array, got ${JSON.stringify(historyRaw)}`);
  }
  const id = str(row, "id", "WorkItem");
  const projectId = str(row, "projectId", "WorkItem");
  const status = oneOf(row, "status", WORK_ITEM_STATUSES, "WorkItem");
  const version = positiveInt(row, "version", "WorkItem");
  const assignedRole = optionalOneOf(row, "assignedRole", FACTORY_ROLES, "WorkItem");
  const blockedFrom = optionalOneOf(row, "blockedFrom", WORK_ITEM_STATUSES, "WorkItem");

  const context = `WorkItem(${expected.id})`;
  crossCheck(context, "id", expected.id, id);
  crossCheck(context, "projectId", expected.projectId, projectId);
  crossCheck(context, "version", expected.version, version);

  if (status === "BLOCKED" && blockedFrom === undefined) {
    throw new PersistenceCorruptionError(`${context}: status is BLOCKED but "blockedFrom" is missing`);
  }
  if (status !== "BLOCKED" && blockedFrom !== undefined) {
    throw new PersistenceCorruptionError(`${context}: "blockedFrom" is set (${blockedFrom}) but status is ${status}, not BLOCKED`);
  }

  return {
    id,
    projectId,
    title: str(row, "title", "WorkItem"),
    type: oneOf(row, "type", WORK_ITEM_TYPES, "WorkItem"),
    status,
    specRevision: positiveInt(row, "specRevision", "WorkItem"),
    version,
    ...(blockedFrom === undefined ? {} : { blockedFrom }),
    priority: oneOf(row, "priority", PRIORITIES, "WorkItem"),
    planVersion: str(row, "planVersion", "WorkItem"),
    dependencies: strArray(row, "dependencies", "WorkItem"),
    acceptanceCriteriaIds: strArray(row, "acceptanceCriteriaIds", "WorkItem"),
    ...(assignedRole === undefined ? {} : { assignedRole }),
    runIds: strArray(row, "runIds", "WorkItem"),
    history: historyRaw.map((entry, index) => parseStatusChange(entry, index)),
    createdAt: num(row, "createdAt", "WorkItem"),
    updatedAt: num(row, "updatedAt", "WorkItem"),
  };
}

export function parseAcceptanceCriterion(
  json: string,
  expected: { readonly id: string; readonly workItemId: string },
): AcceptanceCriterion {
  const row = decode(json, "AcceptanceCriterion");
  const id = str(row, "id", "AcceptanceCriterion");
  const workItemId = str(row, "workItemId", "AcceptanceCriterion");
  const context = `AcceptanceCriterion(${expected.id})`;
  crossCheck(context, "id", expected.id, id);
  crossCheck(context, "workItemId", expected.workItemId, workItemId);
  const verifiedByEvidenceId = optionalStr(row, "verifiedByEvidenceId", "AcceptanceCriterion");
  return {
    id,
    workItemId,
    text: str(row, "text", "AcceptanceCriterion"),
    verificationHint: str(row, "verificationHint", "AcceptanceCriterion"),
    ...(verifiedByEvidenceId === undefined ? {} : { verifiedByEvidenceId }),
  };
}

export function parseRun(json: string, expected: { readonly id: string; readonly workItemId: string; readonly status: string }): Run {
  const row = decode(json, "Run");
  const id = str(row, "id", "Run");
  const workItemId = str(row, "workItemId", "Run");
  const status = oneOf(row, "status", RUN_STATUSES, "Run");
  const finishedAt = optionalNum(row, "finishedAt", "Run");

  const context = `Run(${expected.id})`;
  crossCheck(context, "id", expected.id, id);
  crossCheck(context, "workItemId", expected.workItemId, workItemId);
  crossCheck(context, "status", expected.status, status);

  // A Run is created RUNNING and completes exactly once to a terminal
  // status (src/domain/run.ts) — finishedAt is set if and only if terminal.
  if (status === "RUNNING" && finishedAt !== undefined) {
    throw new PersistenceCorruptionError(`${context}: status is RUNNING but "finishedAt" is set`);
  }
  if (status !== "RUNNING" && finishedAt === undefined) {
    throw new PersistenceCorruptionError(`${context}: status is ${status} (terminal) but "finishedAt" is missing`);
  }

  const summary = optionalStr(row, "summary", "Run");
  const targetRunId = optionalStr(row, "targetRunId", "Run");
  return {
    id,
    workItemId,
    specRevision: positiveInt(row, "specRevision", "Run"),
    role: oneOf(row, "role", FACTORY_ROLES, "Run"),
    workerPrincipalId: str(row, "workerPrincipalId", "Run"),
    declaredWorkerId: str(row, "declaredWorkerId", "Run"),
    status,
    ...(summary === undefined ? {} : { summary }),
    ...(targetRunId === undefined ? {} : { targetRunId }),
    claimsAcceptanceMet: bool(row, "claimsAcceptanceMet", "Run"),
    evidenceIds: strArray(row, "evidenceIds", "Run"),
    startedAt: num(row, "startedAt", "Run"),
    ...(finishedAt === undefined ? {} : { finishedAt }),
  };
}

export function parseReview(json: string, expected: { readonly id: string; readonly workItemId: string }): Review {
  const row = decode(json, "Review");
  const id = str(row, "id", "Review");
  const workItemId = str(row, "workItemId", "Review");
  const context = `Review(${expected.id})`;
  crossCheck(context, "id", expected.id, id);
  crossCheck(context, "workItemId", expected.workItemId, workItemId);

  const findingsRaw = row.findings;
  if (!Array.isArray(findingsRaw) || findingsRaw.some((entry) => typeof entry !== "string")) {
    throw new PersistenceCorruptionError(`Review: field "findings" must be an array of strings, got ${JSON.stringify(findingsRaw)}`);
  }
  return {
    id,
    workItemId,
    specRevision: positiveInt(row, "specRevision", "Review"),
    reviewedRunId: str(row, "reviewedRunId", "Review"),
    reviewerRunId: str(row, "reviewerRunId", "Review"),
    kind: oneOf(row, "kind", REVIEW_KINDS, "Review"),
    reviewerPrincipalId: str(row, "reviewerPrincipalId", "Review"),
    implementerPrincipalId: str(row, "implementerPrincipalId", "Review"),
    verdict: oneOf(row, "verdict", REVIEW_VERDICTS, "Review"),
    findings: findingsRaw as string[],
    createdAt: num(row, "createdAt", "Review"),
  };
}

export function parseEvidence(json: string, expected: { readonly id: string; readonly workItemId: string }): Evidence {
  const row = decode(json, "Evidence");
  const id = str(row, "id", "Evidence");
  const workItemId = str(row, "workItemId", "Evidence");
  const context = `Evidence(${expected.id})`;
  crossCheck(context, "id", expected.id, id);
  crossCheck(context, "workItemId", expected.workItemId, workItemId);

  const criterionId = optionalStr(row, "criterionId", "Evidence");
  const runId = optionalStr(row, "runId", "Evidence");
  return {
    id,
    workItemId,
    kind: oneOf(row, "kind", EVIDENCE_KINDS, "Evidence"),
    summary: str(row, "summary", "Evidence"),
    reference: str(row, "reference", "Evidence"),
    ...(criterionId === undefined ? {} : { criterionId }),
    ...(runId === undefined ? {} : { runId }),
    createdAt: num(row, "createdAt", "Evidence"),
  };
}

export function parseVerification(
  json: string,
  expected: { readonly id: string; readonly workItemId: string },
): AcceptanceCriterionVerification {
  const row = decode(json, "AcceptanceCriterionVerification");
  const id = str(row, "id", "AcceptanceCriterionVerification");
  const workItemId = str(row, "workItemId", "AcceptanceCriterionVerification");
  const context = `AcceptanceCriterionVerification(${expected.id})`;
  crossCheck(context, "id", expected.id, id);
  crossCheck(context, "workItemId", expected.workItemId, workItemId);

  const evidenceId = optionalStr(row, "evidenceId", "AcceptanceCriterionVerification");
  return {
    id,
    criterionId: str(row, "criterionId", "AcceptanceCriterionVerification"),
    workItemId,
    specRevision: positiveInt(row, "specRevision", "AcceptanceCriterionVerification"),
    implementationRunId: str(row, "implementationRunId", "AcceptanceCriterionVerification"),
    result: oneOf(row, "result", VERIFICATION_RESULTS, "AcceptanceCriterionVerification"),
    verifierPrincipalId: str(row, "verifierPrincipalId", "AcceptanceCriterionVerification"),
    verifierRunId: str(row, "verifierRunId", "AcceptanceCriterionVerification"),
    ...(evidenceId === undefined ? {} : { evidenceId }),
    verifiedAt: num(row, "verifiedAt", "AcceptanceCriterionVerification"),
  };
}

function parseActor(value: unknown, context: string): Actor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PersistenceCorruptionError(`${context}: must be an object, got ${JSON.stringify(value)}`);
  }
  const row = value as Record<string, unknown>;
  return {
    id: str(row, "id", context),
    kind: oneOf(row, "kind", ACTOR_KINDS, context),
    displayName: str(row, "displayName", context),
  };
}

function parseSubject(value: unknown, context: string): SubjectRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PersistenceCorruptionError(`${context}: must be an object, got ${JSON.stringify(value)}`);
  }
  const row = value as Record<string, unknown>;
  return {
    type: oneOf(row, "type", SUBJECT_TYPES, context),
    id: str(row, "id", context),
  };
}

/**
 * EVERY field of `ApprovalContext` is reconstructed here, and this list must be
 * kept in step with `src/domain/approval.ts`.
 *
 * TASK-005 remediation round 3 exists because it was not. `ApprovalContext`
 * gained four TASK-005 authority fields while this function kept an older
 * three-field whitelist, so a PLAN approval recorded WITH a content digest came
 * back from SQLite WITHOUT one — and `gateGuard`, correctly, then refused to
 * treat it as authority. Nothing was corrupted and nothing was insecure; the
 * evidence was simply deleted in transit, which made every durable
 * SQLite-backed plan permanently unable to leave approval. The production
 * `sf plan approve` path was dead while every in-memory-backed test passed.
 *
 * The rule this encodes: an authority field that does not round-trip is an
 * authority field that does not exist. Silent field loss is never acceptable —
 * failing closed on corruption is.
 *
 * `tests/approvalContextRoundTrip.test.ts` asserts a maximal context survives
 * this function unchanged, so the next field added to the domain type fails
 * loudly here instead of silently disappearing in production.
 */
function parseApprovalContext(value: unknown, context: string): ApprovalContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PersistenceCorruptionError(`${context}: must be an object, got ${JSON.stringify(value)}`);
  }
  const row = value as Record<string, unknown>;
  const snapshotId = optionalStr(row, "snapshotId", context);
  // TASK-005: the bindings that make a PLAN approval mean one exact plan
  // revision, one exact approved content+configuration digest, and — for a
  // derived per-work-item approval — the human decision it descends from.
  const planContentDigest = optionalStr(row, "planContentDigest", context);
  const derivedFromApprovalId = optionalStr(row, "derivedFromApprovalId", context);
  const planId = optionalStr(row, "planId", context);
  const planRevision = optionalPositiveInt(row, "planRevision", context);
  return {
    statusWhenDecided: oneOf(row, "statusWhenDecided", WORK_ITEM_STATUSES, context),
    specRevision: positiveInt(row, "specRevision", context),
    ...(snapshotId === undefined ? {} : { snapshotId }),
    ...(planContentDigest === undefined ? {} : { planContentDigest }),
    ...(derivedFromApprovalId === undefined ? {} : { derivedFromApprovalId }),
    ...(planId === undefined ? {} : { planId }),
    ...(planRevision === undefined ? {} : { planRevision }),
  };
}

export function parseApproval(
  json: string,
  expected: { readonly id: string; readonly subjectType: string; readonly subjectId: string },
): Approval {
  const row = decode(json, "Approval");
  const id = str(row, "id", "Approval");
  const subject = parseSubject(row.subject, `Approval(${id}).subject`);

  const context = `Approval(${expected.id})`;
  crossCheck(context, "id", expected.id, id);
  crossCheck(context, "subject.type", expected.subjectType, subject.type);
  crossCheck(context, "subject.id", expected.subjectId, subject.id);

  const note = optionalStr(row, "note", "Approval");
  const contextRaw = row.context;
  return {
    id,
    gate: oneOf(row, "gate", PROTECTED_GATES, "Approval"),
    subject,
    decision: oneOf(row, "decision", APPROVAL_DECISIONS, "Approval"),
    decidedBy: parseActor(row.decidedBy, `Approval(${id}).decidedBy`),
    ...(contextRaw === undefined ? {} : { context: parseApprovalContext(contextRaw, `Approval(${id}).context`) }),
    ...(note === undefined ? {} : { note }),
    decidedAt: num(row, "decidedAt", "Approval"),
  };
}

// Re-export for adapters that need to reason about roles read from storage
// without importing the domain module directly.
export type { FactoryRole };
