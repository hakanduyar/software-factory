/**
 * Shared admission boundary for a "protected direct run" — a
 * FactoryService.runWorker call against a registry-issued principal that is
 * host-flagged `requiresDirectAdmission` (see src/domain/workerPrincipal.ts,
 * src/ports/workerRegistry.ts).
 *
 * D1 scope only: binds a trusted, caller-configured DirectWorkerTicket to
 * the exact WorkItem/specRevision/role/principal/criteria of the current
 * run, BEFORE Worker.execute is invoked, and exposes a `revalidate` closure
 * an adapter calls again immediately before its ProcessRunner invocation
 * (Phase 2), so authority that changed between phases is caught before any
 * process spawns. Never derives authority from Worker.id, capabilities, or
 * any model-authored text. D3 live quota/confinement capability is out of
 * scope here and is not probed; this module performs no provider calls.
 */

import { createHash } from "node:crypto";

import {
  parseWorkerTicket,
  computeTicketDigest,
  parseDeterministicExecutionTicket,
  computeDeterministicExecutionTicketDigest,
  DETERMINISTIC_EXECUTION_KIND,
  type WorkerTicket,
  type DeterministicExecutionTicket,
} from "./workerContract.js";
import type { AcceptanceCriterion } from "../domain/acceptanceCriterion.js";
import { ValidationError } from "../domain/errors.js";
import type { WorkItemId } from "../domain/ids.js";
import type { FactoryRole } from "../domain/role.js";
import type { WorkerPrincipal } from "../domain/workerPrincipal.js";
import type { WorkItem } from "../domain/workItem.js";

export class DirectAdmissionRefusedError extends ValidationError {
  readonly reason: string;
  constructor(reason: string) {
    super(`direct provider admission refused: ${reason}`);
    this.reason = reason;
  }
}

/** Trusted, caller-configured — never parsed from model output or worker text. */
export interface DirectWorkerTicket {
  readonly ticketId: string;
  readonly workItemId: WorkItemId;
  readonly specRevision: number;
  readonly role: FactoryRole;
  readonly principalId: string;
  readonly criteriaIds: readonly string[];
  readonly dependencyWorkItemIds: readonly WorkItemId[];
  readonly budgets: {
    readonly maxAttempts: number;
    readonly elapsedSeconds: number;
  };
  readonly approved: boolean;
}

export interface DirectAdmissionSnapshot {
  readonly item: Pick<WorkItem, "id" | "specRevision">;
  readonly role: FactoryRole;
  readonly principal: WorkerPrincipal;
  readonly criteria: readonly AcceptanceCriterion[];
}

export interface DirectAdmissionBinding {
  readonly ticketDigest: string;
  revalidate(snapshot: DirectAdmissionSnapshot): void;
}

function fail(reason: string): never {
  throw new DirectAdmissionRefusedError(reason);
}

function canonicalTicketDigest(ticket: DirectWorkerTicket): string {
  const serialized = JSON.stringify({
    ticketId: ticket.ticketId,
    workItemId: ticket.workItemId,
    specRevision: ticket.specRevision,
    role: ticket.role,
    principalId: ticket.principalId,
    criteriaIds: [...ticket.criteriaIds].sort(),
    dependencyWorkItemIds: [...ticket.dependencyWorkItemIds].sort(),
    budgets: ticket.budgets,
    approved: ticket.approved,
  });
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

function checkBinding(ticket: DirectWorkerTicket, snapshot: DirectAdmissionSnapshot): void {
  if (ticket.approved !== true) {
    fail("ticket is not marked approved");
  }
  if (!Number.isSafeInteger(ticket.specRevision) || ticket.specRevision < 1) {
    fail("ticket specRevision is malformed");
  }
  if (!Array.isArray(ticket.dependencyWorkItemIds)) {
    fail("ticket dependencyWorkItemIds is malformed");
  }
  if (
    !Number.isFinite(ticket.budgets.maxAttempts) ||
    ticket.budgets.maxAttempts <= 0 ||
    !Number.isFinite(ticket.budgets.elapsedSeconds) ||
    ticket.budgets.elapsedSeconds <= 0
  ) {
    fail("ticket budgets must be positive finite values");
  }
  if (ticket.workItemId !== snapshot.item.id) {
    fail("ticket workItemId does not match the current WorkItem");
  }
  if (ticket.specRevision !== snapshot.item.specRevision) {
    fail("ticket specRevision is stale against the current WorkItem specRevision");
  }
  if (ticket.role !== snapshot.role) {
    fail("ticket role does not match the requested run role");
  }
  if (ticket.principalId !== snapshot.principal.principalId) {
    fail("ticket principalId does not match the registry-issued principal for this worker");
  }
  if (!sameIdSet(ticket.criteriaIds, snapshot.criteria.map((c) => c.id))) {
    fail("ticket acceptance criteria do not match the current WorkItem criteria");
  }
}

/** Phase 1: admits a direct run BEFORE Worker.execute. Throws on any mismatch. */
export function admitDirectWorkerRun(
  ticket: DirectWorkerTicket,
  snapshot: DirectAdmissionSnapshot,
): DirectAdmissionBinding {
  checkBinding(ticket, snapshot);
  const digest = canonicalTicketDigest(ticket);
  return {
    ticketDigest: digest,
    revalidate(next: DirectAdmissionSnapshot): void {
      checkBinding(ticket, next);
      if (canonicalTicketDigest(ticket) !== digest) {
        fail("ticket digest changed between phases (forged or mutated ticket)");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// D1 dependency increment: pure strict frozen-ticket validation helper.
// Validation-only - does not grant run authority and does not replace or
// strengthen the legacy DirectWorkerTicket admission above. Expected digest
// is supplied by a future trusted host authority; this helper never derives
// trust from the input itself.
// ---------------------------------------------------------------------------

export interface StrictTicketValidationResult {
  readonly ticket: WorkerTicket;
  readonly digest: string;
}

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

/**
 * Pure, strict validation of an untrusted candidate ticket against a
 * trusted expected canonical digest. Reuses parseWorkerTicket/
 * computeTicketDigest unchanged; defines no parallel schema/canonicalizer.
 * Throws DirectAdmissionRefusedError on any malformed, partial, unsupported
 * or digest-mismatched input. The returned ticket is a deep-frozen snapshot
 * insulated from later mutation of the caller's source input.
 */
export function validateStrictFrozenTicket(
  candidate: unknown,
  expectedDigest: string,
): StrictTicketValidationResult {
  const parsed = parseWorkerTicket(candidate);
  if (!parsed.ok) {
    fail(`strict ticket validation failed: ${parsed.errors.join("; ")}`);
  }
  const digest = computeTicketDigest(parsed.value);
  if (digest !== expectedDigest) {
    fail("strict ticket validation failed: canonical digest does not match trusted expected digest");
  }
  const snapshot = deepFreeze(JSON.parse(JSON.stringify(parsed.value))) as WorkerTicket;
  return { ticket: snapshot, digest };
}

export interface StrictDeterministicTicketValidationResult {
  readonly ticket: DeterministicExecutionTicket;
  readonly digest: string;
}

/**
 * PHASE7-102 sibling of `validateStrictFrozenTicket` for the deterministic
 * execution kind. Reuses the accepted `parseDeterministicExecutionTicket` /
 * `computeDeterministicExecutionTicketDigest` unchanged — no parallel schema
 * and no parallel canonicalizer — and never routes a deterministic candidate
 * through the AI parser. Validation only: confers no approval, reservation
 * or launch authority, and the expected digest must come from a trusted host
 * authority, never from the candidate itself.
 */
export function validateStrictFrozenDeterministicTicket(
  candidate: unknown,
  expectedDigest: string,
): StrictDeterministicTicketValidationResult {
  const parsed = parseDeterministicExecutionTicket(candidate);
  if (!parsed.ok) {
    fail(`strict deterministic ticket validation failed: ${parsed.errors.join("; ")}`);
  }
  const digest = computeDeterministicExecutionTicketDigest(parsed.value);
  if (digest !== expectedDigest) {
    fail(
      "strict deterministic ticket validation failed: canonical digest does not match trusted expected digest",
    );
  }
  const snapshot = deepFreeze(
    JSON.parse(JSON.stringify(parsed.value)),
  ) as DeterministicExecutionTicket;
  return { ticket: snapshot, digest };
}

// ---------------------------------------------------------------------------
// D1 dependency increment: trusted-host direct-launch authority contract
// (types only). Defines the shape a future trusted host supplies when
// resolving/reserving/consuming a direct launch; no runtime behavior, no
// brands that prove forgery-resistance, no D3 live quota/confinement
// supplier. A future admission gate must independently validate a complete,
// fresh, exactly-matching grant and fail closed on anything missing or
// unknown; nothing here performs that validation.
// ---------------------------------------------------------------------------

import type { RunId } from "../domain/ids.js";
import type {
  DirectLaunchBinding,
  DirectLaunchAuthorityPort,
} from "../ports/worker.js";

/** Opaque trusted-host reference to an out-of-band ticket record; never a caller-asserted ticket or approval boolean. */
export type TrustedTicketReference = string & { readonly __brand: "TrustedTicketReference" };

export type DirectLaunchModelExpectation = WorkerTicket["model"];
export type DirectLaunchScopeExpectation = WorkerTicket["scope"];
export type DirectLaunchBudgetExpectation = WorkerTicket["budgets"];

export type DirectLaunchCommandExpectation = DeterministicExecutionTicket["commands"];
export type DirectLaunchDeterministicBudgetExpectation = DeterministicExecutionTicket["budgets"];
export type DirectLaunchExecutionPolicyExpectation = DeterministicExecutionTicket["executionPolicy"];

interface DirectHostLaunchRequestCommon {
  readonly ticketReference: TrustedTicketReference;
  readonly registryPrincipalId: string;
  readonly workItemId: WorkItemId;
  readonly specRevision: number;
  readonly runId: RunId;
  readonly role: FactoryRole;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly dependencyWorkItemIds: readonly WorkItemId[];
  readonly scope: DirectLaunchScopeExpectation;
}

/**
 * Context the caller presents to a trusted host authority before any run.
 *
 * `DirectHostLaunchRequest` remains EXACTLY the pre-PHASE7-102 AI shape — the
 * same absent-discriminant form with a mandatory `model` — so every existing
 * producer, consumer and fixture keeps its previous precise inference
 * (`request.model` still resolves) rather than being forced to narrow a
 * widened union it was never written against. `executionKind: "ai"` is an
 * explicit spelling of the same thing.
 *
 * The deterministic sibling replaces `model` with the actual ordered
 * commands, workspace root, process budgets and executionPolicy rationale —
 * it has no model, token or provider quota expectation, and none may be
 * invented to fill one. `DirectHostExecutionLaunchRequest` is the EXPLICIT
 * discriminated union over both kinds; only a deterministic-capable caller
 * (Factory here, supplier Unit2 and loop Unit3 later) names it.
 */
export type DirectHostLaunchRequest = DirectHostLaunchRequestCommon & {
  readonly executionKind?: "ai";
  readonly model: DirectLaunchModelExpectation;
};

export type DirectHostDeterministicLaunchRequest = DirectHostLaunchRequestCommon & {
  readonly executionKind: typeof DETERMINISTIC_EXECUTION_KIND;
  readonly commands: DirectLaunchCommandExpectation;
  readonly workspace: string;
  readonly budgets: DirectLaunchDeterministicBudgetExpectation;
  readonly executionPolicy: DirectLaunchExecutionPolicyExpectation;
};

/** Explicit PHASE7-102 execution union; the AI alias above is deliberately NOT widened into it. */
export type DirectHostExecutionLaunchRequest =
  | DirectHostLaunchRequest
  | DirectHostDeterministicLaunchRequest;

export type DirectHostAiLaunchRequest = DirectHostLaunchRequest;

/**
 * Resolves a declared execution kind and refuses any MIXED shape — one
 * declaring one kind while also carrying the other kind's fields. Presence
 * is KEY presence (`in`), so an explicitly `undefined` opposite-kind field
 * is still mixed and is never normalized away. `undefined` means unknown or
 * mixed, and every caller refuses closed on it; a missing SAME-kind field is
 * never exempted here — each branch validates its own complete fact set.
 */
function resolveLaunchExecutionKind(
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

const DETERMINISTIC_ONLY_REQUEST_FIELDS: readonly string[] = [
  "commands",
  "workspace",
  "executionPolicy",
];
const DETERMINISTIC_ONLY_EVIDENCE_FIELDS: readonly string[] = [
  "commands",
  "workspace",
  "executionPolicy",
  "process",
];

/** `undefined` for any unknown or mixed execution-kind shape. */
export function directLaunchRequestKind(
  request: DirectHostExecutionLaunchRequest,
): "ai" | typeof DETERMINISTIC_EXECUTION_KIND | undefined {
  return resolveLaunchExecutionKind(request, ["model"], DETERMINISTIC_ONLY_REQUEST_FIELDS);
}

/**
 * Structured capability evidence a trusted host must attach to a grant.
 * Binds the identical ticket/principal/workitem/spec/run/reservation/version
 * as the accompanying DirectLaunchBinding, and the exact scope/model/budget
 * expectations it was evaluated against. Numeric availability fields are
 * point-in-time observations, not guarantees; supported/verified flags
 * record what the host actually checked, not what it assumes.
 */
interface DirectLaunchCapabilityEvidenceCommon {
  readonly ticketDigest: string;
  readonly registryPrincipalId: string;
  readonly workItemId: WorkItemId;
  readonly specRevision: number;
  readonly runId: RunId;
  readonly reservationId: string;
  readonly reservationVersion: number;
  readonly scope: DirectLaunchScopeExpectation;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly evidenceReference: string;
  readonly evidenceDigest: string;
  readonly confinement: {
    readonly supportedScopeOwned: readonly string[];
    readonly supportedScopeForbidden: readonly string[];
    readonly verified: boolean;
  };
}

/** Unchanged AI capability evidence; absent `executionKind` means "ai". */
export interface DirectLaunchAiCapabilityEvidence extends DirectLaunchCapabilityEvidenceCommon {
  readonly executionKind?: "ai";
  readonly model: DirectLaunchModelExpectation;
  readonly budgets: DirectLaunchBudgetExpectation;
  readonly quota: {
    readonly availableContextTokens: number;
    readonly availableOutputTokens: number;
    readonly availableElapsedSeconds: number;
    readonly availableAttempts: number;
    readonly verified: boolean;
  };
  readonly context: {
    readonly supportedModels: readonly string[];
    readonly supportedReasoningEfforts: readonly string[];
    readonly verified: boolean;
  };
}

/**
 * PHASE7-102 deterministic capability evidence. It describes only LOCAL,
 * genuinely enforceable process facts the host actually observed — that the
 * named executables resolve, that the workspace root exists and contains
 * every command cwd, and the elapsed/output/attempt limits the host can
 * really impose — each with its own `verified` flag recording what was
 * checked rather than assumed. It deliberately has NO model/token/provider
 * quota or context block: a deterministic command sequence has no provider
 * capacity, and the approved limits must never be restated as invented
 * provider quota. The limits here are the host's own enforceable ceiling,
 * supplied independently of the approval; a later unit (supplier Unit2) is
 * what populates these facts and the loop/verifier Unit3 is what enforces
 * them at spawn time.
 */
export interface DirectLaunchDeterministicCapabilityEvidence
  extends DirectLaunchCapabilityEvidenceCommon {
  readonly executionKind: typeof DETERMINISTIC_EXECUTION_KIND;
  readonly commands: DirectLaunchCommandExpectation;
  readonly workspace: string;
  readonly budgets: DirectLaunchDeterministicBudgetExpectation;
  readonly executionPolicy: DirectLaunchExecutionPolicyExpectation;
  readonly process: {
    /** Workspace root the host actually resolved and will confine every command cwd to. */
    readonly resolvedWorkspace: string;
    /** Executables the host actually resolved, in the same order as `commands`. */
    readonly resolvedExecutables: readonly string[];
    /** Limits the host can genuinely impose on the spawned processes. */
    readonly enforceableElapsedSeconds: number;
    readonly enforceableOutputBytes: number;
    readonly enforceableAttempts: number;
    readonly verified: boolean;
  };
}

/**
 * Unchanged AI-only alias: accepted consumers (the A95 capability validator,
 * its fixtures and tests) read `evidence.model`/`quota`/`context` directly and
 * keep doing so. `DirectLaunchExecutionCapabilityEvidence` is the explicit
 * union that deterministic-capable code names instead.
 */
export type DirectLaunchCapabilityEvidence = DirectLaunchAiCapabilityEvidence;

export type DirectLaunchExecutionCapabilityEvidence =
  | DirectLaunchAiCapabilityEvidence
  | DirectLaunchDeterministicCapabilityEvidence;

interface DirectHostLaunchGrantCommon {
  readonly ticketDigest: string;
  /** The full seven-field branded binding tuple; never loosened per kind. */
  readonly binding: DirectLaunchBinding;
}

/**
 * Immutable, deep-copied result of a trusted host resolve/reserve call.
 *
 * `DirectHostLaunchGrant` stays the unchanged AI grant, so an existing
 * producer may still return `{ ticket, ticketDigest, binding, evidence }`
 * without an `executionKind` and an existing consumer still reads
 * `grant.ticket.model`. `DirectHostExecutionLaunchGrant` is the explicit
 * discriminated union, so a deterministic-capable consumer can never read a
 * deterministic ticket as a WorkerTicket (or its local process facts as
 * provider quota) without narrowing first.
 */
export type DirectHostLaunchGrant = DirectHostLaunchGrantCommon & {
  readonly executionKind?: "ai";
  readonly ticket: WorkerTicket;
  readonly evidence: DirectLaunchAiCapabilityEvidence;
};

export type DirectHostDeterministicLaunchGrant = DirectHostLaunchGrantCommon & {
  readonly executionKind: typeof DETERMINISTIC_EXECUTION_KIND;
  readonly ticket: DeterministicExecutionTicket;
  readonly evidence: DirectLaunchDeterministicCapabilityEvidence;
};

export type DirectHostExecutionLaunchGrant =
  | DirectHostLaunchGrant
  | DirectHostDeterministicLaunchGrant;

/**
 * Narrowing form of `directLaunchGrantKind` for the deterministic member: it
 * decides on the grant's OWN cross-checked discriminant and evidence, so a
 * consumer gets a genuinely narrowed `DirectHostDeterministicLaunchGrant`
 * (deterministic ticket, deterministic evidence) instead of asserting one.
 */
export function isDirectHostDeterministicLaunchGrant(
  grant: DirectHostExecutionLaunchGrant,
): grant is DirectHostDeterministicLaunchGrant {
  return directLaunchGrantKind(grant) === DETERMINISTIC_EXECUTION_KIND;
}

/**
 * Narrowing form for the AI member. A grant whose kind is unknown or mixed
 * satisfies NEITHER predicate, so an unknown shape can never fall through
 * into a branch by default.
 */
export function isDirectHostAiLaunchGrant(
  grant: DirectHostExecutionLaunchGrant,
): grant is DirectHostLaunchGrant {
  return directLaunchGrantKind(grant) === "ai";
}

/** `undefined` for any unknown or mixed execution-kind grant shape. */
export function directLaunchGrantKind(
  grant: DirectHostExecutionLaunchGrant,
): "ai" | typeof DETERMINISTIC_EXECUTION_KIND | undefined {
  const declared = (grant as { readonly executionKind?: unknown }).executionKind;
  if (declared !== DETERMINISTIC_EXECUTION_KIND && declared !== undefined && declared !== "ai") {
    return undefined;
  }
  // A grant's ticket/evidence carry the kind-specific fields; the grant
  // itself has none, so its declared kind is cross-checked against the
  // evidence it actually carries rather than taken on trust.
  const evidence = (grant as { readonly evidence?: unknown }).evidence;
  if (evidence === null || typeof evidence !== "object") {
    return undefined;
  }
  const evidenceKind = directLaunchEvidenceKind(
    evidence as DirectLaunchExecutionCapabilityEvidence,
  );
  const grantKind = declared === DETERMINISTIC_EXECUTION_KIND ? DETERMINISTIC_EXECUTION_KIND : "ai";
  return evidenceKind === grantKind ? grantKind : undefined;
}

/**
 * Trusted-host authority contract. No default implementation exists; a
 * concrete trusted host adapter is a later increment.
 *
 * - resolveAndReserve: resolves the full ticket strictly via the trusted
 *   host's own reference lookup (never from request-supplied ticket
 *   content), atomically reserves canonical reservation paths, and returns
 *   an immutable, deep-copied grant.
 * - revalidate: re-checks the full current context and evidence against an
 *   existing grant without consuming it; callers invoke this immediately
 *   before process spawn (Phase 2).
 * - cancel: releases only a reservation this authority itself created,
 *   identified by its own DirectLaunchBinding; never affects reservations
 *   owned by another authority.
 *
 * Final atomic consumption of the launch happens exactly once via the
 * existing DirectLaunchAuthorityPort surface using the grant's
 * DirectLaunchBinding; this interface adds resolution/reservation lifecycle
 * on top without duplicating that consume path.
 */
export interface DirectHostAuthorityPort<
  TRequest extends DirectHostExecutionLaunchRequest = DirectHostLaunchRequest,
  TGrant extends DirectHostExecutionLaunchGrant = DirectHostLaunchGrant,
> extends DirectLaunchAuthorityPort {
  resolveAndReserve(request: TRequest): Promise<TGrant>;
  revalidate(grant: TGrant, request: TRequest): Promise<void>;
  cancel(binding: DirectLaunchBinding): Promise<void>;
  /** Optional, strictly read-only: proves a genuine CONSUMED launch is still live. */
  checkConsumedContinuation?(receipt: DirectLaunchReceipt, request: TRequest): Promise<boolean>;
}

/**
 * The deterministic-capable authority surface: an EXPLICIT instantiation over
 * the execution unions, not a cast of the AI-only facade. A host that only
 * implements the AI shapes genuinely does NOT satisfy this type — its
 * `revalidate` cannot accept a deterministic grant — so a channel built for
 * deterministic execution must be given an authority that really implements
 * it, and a missing deterministic implementation refuses at the boundary
 * rather than being asserted away. Planned supplier Unit2 adopts this
 * signature.
 */
export type DirectHostExecutionAuthorityPort = DirectHostAuthorityPort<
  DirectHostExecutionLaunchRequest,
  DirectHostExecutionLaunchGrant
>;

// ---------------------------------------------------------------------------
// D1 handle-channel increment: a single provenance primitive binding one
// trusted-host authority + one trusted readCurrentRequest callback into a
// channel that issues, checks, and consumes opaque admission handles.
//
// Primitive-only. A trusted host process must construct exactly one channel
// and inject it wherever workers are admitted; it must never expose the
// authority or readCurrentRequest callback to caller code directly. If an
// arbitrary caller constructs its OWN channel with its own fake authority,
// that second channel's handles carry no trust whatsoever with respect to
// THIS channel: handle validity is private per-channel WeakMap identity,
// not a structural brand, so no cross-channel handle, clone, plain object,
// Proxy wrapping a real handle, or null can ever be recognized here.
// No Factory/CLI wiring, production store, or capability supplier is
// defined or authorized by this primitive.
// ---------------------------------------------------------------------------

const handleBrand: unique symbol = Symbol("DirectHostAdmissionHandle");

/** Opaque; compile-time only. Runtime trust is private per-channel WeakMap identity, never this brand. */
export interface DirectHostAdmissionHandle {
  readonly [handleBrand]: true;
}

/**
 * `issue` is parameterized with the SAME AI default as the authority port, so
 * every existing holder of a `DirectHostAdmissionSurface` still passes an AI
 * request and infers exactly as before. A deterministic-capable host names
 * `DirectHostExecutionAdmissionSurface`, whose channel was built from an
 * authority that really implements the execution union.
 */
export interface DirectHostAdmissionSurface<
  TRequest extends DirectHostExecutionLaunchRequest = DirectHostLaunchRequest,
> {
  issue(request: TRequest): Promise<DirectHostAdmissionHandle>;
  checkReadiness(handle: unknown): Promise<boolean>;
  consume(handle: unknown): Promise<DirectLaunchReceipt>;
  cancel(handle: unknown): Promise<void>;
  /** Optional, read-only: true only for a genuine receipt returned by this surface's consume. */
  checkConsumedContinuation?(receipt: unknown): Promise<boolean>;
}

export type DirectHostExecutionAdmissionSurface =
  DirectHostAdmissionSurface<DirectHostExecutionLaunchRequest>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A real, finite, positive NUMBER — never a numeric-looking string that `>=` would coerce. */
function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
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

function cloneFrozen<T>(value: T): T {
  return deepFreeze(JSON.parse(JSON.stringify(value))) as T;
}

interface DirectHostPrivateState<
  TRequest extends DirectHostExecutionLaunchRequest = DirectHostExecutionLaunchRequest,
  TGrant extends DirectHostExecutionLaunchGrant = DirectHostExecutionLaunchGrant,
> {
  readonly request: TRequest;
  readonly binding: DirectLaunchBinding;
  readonly grant: TGrant;
}

const SEVEN_BINDING_STRING_FIELDS = [
  "ticketDigest",
  "registryPrincipalId",
  "workItemId",
  "reservationId",
] as const;
const SEVEN_BINDING_INT_FIELDS = ["specRevision", "reservationVersion"] as const;

function checkSevenFieldsConsistent(
  binding: DirectLaunchBinding,
  evidence: DirectLaunchExecutionCapabilityEvidence,
): void {
  for (const key of SEVEN_BINDING_STRING_FIELDS) {
    const value = (binding as unknown as Record<string, unknown>)[key];
    const other = (evidence as unknown as Record<string, unknown>)[key];
    if (!isNonEmptyString(value) || value !== other) {
      fail(`binding/evidence field ${key} is missing, empty, or inconsistent`);
    }
  }
  if (!isNonEmptyString(binding.runId) || binding.runId !== evidence.runId) {
    fail("binding/evidence field runId is missing, empty, or inconsistent");
  }
  for (const key of SEVEN_BINDING_INT_FIELDS) {
    const value = (binding as unknown as Record<string, unknown>)[key];
    const other = (evidence as unknown as Record<string, unknown>)[key];
    if (!isPositiveSafeInteger(value) || value !== other) {
      fail(`binding/evidence field ${key} is missing, non-positive, or inconsistent`);
    }
  }
}

function checkGrantAgainstRequest(
  grant: DirectHostExecutionLaunchGrant,
  request: DirectHostExecutionLaunchRequest,
): void {
  const { ticket, binding, evidence } = grant;
  if (binding.ticketDigest !== grant.ticketDigest || evidence.ticketDigest !== grant.ticketDigest) {
    fail("grant ticketDigest is inconsistent across ticket/binding/evidence");
  }
  checkSevenFieldsConsistent(binding, evidence);
  if (
    binding.registryPrincipalId !== request.registryPrincipalId ||
    binding.workItemId !== request.workItemId ||
    binding.specRevision !== request.specRevision ||
    binding.runId !== request.runId
  ) {
    fail("grant binding does not match the issuing request");
  }
  // Request, grant and evidence must all declare the SAME execution kind.
  // An unknown or mixed kind on any of the three refuses closed; the kind is
  // never defaulted to make a missing expectation pass.
  const requestKind = directLaunchRequestKind(request);
  const grantKind = directLaunchGrantKind(grant);
  const evidenceKind = directLaunchEvidenceKind(evidence);
  if (requestKind === undefined || grantKind === undefined || evidenceKind === undefined) {
    fail("request/grant/evidence carries an unknown or mixed executionKind");
  }
  if (requestKind !== grantKind || grantKind !== evidenceKind) {
    fail("grant/evidence executionKind does not match the issuing request's executionKind");
  }
  if (!deepEqual(ticket.scope, request.scope) || !deepEqual(evidence.scope, request.scope)) {
    fail("grant ticket/evidence scope does not match the issuing request");
  }

  if (grantKind === DETERMINISTIC_EXECUTION_KIND) {
    const detTicket = ticket as DeterministicExecutionTicket;
    const detEvidence = evidence as DirectLaunchDeterministicCapabilityEvidence;
    const detRequest = request as DirectHostDeterministicLaunchRequest;
    // Order is significant throughout: deepEqual compares arrays index by
    // index, so a reordered command sequence is a mismatch.
    if (
      !deepEqual(detTicket.commands, detRequest.commands) ||
      !deepEqual(detEvidence.commands, detRequest.commands)
    ) {
      fail("grant ticket/evidence commands do not match the issuing request's ordered commands");
    }
    if (
      detTicket.workspace !== detRequest.workspace ||
      detEvidence.workspace !== detRequest.workspace
    ) {
      fail("grant ticket/evidence workspace does not match the issuing request's workspace root");
    }
    if (
      !deepEqual(detTicket.budgets, detRequest.budgets) ||
      !deepEqual(detEvidence.budgets, detRequest.budgets)
    ) {
      fail("grant ticket/evidence budgets do not match the issuing request's process budgets");
    }
    if (
      !deepEqual(detTicket.executionPolicy, detRequest.executionPolicy) ||
      !deepEqual(detEvidence.executionPolicy, detRequest.executionPolicy)
    ) {
      fail("grant ticket/evidence executionPolicy does not match the issuing request's executionPolicy");
    }
    // The host's own locally observed facts must actually cover the approved
    // commands/workspace/limits. These are independent observations, not a
    // restatement of the approved limits: a host that merely echoes them
    // without having verified anything is refused here.
    const observed = detEvidence.process;
    if (observed === null || typeof observed !== "object" || observed.verified !== true) {
      fail("deterministic grant evidence carries no verified local process facts");
    }
    if (observed.resolvedWorkspace !== detTicket.workspace) {
      fail("deterministic grant evidence resolved a different workspace root than the approved one");
    }
    if (
      !Array.isArray(observed.resolvedExecutables) ||
      observed.resolvedExecutables.length !== detTicket.commands.length ||
      observed.resolvedExecutables.some(
        (executable, index) =>
          !isNonEmptyString(executable) || executable !== detTicket.commands[index]?.executable,
      )
    ) {
      fail("deterministic grant evidence did not resolve every approved command executable in order");
    }
    // `>=` coerces, so a string capacity such as "999" would otherwise satisfy
    // a numeric limit. Each enforceable capacity must be a real number of the
    // right shape BEFORE any comparison: elapsed is a finite positive number,
    // output bytes and attempts are positive safe integers. No provider quota
    // or approved limit may stand in for a missing observation.
    if (
      !isPositiveFiniteNumber(observed.enforceableElapsedSeconds) ||
      !isPositiveSafeInteger(observed.enforceableOutputBytes) ||
      !isPositiveSafeInteger(observed.enforceableAttempts)
    ) {
      fail("deterministic grant evidence carries non-numeric or non-positive enforceable process capacities");
    }
    if (
      !(observed.enforceableElapsedSeconds >= detTicket.budgets.elapsedSeconds) ||
      !(observed.enforceableOutputBytes >= detTicket.budgets.outputBytes) ||
      !(observed.enforceableAttempts >= detTicket.budgets.maxAttempts)
    ) {
      fail("deterministic grant evidence cannot locally enforce the approved process limits");
    }
    // A deterministic grant must carry no AI model/token/provider quota at
    // all — inventing one from the approved limits is exactly the masquerade
    // this phase refuses.
    for (const forbidden of ["model", "quota", "context"] as const) {
      if (forbidden in (detEvidence as unknown as Record<string, unknown>)) {
        fail(`deterministic grant evidence carries an AI-only field (${forbidden})`);
      }
    }
    return;
  }

  const aiTicket = ticket as WorkerTicket;
  const aiEvidence = evidence as DirectLaunchAiCapabilityEvidence;
  const aiRequest = request as DirectHostAiLaunchRequest;
  if (
    aiRequest.model === undefined ||
    !deepEqual(aiTicket.model, aiRequest.model) ||
    !deepEqual(aiEvidence.model, aiRequest.model)
  ) {
    fail("grant ticket/evidence model does not match the issuing request");
  }
  if (!deepEqual(aiEvidence.budgets, aiTicket.budgets)) {
    fail("grant evidence budgets do not match the strict ticket budgets");
  }
}

/** `undefined` for any unknown or mixed execution-kind evidence shape. */
export function directLaunchEvidenceKind(
  evidence: DirectLaunchExecutionCapabilityEvidence,
): "ai" | typeof DETERMINISTIC_EXECUTION_KIND | undefined {
  return resolveLaunchExecutionKind(
    evidence,
    ["model", "quota", "context"],
    DETERMINISTIC_ONLY_EVIDENCE_FIELDS,
  );
}

function checkReceiptMatchesBinding(
  receipt: DirectLaunchReceipt,
  binding: DirectLaunchBinding,
): void {
  const fields: ReadonlyArray<keyof DirectLaunchBinding> = [
    "ticketDigest",
    "registryPrincipalId",
    "workItemId",
    "specRevision",
    "runId",
    "reservationId",
    "reservationVersion",
  ];
  for (const field of fields) {
    if (receipt.binding[field] !== binding[field]) {
      fail(`receipt binding field ${String(field)} does not match the consumed binding`);
    }
  }
  if (!isNonEmptyString(receipt.consumedAt) || Number.isNaN(Date.parse(receipt.consumedAt))) {
    fail("receipt consumedAt is not a valid timestamp");
  }
}

/**
 * Creates exactly one direct-host admission channel binding one trusted
 * authority and one trusted readCurrentRequest callback. A trusted host
 * process must construct and inject this specific channel; an arbitrary
 * caller constructing a different channel with its own authority grants no
 * trust whatsoever toward this channel's handles.
 */
import type { DirectLaunchReceipt } from "../ports/worker.js";

/**
 * Old-AI channel callers keep EXACTLY their previous inference: the first
 * overload is the unchanged AI signature, so an existing authority and an
 * existing `readCurrentRequest` callback still see `DirectHostLaunchRequest`
 * (with `request.model` resolving) in their parameters and still receive a
 * `DirectHostAdmissionSurface`. The second overload is the EXPLICIT
 * deterministic-capable instantiation: a caller naming it must supply an
 * authority that genuinely implements the execution-union port and a callback
 * that genuinely accepts/returns the execution union — it is not the AI
 * surface reinterpreted. The implementation signature is union-typed and is
 * never reachable as a widened public contract.
 */
export function createDirectHostAdmissionChannel(
  authority: DirectHostAuthorityPort,
  readCurrentRequest: (
    binding: DirectLaunchBinding,
    issuedRequest: DirectHostLaunchRequest,
  ) => Promise<DirectHostLaunchRequest>,
): DirectHostAdmissionSurface;
export function createDirectHostAdmissionChannel(
  authority: DirectHostExecutionAuthorityPort,
  readCurrentRequest: (
    binding: DirectLaunchBinding,
    issuedRequest: DirectHostExecutionLaunchRequest,
  ) => Promise<DirectHostExecutionLaunchRequest>,
): DirectHostExecutionAdmissionSurface;
export function createDirectHostAdmissionChannel<
  TRequest extends DirectHostExecutionLaunchRequest,
  TGrant extends DirectHostExecutionLaunchGrant,
>(
  authority: DirectHostAuthorityPort<TRequest, TGrant>,
  readCurrentRequest: (
    binding: DirectLaunchBinding,
    issuedRequest: TRequest,
  ) => Promise<TRequest>,
): DirectHostAdmissionSurface<TRequest> {
  if (
    authority === null ||
    typeof authority !== "object" ||
    typeof authority.resolveAndReserve !== "function" ||
    typeof authority.revalidate !== "function" ||
    typeof authority.checkReadiness !== "function" ||
    typeof authority.atomicConsumeLaunch !== "function" ||
    typeof authority.cancel !== "function"
  ) {
    fail("authority does not implement the required DirectHostAuthorityPort methods");
  }
  if (typeof readCurrentRequest !== "function") {
    fail("readCurrentRequest callback is required");
  }

  // The overloads above already proved the authority really implements the
  // kind it was handed, so the two request/grant-typed methods stay bound at
  // the authority's OWN <TRequest, TGrant> instantiation: the private state
  // below carries exactly those types, so no authority-kind assertion and no
  // widening to the execution union is needed at the callsites.
  const resolveAndReserve = authority.resolveAndReserve.bind(authority);
  const revalidate = authority.revalidate.bind(authority);
  const checkReadinessOnAuthority = authority.checkReadiness.bind(authority);
  const atomicConsumeLaunch = authority.atomicConsumeLaunch.bind(authority);
  const cancelOnAuthority = authority.cancel.bind(authority);
  const checkConsumedContinuationOnAuthority =
    typeof authority.checkConsumedContinuation === "function"
      ? authority.checkConsumedContinuation.bind(authority)
      : undefined;
  const captureCurrentRequest = readCurrentRequest;

  const registry = new WeakMap<
    DirectHostAdmissionHandle,
    DirectHostPrivateState<TRequest, TGrant>
  >();
  // Keyed by the genuine frozen receipt object returned from consume().
  const receiptRegistry = new WeakMap<
    DirectLaunchReceipt,
    DirectHostPrivateState<TRequest, TGrant>
  >();

  function lookup(handle: unknown): DirectHostPrivateState<TRequest, TGrant> {
    if (handle === null || typeof handle !== "object") {
      fail("admission handle is not recognized by this channel");
    }
    const state = registry.get(handle as DirectHostAdmissionHandle);
    if (state === undefined) {
      fail("admission handle is unknown, foreign, or already retired");
    }
    return state;
  }

  async function refreshAndRevalidate(
    state: DirectHostPrivateState<TRequest, TGrant>,
  ): Promise<void> {
    const currentRequest = await captureCurrentRequest(state.binding, state.request);
    if (!deepEqual(currentRequest, state.request)) {
      fail("current request drifted from the request this handle was issued against");
    }
    await revalidate(state.grant, currentRequest);
  }

  const surface: DirectHostAdmissionSurface<TRequest> = {
    async issue(request: TRequest): Promise<DirectHostAdmissionHandle> {
      const snapshot = cloneFrozen(request);
      if (directLaunchRequestKind(snapshot) === undefined) {
        fail("issuing request carries an unknown or mixed executionKind");
      }
      const grant = await resolveAndReserve(snapshot);
      // The grant's own declared kind selects the strict accepted parser and
      // digest; a deterministic ticket is NEVER routed through the AI parser
      // and an unknown kind refuses before anything is registered.
      // The grant's own validated discriminant narrows it — not a cast — and
      // each branch rebuilds its OWN grant member with its own strict-parsed
      // ticket. A deterministic grant is never retyped as the AI grant, and an
      // unknown/mixed kind satisfies neither predicate and refuses here.
      // Each branch rebuilds the grant at its OWN narrowed type, so the
      // strict-parsed ticket replaces the same-kind ticket field and the
      // result stays the authority's TGrant rather than a widened union.
      let privateGrant: TGrant;
      if (isDirectHostDeterministicLaunchGrant(grant)) {
        privateGrant = cloneFrozen({
          ...grant,
          ticket: validateStrictFrozenDeterministicTicket(grant.ticket, grant.ticketDigest).ticket,
        });
      } else if (isDirectHostAiLaunchGrant(grant)) {
        privateGrant = cloneFrozen({
          ...grant,
          ticket: validateStrictFrozenTicket(grant.ticket, grant.ticketDigest).ticket,
        });
      } else {
        fail("grant carries an unknown or mixed executionKind");
      }
      checkGrantAgainstRequest(privateGrant, snapshot);
      const privateBinding = cloneFrozen(privateGrant.binding);

      const handle = Object.freeze({}) as unknown as DirectHostAdmissionHandle;
      registry.set(handle, {
        request: snapshot,
        binding: privateBinding,
        grant: privateGrant,
      });
      return handle;
    },

    async checkReadiness(handle: unknown): Promise<boolean> {
      const state = lookup(handle);
      await refreshAndRevalidate(state);
      const ready = await checkReadinessOnAuthority(state.binding);
      if (handle === null || typeof handle !== "object" || !registry.has(handle as DirectHostAdmissionHandle)) {
        fail("admission handle was retired concurrently; readiness cannot be reported");
      }
      return ready;
    },

    async consume(handle: unknown): Promise<DirectLaunchReceipt> {
      if (handle === null || typeof handle !== "object") {
        fail("admission handle is not recognized by this channel");
      }
      const typedHandle = handle as DirectHostAdmissionHandle;
      const state = registry.get(typedHandle);
      if (state === undefined) {
        fail("admission handle is unknown, foreign, or already retired");
      }
      registry.delete(typedHandle);

      await refreshAndRevalidate(state);
      const ready = await checkReadinessOnAuthority(state.binding);
      if (!ready) {
        fail("authority reports the admission binding is not ready to consume");
      }
      const receipt = await atomicConsumeLaunch(state.binding);
      checkReceiptMatchesBinding(receipt, state.binding);
      const frozenReceipt = cloneFrozen(receipt);
      receiptRegistry.set(frozenReceipt, state);
      return frozenReceipt;
    },
    ...(checkConsumedContinuationOnAuthority === undefined
      ? {}
      : {
          async checkConsumedContinuation(receipt: unknown): Promise<boolean> {
            if (typeof receipt !== "object" || receipt === null) {
              return false;
            }
            const genuine = receipt as DirectLaunchReceipt;
            const state = receiptRegistry.get(genuine);
            if (state === undefined || checkConsumedContinuationOnAuthority === undefined) {
              return false;
            }
            try {
              const currentRequest = await captureCurrentRequest(state.binding, state.request);
              if (!deepEqual(currentRequest, state.request)) {
                return false;
              }
              checkReceiptMatchesBinding(genuine, state.binding);
              return (await checkConsumedContinuationOnAuthority(genuine, currentRequest)) === true;
            } catch {
              return false;
            }
          },
        }),

    async cancel(handle: unknown): Promise<void> {
      if (handle === null || typeof handle !== "object") {
        fail("admission handle is not recognized by this channel");
      }
      const typedHandle = handle as DirectHostAdmissionHandle;
      const state = registry.get(typedHandle);
      if (state === undefined) {
        fail("admission handle is unknown, foreign, or already retired");
      }
      registry.delete(typedHandle);
      await cancelOnAuthority(state.binding);
    },
  };

  // One frozen channel object serves both overloads: the AI overload's
  // declared return type simply exposes the AI-request `issue` signature of
  // this same union-capable implementation.
  return Object.freeze(surface);
}
