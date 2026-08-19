/**
 * Provider-neutral worker contract (C9).
 *
 * Nothing here names Claude, Codex, Gemini, OpenCode or Ollama. An adapter
 * wraps whatever tool it likes as long as it satisfies this interface.
 *
 * Deliberate omission: a WorkerOutcome carries no WorkItemStatus and no
 * approval. A worker can report what it did and claim its criteria are met,
 * but it has no vocabulary for moving a work item or opening a gate.
 */

import type { AcceptanceCriterion } from "../domain/acceptanceCriterion.js";
import type { EvidenceDraft } from "../domain/evidence.js";
import type { RunId, WorkItemId } from "../domain/ids.js";
import type { FactoryRole } from "../domain/role.js";

export interface WorkerRequest {
  readonly runId: RunId;
  readonly workItemId: WorkItemId;
  readonly role: FactoryRole;
  readonly title: string;
  readonly instructions: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
}

export interface WorkerOutcome {
  readonly status: "SUCCEEDED" | "FAILED";
  readonly summary: string;
  readonly evidence: readonly EvidenceDraft[];
  /**
   * The worker's own claim. Recorded as audit data (C8) and explicitly not
   * treated as proof of acceptance (C3) or as an approval (C1).
   */
  readonly claimsAcceptanceMet: boolean;
}

export interface WorkerCapabilities {
  readonly roles: readonly FactoryRole[];
  /** True when the same request always produces the same outcome. */
  readonly deterministic: boolean;
}

export interface Worker {
  readonly id: string;
  readonly capabilities: WorkerCapabilities;
  execute(request: WorkerRequest): Promise<WorkerOutcome>;
}

export function supportsRole(worker: Worker, role: FactoryRole): boolean {
  return worker.capabilities.roles.includes(role);
}
