/**
 * Read-only Run ledger: opens an existing SQLite Factory database with
 * `node:sqlite`'s native `readOnly` connection and exposes only
 * `RunRepository.findById` and `RunRepository.listByWorkItem`.
 *
 * Deliberately not `createSqliteStore` reused read-only: that adapter calls
 * `ensureSchema`, which writes `PRAGMA journal_mode`/`foreign_keys` and, for
 * an empty database, the whole schema. A read-only ledger must never create
 * or alter the file it opens — a missing path stays missing, and an existing
 * database is only ever classified, never initialized — so this opens the
 * connection with `readOnly: true` and validates with
 * `assertReadonlyFactorySchema` instead.
 */

import { DatabaseSync } from "node:sqlite";

import { deepFreeze } from "../../domain/freeze.js";
import type { RunRepository } from "../../ports/repositories.js";
import { assertReadonlyFactorySchema } from "./schema.js";
import { parseRun } from "./serialization.js";

interface RunRow {
  readonly id: string;
  readonly work_item_id: string;
  readonly status: string;
  readonly data: string;
}

export function openReadonlyRunLedger(path: string): {
  runs: Pick<RunRepository, "findById" | "listByWorkItem">;
  close(): void;
} {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assertReadonlyFactorySchema(db);
    const runFind = db.prepare("SELECT id, work_item_id, status, data FROM runs WHERE id = ?");
    const runList = db.prepare("SELECT id, work_item_id, status, data FROM runs WHERE work_item_id = ? ORDER BY rowid ASC");
    return {
      runs: {
        async listByWorkItem(workItemId) {
          return (runList.all(workItemId) as unknown as RunRow[]).map((row) =>
            deepFreeze(parseRun(row.data, { id: row.id, workItemId: row.work_item_id, status: row.status })),
          );
        },
        async findById(id) {
          const row = runFind.get(id) as RunRow | undefined;
          return row === undefined
            ? undefined
            : deepFreeze(parseRun(row.data, { id: row.id, workItemId: row.work_item_id, status: row.status }));
        },
      },
      close(): void {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
