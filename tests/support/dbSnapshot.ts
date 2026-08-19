/**
 * A reusable "did opening this database mutate it" comparator (TASK-002
 * Remediation Round 3, Step 7: "FAILED VALIDATION MUST NOT MUTATE AN
 * EXISTING DATABASE"). Captures journal mode, the full `sqlite_master`
 * schema, and every table's row count, so a before/after `deepEqual` proves
 * a refused `createSqliteStore()` call left no trace — not even a
 * journal_mode change.
 */

import { DatabaseSync } from "node:sqlite";

export interface DbSnapshot {
  readonly journalMode: string;
  readonly master: readonly { readonly type: string; readonly name: string; readonly tbl_name: string; readonly sql: string | null }[];
  readonly rowCounts: Readonly<Record<string, number>>;
}

export function snapshotDb(dbPath: string): DbSnapshot {
  const db = new DatabaseSync(dbPath);
  try {
    const journalModeRow = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const master = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all() as {
      type: string;
      name: string;
      tbl_name: string;
      sql: string | null;
    }[];
    const tableNames = master.filter((row) => row.type === "table").map((row) => row.name);
    const rowCounts = Object.fromEntries(
      tableNames.map((name) => [name, (db.prepare(`SELECT count(*) AS c FROM "${name}"`).get() as { c: number }).c]),
    );
    return { journalMode: journalModeRow.journal_mode, master, rowCounts };
  } finally {
    db.close();
  }
}

/** Reads just the journal mode, without touching anything else. */
export function readJournalMode(dbPath: string): string {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
  } finally {
    db.close();
  }
}
