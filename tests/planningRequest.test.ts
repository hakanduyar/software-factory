/**
 * PHASE7-112. `requestOnly` persists an inspectable plan without driving any
 * planner, loop or work item. These tests prove zero planner invocation on
 * the request path, exact unchanged default `start()` behavior, idempotent
 * repeated requests, requestOnly against an already-advanced plan, and real
 * SQLite persistence of the verbatim intent/config.
 */

import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import {
  newPlanning,
  PLAN_HUMAN,
  testExecutionConfig,
  TEST_PLANNER_CONFIG,
  simplePlanResponse,
} from "./support/planFixtures.js";
import { createTempWorkspace, cleanupTempWorkspaces } from "./support/tempWorkspace.js";
import { createSqliteStore } from "../src/adapters/sqlite/sqliteStore.js";
import { createSqlitePlanRepository } from "../src/adapters/planning/sqlitePlanRepository.js";
import { runPlanRequest } from "../src/cli/plan.js";
import type { PlannerOutcome, PlannerRequest, PlannerWorker } from "../src/planning/plannerWorker.js";

after(cleanupTempWorkspaces);

function countingPlanner(): PlannerWorker & { calls: number } {
  const worker = {
    id: "counting-planner",
    calls: 0,
    async plan(_request: PlannerRequest): Promise<PlannerOutcome> {
      worker.calls += 1;
      return { status: "SUCCEEDED" as const, rawOutput: simplePlanResponse(), summary: "must never be called" };
    },
  };
  return worker;
}

test("requestOnly persists a DRAFT without calling the planner", async () => {
  const planner = countingPlanner();
  const { service, projectId } = await newPlanning({ planner });
  const plan = await service.start({
    projectId,
    actor: PLAN_HUMAN,
    intent: "Build the thing.",
    planner: TEST_PLANNER_CONFIG,
    execution: testExecutionConfig(),
    requestOnly: true,
  });

  assert.equal(plan.phase, "DRAFT");
  assert.equal(plan.intent, "Build the thing.");
  assert.equal(plan.totalPlannerRuns, 0);
  assert.equal(plan.attemptsForCurrentRevision, 0);
  assert.equal(plan.materialized.length, 0);
  assert.equal(plan.dispatches.length, 0);
  assert.equal(planner.calls, 0);
});

test("default start (requestOnly omitted) drives the scripted planner unchanged", async () => {
  const { service, projectId } = await newPlanning();
  const plan = await service.start({
    projectId,
    actor: PLAN_HUMAN,
    intent: "Build the thing, unchanged.",
    planner: TEST_PLANNER_CONFIG,
    execution: testExecutionConfig(),
  });

  assert.equal(plan.phase, "PLAN_REVIEW");
  assert.equal(plan.totalPlannerRuns, 1);
});

test("repeating the same request with requestOnly adopts the stored plan without driving or duplicating", async () => {
  const planner = countingPlanner();
  const { service, projectId } = await newPlanning({ planner });
  const intent = "Repeat me.";
  const first = await service.start({
    projectId,
    actor: PLAN_HUMAN,
    intent,
    planner: TEST_PLANNER_CONFIG,
    execution: testExecutionConfig(),
    requestOnly: true,
  });

  const second = await service.start({
    projectId,
    actor: PLAN_HUMAN,
    intent,
    planner: TEST_PLANNER_CONFIG,
    execution: testExecutionConfig(),
    requestOnly: true,
  });

  assert.equal(second.id, first.id);
  assert.equal(second.version, first.version);
  assert.equal(second.phase, "DRAFT");
  assert.equal(second.totalPlannerRuns, 0);
  assert.equal(planner.calls, 0);
});

test("requestOnly against an already-advanced plan returns the stored phase and counters unchanged", async () => {
  const { service, projectId } = await newPlanning();
  const intent = "Advance then re-request.";
  const driven = await service.start({
    projectId,
    actor: PLAN_HUMAN,
    intent,
    planner: TEST_PLANNER_CONFIG,
    execution: testExecutionConfig(),
  });
  assert.equal(driven.phase, "PLAN_REVIEW");

  const reRequested = await service.start({
    projectId,
    actor: PLAN_HUMAN,
    intent,
    planner: TEST_PLANNER_CONFIG,
    execution: testExecutionConfig(),
    requestOnly: true,
  });

  assert.equal(reRequested.id, driven.id);
  assert.equal(reRequested.phase, "PLAN_REVIEW");
  assert.equal(reRequested.totalPlannerRuns, driven.totalPlannerRuns);
  assert.equal(reRequested.version, driven.version);
});

test("real SQLite store/plans persist a requestOnly plan with verbatim intent and config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-plan-request-sqlite-"));
  const store = createSqliteStore(join(dir, "factory.db"));
  const plans = createSqlitePlanRepository(join(dir, "plans.db"));
  try {
    const { service, projectId } = await newPlanning({ store, plans });
    const execution = testExecutionConfig();
    const plan = await service.start({
      projectId,
      actor: PLAN_HUMAN,
      intent: "Persisted verbatim intent.",
      planner: TEST_PLANNER_CONFIG,
      execution,
      requestOnly: true,
    });

    assert.equal(plan.phase, "DRAFT");
    assert.equal(plan.intent, "Persisted verbatim intent.");
    assert.deepEqual(plan.execution, execution);

    const reloaded = await plans.findById(plan.id);
    assert.ok(reloaded !== undefined);
    assert.equal(reloaded?.intent, "Persisted verbatim intent.");
    assert.equal(reloaded?.phase, "DRAFT");
  } finally {
    store.close();
    plans.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compiled CLI 'plan request' persists a DRAFT via requestOnly without driving the plan, and repeats idempotently", async () => {
  const workspace = createTempWorkspace();
  const dir = mkdtempSync(join(tmpdir(), "sf-plan-request-cli-"));
  const factoryDbPath = join(dir, "factory.db");
  const loopsDbPath = join(dir, "loops.db");
  const plansDbPath = join(dir, "plans.db");
  const intentPath = join(dir, "intent.txt");
  const configPath = join(dir, "config.json");
  writeFileSync(intentPath, "CLI persisted intent.");
  writeFileSync(
    configPath,
    JSON.stringify({
      workspace,
      planner: { tool: "codex-cli", model: "fictional-planner-model" },
      implementer: { tool: "claude-code", model: "fictional-implementer-model" },
      reviewer: { tool: "codex-cli", model: "fictional-reviewer-model" },
      verificationCommands: [{ id: "check", executable: "node", argv: ["-e", "process.exit(0)"] }],
    }),
  );

  const store = createSqliteStore(factoryDbPath);
  const plans = createSqlitePlanRepository(plansDbPath);
  let projectId: string;
  try {
    const { projectId: pid } = await newPlanning({ store, plans });
    projectId = pid;
  } finally {
    store.close();
    plans.close();
  }

  const main = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
  const childEnv = {
    ...process.env,
    FACTORY_DB_PATH: factoryDbPath,
    FACTORY_LOOPS_DB_PATH: loopsDbPath,
    FACTORY_PLANS_DB_PATH: plansDbPath,
  };

  try {
    const direct = await runPlanRequest(projectId, intentPath, configPath, {
      factoryDbPath,
      loopsDbPath,
      plansDbPath,
    });
    assert.equal(direct.phase, "DRAFT");

    execFileSync(
      process.execPath,
      [main, "plan", "request", projectId, "--intent", intentPath, "--config", configPath],
      { cwd: workspace, env: childEnv },
    );
    execFileSync(
      process.execPath,
      [main, "plan", "request", projectId, "--intent", intentPath, "--config", configPath],
      { cwd: workspace, env: childEnv },
    );

    const verifyPlans = createSqlitePlanRepository(plansDbPath);
    try {
      const stored = await verifyPlans.listByProject(projectId);
      assert.equal(stored.length, 1);
      const row = stored[0];
      assert.ok(row);
      assert.equal(row.phase, "DRAFT");
      assert.equal(row.totalPlannerRuns, 0);
      assert.equal(row.attemptsForCurrentRevision, 0);
      assert.equal(row.materialized.length, 0);
      assert.equal(row.dispatches.length, 0);
      assert.equal(row.intent, "CLI persisted intent.");
      assert.equal(row.execution.workspaceRoot, workspace);
      assert.equal(row.id, direct.id);
    } finally {
      verifyPlans.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPlanRequest rejects on missing config file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-plan-request-missing-config-"));
  const intentPath = join(dir, "intent.txt");
  writeFileSync(intentPath, "Some intent.");
  const factoryDbPath = join(dir, "factory.db");
  const loopsDbPath = join(dir, "loops.db");
  const plansDbPath = join(dir, "plans.db");

  const store = createSqliteStore(factoryDbPath);
  const plans = createSqlitePlanRepository(plansDbPath);
  let projectId: string;
  try {
    const { projectId: pid } = await newPlanning({ store, plans });
    projectId = pid;
  } finally {
    store.close();
    plans.close();
  }

  try {
    await assert.rejects(
      runPlanRequest(projectId, intentPath, undefined, {
        factoryDbPath,
        loopsDbPath,
        plansDbPath,
      }),
      /requires --config/,
    );
    await assert.rejects(
      runPlanRequest(projectId, intentPath, join(dir, "missing-config.json"), {
        factoryDbPath,
        loopsDbPath,
        plansDbPath,
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPlanRequest rejects on empty intent with a valid config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-plan-request-empty-intent-"));
  const workspace = createTempWorkspace();
  const intentPath = join(dir, "intent.txt");
  const configPath = join(dir, "config.json");
  writeFileSync(intentPath, "");
  writeFileSync(
    configPath,
    JSON.stringify({
      workspace,
      planner: { tool: "codex-cli", model: "fictional-planner-model" },
      implementer: { tool: "claude-code", model: "fictional-implementer-model" },
      reviewer: { tool: "codex-cli", model: "fictional-reviewer-model" },
      verificationCommands: [{ id: "check", executable: "node", argv: ["-e", "process.exit(0)"] }],
    }),
  );
  const factoryDbPath = join(dir, "factory.db");
  const loopsDbPath = join(dir, "loops.db");
  const plansDbPath = join(dir, "plans.db");

  const store = createSqliteStore(factoryDbPath);
  const plans = createSqlitePlanRepository(plansDbPath);
  let projectId: string;
  try {
    const { projectId: pid } = await newPlanning({ store, plans });
    projectId = pid;
  } finally {
    store.close();
    plans.close();
  }

  try {
    await assert.rejects(
      runPlanRequest(projectId, intentPath, configPath, { factoryDbPath, loopsDbPath, plansDbPath }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPlanRequest rejects on malformed config JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-plan-request-malformed-config-"));
  const intentPath = join(dir, "intent.txt");
  const configPath = join(dir, "config.json");
  writeFileSync(intentPath, "Some intent.");
  writeFileSync(configPath, "{ not valid json ");
  const factoryDbPath = join(dir, "factory.db");
  const loopsDbPath = join(dir, "loops.db");
  const plansDbPath = join(dir, "plans.db");

  const store = createSqliteStore(factoryDbPath);
  const plans = createSqlitePlanRepository(plansDbPath);
  let projectId: string;
  try {
    const { projectId: pid } = await newPlanning({ store, plans });
    projectId = pid;
  } finally {
    store.close();
    plans.close();
  }

  try {
    await assert.rejects(
      runPlanRequest(projectId, intentPath, configPath, { factoryDbPath, loopsDbPath, plansDbPath }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
