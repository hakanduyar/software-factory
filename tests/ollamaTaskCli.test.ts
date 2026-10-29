/**
 * `sf ollama task`: fake readiness (injected HTTP) + recording runner. No
 * Ollama process, model, account or network is used by any test here.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import {
  OLLAMA_ENDPOINT,
  evaluateOllamaReadiness,
  parseOllamaTaskArgs,
  runOllamaTask,
  type OllamaHttpJson,
  type OllamaTaskArgs,
} from "../src/cli/ollamaTask.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/ports/processRunner.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./support/tempWorkspace.js";

const MAIN = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "sf-ollama-task-")));
after(() => {
  cleanupTempWorkspaces();
  rmSync(ROOT, { recursive: true, force: true });
});

const MODEL = "llama3:latest";
const DIGEST = "sha256abcdef0123456789";
const TASK = "Summarize this: ```json\n{\"a\":1}\n``` — ünïcode kept.\n";

function tagsBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    models: [
      {
        name: MODEL, model: MODEL, modified_at: "2026-01-01T00:00:00Z", size: 123, digest: DIGEST,
        details: { format: "gguf", family: "llama", parameter_size: "8B", quantization_level: "Q4_0" },
        ...overrides,
      },
    ],
  };
}
function showBody(overrides: Record<string, unknown> = {}): unknown {
  return { details: { format: "gguf", family: "llama", parameter_size: "8B", quantization_level: "Q4_0" }, ...overrides };
}
function fakeHttp(tags: unknown = tagsBody(), show: unknown = showBody()): { http: OllamaHttpJson; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    http: async (c) => {
      calls.push(c);
      return c.path === "/api/tags" ? tags : show;
    },
  };
}

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    terminationReason: "EXITED", exitCode: 0, signal: null, stdout: "plain model prose", stderr: "",
    stdoutTruncated: false, stderrTruncated: false, startedAt: 1, finishedAt: 2, durationMs: 1, ...overrides,
  };
}
function recorder(next: ProcessResult = result()): { runner: ProcessRunner; calls: ProcessRequest[] } {
  const calls: ProcessRequest[] = [];
  return { calls, runner: { async run(req) { calls.push(req); return next; } } };
}

interface Fx { args: OllamaTaskArgs; parent: string }
function fixture(): Fx {
  const parent = mkdtempSync(join(ROOT, "case-"));
  const executable = join(parent, "ollama-fake");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  const taskFile = join(parent, "task.txt");
  writeFileSync(taskFile, TASK, "utf8");
  return {
    parent,
    args: { model: MODEL, taskFile, workspace: createTempWorkspace(), outputDir: join(parent, "out"), executable },
  };
}
const sink = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (l: string) => void out.push(l), error: (l: string) => void err.push(l) };
};
const flags = (a: OllamaTaskArgs): string[] => [
  "--model", a.model, "--task-file", a.taskFile, "--workspace", a.workspace, "--output-dir", a.outputDir, "--executable", a.executable,
];

describe("sf ollama task: strict parser", () => {
  const f = fixture();
  const base = flags(f.args);
  it("accepts the complete explicit form", () => {
    const p = parseOllamaTaskArgs(base);
    assert.ok(p.ok && p.value.model === MODEL && p.value.outputDir === f.args.outputDir);
  });
  it("rejects missing, duplicate, unknown, valueless, option-looking and relative input", () => {
    const swap = (from: string, to: string): string[] => base.map((t) => (t === from ? to : t));
    const bad: string[][] = [
      base.slice(2), [...base, "--model", "x"], [...base, "--endpoint", "http://x"], [...base, "stray"], base.slice(0, -1),
      swap(MODEL, "--evil"), swap(MODEL, "-x"), swap(MODEL, ""), swap(MODEL, " padded "),
      swap(f.args.executable, "ollama"), swap(f.args.workspace, "rel"), swap(f.args.outputDir, "out"),
      swap(f.args.taskFile, `${f.parent}/../task.txt`),
    ];
    for (const args of bad) assert.equal(parseOllamaTaskArgs(args).ok, false, args.join(" "));
  });
});

describe("sf ollama task: readiness evaluation", () => {
  const ok = (tags: unknown, show: unknown, model = MODEL) => evaluateOllamaReadiness(model, tags, show);
  it("returns digest and nonsecret provenance for an exact local GGUF model", () => {
    const p = ok(tagsBody(), showBody());
    assert.equal(p.digest, DIGEST);
    assert.equal(p.format, "gguf");
    assert.equal(p.parameterSize, "8B");
  });
  it("refuses missing, alias, ambiguous, cloud, remote, no-digest and non-GGUF models", () => {
    assert.throws(() => ok({ models: [] }, showBody()), /not an exact cached/);
    assert.throws(() => ok(tagsBody(), showBody(), "llama3"), /not an exact cached/);
    const dup = { models: [(tagsBody() as { models: unknown[] }).models[0], (tagsBody({ digest: "other" }) as { models: unknown[] }).models[0]] };
    assert.throws(() => ok(dup, showBody()), /ambiguous/);
    assert.throws(() => ok(tagsBody({ name: MODEL, model: "x" }), showBody()), /not an exact cached|ambiguous/);
    assert.throws(() => evaluateOllamaReadiness("gpt-oss:120b-cloud", tagsBody({ name: "gpt-oss:120b-cloud", model: "gpt-oss:120b-cloud" }), showBody()), /cloud/);
    assert.throws(() => ok(tagsBody({ remote_host: "https://ollama.com" }), showBody()), /remote/);
    assert.throws(() => ok(tagsBody(), showBody({ remote_model: "m" })), /remote/);
    assert.throws(() => ok(tagsBody({ digest: "" }), showBody()), /digest/);
    assert.throws(() => ok(tagsBody({ details: { format: "safetensors" } }), showBody()), /gguf/);
    assert.throws(() => ok(tagsBody(), showBody({ details: { format: "bin" } })), /gguf/);
    assert.throws(() => ok("nope", showBody()), /malformed/);
  });
  it("refuses mismatched show metadata", () => {
    assert.throws(() => ok(tagsBody(), showBody({ details: { format: "gguf", family: "qwen" } })), /family disagrees/);
    assert.throws(() => ok(tagsBody(), showBody({ details: { format: "gguf", quantization_level: "Q8_0" } })), /quantization_level/);
    assert.throws(() => ok(tagsBody(), showBody({ digest: "different" })), /digest disagrees/);
  });
});

describe("sf ollama task: run", () => {
  it("runs one ANALYST request and persists redacted outcome plus provenance", async () => {
    const f = fixture();
    const h = fakeHttp();
    const r = recorder(result({ stdout: "answer ```json {not json}``` token=sk-ant-SECRETSECRETSECRET1234" }));
    const s = sink();
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-LEAKLEAKLEAKLEAK";
    process.env["OLLAMA_HOST"] = "http://evil.example:1";
    let code: number;
    try {
      code = await runOllamaTask(f.args, { ...s, httpJson: h.http, processRunner: r.runner, now: () => new Date("2026-02-03T04:05:06Z") });
    } finally {
      delete process.env["ANTHROPIC_API_KEY"];
      delete process.env["OLLAMA_HOST"];
    }
    assert.equal(code, 0, s.err.join("\n"));
    assert.deepEqual(h.calls, [
      { method: "GET", path: "/api/tags" },
      { method: "POST", path: "/api/show", body: { model: MODEL } },
    ]);
    assert.equal(r.calls.length, 1);
    const call = r.calls[0] as ProcessRequest;
    assert.equal(call.executable, f.args.executable);
    assert.deepEqual(call.argv, ["run", MODEL, "--nowordwrap"]);
    assert.equal(call.timeoutMs, null);
    assert.equal(call.maxOutputBytes, undefined);
    assert.ok(call.input?.includes(TASK), "task preserved verbatim in the prompt");
    assert.match(call.input ?? "", /ANALYST/);
    assert.equal(call.env["OLLAMA_HOST"], OLLAMA_ENDPOINT);
    assert.equal(call.env["ANTHROPIC_API_KEY"], undefined);
    assert.ok(!JSON.stringify(call.env).includes("LEAK"));
    assert.equal(call.cwd, f.args.workspace);

    assert.deepEqual(readdirSync(f.args.outputDir).sort(), ["readiness.json", "result.json"]);
    const text = readFileSync(join(f.args.outputDir, "result.json"), "utf8");
    assert.ok(!text.includes("SECRETSECRET"), "secret redacted in persisted evidence");
    assert.ok(text.includes("```json {not json}```") || text.includes("{not json}"), "model text not repaired");
    const rec = JSON.parse(text);
    assert.equal(rec.role, "ANALYST");
    assert.equal(rec.outcome.status, "SUCCEEDED");
    assert.equal(rec.outcome.claimsAcceptanceMet, false);
    assert.equal(rec.readiness.model.digest, DIGEST);
    assert.equal(rec.readiness.observedAt, "2026-02-03T04:05:06.000Z");
    assert.match(rec.taskFile.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!text.includes(TASK.slice(0, 20)), "task body is hashed, not duplicated");
    assert.match(s.out.join("\n"), /outcome: SUCCEEDED/);
  });

  it("reports a failed process as failed (exit 2) and keeps the evidence", async () => {
    const f = fixture();
    const s = sink();
    const code = await runOllamaTask(f.args, {
      ...s, httpJson: fakeHttp().http, processRunner: recorder(result({ exitCode: 1, stdout: "PASS all good" })).runner,
    });
    assert.equal(code, 2);
    const rec = JSON.parse(readFileSync(join(f.args.outputDir, "result.json"), "utf8"));
    assert.equal(rec.outcome.status, "FAILED");
    assert.equal(rec.outcome.claimsAcceptanceMet, false);
    assert.match(s.out.join("\n"), /outcome: FAILED/);
  });

  it("preserves readiness evidence and writes error.json when the runner throws", async () => {
    const f = fixture();
    const s = sink();
    const code = await runOllamaTask(f.args, {
      ...s, httpJson: fakeHttp().http, processRunner: { async run() { throw new Error("boom token=abcdefghijk"); } },
    });
    assert.equal(code, 3);
    assert.deepEqual(readdirSync(f.args.outputDir).sort(), ["error.json", "readiness.json"]);
    assert.ok(!readFileSync(join(f.args.outputDir, "error.json"), "utf8").includes("abcdefghijk"));
  });

  it("never overwrites: an existing output directory is refused untouched", async () => {
    const f = fixture();
    mkdirSync(f.args.outputDir);
    writeFileSync(join(f.args.outputDir, "result.json"), "earlier");
    const r = recorder();
    const code = await runOllamaTask(f.args, { ...sink(), httpJson: fakeHttp().http, processRunner: r.runner });
    assert.equal(code, 1);
    assert.equal(r.calls.length, 0);
    assert.equal(readFileSync(join(f.args.outputDir, "result.json"), "utf8"), "earlier");
  });

  describe("preflight refusals: exit 1, zero runner calls, no output directory", () => {
    const cases: Array<[string, (f: Fx) => Partial<Parameters<typeof runOllamaTask>[1]> & { args?: Partial<OllamaTaskArgs> }]> = [
      ["missing model", () => ({ ...{ httpJson: fakeHttp({ models: [] }).http } })],
      ["cloud model", () => ({ args: { model: "x:cloud" }, httpJson: fakeHttp().http })],
      ["mismatched show metadata", () => ({ httpJson: fakeHttp(tagsBody(), showBody({ details: { format: "gguf", family: "other" } })).http })],
      ["readiness transport failure", () => ({ httpJson: async () => { throw new Error("ECONNREFUSED"); } })],
      ["missing task file", (f) => ({ args: { taskFile: join(f.parent, "absent.txt") } })],
      ["non-UTF-8 task file", (f) => { writeFileSync(f.args.taskFile, Buffer.from([0xff, 0xfe, 0x41])); return {}; }],
      ["empty task file", (f) => { writeFileSync(f.args.taskFile, "  \n"); return {}; }],
      ["missing executable", (f) => ({ args: { executable: join(f.parent, "nope") } })],
      ["non-repository workspace", (f) => ({ args: { workspace: f.parent } })],
      ["missing workspace", (f) => ({ args: { workspace: join(f.parent, "none") } })],
      ["missing output parent", (f) => ({ args: { outputDir: join(f.parent, "no", "out") } })],
      ["symlink output ancestor", (f) => {
        const real = join(f.parent, "real");
        mkdirSync(real);
        symlinkSync(real, join(f.parent, "link"), process.platform === "win32" ? "junction" : "dir");
        return { args: { outputDir: join(f.parent, "link", "out") } };
      }],
      ["output is a symlink", (f) => {
        symlinkSync(f.parent, f.args.outputDir, process.platform === "win32" ? "junction" : "dir");
        return {};
      }],
    ];
    for (const [name, build] of cases) {
      it(name, async () => {
        const f = fixture();
        const extra = build(f);
        const r = recorder();
        const s = sink();
        const args = { ...f.args, ...(extra.args ?? {}) };
        const http = extra.httpJson ?? fakeHttp().http;
        const code = await runOllamaTask(args, { ...s, httpJson: http, processRunner: r.runner });
        assert.equal(code, 1, s.err.join("\n"));
        assert.match(s.err.join("\n"), /PRECHECK_REFUSED/);
        assert.equal(r.calls.length, 0);
        if (name !== "output is a symlink") assert.equal(existsSync(args.outputDir), false);
      });
    }

    it("makes no readiness call when local validation already failed", async () => {
      const f = fixture();
      const h = fakeHttp();
      const code = await runOllamaTask({ ...f.args, taskFile: join(f.parent, "absent.txt") }, { ...sink(), httpJson: h.http, processRunner: recorder().runner });
      assert.equal(code, 1);
      assert.equal(h.calls.length, 0);
    });
  });
});

describe("sf ollama task: actual main dispatch (no provider is invoked)", () => {
  const sf = (args: string[]) => spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", timeout: 60_000 });

  it("documents the command in sf help and its own --help", () => {
    assert.match(sf(["help"]).stdout, /sf ollama task/);
    const h = sf(["ollama", "task", "--help"]);
    assert.equal(h.status, 0);
    assert.match(h.stdout, /--output-dir/);
  });
  it("rejects bad flags and unknown subcommands with exit 1", () => {
    const r = sf(["ollama", "task", "--bogus", "x"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unexpected argument/);
    assert.equal(sf(["ollama", "pull"]).status, 1);
  });
  it("reaches the command through main and refuses a missing task file before any readiness or process", () => {
    const f = fixture();
    const r = sf(["ollama", "task", ...flags({ ...f.args, taskFile: join(f.parent, "absent.txt") })]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PRECHECK_REFUSED — --task-file/);
    assert.equal(existsSync(f.args.outputDir), false);
  });
});
