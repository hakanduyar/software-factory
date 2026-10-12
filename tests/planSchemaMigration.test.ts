/**
 * PHASE8-145 positive leaf: explicit Plan database v1 -> v2 upgrade against a
 * real populated SQLite file. Malformed-matrix and rollback cases are separate
 * leaves.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { createSqlitePlanRepository, upgradePlanSchemaV1ToV2 } from "../src/adapters/planning/sqlitePlanRepository.js";
import { PersistenceCorruptionError, SchemaIntegrityError, SchemaVersionError } from "../src/domain/errors.js";
import type { PlannerOutcome, PlannerWorker } from "../src/planning/plannerWorker.js";
import { newPlanning, PLAN_SYSTEM, TEST_PLANNER_CONFIG, testExecutionConfig } from "./support/planFixtures.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";

const BASE_OBJECTS = ["schema_meta", "plans", "idx_plans_project_id", "idx_plans_request_key", "idx_plans_active_request"];
const LINK_TABLE = "plan_request_links";

interface RawSnapshot {
  readonly plans: unknown[];
  readonly baseSql: unknown[];
  readonly marker: unknown[];
  readonly hasLinkTable: boolean;
}

function snapshot(path: string): RawSnapshot {
  const db = new DatabaseSync(path);
  try {
    const placeholders = BASE_OBJECTS.map(() => "?").join(", ");
    return {
      plans: db.prepare("SELECT * FROM plans ORDER BY id").all(),
      baseSql: db
        .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name IN (${placeholders}) ORDER BY name`)
        .all(...BASE_OBJECTS),
      marker: db.prepare("SELECT key, value FROM schema_meta ORDER BY key").all(),
      hasLinkTable: db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(LINK_TABLE) !== undefined,
    };
  } finally {
    db.close();
  }
}

function markerValue(snap: RawSnapshot): string {
  assert.equal(snap.marker.length, 1);
  return (snap.marker[0] as { value: string }).value;
}

function inspectLinkTable(path: string): void {
  const db = new DatabaseSync(path);
  try {
    const listed = db.prepare("PRAGMA table_list").all() as { name: string; strict: number }[];
    assert.equal(listed.find((row) => row.name === LINK_TABLE)?.strict, 1);
    const columns = db.prepare(`PRAGMA table_info("${LINK_TABLE}")`).all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];
    assert.deepEqual(
      columns.map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, pk: c.pk })),
      [
        { name: "bot_id", type: "INTEGER", notnull: 1, pk: 1 },
        { name: "update_id", type: "INTEGER", notnull: 1, pk: 2 },
        { name: "request_digest", type: "TEXT", notnull: 1, pk: 0 },
        { name: "plan_id", type: "TEXT", notnull: 1, pk: 0 },
      ],
    );
  } finally {
    db.close();
  }
}

describe("plan database v1 -> v2 upgrade (positive)", () => {
  after(() => cleanupTempDbs());

  it("upgrades a populated v1 database in place, preserving plans and base schema; repeat is a no-op; fresh ordinary DBs stay v1", async () => {
    const path = tempDbPath("plan-migration-");
    const repo = createSqlitePlanRepository(path);
    let plannerRuns = 0;
    const countingPlanner: PlannerWorker = {
      id: "counting-planner",
      async plan(): Promise<PlannerOutcome> {
        plannerRuns += 1;
        return { status: "FAILED", rawOutput: "", summary: "must not run" };
      },
    };
    const f = await newPlanning({ plans: repo, planner: countingPlanner });
    const started = await f.service.start({
      projectId: f.projectId,
      actor: PLAN_SYSTEM,
      intent: "Migration fixture",
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
      requestOnly: true,
    });
    assert.equal(started.phase, "DRAFT");
    assert.equal(f.dispatcher.startCount(), 0);
    assert.equal(plannerRuns, 0);
    const originalPlan = await repo.findById(started.id);
    assert.ok(originalPlan);
    repo.close();

    const before = snapshot(path);
    assert.equal(before.plans.length, 1);
    assert.equal(before.baseSql.length, BASE_OBJECTS.length);
    assert.equal(markerValue(before), "1");
    assert.equal(before.hasLinkTable, false);

    upgradePlanSchemaV1ToV2(path);

    const upgraded = snapshot(path);
    assert.equal(markerValue(upgraded), "2");
    assert.equal(upgraded.hasLinkTable, true);
    inspectLinkTable(path);
    assert.deepEqual(upgraded.plans, before.plans);
    assert.deepEqual(upgraded.baseSql, before.baseSql);

    const reopened = createSqlitePlanRepository(path);
    try {
      assert.deepEqual(await reopened.findById(started.id), originalPlan);
    } finally {
      reopened.close();
    }

    upgradePlanSchemaV1ToV2(path);
    const repeated = snapshot(path);
    assert.deepEqual(repeated, upgraded);
    inspectLinkTable(path);

    const otherPath = tempDbPath("plan-migration-fresh-");
    createSqlitePlanRepository(otherPath).close();
    const fresh = snapshot(otherPath);
    assert.equal(markerValue(fresh), "1");
    assert.equal(fresh.hasLinkTable, false);
  });
});

describe("plan database v1 -> v2 upgrade (rollback)", () => {
  after(() => cleanupTempDbs());

  it("rolls back the link-table DDL when the marker UPDATE aborts, leaving the v1 database unchanged", async () => {
    const path = tempDbPath("plan-migration-rollback-");
    const repo = createSqlitePlanRepository(path);
    let plannerRuns = 0;
    const countingPlanner: PlannerWorker = {
      id: "counting-planner",
      async plan(): Promise<PlannerOutcome> {
        plannerRuns += 1;
        return { status: "FAILED", rawOutput: "", summary: "must not run" };
      },
    };
    let startId: string;
    let originalPlan: unknown;
    let dispatcherStarts: number;
    try {
      const f = await newPlanning({ plans: repo, planner: countingPlanner });
      const started = await f.service.start({
        projectId: f.projectId,
        actor: PLAN_SYSTEM,
        intent: "Migration rollback fixture",
        planner: TEST_PLANNER_CONFIG,
        execution: testExecutionConfig(),
        requestOnly: true,
      });
      assert.equal(started.phase, "DRAFT");
      startId = started.id;
      originalPlan = await repo.findById(started.id);
      assert.ok(originalPlan);
      dispatcherStarts = f.dispatcher.startCount();
    } finally {
      repo.close();
    }

    const fullSchema = (): unknown[] => {
      const db = new DatabaseSync(path);
      try {
        return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
      } finally {
        db.close();
      }
    };

    const trigger = new DatabaseSync(path);
    try {
      trigger.exec(
        `CREATE TRIGGER fault_145 BEFORE UPDATE OF value ON schema_meta
         WHEN OLD.key = 'plan_schema_version'
         BEGIN SELECT RAISE(ABORT, '145 rollback sentinel'); END`,
      );
    } finally {
      trigger.close();
    }

    const before = snapshot(path);
    const schemaBefore = fullSchema();
    assert.equal(before.plans.length, 1);
    assert.equal(markerValue(before), "1");
    assert.equal(before.hasLinkTable, false);
    assert.ok(schemaBefore.some((row) => (row as { name: string }).name === "fault_145"));

    assert.throws(() => upgradePlanSchemaV1ToV2(path), /145 rollback sentinel/);

    const after = snapshot(path);
    assert.equal(markerValue(after), "1");
    assert.equal(after.hasLinkTable, false);
    assert.deepEqual(after.plans, before.plans);
    assert.deepEqual(after.baseSql, before.baseSql);
    assert.deepEqual(after.marker, before.marker);
    assert.deepEqual(fullSchema(), schemaBefore);

    const reopened = createSqlitePlanRepository(path);
    try {
      assert.deepEqual(await reopened.findById(startId), originalPlan);
    } finally {
      reopened.close();
    }
    assert.equal(dispatcherStarts, 0);
    assert.equal(plannerRuns, 0);
  });
});

describe("plan database v1 -> v2 upgrade (basic refusals)", () => {
  after(() => cleanupTempDbs());

  const PRECHECK = /requires an existing non-empty database file/;

  it("refuses a missing path without creating it", () => {
    const path = tempDbPath("plan-migration-missing-");
    assert.equal(existsSync(path), false);
    assert.throws(() => upgradePlanSchemaV1ToV2(path), PRECHECK);
    assert.equal(existsSync(path), false);
  });

  it("refuses an empty file and leaves its bytes unchanged", () => {
    const path = tempDbPath("plan-migration-empty-");
    writeFileSync(path, new Uint8Array(0));
    const before = readFileSync(path);
    assert.equal(before.length, 0);
    assert.throws(() => upgradePlanSchemaV1ToV2(path), PRECHECK);
    assert.deepEqual(readFileSync(path), before);
  });

  it("refuses a foreign SQLite database without a schema_meta marker and leaves its bytes unchanged", () => {
    const path = tempDbPath("plan-migration-foreign-");
    const prep = new DatabaseSync(path);
    try {
      prep.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO unrelated (note) VALUES ('x');");
    } finally {
      prep.close();
    }
    const before = readFileSync(path);
    assert.ok(before.length > 0);
    assert.throws(() => upgradePlanSchemaV1ToV2(path), /no schema_meta version marker/);
    assert.deepEqual(readFileSync(path), before);
  });
});

describe("plan database v1 -> v2 upgrade (marker and link-object refusals)", () => {
  after(() => cleanupTempDbs());

  const LINK_MESSAGE = "version 1 must not contain plan_request_links objects";
  const cases: readonly {
    readonly name: string;
    readonly sql: string;
    readonly errorClass: typeof SchemaIntegrityError | typeof SchemaVersionError;
    readonly message: string;
  }[] = [
    {
      name: "non-numeric marker value",
      sql: "UPDATE schema_meta SET value = 'invalid' WHERE key = 'plan_schema_version'",
      errorClass: SchemaIntegrityError,
      message: "not a valid integer",
    },
    {
      name: "unsupported marker value 99",
      sql: "UPDATE schema_meta SET value = '99' WHERE key = 'plan_schema_version'",
      errorClass: SchemaVersionError,
      message: "this build expects 1 or 2",
    },
    {
      name: "pre-existing plan_request_links table in a v1 database",
      sql: "CREATE TABLE plan_request_links(extra TEXT)",
      errorClass: SchemaIntegrityError,
      message: LINK_MESSAGE,
    },
    {
      name: "differently named view referencing plan_request_links",
      sql: "CREATE VIEW shadow_links AS SELECT * FROM plan_request_links",
      errorClass: SchemaIntegrityError,
      message: LINK_MESSAGE,
    },
    {
      name: "differently named trigger referencing plan_request_links",
      sql: "CREATE TRIGGER shadow_trigger AFTER INSERT ON plans BEGIN SELECT count(*) FROM plan_request_links; END",
      errorClass: SchemaIntegrityError,
      message: LINK_MESSAGE,
    },
  ];

  for (const c of cases) {
    it(`refuses ${c.name} and leaves the file bytes unchanged`, () => {
      const path = tempDbPath("plan-migration-refusal-");
      createSqlitePlanRepository(path).close();

      const raw = new DatabaseSync(path);
      try {
        raw.exec(c.sql);
      } finally {
        raw.close();
      }

      const before = readFileSync(path);
      assert.ok(before.length > 0);

      assert.throws(
        () => upgradePlanSchemaV1ToV2(path),
        (err: unknown) => {
          assert.ok(err instanceof c.errorClass, `expected ${c.errorClass.name}, got ${String(err)}`);
          assert.ok(
            (err as Error).message.includes(c.message),
            `expected message to include "${c.message}", got "${(err as Error).message}"`,
          );
          return true;
        },
      );

      assert.deepEqual(readFileSync(path), before);
    });
  }
});

describe("typed v2 refusals", () => {
  after(() => cleanupTempDbs());

  type Refusal = typeof SchemaIntegrityError | typeof PersistenceCorruptionError;
  const cases: readonly {
    readonly name: string;
    readonly mutate: (db: DatabaseSync, planId: string) => void;
    readonly errorClass: Refusal;
    readonly message: RegExp;
  }[] = [
    {
      name: "extra column on plan_request_links",
      mutate: (db) => db.exec("ALTER TABLE plan_request_links ADD COLUMN extra TEXT"),
      errorClass: SchemaIntegrityError,
      message: /plan_request_links/,
    },
    {
      name: "malformed request_digest",
      mutate: (db) => {
        db.exec("PRAGMA ignore_check_constraints=ON");
        db.prepare("UPDATE plan_request_links SET request_digest = ?").run("a".repeat(64) + String.fromCharCode(10));
      },
      errorClass: SchemaIntegrityError,
      message: /row has an invalid request_digest/,
    },
    {
      name: "bot_id zero",
      mutate: (db) => {
        db.exec("PRAGMA ignore_check_constraints=ON");
        db.exec("UPDATE plan_request_links SET bot_id=0");
      },
      errorClass: SchemaIntegrityError,
      message: /row has an invalid bot_id/,
    },
    {
      name: "dangling linked Plan",
      mutate: (db) => db.exec("UPDATE plan_request_links SET plan_id='missing-linked-plan'"),
      errorClass: SchemaIntegrityError,
      message: /row references a Plan that does not exist/,
    },
    {
      name: "invalid linked Plan JSON",
      mutate: (db, planId) => {
        db.prepare("UPDATE plans SET data = ? WHERE id = ?").run("{}", planId);
      },
      errorClass: PersistenceCorruptionError,
      message: /plan/i,
    },
  ];

  for (const c of cases) {
    it(`refuses ${c.name} via upgrade and ordinary open without changing bytes`, async () => {
      const path = tempDbPath("plan-migration-typed-");
      const repo = createSqlitePlanRepository(path);
      let plannerRuns = 0;
      const countingPlanner: PlannerWorker = {
        id: "counting-planner",
        async plan(): Promise<PlannerOutcome> {
          plannerRuns += 1;
          return { status: "FAILED", rawOutput: "", summary: "must not run" };
        },
      };
      let originalPlan: Awaited<ReturnType<typeof repo.findById>>;
      let planId: string;
      let dispatcherStarts: number;
      try {
        const f = await newPlanning({ plans: repo, planner: countingPlanner });
        const started = await f.service.start({
          projectId: f.projectId,
          actor: PLAN_SYSTEM,
          intent: "Typed refusal fixture",
          planner: TEST_PLANNER_CONFIG,
          execution: testExecutionConfig(),
          requestOnly: true,
        });
        assert.equal(started.phase, "DRAFT");
        planId = started.id;
        originalPlan = await repo.findById(started.id);
        assert.ok(originalPlan);
        dispatcherStarts = f.dispatcher.startCount();
      } finally {
        repo.close();
      }

      upgradePlanSchemaV1ToV2(path);
      const link = new DatabaseSync(path);
      try {
        link
          .prepare("INSERT INTO plan_request_links(bot_id,update_id,request_digest,plan_id) VALUES (?,?,?,?)")
          .run(1, 0, "a".repeat(64), planId);
      } finally {
        link.close();
      }

      const valid = createSqlitePlanRepository(path);
      try {
        assert.deepEqual(await valid.findById(planId), originalPlan);
      } finally {
        valid.close();
      }
      const validBytes = readFileSync(path);
      upgradePlanSchemaV1ToV2(path);
      assert.deepEqual(readFileSync(path), validBytes);

      const prep = new DatabaseSync(path);
      try {
        c.mutate(prep, planId);
      } finally {
        prep.close();
      }
      const mutated = readFileSync(path);

      const expectRefusal = (err: unknown): boolean => {
        assert.ok(err instanceof c.errorClass, `expected ${c.errorClass.name}, got ${String(err)}`);
        assert.match((err as Error).message, c.message);
        return true;
      };

      assert.throws(() => upgradePlanSchemaV1ToV2(path), expectRefusal);
      assert.deepEqual(readFileSync(path), mutated);

      assert.throws(() => {
        const unexpected = createSqlitePlanRepository(path);
        unexpected.close();
      }, expectRefusal);
      assert.deepEqual(readFileSync(path), mutated);

      assert.equal(dispatcherStarts, 0);
      assert.equal(plannerRuns, 0);
    });
  }
});
