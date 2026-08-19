/**
 * Identifier helpers.
 *
 * Ids are opaque strings at the domain boundary. The domain never generates
 * them itself: generation is injected so that runs are reproducible in tests
 * and so a future persistent store can supply its own id strategy.
 */

export type Id = string;

export type ProjectId = Id;
export type WorkItemId = Id;
export type AcceptanceCriterionId = Id;
export type RunId = Id;
export type ReviewId = Id;
export type ApprovalId = Id;
export type EvidenceId = Id;

export interface IdGenerator {
  next(prefix: string): Id;
}

/**
 * Deterministic generator: per-prefix counters, no randomness, no clock.
 * Adequate for the in-memory bootstrap; a persistent adapter is expected to
 * replace it (see README known limitations).
 */
export function createSequentialIdGenerator(): IdGenerator {
  const counters = new Map<string, number>();
  return {
    next(prefix: string): Id {
      const current = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, current);
      return `${prefix}-${String(current).padStart(4, "0")}`;
    },
  };
}
