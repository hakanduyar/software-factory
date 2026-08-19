import type { EvidenceId, RunId, WorkItemId } from "./ids.js";
import type { FactoryRole } from "./role.js";
import type { Timestamp } from "./time.js";

export const RUN_STATUSES = ["RUNNING", "SUCCEEDED", "FAILED"] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["SUCCEEDED", "FAILED"];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * One attempt by one worker to perform one role on one work item.
 *
 * Lifecycle: a Run is created RUNNING and completes exactly once to
 * SUCCEEDED or FAILED. Terminal is terminal — the repository refuses to
 * rewrite it (RunRepository has no general `save`), which is what stops a
 * FAILED implementation run from being replaced by a SUCCEEDED one under the
 * same id.
 *
 * `workerPrincipalId` is registry-issued (src/ports/workerRegistry.ts), not
 * the worker's self-reported id: it is the only identity the Factory trusts
 * for reviewer-independence decisions (C4).
 *
 * `targetRunId` binds a VERIFIER/REVIEWER run to the exact implementation
 * run it examined, so a later implementation run does not silently inherit
 * an older run's verification or review.
 */
export interface Run {
  readonly id: RunId;
  readonly workItemId: WorkItemId;
  /** The work item's spec revision when this run started. */
  readonly specRevision: number;
  readonly role: FactoryRole;
  readonly workerPrincipalId: string;
  /** The worker's self-reported id — audit data only, never an authority. */
  readonly declaredWorkerId: string;
  readonly status: RunStatus;
  readonly summary?: string;
  /** For VERIFIER/REVIEWER runs: the implementation run under examination. */
  readonly targetRunId?: RunId;
  /** What the worker asserted. Recorded for audit; never trusted as proof (C3). */
  readonly claimsAcceptanceMet: boolean;
  readonly evidenceIds: readonly EvidenceId[];
  readonly startedAt: Timestamp;
  readonly finishedAt?: Timestamp;
}
