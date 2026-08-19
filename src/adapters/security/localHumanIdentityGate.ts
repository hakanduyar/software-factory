/**
 * Local, no-external-infrastructure implementation of HumanIdentityGate.
 *
 * Trust model: whoever configures this adapter supplies a credential (e.g.
 * from an environment variable read once at process start — see
 * src/cli/main.ts). `authorize` mints a token only if the caller presents
 * that exact credential; the credential itself is compared with a
 * timing-safe check and is never embedded in the returned token. Tokens are
 * signed with a per-process random key that is generated here and never
 * exposed through this module's public surface, so a party that obtains a
 * token cannot mint further tokens from it, and a party without the
 * credential (e.g. a Worker adapter, which is never given the credential or
 * a reference to this gate — see src/ports/worker.ts) cannot mint one at
 * all.
 *
 * This is intentionally not a substitute for real authentication (OAuth,
 * OS user session, hardware key). It is the smallest mechanism that makes
 * "an AI-controlled caller can construct `{ kind: HUMAN }` and be believed"
 * false, per TASK-001's constraint not to add external auth infrastructure
 * yet.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { HumanIdentityError } from "../../domain/errors.js";
import type { TrustedHumanToken } from "../../domain/humanIdentity.js";
import type { Timestamp } from "../../domain/time.js";
import type { Clock } from "../../ports/clock.js";
import type { HumanIdentityGate } from "../../ports/humanIdentityGate.js";

const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000;
const MIN_CREDENTIAL_LENGTH = 8;

export interface LocalHumanIdentityGateOptions {
  /** The shared secret. Must come from an env var or local secret store — never hardcoded (C6). */
  readonly credential: string;
  readonly clock: Clock;
  readonly tokenTtlMs?: number;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // Compare fixed-size digests so buffer length itself leaks nothing timing-wise.
  const paddedA = createHmac("sha256", "length-guard").update(bufA).digest();
  const paddedB = createHmac("sha256", "length-guard").update(bufB).digest();
  return bufA.length === bufB.length && timingSafeEqual(paddedA, paddedB) && timingSafeEqual(bufA, bufB);
}

export function createLocalHumanIdentityGate(options: LocalHumanIdentityGateOptions): HumanIdentityGate {
  if (options.credential.trim().length < MIN_CREDENTIAL_LENGTH) {
    throw new HumanIdentityError(
      `local human identity gate requires a credential of at least ${MIN_CREDENTIAL_LENGTH} characters`,
    );
  }

  const signingKey = randomBytes(32);
  const ttlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;

  function sign(actorId: string, issuedAt: Timestamp, nonce: string): string {
    return createHmac("sha256", signingKey).update(`${actorId}|${issuedAt}|${nonce}`).digest("hex");
  }

  return {
    authorize(actor, credential): TrustedHumanToken {
      if (actor.kind !== "HUMAN") {
        throw new HumanIdentityError(`only a HUMAN actor may request authorization, got ${actor.kind}`);
      }
      if (!constantTimeEquals(credential, options.credential)) {
        throw new HumanIdentityError("credential did not match the configured local human identity secret");
      }
      const issuedAt = options.clock.now();
      const nonce = randomBytes(16).toString("hex");
      return { actorId: actor.id, issuedAt, nonce, signature: sign(actor.id, issuedAt, nonce) };
    },

    verify(token, actor): boolean {
      if (token.actorId !== actor.id) {
        return false;
      }
      const expected = sign(token.actorId, token.issuedAt, token.nonce);
      if (expected.length !== token.signature.length) {
        return false;
      }
      if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(token.signature, "hex"))) {
        return false;
      }
      const age = options.clock.now() - token.issuedAt;
      return age >= 0 && age <= ttlMs;
    },
  };
}
