/**
 * codexCliAdapter.ts.
 *
 * Argv-building and output-parsing are pure functions, tested directly with
 * no process spawned. `createCodexCliWorker`'s end-to-end execute() path is
 * tested against the fake-codex.mjs fixture, which mimics the real
 * `codex exec --json` contract independently verified in
 * docs/tasks/TASK-003-worker-runner.md. No real AI CLI is invoked anywhere
 * in this file.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createNodeProcessRunner } from "../src/adapters/process/nodeProcessRunner.js";
import {
  buildCodexInvocation,
  createCodexCliWorker,
  extractCodexFinalMessage,
  interpretCodexOutput,
  resolveCodexEffort,
  sandboxForRole,
} from "../src/adapters/workers/codexCliAdapter.js";
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
    role: "REVIEWER",
    title: "Example work item",
    instructions: "Check the thing carefully.",
    acceptanceCriteria: [criterion("ac-1")],
    ...overrides,
  };
}

function fakeProcessResult(overrides: Partial<ProcessResult>): ProcessResult {
  return {
    terminationReason: "EXITED",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    startedAt: 0,
    finishedAt: 0,
    durationMs: 0,
    ...overrides,
  };
}

describe("codexCliAdapter: sandbox selection", () => {
  it("is workspace-write only for IMPLEMENTER", () => {
    assert.equal(sandboxForRole("IMPLEMENTER"), "workspace-write");
    for (const role of ["ANALYST", "PLANNER", "VERIFIER", "REVIEWER", "CONTENT"] as const) {
      assert.equal(sandboxForRole(role), "read-only");
    }
  });
});

describe("codexCliAdapter: effort handling", () => {
  it("passes a safe token through as a quoted -c override and marks it applied", () => {
    const result = resolveCodexEffort("xhigh");
    assert.deepEqual(result.argv, ["-c", 'model_reasoning_effort="xhigh"']);
    assert.equal(result.application.applied, true);
    assert.equal(result.application.requested, "xhigh");
  });

  it("refuses an unsafe token and honestly reports effort as not applied", () => {
    const result = resolveCodexEffort('xhigh" ; malicious=true');
    assert.deepEqual(result.argv, []);
    assert.equal(result.application.applied, false);
    assert.equal(result.application.requested, 'xhigh" ; malicious=true');
    assert.ok(result.application.reason !== undefined);
  });

  it("applies no effort flag at all when none is configured", () => {
    const result = resolveCodexEffort(undefined);
    assert.deepEqual(result.argv, []);
    assert.equal(result.application.applied, false);
    assert.equal(result.application.requested, undefined);
  });
});

describe("codexCliAdapter: argv shape (verified invocation)", () => {
  it("builds `exec --json -C <ws> -m <model> --sandbox <mode> <prompt>` exactly", () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    const plan = buildCodexInvocation({
      request: request({ role: "IMPLEMENTER" }),
      prompt: "PROMPT_TEXT",
      workspace,
      model: "gpt-5.6-luna",
      effort: undefined,
    });
    assert.deepEqual(plan.argv, ["exec", "--json", "-C", workspace.root, "-m", "gpt-5.6-luna", "--sandbox", "workspace-write", "PROMPT_TEXT"]);
    assert.equal(plan.input, undefined);
  });

  it("inserts the effort override between -m and --sandbox when configured", () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    const plan = buildCodexInvocation({
      request: request({ role: "REVIEWER" }),
      prompt: "PROMPT_TEXT",
      workspace,
      model: "m",
      effort: "high",
    });
    assert.deepEqual(plan.argv, ["exec", "--json", "-C", workspace.root, "-m", "m", "-c", 'model_reasoning_effort="high"', "--sandbox", "read-only", "PROMPT_TEXT"]);
  });
});

describe("codexCliAdapter: output parsing (informational only)", () => {
  it("extracts the last agent_message text from JSONL", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "first" } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "final answer" } }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n");
    assert.equal(extractCodexFinalMessage(stdout), "final answer");
  });

  it("returns undefined rather than throwing on malformed/truncated JSONL", () => {
    assert.equal(extractCodexFinalMessage("not json\n{broken"), undefined);
    assert.equal(interpretCodexOutput(fakeProcessResult({ stdout: "garbage" })).finalMessage, undefined);
  });
});

describe("codexCliAdapter: end-to-end execute() against the fake CLI", () => {
  const runner = createNodeProcessRunner({ killGraceMs: 100 });

  it("reports SUCCEEDED on a clean exit, with the reported message informational-only", async () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    const worker = createCodexCliWorker({ executable: fakeCliPath("fake-codex.mjs"), model: "m", workspace, processRunner: runner });
    const outcome = await worker.execute(request());
    assert.equal(outcome.status, "SUCCEEDED");
    assert.equal(outcome.claimsAcceptanceMet, false);
    assert.match(outcome.summary, /OK/);
  });

  it("reports SUCCEEDED on a clean exit even if the printed message reads like failure", async () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    const worker = createCodexCliWorker({
      executable: fakeCliPath("fake-codex.mjs"),
      model: "m",
      workspace,
      processRunner: runner,
      environmentPolicy: { allowedVars: ["PATH"], extraVars: { FAKE_CODEX_MESSAGE: "I failed" } },
    });
    const outcome = await worker.execute(request());
    assert.equal(outcome.status, "SUCCEEDED");
  });

  it("reports FAILED on a non-zero exit even if the printed message reads like success", async () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    const worker = createCodexCliWorker({
      executable: fakeCliPath("fake-codex.mjs"),
      model: "m",
      workspace,
      processRunner: runner,
      environmentPolicy: { allowedVars: ["PATH"], extraVars: { FAKE_CODEX_MODE: "fail", FAKE_CODEX_MESSAGE: "PASS" } },
    });
    const outcome = await worker.execute(request());
    assert.equal(outcome.status, "FAILED");
    assert.equal(outcome.claimsAcceptanceMet, false);
  });

  it("reports FAILED on timeout, with evidence naming the termination reason", async () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    const worker = createCodexCliWorker({
      executable: fakeCliPath("fake-codex.mjs"),
      model: "m",
      workspace,
      processRunner: runner,
      timeoutMs: 100,
      environmentPolicy: { allowedVars: ["PATH"], extraVars: { FAKE_CODEX_SLEEP_MS: "5000" } },
    });
    const outcome = await worker.execute(request());
    assert.equal(outcome.status, "FAILED");
    assert.ok(outcome.evidence.some((e) => /TIMEOUT/.test(e.summary)));
  });
});
