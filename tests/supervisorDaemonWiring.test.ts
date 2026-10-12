/** SF-R2: the shipped daemon uses the existing gated plan executor. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { createSqlitePlanRepository } from "../src/adapters/planning/sqlitePlanRepository.js";
import { createSqliteSupervisorRepository } from "../src/adapters/supervision/sqliteSupervisorRepository.js";
import { runSupervisorService } from "../src/cli/supervisor.js";
import { computePlanContentDigest } from "../src/planning/planDigest.js";
import type { Plan, PlannedWorkItem } from "../src/planning/planTypes.js";
import { DEFAULT_ROADMAP } from "../src/supervision/supervisorTypes.js";

const cli = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const temporary: string[] = [];
after(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function sandbox() {
  const directory = mkdtempSync(join(tmpdir(), "sf-daemon-wiring-"));
  temporary.push(directory);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const invocations = join(directory, "cli-invocations.jsonl");
  const responses: Record<string, { args: string[]; answer: object }> = {
    claude: { args: ["auth", "status"], answer: {
      loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max",
    } },
    codex: { args: ["doctor", "--json"], answer: { checks: {
      "auth.credentials": { status: "ok", details: { "stored auth mode": "chatgpt", "stored API key": "false" } },
    } } },
  };
  for (const [tool, response] of Object.entries(responses)) {
    // These programs can answer only local availability probes. They cannot
    // invoke a model even if production accidentally asks them to.
    writeFileSync(join(bin, tool), `#!${process.execPath}
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(invocations)}, JSON.stringify({ tool: ${JSON.stringify(tool)}, args }) + '\\n');
      if (JSON.stringify(args) !== ${JSON.stringify(JSON.stringify(response.args))}) {
        process.stderr.write('TEST REFUSAL: unexpected worker launch'); process.exit(96);
      }
      console.log(${JSON.stringify(JSON.stringify(response.answer))});
    `, { mode: 0o700 });
  }
  const supervisorDbPath = join(directory, "supervisor.db");
  const plansDbPath = join(directory, "explicit-plans.db");
  const roadmapPlansPath = join(directory, "bindings.json");
  return {
    directory, bin, invocations, supervisorDbPath, plansDbPath, roadmapPlansPath,
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      FACTORY_SUPERVISOR_DB_PATH: supervisorDbPath,
      // A positive --plans-db test must override this distinct empty database.
      FACTORY_PLANS_DB_PATH: join(directory, "wrong-plans.db"),
      FACTORY_DB_PATH: join(directory, "factory.db"),
      FACTORY_LOOPS_DB_PATH: join(directory, "loops.db"),
    },
  };
}

type Sandbox = ReturnType<typeof sandbox>;

async function seed(fixture: Sandbox): Promise<void> {
  const plans = createSqlitePlanRepository(fixture.plansDbPath);
  try { await plans.create(blockedPlanFixture()); } finally { plans.close(); }
  writeFileSync(fixture.roadmapPlansPath, JSON.stringify({ LOCAL_24_7_RUNTIME: "plan-blocked-1" }));
  const repository = createSqliteSupervisorRepository(fixture.supervisorDbPath);
  try {
    await repository.create({
      version: 1, financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [], roadmap: DEFAULT_ROADMAP, checkpoints: [], escalations: [], provenance: [], updatedAt: Date.now(),
    });
  } finally { repository.close(); }
}

function runCli(fixture: Sandbox, args: string[]) {
  return spawnSync(process.execPath, [cli, "supervisor", "run", ...args], {
    cwd: fixture.directory, env: fixture.env, encoding: "utf8", timeout: 5000,
  });
}

function openHandlesWithin(directory: string): string[] {
  return readdirSync("/proc/self/fd").flatMap((fd) => {
    try {
      const target = readlinkSync(`/proc/self/fd/${fd}`);
      return target.startsWith(directory + "/") ? [target] : [];
    } catch { return []; }
  });
}

function assertOnlyProbes(fixture: Sandbox): void {
  const calls = existsSync(fixture.invocations)
    ? readFileSync(fixture.invocations, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { tool: string; args: string[] })
    : [];
  for (const call of calls) {
    assert.deepEqual(call.args, call.tool === "claude" ? ["auth", "status"] : ["doctor", "--json"]);
  }
}

async function boundPlanThroughCli(fixture: Sandbox, drivePlans: boolean): Promise<void> {
  const repository = createSqliteSupervisorRepository(fixture.supervisorDbPath);
  const child = spawn(process.execPath, [cli, "supervisor", "run", "--roadmap-plans", fixture.roadmapPlansPath,
    "--plans-db", fixture.plansDbPath, ...(drivePlans ? ["--drive-plans"] : [])], {
    cwd: fixture.directory, env: fixture.env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (part: Buffer) => { output += part.toString(); });
  child.stderr.on("data", (part: Buffer) => { output += part.toString(); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const guard = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const deadline = Date.now() + 8000;
    let reached = false;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      const state = await repository.load();
      reached = state?.escalations.some((entry) =>
        entry.roadmapKey === "LOCAL_24_7_RUNTIME" && /plan-blocked-1.*BLOCKED.*verifier failed/s.test(entry.detail),
      ) ?? false;
      if (reached) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(reached, true, `daemon did not persist the bound plan's real blocker: ${output}\n${JSON.stringify(await repository.load())}`);
    child.kill("SIGTERM");
    assert.deepEqual(await closed, { code: 0, signal: null }, output);
    assert.equal((await repository.load())?.supervisor, undefined, "daemon stop left ownership behind");
    assertOnlyProbes(fixture);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    clearTimeout(guard);
    repository.close();
  }
}

function blockedPlanFixture(): Plan {
  const item: PlannedWorkItem = {
    key: "WI-A",
    title: "Do the thing",
    type: "FEATURE",
    priority: "P2",
    spec: "Implement the thing.",
    acceptanceCriteria: [{ text: "It works", verificationHint: "npm test" }],
    dependsOn: [],
  };
  const contentDigest = computePlanContentDigest({
    revision: 1,
    summary: "Deliver it.",
    assumptions: [],
    constraints: [],
    risks: [],
    items: [item],
  });
  return {
    id: "plan-blocked-1",
    projectId: "prj-0001",
    requestKey: "req-blocked-1",
    version: 1,
    phase: "BLOCKED",
    failureReason: "verifier failed for command test",
    intent: "Build the thing.",
    declaredConstraints: ["roadmap-key: LOCAL_24_7_RUNTIME"],
    budget: { maxPlannerAttempts: 2, maxClarificationCycles: 2, maxTotalPlannerRuns: 6 },
    planner: { tool: "scripted", model: "test" },
    execution: {
      implementer: { tool: "scripted", model: "impl" },
      reviewer: { tool: "scripted", model: "rev" },
      verificationCommands: [{ id: "check", executable: "node", argv: ["-e", "0"] }],
      workspaceRoot: "/tmp/ws",
    },
    revisions: [
      {
        revision: 1,
        summary: "Deliver it.",
        assumptions: [],
        constraints: [],
        risks: [],
        items: [item],
        contentDigest,
        plannerRunRef: "plan-blocked-1:r1:planner:a1",
        generatedAt: 0,
      },
    ],
    openQuestions: [],
    answers: [],
    attemptsForCurrentRevision: 0,
    clarificationCycles: 0,
    totalPlannerRuns: 1,
    materialized: [],
    dispatches: [],
    cancelRequested: false,
    events: [{ seq: 1, kind: "REQUEST_CREATED", detail: "created", at: 0 }],
    startedBy: { id: "user:test", kind: "HUMAN", displayName: "Test Human" },
    startedAt: 0,
    lastTransitionAt: 0,
  };
}

describe("SF-R2 daemon plan executor wiring", () => {
  for (const args of [["--unknown"], ["--roadmap-plans"], ["--plans-db"], ["--drive-plans"]]) {
    it(`refuses invalid shipped CLI arguments ${args.join(" ")}`, () => {
      const fixture = sandbox();
      const result = runCli(fixture, args);
      assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /unexpected argument|requires a value|needs --roadmap-plans/);
      assert.equal(existsSync(fixture.supervisorDbPath), false, "invalid args reached the database");
      assertOnlyProbes(fixture);
    });
  }

  it("the shipped CLI really reads a supplied bindings path", () => {
    const fixture = sandbox();
    const result = runCli(fixture, ["--roadmap-plans", join(fixture.directory, "missing-bindings.json")]);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /ENOENT.*missing-bindings\.json/);
  });

  for (const drivePlans of [false, true]) {
    it(`persists the real bound BLOCKED plan through the shipped CLI (drive=${drivePlans})`, async () => {
      const fixture = sandbox();
      await seed(fixture);
      await boundPlanThroughCli(fixture, drivePlans);
    });
  }

  it("closes plan and supervisor databases after a normal bounded daemon run", async () => {
    const fixture = sandbox();
    await seed(fixture);
    const originalPath = process.env["PATH"];
    process.env["PATH"] = fixture.env.PATH;
    try {
      assert.deepEqual(await runSupervisorService({
        supervisorDbPath: fixture.supervisorDbPath, plansDbPath: fixture.plansDbPath,
        roadmapPlansPath: fixture.roadmapPlansPath, maxTicks: 1, log: () => {},
      }), { kind: "STOPPED", ticks: 1 });
      assert.deepEqual(openHandlesWithin(fixture.directory), []);
      assertOnlyProbes(fixture);
    } finally {
      if (originalPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = originalPath;
    }
  });

  it("closes the supervisor database when reading the binding fails", async () => {
    const fixture = sandbox();
    await assert.rejects(() => runSupervisorService({
      supervisorDbPath: fixture.supervisorDbPath,
      roadmapPlansPath: join(fixture.directory, "missing-bindings.json"), log: () => {},
    }), /ENOENT/);
    assert.deepEqual(openHandlesWithin(fixture.directory), []);
  });

  it("closes both databases when service construction fails after binding", async () => {
    const fixture = sandbox();
    await seed(fixture);
    const originalPath = process.env["PATH"];
    process.env["PATH"] = join(fixture.directory, "empty-path");
    try {
      await assert.rejects(() => runSupervisorService({
        supervisorDbPath: fixture.supervisorDbPath, plansDbPath: fixture.plansDbPath,
        roadmapPlansPath: fixture.roadmapPlansPath, log: () => {},
      }), /CLI could not be located/);
      assert.deepEqual(openHandlesWithin(fixture.directory), []);
    } finally {
      if (originalPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = originalPath;
    }
  });
});
