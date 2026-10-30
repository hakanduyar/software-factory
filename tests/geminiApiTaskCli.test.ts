/**
 * `sf gemini-api task`: parser, injected-host runner and real main dispatch.
 * Synthetic credential and recording transport only; no network, key lookup or
 * provider is used by any test here.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import type { GeminiApiHttpRequest, GeminiApiHttpResponse } from "../src/adapters/workers/geminiApiAdapter.js";
import {
  parseGeminiApiTaskArgs,
  runGeminiApiTask,
  type GeminiApiHostConfig,
  type GeminiApiTaskArgs,
} from "../src/cli/geminiApiTask.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./support/tempWorkspace.js";

const MAIN = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "sf-gemini-task-")));
after(() => {
  cleanupTempWorkspaces();
  rmSync(ROOT, { recursive: true, force: true });
});

const MODEL = "synthetic-model-fixture";
const ENV_NAME = "SYNTHETIC_GEMINI_KEY";
const KEY = `fake-runtime-${randomBytes(8).toString("hex")}`;
const TASK = "Summarize: ```json\n{\"a\":1}\n``` — ünïcode kept.\n";

const okBody = (text = "hello", extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }], ...extra });

interface Host {
  host: GeminiApiHostConfig;
  calls: GeminiApiHttpRequest[];
  resolved: string[];
}
function host(respond: (r: GeminiApiHttpRequest) => Promise<GeminiApiHttpResponse> | GeminiApiHttpResponse, credential: string | null = KEY): Host {
  // null (not undefined) means "variable truly absent": undefined would trigger the KEY default.
  const h: Host = { calls: [], resolved: [], host: undefined as unknown as GeminiApiHostConfig };
  h.host = {
    resolveCredential: (name) => {
      h.resolved.push(name);
      return credential === null ? undefined : credential;
    },
    transport: async (r) => {
      h.calls.push(r);
      return respond(r);
    },
  };
  return h;
}

interface Fx { args: GeminiApiTaskArgs; parent: string }
function fixture(): Fx {
  const parent = mkdtempSync(join(ROOT, "case-"));
  const taskFile = join(parent, "task.txt");
  writeFileSync(taskFile, TASK, "utf8");
  return { parent, args: { model: MODEL, taskFile, workspace: createTempWorkspace(), outputDir: join(parent, "out"), credentialEnv: ENV_NAME } };
}
const sink = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (l: string) => void out.push(l), error: (l: string) => void err.push(l) };
};
const flags = (a: GeminiApiTaskArgs): string[] => [
  "--model", a.model, "--task-file", a.taskFile, "--workspace", a.workspace, "--output-dir", a.outputDir, "--credential-env", a.credentialEnv,
];

describe("sf gemini-api task: strict parser", () => {
  const f = fixture();
  const base = flags(f.args);
  it("accepts the complete explicit form", () => {
    const p = parseGeminiApiTaskArgs(base);
    assert.ok(p.ok && p.value.model === MODEL && p.value.credentialEnv === ENV_NAME);
  });
  it("rejects missing, duplicate, unknown, valueless, malformed and key-looking input without echoing a key", () => {
    const swap = (from: string, to: string): string[] => base.map((t) => (t === from ? to : t));
    const bad: string[][] = [
      base.slice(2), [...base, "--model", "x"], [...base, "--endpoint", "http://x"], [...base, "--api-key", KEY], [...base, "stray"], base.slice(0, -1),
      swap(MODEL, "--evil"), swap(MODEL, ""), swap(MODEL, "a/b"), swap(MODEL, "models/x?key=1"), swap(MODEL, "a..b"),
      swap(f.args.workspace, "rel"), swap(f.args.outputDir, "out"), swap(f.args.taskFile, `${f.parent}/../task.txt`),
      swap(ENV_NAME, KEY + " "), swap(ENV_NAME, "has-dash"), swap(ENV_NAME, "1BAD"), swap(ENV_NAME, "A=B"),
    ];
    for (const args of bad) {
      const p = parseGeminiApiTaskArgs(args);
      assert.equal(p.ok, false, args.join(" "));
      if (!p.ok) assert.ok(!p.error.includes(KEY), "key literal not echoed");
    }
  });
});

describe("sf gemini-api task: injected-host run", () => {
  it("sends one exact adapter request and persists the whole redacted outcome", async () => {
    const f = fixture();
    const h = host(() => ({
      status: 200,
      bodyText: okBody(`answer token=sk-ant-SECRETSECRETSECRET1234 echoed ${KEY}`, {
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
        modelVersion: "mv-1",
      }),
    }));
    const s = sink();
    const code = await runGeminiApiTask(f.args, { ...s, host: h.host });
    assert.equal(code, 0, s.err.join("\n"));
    assert.deepEqual(h.resolved, [ENV_NAME]);
    assert.equal(h.calls.length, 1);
    const call = h.calls[0] as GeminiApiHttpRequest;
    assert.equal(call.url, `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`);
    assert.equal(call.method, "POST");
    assert.equal(call.headers["x-goog-api-key"], KEY);
    const body = JSON.parse(call.body) as { contents: { parts: { text: string }[] }[] };
    assert.equal(body.contents.length, 1);
    assert.ok(body.contents[0]?.parts[0]?.text.includes(TASK), "task preserved verbatim in the prompt");
    assert.match(body.contents[0]?.parts[0]?.text ?? "", /ANALYST/);

    assert.deepEqual(readdirSync(f.args.outputDir), ["result.json"]);
    const text = readFileSync(join(f.args.outputDir, "result.json"), "utf8");
    assert.ok(!text.includes(KEY) && !text.includes("SECRETSECRET"), "secrets redacted in persisted JSON");
    const rec = JSON.parse(text);
    assert.equal(rec.role, "ANALYST");
    assert.equal(rec.credentialEnv, ENV_NAME);
    assert.equal(rec.outcome.status, "SUCCEEDED");
    assert.equal(rec.outcome.claimsAcceptanceMet, false);
    assert.match(rec.outcome.summary, /^answer /, "full summary, not a digest");
    assert.match(rec.outcome.evidence[0].summary, /"usageStatus":"REPORTED"/);
    assert.match(rec.taskFile.sha256, /^[0-9a-f]{64}$/);
    const console_ = [...s.out, ...s.err].join("\n");
    assert.ok(!console_.includes(KEY));
    assert.match(console_, /outcome: SUCCEEDED/);
  });

  it("keeps UNKNOWN usage unknown (never zero)", async () => {
    const f = fixture();
    const code = await runGeminiApiTask(f.args, { ...sink(), host: host(() => ({ status: 200, bodyText: okBody() })).host });
    assert.equal(code, 0);
    const rec = JSON.parse(readFileSync(join(f.args.outputDir, "result.json"), "utf8"));
    assert.match(rec.outcome.evidence[0].summary, /"usageStatus":"UNKNOWN"/);
    assert.match(rec.outcome.evidence[0].summary, /"promptTokenCount":null/);
  });

  for (const [name, respond] of [
    ["HTTP 429", () => ({ status: 429, bodyText: `quota exceeded ${KEY}` })],
    ["provider refusal", () => ({ status: 200, bodyText: JSON.stringify({ promptFeedback: { blockReason: `SAFETY ${KEY}` }, candidates: [] }) })],
    ["transport failure", () => { throw new Error(`ECONNRESET ${KEY}`); }],
  ] as Array<[string, () => GeminiApiHttpResponse]>) {
    it(`preserves a failed outcome once for ${name}: exit 2, no retry, no key anywhere`, async () => {
      const f = fixture();
      const h = host(respond);
      const s = sink();
      const code = await runGeminiApiTask(f.args, { ...s, host: h.host });
      assert.equal(code, 2);
      assert.equal(h.calls.length, 1, "no retry or fallback");
      const text = readFileSync(join(f.args.outputDir, "result.json"), "utf8");
      assert.ok(!text.includes(KEY));
      assert.ok(![...s.out, ...s.err].join("\n").includes(KEY));
      const rec = JSON.parse(text);
      assert.equal(rec.outcome.status, "FAILED");
      assert.equal(rec.outcome.claimsAcceptanceMet, false);
      assert.match(s.out.join("\n"), /outcome: FAILED/);
    });
  }

  it("fails truthfully before HTTP when the credential variable is unset", async () => {
    const f = fixture();
    const h = host(() => ({ status: 200, bodyText: okBody() }), null);
    const s = sink();
    const code = await runGeminiApiTask(f.args, { ...s, host: h.host });
    assert.equal(code, 2);
    assert.deepEqual(h.resolved, [ENV_NAME], "credential was actually looked up once and found absent");
    assert.equal(h.calls.length, 0);
    const rec = JSON.parse(readFileSync(join(f.args.outputDir, "result.json"), "utf8"));
    assert.equal(rec.outcome.status, "FAILED");
    assert.ok(![...s.out, ...s.err, JSON.stringify(rec)].join("\n").includes(KEY));
  });

  it("never overwrites an existing output directory and resolves no credential", async () => {
    const f = fixture();
    mkdirSync(f.args.outputDir);
    writeFileSync(join(f.args.outputDir, "result.json"), "earlier");
    const h = host(() => ({ status: 200, bodyText: okBody() }));
    const code = await runGeminiApiTask(f.args, { ...sink(), host: h.host });
    assert.equal(code, 1);
    assert.equal(h.resolved.length, 0);
    assert.equal(h.calls.length, 0);
    assert.equal(readFileSync(join(f.args.outputDir, "result.json"), "utf8"), "earlier");
  });

  describe("preflight refusals: exit 1, no credential, no transport, no output directory", () => {
    const cases: Array<[string, (f: Fx) => Partial<GeminiApiTaskArgs>]> = [
      ["missing task file", (f) => ({ taskFile: join(f.parent, "absent.txt") })],
      ["non-UTF-8 task file", (f) => { writeFileSync(f.args.taskFile, Buffer.from([0xff, 0xfe, 0x41])); return {}; }],
      ["empty task file", (f) => { writeFileSync(f.args.taskFile, "  \n"); return {}; }],
      ["non-repository workspace", (f) => ({ workspace: f.parent })],
      ["missing output parent", (f) => ({ outputDir: join(f.parent, "no", "out") })],
    ];
    for (const [name, build] of cases) {
      it(name, async () => {
        const f = fixture();
        const args = { ...f.args, ...build(f) };
        const h = host(() => ({ status: 200, bodyText: okBody() }));
        const s = sink();
        const code = await runGeminiApiTask(args, { ...s, host: h.host });
        assert.equal(code, 1, s.err.join("\n"));
        assert.match(s.err.join("\n"), /PRECHECK_REFUSED/);
        assert.equal(h.resolved.length, 0);
        assert.equal(h.calls.length, 0);
        assert.equal(existsSync(args.outputDir), false);
      });
    }
  });

  describe("ordinary input paths: links and wrong types are refused before credential, HTTP or output", () => {
    // Genuine synthetic links: junction on Windows, symbolic link elsewhere.
    const dirLink = (target: string, path: string): void => symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
    const fileLinkSupported = ((): boolean => {
      const probe = join(ROOT, "probe-target.txt");
      writeFileSync(probe, "x");
      try {
        symlinkSync(probe, join(ROOT, "probe-link.txt"), "file");
        return true;
      } catch (error) {
        // Only the unprivileged-Windows file-symlink case is a capability gap; anything else must fail the run.
        if (process.platform === "win32" && (error as NodeJS.ErrnoException | null)?.code === "EPERM") return false;
        throw error;
      }
    })();
    const cases: Array<[string, (f: Fx) => Partial<GeminiApiTaskArgs>, boolean?]> = [
      ["task file is a file symlink", (f) => {
        const link = join(f.parent, "task-link.txt");
        symlinkSync(f.args.taskFile, link, "file");
        return { taskFile: link };
      }, !fileLinkSupported],
      ["task file under a directory-link ancestor", (f) => {
        const link = join(f.parent, "dir-link");
        dirLink(f.parent, link);
        return { taskFile: join(link, "task.txt") };
      }],
      ["task file is a directory", (f) => ({ taskFile: f.parent })],
      ["workspace is a directory link", (f) => {
        const link = join(f.parent, "ws-link");
        dirLink(f.args.workspace, link);
        return { workspace: link };
      }],
      ["workspace under a directory-link ancestor", (f) => {
        const link = join(f.parent, "ws-parent-link");
        dirLink(dirname(f.args.workspace), link);
        return { workspace: join(link, basename(f.args.workspace)) };
      }],
      ["workspace is a file", (f) => ({ workspace: f.args.taskFile })],
      ["missing workspace", (f) => ({ workspace: join(f.parent, "no-workspace") })],
    ];
    for (const [name, build, skip] of cases) {
      it(name, { skip: skip === true ? "file symlink capability unavailable: Windows EPERM (symlink privilege not held) on file-link creation" : false }, async () => {
        const f = fixture();
        const args = { ...f.args, ...build(f) };
        const h = host(() => ({ status: 200, bodyText: okBody() }));
        const s = sink();
        const code = await runGeminiApiTask(args, { ...s, host: h.host });
        assert.equal(code, 1, s.err.join("\n"));
        assert.match(s.err.join("\n"), /PRECHECK_REFUSED/);
        assert.equal(h.resolved.length, 0);
        assert.equal(h.calls.length, 0);
        assert.equal(existsSync(args.outputDir), false);
      });
    }
    it("ordinary task file and workspace still run through the injected adapter", async () => {
      const f = fixture();
      const h = host(() => ({ status: 200, bodyText: okBody() }));
      const code = await runGeminiApiTask(f.args, { ...sink(), host: h.host });
      assert.equal(code, 0);
      assert.equal(h.calls.length, 1);
      assert.deepEqual(readdirSync(f.args.outputDir), ["result.json"]);
    });
  });

  it("reports CONFIGURATION_REQUIRED without host configuration and touches nothing", async () => {
    const f = fixture();
    const s = sink();
    const code = await runGeminiApiTask(f.args, s);
    assert.equal(code, 1);
    assert.match(s.err.join("\n"), /CONFIGURATION_REQUIRED/);
    assert.equal(existsSync(f.args.outputDir), false);
  });
});

describe("sf gemini-api task: actual main dispatch (no provider is invoked)", () => {
  const sf = (args: string[]) =>
    spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", timeout: 60_000, env: { ...process.env, [ENV_NAME]: KEY } });

  it("documents the command in sf help and its own --help", () => {
    assert.match(sf(["help"]).stdout, /sf gemini-api task/);
    const h = sf(["gemini-api", "task", "--help"]);
    assert.equal(h.status, 0);
    for (const flag of ["--model", "--task-file", "--workspace", "--output-dir", "--credential-env"]) assert.ok(h.stdout.includes(flag), flag);
    assert.match(h.stdout, /result\.json/);
  });
  it("rejects bad flags and unknown subcommands with exit 1", () => {
    const r = sf(["gemini-api", "task", "--bogus", "x"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unexpected argument/);
    assert.equal(sf(["gemini-api", "other"]).status, 1);
  });
  it("valid arguments on the ordinary CLI fail CONFIGURATION_REQUIRED, create nothing and never print the key", () => {
    const f = fixture();
    const r = sf(["gemini-api", "task", ...flags(f.args)]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /CONFIGURATION_REQUIRED/);
    assert.ok(!(r.stdout + r.stderr).includes(KEY));
    assert.equal(existsSync(f.args.outputDir), false);
  });
});
