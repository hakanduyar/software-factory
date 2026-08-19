/**
 * Deterministic mock worker.
 *
 * No network, no API key, no vendor SDK: TASK-001 forbids real provider
 * integration, and the tests need a worker whose output never varies.
 *
 * It can be told to fail, to throw instead of returning, to lie (claim its
 * acceptance criteria are met when it failed), and to omit the per-criterion
 * evidence a real check would produce — so tests can prove the Factory does
 * not trust worker claims and does not treat unbacked evidence as proof.
 */

import type { AcceptanceCriterionId } from "../../domain/ids.js";
import type { EvidenceDraft } from "../../domain/evidence.js";
import { FACTORY_ROLES, type FactoryRole } from "../../domain/role.js";
import type { Worker, WorkerOutcome, WorkerRequest } from "../../ports/worker.js";

export interface MockWorkerOptions {
  readonly id?: string;
  readonly roles?: readonly FactoryRole[];
  readonly outcomeStatus?: "SUCCEEDED" | "FAILED";
  /** Defaults to true when SUCCEEDED. Set explicitly to simulate an over-claiming worker. */
  readonly claimsAcceptanceMet?: boolean;
  readonly extraEvidence?: readonly EvidenceDraft[];
  /** Criteria to silently skip evidence for, simulating an incomplete/dishonest check. */
  readonly omitEvidenceForCriteria?: readonly AcceptanceCriterionId[];
  /** When set, execute() throws this (or a generic Error) instead of returning. */
  readonly throws?: unknown;
}

export function createMockWorker(options: MockWorkerOptions = {}): Worker {
  const id = options.id ?? "mock-worker";
  const outcomeStatus = options.outcomeStatus ?? "SUCCEEDED";
  const claimsAcceptanceMet = options.claimsAcceptanceMet ?? outcomeStatus === "SUCCEEDED";
  const omitted = new Set(options.omitEvidenceForCriteria ?? []);

  return {
    id,
    capabilities: {
      roles: options.roles ?? FACTORY_ROLES,
      deterministic: true,
    },
    async execute(request: WorkerRequest): Promise<WorkerOutcome> {
      if (options.throws !== undefined) {
        throw options.throws;
      }

      const evidence: EvidenceDraft[] = [
        {
          kind: "NOTE",
          summary: `${id} performed role ${request.role} on ${request.workItemId}`,
          reference: `mock://run/${request.runId}`,
        },
        ...request.acceptanceCriteria
          .filter((criterion) => !omitted.has(criterion.id))
          .map(
            (criterion): EvidenceDraft => ({
              kind: "TEST_OUTPUT",
              summary: `Simulated check for: ${criterion.text}`,
              reference: `mock://check/${criterion.id}`,
              criterionId: criterion.id,
            }),
          ),
        ...(options.extraEvidence ?? []),
      ];

      return {
        status: outcomeStatus,
        summary: `[${id}] ${outcomeStatus} while acting as ${request.role} on "${request.title}"`,
        evidence,
        claimsAcceptanceMet,
      };
    },
  };
}
