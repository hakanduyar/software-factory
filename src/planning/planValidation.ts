/**
 * Deterministic plan validation (TASK-005 §8).
 *
 * A revision must pass every check here before a human is ever shown it. That
 * ordering is the point: the Factory must never ask a human to approve
 * malformed content, because an approval is authority and authority granted
 * over nonsense is still authority.
 *
 * Everything in this module is pure and total — no I/O, no clock, no
 * randomness — so the same revision always validates the same way, on any
 * machine, before and after a restart.
 *
 * The topological order this produces is not a by-product: it IS the
 * materialization and dispatch order, so validating the graph and deciding
 * execution sequence can never disagree.
 */

import type { ParsedPlannerProposal } from "./plannerOutputContract.js";
import type { PlannedWorkItem } from "./planTypes.js";

export type PlanValidation =
  | { readonly ok: true; readonly order: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Kahn's algorithm. Returns a deterministic topological order (ties broken by
 * key, so the order is stable across runs) or reports the cycle it found.
 */
export function topologicalOrder(items: readonly PlannedWorkItem[]): PlanValidation {
  const byKey = new Map(items.map((item) => [item.key, item]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const item of items) {
    indegree.set(item.key, item.dependsOn.length);
    for (const dependency of item.dependsOn) {
      const list = dependents.get(dependency) ?? [];
      list.push(item.key);
      dependents.set(dependency, list);
    }
  }

  // Sorted queue => deterministic output for any input ordering.
  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([key]) => key).sort();
  const order: string[] = [];

  while (ready.length > 0) {
    const key = ready.shift()!;
    order.push(key);
    const next = (dependents.get(key) ?? []).slice().sort();
    for (const dependent of next) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  if (order.length !== items.length) {
    const stuck = items
      .map((item) => item.key)
      .filter((key) => !order.includes(key))
      .sort();
    return {
      ok: false,
      reason: `dependency graph contains a cycle involving: ${stuck.join(", ")}`,
    };
  }

  void byKey;
  return { ok: true, order };
}

/**
 * Full validation of a parsed proposal that is intended to become an approvable
 * revision. Callers must NOT run this on a clarification-only response — that
 * response legitimately has no items, and turning "the planner asked a
 * question" into "the plan is invalid" would be wrong.
 */
export function validateProposal(proposal: ParsedPlannerProposal): PlanValidation {
  if (proposal.summary.trim().length === 0) {
    return { ok: false, reason: "plan summary is empty" };
  }
  if (proposal.items.length === 0) {
    return { ok: false, reason: "an approvable plan must contain at least one work item" };
  }

  const seen = new Set<string>();
  for (const item of proposal.items) {
    if (seen.has(item.key)) {
      return { ok: false, reason: `duplicate work item key "${item.key}"` };
    }
    seen.add(item.key);
  }

  for (const item of proposal.items) {
    if (item.spec.trim().length === 0) {
      return { ok: false, reason: `work item "${item.key}" has an empty spec` };
    }
    if (item.acceptanceCriteria.length === 0) {
      return {
        ok: false,
        reason: `work item "${item.key}" has no acceptance criteria; nothing to verify means it can never be honestly DONE (C2/C3)`,
      };
    }
    for (const criterion of item.acceptanceCriteria) {
      if (criterion.text.trim().length === 0 || criterion.verificationHint.trim().length === 0) {
        return { ok: false, reason: `work item "${item.key}" has an acceptance criterion with empty text or verification hint` };
      }
    }

    const declared = new Set<string>();
    for (const dependency of item.dependsOn) {
      if (dependency === item.key) {
        return { ok: false, reason: `work item "${item.key}" depends on itself` };
      }
      if (declared.has(dependency)) {
        return { ok: false, reason: `work item "${item.key}" declares duplicate dependency "${dependency}"` };
      }
      declared.add(dependency);
      if (!seen.has(dependency)) {
        return { ok: false, reason: `work item "${item.key}" depends on "${dependency}", which is not part of this plan` };
      }
    }
  }

  return topologicalOrder(proposal.items);
}
