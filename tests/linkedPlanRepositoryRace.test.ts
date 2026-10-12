import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { createSqlitePlanRepository, upgradePlanSchemaV1ToV2 } from "../src/adapters/planning/sqlitePlanRepository.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import { newPlanning, PLAN_SYSTEM, TEST_PLANNER_CONFIG, testExecutionConfig } from "./support/planFixtures.js";

const READY_DEADLINE_MS = 15_000;
const EXIT_DEADLINE_MS = 20_000;
const CHILD_RELEASE_WAIT_MS = 15_000;

// Child: open an independent repo, signal ready, wait for ONE release marker, call once, record outcome.
const CHILD_SOURCE = `
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const [moduleUrl, payloadPath, readyPath, releasePath, resultPath, waitMs] = process.argv.slice(1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const record = (obj) => {
  writeFileSync(resultPath + ".tmp", JSON.stringify(obj));
  renameSync(resultPath + ".tmp", resultPath);
};
let repo;
let outcome;
try {
  const { createSqlitePlanRepository } = await import(moduleUrl);
  const { dbPath, candidate, binding } = JSON.parse(readFileSync(payloadPath, "utf8"));
  repo = createSqlitePlanRepository(dbPath);
  writeFileSync(readyPath, "ready");
  const deadline = Date.now() + Number(waitMs);
  while (!existsSync(releasePath) && Date.now() < deadline) await sleep(2);
  if (!existsSync(releasePath)) {
    outcome = { kind: "release-timeout" };
  } else {
    try {
      const plan = await repo.createOrAdoptLinkedRequest(candidate, binding);
      outcome = { kind: "success", plan };
    } catch (e) {
      const pick = (x) => x && typeof x === "object"
        ? { name: x.name, message: String(x.message), code: x.code, errcode: x.errcode, errstr: x.errstr }
        : { message: String(x) };
      outcome = { kind: "error", error: { ...pick(e), cause: e && e.cause !== undefined ? pick(e.cause) : undefined } };
    }
  }
} catch (e) {
  outcome = { kind: "startup-error", message: String(e && e.stack ? e.stack : e) };
} finally {
  try { repo?.close(); } catch {}
}
record(outcome);
`;

type ChildOutcome =
  | { kind: "success"; plan: unknown }
  | { kind: "error"; error: { errcode?: unknown; cause?: { errcode?: unknown } } & Record<string, unknown> }
  | { kind: "release-timeout" }
  | { kind: "startup-error"; message: string };

interface OwnedChild {
  proc: ChildProcess;
  readyPath: string;
  resultPath: string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  isExited: () => boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitUntil(label: string, deadlineMs: number, pred: () => boolean): Promise<void> {
  const end = Date.now() + deadlineMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}`);
    await sleep(5);
  }
}

describe("linked plan repository (SQLite, two-process race)", () => {
  after(() => cleanupTempDbs());

  const readRaw = (path: string) => {
    const raw = new DatabaseSync(path, { readOnly: true });
    try {
      return {
        plans: raw.prepare("SELECT * FROM plans").all(),
        links: raw
          .prepare("SELECT bot_id,update_id,request_digest,plan_id FROM plan_request_links ORDER BY bot_id,update_id")
          .all(),
      };
    } finally {
      raw.close();
    }
  };

  it("two real Node children race createOrAdoptLinkedRequest atomically", async () => {
    // Genuine DRAFT version-1 Plan in a separate, owned seed database.
    let plannerCalls = 0;
    const countingPlanner = {
      id: "counting-planner",
      async plan() {
        plannerCalls += 1;
        return { status: "FAILED" as const, rawOutput: "", summary: "must not be called" };
      },
    };
    const seedRepo = createSqlitePlanRepository(tempDbPath("linked-race-seed-"));
    let candidate;
    try {
      const f = await newPlanning({ plans: seedRepo, planner: countingPlanner });
      const started = await f.service.start({
        projectId: f.projectId,
        actor: PLAN_SYSTEM,
        intent: "Linked request race fixture",
        planner: TEST_PLANNER_CONFIG,
        execution: testExecutionConfig(),
        requestOnly: true,
      });
      assert.equal(started.phase, "DRAFT");
      assert.equal(plannerCalls, 0);
      assert.equal(f.dispatcher.startCount(), 0);
      assert.deepEqual(await seedRepo.findById(started.id), started);
      candidate = started;
    } finally {
      seedRepo.close();
    }

    // Target: v1 create, close, explicit upgrade to v2; no parent handle stays open.
    const targetPath = tempDbPath("linked-race-target-");
    createSqlitePlanRepository(targetPath).close();
    upgradePlanSchemaV1ToV2(targetPath);

    const binding = { botId: 1, updateId: 10, requestDigest: "a".repeat(64) };
    const payloadText = JSON.stringify({ dbPath: targetPath, candidate, binding });
    const candidateBefore = JSON.stringify(candidate);
    const bindingBefore = JSON.stringify(binding);
    const expectedPlan = JSON.parse(candidateBefore);
    const moduleUrl = new URL("../src/adapters/planning/sqlitePlanRepository.js", import.meta.url).href;

    const dir = mkdtempSync(join(tmpdir(), "linked-race-"));
    const payloadPath = join(dir, "payload.json");
    const releasePath = join(dir, "release");
    writeFileSync(payloadPath, payloadText);

    const children: OwnedChild[] = [];
    const spawnChild = (name: string): OwnedChild => {
      const readyPath = join(dir, `${name}.ready`);
      const resultPath = join(dir, `${name}.result.json`);
      const proc = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          CHILD_SOURCE,
          moduleUrl,
          payloadPath,
          readyPath,
          releasePath,
          resultPath,
          String(CHILD_RELEASE_WAIT_MS),
        ],
        { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
      );
      let done = false;
      let stderr = "";
      proc.stderr?.on("data", (d) => {
        if (stderr.length < 4000) stderr += String(d);
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        proc.once("error", (e) => {
          // Only a spawn failure (no PID) means no process exists; a kill/other error does not mean exit.
          if (proc.pid === undefined) done = true;
          reject(e);
        });
        proc.once("exit", (code, signal) => {
          done = true;
          resolve({ code, signal });
        });
      });
      exited.catch(() => undefined);
      const child = { proc, readyPath, resultPath, exited, isExited: () => done };
      children.push(child);
      return child;
    };

    let forcedCleanup = false;
    let primaryFailed = false;
    try {
      const a = spawnChild("a");
      const b = spawnChild("b");

      await waitUntil("both children ready", READY_DEADLINE_MS, () => existsSync(a.readyPath) && existsSync(b.readyPath));
      writeFileSync(releasePath, "go");

      const exits = await Promise.race([
        Promise.all([a.exited, b.exited]),
        sleep(EXIT_DEADLINE_MS).then(() => {
          throw new Error("child exit deadline exceeded");
        }),
      ]);
      for (const e of exits) {
        assert.equal(e.signal, null);
        assert.equal(e.code, 0);
      }

      const outcomes = [a, b].map((c) => JSON.parse(readFileSync(c.resultPath, "utf8")) as ChildOutcome);
      for (const o of outcomes) {
        assert.notEqual(o.kind, "startup-error", JSON.stringify(o));
        assert.notEqual(o.kind, "release-timeout");
      }
      const successes = outcomes.filter((o) => o.kind === "success");
      const errors = outcomes.filter((o) => o.kind === "error") as Extract<ChildOutcome, { kind: "error" }>[];
      assert.equal(successes.length + errors.length, 2);
      assert.ok(successes.length >= 1, `no success: ${JSON.stringify(outcomes)}`);
      for (const s of successes) {
        assert.deepEqual((s as { plan: unknown }).plan, expectedPlan);
      }
      for (const e of errors) {
        // Only an actual SQLITE_BUSY primary result code (5) is tolerated, never message-only matches.
        const code = e.error.errcode ?? e.error.cause?.errcode;
        assert.equal(code, 5, `unexpected loser error: ${JSON.stringify(e.error)}`);
      }

      // Authoritative state after both exits.
      const expectedLink = {
        bot_id: binding.botId,
        update_id: binding.updateId,
        request_digest: binding.requestDigest,
        plan_id: candidate.id,
      };
      const rows = readRaw(targetPath);
      assert.equal(rows.plans.length, 1);
      assert.equal(rows.links.length, 1);
      assert.deepEqual({ ...rows.links[0] }, expectedLink);

      // Inputs untouched; fresh repository replay is idempotent and rows are unchanged.
      assert.equal(JSON.stringify(candidate), candidateBefore);
      assert.equal(JSON.stringify(binding), bindingBefore);
      assert.equal(readFileSync(payloadPath, "utf8"), payloadText);

      const fresh = createSqlitePlanRepository(targetPath);
      try {
        assert.deepEqual(await fresh.findById(candidate.id), candidate);
        assert.deepEqual(await fresh.createOrAdoptLinkedRequest!(candidate, binding), candidate);
      } finally {
        fresh.close();
      }
      const after = readRaw(targetPath);
      assert.deepEqual(after.plans, rows.plans);
      assert.deepEqual(after.links, rows.links);
      assert.equal(plannerCalls, 0);
    } catch (e) {
      primaryFailed = true;
      throw e;
    } finally {
      // Owned children only; forced cleanup is never passing evidence.
      let killFailed = false;
      for (const c of children) {
        if (!c.isExited()) {
          forcedCleanup = true;
          try {
            if (!c.proc.kill()) killFailed = true;
          } catch {
            killFailed = true;
          }
        }
      }
      let exitTimedOut = false;
      try {
        await waitUntil("owned children exit after kill", EXIT_DEADLINE_MS, () => children.every((c) => c.isExited()));
      } catch {
        exitTimedOut = true;
      }
      const unresolved = children.filter((c) => !c.isExited());
      let removalFailed = false;
      let removalError: unknown;
      if (unresolved.length === 0) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (e) {
          removalFailed = true;
          removalError = e;
        }
      }
      // On the primary-failure path the original error propagates; the owned dir is retained if any child is unresolved.
      if (!primaryFailed) {
        if (removalFailed) {
          assert.fail(`owned temp removal failed; retained evidence in ${dir}: ${String(removalError)}`);
        }
        if (unresolved.length > 0 || killFailed || exitTimedOut) {
          assert.fail(`owned child cleanup failed; retained evidence in ${dir}; unresolved=${unresolved.length}`);
        }
        if (forcedCleanup) assert.fail("child had to be force-killed during cleanup");
      }
    }
  });
});
