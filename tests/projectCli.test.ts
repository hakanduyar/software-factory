import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { createSqliteStore } from "../src/adapters/sqlite/sqliteStore.js";
import { createSqlitePlanRepository } from "../src/adapters/planning/sqlitePlanRepository.js";
import { runProjectCreate } from "../src/cli/project.js";
import { createTempWorkspace, cleanupTempWorkspaces } from "./support/tempWorkspace.js";

after(cleanupTempWorkspaces);

test("runProjectCreate persists exact key/name and returns a generated id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-project-create-"));
  const factoryDbPath = join(dir, "factory.db");
  try {
    const project = await runProjectCreate("proj-key", "Project Name", { factoryDbPath });
    assert.equal(project.key, "proj-key");
    assert.equal(project.name, "Project Name");
    assert.ok(project.id.length > 0);

    const store = createSqliteStore(factoryDbPath);
    try {
      const reloaded = await store.projects.findById(project.id);
      assert.ok(reloaded !== undefined);
      assert.equal(reloaded?.key, "proj-key");
      assert.equal(reloaded?.name, "Project Name");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runProjectCreate rejects blank key/name before the database exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-project-create-blank-"));
  const factoryDbPath = join(dir, "nested", "factory.db");
  try {
    await assert.rejects(runProjectCreate("  ", "Name", { factoryDbPath }));
    await assert.rejects(runProjectCreate("key", "  ", { factoryDbPath }));
    assert.equal(existsSync(factoryDbPath), false);
    assert.equal(existsSync(dirname(factoryDbPath)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compiled CLI 'project create' prints the project as JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-project-create-cli-"));
  const factoryDbPath = join(dir, "factory.db");
  const main = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
  try {
    const output = execFileSync(
      process.execPath,
      [main, "project", "create", "cli-key", "--name", "CLI Name"],
      { env: { ...process.env, FACTORY_DB_PATH: factoryDbPath } },
    ).toString("utf8");
    const lines = output.trim().split("\n");
    const parsed = JSON.parse(lines[lines.length - 1] as string);
    assert.equal(parsed.key, "cli-key");
    assert.equal(parsed.name, "CLI Name");
    assert.ok(typeof parsed.id === "string" && parsed.id.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compiled CLI 'project create' then 'plan request' persists a DRAFT using the returned project id", async () => {
  const workspace = createTempWorkspace();
  const dir = mkdtempSync(join(tmpdir(), "sf-project-plan-cli-"));
  const factoryDbPath = join(dir, "factory.db");
  const loopsDbPath = join(dir, "loops.db");
  const plansDbPath = join(dir, "plans.db");
  const intentPath = join(dir, "intent.txt");
  const configPath = join(dir, "config.json");
  writeFileSync(intentPath, "Bootstrap intent.");
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

  const main = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
  const childEnv = {
    ...process.env,
    FACTORY_DB_PATH: factoryDbPath,
    FACTORY_LOOPS_DB_PATH: loopsDbPath,
    FACTORY_PLANS_DB_PATH: plansDbPath,
  };

  try {
    const createOutput = execFileSync(
      process.execPath,
      [main, "project", "create", "bootstrap-key", "--name", "Bootstrap Project"],
      { cwd: workspace, env: childEnv },
    ).toString("utf8");
    const createLines = createOutput.trim().split("\n");
    const project = JSON.parse(createLines[createLines.length - 1] as string);

    execFileSync(
      process.execPath,
      [main, "plan", "request", project.id, "--intent", intentPath, "--config", configPath],
      { cwd: workspace, env: childEnv },
    );

    const plans = createSqlitePlanRepository(plansDbPath);
    try {
      const stored = await plans.listByProject(project.id);
      assert.equal(stored.length, 1);
      const row = stored[0];
      assert.ok(row);
      assert.equal(row.phase, "DRAFT");
      assert.equal(row.intent, "Bootstrap intent.");
      assert.equal(row.totalPlannerRuns, 0);
      assert.equal(row.materialized.length, 0);
      assert.equal(row.dispatches.length, 0);
    } finally {
      plans.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI refuses missing name/key before touching the database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-project-create-missing-"));
  const factoryDbPath = join(dir, "factory.db");
  const main = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
  try {
    assert.throws(() =>
      execFileSync(process.execPath, [main, "project", "create"], {
        env: { ...process.env, FACTORY_DB_PATH: factoryDbPath },
      }),
    );
    assert.throws(() =>
      execFileSync(process.execPath, [main, "project", "create", "onlykey"], {
        env: { ...process.env, FACTORY_DB_PATH: factoryDbPath },
      }),
    );
    assert.throws(() =>
      execFileSync(process.execPath, [main, "project", "create", "--name", "Name"], {
        env: { ...process.env, FACTORY_DB_PATH: factoryDbPath },
      }),
    );
    assert.throws(() =>
      execFileSync(process.execPath, [main, "project", "create", "key", "--name"], {
        env: { ...process.env, FACTORY_DB_PATH: factoryDbPath },
      }),
    );
    assert.equal(existsSync(factoryDbPath), false);
    const helpOutput = execFileSync(process.execPath, [main, "help"]).toString("utf8");
    assert.match(helpOutput, /sf project create/);
    assert.match(helpOutput, /sf plan start/);
    assert.match(helpOutput, /sf plan request/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
