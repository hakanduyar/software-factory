/**
 * Planner prompt construction (TASK-005 §7.2).
 *
 * Two rules govern everything here.
 *
 * FIRST, what the planner is given is bounded and explicit. It receives the
 * human goal, the declared constraints, previously answered clarifications, a
 * curated list of project rules, and the output contract. It does not receive
 * secrets, credentials, environment, repository contents, or any machine
 * context — there is no code path in this module that could read one, which is
 * a stronger guarantee than remembering not to include them (C6).
 *
 * SECOND, the prompt tells the planner what the Factory will do with its
 * answer, including that the answer is a PROPOSAL with no authority. A planner
 * that believes it is approving work writes different text than one that knows
 * a human will review it, so stating the trust boundary in the prompt is part
 * of making the contract work — while never being what enforces it. Enforcement
 * is `plannerOutputContract.ts` plus the human gate; this text is courtesy.
 *
 * The instructions deliberately spell out the clarification policy (§6),
 * because the single most valuable behaviour to elicit here is *not asking* —
 * the Factory's product goal is low human friction, and a planner that asks
 * about every reversible detail defeats it.
 */

import { PRIORITIES, WORK_ITEM_TYPES } from "../domain/workItem.js";
import { PLAN_MARKER } from "./plannerOutputContract.js";
import type { PlannerQuestionAnswer } from "./plannerWorker.js";

/** The machine-readable contract text handed to the planner verbatim. */
export const PLANNER_OUTPUT_CONTRACT = `Respond with a short prose rationale if you wish, then EXACTLY ONE machine-readable block.

The block MUST be the line \`${PLAN_MARKER}\` on its own, immediately followed by exactly one fenced JSON code block:

${PLAN_MARKER}
\`\`\`json
{
  "summary": "one-paragraph statement of what will be built",
  "assumptions": ["conventional reversible choices you made instead of asking"],
  "constraints": ["constraints you are honouring"],
  "risks": ["risks or ambiguities a human should know about"],
  "blockingQuestions": [
    { "id": "q1", "question": "...", "why": "why a safe plan is impossible without this" }
  ],
  "items": [
    {
      "key": "WI-A",
      "title": "...",
      "type": "${WORK_ITEM_TYPES.join(" | ")}",
      "priority": "${PRIORITIES.join(" | ")}",
      "spec": "the explicit specification for this work item",
      "acceptanceCriteria": [
        { "text": "a behaviour that must be proven", "verificationHint": "how it is proven, e.g. npm test" }
      ],
      "dependsOn": ["WI-OTHER"]
    }
  ]
}
\`\`\`

Hard requirements:
- Emit the marker line EXACTLY ONCE and exactly one fenced json block. More than one of either is rejected as ambiguous.
- Every listed field is required. Use [] for empty lists. Any field not listed above is rejected.
- Every work item needs a non-empty "spec" and at least one acceptance criterion.
- "dependsOn" entries must reference other "key" values in this same plan. No cycles. No self-references.
- If "blockingQuestions" is non-empty, the plan is NOT proposed: you are asking, not planning. If it is empty, "items" must be non-empty.
- Do not emit a FACTORY_REVIEW_VERDICT tag. You are not a reviewer and have no reviewer authority.`;

export interface PlannerPromptInput {
  readonly projectKey: string;
  readonly intent: string;
  readonly constraints: readonly string[];
  readonly answeredQuestions: readonly PlannerQuestionAnswer[];
  readonly projectRules: readonly string[];
  readonly revision: number;
  readonly attempt: number;
  /** Set when a previous attempt's output failed the contract, so the retry can correct itself. */
  readonly previousRejection?: string;
}

function bulletList(entries: readonly string[], empty: string): string {
  return entries.length === 0 ? empty : entries.map((entry) => `- ${entry}`).join("\n");
}

export function buildPlannerPrompt(input: PlannerPromptInput): string {
  const sections: string[] = [
    `You are the PLANNER role in an automated Software Factory. Project: ${input.projectKey}.`,
    "",
    "Your output is a PROPOSAL. It has no authority. A human reviews and approves an exact plan revision before any code is written, and nothing you write can approve, release, or publish anything.",
    "",
    "## The human's goal (verbatim)",
    input.intent,
    "",
    "## Declared constraints",
    bulletList(input.constraints, "- (none declared)"),
    "",
    "## Project rules and invariants you must respect",
    bulletList(input.projectRules, "- (none supplied)"),
  ];

  if (input.answeredQuestions.length > 0) {
    sections.push(
      "",
      "## Clarifications the human already answered — do not ask these again",
      input.answeredQuestions.map((entry) => `- Q: ${entry.question}\n  A: ${entry.answer}`).join("\n"),
    );
  }

  sections.push(
    "",
    "## When to ask, and when not to",
    "Classify every unknown as exactly one of:",
    "1. BLOCKING AMBIGUITY — several materially different readings exist, and choosing wrongly would substantially change product behaviour, safety, irreversible actions, architecture boundaries, or acceptance criteria. ASK: put it in blockingQuestions.",
    "2. SAFE ASSUMPTION — a conventional, reversible choice can be made and written down. DO NOT ASK: make it and record it in assumptions.",
    "3. IMPLEMENTATION DETAIL — the implementing engineer can settle it during approved execution without changing product intent. DO NOT ASK and do not record it.",
    "",
    "Interrupting a human is expensive; a documented safe assumption is cheap and reversible. Prefer assumptions. Ask only when a safe, actionable plan is genuinely impossible without an answer.",
    "",
    "## Decomposition",
    "Break the goal into the smallest set of independently verifiable work items that actually delivers it. Give every item acceptance criteria that can be PROVEN by running something, not merely asserted. Express real ordering with dependsOn; do not invent ordering that is not required.",
    "",
    "## Output contract",
    PLANNER_OUTPUT_CONTRACT,
  );

  if (input.previousRejection !== undefined) {
    sections.push(
      "",
      "## Your previous attempt was rejected",
      `Attempt ${input.attempt - 1} for revision ${input.revision} did not satisfy the contract: ${input.previousRejection}`,
      "Correct exactly that problem. Do not change the plan's substance to work around a formatting rejection.",
    );
  }

  return sections.join("\n");
}
