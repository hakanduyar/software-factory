/**
 * Durable PlanRepository (TASK-005), backed by its own small SQLite file
 * (conventionally `.factory-data/plans.db`), deliberately independent of both
 * `src/adapters/sqlite/sqliteStore.ts` and TASK-004's `loops.db` connection —
 * a plan coordinates the Factory store and the loop store, so owning a third
 * file keeps each store's schema, version marker and crash windows separately
 * reasoned about rather than entangling three lifecycles in one connection.
 *
 * This adapter is a deliberate structural mirror of the accepted TASK-004
 * `sqliteLoopRepository`, and inherits its remediation history wholesale
 * instead of rediscovering the same defects:
 *
 * - START UNIQUENESS at the persistence level: a partial UNIQUE index over
 *   `request_key` restricted to active phases makes "at most one active plan
 *   per human request" a database constraint, not a check-then-insert
 *   pattern. Two concurrent `plan start` calls for the same intent serialize
 *   inside SQLite; the loser gets a UNIQUE violation translated to
 *   `ConcurrencyError`, so the caller adopts the existing plan rather than
 *   duplicating planning work (and duplicating the work items it would go on
 *   to materialize).
 * - SCHEMA INTEGRITY on open (TASK-002 lesson): the version marker alone is
 *   not proof of shape. Every table/column/PK and every index this adapter's
 *   correctness relies on — including the partial unique index above — is
 *   validated structurally before any query trusts the database. Mismatch
 *   throws; nothing is silently repaired.
 * - THE INDEX'S WHERE PREDICATE ITSELF is validated (TASK-004 remediation
 *   round 2, independent review HIGH 1): `PRAGMA index_list`/`index_info`
 *   only prove an index is unique, partial, and over the right column — not
 *   that its condition actually restricts to the right *set of phases*. A
 *   semantically wrong predicate (a missing phase, an inverted condition, an
 *   unrelated WHERE clause) would otherwise pass structural validation while
 *   silently permitting two concurrent plans for one request. See
 *   `validatePlanActiveIndexPredicateSql` below.
 * - VALIDATE ON READ: rows decode through `src/planning/planSerialization.ts`
 *   (full shape/enum/coherence validation, revision-digest recomputation,
 *   correlation-tag recomputation, approval-triple coherence, plus
 *   SQL-column/JSON cross-checks), never through a cast. A corrupted plan row
 *   therefore throws `PersistenceCorruptionError` at read time and can never
 *   create a work item, derive an approval, or dispatch an external worker.
 */

import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { ConcurrencyError, PersistenceCorruptionError, SchemaIntegrityError, SchemaVersionError } from "../../domain/errors.js";
import { deepFreeze } from "../../domain/freeze.js";
import type { ProjectId } from "../../domain/ids.js";
import { encodePlan, parsePlan } from "../../planning/planSerialization.js";
import type { PlanRepository } from "../../planning/planRepository.js";
import { ACTIVE_PLAN_PHASES, type Plan, type PlanPhase } from "../../planning/planTypes.js";

const PLAN_SCHEMA_VERSION = 1;

// Canonical future-producer DDL for the plan request link table. The literal
// spelling is frozen: validatePlanLinkSchema compares sqlite_master.sql to it
// after only whitespace normalization (GLOB literals are case-sensitive).
const PLAN_LINK_SCHEMA_DDL =
  "CREATE TABLE plan_request_links (" +
  "bot_id INTEGER NOT NULL CHECK(bot_id BETWEEN 1 AND 9007199254740991), " +
  "update_id INTEGER NOT NULL CHECK(update_id BETWEEN 0 AND 9007199254740991), " +
  "request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'), " +
  "plan_id TEXT NOT NULL CHECK(length(plan_id)>0), " +
  "PRIMARY KEY(bot_id,update_id)) STRICT;";

function normalizePlanLinkSql(sql: string): string {
  let text = sql.trim();
  if (text.endsWith(";")) {
    text = text.slice(0, -1);
  }
  return text.replace(/\s+/g, " ").trim();
}

function validatePlanLinkSchema(db: DatabaseSync): void {
  const name = "plan_request_links";
  const fail = (detail: string): never => {
    throw new SchemaIntegrityError(`plans database: ${name} ${detail}`);
  };

  const objects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master").all() as {
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
  }[];
  const tables = objects.filter((row) => row.name === name);
  if (tables.length !== 1 || tables[0]!.type !== "table") {
    fail("must exist as exactly one table object");
  }
  const actualSql = tables[0]!.sql;
  if (actualSql === null || normalizePlanLinkSql(actualSql) !== normalizePlanLinkSql(PLAN_LINK_SCHEMA_DDL)) {
    fail("definition does not match the canonical DDL");
  }
  for (const row of objects) {
    if (row.name === name) {
      continue;
    }
    const isPkIndex = row.type === "index" && row.tbl_name === name && row.name === `sqlite_autoindex_${name}_1`;
    const linked = row.tbl_name === name || row.name.includes(name) || (row.sql ?? "").includes(name);
    if (linked && !isPkIndex) {
      fail(`has unexpected linked ${row.type} "${row.name}"`);
    }
  }

  const listed = (db.prepare(`PRAGMA table_list("${name}")`).all() as {
    schema: string;
    name: string;
    type: string;
    ncol: number;
    wr: number;
    strict: number;
  }[]).filter((row) => row.name === name);
  const entry = listed[0];
  if (listed.length !== 1 || entry!.schema !== "main" || entry!.type !== "table" || Number(entry!.strict) !== 1) {
    fail("must be a STRICT table in schema main");
  }

  const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  const expectedColumns = [
    ["bot_id", "INTEGER", 1],
    ["update_id", "INTEGER", 2],
    ["request_digest", "TEXT", 0],
    ["plan_id", "TEXT", 0],
  ] as const;
  if (columns.length !== expectedColumns.length) {
    fail(`has ${columns.length} columns, expected ${expectedColumns.length}`);
  }
  expectedColumns.forEach(([colName, colType, colPk], i) => {
    const actual = columns[i]!;
    if (
      Number(actual.cid) !== i ||
      actual.name !== colName ||
      actual.type !== colType ||
      Number(actual.notnull) !== 1 ||
      actual.dflt_value !== null ||
      Number(actual.pk) !== colPk
    ) {
      fail(`column ${i} does not match the canonical definition of "${colName}"`);
    }
  });

  const indexes = db.prepare(`PRAGMA index_list("${name}")`).all() as {
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }[];
  const pk = indexes[0];
  if (indexes.length !== 1 || pk!.origin !== "pk" || Number(pk!.unique) !== 1 || Number(pk!.partial) !== 0) {
    fail("must have exactly one unique non-partial primary-key index");
  }
  const keyColumns = (db.prepare(`PRAGMA index_info("${pk!.name}")`).all() as { seqno: number; name: string | null }[]).sort(
    (a, b) => a.seqno - b.seqno,
  );
  if (
    keyColumns.length !== 2 ||
    Number(keyColumns[0]!.seqno) !== 0 ||
    keyColumns[0]!.name !== "bot_id" ||
    Number(keyColumns[1]!.seqno) !== 1 ||
    keyColumns[1]!.name !== "update_id"
  ) {
    fail("primary key must be exactly (bot_id, update_id)");
  }
}

const ACTIVE_PHASES_SQL = ACTIVE_PLAN_PHASES.map((phase) => `'${phase}'`).join(", ");

const PLAN_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  phase TEXT NOT NULL,
  version INTEGER NOT NULL,
  data TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_plans_project_id ON plans(project_id);
CREATE INDEX IF NOT EXISTS idx_plans_request_key ON plans(request_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_active_request ON plans(request_key)
  WHERE phase IN (${ACTIVE_PHASES_SQL});
`;

interface ExpectedColumn {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly primaryKey: boolean;
}

interface ExpectedIndex {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly partial: boolean;
  /** When set, the index's WHERE clause is validated to restrict `phase` to exactly this set — see `validatePlanActiveIndexPredicateSql`. */
  readonly requiredWherePhases?: readonly string[];
}

interface ExpectedTable {
  readonly name: string;
  readonly columns: readonly ExpectedColumn[];
  readonly indexes: readonly ExpectedIndex[];
}

const EXPECTED_TABLES: readonly ExpectedTable[] = [
  {
    name: "schema_meta",
    columns: [
      { name: "key", type: "TEXT", notNull: true, primaryKey: true },
      { name: "value", type: "TEXT", notNull: true, primaryKey: false },
    ],
    indexes: [],
  },
  {
    name: "plans",
    columns: [
      { name: "id", type: "TEXT", notNull: true, primaryKey: true },
      { name: "project_id", type: "TEXT", notNull: true, primaryKey: false },
      { name: "request_key", type: "TEXT", notNull: true, primaryKey: false },
      { name: "phase", type: "TEXT", notNull: true, primaryKey: false },
      { name: "version", type: "INTEGER", notNull: true, primaryKey: false },
      { name: "data", type: "TEXT", notNull: true, primaryKey: false },
    ],
    indexes: [
      { name: "idx_plans_project_id", columns: ["project_id"], unique: false, partial: false },
      { name: "idx_plans_request_key", columns: ["request_key"], unique: false, partial: false },
      // The active-plan uniqueness constraint this adapter's create() relies
      // on for start-uniqueness. Its absence, non-uniqueness, or
      // non-partial-ness would silently void that guarantee, so all three are
      // validated structurally — and so is the WHERE predicate itself
      // (TASK-004 round 2, HIGH 1): PRAGMA introspection alone cannot see
      // *which* phases a partial index actually restricts to.
      {
        name: "idx_plans_active_request",
        columns: ["request_key"],
        unique: true,
        partial: true,
        requiredWherePhases: ACTIVE_PLAN_PHASES,
      },
    ],
  },
];

/**
 * Validates that a `CREATE ... INDEX` statement's WHERE clause is exactly
 * `phase IN (<requiredPhases>)`, tolerating harmless formatting variation
 * (whitespace, keyword casing, entry order, spacing around commas/quotes) —
 * a small, hand-written parser scoped to this ONE Factory-owned predicate
 * shape, deliberately not a general SQL parser (the TASK-004 round-2 lesson).
 * `sqlite_master.sql` retains the statement's original text verbatim (SQLite
 * does not re-serialize DDL), so this can inspect exactly what was actually
 * declared rather than trusting `PRAGMA index_list`/`index_info`, which only
 * prove an index is unique/partial/over the right column — never which phases
 * a partial condition restricts to. Exported for direct unit testing without a
 * live database.
 */
export function validatePlanActiveIndexPredicateSql(sql: string, indexName: string, requiredPhases: readonly string[]): void {
  const whereMatch = /\bWHERE\b([\s\S]+)$/i.exec(sql);
  if (whereMatch === null) {
    throw new SchemaIntegrityError(
      `plans database: index "${indexName}" has no WHERE clause — expected a partial index restricted to active phases`,
    );
  }
  let clause = whereMatch[1]!.trim();
  if (clause.endsWith(";")) {
    clause = clause.slice(0, -1).trim();
  }

  const predicateMatch = /^phase\s+IN\s*\(([\s\S]*)\)$/i.exec(clause);
  if (predicateMatch === null) {
    throw new SchemaIntegrityError(
      `plans database: index "${indexName}" WHERE clause "${clause}" is not the expected "phase IN (...)" predicate`,
    );
  }

  const listText = predicateMatch[1]!.trim();
  const literalPattern = /^'((?:[^']|'')*)'$/;
  const rawEntries = listText.length === 0 ? [] : listText.split(",");
  const actualPhases = new Set<string>();
  for (const rawEntry of rawEntries) {
    const trimmedEntry = rawEntry.trim();
    const literalMatch = literalPattern.exec(trimmedEntry);
    if (literalMatch === null) {
      throw new SchemaIntegrityError(
        `plans database: index "${indexName}" WHERE clause contains a non-string-literal or malformed entry: "${trimmedEntry}"`,
      );
    }
    actualPhases.add(literalMatch[1]!.replace(/''/g, "'"));
  }

  const expectedPhases = new Set(requiredPhases);
  const matches = actualPhases.size === expectedPhases.size && [...expectedPhases].every((phase) => actualPhases.has(phase));
  if (!matches) {
    throw new SchemaIntegrityError(
      `plans database: index "${indexName}" WHERE clause restricts phase to {${[...actualPhases].sort().join(", ")}}, expected exactly ` +
        `{${[...expectedPhases].sort().join(", ")}} — the active-plan uniqueness rule depends on this exact predicate`,
    );
  }
}

function validateActiveIndexPredicate(db: DatabaseSync, indexName: string, requiredPhases: readonly string[]): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName) as
    | { sql: string | null }
    | undefined;
  if (row === undefined || row.sql === null || row.sql.length === 0) {
    throw new SchemaIntegrityError(`plans database: could not read the definition of index "${indexName}" from sqlite_master`);
  }
  validatePlanActiveIndexPredicateSql(row.sql, indexName, requiredPhases);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function listUserSchemaObjects(db: DatabaseSync): { readonly type: string; readonly name: string }[] {
  const rows = db.prepare("SELECT type, name FROM sqlite_master").all() as { type: string; name: string }[];
  return rows.filter((row) => !row.name.startsWith("sqlite_"));
}

function validateTable(db: DatabaseSync, table: ExpectedTable): void {
  if (!tableExists(db, table.name)) {
    throw new SchemaIntegrityError(`plans database: expected table "${table.name}" is missing`);
  }

  const actualColumns = db.prepare(`PRAGMA table_info("${table.name}")`).all() as {
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }[];
  const byName = new Map(actualColumns.map((column) => [column.name, column]));
  for (const expected of table.columns) {
    const actual = byName.get(expected.name);
    if (actual === undefined) {
      throw new SchemaIntegrityError(`plans database: table "${table.name}" is missing expected column "${expected.name}"`);
    }
    if (actual.type.toUpperCase() !== expected.type) {
      throw new SchemaIntegrityError(
        `plans database: table "${table.name}" column "${expected.name}" has type ${actual.type}, expected ${expected.type}`,
      );
    }
    if ((actual.notnull === 1) !== expected.notNull) {
      throw new SchemaIntegrityError(`plans database: table "${table.name}" column "${expected.name}" NOT NULL does not match`);
    }
    if ((actual.pk > 0) !== expected.primaryKey) {
      throw new SchemaIntegrityError(
        `plans database: table "${table.name}" column "${expected.name}" PRIMARY KEY does not match (append-only/CAS identity relies on it)`,
      );
    }
  }

  const actualIndexes = db.prepare(`PRAGMA index_list("${table.name}")`).all() as {
    name: string;
    unique: number;
    partial: number;
  }[];
  const indexByName = new Map(actualIndexes.map((index) => [index.name, index]));
  for (const expected of table.indexes) {
    const actual = indexByName.get(expected.name);
    if (actual === undefined) {
      throw new SchemaIntegrityError(`plans database: table "${table.name}" is missing expected index "${expected.name}"`);
    }
    if ((actual.unique === 1) !== expected.unique) {
      throw new SchemaIntegrityError(`plans database: index "${expected.name}" uniqueness does not match the expected schema`);
    }
    if ((actual.partial === 1) !== expected.partial) {
      throw new SchemaIntegrityError(
        `plans database: index "${expected.name}" partial-ness does not match — the active-plan uniqueness rule depends on its WHERE clause`,
      );
    }
    const actualIndexColumns = (db.prepare(`PRAGMA index_info("${expected.name}")`).all() as { seqno: number; name: string | null }[])
      .sort((a, b) => a.seqno - b.seqno)
      .map((column) => column.name);
    const columnsMatch =
      actualIndexColumns.length === expected.columns.length && actualIndexColumns.every((name, i) => name === expected.columns[i]);
    if (!columnsMatch) {
      throw new SchemaIntegrityError(
        `plans database: index "${expected.name}" indexes columns [${actualIndexColumns.join(", ")}], expected [${expected.columns.join(", ")}]`,
      );
    }
    if (expected.requiredWherePhases !== undefined) {
      validateActiveIndexPredicate(db, expected.name, expected.requiredWherePhases);
    }
  }
}

/**
 * Read-only validation of every existing plan_request_links row: actual typed
 * values (no coercion), then the linked Plan must exist and decode through the
 * same parsePlan relationship the repository uses on read. Call only after the
 * base schema and the link table schema have been validated.
 */
function validatePlanLinkRows(db: DatabaseSync): void {
  const fail = (detail: string): never => {
    throw new SchemaIntegrityError(`plans database: plan_request_links ${detail}`);
  };

  const links = db.prepare("SELECT bot_id,update_id,request_digest,plan_id FROM plan_request_links").all() as Record<string, unknown>[];
  const findPlan = db.prepare("SELECT id,project_id,request_key,phase,version,data FROM plans WHERE id=?");
  for (const link of links) {
    const botId = link.bot_id;
    const updateId = link.update_id;
    const digest = link.request_digest;
    const planId = link.plan_id;
    if (typeof botId !== "number" || !Number.isSafeInteger(botId) || botId <= 0) {
      fail("row has an invalid bot_id");
    }
    if (typeof updateId !== "number" || !Number.isSafeInteger(updateId) || updateId < 0) {
      fail("row has an invalid update_id");
    }
    if (typeof digest !== "string" || digest.length !== 64 || !/^[0-9a-f]{64}$/.test(digest)) {
      fail("row has an invalid request_digest");
    }
    if (typeof planId !== "string" || planId.length === 0) {
      fail("row has an invalid plan_id");
    }

    const row = findPlan.get(planId as string) as Record<string, unknown> | undefined;
    if (row === undefined) {
      fail("row references a Plan that does not exist");
    }
    const plan = row as Record<string, unknown>;
    if (
      typeof plan.id !== "string" ||
      typeof plan.project_id !== "string" ||
      typeof plan.request_key !== "string" ||
      typeof plan.phase !== "string" ||
      typeof plan.version !== "number" ||
      typeof plan.data !== "string"
    ) {
      fail("row references a Plan row with invalid column types");
    }
    const planRow = plan as unknown as PlanRow;
    // Throws if the stored Plan serialization/hash/identity is not valid.
    parsePlan(planRow.data, {
      id: planRow.id,
      projectId: planRow.project_id,
      requestKey: planRow.request_key,
      phase: planRow.phase,
      version: planRow.version,
    });
  }
}

/**
 * Read-only validation of a NON-EMPTY existing plans database. Returns the
 * recognized schema version (1, or 2 once explicitly upgraded). Never writes
 * and never initializes anything, so it is safe to run before maintenance.
 */
function inspectExistingPlanDatabase(db: DatabaseSync): 1 | 2 {
  if (!tableExists(db, "schema_meta")) {
    throw new SchemaIntegrityError(
      "plans database is non-empty but has no schema_meta version marker; refusing to treat it as either fresh or valid",
    );
  }
  validateTable(db, EXPECTED_TABLES[0]!);

  const rows = db.prepare("SELECT value FROM schema_meta WHERE key = 'plan_schema_version'").all() as { value: string }[];
  if (rows.length !== 1) {
    throw new SchemaIntegrityError(`plans database schema_meta has ${rows.length} "plan_schema_version" row(s), expected exactly 1`);
  }
  const stored = Number(rows[0]!.value);
  if (!Number.isFinite(stored) || !Number.isInteger(stored)) {
    throw new SchemaIntegrityError(`plans database schema_meta.plan_schema_version value "${rows[0]!.value}" is not a valid integer`);
  }
  if (stored !== 1 && stored !== 2) {
    throw new SchemaVersionError(
      `plans database plan_schema_version is ${stored}, this build expects 1 or 2. Open with a matching build, or a fresh database file.`,
    );
  }

  // Version marker recognized — now validate the actual structure it claims.
  for (const table of EXPECTED_TABLES) {
    validateTable(db, table);
  }

  if (stored === 1) {
    const linked = (
      db.prepare("SELECT name, tbl_name, sql FROM sqlite_master").all() as { name: string; tbl_name: string; sql: string | null }[]
    ).some(
      (row) =>
        row.name === "plan_request_links" ||
        row.tbl_name === "plan_request_links" ||
        row.name.includes("plan_request_links") ||
        (row.sql ?? "").includes("plan_request_links"),
    );
    if (linked) {
      throw new SchemaIntegrityError("plans database: version 1 must not contain plan_request_links objects");
    }
    return 1;
  }
  validatePlanLinkSchema(db);
  validatePlanLinkRows(db);
  return 2;
}

/**
 * Public read-only guard: succeeds only for an existing, validated plans
 * database that has been explicitly upgraded to schema v2. Never writes or
 * initializes anything.
 */
export function assertReadonlyPlanSchemaV2(db: DatabaseSync): void {
  if (inspectExistingPlanDatabase(db) !== 2) {
    throw new SchemaVersionError(
      "plans database is not schema v2; read-only inspection requires an explicitly upgraded v2 database",
    );
  }
}

function ensurePlanSchema(db: DatabaseSync): void {
  if (listUserSchemaObjects(db).length === 0) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(PLAN_SCHEMA_DDL);
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('plan_schema_version', ?)").run(String(PLAN_SCHEMA_VERSION));
    return;
  }
  inspectExistingPlanDatabase(db);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = OFF");
}

/**
 * Explicit maintenance-only v1 -> v2 upgrade of an EXISTING plans database.
 * Never creates, initializes or repairs: a missing/non-file/empty/foreign/
 * corrupt/newer input throws. A valid v2 is verified read-only and left
 * untouched. The ordinary constructor never calls this.
 */
export function upgradePlanSchemaV1ToV2(existingPath: string): void {
  let stat: ReturnType<typeof statSync> | undefined;
  try {
    stat = statSync(existingPath);
  } catch {
    stat = undefined;
  }
  if (stat === undefined || !stat.isFile() || stat.size === 0) {
    throw new SchemaIntegrityError("plans database upgrade requires an existing non-empty database file");
  }

  const readOnly = new DatabaseSync(existingPath, { readOnly: true });
  let recognized: 1 | 2 | undefined;
  let inspectFailure: unknown;
  let inspectFailed = false;
  try {
    recognized = inspectExistingPlanDatabase(readOnly);
  } catch (error) {
    inspectFailed = true;
    inspectFailure = error;
  }
  try {
    readOnly.close();
  } catch (closeError) {
    if (!inspectFailed) {
      inspectFailed = true;
      inspectFailure = closeError;
    }
  }
  if (inspectFailed) {
    throw inspectFailure;
  }
  if (recognized === 2) {
    return;
  }

  const db = new DatabaseSync(existingPath);
  let failure: unknown;
  let failed = false;
  let begun = false;
  try {
    // Recheck recognition on the writable handle before any mutation.
    if (inspectExistingPlanDatabase(db) !== 1) {
      throw new SchemaIntegrityError("plans database changed during upgrade; expected version 1");
    }
    db.exec("BEGIN IMMEDIATE");
    begun = true;
    if (inspectExistingPlanDatabase(db) !== 1) {
      throw new SchemaIntegrityError("plans database changed during upgrade; expected version 1");
    }
    db.exec(PLAN_LINK_SCHEMA_DDL);
    const result = db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'plan_schema_version'").run("2");
    if (Number(result.changes) !== 1) {
      throw new SchemaIntegrityError("plans database upgrade did not update exactly one plan_schema_version row");
    }
    if (inspectExistingPlanDatabase(db) !== 2) {
      throw new SchemaIntegrityError("plans database upgrade did not produce a valid version 2 schema");
    }
    db.exec("COMMIT");
    begun = false;
  } catch (error) {
    failed = true;
    failure = error;
    if (begun) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original upgrade error even if rollback fails.
      }
    }
  }
  try {
    db.close();
  } catch (closeError) {
    if (!failed) {
      failed = true;
      failure = closeError;
    }
  }
  if (failed) {
    throw failure;
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === "ERR_SQLITE_ERROR" &&
    /UNIQUE constraint failed/.test(error.message)
  );
}

/**
 * Note on diagnosing WHICH constraint an insert violated.
 *
 * The TASK-004 loop adapter reads SQLite's error text for the offending column
 * name, which is correct there because its two constraints cannot both be
 * violated by one insert in practice. Here they can: re-inserting the very same
 * plan collides on the primary key AND on the partial active-request index at
 * once — and SQLite reports only whichever index it happened to check first, so
 * the message may not name the id at all.
 *
 * So the cause is determined by READING rather than by parsing a message: if a
 * row with this id already exists, that is the duplicate; otherwise the active
 * request key is. One extra read, only on an error path, in exchange for a
 * diagnosis that does not depend on SQLite's internal index ordering.
 */

export interface SqlitePlanRepository extends PlanRepository {
  close(): void;
}

interface PlanRow {
  readonly id: string;
  readonly project_id: string;
  readonly request_key: string;
  readonly phase: string;
  readonly version: number;
  readonly data: string;
}

export function createSqlitePlanRepository(path: string): SqlitePlanRepository {
  const db = new DatabaseSync(path);
  try {
    ensurePlanSchema(db);
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the original schema error even if close fails.
    }
    throw error;
  }

  const insert = db.prepare("INSERT INTO plans (id, project_id, request_key, phase, version, data) VALUES (?, ?, ?, ?, ?, ?)");
  const cas = db.prepare(
    "UPDATE plans SET project_id = ?, request_key = ?, phase = ?, version = ?, data = ? WHERE id = ? AND version = ?",
  );
  const findStmt = db.prepare("SELECT id, project_id, request_key, phase, version, data FROM plans WHERE id = ?");
  // The active-phase filter is the same list the partial unique index uses, so
  // "the active plan for this request" is answered by exactly the predicate
  // that makes at most one such plan possible.
  const findActiveStmt = db.prepare(
    `SELECT id, project_id, request_key, phase, version, data FROM plans WHERE request_key = ? AND phase IN (${ACTIVE_PHASES_SQL}) ORDER BY rowid ASC`,
  );
  const listStmt = db.prepare(
    "SELECT id, project_id, request_key, phase, version, data FROM plans WHERE project_id = ? ORDER BY rowid ASC",
  );

  function decodeRow(row: PlanRow): Plan {
    return deepFreeze(
      parsePlan(row.data, {
        id: row.id,
        projectId: row.project_id,
        requestKey: row.request_key,
        phase: row.phase,
        version: row.version,
      }),
    );
  }

  return {
    async create(plan: Plan): Promise<Plan> {
      const frozen = deepFreeze(plan);
      try {
        insert.run(frozen.id, frozen.projectId, frozen.requestKey, frozen.phase, frozen.version, encodePlan(frozen));
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          const duplicateId = findStmt.get(frozen.id) !== undefined;
          throw new ConcurrencyError(
            duplicateId
              ? `Plan ${frozen.id} already exists`
              : `an active Plan already exists for request ${frozen.requestKey}`,
          );
        }
        throw error;
      }
      return frozen;
    },
    async compareAndSave(plan: Plan, expectedVersion: number): Promise<Plan> {
      const frozen = deepFreeze(plan);
      const result = cas.run(
        frozen.projectId,
        frozen.requestKey,
        frozen.phase,
        frozen.version,
        encodePlan(frozen),
        frozen.id,
        expectedVersion,
      );
      if (Number(result.changes) === 0) {
        const currentRow = findStmt.get(frozen.id) as PlanRow | undefined;
        const currentVersion = currentRow === undefined ? 0 : currentRow.version;
        throw new ConcurrencyError(
          `Plan ${frozen.id} version conflict: expected current version ${expectedVersion}, found ${currentVersion}`,
        );
      }
      return frozen;
    },
    async findById(id: string): Promise<Plan | undefined> {
      const row = findStmt.get(id) as PlanRow | undefined;
      return row === undefined ? undefined : decodeRow(row);
    },
    async findActiveByRequestKey(requestKey: string): Promise<Plan | undefined> {
      const rows = findActiveStmt.all(requestKey) as unknown as PlanRow[];
      const first = rows[0];
      return first === undefined ? undefined : decodeRow(first);
    },
    async listByProject(projectId: ProjectId): Promise<readonly Plan[]> {
      const rows = listStmt.all(projectId) as unknown as PlanRow[];
      return rows.map((row) => decodeRow(row));
    },
    async createOrAdoptLinkedRequest(
      candidate: Plan,
      binding: { botId: number; updateId: number; requestDigest: string },
    ): Promise<Plan> {
      // Everything up to BEGIN is synchronous: binding and candidate are copied
      // once, so later caller mutation or aliasing cannot influence the write.
      const botId = binding.botId;
      const updateId = binding.updateId;
      const requestDigest = binding.requestDigest;
      if (typeof botId !== "number" || !Number.isSafeInteger(botId) || botId < 1) {
        throw new TypeError("linked request botId must be a safe integer >= 1");
      }
      if (typeof updateId !== "number" || !Number.isSafeInteger(updateId) || updateId < 0) {
        throw new TypeError("linked request updateId must be a safe integer >= 0");
      }
      if (typeof requestDigest !== "string" || requestDigest.length !== 64 || !/^[0-9a-f]{64}$/.test(requestDigest)) {
        throw new TypeError("linked request requestDigest must be 64 lowercase hex characters");
      }

      const id = candidate.id;
      const projectId = candidate.projectId;
      const requestKey = candidate.requestKey;
      const phase = candidate.phase;
      const version = candidate.version;
      if (phase !== "DRAFT" || version !== 1) {
        throw new TypeError("linked request candidate must be an initial DRAFT Plan at version 1");
      }
      const encoded = encodePlan(candidate);
      const captured = deepFreeze(parsePlan(encoded, { id, projectId, requestKey, phase, version }));

      if (inspectExistingPlanDatabase(db) !== 2) {
        throw new SchemaVersionError(
          "linked plan requests require an explicitly upgraded version 2 plans database; version 1 is not upgraded automatically",
        );
      }

      const findLink = db.prepare(
        "SELECT request_digest, plan_id FROM plan_request_links WHERE bot_id = ? AND update_id = ?",
      );
      const insertLink = db.prepare(
        "INSERT INTO plan_request_links (bot_id, update_id, request_digest, plan_id) VALUES (?, ?, ?, ?)",
      );

      let chosen: Plan;
      let begun = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        begun = true;
        if (inspectExistingPlanDatabase(db) !== 2) {
          throw new SchemaIntegrityError("plans database changed during linked request; expected version 2");
        }

        const linked = findLink.get(botId, updateId) as { request_digest: string; plan_id: string } | undefined;
        if (linked !== undefined) {
          if (linked.request_digest !== requestDigest) {
            throw new ConcurrencyError(
              `linked request ${botId}/${updateId} already exists with a different request digest`,
            );
          }
          const targetRow = findStmt.get(linked.plan_id) as PlanRow | undefined;
          if (targetRow === undefined) {
            throw new PersistenceCorruptionError(
              `linked request ${botId}/${updateId} references missing Plan ${linked.plan_id}`,
            );
          }
          chosen = decodeRow(targetRow);
        } else {
          const activeRows = findActiveStmt.all(requestKey) as unknown as PlanRow[];
          const activeRow = activeRows[0];
          if (activeRow !== undefined) {
            chosen = decodeRow(activeRow);
          } else {
            try {
              insert.run(
                captured.id,
                captured.projectId,
                captured.requestKey,
                captured.phase,
                captured.version,
                encodePlan(captured),
              );
            } catch (error) {
              if (isUniqueConstraintError(error)) {
                throw new ConcurrencyError(
                  findStmt.get(captured.id) !== undefined
                    ? `Plan ${captured.id} already exists`
                    : `an active Plan already exists for request ${captured.requestKey}`,
                );
              }
              throw error;
            }
            chosen = captured;
          }
          insertLink.run(botId, updateId, requestDigest, chosen.id);
        }

        if (inspectExistingPlanDatabase(db) !== 2) {
          throw new SchemaIntegrityError("plans database did not remain a valid version 2 schema after linked request");
        }
        db.exec("COMMIT");
        begun = false;
      } catch (error) {
        if (begun) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Preserve the original error even if rollback fails.
          }
        }
        throw error;
      }
      return chosen;
    },
    close(): void {
      db.close();
    },
  };
}

export type { PlanPhase };
