/**
 * The wire contract between the supervisor and an ISOLATED executor process
 * (TASK-011).
 *
 * ================================================================
 * WHY THIS FILE IS SEPARATE FROM THE ADAPTER
 * ================================================================
 * The adapter spawns processes and cannot be reasoned about without one. The
 * RULES — what may be sent, what may be believed — are pure functions, so they
 * live here where they can be driven directly with fixtures. Every previous
 * round of this project that put a rule inside an I/O function ended up with a
 * rule nothing tested.
 *
 * ================================================================
 * DIRECTION MATTERS
 * ================================================================
 * The two directions are NOT symmetric, and treating them alike would be the
 * whole mistake:
 *
 *   - what the supervisor SENDS is bounded by AC-3: the item, the action id,
 *     the already-chosen run configuration, and a resume checkpoint. Not the
 *     supervisor state, not the database path, not the financial policy. A
 *     child cannot leak, corrupt or reason about what it was never given.
 *
 *   - what the child RETURNS is UNTRUSTED DATA (AC-4). It is parsed field by
 *     field and refused on anything unexpected. The child is a separate process
 *     precisely because it is not trusted to behave; believing its output
 *     because it is "our own code" would give back everything the separation
 *     bought.
 *
 * ================================================================
 * WHAT A CHILD CANNOT DO, AND WHY THAT IS THE POINT
 * ================================================================
 * No value here can grant spending authority (AC-5). `WorkOutcome` describes
 * what HAPPENED; it never says what the supervisor should permit next. That is
 * the same principle F-1 applied to the financial gate: authority that cannot
 * be EXPRESSED in data cannot be forged in data. A child may lie about an
 * outcome; it cannot lie its way into a budget.
 */

import type { SessionCheckpoint } from "./supervisorTypes.js";
import type { WorkExecutionInput, WorkOutcome } from "./supervisorPorts.js";

/** Wire format version. A child speaking anything else is refused, not adapted. */
export const EXECUTOR_PROTOCOL_VERSION = 1;

/**
 * Hard ceiling on a child's response, before parsing.
 *
 * A child that streams unbounded output would otherwise be a memory exhaustion
 * away from taking the supervisor down with it — and "the supervisor died" is
 * not one of the outcomes any caller handles. Refusing a large response is a
 * definite answer; running out of memory is not.
 */
export const MAX_RESPONSE_BYTES = 1_000_000;

/** Everything a child is given. Deliberately small; see AC-3. */
export interface ExecutorRequest {
  readonly protocol: number;
  readonly item: WorkExecutionInput["item"];
  readonly actionId: string;
  readonly config?: WorkExecutionInput["config"];
  readonly checkpoint?: SessionCheckpoint;
}

/**
 * Arrays were SHALLOW-copied, so an object sitting in a string array crossed
 * the boundary intact — `{ databasePath: "..." }` inside `dependsOn` reached
 * the child (round-5 note). Spreading an array copies the array, not what is
 * in it.
 *
 * Round-6 extends this to SCALARS. `title` and `note` were copied on the
 * strength of their declared type, and a declared type is a claim about the
 * caller rather than a fact about the value: a malformed object in a `string`
 * field crosses the boundary just as an array element did.
 *
 * Round-7 finished the job. Fixing the two fields a reviewer named and leaving
 * the rest is fixing an instance and not a class — `actionId`, the provider and
 * model identities, and the checkpoint's `actionId` all carried objects
 * through. EVERY free-text scalar goes through this now; the only fields still
 * copied as declared are the literal UNIONS, which have no free text to hide in
 * and whose only consumer fails closed on an unrecognised value.
 */
function asPlainString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A NUMBER field is copied on exactly the same strength as a string one, and an
 * object in a `number` field crosses the boundary exactly as far. Non-finite
 * values go too: `NaN` and `Infinity` do not survive JSON, so forwarding them
 * would put `null` in a field the child's parser declares numeric.
 */
function asPlainNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function buildExecutorRequest(input: WorkExecutionInput): ExecutorRequest {
  // Constructed field by field, never spread from `input`. A spread would
  // forward whatever the caller's object happened to carry, which is how a
  // field nobody intended to expose crosses a trust boundary.
  /**
   * PROJECTED FIELD BY FIELD, at every level (round-4 finding).
   *
   * The first version copied `item`, `config` and `checkpoint` wholesale. It
   * was "constructed explicitly" only at the top level, so anything nested
   * inside them travelled — the reviewer put `databasePath` and a
   * `financialPolicy` with `autonomousSpendAllowed: true` inside `item` and
   * the child received both. A shallow projection across a trust boundary is
   * not a projection; it is a spread with extra steps.
   */
  const item = input.item;
  const config = input.config;
  const checkpoint = input.checkpoint;
  return {
    protocol: EXECUTOR_PROTOCOL_VERSION,
    item: {
      key: asPlainString(item.key),
      title: asPlainString(item.title),
      dependsOn: item.dependsOn.map(asPlainString),
      /**
       * "status" and "workClass" are literal UNIONS, not free text, so they are
       * copied as declared. Coercing them to string breaks the contract, and
       * substituting a fallback would silently change meaning — the child reads
       * "workClass" for exactly one comparison, and a malformed value simply
       * fails that comparison, which is already the closed direction.
       */
      status: item.status,
      workClass: item.workClass,
      order: asPlainNumber(item.order),
      ...(item.attempts === undefined ? {} : { attempts: asPlainNumber(item.attempts) }),
      ...(item.detail === undefined ? {} : { detail: asPlainString(item.detail) }),
    },
    actionId: asPlainString(input.actionId),
    ...(config === undefined
      ? {}
      : {
          config: {
            requestedProvider: asPlainString(config.requestedProvider),
            requestedModel: asPlainString(config.requestedModel),
            ...(config.requestedEffort === undefined ? {} : { requestedEffort: asPlainString(config.requestedEffort) }),
            effectiveProvider: asPlainString(config.effectiveProvider),
            effectiveModel: asPlainString(config.effectiveModel),
            ...(config.effectiveEffort === undefined ? {} : { effectiveEffort: asPlainString(config.effectiveEffort) }),
            verification: config.verification,
            argvEvidence: config.argvEvidence.map(asPlainString),
            note: asPlainString(config.note),
          },
        }),
    ...(checkpoint === undefined
      ? {}
      : {
          checkpoint: {
            roadmapKey: asPlainString(checkpoint.roadmapKey),
            actionId: asPlainString(checkpoint.actionId),
            requiredWorkClass: checkpoint.requiredWorkClass,
            iteration: asPlainNumber(checkpoint.iteration),
            nextAction: asPlainString(checkpoint.nextAction),
            findings: checkpoint.findings.map(asPlainString),
            completedVerification: checkpoint.completedVerification.map(asPlainString),
            pendingVerification: checkpoint.pendingVerification.map(asPlainString),
            updatedAt: asPlainNumber(checkpoint.updatedAt),
          },
        }),
  };
}

/**
 * Refuses an object carrying any key the contract does not name (AC-4).
 *
 * Round-1 review: the parser IGNORED unexpected fields, and a test in this
 * repository had codified that as intended — "extra fields should simply be
 * ignored, not fail". That was wrong. AC-4 requires unknown fields to be
 * REFUSED, and ignoring them means a child can attach anything it likes to a
 * response the supervisor then stores, logs or reasons about. `__proto__` and
 * `constructor` came through the same way.
 *
 * Deliberately checks OWN properties including non-enumerable ones, so a
 * response cannot smuggle a key past `Object.keys`.
 */
function onlyKeys(row: Record<string, unknown>, allowed: readonly string[], where: string): string | undefined {
  for (const key of Object.getOwnPropertyNames(row)) {
    if (!allowed.includes(key)) {
      return `${where} carries an unexpected field ${JSON.stringify(key)}`;
    }
  }
  return undefined;
}

export type ParseResult =
  | { readonly ok: true; readonly outcome: WorkOutcome }
  | { readonly ok: false; readonly reason: string };

function fail(reason: string): ParseResult {
  return { ok: false, reason };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(row: Record<string, unknown>, field: string): string | undefined {
  const value = row[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * Parses what a child wrote on stdout into a `WorkOutcome`, or refuses.
 *
 * FAIL CLOSED, always. Every path that cannot produce a fully-formed outcome
 * returns a reason rather than a partial value — an outcome that is half
 * believed is worse than no outcome, because the supervisor acts on it.
 */
export function parseExecutorResponse(raw: string): ParseResult {
  // BYTES, not code units (round-1 finding). A UTF-8 response can pass a
  // string-length check while exceeding the byte budget it claims to enforce.
  const byteLength = Buffer.byteLength(raw, "utf8");
  if (byteLength > MAX_RESPONSE_BYTES) {
    return fail(`response is ${byteLength} bytes, over the ${MAX_RESPONSE_BYTES} limit`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return fail("the executor wrote nothing");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return fail(`the executor did not write valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(parsed)) {
    return fail("the executor response is not an object");
  }
  const topProblem = onlyKeys(parsed, ["protocol", "outcome"], "the executor response");
  if (topProblem !== undefined) return fail(topProblem);
  if (parsed["protocol"] !== EXECUTOR_PROTOCOL_VERSION) {
    // A version mismatch is a DIFFERENT problem from corruption, and saying so
    // sends the operator to the right place — the lesson of L-1 in
    // docs/KNOWN-LIMITATIONS.md, where a newer field read as a corrupt row.
    return fail(
      `the executor speaks protocol ${JSON.stringify(parsed["protocol"])}, this supervisor speaks ${EXECUTOR_PROTOCOL_VERSION}`,
    );
  }

  const outcome = parsed["outcome"];
  if (!isObject(outcome)) {
    return fail("the executor response carries no outcome object");
  }
  const kind = outcome["kind"];

  switch (kind) {
    case "COMPLETED": {
      const problem = onlyKeys(outcome, ["kind", "detail", "reportedIdentity"], "COMPLETED");
      if (problem !== undefined) return fail(problem);
      const detail = stringField(outcome, "detail");
      if (detail === undefined) return fail("COMPLETED requires a string detail");
      const identity = parseIdentity(outcome["reportedIdentity"]);
      if (identity === "invalid") return fail("reportedIdentity must be an object of strings");
      return {
        ok: true,
        outcome: { kind: "COMPLETED", detail, ...(identity === undefined ? {} : { reportedIdentity: identity }) },
      };
    }
    case "CHANGES_REQUIRED": {
      const problem = onlyKeys(outcome, ["kind", "findings"], "CHANGES_REQUIRED");
      if (problem !== undefined) return fail(problem);
      const findings = outcome["findings"];
      if (!Array.isArray(findings) || findings.some((entry) => typeof entry !== "string")) {
        return fail("CHANGES_REQUIRED requires an array of string findings");
      }
      return { ok: true, outcome: { kind: "CHANGES_REQUIRED", findings: findings as readonly string[] } };
    }
    case "RESOURCE_FAILURE": {
      const problem = onlyKeys(outcome, ["kind", "process", "retryAt"], "RESOURCE_FAILURE");
      if (problem !== undefined) return fail(problem);
      const process_ = outcome["process"];
      if (!isObject(process_)) return fail("RESOURCE_FAILURE requires a process object");
      const processProblem = onlyKeys(
        process_,
        ["terminationReason", "exitCode", "stdout", "stderr"],
        "RESOURCE_FAILURE.process",
      );
      if (processProblem !== undefined) return fail(processProblem);
      const reason = process_["terminationReason"];
      if (reason !== "EXITED" && reason !== "TIMEOUT" && reason !== "CANCELLED" && reason !== "SPAWN_ERROR") {
        return fail(`RESOURCE_FAILURE has an unknown terminationReason ${JSON.stringify(reason)}`);
      }
      const exitCode = process_["exitCode"];
      if (exitCode !== null && (typeof exitCode !== "number" || !Number.isInteger(exitCode))) {
        return fail("RESOURCE_FAILURE exitCode must be an integer or null");
      }
      const stdout = stringField(process_, "stdout");
      const stderr = stringField(process_, "stderr");
      if (stdout === undefined || stderr === undefined) {
        return fail("RESOURCE_FAILURE requires string stdout and stderr");
      }
      const retryAt = outcome["retryAt"];
      if (retryAt !== undefined && (typeof retryAt !== "number" || !Number.isFinite(retryAt))) {
        return fail("RESOURCE_FAILURE retryAt must be a finite number when present");
      }
      return {
        ok: true,
        outcome: {
          kind: "RESOURCE_FAILURE",
          process: { terminationReason: reason, exitCode, stdout, stderr },
          ...(retryAt === undefined ? {} : { retryAt }),
        },
      };
    }
    /**
     * CHECKPOINT and HUMAN_REQUIRED are deliberately REFUSED from a child.
     *
     * Both carry structures the supervisor stores or acts on directly — a
     * `SessionCheckpoint` becomes durable state, and a `SupervisedAction` is
     * the currency the financial gate reasons about. Accepting either from an
     * untrusted process would let a child write durable state, or hand the gate
     * an action it minted itself, which is exactly the authority AC-5 says no
     * child may have.
     *
     * They remain valid outcomes for the in-process test executor. If an
     * isolated child ever needs to express them, they need a narrowed wire
     * shape and their own review — not a hole opened here for convenience.
     */
    case "CHECKPOINT":
    case "HUMAN_REQUIRED":
      return fail(`an isolated executor may not report ${kind}; it mints state the supervisor must own`);
    default:
      return fail(`unknown outcome kind ${JSON.stringify(kind)}`);
  }
}

function parseIdentity(value: unknown): { provider?: string; model?: string; effort?: string } | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (!isObject(value)) return "invalid";
  if (onlyKeys(value, ["provider", "model", "effort"], "reportedIdentity") !== undefined) return "invalid";
  const provider = value["provider"];
  const model = value["model"];
  const effort = value["effort"];
  for (const candidate of [provider, model, effort]) {
    if (candidate !== undefined && typeof candidate !== "string") return "invalid";
  }
  return {
    ...(typeof provider === "string" ? { provider } : {}),
    ...(typeof model === "string" ? { model } : {}),
    ...(typeof effort === "string" ? { effort } : {}),
  };
}
