/**
 * WorkItem lifecycle statuses (docs/DOMAIN_MODEL.md).
 *
 * Declared as a const tuple rather than a TS enum so the domain stays plain,
 * erasable TypeScript with no runtime enum object to leak into adapters.
 */

export const WORK_ITEM_STATUSES = [
  "IDEA",
  "ANALYSIS",
  "PLAN_REVIEW",
  "READY",
  "IMPLEMENTING",
  "VERIFYING",
  "REVIEW",
  "WAITING_FOR_HUMAN",
  "DONE",
  "BLOCKED",
  "CANCELLED",
] as const;

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export const TERMINAL_STATUSES: readonly WorkItemStatus[] = ["DONE", "CANCELLED"];

export function isTerminal(status: WorkItemStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isWorkItemStatus(value: string): value is WorkItemStatus {
  return (WORK_ITEM_STATUSES as readonly string[]).includes(value);
}
