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
