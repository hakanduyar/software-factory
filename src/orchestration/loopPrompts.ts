/**
 * Bounded, iteration-aware instruction text for the loop's IMPLEMENTER and
 * REVIEWER runs (TASK-004 §7).
 *
 * Deliberately does not touch `src/adapters/workers/promptTemplates.ts` —
 * these strings become the `instructions` field of
 * `FactoryService.runWorker`'s input, which `buildWorkerPrompt` already
 * renders under "Task instructions:" (role framing, workspace/scope
 * statement, and the commit/push prohibition all still come from the
 * existing, unmodified template). Only *current-state* context is included
 * (the immediately preceding iteration's failures/findings, never the whole
 * loop history), per the brief's explicit "no unlimited historical
 * transcripts" instruction.
 */

import type { EngineeringLoop, LoopIterationRecord } from "./loopTypes.js";

const MAX_CONTEXT_CHARS = 2000;

function truncate(text: string, maxChars = MAX_CONTEXT_CHARS): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…[truncated]`;
}

function summarizeVerificationFailures(iteration: LoopIterationRecord): string {
  const failed = (iteration.verificationCommandResults ?? []).filter((r) => !r.passed);
  if (failed.length === 0) {
    return "";
  }
  const lines = failed.map(
    (r) => `- ${r.commandId}: ${r.terminationReason}${r.exitCode === null ? "" : ` (exit ${r.exitCode})`}`,
  );
  return ["Deterministic verification failed on the previous attempt:", ...lines].join("\n");
}

function summarizeReviewFindings(iteration: LoopIterationRecord): string {
  if (iteration.reviewParseError !== undefined) {
    return `The previous reviewer response could not be parsed: ${iteration.reviewParseError}. Ensure your next response follows the required verdict format exactly.`;
  }
  const findings = iteration.reviewFindings ?? [];
  if (iteration.reviewVerdict !== "CHANGES_REQUIRED" || findings.length === 0) {
    return "";
  }
  return ["The independent reviewer requested changes on the previous attempt:", ...findings.map((f) => `- ${f}`)].join("\n");
}

/**
 * `previousIteration` is the just-closed iteration this remediation attempt
 * follows, or undefined for the very first IMPLEMENTER attempt in the loop.
 */
export function buildImplementerInstructions(loop: EngineeringLoop, iterationNumber: number, previousIteration?: LoopIterationRecord): string {
  if (previousIteration === undefined) {
    return loop.taskInstructions;
  }

  const parts = [
    loop.taskInstructions,
    "",
    `This is remediation attempt ${iterationNumber} of a maximum of ${loop.budget.maxIterations} for this task.`,
    truncate(summarizeVerificationFailures(previousIteration)),
    truncate(summarizeReviewFindings(previousIteration)),
  ].filter((part) => part.length > 0);

  return parts.join("\n\n");
}

const VERDICT_CONTRACT = [
  "Respond with your verdict as the very first line of your message, in exactly this format (no other text on that line):",
  "FACTORY_REVIEW_VERDICT: PASS",
  "or:",
  "FACTORY_REVIEW_VERDICT: PASS_WITH_NON_BLOCKING_NOTES",
  "or:",
  "FACTORY_REVIEW_VERDICT: CHANGES_REQUIRED",
  "",
  "Immediately after, list findings under a FACTORY_REVIEW_FINDINGS: header, one per line starting with \"- \" (or a single \"- none\" line if there are none).",
  "Use exactly one FACTORY_REVIEW_VERDICT line. Do not repeat it, and do not use any other verdict token.",
  "You are not the implementer: report findings only. Do not modify, commit, or push any code.",
].join("\n");

export function buildReviewerInstructions(loop: EngineeringLoop, currentIteration: LoopIterationRecord): string {
  const verificationSummary = (currentIteration.verificationCommandResults ?? [])
    .map((r) => `- ${r.commandId}: ${r.passed ? "PASSED" : `FAILED (${r.terminationReason})`}`)
    .join("\n");

  const parts = [
    loop.taskInstructions,
    "",
    verificationSummary.length === 0 ? "" : `Deterministic verification results for this implementation:\n${verificationSummary}`,
    VERDICT_CONTRACT,
  ].filter((part) => part.length > 0);

  return parts.join("\n\n");
}
