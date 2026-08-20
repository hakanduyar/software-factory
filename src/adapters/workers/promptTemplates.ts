/**
 * Prompt-template layer (TASK-003 item 11).
 *
 * One small, explicit function per role instead of giant inline strings
 * scattered through each CLI adapter. Every template:
 *
 *   - identifies the task/workspace/context,
 *   - states the permitted scope,
 *   - prohibits commit/push unless the caller explicitly allows it,
 *   - distinguishes implementation from review,
 *   - never contains a secret (it is built only from WorkerRequest fields,
 *     the workspace root path, and caller-supplied booleans — never from
 *     process.env).
 *
 * This is intentionally not the TASK-004 autonomous planning system: it has
 * no memory, no multi-step planning, no tool-selection logic. It renders one
 * instruction string for one run.
 */

import type { AcceptanceCriterion } from "../../domain/acceptanceCriterion.js";
import type { FactoryRole } from "../../domain/role.js";

export interface PromptContext {
  readonly workItemTitle: string;
  readonly instructions: string;
  readonly workspaceRoot: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  /** Default false: a worker may not commit, push, merge or release unless this is explicitly set. */
  readonly allowCommit?: boolean;
  /** For VERIFIER/REVIEWER roles: identifies which implementation attempt is under examination. */
  readonly targetRunId?: string;
}

function scopeStatement(ctx: PromptContext): string {
  const commitLine = ctx.allowCommit === true
    ? "You may create local commits in this workspace. Do not push, merge, tag a release, or publish anything."
    : "Do not commit, push, merge, tag a release, or publish anything. Leave the working tree's git history untouched.";
  return [
    `Workspace: ${ctx.workspaceRoot}`,
    `Work item: ${ctx.workItemTitle}`,
    "Stay strictly inside the workspace directory above. Do not touch files outside it.",
    commitLine,
  ].join("\n");
}

function criteriaBlock(criteria: readonly AcceptanceCriterion[]): string {
  if (criteria.length === 0) {
    return "No acceptance criteria were supplied for this run.";
  }
  return ["Acceptance criteria to keep in mind:", ...criteria.map((c, i) => `${i + 1}. ${c.text} (verify via: ${c.verificationHint})`)].join(
    "\n",
  );
}

function render(header: string, ctx: PromptContext, body: string): string {
  return [header, "", scopeStatement(ctx), "", criteriaBlock(ctx.acceptanceCriteria), "", body, "", "Task instructions:", ctx.instructions].join(
    "\n",
  );
}

function buildAnalystPrompt(ctx: PromptContext): string {
  return render(
    "You are acting as the Factory's ANALYST for one work item.",
    ctx,
    "Clarify the intent, scope and domain behavior of this work item. Do not write or edit production code.",
  );
}

function buildPlannerPrompt(ctx: PromptContext): string {
  return render(
    "You are acting as the Factory's PLANNER for one work item.",
    ctx,
    "Propose an architecture/decomposition/risk/sequencing plan for this work item. Do not implement it.",
  );
}

function buildImplementerPrompt(ctx: PromptContext): string {
  return render(
    "You are acting as the Factory's IMPLEMENTATION ENGINEER for one work item.",
    ctx,
    "Implement only the instructions below. Add or update tests with any code change. Run the project's own checks before finishing.",
  );
}

function buildVerifierPrompt(ctx: PromptContext): string {
  const target = ctx.targetRunId === undefined ? "" : ` You are verifying implementation run ${ctx.targetRunId}.`;
  return render(
    "You are acting as the Factory's VERIFIER for one work item.",
    ctx,
    `Deterministically check whether the acceptance criteria above actually hold (run the project's real checks; do not take anyone's word for it).${target} Do not change production code — checks and evidence only.`,
  );
}

function buildReviewerPrompt(ctx: PromptContext): string {
  const target = ctx.targetRunId === undefined ? "" : ` You are reviewing implementation run ${ctx.targetRunId}.`;
  return render(
    "You are acting as the Factory's independent REVIEWER for one work item.",
    ctx,
    `Critically review the implementation for correctness, security and quality risks against the acceptance criteria above.${target} You are not the implementer: do not rewrite the implementation, only report findings.`,
  );
}

function buildContentPrompt(ctx: PromptContext): string {
  return render(
    "You are acting as the Factory's CONTENT worker for one work item.",
    ctx,
    "Draft the requested content artifact only. Do not publish it and do not modify production code.",
  );
}

const TEMPLATES: Record<FactoryRole, (ctx: PromptContext) => string> = {
  ANALYST: buildAnalystPrompt,
  PLANNER: buildPlannerPrompt,
  IMPLEMENTER: buildImplementerPrompt,
  VERIFIER: buildVerifierPrompt,
  REVIEWER: buildReviewerPrompt,
  CONTENT: buildContentPrompt,
};

export function buildWorkerPrompt(role: FactoryRole, ctx: PromptContext): string {
  return TEMPLATES[role](ctx);
}
