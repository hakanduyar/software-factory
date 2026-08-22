/**
 * Strict parse/validation for persisted Plan rows (TASK-005 §12).
 *
 * A plan row is untrusted input the moment it comes from disk: it decides which
 * work items get created and which external AI actions run next, so
 * `JSON.parse(...) as Plan` is not runtime validation. Every field the planning
 * state machine branches on is checked here — shapes, enums, ranges, and
 * cross-field coherence — and a row that could only exist through corruption or
 * tampering throws `PersistenceCorruptionError` rather than becoming a value
 * that merely satisfies TypeScript's structural type check.
 *
 * Three checks here are load-bearing beyond ordinary shape validation:
 *
 * 1. EVERY REVISION'S DIGEST IS RECOMPUTED. A stored `contentDigest` is never
 *    trusted; it must equal the hash of the content stored alongside it. This
 *    is what makes "the approved content cannot change" enforceable rather than
 *    aspirational — edited plan content cannot even load, let alone execute.
 *
 * 2. EVERY CORRELATION TAG IS RECOMPUTED. Materialization claims and mappings
 *    carry derived identities (`canonicalCorrelationTag`), so a corrupted row
 *    cannot point one plan item's mapping at another item's — or another
 *    plan's — work item. Same lesson as TASK-004 round 2.
 *
 * 3. THE APPROVAL TRIPLE IS COHERENT. `approvalId`, `approvedRevision` and
 *    `approvedDigest` are all-or-nothing, the revision must exist, and the
 *    digest must match that revision. A half-written approval is corruption,
 *    not "probably fine".
 *
 * The coherence rules are written against the crash windows the design
 * documents: every state a legitimate crash can leave behind MUST validate (a
 * claim with no mapping yet, a mapping not yet readied, a readied item not yet
 * dispatched), while states no execution path can produce are rejected.
 */

import { ACTOR_KINDS, type Actor } from "../domain/actor.js";
import { PersistenceCorruptionError } from "../domain/errors.js";
import { PRIORITIES, WORK_ITEM_TYPES } from "../domain/workItem.js";
import { approvalDigestOfPlan, digestOfRevision } from "./planDigest.js";
import {
  ACTIVE_PLAN_PHASES,
  PLAN_EVENT_KINDS,
  PLAN_EXHAUSTION_KINDS,
  PLAN_OUTCOMES,
  PLAN_PHASES,
  PLANNER_ACTION_STATES,
  canonicalCorrelationTag,
  canonicalPlannerActionTag,
  isTerminalPlanPhase,
  type PlannerAction,
  type PlannerActionState,
  type ClarificationAnswer,
  type ClarificationQuestion,
  type DispatchClaim,
  type DispatchRecord,
  type MaterializationClaim,
  type MaterializedItem,
  type Plan,
  type PlanBudget,
  type PlanEvent,
  type PlanExecutionConfig,
  type PlannedWorkItem,
  type PlannerConfig,
  type PlanPhase,
  type PlanRevision,
} from "./planTypes.js";

function corrupt(context: string, message: string): never {
  throw new PersistenceCorruptionError(`${context}: ${message}`);
}

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    corrupt(context, `must be an object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, context: string): readonly unknown[] {
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

/** Allows the empty string, which several legitimately-optional text fields use. */
function anyStr(row: Record<string, unknown>, field: string, context: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    corrupt(context, `field "${field}" must be a string, got ${JSON.stringify(value)}`);
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
  return row[field] === undefined ? undefined : positiveInt(row, field, context);
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
  return row[field] === undefined ? undefined : oneOf(row, field, allowed, context);
}

function strArray(value: unknown, context: string): readonly string[] {
  const entries = asArray(value, context);
  if (entries.some((entry) => typeof entry !== "string")) {
    corrupt(context, `must be an array of strings, got ${JSON.stringify(value)}`);
  }
  return entries as readonly string[];
}

function parseActor(value: unknown, context: string): Actor {
  const row = asObject(value, context);
  return {
    id: str(row, "id", context),
    kind: oneOf(row, "kind", ACTOR_KINDS, context),
    displayName: str(row, "displayName", context),
  };
}

function parseBudget(value: unknown, context: string): PlanBudget {
  const row = asObject(value, context);
  const maxWallClockMs = optionalPositiveInt(row, "maxWallClockMs", context);
  return {
    maxPlannerAttempts: positiveInt(row, "maxPlannerAttempts", context),
    maxClarificationCycles: nonNegativeInt(row, "maxClarificationCycles", context),
    maxTotalPlannerRuns: positiveInt(row, "maxTotalPlannerRuns", context),
    ...(maxWallClockMs === undefined ? {} : { maxWallClockMs }),
  };
}

function parsePlannerConfig(value: unknown, context: string): PlannerConfig {
  const row = asObject(value, context);
  const effort = optionalStr(row, "effort", context);
  const timeoutMs = optionalPositiveInt(row, "timeoutMs", context);
  return {
    tool: str(row, "tool", context),
    model: str(row, "model", context),
    ...(effort === undefined ? {} : { effort }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function parseExecutionConfig(value: unknown, context: string): PlanExecutionConfig {
  const row = asObject(value, context);
  const commands = asArray(row.verificationCommands, `${context}.verificationCommands`).map((entry, index) => {
    const commandContext = `${context}.verificationCommands[${index}]`;
    const command = asObject(entry, commandContext);
    const cwd = optionalStr(command, "cwd", commandContext);
    const timeoutMs = optionalPositiveInt(command, "timeoutMs", commandContext);
    return {
      id: str(command, "id", commandContext),
      executable: str(command, "executable", commandContext),
      argv: strArray(command.argv, `${commandContext}.argv`),
      ...(cwd === undefined ? {} : { cwd }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  });
  if (commands.length === 0) {
    corrupt(context, "verificationCommands must declare at least one deterministic command");
  }

  let loopBudget: PlanExecutionConfig["loopBudget"];
  if (row.loopBudget !== undefined) {
    const budgetContext = `${context}.loopBudget`;
    const budgetRow = asObject(row.loopBudget, budgetContext);
    const maxIterations = optionalPositiveInt(budgetRow, "maxIterations", budgetContext);
    const maxTotalRuns = optionalPositiveInt(budgetRow, "maxTotalRuns", budgetContext);
    const maxWallClockMs = optionalPositiveInt(budgetRow, "maxWallClockMs", budgetContext);
    const workerTimeoutMs = optionalPositiveInt(budgetRow, "workerTimeoutMs", budgetContext);
    const verificationTimeoutMs = optionalPositiveInt(budgetRow, "verificationTimeoutMs", budgetContext);
    loopBudget = {
      ...(maxIterations === undefined ? {} : { maxIterations }),
      ...(maxTotalRuns === undefined ? {} : { maxTotalRuns }),
      ...(maxWallClockMs === undefined ? {} : { maxWallClockMs }),
      ...(workerTimeoutMs === undefined ? {} : { workerTimeoutMs }),
      ...(verificationTimeoutMs === undefined ? {} : { verificationTimeoutMs }),
    };
  }

  return {
    implementer: parsePlannerConfig(row.implementer, `${context}.implementer`),
    reviewer: parsePlannerConfig(row.reviewer, `${context}.reviewer`),
    verificationCommands: commands,
    workspaceRoot: str(row, "workspaceRoot", context),
    ...(loopBudget === undefined ? {} : { loopBudget }),
  };
}

function parsePlannedItem(value: unknown, context: string): PlannedWorkItem {
  const row = asObject(value, context);
  const criteria = asArray(row.acceptanceCriteria, `${context}.acceptanceCriteria`).map((entry, index) => {
    const criterionContext = `${context}.acceptanceCriteria[${index}]`;
    const criterion = asObject(entry, criterionContext);
    return {
      text: str(criterion, "text", criterionContext),
      verificationHint: str(criterion, "verificationHint", criterionContext),
    };
  });
  if (criteria.length === 0) {
    corrupt(context, "a planned work item must declare at least one acceptance criterion (C2/C3)");
  }
  return {
    key: str(row, "key", context),
    title: str(row, "title", context),
    type: oneOf(row, "type", WORK_ITEM_TYPES, context),
    priority: oneOf(row, "priority", PRIORITIES, context),
    spec: str(row, "spec", context),
    acceptanceCriteria: criteria,
    dependsOn: strArray(row.dependsOn, `${context}.dependsOn`),
  };
}

function parseRevision(value: unknown, index: number, planContext: string): PlanRevision {
  const context = `${planContext}.revisions[${index}]`;
  const row = asObject(value, context);
  const items = asArray(row.items, `${context}.items`).map((entry, itemIndex) =>
    parsePlannedItem(entry, `${context}.items[${itemIndex}]`),
  );
  if (items.length === 0) {
    corrupt(context, "a persisted revision must contain at least one work item");
  }

  const revision: PlanRevision = {
    revision: positiveInt(row, "revision", context),
    summary: str(row, "summary", context),
    assumptions: strArray(row.assumptions, `${context}.assumptions`),
    constraints: strArray(row.constraints, `${context}.constraints`),
    risks: strArray(row.risks, `${context}.risks`),
    items,
    contentDigest: str(row, "contentDigest", context),
    plannerRunRef: str(row, "plannerRunRef", context),
    generatedAt: timestamp(row, "generatedAt", context),
  };

  // CHECK 1 (see module docs): the stored digest is never trusted.
  const recomputed = digestOfRevision(revision);
  if (recomputed !== revision.contentDigest) {
    corrupt(
      context,
      `stored contentDigest ${revision.contentDigest} does not match the digest of the stored content (${recomputed}); ` +
        `approved plan content may not be edited`,
    );
  }

  // Item keys must be unique and every dependency must exist: a persisted plan
  // with a dangling dependency could otherwise stall dispatch forever.
  const keys = new Set<string>();
  for (const item of items) {
    if (keys.has(item.key)) {
      corrupt(context, `duplicate work item key "${item.key}"`);
    }
    keys.add(item.key);
  }
  for (const item of items) {
    for (const dependency of item.dependsOn) {
      if (dependency === item.key) {
        corrupt(context, `work item "${item.key}" depends on itself`);
      }
      if (!keys.has(dependency)) {
        corrupt(context, `work item "${item.key}" depends on "${dependency}", which is not part of this revision`);
      }
    }
  }

  return revision;
}

function parseQuestion(value: unknown, context: string): ClarificationQuestion {
  const row = asObject(value, context);
  return {
    id: str(row, "id", context),
    question: str(row, "question", context),
    why: str(row, "why", context),
  };
}

function parseAnswer(value: unknown, context: string): ClarificationAnswer {
  const row = asObject(value, context);
  return {
    questionId: str(row, "questionId", context),
    askedAtCycle: positiveInt(row, "askedAtCycle", context),
    askedAtRevision: nonNegativeInt(row, "askedAtRevision", context),
    question: str(row, "question", context),
    answer: str(row, "answer", context),
    answeredBy: parseActor(row.answeredBy, `${context}.answeredBy`),
    answeredAt: timestamp(row, "answeredAt", context),
  };
}

function parseEvent(value: unknown, index: number, planContext: string): PlanEvent {
  const context = `${planContext}.events[${index}]`;
  const row = asObject(value, context);
  return {
    seq: positiveInt(row, "seq", context),
    kind: oneOf(row, "kind", PLAN_EVENT_KINDS, context),
    detail: anyStr(row, "detail", context),
    at: timestamp(row, "at", context),
  };
}

export interface PlanRowColumns {
  readonly id: string;
  readonly projectId: string;
  readonly requestKey: string;
  readonly phase: string;
  readonly version: number;
}

/**
 * Parses and fully validates one persisted plan row.
 *
 * `columns` are the SQL columns the adapter queries and enforces invariants on.
 * They are cross-checked against the JSON body: a row whose indexed columns
 * disagree with its payload is corruption, and trusting either half silently
 * would mean a query could select a plan whose contents say something else.
 */
export function parsePlan(json: string, columns: PlanRowColumns): Plan {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    corrupt(`plan ${columns.id}`, `data column is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const context = `plan ${columns.id}`;
  const row = asObject(raw, context);

  const id = str(row, "id", context);
  const projectId = str(row, "projectId", context);
  const requestKey = str(row, "requestKey", context);
  const phase = oneOf<PlanPhase>(row, "phase", PLAN_PHASES, context);
  const version = positiveInt(row, "version", context);

  if (id !== columns.id) corrupt(context, `data.id ${id} does not match the row id ${columns.id}`);
  if (projectId !== columns.projectId) corrupt(context, `data.projectId ${projectId} does not match the row project_id ${columns.projectId}`);
  if (requestKey !== columns.requestKey) corrupt(context, `data.requestKey ${requestKey} does not match the row request_key ${columns.requestKey}`);
  if (phase !== columns.phase) corrupt(context, `data.phase ${phase} does not match the row phase ${columns.phase}`);
  if (version !== columns.version) corrupt(context, `data.version ${version} does not match the row version ${columns.version}`);

  const revisions = asArray(row.revisions, `${context}.revisions`).map((entry, index) => parseRevision(entry, index, context));
  // Revisions are append-only and strictly 1..n with no gaps, which is what
  // makes "approval of N cannot authorize N+1" a checkable statement.
  revisions.forEach((revision, index) => {
    if (revision.revision !== index + 1) {
      corrupt(context, `revisions must be numbered strictly 1..n in order; entry ${index} is revision ${revision.revision}`);
    }
  });

  const events = asArray(row.events, `${context}.events`).map((entry, index) => parseEvent(entry, index, context));
  events.forEach((event, index) => {
    if (event.seq !== index + 1) {
      corrupt(context, `events must be numbered strictly 1..n in order; entry ${index} has seq ${event.seq}`);
    }
  });

  const openQuestions = asArray(row.openQuestions, `${context}.openQuestions`).map((entry, index) =>
    parseQuestion(entry, `${context}.openQuestions[${index}]`),
  );
  const answers = asArray(row.answers, `${context}.answers`).map((entry, index) =>
    parseAnswer(entry, `${context}.answers[${index}]`),
  );
  // Answer lineage, held to the same standard as every other reference in this
  // file. `planTypes.ts` states that an answer binds to the revision that ASKED
  // and that a stale answer cannot be applied; the service enforces that on the
  // write path, so persistence must re-prove it on the read path rather than
  // trusting that the only writer was well-behaved.
  const clarificationCycles = nonNegativeInt(row, "clarificationCycles", context);
  const answered = new Set<string>();
  for (const answer of answers) {
    // `(questionId, askedAtCycle)` is the key, not the id alone: a planner may
    // reuse "q1" in a later round, so id-only uniqueness would reject a
    // perfectly legitimate multi-round clarification history.
    const key = `${answer.askedAtCycle}:${answer.questionId}`;
    if (answered.has(key)) {
      corrupt(context, `question "${answer.questionId}" is answered more than once in clarification round ${answer.askedAtCycle}`);
    }
    answered.add(key);
    if (answer.askedAtCycle < 1 || answer.askedAtCycle > clarificationCycles) {
      corrupt(
        context,
        `answer to "${answer.questionId}" claims clarification round ${answer.askedAtCycle}, but this plan has completed ${clarificationCycles} round(s)`,
      );
    }
    if (answer.askedAtRevision > revisions.length) {
      corrupt(
        context,
        `answer to "${answer.questionId}" claims it was asked at revision ${answer.askedAtRevision}, but this plan has only ${revisions.length} revision(s)`,
      );
    }
  }
  const openIds = new Set<string>();
  for (const question of openQuestions) {
    if (openIds.has(question.id)) {
      corrupt(context, `question id "${question.id}" is open more than once`);
    }
    openIds.add(question.id);
  }

  const approvalId = optionalStr(row, "approvalId", context);
  const approvedRevision = optionalPositiveInt(row, "approvedRevision", context);
  const approvedDigest = optionalStr(row, "approvedDigest", context);

  // CHECK 3: the approval triple is all-or-nothing and internally consistent.
  const approvalParts = [approvalId, approvedRevision, approvedDigest].filter((part) => part !== undefined).length;
  if (approvalParts !== 0 && approvalParts !== 3) {
    corrupt(context, "approvalId, approvedRevision and approvedDigest must all be present or all absent");
  }
  if (approvedRevision !== undefined) {
    const target = revisions.find((revision) => revision.revision === approvedRevision);
    if (target === undefined) {
      corrupt(context, `approvedRevision ${approvedRevision} does not exist in this plan`);
    }
    // A newer revision alongside a recorded approval is an impossible lineage:
    // no phase from APPROVED onwards can run the planner, and no pre-approval
    // phase may carry an approvalId (checked below). The digest itself is
    // verified once the whole plan value exists — it covers plan-level
    // configuration too (remediation round 1, HIGH 4).
    if (revisions.length !== approvedRevision) {
      corrupt(
        context,
        `approvedRevision ${approvedRevision} is superseded: ${revisions.length} revision(s) exist, and no revision can be generated after approval`,
      );
    }
  }

  // The in-flight planner lease (remediation round 1, HIGH 5). Its identity is
  // derived, so it is recomputed rather than trusted — a stored lease cannot be
  // made to name another attempt's action.
  let plannerAction: PlannerAction | undefined;
  if (row.plannerAction !== undefined) {
    const actionContext = `${context}.plannerAction`;
    const actionRow = asObject(row.plannerAction, actionContext);
    plannerAction = {
      revision: positiveInt(actionRow, "revision", actionContext),
      attempt: positiveInt(actionRow, "attempt", actionContext),
      correlationTag: str(actionRow, "correlationTag", actionContext),
      ownerId: str(actionRow, "ownerId", actionContext),
      state: oneOf<PlannerActionState>(actionRow, "state", PLANNER_ACTION_STATES, actionContext),
      claimedAt: timestamp(actionRow, "claimedAt", actionContext),
    };
    const expectedTag = canonicalPlannerActionTag(id, plannerAction.revision, plannerAction.attempt);
    if (plannerAction.correlationTag !== expectedTag) {
      corrupt(actionContext, `correlationTag ${plannerAction.correlationTag} is not the canonical ${expectedTag}`);
    }
    if (plannerAction.revision !== revisions.length + 1) {
      corrupt(
        actionContext,
        `lease is for revision ${plannerAction.revision}, but this plan has ${revisions.length} revision(s) and can only be generating ${revisions.length + 1}`,
      );
    }
  }

  let materializationClaim: MaterializationClaim | undefined;
  if (row.materializationClaim !== undefined) {
    const claimContext = `${context}.materializationClaim`;
    const claimRow = asObject(row.materializationClaim, claimContext);
    materializationClaim = {
      planItemKey: str(claimRow, "planItemKey", claimContext),
      correlationTag: str(claimRow, "correlationTag", claimContext),
      claimedAt: timestamp(claimRow, "claimedAt", claimContext),
    };
  }

  const materialized = asArray(row.materialized, `${context}.materialized`).map((entry, index) => {
    const itemContext = `${context}.materialized[${index}]`;
    const itemRow = asObject(entry, itemContext);
    const record: MaterializedItem = {
      planItemKey: str(itemRow, "planItemKey", itemContext),
      workItemId: str(itemRow, "workItemId", itemContext),
      correlationTag: str(itemRow, "correlationTag", itemContext),
      materializedAt: timestamp(itemRow, "materializedAt", itemContext),
      readied: bool(itemRow, "readied", itemContext),
    };
    return record;
  });

  let dispatchClaim: DispatchClaim | undefined;
  if (row.dispatchClaim !== undefined) {
    const claimContext = `${context}.dispatchClaim`;
    const claimRow = asObject(row.dispatchClaim, claimContext);
    dispatchClaim = {
      planItemKey: str(claimRow, "planItemKey", claimContext),
      workItemId: str(claimRow, "workItemId", claimContext),
      claimedAt: timestamp(claimRow, "claimedAt", claimContext),
    };
  }

  const dispatches = asArray(row.dispatches, `${context}.dispatches`).map((entry, index) => {
    const dispatchContext = `${context}.dispatches[${index}]`;
    const dispatchRow = asObject(entry, dispatchContext);
    const record: DispatchRecord = {
      planItemKey: str(dispatchRow, "planItemKey", dispatchContext),
      workItemId: str(dispatchRow, "workItemId", dispatchContext),
      loopId: str(dispatchRow, "loopId", dispatchContext),
      dispatchedAt: timestamp(dispatchRow, "dispatchedAt", dispatchContext),
      adopted: bool(dispatchRow, "adopted", dispatchContext),
    };
    return record;
  });

  // CHECK 2: derived identities are recomputed, never trusted. Materialization
  // only ever happens against the approved revision, so that is the only
  // revision a legitimate correlation tag can name.
  if (materializationClaim !== undefined || materialized.length > 0) {
    if (approvedRevision === undefined) {
      corrupt(context, "materialization state exists without an approved revision; work may not be created before approval");
    }
    const approvedItems = new Set(
      (revisions.find((revision) => revision.revision === approvedRevision)?.items ?? []).map((item) => item.key),
    );
    if (materializationClaim !== undefined) {
      if (!approvedItems.has(materializationClaim.planItemKey)) {
        corrupt(context, `materialization claim names plan item "${materializationClaim.planItemKey}", which is not in the approved revision`);
      }
      const expected = canonicalCorrelationTag(id, approvedRevision, materializationClaim.planItemKey);
      if (materializationClaim.correlationTag !== expected) {
        corrupt(context, `materialization claim tag ${materializationClaim.correlationTag} is not the canonical ${expected}`);
      }
    }
    const seenKeys = new Set<string>();
    const seenWorkItems = new Set<string>();
    for (const record of materialized) {
      if (!approvedItems.has(record.planItemKey)) {
        corrupt(context, `materialized mapping names plan item "${record.planItemKey}", which is not in the approved revision`);
      }
      if (seenKeys.has(record.planItemKey)) {
        corrupt(context, `plan item "${record.planItemKey}" is materialized more than once`);
      }
      seenKeys.add(record.planItemKey);
      if (seenWorkItems.has(record.workItemId)) {
        corrupt(context, `work item ${record.workItemId} is mapped to more than one plan item`);
      }
      seenWorkItems.add(record.workItemId);
      const expected = canonicalCorrelationTag(id, approvedRevision, record.planItemKey);
      if (record.correlationTag !== expected) {
        corrupt(context, `materialized mapping tag ${record.correlationTag} is not the canonical ${expected}`);
      }
    }
  }

  // Dispatch may only reference an item that is materialized AND readied: a
  // loop can only legally start from READY, so a dispatch of anything else is
  // an impossible lineage rather than a crash window.
  const readiedByKey = new Map(materialized.map((record) => [record.planItemKey, record]));
  if (dispatchClaim !== undefined) {
    const claimed = readiedByKey.get(dispatchClaim.planItemKey);
    if (claimed === undefined) {
      corrupt(context, `dispatch claim references plan item "${dispatchClaim.planItemKey}", which is not materialized`);
    }
    if (claimed.workItemId !== dispatchClaim.workItemId) {
      corrupt(
        context,
        `dispatch claim for "${dispatchClaim.planItemKey}" names work item ${dispatchClaim.workItemId}, but the mapping names ${claimed.workItemId}`,
      );
    }
    if (!claimed.readied) {
      corrupt(context, `dispatch claim references plan item "${dispatchClaim.planItemKey}", which was never readied`);
    }
  }
  // THE PERSISTENCE / RUNTIME BOUNDARY for foreign references (round 2).
  //
  // This file may prove everything that is decidable from the row ITSELF:
  // key coherence, that a dispatch's work item agrees with its own
  // materialization mapping, loop-id uniqueness and shape, and legal
  // phase/state relationships. It may NOT ask whether the referenced
  // EngineeringLoop exists or belongs to that work item — that lives in
  // another store, and a decoder that reaches across stores would make
  // "can this row be read" depend on live external state, so a transient
  // outage would look identical to corruption.
  //
  // Cross-store LINEAGE is therefore proved at use time by
  // `PlanningService.resolveDispatchViews`, which fails closed to
  // RECOVERY_REQUIRED rather than refusing to load. Same split as the
  // materialized mappings above.
  const dispatchedKeys = new Set<string>();
  const dispatchedLoopIds = new Set<string>();
  for (const dispatch of dispatches) {
    if (dispatch.loopId.trim().length === 0) {
      corrupt(context, `dispatch for "${dispatch.planItemKey}" records an empty loop id`);
    }
    // Held to the same standard as `materialized`, which enforces uniqueness on
    // both sides of its mapping: two plan items claiming one engineering loop
    // is impossible under TASK-004's one-active-loop-per-work-item constraint,
    // so a row asserting it is corruption.
    if (dispatchedLoopIds.has(dispatch.loopId)) {
      corrupt(context, `loop ${dispatch.loopId} is claimed by more than one plan item`);
    }
    dispatchedLoopIds.add(dispatch.loopId);
    const mapping = readiedByKey.get(dispatch.planItemKey);
    if (mapping === undefined) {
      corrupt(context, `dispatch references plan item "${dispatch.planItemKey}", which is not materialized`);
    }
    if (mapping.workItemId !== dispatch.workItemId) {
      corrupt(
        context,
        `dispatch for "${dispatch.planItemKey}" names work item ${dispatch.workItemId}, but the mapping names ${mapping.workItemId}`,
      );
    }
    if (!mapping.readied) {
      corrupt(context, `dispatch references plan item "${dispatch.planItemKey}", which was never readied`);
    }
    if (dispatchedKeys.has(dispatch.planItemKey)) {
      corrupt(context, `plan item "${dispatch.planItemKey}" is dispatched more than once`);
    }
    dispatchedKeys.add(dispatch.planItemKey);
  }

  const outcome = optionalOneOf(row, "outcome", PLAN_OUTCOMES, context);
  const failureReason = optionalStr(row, "failureReason", context);
  const exhaustionKind = optionalOneOf(row, "exhaustionKind", PLAN_EXHAUSTION_KINDS, context);

  // An active plan claims no outcome; a terminal one must state which.
  if (!isTerminalPlanPhase(phase) && phase !== "BLOCKED" && outcome !== undefined) {
    corrupt(context, `phase ${phase} is not terminal but an outcome ${outcome} is recorded`);
  }
  if (isTerminalPlanPhase(phase) && outcome === undefined) {
    corrupt(context, `phase ${phase} is terminal but no outcome is recorded`);
  }

  // Phases that presuppose an approval must have one. WAITING_FOR_HUMAN and
  // COMPLETED are reachable only through materialization, which is reachable
  // only through approval, so they belong here too — a plan claiming its work
  // finished without ever having been approved is an impossible lineage.
  const PHASES_REQUIRING_APPROVAL: readonly string[] = [
    "APPROVED",
    "MATERIALIZING",
    "EXECUTING",
    "WAITING_FOR_HUMAN",
    "COMPLETED",
  ];
  if (PHASES_REQUIRING_APPROVAL.includes(phase) && approvalId === undefined) {
    corrupt(context, `phase ${phase} presupposes a recorded plan approval, but none is stored`);
  }
  // ...and phases before approval must not.
  if ((phase === "DRAFT" || phase === "PLANNING" || phase === "NEEDS_CLARIFICATION" || phase === "PLAN_REVIEW") && approvalId !== undefined) {
    corrupt(context, `phase ${phase} precedes approval, but an approval ${approvalId} is stored`);
  }
  if (phase === "NEEDS_CLARIFICATION" && openQuestions.length === 0) {
    corrupt(context, "phase NEEDS_CLARIFICATION presupposes at least one open question, but none is stored");
  }
  // A planner lease exists exactly while PLANNING — the invariant `commit`
  // maintains on the write path, re-proved here on the read path.
  if (phase === "PLANNING" && plannerAction === undefined) {
    corrupt(context, "phase PLANNING presupposes an in-flight planner lease, but none is stored");
  }
  if (phase !== "PLANNING" && plannerAction !== undefined) {
    corrupt(context, `phase ${phase} cannot hold a planner lease, but attempt ${plannerAction.attempt} is stored`);
  }
  if (plannerAction !== undefined && plannerAction.attempt !== nonNegativeInt(row, "attemptsForCurrentRevision", context)) {
    corrupt(
      context,
      `planner lease is attempt ${plannerAction.attempt}, but attemptsForCurrentRevision is ${nonNegativeInt(row, "attemptsForCurrentRevision", context)}`,
    );
  }
  // Every active phase except the three that legitimately precede a generated
  // plan (DRAFT, PLANNING, NEEDS_CLARIFICATION) presupposes a revision. Stated
  // once, rather than repeating the PLAN_REVIEW case separately.
  const PRE_REVISION_PHASES: readonly string[] = ["DRAFT", "PLANNING", "NEEDS_CLARIFICATION"];
  if ((ACTIVE_PLAN_PHASES as readonly string[]).includes(phase) && !PRE_REVISION_PHASES.includes(phase) && revisions.length === 0) {
    corrupt(context, `phase ${phase} presupposes a generated revision, but none is stored`);
  }

  const plan: Plan = {
    id,
    projectId,
    requestKey,
    version,
    phase,
    intent: str(row, "intent", context),
    declaredConstraints: strArray(row.declaredConstraints, `${context}.declaredConstraints`),
    budget: parseBudget(row.budget, `${context}.budget`),
    planner: parsePlannerConfig(row.planner, `${context}.planner`),
    execution: parseExecutionConfig(row.execution, `${context}.execution`),
    revisions,
    openQuestions,
    answers,
    ...(plannerAction === undefined ? {} : { plannerAction }),
    attemptsForCurrentRevision: nonNegativeInt(row, "attemptsForCurrentRevision", context),
    clarificationCycles,
    totalPlannerRuns: nonNegativeInt(row, "totalPlannerRuns", context),
    ...(approvalId === undefined ? {} : { approvalId }),
    ...(approvedRevision === undefined ? {} : { approvedRevision }),
    ...(approvedDigest === undefined ? {} : { approvedDigest }),
    ...(materializationClaim === undefined ? {} : { materializationClaim }),
    materialized,
    ...(dispatchClaim === undefined ? {} : { dispatchClaim }),
    dispatches,
    ...(outcome === undefined ? {} : { outcome }),
    ...(failureReason === undefined ? {} : { failureReason }),
    ...(exhaustionKind === undefined ? {} : { exhaustionKind }),
    cancelRequested: bool(row, "cancelRequested", context),
    events,
    startedBy: parseActor(row.startedBy, `${context}.startedBy`),
    startedAt: timestamp(row, "startedAt", context),
    lastTransitionAt: timestamp(row, "lastTransitionAt", context),
  };

  // CHECK 3 (completed). The approved digest is recomputed here — where the
  // whole plan value finally exists — because remediation round 1 proved a
  // revision-only digest is not what a human approves: `projectId` and the
  // `execution` configuration decide where work is created and which commands
  // verify it, and independent review changed both while the approval stayed
  // valid. Tampering with either now fails to load at all.
  if (plan.approvedRevision !== undefined && plan.approvedDigest !== undefined) {
    const approved = plan.revisions.find((revision) => revision.revision === plan.approvedRevision);
    if (approved === undefined) {
      corrupt(context, `approvedRevision ${plan.approvedRevision} does not exist in this plan`);
    }
    const expected = approvalDigestOfPlan(plan, approved);
    if (expected !== plan.approvedDigest) {
      corrupt(
        context,
        `approvedDigest ${plan.approvedDigest} does not match this plan's approved content and configuration (recomputed ${expected})`,
      );
    }
  }

  return plan;
}

export function encodePlan(plan: Plan): string {
  return JSON.stringify(plan);
}
