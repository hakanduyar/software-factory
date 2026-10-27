/**
 * Consumer boundary for projected GitHub task status.
 *
 * Part 1 drives the real projector into a recording ProcessRunner (no process).
 * Part 2 drives the real PowerShell entrypoint and the unchanged durable engine
 * against a controlled local fake `gh` placed alone on an isolated PATH, with a
 * fresh owned fixture root. It is SKIPPED (not passed) when pwsh >= 7.6 is
 * unavailable, and it fails loudly if the fake gh cannot be proven isolated, so
 * a real gh can never run.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";

import { createNodeProcessRunner } from "../src/adapters/process/nodeProcessRunner.js";
import { syncWorkItemStatus } from "../src/adapters/github/workItemStatusSync.js";
import type {
  StatusSyncDeps,
  StatusSyncMapping,
  StatusSyncRequest,
} from "../src/adapters/github/workItemStatusSync.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/ports/processRunner.js";

const REPO_ROOT = process.cwd();
const ENTRY = join(REPO_ROOT, "scripts", "github", "invoke-projected-task-status.ps1");
const MAPPING: StatusSyncMapping = {
  taskId: "T-1",
  repo: "hakanduyar/software-factory",
  issueNumber: 5,
  stableMarker: "SF-OP-CONTINUATION-119-122",
};

const ref = (referenceId: string) => ({ taskId: "T-1", specRevision: 2, runId: "run-1", referenceId });
const projectionInput = (status: string, withEvidence = false) => ({
  taskId: "T-1",
  status,
  specRevision: 2,
  runId: "run-1",
  ...(withEvidence ? { doneEvidence: { acceptance: ref("acc-1"), delivery: ref("dlv-1") } } : {}),
});
const request = (over: Partial<StatusSyncRequest> = {}): StatusSyncRequest => ({
  projectionInput: projectionInput("VERIFYING"),
  checkpointPath: join(tmpdir(), "cp.json"),
  mapping: MAPPING,
  stateDir: join(tmpdir(), "state"),
  ...over,
});

function processResult(over: Partial<ProcessResult> = {}): ProcessResult {
  return {
    terminationReason: "EXITED",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    startedAt: 0,
    finishedAt: 1,
    durationMs: 1,
    ...over,
  };
}

const KEY = "a".repeat(64);
const durable = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ status: "DELIVERED", code: "OK", key: KEY, taskId: "T-1", attempt: 1, replay: false, ...over }) + "\n";

function recorder(result: ProcessResult | (() => ProcessResult)): ProcessRunner & { requests: ProcessRequest[] } {
  const requests: ProcessRequest[] = [];
  return {
    requests,
    run: async (r: ProcessRequest) => {
      requests.push(r);
      return typeof result === "function" ? result() : result;
    },
  };
}

const fakeDeps = (runner: ProcessRunner, env?: NodeJS.ProcessEnv): StatusSyncDeps => ({
  processRunner: runner,
  pwshPath: "/opt/pwsh/pwsh",
  repositoryRoot: REPO_ROOT,
  cwd: REPO_ROOT,
  ...(env === undefined ? {} : { env }),
});

describe("syncWorkItemStatus: projector -> fixed process request", () => {
  it("sends a public-only five-field envelope over separate argv with the right pair", async () => {
    const run = recorder(processResult({ stdout: durable() }));
    const out = await syncWorkItemStatus(request(), fakeDeps(run, { PATH: "/bin", GH_TOKEN: "x", GITHUB_TOKEN: "y", SECRET: "z" }));
    assert.equal(out.kind, "SYNC_RESULT");
    assert.equal(run.requests.length, 1);
    const r = run.requests[0]!;
    assert.equal(r.executable, "/opt/pwsh/pwsh");
    assert.deepEqual(r.argv, ["-NoProfile", "-File", ENTRY]);
    assert.equal(r.cwd, REPO_ROOT);
    assert.deepEqual(r.env, { PATH: "/bin" });
    const env = JSON.parse(r.input ?? "") as Record<string, unknown>;
    assert.deepEqual(Object.keys(env), ["checkpointPath", "mapping", "stateDir", "publicStatus", "nextAction"]);
    assert.deepEqual(env["mapping"], MAPPING);
    assert.equal(env["publicStatus"], "IN_PROGRESS");
    assert.equal(env["nextAction"], "RUN_FOCUSED_CHECKS");
    assert.ok(!/run-1|specRevision|doneEvidence|VERIFYING/.test(r.input ?? ""));
  });

  it("maps REVIEW, BLOCKED and evidenced DONE to their pairs", async () => {
    const expected: Array<[ReturnType<typeof projectionInput>, string, string]> = [
      [projectionInput("REVIEW"), "WAITING_FOR_REVIEW", "INDEPENDENT_REVIEW"],
      [projectionInput("BLOCKED"), "BLOCKED", "WAIT_FOR_DEPENDENCY"],
      [projectionInput("DONE", true), "ACCEPTED_SCOPED", "RESUME_AUTHORIZED_WORK"],
    ];
    for (const [input, status, next] of expected) {
      const run = recorder(processResult({ stdout: durable() }));
      await syncWorkItemStatus(request({ projectionInput: input }), fakeDeps(run));
      const env = JSON.parse(run.requests[0]?.input ?? "") as Record<string, unknown>;
      assert.equal(env["publicStatus"], status);
      assert.equal(env["nextAction"], next);
    }
  });

  it("makes zero process calls for REFUSED and NOT_PUBLISHABLE projections", async () => {
    const cases = [projectionInput("DONE"), projectionInput("NOPE"), projectionInput("READY"), projectionInput("CANCELLED")];
    for (const input of cases) {
      const run = recorder(processResult());
      const out = await syncWorkItemStatus(request({ projectionInput: input }), fakeDeps(run));
      assert.ok(out.kind === "PROJECTION_REFUSED" || out.kind === "NOT_PUBLISHABLE");
      assert.equal(run.requests.length, 0);
    }
  });

  it("makes zero process calls for missing, mismatched or malformed mappings and paths", async () => {
    const bad: Array<[Partial<StatusSyncRequest>, string]> = [
      [{ mapping: undefined as unknown as StatusSyncMapping }, "MAPPING_INVALID"],
      [{ mapping: { ...MAPPING, taskId: "T-2" } }, "MAPPING_TASK_MISMATCH"],
      [{ mapping: { ...MAPPING, extra: 1 } as StatusSyncMapping }, "MAPPING_INVALID"],
      [{ mapping: { taskId: "T-1", repo: MAPPING.repo, issueNumber: 5 } as StatusSyncMapping }, "MAPPING_INVALID"],
      [{ mapping: { ...MAPPING, repo: "not a repo" } }, "MAPPING_INVALID"],
      [{ mapping: { ...MAPPING, repo: "a/b; rm -rf /" } }, "MAPPING_INVALID"],
      [{ mapping: { ...MAPPING, issueNumber: 0 } }, "MAPPING_INVALID"],
      [{ mapping: { ...MAPPING, issueNumber: 1.5 } }, "MAPPING_INVALID"],
      [{ mapping: { ...MAPPING, issueNumber: "5" as unknown as number } }, "MAPPING_INVALID"],
      [{ mapping: { ...MAPPING, stableMarker: "$(touch x)" } }, "MAPPING_INVALID"],
      [{ mapping: { ...MAPPING, stableMarker: "" } }, "MAPPING_INVALID"],
      [{ checkpointPath: "relative/cp.json" }, "PATH_INVALID"],
      [{ stateDir: "" }, "PATH_INVALID"],
      [{ checkpointPath: join(tmpdir(), "a\nb") }, "PATH_INVALID"],
    ];
    for (const [over, code] of bad) {
      const run = recorder(processResult());
      const out = await syncWorkItemStatus(request(over), fakeDeps(run));
      assert.deepEqual(out, { kind: "REQUEST_INVALID", code }, JSON.stringify(over));
      assert.equal(run.requests.length, 0);
    }
  });

  it("makes zero process calls for untrusted dependencies", async () => {
    const run = recorder(processResult());
    for (const deps of [
      { ...fakeDeps(run), pwshPath: "pwsh" },
      { ...fakeDeps(run), repositoryRoot: "relative" },
      { ...fakeDeps(run), cwd: "" },
      { ...fakeDeps(run), timeoutMs: 0 },
    ]) {
      assert.deepEqual(await syncWorkItemStatus(request(), deps), { kind: "REQUEST_INVALID", code: "DEPENDENCY_INVALID" });
    }
    assert.equal(run.requests.length, 0);
  });

  it("does not interpret caller data as shell syntax: injection-looking paths pass through as data", async () => {
    const run = recorder(processResult({ stdout: durable() }));
    const cp = join(tmpdir(), "$(touch PWNED);`x`&|.json");
    await syncWorkItemStatus(request({ checkpointPath: cp }), fakeDeps(run));
    assert.equal((JSON.parse(run.requests[0]?.input ?? "") as { checkpointPath: string }).checkpointPath, cp);
    assert.equal(run.requests[0]?.argv.length, 3);
  });
});

describe("syncWorkItemStatus: process and result classification", () => {
  const classify = async (result: ProcessResult) => syncWorkItemStatus(request(), fakeDeps(recorder(result)));
  const failureReason = (out: Awaited<ReturnType<typeof classify>>) => {
    assert.equal(out.kind, "PROCESS_FAILURE");
    return out.kind === "PROCESS_FAILURE" ? out.reason : "";
  };

  it("never turns termination, nonzero exit, truncation or garbage into DELIVERED", async () => {
    const delivered = durable();
    assert.equal(failureReason(await classify(processResult({ terminationReason: "TIMEOUT", exitCode: null, stdout: delivered }))), "TIMEOUT");
    assert.equal(failureReason(await classify(processResult({ terminationReason: "CANCELLED", exitCode: null, stdout: delivered }))), "CANCELLED");
    assert.equal(failureReason(await classify(processResult({ terminationReason: "SPAWN_ERROR", exitCode: null, spawnError: "ENOENT" }))), "SPAWN_ERROR");
    assert.equal(failureReason(await classify(processResult({ exitCode: 2, stdout: delivered }))), "EXIT_NONZERO");
    assert.equal(failureReason(await classify(processResult({ stdout: delivered, stdoutTruncated: true }))), "OUTPUT_TRUNCATED");
    assert.equal(failureReason(await classify(processResult({ stdout: "" }))), "RESULT_UNPARSEABLE");
    assert.equal(failureReason(await classify(processResult({ stdout: "{not json" }))), "RESULT_UNPARSEABLE");
    assert.equal(failureReason(await classify(processResult({ stdout: delivered + delivered }))), "RESULT_UNPARSEABLE");
  });

  it("rejects results outside the exact durable contract", async () => {
    const bad = [
      JSON.stringify({ status: "DELIVERED" }),
      JSON.stringify([]),
      durable({ extra: 1 }),
      durable({ status: "OK" }),
      durable({ code: "WRITE_FAILED" }),
      durable({ taskId: "T-2" }),
      durable({ taskId: null }),
      durable({ key: "short" }),
      durable({ key: null }),
      durable({ attempt: -1 }),
      durable({ attempt: 1.5 }),
      durable({ replay: "false" }),
      durable({ code: "REPLAY", replay: false }),
      durable({ code: "OK", attempt: 0 }),
      durable({ status: "PENDING", code: "OK" }),
      durable({ status: "PENDING", code: "WRITE_FAILED", attempt: 0 }),
    ];
    for (const stdout of bad) {
      assert.equal(failureReason(await classify(processResult({ stdout }))), "RESULT_INVALID", stdout);
    }
  });

  it("keeps PENDING, REFUSED, LOCKED, STALE and DELIVERED distinct, exit 0 notwithstanding", async () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{}, "DELIVERED", "OK"],
      [{ code: "REPLAY", replay: true }, "DELIVERED", "REPLAY"],
      [{ status: "PENDING", code: "READBACK_MISMATCH", attempt: 1 }, "PENDING", "READBACK_MISMATCH"],
      [{ status: "REFUSED", code: "TASK_MISMATCH", attempt: 0, key: null, taskId: null }, "REFUSED", "TASK_MISMATCH"],
      [{ status: "LOCKED", code: "LOCKED", attempt: 0 }, "LOCKED", "LOCKED"],
      [{ status: "STALE", code: "STALE", attempt: 0 }, "STALE", "STALE"],
    ];
    for (const [over, status, code] of cases) {
      const out = await classify(processResult({ stdout: durable(over) }));
      assert.equal(out.kind, "SYNC_RESULT");
      if (out.kind === "SYNC_RESULT") {
        assert.equal(out.result.status, status);
        assert.equal(out.result.code, code);
        assert.equal(out.publicStatus, "IN_PROGRESS");
      }
    }
  });

  it("bounds and redacts diagnostics without echoing the envelope", async () => {
    const token = "ghp_" + "A".repeat(30);
    const out = await classify(processResult({ exitCode: 3, stderr: `boom ${token} ${"x".repeat(5000)}` }));
    assert.equal(out.kind, "PROCESS_FAILURE");
    if (out.kind === "PROCESS_FAILURE") {
      assert.ok(!out.diagnostic.includes(token));
      assert.ok(out.diagnostic.length < 1500);
      assert.equal(out.exitCode, 3);
    }
  });

  it("reports a rejecting runner as SPAWN_ERROR", async () => {
    const out = await syncWorkItemStatus(
      request(),
      fakeDeps({ run: () => Promise.reject(new Error("boom")) }),
    );
    assert.equal(failureReason(out), "SPAWN_ERROR");
  });
});

// ---------------------------------------------------------------------------
// Part 2: real PowerShell entrypoint + unchanged engine + isolated fake gh.
// ---------------------------------------------------------------------------

function discoverPwsh(): { path?: string; skip?: string } {
  if (process.platform === "win32") return { skip: "e2e fixture uses a POSIX shebang fake gh" };
  const dirs = (process.env["PATH"] ?? "").split(delimiter).concat(["/opt/microsoft/powershell/7", "/usr/local/microsoft/powershell/7"]);
  for (const d of dirs) {
    const candidate = join(d, "pwsh");
    if (!d.startsWith("/") || !existsSync(candidate) || !statSync(candidate).isFile()) continue;
    const probe = spawnSync(candidate, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", timeout: 60_000 });
    const m = /^(\d+)\.(\d+)/.exec(probe.stdout ?? "");
    if (probe.status !== 0 || m === null) continue;
    if (Number(m[1]) > 7 || (Number(m[1]) === 7 && Number(m[2]) >= 6)) return { path: candidate };
    return { skip: `pwsh ${(probe.stdout ?? "").trim()} found; entrypoint requires >= 7.6` };
  }
  return { skip: "pwsh >= 7.6 is not installed" };
}

const PWSH = discoverPwsh();
const owned: string[] = [];
after(() => {
  for (const d of owned.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ORIGINAL_BODY = "Intro\nKeep me exactly\n\nSF-OP-CONTINUATION-119-122 stable marker line\n";
const URL5 = "https://github.com/hakanduyar/software-factory/issues/5";

const FAKE_GH = `#!${process.execPath}
const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");
const root = path.dirname(path.dirname(process.argv[1]));
const args = process.argv.slice(2);
if (args[0] === "--sf-fixture-probe") { process.stdout.write("SF_FIXTURE_GH"); process.exit(0); }
const cfgPath = path.join(root, "remote.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const log = (e) => fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify(e) + "\\n");
const flag = (n) => args[args.indexOf(n) + 1];
if (args[0] === "issue" && args[1] === "view") {
  log({ op: "READ", number: args[2], repo: flag("--repo") });
  process.stdout.write(JSON.stringify({ number: cfg.number, url: cfg.url, state: cfg.state, body: cfg.body }));
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "edit") {
  const body = fs.readFileSync(flag("--body-file"), "utf8");
  const sp = cfg.statePath;
  log({ op: "WRITE", number: args[2], repo: flag("--repo"), stateAtWrite: fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, "utf8")) : null });
  if (cfg.mode !== "dropWrite") { cfg.body = body; fs.writeFileSync(cfgPath, JSON.stringify(cfg)); }
  process.exit(0);
}
process.exit(9);
`;

interface Call { op: string; stateAtWrite?: { versions: Record<string, { state: string }> } | null }

function makeFixture(updatedAt = "2026-01-01T00:00:00Z", checkpointId = "T-1") {
  const root = mkdtempSync(join(tmpdir(), "software-factory-status-sync-"));
  owned.push(root);
  const bin = join(root, "bin");
  for (const d of [bin, join(root, "home"), join(root, "tmp")]) mkdirSync(d);
  const gh = join(bin, "gh");
  writeFileSync(gh, FAKE_GH);
  chmodSync(gh, 0o755);
  const stateDir = join(root, "state");
  const cp = join(root, "checkpoint.json");
  const writeCp = (at: string, id = checkpointId) =>
    writeFileSync(cp, JSON.stringify({ updatedAt: at, currentActiveWork: { id, status: "active" }, providerLog: "PRIVATE_SENTINEL" }));
  writeCp(updatedAt);
  const remotePath = join(root, "remote.json");
  const setRemote = (over: Record<string, unknown> = {}) =>
    writeFileSync(remotePath, JSON.stringify({ body: ORIGINAL_BODY, state: "OPEN", number: 5, url: URL5, mode: "", statePath: join(stateDir, "runtime-github-sync.state.json"), ...over }));
  setRemote();
  // Fail closed: the fake must run, and must be the only gh on the child's PATH.
  const probe = execFileSync(gh, ["--sf-fixture-probe"], { encoding: "utf8", env: {} });
  assert.equal(probe, "SF_FIXTURE_GH", "fake gh fixture is not runnable; refusing to continue");
  const env = { PATH: bin, HOME: join(root, "home"), TMPDIR: join(root, "tmp") };
  assert.equal(env.PATH, bin);
  const deps: StatusSyncDeps = {
    processRunner: createNodeProcessRunner(),
    pwshPath: PWSH.path ?? "",
    repositoryRoot: REPO_ROOT,
    cwd: root,
    timeoutMs: 120_000,
    env,
  };
  const readRemote = () => JSON.parse(readFileSync(remotePath, "utf8")) as { body: string; mode: string };
  const calls = (): Call[] => {
    const p = join(root, "calls.jsonl");
    return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call) : [];
  };
  const req = (over: Partial<StatusSyncRequest> = {}): StatusSyncRequest => ({
    projectionInput: projectionInput("VERIFYING"),
    checkpointPath: cp,
    mapping: MAPPING,
    stateDir,
    ...over,
  });
  const stateFile = join(stateDir, "runtime-github-sync.state.json");
  return { root, deps, req, calls, readRemote, setRemote, writeCp, stateFile, env };
}

const writes = (calls: Call[]) => calls.filter((c) => c.op === "WRITE");

describe("syncWorkItemStatus: TypeScript -> PowerShell entry -> durable engine (fake gh)", { skip: PWSH.skip ?? false }, () => {
  it("records PENDING before WRITE, requires readback for DELIVERED, and replays without a new WRITE", async () => {
    const f = makeFixture();
    const out = await syncWorkItemStatus(f.req(), f.deps);
    assert.equal(out.kind, "SYNC_RESULT");
    if (out.kind !== "SYNC_RESULT") return;
    assert.deepEqual([out.result.status, out.result.code, out.result.attempt], ["DELIVERED", "OK", 1]);
    assert.equal(out.result.taskId, "T-1");
    assert.deepEqual(f.calls().map((c) => c.op), ["READ", "WRITE", "READ"]);
    const atWrite = writes(f.calls())[0]?.stateAtWrite;
    assert.deepEqual(Object.values(atWrite?.versions ?? {}).map((v) => v.state), ["PENDING"]);
    const body = f.readRemote().body;
    assert.equal(body, `${ORIGINAL_BODY}\n<!-- factory-task-status:start -->\nTask: T-1\nStatus: IN_PROGRESS\nNext action: RUN_FOCUSED_CHECKS\n<!-- factory-task-status:end -->`);
    assert.ok(!body.includes("PRIVATE_SENTINEL"));

    const again = await syncWorkItemStatus(f.req(), f.deps);
    assert.equal(again.kind, "SYNC_RESULT");
    if (again.kind === "SYNC_RESULT") assert.deepEqual([again.result.status, again.result.code, again.result.replay], ["DELIVERED", "REPLAY", true]);
    assert.equal(writes(f.calls()).length, 1);
  });

  it("returns PENDING, not DELIVERED, when readback does not show the desired region", async () => {
    const f = makeFixture();
    f.setRemote({ mode: "dropWrite" });
    const out = await syncWorkItemStatus(f.req(), f.deps);
    assert.equal(out.kind, "SYNC_RESULT");
    if (out.kind === "SYNC_RESULT") assert.deepEqual([out.result.status, out.result.code], ["PENDING", "READBACK_MISMATCH"]);
    const persisted = JSON.parse(readFileSync(f.stateFile, "utf8")) as { versions: Record<string, { state: string }> };
    assert.deepEqual(Object.values(persisted.versions).map((v) => v.state), ["PENDING"]);
  });

  it("refuses missing, mismatched and stale checkpoints and a wrong destination mapping", async () => {
    const missing = makeFixture();
    rmSync(join(missing.root, "checkpoint.json"));
    let out = await syncWorkItemStatus(missing.req(), missing.deps);
    assert.ok(out.kind === "SYNC_RESULT" && out.result.status === "REFUSED" && out.result.code === "CHECKPOINT_MISSING");
    assert.equal(missing.calls().length, 0);

    const mismatched = makeFixture("2026-01-01T00:00:00Z", "T-2");
    out = await syncWorkItemStatus(mismatched.req(), mismatched.deps);
    assert.ok(out.kind === "SYNC_RESULT" && out.result.status === "REFUSED" && out.result.code === "TASK_MISMATCH");
    assert.equal(mismatched.calls().length, 0);

    const stale = makeFixture("2026-01-01T00:10:00Z");
    out = await syncWorkItemStatus(stale.req(), stale.deps);
    assert.ok(out.kind === "SYNC_RESULT" && out.result.status === "DELIVERED");
    stale.writeCp("2026-01-01T00:00:00Z");
    out = await syncWorkItemStatus(stale.req(), stale.deps);
    assert.ok(out.kind === "SYNC_RESULT" && out.result.status === "STALE");
    assert.equal(writes(stale.calls()).length, 1);

    const wrongDest = makeFixture();
    out = await syncWorkItemStatus(wrongDest.req({ mapping: { ...MAPPING, issueNumber: 6 } }), wrongDest.deps);
    assert.ok(out.kind === "SYNC_RESULT" && out.result.status === "REFUSED" && out.result.code === "DESTINATION_MISMATCH");
    assert.equal(writes(wrongDest.calls()).length, 0);
  });

  it("refuses malformed, extra, wrong-case, duplicate and injection-looking envelopes with no transport", async () => {
    const f = makeFixture();
    const base = { checkpointPath: f.root + "/checkpoint.json", mapping: { ...MAPPING }, stateDir: f.root + "/state", publicStatus: "IN_PROGRESS", nextAction: "RUN_FOCUSED_CHECKS" };
    const withMapping = (m: Record<string, unknown>) => JSON.stringify({ ...base, mapping: m });
    const dupTop = `{"checkpointPath":"${base.checkpointPath}","checkpointPath":"${base.checkpointPath}","mapping":${JSON.stringify(MAPPING)},"stateDir":"${base.stateDir}","publicStatus":"IN_PROGRESS","nextAction":"RUN_FOCUSED_CHECKS"}`;
    const dupMap = JSON.stringify(base).replace('"taskId":"T-1"', '"taskId":"T-1","taskId":"T-1"');
    const envelopes: string[] = [
      "", "not json", "[]", "{}", JSON.stringify(base) + "x", "﻿" + JSON.stringify(base),
      JSON.stringify({ ...base, extra: 1 }),
      JSON.stringify({ ...base, CheckpointPath: base.checkpointPath, checkpointPath: undefined }),
      JSON.stringify({ ...base, publicStatus: "in_progress" }),
      JSON.stringify({ ...base, publicStatus: "DONE" }),
      JSON.stringify({ ...base, nextAction: "RUN_EVERYTHING" }),
      JSON.stringify({ ...base, stateDir: 5 }),
      JSON.stringify({ ...base, checkpointPath: "relative.json" }),
      JSON.stringify({ ...base, transport: "{ param($o) }" }),
      dupTop, dupMap,
      withMapping({ ...MAPPING, extra: 1 }),
      withMapping({ taskId: "T-1", repo: MAPPING.repo, issueNumber: 5 }),
      withMapping({ ...MAPPING, TaskId: "T-1", taskId: undefined }),
      withMapping({ ...MAPPING, issueNumber: "5" }),
      withMapping({ ...MAPPING, issueNumber: 0 }),
      withMapping({ ...MAPPING, issueNumber: 5.5 }),
      withMapping({ ...MAPPING, issueNumber: 3000000000 }),
      withMapping({ ...MAPPING, taskId: "T-1; Remove-Item -Recurse /" }),
      withMapping({ ...MAPPING, taskId: "T-1\n" }),
      withMapping({ ...MAPPING, repo: "a/b$(touch PWNED)" }),
      withMapping({ ...MAPPING, stableMarker: "`touch PWNED`" }),
    ];
    for (const stdin of envelopes) {
      const r = await f.deps.processRunner.run({
        executable: PWSH.path ?? "",
        argv: ["-NoProfile", "-File", ENTRY],
        cwd: f.root,
        env: f.env,
        input: stdin,
        timeoutMs: 120_000,
      });
      assert.equal(r.terminationReason, "EXITED");
      assert.equal(r.exitCode, 2, `envelope accepted: ${stdin.slice(0, 80)} -> ${r.stdout}${r.stderr}`);
      assert.equal(r.stdout, "");
    }
    // Shell-looking path text is data: the engine sees a missing checkpoint, nothing executes.
    const evil = await syncWorkItemStatus(f.req({ checkpointPath: join(f.root, "$(touch PWNED);x.json") }), f.deps);
    assert.ok(evil.kind === "SYNC_RESULT" && evil.result.code === "CHECKPOINT_MISSING");
    assert.equal(f.calls().length, 0);
    assert.ok(!existsSync(join(f.root, "PWNED")) && !existsSync(join(f.root, "bin", "PWNED")));
  });

  it("reports a missing entrypoint as a process failure, never DELIVERED", async () => {
    const f = makeFixture();
    const out = await syncWorkItemStatus(f.req(), { ...f.deps, repositoryRoot: join(f.root, "no-such-checkout") });
    assert.equal(out.kind, "PROCESS_FAILURE");
    assert.equal(f.calls().length, 0);
  });
});
