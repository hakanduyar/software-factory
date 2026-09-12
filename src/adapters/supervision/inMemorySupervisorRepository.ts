/**
 * In-memory `SupervisorRepository`, for tests and for the deterministic demo.
 *
 * Mirrors the SQLite adapter's CAS semantics exactly, so a test that passes
 * here means the same thing it would mean there. Round 3 of TASK-005 is the
 * reason that sentence is written down: a substitute that behaves differently
 * from production is how a production-only defect stays invisible.
 */

import { ConcurrencyError, ValidationError } from "../../domain/errors.js";
import { ROADMAP_CATALOG_VERSION } from "../../supervision/catalogUpgrade.js";
import type { SupervisorRepository } from "../../supervision/supervisorPorts.js";
import type { SupervisorState } from "../../supervision/supervisorTypes.js";
import { validateRoadmap } from "../../supervision/supervisorService.js";

export function createInMemorySupervisorRepository(): SupervisorRepository {
  let stored: SupervisorState | undefined;
  /**
   * Undefined until a state exists, and then whatever the state was written at
   * — mirroring the SQLite adapter, where the record lives in `supervisor_meta`
   * and a database that has never been written has no row to read.
   */
  let catalogVersion: number | undefined;

  return {
    async load(): Promise<SupervisorState | undefined> {
      return stored;
    },

    async create(state: SupervisorState): Promise<SupervisorState> {
      if (stored !== undefined) {
        throw new ValidationError("supervisor state already exists");
      }
      validateRoadmap(state.roadmap);
      stored = deepFreeze(state);
      // A database created by THIS build is at this build's catalog version
      // (AC-1). It has no history to upgrade from.
      catalogVersion = ROADMAP_CATALOG_VERSION;
      return stored;
    },

    async compareAndSave(next: SupervisorState, expectedVersion: number): Promise<SupervisorState> {
      if (stored === undefined) {
        throw new ValidationError("no supervisor state exists to update");
      }
      if (stored.version !== expectedVersion) {
        throw new ConcurrencyError(
          `supervisor state version conflict: expected ${expectedVersion}, found ${stored.version}`,
        );
      }
      validateRoadmap(next.roadmap);
      stored = deepFreeze(next);
      return stored;
    },

    async readCatalogVersion(): Promise<number | undefined> {
      return catalogVersion;
    },

    async applyCatalogUpgrade(
      next: SupervisorState,
      expectedVersion: number,
      toCatalogVersion: number,
    ): Promise<SupervisorState> {
      if (stored === undefined) {
        throw new ValidationError("no supervisor state exists to upgrade");
      }
      if (stored.version !== expectedVersion) {
        throw new ConcurrencyError(
          `supervisor state version conflict: expected ${expectedVersion}, found ${stored.version}`,
        );
      }
      validateRoadmap(next.roadmap);
      /**
       * Both assignments after every check that can throw, so a refusal leaves
       * this adapter exactly as it found it — the in-memory equivalent of the
       * SQLite adapter's rollback, and what makes a test that passes here mean
       * the same thing it would mean there.
       */
      stored = deepFreeze(next);
      catalogVersion = toCatalogVersion;
      return stored;
    },
  };
}

/**
 * Lets a test construct a repository that has NEVER recorded a catalog version,
 * which is what every database written before TASK-018 looks like.
 *
 * Exported rather than reached by casting, because a test that reaches into an
 * adapter's private state proves something about the test, not the adapter.
 */
export function createInMemorySupervisorRepositoryAtCatalogVersion(
  version: number | undefined,
): SupervisorRepository {
  const inner = createInMemorySupervisorRepository();
  let recorded = version;

  return {
    load: () => inner.load(),
    compareAndSave: (next, expectedVersion) => inner.compareAndSave(next, expectedVersion),

    async create(state: SupervisorState): Promise<SupervisorState> {
      const result = await inner.create(state);
      // `inner.create` records THIS build's version; an old database is the
      // whole point of this helper, so the seeded value wins.
      recorded = version;
      return result;
    },

    async readCatalogVersion(): Promise<number | undefined> {
      return recorded;
    },

    async applyCatalogUpgrade(next, expectedVersion, toCatalogVersion) {
      const result = await inner.applyCatalogUpgrade(next, expectedVersion, toCatalogVersion);
      recorded = toCatalogVersion;
      return result;
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
