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

import { DatabaseSync } from "node:sqlite";

import { ConcurrencyError, SchemaIntegrityError, SchemaVersionError } from "../../domain/errors.js";
import { deepFreeze } from "../../domain/freeze.js";
import type { ProjectId } from "../../domain/ids.js";
import { encodePlan, parsePlan } from "../../planning/planSerialization.js";
import type { PlanRepository } from "../../planning/planRepository.js";
import { ACTIVE_PLAN_PHASES, type Plan, type PlanPhase } from "../../planning/planTypes.js";

const PLAN_SCHEMA_VERSION = 1;

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

function ensurePlanSchema(db: DatabaseSync): void {
  const userObjects = listUserSchemaObjects(db);

  if (userObjects.length === 0) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(PLAN_SCHEMA_DDL);
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('plan_schema_version', ?)").run(String(PLAN_SCHEMA_VERSION));
    return;
  }

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
  if (stored !== PLAN_SCHEMA_VERSION) {
    throw new SchemaVersionError(
      `plans database plan_schema_version is ${stored}, this build expects ${PLAN_SCHEMA_VERSION}. Open with a matching build, or a fresh database file.`,
    );
  }

  // Version marker matches — now validate the actual structure it claims.
  for (const table of EXPECTED_TABLES) {
    validateTable(db, table);
  }

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = OFF");
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
  ensurePlanSchema(db);

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
    close(): void {
      db.close();
    },
  };
}

export type { PlanPhase };
