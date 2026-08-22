/**
 * In-memory LoopRepository (TASK-004). Bootstrap/test/demo use only — mirrors
 * the optimistic-concurrency discipline of
 * src/adapters/memory/inMemoryStore.ts's `workItems` repository, without
 * needing that store's full staged-transaction machinery (loop writes are
 * always single-record and never need to commit atomically with a
 * FactoryStore write — see docs/tasks/TASK-004-autonomous-engineering-loop.md §5).
 */

import { ConcurrencyError } from "../../domain/errors.js";
import { deepFreeze } from "../../domain/freeze.js";
import type { WorkItemId } from "../../domain/ids.js";
import type { LoopRepository } from "../../orchestration/loopRepository.js";
import { isTerminalLoopPhase, type EngineeringLoop } from "../../orchestration/loopTypes.js";

export function createInMemoryLoopRepository(): LoopRepository {
  const rows = new Map<string, EngineeringLoop>();

  return {
    async create(loop: EngineeringLoop): Promise<EngineeringLoop> {
      // Both checks and the insert run synchronously (no await), so this is
      // atomic under JavaScript's single-threaded execution — the in-memory
      // equivalent of the SQLite adapter's PRIMARY KEY + partial unique
      // index enforcement (PART E: never check-then-insert across a yield).
      if (rows.has(loop.id)) {
        throw new ConcurrencyError(`EngineeringLoop ${loop.id} already exists`);
      }
      for (const existing of rows.values()) {
        if (existing.workItemId === loop.workItemId && !isTerminalLoopPhase(existing.phase)) {
          throw new ConcurrencyError(`an active EngineeringLoop already exists for work item ${loop.workItemId}`);
        }
      }
      const frozen = deepFreeze(loop);
      rows.set(frozen.id, frozen);
      return frozen;
    },
    async compareAndSave(loop: EngineeringLoop, expectedVersion: number): Promise<EngineeringLoop> {
      const current = rows.get(loop.id);
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== expectedVersion) {
        throw new ConcurrencyError(
          `EngineeringLoop ${loop.id} version conflict: expected current version ${expectedVersion}, found ${currentVersion}`,
        );
      }
      const frozen = deepFreeze(loop);
      rows.set(frozen.id, frozen);
      return frozen;
    },
    async findById(id: string): Promise<EngineeringLoop | undefined> {
      return rows.get(id);
    },
    async listByWorkItem(workItemId: WorkItemId): Promise<readonly EngineeringLoop[]> {
      return [...rows.values()].filter((loop) => loop.workItemId === workItemId);
    },
  };
}
