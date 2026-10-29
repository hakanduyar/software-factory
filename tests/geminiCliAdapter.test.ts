/**
 * geminiCliAdapter.ts — stub ProcessRunner only. No Gemini process is spawned.
 * Model names are synthetic fixtures, not provider claims.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import {
  buildGeminiInvocation,
  createGeminiCliWorker,
  interpretGeminiOutput,
  resolveGeminiEffort,
  validateGeminiModel,
} from "../src/adapters/workers/geminiCliAdapter.js";
import { resolveWorkspace } from "../src/adapters/workers/workspace.js";
import { ValidationError } from "../src/domain/errors.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/ports/processRunner.js";
import type { WorkerRequest } from "../src/ports/worker.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./support/tempWorkspace.js";

after(cleanupTempWorkspaces);

const MODEL = "synthetic-gemini-fixture";

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

function json(value: unknown): ProcessResult {
  return result({ stdout: JSON.stringify(value) });
}

describe("geminiCliAdapter: pure helpers", () => {
  it("builds the exact separate argv with the whole prompt as --prompt value", () => {
    const plan = buildGeminiInvocation({
      request: request(),
      prompt: "PROMPT with spaces\nand lines",
      workspace: workspace(),
      model: MODEL,
      effort: undefined,
    });
    assert.deepEqual(plan.argv, ["--model", MODEL, "--output-format", "json", "--prompt", "PROMPT with spaces\nand lines"]);
    assert.equal(plan.input, undefined);
    assert.deepEqual(plan.effortApplication, { applied: false });
  });

  it("records a requested effort as not applied, with a reason", () => {
    const app = resolveGeminiEffort("high");
    assert.equal(app.requested, "high");
    assert.equal(app.applied, false);
    assert.ok((app.reason ?? "").length > 0);
  });

  it("rejects missing, nonstring, blank, whitespace, option, NUL, newline and auto models", () => {
    const bad: unknown[] = [undefined, null, 5, {}, "", " ", "a b", " m", "m ", "-m", "--help", "a\0b", "a\nb", "a\rb", "auto", "AUTO", "Auto"];
    for (const model of bad) {
      assert.notEqual(validateGeminiModel(model), undefined, JSON.stringify(model));
    }
    assert.equal(validateGeminiModel(MODEL), undefined);
    assert.equal(validateGeminiModel("name:tag.1"), undefined);
  });

  it("parses only an ordinary JSON object with own string response", () => {
    assert.deepEqual(interpretGeminiOutput(json({ response: " hi ", stats: {} })), { finalMessage: "hi" });
    assert.deepEqual(interpretGeminiOutput(json({ response: "ok", error: null })), { finalMessage: "ok" });
    assert.deepEqual(interpretGeminiOutput(json({ response: "" })), {});
  });

  it("yields no message for malformed, nonobject, missing, inherited, nonstring or error envelopes", () => {
    const outputs = [
      result({ stdout: "not json" }),
      result({ stdout: "" }),
      result({ stdout: '{"response":"a"}\n{"response":"b"}' }),
      json(null),
      json([{ response: "x" }]),
      json("response"),
      json({ stats: {} }),
      json({ response: 5 }),
      json({ response: null }),
      json({ response: "text", error: { message: "boom" } }),
      json({ error: { message: "only error" } }),
      result({ stdout: '{"__proto__":{"response":"inherited"}}' }),
    ];
    for (const out of outputs) {
      assert.deepEqual(interpretGeminiOutput(out), {}, out.stdout);
    }
  });
});

describe("geminiCliAdapter: createGeminiCliWorker", () => {
  it("runs with exact argv, cwd, filtered env, null timeout; claims=false", async () => {
    const ws = workspace();
    const { runner, calls } = stubRunner(json({ response: "PASS", stats: {} }));
    const worker = createGeminiCliWorker({
      model: MODEL,
      roles: ["REVIEWER"],
      workspace: ws,
      processRunner: runner,
      timeoutMs: null,
      effort: "high",
    });
    assert.deepEqual([...worker.capabilities.roles], ["REVIEWER"]);
    const outcome = await worker.execute(request());
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.executable, "gemini");
    assert.equal(call.argv.length, 6);
    assert.deepEqual(call.argv.slice(0, 5), ["--model", MODEL, "--output-format", "json", "--prompt"]);
    assert.ok(call.argv[5]!.includes("Do the thing."));
    assert.equal(call.input, undefined);
    assert.ok(!call.argv.some((a) => /yolo|approval|trust|allowed|policy/i.test(a) && a.startsWith("-")));
    assert.equal(call.cwd, ws.root);
    assert.equal(call.timeoutMs, null);
    assert.equal(call.maxOutputBytes, null);
    assert.equal(call.env["ANTHROPIC_API_KEY"], undefined);
    assert.equal(outcome.status, "SUCCEEDED");
    assert.equal(outcome.claimsAcceptanceMet, false);
    assert.ok(outcome.evidence.some((e) => e.summary.includes("effort=high(applied=false)")));
  });

  it("honours an executable override", async () => {
    const { runner, calls } = stubRunner(result());
    const worker = createGeminiCliWorker({ executable: "stub-gemini", model: MODEL, roles: ["ANALYST"], workspace: workspace(), processRunner: runner });
    await worker.execute(request());
    assert.equal(calls[0]!.executable, "stub-gemini");
  });

  it("redacts secrets in informational text", async () => {
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const { runner } = stubRunner(json({ response: `token ${secret}` }));
    const worker = createGeminiCliWorker({ model: MODEL, roles: ["REVIEWER"], workspace: workspace(), processRunner: runner });
    const outcome = await worker.execute(request());
    assert.ok(!JSON.stringify(outcome).includes(secret));
    assert.equal(outcome.claimsAcceptanceMet, false);
  });

  it("refuses invalid model or roles before any runner call", () => {
    const { runner, calls } = stubRunner(result());
    const base = { workspace: workspace(), processRunner: runner };
    for (const model of ["", "  ", "--help", "a\nb", "a\0b", "a b", "auto", "AUTO"]) {
      assert.throws(() => createGeminiCliWorker({ ...base, model, roles: ["REVIEWER"] }), ValidationError);
    }
    assert.throws(() => createGeminiCliWorker({ ...base, roles: ["REVIEWER"] } as never), ValidationError);
    assert.throws(() => createGeminiCliWorker({ ...base, model: MODEL, roles: [] }), ValidationError);
    assert.throws(() => createGeminiCliWorker({ ...base, model: MODEL } as never), ValidationError);
    assert.equal(calls.length, 0);
  });

  it("process result governs status, not model text", async () => {
    const cases: Array<[ProcessResult, string]> = [
      [result({ exitCode: 1, stdout: JSON.stringify({ response: "PASS" }) }), "FAILED"],
      [result({ terminationReason: "TIMEOUT", exitCode: null, signal: "SIGTERM", stdout: JSON.stringify({ response: "PASS" }) }), "FAILED"],
      [result({ terminationReason: "CANCELLED", exitCode: null, signal: "SIGTERM" }), "FAILED"],
      [result({ terminationReason: "SPAWN_ERROR", exitCode: null, spawnError: "ENOENT" }), "FAILED"],
      [json({ response: "FAILED" }), "SUCCEEDED"],
      [result({ stdout: "garbage" }), "SUCCEEDED"],
    ];
    for (const [pr, expected] of cases) {
      const { runner } = stubRunner(pr);
      const worker = createGeminiCliWorker({ model: MODEL, roles: ["REVIEWER"], workspace: workspace(), processRunner: runner });
      const outcome = await worker.execute(request());
      assert.equal(outcome.status, expected, JSON.stringify(pr));
      assert.equal(outcome.claimsAcceptanceMet, false);
    }
  });
});

describe("createGeminiCliWorker: finite author timeout refusal", () => {
  it("defaults to null and refuses a finite timeout before any runner call", async () => {
    const { runner, calls } = stubRunner(json({ response: "PASS", stats: {} }));
    assert.throws(
      () => createGeminiCliWorker({ model: MODEL, roles: ["REVIEWER"], workspace: workspace(), processRunner: runner, timeoutMs: 1234 }),
      /must be null/,
    );
    assert.equal(calls.length, 0);
    await createGeminiCliWorker({ model: MODEL, roles: ["REVIEWER"], workspace: workspace(), processRunner: runner }).execute(request());
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.timeoutMs, null);
  });
});
