/**
 * Explicit, trusted-operator consumer of `projectWorkItemStatus`: selects the
 * public (status, next action) pair, then hands strict DATA to the fixed
 * PowerShell entrypoint scripts/github/invoke-projected-task-status.ps1, which
 * calls the existing durable engine (sync-github-task-status.ps1) unchanged.
 *
 * WHAT THIS IS NOT. It is not automatic supervisor publication, and it holds
 * no authority of its own. The CALLER must already be authorized to publish
 * status for the exact mapping it supplies. The existing CREATE_PULL_REQUEST
 * RemoteWriteAuthorization is kind- and target-specific and is deliberately
 * NOT reinterpreted here; no boolean "authorized" flag exists in this API. A
 * status-action authorization for automatic publication is a separate,
 * still-missing prerequisite. GitHub status text, including
 * RESUME_AUTHORIZED_WORK, is display vocabulary and never launch authority.
 *
 * Structural identity checks below (mapping.taskId === projected taskId, the
 * typed mapping grammar) do not authenticate the DONE acceptance/delivery
 * facts: those remain caller-authenticated inputs to the projector.
 *
 * Exit code 0 never means DELIVERED. Only a validated durable-engine result
 * whose own `status` is DELIVERED is reported as delivered; OS termination,
 * non-zero exit, truncation and parse failure are separate, explicit outcomes.
 */

import { isAbsolute, join } from "node:path";

import { buildWorkerEnvironment, redactSecrets } from "../workers/environmentPolicy.js";
import { GITHUB_CLI_ENVIRONMENT_POLICY } from "./ghCliClient.js";
import { boundedDiagnostic } from "../../supervision/resourceClassifier.js";
import { projectWorkItemStatus } from "./workItemStatusProjection.js";
import type {
  NextAction,
  PublicStatus,
  RefusalCode,
  StatusProjectionInput,
} from "./workItemStatusProjection.js";
import type { WorkItemStatus } from "../../domain/status.js";
import type { ProcessRunner } from "../../ports/processRunner.js";

/** Same grammar as the durable engine's mapping validation. */
export interface StatusSyncMapping {
  readonly taskId: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly stableMarker: string;
}

export interface StatusSyncRequest {
  readonly projectionInput: StatusProjectionInput;
  /** Absolute path; data only, never shell syntax. */
  readonly checkpointPath: string;
  readonly mapping: StatusSyncMapping;
  /** Absolute path of the durable engine's state directory. */
  readonly stateDir: string;
}

export interface StatusSyncDeps {
  readonly processRunner: ProcessRunner;
  /** Trusted absolute path to pwsh (>= 7.6). */
  readonly pwshPath: string;
  /** Trusted absolute repository checkout root; the entrypoint is a fixed relative literal beneath it. */
  readonly repositoryRoot: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
  /** Source for the filtered child environment; defaults to process.env. GH_TOKEN/GITHUB_TOKEN are never forwarded. */
  readonly env?: NodeJS.ProcessEnv;
}

export const DURABLE_SYNC_STATUSES = ["DELIVERED", "PENDING", "REFUSED", "LOCKED", "STALE"] as const;
export type DurableSyncStatus = (typeof DURABLE_SYNC_STATUSES)[number];

/** The durable engine's ordinary result, after shape validation. */
export interface DurableSyncResult {
  readonly status: DurableSyncStatus;
  readonly code: string;
  readonly key: string | null;
  readonly taskId: string | null;
  readonly attempt: number;
  readonly replay: boolean;
}

export type StatusSyncRequestInvalidCode =
  | "REQUEST_MALFORMED"
  | "MAPPING_INVALID"
  | "MAPPING_TASK_MISMATCH"
  | "PATH_INVALID"
  | "DEPENDENCY_INVALID";

export type StatusSyncProcessFailureReason =
  | "SPAWN_ERROR"
  | "TIMEOUT"
  | "CANCELLED"
  | "EXIT_NONZERO"
  | "OUTPUT_TRUNCATED"
  | "RESULT_UNPARSEABLE"
  | "RESULT_INVALID";

export type StatusSyncOutcome =
  | { readonly kind: "PROJECTION_REFUSED"; readonly code: RefusalCode }
  | { readonly kind: "NOT_PUBLISHABLE"; readonly status: WorkItemStatus }
  | { readonly kind: "REQUEST_INVALID"; readonly code: StatusSyncRequestInvalidCode }
  | {
      readonly kind: "PROCESS_FAILURE";
      readonly reason: StatusSyncProcessFailureReason;
      readonly exitCode: number | null;
      /** Bounded and redacted; never contains the envelope, checkpoint contents or environment. */
      readonly diagnostic: string;
    }
  | {
      readonly kind: "SYNC_RESULT";
      readonly publicStatus: PublicStatus;
      readonly nextAction: NextAction;
      readonly result: DurableSyncResult;
    };

export const STATUS_SYNC_ENTRYPOINT_SEGMENTS: readonly string[] = Object.freeze([
  "scripts",
  "github",
  "invoke-projected-task-status.ps1",
]);

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_PATH_LENGTH = 4096;

const TASK_ID_RX = /^[A-Za-z0-9._:-]{1,128}$/;
const REPO_RX = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const MARKER_RX = /^[A-Za-z0-9._-]{1,128}$/;
const KEY_RX = /^[0-9a-f]{64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RX = /[\u0000-\u001f\u007f]/;
const LONE_SURROGATE_RX = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const MAPPING_KEYS = ["taskId", "repo", "issueNumber", "stableMarker"] as const;

/** Result codes the unchanged durable engine can emit, per status. */
const CODES_BY_STATUS: Readonly<Record<DurableSyncStatus, ReadonlySet<string>>> = {
  DELIVERED: new Set(["OK", "RECONCILED", "REPLAY"]),
  PENDING: new Set(["WRITE_FAILED", "CHECKPOINT_CHANGED", "READBACK_FAILED", "READBACK_MISMATCH"]),
  LOCKED: new Set(["LOCKED"]),
  STALE: new Set(["STALE"]),
  REFUSED: new Set([
    "MAPPING_INVALID",
    "PATH_COLLISION",
    "CHECKPOINT_MISSING",
    "CHECKPOINT_MALFORMED",
    "CHECKPOINT_FIELDS_INVALID",
    "CHECKPOINT_TIMESTAMP_INVALID",
    "TASK_MISMATCH",
    "STATE_CORRUPT",
    "AMBIGUOUS_SAME_UPDATEDAT",
    "READ_FAILED",
    "DESTINATION_MISMATCH",
    "ISSUE_CLOSED",
    "MARKER_MISSING",
    "CHECKPOINT_CHANGED",
    "REGION_MALFORMED",
    "UNEXPECTED_FAILURE",
  ]),
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function ownKeysExactly(obj: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(obj);
  return keys.length === expected.length && expected.every((k) => Object.hasOwn(obj, k));
}

function validMapping(v: unknown): v is StatusSyncMapping {
  if (!isPlainObject(v) || !ownKeysExactly(v, MAPPING_KEYS)) return false;
  const n = v["issueNumber"];
  return (
    typeof v["taskId"] === "string" && TASK_ID_RX.test(v["taskId"]) &&
    typeof v["repo"] === "string" && REPO_RX.test(v["repo"]) &&
    typeof n === "number" && Number.isSafeInteger(n) && n >= 1 && n <= 2_147_483_647 &&
    typeof v["stableMarker"] === "string" && MARKER_RX.test(v["stableMarker"])
  );
}

function validPath(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= MAX_PATH_LENGTH &&
    isAbsolute(v) &&
    !CONTROL_RX.test(v) &&
    !LONE_SURROGATE_RX.test(v)
  );
}

function validDeps(d: unknown): d is StatusSyncDeps {
  if (!isPlainObject(d)) return false;
  const runner = d["processRunner"] as { run?: unknown } | undefined;
  const t = d["timeoutMs"];
  return (
    isPlainObject(runner) && typeof runner.run === "function" &&
    validPath(d["pwshPath"]) && validPath(d["repositoryRoot"]) && validPath(d["cwd"]) &&
    (t === undefined || (typeof t === "number" && Number.isSafeInteger(t) && t >= 1 && t <= MAX_TIMEOUT_MS))
  );
}

const diagnostic = (text: string): string => redactSecrets(boundedDiagnostic(text));

const failure = (
  reason: StatusSyncProcessFailureReason,
  exitCode: number | null,
  text: string,
): StatusSyncOutcome => ({ kind: "PROCESS_FAILURE", reason, exitCode, diagnostic: diagnostic(text) });

/**
 * Shape- and association-checks the engine's ordinary result. Anything outside
 * the exact six-field contract is RESULT_INVALID, never coerced into a status.
 */
function parseDurableResult(raw: unknown, intendedTaskId: string): DurableSyncResult | undefined {
  if (!isPlainObject(raw) || !ownKeysExactly(raw, ["status", "code", "key", "taskId", "attempt", "replay"])) {
    return undefined;
  }
  const { status, code, key, taskId, attempt, replay } = raw;
  if (typeof status !== "string" || !(DURABLE_SYNC_STATUSES as readonly string[]).includes(status)) return undefined;
  const s = status as DurableSyncStatus;
  if (typeof code !== "string" || !CODES_BY_STATUS[s].has(code)) return undefined;
  if (key !== null && (typeof key !== "string" || !KEY_RX.test(key))) return undefined;
  if (taskId !== null && taskId !== intendedTaskId) return undefined;
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 0) return undefined;
  if (typeof replay !== "boolean") return undefined;
  // Everything except an early REFUSED has already derived key and task from the checkpoint/mapping.
  if (s !== "REFUSED" && (key === null || taskId === null)) return undefined;
  if (replay !== (s === "DELIVERED" && code === "REPLAY")) return undefined;
  if ((s === "PENDING" || (s === "DELIVERED" && code === "OK")) && attempt < 1) return undefined;
  return { status: s, code, key, taskId, attempt, replay };
}

export async function syncWorkItemStatus(
  request: StatusSyncRequest,
  deps: StatusSyncDeps,
): Promise<StatusSyncOutcome> {
  if (!isPlainObject(request)) return { kind: "REQUEST_INVALID", code: "REQUEST_MALFORMED" };

  // 1. Projection first: REFUSED / NOT_PUBLISHABLE never reach a process.
  const projection = projectWorkItemStatus(request.projectionInput);
  if (projection.kind === "REFUSED") return { kind: "PROJECTION_REFUSED", code: projection.code };
  if (projection.kind === "NOT_PUBLISHABLE") return { kind: "NOT_PUBLISHABLE", status: projection.status };

  // 2. Explicit mapping: typed grammar, identity equal to the projected task.
  if (!validMapping(request.mapping)) return { kind: "REQUEST_INVALID", code: "MAPPING_INVALID" };
  if (request.mapping.taskId !== request.projectionInput.taskId) {
    return { kind: "REQUEST_INVALID", code: "MAPPING_TASK_MISMATCH" };
  }
  if (!validPath(request.checkpointPath) || !validPath(request.stateDir)) {
    return { kind: "REQUEST_INVALID", code: "PATH_INVALID" };
  }
  if (!validDeps(deps)) return { kind: "REQUEST_INVALID", code: "DEPENDENCY_INVALID" };

  const { publicStatus, nextAction } = projection;
  const { taskId, repo, issueNumber, stableMarker } = request.mapping;
  // Exactly five data fields; public status only. No projector input, evidence or run identity.
  const envelope = JSON.stringify({
    checkpointPath: request.checkpointPath,
    mapping: { taskId, repo, issueNumber, stableMarker },
    stateDir: request.stateDir,
    publicStatus,
    nextAction,
  });

  let result;
  try {
    result = await deps.processRunner.run({
      executable: deps.pwshPath,
      argv: ["-NoProfile", "-File", join(deps.repositoryRoot, ...STATUS_SYNC_ENTRYPOINT_SEGMENTS)],
      cwd: deps.cwd,
      env: buildWorkerEnvironment(GITHUB_CLI_ENVIRONMENT_POLICY, deps.env ?? process.env),
      input: envelope,
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
  } catch {
    return failure("SPAWN_ERROR", null, "process runner rejected");
  }

  if (result.terminationReason === "TIMEOUT") return failure("TIMEOUT", result.exitCode, result.stderr);
  if (result.terminationReason === "CANCELLED") return failure("CANCELLED", result.exitCode, result.stderr);
  if (result.terminationReason === "SPAWN_ERROR") {
    return failure("SPAWN_ERROR", null, result.spawnError ?? "spawn failed");
  }
  if (result.exitCode !== 0) {
    return failure("EXIT_NONZERO", result.exitCode, result.stderr.length > 0 ? result.stderr : result.stdout);
  }
  if (result.stdoutTruncated || result.stderrTruncated) {
    return failure("OUTPUT_TRUNCATED", result.exitCode, "output exceeded the capture bound");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout);
  } catch {
    return failure("RESULT_UNPARSEABLE", result.exitCode, "stdout was not one JSON value");
  }
  const durable = parseDurableResult(parsed, taskId);
  if (durable === undefined) {
    return failure("RESULT_INVALID", result.exitCode, "result did not match the durable sync contract");
  }
  return { kind: "SYNC_RESULT", publicStatus, nextAction, result: durable };
}
