/**
 * TASK-002 Remediation Round 3: regression tests for two HIGH and two MEDIUM
 * findings in how `ensureSchema` classifies and opens a database, all found
 * by independent review.
 *
 * HIGH 1: opening an unsupported-version database changed `journal_mode`
 * from DELETE to WAL before `SchemaVersionError` was raised — a persistent,
 * on-disk mutation of a database the store was about to refuse.
 * HIGH 2: a non-empty, unrelated SQLite database (no Factory tables, no
 * `schema_meta`) was treated as "fresh" and had the Factory schema installed
 * into it.
 * MEDIUM 1: a malformed `schema_meta` table could make the version-lookup
 * query itself throw a raw `ERR_SQLITE_ERROR` instead of a controlled
 * `SchemaIntegrityError`.
 * MEDIUM 2: `validateSchema` checked only that an index with the expected
 * name existed, not that it actually indexed the expected column(s) in the
 * expected order — an index name is not proof of its definition.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { SCHEMA_DDL, SCHEMA_VERSION } from "../src/adapters/sqlite/schema.js";
import { createSqliteStore } from "../src/adapters/sqlite/sqliteStore.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import { readJournalMode, snapshotDb } from "./support/dbSnapshot.js";

after(cleanupTempDbs);

function freshDbPath(): string {
  return tempDbPath("factory-schema-open-");
}

/** A raw, valid-shaped Factory database (bypasses `createSqliteStore`, so journal_mode is left at its default). */
function buildRawFactoryDb(dbPath: string, options: { readonly version?: number | string; readonly journalMode?: string } = {}): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode = ${options.journalMode ?? "DELETE"}`);
  db.exec(SCHEMA_DDL);
  db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(options.version ?? SCHEMA_VERSION));
  db.prepare("INSERT INTO projects (id, data) VALUES (?, ?)").run(
    "prj-marker",
    JSON.stringify({ id: "prj-marker", key: "MRK", name: "Marker Project", createdAt: 1_800_000_000_000 }),
  );
  db.close();
}

describe("A: version mismatch must be read-only", () => {
  it("does not change journal_mode from DELETE, and leaves the database unchanged, when the version is unsupported", () => {
    const dbPath = freshDbPath();
    buildRawFactoryDb(dbPath, { version: 999, journalMode: "DELETE" });
    assert.equal(readJournalMode(dbPath), "delete");

    const before = snapshotDb(dbPath);
    assert.throws(() => createSqliteStore(dbPath), { code: "SCHEMA_VERSION_MISMATCH" });
    const afterRefusal = snapshotDb(dbPath);

    assert.equal(afterRefusal.journalMode, "delete", "journal_mode must remain DELETE after a refused open");
    assert.deepEqual(afterRefusal, before, "refusing an unsupported-version database must not mutate it at all");
  });
});

describe("B: unrelated non-empty SQLite DB must not initialize", () => {
  it("refuses a non-empty database with an unrelated user table, without touching it", () => {
    const dbPath = freshDbPath();
    const raw = new DatabaseSync(dbPath);
    raw.exec("CREATE TABLE customer_data (id INTEGER PRIMARY KEY, name TEXT)");
    raw.prepare("INSERT INTO customer_data (id, name) VALUES (1, 'Alice')").run();
    raw.close();

    const before = snapshotDb(dbPath);
    assert.throws(() => createSqliteStore(dbPath), { code: "SCHEMA_INTEGRITY_VIOLATION" });
    const afterRefusal = snapshotDb(dbPath);
    assert.deepEqual(afterRefusal, before, "an unrelated non-empty database must not be mutated");

    const raw2 = new DatabaseSync(dbPath);
    const row = raw2.prepare("SELECT name FROM customer_data WHERE id = 1").get() as { name: string };
    assert.equal(row.name, "Alice", "unrelated application data must survive the refused open untouched");
    const tables = (raw2.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    assert.deepEqual(tables, ["customer_data"], "no Factory tables may be created in an unrelated database");
    raw2.close();
  });

  it("still initializes a genuinely empty (zero-byte/new) database file", () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();
    // Reopening the now-initialized database must succeed too.
    createSqliteStore(dbPath).close();
  });

  it("initializes a database containing only internal sqlite_* metadata (e.g. a leftover sqlite_sequence table)", () => {
    const dbPath = freshDbPath();
    const raw = new DatabaseSync(dbPath);
    raw.exec("CREATE TABLE tmp_autoinc (id INTEGER PRIMARY KEY AUTOINCREMENT)");
    raw.exec("INSERT INTO tmp_autoinc DEFAULT VALUES");
    raw.exec("DROP TABLE tmp_autoinc");
    // sqlite_sequence remains as an internal, SQLite-owned table — it must
    // not make this database look "non-empty" to Factory classification.
    raw.close();

    createSqliteStore(dbPath).close();
  });
});

describe("C: malformed schema_meta must not leak a raw SQLite error", () => {
  it("a schema_meta missing its required 'value' column raises SchemaIntegrityError", () => {
    const dbPath = freshDbPath();
    const raw = new DatabaseSync(dbPath);
    raw.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY) STRICT");
    raw.prepare("INSERT INTO schema_meta (key) VALUES ('schema_version')").run();
    raw.close();

    assert.throws(() => createSqliteStore(dbPath), { code: "SCHEMA_INTEGRITY_VIOLATION" });
  });

  it("a schema_meta missing its PRIMARY KEY raises SchemaIntegrityError", () => {
    const dbPath = freshDbPath();
    const raw = new DatabaseSync(dbPath);
    raw.exec("CREATE TABLE schema_meta (key TEXT, value TEXT NOT NULL) STRICT");
    raw.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1')").run();
    raw.close();

    assert.throws(() => createSqliteStore(dbPath), { code: "SCHEMA_INTEGRITY_VIOLATION" });
  });

  it("a schema_meta with no schema_version row raises SchemaIntegrityError", () => {
    const dbPath = freshDbPath();
    const raw = new DatabaseSync(dbPath);
    raw.exec(SCHEMA_DDL);
    raw.close();

    assert.throws(() => createSqliteStore(dbPath), { code: "SCHEMA_INTEGRITY_VIOLATION" });
  });

  it("duplicate schema_version rows (PRIMARY KEY constraint absent) raise SchemaIntegrityError", () => {
    const dbPath = freshDbPath();
    const raw = new DatabaseSync(dbPath);
    raw.exec("CREATE TABLE schema_meta (key TEXT, value TEXT NOT NULL) STRICT");
    raw.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1')").run();
    raw.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1')").run();
    raw.close();

    assert.throws(() => createSqliteStore(dbPath), { code: "SCHEMA_INTEGRITY_VIOLATION" });
  });

  it("a schema_version value that is not a valid integer raises SchemaIntegrityError, not SchemaVersionError", () => {
    const dbPath = freshDbPath();
    const raw = new DatabaseSync(dbPath);
    raw.exec(SCHEMA_DDL);
    raw.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', 'not-a-number')").run();
    raw.close();

    assert.throws(() => createSqliteStore(dbPath), { code: "SCHEMA_INTEGRITY_VIOLATION" });
  });

  it("schema_meta.value with the wrong column type raises SchemaIntegrityError", () => {
    const dbPath = freshDbPath();
    const raw = new DatabaseSync(dbPath);
    raw.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT");
    raw.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', 1)").run();
    raw.close();

    assert.throws(() => createSqliteStore(dbPath), { code: "SCHEMA_INTEGRITY_VIOLATION" });
  });
});

describe("D: index definitions are validated, not just index names", () => {
  it("rejects an index with the expected name but a different indexed column", () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();

    const raw = new DatabaseSync(dbPath);
    raw.exec("DROP INDEX idx_work_items_project_id");
    raw.exec("CREATE INDEX idx_work_items_project_id ON work_items(version)");
    raw.close();

    assert.throws(() => createSqliteStore(dbPath), { code: "SCHEMA_INTEGRITY_VIOLATION" });
  });

  it("rejects a composite index whose columns are in the wrong order", () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();

    const raw = new DatabaseSync(dbPath);
    raw.exec("DROP INDEX idx_approvals_subject");
    raw.exec("CREATE INDEX idx_approvals_subject ON approvals(subject_id, subject_type)");
    raw.close();

    assert.throws(() => createSqliteStore(dbPath), { code: "SCHEMA_INTEGRITY_VIOLATION" });
  });

  it("rejects when an expected index is missing entirely", () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();

    const raw = new DatabaseSync(dbPath);
    raw.exec("DROP INDEX idx_runs_work_item_id");
    raw.close();

    assert.throws(() => createSqliteStore(dbPath), { code: "SCHEMA_INTEGRITY_VIOLATION" });
  });

  it("accepts the expected index name with exactly the expected column(s), untouched", () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();
    createSqliteStore(dbPath).close();
  });
});
