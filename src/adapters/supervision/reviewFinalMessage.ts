/**
 * The reviewer's FINAL structured message — strictly (TASK-019 AC-14, SF-R3).
 *
 * WHY THIS IS NOT `interpretCodexOutput` / `interpretClaudeOutput`.
 *
 * `codexCliAdapter.ts` and `claudeCodeAdapter.ts` already parse these two
 * formats, and they say so about themselves: that channel is INFORMATIONAL, it
 * "must never affect WorkerOutcome.status", and it is deliberately lenient —
 * Claude's version falls back to a JSONL scan when the single object does not
 * parse, and Codex's version skips a malformed line and keeps going. Leniency is
 * right for a reported-identity channel and wrong here, because here the text
 * this returns is the ONLY thing that may become an acceptance verdict.
 *
 * So the measured FORMAT knowledge is reused and the leniency is not:
 *
 *   - a line that does not parse means the stream is malformed or truncated, and
 *     a truncated transcript is exactly the case where an earlier `PASS` block
 *     would otherwise be the last thing successfully read;
 *   - only the LAST `agent_message` of a Codex run is the answer. An echoed
 *     prompt, a diagnostic, or a mid-run message that contains a complete
 *     verdict block is not the reviewer's conclusion;
 *   - that last message is not the answer BY ITSELF: a stream that ends right
 *     after it, without the `turn.completed` event that says the turn the
 *     message belongs to actually finished, proves nothing about whether the
 *     reviewer was still working. And a `turn.failed` or `error` event naming
 *     that same turn OUTRANKS an agent_message that reads like a verdict, the
 *     same way a nonzero exit code does — a turn the CLI itself reports as
 *     failed is not a conclusion reached;
 *   - `is_error: true` from Claude is a provider FAILURE whatever `.result`
 *     contains and whatever the process exit code was. MEASURED on this machine
 *     (claude-code 2.1.238): an OAuth-expired invocation returned
 *     `is_error: true`, `subtype: "success"`, `terminal_reason: "api_error"` and
 *     a `result` string describing the failure. `subtype` is therefore not read
 *     at all — it said "success" about a call that failed.
 *
 * Pure and synchronous: no I/O, no clock, no state. The only thing that turns
 * its output into a verdict is `parseAcceptanceVerdict`, which is unchanged and
 * remains the acceptance authority.
 */

export type FinalMessageReading =
  /** The reviewer's last structured message. The ONLY verdict candidate. */
  | { readonly kind: "FINAL"; readonly text: string }
  /** The provider's own structured output said the invocation failed. */
  | { readonly kind: "PROVIDER_ERROR"; readonly message: string }
  /** Nothing usable. Never an approval, never a retry decision on its own. */
  | { readonly kind: "NONE"; readonly reason: string };

/** Codex `exec --json`: one JSON event per line, the answer in the last `agent_message`. */
export function strictCodexFinalMessage(stdout: string): FinalMessageReading {
  const lines = stdout.split("\n");
  let last: string | undefined;
  /**
   * Both flags are about the turn the CURRENT `last` belongs to, and both are
   * reset whenever `last` changes (a new `agent_message` starts a new turn's
   * evidence). `failed` is STICKY once set for that turn — a `turn.completed`
   * arriving after a `turn.failed`/`error` for the same message does not undo
   * it, because two contradictory terminal events about one turn are not
   * something a stream is supposed to produce, and a fail-closed reading of a
   * self-contradictory stream is never "FINAL".
   */
  let completedAfterLast = false;
  let failedAfterLast = false;
  let events = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      /**
       * STRICT, and this is the whole difference from the informational parser.
       *
       * A line that does not parse is either a truncated stream or something
       * that is not this format at all. Skipping it would let the last
       * SUCCESSFULLY PARSED message — which may be an echoed prompt containing a
       * complete PASS block — stand in for a conclusion the reviewer never
       * reached.
       */
      return {
        kind: "NONE",
        reason: "the Codex JSON stream carried a line that is not JSON, so it is malformed or truncated",
      };
    }
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      return { kind: "NONE", reason: "the Codex JSON stream carried a line that is not a JSON object" };
    }
    events += 1;
    const row = event as { type?: unknown; item?: unknown };
    if (row.type === "item.completed") {
      const item = row.item;
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const completed = item as { type?: unknown; text?: unknown };
      if (completed.type === "agent_message" && typeof completed.text === "string") {
        // Overwritten deliberately: the LAST one is the answer, and its turn's
        // terminal evidence starts fresh from here.
        last = completed.text;
        completedAfterLast = false;
        failedAfterLast = false;
      }
      continue;
    }
    if (row.type === "turn.completed") {
      completedAfterLast = true;
      continue;
    }
    if (row.type === "turn.failed" || row.type === "error") {
      failedAfterLast = true;
      continue;
    }
  }
  if (events === 0) {
    return { kind: "NONE", reason: "the reviewer produced no Codex JSON events at all" };
  }
  if (last === undefined) {
    return { kind: "NONE", reason: "the Codex JSON stream carried no completed agent_message" };
  }
  if (failedAfterLast) {
    return {
      kind: "NONE",
      reason: "the Codex JSON stream reported turn.failed or error after the final agent_message",
    };
  }
  if (!completedAfterLast) {
    return {
      kind: "NONE",
      reason: "the Codex JSON stream carried no turn.completed after the final agent_message",
    };
  }
  return { kind: "FINAL", text: last };
}

/** Claude `-p --output-format json`: exactly ONE result object, the answer in `.result`. */
export function strictClaudeFinalMessage(stdout: string): FinalMessageReading {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { kind: "NONE", reason: "the reviewer produced no output" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    /**
     * NO JSONL FALLBACK HERE, on purpose. The informational parser scans for any
     * object with a `.result` field when the single object does not parse, which
     * is a reasonable way to survive a format change and an unreasonable way to
     * choose an approval: the first `{"result": "...PASS..."}` shaped thing in a
     * truncated stream would win.
     */
    return { kind: "NONE", reason: "the reviewer's output is not a single JSON object" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "NONE", reason: "the reviewer's JSON output is not an object" };
  }
  const row = parsed as Record<string, unknown>;
  if (own(row, "type") !== "result") {
    return { kind: "NONE", reason: "the reviewer's JSON output is not a claude-code result object" };
  }
  const isError = own(row, "is_error");
  const result = own(row, "result");
  /**
   * `is_error` OUTRANKS EVERYTHING, including a `result` that reads like a
   * verdict and an exit code of zero. This is the measured auth-failure shape.
   */
  if (isError === true) {
    return {
      kind: "PROVIDER_ERROR",
      message: typeof result === "string" && result.trim().length > 0
        ? result
        : "claude-code reported is_error with no result text",
    };
  }
  if (isError !== false) {
    return { kind: "NONE", reason: "the claude-code result object carried no boolean is_error field" };
  }
  if (typeof result !== "string" || result.trim().length === 0) {
    return { kind: "NONE", reason: "the claude-code result object carried no result text" };
  }
  return { kind: "FINAL", text: result };
}

/**
 * Reads a field the object OWNS, never one it merely inherits — the same
 * hardening `resourceClassifier.ts` applies for the same reason: a decision made
 * from a field the payload does not actually contain.
 */
function own(row: Record<string, unknown>, field: string): unknown {
  return Object.prototype.hasOwnProperty.call(row, field) ? row[field] : undefined;
}

/**
 * The parser for a provider, or a refusal.
 *
 * An unknown provider gets NO lenient fallback: a format nobody has measured
 * cannot be parsed strictly, and "parse it loosely instead" is how prose becomes
 * a verdict.
 */
export function strictReviewFinalMessage(provider: string, stdout: string): FinalMessageReading {
  switch (provider) {
    case "codex-cli":
      return strictCodexFinalMessage(stdout);
    case "claude-code":
      return strictClaudeFinalMessage(stdout);
    default:
      return {
        kind: "NONE",
        reason: `no strict final-message parser exists for provider ${JSON.stringify(provider)}`,
      };
  }
}
