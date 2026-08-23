/**
 * Durable resource state (TASK-006 §4).
 *
 * A "resource" is one (provider, model) pair the Factory can send work to. Its
 * state is the Factory's deterministic memory of whether that pair is usable
 * right now — memory that must survive process death, because the whole point
 * of TASK-006 is that no AI session is alive between ticks to remember it.
 *
 * `WAITING_FOR_RESOURCE` is deliberately NOT a resource state. A resource is
 * exhausted; a TASK waits. Conflating the two is what makes a quota limit look
 * like a failure, and a shortage is not `FAILED` and not `RECOVERY_REQUIRED`.
 */

import { ValidationError } from "../domain/errors.js";
import type { Timestamp } from "../domain/time.js";
import type { BillingMode } from "./financialSafety.js";

export const RESOURCE_STATES = [
  /** Last deterministic evidence says this is usable. */
  "AVAILABLE",
  /** Claimed by an in-flight action right now. */
  "BUSY",
  /** Short-term provider throttle. Usually carries a retryAt. */
  "RATE_LIMITED",
  /** Plan/quota exhausted for a period. Never a reason to buy more (§3). */
  "USAGE_LIMIT_REACHED",
  /** Provider reachable, this model not usable. */
  "MODEL_UNAVAILABLE",
  /** Provider or network unreachable. */
  "PROVIDER_UNAVAILABLE",
  /** Credentials missing or expired. Human-only to fix. */
  "AUTH_REQUIRED",
  /** Failed, and the cause could not be deterministically classified. Fails closed. */
  "UNKNOWN_FAILURE",
] as const;

export type ResourceState = (typeof RESOURCE_STATES)[number];

/** States in which the resource may be handed new work. */
export const USABLE_RESOURCE_STATES: readonly ResourceState[] = ["AVAILABLE"];

/** States a deterministic retry can plausibly clear without a human. */
export const RETRYABLE_RESOURCE_STATES: readonly ResourceState[] = [
  "RATE_LIMITED",
  "USAGE_LIMIT_REACHED",
  "PROVIDER_UNAVAILABLE",
  "MODEL_UNAVAILABLE",
  "UNKNOWN_FAILURE",
];

/** States only a human can clear. Never retried on a timer. */
export const HUMAN_ONLY_RESOURCE_STATES: readonly ResourceState[] = ["AUTH_REQUIRED"];

/**
 * Canonical resource identity: a pure function of its coordinates, never a
 * random or model-supplied string (the TASK-004 round-2 lesson).
 *
 * Review note (round 7): with a `:` separator and unconstrained components, the
 * pairs `("provider:model", "x")` and `("provider", "model:x")` collide. That is
 * unreachable through the supported catalog and the `SUPPORTED_MODELS`
 * allowlist — but this key decides reviewer independence (C4) and the resource
 * binding on a financial verdict (F6-FIN-1), and "these two are the same
 * resource" being wrong in either place is exactly the kind of thing a review
 * finds three rounds later. A component carrying the delimiter is refused
 * rather than silently encoded: nothing legitimate needs it, and an unambiguous
 * refusal beats a clever escape.
 */
export function resourceKey(provider: string, model: string): string {
  if (provider.includes(":") || model.includes(":")) {
    throw new ValidationError(
      `resource identity components may not contain ":" (provider=${JSON.stringify(provider)}, model=${JSON.stringify(model)})`,
    );
  }
  return `${provider}:${model}`;
}

/**
 * Bounded, deterministic backoff ladder for a failure with no known reset time.
 * No randomness: the schedule must be exactly reproducible in tests, and a
 * jittered ladder buys nothing for a single-tenant local supervisor.
 */
export const BACKOFF_LADDER_MS: readonly number[] = [
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
];

export interface BackoffState {
  /** How many consecutive failures have been recorded. 0 means "none". */
  readonly attempt: number;
  /** The delay that was applied for the current attempt, in ms. */
  readonly delayMs: number;
}

export const NO_BACKOFF: BackoffState = { attempt: 0, delayMs: 0 };

/**
 * The next rung, capped at the top of the ladder. Persisted, so a restart
 * continues the ladder rather than starting it again — otherwise a crash loop
 * would hammer a provider at the 5-minute rung forever.
 */
export function nextBackoff(current: BackoffState): BackoffState {
  const attempt = current.attempt + 1;
  const index = Math.min(attempt - 1, BACKOFF_LADDER_MS.length - 1);
  return { attempt, delayMs: BACKOFF_LADDER_MS[index]! };
}

/** Bound applied to any diagnostic before it is persisted. Audit data, never a transcript. */
export const MAX_DIAGNOSTIC_LENGTH = 300;

export interface ResourceRecord {
  readonly provider: string;
  readonly model: string;
  /** Derived: `resourceKey(provider, model)`. Recomputed on read, never trusted. */
  readonly key: string;
  readonly state: ResourceState;
  /** When the CURRENT state was first observed. */
  readonly detectedAt: Timestamp;
  /** When the resource was last examined, whether or not the state changed. */
  readonly lastCheckedAt: Timestamp;
  /**
   * When it is worth looking again. Absent means "no scheduled retry" — either
   * the resource is usable, or only a human can clear it.
   */
  readonly retryAt?: Timestamp;
  readonly backoff: BackoffState;
  readonly lastSuccessAt?: Timestamp;
  /**
   * How the PROVIDER says this resource is paid for, as observed by the last
   * probe (NEW-FIN-1). Absent means nothing has been observed, which the
   * financial gate treats as UNKNOWN and therefore financial.
   */
  readonly observedBillingMode?: BillingMode;
  /** Bounded, redacted. Never a credential, never a raw provider payload. */
  readonly diagnostic?: string;
}

/** Is this resource usable at `now`, given its persisted state? */
export function isUsable(record: ResourceRecord): boolean {
  return USABLE_RESOURCE_STATES.includes(record.state);
}

/**
 * How long a recorded `AVAILABLE` may be believed without fresh evidence.
 *
 * Review finding F-8 (HIGH): `AVAILABLE` was never re-probed, so a persisted
 * row saying so was trusted indefinitely — and anything able to write the row
 * could manufacture availability that no probe had ever confirmed. A
 * checkpoint is not authority; that is the lesson TASK-004 and TASK-005 each
 * had to learn, and it applies to resource state too.
 *
 * The probe is zero-token, so re-confirming costs nothing but a local process.
 */
export const MAX_AVAILABILITY_AGE_MS = 15 * 60_000;

/**
 * Is it time to look at this resource again?
 *
 * A resource with a known `retryAt` in the FUTURE is deliberately not probed:
 * that is the zero-token-waiting rule, and probing early tells us nothing we
 * did not already know. A stale or never-probed `AVAILABLE` is the opposite
 * case — there, not probing is trusting a row instead of a fact.
 */
export function isRetryDue(record: ResourceRecord, now: Timestamp): boolean {
  // N-4 (HIGH): a timestamp in the FUTURE is not evidence of freshness, it is
  // evidence of a bad clock or a forged row. The first fix rejected stale and
  // never-probed records but happily accepted `lastCheckedAt = now + 10^10`,
  // which parked a resource in "recently confirmed healthy" forever. Any
  // not-yet-happened observation is treated as no observation.
  if (record.lastCheckedAt > now) {
    return true;
  }

  if (record.state === "AVAILABLE") {
    // F-8: believed only while the evidence is fresh, and never on a row that
    // was never probed at all (`lastCheckedAt === 0`).
    return record.lastCheckedAt === 0 || now - record.lastCheckedAt >= MAX_AVAILABILITY_AGE_MS;
  }
  if (!RETRYABLE_RESOURCE_STATES.includes(record.state)) {
    return false;
  }
  if (record.retryAt === undefined) {
    return true;
  }
  // A retry further out than the ladder could ever schedule is likewise not
  // trustworthy — otherwise a forged `retryAt` could silence a resource
  // indefinitely without ever being re-examined.
  const longestPlausibleWait = BACKOFF_LADDER_MS[BACKOFF_LADDER_MS.length - 1]!;
  if (record.retryAt > record.lastCheckedAt + longestPlausibleWait) {
    return true;
  }
  return record.retryAt <= now;
}
