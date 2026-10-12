/**
 * D1-92: isolated trusted prestart primitive.
 *
 * Validates that an out-of-band, independently retained record for a given
 * opaque reference carries an explicit approval disposition AND genuinely
 * matches BOTH:
 *   - the existing strict WorkerTicket parser/digest validator
 *     (parseWorkerTicket / computeTicketDigest, unchanged), and
 *   - a genuine, runless current snapshot (principal/role/item/spec/full
 *     acceptance criteria/dependencies/target run/requested scope, model
 *     and budgets) supplied separately by the caller.
 *
 * PHASE7-102 adds a second, strictly separate execution kind alongside the
 * unchanged AI one. A retained record and the genuine current snapshot each
 * declare their own `executionKind`; the two must agree, and the pair
 * determines which accepted parser/digest runs:
 *   - "ai" (also the legacy shape, where the discriminant is absent):
 *     parseWorkerTicket / computeTicketDigest, model+token budgets still
 *     mandatory;
 *   - "deterministic-execution": parseDeterministicExecutionTicket /
 *     computeDeterministicExecutionTicketDigest, with ordered commands,
 *     workspace root, elapsed/output/attempt limits and an executionPolicy
 *     rationale, and NO model/token/provider quota at all.
 * Any other, mixed or absent-on-one-side-only kind refuses closed.
 *
 * `resolveApprovedPrestart` is constructor-injected: it resolves the
 * retained disposition/facts strictly from the port's OWN retained record
 * keyed by `reference`, never from anything the caller asserts about
 * approval. A raw caller-supplied ticket object or a caller-supplied
 * boolean never grants authority on their own; a retained record whose own
 * disposition is not "approved" is refused regardless of its shape, and an
 * approved record is further checked against the genuine current snapshot.
 *
 * This primitive performs no reservation, no handle/claim, no consume, no
 * launch permission and requires no RunId. A successful result is current
 * validation only — it is NOT a running/claimed/reserved/consumed grant and
 * cannot replace later mandatory issue/readiness/consume/cancel lifecycle
 * steps. The existing poststart admission source
 * (src/supervision/directWorkerAdmission.ts) is unchanged and untouched by
 * this module.
 */

import {
  parseWorkerTicket,
  computeTicketDigest,
  parseDeterministicExecutionTicket,
  computeDeterministicExecutionTicketDigest,
  DETERMINISTIC_EXECUTION_KIND,
  type WorkerTicket,
  type WorkerScope,
  type WorkerModelPolicy,
  type WorkerBudgets,
  type DeterministicExecutionTicket,
  type DeterministicCommand,
  type DeterministicBudgets,
  type DeterministicExecutionPolicy,
  type AcceptanceCriterion as TicketAcceptanceCriterion,
} from "./workerContract.js";
import { ValidationError } from "../domain/errors.js";
import type { AcceptanceCriterion as DomainAcceptanceCriterion } from "../domain/acceptanceCriterion.js";
import type { RunId, WorkItemId } from "../domain/ids.js";
import type { FactoryRole } from "../domain/role.js";
import type { WorkerPrincipal } from "../domain/workerPrincipal.js";
import type { WorkItem } from "../domain/workItem.js";

/**
 * D1-93 prerequisite: the frozen 92 ticket criterion type
 * `{id,version,description}` and the actual domain criterion type
 * `{id,workItemId,text,verificationHint,verifiedByEvidenceId?}` differ. This
 * union lets record/snapshot fields carry genuine domain criteria (full
 * shape, no invented `version`/`description`, no cast away) while still
 * accepting the legacy ticket shape where some caller still supplies it.
 * Comparator/parser/digest logic below is untouched: `deepEqual`/`sameIdSet`
 * already compare whatever own-enumerable fields a value actually has, so a
 * domain criterion's extra/different fields are preserved and compared
 * exactly, never coerced into the ticket shape.
 */
export type PrestartAcceptanceCriterion = TicketAcceptanceCriterion | DomainAcceptanceCriterion;

export class PrestartAdmissionRefusedError extends ValidationError {
  readonly reason: string;
  constructor(reason: string) {
    super(`direct worker prestart admission refused: ${reason}`);
    this.reason = reason;
  }
}

function fail(reason: string): never {
  throw new PrestartAdmissionRefusedError(reason);
}

/** Opaque caller-held reference to an out-of-band approved prestart record. */
export type PrestartTicketReference = string & {
  readonly __brand: "PrestartTicketReference";
};

/**
 * A trusted authority's own retained record for a reference, independently
 * of anything the current caller presents: a strict-shaped record carries
 * an explicit approval disposition (never a caller-supplied boolean). Only
 * "approved" records may ever be admitted; "unapproved" and "unavailable"
 * are both frozen, typed refusal outcomes a resolver can legitimately
 * return for a reference it does recognize, distinct from "unknown
 * reference entirely" (resolveApprovedPrestart returning undefined).
 */
export type RetainedPrestartRecord =
  | { readonly disposition: "approved"; readonly approval: ApprovedPrestartRecord }
  | { readonly disposition: "unapproved" }
  | { readonly disposition: "unavailable" };

/**
 * The deterministic-capable retained row: EXPLICITLY over the execution
 * union, named by the actual deterministic-aware port/resolver/internal
 * helpers below. `RetainedPrestartRecord` above stays the AI-compatible row
 * so unaffected AI stores/fixtures need no migration.
 */
export type RetainedExecutionPrestartRecord =
  | { readonly disposition: "approved"; readonly approval: ApprovedExecutionPrestartRecord }
  | { readonly disposition: "unapproved" }
  | { readonly disposition: "unavailable" };

/**
 * The approved facts a trusted authority retains for a reference,
 * independently of anything the current caller presents. `ticket` is the
 * raw candidate payload to be re-validated through the unchanged strict
 * parser/digest validator; `ticketDigest` is the trusted expected digest it
 * must match. The remaining fields are the authority's own retained record
 * of what was approved, compared field-by-field against the genuine current
 * snapshot — never against the candidate ticket's own self-reported values.
 * `approvedTargetRunId` binds the specific run this approval targets, if
 * any; its presence/absence is itself part of the approved fact set and is
 * compared exactly against the current snapshot's own target.
 */
interface ApprovedPrestartRecordCommon {
  readonly ticket: unknown;
  readonly ticketDigest: string;
  readonly approvedPrincipalId: string;
  readonly approvedRole: FactoryRole;
  readonly approvedWorkItemId: WorkItemId;
  readonly approvedSpecRevision: number;
  readonly approvedAcceptanceCriteria: readonly PrestartAcceptanceCriterion[];
  readonly approvedDependencyWorkItemIds: readonly WorkItemId[];
  readonly approvedTargetRunId?: RunId;
  readonly approvedScope: WorkerScope;
}

/**
 * The retained AI (model-backed) approved record. Unchanged in shape: the
 * `executionKind` discriminant is optional and absent means "ai", so every
 * existing retained row and every existing caller keeps working byte for
 * byte. A model/token policy is still mandatory here — a missing
 * `approvedModel` never becomes an exemption for a nonmock worker, it is a
 * malformed record and refuses.
 */
export interface ApprovedAiPrestartRecord extends ApprovedPrestartRecordCommon {
  readonly executionKind?: "ai";
  readonly approvedModel: WorkerModelPolicy;
  readonly approvedBudgets: WorkerBudgets;
}

/**
 * The retained DETERMINISTIC approved record (PHASE7-102). Carries the
 * actual ordered command sequence, workspace root, independently supplied
 * process budgets (elapsedSeconds/outputBytes/maxAttempts) and the
 * executionPolicy rationale the human approval bound — and deliberately NO
 * model/token/provider quota, which a deterministic command sequence does
 * not have and which must never be fabricated to satisfy an AI-shaped
 * check. `approvedWorkspace` and the command order are both digest-bound
 * through `computeDeterministicExecutionTicketDigest`.
 */
export interface ApprovedDeterministicPrestartRecord extends ApprovedPrestartRecordCommon {
  readonly executionKind: typeof DETERMINISTIC_EXECUTION_KIND;
  readonly approvedCommands: readonly DeterministicCommand[];
  readonly approvedWorkspace: string;
  readonly approvedDeterministicBudgets: DeterministicBudgets;
  readonly approvedExecutionPolicy: DeterministicExecutionPolicy;
}

/**
 * UNCHANGED public name: `ApprovedPrestartRecord` stays the AI-compatible
 * shape every existing retained row, fixture and validator was written
 * against, so `record.approvedModel`/`approvedBudgets` still resolve without
 * narrowing. The explicit execution union is a separate name that only
 * deterministic-aware code (this module's internals, the Factory, planned
 * supplier Unit2 and loop Unit3) chooses to say.
 */
export type ApprovedPrestartRecord = ApprovedAiPrestartRecord;

export type ApprovedExecutionPrestartRecord =
  | ApprovedAiPrestartRecord
  | ApprovedDeterministicPrestartRecord;

/**
 * Genuine, runless current-state facts to validate the approved record
 * against: the actual requested scope/model/budgets and an optional target
 * run, compared against the approved record's own facts, not merely
 * re-derived from the retained ticket. Deliberately excludes any handle,
 * binding, reservation, or launch capability: this primitive is
 * prestart-only and precedes all of that. `targetRunId` absence is exact —
 * an approval scoped to no particular run must not match a current request
 * that names one, and vice versa.
 */
interface CurrentPrestartSnapshotCommon {
  readonly item: Pick<WorkItem, "id" | "specRevision" | "dependencies">;
  readonly role: FactoryRole;
  readonly principal: WorkerPrincipal;
  readonly criteria: readonly PrestartAcceptanceCriterion[];
  readonly targetRunId?: RunId;
  readonly requestedScope: WorkerScope;
}

/** Unchanged AI current snapshot; absent `executionKind` means "ai". */
export interface CurrentAiPrestartSnapshot extends CurrentPrestartSnapshotCommon {
  readonly executionKind?: "ai";
  readonly requestedModel: WorkerModelPolicy;
  readonly requestedBudgets: WorkerBudgets;
}

/**
 * The genuine current DETERMINISTIC request: the actual host-side ordered
 * commands, workspace root, process limits and executionPolicy rationale
 * this run would really execute, captured independently of the retained
 * approval and of the retained ticket's own self-report. These are compared
 * exactly (order included) against the approved facts; no runtime default,
 * token-derived or maxResultBytes-derived value may stand in for a missing
 * one.
 */
export interface CurrentDeterministicPrestartSnapshot extends CurrentPrestartSnapshotCommon {
  readonly executionKind: typeof DETERMINISTIC_EXECUTION_KIND;
  readonly requestedCommands: readonly DeterministicCommand[];
  readonly requestedWorkspace: string;
  readonly requestedDeterministicBudgets: DeterministicBudgets;
  readonly requestedExecutionPolicy: DeterministicExecutionPolicy;
}

/**
 * UNCHANGED public name: `CurrentPrestartSnapshot` stays the AI-compatible
 * snapshot, so existing AI callers keep passing `{ requestedModel,
 * requestedBudgets, ... }` and keep precise inference. The explicit union is
 * `CurrentExecutionPrestartSnapshot`.
 */
export type CurrentPrestartSnapshot = CurrentAiPrestartSnapshot;

export type CurrentExecutionPrestartSnapshot =
  | CurrentAiPrestartSnapshot
  | CurrentDeterministicPrestartSnapshot;

/**
 * Current validation only. Not a run/claim/reserve/consume/launch grant.
 * The discriminant mirrors the retained record's own execution kind, so a
 * consumer can never read a deterministic ticket as an AI WorkerTicket (or
 * vice versa) without narrowing first. The unchanged AI consumer shape is
 * preserved: `kind === "ai"` still carries exactly `{ ticket, ticketDigest }`
 * with a strict-parsed WorkerTicket.
 */
export type ApprovedPrestartResult =
  | { readonly kind: "ai"; readonly ticket: WorkerTicket; readonly ticketDigest: string }
  | {
      readonly kind: typeof DETERMINISTIC_EXECUTION_KIND;
      readonly ticket: DeterministicExecutionTicket;
      readonly ticketDigest: string;
    };

/**
 * Trusted, constructor-injected port. A concrete implementation resolves
 * `reference` strictly against its OWN retained store; it must never derive
 * the returned disposition from request-supplied ticket content or from a
 * caller-supplied "approved" boolean. `undefined` means the reference is
 * entirely unknown to this authority; a defined RetainedPrestartRecord with
 * disposition "unapproved" or "unavailable" means the authority recognizes
 * the reference but the record itself carries no approval.
 */
export interface ApprovedPrestartPort<
  TRetained extends RetainedExecutionPrestartRecord = RetainedPrestartRecord,
> {
  resolveApprovedPrestart(reference: PrestartTicketReference): TRetained | undefined;
}

/**
 * The deterministic-capable prestart authority: an EXPLICIT instantiation
 * over the execution union, not the AI port reinterpreted. An authority that
 * only ever retains AI rows genuinely satisfies this too (its rows are a
 * union member), but a deterministic-aware consumer must narrow before
 * reading any kind-specific approved fact.
 */
export type ApprovedExecutionPrestartPort =
  ApprovedPrestartPort<RetainedExecutionPrestartRecord>;

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((item) => deepFreeze(item));
    return Object.freeze(value);
  }
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    return Object.freeze(value);
  }
  return value;
}

function cloneFrozen<T>(value: T): T {
  return deepFreeze(JSON.parse(JSON.stringify(value))) as T;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const keysA = Object.keys(a as Record<string, unknown>).sort();
    const keysB = Object.keys(b as Record<string, unknown>).sort();
    if (keysA.length !== keysB.length || keysA.some((key, index) => key !== keysB[index])) {
      return false;
    }
    return keysA.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

function sameCriteriaSet(
  approved: readonly PrestartAcceptanceCriterion[],
  current: readonly PrestartAcceptanceCriterion[],
): boolean {
  if (approved.length !== current.length) {
    return false;
  }
  const sortedApproved = [...approved].sort((a, b) => a.id.localeCompare(b.id));
  const sortedCurrent = [...current].sort((a, b) => a.id.localeCompare(b.id));
  return sortedApproved.every((criterion, index) => deepEqual(criterion, sortedCurrent[index]));
}

/**
 * Prestart admission: resolves the retained record for `reference` through
 * the trusted injected port's OWN retained store, refuses closed unless its
 * own disposition is explicitly "approved", strictly re-validates the
 * retained ticket payload through the unchanged parser/digest validator,
 * then compares every approved fact (principal/role/item/spec/full
 * acceptance criteria/dependencies/target run/scope/model/budgets) against
 * the genuine current snapshot supplied separately. Refuses closed on any
 * missing authority, unknown reference, non-approved disposition,
 * malformed retained record, digest mismatch, stale spec, wrong registry
 * principal/role, or any differing fact — current vs approved, and approved
 * vs the retained ticket's own strict-parsed facts. Never trusts a raw
 * caller ticket or a caller-supplied boolean as a substitute for the
 * independently retained approval.
 */
export type ApprovedAiPrestartResult = Extract<ApprovedPrestartResult, { readonly kind: "ai" }>;

/**
 * Old AI resolver callers keep their EXACT previous return inference: an
 * AI port + AI snapshot resolves through the first overload to the `kind:
 * "ai"` member, so `result.ticket` is still a WorkerTicket with no narrowing
 * and no migration. A deterministic or union callsite names the union
 * snapshot/port through the second overload and gets the full discriminated
 * result it must narrow.
 */
export function resolveApprovedPrestart(
  port: ApprovedPrestartPort,
  reference: PrestartTicketReference,
  snapshot: CurrentAiPrestartSnapshot,
): ApprovedAiPrestartResult;
export function resolveApprovedPrestart(
  port: ApprovedExecutionPrestartPort,
  reference: PrestartTicketReference,
  snapshot: CurrentExecutionPrestartSnapshot,
): ApprovedPrestartResult;
export function resolveApprovedPrestart(
  port: ApprovedExecutionPrestartPort,
  reference: PrestartTicketReference,
  snapshot: CurrentExecutionPrestartSnapshot,
): ApprovedPrestartResult {
  if (port === null || typeof port !== "object" || typeof port.resolveApprovedPrestart !== "function") {
    fail("no trusted approved-prestart authority was supplied");
  }
  if (!isNonEmptyString(reference)) {
    fail("ticket reference is missing or empty");
  }

  const retained = port.resolveApprovedPrestart(reference);
  if (retained === undefined || retained === null || typeof retained !== "object") {
    fail("ticket reference is unknown to the trusted approved-prestart authority");
  }
  if (retained.disposition === "unapproved" || retained.disposition === "unavailable") {
    fail(`retained record carries no approval (disposition: ${retained.disposition})`);
  }
  if (retained.disposition !== "approved") {
    fail("retained record has an unrecognized disposition");
  }

  const record = retained.approval;
  if (record === undefined || record === null || typeof record !== "object") {
    fail("retained approved record is missing its approval payload");
  }

  if (!isNonEmptyString(record.ticketDigest)) {
    fail("retained approved record has a missing or malformed ticketDigest");
  }
  if (!isNonEmptyString(record.approvedPrincipalId)) {
    fail("retained approved record has a missing or malformed approvedPrincipalId");
  }
  if (!isPositiveSafeInteger(record.approvedSpecRevision)) {
    fail("retained approved record has a missing or malformed approvedSpecRevision");
  }
  if (!isNonEmptyString(record.approvedWorkItemId)) {
    fail("retained approved record has a missing or malformed approvedWorkItemId");
  }
  if (!Array.isArray(record.approvedDependencyWorkItemIds)) {
    fail("retained approved record has a missing or malformed approvedDependencyWorkItemIds");
  }
  if (!Array.isArray(record.approvedAcceptanceCriteria)) {
    fail("retained approved record has a missing or malformed approvedAcceptanceCriteria");
  }

  // The execution kind is a fact of the retained record and of the genuine
  // current request, and the two must agree exactly. An absent discriminant
  // on either side is the legacy AI shape; anything that is neither "ai" nor
  // the deterministic kind, and any mix of the two, refuses closed rather
  // than being narrowed into whichever branch happens to parse.
  const recordKind = recordExecutionKind(record);
  const snapshotKind = snapshotExecutionKind(snapshot);
  if (recordKind === undefined) {
    fail("retained approved record has an unrecognized executionKind");
  }
  if (snapshotKind === undefined) {
    fail("current prestart snapshot has an unrecognized executionKind");
  }
  if (recordKind !== snapshotKind) {
    fail(
      `retained approved executionKind (${recordKind}) does not match the current request's executionKind (${snapshotKind})`,
    );
  }

  if (snapshot.item.specRevision !== record.approvedSpecRevision) {
    fail("approved specRevision is stale against the current WorkItem specRevision");
  }
  if (snapshot.item.id !== record.approvedWorkItemId) {
    fail("approved workItemId does not match the current WorkItem");
  }
  if (snapshot.role !== record.approvedRole) {
    fail("approved role does not match the current registry-issued run role");
  }
  if (snapshot.principal.principalId !== record.approvedPrincipalId) {
    fail("approved principalId does not match the current registry-issued principal");
  }
  if (!sameCriteriaSet(record.approvedAcceptanceCriteria, snapshot.criteria)) {
    fail("approved acceptance criteria do not fully match the current WorkItem criteria");
  }
  if (!sameIdSet(record.approvedDependencyWorkItemIds, snapshot.item.dependencies)) {
    fail("approved dependency work items do not match the current WorkItem dependencies");
  }
  if (record.approvedTargetRunId !== snapshot.targetRunId) {
    fail("approved target run does not exactly match the current target run (including absence)");
  }
  if (!deepEqual(record.approvedScope, snapshot.requestedScope)) {
    fail("approved scope does not match the current genuinely requested scope");
  }

  if (recordKind === DETERMINISTIC_EXECUTION_KIND) {
    return resolveDeterministicBranch(
      record as ApprovedDeterministicPrestartRecord,
      snapshot as CurrentDeterministicPrestartSnapshot,
    );
  }
  return resolveAiBranch(record as ApprovedAiPrestartRecord, snapshot as CurrentAiPrestartSnapshot);
}

const AI_ONLY_RECORD_FIELDS: readonly string[] = ["approvedModel", "approvedBudgets"];
const DETERMINISTIC_ONLY_RECORD_FIELDS: readonly string[] = [
  "approvedCommands",
  "approvedWorkspace",
  "approvedDeterministicBudgets",
  "approvedExecutionPolicy",
];
const AI_ONLY_SNAPSHOT_FIELDS: readonly string[] = ["requestedModel", "requestedBudgets"];
const DETERMINISTIC_ONLY_SNAPSHOT_FIELDS: readonly string[] = [
  "requestedCommands",
  "requestedWorkspace",
  "requestedDeterministicBudgets",
  "requestedExecutionPolicy",
];

/**
 * Resolves a declared execution kind and refuses any MIXED shape — one that
 * declares one kind while also carrying the other kind's fields. Presence is
 * decided by KEY presence (`in`), not by value, so an explicitly
 * `undefined` opposite-kind field is still a mixed shape rather than being
 * normalized away. Returns `undefined` for an unknown kind or a mixed one;
 * callers refuse closed on `undefined`. This never makes a MISSING
 * same-kind field an exemption: each branch still demands its own complete
 * fact set.
 */
function resolveExecutionKind(
  value: object,
  aiOnlyFields: readonly string[],
  deterministicOnlyFields: readonly string[],
): "ai" | typeof DETERMINISTIC_EXECUTION_KIND | undefined {
  const declared = (value as { readonly executionKind?: unknown }).executionKind;
  const bag = value as unknown as Record<string, unknown>;
  if (declared === DETERMINISTIC_EXECUTION_KIND) {
    return aiOnlyFields.some((field) => field in bag) ? undefined : DETERMINISTIC_EXECUTION_KIND;
  }
  if (declared === undefined || declared === "ai") {
    return deterministicOnlyFields.some((field) => field in bag) ? undefined : "ai";
  }
  return undefined;
}

/** Execution kind of a retained record; `undefined` for any unknown/mixed shape. */
function recordExecutionKind(
  record: ApprovedExecutionPrestartRecord,
): "ai" | typeof DETERMINISTIC_EXECUTION_KIND | undefined {
  return resolveExecutionKind(record, AI_ONLY_RECORD_FIELDS, DETERMINISTIC_ONLY_RECORD_FIELDS);
}

/** Execution kind of the genuine current request; `undefined` for any unknown/mixed shape. */
function snapshotExecutionKind(
  snapshot: CurrentExecutionPrestartSnapshot,
): "ai" | typeof DETERMINISTIC_EXECUTION_KIND | undefined {
  return resolveExecutionKind(snapshot, AI_ONLY_SNAPSHOT_FIELDS, DETERMINISTIC_ONLY_SNAPSHOT_FIELDS);
}

/**
 * The unchanged AI branch: strict `parseWorkerTicket`/`computeTicketDigest`,
 * then the genuine current model/budget request compared against the
 * authority's own approved facts, then those approved facts compared against
 * the retained ticket's own strict-parsed values. A deterministic command
 * shape smuggled in here is refused by the AI parser itself — this branch
 * never accepts a deterministic object.
 */
function resolveAiBranch(
  record: ApprovedAiPrestartRecord,
  snapshot: CurrentAiPrestartSnapshot,
): ApprovedPrestartResult {
  const parsed = parseWorkerTicket(record.ticket);
  if (!parsed.ok) {
    fail(`retained approved ticket failed strict validation: ${parsed.errors.join("; ")}`);
  }
  const digest = computeTicketDigest(parsed.value);
  if (digest !== record.ticketDigest) {
    fail("retained approved ticket digest does not match the authority's own expected digest");
  }

  if (record.approvedModel === undefined || record.approvedModel === null) {
    fail("retained approved record has a missing or malformed approvedModel");
  }
  if (record.approvedBudgets === undefined || record.approvedBudgets === null) {
    fail("retained approved record has a missing or malformed approvedBudgets");
  }
  if (snapshot.requestedModel === undefined || snapshot.requestedModel === null) {
    fail("current prestart snapshot has a missing or malformed requestedModel");
  }
  if (snapshot.requestedBudgets === undefined || snapshot.requestedBudgets === null) {
    fail("current prestart snapshot has a missing or malformed requestedBudgets");
  }
  if (!deepEqual(record.approvedModel, snapshot.requestedModel)) {
    fail("approved model does not match the current genuinely requested model policy");
  }
  if (!deepEqual(record.approvedBudgets, snapshot.requestedBudgets)) {
    fail("approved budgets does not match the current genuinely requested budgets");
  }
  if (!deepEqual(record.approvedScope, parsed.value.scope)) {
    fail("approved scope does not match the retained ticket's own scope (strict ticket consistency)");
  }
  if (!deepEqual(record.approvedModel, parsed.value.model)) {
    fail("approved model does not match the retained ticket's own model policy (strict ticket consistency)");
  }
  if (!deepEqual(record.approvedBudgets, parsed.value.budgets)) {
    fail("approved budgets does not match the retained ticket's own budgets (strict ticket consistency)");
  }

  return {
    kind: "ai",
    ticket: cloneFrozen(parsed.value),
    ticketDigest: digest,
  };
}

/**
 * The deterministic branch: strict `parseDeterministicExecutionTicket` /
 * `computeDeterministicExecutionTicketDigest` only (no parallel schema, no
 * legacy AI parser), then the full approved fact set — ordered commands,
 * workspace, elapsedSeconds/outputBytes/maxAttempts, executionPolicy
 * rationale — compared exactly against BOTH the genuine current host inputs
 * and the retained ticket's own digest-bound values. Every deterministic
 * approved/current field must be PRESENT: a missing or malformed policy
 * refuses, and nothing is defaulted, token-derived or derived from
 * resultSchema.maxResultBytes.
 */
function resolveDeterministicBranch(
  record: ApprovedDeterministicPrestartRecord,
  snapshot: CurrentDeterministicPrestartSnapshot,
): ApprovedPrestartResult {
  if (!Array.isArray(record.approvedCommands) || record.approvedCommands.length === 0) {
    fail("retained approved record has a missing or malformed approvedCommands");
  }
  if (!isNonEmptyString(record.approvedWorkspace)) {
    fail("retained approved record has a missing or malformed approvedWorkspace");
  }
  if (!isDeterministicBudgets(record.approvedDeterministicBudgets)) {
    fail("retained approved record has a missing or malformed approvedDeterministicBudgets");
  }
  if (!isDeterministicExecutionPolicy(record.approvedExecutionPolicy)) {
    fail("retained approved record has a missing or malformed approvedExecutionPolicy");
  }
  if (!Array.isArray(snapshot.requestedCommands) || snapshot.requestedCommands.length === 0) {
    fail("current prestart snapshot has a missing or malformed requestedCommands");
  }
  if (!isNonEmptyString(snapshot.requestedWorkspace)) {
    fail("current prestart snapshot has a missing or malformed requestedWorkspace");
  }
  if (!isDeterministicBudgets(snapshot.requestedDeterministicBudgets)) {
    fail("current prestart snapshot has missing or malformed requestedDeterministicBudgets");
  }
  if (!isDeterministicExecutionPolicy(snapshot.requestedExecutionPolicy)) {
    fail("current prestart snapshot has a missing or malformed requestedExecutionPolicy");
  }
  // A deterministic record must never carry an AI model/token policy: that
  // would be exactly the fabricated provider quota this phase refuses.
  for (const forbidden of ["approvedModel", "approvedBudgets"] as const) {
    if (forbidden in (record as unknown as Record<string, unknown>)) {
      fail(`retained deterministic record carries an AI-only field (${forbidden})`);
    }
  }

  const parsed = parseDeterministicExecutionTicket(record.ticket);
  if (!parsed.ok) {
    fail(`retained approved deterministic ticket failed strict validation: ${parsed.errors.join("; ")}`);
  }
  const digest = computeDeterministicExecutionTicketDigest(parsed.value);
  if (digest !== record.ticketDigest) {
    fail(
      "retained approved deterministic ticket digest does not match the authority's own expected digest",
    );
  }

  // Order is significant on both comparisons: `deepEqual` compares arrays
  // index by index, so a reordered command sequence is a mismatch.
  if (!deepEqual(record.approvedCommands, snapshot.requestedCommands)) {
    fail("approved verification commands do not exactly match the current genuinely requested commands");
  }
  if (record.approvedWorkspace !== snapshot.requestedWorkspace) {
    fail("approved workspace root does not match the current genuinely requested workspace root");
  }
  if (!deepEqual(record.approvedDeterministicBudgets, snapshot.requestedDeterministicBudgets)) {
    fail("approved deterministic budgets do not match the current genuinely requested process limits");
  }
  if (!deepEqual(record.approvedExecutionPolicy, snapshot.requestedExecutionPolicy)) {
    fail("approved executionPolicy rationale does not match the current genuinely requested executionPolicy");
  }
  if (!deepEqual(record.approvedScope, parsed.value.scope)) {
    fail("approved scope does not match the retained ticket's own scope (strict ticket consistency)");
  }
  if (!deepEqual(record.approvedCommands, parsed.value.commands)) {
    fail("approved commands do not match the retained ticket's own commands (strict ticket consistency)");
  }
  if (record.approvedWorkspace !== parsed.value.workspace) {
    fail("approved workspace does not match the retained ticket's own workspace (strict ticket consistency)");
  }
  if (!deepEqual(record.approvedDeterministicBudgets, parsed.value.budgets)) {
    fail("approved deterministic budgets do not match the retained ticket's own budgets (strict ticket consistency)");
  }
  if (!deepEqual(record.approvedExecutionPolicy, parsed.value.executionPolicy)) {
    fail(
      "approved executionPolicy does not match the retained ticket's own executionPolicy (strict ticket consistency)",
    );
  }

  return {
    kind: DETERMINISTIC_EXECUTION_KIND,
    ticket: cloneFrozen(parsed.value),
    ticketDigest: digest,
  };
}

function isDeterministicBudgets(value: unknown): value is DeterministicBudgets {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.elapsedSeconds === "number" &&
    Number.isFinite(candidate.elapsedSeconds) &&
    candidate.elapsedSeconds > 0 &&
    isPositiveSafeInteger(candidate.outputBytes) &&
    isPositiveSafeInteger(candidate.maxAttempts)
  );
}

function isDeterministicExecutionPolicy(value: unknown): value is DeterministicExecutionPolicy {
  if (value === null || typeof value !== "object") {
    return false;
  }
  return isNonEmptyString((value as Record<string, unknown>).rationale);
}
