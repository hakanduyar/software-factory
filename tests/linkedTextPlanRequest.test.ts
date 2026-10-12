/**
 * Linked text plan request adapter — real SQLite lifecycle and terminal replay.
 *
 * One authorized envelope is submitted against a REAL v2 plans database. The
 * proof is durable identity: the same (botId, updateId) resolves to the same
 * Plan across a repository close/reopen with fresh services over the same
 * store, and after a supported human cancel the replay still returns that
 * genuine CANCELLED Plan — never a resurrected or second one. No planner and
 * no loop dispatcher is ever reached.
 *
 * Fully offline: temp files only, no AI, no network, no approval granted.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { ConcurrencyError } from "../src/domain/errors.js";
import { createLinkedTextPlanRequestAdapter } from "../src/adapters/telegram/textPlanRequest.js";
import {
  createSqlitePlanRepository,
  upgradePlanSchemaV1ToV2,
  type SqlitePlanRepository,
} from "../src/adapters/planning/sqlitePlanRepository.js";
import type { PlannerOutcome, PlannerRequest, PlannerWorker } from "../src/planning/plannerWorker.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import {
  PLAN_HUMAN,
  PLAN_SYSTEM,
  TEST_PLANNER_CONFIG,
  authorizePlanHuman,
  newPlanning,
  testExecutionConfig,
  type TestPlanning,
} from "./support/planFixtures.js";

after(cleanupTempDbs);

const LITERAL_TEXT = " literal offline text ";

function envelope() {
  return { botId: 111, updateId: 10, chatId: 222, senderId: 333, text: LITERAL_TEXT };
}

function countingFailIfCalled(): PlannerWorker & { calls(): number } {
  let calls = 0;
  return {
    id: "fail-if-called",
    calls: () => calls,
    async plan(_request: PlannerRequest): Promise<PlannerOutcome> {
      calls += 1;
      throw new Error("planner must not be reached by a linked text plan request");
    },
  };
}

function rawCounts(path: string): { plans: number; links: number } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const plans = db.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number };
    const links = db.prepare("SELECT COUNT(*) AS n FROM plan_request_links").get() as { n: number };
    return { plans: Number(plans.n), links: Number(links.n) };
  } finally {
    db.close();
  }
}

describe("linked text plan request adapter over real SQLite", () => {
  it("persists one DRAFT, replays across reopen, and replays the CANCELLED plan without resurrection", async () => {
    const path = tempDbPath("linked-text-plan-");
    createSqlitePlanRepository(path).close();
    upgradePlanSchemaV1ToV2(path);

    const planner = countingFailIfCalled();
    let repo: SqlitePlanRepository | undefined = createSqlitePlanRepository(path);
    try {
      const first = await newPlanning({ plans: repo, planner });
      const config = {
        projectId: first.projectId,
        actor: PLAN_SYSTEM,
        planner: TEST_PLANNER_CONFIG,
        execution: testExecutionConfig(),
        allowedTuples: [{ botId: 111, chatId: 222, senderId: 333 }],
      };
      const input = envelope();
      const snapshot = structuredClone(input);

      const submitted = await createLinkedTextPlanRequestAdapter({ planning: first.service, config }).submit(input);
      assert.equal(submitted.phase, "DRAFT");
      assert.deepEqual(input, snapshot);

      const stored = await first.plans.findById(submitted.planId);
      assert.ok(stored);
      assert.equal(stored.phase, "DRAFT");
      assert.equal(stored.intent, LITERAL_TEXT);
      assert.deepEqual(stored.planner, TEST_PLANNER_CONFIG);
      assert.deepEqual(stored.execution, testExecutionConfig());
      assert.equal((await first.plans.listByProject(first.projectId)).length, 1);
      assert.deepEqual(rawCounts(path), { plans: 1, links: 1 });
      assert.equal(planner.calls(), 0);
      assert.equal(first.dispatcher.startCount(), 0);

      // Restart: close, reopen, fresh services over the SAME store and project.
      repo.close();
      repo = createSqlitePlanRepository(path);
      const second: TestPlanning = await newPlanning({ plans: repo, planner, store: first.store });
      assert.equal(second.projectId, first.projectId);
      const replayed = await createLinkedTextPlanRequestAdapter({ planning: second.service, config }).submit(envelope());
      assert.deepEqual(replayed, submitted);
      assert.deepEqual(rawCounts(path), { plans: 1, links: 1 });

      // Supported cancel, then replay the same envelope.
      const cancelled = await second.service.cancel(submitted.planId, PLAN_HUMAN, authorizePlanHuman(second.factory));
      assert.equal(cancelled.phase, "CANCELLED");

      const afterCancel = await createLinkedTextPlanRequestAdapter({ planning: second.service, config }).submit(envelope());
      assert.equal(afterCancel.planId, submitted.planId);
      assert.equal(afterCancel.phase, "CANCELLED");
      const current = await second.plans.findById(submitted.planId);
      assert.equal(current?.phase, "CANCELLED");
      assert.equal((await second.plans.listByProject(second.projectId)).length, 1);
      assert.deepEqual(rawCounts(path), { plans: 1, links: 1 });
      assert.equal(planner.calls(), 0);
      assert.equal(second.dispatcher.startCount(), 0);
    } finally {
      repo?.close();
    }
  });

  it("refuses same bot/update with changed text or changed authorized context, leaving raw rows untouched", async () => {
    const path = tempDbPath("linked-text-conflict-");
    createSqlitePlanRepository(path).close();
    upgradePlanSchemaV1ToV2(path);

    const planner = countingFailIfCalled();
    const repo = createSqlitePlanRepository(path);
    try {
      const t = await newPlanning({ plans: repo, planner });
      const adapter = createLinkedTextPlanRequestAdapter({
        planning: t.service,
        config: {
          projectId: t.projectId,
          actor: PLAN_SYSTEM,
          planner: TEST_PLANNER_CONFIG,
          execution: testExecutionConfig(),
          allowedTuples: [
            { botId: 111, chatId: 222, senderId: 333 },
            { botId: 111, chatId: 223, senderId: 333 },
          ],
        },
      });

      const baseline = await adapter.submit(envelope());
      assert.equal(baseline.phase, "DRAFT");
      assert.deepEqual((await adapter.submit(envelope())).planId, baseline.planId);
      const before = rawRows(path);
      assert.equal(before.plans.length, 1);
      assert.equal(before.links.length, 1);

      await assert.rejects(adapter.submit({ ...envelope(), text: "changed text" }), ConcurrencyError);
      assert.deepEqual(rawRows(path), before);

      await assert.rejects(adapter.submit({ ...envelope(), chatId: 223 }), ConcurrencyError);
      assert.deepEqual(rawRows(path), before);

      assert.equal(planner.calls(), 0);
      assert.equal(t.dispatcher.startCount(), 0);
    } finally {
      repo.close();
    }
  });
});

describe("linked text plan request adapter boundary controls", () => {
  function baseConfig() {
    return {
      projectId: "project-initial",
      actor: PLAN_SYSTEM,
      planner: structuredClone(TEST_PLANNER_CONFIG),
      execution: testExecutionConfig(),
      allowedTuples: [{ botId: 111, chatId: 222, senderId: 333 }],
    };
  }

  function collectKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        out.add(k);
        collectKeys(v, out);
      }
    }
    return out;
  }

  it("does not reach requestLinked for an unauthorized tuple", async () => {
    let calls = 0;
    const planning = {
      async requestLinked() {
        calls += 1;
        return { id: "p", phase: "DRAFT" };
      },
    };
    const adapter = createLinkedTextPlanRequestAdapter({ planning: planning as never, config: baseConfig() as never });
    await assert.rejects(adapter.submit({ ...envelope(), senderId: 999 }), /Invalid Telegram text plan request/);
    await assert.rejects(adapter.submit({ ...envelope(), chatId: 999 }), /Invalid Telegram text plan request/);
    await assert.rejects(adapter.submit({ ...envelope(), botId: 999 }), /Invalid Telegram text plan request/);
    assert.equal(calls, 0);
  });

  it("binds the method and config at construction, immune to later mutation or replacement", async () => {
    const forwarded: unknown[][] = [];
    const planning = {
      async requestLinked(...args: unknown[]) {
        forwarded.push(args);
        return { id: "p", phase: "DRAFT" };
      },
    };
    const config = baseConfig();
    const initial = structuredClone(config);
    const adapter = createLinkedTextPlanRequestAdapter({ planning: planning as never, config: config as never });

    config.projectId = "project-mutated";
    config.allowedTuples.length = 0;
    config.allowedTuples.push({ botId: 1, chatId: 2, senderId: 3 });
    (config.planner as unknown as { [k: string]: unknown }).mutated = true;
    planning.requestLinked = async () => {
      throw new Error("replaced method must not be called");
    };

    await adapter.submit(envelope());
    assert.equal(forwarded.length, 1);
    const serialized = JSON.stringify(forwarded[0]);
    assert.ok(serialized.includes(JSON.stringify(initial.projectId)));
    assert.ok(serialized.includes(JSON.stringify(LITERAL_TEXT)));
    assert.ok(!serialized.includes("project-mutated"));
    assert.ok(!serialized.includes("mutated\":true"));
    const keys = collectKeys(forwarded[0]);
    for (const forbidden of ["requestOnly", "digest", "requestDigest", "allowedTuples"]) {
      assert.ok(!keys.has(forbidden), `forwarded ${forbidden}`);
    }
    assert.deepEqual(forwarded[0], [
      {
        projectId: initial.projectId,
        actor: initial.actor,
        planner: initial.planner,
        execution: initial.execution,
        intent: LITERAL_TEXT,
      },
      { botId: 111, updateId: 10, chatId: 222, senderId: 333 },
    ]);
    assert.deepEqual(config.allowedTuples, [{ botId: 1, chatId: 2, senderId: 3 }]);
  });

  for (const key of ["requestOnly", "digest", "requestDigest"]) {
    it(`rejects runtime config key ${key} at construction before the service`, () => {
      let touched = 0;
      const stubPlan = { id: "p", phase: "DRAFT" };
      const planning = {
        async requestLinked() {
          touched += 1;
          return stubPlan;
        },
      };
      const config = { ...baseConfig(), [key]: "x" };
      const suppliedBefore = structuredClone(config);
      assert.throws(
        () => createLinkedTextPlanRequestAdapter({ planning: planning as never, config: config as never }),
        /Invalid Telegram text plan request/,
      );
      assert.equal(touched, 0);
      assert.deepEqual(config, suppliedBefore);
    });
  }
});

function rawRows(path: string): { plans: Record<string, unknown>[]; links: Record<string, unknown>[] } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const all = (sql: string) => db.prepare(sql).all().map((r) => ({ ...(r as Record<string, unknown>) }));
    return {
      plans: all("SELECT * FROM plans ORDER BY 1"),
      links: all("SELECT * FROM plan_request_links ORDER BY 1, 2"),
    };
  } finally {
    db.close();
  }
}
