/**
 * Deterministic failure classification (TASK-006 §5).
 *
 * Turns evidence about a worker invocation or a zero-token probe into a
 * `ResourceState`. It is pure, synchronous and unit-tested, and it NEVER
 * invokes a model: using an LLM to classify a deterministic provider error is
 * exactly the "AI waiting for AI" the task exists to eliminate.
 *
 * THE HONESTY RULE. Evidence is consulted in strict priority:
 *
 *   1. process facts (termination reason, exit code) — fully under our control
 *      via the accepted TASK-003 ProcessRunner;
 *   2. structured zero-token probe output, parsed STRUCTURALLY (a JSON field),
 *      never by message text;
 *   3. the signature table below;
 *   4. unmatched -> UNKNOWN_FAILURE.
 *
 * Every signature records how it is known. `MEASURED` means it was observed on
 * a real machine and captured as a permanent fixture. `PROVISIONAL` means it is
 * plausible but was NOT observed — and a provisional signature DOES NOT
 * CLASSIFY. It is inert unless a future maintainer promotes it after seeing the
 * real thing.
 *
 * Why ship provisional entries at all, disabled? Because the alternative is a
 * future maintainer inventing them from scratch under time pressure. Listing
 * them, clearly marked and inert, records what we suspect without pretending we
 * verified it.
 *
 * Consequence, stated plainly: a real provider rate limit currently classifies
 * as `UNKNOWN_FAILURE`, because no rate-limit response was ever observed here
 * (observing one costs real quota). That is SAFE — an unclassified failure gets
 * bounded backoff, which is the correct treatment for a suspected transient
 * limit. When a genuine response is captured, its fixture is added and the
 * behaviour sharpens from "back off" to "wait until the stated reset".
 */

import { redactSecrets } from "../adapters/workers/environmentPolicy.js";
import type { ProcessResult } from "../ports/processRunner.js";
import type { BillingMode } from "./financialSafety.js";
import { MAX_DIAGNOSTIC_LENGTH, type ResourceState } from "./resourceTypes.js";

/** How a signature is known. Only MEASURED signatures classify. */
export type SignatureEvidence = "MEASURED" | "PROVISIONAL";

export interface FailureSignature {
  readonly id: string;
  readonly pattern: RegExp;
  readonly state: ResourceState;
  readonly evidence: SignatureEvidence;
  /** Where the pattern came from. Required for MEASURED entries. */
  readonly source: string;
}

/**
 * The signature table.
 *
 * MEASURED entries below were confirmed against the CLIs installed on this
 * machine (Claude Code 2.1.238, codex-cli 0.149.0). PROVISIONAL entries were
 * NOT observed and are inert.
 */
export const FAILURE_SIGNATURES: readonly FailureSignature[] = [
  /**
   * HONESTY CORRECTION (review honesty audit). These two were labelled
   * MEASURED, but only the SIGNED-IN outputs were ever observed on this
   * machine; nobody logged out to see the negative forms. Inferring the exact
   * text of a failure from the text of a success is precisely the kind of
   * plausible-but-unobserved claim the evidence levels exist to prevent, so
   * they are PROVISIONAL and inert.
   *
   * Nothing is lost by this: auth is detected by the STRUCTURAL interpreters
   * below (`interpretClaudeAuthStatus` reads the measured `loggedIn` field;
   * `interpretCodexDoctorJson` reads the measured `auth.credentials.status`),
   * which are genuinely measured and do not depend on message wording.
   */
  {
    id: "claude-auth-logged-out",
    pattern: /"loggedIn"\s*:\s*false/,
    state: "AUTH_REQUIRED",
    evidence: "PROVISIONAL",
    source: "not observed; only the signed-in output was seen. Auth is detected structurally instead",
  },
  {
    id: "codex-not-logged-in",
    pattern: /\bnot logged in\b/i,
    state: "AUTH_REQUIRED",
    evidence: "PROVISIONAL",
    source: "not observed; inferred from the measured 'Logged in using ChatGPT' success text",
  },

  // --- PROVISIONAL: NOT OBSERVED. Inert until a real response is captured.
  {
    id: "generic-rate-limit",
    pattern: /\brate.?limit(ed)?\b/i,
    state: "RATE_LIMITED",
    evidence: "PROVISIONAL",
    source: "not observed; requires a real throttled response to promote",
  },
  {
    id: "generic-usage-limit",
    pattern: /\busage limit\b|\bquota exceeded\b|\bout of credits?\b/i,
    state: "USAGE_LIMIT_REACHED",
    evidence: "PROVISIONAL",
    source: "not observed; requires a real exhausted-plan response to promote",
  },
  {
    id: "generic-model-unavailable",
    pattern: /\bmodel not found\b|\bunknown model\b|\bmodel unavailable\b/i,
    state: "MODEL_UNAVAILABLE",
    evidence: "PROVISIONAL",
    source: "not observed; requires a real unknown-model response to promote",
  },
];

export interface ClassificationInput {
  /** OS-level truth about the invocation, from the accepted ProcessRunner. */
  readonly process: Pick<ProcessResult, "terminationReason" | "exitCode" | "stdout" | "stderr">;
  /**
   * Allows a future maintainer to switch on provisional signatures once they
   * have been confirmed. Defaults to MEASURED-only, which is the safe setting.
   */
  readonly trustProvisionalSignatures?: boolean;
}

export interface Classification {
  readonly state: ResourceState;
  /** Why, in bounded, redaction-safe text. Recorded as the resource diagnostic. */
  readonly reason: string;
  /**
   * How the provider says this resource is paid for, OBSERVED from the probe.
   *
   * Review finding NEW-FIN-1: `billingMode` was configuration, so declaring a
   * pay-as-you-go resource "included" made it free. Configuration is a claim;
   * this is evidence. Both CLIs expose enough to tell the difference —
   * `claude auth status` reports `subscriptionType`, and `codex doctor --json`
   * reports whether a metered API key is stored — so the Factory can observe it
   * rather than be told. Absent evidence stays `UNKNOWN`, which is financial.
   */
  readonly billingMode?: BillingMode;
  /** The signature id that matched, when one did. Audit only. */
  readonly signatureId?: string;
  /**
   * A reset time the provider stated, when it stated one. TASK-006 never
   * invents this: absent means "no reset time was given", which is what makes
   * the backoff ladder apply instead.
   */
  readonly retryAt?: number;
}

/**
 * Redacts, flattens and bounds any text before it can be logged or persisted.
 *
 * REVIEW FINDING N-3 (HIGH): this bounded but did not REDACT, so a token
 * appearing in an executor's action description or a provider's error text was
 * written verbatim into durable state and the log. Diagnostics originate
 * outside this module — from a provider, from a worker, from model output — and
 * anything crossing that boundary gets the same treatment the accepted TASK-003
 * worker layer already applies to raw process output (C6).
 *
 * `redactSecrets` is reused rather than reimplemented so there is one
 * definition of what a secret looks like.
 */
export function boundedDiagnostic(text: string): string {
  const flattened = redactSecrets(text).replace(/\s+/g, " ").trim();
  return flattened.length > MAX_DIAGNOSTIC_LENGTH ? `${flattened.slice(0, MAX_DIAGNOSTIC_LENGTH)}…` : flattened;
}

/**
 * Classify one invocation.
 *
 * A SUCCESSFUL process is `AVAILABLE`: the resource demonstrably worked. Every
 * other path is a failure, and an unclassifiable failure is `UNKNOWN_FAILURE`,
 * never an optimistic `AVAILABLE`.
 */
export function classifyResourceOutcome(input: ClassificationInput): Classification {
  const { terminationReason, exitCode, stdout, stderr } = input.process;

  // 1. PROCESS FACTS. Deterministic and entirely ours.
  if (terminationReason === "SPAWN_ERROR") {
    return {
      state: "PROVIDER_UNAVAILABLE",
      reason: "the provider CLI could not be spawned",
    };
  }
  if (terminationReason === "TIMEOUT") {
    return {
      state: "PROVIDER_UNAVAILABLE",
      reason: "the provider CLI exceeded its wall-clock budget and was terminated",
    };
  }
  if (terminationReason === "CANCELLED") {
    // Our own doing, not the provider's fault: says nothing about availability.
    return { state: "UNKNOWN_FAILURE", reason: "the invocation was cancelled by the Factory" };
  }
  if (terminationReason === "EXITED" && exitCode === 0) {
    return { state: "AVAILABLE", reason: "the provider CLI completed successfully" };
  }

  // 2/3. SIGNATURES over the combined output. Only MEASURED entries classify
  //      unless a maintainer has explicitly opted into provisional ones.
  const haystack = `${stdout}\n${stderr}`;
  const trustProvisional = input.trustProvisionalSignatures === true;
  for (const signature of FAILURE_SIGNATURES) {
    if (signature.evidence === "PROVISIONAL" && !trustProvisional) {
      continue;
    }
    if (signature.pattern.test(haystack)) {
      return {
        state: signature.state,
        reason: `matched signature "${signature.id}" (${signature.evidence})`,
        signatureId: signature.id,
      };
    }
  }

  // 4. FAIL CLOSED. We do not guess, and we never assume availability.
  return {
    state: "UNKNOWN_FAILURE",
    reason: `provider CLI exited ${String(exitCode)} with no recognised failure signature`,
  };
}

// =====================================================================
// Zero-token probe interpretation
// =====================================================================

/**
 * `codex doctor --json` emits `{schemaVersion, overallStatus, checks:{...}}`
 * with an `auth.credentials` check. Parsed structurally — by field, not by
 * scraping prose — so a wording change cannot silently flip the verdict.
 */
export function interpretCodexDoctorJson(raw: string): Classification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "UNKNOWN_FAILURE", reason: "codex doctor did not emit parseable JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { state: "UNKNOWN_FAILURE", reason: "codex doctor JSON was not an object" };
  }
  const checks = (parsed as { checks?: unknown }).checks;
  if (typeof checks !== "object" || checks === null || Array.isArray(checks)) {
    return { state: "UNKNOWN_FAILURE", reason: "codex doctor JSON carried no checks object" };
  }
  const auth = (checks as Record<string, unknown>)["auth.credentials"];
  if (typeof auth !== "object" || auth === null || Array.isArray(auth)) {
    return { state: "UNKNOWN_FAILURE", reason: "codex doctor JSON carried no auth.credentials check" };
  }
  const status = (auth as { status?: unknown }).status;
  if (status === "ok") {
    return {
      state: "AVAILABLE",
      reason: "codex doctor reports auth is configured",
      billingMode: codexBillingModeFrom(auth as Record<string, unknown>),
    };
  }
  return {
    state: "AUTH_REQUIRED",
    reason: `codex doctor reports auth.credentials status ${JSON.stringify(status)}`,
  };
}

/**
 * Reads Codex's billing mode from the measured `auth.credentials.details`.
 *
 * `"stored auth mode": "chatgpt"` with `"stored API key": "false"` means usage
 * runs on the ChatGPT subscription. A stored API key means metered API billing,
 * which can add to a bill and is therefore `USAGE_BILLED`. Anything else is
 * `UNKNOWN`, and unknown is financial.
 */
function codexBillingModeFrom(auth: Record<string, unknown>): BillingMode {
  const details = own(auth, "details");
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    return "UNKNOWN";
  }
  const row = details as Record<string, unknown>;
  const mode = own(row, "stored auth mode");
  const apiKey = own(row, "stored API key");
  if (apiKey === "true") {
    return "USAGE_BILLED";
  }
  if (mode === "chatgpt" && apiKey === "false") {
    return "INCLUDED_SUBSCRIPTION";
  }
  return "UNKNOWN";
}

/**
 * Reads Claude's billing mode from the measured `auth status` fields.
 *
 * A first-party subscription (`subscriptionType` such as `max`/`pro`) is
 * included quota. An API-provider session is metered. Absent or unrecognised
 * evidence stays UNKNOWN.
 */
/**
 * Subscription values that mean "usage comes out of quota already paid for".
 *
 * REVIEW FINDING F5-FIN-2 (CRITICAL): the test was `subscription.length > 0`, so
 * `subscriptionType: "free"` — and `"trial"`, and `"unknown"` — classified as an
 * INCLUDED_SUBSCRIPTION. That is precisely the case the mandate calls out by
 * name: *"Free tier does NOT automatically mean FREE_REMOTE_ACTION."* A free
 * plan is not a paid plan, and a truncated or unrecognised value is not evidence
 * of anything.
 *
 * MEASURED: only `max`, on this installation. `pro`, `team` and `enterprise` are
 * named paid Anthropic plans and are included on that basis rather than on
 * observation here — stated plainly rather than implied, per the honesty rule
 * this file already applies to failure signatures. Everything else, `free` and
 * `trial` explicitly included, is UNKNOWN and therefore financial.
 */
const INCLUDED_CLAUDE_SUBSCRIPTIONS: ReadonlySet<string> = Object.freeze(
  new Set(["max", "pro", "team", "enterprise"]),
) as ReadonlySet<string>;

/**
 * Authentication methods known to draw on subscription quota (R8-FIN-1).
 *
 * The round-5 fix allowlisted the SUBSCRIPTION value and checked `apiProvider`,
 * but said nothing about HOW the session authenticates — so a payload with
 * `subscriptionType: "max"`, `apiProvider: "firstParty"` and no `authMethod` at
 * all classified as an included subscription, and an end-to-end tick launched a
 * worker on it. Three fields agreeing about the plan is not evidence about who
 * pays for the calls; the field that says that is `authMethod`, and its absence
 * is missing evidence rather than benign.
 *
 * MEASURED on this installation: `claude.ai`. Nothing else is recognised, and an
 * unrecognised or absent value is UNKNOWN, which the gate treats as financial.
 */
const INCLUDED_CLAUDE_AUTH_METHODS: ReadonlySet<string> = Object.freeze(
  new Set(["claude.ai", "claude.ai/subscription", "subscription", "oauth"]),
) as ReadonlySet<string>;

/**
 * Reads a field the object OWNS, never one it merely inherits.
 *
 * Review note (round 6): with a polluted `Object.prototype`, a minimal provider
 * payload inherited `subscriptionType: "max"` and `apiProvider: "firstParty"`
 * and classified as an included subscription. Nothing in this repository
 * pollutes the prototype, so this is hardening rather than a live exploit — but
 * "billing is decided by a field the payload does not actually contain" is the
 * exact shape of every finding this module has already had.
 */
function own(row: Record<string, unknown>, field: string): unknown {
  return Object.prototype.hasOwnProperty.call(row, field) ? row[field] : undefined;
}

function claudeBillingModeFrom(row: Record<string, unknown>): BillingMode {
  const subscription = own(row, "subscriptionType");
  const provider = own(row, "apiProvider");
  const authMethod = own(row, "authMethod");

  /**
   * REVIEW FINDING (round 4, financial assessment): `authMethod` was not read at
   * all, so the contradictory pair `{authMethod:"apiKey", apiProvider:"firstParty",
   * subscriptionType:"max"}` was reported as an included subscription. An API key
   * is metered no matter what the neighbouring fields claim, and two fields
   * disagreeing about who pays is exactly the case that must not resolve
   * optimistically.
   */
  if (typeof authMethod === "string" && /api[-_]?key/i.test(authMethod)) {
    return "USAGE_BILLED";
  }
  // R8-FIN-1: the METHOD must also be one known to draw on subscription quota.
  // Absent or unrecognised is missing evidence, and missing evidence is not a
  // subscription.
  if (
    typeof subscription === "string" &&
    INCLUDED_CLAUDE_SUBSCRIPTIONS.has(subscription.trim().toLowerCase()) &&
    provider === "firstParty" &&
    typeof authMethod === "string" &&
    INCLUDED_CLAUDE_AUTH_METHODS.has(authMethod.trim().toLowerCase())
  ) {
    return "INCLUDED_SUBSCRIPTION";
  }
  if (provider !== undefined && provider !== "firstParty") {
    return "USAGE_BILLED";
  }
  return "UNKNOWN";
}

/**
 * `claude auth status` emits JSON including `loggedIn`. Same discipline: read
 * the field, do not scrape the prose.
 */
export function interpretClaudeAuthStatus(raw: string): Classification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "UNKNOWN_FAILURE", reason: "claude auth status did not emit parseable JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { state: "UNKNOWN_FAILURE", reason: "claude auth status JSON was not an object" };
  }
  const loggedIn = (parsed as { loggedIn?: unknown }).loggedIn;
  if (loggedIn === true) {
    return {
      state: "AVAILABLE",
      reason: "claude auth status reports a logged-in session",
      billingMode: claudeBillingModeFrom(parsed as Record<string, unknown>),
    };
  }
  if (loggedIn === false) {
    return { state: "AUTH_REQUIRED", reason: "claude auth status reports no logged-in session" };
  }
  return { state: "UNKNOWN_FAILURE", reason: "claude auth status JSON carried no boolean loggedIn field" };
}
