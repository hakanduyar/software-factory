import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { createSqlitePlanRepository, upgradePlanSchemaV1ToV2 } from "../src/adapters/planning/sqlitePlanRepository.js";
import { PersistenceCorruptionError, SchemaVersionError } from "../src/domain/errors.js";
import type { Plan } from "../src/planning/planTypes.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import {
  authorizePlanHuman,
  newPlanning,
  PLAN_HUMAN,
  PLAN_SYSTEM,
  TEST_PLANNER_CONFIG,
  testExecutionConfig,
  type TestPlanning,
} from "./support/planFixtures.js";

describe("linked plan repository (SQLite, first positive leaf)", () => {
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

  it("linked repository positive", async () => {
    // Seed a genuine DRAFT version-1 Plan in a separate, owned database.
    let plannerCalls = 0;
    const countingPlanner = {
      id: "counting-planner",
      async plan() {
        plannerCalls += 1;
        return { status: "FAILED" as const, rawOutput: "", summary: "must not be called" };
      },
    };
    const seedRepo = createSqlitePlanRepository(tempDbPath("linked-seed-"));
    let candidate;
    try {
      const f = await newPlanning({ plans: seedRepo, planner: countingPlanner });
      const started = await f.service.start({
        projectId: f.projectId,
        actor: PLAN_SYSTEM,
        intent: "Linked request fixture",
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

    // Target: ordinary create (v1), close, explicit upgrade to v2, reopen.
    const targetPath = tempDbPath("linked-target-");
    createSqlitePlanRepository(targetPath).close();
    upgradePlanSchemaV1ToV2(targetPath);

    const binding = { botId: 1, updateId: 10, requestDigest: "a".repeat(64) };
    const digestA = binding.requestDigest;
    const digestC = "c".repeat(64);

    const repo = createSqlitePlanRepository(targetPath);
    try {
      assert.equal(typeof repo.createOrAdoptLinkedRequest, "function");
      const link = repo.createOrAdoptLinkedRequest!.bind(repo);

      assert.deepEqual(await link(candidate, binding), candidate);
      assert.deepEqual(await link(candidate, binding), candidate);

      await assert.rejects(
        link(candidate, { ...binding, requestDigest: "b".repeat(64) }),
        (error: unknown) => error instanceof Error && /conflict|digest|differ|mismatch|concurren/i.test(`${error.name} ${error.message}`),
      );
      assert.deepEqual(await repo.findById(candidate.id), candidate);

      assert.deepEqual(await link(candidate, { botId: 1, updateId: 11, requestDigest: digestC }), candidate);
    } finally {
      repo.close();
    }

    const expectedLinks = [
      { bot_id: 1, update_id: 10, request_digest: digestA, plan_id: candidate.id },
      { bot_id: 1, update_id: 11, request_digest: digestC, plan_id: candidate.id },
    ];
    const first = readRaw(targetPath);
    assert.equal(first.plans.length, 1);
    assert.equal((first.plans[0] as { id?: string }).id, candidate.id);
    assert.deepEqual(first.links.map((row) => ({ ...row })), expectedLinks);

    // Reopen as an ordinary repository: same plan, replay still adopts it.
    const reopened = createSqlitePlanRepository(targetPath);
    try {
      assert.deepEqual(await reopened.findById(candidate.id), candidate);
      assert.equal(typeof reopened.createOrAdoptLinkedRequest, "function");
      assert.deepEqual(await reopened.createOrAdoptLinkedRequest!(candidate, binding), candidate);
    } finally {
      reopened.close();
    }

    const second = readRaw(targetPath);
    assert.deepEqual(second.plans, first.plans);
    assert.deepEqual(second.links.map((row) => ({ ...row })), expectedLinks);
    assert.equal(plannerCalls, 0);
  });

  it("linked repository rollback", async () => {
    let plannerCalls = 0;
    const countingPlanner = {
      id: "counting-planner",
      async plan() {
        plannerCalls += 1;
        return { status: "FAILED" as const, rawOutput: "", summary: "must not be called" };
      },
    };
    const seedRepo = createSqlitePlanRepository(tempDbPath("linked-rollback-seed-"));
    let candidate;
    try {
      const f = await newPlanning({ plans: seedRepo, planner: countingPlanner });
      const started = await f.service.start({
        projectId: f.projectId,
        actor: PLAN_SYSTEM,
        intent: "Linked rollback fixture",
        planner: TEST_PLANNER_CONFIG,
        execution: testExecutionConfig(),
        requestOnly: true,
      });
      assert.equal(started.phase, "DRAFT");
      assert.equal(plannerCalls, 0);
      assert.equal(f.dispatcher.startCount(), 0);
      candidate = started;
    } finally {
      seedRepo.close();
    }

    const targetPath = tempDbPath("linked-rollback-target-");
    createSqlitePlanRepository(targetPath).close();
    upgradePlanSchemaV1ToV2(targetPath);

    const snapshot = () => {
      const raw = new DatabaseSync(targetPath, { readOnly: true });
      try {
        return {
          plans: raw.prepare("SELECT * FROM plans ORDER BY id").all().map((row) => ({ ...row })),
          links: raw.prepare("SELECT * FROM plan_request_links ORDER BY bot_id,update_id").all().map((row) => ({ ...row })),
        };
      } finally {
        raw.close();
      }
    };

    // Baseline: the ordinary v2 target opens/closes and has no raw rows before the fault is installed.
    createSqlitePlanRepository(targetPath).close();
    assert.deepEqual(snapshot(), { plans: [], links: [] });

    // Unrelated fault site: corrupts the new Plan's serialized data AFTER its INSERT, so the
    // method's final v2 inspect raises a genuine PersistenceCorruptionError after both writes.
    const triggerSql =
      "CREATE TRIGGER rollback_plan_corruption AFTER INSERT ON plans BEGIN UPDATE plans SET data = '{}' WHERE id = NEW.id; END";
    const prep = new DatabaseSync(targetPath);
    try {
      prep.exec(triggerSql);
    } finally {
      prep.close();
    }

    const triggerRow = () => {
      const raw = new DatabaseSync(targetPath, { readOnly: true });
      try {
        return raw.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map((row) => ({ ...row }));
      } finally {
        raw.close();
      }
    };
    const triggersBefore = triggerRow();
    assert.equal(triggersBefore.length, 1);

    const before = snapshot();
    assert.deepEqual(before, { plans: [], links: [] });

    const repo = createSqlitePlanRepository(targetPath);
    try {
      assert.equal(typeof repo.createOrAdoptLinkedRequest, "function");
      await assert.rejects(
        repo.createOrAdoptLinkedRequest!(candidate, { botId: 2, updateId: 20, requestDigest: "d".repeat(64) }),
        (error: unknown) => error instanceof PersistenceCorruptionError && /plan/i.test(error.message),
      );
    } finally {
      repo.close();
    }

    assert.deepEqual(triggerRow(), triggersBefore);
    const after = snapshot();
    assert.deepEqual(after, before);
    assert.equal(after.plans.some((row) => (row as { id?: string }).id === candidate.id), false);
    assert.equal(after.links.length, 0);

    const reopened = createSqlitePlanRepository(targetPath);
    try {
      assert.equal(await reopened.findById(candidate.id), undefined);
    } finally {
      reopened.close();
    }
    assert.deepEqual(snapshot(), before);
    assert.equal(plannerCalls, 0);
  });

  it("linked repository typed", async () => {
    let plannerCalls = 0;
    const countingPlanner = {
      id: "counting-planner",
      async plan() {
        plannerCalls += 1;
        return { status: "FAILED" as const, rawOutput: "", summary: "must not be called" };
      },
    };
    const seedRepo = createSqlitePlanRepository(tempDbPath("linked-typed-seed-"));
    let candidate;
    try {
      const f = await newPlanning({ plans: seedRepo, planner: countingPlanner });
      const started = await f.service.start({
        projectId: f.projectId,
        actor: PLAN_SYSTEM,
        intent: "Linked typed fixture",
        planner: TEST_PLANNER_CONFIG,
        execution: testExecutionConfig(),
        requestOnly: true,
      });
      assert.equal(started.phase, "DRAFT");
      assert.equal(plannerCalls, 0);
      assert.equal(f.dispatcher.startCount(), 0);
      candidate = started;
    } finally {
      seedRepo.close();
    }

    const targetPath = tempDbPath("linked-typed-target-");
    createSqlitePlanRepository(targetPath).close();
    upgradePlanSchemaV1ToV2(targetPath);

    const good = { botId: 3, updateId: 30, requestDigest: "e".repeat(64) };
    const repo = createSqlitePlanRepository(targetPath);
    try {
      assert.equal(typeof repo.createOrAdoptLinkedRequest, "function");
      const link = repo.createOrAdoptLinkedRequest!.bind(repo);

      assert.deepEqual(await link(candidate, good), candidate);
      const baseline = readRaw(targetPath);
      assert.equal(baseline.plans.length, 1);
      assert.equal(baseline.links.length, 1);

      const refusals: Array<[() => Promise<unknown>, RegExp]> = [
        [() => link(candidate, { ...good, botId: 0 }), /botId/],
        [() => link(candidate, { ...good, updateId: -1 }), /updateId/],
        [() => link(candidate, { ...good, requestDigest: `${"e".repeat(64)}\n` }), /requestDigest/],
        [() => link({ ...candidate, version: 2 }, good), /initial DRAFT.*version 1/],
      ];
      for (const [attempt, pattern] of refusals) {
        await assert.rejects(
          attempt(),
          (error: unknown) => error instanceof TypeError && pattern.test(error.message),
        );
        assert.deepEqual(readRaw(targetPath), baseline);
      }
    } finally {
      repo.close();
    }
    assert.equal(plannerCalls, 0);
  });

  it("linked repository v1 refusal", async () => {
    let plannerCalls = 0;
    const countingPlanner = {
      id: "counting-planner",
      async plan() {
        plannerCalls += 1;
        return { status: "FAILED" as const, rawOutput: "", summary: "must not be called" };
      },
    };
    const seedRepo = createSqlitePlanRepository(tempDbPath("linked-v1-seed-"));
    let candidate;
    try {
      const f = await newPlanning({ plans: seedRepo, planner: countingPlanner });
      const started = await f.service.start({
        projectId: f.projectId,
        actor: PLAN_SYSTEM,
        intent: "Linked v1 refusal fixture",
        planner: TEST_PLANNER_CONFIG,
        execution: testExecutionConfig(),
        requestOnly: true,
      });
      assert.equal(started.phase, "DRAFT");
      assert.equal(plannerCalls, 0);
      assert.equal(f.dispatcher.startCount(), 0);
      candidate = started;
    } finally {
      seedRepo.close();
    }

    // Ordinary owned fresh target: version 1, never upgraded.
    const targetPath = tempDbPath("linked-v1-target-");
    createSqlitePlanRepository(targetPath).close();

    const rawState = () => {
      const raw = new DatabaseSync(targetPath, { readOnly: true });
      try {
        return {
          meta: raw.prepare("SELECT * FROM schema_meta").all().map((row) => ({ ...row })),
          plans: raw.prepare("SELECT * FROM plans").all().map((row) => ({ ...row })),
          linkTable: raw.prepare("SELECT name FROM sqlite_schema WHERE name='plan_request_links'").all().length,
        };
      } finally {
        raw.close();
      }
    };

    const baseline = rawState();
    assert.equal(baseline.meta.length, 1);
    assert.ok(Object.values(baseline.meta[0]!).some((value) => value === 1 || value === 1n || value === "1"));
    assert.deepEqual(baseline.plans, []);
    assert.equal(baseline.linkTable, 0);

    const good = { botId: 3, updateId: 30, requestDigest: "e".repeat(64) };
    const repo = createSqlitePlanRepository(targetPath);
    try {
      assert.equal(typeof repo.createOrAdoptLinkedRequest, "function");
      await assert.rejects(
        repo.createOrAdoptLinkedRequest!(candidate, good),
        (error: unknown) =>
          error instanceof SchemaVersionError && /require.*version 2|not upgraded automatically/.test(error.message),
      );
    } finally {
      repo.close();
    }
    assert.deepEqual(rawState(), baseline);

    const reopened = createSqlitePlanRepository(targetPath);
    try {
      assert.equal(await reopened.findById(candidate.id), undefined);
    } finally {
      reopened.close();
    }
    assert.deepEqual(rawState(), baseline);
    assert.equal(plannerCalls, 0);
  });

  it("linked repository terminal adoption", async () => {
    let plannerCalls = 0;
    const countingPlanner = {
      id: "counting-planner",
      async plan() {
        plannerCalls += 1;
        return { status: "FAILED" as const, rawOutput: "", summary: "must not be called" };
      },
    };
    const seedRepo = createSqlitePlanRepository(tempDbPath("linked-terminal-seed-"));
    let candidate: Plan;
    let f: TestPlanning;
    try {
      f = await newPlanning({ plans: seedRepo, planner: countingPlanner });
      const started = await f.service.start({
        projectId: f.projectId,
        actor: PLAN_SYSTEM,
        intent: "Linked terminal fixture",
        planner: TEST_PLANNER_CONFIG,
        execution: testExecutionConfig(),
        requestOnly: true,
      });
      assert.equal(started.phase, "DRAFT");
      assert.equal(plannerCalls, 0);
      assert.equal(f.dispatcher.startCount(), 0);
      candidate = started;
    } finally {
      seedRepo.close();
    }

    const targetPath = tempDbPath("linked-terminal-target-");
    createSqlitePlanRepository(targetPath).close();
    upgradePlanSchemaV1ToV2(targetPath);

    const binding = { botId: 1, updateId: 10, requestDigest: "a".repeat(64) };
    const alternateBinding = { botId: 1, updateId: 12, requestDigest: "f".repeat(64) };
    const alternate: Plan = {
      ...candidate,
      id: candidate.id + "-alternate",
      planner: { ...candidate.planner, model: "alternate-test-model" },
    };

    // Adoption: a second binding with a different candidate adopts the exact ORIGINAL plan.
    const targetRepo = createSqlitePlanRepository(targetPath);
    let cancelled: Plan;
    try {
      assert.equal(typeof targetRepo.createOrAdoptLinkedRequest, "function");
      const link = targetRepo.createOrAdoptLinkedRequest!.bind(targetRepo);
      assert.deepEqual(await link(candidate, binding), candidate);
      assert.deepEqual(await link(alternate, alternateBinding), candidate);

      const adopted = readRaw(targetPath);
      assert.equal(adopted.plans.length, 1);
      assert.equal((adopted.plans[0] as { id?: string }).id, candidate.id);
      assert.deepEqual(adopted.links.map((row) => ({ ...row })), [
        { bot_id: 1, update_id: 10, request_digest: binding.requestDigest, plan_id: candidate.id },
        { bot_id: 1, update_id: 12, request_digest: alternateBinding.requestDigest, plan_id: candidate.id },
      ]);

      // Real terminal transition through the service on the same target repository.
      const g = await newPlanning({ plans: targetRepo, store: f.store });
      cancelled = await g.service.cancel(candidate.id, PLAN_HUMAN, authorizePlanHuman(g.factory));
      assert.equal(cancelled.phase, "CANCELLED");
      assert.ok(cancelled.cancelRequested);
      assert.ok(cancelled.version > candidate.version);
      assert.deepEqual(await targetRepo.findById(candidate.id), cancelled);
      assert.equal(g.dispatcher.startCount(), 0);
    } finally {
      targetRepo.close();
    }

    const terminalRaw = readRaw(targetPath);
    assert.equal(terminalRaw.plans.length, 1);
    assert.equal(terminalRaw.links.length, 2);

    // Replay of the original initial DRAFT candidate returns the terminal plan without resurrection.
    const reopened = createSqlitePlanRepository(targetPath);
    try {
      assert.equal(typeof reopened.createOrAdoptLinkedRequest, "function");
      assert.deepEqual(await reopened.createOrAdoptLinkedRequest!(candidate, binding), cancelled);
      assert.deepEqual(await reopened.findById(candidate.id), cancelled);
    } finally {
      reopened.close();
    }
    assert.deepEqual(readRaw(targetPath), terminalRaw);
    assert.equal(plannerCalls, 0);
    assert.equal(f.dispatcher.startCount(), 0);
  });
});
