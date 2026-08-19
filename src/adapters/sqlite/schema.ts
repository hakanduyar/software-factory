/**
 * Schema DDL and the version marker (TASK-002 requirement 10: "the smallest
 * sensible schema-version mechanism").
 *
 * Every table stores the full domain record as a JSON `data` column — the
 * domain values are already JSON-safe (no `Date`, only numeric `Timestamp`;
 * see src/domain/time.ts and src/domain/freeze.ts) — plus the handful of
 * columns each adapter method needs to query or enforce invariants on
 * without parsing JSON first:
 *
 *   - `work_items.version`   : the optimistic-concurrency token, checked by
 *                               a real `UPDATE ... WHERE version = ?`.
 *   - `runs.status`          : the lifecycle guard, checked by a real
 *                               `UPDATE ... WHERE status = 'RUNNING'`.
 *   - `*.work_item_id`, `approvals.subject_type/subject_id`, `criteria`'s
 *     `work_item_id`: index targets for the `listByX` queries.
 *
 * `id` is the `PRIMARY KEY` on every table, so SQLite's own uniqueness
 * constraint is what makes the append-only tables (evidence, reviews,
 * approvals, verifications, and — via a separate `create`/`complete` split —
 * runs) reject id reuse; the adapter only needs to translate the resulting
 * SQLite constraint error into the domain's `AppendOnlyViolationError`.
 *
 * Every table relies on SQLite's implicit `rowid` for insertion-order
 * reads (`ORDER BY rowid ASC`), matching the in-memory adapter's `Map`
 * iteration order — several workflow preconditions rely on "the last
 * matching record wins" (see src/workflow/releaseSnapshotResolver.ts).
 */

import type { DatabaseSync } from "node:sqlite";

import { SchemaIntegrityError, SchemaVersionError } from "../../domain/errors.js";

/**
 * Bump when the table shape changes. TASK-002 intentionally ships no
 * migration runner — only detection, so a future migration mechanism has a
 * safe, loud failure mode to build on rather than silently misreading rows.
 */
export const SCHEMA_VERSION = 1;

/** Exported for tests that need to construct a raw, valid-shaped Factory database directly. */
export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  data TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_work_items_project_id ON work_items(project_id);

CREATE TABLE IF NOT EXISTS criteria (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  data TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_criteria_work_item_id ON criteria(work_item_id);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_runs_work_item_id ON runs(work_item_id);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  data TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_reviews_work_item_id ON reviews(work_item_id);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  data TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_evidence_work_item_id ON evidence(work_item_id);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  data TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_verifications_work_item_id ON verifications(work_item_id);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  data TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_approvals_subject ON approvals(subject_type, subject_id);
`;

interface ExpectedColumn {
  readonly name: string;
  /** SQLite storage class as reported by `PRAGMA table_info`, e.g. "TEXT"/"INTEGER". */
  readonly type: string;
  readonly notNull: boolean;
  /** True if this column is (part of) the table's PRIMARY KEY. */
  readonly primaryKey: boolean;
}

interface ExpectedIndex {
  readonly name: string;
  /** Indexed columns in order — order matters for composite indexes. */
  readonly columns: readonly string[];
  readonly unique: boolean;
}

interface ExpectedTable {
  readonly name: string;
  readonly columns: readonly ExpectedColumn[];
  /** Indexes this adapter's queries and invariants actually rely on. */
  readonly indexes: readonly ExpectedIndex[];
}

/**
 * The structural shape `ensureSchema` requires of an *existing* database —
 * kept in sync with `SCHEMA_DDL` by hand, since TASK-002 intentionally has no
 * migration framework to derive one from the other. Round-2 review found
 * that checking `schema_meta.schema_version` alone lets a table that lost
 * its `PRIMARY KEY` (and with it, the append-only guarantee) masquerade as a
 * valid database of the current version; this is what closes that gap.
 */
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
    name: "projects",
    columns: [
      { name: "id", type: "TEXT", notNull: true, primaryKey: true },
      { name: "data", type: "TEXT", notNull: true, primaryKey: false },
    ],
    indexes: [],
  },
  {
    name: "work_items",
    columns: [
      { name: "id", type: "TEXT", notNull: true, primaryKey: true },
      { name: "project_id", type: "TEXT", notNull: true, primaryKey: false },
      { name: "version", type: "INTEGER", notNull: true, primaryKey: false },
      { name: "data", type: "TEXT", notNull: true, primaryKey: false },
    ],
    indexes: [{ name: "idx_work_items_project_id", columns: ["project_id"], unique: false }],
  },
  {
    name: "criteria",
    columns: [
      { name: "id", type: "TEXT", notNull: true, primaryKey: true },
      { name: "work_item_id", type: "TEXT", notNull: true, primaryKey: false },
      { name: "data", type: "TEXT", notNull: true, primaryKey: false },
    ],
    indexes: [{ name: "idx_criteria_work_item_id", columns: ["work_item_id"], unique: false }],
  },
  {
    name: "runs",
    columns: [
      { name: "id", type: "TEXT", notNull: true, primaryKey: true },
      { name: "work_item_id", type: "TEXT", notNull: true, primaryKey: false },
      { name: "status", type: "TEXT", notNull: true, primaryKey: false },
      { name: "data", type: "TEXT", notNull: true, primaryKey: false },
    ],
    indexes: [{ name: "idx_runs_work_item_id", columns: ["work_item_id"], unique: false }],
  },
  {
    name: "reviews",
    columns: [
      { name: "id", type: "TEXT", notNull: true, primaryKey: true },
      { name: "work_item_id", type: "TEXT", notNull: true, primaryKey: false },
      { name: "data", type: "TEXT", notNull: true, primaryKey: false },
    ],
    indexes: [{ name: "idx_reviews_work_item_id", columns: ["work_item_id"], unique: false }],
  },
  {
    name: "evidence",
    columns: [
      { name: "id", type: "TEXT", notNull: true, primaryKey: true },
      { name: "work_item_id", type: "TEXT", notNull: true, primaryKey: false },
      { name: "data", type: "TEXT", notNull: true, primaryKey: false },
    ],
    indexes: [{ name: "idx_evidence_work_item_id", columns: ["work_item_id"], unique: false }],
  },
  {
    name: "verifications",
    columns: [
      { name: "id", type: "TEXT", notNull: true, primaryKey: true },
      { name: "work_item_id", type: "TEXT", notNull: true, primaryKey: false },
      { name: "data", type: "TEXT", notNull: true, primaryKey: false },
    ],
    indexes: [{ name: "idx_verifications_work_item_id", columns: ["work_item_id"], unique: false }],
  },
  {
    name: "approvals",
    columns: [
      { name: "id", type: "TEXT", notNull: true, primaryKey: true },
      { name: "subject_type", type: "TEXT", notNull: true, primaryKey: false },
      { name: "subject_id", type: "TEXT", notNull: true, primaryKey: false },
      { name: "data", type: "TEXT", notNull: true, primaryKey: false },
    ],
    indexes: [{ name: "idx_approvals_subject", columns: ["subject_type", "subject_id"], unique: false }],
  },
];

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/**
 * Every non-`sqlite_`-owned object in the database: tables, indexes,
 * triggers, views — anything a prior write could have created. SQLite's own
 * internal bookkeeping tables (`sqlite_sequence`, `sqlite_stat1`, ...) are
 * always named with an `sqlite_` prefix and must not make a genuinely empty
 * database look non-empty (Round-3 review, Step 4).
 */
function listUserSchemaObjects(db: DatabaseSync): { readonly type: string; readonly name: string }[] {
  const rows = db.prepare("SELECT type, name FROM sqlite_master").all() as { type: string; name: string }[];
  return rows.filter((row) => !row.name.startsWith("sqlite_"));
}

/**
 * Validates one table's columns against `EXPECTED_TABLES` (not its indexes —
 * see `validateTableIndexes`). Used standalone to check `schema_meta`'s own
 * shape *before* any query trusts it enough to read a value out of it
 * (Round-3 review, Step 5) — a malformed `schema_meta` must never let a raw
 * `ERR_SQLITE_ERROR` escape from a query built assuming valid columns.
 */
function validateTableColumns(db: DatabaseSync, table: ExpectedTable): void {
  if (!tableExists(db, table.name)) {
    throw new SchemaIntegrityError(`expected table "${table.name}" is missing from the database`);
  }

  // Table names here always come from the fixed EXPECTED_TABLES constant,
  // never external input, so interpolating into PRAGMA (which accepts no
  // bound parameters) is safe.
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
      throw new SchemaIntegrityError(`table "${table.name}" is missing expected column "${expected.name}"`);
    }
    if (actual.type.toUpperCase() !== expected.type) {
      throw new SchemaIntegrityError(
        `table "${table.name}" column "${expected.name}" has type ${actual.type}, expected ${expected.type}`,
      );
    }
    if ((actual.notnull === 1) !== expected.notNull) {
      throw new SchemaIntegrityError(`table "${table.name}" column "${expected.name}" NOT NULL does not match the expected schema`);
    }
    if ((actual.pk > 0) !== expected.primaryKey) {
      throw new SchemaIntegrityError(
        `table "${table.name}" column "${expected.name}" PRIMARY KEY does not match the expected schema ` +
          `(this is the constraint append-only identity relies on)`,
      );
    }
  }
}

/**
 * Validates that every index this adapter's queries rely on actually exists
 * with the expected indexed column(s), in order, and the expected
 * uniqueness — not merely that a same-named index exists (Round-3 review,
 * MEDIUM 2: an index name alone is not proof of its definition).
 */
function validateTableIndexes(db: DatabaseSync, table: ExpectedTable): void {
  const actualIndexes = db.prepare(`PRAGMA index_list("${table.name}")`).all() as { name: string; unique: number }[];
  const byName = new Map(actualIndexes.map((index) => [index.name, index]));

  for (const expected of table.indexes) {
    const actual = byName.get(expected.name);
    if (actual === undefined) {
      throw new SchemaIntegrityError(`table "${table.name}" is missing expected index "${expected.name}"`);
    }
    if ((actual.unique === 1) !== expected.unique) {
      throw new SchemaIntegrityError(`table "${table.name}" index "${expected.name}" uniqueness does not match the expected schema`);
    }

    const actualColumns = (db.prepare(`PRAGMA index_info("${expected.name}")`).all() as { seqno: number; name: string | null }[])
      .sort((a, b) => a.seqno - b.seqno)
      .map((column) => column.name);
    const columnsMatch =
      actualColumns.length === expected.columns.length && actualColumns.every((name, i) => name === expected.columns[i]);
    if (!columnsMatch) {
      throw new SchemaIntegrityError(
        `table "${table.name}" index "${expected.name}" indexes columns [${actualColumns.join(", ")}], expected ` +
          `[${expected.columns.join(", ")}] — an index with the right name but the wrong definition is not the right index`,
      );
    }
  }
}

function validateTable(db: DatabaseSync, table: ExpectedTable): void {
  validateTableColumns(db, table);
  validateTableIndexes(db, table);
}

/** Validates every expected table's columns and indexes. Never repairs — any mismatch throws. */
function validateSchema(db: DatabaseSync): void {
  for (const table of EXPECTED_TABLES) {
    validateTable(db, table);
  }
}

const SCHEMA_META_TABLE = EXPECTED_TABLES[0]!;

type DbClassification =
  | { readonly kind: "EMPTY" }
  | { readonly kind: "CURRENT_FACTORY" }
  | { readonly kind: "UNSUPPORTED_FACTORY_VERSION"; readonly storedVersion: string }
  | { readonly kind: "CORRUPT_OR_INCOMPLETE_FACTORY"; readonly reason: string }
  | { readonly kind: "NON_FACTORY_NONEMPTY"; readonly reason: string };

/**
 * Classifies a database using only read-only introspection (`sqlite_master`,
 * `PRAGMA table_info`/`index_list`/`index_info`, and plain `SELECT`s) —
 * nothing here executes DDL or a mutating `PRAGMA`, so classifying a
 * database never has a side effect on it (Round-3 review, Step 2 and 7).
 */
function classifyDatabase(db: DatabaseSync): DbClassification {
  const userObjects = listUserSchemaObjects(db);
  if (userObjects.length === 0) {
    return { kind: "EMPTY" };
  }

  const hasMetaTable = userObjects.some((object) => object.type === "table" && object.name === SCHEMA_META_TABLE.name);
  if (!hasMetaTable) {
    const hasAnyFactoryTable = EXPECTED_TABLES.some((table) =>
      userObjects.some((object) => object.type === "table" && object.name === table.name),
    );
    return hasAnyFactoryTable
      ? {
          kind: "CORRUPT_OR_INCOMPLETE_FACTORY",
          reason: "database has Factory-named tables but no schema_meta version marker; refusing to treat it as either a fresh database or a valid one",
        }
      : {
          kind: "NON_FACTORY_NONEMPTY",
          reason: "database has user-created schema objects that are not part of the Factory schema, and no schema_meta marker; refusing to initialize into it",
        };
  }

  // schema_meta exists by name — validate its own shape before trusting any
  // query built assuming its columns exist (this is what stops a malformed
  // schema_meta from leaking a raw ERR_SQLITE_ERROR).
  try {
    validateTableColumns(db, SCHEMA_META_TABLE);
  } catch (error) {
    if (error instanceof SchemaIntegrityError) {
      return { kind: "CORRUPT_OR_INCOMPLETE_FACTORY", reason: error.message };
    }
    throw error;
  }

  let versionRows: { value: string }[];
  try {
    versionRows = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").all() as { value: string }[];
  } catch (error) {
    return { kind: "CORRUPT_OR_INCOMPLETE_FACTORY", reason: `schema_meta could not be read: ${String(error)}` };
  }

  if (versionRows.length !== 1) {
    return {
      kind: "CORRUPT_OR_INCOMPLETE_FACTORY",
      reason: `schema_meta has ${versionRows.length} "schema_version" row(s), expected exactly 1`,
    };
  }

  const rawVersion = versionRows[0]!.value;
  const storedVersion = Number(rawVersion);
  // A non-numeric version value is a structural/data defect, not "a valid
  // Factory schema declaring a known unsupported version" — SchemaVersionError
  // is reserved for the latter (Round-3 review, Step 5).
  if (!Number.isFinite(storedVersion) || !Number.isInteger(storedVersion)) {
    return { kind: "CORRUPT_OR_INCOMPLETE_FACTORY", reason: `schema_meta.schema_version value "${rawVersion}" is not a valid integer` };
  }

  if (storedVersion !== SCHEMA_VERSION) {
    return { kind: "UNSUPPORTED_FACTORY_VERSION", storedVersion: rawVersion };
  }

  try {
    validateSchema(db);
  } catch (error) {
    if (error instanceof SchemaIntegrityError) {
      return { kind: "CORRUPT_OR_INCOMPLETE_FACTORY", reason: error.message };
    }
    throw error;
  }

  return { kind: "CURRENT_FACTORY" };
}

/**
 * Creates the schema on a fresh database, or validates an existing one.
 * Classification (`classifyDatabase`) runs entirely read-only, strictly
 * *before* any DDL or mutating `PRAGMA` executes — a database this build is
 * about to refuse (unsupported version, corrupt/incomplete Factory shape, or
 * an unrelated non-empty database) is never touched: not its tables, not its
 * `journal_mode`. `journal_mode = WAL` and `foreign_keys = OFF` are the only
 * settings this function ever changes, and only after classification has
 * already decided the database is safe to use (EMPTY, about to be
 * initialized; or CURRENT_FACTORY, already fully validated).
 */
export function ensureSchema(db: DatabaseSync): void {
  const classification = classifyDatabase(db);

  switch (classification.kind) {
    case "EMPTY":
      // The only path allowed to write anything: a database with zero
      // pre-existing user-created schema objects.
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec(SCHEMA_DDL);
      db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
      return;
    case "CURRENT_FACTORY":
      // Schema is already fully validated above; only now is it safe to
      // change a persistent setting, since nothing left could still refuse.
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA foreign_keys = OFF");
      return;
    case "UNSUPPORTED_FACTORY_VERSION":
      throw new SchemaVersionError(
        `database schema_version is ${classification.storedVersion}, this build expects ${SCHEMA_VERSION}. ` +
          `TASK-002 ships no migration runner; open the database with a matching Factory build, or a fresh database file.`,
      );
    case "CORRUPT_OR_INCOMPLETE_FACTORY":
    case "NON_FACTORY_NONEMPTY":
      throw new SchemaIntegrityError(classification.reason);
  }
}
