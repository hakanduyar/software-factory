/**
 * The durable `SupervisorRepository`, against a real SQLite file.
 *
 * This is the production adapter, and it is the reason TASK-006 means anything:
 * the Factory's ability to continue must survive the death of every process
 * involved. Between ticks there is no daemon and no model session — only this
 * file.
 *
 * Same discipline as TASK-002's store and TASK-005's plan repository:
 * single-row state, CAS on `version`, schema-version marker checked on open,
 * strict parse on read, and corruption refused rather than repaired.
 *
 * TASK-005 remediation round 3 is why this adapter exists at all rather than
 * shipping only the in-memory one: a substitute that behaves differently from
 * production is exactly how a production-only defect stays invisible through a
 * green test suite.
 */

import { DatabaseSync } from "node:sqlite";

import {
  ConcurrencyError,
  SchemaIntegrityError,
  SchemaVersionError,
  ValidationError,
} from "../../domain/errors.js";
import { encodeSupervisorState, parseSupervisorState } from "../../supervision/supervisorSerialization.js";
import type { SupervisorRepository } from "../../supervision/supervisorPorts.js";
import type { SupervisorState } from "../../supervision/supervisorTypes.js";

/** Bumped whenever the persisted shape changes incompatibly. */
export const SUPERVISOR_SCHEMA_VERSION = 1;

/** There is exactly one supervisor state per database. */
const SINGLETON_ID = "supervisor";

export interface SqliteSupervisorRepository extends SupervisorRepository {
  close(): void;
}

export function createSqliteSupervisorRepository(path: string): SqliteSupervisorRepository {
  const db = new DatabaseSync(path);
  ensureSchema(db);

  const insert = db.prepare("INSERT INTO supervisor_state (id, version, data) VALUES (?, ?, ?)");
  const find = db.prepare("SELECT id, version, data FROM supervisor_state WHERE id = ?");
  const update = db.prepare("UPDATE supervisor_state SET version = ?, data = ? WHERE id = ? AND version = ?");

  interface Row {
    readonly id: string;
    readonly version: number;
    readonly data: string;
  }

  return {
    async load(): Promise<SupervisorState | undefined> {
      const row = find.get(SINGLETON_ID) as Row | undefined;
      if (row === undefined) {
        return undefined;
      }
      // The SQL column and the payload must agree; a disagreement is corruption
      // rather than a preference for one of them.
      return parseSupervisorState(row.data, { version: row.version });
    },

    async create(state: SupervisorState): Promise<SupervisorState> {
      if ((find.get(SINGLETON_ID) as Row | undefined) !== undefined) {
        throw new ValidationError("supervisor state already exists");
      }
      // Round-trip on write, so a value that could not be read back never
      // reaches the file in the first place.
      const encoded = encodeSupervisorState(state);
      parseSupervisorState(encoded, { version: state.version });
      insert.run(SINGLETON_ID, state.version, encoded);
      return state;
    },

    async compareAndSave(next: SupervisorState, expectedVersion: number): Promise<SupervisorState> {
      const encoded = encodeSupervisorState(next);
      parseSupervisorState(encoded, { version: next.version });

      const result = update.run(next.version, encoded, SINGLETON_ID, expectedVersion);
      if (result.changes === 0) {
        const current = find.get(SINGLETON_ID) as Row | undefined;
        if (current === undefined) {
          throw new ValidationError("no supervisor state exists to update");
        }
        throw new ConcurrencyError(
          `supervisor state version conflict: expected ${expectedVersion}, found ${current.version}`,
        );
      }
      return next;
    },

    close(): void {
      db.close();
    },
  };
}

function ensureSchema(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS supervisor_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS supervisor_state (
      id      TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      data    TEXT NOT NULL
    );
  `);

  const row = db.prepare("SELECT value FROM supervisor_meta WHERE key = 'schema_version'").get() as
    | { readonly value: string }
    | undefined;

  if (row === undefined) {
    db.prepare("INSERT INTO supervisor_meta (key, value) VALUES ('schema_version', ?)").run(
      String(SUPERVISOR_SCHEMA_VERSION),
    );
  } else if (row.value !== String(SUPERVISOR_SCHEMA_VERSION)) {
    // A database from another build is refused outright rather than silently
    // migrated: guessing at another version's semantics is how state gets
    // quietly corrupted.
    throw new SchemaVersionError(
      `supervisor database schema version ${row.value} does not match this build's ${SUPERVISOR_SCHEMA_VERSION}`,
    );
  }

  const columns = db.prepare("PRAGMA table_info(supervisor_state)").all() as { readonly name: string }[];
  const names = new Set(columns.map((column) => column.name));
  for (const required of ["id", "version", "data"]) {
    if (!names.has(required)) {
      throw new SchemaIntegrityError(`supervisor_state is missing the required column "${required}"`);
    }
  }
}
