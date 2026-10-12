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

import { parseWorkerTicket } from "../supervision/workerContract.js";
import type { ParsedPlannerProposal } from "./plannerOutputContract.js";
import { candidateTicketFromTemplate, findUnknownTicketTemplateFields, type PlannedWorkItem, type WorkItemTicketTemplate } from "./planTypes.js";

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

// =====================================================================
// Per-work-item ticket templates (NC-RUNTIME-01 / NC-10 / NC-11)
// =====================================================================

/**
 * The three answers a plan can give to "may this item be dispatched?".
 *
 * The split is the fail-closed part. `INVALID` means the templates the plan
 * DOES carry are structurally wrong — malformed against the frozen contract,
 * duplicated, orphaned or contradicting the revision's criteria — and nothing
 * may run. `NON_EXECUTABLE` means authority was never recorded for some item
 * (a legacy plan, or an incomplete one): the plan stays readable and the
 * remedy is a replan, never a synthesized ticket. Only `EXECUTABLE` yields
 * templates, and only for items that actually have one.
 */
export type PlanTicketExecutability =
  | { readonly status: "EXECUTABLE"; readonly templatesByKey: ReadonlyMap<string, WorkItemTicketTemplate> }
  | { readonly status: "NON_EXECUTABLE"; readonly reason: string; readonly replanAction: string }
  | { readonly status: "INVALID"; readonly reason: string };

const REPLAN_ACTION =
  "replan this request so the approved execution configuration captures a structured ticket template " +
  "for every work item; ownership and budgets must be stated explicitly, never inferred from plan prose";

/**
 * Structural validation of ONE template, independent of any revision.
 *
 * Conformance is decided by the accepted `parseWorkerTicket` rather than
 * restated here: that parser already refuses unsupported wire versions,
 * placeholder objectives, empty ownership, overlapping owned/forbidden scope,
 * non-positive or non-finite budgets and unknown result fields, and a second
 * copy of those rules would be a second place for them to rot.
 *
 * One thing the accepted parser does NOT do: refuse an unrecognized nested
 * key (e.g. `scope.grantAll`). It builds each nested object by naming only
 * its known fields, so an unknown one is silently absent from the value it
 * returns rather than being a reason to fail. That is fine as a NARROWING
 * step, but it must never be the ONLY check — a template smuggling an
 * unrecognized grant must be refused outright, not quietly stripped of it.
 * So unknown nested keys are checked here FIRST, and on success the value
 * returned is the accepted parser's own narrowed output (never the caller's
 * original, unvalidated object), so nothing unvalidated can reach EXECUTABLE
 * or the approval digest.
 */
export function validateTicketTemplate(
  template: WorkItemTicketTemplate,
): { readonly ok: true; readonly value: WorkItemTicketTemplate } | { readonly ok: false; readonly reason: string } {
  if (typeof template.planItemKey !== "string" || template.planItemKey.trim().length === 0) {
    return { ok: false, reason: "ticket template does not name a plan-local work item key" };
  }
  const unexpected = findUnknownTicketTemplateFields(template as unknown as Record<string, unknown>);
  if (unexpected !== undefined) {
    return {
      ok: false,
      reason: `ticket template for "${template.planItemKey}" carries unrecognized field(s): ${unexpected}`,
    };
  }
  // The plan-local key stands in for the dispatch-time ticket id, which no
  // template is allowed to carry.
  const parsed = parseWorkerTicket(candidateTicketFromTemplate(template, template.planItemKey));
  if (!parsed.ok) {
    return {
      ok: false,
      reason: `ticket template for "${template.planItemKey}" does not satisfy the frozen WorkerTicket contract: ${parsed.errors.join("; ")}`,
    };
  }
  const ticket = parsed.value;
  return {
    ok: true,
    value: {
      planItemKey: template.planItemKey,
      schemaVersion: ticket.schemaVersion,
      objective: ticket.objective,
      acceptanceCriteria: ticket.acceptanceCriteria,
      scope: ticket.scope,
      model: ticket.model,
      budgets: ticket.budgets,
      policy: ticket.policy,
      resultSchema: ticket.resultSchema,
    },
  };
}

function criterionTexts(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).sort();
}

/**
 * Decides executability of `items` against the templates a plan captured.
 *
 * `templates === undefined` is the legacy shape: it is NOT an error, it is an
 * absence of authority.
 */
export function planTicketExecutability(
  items: readonly PlannedWorkItem[],
  templates: readonly WorkItemTicketTemplate[] | undefined,
): PlanTicketExecutability {
  if (templates === undefined) {
    return {
      status: "NON_EXECUTABLE",
      reason: "this plan records no per-work-item ticket templates (legacy plan)",
      replanAction: REPLAN_ACTION,
    };
  }

  const itemsByKey = new Map(items.map((item) => [item.key, item]));
  const byKey = new Map<string, WorkItemTicketTemplate>();

  for (const template of templates) {
    const shape = validateTicketTemplate(template);
    if (!shape.ok) {
      return { status: "INVALID", reason: shape.reason };
    }
    // EXECUTABLE must expose only the explicitly validated canonical template
    // — the accepted parser's own narrowed output — never the caller's
    // original, unvalidated object.
    const canonical = shape.value;
    if (byKey.has(canonical.planItemKey)) {
      return { status: "INVALID", reason: `plan item "${canonical.planItemKey}" has more than one ticket template` };
    }
    byKey.set(canonical.planItemKey, canonical);

    const item = itemsByKey.get(canonical.planItemKey);
    if (item === undefined) {
      return {
        status: "INVALID",
        reason: `ticket template names plan item "${canonical.planItemKey}", which is not part of this revision`,
      };
    }
    // MISMATCH: the criteria a worker is held to must be exactly the criteria
    // the human approved for that item — no extras the plan never stated, and
    // none quietly dropped. Each template criterion additionally carries its
    // own version (NC-11), so "the criteria changed" is always visible.
    const declared = criterionTexts(item.acceptanceCriteria.map((criterion) => criterion.text));
    const bound = criterionTexts(canonical.acceptanceCriteria.map((criterion) => criterion.description));
    if (declared.length !== bound.length || declared.some((text, index) => text !== bound[index])) {
      return {
        status: "INVALID",
        reason: `ticket template for "${canonical.planItemKey}" binds criteria [${bound.join(" | ")}], which do not match the approved acceptance criteria [${declared.join(" | ")}]`,
      };
    }
  }

  const uncovered = items.map((item) => item.key).filter((key) => !byKey.has(key)).sort();
  if (uncovered.length > 0) {
    return {
      status: "NON_EXECUTABLE",
      reason: `no ticket template is recorded for plan item(s): ${uncovered.join(", ")}`,
      replanAction: REPLAN_ACTION,
    };
  }

  return { status: "EXECUTABLE", templatesByKey: byKey };
}
