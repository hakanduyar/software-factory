/**
 * The bounded, redacted, atomic terminal artifact a worker run leaves behind
 * (DEFECT-DURABLE-WORKER-RUN-ENVELOPE AC-5).
 *
 * WHY A SEPARATE FILE FROM `reviewCompletion.ts`. That module publishes what a
 * REVIEWER left behind — a verdict candidate plus completion evidence, written
 * by the reviewer's own wrapper script after it exits. This artifact belongs to
 * any worker run this repository's own process spawned directly (through
 * `ProcessRunner`), and it is written by THIS process, synchronously, the
 * moment a spawn settles — exit 0, nonzero, signal, timeout, spawn error or a
 * caught wrapper exception all go through the same call. There is no detached
 * shell wrapper here to publish anything after the fact, so nothing needed one.
 *
 * WHY THE HASH IS RECOMPUTED ON EVERY READ, NEVER TRUSTED FROM THE CALLER. A
 * `WorkerRunEnvelope.artifact` records a path and a hash, but the hash a reader
 * trusts is the one it computes itself from the bytes it just read — comparing
 * that against what the durable record expects is what turns "a file exists at
 * this path" into "this is provably the same artifact the run wrote", and what
 * makes a torn write (a crash mid-`writeFileSync`) or a foreign file (another
 * run's artifact copied or symlinked into this path) an INTEGRITY ERROR rather
 * than a silently accepted result.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { boundedDiagnostic } from "../../supervision/resourceClassifier.js";
import { canonicalWorkerRunId, type WorkerRunTerminalReason } from "../../supervision/workerRunEnvelope.js";
import { PROCESS_TERMINATION_REASONS } from "../../ports/processRunner.js";

/** How much of a run's own diagnostic text becomes part of the artifact. */
export const MAX_ARTIFACT_DETAIL_CHARS = 4_096;

export interface WorkerRunArtifactData {
  readonly runId: string;
  readonly actionId: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly terminationReason: string;
  readonly providerSessionId?: string;
  readonly terminalReason?: WorkerRunTerminalReason;
  readonly detail: string;
  readonly at: number;
}

export interface WrittenWorkerRunArtifact {
  readonly path: string;
  readonly hash: string;
}

function boundedDetail(text: string): string {
  // `boundedDiagnostic` already redacts and bounds to `MAX_DIAGNOSTIC_LENGTH`;
  // this is a second, tighter cap specific to what this artifact stores.
  return boundedDiagnostic(text).slice(0, MAX_ARTIFACT_DETAIL_CHARS);
}

/** Deterministic regardless of key insertion order, so the hash is a function of content alone. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (nested === null || typeof nested !== "object" || Array.isArray(nested)) {
      return nested;
    }
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(nested as Record<string, unknown>).sort()) {
      ordered[key] = (nested as Record<string, unknown>)[key];
    }
    return ordered;
  });
}

function digestOf(data: WorkerRunArtifactData): string {
  return createHash("sha256").update(canonicalJson(data)).digest("hex");
}

/** Where one run's artifact lives, given a directory the caller owns. */
export function workerRunArtifactPath(directory: string, runId: string): string {
  return `${directory}/${encodeURIComponent(runId)}.json`;
}

/**
 * Writes the artifact atomically (write-then-rename), so a reader either sees
 * nothing or the whole thing — never half a JSON object.
 *
 * `detail` is bounded and redacted BEFORE it is hashed, exactly as the write
 * path everywhere else in this repository does: hashing raw text and redacting
 * afterwards would make every sanitized artifact fail its own integrity check.
 */
export function writeWorkerRunArtifact(
  path: string,
  input: {
    readonly runId: string;
    readonly actionId: string;
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly terminationReason: string;
    readonly providerSessionId?: string;
    readonly terminalReason?: WorkerRunTerminalReason;
    readonly detail: string;
    readonly at: number;
  },
): WrittenWorkerRunArtifact {
  const data: WorkerRunArtifactData = {
    runId: input.runId,
    actionId: input.actionId,
    exitCode: input.exitCode,
    signal: input.signal,
    terminationReason: input.terminationReason,
    ...(input.providerSessionId === undefined ? {} : { providerSessionId: input.providerSessionId }),
    ...(input.terminalReason === undefined ? {} : { terminalReason: input.terminalReason }),
    detail: boundedDetail(input.detail),
    at: input.at,
  };
  const hash = digestOf(data);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify({ data, hash }), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  return { path, hash };
}

export type WorkerRunArtifactReading =
  | { readonly kind: "NONE" }
  | { readonly kind: "UNUSABLE"; readonly reason: string }
  | { readonly kind: "FOUND"; readonly data: WorkerRunArtifactData; readonly hash: string };

/**
 * Reads an artifact back, verifying it is the SAME artifact the run wrote and
 * that it names the run the caller is asking about.
 *
 * Fails towards `NONE` (nothing written yet — the run may still be in
 * progress) and `UNUSABLE` (something is there and cannot be trusted: torn
 * JSON, a recomputed hash that disagrees with the one stored beside the data,
 * or a `runId` naming a different run). Neither is ever treated as a
 * completion, and neither is ever permission to launch a second worker.
 */
export function readWorkerRunArtifact(
  path: string, expectedRunId: string,
  expectedActionId: string = expectedRunId.endsWith(":wr1") ? expectedRunId.slice(0, -4) : "",
  expectedHash?: string,
): WorkerRunArtifactReading {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "NONE" };
    }
    return { kind: "UNUSABLE", reason: `worker run artifact could not be read: ${(error as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "UNUSABLE", reason: "worker run artifact is not parseable JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "UNUSABLE", reason: "worker run artifact is not a JSON object" };
  }
  const row = parsed as Record<string, unknown>;
  const dataRaw = row["data"];
  const hashRaw = row["hash"];
  if (typeof hashRaw !== "string" || typeof dataRaw !== "object" || dataRaw === null || Array.isArray(dataRaw)) {
    return { kind: "UNUSABLE", reason: "worker run artifact is missing its data or hash" };
  }
  const dataRow = dataRaw as Record<string, unknown>;
  const runId = dataRow["runId"];
  const actionId = dataRow["actionId"];
  const exitCode = dataRow["exitCode"];
  const signal = dataRow["signal"];
  const terminationReason = dataRow["terminationReason"];
  const detail = dataRow["detail"];
  const at = dataRow["at"];
  const providerSessionId = dataRow["providerSessionId"];
  const terminalReason = dataRow["terminalReason"];
  if (
    typeof runId !== "string" ||
    typeof actionId !== "string" ||
    (exitCode !== null && (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode) || exitCode < 0)) ||
    (signal !== null && (typeof signal !== "string" || !/^SIG[A-Z0-9]+$/.test(signal))) ||
    typeof terminationReason !== "string" ||
    ![...PROCESS_TERMINATION_REASONS, "WRAPPER_ERROR"].includes(terminationReason) ||
    typeof detail !== "string" ||
    typeof at !== "number" || !Number.isSafeInteger(at) || at < 0 ||
    typeof detail === "string" && detail.length > MAX_ARTIFACT_DETAIL_CHARS ||
    (providerSessionId !== undefined && (typeof providerSessionId !== "string" || providerSessionId.length === 0 || providerSessionId.length > 256)) ||
    (terminalReason !== undefined && terminalReason !== "MAX_TURNS")
  ) {
    return { kind: "UNUSABLE", reason: "worker run artifact is missing or mistyped required fields" };
  }
  const data: WorkerRunArtifactData = {
    runId,
    actionId,
    exitCode,
    signal,
    terminationReason,
    ...(providerSessionId === undefined ? {} : { providerSessionId }),
    ...(terminalReason === undefined ? {} : { terminalReason: "MAX_TURNS" as const }),
    detail,
    at,
  };

  const recomputed = digestOf(data);
  if (recomputed !== hashRaw) {
    // A TORN OR TAMPERED WRITE. The bytes on disk do not match their own
    // recorded digest, so nothing here can say what the run actually reported.
    return { kind: "UNUSABLE", reason: "worker run artifact hash does not match its own recorded content" };
  }
  if (runId !== expectedRunId || actionId !== expectedActionId ||
      expectedActionId.length === 0 || runId !== canonicalWorkerRunId(actionId) ||
      (expectedHash !== undefined && expectedHash !== recomputed)) {
    // A FOREIGN ARTIFACT: some other run's file at this path.
    return { kind: "UNUSABLE", reason: `worker run artifact names run ${JSON.stringify(runId)}, not ${JSON.stringify(expectedRunId)}` };
  }
  return { kind: "FOUND", data, hash: recomputed };
}
