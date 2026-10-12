/**
 * Publishing, and reading back, what a finished reviewer actually produced
 * (SF-R3; TASK-019 AC-14, AC-15, AC-16, AC-20).
 *
 * THE DEFECT THIS CLOSES. The wrapper used to merge stdout and stderr into one
 * log and copy everything from the first line beginning `VERDICT:` into the
 * verdict file whenever the CLI exited zero. A prompt echo, a diagnostic, or an
 * earlier message could therefore BE the verdict; stderr could masquerade as a
 * reviewer message; and a CLI that launched and then failed left the review
 * looking like one still in progress, so the resource stayed `AVAILABLE` and the
 * next attempt spent another call immediately.
 *
 * Two artefacts fix that, and both are written by the process that did the work,
 * after the CLI has exited:
 *
 *   - the VERDICT CANDIDATE — the reviewer's final structured message and
 *     nothing else, written only after exit 0 and a valid structured result;
 *   - the COMPLETION EVIDENCE — run identity, exit code and bounded, redacted
 *     failure text, so a supervisor that was not alive when the reviewer died
 *     can still tell "finished badly" from "still working".
 *
 * Both are published with a write-then-rename, so a tick reading at the wrong
 * moment sees either nothing or the whole thing. The completion is published
 * LAST: once it exists, whatever verdict there was going to be is already there,
 * which is what lets the consumer check for a verdict first without a race.
 *
 * It is EVIDENCE, not a workflow database. Nothing here decides anything; the
 * supervisor classifies, and `parseAcceptanceVerdict` remains the only thing
 * that can turn text into an acceptance.
 */

import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

import { redactSecrets } from "../workers/environmentPolicy.js";
import type { ReviewCompletionEvidence, ReviewCompletionQuery, ReviewCompletionReading } from "../../supervision/supervisorPorts.js";
import { strictReviewFinalMessage } from "./reviewFinalMessage.js";

/**
 * How much reviewer output is parsed at all.
 *
 * A review transcript is large but not unbounded, and an unbounded read of a
 * file a provider wrote is a memory problem waiting for a bad day. Beyond this,
 * the output is treated as unusable rather than truncated-and-parsed: a
 * truncated transcript is exactly where an earlier `PASS` block would otherwise
 * become the last thing successfully read.
 */
export const MAX_REVIEW_OUTPUT_BYTES = 8 * 1024 * 1024;

/** How much failure text becomes evidence. Bounded and redacted, never a transcript. */
export const MAX_FAILURE_EVIDENCE = 1_000;

/** Every file one review run produces, derived from where its verdict goes. */
export interface ReviewRunPaths {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: string;
  readonly completion: string;
  readonly publisherLog: string;
}

export function reviewRunPaths(source: string): ReviewRunPaths {
  return {
    stdout: `${source}.run.log`,
    stderr: `${source}.run.err`,
    exitCode: `${source}.run.rc`,
    completion: `${source}.run.done`,
    publisherLog: `${source}.run.publish.log`,
  };
}

/** Write-then-rename, so no reader ever sees half of this. */
function publishAtomically(path: string, contents: string): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function boundedEvidence(text: string): string {
  const flattened = redactSecrets(text).replace(/\s+/g, " ").trim();
  return flattened.length > MAX_FAILURE_EVIDENCE ? `…${flattened.slice(-MAX_FAILURE_EVIDENCE)}` : flattened;
}

/** The TAIL, because a provider's reason for failing is the last thing it says. */
function tail(text: string, characters: number): string {
  return text.length > characters ? text.slice(-characters) : text;
}

function readBounded(path: string): { readonly text: string; readonly oversize: boolean } {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { text: "", oversize: false };
  }
  if (size > MAX_REVIEW_OUTPUT_BYTES) {
    return { text: "", oversize: true };
  }
  try {
    return { text: readFileSync(path, "utf8"), oversize: false };
  } catch {
    return { text: "", oversize: false };
  }
}

export interface PublishReviewOutcomeInput {
  readonly provider: string;
  readonly runId: string;
  /** Where a verdict candidate would go. Every other path derives from it. */
  readonly source: string;
  readonly exitCode: number;
  readonly now: number;
}

/**
 * Publishes at most one verdict candidate, and exactly one completion record.
 *
 * Pure enough to unit-test directly: it reads the files the wrapper wrote and
 * writes two more. It spawns nothing and contacts nothing.
 */
export function publishReviewOutcome(input: PublishReviewOutcomeInput): ReviewCompletionEvidence {
  const paths = reviewRunPaths(input.source);
  const out = readBounded(paths.stdout);
  const err = readBounded(paths.stderr);

  const reading = out.oversize
    ? ({ kind: "NONE", reason: `the reviewer's output exceeds ${MAX_REVIEW_OUTPUT_BYTES} bytes and was not parsed` } as const)
    : strictReviewFinalMessage(input.provider, out.text);

  /**
   * A VERDICT NEEDS BOTH: a clean exit AND a valid structured final message.
   *
   * Exit 0 with malformed output publishes nothing, and a nonzero exit publishes
   * nothing whatever the output says — "PASS" printed by a process that died is
   * exactly the approval this must never manufacture.
   */
  const verdictPublished = input.exitCode === 0 && reading.kind === "FINAL";
  if (verdictPublished && reading.kind === "FINAL") {
    publishAtomically(input.source, reading.text);
  }

  const providerError = reading.kind === "PROVIDER_ERROR" ? boundedEvidence(reading.message) : undefined;
  const why = reading.kind === "FINAL" ? "" : `; ${reading.kind === "PROVIDER_ERROR" ? "provider reported an error" : reading.reason}`;
  const failure = verdictPublished
    ? ""
    : boundedEvidence(
        `exit ${input.exitCode}${why}; stderr: ${tail(err.text, MAX_FAILURE_EVIDENCE)}; stdout: ${tail(out.text, MAX_FAILURE_EVIDENCE)}`,
      );

  const evidence: ReviewCompletionEvidence = {
    runId: input.runId,
    exitCode: input.exitCode,
    failure,
    ...(providerError === undefined ? {} : { providerError }),
    verdictPublished,
    at: input.now,
  };
  // LAST, and atomically: its existence means the verdict decision is already made.
  publishAtomically(paths.completion, JSON.stringify(evidence));
  return evidence;
}

/**
 * Reads the completion of a recorded review, or reports that there is none.
 *
 * Fails towards NONE and UNUSABLE. A record naming another run is FOREIGN — a
 * previous attempt's file, or something else entirely — and adopting it would
 * settle this review from another one's outcome.
 */
export function readReviewCompletion(query: ReviewCompletionQuery): ReviewCompletionReading {
  const path = reviewRunPaths(query.source).completion;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "NONE" };
    }
    return { kind: "UNUSABLE", reason: `review completion could not be read: ${(error as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Torn or corrupt. Not success, and not permission to launch again.
    return { kind: "UNUSABLE", reason: "review completion is not parseable JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "UNUSABLE", reason: "review completion is not a JSON object" };
  }
  const row = parsed as Record<string, unknown>;
  const runId = row["runId"];
  const exitCode = row["exitCode"];
  const failure = row["failure"];
  const providerError = row["providerError"];
  const verdictPublished = row["verdictPublished"];
  const at = row["at"];
  if (
    typeof runId !== "string" ||
    typeof exitCode !== "number" ||
    !Number.isInteger(exitCode) ||
    typeof failure !== "string" ||
    typeof verdictPublished !== "boolean" ||
    typeof at !== "number" ||
    (providerError !== undefined && typeof providerError !== "string")
  ) {
    return { kind: "UNUSABLE", reason: "review completion is missing or mistyped required evidence" };
  }
  if (runId !== query.reviewId) {
    return {
      kind: "UNUSABLE",
      reason: `review completion names run ${JSON.stringify(runId)}, not ${JSON.stringify(query.reviewId)}`,
    };
  }
  return {
    kind: "COMPLETED",
    evidence: {
      runId,
      exitCode,
      // Re-bounded on the way IN as well as out: the file is written by a
      // process, and a process can be replaced.
      failure: boundedEvidence(failure),
      ...(providerError === undefined ? {} : { providerError: boundedEvidence(providerError) }),
      verdictPublished,
      at,
    },
  };
}

/**
 * Removes every artefact of a PREVIOUS attempt at the same run.
 *
 * A retry reuses the run id — it is derived from the request, not generated — so
 * it reuses these paths. An old `.run.rc`, log or completion left in place would
 * be read as this launch's outcome, which is the same lie by a longer route.
 * Throws rather than reporting: the caller must refuse to launch.
 */
export function clearReviewRunArtifacts(source: string): void {
  const paths = reviewRunPaths(source);
  for (const path of [paths.stdout, paths.stderr, paths.exitCode, paths.completion, paths.publisherLog]) {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
