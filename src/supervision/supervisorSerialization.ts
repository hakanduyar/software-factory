/**
 * Strict parse/validation for persisted supervisor state (TASK-006 AC-7).
 *
 * A supervisor row is untrusted input the moment it comes off disk: it decides
 * which external AI actions run next and which resources are believed usable,
 * so `JSON.parse(...) as SupervisorState` is not validation. Everything the
 * tick branches on is checked here, and a row that could only exist through
 * corruption throws `PersistenceCorruptionError` rather than becoming a value
 * that merely satisfies TypeScript.
 *
 * Two checks are load-bearing beyond ordinary shape validation:
 *
 * 1. DERIVED IDENTITIES ARE RECOMPUTED. `ResourceRecord.key` and
 *    `SupervisorActionClaim.actionId` are pure functions of their coordinates,
 *    so a corrupted row cannot point one resource's state at another's, or one
 *    action's claim at a different action.
 *
 * 2. THE FINANCIAL POLICY IS NOT PARSED HERE. It is carried through as
 *    `unknown` and validated at every point of use by
 *    `parseFinancialPolicy`, which denies on anything it cannot trust. Parsing
 *    it into a typed value here would quietly assert that a stored policy is
 *    always a valid one — and a corrupt policy must DENY, not fail to load,
 *    because a state that will not load cannot even report why.
 */

import { PersistenceCorruptionError } from "../domain/errors.js";
import {
  ACTION_STATES,
  ESCALATION_REASONS,
  ROADMAP_STATUSES,
  canonicalActionId,
  type ActionState,
  type EscalationReason,
  type HumanEscalation,
  type RoadmapItem,
  type RoadmapStatus,
  type SessionCheckpoint,
  type SupervisorActionClaim,
  type SupervisorState,
} from "./supervisorTypes.js";
import { BILLING_MODES, type BillingMode } from "./financialSafety.js";
import { CONFIG_VERIFICATIONS, type AiRunConfigRecord, type ConfigVerification } from "./modelEnforcement.js";
import { WORK_CLASSES, type WorkClass } from "./modelRouting.js";
import {
  GENESIS_DIGEST,
  isHashable,
  PROVENANCE_KINDS,
  type ProvenanceEntry,
  type ProvenanceKind,
} from "./provenanceChain.js";
import { redactSecrets } from "../adapters/workers/environmentPolicy.js";
import {
  BACKOFF_LADDER_MS,
  RESOURCE_STATES,
  resourceKey,
  type ResourceRecord,
  type ResourceState,
} from "./resourceTypes.js";
import { validateRoadmap } from "./supervisorService.js";

function corrupt(context: string, message: string): never {
  throw new PersistenceCorruptionError(`${context}: ${message}`);
}

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    corrupt(context, `must be an object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) {
    corrupt(context, `must be an array, got ${JSON.stringify(value)}`);
  }
  return value;
}

function str(row: Record<string, unknown>, field: string, context: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    corrupt(context, `field "${field}" must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalStr(row: Record<string, unknown>, field: string, context: string): string | undefined {
  const value = row[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    corrupt(context, `field "${field}" must be a string when present, got ${JSON.stringify(value)}`);
  }
  return value;
}

function num(row: Record<string, unknown>, field: string, context: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    corrupt(context, `field "${field}" must be a finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalNum(row: Record<string, unknown>, field: string, context: string): number | undefined {
  const value = row[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    corrupt(context, `field "${field}" must be a finite number when present, got ${JSON.stringify(value)}`);
  }
  return value;
}

function nonNegativeInt(row: Record<string, unknown>, field: string, context: string): number {
  const value = num(row, field, context);
  if (!Number.isInteger(value) || value < 0) {
    corrupt(context, `field "${field}" must be a non-negative integer, got ${value}`);
  }
  return value;
}

function bool(row: Record<string, unknown>, field: string, context: string): boolean {
  const value = row[field];
  if (typeof value !== "boolean") {
    corrupt(context, `field "${field}" must be a boolean, got ${JSON.stringify(value)}`);
  }
  return value;
}

function oneOf<T extends string>(row: Record<string, unknown>, field: string, allowed: readonly T[], context: string): T {
  const value = row[field];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    corrupt(context, `field "${field}" must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
  }
  return value as T;
}

function strArray(value: unknown, context: string): string[] {
  return asArray(value, context).map((entry, index) => {
    if (typeof entry !== "string") {
      corrupt(context, `entry ${index} must be a string, got ${JSON.stringify(entry)}`);
    }
    return entry;
  });
}

/**
 * How many implementers one item may carry in from PERSISTED state.
 *
 * Review note (round 7): removing the write-side eviction (F6-C4-1, correctly —
 * an evicted implementer silently stops being excluded) left the read side with
 * no limit, and a hand-written 100,000-entry history parsed happily at 1.29 MB.
 * The service itself cannot produce that: attempts are capped by
 * `MAX_REMEDIATION_ATTEMPTS` and the catalog is a handful of entries. So a
 * history beyond any plausible number is not a long history, it is a corrupt
 * row — and the answer to a corrupt row here is the same as everywhere else in
 * this file: refuse to load it, rather than truncate and carry on with an
 * incomplete lineage.
 */
const MAX_PARSED_IMPLEMENTERS = 256;

function boundedStrArray(value: unknown, limit: number, context: string): string[] {
  const parsed = strArray(value, context);
  if (parsed.length > limit) {
    corrupt(context, `has ${parsed.length} entries, which exceeds the maximum of ${limit}`);
  }
  return parsed;
}

function parseResource(raw: unknown, index: number, context: string): ResourceRecord {
  const itemContext = `${context}.resources[${index}]`;
  const row = asObject(raw, itemContext);
  const provider = str(row, "provider", itemContext);
  const model = str(row, "model", itemContext);
  const key = str(row, "key", itemContext);

  // Derived identity: recomputed, never trusted.
  const expected = resourceKey(provider, model);
  if (key !== expected) {
    corrupt(itemContext, `key ${key} is not the canonical ${expected}`);
  }

  const backoffContext = `${itemContext}.backoff`;
  const backoffRow = asObject(row["backoff"], backoffContext);
  const attempt = nonNegativeInt(backoffRow, "attempt", backoffContext);
  const delayMs = nonNegativeInt(backoffRow, "delayMs", backoffContext);
  const cap = BACKOFF_LADDER_MS[BACKOFF_LADDER_MS.length - 1]!;
  if (delayMs > cap) {
    corrupt(backoffContext, `delayMs ${delayMs} exceeds the ladder cap ${cap}`);
  }
  if (attempt === 0 && delayMs !== 0) {
    corrupt(backoffContext, `attempt 0 must carry delayMs 0, got ${delayMs}`);
  }

  const state = oneOf<ResourceState>(row, "state", RESOURCE_STATES, itemContext);
  const retryAt = optionalNum(row, "retryAt", itemContext);
  // A scheduled retry on a state no timer can clear would poll forever.
  if (retryAt !== undefined && state === "AUTH_REQUIRED") {
    corrupt(itemContext, "AUTH_REQUIRED is human-only and may not carry a scheduled retry");
  }

  const diagnostic = optionalStr(row, "diagnostic", itemContext);
  const lastSuccessAt = optionalNum(row, "lastSuccessAt", itemContext);
  // Every declared field must round-trip. TASK-005 remediation round 3 was
  // caused by exactly this omission on ApprovalContext, and the supervisor
  // restart test caught the same mistake here — an observed billing mode that
  // vanished on reload would silently make every AI action financial.
  const observedBillingMode =
    row["observedBillingMode"] === undefined
      ? undefined
      : oneOf<BillingMode>(row, "observedBillingMode", BILLING_MODES, itemContext);
  return {
    provider,
    model,
    key,
    state,
    detectedAt: num(row, "detectedAt", itemContext),
    lastCheckedAt: num(row, "lastCheckedAt", itemContext),
    ...(retryAt === undefined ? {} : { retryAt }),
    backoff: { attempt, delayMs },
    ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
    ...(observedBillingMode === undefined ? {} : { observedBillingMode }),
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

function parseRoadmapItem(raw: unknown, index: number, context: string): RoadmapItem {
  const itemContext = `${context}.roadmap[${index}]`;
  const row = asObject(raw, itemContext);
  const status = oneOf<RoadmapStatus>(row, "status", ROADMAP_STATUSES, itemContext);
  const humanActionRequired = optionalStr(row, "humanActionRequired", itemContext);

  // A phase presupposition: an item parked for a human must say what the human
  // is for, or the escalation is unactionable.
  if (status === "WAITING_FOR_HUMAN_REQUIRED" && humanActionRequired === undefined) {
    corrupt(itemContext, "WAITING_FOR_HUMAN_REQUIRED presupposes a recorded humanActionRequired");
  }

  const detail = optionalStr(row, "detail", itemContext);
  const attempts = row["attempts"] === undefined ? undefined : nonNegativeInt(row, "attempts", itemContext);
  const declaredActionKinds =
    row["declaredActionKinds"] === undefined
      ? undefined
      : strArray(row["declaredActionKinds"], `${itemContext}.declaredActionKinds`);
  const implementedByResourceKey = optionalStr(row, "implementedByResourceKey", itemContext);
  const implementedByResourceKeys =
    row["implementedByResourceKeys"] === undefined
      ? undefined
      : boundedStrArray(
          row["implementedByResourceKeys"],
          MAX_PARSED_IMPLEMENTERS,
          `${itemContext}.implementedByResourceKeys`,
        );
  const lastRunConfig =
    row["lastRunConfig"] === undefined
      ? undefined
      : parseRunConfig(row["lastRunConfig"], `${itemContext}.lastRunConfig`);
  return {
    key: str(row, "key", itemContext),
    title: str(row, "title", itemContext),
    dependsOn: strArray(row["dependsOn"], `${itemContext}.dependsOn`),
    status,
    workClass: oneOf<WorkClass>(row, "workClass", WORK_CLASSES, itemContext),
    order: nonNegativeInt(row, "order", itemContext),
    ...(attempts === undefined ? {} : { attempts }),
    ...(declaredActionKinds === undefined ? {} : { declaredActionKinds }),
    ...(implementedByResourceKey === undefined ? {} : { implementedByResourceKey }),
    ...(implementedByResourceKeys === undefined ? {} : { implementedByResourceKeys }),
    ...(lastRunConfig === undefined ? {} : { lastRunConfig }),
    ...(detail === undefined ? {} : { detail }),
    ...(humanActionRequired === undefined ? {} : { humanActionRequired }),
  };
}

/**
 * The durable record of what an AI run was configured to be (F4-9).
 *
 * Parsed as strictly as everything else: `verification` is checked against the
 * closed set, because a row claiming `VERIFIED_EFFECTIVE` is a claim about
 * evidence, and an unrecognised value must fail closed rather than be carried
 * along as a string.
 */
function parseRunConfig(raw: unknown, context: string): AiRunConfigRecord {
  const row = asObject(raw, context);
  const requestedEffort = optionalStr(row, "requestedEffort", context);
  const effectiveEffort = optionalStr(row, "effectiveEffort", context);
  return {
    requestedProvider: str(row, "requestedProvider", context),
    requestedModel: str(row, "requestedModel", context),
    ...(requestedEffort === undefined ? {} : { requestedEffort }),
    effectiveProvider: str(row, "effectiveProvider", context),
    effectiveModel: str(row, "effectiveModel", context),
    ...(effectiveEffort === undefined ? {} : { effectiveEffort }),
    verification: oneOf<ConfigVerification>(row, "verification", CONFIG_VERIFICATIONS, context),
    argvEvidence: strArray(row["argvEvidence"], `${context}.argvEvidence`),
    note: str(row, "note", context),
  };
}

function parseCheckpoint(raw: unknown, index: number, context: string): SessionCheckpoint {
  const itemContext = `${context}.checkpoints[${index}]`;
  const row = asObject(raw, itemContext);
  const optionals = {
    projectId: optionalStr(row, "projectId", itemContext),
    workItemId: optionalStr(row, "workItemId", itemContext),
    planId: optionalStr(row, "planId", itemContext),
    planRevision: optionalNum(row, "planRevision", itemContext),
    branch: optionalStr(row, "branch", itemContext),
    baseCommit: optionalStr(row, "baseCommit", itemContext),
    resumedFromActionId: optionalStr(row, "resumedFromActionId", itemContext),
  };
  return {
    roadmapKey: str(row, "roadmapKey", itemContext),
    ...(optionals.projectId === undefined ? {} : { projectId: optionals.projectId }),
    ...(optionals.workItemId === undefined ? {} : { workItemId: optionals.workItemId }),
    ...(optionals.planId === undefined ? {} : { planId: optionals.planId }),
    ...(optionals.planRevision === undefined ? {} : { planRevision: optionals.planRevision }),
    ...(optionals.branch === undefined ? {} : { branch: optionals.branch }),
    ...(optionals.baseCommit === undefined ? {} : { baseCommit: optionals.baseCommit }),
    ...(optionals.resumedFromActionId === undefined
      ? {}
      : { resumedFromActionId: optionals.resumedFromActionId }),
    actionId: str(row, "actionId", itemContext),
    iteration: nonNegativeInt(row, "iteration", itemContext),
    completedVerification: strArray(row["completedVerification"], `${itemContext}.completedVerification`),
    pendingVerification: strArray(row["pendingVerification"], `${itemContext}.pendingVerification`),
    findings: strArray(row["findings"], `${itemContext}.findings`),
    nextAction: str(row, "nextAction", itemContext),
    requiredWorkClass: oneOf<WorkClass>(row, "requiredWorkClass", WORK_CLASSES, itemContext),
    updatedAt: num(row, "updatedAt", itemContext),
  };
}

function parseClaim(raw: unknown, context: string): SupervisorActionClaim {
  const claimContext = `${context}.activeClaim`;
  const row = asObject(raw, claimContext);
  const roadmapKey = str(row, "roadmapKey", claimContext);
  const kind = str(row, "kind", claimContext);
  const attempt = nonNegativeInt(row, "attempt", claimContext);
  const actionId = str(row, "actionId", claimContext);

  const expected = canonicalActionId(roadmapKey, kind, attempt);
  if (actionId !== expected) {
    corrupt(claimContext, `actionId ${actionId} is not the canonical ${expected}`);
  }
  const resourceKeyValue = optionalStr(row, "resourceKey", claimContext);
  return {
    actionId,
    roadmapKey,
    kind,
    ...(resourceKeyValue === undefined ? {} : { resourceKey: resourceKeyValue }),
    state: oneOf<ActionState>(row, "state", ACTION_STATES, claimContext),
    ownerId: str(row, "ownerId", claimContext),
    attempt,
    claimedAt: num(row, "claimedAt", claimContext),
  };
}

function parseEscalation(raw: unknown, index: number, context: string): HumanEscalation {
  const itemContext = `${context}.escalations[${index}]`;
  const row = asObject(raw, itemContext);
  return {
    roadmapKey: str(row, "roadmapKey", itemContext),
    reason: oneOf<EscalationReason>(row, "reason", ESCALATION_REASONS, itemContext),
    humanActionRequired: str(row, "humanActionRequired", itemContext),
    detail: str(row, "detail", itemContext),
    raisedAt: num(row, "raisedAt", itemContext),
    resolved: bool(row, "resolved", itemContext),
  };
}

/**
 * One provenance entry, field by field (TASK-008).
 *
 * Constructed explicitly rather than spread, for the reason every parser in
 * this file is: a spread copies whatever the row happens to carry, and an
 * entry whose extra fields survive into memory is an entry whose digest is
 * computed over something other than what was verified.
 */
/**
 * The longest a persisted provenance string may be.
 *
 * `boundedDiagnostic` already bounds everything the WRITE path produces, so a
 * longer value did not come from this codebase — it came from a restore, an
 * older build, or something with file access. Round-1 review pushed a
 * 100,000-character detail straight through this parser.
 */
const MAX_PARSED_PROVENANCE_TEXT = 4_096;

/**
 * REFUSES rather than redacts (AC-9, round-1 finding).
 *
 * Redacting here would change the very bytes the digest was computed over, so
 * every sanitized entry would then fail its own verification and the whole
 * chain would read as tampered. The write path redacts BEFORE hashing; by the
 * time a row is on disk, unredacted text means the row did not come from the
 * write path — which is corruption, not something to tidy up.
 */
function boundedProvenanceText(value: string, field: string, context: string): string {
  if (value.length > MAX_PARSED_PROVENANCE_TEXT) {
    corrupt(
      context,
      `field "${field}" is ${value.length} characters, over the ${MAX_PARSED_PROVENANCE_TEXT} limit; ` +
        "the write path bounds every provenance string, so this row was not written by it",
    );
  }
  /**
   * Round-3 finding: `appendProvenance` refused a lone surrogate, but nothing
   * refused one already on disk — and `computeDigest` gives `x\uD800y` and
   * `x\uFFFDy` the same digest, because UTF-8 encoding replaces the lone
   * surrogate. A row carrying one is therefore a row whose digest does not
   * distinguish it from a different value.
   */
  if (!isHashable(value)) {
    corrupt(
      context,
      `field "${field}" is not well-formed UTF-16; its digest would not distinguish it from a different string`,
    );
  }
  if (redactSecrets(value) !== value) {
    corrupt(
      context,
      `field "${field}" contains credential-shaped text; the write path redacts before hashing, ` +
        "so a row still carrying one was not written by it",
    );
  }
  return value;
}

/**
 * A digest field must have the SHAPE of a digest (round-2 finding).
 *
 * `digest` and `previousDigest` were plain strings, so a credential could be
 * persisted in one — the reviewer stored `sk-ant-api03-...` as a digest and it
 * round-tripped. Bounding and redacting them would not be enough either: a
 * digest is a derived value with exactly one legal form, and anything else is
 * corruption rather than text to sanitize.
 */
function digestField(value: string, field: string, context: string): string {
  if (value !== GENESIS_DIGEST && !/^prov-[0-9a-f]{64}$/.test(value)) {
    corrupt(context, `field "${field}" is not a digest; a derived value has exactly one legal form`);
  }
  return value;
}

function parseProvenanceEntry(raw: unknown, index: number, context: string): ProvenanceEntry {
  const itemContext = `${context}.provenance[${index}]`;
  const row = asObject(raw, itemContext);
  const rawResourceKey = optionalStr(row, "resourceKey", itemContext);
  const resourceKeyValue =
    rawResourceKey === undefined ? undefined : boundedProvenanceText(rawResourceKey, "resourceKey", itemContext);
  return {
    sequence: nonNegativeInt(row, "sequence", itemContext),
    kind: oneOf<ProvenanceKind>(row, "kind", PROVENANCE_KINDS, itemContext),
    roadmapKey: boundedProvenanceText(str(row, "roadmapKey", itemContext), "roadmapKey", itemContext),
    ...(resourceKeyValue === undefined ? {} : { resourceKey: resourceKeyValue }),
    detail: boundedProvenanceText(str(row, "detail", itemContext), "detail", itemContext),
    recordedAt: num(row, "recordedAt", itemContext),
    previousDigest: digestField(str(row, "previousDigest", itemContext), "previousDigest", itemContext),
    digest: digestField(str(row, "digest", itemContext), "digest", itemContext),
  };
}

export function encodeSupervisorState(state: SupervisorState): string {
  return JSON.stringify(state);
}

export function parseSupervisorState(json: string, expected: { readonly version: number }): SupervisorState {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    corrupt("supervisor state", `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const context = "supervisor state";
  const row = asObject(raw, context);

  const version = nonNegativeInt(row, "version", context);
  if (version !== expected.version) {
    corrupt(context, `data.version ${version} does not match the row version ${expected.version}`);
  }
  if (!Object.prototype.hasOwnProperty.call(row, "financialPolicy")) {
    // Its VALUE is validated at use (and denies when untrustworthy), but a row
    // with no policy field at all is structurally incomplete.
    corrupt(context, "no financialPolicy field is stored");
  }

  const resources = asArray(row["resources"], `${context}.resources`).map((entry, index) =>
    parseResource(entry, index, context),
  );
  const seenKeys = new Set<string>();
  for (const record of resources) {
    if (seenKeys.has(record.key)) {
      corrupt(context, `resource ${record.key} appears more than once`);
    }
    seenKeys.add(record.key);
  }

  const roadmap = asArray(row["roadmap"], `${context}.roadmap`).map((entry, index) =>
    parseRoadmapItem(entry, index, context),
  );
  // Same DAG rules the write path enforces: cycles and dangling references are
  // corruption, not a state to recover from.
  validateRoadmap(roadmap);
  const roadmapKeys = new Set(roadmap.map((item) => item.key));

  const checkpoints = asArray(row["checkpoints"], `${context}.checkpoints`).map((entry, index) =>
    parseCheckpoint(entry, index, context),
  );
  for (const checkpoint of checkpoints) {
    if (!roadmapKeys.has(checkpoint.roadmapKey)) {
      corrupt(context, `checkpoint references unknown roadmap item "${checkpoint.roadmapKey}"`);
    }
  }
  const seenCheckpoints = new Set<string>();
  for (const checkpoint of checkpoints) {
    if (seenCheckpoints.has(checkpoint.roadmapKey)) {
      corrupt(context, `roadmap item "${checkpoint.roadmapKey}" has more than one checkpoint`);
    }
    seenCheckpoints.add(checkpoint.roadmapKey);
  }

  const escalations = asArray(row["escalations"], `${context}.escalations`).map((entry, index) =>
    parseEscalation(entry, index, context),
  );
  for (const escalation of escalations) {
    if (!roadmapKeys.has(escalation.roadmapKey)) {
      corrupt(context, `escalation references unknown roadmap item "${escalation.roadmapKey}"`);
    }
  }

  const claimRaw = row["activeClaim"];
  const activeClaim = claimRaw === undefined ? undefined : parseClaim(claimRaw, context);
  if (activeClaim !== undefined) {
    if (!roadmapKeys.has(activeClaim.roadmapKey)) {
      corrupt(context, `activeClaim references unknown roadmap item "${activeClaim.roadmapKey}"`);
    }
    if (activeClaim.resourceKey !== undefined && !seenKeys.has(activeClaim.resourceKey)) {
      corrupt(context, `activeClaim references unknown resource "${activeClaim.resourceKey}"`);
    }
  }

  /**
   * ABSENT means an empty chain, not corruption (TASK-008).
   *
   * A database written before provenance existed is not damaged, and refusing
   * it would repeat exactly the forward-compatibility failure recorded as L-1
   * in docs/KNOWN-LIMITATIONS.md: an operator whose supervisor stops loading
   * because a newer build added a field. A PRESENT-but-malformed chain is still
   * corruption and is refused field by field.
   *
   * The chain is NOT verified here. Parsing answers "is this well-formed"; the
   * C4 decision asks "is this intact", and conflating the two would mean a
   * tampered chain took down state loading entirely instead of failing that one
   * decision closed.
   */
  const provenance =
    row["provenance"] === undefined
      ? []
      : asArray(row["provenance"], `${context}.provenance`).map((entry, index) =>
          parseProvenanceEntry(entry, index, context),
        );
  for (const entry of provenance) {
    if (!roadmapKeys.has(entry.roadmapKey)) {
      corrupt(context, `provenance entry ${entry.sequence} references unknown roadmap item "${entry.roadmapKey}"`);
    }
  }

  const nextWakeAt = optionalNum(row, "nextWakeAt", context);
  return {
    version,
    financialPolicy: row["financialPolicy"],
    resources,
    roadmap,
    checkpoints,
    ...(activeClaim === undefined ? {} : { activeClaim }),
    ...(nextWakeAt === undefined ? {} : { nextWakeAt }),
    escalations,
    provenance,
    updatedAt: num(row, "updatedAt", context),
  };
}
