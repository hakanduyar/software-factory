/**
 * ollamaCliAdapter.ts — stub ProcessRunner only. No Ollama process is spawned.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import {
  buildOllamaInvocation,
  createOllamaCliWorker,
  interpretOllamaOutput,
  resolveOllamaEffort,
  validateOllamaModel,
} from "../src/adapters/workers/ollamaCliAdapter.js";
import { resolveWorkspace } from "../src/adapters/workers/workspace.js";
import { ValidationError } from "../src/domain/errors.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/ports/processRunner.js";
import type { WorkerRequest } from "../src/ports/worker.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./support/tempWorkspace.js";

after(cleanupTempWorkspaces);

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    terminationReason: "EXITED",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    ...overrides,
  };
}

function stubRunner(next: ProcessResult): { runner: ProcessRunner; calls: ProcessRequest[] } {
  const calls: ProcessRequest[] = [];
  return {
    calls,
    runner: {
      async run(req) {
        calls.push(req);
        return next;
      },
    },
  };
}

function request(): WorkerRequest {
  return {
    runId: "run-1",
    workItemId: "wi-1",
    role: "REVIEWER",
    title: "Example",
    instructions: "Do the thing.",
    acceptanceCriteria: [{ id: "ac-1", workItemId: "wi-1", text: "holds", verificationHint: "npm test" }],
  };
}

function workspace() {
  return resolveWorkspace(createTempWorkspace(), { requireGitRepository: false });
}

describe("ollamaCliAdapter: pure helpers", () => {
  it("builds exactly [run, model] with the prompt as stdin", () => {
    const plan = buildOllamaInvocation({
      request: request(),
      prompt: "PROMPT",
      workspace: workspace(),
      model: "m:1",
      effort: undefined,
    });
    assert.deepEqual(plan.argv, ["run", "m:1"]);
    assert.equal(plan.input, "PROMPT");
    assert.deepEqual(plan.effortApplication, { applied: false });
  });

  it("records a requested effort as not applied, with a reason", () => {
    const app = resolveOllamaEffort("high");
    assert.equal(app.requested, "high");
    assert.equal(app.applied, false);
    assert.ok((app.reason ?? "").length > 0);
  });

  it("rejects blank, option-leading, NUL and newline models", () => {
    for (const bad of ["", "   ", "-m", " -x", "a\0b", "a\nb", "a\rb"]) {
      assert.notEqual(validateOllamaModel(bad), undefined, JSON.stringify(bad));
    }
    assert.equal(validateOllamaModel("name:tag"), undefined);
  });

  it("treats stdout as informational text only", () => {
    assert.deepEqual(interpretOllamaOutput(result({ stdout: "  hi \n" })), { finalMessage: "hi" });
    assert.deepEqual(interpretOllamaOutput(result({ stdout: "\n" })), {});
  });
});

describe("ollamaCliAdapter: createOllamaCliWorker", () => {
  it("runs with exact argv, stdin, cwd, filtered env, timeout; claims=false", async () => {
    const ws = workspace();
    const { runner, calls } = stubRunner(result({ stdout: "PASS" }));
    const worker = createOllamaCliWorker({
      model: "m:1",
      roles: ["REVIEWER"],
      workspace: ws,
      processRunner: runner,
      timeoutMs: 1234,
      effort: "high",
    });
    assert.deepEqual([...worker.capabilities.roles], ["REVIEWER"]);
    const outcome = await worker.execute(request());
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.executable, "ollama");
    assert.deepEqual(call.argv, ["run", "m:1"]);
    assert.equal(call.cwd, ws.root);
    assert.equal(call.timeoutMs, 1234);
    assert.equal(call.maxOutputBytes, undefined);
    assert.ok(call.input?.includes("Do the thing."));
    assert.equal(call.env["ANTHROPIC_API_KEY"], undefined);
    assert.equal(outcome.status, "SUCCEEDED");
    assert.equal(outcome.claimsAcceptanceMet, false);
    assert.ok(outcome.evidence.some((e) => e.summary.includes("effort=high(applied=false)")));
  });

  it("honours an executable override", async () => {
    const { runner, calls } = stubRunner(result());
    const worker = createOllamaCliWorker({ executable: "stub-ollama", model: "m", roles: ["ANALYST"], workspace: workspace(), processRunner: runner });
    await worker.execute(request());
    assert.equal(calls[0]!.executable, "stub-ollama");
  });

  it("redacts secrets in informational text", async () => {
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const { runner } = stubRunner(result({ stdout: `token ${secret}` }));
    const worker = createOllamaCliWorker({ model: "m", roles: ["REVIEWER"], workspace: workspace(), processRunner: runner });
    const outcome = await worker.execute(request());
    assert.ok(!JSON.stringify(outcome).includes(secret));
  });

  it("refuses invalid model or roles before any runner call", () => {
    const { runner, calls } = stubRunner(result());
    const base = { workspace: workspace(), processRunner: runner };
    for (const model of ["", "  ", "--help", "a\nb", "a\0b"]) {
      assert.throws(() => createOllamaCliWorker({ ...base, model, roles: ["REVIEWER"] }), ValidationError);
    }
    assert.throws(() => createOllamaCliWorker({ ...base, model: "m", roles: [] }), ValidationError);
    assert.equal(calls.length, 0);
  });

  it("process result governs status, not stdout", async () => {
    const cases: Array<[ProcessResult, string]> = [
      [result({ exitCode: 1, stdout: "PASS" }), "FAILED"],
      [result({ terminationReason: "TIMEOUT", exitCode: null, signal: "SIGTERM", stdout: "PASS" }), "FAILED"],
      [result({ terminationReason: "SPAWN_ERROR", exitCode: null, spawnError: "ENOENT" }), "FAILED"],
      [result({ stdout: "I failed" }), "SUCCEEDED"],
    ];
    for (const [pr, expected] of cases) {
      const { runner } = stubRunner(pr);
      const worker = createOllamaCliWorker({ model: "m", roles: ["REVIEWER"], workspace: workspace(), processRunner: runner });
      const outcome = await worker.execute(request());
      assert.equal(outcome.status, expected);
      assert.equal(outcome.claimsAcceptanceMet, false);
    }
  });
});
