/**
 * Port for the trusted-human boundary. See src/domain/humanIdentity.ts for
 * why this exists and what it does and does not protect against at bootstrap
 * scale.
 *
 * `authorize` is the only way to obtain a TrustedHumanToken and requires a
 * credential; `verify` is what FactoryService.recordApproval calls before
 * accepting a decision. Implementations must reject a token whose actorId
 * does not match, whose signature does not match, or that has expired.
 */

import type { Actor } from "../domain/actor.js";
import type { TrustedHumanToken } from "../domain/humanIdentity.js";

export interface HumanIdentityGate {
  /** Throws HumanIdentityError if actor is not HUMAN or credential is wrong. */
  authorize(actor: Actor, credential: string): TrustedHumanToken;

  /** Non-throwing: false for any forged, mismatched, or expired token. */
  verify(token: TrustedHumanToken, actor: Actor): boolean;
}
