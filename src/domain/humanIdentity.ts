/**
 * The trusted-authorization boundary (remediation of CRITICAL finding:
 * "approval authority is caller-asserted data").
 *
 * `Actor` (see actor.ts) is an untrusted claim: any caller can construct
 * `{ kind: "HUMAN", id: "x", displayName: "y" }`. A `TrustedHumanToken` is
 * different — it is data that can only be produced by a HumanIdentityGate
 * (src/ports/humanIdentityGate.ts) after a credential check, and it is
 * cryptographically bound to one actor id and one issuance time.
 *
 * TASK-001 deliberately does not add external auth infrastructure (OAuth,
 * SSO, a user database). The bootstrap boundary is a locally-configured
 * shared secret (see src/adapters/security/localHumanIdentityGate.ts): only
 * whoever knows that secret can mint a token, and workers are never given
 * the secret or a reference to the gate (see src/ports/worker.ts — a
 * WorkerRequest carries no credential and no gate). A worker forging a HUMAN
 * Actor object therefore still cannot produce a token that verifies.
 */

import type { Timestamp } from "./time.js";

export interface TrustedHumanToken {
  readonly actorId: string;
  readonly issuedAt: Timestamp;
  readonly nonce: string;
  readonly signature: string;
}
