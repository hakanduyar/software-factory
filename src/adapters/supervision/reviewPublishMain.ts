/**
 * The reviewer wrapper's last act: publish what the CLI produced (SF-R3).
 *
 * WHY A SEPARATE PROCESS RATHER THAN SHELL. The verdict candidate is now the
 * provider's FINAL STRUCTURED MESSAGE, and deciding which message that is means
 * parsing JSON strictly — a JSONL stream whose last `agent_message` is the
 * answer, or a single result object whose `is_error` outranks its text. `awk`
 * can copy lines; it cannot refuse a truncated stream, and the previous
 * `awk '/^VERDICT: /...'` is exactly how an echoed prompt became a verdict.
 *
 * WHY NOT IN THE SUPERVISOR. The supervisor may be dead: a review runs for
 * tens of minutes and must outlive the process that started it. Whatever
 * publishes the outcome has to be part of the detached job, so it is this — a
 * tiny node invocation the wrapper makes after the CLI exits, with the same
 * filtered environment as the reviewer itself.
 *
 * It invokes no model, contacts nothing, and decides nothing.
 */

import { publishReviewOutcome } from "./reviewCompletion.js";

const [provider, runId, source, exitCode] = process.argv.slice(2);

if (provider === undefined || runId === undefined || source === undefined || exitCode === undefined) {
  process.stderr.write("usage: reviewPublishMain <provider> <runId> <verdictPath> <exitCode>\n");
  process.exit(64);
}

const parsed = Number(exitCode);
if (!Number.isInteger(parsed)) {
  process.stderr.write(`review exit code ${JSON.stringify(exitCode)} is not an integer\n`);
  process.exit(64);
}

publishReviewOutcome({ provider, runId, source, exitCode: parsed, now: Date.now() });
