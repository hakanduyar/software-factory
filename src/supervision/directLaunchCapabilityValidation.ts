/**
 * D1 dependency increment: provider-neutral, executable validator of the
 * EXISTING DirectLaunchCapabilityEvidence contract
 * (src/supervision/directWorkerAdmission.ts). Validation-only: this module
 * never reserves, approves, consumes, launches, or probes a provider; it
 * accepts no request-derived approval and supplies no default production
 * capability. Unknown or unverified facts are denied, not assumed.
 *
 * The caller independently supplies the strict frozen WorkerTicket, the
 * DirectLaunchBinding this evidence must match, a trusted clock instant, and
 * a finite maximum evidence age. This function derives no trust from the
 * candidate evidence's own content; it only checks that content against
 * those independently supplied, caller-trusted values.
 *
 * The trusted production supplier that actually resolves/reserves real
 * DirectLaunchCapabilityEvidence remains a later required dependency; this
 * validator has no opinion on, and performs no call toward, any such
 * supplier.
 */

import type { WorkerTicket } from "./workerContract.js";
import { computeTicketDigest, parseWorkerTicket } from "./workerContract.js";
import { DirectAdmissionRefusedError } from "./directWorkerAdmission.js";
import type {
  DirectLaunchCapabilityEvidence,
} from "./directWorkerAdmission.js";
import type { DirectLaunchBinding } from "../ports/worker.js";

function fail(reason: string): never {
  throw new DirectAdmissionRefusedError(reason);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string" || value.length === 0) {
    fail(`evidence ${label} is not a non-empty string timestamp`);
  }
  const parsed = Date.parse(value as string);
  if (Number.isNaN(parsed)) {
    fail(`evidence ${label} is not a parseable timestamp`);
  }
  return parsed;
}

function deepEqualReadonlyStringArray(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

function coversAll(required: readonly string[], available: readonly string[]): boolean {
  const availableSet = new Set(available);
  return required.every((item) => availableSet.has(item));
}

/** Immutable, validation-only snapshot. Never a launch handle or approval. */
export interface ValidatedDirectLaunchCapability {
  readonly evidence: DirectLaunchCapabilityEvidence;
  readonly validatedAgainstBinding: DirectLaunchBinding;
  readonly validatedAt: number;
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

function checkIdentity(
  evidence: DirectLaunchCapabilityEvidence,
  ticketDigest: string,
  binding: DirectLaunchBinding,
): void {
  if (!isNonEmptyString(evidence.ticketDigest) || evidence.ticketDigest !== ticketDigest) {
    fail("evidence ticketDigest does not match the strict frozen ticket digest");
  }
  if (evidence.ticketDigest !== binding.ticketDigest) {
    fail("evidence ticketDigest does not match the trusted binding ticketDigest");
  }
  if (
    !isNonEmptyString(evidence.registryPrincipalId) ||
    evidence.registryPrincipalId !== binding.registryPrincipalId
  ) {
    fail("evidence registryPrincipalId does not match the trusted binding");
  }
  if (!isNonEmptyString(evidence.workItemId) || evidence.workItemId !== binding.workItemId) {
    fail("evidence workItemId does not match the trusted binding");
  }
  if (evidence.specRevision !== binding.specRevision) {
    fail("evidence specRevision does not match the trusted binding");
  }
  if (!isNonEmptyString(evidence.runId) || evidence.runId !== binding.runId) {
    fail("evidence runId does not match the trusted binding");
  }
  if (!isNonEmptyString(evidence.reservationId) || evidence.reservationId !== binding.reservationId) {
    fail("evidence reservationId does not match the trusted binding");
  }
  if (evidence.reservationVersion !== binding.reservationVersion) {
    fail("evidence reservationVersion does not match the trusted binding");
  }
  if (!Number.isSafeInteger(evidence.specRevision) || evidence.specRevision < 1) {
    fail("evidence specRevision is malformed");
  }
  if (!Number.isSafeInteger(evidence.reservationVersion) || evidence.reservationVersion < 1) {
    fail("evidence reservationVersion is malformed");
  }
}

function checkTicketDigestBinding(ticket: WorkerTicket, ticketDigest: string): WorkerTicket {
  const parsed = parseWorkerTicket(ticket);
  if (!parsed.ok) {
    fail("expected ticket does not satisfy the strict frozen WorkerTicket schema");
  }
  if (computeTicketDigest(parsed.value) !== ticketDigest) {
    fail("supplied ticketDigest does not match the computed digest of the supplied ticket");
  }
  return parsed.value;
}

function checkScopeModelBudgets(
  evidence: DirectLaunchCapabilityEvidence,
  ticket: WorkerTicket,
): void {
  if (
    !isStringArray(evidence.scope?.owned) ||
    !isStringArray(evidence.scope?.forbidden) ||
    !isStringArray(evidence.scope?.read) ||
    !isStringArray(evidence.scope?.dependencies) ||
    !isStringArray(evidence.scope?.validation)
  ) {
    fail("evidence scope is malformed");
  }
  if (
    !deepEqualReadonlyStringArray(evidence.scope.owned, ticket.scope.owned) ||
    !deepEqualReadonlyStringArray(evidence.scope.forbidden, ticket.scope.forbidden) ||
    !deepEqualReadonlyStringArray(evidence.scope.read, ticket.scope.read) ||
    !deepEqualReadonlyStringArray(evidence.scope.dependencies, ticket.scope.dependencies) ||
    !deepEqualReadonlyStringArray(evidence.scope.validation, ticket.scope.validation)
  ) {
    fail("evidence scope does not exactly match the strict frozen ticket scope");
  }

  if (
    !isStringArray(evidence.model?.eligibleModels) ||
    typeof evidence.model?.reasoningEffort !== "string" ||
    !isNonEmptyString(evidence.model?.rationale)
  ) {
    fail("evidence model is malformed");
  }
  if (
    !deepEqualReadonlyStringArray(evidence.model.eligibleModels, ticket.model.eligibleModels) ||
    evidence.model.reasoningEffort !== ticket.model.reasoningEffort ||
    evidence.model.rationale !== ticket.model.rationale
  ) {
    fail("evidence model does not exactly match the strict frozen ticket model");
  }

  if (
    !isFiniteSafeNonNegativeInteger(evidence.budgets?.contextTokens) ||
    !isFiniteSafeNonNegativeInteger(evidence.budgets?.outputTokens) ||
    typeof evidence.budgets?.elapsedSeconds !== "number" ||
    !Number.isFinite(evidence.budgets.elapsedSeconds) ||
    !isFiniteSafeNonNegativeInteger(evidence.budgets?.maxAttempts)
  ) {
    fail("evidence budgets is malformed");
  }
  if (
    evidence.budgets.contextTokens !== ticket.budgets.contextTokens ||
    evidence.budgets.outputTokens !== ticket.budgets.outputTokens ||
    evidence.budgets.elapsedSeconds !== ticket.budgets.elapsedSeconds ||
    evidence.budgets.maxAttempts !== ticket.budgets.maxAttempts
  ) {
    fail("evidence budgets does not exactly match the strict frozen ticket budgets");
  }
}

function checkEvidenceReference(evidence: DirectLaunchCapabilityEvidence): void {
  if (!isNonEmptyString(evidence.evidenceReference)) {
    fail("evidence evidenceReference is missing or empty");
  }
  if (!isNonEmptyString(evidence.evidenceDigest)) {
    fail("evidence evidenceDigest is missing or empty");
  }
}

function checkFreshness(
  evidence: DirectLaunchCapabilityEvidence,
  trustedNowMillis: number,
  maxEvidenceAgeSeconds: number,
): void {
  if (!Number.isFinite(maxEvidenceAgeSeconds) || maxEvidenceAgeSeconds <= 0) {
    fail("maximum evidence age must be a finite positive number of seconds");
  }
  if (!Number.isFinite(trustedNowMillis)) {
    fail("trusted clock instant must be finite");
  }

  const observedAtMillis = parseTimestamp(evidence.observedAt, "observedAt");
  const expiresAtMillis = parseTimestamp(evidence.expiresAt, "expiresAt");

  if (observedAtMillis > trustedNowMillis) {
    fail("evidence observedAt is in the future relative to the trusted clock");
  }
  if (expiresAtMillis <= observedAtMillis) {
    fail("evidence expiresAt is not after observedAt");
  }
  if (trustedNowMillis >= expiresAtMillis) {
    fail("evidence has expired relative to the trusted clock");
  }

  const ageSeconds = (trustedNowMillis - observedAtMillis) / 1000;
  if (ageSeconds > maxEvidenceAgeSeconds) {
    fail("evidence is older than the maximum allowed evidence age");
  }
}

function checkQuota(evidence: DirectLaunchCapabilityEvidence, ticket: WorkerTicket): void {
  const quota = evidence.quota;
  if (
    !isFiniteSafeNonNegativeInteger(quota?.availableContextTokens) ||
    !isFiniteSafeNonNegativeInteger(quota?.availableOutputTokens) ||
    !isFiniteSafeNonNegativeInteger(quota?.availableElapsedSeconds) ||
    !isFiniteSafeNonNegativeInteger(quota?.availableAttempts)
  ) {
    fail("evidence quota availability fields are missing, non-finite, or not safe integers");
  }
  if (quota.verified !== true) {
    fail("evidence quota.verified is not exactly true");
  }
  if (quota.availableContextTokens < ticket.budgets.contextTokens) {
    fail("evidence quota.availableContextTokens is insufficient for the frozen ticket budget");
  }
  if (quota.availableOutputTokens < ticket.budgets.outputTokens) {
    fail("evidence quota.availableOutputTokens is insufficient for the frozen ticket budget");
  }
  if (quota.availableElapsedSeconds < ticket.budgets.elapsedSeconds) {
    fail("evidence quota.availableElapsedSeconds is insufficient for the frozen ticket budget");
  }
  if (quota.availableAttempts < ticket.budgets.maxAttempts) {
    fail("evidence quota.availableAttempts is insufficient for the frozen ticket budget");
  }
}

function checkContext(evidence: DirectLaunchCapabilityEvidence, ticket: WorkerTicket): void {
  const context = evidence.context;
  if (
    !isStringArray(context?.supportedModels) ||
    !isStringArray(context?.supportedReasoningEfforts)
  ) {
    fail("evidence context supported-model/effort lists are malformed");
  }
  if (context.verified !== true) {
    fail("evidence context.verified is not exactly true");
  }
  if (!coversAll(ticket.model.eligibleModels, context.supportedModels)) {
    fail("evidence context.supportedModels does not cover every eligible ticket model");
  }
  if (!context.supportedReasoningEfforts.includes(ticket.model.reasoningEffort)) {
    fail("evidence context.supportedReasoningEfforts does not cover the ticket reasoning effort");
  }
}

function checkConfinement(evidence: DirectLaunchCapabilityEvidence, ticket: WorkerTicket): void {
  const confinement = evidence.confinement;
  if (
    !isStringArray(confinement?.supportedScopeOwned) ||
    !isStringArray(confinement?.supportedScopeForbidden)
  ) {
    fail("evidence confinement supported-scope lists are malformed");
  }
  if (confinement.verified !== true) {
    fail("evidence confinement.verified is not exactly true");
  }
  if (!coversAll(ticket.scope.owned, confinement.supportedScopeOwned)) {
    fail("evidence confinement.supportedScopeOwned does not cover every owned ticket path");
  }
  if (!coversAll(ticket.scope.forbidden, confinement.supportedScopeForbidden)) {
    fail("evidence confinement.supportedScopeForbidden does not cover every forbidden ticket path");
  }
}

/**
 * Validates an untrusted candidate DirectLaunchCapabilityEvidence against
 * independently supplied, caller-trusted context: the exact strict frozen
 * WorkerTicket/digest, the DirectLaunchBinding this evidence must identify,
 * a trusted clock instant, and a finite maximum evidence age.
 *
 * Throws DirectAdmissionRefusedError (bounded, generic; no raw input or
 * nested error detail) if the expected ticket fails strict WorkerTicket
 * schema parsing, or on any identity mismatch, malformed or unknown field,
 * stale/expired/future timestamp, insufficient numeric capacity, or
 * unsupported model/effort/scope. Returns an immutable validated snapshot on
 * success; this is validation evidence only, never a launch handle,
 * reservation, consumption, or approval.
 */
export function validateDirectLaunchCapabilityEvidence(
  candidate: unknown,
  expected: {
    readonly ticket: WorkerTicket;
    readonly ticketDigest: string;
    readonly binding: DirectLaunchBinding;
    readonly trustedNowMillis: number;
    readonly maxEvidenceAgeSeconds: number;
  },
): ValidatedDirectLaunchCapability {
  if (candidate === null || typeof candidate !== "object") {
    fail("capability evidence is not an object");
  }
  const evidence = candidate as DirectLaunchCapabilityEvidence;

  const parsedTicket = checkTicketDigestBinding(expected.ticket, expected.ticketDigest);
  checkIdentity(evidence, expected.ticketDigest, expected.binding);
  checkScopeModelBudgets(evidence, parsedTicket);
  checkEvidenceReference(evidence);
  checkFreshness(evidence, expected.trustedNowMillis, expected.maxEvidenceAgeSeconds);
  checkQuota(evidence, parsedTicket);
  checkContext(evidence, parsedTicket);
  checkConfinement(evidence, parsedTicket);

  const snapshot = deepFreeze(JSON.parse(JSON.stringify(evidence))) as DirectLaunchCapabilityEvidence;
  const bindingSnapshot = deepFreeze(
    JSON.parse(JSON.stringify(expected.binding)),
  ) as DirectLaunchBinding;
  return Object.freeze({
    evidence: snapshot,
    validatedAgainstBinding: bindingSnapshot,
    validatedAt: expected.trustedNowMillis,
  });
}
