/**
 * claudeCodeAdapter.ts.
 *
 * The invocation this adapter builds is now independently verified against
 * the real `claude` binary (2.1.235) — see that file's header and
 * docs/tasks/TASK-003-worker-runner.md for the exact experiments. These
 * tests exercise the adapter's own logic (argv building, output parsing,
 * execute() process-result-decides-status behavior) against a fake CLI
 * fixture that mimics the confirmed real contract — no real AI CLI is ever
 * invoked in this file.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createNodeProcessRunner } from "../src/adapters/process/nodeProcessRunner.js";
import {
  buildClaudeInvocation,
  createClaudeCodeWorker,
  extractClaudeFinalMessage,
  interpretClaudeOutput,
  parseClaudeStructuredResult,
  permissionModeForRole,
  resolveClaudeEffort,
} from "../src/adapters/workers/claudeCodeAdapter.js";
import { resolveWorkspace } from "../src/adapters/workers/workspace.js";
import type { AcceptanceCriterion } from "../src/domain/acceptanceCriterion.js";
import type { ProcessResult } from "../src/ports/processRunner.js";
import type { WorkerRequest } from "../src/ports/worker.js";
import { fakeCliPath } from "./support/fakeCli.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./support/tempWorkspace.js";

after(cleanupTempWorkspaces);

function criterion(id: string): AcceptanceCriterion {
  return { id, workItemId: "wi-1", text: `criterion ${id} holds`, verificationHint: "npm test" };
}

function request(overrides: Partial<WorkerRequest> = {}): WorkerRequest {
  return {
    runId: "run-1",
    workItemId: "wi-1",
    role: "IMPLEMENTER",
    title: "Example work item",
    instructions: "Implement the thing carefully.",
    acceptanceCriteria: [criterion("ac-1")],
    ...overrides,
  };
}

describe("claudeCodeAdapter: permission-mode selection", () => {
  it("is acceptEdits only for IMPLEMENTER", () => {
    assert.equal(permissionModeForRole("IMPLEMENTER"), "acceptEdits");
    for (const role of ["ANALYST", "PLANNER", "VERIFIER", "REVIEWER", "CONTENT"] as const) {
      assert.equal(permissionModeForRole(role), "plan");
    }
  });
});

describe("claudeCodeAdapter: effort handling (real, validated --effort flag)", () => {
  it("applies a valid effort level and marks it applied", () => {
    const result = resolveClaudeEffort("xhigh");
    assert.deepEqual(result.argv, ["--effort", "xhigh"]);
    assert.equal(result.application.applied, true);
    assert.equal(result.application.requested, "xhigh");
  });

  it("refuses a value outside the CLI's documented choice set, with a reason", () => {
    const result = resolveClaudeEffort("extreme");
    assert.deepEqual(result.argv, []);
    assert.equal(result.application.applied, false);
    assert.equal(result.application.requested, "extreme");
    assert.match(result.application.reason ?? "", /low, medium, high, xhigh, max/);
  });

  it("has nothing to report when no effort is configured", () => {
    const result = resolveClaudeEffort(undefined);
    assert.deepEqual(result.argv, []);
    assert.equal(result.application.requested, undefined);
    assert.equal(result.application.applied, false);
  });
});

describe("claudeCodeAdapter: argv shape (verified invocation)", () => {
  it("builds `-p <prompt> --model <model> --output-format json --permission-mode <mode>` exactly", () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    const plan = buildClaudeInvocation({
      request: request({ role: "IMPLEMENTER" }),
      prompt: "PROMPT_TEXT",
      workspace,
      model: "claude-sonnet-5",
      effort: undefined,
    });
    assert.deepEqual(plan.argv, [
      "-p",
      "PROMPT_TEXT",
      "--model",
      "claude-sonnet-5",
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
    ]);
    assert.equal(plan.input, undefined);
  });

  it("uses plan mode for non-IMPLEMENTER roles and inserts --effort when configured", () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    const plan = buildClaudeInvocation({
      request: request({ role: "REVIEWER" }),
      prompt: "PROMPT_TEXT",
      workspace,
      model: "m",
      effort: "high",
    });
    assert.deepEqual(plan.argv, [
      "-p",
      "PROMPT_TEXT",
      "--model",
      "m",
      "--output-format",
      "json",
      "--effort",
      "high",
      "--permission-mode",
      "plan",
    ]);
  });
});

describe("claudeCodeAdapter: output parsing (informational only)", () => {
  it("extracts `result` from a single JSON result object (confirmed real shape)", () => {
    assert.equal(extractClaudeFinalMessage(JSON.stringify({ type: "result", subtype: "success", result: "the answer" })), "the answer");
  });

  it("falls back to a JSONL-style scan and returns undefined rather than throwing on garbage", () => {
    assert.equal(extractClaudeFinalMessage("not json at all"), undefined);
    assert.equal(extractClaudeFinalMessage(""), undefined);
  });

  it("interpretClaudeOutput never throws on an arbitrary ProcessResult", () => {
    const processResult: ProcessResult = {
      terminationReason: "SPAWN_ERROR",
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      startedAt: 0,
      finishedAt: 0,
      durationMs: 0,
      spawnError: "ENOENT",
    };
    assert.deepEqual(interpretClaudeOutput(processResult), {});
  });

  it("flags streamCorrupted when the JSONL fallback scan hits a malformed line after a valid `result` line", () => {
    // Claude's primary output is a single JSON object, so this exercises the
    // defensive JSONL-fallback scan path (triggered because the whole stdout
    // does not parse as one object) with the same malformed-tail shape as the
    // Codex regression: a valid result line, then a malformed trailing line.
    const stdout = `${JSON.stringify({ type: "result", subtype: "success", result: "the answer" })}\n{`;
    const processResult: ProcessResult = {
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
    assert.equal(extractClaudeFinalMessage(stdout), "the answer");
    const reported = interpretClaudeOutput(processResult);
    assert.equal(reported.finalMessage, "the answer");
    assert.equal(reported.streamCorrupted, true);
  });

  it("flags streamCorrupted when the JSONL fallback scan finds two independently well-formed `result` lines (DEFECT-PLANNER-MULTIRESULT)", () => {
    // Claude's documented contract is exactly ONE JSON object per invocation
    // (see this file's header). Reaching the JSONL fallback with two
    // COMPLETE, individually valid result lines — no malformed line at all —
    // is a distinct contract violation from the malformed-tail case above:
    // both lines parse cleanly, so the old scan silently kept the last one
    // instead of surfacing the ambiguity.
    const stdout =
      JSON.stringify({ type: "result", is_error: false, result: "first answer" }) +
      "\n" +
      JSON.stringify({ type: "result", is_error: false, result: "second answer" });
    const processResult: ProcessResult = {
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
    const reported = interpretClaudeOutput(processResult);
    assert.equal(reported.streamCorrupted, true);
  });

  it("does not flag streamCorrupted for the confirmed clean single-JSON-object shape", () => {
    const stdout = JSON.stringify({ type: "result", subtype: "success", result: "the answer" });
    const processResult: ProcessResult = {
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
    const reported = interpretClaudeOutput(processResult);
    assert.equal(reported.finalMessage, "the answer");
    assert.equal(reported.streamCorrupted, undefined);
  });
});

describe("claudeCodeAdapter: end-to-end execute() against a fake CLI matching the confirmed real contract", () => {
  const runner = createNodeProcessRunner({ killGraceMs: 100 });

  it("reports SUCCEEDED on a clean exit", async () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    const worker = createClaudeCodeWorker({ executable: fakeCliPath("fake-claude.mjs"), model: "m", workspace, processRunner: runner });
    const outcome = await worker.execute(request());
    assert.equal(outcome.status, "SUCCEEDED");
    assert.equal(outcome.claimsAcceptanceMet, false);
  });

  it("reports FAILED on a non-zero exit even if the printed message reads like success", async () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    const worker = createClaudeCodeWorker({
      executable: fakeCliPath("fake-claude.mjs"),
      model: "m",
      workspace,
      processRunner: runner,
      environmentPolicy: { allowedVars: ["PATH"], extraVars: { FAKE_CLAUDE_MODE: "fail", FAKE_CLAUDE_MESSAGE: "PASS" } },
    });
    const outcome = await worker.execute(request());
    assert.equal(outcome.status, "FAILED");
  });

  it("carries a spawn failure through as a FAILED outcome, not a thrown exception", async () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    const worker = createClaudeCodeWorker({
      executable: "/definitely/not/a/real/claude/binary",
      model: "m",
      workspace,
      processRunner: runner,
    });
    const outcome = await worker.execute(request());
    assert.equal(outcome.status, "FAILED");
    assert.ok(outcome.evidence.some((e) => /SPAWN_ERROR/.test(e.summary)));
  });
});

/**
 * DEFECT-DURABLE-WORKER-RUN-ENVELOPE AC-6: `parseClaudeStructuredResult`.
 *
 * Deliberately strict, unlike `scanClaudeOutput`'s informational, lenient
 * JSONL-fallback scan above: a durable MAX_TURNS record is a stronger claim,
 * so anything other than a single well-formed `type: "result"` object naming
 * `terminal_reason: "max_turns"` verbatim must produce nothing rather than a
 * guess. Free text can never fabricate this state.
 */
describe("DEFECT-DURABLE-WORKER-RUN-ENVELOPE: parseClaudeStructuredResult", () => {
  it("extracts session_id and a verified MAX_TURNS terminal reason", () => {
    const stdout = JSON.stringify({
      type: "result",
      is_error: false,
      result: "ran out of turns",
      session_id: "sess-abc123",
      terminal_reason: "max_turns",
    });
    const parsed = parseClaudeStructuredResult(stdout);
    assert.equal(parsed.sessionId, "sess-abc123");
    assert.equal(parsed.terminalReason, "MAX_TURNS");
  });

  it("extracts session_id alone when there is no terminal_reason at all", () => {
    const stdout = JSON.stringify({ type: "result", is_error: false, result: "done", session_id: "sess-ok" });
    const parsed = parseClaudeStructuredResult(stdout);
    assert.equal(parsed.sessionId, "sess-ok");
    assert.equal(parsed.terminalReason, undefined);
  });

  it("never fabricates MAX_TURNS from a DIFFERENT structured terminal_reason", () => {
    const stdout = JSON.stringify({ type: "result", is_error: true, result: "boom", terminal_reason: "api_error" });
    assert.equal(parseClaudeStructuredResult(stdout).terminalReason, undefined);
  });

  it("never fabricates MAX_TURNS from FREE TEXT that merely mentions max turns", () => {
    const stdout = "the assistant said: I am out of max turns, sorry!";
    const parsed = parseClaudeStructuredResult(stdout);
    assert.equal(parsed.terminalReason, undefined);
    assert.equal(parsed.sessionId, undefined);
  });

  it("never fabricates MAX_TURNS from free text embedded inside an otherwise-valid object's result field", () => {
    const stdout = JSON.stringify({ type: "result", is_error: false, result: "terminal_reason: max_turns (just a string)" });
    assert.equal(parseClaudeStructuredResult(stdout).terminalReason, undefined);
  });

  it("finds nothing in a non-result object, malformed JSON, or empty output", () => {
    assert.deepEqual(parseClaudeStructuredResult(JSON.stringify({ type: "system" })), {});
    assert.deepEqual(parseClaudeStructuredResult("{not json"), {});
    assert.deepEqual(parseClaudeStructuredResult(""), {});
  });
});
