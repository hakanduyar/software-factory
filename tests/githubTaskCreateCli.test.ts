/**
 * `sf github task-create`: parser, runner classification, and (Linux) the real
 * fixed pwsh entrypoint + unchanged durable CREATE engine + default pinned gh
 * transport driven by an OWNED local fake gh. No network, no real gh, no
 * provider, no credentials. Fake-gh evidence is NOT evidence of real GitHub delivery.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { createNodeProcessRunner } from "../src/adapters/process/nodeProcessRunner.js";
import {
  parseGithubTaskCreateArgs,
  parseTaskCreateResult,
  runGithubTaskCreate,
  TASK_CREATE_ENTRYPOINT_SEGMENTS,
} from "../src/cli/githubTaskCreate.js";
import type { GithubTaskCreateArgs } from "../src/cli/githubTaskCreate.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/ports/processRunner.js";

const MAIN = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const REPO_ROOT = process.cwd();
const owned: string[] = [];
after(() => {
  for (const d of owned.splice(0)) rmSync(d, { recursive: true, force: true });
});
const mk = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "sf-gh-task-create-")));
  owned.push(d);
  return d;
};

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const TASK = "TASK-1";
const KEY = "c".repeat(64);
const MARKER = `factory-task-${sha(TASK)}`;
const GHSHA = "a".repeat(64);

const procResult = (over: Partial<ProcessResult> = {}): ProcessResult => ({
  terminationReason: "EXITED", exitCode: 0, signal: null, stdout: "", stderr: "",
  stdoutTruncated: false, stderrTruncated: false, startedAt: 0, finishedAt: 1, durationMs: 1, ...over,
});
const mapping = (n = 7) => ({ taskId: TASK, repo: "hakanduyar/software-factory", issueNumber: n, stableMarker: MARKER });
const engine = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ status: "MAPPED", code: "CREATED", taskId: TASK, eventKey: KEY, attempt: 1, replay: false, mapping: mapping(), ...over }) + "\n";

function stubRunner(res: ProcessResult | (() => Promise<ProcessResult>)): ProcessRunner & { requests: ProcessRequest[] } {
  const requests: ProcessRequest[] = [];
  return { requests, run: async (r) => { requests.push(r); return typeof res === "function" ? res() : res; } };
}

interface Dirs { args: GithubTaskCreateArgs; root: string }
function dirs(): Dirs {
  const root = mk();
  const repositoryRoot = join(root, "repo");
  mkdirSync(join(repositoryRoot, "scripts", "github"), { recursive: true });
  writeFileSync(join(repositoryRoot, ...TASK_CREATE_ENTRYPOINT_SEGMENTS), "# stub\n");
  const tempRoot = join(root, "tmp");
  mkdirSync(tempRoot);
  const eventPath = join(root, "event.json");
  writeFileSync(eventPath, "{}");
  const pwshPath = join(root, "pwsh");
  writeFileSync(pwshPath, "#!/bin/sh\n");
  chmodSync(pwshPath, 0o755);
  return {
    root,
    args: {
      eventPath, repo: "hakanduyar/software-factory", markerNamespace: "factory-task", stateDir: join(root, "state"),
      ghPath: join(root, "gh"), ghSha256: GHSHA, transportTempRoot: tempRoot, pwshPath, repositoryRoot,
    },
  };
}

const goodFlags = (a: GithubTaskCreateArgs): string[] => [
  "--event", a.eventPath, "--repo", a.repo, "--marker-namespace", a.markerNamespace, "--state-dir", a.stateDir,
  "--gh", a.ghPath, "--gh-sha256", a.ghSha256, "--transport-temp-root", a.transportTempRoot,
  "--pwsh", a.pwshPath, "--repository-root", a.repositoryRoot,
];

describe("parseGithubTaskCreateArgs", () => {
  const { args } = dirs();
  const flags = goodFlags(args);
  const replaceValue = (flag: string, value: string): string[] => flags.map((t, i) => (flags[i - 1] === flag ? value : t));

  it("accepts the exact configuration", () => {
    const p = parseGithubTaskCreateArgs(flags);
    assert.ok(p.ok);
    if (p.ok) assert.deepEqual(p.value, args);
  });
  it("refuses missing, duplicate, unknown and case-aliased flags", () => {
    for (let i = 0; i < flags.length; i += 2) {
      assert.equal(parseGithubTaskCreateArgs([...flags.slice(0, i), ...flags.slice(i + 2)]).ok, false);
      assert.equal(parseGithubTaskCreateArgs([...flags, flags[i] as string, flags[i + 1] as string]).ok, false);
    }
    assert.equal(parseGithubTaskCreateArgs([...flags, "--extra", "x"]).ok, false);
    assert.equal(parseGithubTaskCreateArgs(flags.map((t) => (t === "--event" ? "--Event" : t))).ok, false);
    assert.equal(parseGithubTaskCreateArgs([...flags, "positional"]).ok, false);
    assert.equal(parseGithubTaskCreateArgs(replaceValue("--event", "--repo")).ok, false);
  });
  it("refuses relative/control paths, wrong config and bad hashes", () => {
    for (const f of ["--event", "--state-dir", "--gh", "--transport-temp-root", "--pwsh", "--repository-root"]) {
      assert.equal(parseGithubTaskCreateArgs(replaceValue(f, "relative/path")).ok, false, f);
      assert.equal(parseGithubTaskCreateArgs(replaceValue(f, "/abs/with\nnewline")).ok, false, f);
    }
    assert.equal(parseGithubTaskCreateArgs(replaceValue("--repo", "hakanduyar/other")).ok, false);
    assert.equal(parseGithubTaskCreateArgs(replaceValue("--repo", "HAKANDUYAR/software-factory")).ok, false);
    assert.equal(parseGithubTaskCreateArgs(replaceValue("--marker-namespace", "other")).ok, false);
    for (const h of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), ""]) {
      assert.equal(parseGithubTaskCreateArgs(replaceValue("--gh-sha256", h)).ok, false, h);
    }
  });
});

describe("existing CLI help/dispatch", () => {
  const sf = (a: string[]) => spawnSync(process.execPath, [MAIN, ...a], { encoding: "utf8", timeout: 60_000 });
  it("documents task-create and keeps other commands working", () => {
    assert.match(sf(["help"]).stdout, /sf github task-create/);
    const h = sf(["github", "task-create", "--help"]);
    assert.equal(h.status, 0);
    assert.match(h.stdout, /already-authorized operator/);
    assert.match(h.stdout, /ACTUAL remote issue creation/);
    assert.match(h.stdout, /use no real\s+remote/);
    const bad = sf(["github", "task-create", "--event", "/x"]);
    assert.equal(bad.status, 1);
    assert.match(sf(["github", "sync-status", "--help"]).stdout, /sync-status/);
    assert.equal(sf(["transitions"]).status, 0);
  });
});

describe("runGithubTaskCreate prerequisites and request shape", () => {
  it("calls the runner zero times when a prerequisite is missing or a symlink", async () => {
    const d = dirs();
    const cases: Array<[string, GithubTaskCreateArgs]> = [
      ["event missing", { ...d.args, eventPath: join(d.root, "nope.json") }],
      ["event dir", { ...d.args, eventPath: d.root }],
      ["temp root missing", { ...d.args, transportTempRoot: join(d.root, "nope") }],
      ["temp root file", { ...d.args, transportTempRoot: d.args.eventPath }],
      ["entrypoint missing", { ...d.args, repositoryRoot: d.root }],
      ["pwsh missing", { ...d.args, pwshPath: join(d.root, "nope") }],
      ["pwsh not executable", { ...d.args, pwshPath: d.args.eventPath }],
    ];
    const evLink = join(d.root, "event-link.json");
    symlinkSync(d.args.eventPath, evLink);
    cases.push(["event symlink", { ...d.args, eventPath: evLink }]);
    const trLink = join(d.root, "tmp-link");
    symlinkSync(d.args.transportTempRoot, trLink);
    cases.push(["temp root symlink", { ...d.args, transportTempRoot: trLink }]);
    for (const [name, a] of cases) {
      const r = stubRunner(procResult({ stdout: engine() }));
      const errs: string[] = [];
      assert.equal(await runGithubTaskCreate(a, { processRunner: r, error: (l) => errs.push(l) }), 1, name);
      assert.equal(r.requests.length, 0, name);
      assert.match(errs.join("\n"), /PRECHECK_REFUSED/);
    }
  });

  it("passes separate argv, the exact stdin envelope and a filtered environment", async () => {
    const d = dirs();
    const r = stubRunner(procResult({ stdout: engine() }));
    const logs: string[] = [];
    const code = await runGithubTaskCreate(d.args, {
      processRunner: r, log: (l) => logs.push(l),
      env: { PATH: "/usr/bin", HOME: "/h", GH_TOKEN: "tok-secret", GITHUB_TOKEN: "tok2", MY_SECRET: "s", ANTHROPIC_API_KEY: "k" },
    });
    assert.equal(code, 0);
    assert.equal(r.requests.length, 1);
    const q = r.requests[0] as ProcessRequest;
    assert.equal(q.executable, d.args.pwshPath);
    assert.deepEqual(q.argv, ["-NoProfile", "-NonInteractive", "-File", join(d.args.repositoryRoot, "scripts", "github", "invoke-github-task-create.ps1")]);
    assert.deepEqual(JSON.parse(q.input as string), {
      eventPath: d.args.eventPath,
      configuration: { repo: "hakanduyar/software-factory", markerNamespace: "factory-task" },
      stateDir: d.args.stateDir, ghPath: d.args.ghPath, expectedGhSha256: GHSHA, tempRoot: d.args.transportTempRoot,
    });
    assert.deepEqual(Object.keys(JSON.parse(q.input as string)), ["eventPath", "configuration", "stateDir", "ghPath", "expectedGhSha256", "tempRoot"]);
    const envText = JSON.stringify(q.env);
    for (const s of ["tok-secret", "tok2", "MY_SECRET", "ANTHROPIC_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"]) assert.ok(!envText.includes(s), s);
    assert.match(logs.join("\n"), /outcome: MAPPED /);
    assert.match(logs.join("\n"), /not task DONE/);
  });
});

describe("runGithubTaskCreate outcome classification (stub runner; not delivery evidence)", () => {
  const outcome = async (res: ProcessResult | (() => Promise<ProcessResult>)) => {
    const d = dirs();
    const logs: string[] = [];
    const errs: string[] = [];
    const code = await runGithubTaskCreate(d.args, { processRunner: stubRunner(res), log: (l) => logs.push(l), error: (l) => errs.push(l) });
    return { code, logs: logs.join("\n"), errs: errs.join("\n") };
  };
  const noMap = (status: string, code: string, extra: Record<string, unknown> = {}) =>
    procResult({ stdout: JSON.stringify({ status, code, taskId: TASK, eventKey: KEY, attempt: 1, replay: false, ...extra }) + "\n" });

  it("keeps the five engine statuses distinct, and only MAPPED succeeds", async () => {
    const mapped = await outcome(procResult({ stdout: engine() }));
    assert.equal(mapped.code, 0);
    assert.match(mapped.logs, /outcome: MAPPED code=CREATED/);
    const replay = await outcome(procResult({ stdout: engine({ code: "REPLAY", replay: true }) }));
    assert.equal(replay.code, 0);
    const upd = await outcome(procResult({ stdout: engine({ status: "MAPPED_NEEDS_UPDATE", code: "NEEDS_UPDATE" }) }));
    const unk = await outcome(noMap("UNKNOWN_SEND", "CREATE_AMBIGUOUS"));
    const ref = await outcome(noMap("REFUSED", "READ_MISMATCH"));
    const lock = await outcome(noMap("LOCKED", "LOCKED"));
    assert.deepEqual([upd.code, unk.code, ref.code, lock.code], [2, 4, 5, 3]);
    assert.match(upd.errs, /MAPPED_NEEDS_UPDATE/);
    assert.match(unk.errs, /outcome: UNKNOWN_SEND/);
    assert.match(ref.errs, /outcome: REFUSED/);
    assert.match(lock.errs, /outcome: LOCKED/);
    for (const o of [upd, unk, ref, lock]) assert.equal(o.logs, "");
    const early = await outcome(procResult({ stdout: JSON.stringify({ status: "REFUSED", code: "EVENT_MISSING", taskId: null, eventKey: null, attempt: 0, replay: false }) }));
    assert.equal(early.code, 5);
  });

  it("never reports MAPPED for malformed, extra, aliased or inconsistent results", async () => {
    const bad: ProcessResult[] = [
      procResult({ stdout: "" }),
      procResult({ stdout: "not json" }),
      procResult({ stdout: engine() + engine() }),
      procResult({ stdout: engine().slice(0, 30) }),
      procResult({ stdout: engine({ extra: 1 }) }),
      procResult({ stdout: engine({ Status: "MAPPED" }) }),
      procResult({ stdout: engine({ status: "mapped" }) }),
      procResult({ stdout: engine({ code: "NEEDS_UPDATE" }) }),
      procResult({ stdout: engine({ attempt: "1" }) }),
      procResult({ stdout: engine({ attempt: 1.5 }) }),
      procResult({ stdout: engine({ replay: true }) }),
      procResult({ stdout: engine({ eventKey: "X" }) }),
      procResult({ stdout: engine({ mapping: undefined }) }),
      procResult({ stdout: engine({ mapping: { ...mapping(), extra: 1 } }) }),
      procResult({ stdout: engine({ mapping: { ...mapping(), taskId: "OTHER" } }) }),
      procResult({ stdout: engine({ mapping: { ...mapping(), repo: "x/y" } }) }),
      procResult({ stdout: engine({ mapping: { ...mapping(), stableMarker: `factory-task-${"0".repeat(64)}` } }) }),
      procResult({ stdout: engine({ mapping: { ...mapping(), issueNumber: 0 } }) }),
      procResult({ stdout: engine({ mapping: { ...mapping(), issueNumber: "7" } }) }),
      procResult({ stdout: noMap("REFUSED", "READ_MISMATCH", { mapping: mapping() }).stdout }),
      procResult({ stdout: engine(), exitCode: 1 }),
      procResult({ stdout: engine(), stdoutTruncated: true }),
      procResult({ stdout: engine(), stderrTruncated: true }),
      procResult({ stdout: engine(), terminationReason: "TIMEOUT", exitCode: null }),
      procResult({ stdout: engine(), terminationReason: "CANCELLED", exitCode: null }),
      procResult({ stdout: engine(), terminationReason: "SPAWN_ERROR", exitCode: null, spawnError: "boom" }),
    ];
    for (const [i, b] of bad.entries()) {
      const o = await outcome(b);
      assert.notEqual(o.code, 0, `case ${i}`);
      assert.doesNotMatch(o.logs, /MAPPED/, `case ${i}`);
      assert.ok(o.code === 6, `case ${i} exit ${o.code}`);
      assert.match(o.errs, /PROCESS_FAILURE/);
    }
    const rejected = await outcome(() => Promise.reject(new Error("SECRET_TOKEN_VALUE")));
    assert.equal(rejected.code, 6);
    assert.ok(!rejected.errs.includes("SECRET_TOKEN_VALUE"));
  });

  it("does not echo child stderr beyond a fixed code", async () => {
    const generic = await outcome(procResult({ exitCode: 2, stderr: "C:\\secret\\path token=abc", stdout: "" }));
    assert.ok(!generic.errs.includes("secret") && !generic.errs.includes("token"));
    const fixed = await outcome(procResult({ exitCode: 2, stderr: "ENVELOPE_INVALID\n" }));
    assert.match(fixed.errs, /detail=ENVELOPE_INVALID/);
  });

  it("parseTaskCreateResult accepts exactly the valid shapes", () => {
    assert.ok(parseTaskCreateResult(JSON.parse(engine())));
    assert.equal(parseTaskCreateResult([]), undefined);
    assert.equal(parseTaskCreateResult(null), undefined);
  });
});

// ---------------------------------------------------------------------------
// Real pwsh entrypoint + unchanged engine + default pinned transport + owned fake gh.
// ---------------------------------------------------------------------------

function discoverPwsh(): string | undefined {
  const dirs = (process.env["PATH"] ?? "").split(delimiter).concat(["/opt/pwsh", "/opt/microsoft/powershell/7", "/usr/local/microsoft/powershell/7"]);
  for (const d of dirs) {
    const c = join(d, "pwsh");
    if (!d.startsWith("/") || !existsSync(c)) continue;
    const probe = spawnSync(c, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", timeout: 60_000 });
    const m = /^(\d+)\.(\d+)/.exec(probe.stdout ?? "");
    if (probe.status === 0 && m !== null && (Number(m[1]) > 7 || (Number(m[1]) === 7 && Number(m[2]) >= 6))) return c;
  }
  return undefined;
}

const FAKE_GH = `#!${process.execPath}
const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");
const root = path.dirname(path.dirname(process.argv[1]));
const args = process.argv.slice(2);
const cfgPath = path.join(root, "remote.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const log = (e) => fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify(e) + "\\n");
const flag = (n) => args[args.indexOf(n) + 1];
const R = "hakanduyar/software-factory";
const URLB = "https://github.com/" + R + "/issues/";
if (args[0] === "api" && args[1] === "--method" && args[2] === "GET" && args[3] === "repos/" + R + "/issues?state=all&per_page=100" && args[4] === "--paginate" && args[5] === "--slurp" && args.length === 6) {
  log({ op: "FIND" });
  process.stdout.write(JSON.stringify([cfg.issues.map((i) => ({ number: i.number, html_url: URLB + i.number, state: "open", body: i.body }))]));
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "create" && flag("--repo") === R) {
  log({ op: "CREATE", title: flag("--title") });
  if (cfg.mode === "ambiguous") { process.stdout.write("created something\\n"); process.exit(0); }
  const n = cfg.issues.length + 1;
  cfg.issues.push({ number: n, title: flag("--title"), body: fs.readFileSync(flag("--body-file"), "utf8") });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  process.stdout.write(URLB + n + "\\n");
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "view" && flag("--repo") === R && flag("--json") === "number,url,state,title,body") {
  log({ op: "READ", number: args[2] });
  const i = cfg.issues.find((x) => String(x.number) === args[2]);
  if (!i) process.exit(1);
  process.stdout.write(JSON.stringify({ number: i.number, url: URLB + i.number, state: "OPEN", title: i.title, body: i.body }));
  process.exit(0);
}
log({ op: "UNEXPECTED", args });
process.exit(9);
`;

const PWSH = process.platform === "win32" ? undefined : discoverPwsh();
const E2E_SKIP = process.platform === "win32" ? "e2e fixture uses a POSIX shebang fake gh (Windows only)" : false;

function e2eFixture(mode = "") {
  const root = mk();
  const bin = join(root, "bin");
  for (const d of [bin, join(root, "home"), join(root, "tmp"), join(root, "ev")]) mkdirSync(d);
  const gh = join(bin, "gh");
  writeFileSync(gh, FAKE_GH);
  chmodSync(gh, 0o755);
  writeFileSync(join(root, "remote.json"), JSON.stringify({ mode, issues: [] }));
  const eventPath = join(root, "ev", "event.json");
  writeFileSync(eventPath, JSON.stringify({
    schema: "GitHubCreateEvent/v1", taskId: TASK, canonicalVersion: 1, publicTitle: "Create the first task",
    publicSummary: "A short public summary", publicStatus: "IN_PROGRESS", nextAction: "RUN_FOCUSED_CHECKS",
  }));
  const args: GithubTaskCreateArgs = {
    eventPath, repo: "hakanduyar/software-factory", markerNamespace: "factory-task", stateDir: join(root, "state"),
    ghPath: gh, ghSha256: createHash("sha256").update(readFileSync(gh)).digest("hex"),
    transportTempRoot: join(root, "tmp"), pwshPath: PWSH ?? "", repositoryRoot: REPO_ROOT,
  };
  const env = { PATH: bin, HOME: join(root, "home"), TMPDIR: join(root, "tmp") };
  const calls = (): Array<{ op: string }> => {
    const p = join(root, "calls.jsonl");
    return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { op: string }) : [];
  };
  const run = async () => {
    const logs: string[] = [];
    const errs: string[] = [];
    const code = await runGithubTaskCreate(args, { env, timeoutMs: 120_000, log: (l) => logs.push(l), error: (l) => errs.push(l) });
    return { code, logs: logs.join("\n"), errs: errs.join("\n") };
  };
  return { root, args, env, calls, run };
}

describe("sf github task-create: real entrypoint + engine + transport with an owned fake gh", { skip: E2E_SKIP }, () => {
  it("has pwsh >= 7.6 (Linux must not skip)", () => {
    assert.ok(PWSH, "pwsh >= 7.6 is required for the authoritative e2e cases");
  });

  it("creates once, reads back, and replays idempotently with exactly one CREATE", async () => {
    const f = e2eFixture();
    const first = await f.run();
    assert.equal(first.code, 0, first.errs);
    assert.match(first.logs, /outcome: MAPPED code=CREATED taskId=TASK-1 attempt=1 replay=false issue=hakanduyar\/software-factory#1/);
    assert.deepEqual(f.calls().map((c) => c.op), ["FIND", "CREATE", "READ"]);
    const again = await f.run();
    assert.equal(again.code, 0, again.errs);
    assert.match(again.logs, /outcome: MAPPED code=REPLAY .*replay=true/);
    assert.equal(f.calls().filter((c) => c.op === "CREATE").length, 1);
    assert.ok(!f.calls().some((c) => c.op === "UNEXPECTED"));
  });

  it("never issues a second CREATE after an ambiguous CREATE", async () => {
    const f = e2eFixture("ambiguous");
    const first = await f.run();
    assert.equal(first.code, 4);
    assert.match(first.errs, /outcome: UNKNOWN_SEND code=CREATE_INVALID_RESPONSE/);
    const second = await f.run();
    assert.notEqual(second.code, 0);
    assert.doesNotMatch(second.logs, /MAPPED/);
    assert.match(second.errs, /outcome: REFUSED code=AMBIGUOUS_NO_MATCH/);
    assert.equal(f.calls().filter((c) => c.op === "CREATE").length, 1);
  });

  it("refuses a malformed envelope before any fake gh call", async () => {
    const f = e2eFixture();
    const entry = join(REPO_ROOT, ...TASK_CREATE_ENTRYPOINT_SEGMENTS);
    const good = {
      eventPath: f.args.eventPath, configuration: { repo: f.args.repo, markerNamespace: f.args.markerNamespace },
      stateDir: f.args.stateDir, ghPath: f.args.ghPath, expectedGhSha256: f.args.ghSha256, tempRoot: f.args.transportTempRoot,
    };
    const inputs = [
      "", "not json", JSON.stringify({ ...good, extra: 1 }), JSON.stringify({ ...good, EventPath: good.eventPath }),
      JSON.stringify({ ...good, expectedGhSha256: "A".repeat(64) }),
      JSON.stringify({ ...good, configuration: { repo: "x/y", markerNamespace: "factory-task" } }),
      JSON.stringify({ ...good, tempRoot: 5 }),
      JSON.stringify(good).replace("{", '{"stateDir":"/dup",'),
    ];
    for (const input of inputs) {
      const r = await createNodeProcessRunner().run({
        executable: PWSH ?? "", argv: ["-NoProfile", "-NonInteractive", "-File", entry], cwd: REPO_ROOT, env: f.env, input, timeoutMs: 120_000,
      });
      assert.equal(r.exitCode, 2, input);
      assert.equal(r.stdout, "");
    }
    assert.equal(f.calls().length, 0);
    assert.equal(existsSync(f.args.stateDir), false);
  });
});
