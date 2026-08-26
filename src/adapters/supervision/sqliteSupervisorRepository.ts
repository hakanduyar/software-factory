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

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
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

/** Owner-only: `rwx` for the directory, `rw-` for the files. */
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * SQLite's sidecars. In WAL mode the `-wal` file holds committed data that has
 * not yet been checkpointed into the main file, so leaving it world-readable
 * would expose exactly what tightening the database was meant to protect.
 */
const SIDECAR_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

/**
 * Restrict the database and its directory (AC-7).
 *
 * Applied on EVERY open, not only at creation. A file created before this code
 * existed — or by a restore, a copy, or a `umask` that permitted more — would
 * otherwise keep its original mode forever, and "we set it correctly when we
 * made it" is not a statement about the file in front of you.
 *
 * WHAT THIS DOES NOT DO, stated because the task's own criteria forbid
 * overclaiming: it raises the bar against OTHER local users and stray
 * processes. It does nothing against the operator's own account, which owns
 * the file and can chmod it back. The supervisor database remains part of the
 * trusted computing base.
 *
 * POSIX modes are meaningless on Windows, where `chmod` silently does almost
 * nothing; this is a Linux control and is not claimed as portable.
 */
function restrictPermissions(path: string): void {
  const directory = dirname(path);
  // `recursive` makes this idempotent, and `mode` applies only when it creates.
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  try {
    chmodSync(directory, DIRECTORY_MODE);
  } catch {
    // A directory owned by someone else cannot be tightened from here. Refusing
    // to run would make the Factory unusable on a shared checkout; the
    // permission state is reported rather than silently assumed.
  }
  for (const suffix of SIDECAR_SUFFIXES) {
    const candidate = `${path}${suffix}`;
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      chmodSync(candidate, FILE_MODE);
    } catch {
      /* same reasoning as the directory */
    }
  }
}

export function createSqliteSupervisorRepository(path: string): SqliteSupervisorRepository {
  // Before the open, so the directory exists and is already restricted when
  // SQLite creates the file inside it.
  restrictPermissions(path);
  const db = new DatabaseSync(path);
  // ...and again after, because the file (and any sidecar) only exists now.
  restrictPermissions(path);
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
