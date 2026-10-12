/**
 * TASK-005 bounded planner recovery.
 *
 * Reproduces the real production failure — `PLANNER_OUTPUT_REJECTED: no
 * fenced json block after FACTORY_PLAN_V1` on a genuinely valid plan — end to
 * end through the real adapter stack: cliPlannerWorker -> loopWorkerFactory ->
 * cliWorker -> {codexCliAdapter,claudeCodeAdapter} -> parsePlannerOutput. The
 * `ProcessRunner` here is a fake, but its stdout is the real per-tool
 * structured shape (Codex `exec --json` JSONL, Claude's single JSON object
 * with a `result` field), not a mocked `Worker`.
 *
 * Root cause (round 1): `cliWorker`'s evidence-transcript bound defaulted to
 * 4000 chars for every caller, including the planner. A valid fenced-JSON
 * plan with a handful of work items routinely exceeds that before its
 * closing fence, so the transcript evidence was cut mid-document and the
 * strict parser correctly (but misleadingly) reported "no fenced block".
 * Fixed by giving the planner its own generous, still-finite bound
 * (`PLANNER_MAX_EVIDENCE_CHARS`).
 *
 * Root cause (round 2, HIGH, this file's main coverage): raising the bound
 * only moves the cliff, it does not remove it. `cliWorker.truncate()` cuts
 * the transcript at an arbitrary byte position with no regard for document
 * structure. Whether the resulting PREFIX still parses as a complete,
 * unambiguous plan depends entirely on where within the model's real,
 * untruncated answer that cut happened to land:
 *
 *   - a valid short plan followed by oversized padding truncates to a
 *     complete, valid-looking prefix -> the OLD code accepted it, even though
 *     the model's actual answer was materially larger than what was checked;
 *   - a valid short plan, oversized padding, THEN a second fenced JSON block
 *     (which makes the real, untruncated answer ambiguous and must be
 *     rejected under AC-2) truncates to the exact same complete-looking
 *     prefix if the cut lands before the second block -> the OLD code
 *     accepted an answer whose full, untruncated form is contractually
 *     REJECTED. Acceptance silently depended on cut position.
 *
 * The fix (cliWorker.ts) adds a STRUCTURED truncation signal — a dedicated
 * `.../transcript-truncated` evidence entry emitted only when `truncate()`
 * actually cut the transcript, independent of the cut position or of any
 * text a model could itself have written. `cliPlannerWorker.ts` checks for
 * that signal and fails closed (status FAILED, no rawOutput reaches the
 * parser at all) whenever it is present, before ever asking whether the
 * (necessarily incomplete) prefix happens to parse.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCliPlannerWorker } from "../src/adapters/planning/cliPlannerWorker.js";
import { parsePlannerOutput } from "../src/planning/plannerOutputContract.js";
import { createCodexCliWorker } from "../src/adapters/workers/codexCliAdapter.js";
import { createClaudeCodeWorker } from "../src/adapters/workers/claudeCodeAdapter.js";
import type { ProcessResult, ProcessRunner } from "../src/ports/processRunner.js";
import type { Workspace } from "../src/adapters/workers/workspace.js";
import type { PlannerRequest } from "../src/planning/plannerWorker.js";
import type { WorkerRequest } from "../src/ports/worker.js";
import type { WorkerTool } from "../src/adapters/workers/workerModelConfig.js";
import {
  createSyntheticGenericWorkerAdmission,
  createSyntheticPlannerAdmissionSource,
} from "./support/plannerAdmissionFixtures.js";

function fakeProcessResult(stdout: string): ProcessResult {
  return {
    terminationReason: "EXITED",
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    startedAt: 0,
    finishedAt: 1,
    durationMs: 1,
  };
}

/** The real Codex `exec --json` JSONL shape, carrying one final agent_message. */
function codexJsonlFor(finalMessage: string): string {
  return [
    JSON.stringify({ type: "thread.started" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: finalMessage } }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");
}

/** The real Claude Code `--output-format json` shape: one JSON object with `result`. */
function claudeJsonFor(finalMessage: string): string {
  return JSON.stringify({ type: "result", subtype: "success", result: finalMessage });
}

function plannerRequest(overrides: Partial<PlannerRequest> = {}): PlannerRequest {
  return {
    projectKey: "proj",
    intent: "do the thing",
    constraints: [],
    answeredQuestions: [],
    projectRules: [],
    revision: 1,
    attempt: 1,
    planId: "plan-1",
    correlationTag: "corr-1",
    outputContract: "contract",
    ...overrides,
  };
}

function buildValidPlanFinalMessage(itemCount: number, summary = "A sufficiently long plan summary."): string {
  const items = Array.from({ length: itemCount }, (_, i) => ({
    key: `item-${i}`,
    title: `Work item number ${i} with a reasonably descriptive title`,
    type: "FEATURE",
    priority: "P2",
    spec: `Spec text for item ${i}. `.repeat(30),
    acceptanceCriteria: [{ text: `criterion for ${i}`, verificationHint: "run tests" }],
    dependsOn: [] as string[],
  }));
  const plan = {
    summary,
    assumptions: [] as string[],
    constraints: [] as string[],
    risks: [] as string[],
    blockingQuestions: [] as unknown[],
    items,
  };
  const planJson = JSON.stringify(plan, null, 2);
  return `FACTORY_PLAN_V1\n\`\`\`json\n${planJson}\n\`\`\`\n`;
}

/** A second, distinct, well-formed fenced JSON block that would make a full answer ambiguous under AC-2. */
const SECOND_FENCE = '```json\n{"summary":"x","assumptions":[],"constraints":[],"risks":[],"blockingQuestions":[],"items":[]}\n```\n';

/**
 * The exact malformed-tail production shape from the recovery packet: a
 * clean, valid final message, followed by a malformed/truncated trailing
 * line ('\n{') that the adapter's own JSON parse rejects. For Codex this is
 * the native JSONL stream; for Claude this forces the defensive JSONL
 * fallback scan (the whole stdout no longer parses as one clean object).
 */
function stdoutWithMalformedTail(tool: WorkerTool, finalMessage: string): string {
  const clean = tool === "codex-cli" ? codexJsonlFor(finalMessage) : claudeJsonFor(finalMessage);
  return `${clean}\n{`;
}

function genericWorkerRequest(): WorkerRequest {
  return {
    runId: "run-generic-1",
    workItemId: "wi-1",
    role: "REVIEWER",
    title: "Example work item",
    instructions: "Check the thing carefully.",
    acceptanceCriteria: [],
  };
}

async function genericWorkerFor(tool: WorkerTool, processResult: ProcessResult) {
  const runner: ProcessRunner = { run: async () => processResult };
  const workspace: Workspace = { root: process.cwd(), repositoryRoot: process.cwd() };
  const model = tool === "codex-cli" ? "gpt-5-codex" : "claude-opus";
  const request = genericWorkerRequest();
  const { channel, handle } = await createSyntheticGenericWorkerAdmission({
    model,
    role: request.role,
    workItemId: request.workItemId,
    runId: request.runId,
  });
  const worker =
    tool === "codex-cli"
      ? createCodexCliWorker({ model, workspace, processRunner: runner, directAdmissionChannel: channel })
      : createClaudeCodeWorker({ model, workspace, processRunner: runner, directAdmissionChannel: channel });
  return { worker, request: { ...request, directAdmissionHandle: handle } as WorkerRequest };
}

function plannerForResult(tool: WorkerTool, processResult: ProcessResult) {
  const runner: ProcessRunner = { run: async () => processResult };
  const workspace: Workspace = { root: process.cwd(), repositoryRoot: process.cwd() };
  const model = tool === "codex-cli" ? "gpt-5-codex" : "claude-opus";
  const { source } = createSyntheticPlannerAdmissionSource({ model });
  return createCliPlannerWorker({
    tool,
    model,
    workspace,
    processRunner: runner,
    admissionSource: source,
  });
}

function plannerFor(tool: WorkerTool, finalMessage: string) {
  const stdout = tool === "codex-cli" ? codexJsonlFor(finalMessage) : claudeJsonFor(finalMessage);
  return plannerForResult(tool, fakeProcessResult(stdout));
}

const PROVIDERS: readonly WorkerTool[] = ["codex-cli", "claude-code"];

for (const tool of PROVIDERS) {
  describe(`cliPlannerWorker (${tool}): real adapter stack vs a valid long plan`, () => {
    it("carries a >4000-char valid plan intact into the strict parser (previously truncated the closing fence)", async () => {
      const finalMessage = buildValidPlanFinalMessage(6);
      assert.ok(finalMessage.length > 4000, `fixture too short: ${finalMessage.length} chars`);

      const outcome = await plannerFor(tool, finalMessage).plan(plannerRequest());

      assert.equal(outcome.status, "SUCCEEDED");
      assert.equal(outcome.rawOutput, finalMessage);
      const parsed = parsePlannerOutput(outcome.rawOutput);
      assert.equal(parsed.ok, true);
      if (parsed.ok) {
        assert.equal(parsed.proposal.items.length, 6);
      }
    });

    it("fails closed when a fully oversized transcript is truncated (no fenced block survives the cut)", async () => {
      const finalMessage = buildValidPlanFinalMessage(400);
      assert.ok(finalMessage.length > 100_000, `fixture too short: ${finalMessage.length} chars`);

      const outcome = await plannerFor(tool, finalMessage).plan(plannerRequest());

      // Fails closed at the adapter boundary, before the parser ever runs:
      // a truncated authoritative transcript is never trusted as a plan.
      assert.equal(outcome.status, "FAILED");
      assert.equal(outcome.rawOutput, "");
    });

    it("fails closed for a valid short plan followed only by oversized padding (truncated prefix parses cleanly, but must still be refused)", async () => {
      const shortPlan = buildValidPlanFinalMessage(1);
      const finalMessage = `${shortPlan}${" ".repeat(101_000)}`;
      assert.ok(finalMessage.length > 100_000, `fixture too short: ${finalMessage.length} chars`);

      // Sanity: the untruncated answer itself is a genuinely valid plan —
      // this proves the rejection below is about truncation, not content.
      const parsedUntruncated = parsePlannerOutput(finalMessage);
      assert.equal(parsedUntruncated.ok, true);

      const outcome = await plannerFor(tool, finalMessage).plan(plannerRequest());

      assert.equal(outcome.status, "FAILED");
      assert.equal(outcome.rawOutput, "");
    });

    it("fails closed for a valid short plan + padding + a hidden second fenced block after the cutoff (acceptance must not depend on cut position)", async () => {
      const shortPlan = buildValidPlanFinalMessage(1);
      const finalMessage = `${shortPlan}${" ".repeat(101_000)}${SECOND_FENCE}`;
      assert.ok(finalMessage.length > 100_000, `fixture too short: ${finalMessage.length} chars`);

      // Sanity: the untruncated answer is ambiguous under AC-2 (two fenced
      // blocks) and the strict parser correctly rejects it on its own.
      const parsedUntruncated = parsePlannerOutput(finalMessage);
      assert.equal(parsedUntruncated.ok, false);
      if (!parsedUntruncated.ok) {
        assert.match(parsedUntruncated.reason, /ambiguous planner output: 2 fenced json blocks/);
      }

      const outcome = await plannerFor(tool, finalMessage).plan(plannerRequest());

      // The regression: the OLD code truncated to exactly the valid-looking
      // prefix (the second fence, past the cutoff, was silently discarded)
      // and accepted it as SUCCEEDED with a clean parse. The fix must refuse
      // it at the adapter boundary, the same as the padding-only case above —
      // acceptance must not depend on where within the real answer the cut
      // happened to land.
      assert.equal(outcome.status, "FAILED");
      assert.equal(outcome.rawOutput, "");
    });

    it("still rejects two fenced json blocks as ambiguous through the real adapter stack when nothing was truncated", async () => {
      const single = buildValidPlanFinalMessage(1);
      const doubled = `${single}\n${SECOND_FENCE}`;
      assert.ok(doubled.length < 100_000, `fixture unexpectedly large: ${doubled.length} chars`);

      const outcome = await plannerFor(tool, doubled).plan(plannerRequest());
      assert.equal(outcome.status, "SUCCEEDED");
      const parsed = parsePlannerOutput(outcome.rawOutput);
      assert.equal(parsed.ok, false);
      if (!parsed.ok) {
        assert.match(parsed.reason, /ambiguous planner output: 2 fenced json blocks/);
      }
    });

    it("still rejects an unparseable/empty transcript through the real adapter stack", async () => {
      const outcome = await plannerFor(tool, "").plan(plannerRequest());
      // No agent_message/result item -> nothing parsed -> no transcript evidence at all.
      assert.equal(outcome.rawOutput, "");
      const parsed = parsePlannerOutput(outcome.rawOutput);
      assert.equal(parsed.ok, false);
    });

    it("redacts a secret-shaped token in the planner transcript before it reaches rawOutput", async () => {
      const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789";
      const finalMessage = buildValidPlanFinalMessage(1, `Plan summary mentioning a leaked token ${secret} inline.`);

      const outcome = await plannerFor(tool, finalMessage).plan(plannerRequest());

      assert.equal(outcome.status, "SUCCEEDED");
      assert.ok(!outcome.rawOutput.includes(secret), "secret-shaped token must be redacted from planner rawOutput");
      assert.ok(outcome.rawOutput.includes("[REDACTED]"), "expected the redaction marker in place of the secret");
    });

    it("fails closed when the process runner itself reports stdoutTruncated=true, even though the captured prefix parses as a clean, valid, short plan", async () => {
      const finalMessage = buildValidPlanFinalMessage(1);
      const stdout = tool === "codex-cli" ? codexJsonlFor(finalMessage) : claudeJsonFor(finalMessage);

      // Sanity: the captured prefix alone is a genuinely valid, unambiguous
      // plan — this proves the rejection below is about untrustworthy
      // process-level capture, not content.
      const parsedPrefix = parsePlannerOutput(finalMessage);
      assert.equal(parsedPrefix.ok, true);

      const outcome = await plannerForResult(tool, {
        terminationReason: "EXITED",
        exitCode: 0,
        signal: null,
        stdout,
        stderr: "",
        stdoutTruncated: true,
        stderrTruncated: false,
        startedAt: 0,
        finishedAt: 1,
        durationMs: 1,
      }).plan(plannerRequest());

      // A clean exit and a cleanly-parsing captured prefix are not enough:
      // the process runner discarded bytes past its own capture cap, so the
      // Factory has no way to know what the model produced after the cut.
      // Never accept a captured prefix of unknown full stdout as authoritative.
      assert.equal(outcome.status, "FAILED");
      assert.equal(outcome.rawOutput, "");
    });

    it("fails closed when a valid final message is followed by a malformed JSONL tail, even with stdoutTruncated=false", async () => {
      const finalMessage = buildValidPlanFinalMessage(1);
      const stdout = stdoutWithMalformedTail(tool, finalMessage);

      const outcome = await plannerForResult(tool, {
        terminationReason: "EXITED",
        exitCode: 0,
        signal: null,
        stdout,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        startedAt: 0,
        finishedAt: 1,
        durationMs: 1,
      }).plan(plannerRequest());

      // Raw stream corruption after a valid-looking message can hide a
      // later, different, authoritative message. The adapter's own parser
      // silently ignores the malformed line and keeps the earlier valid one
      // (informational-only, correct for that layer); the planner must not
      // inherit that leniency and must fail closed instead of silently
      // picking the earlier message.
      assert.equal(outcome.status, "FAILED");
      assert.equal(outcome.rawOutput, "");
    });

    it("regression: swapping the order of two conflicting result candidates does not change refusal into acceptance (DEFECT-PLANNER-MULTIRESULT)", async () => {
      if (tool !== "claude-code") return;
      const first = buildValidPlanFinalMessage(1, "first plan");
      const second = buildValidPlanFinalMessage(1, "second plan");
      const stdoutFirstThenSecond =
        JSON.stringify({ type: "result", is_error: false, result: first }) +
        "\n" +
        JSON.stringify({ type: "result", is_error: false, result: second });
      const stdoutSecondThenFirst =
        JSON.stringify({ type: "result", is_error: false, result: second }) +
        "\n" +
        JSON.stringify({ type: "result", is_error: false, result: first });

      const outcomeA = await plannerForResult(tool, fakeProcessResult(stdoutFirstThenSecond)).plan(plannerRequest());
      const outcomeB = await plannerForResult(tool, fakeProcessResult(stdoutSecondThenFirst)).plan(plannerRequest());

      assert.equal(outcomeA.status, "FAILED");
      assert.equal(outcomeA.rawOutput, "");
      assert.equal(outcomeB.status, "FAILED");
      assert.equal(outcomeB.rawOutput, "");
    });

    it("generic worker (non-planner) compatibility: the same stdoutTruncated/malformed-tail evidence remains informational-only and does not change SUCCEEDED status", async () => {
      const finalMessage = "a short reviewer verdict";
      const stdout = stdoutWithMalformedTail(tool, finalMessage);

      const truncated = await genericWorkerFor(tool, {
        terminationReason: "EXITED",
        exitCode: 0,
        signal: null,
        stdout: tool === "codex-cli" ? codexJsonlFor(finalMessage) : claudeJsonFor(finalMessage),
        stderr: "",
        stdoutTruncated: true,
        stderrTruncated: false,
        startedAt: 0,
        finishedAt: 1,
        durationMs: 1,
      });
      const truncatedOutcome = await truncated.worker.execute(truncated.request);
      assert.equal(truncatedOutcome.status, "SUCCEEDED");

      const corrupted = await genericWorkerFor(tool, {
        terminationReason: "EXITED",
        exitCode: 0,
        signal: null,
        stdout,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        startedAt: 0,
        finishedAt: 1,
        durationMs: 1,
      });
      const corruptedOutcome = await corrupted.worker.execute(corrupted.request);
      assert.equal(corruptedOutcome.status, "SUCCEEDED");
    });
  });
}
