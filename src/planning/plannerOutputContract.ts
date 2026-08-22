/**
 * Strict, fail-closed planner output parser (TASK-005 §7.3).
 *
 * This is the deterministic boundary between "a model said something" and
 * "the Factory has a plan". Everything on the model's side of it is untrusted
 * text; nothing crosses without satisfying an exact machine-readable contract.
 *
 * It applies, deliberately, the same defensive discipline
 * `src/orchestration/reviewVerdictParser.ts` established after TASK-004
 * review:
 *
 *  - an exact, whole-line marker is required — prose mentioning the marker
 *    inline can never be mistaken for one;
 *  - MORE THAN ONE marker is rejected as ambiguous, not silently resolved by
 *    taking the first. Ambiguity is refused, not guessed;
 *  - every field is validated against an explicit schema, and UNKNOWN KEYS ARE
 *    REJECTED at every level. That last rule is what structurally prevents
 *    authority smuggling: there is no field a planner could add that the
 *    Factory would carry forward, because any field the contract does not name
 *    fails the parse outright;
 *  - a planner that emits a `FACTORY_REVIEW_VERDICT:` tag is rejected outright,
 *    so planner output can never plant a reviewer verdict that a later stage
 *    might read out of evidence;
 *  - malformed output produces a REASON, never a partial plan. The caller
 *    spends a bounded attempt and, on exhaustion, fails closed.
 *
 * This function is pure (no I/O) and must only ever be invoked for a planner
 * action whose process-level status was SUCCEEDED — a crashed planner's stdout
 * must never reach it, exactly as a FAILED reviewer run's output never reaches
 * the verdict parser.
 */

import { PRIORITIES, WORK_ITEM_TYPES, type Priority, type WorkItemType } from "../domain/workItem.js";
import type { ClarificationQuestion, PlannedWorkItem } from "./planTypes.js";

export interface ParsedPlannerProposal {
  readonly summary: string;
  readonly assumptions: readonly string[];
  readonly constraints: readonly string[];
  readonly risks: readonly string[];
  readonly blockingQuestions: readonly ClarificationQuestion[];
  readonly items: readonly PlannedWorkItem[];
}

export type ParsedPlannerOutput =
  | { readonly ok: true; readonly proposal: ParsedPlannerProposal }
  | { readonly ok: false; readonly reason: string };

/** The exact marker a planner must emit on its own line, immediately before the JSON block. */
export const PLAN_MARKER = "FACTORY_PLAN_V1";

const MARKER_PATTERN = /^FACTORY_PLAN_V1[ \t]*$/gm;
const FENCE_PATTERN = /^[ \t]*```json[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
/** A reviewer verdict tag has no business in planner output; see module docs. */
const REVIEW_VERDICT_PATTERN = /^FACTORY_REVIEW_VERDICT:/m;

/** Bounds so a runaway planner cannot persist an unreasonable amount of text. */
const MAX_SUMMARY_LENGTH = 4000;
const MAX_FIELD_LENGTH = 2000;
const MAX_SPEC_LENGTH = 20_000;
const MAX_LIST_LENGTH = 100;
const MAX_ITEMS = 50;
const MAX_CRITERIA_PER_ITEM = 25;

class ContractError extends Error {}

function fail(message: string): never {
  throw new ContractError(message);
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * The rule that makes authority smuggling structurally impossible: anything the
 * contract does not explicitly name is a parse failure, not ignored data.
 */
function rejectUnknownKeys(row: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unexpected = Object.keys(row).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    fail(`${path} has unrecognized field(s): ${unexpected.sort().join(", ")}`);
  }
}

function requireString(row: Record<string, unknown>, field: string, path: string, maxLength: number): string {
  const value = row[field];
  if (typeof value !== "string") {
    fail(`${path}.${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    fail(`${path}.${field} must be a non-empty string`);
  }
  if (trimmed.length > maxLength) {
    fail(`${path}.${field} exceeds the ${maxLength}-character bound`);
  }
  return trimmed;
}

function requireStringList(row: Record<string, unknown>, field: string, path: string): readonly string[] {
  const value = row[field];
  if (!Array.isArray(value)) {
    fail(`${path}.${field} must be an array of strings`);
  }
  if (value.length > MAX_LIST_LENGTH) {
    fail(`${path}.${field} exceeds the ${MAX_LIST_LENGTH}-entry bound`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      fail(`${path}.${field}[${index}] must be a string`);
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      fail(`${path}.${field}[${index}] must be a non-empty string`);
    }
    if (trimmed.length > MAX_FIELD_LENGTH) {
      fail(`${path}.${field}[${index}] exceeds the ${MAX_FIELD_LENGTH}-character bound`);
    }
    return trimmed;
  });
}

function requireEnum<T extends string>(
  row: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  path: string,
): T {
  const value = row[field];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(`${path}.${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function parseQuestion(value: unknown, index: number): ClarificationQuestion {
  const path = `blockingQuestions[${index}]`;
  const row = requireObject(value, path);
  rejectUnknownKeys(row, ["id", "question", "why"], path);
  return {
    id: requireString(row, "id", path, 120),
    question: requireString(row, "question", path, MAX_FIELD_LENGTH),
    why: requireString(row, "why", path, MAX_FIELD_LENGTH),
  };
}

function parseCriterion(value: unknown, itemIndex: number, index: number): { text: string; verificationHint: string } {
  const path = `items[${itemIndex}].acceptanceCriteria[${index}]`;
  const row = requireObject(value, path);
  rejectUnknownKeys(row, ["text", "verificationHint"], path);
  return {
    text: requireString(row, "text", path, MAX_FIELD_LENGTH),
    verificationHint: requireString(row, "verificationHint", path, MAX_FIELD_LENGTH),
  };
}

function parseItem(value: unknown, index: number): PlannedWorkItem {
  const path = `items[${index}]`;
  const row = requireObject(value, path);
  rejectUnknownKeys(row, ["key", "title", "type", "priority", "spec", "acceptanceCriteria", "dependsOn"], path);

  const criteria = row.acceptanceCriteria;
  if (!Array.isArray(criteria)) {
    fail(`${path}.acceptanceCriteria must be an array`);
  }
  if (criteria.length === 0) {
    // Mirrors the accepted createWorkItem invariant (C2/C3): an item with
    // nothing to verify can never be honestly DONE, so it must never become an
    // approvable plan item either.
    fail(`${path}.acceptanceCriteria must declare at least one criterion`);
  }
  if (criteria.length > MAX_CRITERIA_PER_ITEM) {
    fail(`${path}.acceptanceCriteria exceeds the ${MAX_CRITERIA_PER_ITEM}-entry bound`);
  }

  return {
    key: requireString(row, "key", path, 120),
    title: requireString(row, "title", path, MAX_FIELD_LENGTH),
    type: requireEnum<WorkItemType>(row, "type", WORK_ITEM_TYPES, path),
    priority: requireEnum<Priority>(row, "priority", PRIORITIES, path),
    spec: requireString(row, "spec", path, MAX_SPEC_LENGTH),
    acceptanceCriteria: criteria.map((entry, criterionIndex) => parseCriterion(entry, index, criterionIndex)),
    dependsOn: requireStringList(row, "dependsOn", path),
  };
}

/**
 * Extracts the single fenced JSON block that must immediately follow the single
 * marker. "Immediately" is enforced positionally: the block must start after
 * the marker, and no second block may appear anywhere — so a planner cannot
 * emit a decoy block before the real one, or a second one after it.
 */
function extractJsonBlock(text: string, markerEnd: number): string {
  FENCE_PATTERN.lastIndex = 0;
  const blocks: { body: string; start: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = FENCE_PATTERN.exec(text)) !== null) {
    blocks.push({ body: match[1] ?? "", start: match.index });
  }
  if (blocks.length === 0) {
    fail("no fenced ```json block found after the FACTORY_PLAN_V1 marker");
  }
  if (blocks.length > 1) {
    fail(`ambiguous planner output: ${blocks.length} fenced json blocks found, expected exactly 1`);
  }
  const block = blocks[0]!;
  if (block.start < markerEnd) {
    fail("the fenced ```json block appears before the FACTORY_PLAN_V1 marker");
  }
  return block.body;
}

export function parsePlannerOutput(rawOutput: string): ParsedPlannerOutput {
  try {
    if (rawOutput.trim().length === 0) {
      fail("planner produced no output");
    }
    if (REVIEW_VERDICT_PATTERN.test(rawOutput)) {
      fail(
        "planner output contains a FACTORY_REVIEW_VERDICT tag; a planner has no reviewer authority and its output may not carry one",
      );
    }

    MARKER_PATTERN.lastIndex = 0;
    const markers: number[] = [];
    let markerMatch: RegExpExecArray | null;
    while ((markerMatch = MARKER_PATTERN.exec(rawOutput)) !== null) {
      markers.push(markerMatch.index + markerMatch[0].length);
    }
    if (markers.length === 0) {
      fail(`no ${PLAN_MARKER} marker line found in planner output`);
    }
    if (markers.length > 1) {
      fail(`ambiguous planner output: ${markers.length} ${PLAN_MARKER} markers found, expected exactly 1`);
    }

    const body = extractJsonBlock(rawOutput, markers[0]!);

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      fail(`planner JSON block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }

    const root = requireObject(parsed, "plan");
    rejectUnknownKeys(root, ["summary", "assumptions", "constraints", "risks", "blockingQuestions", "items"], "plan");

    const questionsValue = root.blockingQuestions;
    if (!Array.isArray(questionsValue)) {
      fail("plan.blockingQuestions must be an array (use [] when nothing is genuinely blocking)");
    }
    if (questionsValue.length > MAX_LIST_LENGTH) {
      fail(`plan.blockingQuestions exceeds the ${MAX_LIST_LENGTH}-entry bound`);
    }
    const blockingQuestions = questionsValue.map(parseQuestion);
    const questionIds = new Set<string>();
    for (const question of blockingQuestions) {
      if (questionIds.has(question.id)) {
        fail(`plan.blockingQuestions contains duplicate question id "${question.id}"`);
      }
      questionIds.add(question.id);
    }

    const itemsValue = root.items;
    if (!Array.isArray(itemsValue)) {
      fail("plan.items must be an array");
    }
    if (itemsValue.length > MAX_ITEMS) {
      fail(`plan.items exceeds the ${MAX_ITEMS}-entry bound`);
    }
    const items = itemsValue.map(parseItem);

    // The clarification contract (TASK-005 §6): asking and proposing are
    // different answers to the request. A response with blocking questions
    // yields no approvable revision at all; a response with none must actually
    // propose work, or it is malformed rather than merely empty.
    if (blockingQuestions.length === 0 && items.length === 0) {
      fail("plan declares no blocking questions and no work items; one of the two is required");
    }

    return {
      ok: true,
      proposal: {
        summary: requireString(root, "summary", "plan", MAX_SUMMARY_LENGTH),
        assumptions: requireStringList(root, "assumptions", "plan"),
        constraints: requireStringList(root, "constraints", "plan"),
        risks: requireStringList(root, "risks", "plan"),
        blockingQuestions,
        items,
      },
    };
  } catch (error) {
    if (error instanceof ContractError) {
      return { ok: false, reason: error.message };
    }
    throw error;
  }
}
