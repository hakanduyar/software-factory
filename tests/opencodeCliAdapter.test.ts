/**
 * opencodeCliAdapter.ts — stub ProcessRunner only. No OpenCode process is spawned.
 * Provider/model strings are clearly synthetic.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import {
  buildOpenCodeInvocation,
  createOpenCodeCliWorker,
  interpretOpenCodeOutput,
  resolveOpenCodeEffort,
  validateOpenCodeModel,
} from "../src/adapters/workers/opencodeCliAdapter.js";
import { WORKER_TOOLS } from "../src/adapters/workers/workerModelConfig.js";
import { resolveWorkspace } from "../src/adapters/workers/workspace.js";
import { ValidationError } from "../src/domain/errors.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/ports/processRunner.js";
import type { WorkerRequest } from "../src/ports/worker.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./support/tempWorkspace.js";

after(cleanupTempWorkspaces);

const MODEL = "synthetic-provider/synthetic-model";

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

describe("opencodeCliAdapter: pure helpers", () => {
  it("registers the tool identity", () => {
    assert.ok((WORKER_TOOLS as readonly string[]).includes("opencode-cli"));
  });

  it("builds exactly [run, --model, model, prompt] with no stdin", () => {
    const plan = buildOpenCodeInvocation({
      request: request(),
      prompt: "PROMPT",
      workspace: workspace(),
      model: MODEL,
      effort: undefined,
    });
    assert.deepEqual(plan.argv, ["run", "--model", MODEL, "PROMPT"]);
    assert.equal(plan.input, undefined);
    assert.deepEqual(plan.effortApplication, { applied: false });
  });

  it("refuses a message that would be read as an option", () => {
    assert.throws(
      () => buildOpenCodeInvocation({ request: request(), prompt: "--auto", workspace: workspace(), model: MODEL, effort: undefined }),
      ValidationError,
    );
  });

  it("records a requested effort as not applied, with a variant reason", () => {
    const app = resolveOpenCodeEffort("high");
    assert.equal(app.requested, "high");
    assert.equal(app.applied, false);
    assert.match(app.reason ?? "", /variant/);
  });

  it("validates provider/model lexically", () => {
    for (const bad of ["", "model", "/model", "provider/", "-p/m", "--help", "a b/c", "a/b c", "a/b\nc", "a\0/b", "a/b\t", "p/auto"]) {
      assert.notEqual(validateOpenCodeModel(bad), undefined, JSON.stringify(bad));
    }
    assert.notEqual(validateOpenCodeModel(undefined), undefined);
    assert.equal(validateOpenCodeModel(MODEL), undefined);
    assert.equal(validateOpenCodeModel("synthetic/nested/model"), undefined);
  });

  it("treats formatted stdout as informational text only", () => {
    assert.deepEqual(interpretOpenCodeOutput(result({ stdout: "  hi \n" })), { finalMessage: "hi" });
    assert.deepEqual(interpretOpenCodeOutput(result({ stdout: "\n" })), {});
    assert.deepEqual(interpretOpenCodeOutput(result({ stdout: '{"type":"x"' })), { finalMessage: '{"type":"x"' });
  });
});

describe("opencodeCliAdapter: createOpenCodeCliWorker", () => {
  it("runs with exact argv, single message, no stdin, cwd, filtered env; claims=false", async () => {
    const ws = workspace();
    const { runner, calls } = stubRunner(result({ stdout: "PASS" }));
    const worker = createOpenCodeCliWorker({
      model: MODEL,
      roles: ["REVIEWER", "ANALYST"],
      workspace: ws,
      processRunner: runner,
      timeoutMs: null,
      effort: "high",
    });
    assert.deepEqual([...worker.capabilities.roles], ["REVIEWER", "ANALYST"]);
    const outcome = await worker.execute(request());
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.executable, "opencode");
    assert.equal(call.argv.length, 4);
    assert.deepEqual(call.argv.slice(0, 3), ["run", "--model", MODEL]);
    assert.ok(call.argv[3]!.includes("Do the thing."));
    assert.ok(call.argv[3]!.includes("holds"));
    for (const flag of ["--auto", "--attach", "--variant", "--share", "--agent", "--file"]) {
      assert.ok(!call.argv.includes(flag), flag);
    }
    assert.equal(call.input, undefined);
    assert.equal(call.cwd, ws.root);
    assert.equal(call.timeoutMs, null);
    assert.equal(call.maxOutputBytes, undefined);
    assert.equal(call.env["ANTHROPIC_API_KEY"], undefined);
    assert.equal(outcome.status, "SUCCEEDED");
    assert.equal(outcome.claimsAcceptanceMet, false);
    assert.ok(outcome.evidence.some((e) => e.summary.includes("effort=high(applied=false)")));
    assert.ok(outcome.evidence.some((e) => e.reference.endsWith("/transcript")));
  });

  it("absent effort is not recorded as requested; empty output yields no transcript", async () => {
    const { runner } = stubRunner(result());
    const worker = createOpenCodeCliWorker({ model: MODEL, roles: ["REVIEWER"], workspace: workspace(), processRunner: runner });
    const outcome = await worker.execute(request());
    assert.ok(!outcome.evidence.some((e) => e.summary.includes("effort=")));
    assert.ok(!outcome.evidence.some((e) => e.reference.endsWith("/transcript")));
  });

  it("honours an executable override", async () => {
    const { runner, calls } = stubRunner(result());
    const worker = createOpenCodeCliWorker({ executable: "stub-opencode", model: MODEL, roles: ["ANALYST"], workspace: workspace(), processRunner: runner });
    await worker.execute(request());
    assert.equal(calls[0]!.executable, "stub-opencode");
  });

  it("redacts secrets in informational text", async () => {
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const { runner } = stubRunner(result({ stdout: `token ${secret}` }));
    const worker = createOpenCodeCliWorker({ model: MODEL, roles: ["REVIEWER"], workspace: workspace(), processRunner: runner });
    const outcome = await worker.execute(request());
    assert.ok(!JSON.stringify(outcome).includes(secret));
  });

  it("refuses invalid model, roles or finite timeout before any runner call", () => {
    const { runner, calls } = stubRunner(result());
    const base = { workspace: workspace(), processRunner: runner };
    for (const model of ["", "m", "p/", "/m", "--help", "a/b c", "a/b\0"]) {
      assert.throws(() => createOpenCodeCliWorker({ ...base, model, roles: ["REVIEWER"] }), ValidationError);
    }
    assert.throws(() => createOpenCodeCliWorker({ ...base, model: MODEL, roles: [] }), ValidationError);
    assert.throws(() => createOpenCodeCliWorker({ ...base, model: MODEL, roles: ["REVIEWER"], timeoutMs: 1234 }), /must be null/);
    assert.equal(calls.length, 0);
  });

  it("process result governs status and metadata, not stdout", async () => {
    const cases: Array<[ProcessResult, string, RegExp]> = [
      [result({ exitCode: 1, stdout: "PASS" }), "FAILED", /exit=1/],
      [result({ terminationReason: "TIMEOUT", exitCode: null, signal: "SIGTERM", stdout: "PASS" }), "FAILED", /TIMEOUT/],
      [result({ terminationReason: "CANCELLED", exitCode: null, signal: "SIGTERM", stdout: "PASS" }), "FAILED", /CANCELLED/],
      [result({ terminationReason: "SPAWN_ERROR", exitCode: null, spawnError: "ENOENT" }), "FAILED", /SPAWN_ERROR: ENOENT/],
      [result({ stdout: "I failed" }), "SUCCEEDED", /exit=0/],
    ];
    for (const [pr, expected, meta] of cases) {
      const { runner } = stubRunner(pr);
      const worker = createOpenCodeCliWorker({ model: MODEL, roles: ["REVIEWER"], workspace: workspace(), processRunner: runner });
      const outcome = await worker.execute(request());
      assert.equal(outcome.status, expected);
      assert.equal(outcome.claimsAcceptanceMet, false);
      assert.match(outcome.summary, meta);
    }
  });
});
