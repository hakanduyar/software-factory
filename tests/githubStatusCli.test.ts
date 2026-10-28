/**
 * `sf github sync-status`: real Factory records -> delivered syncWorkItemStatus.
 * Fresh owned SQLite fixture, controlled ProcessRunner (no OS process, no
 * provider, no network, no real GitHub). Stub results prove CLI classification
 * only; they are NOT evidence of actual GitHub delivery.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { parseGithubSyncStatusArgs, runGithubSyncStatus } from "../src/cli/githubStatus.js";
import type { GithubSyncStatusArgs } from "../src/cli/githubStatus.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/ports/processRunner.js";
import { AGENT, cleanupTempDbs, newSqliteFactory, registeredWorker, seedWorkItem, tempDbPath, toImplementing } from "./support/factoryFixtures.js";

const MAIN = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), "sf-gh-status-cli-"));
after(() => {
  cleanupTempDbs();
  rmSync(ROOT, { recursive: true, force: true });
});

const KEY = "b".repeat(64);
const result = (over: Partial<ProcessResult> = {}): ProcessResult => ({
  terminationReason: "EXITED", exitCode: 0, signal: null, stdout: "", stderr: "",
  stdoutTruncated: false, stderrTruncated: false, startedAt: 0, finishedAt: 1, durationMs: 1, ...over,
});
const durable = (status: string, code: string, attempt = 1) =>
  JSON.stringify({ status, code, key: KEY, taskId: "WI", attempt, replay: false }) + "\n";

function runner(res: (taskId: string) => ProcessResult): ProcessRunner & { requests: ProcessRequest[] } {
  const requests: ProcessRequest[] = [];
  return {
    requests,
    run: async (r) => {
      requests.push(r);
      return res(String((JSON.parse(r.input ?? "{}") as { mapping?: { taskId?: string } }).mapping?.taskId));
    },
  };
}

interface Fixture { dbPath: string; itemId: string; runId: string; args: GithubSyncStatusArgs; foreignRunId: string }

async function fixture(status: "VERIFYING" | "IMPLEMENTING" = "VERIFYING"): Promise<Fixture> {
  const dbPath = tempDbPath("sf-gh-status-");
  const t = newSqliteFactory(dbPath);
  const item = await seedWorkItem(t.factory);
  const other = await t.factory.createWorkItem({ projectId: item.projectId, title: "other", type: "FEATURE", priority: "P2", planVersion: "v1", acceptanceCriteria: ["x"] } as never);
  await toImplementing(t.factory, item.id);
  const worker = registeredWorker(t.factory, "w-impl", ["IMPLEMENTER"]);
  const run = await t.factory.runWorker({ workItemId: item.id, role: "IMPLEMENTER", worker, instructions: "i" });
  if (status === "VERIFYING") await t.factory.advance(item.id, "VERIFYING", AGENT);
  await toImplementing(t.factory, other.id).catch(() => undefined);
  const w2 = registeredWorker(t.factory, "w-impl2", ["IMPLEMENTER"]);
  const foreign = await t.factory.runWorker({ workItemId: other.id, role: "IMPLEMENTER", worker: w2, instructions: "i" }).catch(() => undefined);
  t.store.close();
  const dir = mkdtempSync(join(ROOT, "case-"));
  const checkpointPath = join(dir, "cp.json");
  writeFileSync(checkpointPath, JSON.stringify({ currentActiveWork: { id: item.id } }));
  return {
    dbPath, itemId: item.id, runId: run.run.id, foreignRunId: foreign?.run.id ?? "run-nonexistent",
    args: {
      factoryDb: dbPath, workItemId: item.id, runId: run.run.id, checkpointPath, repo: "hakanduyar/software-factory",
      issueNumber: 7, stableMarker: "SF-MARK-1", stateDir: join(dir, "state"), pwshPath: "/opt/pwsh/pwsh", repositoryRoot: "/repo/root",
    },
  };
}

const sink = () => { const out: string[] = []; const err: string[] = []; return { out, err, log: (l: string) => void out.push(l), error: (l: string) => void err.push(l) }; };

const argv = (a: GithubSyncStatusArgs): string[] => [
  "--factory-db", a.factoryDb, "--work-item", a.workItemId, "--run-id", a.runId, "--checkpoint", a.checkpointPath,
  "--repo", a.repo, "--issue", String(a.issueNumber), "--marker", a.stableMarker, "--state-dir", a.stateDir,
  "--pwsh", a.pwshPath, "--repository-root", a.repositoryRoot,
];

describe("sf github sync-status: strict parser", () => {
  const base = argv({ factoryDb: "/a/db", workItemId: "wi", runId: "r", checkpointPath: "/a/cp", repo: "o/n", issueNumber: 3, stableMarker: "M", stateDir: "/a/s", pwshPath: "/a/pwsh", repositoryRoot: "/a/r" });
  it("accepts the complete explicit form", () => {
    const p = parseGithubSyncStatusArgs(base);
    assert.ok(p.ok && p.value.issueNumber === 3 && p.value.repositoryRoot === "/a/r");
  });
  it("rejects missing, duplicate, unknown, valueless, relative and malformed input", () => {
    const bad: string[][] = [
      base.slice(2), [...base, "--issue", "4"], [...base, "--env", "X=1"], [...base, "--script", "x"], [...base, "stray"],
      [...base.slice(0, -1)], base.map((t) => (t === "/a/pwsh" ? "pwsh" : t)), base.map((t) => (t === "/a/db" ? "rel.db" : t)),
      base.map((t) => (t === "3" ? "0" : t)), base.map((t) => (t === "3" ? "3.5" : t)), base.map((t) => (t === "3" ? "99999999999" : t)),
      base.map((t) => (t === "o/n" ? "not a repo" : t)), base.map((t) => (t === "M" ? "$(x)" : t)), base.map((t) => (t === "wi" ? "a b" : t)),
      ["--issue=3", ...base.slice(2)], base.map((t) => (t === "/a/cp" ? "--state-dir" : t)),
    ];
    for (const b of bad) assert.equal(parseGithubSyncStatusArgs(b).ok, false, JSON.stringify(b));
  });
});

describe("sf github sync-status: real records", () => {
  it("derives status/task/revision/run from records and sends the fixed command", async () => {
    const f = await fixture();
    const r = runner((id) => result({ stdout: durable("DELIVERED", "OK").replace("WI", id) }));
    const s = sink();
    const code = await runGithubSyncStatus(f.args, { ...s, processRunner: r, env: { PATH: "/bin", GH_TOKEN: "t" } });
    assert.equal(code, 0);
    assert.equal(r.requests.length, 1);
    const req = r.requests[0]!;
    assert.equal(req.executable, "/opt/pwsh/pwsh");
    assert.deepEqual(req.argv, ["-NoProfile", "-File", join(f.args.repositoryRoot, "scripts", "github", "invoke-projected-task-status.ps1")]);
    assert.deepEqual(req.env, { PATH: "/bin" });
    const env = JSON.parse(req.input ?? "") as Record<string, unknown>;
    assert.equal(env["publicStatus"], "IN_PROGRESS");
    assert.equal(env["nextAction"], "RUN_FOCUSED_CHECKS");
    assert.deepEqual(env["mapping"], { taskId: f.itemId, repo: f.args.repo, issueNumber: 7, stableMarker: "SF-MARK-1" });
    assert.equal(env["checkpointPath"], f.args.checkpointPath);
    assert.match(s.out.join("\n"), /outcome: DELIVERED code=OK/);
  });

  it("keeps process failure, PENDING, LOCKED, STALE and durable REFUSED distinct", async () => {
    const f = await fixture();
    const cases: Array<[ProcessResult, number, RegExp]> = [
      [result({ exitCode: 3 }), 6, /PROCESS_FAILURE reason=EXIT_NONZERO/],
      [result({ terminationReason: "SPAWN_ERROR", exitCode: null, spawnError: "ENOENT" }), 6, /PROCESS_FAILURE reason=SPAWN_ERROR/],
      [result({ stdout: durable("PENDING", "WRITE_FAILED") }), 2, /outcome: PENDING/],
      [result({ stdout: durable("LOCKED", "LOCKED", 0) }), 3, /outcome: LOCKED/],
      [result({ stdout: durable("STALE", "STALE", 0) }), 4, /outcome: STALE/],
      [result({ stdout: JSON.stringify({ status: "REFUSED", code: "ISSUE_CLOSED", key: null, taskId: null, attempt: 0, replay: false }) }), 5, /outcome: REFUSED/],
    ];
    for (const [res, exit, rx] of cases) {
      const s = sink();
      const code = await runGithubSyncStatus(f.args, { ...s, processRunner: runner((id) => ({ ...res, stdout: res.stdout.replace('"WI"', JSON.stringify(id)) })) });
      assert.equal(code, exit);
      assert.match([...s.out, ...s.err].join("\n"), rx);
    }
  });

  it("reports a nonpublishable status with zero process calls", async () => {
    const f = await fixture("IMPLEMENTING");
    const r = runner(() => result());
    const s = sink();
    assert.equal(await runGithubSyncStatus(f.args, { ...s, processRunner: r }), 0);
    assert.equal(r.requests.length, 0);
    assert.match(s.out.join("\n"), /NOT_PUBLISHABLE status=IMPLEMENTING/);
  });

  it("calls no process for missing item/run, foreign run, checkpoint mismatch", async () => {
    const f = await fixture();
    const attempts: Array<Partial<GithubSyncStatusArgs>> = [
      { workItemId: "wi-missing" }, { runId: "run-missing" }, { runId: f.foreignRunId },
    ];
    const badCp = join(ROOT, "bad-cp.json");
    writeFileSync(badCp, JSON.stringify({ currentActiveWork: { id: "someone-else" } }));
    attempts.push({ checkpointPath: badCp }, { checkpointPath: join(ROOT, "absent.json") });
    for (const over of attempts) {
      const r = runner(() => result());
      const s = sink();
      assert.equal(await runGithubSyncStatus({ ...f.args, ...over }, { ...s, processRunner: r }), 1, JSON.stringify(over));
      assert.equal(r.requests.length, 0);
      assert.match(s.err.join("\n"), /PRECHECK_REFUSED/);
    }
  });

  it("refuses DONE with no process", async () => {
    const f = await fixture();
    const { createSqliteStore } = await import("../src/adapters/sqlite/sqliteStore.js");
    const store = createSqliteStore(f.dbPath);
    const item = (await store.workItems.findById(f.itemId))!;
    await store.workItems.compareAndSave({ ...item, status: "DONE" }, item.version);
    store.close();
    const r = runner(() => result());
    const s = sink();
    assert.equal(await runGithubSyncStatus(f.args, { ...s, processRunner: r }), 1);
    assert.equal(r.requests.length, 0);
    assert.match(s.err.join("\n"), /DONE_REFUSED/);
  });

  it("refuses a run that is stale for the item's current spec revision", async () => {
    const f = await fixture();
    const { createSqliteStore } = await import("../src/adapters/sqlite/sqliteStore.js");
    const store = createSqliteStore(f.dbPath);
    const item = (await store.workItems.findById(f.itemId))!;
    await store.workItems.compareAndSave({ ...item, specRevision: item.specRevision + 1 }, item.version);
    store.close();
    const r = runner(() => result());
    assert.equal(await runGithubSyncStatus(f.args, { ...sink(), processRunner: r }), 1);
    assert.equal(r.requests.length, 0);
  });

  it("refuses a run that is not in the item's runIds", async () => {
    const f = await fixture();
    const { createSqliteStore } = await import("../src/adapters/sqlite/sqliteStore.js");
    const store = createSqliteStore(f.dbPath);
    const item = (await store.workItems.findById(f.itemId))!;
    await store.workItems.compareAndSave({ ...item, runIds: [] }, item.version);
    store.close();
    const r = runner(() => result());
    assert.equal(await runGithubSyncStatus(f.args, { ...sink(), processRunner: r }), 1);
    assert.equal(r.requests.length, 0);
  });

  it("never creates a missing or non-file database", async () => {
    const f = await fixture();
    const missing = join(ROOT, "nope", "missing.db");
    const r = runner(() => result());
    assert.equal(await runGithubSyncStatus({ ...f.args, factoryDb: missing }, { ...sink(), processRunner: r }), 1);
    assert.equal(existsSync(missing), false);
    assert.equal(existsSync(join(ROOT, "nope")), false);
    const dir = join(ROOT, "adir");
    mkdirSync(dir);
    assert.equal(await runGithubSyncStatus({ ...f.args, factoryDb: dir }, { ...sink(), processRunner: r }), 1);
    assert.equal(r.requests.length, 0);
  });
});

describe("sf github sync-status: actual main dispatch", () => {
  const sf = (args: string[]) => spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", timeout: 60_000 });

  it("documents the command in sf help and its own --help", () => {
    assert.match(sf(["help"]).stdout, /sf github sync-status/);
    const h = sf(["github", "sync-status", "--help"]);
    assert.equal(h.status, 0);
    assert.match(h.stdout, /--repository-root/);
  });

  it("rejects bad flags through main with a usage message and exit 1", () => {
    const r = sf(["github", "sync-status", "--bogus", "x"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unexpected argument/);
  });

  it("dispatches real records to the real runner; an absent pwsh is a process failure, not delivery", async () => {
    const f = await fixture();
    const absent = join(ROOT, "no-such-pwsh");
    const r = sf(["github", "sync-status", ...argv({ ...f.args, pwshPath: absent, repositoryRoot: ROOT })]);
    assert.equal(r.status, 6, r.stderr);
    assert.match(r.stderr, /PROCESS_FAILURE reason=SPAWN_ERROR/);
    assert.doesNotMatch(r.stdout + r.stderr, /DELIVERED/);
  });
});
