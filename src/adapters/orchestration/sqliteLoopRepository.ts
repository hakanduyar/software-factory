/**
 * Durable LoopRepository (TASK-004), backed by its own small SQLite file
 * (conventionally `.factory-data/loops.db`), deliberately independent of
 * `src/adapters/sqlite/sqliteStore.ts`'s connection — see the design doc for
 * why a shared connection was rejected and how the crash-safe action
 * protocol reconciles the two files instead.
 *
 * Remediation round 1 (independent review HIGH 2/5, PARTS E/G/H) brings this
 * adapter to the same trust standard as the Factory's own SQLite adapter:
 *
 * - START UNIQUENESS at the persistence level: a partial UNIQUE index over
 *   `work_item_id` restricted to active phases makes "at most one active
 *   loop per work item" a database constraint, not a check-then-insert
 *   pattern. Two concurrent `create()` calls serialize inside SQLite; the
 *   loser gets a UNIQUE violation translated to `ConcurrencyError`.
 * - SCHEMA INTEGRITY on open (TASK-002 lesson): the version marker alone is
 *   not proof of shape. Every table/column/PK and every index this adapter's
 *   correctness relies on — including the partial unique index above — is
 *   validated structurally before any query trusts the database. Mismatch
 *   throws; nothing is silently repaired.
 * - THE INDEX'S WHERE PREDICATE ITSELF is validated (remediation round 2,
 *   independent review HIGH 1): `PRAGMA index_list`/`index_info` only prove
 *   an index is unique, partial, and over the right column — not that its
 *   condition actually restricts to the right *set of phases*. A
 *   semantically wrong predicate (a missing phase, an inverted condition, an
 *   unrelated WHERE clause) would otherwise pass structural validation while
 *   silently permitting more than one active loop per work item. See
 *   `validateActiveIndexPredicate` below.
 * - VALIDATE ON READ: rows decode through
 *   `src/orchestration/loopSerialization.ts` (full shape/enum/coherence
 *   validation + SQL-column/JSON cross-checks), never through a cast. A
 *   corrupted loop row therefore throws `PersistenceCorruptionError` at
 *   `findById` time and can never select an external worker action.
 */

import { DatabaseSync } from "node:sqlite";

import { ConcurrencyError, SchemaIntegrityError, SchemaVersionError } from "../../domain/errors.js";
import { deepFreeze } from "../../domain/freeze.js";
import type { WorkItemId } from "../../domain/ids.js";
import type { LoopRepository } from "../../orchestration/loopRepository.js";
import { encodeEngineeringLoop, parseEngineeringLoop } from "../../orchestration/loopSerialization.js";
import { ACTIVE_LOOP_PHASES, type EngineeringLoop, type LoopPhase } from "../../orchestration/loopTypes.js";

const LOOP_SCHEMA_VERSION = 2;

const ACTIVE_PHASES_SQL = ACTIVE_LOOP_PHASES.map((phase) => `'${phase}'`).join(", ");

const LOOP_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS engineering_loops (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  version INTEGER NOT NULL,
  data TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_engineering_loops_work_item_id ON engineering_loops(work_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_engineering_loops_active ON engineering_loops(work_item_id)
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
  /** When set, the index's WHERE clause is validated to restrict `phase` to exactly this set — see `validateActiveIndexPredicateSql`. */
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
    name: "engineering_loops",
    columns: [
      { name: "id", type: "TEXT", notNull: true, primaryKey: true },
      { name: "work_item_id", type: "TEXT", notNull: true, primaryKey: false },
      { name: "phase", type: "TEXT", notNull: true, primaryKey: false },
      { name: "version", type: "INTEGER", notNull: true, primaryKey: false },
      { name: "data", type: "TEXT", notNull: true, primaryKey: false },
    ],
    indexes: [
      { name: "idx_engineering_loops_work_item_id", columns: ["work_item_id"], unique: false, partial: false },
      // The active-loop uniqueness constraint this adapter's create() relies
      // on for start-uniqueness (PART E). Its absence, non-uniqueness, or
      // non-partial-ness would silently void that guarantee, so all three
      // are validated structurally — and so is the WHERE predicate itself
      // (remediation round 2, HIGH 1): PRAGMA introspection alone cannot see
      // *which* phases a partial index actually restricts to.
      {
        name: "idx_engineering_loops_active",
        columns: ["work_item_id"],
        unique: true,
        partial: true,
        requiredWherePhases: ACTIVE_LOOP_PHASES,
      },
    ],
  },
];

/**
 * Validates that a `CREATE ... INDEX` statement's WHERE clause is exactly
 * `phase IN (<requiredPhases>)`, tolerating harmless formatting variation
 * (whitespace, keyword casing, entry order, spacing around commas/quotes) —
 * a small, hand-written parser scoped to this ONE Factory-owned predicate
 * shape, deliberately not a general SQL parser (remediation round 2, HIGH 1
 * / PART 1). `sqlite_master.sql` retains the statement's original text
 * verbatim (SQLite does not re-serialize DDL), so this can inspect exactly
 * what was actually declared rather than trusting `PRAGMA index_list`/
 * `index_info`, which only prove an index is unique/partial/over the right
 * column — never which phases a partial condition restricts to. Exported for
 * direct unit testing without a live database.
 */
export function validateActiveIndexPredicateSql(sql: string, indexName: string, requiredPhases: readonly string[]): void {
  const whereMatch = /\bWHERE\b([\s\S]+)$/i.exec(sql);
  if (whereMatch === null) {
    throw new SchemaIntegrityError(
      `loops database: index "${indexName}" has no WHERE clause — expected a partial index restricted to active phases`,
    );
  }
  let clause = whereMatch[1]!.trim();
  if (clause.endsWith(";")) {
    clause = clause.slice(0, -1).trim();
  }

  const predicateMatch = /^phase\s+IN\s*\(([\s\S]*)\)$/i.exec(clause);
  if (predicateMatch === null) {
    throw new SchemaIntegrityError(
      `loops database: index "${indexName}" WHERE clause "${clause}" is not the expected "phase IN (...)" predicate`,
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
        `loops database: index "${indexName}" WHERE clause contains a non-string-literal or malformed entry: "${trimmedEntry}"`,
      );
    }
    actualPhases.add(literalMatch[1]!.replace(/''/g, "'"));
  }

  const expectedPhases = new Set(requiredPhases);
  const matches = actualPhases.size === expectedPhases.size && [...expectedPhases].every((phase) => actualPhases.has(phase));
  if (!matches) {
    throw new SchemaIntegrityError(
      `loops database: index "${indexName}" WHERE clause restricts phase to {${[...actualPhases].sort().join(", ")}}, expected exactly ` +
        `{${[...expectedPhases].sort().join(", ")}} — the active-loop uniqueness rule depends on this exact predicate`,
    );
  }
}

function validateActiveIndexPredicate(db: DatabaseSync, indexName: string, requiredPhases: readonly string[]): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName) as
    | { sql: string | null }
    | undefined;
  if (row === undefined || row.sql === null || row.sql.length === 0) {
    throw new SchemaIntegrityError(`loops database: could not read the definition of index "${indexName}" from sqlite_master`);
  }
  validateActiveIndexPredicateSql(row.sql, indexName, requiredPhases);
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
    throw new SchemaIntegrityError(`loops database: expected table "${table.name}" is missing`);
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
      throw new SchemaIntegrityError(`loops database: table "${table.name}" is missing expected column "${expected.name}"`);
    }
    if (actual.type.toUpperCase() !== expected.type) {
      throw new SchemaIntegrityError(
        `loops database: table "${table.name}" column "${expected.name}" has type ${actual.type}, expected ${expected.type}`,
      );
    }
    if ((actual.notnull === 1) !== expected.notNull) {
      throw new SchemaIntegrityError(`loops database: table "${table.name}" column "${expected.name}" NOT NULL does not match`);
    }
    if ((actual.pk > 0) !== expected.primaryKey) {
      throw new SchemaIntegrityError(
        `loops database: table "${table.name}" column "${expected.name}" PRIMARY KEY does not match (append-only/CAS identity relies on it)`,
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
      throw new SchemaIntegrityError(`loops database: table "${table.name}" is missing expected index "${expected.name}"`);
    }
    if ((actual.unique === 1) !== expected.unique) {
      throw new SchemaIntegrityError(`loops database: index "${expected.name}" uniqueness does not match the expected schema`);
    }
    if ((actual.partial === 1) !== expected.partial) {
      throw new SchemaIntegrityError(
        `loops database: index "${expected.name}" partial-ness does not match — the active-loop uniqueness rule depends on its WHERE clause`,
      );
    }
    const actualIndexColumns = (db.prepare(`PRAGMA index_info("${expected.name}")`).all() as { seqno: number; name: string | null }[])
      .sort((a, b) => a.seqno - b.seqno)
      .map((column) => column.name);
    const columnsMatch =
      actualIndexColumns.length === expected.columns.length && actualIndexColumns.every((name, i) => name === expected.columns[i]);
    if (!columnsMatch) {
      throw new SchemaIntegrityError(
        `loops database: index "${expected.name}" indexes columns [${actualIndexColumns.join(", ")}], expected [${expected.columns.join(", ")}]`,
      );
    }
    if (expected.requiredWherePhases !== undefined) {
      validateActiveIndexPredicate(db, expected.name, expected.requiredWherePhases);
    }
  }
}

function ensureLoopSchema(db: DatabaseSync): void {
  const userObjects = listUserSchemaObjects(db);

  if (userObjects.length === 0) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(LOOP_SCHEMA_DDL);
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('loop_schema_version', ?)").run(String(LOOP_SCHEMA_VERSION));
    return;
  }

  if (!tableExists(db, "schema_meta")) {
    throw new SchemaIntegrityError(
      "loops database is non-empty but has no schema_meta version marker; refusing to treat it as either fresh or valid",
    );
  }
  validateTable(db, EXPECTED_TABLES[0]!);

  const rows = db.prepare("SELECT value FROM schema_meta WHERE key = 'loop_schema_version'").all() as { value: string }[];
  if (rows.length !== 1) {
    throw new SchemaIntegrityError(`loops database schema_meta has ${rows.length} "loop_schema_version" row(s), expected exactly 1`);
  }
  const stored = Number(rows[0]!.value);
  if (!Number.isFinite(stored) || !Number.isInteger(stored)) {
    throw new SchemaIntegrityError(`loops database schema_meta.loop_schema_version value "${rows[0]!.value}" is not a valid integer`);
  }
  if (stored !== LOOP_SCHEMA_VERSION) {
    throw new SchemaVersionError(
      `loops database loop_schema_version is ${stored}, this build expects ${LOOP_SCHEMA_VERSION}. Open with a matching build, or a fresh database file.`,
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

/** SQLite names the violated COLUMN, not the index: the partial active-loop index reports `engineering_loops.work_item_id`. */
function isActiveUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes("engineering_loops.work_item_id");
}

export interface SqliteLoopRepository extends LoopRepository {
  close(): void;
}

interface LoopRow {
  readonly id: string;
  readonly work_item_id: string;
  readonly phase: string;
  readonly version: number;
  readonly data: string;
}

export function createSqliteLoopRepository(path: string): SqliteLoopRepository {
  const db = new DatabaseSync(path);
  ensureLoopSchema(db);

  const insert = db.prepare("INSERT INTO engineering_loops (id, work_item_id, phase, version, data) VALUES (?, ?, ?, ?, ?)");
  const cas = db.prepare("UPDATE engineering_loops SET phase = ?, version = ?, data = ? WHERE id = ? AND version = ?");
  const findStmt = db.prepare("SELECT id, work_item_id, phase, version, data FROM engineering_loops WHERE id = ?");
  const listStmt = db.prepare(
    "SELECT id, work_item_id, phase, version, data FROM engineering_loops WHERE work_item_id = ? ORDER BY rowid ASC",
  );

  function decodeRow(row: LoopRow): EngineeringLoop {
    return deepFreeze(parseEngineeringLoop(row.data, { id: row.id, workItemId: row.work_item_id, phase: row.phase, version: row.version }));
  }

  return {
    async create(loop: EngineeringLoop): Promise<EngineeringLoop> {
      const frozen = deepFreeze(loop);
      try {
        insert.run(frozen.id, frozen.workItemId, frozen.phase, frozen.version, encodeEngineeringLoop(frozen));
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new ConcurrencyError(
            isActiveUniqueViolation(error)
              ? `an active EngineeringLoop already exists for work item ${frozen.workItemId}`
              : `EngineeringLoop ${frozen.id} already exists`,
          );
        }
        throw error;
      }
      return frozen;
    },
    async compareAndSave(loop: EngineeringLoop, expectedVersion: number): Promise<EngineeringLoop> {
      const frozen = deepFreeze(loop);
      const result = cas.run(frozen.phase, frozen.version, encodeEngineeringLoop(frozen), frozen.id, expectedVersion);
      if (Number(result.changes) === 0) {
        const currentRow = findStmt.get(frozen.id) as LoopRow | undefined;
        const currentVersion = currentRow === undefined ? 0 : currentRow.version;
        throw new ConcurrencyError(
          `EngineeringLoop ${frozen.id} version conflict: expected current version ${expectedVersion}, found ${currentVersion}`,
        );
      }
      return frozen;
    },
    async findById(id: string): Promise<EngineeringLoop | undefined> {
      const row = findStmt.get(id) as LoopRow | undefined;
      return row === undefined ? undefined : decodeRow(row);
    },
    async listByWorkItem(workItemId: WorkItemId): Promise<readonly EngineeringLoop[]> {
      const rows = listStmt.all(workItemId) as unknown as LoopRow[];
      return rows.map((row) => decodeRow(row));
    },
    close(): void {
      db.close();
    },
  };
}

export type { LoopPhase };
