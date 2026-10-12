import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { createSqlitePlanRepository, upgradePlanSchemaV1ToV2 } from "../src/adapters/planning/sqlitePlanRepository.js";
import { ValidationError } from "../src/domain/errors.js";
import { sha256Hex } from "../src/planning/planDigest.js";
import { canonicalRequestKey, type Plan } from "../src/planning/planTypes.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import { newPlanning, PLAN_SYSTEM, TEST_PLANNER_CONFIG, testExecutionConfig } from "./support/planFixtures.js";

/** Same data, every object's keys in reverse insertion order. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseKeys);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, entry]) => [key, reverseKeys(entry)]),
    );
  }
  return value;
}

describe("PlanningService.requestLinked (real service + SQLite, first lifecycle leaf)", () => {
  after(() => cleanupTempDbs());

  const readRaw = (path: string) => {
    const raw = new DatabaseSync(path, { readOnly: true });
    try {
      return {
        plans: raw.prepare("SELECT * FROM plans ORDER BY id").all().map((row) => ({ ...row })),
        links: raw
          .prepare("SELECT bot_id,update_id,request_digest,plan_id FROM plan_request_links ORDER BY bot_id,update_id")
          .all()
          .map((row) => ({ ...row })),
      };
    } finally {
      raw.close();
    }
  };

  it("creates a request-only DRAFT, replays it across reopen, and refuses a changed chat", async () => {
    let plannerCalls = 0;
    const countingPlanner = {
      id: "counting-planner",
      async plan() {
        plannerCalls += 1;
        return { status: "FAILED" as const, rawOutput: "", summary: "must not be called" };
      },
    };

    const path = tempDbPath("requestlinked-lifecycle-");
    createSqlitePlanRepository(path).close();
    upgradePlanSchemaV1ToV2(path);

    const link = { botId: 1, updateId: 10, chatId: 100, senderId: 200 };

    // First process: real Factory project, real SQLite repository.
    const repo = createSqlitePlanRepository(path);
    let first: Plan;
    let store;
    let projectId: string;
    try {
      const f = await newPlanning({ plans: repo, planner: countingPlanner });
      store = f.store;
      projectId = f.projectId;
      const input = {
        projectId,
        actor: PLAN_SYSTEM,
        intent: "Linked lifecycle request",
        planner: TEST_PLANNER_CONFIG,
        execution: testExecutionConfig(),
      };

      first = await f.service.requestLinked(input, link);
      assert.equal(first.phase, "DRAFT");
      assert.equal(first.version, 1);
      assert.equal(first.totalPlannerRuns, 0);
      assert.equal(first.attemptsForCurrentRevision, 0);
      assert.equal(first.clarificationCycles, 0);
      assert.equal(plannerCalls, 0);
      assert.equal(f.dispatcher.startCount(), 0);
      assert.deepEqual(await repo.findById(first.id), first);
    } finally {
      repo.close();
    }

    const baseline = readRaw(path);
    assert.equal(baseline.plans.length, 1);
    assert.equal(baseline.links.length, 1);
    assert.equal(baseline.links[0]!.plan_id, first.id);
    assert.equal(baseline.links[0]!.bot_id, 1);
    assert.equal(baseline.links[0]!.update_id, 10);

    // Restart: reopened repository, original Factory store.
    const reopened = createSqlitePlanRepository(path);
    try {
      const g = await newPlanning({ plans: reopened, store, planner: countingPlanner });
      assert.equal(g.projectId, projectId);
      const input = {
        projectId,
        actor: PLAN_SYSTEM,
        intent: "Linked lifecycle request",
        planner: TEST_PLANNER_CONFIG,
        execution: testExecutionConfig(),
      };

      // Exact replay adopts the same plan.
      assert.deepEqual(await g.service.requestLinked(input, link), first);

      // Semantically identical config with different nested key order also replays.
      const reordered = {
        ...input,
        planner: reverseKeys(input.planner) as typeof input.planner,
        execution: reverseKeys(input.execution) as typeof input.execution,
      };
      assert.deepEqual(await g.service.requestLinked(reordered, link), first);
      assert.deepEqual(readRaw(path), baseline);

      // Same bot/update with a different chat is a different request: refused, nothing changes.
      await assert.rejects(
        g.service.requestLinked(input, { ...link, chatId: 101 }),
        (error: unknown) => error instanceof Error && /conflict|digest|differ|mismatch|concurren/i.test(`${error.name} ${error.message}`),
      );
      assert.deepEqual(await reopened.findById(first.id), first);
      assert.equal(g.dispatcher.startCount(), 0);
    } finally {
      reopened.close();
    }

    assert.deepEqual(readRaw(path), baseline);
    assert.equal(plannerCalls, 0);
  });

  const failIfCalledPlanner = (counter: { calls: number }) => ({
    id: "fail-if-called-planner",
    async plan() {
      counter.calls += 1;
      return { status: "FAILED" as const, rawOutput: "", summary: "must not be called" };
    },
  });

  const refusalLink = { botId: 1, updateId: 10, chatId: 100, senderId: 200 };

  it("refuses a repository without linked-request support before any project read or plan write", async () => {
    const planner = { calls: 0 };
    const f = await newPlanning({ planner: failIfCalledPlanner(planner) });
    let projectReads = 0;
    const originalGetProject = f.factory.getProject.bind(f.factory);
    (f.factory as unknown as { getProject: unknown }).getProject = (...args: Parameters<typeof originalGetProject>) => {
      projectReads += 1;
      return originalGetProject(...args);
    };
    const intent = "Unsupported repository request";

    await assert.rejects(
      f.service.requestLinked(
        { projectId: f.projectId, actor: PLAN_SYSTEM, intent, planner: TEST_PLANNER_CONFIG, execution: testExecutionConfig() },
        refusalLink,
      ),
      (error: unknown) => error instanceof ValidationError && /does not support linked requests/.test(error.message),
    );

    assert.equal(await f.plans.findActiveByRequestKey(canonicalRequestKey(f.projectId, intent, sha256Hex)), undefined);
    assert.equal(projectReads, 0);
    assert.equal(planner.calls, 0);
    assert.equal(f.dispatcher.startCount(), 0);
  });

  it("refuses supplied requestOnly and non-plain constraint arrays on SQLite, leaving storage unchanged", async () => {
    const path = tempDbPath("requestlinked-refusals-");
    createSqlitePlanRepository(path).close();
    upgradePlanSchemaV1ToV2(path);

    const planner = { calls: 0 };
    const repo = createSqlitePlanRepository(path);
    try {
      const f = await newPlanning({ plans: repo, planner: failIfCalledPlanner(planner) });
      let projectReads = 0;
      const originalGetProject = f.factory.getProject.bind(f.factory);
      (f.factory as unknown as { getProject: unknown }).getProject = (...args: Parameters<typeof originalGetProject>) => {
        projectReads += 1;
        return originalGetProject(...args);
      };
      const baseline = readRaw(path);

      const base = {
        projectId: f.projectId,
        actor: PLAN_SYSTEM,
        intent: "Linked refusal request",
        planner: TEST_PLANNER_CONFIG,
        execution: testExecutionConfig(),
      };

      const symbolArray = ["keep"];
      Object.defineProperty(symbolArray, Symbol("hidden"), { value: 1, enumerable: false });
      const hiddenElement = ["keep"];
      Object.defineProperty(hiddenElement, 0, { value: "keep", enumerable: false, writable: true, configurable: true });

      const cases: readonly { readonly name: string; readonly input: unknown; readonly message: RegExp }[] = [
        { name: "supplied requestOnly:false", input: { ...base, requestOnly: false }, message: /must not supply requestOnly/ },
        { name: "constraints with a symbol property", input: { ...base, constraints: symbolArray }, message: /constraints must not have symbol properties/ },
        { name: "constraints with a non-enumerable element", input: { ...base, constraints: hiddenElement }, message: /constraints\[0\] must be a plain data element/ },
      ];

      for (const { name, input, message } of cases) {
        await assert.rejects(
          f.service.requestLinked(input as unknown as Parameters<typeof f.service.requestLinked>[0], refusalLink),
          (error: unknown) => error instanceof ValidationError && message.test(error.message),
          name,
        );
        assert.equal(projectReads, 0, name);
        assert.equal(planner.calls, 0, name);
        assert.equal(f.dispatcher.startCount(), 0, name);
        assert.deepEqual(readRaw(path), baseline, name);
      }
    } finally {
      repo.close();
    }
  });

  it("captures input, link and the bound atomic method before the project await, ignoring later mutation and method replacement", async () => {
    type DeepMutable<T> = { -readonly [K in keyof T]: DeepMutable<T[K]> };

    const path = tempDbPath("requestlinked-deferred-");
    createSqlitePlanRepository(path).close();
    upgradePlanSchemaV1ToV2(path);

    const planner = { calls: 0 };
    const repo = createSqlitePlanRepository(path);
    let release!: () => void;
    let markEntered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let pending: Promise<Plan> | undefined;

    try {
      const f = await newPlanning({ plans: repo, planner: failIfCalledPlanner(planner) });
      const originalGetProject = f.factory.getProject.bind(f.factory);
      (f.factory as unknown as { getProject: unknown }).getProject = async (...args: Parameters<typeof originalGetProject>) => {
        markEntered();
        await gate;
        return originalGetProject(...args);
      };

      const before = "constraint before";
      const baseExecution = testExecutionConfig();
      const mutableInput = {
        projectId: f.projectId,
        actor: PLAN_SYSTEM,
        intent: "Deferred capture request",
        planner: { ...TEST_PLANNER_CONFIG } as DeepMutable<typeof TEST_PLANNER_CONFIG>,
        execution: {
          ...baseExecution,
          verificationCommands: baseExecution.verificationCommands.map((command) => ({ ...command, argv: [...command.argv] })),
        } as DeepMutable<typeof baseExecution>,
        constraints: [before],
      };
      const mutableLink = { botId: 1, updateId: 10, chatId: 100, senderId: 200 };

      const originalPlanner = structuredClone(mutableInput.planner);
      const originalExecution = structuredClone(mutableInput.execution);
      const originalLink = { ...mutableLink };
      const replayInput = () => ({
        projectId: f.projectId,
        actor: PLAN_SYSTEM,
        intent: "Deferred capture request",
        planner: structuredClone(originalPlanner),
        execution: structuredClone(originalExecution),
        constraints: [before],
      });

      pending = f.service.requestLinked(mutableInput as unknown as Parameters<typeof f.service.requestLinked>[0], mutableLink);
      await entered;

      // Mutate every caller-owned structure while the service is parked on the project read.
      (mutableInput.planner as { model: string }).model = "mutated-model";
      const firstCommand = mutableInput.execution.verificationCommands[0];
      if (firstCommand !== undefined) {
        firstCommand.argv[0] = "mutated-argv";
        firstCommand.argv.push("extra");
      }
      mutableInput.constraints[0] = "constraint after";
      mutableInput.constraints.push("added constraint");
      mutableLink.botId = 2;
      mutableLink.updateId = 20;
      mutableLink.chatId = 300;
      mutableLink.senderId = 400;

      // Replace the repository method after the service has already captured it.
      const originalCreateOrAdopt = repo.createOrAdoptLinkedRequest;
      let sentinelCalls = 0;
      (repo as unknown as { createOrAdoptLinkedRequest: unknown }).createOrAdoptLinkedRequest = () => {
        sentinelCalls += 1;
        throw new Error("sentinel createOrAdoptLinkedRequest must not be called");
      };

      release();
      const resultingPlan = await pending;

      assert.equal(sentinelCalls, 0);
      assert.equal(planner.calls, 0);
      assert.equal(f.dispatcher.startCount(), 0);
      assert.deepEqual(resultingPlan.planner, originalPlanner);
      assert.deepEqual(resultingPlan.execution, originalExecution);
      assert.deepEqual(resultingPlan.declaredConstraints, [before]);

      const persisted = await repo.findById(resultingPlan.id);
      assert.deepEqual(persisted, resultingPlan);

      const afterCreate = readRaw(path);
      assert.equal(afterCreate.plans.length, 1);
      assert.equal(afterCreate.links.length, 1);
      assert.equal(afterCreate.links[0]!.bot_id, originalLink.botId);
      assert.equal(afterCreate.links[0]!.update_id, originalLink.updateId);
      assert.equal(afterCreate.links[0]!.plan_id, resultingPlan.id);

      // The original request replays against the real database with an unchanged digest.
      (repo as unknown as { createOrAdoptLinkedRequest: unknown }).createOrAdoptLinkedRequest = originalCreateOrAdopt;
      assert.deepEqual(await f.service.requestLinked(replayInput(), originalLink), resultingPlan);
      assert.deepEqual(readRaw(path), afterCreate);
      assert.equal(planner.calls, 0);
      assert.equal(f.dispatcher.startCount(), 0);
    } finally {
      release();
      if (pending !== undefined) {
        await pending.catch(() => undefined);
      }
      repo.close();
    }
  });
});
