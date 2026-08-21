/**
 * Strict parse/validation for persisted EngineeringLoop rows (TASK-004
 * remediation round 1, independent review HIGH 2 / PART G).
 *
 * A loop row is untrusted input the moment it comes from disk: it decides
 * which external AI action runs next, so `JSON.parse(...) as EngineeringLoop`
 * is not runtime validation. Every field the loop state machine branches on
 * is checked here — shapes, enums, ranges, and cross-field coherence — and a
 * row that could only exist through corruption or tampering throws
 * `PersistenceCorruptionError` instead of becoming a value that merely
 * satisfies TypeScript's structural type check.
 *
 * The coherence rules are written against the crash-safe action protocol
 * (docs/tasks/TASK-004-autonomous-engineering-loop.md): every state a
 * legitimate crash window can leave behind MUST validate (a claim without a
 * run id, a run id without a review, a verdict without the phase change...),
 * while states no execution path can produce (a run id without its claim, a
 * verdict without a reviewer run, WAITING_FOR_HUMAN without an authoritative
 * review reference, EXHAUSTED whose stored budget is demonstrably not
 * exhausted, terminal outcome fields on an active loop...) are rejected.
 */

import { ACTOR_KINDS, type Actor } from "../domain/actor.js";
import { PersistenceCorruptionError } from "../domain/errors.js";
import { EVIDENCE_KINDS } from "../domain/evidence.js";
import { WORKER_TOOLS } from "../adapters/workers/workerModelConfig.js";
import {
  EXHAUSTION_KINDS,
  LOOP_OUTCOMES,
  LOOP_PHASES,
  LOOP_REVIEW_VERDICTS,
  WORKER_ACTION_KINDS,
  canonicalActionId,
  correlationTag,
  isTerminalLoopPhase,
  type EngineeringLoop,
  type LoopBudget,
  type LoopIterationRecord,
  type LoopPhase,
  type LoopWorkerConfig,
  type ReviewRecordClaim,
  type VerificationCommandConfig,
  type VerificationCommandResult,
  type WorkerActionClaim,
  type WorkerActionKind,
} from "./loopTypes.js";

function corrupt(context: string, message: string): never {
  throw new PersistenceCorruptionError(`${context}: ${message}`);
}

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    corrupt(context, `must be an object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
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
  if (typeof value !== "string" || value.length === 0) {
    corrupt(context, `field "${field}" must be a non-empty string when present, got ${JSON.stringify(value)}`);
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

function optionalBool(row: Record<string, unknown>, field: string, context: string): boolean | undefined {
  const value = row[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    corrupt(context, `field "${field}" must be a boolean when present, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** A timestamp: non-negative finite integer (epoch ms — see src/domain/time.ts). */
function timestamp(row: Record<string, unknown>, field: string, context: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    corrupt(context, `field "${field}" must be a non-negative integer timestamp, got ${JSON.stringify(value)}`);
  }
  return value;
}

function positiveInt(row: Record<string, unknown>, field: string, context: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    corrupt(context, `field "${field}" must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function nonNegativeInt(row: Record<string, unknown>, field: string, context: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    corrupt(context, `field "${field}" must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalPositiveInt(row: Record<string, unknown>, field: string, context: string): number | undefined {
  const value = row[field];
  if (value === undefined) return undefined;
  return positiveInt(row, field, context);
}

function oneOf<T extends string>(row: Record<string, unknown>, field: string, allowed: readonly T[], context: string): T {
  const value = row[field];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    corrupt(context, `field "${field}" must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
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
  if (value === undefined) return undefined;
  return oneOf(row, field, allowed, context);
}

function strArray(value: unknown, context: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    corrupt(context, `must be an array of strings, got ${JSON.stringify(value)}`);
  }
  return value as string[];
}

function parseActor(value: unknown, context: string): Actor {
  const row = asObject(value, context);
  return {
    id: str(row, "id", context),
    kind: oneOf(row, "kind", ACTOR_KINDS, context),
    displayName: str(row, "displayName", context),
  };
}

function parseBudget(value: unknown, context: string): LoopBudget {
  const row = asObject(value, context);
  const maxTotalRuns = optionalPositiveInt(row, "maxTotalRuns", context);
  const maxWallClockMs = optionalPositiveInt(row, "maxWallClockMs", context);
  const workerTimeoutMs = optionalPositiveInt(row, "workerTimeoutMs", context);
  const verificationTimeoutMs = optionalPositiveInt(row, "verificationTimeoutMs", context);
  return {
    maxIterations: positiveInt(row, "maxIterations", context),
    ...(maxTotalRuns === undefined ? {} : { maxTotalRuns }),
    ...(maxWallClockMs === undefined ? {} : { maxWallClockMs }),
    ...(workerTimeoutMs === undefined ? {} : { workerTimeoutMs }),
    ...(verificationTimeoutMs === undefined ? {} : { verificationTimeoutMs }),
  };
}

function parseWorkerConfig(value: unknown, context: string): LoopWorkerConfig {
  const row = asObject(value, context);
  const effort = optionalStr(row, "effort", context);
  const timeoutMs = optionalPositiveInt(row, "timeoutMs", context);
  return {
    tool: oneOf(row, "tool", WORKER_TOOLS, context),
    model: str(row, "model", context),
    ...(effort === undefined ? {} : { effort }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function parseVerificationCommand(value: unknown, context: string): VerificationCommandConfig {
  const row = asObject(value, context);
  const cwd = optionalStr(row, "cwd", context);
  const timeoutMs = optionalPositiveInt(row, "timeoutMs", context);
  const evidenceKind = optionalOneOf(row, "evidenceKind", EVIDENCE_KINDS, context);
  return {
    id: str(row, "id", context),
    executable: str(row, "executable", context),
    argv: strArray(row.argv, `${context}.argv`),
    ...(cwd === undefined ? {} : { cwd }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(evidenceKind === undefined ? {} : { evidenceKind }),
  };
}

function parseCommandResult(value: unknown, context: string): VerificationCommandResult {
  const row = asObject(value, context);
  const exitCode = row.exitCode;
  if (exitCode !== null && (typeof exitCode !== "number" || !Number.isInteger(exitCode))) {
    corrupt(context, `field "exitCode" must be an integer or null, got ${JSON.stringify(exitCode)}`);
  }
  return {
    commandId: str(row, "commandId", context),
    passed: bool(row, "passed", context),
    exitCode: exitCode as number | null,
    terminationReason: str(row, "terminationReason", context),
    durationMs: nonNegativeInt(row, "durationMs", context),
    stdoutTruncated: bool(row, "stdoutTruncated", context),
    stderrTruncated: bool(row, "stderrTruncated", context),
  };
}

function parseWorkerClaim(value: unknown, context: string): WorkerActionClaim {
  const row = asObject(value, context);
  const recovered = optionalBool(row, "recovered", context);
  const supersededRaw = row.supersededRunIds;
  const supersededRunIds = supersededRaw === undefined ? undefined : strArray(supersededRaw, `${context}.supersededRunIds`);
  return {
    actionId: str(row, "actionId", context),
    kind: oneOf(row, "kind", WORKER_ACTION_KINDS, context),
    attempt: positiveInt(row, "attempt", context),
    ownerToken: str(row, "ownerToken", context),
    claimedAt: timestamp(row, "claimedAt", context),
    correlationTag: str(row, "correlationTag", context),
    ...(recovered === undefined ? {} : { recovered }),
    ...(supersededRunIds === undefined ? {} : { supersededRunIds }),
  };
}

function parseReviewClaim(value: unknown, context: string): ReviewRecordClaim {
  const row = asObject(value, context);
  return {
    ownerToken: str(row, "ownerToken", context),
    claimedAt: timestamp(row, "claimedAt", context),
  };
}

/**
 * Recomputes the canonical actionId/correlationTag this claim is REQUIRED to
 * carry (remediation round 2, HIGH 2) and rejects any deviation. A claim's
 * identity is never trusted persisted text — it is derived from the exact
 * position (loop, iteration, kind) it was parsed from, so a corrupted row
 * cannot make a claim reference a different action's, a different loop's, a
 * different iteration's, or a superseded attempt's identity: there is
 * exactly one legal value for each position, computed here, not read.
 */
function validateCanonicalClaim(claim: WorkerActionClaim, loopId: string, iteration: number, kind: WorkerActionKind, ctx: string): void {
  const expectedActionId = canonicalActionId(loopId, iteration, kind);
  if (claim.actionId !== expectedActionId) {
    corrupt(
      ctx,
      `actionId ${JSON.stringify(claim.actionId)} does not match the canonical identity ${JSON.stringify(expectedActionId)} derived from (loop=${loopId}, iteration=${iteration}, kind=${kind}) — a claim's identity is never trusted persisted text`,
    );
  }
  const expectedTag = correlationTag(expectedActionId, claim.attempt);
  if (claim.correlationTag !== expectedTag) {
    corrupt(
      ctx,
      `correlationTag ${JSON.stringify(claim.correlationTag)} does not match the canonical tag ${JSON.stringify(expectedTag)} for attempt ${claim.attempt}`,
    );
  }
}

function parseIteration(value: unknown, index: number, loopId: string, context: string): LoopIterationRecord {
  const ctx = `${context}.iterations[${index}]`;
  const row = asObject(value, ctx);

  const iteration = positiveInt(row, "iteration", ctx);
  if (iteration !== index + 1) {
    corrupt(ctx, `iteration number ${iteration} at index ${index} breaks strict 1..n ordering (duplicates/gaps are impossible states)`);
  }

  const implementClaim = row.implementClaim === undefined ? undefined : parseWorkerClaim(row.implementClaim, `${ctx}.implementClaim`);
  if (implementClaim !== undefined) {
    validateCanonicalClaim(implementClaim, loopId, iteration, "IMPLEMENT", `${ctx}.implementClaim`);
  }
  const implementerRunId = optionalStr(row, "implementerRunId", ctx);
  const implementerOutcome = optionalOneOf(row, "implementerOutcome", ["SUCCEEDED", "FAILED"] as const, ctx);

  const verifyClaim = row.verifyClaim === undefined ? undefined : parseWorkerClaim(row.verifyClaim, `${ctx}.verifyClaim`);
  if (verifyClaim !== undefined) {
    validateCanonicalClaim(verifyClaim, loopId, iteration, "VERIFY", `${ctx}.verifyClaim`);
  }
  const verificationRunId = optionalStr(row, "verificationRunId", ctx);
  const resultsRaw = row.verificationCommandResults;
  const verificationCommandResults =
    resultsRaw === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(resultsRaw)) {
            corrupt(ctx, `field "verificationCommandResults" must be an array, got ${JSON.stringify(resultsRaw)}`);
          }
          return resultsRaw.map((entry, i) => parseCommandResult(entry, `${ctx}.verificationCommandResults[${i}]`));
        })();
  const deterministicReviewClaim =
    row.deterministicReviewClaim === undefined ? undefined : parseReviewClaim(row.deterministicReviewClaim, `${ctx}.deterministicReviewClaim`);
  const verificationReviewId = optionalStr(row, "verificationReviewId", ctx);
  const verificationPassed = optionalBool(row, "verificationPassed", ctx);

  const reviewClaim = row.reviewClaim === undefined ? undefined : parseWorkerClaim(row.reviewClaim, `${ctx}.reviewClaim`);
  if (reviewClaim !== undefined) {
    validateCanonicalClaim(reviewClaim, loopId, iteration, "REVIEW", `${ctx}.reviewClaim`);
  }
  const reviewerRunId = optionalStr(row, "reviewerRunId", ctx);
  const semanticReviewClaim =
    row.semanticReviewClaim === undefined ? undefined : parseReviewClaim(row.semanticReviewClaim, `${ctx}.semanticReviewClaim`);
  const reviewRecordId = optionalStr(row, "reviewRecordId", ctx);
  const reviewVerdict = optionalOneOf(row, "reviewVerdict", LOOP_REVIEW_VERDICTS, ctx);
  const findingsRaw = row.reviewFindings;
  const reviewFindings = findingsRaw === undefined ? undefined : strArray(findingsRaw, `${ctx}.reviewFindings`);
  const reviewParseError = optionalStr(row, "reviewParseError", ctx);

  // --- coherence: an action's artifacts can only exist downstream of its claim ---
  if (implementerRunId !== undefined && implementClaim === undefined) {
    corrupt(ctx, `implementerRunId without implementClaim: a run can only exist downstream of its durable claim`);
  }
  if (implementerOutcome !== undefined && implementerRunId === undefined) {
    corrupt(ctx, `implementerOutcome without implementerRunId`);
  }
  if (implementClaim !== undefined && implementClaim.kind !== "IMPLEMENT") {
    corrupt(ctx, `implementClaim has kind ${implementClaim.kind}, expected IMPLEMENT`);
  }
  if (verifyClaim !== undefined && verifyClaim.kind !== "VERIFY") {
    corrupt(ctx, `verifyClaim has kind ${verifyClaim.kind}, expected VERIFY`);
  }
  if (reviewClaim !== undefined && reviewClaim.kind !== "REVIEW") {
    corrupt(ctx, `reviewClaim has kind ${reviewClaim.kind}, expected REVIEW`);
  }
  if (verifyClaim !== undefined && implementerOutcome !== "SUCCEEDED") {
    corrupt(ctx, `verifyClaim can only exist after a SUCCEEDED implementer attempt`);
  }
  if (verificationRunId !== undefined && verifyClaim === undefined) {
    corrupt(ctx, `verificationRunId without verifyClaim`);
  }
  if (verificationCommandResults !== undefined && verificationRunId === undefined) {
    corrupt(ctx, `verificationCommandResults without verificationRunId`);
  }
  if (deterministicReviewClaim !== undefined && verificationRunId === undefined) {
    corrupt(ctx, `deterministicReviewClaim without a verification run to review`);
  }
  if (verificationReviewId !== undefined && verificationRunId === undefined) {
    corrupt(ctx, `verificationReviewId without verificationRunId`);
  }
  if (verificationPassed !== undefined && verificationReviewId === undefined) {
    corrupt(ctx, `verificationPassed without its recorded deterministic review (they are written atomically)`);
  }
  if (reviewClaim !== undefined && verificationPassed !== true) {
    corrupt(ctx, `reviewClaim can only exist after deterministic verification passed`);
  }
  if (reviewerRunId !== undefined && reviewClaim === undefined) {
    corrupt(ctx, `reviewerRunId without reviewClaim`);
  }
  if (semanticReviewClaim !== undefined && reviewerRunId === undefined) {
    corrupt(ctx, `semanticReviewClaim without a reviewer run`);
  }
  if (reviewVerdict !== undefined && reviewerRunId === undefined) {
    corrupt(ctx, `reviewVerdict without reviewerRunId`);
  }
  if (reviewRecordId !== undefined && reviewVerdict === undefined) {
    corrupt(ctx, `reviewRecordId without reviewVerdict (they are written atomically)`);
  }
  if (reviewVerdict !== undefined && reviewRecordId === undefined) {
    corrupt(ctx, `reviewVerdict without reviewRecordId (they are written atomically)`);
  }
  if (reviewVerdict !== undefined && reviewParseError !== undefined) {
    corrupt(ctx, `reviewVerdict and reviewParseError are mutually exclusive`);
  }
  if (reviewParseError !== undefined && reviewerRunId === undefined) {
    corrupt(ctx, `reviewParseError without reviewerRunId`);
  }

  return {
    iteration,
    ...(implementClaim === undefined ? {} : { implementClaim }),
    ...(implementerRunId === undefined ? {} : { implementerRunId }),
    ...(implementerOutcome === undefined ? {} : { implementerOutcome }),
    ...(verifyClaim === undefined ? {} : { verifyClaim }),
    ...(verificationRunId === undefined ? {} : { verificationRunId }),
    ...(verificationCommandResults === undefined ? {} : { verificationCommandResults }),
    ...(deterministicReviewClaim === undefined ? {} : { deterministicReviewClaim }),
    ...(verificationReviewId === undefined ? {} : { verificationReviewId }),
    ...(verificationPassed === undefined ? {} : { verificationPassed }),
    ...(reviewClaim === undefined ? {} : { reviewClaim }),
    ...(reviewerRunId === undefined ? {} : { reviewerRunId }),
    ...(semanticReviewClaim === undefined ? {} : { semanticReviewClaim }),
    ...(reviewRecordId === undefined ? {} : { reviewRecordId }),
    ...(reviewVerdict === undefined ? {} : { reviewVerdict }),
    ...(reviewFindings === undefined ? {} : { reviewFindings }),
    ...(reviewParseError === undefined ? {} : { reviewParseError }),
  };
}

/** Completed claimed-action worker runs recorded on this iteration. */
function completedActionCount(iteration: LoopIterationRecord): number {
  let count = 0;
  if (iteration.implementerRunId !== undefined) count += 1;
  if (iteration.verificationRunId !== undefined) count += 1;
  if (iteration.reviewerRunId !== undefined) count += 1;
  return count;
}

export interface ExpectedLoopRow {
  readonly id: string;
  readonly workItemId: string;
  readonly phase: string;
  readonly version: number;
}

export function parseEngineeringLoop(json: string, expected: ExpectedLoopRow): EngineeringLoop {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    corrupt("EngineeringLoop", `stored data is not valid JSON (${String(error)})`);
  }
  const context = `EngineeringLoop(${expected.id})`;
  const row = asObject(parsed, context);

  const id = str(row, "id", context);
  const workItemId = str(row, "workItemId", context);
  const version = positiveInt(row, "version", context);
  const phase = oneOf(row, "phase", LOOP_PHASES, context) as LoopPhase;

  // Indexed SQL columns must agree with the JSON payload — divergence means
  // the row was tampered with or written by something that is not this
  // adapter (HIGH 2 finding 5).
  if (id !== expected.id) corrupt(context, `SQL column "id" is ${JSON.stringify(expected.id)} but JSON says ${JSON.stringify(id)}`);
  if (workItemId !== expected.workItemId) {
    corrupt(context, `SQL column "work_item_id" is ${JSON.stringify(expected.workItemId)} but JSON says ${JSON.stringify(workItemId)}`);
  }
  if (phase !== expected.phase) {
    corrupt(context, `SQL column "phase" is ${JSON.stringify(expected.phase)} but JSON says ${JSON.stringify(phase)} — a row's indexed metadata must never disagree with its stored data`);
  }
  if (version !== expected.version) {
    corrupt(context, `SQL column "version" is ${JSON.stringify(expected.version)} but JSON says ${JSON.stringify(version)}`);
  }

  const budget = parseBudget(row.budget, `${context}.budget`);
  const implementer = parseWorkerConfig(row.implementer, `${context}.implementer`);
  const reviewer = parseWorkerConfig(row.reviewer, `${context}.reviewer`);

  const commandsRaw = row.verificationCommands;
  if (!Array.isArray(commandsRaw) || commandsRaw.length === 0) {
    corrupt(context, `field "verificationCommands" must be a non-empty array, got ${JSON.stringify(commandsRaw)}`);
  }
  const verificationCommands = commandsRaw.map((entry, i) => parseVerificationCommand(entry, `${context}.verificationCommands[${i}]`));

  const iterationsRaw = row.iterations;
  if (!Array.isArray(iterationsRaw)) {
    corrupt(context, `field "iterations" must be an array, got ${JSON.stringify(iterationsRaw)}`);
  }
  const iterations = iterationsRaw.map((entry, i) => parseIteration(entry, i, id, context));

  const totalRunCount = nonNegativeInt(row, "totalRunCount", context);
  const outcome = optionalOneOf(row, "outcome", LOOP_OUTCOMES, context);
  const failureReason = optionalStr(row, "failureReason", context);
  const exhaustionKind = optionalOneOf(row, "exhaustionKind", EXHAUSTION_KINDS, context);
  const cancelRequested = bool(row, "cancelRequested", context);
  const startedBy = parseActor(row.startedBy, `${context}.startedBy`);
  const workspaceRoot = str(row, "workspaceRoot", context);
  const taskInstructions = str(row, "taskInstructions", context);
  const startedAt = timestamp(row, "startedAt", context);
  const lastTransitionAt = timestamp(row, "lastTransitionAt", context);

  // --- loop-level coherence ---
  if (lastTransitionAt < startedAt) {
    corrupt(context, `lastTransitionAt (${lastTransitionAt}) precedes startedAt (${startedAt})`);
  }
  if (iterations.length > budget.maxIterations) {
    corrupt(context, `${iterations.length} iterations exceed the configured maxIterations of ${budget.maxIterations}`);
  }
  const expectedRunCount = iterations.reduce((sum, iteration) => sum + completedActionCount(iteration), 0);
  if (totalRunCount !== expectedRunCount) {
    corrupt(context, `totalRunCount ${totalRunCount} does not match the ${expectedRunCount} completed claimed-action runs on record`);
  }

  if (isTerminalLoopPhase(phase)) {
    if (outcome === undefined || outcome !== phase) {
      corrupt(context, `terminal phase ${phase} requires outcome ${phase}, got ${JSON.stringify(outcome)}`);
    }
  } else if (outcome !== undefined || failureReason !== undefined || exhaustionKind !== undefined) {
    corrupt(context, `active phase ${phase} must not carry terminal outcome fields`);
  }

  const last = iterations.at(-1);
  switch (phase) {
    case "READY":
      if (iterations.length !== 0) corrupt(context, `phase READY must have no iterations yet`);
      break;
    case "VERIFYING":
      if (last === undefined || last.implementerOutcome !== "SUCCEEDED") {
        corrupt(context, `phase VERIFYING requires the last iteration's implementer attempt to have SUCCEEDED`);
      }
      break;
    case "REVIEWING":
      if (last === undefined || last.verificationPassed !== true) {
        corrupt(context, `phase REVIEWING requires the last iteration's deterministic verification to have passed`);
      }
      break;
    case "WAITING_FOR_HUMAN":
      if (
        last === undefined ||
        last.reviewRecordId === undefined ||
        (last.reviewVerdict !== "PASS" && last.reviewVerdict !== "PASS_WITH_NON_BLOCKING_NOTES")
      ) {
        corrupt(
          context,
          `phase WAITING_FOR_HUMAN requires the last iteration to carry an authoritative passing review reference (reviewRecordId + PASS/PASS_WITH_NON_BLOCKING_NOTES verdict)`,
        );
      }
      break;
    case "EXHAUSTED": {
      if (failureReason === undefined) corrupt(context, `phase EXHAUSTED requires a failureReason`);
      if (exhaustionKind === undefined) corrupt(context, `phase EXHAUSTED requires an exhaustionKind`);
      if (exhaustionKind === "ITERATIONS" && iterations.length < budget.maxIterations) {
        corrupt(context, `EXHAUSTED(ITERATIONS) with only ${iterations.length}/${budget.maxIterations} iterations — the stored budget is not exhausted`);
      }
      if (exhaustionKind === "TOTAL_RUNS" && (budget.maxTotalRuns === undefined || totalRunCount < budget.maxTotalRuns)) {
        corrupt(context, `EXHAUSTED(TOTAL_RUNS) does not match the stored run counts/budget`);
      }
      if (exhaustionKind === "WALL_CLOCK" && budget.maxWallClockMs === undefined) {
        corrupt(context, `EXHAUSTED(WALL_CLOCK) without a configured maxWallClockMs`);
      }
      break;
    }
    case "FAILED":
      if (failureReason === undefined) corrupt(context, `phase FAILED requires a failureReason`);
      break;
    case "RECOVERY_REQUIRED":
      if (failureReason === undefined) corrupt(context, `phase RECOVERY_REQUIRED requires a failureReason`);
      break;
    case "CANCELLED":
      if (!cancelRequested) corrupt(context, `phase CANCELLED requires cancelRequested to be true`);
      break;
    case "IMPLEMENTING":
      if (iterations.length === 0) corrupt(context, `phase IMPLEMENTING requires at least one (possibly open) iteration`);
      break;
  }

  return {
    id,
    workItemId,
    version,
    phase,
    budget,
    implementer,
    reviewer,
    verificationCommands,
    workspaceRoot,
    taskInstructions,
    iterations,
    totalRunCount,
    ...(outcome === undefined ? {} : { outcome }),
    ...(failureReason === undefined ? {} : { failureReason }),
    ...(exhaustionKind === undefined ? {} : { exhaustionKind }),
    cancelRequested,
    startedBy,
    startedAt,
    lastTransitionAt,
  };
}

export function encodeEngineeringLoop(loop: EngineeringLoop): string {
  return JSON.stringify(loop);
}
