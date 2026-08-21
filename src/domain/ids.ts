/**
 * Identifier helpers.
 *
 * Ids are opaque strings at the domain boundary. The domain never generates
 * them itself: generation is injected so that runs are reproducible in tests
 * and so a future persistent store can supply its own id strategy.
 */

import { randomBytes } from "node:crypto";

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

/**
 * Collision-free generator for multi-process use against a shared durable
 * store (TASK-004 remediation round 1). The sequential generator above
 * restarts at 1 in every OS process, so two `sf loop` CLI invocations
 * against the same database would mint the same ids and collide on
 * append-only primary keys. Random ids have no cross-process coordination
 * requirement. Tests keep using the sequential generator for reproducible
 * transcripts; production CLI wiring uses this one.
 */
export function createRandomIdGenerator(): IdGenerator {
  return {
    next(prefix: string): Id {
      // Lazy import avoided deliberately: node:crypto is a built-in and this
      // module already runs only on Node (no browser target exists).
      return `${prefix}-${randomBytes(8).toString("hex")}`;
    },
  };
}
