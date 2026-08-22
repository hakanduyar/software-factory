/**
 * TASK-005 — the durable `PlanRepository` against a REAL SQLite file.
 *
 * A plan is the thing work items are derived from, so its persistence layer has
 * to hold three lines at once, and this file exercises all three end to end
 * rather than against a mock:
 *
 * 1. CONCURRENCY IS A DATABASE CONSTRAINT, not a check-then-insert. Duplicate
 *    ids and a second ACTIVE plan for one human request are refused by the
 *    table's own indexes, and every write is a conditional CAS on `version`.
 * 2. DURABILITY SURVIVES RESTART. Close the file, reopen it in a fresh process
 *    object, and revisions, materialized mappings and events come back byte
 *    identical — because a plan half-remembered across a crash would dispatch
 *    work twice.
 * 3. INTEGRITY FAILS CLOSED (TASK-005 AC-14). A corrupted row throws
 *    `PersistenceCorruptionError` at READ time, so it can never select work to
 *    create; a database whose shape or version marker does not match this build
 *    is refused outright rather than silently repaired.
 *
 * The last group unit-tests `validatePlanActiveIndexPredicateSql` with no
 * database at all. That function exists because `PRAGMA index_list`/`index_info`
 * can only prove an index is unique, partial and over the right column — they
 * cannot see WHICH phases a partial index actually restricts to, so a
 * semantically wrong predicate would pass structural validation while silently
 * permitting two concurrent plans for one request. That is the TASK-004 round-2
 * lesson, inherited here rather than rediscovered.
 *
 * Fully offline: temp files only, no AI, no network.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import {
  createSqlitePlanRepository,
  validatePlanActiveIndexPredicateSql,
} from "../src/adapters/planning/sqlitePlanRepository.js";
import {
  ConcurrencyError,
  PersistenceCorruptionError,
  SchemaIntegrityError,
  SchemaVersionError,
} from "../src/domain/errors.js";
import { approvalDigestOfPlan, computePlanContentDigest, type PlanDigestInput } from "../src/planning/planDigest.js";
import {
  ACTIVE_PLAN_PHASES,
  canonicalCorrelationTag,
  type Plan,
  type PlanEvent,
  type PlanEventKind,
  type PlannedWorkItem,
  type PlanRevision,
} from "../src/planning/planTypes.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";

after(cleanupTempDbs);

const T = 1_800_000_000_000;

function freshDbPath(): string {
  return tempDbPath("plan-test-");
}

function item(key: string, dependsOn: readonly string[] = []): PlannedWorkItem {
  return {
    key,
    title: `Deliver ${key}`,
    type: "FEATURE",
    priority: "P2",
    spec: `Implement ${key} exactly as the plan describes.`,
    acceptanceCriteria: [{ text: `${key} behaves as specified`, verificationHint: "npm test" }],
    dependsOn,
  };
}

/** Builds a revision whose stored digest genuinely matches its content. */
function revision(n: number, items: readonly PlannedWorkItem[]): PlanRevision {
  const content: PlanDigestInput = {
    revision: n,
    summary: `Revision ${n} of the plan.`,
    assumptions: ["The existing toolchain is available."],
    constraints: ["No new external infrastructure."],
    risks: ["Scope may grow during implementation."],
    items,
  };
  return {
    ...content,
    contentDigest: computePlanContentDigest(content),
    plannerRunRef: `run-planner-${n}`,
    generatedAt: T + n,
  };
}

function eventsOf(...kinds: PlanEventKind[]): readonly PlanEvent[] {
  return kinds.map((kind, index) => ({ seq: index + 1, kind, detail: `${kind} recorded`, at: T + index }));
}

const ITEMS: readonly PlannedWorkItem[] = [item("WI-A"), item("WI-B", ["WI-A"])];
const REV1 = revision(1, ITEMS);

/** A valid, active (PLAN_REVIEW) plan. */
function planFixture(overrides: Partial<Plan> = {}): Plan {
  return {
    id: "plan-0001",
    projectId: "prj-a",
    requestKey: "req-0001",
    version: 1,
    phase: "PLAN_REVIEW",
    intent: "Build the requested capability.",
    declaredConstraints: ["Stay entirely offline."],
    budget: { maxPlannerAttempts: 2, maxClarificationCycles: 2, maxTotalPlannerRuns: 6 },
    planner: { tool: "scripted", model: "test-planner" },
    execution: {
      implementer: { tool: "scripted", model: "test-implementer" },
      reviewer: { tool: "scripted", model: "test-reviewer" },
      verificationCommands: [{ id: "check", executable: "node", argv: ["-e", "process.exit(0)"] }],
      workspaceRoot: "/tmp/sf-plan-repo-test",
      loopBudget: { maxIterations: 2 },
    },
    revisions: [REV1],
    openQuestions: [],
    answers: [],
    attemptsForCurrentRevision: 1,
    clarificationCycles: 0,
    totalPlannerRuns: 1,
    materialized: [],
    dispatches: [],
    cancelRequested: false,
    events: eventsOf("REQUEST_CREATED", "PLANNER_RUN_STARTED", "REVISION_GENERATED", "ENTERED_PLAN_REVIEW"),
    startedBy: { id: "user:test", kind: "HUMAN", displayName: "Test Human" },
    startedAt: T,
    lastTransitionAt: T + 10,
    ...overrides,
  };
}

/**
 * A valid EXECUTING plan whose approval, mappings and dispatch all cohere.
 * `approvedDigest` is derived from the resulting plan (remediation round 1,
 * HIGH 4: the approval digest covers plan-level configuration too).
 */
function executingFixture(id: string, overrides: Partial<Plan> = {}): Plan {
  const shaped = planFixture({
    id,
    version: 5,
    phase: "EXECUTING",
    approvalId: "apr-0001",
    approvedRevision: 1,
    approvedDigest: "",
    materialized: [
      {
        planItemKey: "WI-A",
        workItemId: "wi-0001",
        correlationTag: canonicalCorrelationTag(id, 1, "WI-A"),
        materializedAt: T + 20,
        readied: true,
      },
      {
        planItemKey: "WI-B",
        workItemId: "wi-0002",
        correlationTag: canonicalCorrelationTag(id, 1, "WI-B"),
        materializedAt: T + 21,
        readied: true,
      },
    ],
    dispatches: [{ planItemKey: "WI-A", workItemId: "wi-0001", loopId: "loop-0001", dispatchedAt: T + 30, adopted: false }],
    events: eventsOf(
      "REQUEST_CREATED",
      "REVISION_GENERATED",
      "ENTERED_PLAN_REVIEW",
      "APPROVED",
      "MATERIALIZATION_STARTED",
      "WORK_ITEM_MATERIALIZED",
      "WORK_ITEM_READIED",
      "DISPATCHED",
    ),
    ...overrides,
  });
  return overrides.approvedDigest === undefined
    ? { ...shaped, approvedDigest: approvalDigestOfPlan(shaped, REV1) }
    : shaped;
}

/** The same plan moved to a terminal, NON-active phase (terminal phases must state an outcome). */
function cancelled(plan: Plan): Plan {
  return { ...plan, version: plan.version + 1, phase: "CANCELLED", outcome: "CANCELLED", cancelRequested: true };
}

type ErrorClass = new (...args: never[]) => Error;

/** Asserts a synchronous refusal by class AND by a reason substring taken from the source. */
function assertThrowsWith(operation: () => unknown, expected: ErrorClass, reason: RegExp): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof expected, `wrong error class: ${String(error)}`);
    assert.match(error.message, reason);
    return true;
  });
}

/** The async equivalent — repository methods return promises, so `rejects`, not `throws`. */
async function assertRejectsWith(
  operation: () => Promise<unknown>,
  expected: ErrorClass,
  reason: RegExp,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof expected, `wrong error class: ${String(error)}`);
    assert.match(error.message, reason);
    return true;
  });
}

/** Reads one plan's stored JSON payload with a second, unrelated connection. */
function readPayload(dbPath: string, id: string): Record<string, unknown> {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT data FROM plans WHERE id = ?").get(id) as { data: string };
    return JSON.parse(row.data) as Record<string, unknown>;
  } finally {
    db.close();
  }
}

/** Overwrites one plan's data column directly, as a corrupting process would. */
function writeRawData(dbPath: string, id: string, data: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE plans SET data = ? WHERE id = ?").run(data, id);
  } finally {
    db.close();
  }
}

describe("createSqlitePlanRepository — durable round-trip", () => {
  it("creates and reads back a plan through a real SQLite file, including revisions, mappings, dispatches and events", async () => {
    const repo = createSqlitePlanRepository(freshDbPath());
    try {
      const plan = executingFixture("plan-0001");
      await repo.create(plan);

      const found = await repo.findById("plan-0001");
      assert.deepEqual(found, plan, "nothing is lost or invented on the way through SQLite");
      assert.equal(found?.phase, "EXECUTING");
      assert.equal(found?.revisions[0]?.contentDigest, REV1.contentDigest);
      assert.equal(found?.revisions[0]?.items[1]?.key, "WI-B");
      assert.equal(found?.materialized[1]?.correlationTag, "plan-0001:r1:WI-B");
      assert.equal(found?.dispatches[0]?.loopId, "loop-0001");
      assert.equal(found?.events.at(-1)?.kind, "DISPATCHED");
    } finally {
      repo.close();
    }
  });

  it("returns undefined for an id that was never created", async () => {
    const repo = createSqlitePlanRepository(freshDbPath());
    try {
      assert.equal(await repo.findById("plan-never"), undefined);
    } finally {
      repo.close();
    }
  });
});

describe("createSqlitePlanRepository — uniqueness is a database constraint", () => {
  it("refuses a duplicate plan id", async () => {
    const repo = createSqlitePlanRepository(freshDbPath());
    try {
      await repo.create(planFixture());
      // A different request key, so ONLY the primary key can be violated and
      // the reported reason is unambiguous.
      await assertRejectsWith(
        () => repo.create(planFixture({ requestKey: "req-other" })),
        ConcurrencyError,
        /Plan plan-0001 already exists/,
      );
    } finally {
      repo.close();
    }
  });

  it("refuses a second ACTIVE plan for the same request key via the partial unique index", async () => {
    const repo = createSqlitePlanRepository(freshDbPath());
    try {
      await repo.create(planFixture({ id: "plan-a", requestKey: "req-shared" }));
      await assertRejectsWith(
        () => repo.create(planFixture({ id: "plan-b", requestKey: "req-shared" })),
        ConcurrencyError,
        /an active Plan already exists for request req-shared/,
      );
    } finally {
      repo.close();
    }
  });

  it("allows a new plan for the request once the previous plan is no longer in an active phase", async () => {
    const repo = createSqlitePlanRepository(freshDbPath());
    try {
      const first = planFixture({ id: "plan-a", requestKey: "req-shared" });
      await repo.create(first);
      await repo.compareAndSave(cancelled(first), first.version);

      const second = await repo.create(planFixture({ id: "plan-b", requestKey: "req-shared" }));
      assert.equal(second.id, "plan-b");
      assert.equal((await repo.findActiveByRequestKey("req-shared"))?.id, "plan-b");
    } finally {
      repo.close();
    }
  });
});

describe("createSqlitePlanRepository — compare-and-save", () => {
  it("commits when the expected version matches, and the new version is readable", async () => {
    const repo = createSqlitePlanRepository(freshDbPath());
    try {
      const plan = planFixture();
      await repo.create(plan);

      const approved: Plan = {
        ...plan,
        version: 2,
        phase: "APPROVED",
        approvalId: "apr-0001",
        approvedRevision: 1,
        approvedDigest: approvalDigestOfPlan(plan, REV1),
      };
      await repo.compareAndSave(approved, 1);

      const found = await repo.findById(plan.id);
      assert.equal(found?.version, 2);
      assert.equal(found?.phase, "APPROVED");
      assert.equal(found?.approvalId, "apr-0001");
    } finally {
      repo.close();
    }
  });

  it("refuses a stale expected version, naming both the expected and the found version", async () => {
    const repo = createSqlitePlanRepository(freshDbPath());
    try {
      const plan = planFixture();
      await repo.create(plan);
      await repo.compareAndSave({ ...plan, version: 2 }, 1);

      await assertRejectsWith(
        () => repo.compareAndSave({ ...plan, version: 2, phase: "CANCELLED", outcome: "CANCELLED" }, 1),
        ConcurrencyError,
        /Plan plan-0001 version conflict: expected current version 1, found 2/,
      );

      const found = await repo.findById(plan.id);
      assert.equal(found?.phase, "PLAN_REVIEW", "the losing writer changed nothing");
      assert.equal(found?.version, 2);
    } finally {
      repo.close();
    }
  });

  it("refuses a compare-and-save for an id that does not exist, reporting found version 0", async () => {
    const repo = createSqlitePlanRepository(freshDbPath());
    try {
      await assertRejectsWith(
        () => repo.compareAndSave(planFixture({ id: "plan-ghost", version: 2 }), 1),
        ConcurrencyError,
        /Plan plan-ghost version conflict: expected current version 1, found 0/,
      );
    } finally {
      repo.close();
    }
  });
});

describe("createSqlitePlanRepository — queries", () => {
  it("findActiveByRequestKey returns the active plan, and nothing once that plan is terminal", async () => {
    const repo = createSqlitePlanRepository(freshDbPath());
    try {
      const plan = planFixture({ requestKey: "req-active" });
      await repo.create(plan);
      assert.equal((await repo.findActiveByRequestKey("req-active"))?.id, "plan-0001");

      await repo.compareAndSave(cancelled(plan), plan.version);
      assert.equal(await repo.findActiveByRequestKey("req-active"), undefined);
      // The plan itself is still there — it simply no longer holds the request.
      assert.equal((await repo.findById("plan-0001"))?.phase, "CANCELLED");
    } finally {
      repo.close();
    }
  });

  it("listByProject returns only that project's plans, in insertion order", async () => {
    const repo = createSqlitePlanRepository(freshDbPath());
    try {
      await repo.create(planFixture({ id: "plan-a1", projectId: "prj-a", requestKey: "req-a1" }));
      await repo.create(planFixture({ id: "plan-b1", projectId: "prj-b", requestKey: "req-b1" }));
      await repo.create(planFixture({ id: "plan-a2", projectId: "prj-a", requestKey: "req-a2" }));

      const forA = await repo.listByProject("prj-a");
      assert.deepEqual(
        forA.map((plan) => plan.id),
        ["plan-a1", "plan-a2"],
      );
      assert.deepEqual(
        (await repo.listByProject("prj-b")).map((plan) => plan.id),
        ["plan-b1"],
      );
    } finally {
      repo.close();
    }
  });
});

describe("createSqlitePlanRepository — restart durability", () => {
  it("survives close and reopen against the same file with revisions, mappings and events intact", async () => {
    const dbPath = freshDbPath();
    const plan = executingFixture("plan-restart");

    const first = createSqlitePlanRepository(dbPath);
    await first.create(plan);
    first.close();

    const reopened = createSqlitePlanRepository(dbPath);
    try {
      const found = await reopened.findById("plan-restart");
      assert.deepEqual(found, plan, "a restarted process sees exactly what the previous one committed");
      assert.equal(found?.revisions.length, 1);
      assert.equal(found?.revisions[0]?.items.length, 2);
      assert.equal(found?.approvedDigest, approvalDigestOfPlan(plan, REV1));
      assert.equal(found?.materialized[0]?.correlationTag, "plan-restart:r1:WI-A");
      assert.equal(found?.materialized[1]?.workItemId, "wi-0002");
      assert.equal(found?.dispatches[0]?.planItemKey, "WI-A");
      assert.equal(found?.events.length, 8);
      assert.equal((await reopened.findActiveByRequestKey(plan.requestKey))?.id, "plan-restart");
    } finally {
      reopened.close();
    }
  });
});

/**
 * TASK-005 AC-14 at the adapter boundary: a row that could only exist through
 * corruption or tampering is refused at READ time, so it can never be the row
 * that selects which work item to create or which worker to dispatch.
 */
describe("createSqlitePlanRepository — corruption fails closed at read time", () => {
  it("refuses a row whose revision content was edited without updating its digest", async () => {
    const dbPath = freshDbPath();
    const repo = createSqlitePlanRepository(dbPath);
    const plan = planFixture();
    await repo.create(plan);
    repo.close();

    const payload = readPayload(dbPath, plan.id);
    const revisions = payload.revisions as Record<string, unknown>[];
    revisions[0]!.summary = "Silently widened scope.";
    writeRawData(dbPath, plan.id, JSON.stringify(payload));

    const reopened = createSqlitePlanRepository(dbPath);
    try {
      await assertRejectsWith(
        () => reopened.findById(plan.id),
        PersistenceCorruptionError,
        /does not match the digest of the stored content/,
      );
    } finally {
      reopened.close();
    }
  });

  it("refuses a row whose data column is not valid JSON at all", async () => {
    const dbPath = freshDbPath();
    const repo = createSqlitePlanRepository(dbPath);
    const plan = planFixture();
    await repo.create(plan);
    repo.close();

    writeRawData(dbPath, plan.id, "{ this is not json");

    const reopened = createSqlitePlanRepository(dbPath);
    try {
      await assertRejectsWith(
        () => reopened.findById(plan.id),
        PersistenceCorruptionError,
        /data column is not valid JSON/,
      );
      // The same corrupted row is equally unusable through the query the
      // planner actually dispatches from.
      await assertRejectsWith(
        () => reopened.findActiveByRequestKey(plan.requestKey),
        PersistenceCorruptionError,
        /data column is not valid JSON/,
      );
    } finally {
      reopened.close();
    }
  });
});

describe("createSqlitePlanRepository — schema integrity on open", () => {
  it("refuses a non-empty database that is not a plans database at all", () => {
    const dbPath = freshDbPath();
    const raw = new DatabaseSync(dbPath);
    raw.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT");
    raw.close();

    assertThrowsWith(
      () => createSqlitePlanRepository(dbPath),
      SchemaIntegrityError,
      /non-empty but has no schema_meta version marker/,
    );
  });

  it("refuses a database whose plan_schema_version does not match this build", async () => {
    const dbPath = freshDbPath();
    const repo = createSqlitePlanRepository(dbPath);
    await repo.create(planFixture());
    repo.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec("UPDATE schema_meta SET value = '99' WHERE key = 'plan_schema_version'");
    raw.close();

    assertThrowsWith(
      () => createSqlitePlanRepository(dbPath),
      SchemaVersionError,
      /plan_schema_version is 99, this build expects 1/,
    );
  });

  it("refuses a database whose active-request uniqueness index was dropped", () => {
    const dbPath = freshDbPath();
    createSqlitePlanRepository(dbPath).close();

    const raw = new DatabaseSync(dbPath);
    raw.exec("DROP INDEX idx_plans_active_request");
    raw.close();

    // Without this index, "at most one active plan per request" silently stops
    // being true — so its absence must be fatal, not tolerated.
    assertThrowsWith(
      () => createSqlitePlanRepository(dbPath),
      SchemaIntegrityError,
      /missing expected index "idx_plans_active_request"/,
    );
  });
});

/**
 * `PRAGMA index_list`/`index_info` prove an index is unique, partial and over
 * `request_key` — they CANNOT see which phases its WHERE clause restricts to.
 * A predicate missing `EXECUTING`, or carrying an extra terminal phase, would
 * therefore pass every structural check while quietly permitting two concurrent
 * plans for one human request. That is the TASK-004 round-2 lesson, which is why
 * the predicate text itself is parsed and validated — and why it is tested here
 * directly, with no database in the way.
 */
describe("validatePlanActiveIndexPredicateSql", () => {
  const INDEX_NAME = "idx_plans_active_request";
  const canonicalList = ACTIVE_PLAN_PHASES.map((phase) => `'${phase}'`).join(", ");

  function check(sql: string): void {
    validatePlanActiveIndexPredicateSql(sql, INDEX_NAME, ACTIVE_PLAN_PHASES);
  }

  function assertRejected(sql: string, reason: RegExp): void {
    assertThrowsWith(() => check(sql), SchemaIntegrityError, reason);
  }

  it("accepts the canonical predicate, and tolerates whitespace, keyword casing and phase order", () => {
    assert.doesNotThrow(() =>
      check(`CREATE UNIQUE INDEX ${INDEX_NAME} ON plans(request_key) WHERE phase IN (${canonicalList})`),
    );

    const messy = [
      `CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME}`,
      "  ON plans(request_key)",
      "  WHERE   phase   IN (",
      ACTIVE_PLAN_PHASES.map((phase) => `        '${phase}'`).join(",\n"),
      "  ) ;",
    ].join("\n");
    assert.doesNotThrow(() => check(messy), "harmless formatting variation is not a schema violation");

    assert.doesNotThrow(() =>
      check(`create unique index ${INDEX_NAME} on plans(request_key) where phase in (${canonicalList})`),
    );

    const reversed = [...ACTIVE_PLAN_PHASES].reverse().map((phase) => `'${phase}'`).join(",");
    assert.doesNotThrow(() =>
      check(`CREATE UNIQUE INDEX ${INDEX_NAME} ON plans(request_key) WHERE phase IN (${reversed})`),
      "the phase list is a set, so declaration order is irrelevant",
    );
  });

  it("rejects an index statement with no WHERE clause at all", () => {
    assertRejected(`CREATE UNIQUE INDEX ${INDEX_NAME} ON plans(request_key)`, /has no WHERE clause/);
  });

  it("rejects a WHERE clause that is not a phase IN (...) predicate", () => {
    assertRejected(
      `CREATE UNIQUE INDEX ${INDEX_NAME} ON plans(request_key) WHERE request_key IS NOT NULL`,
      /is not the expected "phase IN \(\.\.\.\)" predicate/,
    );
  });

  it("rejects a predicate that is missing one of the active phases", () => {
    const missing = ACTIVE_PLAN_PHASES.filter((phase) => phase !== "EXECUTING")
      .map((phase) => `'${phase}'`)
      .join(", ");
    assertRejected(
      `CREATE UNIQUE INDEX ${INDEX_NAME} ON plans(request_key) WHERE phase IN (${missing})`,
      /the active-plan uniqueness rule depends on this exact predicate/,
    );
  });

  it("rejects a predicate that carries an extra phase", () => {
    assertRejected(
      `CREATE UNIQUE INDEX ${INDEX_NAME} ON plans(request_key) WHERE phase IN (${canonicalList}, 'CANCELLED')`,
      /restricts phase to \{/,
    );
  });

  it("rejects a predicate containing a non-string-literal entry", () => {
    assertRejected(
      `CREATE UNIQUE INDEX ${INDEX_NAME} ON plans(request_key) WHERE phase IN ('DRAFT', phase)`,
      /contains a non-string-literal or malformed entry: "phase"/,
    );
  });
});
