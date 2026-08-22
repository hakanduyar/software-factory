/**
 * Persistence port for autonomous-loop state (TASK-004). Mirrors
 * `WorkItemRepository`'s optimistic-concurrency shape (`create` +
 * `compareAndSave`) deliberately — same proven discipline, new table.
 */

import type { WorkItemId } from "../domain/ids.js";
import type { EngineeringLoop } from "./loopTypes.js";

export interface LoopRepository {
  /** Fails with ConcurrencyError if a loop with this id already exists. */
  create(loop: EngineeringLoop): Promise<EngineeringLoop>;
  /** Fails with ConcurrencyError if the stored version !== expectedVersion. */
  compareAndSave(loop: EngineeringLoop, expectedVersion: number): Promise<EngineeringLoop>;
  findById(id: string): Promise<EngineeringLoop | undefined>;
  listByWorkItem(workItemId: WorkItemId): Promise<readonly EngineeringLoop[]>;
}
