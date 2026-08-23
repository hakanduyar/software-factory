/**
 * In-memory `SupervisorRepository`, for tests and for the deterministic demo.
 *
 * Mirrors the SQLite adapter's CAS semantics exactly, so a test that passes
 * here means the same thing it would mean there. Round 3 of TASK-005 is the
 * reason that sentence is written down: a substitute that behaves differently
 * from production is how a production-only defect stays invisible.
 */

import { ConcurrencyError, ValidationError } from "../../domain/errors.js";
import type { SupervisorRepository } from "../../supervision/supervisorPorts.js";
import type { SupervisorState } from "../../supervision/supervisorTypes.js";
import { validateRoadmap } from "../../supervision/supervisorService.js";

export function createInMemorySupervisorRepository(): SupervisorRepository {
  let stored: SupervisorState | undefined;

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
