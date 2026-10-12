/**
 * Bounded interactive stdio observation adapter for the Codex app-server
 * (PHASE7-96). This is NOT a ProcessRunner-based adapter: ProcessRunner
 * closes stdin after writing one input and cannot perform the
 * response-dependent initialize -> initialized -> request sequence this
 * protocol requires, so this file is the one place direct `node:child_process`
 * use is confined to a read-only app-server transport. No other worker
 * execution path may use `node:child_process` directly.
 *
 * Allowed outgoing methods, in order, and nothing else:
 *   initialize -> (wait for response) -> initialized (notification)
 *   -> account/read(refreshToken:false)
 *   -> model/list(paginated, bounded pages)
 *   -> account/rateLimits/read
 *
 * This adapter returns an *observation*, never an authority or a grant:
 * entitlement/applicability is supplied independently by the caller and
 * verified against source-bound evidence here, never invented.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

// ---------------------------------------------------------------------------
// Public result shape
// ---------------------------------------------------------------------------

export const CODEX_QUOTA_OBSERVATION_OUTCOMES = [
  "OBSERVED",
  "UNKNOWN",
  "REFUSED",
] as const;

export type CodexQuotaObservationOutcomeKind = (typeof CODEX_QUOTA_OBSERVATION_OUTCOMES)[number];

/** Sanitized finite rate-limit window facts only; never raw backend payload. */
export interface SanitizedRateLimitWindow {
  readonly usedPercent: number;
  readonly windowDurationMins: number | null;
  readonly resetsAt: number | null;
}

export interface SanitizedRateLimitBucket {
  readonly limitId: string | null;
  readonly primary: SanitizedRateLimitWindow | null;
  readonly secondary: SanitizedRateLimitWindow | null;
  readonly spendControlReached: boolean | null;
  /** Legacy reached-type discriminator carried by some installed snapshots; sanitized passthrough only. */
  readonly rateLimitReachedType: string | null;
}

export interface SanitizedModelFact {
  readonly id: string;
  readonly model: string;
  readonly hidden: boolean;
}

/** Account identity is never returned raw: only a transient-hash match outcome. */
export type AccountBindingStatus = "MATCHED" | "UNKNOWN";

export interface CodexQuotaObservation {
  /** Wall-clock time this observation was collected, source-bound (not caller-supplied). */
  readonly observedAt: number;
  /** Hex digest of the executable actually spawned for this observation; provenance only, never trust on its own. */
  readonly executableDigestHex: string;
  readonly accountBinding: AccountBindingStatus;
  /**
   * Sanitized hex hash of the backend `accountId` actually matched against,
   * retained for later production provenance; the caller's expected hash
   * alone cannot prove which reply this observation came from. Never the
   * raw `accountId` or email.
   */
  readonly accountIdHashHex: string;
  readonly buckets: readonly SanitizedRateLimitBucket[];
  readonly models: readonly SanitizedModelFact[];
  /**
   * Caller-trusted applicability input is independently supplied and must
   * carry exact model/bucket/account binding plus freshness; this adapter
   * never invents a model-to-bucket mapping (the protocol has none). When
   * applicability is unsupported, `eligible` is always `"UNKNOWN"` even if
   * every window appears under 100%.
   */
  readonly eligible: "UNKNOWN";
}

export interface CodexQuotaObservationResult {
  readonly kind: CodexQuotaObservationOutcomeKind;
  readonly observation?: CodexQuotaObservation;
  /** Generic, non-sensitive refusal/unknown reason. Never raw stdout/stderr/server error text. */
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Request configuration
// ---------------------------------------------------------------------------

export interface ExpectedAccountBinding {
  /** Independently configured expected hash of the backend accountId, hex sha256. */
  readonly expectedAccountIdHashHex: string;
  readonly hash: (raw: string) => string;
}

export interface CodexQuotaObservationRequest {
  /** Absolute executable path; independently configured and checked before spawn. */
  readonly executable: string;
  /** Independently configured expected digest of the executable, hex. */
  readonly expectedExecutableDigestHex: string;
  readonly computeExecutableDigestHex: (executablePath: string) => Promise<string> | string;
  readonly argv: readonly string[];
  readonly cwd: string;
  /** Already policy-filtered environment (same filtered worker credential context); no auth-file reads here. */
  readonly env: Readonly<Record<string, string>>;
  readonly clientName: string;
  readonly clientVersion: string;
  readonly expectedAccountBinding: ExpectedAccountBinding;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxMessages: number;
  readonly maxModelPages: number;
  readonly modelPageLimit: number;
  /** Caller-owned cancellation; aborting closes the one owned child and refuses generically. */
  readonly signal?: AbortSignal;
  /**
   * Hook for a spawn-time factory in tests; production callers omit this and
   * get the real `node:child_process.spawn`.
   */
  readonly spawnChild?: (
    executable: string,
    argv: readonly string[],
    options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
  ) => ChildProcessWithoutNullStreams;
}

// ---------------------------------------------------------------------------
// JSON-RPC framing (newline-delimited JSON, as used by the installed app-server)
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcReplyShape {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

const ALLOWED_REQUEST_METHODS = [
  "initialize",
  "account/read",
  "model/list",
  "account/rateLimits/read",
] as const;

/** The only argv this adapter will ever hand to the executable: app-server, nothing else. */
const REQUIRED_ARGV: readonly string[] = ["app-server"];

/** Bounded wait for child termination confirmation at each escalation step (SIGTERM, then SIGKILL). */
const CLOSE_ESCALATION_WAIT_MS = 2000;

function refused(reason: string): CodexQuotaObservationResult {
  return { kind: "REFUSED", reason };
}

function unknown(reason: string): CodexQuotaObservationResult {
  return { kind: "UNKNOWN", reason };
}

function isFinitePositive(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isAbsolutePath(path: string): boolean {
  // Absolute on POSIX ("/...") or Windows ("C:\..." / "C:/..." / "\\server\share").
  return /^([a-zA-Z]:[\\/]|[\\/]{2}|\/)/.test(path);
}

function validateRequest(request: CodexQuotaObservationRequest): string | null {
  if (typeof request.executable !== "string" || !isAbsolutePath(request.executable)) {
    return "executable must be an absolute path";
  }
  if (request.argv.length !== REQUIRED_ARGV.length || !request.argv.every((arg, i) => arg === REQUIRED_ARGV[i])) {
    return "argv must be exactly the app-server invocation";
  }
  if (!isFinitePositive(request.timeoutMs)) {
    return "timeoutMs must be a finite positive number";
  }
  if (!isFinitePositive(request.maxOutputBytes)) {
    return "maxOutputBytes must be a finite positive number";
  }
  if (!isFinitePositive(request.maxMessages)) {
    return "maxMessages must be a finite positive number";
  }
  if (!isFinitePositive(request.maxModelPages)) {
    return "maxModelPages must be a finite positive number";
  }
  if (!isFinitePositive(request.modelPageLimit)) {
    return "modelPageLimit must be a finite positive number";
  }
  return null;
}

/**
 * Collects exactly one fresh observation per call — no polling, no retry
 * loop. Every exit path below closes the one child this function owns.
 */
export async function observeCodexQuota(
  request: CodexQuotaObservationRequest,
): Promise<CodexQuotaObservationResult> {
  const validationError = validateRequest(request);
  if (validationError !== null) {
    return refused(validationError);
  }

  let child: ChildProcessWithoutNullStreams | null = null;
  let session: RpcSession | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  let timedOutBeforeSession = false;
  // One deadline shared by digest/setup and transport: a slow or hung
  // digest/spawn step must not escape the bound just because no session
  // exists yet to receive it.
  const deadlineAt = Date.now() + request.timeoutMs;

  try {
    if (request.signal?.aborted) {
      return refused("observation was cancelled");
    }

    // A hung digest callback that never resolves must still return in
    // finite time: race it against the deadline rather than trusting it to
    // observe a flag, and dispose the timer either way so nothing fires late.
    // Cancellation during this pre-session window must settle the same race
    // promptly too, rather than waiting out the full deadline.
    let preSessionTimer: ReturnType<typeof setTimeout> | null = null;
    let timedOutOrCancelledBeforeSession = false;
    let preSessionAbort: (() => void) | null = null;
    const preSessionDeadline = new Promise<"TIMED_OUT" | "CANCELLED">((resolve) => {
      preSessionTimer = setTimeout(() => {
        timedOutBeforeSession = true;
        timedOutOrCancelledBeforeSession = true;
        resolve("TIMED_OUT");
      }, request.timeoutMs);
      if (request.signal !== undefined) {
        preSessionAbort = () => {
          timedOutOrCancelledBeforeSession = true;
          resolve("CANCELLED");
        };
        request.signal.addEventListener("abort", preSessionAbort, { once: true });
      }
    });

    let actualDigest: string;
    try {
      const digestOutcome = await Promise.race([
        Promise.resolve()
          .then(() => request.computeExecutableDigestHex(request.executable))
          .catch((): "SETUP_FAILED" => "SETUP_FAILED"),
        preSessionDeadline,
      ]);
      if (digestOutcome === "CANCELLED" || timedOutOrCancelledBeforeSession) {
        return refused(timedOutBeforeSession ? "observation timed out" : "observation was cancelled");
      }
      if (digestOutcome === "TIMED_OUT") {
        return refused("observation timed out");
      }
      if (digestOutcome === "SETUP_FAILED") {
        return refused("failed to compute the executable digest");
      }
      actualDigest = digestOutcome;
    } finally {
      if (preSessionTimer !== null) {
        clearTimeout(preSessionTimer);
      }
      if (preSessionAbort !== null) {
        request.signal?.removeEventListener("abort", preSessionAbort);
      }
    }
    if (actualDigest !== request.expectedExecutableDigestHex) {
      return refused("executable digest did not match the independently configured expected digest");
    }

    // No spawn may occur once the pre-session deadline/cancellation has
    // already fired; checked immediately before spawn, not before this
    // comment's prior await, so nothing can sneak in between.
    if (timedOutOrCancelledBeforeSession || request.signal?.aborted) {
      return refused(timedOutBeforeSession ? "observation timed out" : "observation was cancelled");
    }
    const spawnFn = request.spawnChild ?? defaultSpawn;
    try {
      child = spawnFn(request.executable, request.argv, { cwd: request.cwd, env: request.env });
    } catch {
      return refused("failed to spawn the app-server executable");
    }

    session = new RpcSession(child, request.maxOutputBytes, request.maxMessages);
    const activeSession = session;
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    timer = setTimeout(() => activeSession.timeout(), remainingMs);
    if (request.signal !== undefined) {
      if (request.signal.aborted) {
        return refused("observation was cancelled");
      }
      onAbort = () => activeSession.cancel();
      request.signal.addEventListener("abort", onAbort, { once: true });
    }
    const initResult = await session.request("initialize", {
      clientInfo: { name: request.clientName, version: request.clientVersion },
    });
    if (!initResult.ok) {
      return refused(initResult.reason);
    }
    session.sendNotification("initialized", {});

    const accountResult = await session.request("account/read", { refreshToken: false });
    if (!accountResult.ok) {
      return refused(accountResult.reason);
    }
    const accountOutcome = interpretAccountResponse(accountResult.value);
    if (accountOutcome.kind === "REFUSED") {
      return accountOutcome;
    }

    const models: SanitizedModelFact[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < request.maxModelPages; page += 1) {
      const params: Record<string, unknown> = { limit: request.modelPageLimit };
      if (cursor !== null) {
        params["cursor"] = cursor;
      }
      const modelResult = await session.request("model/list", params);
      if (!modelResult.ok) {
        return refused(modelResult.reason);
      }
      const pageOutcome = interpretModelListPage(modelResult.value);
      if (pageOutcome.kind === "REFUSED") {
        return pageOutcome;
      }
      models.push(...pageOutcome.models);
      if (pageOutcome.nextCursor === null) {
        cursor = null;
        break;
      }
      cursor = pageOutcome.nextCursor;
    }
    if (cursor !== null) {
      return refused("model catalog pagination did not complete within the bounded page count");
    }

    const rateLimitsResult = await session.request("account/rateLimits/read", {});
    if (!rateLimitsResult.ok) {
      return refused(rateLimitsResult.reason);
    }
    // Receipt time is captured here, at the source reply this observation is
    // actually bound to, not after the later child teardown below.
    const observedAt = Date.now();
    const bucketsOutcome = interpretRateLimitsResponse(rateLimitsResult.value);
    if (bucketsOutcome.kind === "REFUSED") {
      return bucketsOutcome;
    }

    const accountBindingOutcome = resolveAccountBinding(rateLimitsResult.value, request.expectedAccountBinding);
    if (accountBindingOutcome.kind === "REFUSED") {
      return refused(accountBindingOutcome.reason);
    }
    const accountBinding = accountBindingOutcome.status;
    const accountIdHashHex = accountBindingOutcome.hashHex;
    if (accountBinding === "UNKNOWN") {
      return unknown("no reliable same-account identity evidence; account binding is unknown");
    }

    const terminated = await session.closeAndConfirm();
    if (!terminated) {
      return refused("could not confirm the app-server child terminated cleanly");
    }
    if (session.storedFailure() !== null) {
      return refused(session.storedFailure() ?? "app-server interaction failed");
    }
    const trailingFault = session.trailingFault();
    if (trailingFault !== null) {
      return refused(trailingFault);
    }

    return {
      kind: "OBSERVED",
      observation: {
        observedAt,
        executableDigestHex: actualDigest,
        accountBinding,
        accountIdHashHex,
        buckets: bucketsOutcome.buckets,
        models,
        eligible: "UNKNOWN",
      },
    };
  } catch (err) {
    if (err instanceof RpcTimeoutError) {
      return refused("observation timed out");
    }
    if (err instanceof RpcBoundsError) {
      return refused(err.message);
    }
    return refused("app-server interaction failed");
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
    if (onAbort !== null) {
      request.signal?.removeEventListener("abort", onAbort);
    }
    if (session !== null) {
      await session.closeAndConfirm();
    } else if (child !== null) {
      // RpcSession construction never actually throws today, but if a
      // spawned child exists with no session wrapping it (e.g. a future
      // change makes construction fallible), it must still be reconciled
      // rather than fire-and-forget killed: confirm actual close, bounded.
      await closeOrphanChild(child);
    }
  }
}

/**
 * Bounded best-effort termination for a spawned child that never got an
 * owning `RpcSession` (so no stdio draining/fault bookkeeping applies):
 * confirms actual close via escalating signals, the same bound as
 * `RpcSession.closeAndConfirm`, but never throws and never affects the
 * generic/sanitized observation result either way.
 */
async function closeOrphanChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const waitForExit = (timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      const onClose = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.removeListener("close", onClose);
        resolve(false);
      }, timeoutMs);
      child.once("close", onClose);
    });
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  if (await waitForExit(CLOSE_ESCALATION_WAIT_MS)) {
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }
  await waitForExit(CLOSE_ESCALATION_WAIT_MS);
}

function defaultSpawn(
  executable: string,
  argv: readonly string[],
  options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
): ChildProcessWithoutNullStreams {
  return spawn(executable, [...argv], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
}

// ---------------------------------------------------------------------------
// Response interpretation (installed 0.153.4 schemas are ground truth)
// ---------------------------------------------------------------------------

type RefusalOutcome = { readonly kind: "REFUSED"; readonly reason: string };

/**
 * `requiresOpenaiAuth:true` is not itself a refusal: the installed
 * GetAccountResponse schema allows `requiresOpenaiAuth:true` together with a
 * valid signed-in `account` object (e.g. a ChatGPT account mid-token-refresh),
 * so this only inspects the `account` union's required shape, never the
 * `requiresOpenaiAuth` flag in isolation. `Account.email` is never read,
 * returned, or logged, even though the schema carries it on the `chatgpt`
 * variant: backend identity is confirmed later, from rateLimits/read's
 * `accountId`, which is the only identity field this protocol version
 * actually ties to a usage snapshot.
 */
function interpretAccountResponse(value: unknown): RefusalOutcome | { readonly kind: "OK" } {
  if (typeof value !== "object" || value === null) {
    return { kind: "REFUSED", reason: "malformed account/read reply" };
  }
  const record = value as Record<string, unknown>;
  if (typeof record["requiresOpenaiAuth"] !== "boolean") {
    return { kind: "REFUSED", reason: "malformed account/read reply" };
  }
  if (!("account" in record)) {
    return { kind: "REFUSED", reason: "malformed account/read reply" };
  }
  const account = record["account"];
  if (account === null) {
    // No installed account at all is a contradiction of the protocol
    // sequence reaching this point, not a valid-null outcome.
    return { kind: "REFUSED", reason: "account/read reports no installed account" };
  }
  if (typeof account !== "object") {
    return { kind: "REFUSED", reason: "malformed account/read reply" };
  }
  const accountType = (account as Record<string, unknown>)["type"];
  if (accountType !== "apiKey" && accountType !== "chatgpt" && accountType !== "amazonBedrock") {
    return { kind: "REFUSED", reason: "malformed account/read reply" };
  }
  if (accountType === "chatgpt") {
    const chatgpt = account as Record<string, unknown>;
    if (!("email" in chatgpt) || typeof chatgpt["planType"] !== "string") {
      return { kind: "REFUSED", reason: "malformed account/read reply" };
    }
  }
  return { kind: "OK" };
}

/**
 * Hashes the raw backend `accountId` transiently, compares it to the
 * independently configured expected hash, and discards the raw value
 * immediately. `accountId` is mandatory for this adapter's binding check: a
 * missing or empty value is a contradictory reply, refused rather than
 * silently treated as a valid "no match" UNKNOWN outcome.
 */
function resolveAccountBinding(
  rateLimitsValue: unknown,
  expected: ExpectedAccountBinding,
): RefusalOutcome | { readonly kind: "OK"; readonly status: AccountBindingStatus; readonly hashHex: string } {
  if (typeof rateLimitsValue !== "object" || rateLimitsValue === null) {
    return { kind: "REFUSED", reason: "malformed account/rateLimits/read reply" };
  }
  const raw = (rateLimitsValue as Record<string, unknown>)["accountId"];
  if (typeof raw !== "string" || raw.length === 0) {
    return { kind: "REFUSED", reason: "account/rateLimits/read reply missing required accountId" };
  }
  const actualHash = expected.hash(raw);
  const status: AccountBindingStatus = actualHash === expected.expectedAccountIdHashHex ? "MATCHED" : "UNKNOWN";
  return { kind: "OK", status, hashHex: actualHash };
}

function interpretModelListPage(
  value: unknown,
): RefusalOutcome | { readonly kind: "OK"; readonly models: readonly SanitizedModelFact[]; readonly nextCursor: string | null } {
  if (typeof value !== "object" || value === null) {
    return { kind: "REFUSED", reason: "malformed model/list reply" };
  }
  const record = value as Record<string, unknown>;
  const data = record["data"];
  if (!Array.isArray(data)) {
    return { kind: "REFUSED", reason: "malformed model/list reply" };
  }
  const models: SanitizedModelFact[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) {
      return { kind: "REFUSED", reason: "malformed model/list entry" };
    }
    const m = entry as Record<string, unknown>;
    if (typeof m["id"] !== "string" || typeof m["model"] !== "string" || typeof m["hidden"] !== "boolean") {
      return { kind: "REFUSED", reason: "malformed model/list entry" };
    }
    models.push({ id: m["id"], model: m["model"], hidden: m["hidden"] });
  }
  // nextCursor is a mandatory field of this reply shape: an absent field is
  // a malformed/contradictory reply, not a valid-null end of pagination.
  if (!("nextCursor" in record)) {
    return { kind: "REFUSED", reason: "model/list reply missing required nextCursor field" };
  }
  const nextCursorRaw = record["nextCursor"];
  if (nextCursorRaw !== null && typeof nextCursorRaw !== "string") {
    // A malformed nextCursor (present but not a string/null) is never treated
    // as a normal end of pagination; the caller cannot tell "done" from
    // "server sent garbage" unless this refuses explicitly.
    return { kind: "REFUSED", reason: "malformed model/list nextCursor" };
  }
  const nextCursor = typeof nextCursorRaw === "string" ? nextCursorRaw : null;
  return { kind: "OK", models, nextCursor };
}

function sanitizeWindow(value: unknown): SanitizedRateLimitWindow | null | "MALFORMED" {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "object") {
    return "MALFORMED";
  }
  const w = value as Record<string, unknown>;
  if (typeof w["usedPercent"] !== "number" || !Number.isFinite(w["usedPercent"])) {
    return "MALFORMED";
  }
  const windowDurationMins =
    w["windowDurationMins"] === null || w["windowDurationMins"] === undefined
      ? null
      : typeof w["windowDurationMins"] === "number" && Number.isFinite(w["windowDurationMins"])
        ? w["windowDurationMins"]
        : "MALFORMED";
  if (windowDurationMins === "MALFORMED") {
    return "MALFORMED";
  }
  const resetsAt =
    w["resetsAt"] === null || w["resetsAt"] === undefined
      ? null
      : typeof w["resetsAt"] === "number" && Number.isFinite(w["resetsAt"])
        ? w["resetsAt"]
        : "MALFORMED";
  if (resetsAt === "MALFORMED") {
    return "MALFORMED";
  }
  return { usedPercent: w["usedPercent"], windowDurationMins, resetsAt };
}

function interpretRateLimitsResponse(
  value: unknown,
): RefusalOutcome | { readonly kind: "OK"; readonly buckets: readonly SanitizedRateLimitBucket[] } {
  if (typeof value !== "object" || value === null) {
    return { kind: "REFUSED", reason: "malformed account/rateLimits/read reply" };
  }
  const record = value as Record<string, unknown>;
  const byId = record["rateLimitsByLimitId"];
  const single = record["rateLimits"];

  const rawBuckets: Array<{ isLegacyOrigin: boolean; limitId: string | null; snapshot: unknown }> = [];
  if (byId !== null && byId !== undefined) {
    if (typeof byId !== "object") {
      return { kind: "REFUSED", reason: "malformed rateLimitsByLimitId" };
    }
    const byIdEntries = Object.entries(byId as Record<string, unknown>);
    if (byIdEntries.length === 0) {
      return { kind: "REFUSED", reason: "empty rateLimitsByLimitId map" };
    }
    for (const [limitId, snapshot] of byIdEntries) {
      rawBuckets.push({ isLegacyOrigin: false, limitId, snapshot });
    }
  } else if (single !== null && single !== undefined) {
    // The legacy single-bucket `rateLimits` reply shape carries its own
    // `limitId` field on the snapshot itself (there is no outer map key to
    // take it from); that field is preserved rather than forced to null.
    rawBuckets.push({ isLegacyOrigin: true, limitId: null, snapshot: single });
  } else {
    return { kind: "REFUSED", reason: "no rate-limit bucket present in reply" };
  }

  const buckets: SanitizedRateLimitBucket[] = [];
  for (const { isLegacyOrigin, limitId: outerLimitId, snapshot } of rawBuckets) {
    if (typeof snapshot !== "object" || snapshot === null) {
      return { kind: "REFUSED", reason: "malformed rate-limit snapshot" };
    }
    const s = snapshot as Record<string, unknown>;
    let limitId: string | null;
    if (isLegacyOrigin) {
      const legacyLimitIdRaw = s["limitId"];
      if (legacyLimitIdRaw !== null && legacyLimitIdRaw !== undefined && typeof legacyLimitIdRaw !== "string") {
        return { kind: "REFUSED", reason: "malformed legacy rate-limit limitId" };
      }
      limitId = typeof legacyLimitIdRaw === "string" ? legacyLimitIdRaw : null;
    } else {
      const innerLimitIdRaw = s["limitId"];
      if (innerLimitIdRaw !== null && innerLimitIdRaw !== undefined) {
        if (typeof innerLimitIdRaw !== "string") {
          return { kind: "REFUSED", reason: "malformed rate-limit limitId" };
        }
        if (innerLimitIdRaw !== outerLimitId) {
          return { kind: "REFUSED", reason: "rate-limit bucket key/snapshot limitId mismatch" };
        }
      }
      limitId = outerLimitId;
    }
    const primary = sanitizeWindow(s["primary"]);
    if (primary === "MALFORMED") {
      return { kind: "REFUSED", reason: "malformed rate-limit primary window" };
    }
    const secondary = sanitizeWindow(s["secondary"]);
    if (secondary === "MALFORMED") {
      return { kind: "REFUSED", reason: "malformed rate-limit secondary window" };
    }
    const spendControlReachedRaw = s["spendControlReached"];
    const spendControlReached =
      spendControlReachedRaw === null || spendControlReachedRaw === undefined
        ? null
        : typeof spendControlReachedRaw === "boolean"
          ? spendControlReachedRaw
          : "MALFORMED";
    if (spendControlReached === "MALFORMED") {
      return { kind: "REFUSED", reason: "malformed spendControlReached flag" };
    }
    const rateLimitReachedTypeRaw = s["rateLimitReachedType"];
    const rateLimitReachedType =
      rateLimitReachedTypeRaw === null || rateLimitReachedTypeRaw === undefined
        ? null
        : typeof rateLimitReachedTypeRaw === "string"
          ? rateLimitReachedTypeRaw
          : "MALFORMED";
    if (rateLimitReachedType === "MALFORMED") {
      return { kind: "REFUSED", reason: "malformed rateLimitReachedType flag" };
    }
    if (primary === null && secondary === null) {
      return { kind: "REFUSED", reason: "rate-limit bucket has no usable window" };
    }
    buckets.push({ limitId, primary, secondary, spendControlReached, rateLimitReachedType });
  }
  return { kind: "OK", buckets };
}

// ---------------------------------------------------------------------------
// RPC session: bounded newline-delimited JSON-RPC over the child's stdio.
// ---------------------------------------------------------------------------

class RpcTimeoutError extends Error {}
class RpcBoundsError extends Error {}

type PendingEntry = {
  readonly method: string;
  readonly resolve: (value: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string }) => void;
};

class RpcSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly maxOutputBytes: number;
  private readonly maxMessages: number;
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();
  private buffer = "";
  private outputBytes = 0;
  private stderrBytes = 0;
  private messageCount = 0;
  /** Set once this session has begun its own teardown (graceful stdin end or escalation); stdio is still drained until `closed`. */
  private closing = false;
  /** Set only once the child has actually exited and the `close` event confirmed termination. */
  private closed = false;
  /** Signal this session actually sent via `child.kill`, if any — only this exact signal (with code null) counts as a confirmed own-shutdown exit. */
  private ownSentSignal: "SIGTERM" | "SIGKILL" | null = null;
  private failure: Error | null = null;
  private exited = false;
  private exitWasClean = false;
  private closeResult: Promise<boolean> | null = null;

  constructor(child: ChildProcessWithoutNullStreams, maxOutputBytes: number, maxMessages: number) {
    this.child = child;
    this.maxOutputBytes = maxOutputBytes;
    this.maxMessages = maxMessages;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.onStderr(chunk));
    this.child.on("error", () => this.fail(new RpcBoundsError("child process error")));
    this.child.on("close", (code: number | null, signal: string | null) => {
      this.exited = true;
      this.closed = true;
      // A clean exit is either: a normal EOF/exit(0) with no trailing
      // malformed buffer, or this exact controller-sent signal actually
      // taking effect (code null plus the matching SIGTERM/SIGKILL sent by
      // `closeAndConfirm`). A child that merely happens to exit nonzero (e.g.
      // its own SIGTERM handler calling exit(7)) while a shutdown was in
      // flight is never folded into "clean" just because `ownShutdown` was
      // set — the signal must actually match and the exit code must be null.
      const normalExit = code === 0 && signal === null && this.buffer.trim().length === 0;
      const confirmedOwnSignalExit = code === null && signal !== null && signal === this.ownSentSignal;
      this.exitWasClean = normalExit || confirmedOwnSignalExit;
      if (!this.closing) {
        // The child closed on its own while this session had no shutdown of
        // its own in flight: that is an unexpected failure regardless of
        // whether every reply had already arrived.
        this.fail(new RpcBoundsError("child process closed before reply"));
      } else if (!normalExit && !confirmedOwnSignalExit) {
        // Closing was requested (graceful stdin end) but the exit was
        // neither a normal EOF/exit0 nor this session's own escalation
        // signal: an unrelated crash during graceful shutdown is still a
        // fault, not a silent success.
        this.fail(new RpcBoundsError("child process exited unexpectedly during shutdown"));
      }
    });
  }

  private onStderr(chunk: string): void {
    if (this.closed) {
      return;
    }
    this.stderrBytes += Buffer.byteLength(chunk, "utf8");
    if (this.stderrBytes > this.maxOutputBytes) {
      this.fail(new RpcBoundsError("stderr byte bound exceeded"));
    }
  }

  private onData(chunk: string): void {
    if (this.closed) {
      return;
    }
    this.outputBytes += Buffer.byteLength(chunk, "utf8");
    if (this.outputBytes > this.maxOutputBytes) {
      this.fail(new RpcBoundsError("output byte bound exceeded"));
      return;
    }
    this.buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.trim().length === 0) {
        continue;
      }
      this.handleLine(line);
      if (this.closed) {
        return;
      }
    }
  }

  private handleLine(line: string): void {
    this.messageCount += 1;
    if (this.messageCount > this.maxMessages) {
      this.fail(new RpcBoundsError("message count bound exceeded"));
      return;
    }
    let parsed: JsonRpcReplyShape;
    try {
      parsed = JSON.parse(line) as JsonRpcReplyShape;
    } catch {
      this.fail(new RpcBoundsError("malformed JSON reply"));
      return;
    }
    if (typeof parsed !== "object" || parsed === null || typeof parsed["id"] !== "number") {
      // Non-reply traffic (e.g. server notifications) is observed and
      // discarded; this adapter never answers server-initiated requests,
      // including any auth/token prompt.
      return;
    }
    const id = parsed["id"];
    const entry = this.pending.get(id);
    if (entry === undefined) {
      this.fail(new RpcBoundsError("reply with unknown or duplicate id"));
      return;
    }
    this.pending.delete(id);
    if ("error" in parsed && parsed["error"] !== undefined) {
      entry.resolve({ ok: false, reason: `${entry.method} returned a server error` });
      return;
    }
    if (!("result" in parsed)) {
      entry.resolve({ ok: false, reason: `${entry.method} reply missing result` });
      return;
    }
    entry.resolve({ ok: true, value: parsed["result"] });
  }

  private fail(err: Error): void {
    if (this.failure !== null) {
      return;
    }
    this.failure = err;
    for (const entry of this.pending.values()) {
      entry.resolve({ ok: false, reason: err.message });
    }
    this.pending.clear();
  }

  /** The first fault recorded for this session, if any; checked before reporting success. */
  storedFailure(): string | null {
    return this.failure !== null ? this.failure.message : null;
  }

  timeout(): void {
    this.fail(new RpcTimeoutError("timeout"));
  }

  cancel(): void {
    this.fail(new RpcBoundsError("observation was cancelled"));
  }

  /**
   * A trailing unterminated line or a nonzero/signal exit cannot be silently
   * folded into an OBSERVED result even when every reply the caller was
   * waiting on already arrived.
   */
  trailingFault(): string | null {
    if (this.buffer.trim().length > 0) {
      return "trailing malformed output after the last reply";
    }
    if (this.exited && !this.exitWasClean) {
      return "app-server exited unexpectedly during the observation";
    }
    return null;
  }

  async request(
    method: (typeof ALLOWED_REQUEST_METHODS)[number],
    params: unknown,
  ): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string }> {
    if (this.closing) {
      return { ok: false, reason: "session already closed" };
    }
    if (this.failure !== null) {
      return { ok: false, reason: this.failure.message };
    }
    const id = this.nextId;
    this.nextId += 1;
    const envelope: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve) => {
      this.pending.set(id, { method, resolve });
      try {
        this.child.stdin.write(JSON.stringify(envelope) + "\n");
      } catch {
        this.pending.delete(id);
        resolve({ ok: false, reason: "failed to write request" });
      }
    });
  }

  sendNotification(method: string, params: unknown): void {
    if (this.closing || this.failure !== null) {
      return;
    }
    const envelope: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    try {
      this.child.stdin.write(JSON.stringify(envelope) + "\n");
    } catch {
      // A failed notification write does not block closure below.
    }
  }

  /**
   * Gracefully ends the one child this session owns and does not return
   * until actual termination is confirmed (or a bounded escalation gives
   * up): end stdin first and let stdout/stderr keep draining while waiting
   * for a normal exit, then escalate to SIGTERM with a bounded wait, then
   * SIGKILL with a final bounded wait. Returns whether termination was
   * confirmed. Idempotent and safe to call more than once (e.g. once on the
   * success path, once in `finally`); any pending requests are settled via
   * `fail`, never silently dropped.
   */
  async closeAndConfirm(): Promise<boolean> {
    if (this.closed) {
      return this.exited;
    }
    if (this.closeResult !== null) {
      // A teardown is already in flight or already finished-but-unconfirmed
      // (e.g. called concurrently from the success path and `finally`, or
      // re-invoked after a prior bounded attempt returned false): reuse that
      // same bounded promise rather than starting a second, unbounded wait.
      return this.closeResult;
    }
    this.closing = true;
    this.closeResult = this.runCloseSequence();
    return this.closeResult;
  }

  private async runCloseSequence(): Promise<boolean> {
    // Any requests still pending at close time are settled, never silently
    // dropped — with the already-stored failure reason if one exists, or a
    // generic closed reason otherwise. This does not itself record a stored
    // failure: a clean close with no pending requests must not manufacture
    // one and fail the success path above.
    if (this.pending.size > 0) {
      const reason = this.failure !== null ? this.failure.message : "session closed before a reply arrived";
      for (const entry of this.pending.values()) {
        entry.resolve({ ok: false, reason });
      }
      this.pending.clear();
    }
    try {
      this.child.stdin.end();
    } catch {
      // Already ended or errored; graceful shutdown proceeds regardless.
    }

    const waitForExit = (timeoutMs: number): Promise<boolean> =>
      new Promise((resolve) => {
        if (this.exited) {
          resolve(true);
          return;
        }
        const onClose = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          this.child.removeListener("close", onClose);
          resolve(false);
        }, timeoutMs);
        this.child.once("close", onClose);
      });

    // Bounded wait for a normal EOF/exit after ending stdin, draining
    // stdout/stderr the whole time (the `data` handlers above keep running
    // until `closed` is actually set by the `close` event).
    if (await waitForExit(CLOSE_ESCALATION_WAIT_MS)) {
      return this.exited && this.exitWasClean;
    }

    try {
      this.child.kill("SIGTERM");
      this.ownSentSignal = "SIGTERM";
    } catch {
      // Already exited; nothing further to do.
    }
    if (await waitForExit(CLOSE_ESCALATION_WAIT_MS)) {
      return this.exited && this.exitWasClean;
    }

    try {
      this.child.kill("SIGKILL");
      this.ownSentSignal = "SIGKILL";
    } catch {
      // Already exited; nothing further to do.
    }
    await waitForExit(CLOSE_ESCALATION_WAIT_MS);
    return this.exited && this.exitWasClean;
  }
}
