/**
 * `sf plan start|status|answer|approve|reject|resume|cancel` CLI wiring
 * (docs/tasks/TASK-005-planner-task-generator.md §15) — the input-validation
 * and not-found rejection paths, all of which are reachable WITHOUT invoking a
 * model.
 *
 * WHY THE COVERAGE STOPS WHERE IT DOES. `src/cli/plan.ts` builds its planner
 * with `createCliPlannerWorker`, which launches a real Claude/Codex process the
 * moment `PlanningService.start` reaches its first planner attempt — and the
 * file deliberately exposes no injection seam for it (a `--config` file cannot
 * name a scripted planner; `WORKER_TOOLS` is `claude-code | codex-cli`). So a
 * successful `sf plan start` cannot be automated here without either invoking a
 * real AI CLI (forbidden: no test may make a real AI call, and no network is
 * available) or adding a test-only seam to production wiring (also forbidden —
 * it would weaken the very surface under test). Every case below therefore
 * fails BEFORE any worker exists to be invoked, and each one asserts that
 * structurally rather than trusting it. The end-to-end planner behaviour itself
 * is covered offline by tests/planningService.test.ts and tests/planDemo.test.ts
 * against scripted planners, exactly as tests/loopCli.test.ts leaves TASK-004's
 * real-CLI smoke to a manual run.
 *
 * What this file proves:
 *   - §15 — `start` REFUSES to run without `--config`: the workspace and worker
 *     configuration a plan executes under is captured at start, never guessed.
 *   - §15 / AC-2-adjacent — every `--config` and `--answers` field is validated
 *     at the configuration boundary, including the one that matters for command
 *     safety: `argv` is an array of strings and never a shell string.
 *   - AC-1 — a refused command creates NO authority and NO durable state: no
 *     plan row, and (proven by the absence of factory.db/loops.db) not even the
 *     FactoryService / dispatcher / planner-worker stack that could have made
 *     any.
 *   - AC-13 — every rejection path is unattended: it fails closed with an
 *     explicit message rather than prompting, and reaches no model.
 *
 * No real AI CLI is invoked and no network is touched.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { createSqlitePlanRepository } from "../src/adapters/planning/sqlitePlanRepository.js";
import {
  runPlanAnswer,
  runPlanApprove,
  runPlanCancel,
  runPlanReject,
  runPlanResume,
  runPlanStart,
  runPlanStatus,
} from "../src/cli/plan.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";

after(cleanupTempDbs);

const createdFixtureDirs: string[] = [];
after(() => {
  while (createdFixtureDirs.length > 0) {
    const dir = createdFixtureDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

const PROJECT_ID = "prj-0001";
const UNKNOWN_PLAN_ID = "plan-does-not-exist";

interface PlanDbOptions {
  readonly factoryDbPath: string;
  readonly loopsDbPath: string;
  readonly plansDbPath: string;
}

/**
 * A fresh factory.db / loops.db / plans.db trio in one throwaway directory.
 * Passing all three explicitly also pins them against `FACTORY_DB_PATH`,
 * `FACTORY_LOOPS_DB_PATH` and `FACTORY_PLANS_DB_PATH`, so an environment
 * variable in the developer's shell cannot redirect a test at real state.
 */
function dbOptions(): PlanDbOptions {
  const factoryDbPath = tempDbPath("sf-plan-cli-");
  const dir = dirname(factoryDbPath);
  return { factoryDbPath, loopsDbPath: join(dir, "loops.db"), plansDbPath: join(dir, "plans.db") };
}

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-plan-cli-test-"));
  createdFixtureDirs.push(dir);
  return dir;
}

function writeFixture(fileName: string, content: unknown): string {
  const path = join(fixtureDir(), fileName);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return path;
}

function writeIntent(text = "Add a /health endpoint so the service can be monitored.\n"): string {
  return writeFixture("intent.md", text);
}

function writeConfig(content: unknown): string {
  return writeFixture("plan-config.json", content);
}

function writeAnswers(content: unknown): string {
  return writeFixture("answers.json", content);
}

/**
 * A structurally complete `--config` whose `workspace` deliberately does not
 * exist.
 *
 * That is a safety backstop, not laziness: these cases are expected to be
 * refused by field validation long before the workspace is resolved, but if a
 * check were ever removed, `resolveWorkspace` — the very first statement of
 * `openStores` — would still refuse the run before a planner worker could be
 * constructed. No path through this file can reach a real CLI.
 */
function unusableWorkspaceConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { workspace: join(fixtureDir(), "workspace-that-does-not-exist"), ...overrides };
}

/** Plan rows durably stored for `PROJECT_ID`; 0 when plans.db was never created at all. */
async function storedPlanCount(plansDbPath: string): Promise<number> {
  if (!existsSync(plansDbPath)) {
    return 0;
  }
  const plans = createSqlitePlanRepository(plansDbPath);
  try {
    return (await plans.listByProject(PROJECT_ID)).length;
  } finally {
    plans.close();
  }
}

/**
 * Nothing durable was written, AND no model could have been invoked.
 *
 * `factory.db` and `loops.db` are opened by `openStores` — the same function
 * that builds the engineering-loop dispatcher and the `createCliPlannerWorker`
 * that would launch a real claude/codex process. Their absence is therefore a
 * structural proof that the rejection landed before any worker existed to
 * invoke, not merely an observation that none happened to run.
 */
async function assertNothingCreated(options: PlanDbOptions): Promise<void> {
  assert.equal(await storedPlanCount(options.plansDbPath), 0, "a refused command must leave no plan row behind");
  assert.equal(
    existsSync(options.factoryDbPath),
    false,
    "a refused command must never reach the wiring that opens factory.db — that is where the planner worker is built",
  );
  assert.equal(existsSync(options.loopsDbPath), false, "a refused command must never open the TASK-004 loop store");
}

/** Asserts an exact validation message without needing to narrow `unknown` to `Error`. */
function messageMatches(...patterns: readonly RegExp[]): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    for (const pattern of patterns) {
      assert.match(message, pattern);
    }
    return true;
  };
}

describe("sf plan start — --config is mandatory and validated before any store or worker exists", () => {
  it("refuses to start without --config, naming the flag", async () => {
    const options = dbOptions();
    await assert.rejects(runPlanStart(PROJECT_ID, writeIntent(), undefined, options), /--config/);
    await assertNothingCreated(options);
  });

  it("rejects a --config file that is not valid JSON", async () => {
    const options = dbOptions();
    await assert.rejects(
      runPlanStart(PROJECT_ID, writeIntent(), writeConfig("{ not json"), options),
      messageMatches(/--config file is not valid JSON/),
    );
    await assertNothingCreated(options);
  });

  it("rejects a --config file that is not a JSON object", async () => {
    const options = dbOptions();
    await assert.rejects(
      runPlanStart(PROJECT_ID, writeIntent(), writeConfig([1, 2, 3]), options),
      messageMatches(/--config file must contain a JSON object/),
    );
    await assertNothingCreated(options);
  });

  it("rejects a --config file with no workspace", async () => {
    const options = dbOptions();
    await assert.rejects(
      runPlanStart(PROJECT_ID, writeIntent(), writeConfig({ planner: { tool: "codex-cli", model: "m" } }), options),
      messageMatches(/--config file must set "workspace"/),
    );
    await assertNothingCreated(options);
  });

  it("rejects a verificationCommands entry whose argv is a string rather than an array (never a shell string)", async () => {
    const options = dbOptions();
    const config = writeConfig(
      unusableWorkspaceConfig({
        verificationCommands: [{ id: "test", executable: "npm", argv: "test --shell-like-string" }],
      }),
    );
    await assert.rejects(
      runPlanStart(PROJECT_ID, writeIntent(), config, options),
      messageMatches(/"verificationCommands\[0\]\.argv" must be an array of strings/, /never a shell string/),
    );
    await assertNothingCreated(options);
  });

  it("rejects a verificationCommands list that declares no deterministic command at all (C3)", async () => {
    const options = dbOptions();
    const config = writeConfig(unusableWorkspaceConfig({ verificationCommands: [] }));
    await assert.rejects(
      runPlanStart(PROJECT_ID, writeIntent(), config, options),
      messageMatches(/"verificationCommands" must declare at least one deterministic command/),
    );
    await assertNothingCreated(options);
  });

  it("rejects a planner whose tool is not a known WorkerTool", async () => {
    const options = dbOptions();
    const config = writeConfig(unusableWorkspaceConfig({ planner: { tool: "totally-not-a-tool", model: "m" } }));
    await assert.rejects(
      runPlanStart(PROJECT_ID, writeIntent(), config, options),
      messageMatches(/"planner\.tool" must be one of: claude-code, codex-cli/, /totally-not-a-tool/),
    );
    await assertNothingCreated(options);
  });

  it("rejects an implementer whose tool is not a known WorkerTool", async () => {
    const options = dbOptions();
    const config = writeConfig(unusableWorkspaceConfig({ implementer: { tool: "shell", model: "m" } }));
    await assert.rejects(
      runPlanStart(PROJECT_ID, writeIntent(), config, options),
      messageMatches(/"implementer\.tool" must be one of: claude-code, codex-cli/),
    );
    await assertNothingCreated(options);
  });

  it("rejects an intent file that is empty or only whitespace", async () => {
    const options = dbOptions();
    // The --config here is ALSO invalid (no workspace) on purpose: if the
    // intent check ever stopped running first, this call would still be refused
    // at configuration validation rather than reaching a real planner CLI.
    // Asserting the INTENT message is what proves the ordering.
    await assert.rejects(
      runPlanStart(PROJECT_ID, writeIntent("   \n\t  \n"), writeConfig({ planner: { tool: "codex-cli", model: "m" } }), options),
      messageMatches(/is empty; a plan needs a real goal to work from/),
    );
    await assertNothingCreated(options);
  });

  it("refuses a workspace that does not exist, before opening factory.db or building a planner worker", async () => {
    const options = dbOptions();
    const config = writeConfig({ workspace: join(fixtureDir(), "no-such-workspace") });
    await assert.rejects(runPlanStart(PROJECT_ID, writeIntent(), config, options), { code: "VALIDATION" });
    // plans.db is opened first by design (a stored plan's own configuration is
    // the only configuration for every other command), so it may exist here —
    // but it must hold nothing, and the worker-bearing stores must be untouched.
    await assertNothingCreated(options);
  });
});

describe("sf plan status|answer|approve|reject|resume|cancel — an unknown plan id fails closed, with no model invoked", () => {
  it("status on an unknown plan id rejects with NOT_FOUND", async () => {
    const options = dbOptions();
    await assert.rejects(runPlanStatus(UNKNOWN_PLAN_ID, options), { code: "NOT_FOUND" });
    await assertNothingCreated(options);
  });

  it("resume on an unknown plan id rejects with NOT_FOUND", async () => {
    const options = dbOptions();
    await assert.rejects(runPlanResume(UNKNOWN_PLAN_ID, options), { code: "NOT_FOUND" });
    await assertNothingCreated(options);
  });

  it("approve on an unknown plan id rejects with NOT_FOUND, minting no human token", async () => {
    const options = dbOptions();
    await assert.rejects(runPlanApprove(UNKNOWN_PLAN_ID, options), { code: "NOT_FOUND" });
    await assertNothingCreated(options);
  });

  it("reject on an unknown plan id rejects with NOT_FOUND", async () => {
    const options = dbOptions();
    await assert.rejects(runPlanReject(UNKNOWN_PLAN_ID, "not this one", options), { code: "NOT_FOUND" });
    await assertNothingCreated(options);
  });

  it("cancel on an unknown plan id rejects with NOT_FOUND", async () => {
    const options = dbOptions();
    await assert.rejects(runPlanCancel(UNKNOWN_PLAN_ID, options), { code: "NOT_FOUND" });
    await assertNothingCreated(options);
  });

  it("answer on an unknown plan id rejects with NOT_FOUND even when the answers file is perfectly valid", async () => {
    const options = dbOptions();
    const answers = writeAnswers([{ questionId: "q1", answer: "Archive them. Never delete." }]);
    await assert.rejects(runPlanAnswer(UNKNOWN_PLAN_ID, answers, options), { code: "NOT_FOUND" });
    await assertNothingCreated(options);
  });
});

describe("sf plan answer — --answers is validated before any store is opened", () => {
  it("rejects an --answers file that is not valid JSON", async () => {
    const options = dbOptions();
    await assert.rejects(
      runPlanAnswer(UNKNOWN_PLAN_ID, writeAnswers("{ not json"), options),
      messageMatches(/--answers file is not valid JSON/),
    );
    await assertNothingCreated(options);
  });

  it("rejects an --answers payload that is not an array", async () => {
    const options = dbOptions();
    await assert.rejects(
      runPlanAnswer(UNKNOWN_PLAN_ID, writeAnswers({ questionId: "q1", answer: "yes" }), options),
      messageMatches(/--answers file must contain a JSON array/),
    );
    await assertNothingCreated(options);
  });

  it("rejects an empty --answers array", async () => {
    const options = dbOptions();
    await assert.rejects(
      runPlanAnswer(UNKNOWN_PLAN_ID, writeAnswers([]), options),
      messageMatches(/--answers file must contain at least one answer/),
    );
    await assertNothingCreated(options);
  });

  it("rejects an --answers entry that is not an object", async () => {
    const options = dbOptions();
    await assert.rejects(
      runPlanAnswer(UNKNOWN_PLAN_ID, writeAnswers(["q1"]), options),
      messageMatches(/--answers "\[0\]" must be an object/),
    );
    await assertNothingCreated(options);
  });

  it("rejects an --answers entry with no questionId", async () => {
    const options = dbOptions();
    await assert.rejects(
      runPlanAnswer(UNKNOWN_PLAN_ID, writeAnswers([{ answer: "Archive them." }]), options),
      messageMatches(/--answers "\[0\]\.questionId" must be a non-empty string/),
    );
    await assertNothingCreated(options);
  });

  it("rejects an --answers entry whose answer is empty or only whitespace", async () => {
    const options = dbOptions();
    await assert.rejects(
      runPlanAnswer(UNKNOWN_PLAN_ID, writeAnswers([{ questionId: "q1", answer: "   " }]), options),
      messageMatches(/--answers "\[0\]\.answer" must be a non-empty string/),
    );
    await assertNothingCreated(options);
  });
});
