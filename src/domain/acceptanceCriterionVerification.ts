/**
 * A record that one AcceptanceCriterion was actually checked against one
 * specific implementation run, as opposed to merely described.
 *
 * FactoryService is the only writer (see verifyAcceptanceCriteria) and it
 * only ever writes one from a successful VERIFIER Run's own recorded
 * Evidence — never from a worker's bare claim.
 *
 * `implementationRunId` is what makes this survive review scrutiny: a
 * verification attests one exact implementation. Running a new implementer
 * produces a new run id, so every previous verification stops matching the
 * current implementation and no longer counts.
 */

import type {
  AcceptanceCriterionId,
  EvidenceId,
  RunId,
  WorkItemId,
} from "./ids.js";
import type { Timestamp } from "./time.js";

export const VERIFICATION_RESULTS = ["PASSED", "FAILED"] as const;

export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

export interface AcceptanceCriterionVerification {
  readonly id: string;
  readonly criterionId: AcceptanceCriterionId;
  readonly workItemId: WorkItemId;
  readonly specRevision: number;
  /** The implementation run this verification attests. */
  readonly implementationRunId: RunId;
  readonly result: VerificationResult;
  /** Registry-issued principal of the verifier — provenance, not a string. */
  readonly verifierPrincipalId: string;
  readonly verifierRunId: RunId;
  /** The specific Evidence record backing a PASSED result, if any. */
  readonly evidenceId?: EvidenceId;
  readonly verifiedAt: Timestamp;
}
