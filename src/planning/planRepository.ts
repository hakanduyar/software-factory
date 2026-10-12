/**
 * Persistence port for durable plan state (TASK-005). Mirrors
 * `LoopRepository`'s optimistic-concurrency shape (`create` +
 * `compareAndSave`) deliberately — same proven discipline, new table.
 */

import type { ProjectId } from "../domain/ids.js";
import type { Plan } from "./planTypes.js";

export interface PlanRepository {
  /**
   * Fails with ConcurrencyError if a plan with this id exists, or if an active
   * plan already exists for the same `requestKey` — the latter enforced by a
   * database constraint, not a check-then-insert.
   */
  create(plan: Plan): Promise<Plan>;
  /** Fails with ConcurrencyError if the stored version !== expectedVersion. */
  compareAndSave(plan: Plan, expectedVersion: number): Promise<Plan>;
  findById(id: string): Promise<Plan | undefined>;
  findActiveByRequestKey(requestKey: string): Promise<Plan | undefined>;
  listByProject(projectId: ProjectId): Promise<readonly Plan[]>;
  /**
   * Optional atomic "create or adopt" keyed by a (botId, updateId) request
   * binding. The binding and digest are deduplication context only — never
   * approval or authority. Atomically either returns the Plan already linked
   * to this binding (ConcurrencyError if the stored digest differs), adopts the
   * existing active Plan for `candidate.requestKey`, or inserts `candidate`
   * (a genuine initial DRAFT, version 1); in the latter two cases the link is
   * recorded in the same transaction. Only supported by repositories on the
   * explicitly upgraded link schema; others refuse.
   */
  createOrAdoptLinkedRequest?(
    candidate: Plan,
    binding: { botId: number; updateId: number; requestDigest: string },
  ): Promise<Plan>;
}
