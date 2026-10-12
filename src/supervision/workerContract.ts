// Pure, versioned parser for the frozen WorkerTicket / WorkerResult contract.
// No I/O, no throwing on expected validation failures: callers get a
// discriminated ParseResult and decide what to do with it.

import { createHash } from "node:crypto";

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

export type ReasoningEffort = "low" | "medium" | "high";
export type WorkerResultStatus = "success" | "failure" | "blocked";

// Frozen execution outcome vocabulary. It exists so a reader never has to infer
// success from prose:
//   "passed"  — the command/check was executed and it passed
//   "failed"  — the command/check was executed and it failed
//   "not_run" — no execution happened at all
export type ExecutionOutcome = "passed" | "failed" | "not_run";

export interface CommandRecord {
  readonly command: string;
  readonly outcome: ExecutionOutcome;
}

export interface ValidationRecord {
  readonly check: string;
  readonly outcome: ExecutionOutcome;
}

export interface AcceptanceCriterion {
  readonly id: string;
  readonly version: string;
  readonly description: string;
}

export interface WorkerScope {
  readonly owned: readonly string[];
  readonly forbidden: readonly string[];
  readonly read: readonly string[];
  readonly dependencies: readonly string[];
  readonly validation: readonly string[];
}

export interface WorkerModelPolicy {
  readonly eligibleModels: readonly string[];
  readonly reasoningEffort: ReasoningEffort;
  readonly rationale: string;
}

export interface WorkerBudgets {
  readonly contextTokens: number;
  readonly outputTokens: number;
  readonly elapsedSeconds: number;
  readonly maxAttempts: number;
}

export interface WorkerControlPolicy {
  readonly checkpoint: string;
  readonly stopConditions: readonly string[];
  readonly escalation: string;
}

export interface WorkerResultSchema {
  readonly requiredFields: readonly string[];
  readonly maxResultBytes: number;
}

export interface WorkerTicket {
  readonly schemaVersion: string;
  readonly ticketId: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly scope: WorkerScope;
  readonly model: WorkerModelPolicy;
  readonly budgets: WorkerBudgets;
  readonly policy: WorkerControlPolicy;
  readonly resultSchema: WorkerResultSchema;
}

// ---------------------------------------------------------------------------
// Deterministic execution ticket (WorkerTicket/v1 sibling). Binds an ordered,
// literal command sequence instead of a model/token policy. This is parsing
// and binding only: it confers no approval, reservation or launch authority.
// ---------------------------------------------------------------------------

export const DETERMINISTIC_TICKET_SCHEMA_VERSION = "deterministic/1.0.0";
export const DETERMINISTIC_EXECUTION_KIND = "deterministic-execution" as const;

const SUPPORTED_DETERMINISTIC_SCHEMA_VERSIONS: readonly string[] = [
  DETERMINISTIC_TICKET_SCHEMA_VERSION,
];

export interface DeterministicCommand {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
}

export interface DeterministicBudgets {
  readonly elapsedSeconds: number;
  readonly outputBytes: number;
  readonly maxAttempts: number;
}

export interface DeterministicExecutionPolicy {
  readonly rationale: string;
}

export interface DeterministicExecutionTicket {
  readonly schemaVersion: string;
  readonly kind: typeof DETERMINISTIC_EXECUTION_KIND;
  readonly ticketId: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly scope: WorkerScope;
  readonly commands: readonly DeterministicCommand[];
  readonly workspace: string;
  readonly budgets: DeterministicBudgets;
  readonly executionPolicy: DeterministicExecutionPolicy;
  readonly policy: WorkerControlPolicy;
  readonly resultSchema: WorkerResultSchema;
}

export type ExecutionTicketInput =
  | { readonly kind: "ai"; readonly ticket: unknown }
  | { readonly kind: typeof DETERMINISTIC_EXECUTION_KIND; readonly ticket: unknown };

export type ExecutionTicket =
  | { readonly kind: "ai"; readonly ticket: WorkerTicket }
  | { readonly kind: typeof DETERMINISTIC_EXECUTION_KIND; readonly ticket: DeterministicExecutionTicket };

export interface WorkerResult {
  readonly schemaVersion: string;
  readonly ticketId: string;
  readonly status: WorkerResultStatus;
  readonly summary: string;
  readonly changedPaths: readonly string[];
  readonly commandsRun: readonly CommandRecord[];
  readonly validationResults: readonly ValidationRecord[];
  // Canonical "sha256:<64 lowercase hex>" identifier of the durable candidate
  // manifest covering owned/changed files, the frozen ticket/spec and the
  // validation evidence. The parser checks the syntax only: whether such a
  // manifest exists and actually binds to this result is a downstream check.
  readonly fingerprint: string;
  readonly checkpointRef: string;
  readonly blockers: readonly string[];
  readonly recommendedNextAction: string;
  readonly evidence: readonly string[];
}

// The complete, frozen WorkerResult/v1 field set. This is enforced
// unconditionally: a ticket's resultSchema.requiredFields cannot add fields
// outside this set, and cannot relax the parser below it either.
export const KNOWN_RESULT_FIELDS: readonly (keyof WorkerResult)[] = [
  "schemaVersion",
  "ticketId",
  "status",
  "summary",
  "changedPaths",
  "commandsRun",
  "validationResults",
  "fingerprint",
  "checkpointRef",
  "blockers",
  "recommendedNextAction",
  "evidence",
];

export const MAX_RESULT_BYTES = 2048;

const SUPPORTED_TICKET_SCHEMA_VERSIONS: readonly string[] = ["1.0.0"];
const SUPPORTED_RESULT_SCHEMA_VERSIONS: readonly string[] = ["1.0.0"];

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const PLACEHOLDER_OBJECTIVES = new Set([
  "tbd",
  "todo",
  "tba",
  "placeholder",
  "n/a",
  "na",
]);
const VALID_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
];
const VALID_RESULT_STATUSES: readonly WorkerResultStatus[] = [
  "success",
  "failure",
  "blocked",
];
const VALID_EXECUTION_OUTCOMES: readonly ExecutionOutcome[] = [
  "passed",
  "failed",
  "not_run",
];

// Canonical manifest fingerprint: the literal prefix "sha256:" followed by
// exactly 64 lowercase hex digits. Uppercase, truncated, padded or prose
// fingerprints are rejected.
const FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/;

function fail(errors: string[]): { ok: false; errors: readonly string[] } {
  return { ok: false, errors };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasUniqueEntries(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function isPositiveFiniteInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  );
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

// A well-formed local evidence reference: non-empty, no leading/trailing
// whitespace, no control characters, and no ".." path traversal segments.
function isValidEvidenceRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.trim().length === 0 || value.trim() !== value) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) < 0x20) return false;
  }
  if (value.split(/[\\/]/).includes("..")) return false;
  return true;
}

function isEvidenceRefArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => isValidEvidenceRef(item));
}

// A safe local reference (changed path / checkpoint reference): non-blank, no
// surrounding whitespace, no control characters, not absolute (POSIX root, UNC
// or drive-letter), no ".." traversal segment and no empty/blank segment.
// Invalid references fail closed — the whole result is rejected (NC-03).
function isSafeLocalRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.trim().length === 0 || value.trim() !== value) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) < 0x20 || value.charCodeAt(i) === 0x7f) return false;
  }
  // "C:\x", "C:x" and any other drive-qualified reference.
  if (/^[A-Za-z]:/.test(value)) return false;
  const segments = value.split(/[\\/]/);
  for (const segment of segments) {
    // An empty first segment means a rooted path; an empty inner or trailing
    // segment means a doubled or dangling separator.
    if (segment.trim().length === 0) return false;
    if (segment === "..") return false;
  }
  return true;
}

function isSafeLocalRefArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => isSafeLocalRef(item));
}

// Shared shape check for commandsRun / validationResults. Both are arrays of
// two-field objects whose label is a non-blank string and whose outcome comes
// from the frozen ExecutionOutcome vocabulary. Bare strings ("ran tests",
// "all good") are prose, not evidence, and are rejected. An empty array is a
// valid, explicit "nothing here" statement.
function validateOutcomeEntries(
  value: unknown,
  field: "commandsRun" | "validationResults",
  labelKey: "command" | "check",
  errors: string[],
): { label: string; outcome: ExecutionOutcome }[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`result.${field}: must be an array of {${labelKey}, outcome} objects`);
    return undefined;
  }

  const entries: { label: string; outcome: ExecutionOutcome }[] = [];
  let valid = true;

  value.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(
        `result.${field}[${index}]: must be an object with "${labelKey}" and "outcome"`,
      );
      valid = false;
      return;
    }

    let entryValid = true;
    const unexpected = Object.keys(item).filter(
      (key) => key !== labelKey && key !== "outcome",
    );
    if (unexpected.length > 0) {
      errors.push(`result.${field}[${index}]: unexpected field(s): ${unexpected.join(", ")}`);
      entryValid = false;
    }
    if (!isNonEmptyString(item[labelKey])) {
      errors.push(`result.${field}[${index}].${labelKey}: must be a non-blank string`);
      entryValid = false;
    }
    if (
      typeof item.outcome !== "string" ||
      !VALID_EXECUTION_OUTCOMES.includes(item.outcome as ExecutionOutcome)
    ) {
      errors.push(
        `result.${field}[${index}].outcome: must be one of "passed", "failed", "not_run"`,
      );
      entryValid = false;
    }

    if (!entryValid) {
      valid = false;
      return;
    }

    entries.push({
      label: (item[labelKey] as string).trim(),
      outcome: item.outcome as ExecutionOutcome,
    });
  });

  return valid ? entries : undefined;
}

/**
 * Validates and narrows an unknown value into a frozen WorkerTicket.
 * Pure: performs no I/O and never throws.
 */
export function parseWorkerTicket(input: unknown): ParseResult<WorkerTicket> {
  const errors: string[] = [];

  if (!isRecord(input)) {
    return fail(["ticket: must be a JSON object"]);
  }

  if (
    typeof input.schemaVersion === "string" &&
    SUPPORTED_DETERMINISTIC_SCHEMA_VERSIONS.includes(input.schemaVersion)
  ) {
    errors.push(
      "schemaVersion: deterministic execution tickets are not valid WorkerTicket/v1 input; use parseExecutionTicket",
    );
  } else if (
    typeof input.schemaVersion !== "string" ||
    !SUPPORTED_TICKET_SCHEMA_VERSIONS.includes(input.schemaVersion)
  ) {
    errors.push(
      `schemaVersion: must be one of the supported WorkerTicket schema versions: ${SUPPORTED_TICKET_SCHEMA_VERSIONS.join(", ")}`,
    );
  }

  if (!isNonEmptyString(input.ticketId)) {
    errors.push("ticketId: must be a non-empty string");
  }

  if (
    !isNonEmptyString(input.objective) ||
    input.objective.trim().length < 15 ||
    PLACEHOLDER_OBJECTIVES.has(input.objective.trim().toLowerCase())
  ) {
    errors.push(
      "objective: must be a concrete, non-placeholder description of at least 15 characters",
    );
  }

  const acceptanceCriteria = validateAcceptanceCriteria(input.acceptanceCriteria, errors);
  const scope = validateScope(input.scope, errors);
  const model = validateModel(input.model, errors);
  const budgets = validateBudgets(input.budgets, errors);
  const policy = validatePolicy(input.policy, errors);
  const resultSchema = validateResultSchema(input.resultSchema, errors);

  if (errors.length > 0) {
    return fail(errors);
  }

  return {
    ok: true,
    value: {
      schemaVersion: input.schemaVersion as string,
      ticketId: input.ticketId as string,
      objective: (input.objective as string).trim(),
      acceptanceCriteria: acceptanceCriteria as AcceptanceCriterion[],
      scope: scope as WorkerScope,
      model: model as WorkerModelPolicy,
      budgets: budgets as WorkerBudgets,
      policy: policy as WorkerControlPolicy,
      resultSchema: resultSchema as WorkerResultSchema,
    },
  };
}

function validateAcceptanceCriteria(
  value: unknown,
  errors: string[],
): AcceptanceCriterion[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("acceptanceCriteria: must be a non-empty array");
    return undefined;
  }

  const seenIds = new Set<string>();
  const criteria: AcceptanceCriterion[] = [];
  let valid = true;

  value.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`acceptanceCriteria[${index}]: must be an object`);
      valid = false;
      return;
    }
    if (!isNonEmptyString(item.id)) {
      errors.push(`acceptanceCriteria[${index}].id: must be a non-empty string`);
      valid = false;
    } else if (seenIds.has(item.id)) {
      errors.push(`acceptanceCriteria[${index}].id: duplicate id "${item.id}"`);
      valid = false;
    } else {
      seenIds.add(item.id);
    }
    if (typeof item.version !== "string" || !SEMVER_RE.test(item.version)) {
      errors.push(`acceptanceCriteria[${index}].version: must be a semantic version string`);
      valid = false;
    }
    if (!isNonEmptyString(item.description) || item.description.trim().length < 5) {
      errors.push(
        `acceptanceCriteria[${index}].description: must be a non-empty string of at least 5 characters`,
      );
      valid = false;
    }
    if (isNonEmptyString(item.id) && typeof item.version === "string" && isNonEmptyString(item.description)) {
      criteria.push({
        id: item.id,
        version: item.version,
        description: item.description.trim(),
      });
    }
  });

  return valid ? criteria : undefined;
}

function validateScope(value: unknown, errors: string[]): WorkerScope | undefined {
  if (!isRecord(value)) {
    errors.push("scope: must be an object");
    return undefined;
  }

  const fields: (keyof WorkerScope)[] = ["owned", "forbidden", "read", "dependencies", "validation"];
  let allFieldsValid = true;
  for (const field of fields) {
    if (!isStringArray(value[field])) {
      errors.push(`scope.${field}: must be an array of strings`);
      allFieldsValid = false;
    } else if (!hasUniqueEntries(value[field] as string[])) {
      errors.push(`scope.${field}: entries must be unique`);
      allFieldsValid = false;
    }
  }

  if (!allFieldsValid) {
    return undefined;
  }

  const owned = value.owned as string[];
  const forbidden = value.forbidden as string[];
  const read = value.read as string[];
  const validation = value.validation as string[];
  const dependencies = value.dependencies as string[];

  let valid = true;

  if (owned.length === 0) {
    errors.push("scope.owned: must contain at least one path");
    valid = false;
  }
  if (validation.length === 0) {
    errors.push("scope.validation: must contain at least one validation step");
    valid = false;
  }

  const ownedForbiddenOverlap = owned.filter((p) => forbidden.includes(p));
  if (ownedForbiddenOverlap.length > 0) {
    errors.push(`scope: owned and forbidden overlap on: ${ownedForbiddenOverlap.join(", ")}`);
    valid = false;
  }
  const readForbiddenOverlap = read.filter((p) => forbidden.includes(p));
  if (readForbiddenOverlap.length > 0) {
    errors.push(`scope: read and forbidden overlap on: ${readForbiddenOverlap.join(", ")}`);
    valid = false;
  }

  if (!valid) {
    return undefined;
  }

  return { owned, forbidden, read, dependencies, validation };
}

function validateModel(value: unknown, errors: string[]): WorkerModelPolicy | undefined {
  if (!isRecord(value)) {
    errors.push("model: must be an object");
    return undefined;
  }

  let valid = true;

  if (!isStringArray(value.eligibleModels) || value.eligibleModels.length === 0) {
    errors.push("model.eligibleModels: must be a non-empty array of strings");
    valid = false;
  } else if (!hasUniqueEntries(value.eligibleModels)) {
    errors.push("model.eligibleModels: entries must be unique");
    valid = false;
  }

  if (
    typeof value.reasoningEffort !== "string" ||
    !VALID_REASONING_EFFORTS.includes(value.reasoningEffort as ReasoningEffort)
  ) {
    errors.push('model.reasoningEffort: must be one of "low", "medium", "high"');
    valid = false;
  }

  if (!isNonEmptyString(value.rationale) || value.rationale.trim().length < 10) {
    errors.push("model.rationale: must be a non-empty string of at least 10 characters");
    valid = false;
  }

  if (!valid) {
    return undefined;
  }

  return {
    eligibleModels: value.eligibleModels as string[],
    reasoningEffort: value.reasoningEffort as ReasoningEffort,
    rationale: (value.rationale as string).trim(),
  };
}

function validateBudgets(value: unknown, errors: string[]): WorkerBudgets | undefined {
  if (!isRecord(value)) {
    errors.push("budgets: must be an object");
    return undefined;
  }

  let valid = true;

  if (!isPositiveFiniteInteger(value.contextTokens)) {
    errors.push("budgets.contextTokens: must be a positive finite integer");
    valid = false;
  }
  if (!isPositiveFiniteInteger(value.outputTokens)) {
    errors.push("budgets.outputTokens: must be a positive finite integer");
    valid = false;
  }
  if (!isPositiveFiniteNumber(value.elapsedSeconds)) {
    errors.push("budgets.elapsedSeconds: must be a positive finite number");
    valid = false;
  }
  if (!isPositiveFiniteInteger(value.maxAttempts)) {
    errors.push("budgets.maxAttempts: must be a positive finite integer");
    valid = false;
  }

  if (!valid) {
    return undefined;
  }

  return {
    contextTokens: value.contextTokens as number,
    outputTokens: value.outputTokens as number,
    elapsedSeconds: value.elapsedSeconds as number,
    maxAttempts: value.maxAttempts as number,
  };
}

function validatePolicy(value: unknown, errors: string[]): WorkerControlPolicy | undefined {
  if (!isRecord(value)) {
    errors.push("policy: must be an object");
    return undefined;
  }

  let valid = true;

  if (!isNonEmptyString(value.checkpoint) || value.checkpoint.trim().length < 5) {
    errors.push("policy.checkpoint: must be a non-empty string of at least 5 characters");
    valid = false;
  }
  if (!isStringArray(value.stopConditions) || value.stopConditions.length === 0) {
    errors.push("policy.stopConditions: must be a non-empty array of strings");
    valid = false;
  } else if (!hasUniqueEntries(value.stopConditions)) {
    errors.push("policy.stopConditions: entries must be unique");
    valid = false;
  }
  if (!isNonEmptyString(value.escalation) || value.escalation.trim().length < 5) {
    errors.push("policy.escalation: must be a non-empty string of at least 5 characters");
    valid = false;
  }

  if (!valid) {
    return undefined;
  }

  return {
    checkpoint: (value.checkpoint as string).trim(),
    stopConditions: value.stopConditions as string[],
    escalation: (value.escalation as string).trim(),
  };
}

function validateResultSchema(value: unknown, errors: string[]): WorkerResultSchema | undefined {
  if (!isRecord(value)) {
    errors.push("resultSchema: must be an object");
    return undefined;
  }

  let valid = true;

  if (!isStringArray(value.requiredFields) || value.requiredFields.length === 0) {
    errors.push("resultSchema.requiredFields: must be a non-empty array of strings");
    valid = false;
  } else {
    if (!hasUniqueEntries(value.requiredFields)) {
      errors.push("resultSchema.requiredFields: entries must be unique");
      valid = false;
    }
    const unknownFields = value.requiredFields.filter(
      (field) => !(KNOWN_RESULT_FIELDS as string[]).includes(field),
    );
    if (unknownFields.length > 0) {
      errors.push(`resultSchema.requiredFields: unknown field(s): ${unknownFields.join(", ")}`);
      valid = false;
    }
  }

  if (value.maxResultBytes !== MAX_RESULT_BYTES) {
    errors.push(`resultSchema.maxResultBytes: must equal ${MAX_RESULT_BYTES}`);
    valid = false;
  }

  if (!valid) {
    return undefined;
  }

  return {
    requiredFields: value.requiredFields as string[],
    maxResultBytes: value.maxResultBytes as number,
  };
}

// ---------------------------------------------------------------------------
// Deterministic execution ticket parsing
// ---------------------------------------------------------------------------

function validateDeterministicCommands(
  value: unknown,
  errors: string[],
): DeterministicCommand[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("commands: must be a non-empty array");
    return undefined;
  }

  const commands: DeterministicCommand[] = [];
  let valid = true;

  value.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`commands[${index}]: must be an object with "executable", "argv" and "cwd"`);
      valid = false;
      return;
    }

    const unexpected = Object.keys(item).filter(
      (key) => key !== "executable" && key !== "argv" && key !== "cwd",
    );
    let entryValid = true;
    if (unexpected.length > 0) {
      errors.push(`commands[${index}]: unexpected field(s): ${unexpected.join(", ")}`);
      entryValid = false;
    }
    if (!isNonEmptyString(item.executable)) {
      errors.push(`commands[${index}].executable: must be a non-blank string`);
      entryValid = false;
    }
    if (!isStringArray(item.argv)) {
      errors.push(`commands[${index}].argv: must be an array of strings`);
      entryValid = false;
    }
    if (!isNonEmptyString(item.cwd)) {
      errors.push(`commands[${index}].cwd: must be a non-blank string`);
      entryValid = false;
    }

    if (!entryValid) {
      valid = false;
      return;
    }

    commands.push({
      executable: item.executable as string,
      argv: item.argv as string[],
      cwd: item.cwd as string,
    });
  });

  return valid ? commands : undefined;
}

function validateDeterministicBudgets(
  value: unknown,
  errors: string[],
): DeterministicBudgets | undefined {
  if (!isRecord(value)) {
    errors.push("budgets: must be an object");
    return undefined;
  }

  let valid = true;

  const unexpected = Object.keys(value).filter(
    (key) => key !== "elapsedSeconds" && key !== "outputBytes" && key !== "maxAttempts",
  );
  if (unexpected.length > 0) {
    errors.push(`budgets: unsupported field(s): ${unexpected.join(", ")}`);
    valid = false;
  }

  if (!isPositiveFiniteNumber(value.elapsedSeconds)) {
    errors.push("budgets.elapsedSeconds: must be a positive finite number");
    valid = false;
  }
  if (!isPositiveFiniteInteger(value.outputBytes)) {
    errors.push("budgets.outputBytes: must be a positive finite integer");
    valid = false;
  }
  if (!isPositiveFiniteInteger(value.maxAttempts)) {
    errors.push("budgets.maxAttempts: must be a positive finite integer");
    valid = false;
  }

  if (!valid) {
    return undefined;
  }

  return {
    elapsedSeconds: value.elapsedSeconds as number,
    outputBytes: value.outputBytes as number,
    maxAttempts: value.maxAttempts as number,
  };
}

function validateDeterministicExecutionPolicy(
  value: unknown,
  errors: string[],
): DeterministicExecutionPolicy | undefined {
  if (!isRecord(value)) {
    errors.push("executionPolicy: must be an object");
    return undefined;
  }

  const unexpected = Object.keys(value).filter((key) => key !== "rationale");
  let valid = true;
  if (unexpected.length > 0) {
    errors.push(`executionPolicy: unsupported field(s): ${unexpected.join(", ")}`);
    valid = false;
  }
  // Rejecting model/token/provider leakage keeps the deterministic shape
  // free of fake AI eligibility claims (no model, no token budget fields).
  for (const forbidden of ["model", "eligibleModels", "provider", "reasoningEffort", "tokens", "contextTokens", "outputTokens"]) {
    if (forbidden in value) {
      errors.push(`executionPolicy.${forbidden}: unsupported field in a deterministic ticket`);
      valid = false;
    }
  }
  if (!isNonEmptyString(value.rationale) || value.rationale.trim().length < 10) {
    errors.push("executionPolicy.rationale: must be a non-empty string of at least 10 characters");
    valid = false;
  }

  if (!valid) {
    return undefined;
  }

  return { rationale: (value.rationale as string).trim() };
}

const DETERMINISTIC_TICKET_KNOWN_FIELDS: readonly string[] = [
  "schemaVersion",
  "kind",
  "ticketId",
  "objective",
  "acceptanceCriteria",
  "scope",
  "commands",
  "workspace",
  "budgets",
  "executionPolicy",
  "policy",
  "resultSchema",
];

/**
 * Validates and narrows an unknown value into a frozen DeterministicExecutionTicket.
 * Pure: performs no I/O and never throws. This is parsing/binding only and
 * confers no approval, reservation or launch authority.
 */
export function parseDeterministicExecutionTicket(
  input: unknown,
): ParseResult<DeterministicExecutionTicket> {
  const errors: string[] = [];

  if (!isRecord(input)) {
    return fail(["ticket: must be a JSON object"]);
  }

  const unexpected = Object.keys(input).filter(
    (key) => !DETERMINISTIC_TICKET_KNOWN_FIELDS.includes(key),
  );
  if (unexpected.length > 0) {
    errors.push(`ticket: unsupported field(s): ${unexpected.join(", ")}`);
  }
  // Mixed-policy fields (model/provider) must never appear alongside the
  // deterministic command shape, even though they are already caught by the
  // known-field check above; this keeps the rejection message specific.
  for (const forbidden of ["model", "provider"]) {
    if (forbidden in input) {
      errors.push(`ticket.${forbidden}: unsupported field in a deterministic ticket`);
    }
  }

  if (
    typeof input.schemaVersion !== "string" ||
    !SUPPORTED_DETERMINISTIC_SCHEMA_VERSIONS.includes(input.schemaVersion)
  ) {
    errors.push(
      `schemaVersion: must be one of the supported deterministic schema versions: ${SUPPORTED_DETERMINISTIC_SCHEMA_VERSIONS.join(", ")}`,
    );
  }

  if (input.kind !== DETERMINISTIC_EXECUTION_KIND) {
    errors.push(`kind: must equal "${DETERMINISTIC_EXECUTION_KIND}"`);
  }

  if (!isNonEmptyString(input.ticketId)) {
    errors.push("ticketId: must be a non-empty string");
  }

  if (
    !isNonEmptyString(input.objective) ||
    input.objective.trim().length < 15 ||
    PLACEHOLDER_OBJECTIVES.has(input.objective.trim().toLowerCase())
  ) {
    errors.push(
      "objective: must be a concrete, non-placeholder description of at least 15 characters",
    );
  }

  const acceptanceCriteria = validateAcceptanceCriteria(input.acceptanceCriteria, errors);
  const scope = validateScope(input.scope, errors);
  const commands = validateDeterministicCommands(input.commands, errors);
  if (!isNonEmptyString(input.workspace)) {
    errors.push("workspace: must be a non-blank string");
  }
  const budgets = validateDeterministicBudgets(input.budgets, errors);
  const executionPolicy = validateDeterministicExecutionPolicy(input.executionPolicy, errors);
  const policy = validatePolicy(input.policy, errors);
  const resultSchema = validateResultSchema(input.resultSchema, errors);

  if (errors.length > 0) {
    return fail(errors);
  }

  return {
    ok: true,
    value: {
      schemaVersion: input.schemaVersion as string,
      kind: DETERMINISTIC_EXECUTION_KIND,
      ticketId: input.ticketId as string,
      objective: (input.objective as string).trim(),
      acceptanceCriteria: acceptanceCriteria as AcceptanceCriterion[],
      scope: scope as WorkerScope,
      commands: commands as DeterministicCommand[],
      workspace: input.workspace as string,
      budgets: budgets as DeterministicBudgets,
      executionPolicy: executionPolicy as DeterministicExecutionPolicy,
      policy: policy as WorkerControlPolicy,
      resultSchema: resultSchema as WorkerResultSchema,
    },
  };
}

/**
 * Additive typed union entrypoint. Despite the ExecutionTicketInput type,
 * callers can pass malformed values at runtime (null, wrong kind, extra
 * wrapper keys), so the wrapper shape is validated before dispatch. AI-kind
 * input delegates to the unchanged legacy parseWorkerTicket;
 * deterministic-kind input is validated against the deterministic shape.
 * Parsing/binding only — no approval, reservation or launch authority is
 * conferred.
 */
export function parseExecutionTicket(input: unknown): ParseResult<ExecutionTicket> {
  if (!isRecord(input)) {
    return fail(["wrapper: must be a JSON object"]);
  }

  const unexpected = Object.keys(input).filter((key) => key !== "kind" && key !== "ticket");
  if (unexpected.length > 0) {
    return fail([`wrapper: unsupported field(s): ${unexpected.join(", ")}`]);
  }

  if (input.kind !== "ai" && input.kind !== DETERMINISTIC_EXECUTION_KIND) {
    return fail([`wrapper.kind: must be "ai" or "${DETERMINISTIC_EXECUTION_KIND}"`]);
  }

  if (input.kind === "ai") {
    const result = parseWorkerTicket(input.ticket);
    if (!result.ok) {
      return result;
    }
    return { ok: true, value: { kind: "ai", ticket: result.value } };
  }

  const result = parseDeterministicExecutionTicket(input.ticket);
  if (!result.ok) {
    return result;
  }
  return { ok: true, value: { kind: DETERMINISTIC_EXECUTION_KIND, ticket: result.value } };
}

// ---------------------------------------------------------------------------
// Canonical digest
// ---------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function canonicalize(value: unknown): Json {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (isRecord(value)) {
    const sortedKeys = Object.keys(value).sort();
    const result: { [key: string]: Json } = {};
    for (const key of sortedKeys) {
      result[key] = canonicalize(value[key]);
    }
    return result;
  }
  return value as Json;
}

/**
 * Computes a deterministic SHA-256 digest of a validated WorkerTicket.
 * Object key order never affects the digest; changing any authoritative
 * field value changes it.
 */
export function computeTicketDigest(ticket: WorkerTicket): string {
  const canonical = canonicalize(ticket);
  const serialized = JSON.stringify(canonical);
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

/**
 * Computes a deterministic SHA-256 digest of a validated DeterministicExecutionTicket,
 * using the same shared canonicalizer as computeTicketDigest. Object key order
 * never affects the digest; command order and argv/cwd strings are significant
 * and are never normalized, so reordering or mutating them changes the digest.
 */
export function computeDeterministicExecutionTicketDigest(
  ticket: DeterministicExecutionTicket,
): string {
  const canonical = canonicalize(ticket);
  const serialized = JSON.stringify(canonical);
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Strict JSON parsing (rejects trailing data, duplicate keys, and any
// non-standard/ambiguous JSON extensions such as NaN, comments, trailing
// commas, single-quoted strings, or unquoted keys).
// ---------------------------------------------------------------------------

interface Cursor {
  readonly text: string;
  pos: number;
}

class StrictJsonError extends Error {}

function parseStrictJson(text: string): ParseResult<unknown> {
  const cursor: Cursor = { text, pos: 0 };
  try {
    skipWhitespace(cursor);
    const value = parseValue(cursor);
    skipWhitespace(cursor);
    if (cursor.pos !== cursor.text.length) {
      throw new StrictJsonError(`unexpected trailing content at offset ${cursor.pos}`);
    }
    return { ok: true, value };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown parse error";
    return fail([`result: malformed JSON: ${message}`]);
  }
}

function skipWhitespace(cursor: Cursor): void {
  for (;;) {
    const ch = cursor.text[cursor.pos];
    if (ch === undefined || !" \t\n\r".includes(ch)) return;
    cursor.pos += 1;
  }
}

function parseValue(cursor: Cursor): unknown {
  const ch = cursor.text[cursor.pos];
  if (ch === undefined) {
    throw new StrictJsonError("unexpected end of input");
  }
  if (ch === "{") return parseObject(cursor);
  if (ch === "[") return parseArray(cursor);
  if (ch === '"') return parseString(cursor);
  if (ch === "-" || (ch >= "0" && ch <= "9")) return parseNumber(cursor);
  if (cursor.text.startsWith("true", cursor.pos)) {
    cursor.pos += 4;
    return true;
  }
  if (cursor.text.startsWith("false", cursor.pos)) {
    cursor.pos += 5;
    return false;
  }
  if (cursor.text.startsWith("null", cursor.pos)) {
    cursor.pos += 4;
    return null;
  }
  throw new StrictJsonError(`unexpected token at offset ${cursor.pos}`);
}

const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function parseObject(cursor: Cursor): Record<string, unknown> {
  cursor.pos += 1; // consume '{'
  // Prototype-free map: rejects reliance on inherited Object.prototype
  // behavior (e.g. "__proto__" silently reconfiguring the prototype instead
  // of becoming an own, enumerable key).
  const result: Record<string, unknown> = Object.create(null);
  const seenKeys = new Set<string>();
  skipWhitespace(cursor);
  if (cursor.text[cursor.pos] === "}") {
    cursor.pos += 1;
    return result;
  }
  for (;;) {
    skipWhitespace(cursor);
    if (cursor.text[cursor.pos] !== '"') {
      throw new StrictJsonError(`expected string key at offset ${cursor.pos}`);
    }
    const key = parseString(cursor);
    if (UNSAFE_OBJECT_KEYS.has(key)) {
      throw new StrictJsonError(`unsafe key "${key}" at offset ${cursor.pos}`);
    }
    if (seenKeys.has(key)) {
      throw new StrictJsonError(`duplicate key "${key}" at offset ${cursor.pos}`);
    }
    seenKeys.add(key);
    skipWhitespace(cursor);
    if (cursor.text[cursor.pos] !== ":") {
      throw new StrictJsonError(`expected ':' at offset ${cursor.pos}`);
    }
    cursor.pos += 1;
    skipWhitespace(cursor);
    result[key] = parseValue(cursor);
    skipWhitespace(cursor);
    const next = cursor.text[cursor.pos];
    if (next === ",") {
      cursor.pos += 1;
      continue;
    }
    if (next === "}") {
      cursor.pos += 1;
      return result;
    }
    throw new StrictJsonError(`expected ',' or '}' at offset ${cursor.pos}`);
  }
}

function parseArray(cursor: Cursor): unknown[] {
  cursor.pos += 1; // consume '['
  const result: unknown[] = [];
  skipWhitespace(cursor);
  if (cursor.text[cursor.pos] === "]") {
    cursor.pos += 1;
    return result;
  }
  for (;;) {
    skipWhitespace(cursor);
    result.push(parseValue(cursor));
    skipWhitespace(cursor);
    const next = cursor.text[cursor.pos];
    if (next === ",") {
      cursor.pos += 1;
      continue;
    }
    if (next === "]") {
      cursor.pos += 1;
      return result;
    }
    throw new StrictJsonError(`expected ',' or ']' at offset ${cursor.pos}`);
  }
}

function parseString(cursor: Cursor): string {
  cursor.pos += 1; // consume opening quote
  let out = "";
  for (;;) {
    const ch = cursor.text[cursor.pos];
    if (ch === undefined) {
      throw new StrictJsonError("unterminated string");
    }
    if (ch === '"') {
      cursor.pos += 1;
      return out;
    }
    if (ch === "\\") {
      const escape = cursor.text[cursor.pos + 1];
      switch (escape) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const hex = cursor.text.slice(cursor.pos + 2, cursor.pos + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new StrictJsonError(`invalid unicode escape at offset ${cursor.pos}`);
          }
          out += String.fromCharCode(parseInt(hex, 16));
          cursor.pos += 4;
          break;
        }
        default:
          throw new StrictJsonError(`invalid escape sequence at offset ${cursor.pos}`);
      }
      cursor.pos += 2;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      throw new StrictJsonError(`invalid control character at offset ${cursor.pos}`);
    }
    out += ch;
    cursor.pos += 1;
  }
}

const NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/;

function parseNumber(cursor: Cursor): number {
  const rest = cursor.text.slice(cursor.pos);
  const match = NUMBER_RE.exec(rest);
  if (!match || match.index !== 0) {
    throw new StrictJsonError(`invalid number at offset ${cursor.pos}`);
  }
  cursor.pos += match[0].length;
  return Number(match[0]);
}

// ---------------------------------------------------------------------------
// WorkerResult parsing
// ---------------------------------------------------------------------------

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Parses and validates a raw WorkerResult JSON payload against the schema
 * declared by the originating ticket. Pure and side-effect free.
 */
export function parseWorkerResult(
  raw: string,
  ticket: WorkerTicket,
): ParseResult<WorkerResult> {
  if (typeof raw !== "string" || raw.length === 0) {
    return fail(["result: must be a non-empty JSON string"]);
  }

  const byteLength = utf8ByteLength(raw);
  if (byteLength > MAX_RESULT_BYTES) {
    return fail([`result: exceeds ${MAX_RESULT_BYTES} UTF-8 bytes (got ${byteLength})`]);
  }

  const parsed = parseStrictJson(raw);
  if (!parsed.ok) {
    return parsed;
  }

  if (!isRecord(parsed.value)) {
    return fail(["result: must be exactly one JSON object"]);
  }

  const obj = parsed.value;
  const actualKeys = Object.keys(obj);

  // The frozen WorkerResult/v1 minimum field set is enforced unconditionally.
  // ticket.resultSchema.requiredFields is validated (elsewhere) as a subset
  // of KNOWN_RESULT_FIELDS, but it can never relax this minimum: every
  // field below is always required, regardless of what the ticket declares.
  const requiredFields = KNOWN_RESULT_FIELDS as readonly string[];

  const missing = requiredFields.filter((field) => !actualKeys.includes(field));
  const unexpected = actualKeys.filter((key) => !requiredFields.includes(key));

  const errors: string[] = [];
  if (missing.length > 0) {
    errors.push(`result: missing required field(s): ${missing.join(", ")}`);
  }
  if (unexpected.length > 0) {
    errors.push(`result: unexpected field(s): ${unexpected.join(", ")}`);
  }

  if (
    typeof obj.schemaVersion !== "string" ||
    !SUPPORTED_RESULT_SCHEMA_VERSIONS.includes(obj.schemaVersion) ||
    obj.schemaVersion !== ticket.schemaVersion
  ) {
    errors.push("result.schemaVersion: must be a supported version matching ticket.schemaVersion");
  }
  if (obj.ticketId !== ticket.ticketId) {
    errors.push("result.ticketId: must match ticket.ticketId");
  }
  if (
    typeof obj.status !== "string" ||
    !VALID_RESULT_STATUSES.includes(obj.status as WorkerResultStatus)
  ) {
    errors.push('result.status: must be one of "success", "failure", "blocked"');
  }
  if (!isNonEmptyString(obj.summary)) {
    errors.push("result.summary: must be a non-empty string");
  }
  if (!isSafeLocalRefArray(obj.changedPaths)) {
    errors.push(
      "result.changedPaths: must be an array of non-blank, safe local paths (no absolute, traversal, control or empty segments)",
    );
  }
  const commandsRun = validateOutcomeEntries(obj.commandsRun, "commandsRun", "command", errors);
  const validationResults = validateOutcomeEntries(
    obj.validationResults,
    "validationResults",
    "check",
    errors,
  );
  if (typeof obj.fingerprint !== "string" || !FINGERPRINT_RE.test(obj.fingerprint)) {
    errors.push(
      'result.fingerprint: must be a canonical manifest digest of the form "sha256:" followed by 64 lowercase hex digits',
    );
  }
  if (!isSafeLocalRef(obj.checkpointRef)) {
    errors.push(
      "result.checkpointRef: must be a non-blank, safe local reference (no absolute, traversal, control or empty segments)",
    );
  }
  if (!isStringArray(obj.blockers)) {
    errors.push("result.blockers: must be an array of strings");
  }
  if (!isNonEmptyString(obj.recommendedNextAction)) {
    errors.push("result.recommendedNextAction: must be a non-empty string");
  }
  if (!isEvidenceRefArray(obj.evidence)) {
    errors.push("result.evidence: must be an array of non-empty, well-formed local references");
  }

  // Both helpers return undefined only after recording an error, so this also
  // covers the narrowing needed below.
  if (errors.length > 0 || commandsRun === undefined || validationResults === undefined) {
    return fail(errors);
  }

  return {
    ok: true,
    value: {
      schemaVersion: obj.schemaVersion as string,
      ticketId: obj.ticketId as string,
      status: obj.status as WorkerResultStatus,
      summary: obj.summary as string,
      changedPaths: obj.changedPaths as string[],
      commandsRun: commandsRun.map((entry) => ({
        command: entry.label,
        outcome: entry.outcome,
      })),
      validationResults: validationResults.map((entry) => ({
        check: entry.label,
        outcome: entry.outcome,
      })),
      fingerprint: obj.fingerprint as string,
      checkpointRef: obj.checkpointRef as string,
      blockers: obj.blockers as string[],
      recommendedNextAction: obj.recommendedNextAction as string,
      evidence: obj.evidence as string[],
    },
  };
}
