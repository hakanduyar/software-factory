import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSqlitePlanRepository } from "../src/adapters/planning/sqlitePlanRepository.js";
import { createTextPlanRequestAdapter } from "../src/adapters/telegram/textPlanRequest.js";
import { newPlanning, PLAN_SYSTEM, TEST_PLANNER_CONFIG, testExecutionConfig } from "./support/planFixtures.js";

test("valid text request persists a literal DRAFT plan in SQLite and is adopted after reopen without driving", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-text-plan-"));
  const dbPath = path.join(dir, "plans.sqlite");
  const text = "  Deliver offline draft  ";
  const tuple = { botId: 111, chatId: 222, senderId: 333 };
  let repo = createSqlitePlanRepository(dbPath);
  let closed = false;
  try {
    const first = await newPlanning({ plans: repo });
    const config = (projectId: string) => ({
      projectId,
      actor: PLAN_SYSTEM,
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
      allowedTuples: [tuple],
    });
    const adapter = createTextPlanRequestAdapter({ planning: first.service, config: config(first.projectId) });
    const result = await adapter.submit({ botId: 111, updateId: 0, chatId: 222, senderId: 333, text });
    assert.equal(result.phase, "DRAFT");

    const stored = await repo.findById(result.planId);
    assert.ok(stored);
    assert.equal(stored.phase, "DRAFT");
    assert.equal(stored.intent, text);
    assert.equal(stored.totalPlannerRuns, 0);
    assert.deepEqual(stored.dispatches, []);
    assert.equal(first.dispatcher.startCount(), 0);

    repo.close();
    closed = true;
    repo = createSqlitePlanRepository(dbPath);
    closed = false;

    const reopenedPlan = await repo.findById(result.planId);
    assert.ok(reopenedPlan);
    assert.equal(reopenedPlan.intent, text);
    assert.equal(reopenedPlan.phase, "DRAFT");
    assert.equal((await repo.listByProject(first.projectId)).length, 1);

    const second = await newPlanning({ plans: repo, store: first.store });
    assert.equal(second.projectId, first.projectId);
    const adapter2 = createTextPlanRequestAdapter({ planning: second.service, config: config(second.projectId) });
    const adopted = await adapter2.submit({ botId: 111, updateId: 1, chatId: 222, senderId: 333, text });
    assert.equal(adopted.planId, result.planId);
    assert.equal(adopted.phase, "DRAFT");

    const after = await repo.findById(result.planId);
    assert.ok(after);
    assert.equal(after.phase, "DRAFT");
    assert.equal(after.totalPlannerRuns, 0);
    assert.deepEqual(after.dispatches, []);
    assert.equal((await repo.listByProject(first.projectId)).length, 1);
    assert.equal(second.dispatcher.startCount(), 0);
  } finally {
    if (!closed) repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed or unauthorized envelopes are refused before any planning authority call", async () => {
  const f = await newPlanning();
  let startCalls = 0;
  const planning = Object.create(f.service) as typeof f.service;
  planning.start = ((input: Parameters<typeof f.service.start>[0]) => {
    startCalls++;
    return f.service.start(input);
  }) as typeof f.service.start;
  const adapter = createTextPlanRequestAdapter({
    planning,
    config: {
      projectId: f.projectId,
      actor: PLAN_SYSTEM,
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
      allowedTuples: [{ botId: 111, chatId: 222, senderId: 333 }],
    },
  });
  const valid = () => ({ botId: 111, updateId: 0, chatId: 222, senderId: 333, text: "Valid refusal baseline" });

  const baseline = await adapter.submit(valid());
  assert.equal(baseline.phase, "DRAFT");
  assert.equal((await f.plans.listByProject(f.projectId)).length, 1);
  assert.equal(startCalls, 1);
  startCalls = 0;

  let getterCalls = 0;
  const withGetter = () => {
    const { text: _text, ...rest } = valid();
    return Object.defineProperty(rest, "text", {
      enumerable: true,
      get() {
        getterCalls++;
        return "Valid refusal baseline";
      },
    });
  };
  const withHidden = () => Object.defineProperty(valid(), "hidden", { value: 1, enumerable: false });
  const withSymbol = () => ({ ...valid(), [Symbol("extra")]: 1 });
  const { text: _omitted, ...missingText } = valid();

  const cases: Array<[string, () => unknown]> = [
    ["unauthorized bot", () => ({ ...valid(), botId: 999 })],
    ["unauthorized chat", () => ({ ...valid(), chatId: 999 })],
    ["unauthorized sender", () => ({ ...valid(), senderId: 999 })],
    ["extra projectId authority", () => ({ ...valid(), projectId: "other-project" })],
    ["extra request-only authority", () => ({ ...valid(), actor: PLAN_SYSTEM })],
    ["missing text", () => missingText],
    ["array envelope", () => [valid()]],
    ["null envelope", () => null],
    ["string updateId", () => ({ ...valid(), updateId: "0" })],
    ["non-safe-integer updateId", () => ({ ...valid(), updateId: Number.MAX_SAFE_INTEGER + 1 })],
    ["zero bot", () => ({ ...valid(), botId: 0 })],
    ["zero sender", () => ({ ...valid(), senderId: 0 })],
    ["zero chat", () => ({ ...valid(), chatId: 0 })],
    ["whitespace-only text", () => ({ ...valid(), text: " \t\n " })],
    ["4001 code point text", () => ({ ...valid(), text: "😀".repeat(4001) })],
    ["enumerable accessor text", withGetter],
    ["extra symbol property", withSymbol],
    ["extra non-enumerable property", withHidden],
  ];

  for (const [label, make] of cases) {
    await assert.rejects(async () => adapter.submit(make() as never), label);
    assert.equal(startCalls, 0, `${label}: planning.start called`);
  }
  assert.equal(getterCalls, 0, "accessor must never be read");
  assert.equal((await f.plans.listByProject(f.projectId)).length, 1);
  assert.equal(f.dispatcher.startCount(), 0);
});

test("caller mutation of config, tuples and the planning.start property after construction cannot alter the captured request", async () => {
  const f = await newPlanning();
  const actor = { ...PLAN_SYSTEM };
  const planner = { ...TEST_PLANNER_CONFIG };
  const tuple = { botId: 111, chatId: 222, senderId: 333 };
  const allowedTuples = [tuple];
  const constraints = ["Keep local"];
  const budget = { maxPlannerAttempts: 2, maxTotalPlannerRuns: 2 };
  const execution = {
    ...testExecutionConfig(),
    verificationCommands: testExecutionConfig().verificationCommands.map((c) => ({ ...c, argv: [...c.argv] })),
  };
  const planning = { start: f.service.start.bind(f.service) };
  const config = { projectId: f.projectId, actor, planner, execution, allowedTuples, constraints, budget };

  const expectedActor = { ...PLAN_SYSTEM };
  const expectedPlanner = { ...TEST_PLANNER_CONFIG };
  const expectedBudget = { maxPlannerAttempts: 2, maxTotalPlannerRuns: 2 };
  const expectedConstraints = ["Keep local"];
  const expectedArgv = execution.verificationCommands.map((c) => [...c.argv]);
  assert.ok(expectedArgv.length > 0);

  const adapter = createTextPlanRequestAdapter({ planning, config });

  let changedStartCalls = 0;
  (config as { projectId: string }).projectId = "nonexistent-project";
  const actorRecord = actor as unknown as Record<string, unknown>;
  actorRecord["kind"] = "HUMAN";
  actorRecord["displayName"] = "Mutated actor";
  planner.model = "mutated-model";
  budget.maxTotalPlannerRuns = 99;
  constraints.push("Mutated constraint");
  tuple.senderId = 444;
  allowedTuples.push({ botId: 999, chatId: 998, senderId: 997 });
  execution.verificationCommands[0]!.argv.push("--mutated");
  planning.start = (() => {
    changedStartCalls++;
    throw new Error("replaced start must not be used");
  }) as typeof f.service.start;

  const submit = (envelope: { botId: number; chatId: number; senderId: number }) => ({
    ...envelope,
    updateId: 0,
    text: "Captured aliases request",
  });
  await assert.rejects(async () => adapter.submit(submit({ botId: 111, chatId: 222, senderId: 444 })), "mutated tuple");
  await assert.rejects(async () => adapter.submit(submit({ botId: 999, chatId: 998, senderId: 997 })), "added tuple");
  assert.equal((await f.plans.listByProject(f.projectId)).length, 0);

  const result = await adapter.submit(submit({ botId: 111, chatId: 222, senderId: 333 }));
  assert.deepEqual(Object.keys(result).sort(), ["phase", "planId"]);
  assert.equal(result.phase, "DRAFT");
  assert.equal(changedStartCalls, 0);

  const plans = await f.plans.listByProject(f.projectId);
  assert.equal(plans.length, 1);
  const stored = await f.plans.findById(result.planId);
  assert.ok(stored);
  assert.equal(stored.projectId, f.projectId);
  assert.equal(stored.intent, "Captured aliases request");
  assert.equal(stored.startedBy.kind, expectedActor.kind);
  assert.deepEqual(stored.startedBy, expectedActor);
  assert.equal(stored.planner.tool, expectedPlanner.tool);
  assert.equal(stored.planner.model, expectedPlanner.model);
  assert.equal(stored.budget.maxPlannerAttempts, expectedBudget.maxPlannerAttempts);
  assert.equal(stored.budget.maxTotalPlannerRuns, expectedBudget.maxTotalPlannerRuns);
  assert.deepEqual(stored.declaredConstraints, expectedConstraints);
  assert.deepEqual(
    stored.execution.verificationCommands.map((c) => [...c.argv]),
    expectedArgv,
  );
  assert.equal(stored.totalPlannerRuns, 0);
  assert.deepEqual(stored.dispatches, []);
  assert.equal(f.dispatcher.startCount(), 0);
});
