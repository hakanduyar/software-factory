/**
 * `sf github task-create` — explicit operator command over the delivered
 * durable CREATE lifecycle (scripts/github/github-task-lifecycle.ps1), reached
 * only through the fixed stdin entrypoint scripts/github/invoke-github-task-create.ps1.
 *
 * What this is NOT. It holds no publication authority: the operator who types
 * it, with a real gh, is already authorized for the exact event they supply.
 * It infers no event, task, issue or worker state, runs no loop, and adds no
 * approval boolean. The repo and marker namespace are the existing engine's
 * ONLY supported configuration, not a generalized mapping.
 *
 * MAPPED means an observed durable mapping. It is not task DONE, acceptance,
 * completion or a dispatch grant. Process exit 0 alone is never success; the
 * engine's own `status` is validated and printed.
 */

import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { createNodeProcessRunner } from "../adapters/process/nodeProcessRunner.js";
import { GITHUB_CLI_ENVIRONMENT_POLICY } from "../adapters/github/ghCliClient.js";
import { buildWorkerEnvironment } from "../adapters/workers/environmentPolicy.js";
import type { ProcessRunner } from "../ports/processRunner.js";
import { boundedDiagnostic } from "../supervision/resourceClassifier.js";

export const TASK_CREATE_REPO = "hakanduyar/software-factory";
export const TASK_CREATE_MARKER_NAMESPACE = "factory-task";
export const TASK_CREATE_ENTRYPOINT_SEGMENTS: readonly string[] = Object.freeze([
  "scripts",
  "github",
  "invoke-github-task-create.ps1",
]);

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 64 * 1024; // data observation bound, not an author output cap
const MAX_ISSUE = 2_147_483_647;
// eslint-disable-next-line no-control-regex
const CONTROL_RX = /[\u0000-\u001f\u007f]/;
const SHA_RX = /^[0-9a-f]{64}$/;
const TASK_ID_RX = /^[A-Za-z0-9._:-]{1,128}$/;

export const TASK_CREATE_USAGE =
  "Usage: sf github task-create --event <abs-path> --repo hakanduyar/software-factory " +
  "--marker-namespace factory-task --state-dir <abs-path> --gh <abs-path> --gh-sha256 <64-hex> " +
  "--transport-temp-root <abs-dir> --pwsh <abs-path> --repository-root <abs-path>";

export const TASK_CREATE_HELP = `${TASK_CREATE_USAGE}

For an already-authorized operator only. When invoked with a real gh this
performs ACTUAL remote issue creation (find-before-create, then create and
read back) for the one GitHubCreateEvent/v1 file named by --event. Every flag
is required and may appear once. --repo and --marker-namespace accept only the
engine's single supported configuration. --gh is pinned by --gh-sha256.
--event and --pwsh must be ordinary non-symlink files; --transport-temp-root must be an
existing ordinary directory; --repository-root holds the fixed entrypoint.
The printed "outcome:" line carries the engine status; only MAPPED means an
observed durable mapping (not DONE, acceptance, completion or a dispatch
grant). MAPPED_NEEDS_UPDATE, UNKNOWN_SEND, REFUSED and LOCKED are distinct
non-success outcomes (non-zero exit). This command's own tests use no real
remote.`;

const FLAGS = [
  "--event",
  "--repo",
  "--marker-namespace",
  "--state-dir",
  "--gh",
  "--gh-sha256",
  "--transport-temp-root",
  "--pwsh",
  "--repository-root",
] as const;
type Flag = (typeof FLAGS)[number];

export interface GithubTaskCreateArgs {
  readonly eventPath: string;
  readonly repo: string;
  readonly markerNamespace: string;
  readonly stateDir: string;
  readonly ghPath: string;
  readonly ghSha256: string;
  readonly transportTempRoot: string;
  readonly pwshPath: string;
  readonly repositoryRoot: string;
}

function absolutePath(v: string): boolean {
  return v.length > 0 && v.length <= 4096 && isAbsolute(v) && !CONTROL_RX.test(v);
}

export function parseGithubTaskCreateArgs(
  args: readonly string[],
): { readonly ok: true; readonly value: GithubTaskCreateArgs } | { readonly ok: false; readonly error: string } {
  const seen = new Map<Flag, string>();
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    if (!(FLAGS as readonly string[]).includes(token)) return { ok: false, error: `unexpected argument ${JSON.stringify(token)}` };
    const flag = token as Flag;
    if (seen.has(flag)) return { ok: false, error: `duplicate option ${flag}` };
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) return { ok: false, error: `option ${flag} requires a value` };
    seen.set(flag, value);
    i += 1;
  }
  for (const flag of FLAGS) if (!seen.has(flag)) return { ok: false, error: `${flag} is required` };
  const get = (f: Flag): string => seen.get(f) as string;
  for (const f of ["--event", "--state-dir", "--gh", "--transport-temp-root", "--pwsh", "--repository-root"] as const) {
    if (!absolutePath(get(f))) return { ok: false, error: `${f} must be an absolute path` };
  }
  if (get("--repo") !== TASK_CREATE_REPO) return { ok: false, error: `--repo must be ${TASK_CREATE_REPO}` };
  if (get("--marker-namespace") !== TASK_CREATE_MARKER_NAMESPACE) {
    return { ok: false, error: `--marker-namespace must be ${TASK_CREATE_MARKER_NAMESPACE}` };
  }
  if (!SHA_RX.test(get("--gh-sha256"))) return { ok: false, error: "--gh-sha256 must be 64 lower-case hex characters" };
  return {
    ok: true,
    value: {
      eventPath: get("--event"),
      repo: get("--repo"),
      markerNamespace: get("--marker-namespace"),
      stateDir: get("--state-dir"),
      ghPath: get("--gh"),
      ghSha256: get("--gh-sha256"),
      transportTempRoot: get("--transport-temp-root"),
      pwshPath: get("--pwsh"),
      repositoryRoot: get("--repository-root"),
    },
  };
}

export type TaskCreateStatus = "REFUSED" | "LOCKED" | "UNKNOWN_SEND" | "MAPPED" | "MAPPED_NEEDS_UPDATE";

export interface TaskCreateMapping {
  readonly taskId: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly stableMarker: string;
}

export interface TaskCreateResult {
  readonly status: TaskCreateStatus;
  readonly code: string;
  readonly taskId: string | null;
  readonly eventKey: string | null;
  readonly attempt: number;
  readonly replay: boolean;
  readonly mapping?: TaskCreateMapping;
}

const REFUSED_CODES = new Set([
  "CONFIG_INVALID", "EVENT_MISSING", "EVENT_MALFORMED", "EVENT_KEYS_INVALID", "EVENT_FIELDS_INVALID",
  "PUBLIC_TEXT_TYPE", "PUBLIC_TEXT_LENGTH", "PUBLIC_TEXT_CHARACTERS", "PUBLIC_TEXT_CREDENTIAL_PATTERN",
  "STATE_CORRUPT", "STALE_VERSION", "DIGEST_CONFLICT", "SNAPSHOT_CHANGED", "LOOKUP_INCOMPLETE",
  "DUPLICATE_MATCH", "LOOKUP_INVALID", "AMBIGUOUS_NO_MATCH", "READ_FAILED", "READ_MISMATCH",
  "ISSUE_CLOSED", "UNEXPECTED_FAILURE",
]);
const CODES_BY_STATUS: Readonly<Record<TaskCreateStatus, ReadonlySet<string>>> = {
  REFUSED: REFUSED_CODES,
  LOCKED: new Set(["LOCKED"]),
  UNKNOWN_SEND: new Set(["CREATE_INVALID_RESPONSE", "CREATE_READBACK_FAILED", "SNAPSHOT_CHANGED", "CREATE_AMBIGUOUS"]),
  MAPPED: new Set(["CREATED", "VERSION_ADVANCED", "REPLAY", "ADOPTED"]),
  MAPPED_NEEDS_UPDATE: new Set(["NEEDS_UPDATE", "ADOPTED_NEEDS_UPDATE"]),
};

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function exactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
}

/** Strict shape/consistency check of the engine's ordinary result; undefined when anything is off. */
export function parseTaskCreateResult(raw: unknown): TaskCreateResult | undefined {
  if (!isPlain(raw)) return undefined;
  const base = ["status", "code", "taskId", "eventKey", "attempt", "replay"];
  const hasMapping = Object.hasOwn(raw, "mapping");
  if (!exactKeys(raw, hasMapping ? [...base, "mapping"] : base)) return undefined;
  const { status, code, taskId, eventKey, attempt, replay } = raw;
  if (typeof status !== "string" || !Object.hasOwn(CODES_BY_STATUS, status)) return undefined;
  const s = status as TaskCreateStatus;
  if (typeof code !== "string" || !CODES_BY_STATUS[s].has(code)) return undefined;
  if (taskId !== null && (typeof taskId !== "string" || !TASK_ID_RX.test(taskId))) return undefined;
  if (eventKey !== null && (typeof eventKey !== "string" || !SHA_RX.test(eventKey))) return undefined;
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 0) return undefined;
  if (typeof replay !== "boolean") return undefined;
  if (replay !== (s === "MAPPED" && code === "REPLAY")) return undefined;
  if (s !== "REFUSED" && (taskId === null || eventKey === null)) return undefined;
  if (s === "UNKNOWN_SEND" && attempt < 1) return undefined;
  const mapped = s === "MAPPED" || s === "MAPPED_NEEDS_UPDATE";
  if (mapped !== hasMapping) return undefined;
  if (!hasMapping) return { status: s, code, taskId, eventKey, attempt, replay };
  const m = raw["mapping"];
  if (!isPlain(m) || !exactKeys(m, ["taskId", "repo", "issueNumber", "stableMarker"])) return undefined;
  const n = m["issueNumber"];
  if (
    m["taskId"] !== taskId || m["repo"] !== TASK_CREATE_REPO ||
    typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > MAX_ISSUE ||
    typeof taskId !== "string" ||
    m["stableMarker"] !== `${TASK_CREATE_MARKER_NAMESPACE}-${createHash("sha256").update(taskId, "utf8").digest("hex")}`
  ) {
    return undefined;
  }
  return {
    status: s, code, taskId, eventKey, attempt, replay,
    mapping: { taskId, repo: TASK_CREATE_REPO, issueNumber: n, stableMarker: m["stableMarker"] as string },
  };
}

export interface GithubTaskCreateOptions {
  readonly log?: (line: string) => void;
  readonly error?: (line: string) => void;
  /** Test seam only; main.ts never passes it. Defaults to the existing NodeProcessRunner. */
  readonly processRunner?: ProcessRunner;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

/** Exit codes: 0 MAPPED; 1 prerequisite refused before any process; 2 MAPPED_NEEDS_UPDATE; 3 LOCKED; 4 UNKNOWN_SEND; 5 REFUSED; 6 process failure. */
export async function runGithubTaskCreate(
  args: GithubTaskCreateArgs,
  options: GithubTaskCreateOptions = {},
): Promise<number> {
  const log = options.log ?? ((): void => {});
  const error = options.error ?? ((): void => {});
  const refuse = (message: string): number => {
    error(`outcome: PRECHECK_REFUSED — ${message}`);
    return 1;
  };

  const entrypoint = join(args.repositoryRoot, ...TASK_CREATE_ENTRYPOINT_SEGMENTS);
  try {
    if (!lstatSync(args.eventPath).isFile()) return refuse("--event is not an ordinary non-symlink file");
  } catch {
    return refuse("--event does not exist");
  }
  try {
    if (!lstatSync(args.transportTempRoot).isDirectory()) return refuse("--transport-temp-root is not an ordinary directory");
  } catch {
    return refuse("--transport-temp-root does not exist");
  }
  try {
    if (!lstatSync(entrypoint).isFile()) return refuse("fixed entrypoint is not an ordinary file under --repository-root");
  } catch {
    return refuse("fixed entrypoint missing under --repository-root");
  }
  try {
    if (!lstatSync(args.pwshPath).isFile()) return refuse("--pwsh is not an ordinary non-symlink executable file");
    accessSync(args.pwshPath, constants.X_OK);
  } catch {
    return refuse("--pwsh is not an existing executable");
  }

  const envelope = JSON.stringify({
    eventPath: args.eventPath,
    configuration: { repo: args.repo, markerNamespace: args.markerNamespace },
    stateDir: args.stateDir,
    ghPath: args.ghPath,
    expectedGhSha256: args.ghSha256,
    tempRoot: args.transportTempRoot,
  });

  const failure = (reason: string, exitCode: number | null, detail?: string): number => {
    const safe = detail !== undefined && /^[A-Z][A-Z_]{2,39}$/.test(detail) ? ` detail=${detail}` : "";
    error(
      boundedDiagnostic(
        `outcome: PROCESS_FAILURE reason=${reason} exitCode=${exitCode ?? "none"}${safe} (remote creation state unknown; re-run the same event to reconcile)`,
      ),
    );
    return 6;
  };

  let res;
  try {
    res = await (options.processRunner ?? createNodeProcessRunner()).run({
      executable: args.pwshPath,
      argv: ["-NoProfile", "-NonInteractive", "-File", entrypoint],
      cwd: args.repositoryRoot,
      env: buildWorkerEnvironment(GITHUB_CLI_ENVIRONMENT_POLICY, options.env ?? process.env),
      input: envelope,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
  } catch {
    return failure("SPAWN_ERROR", null);
  }
  if (res.terminationReason === "TIMEOUT") return failure("TIMEOUT", res.exitCode);
  if (res.terminationReason === "CANCELLED") return failure("CANCELLED", res.exitCode);
  if (res.terminationReason === "SPAWN_ERROR") return failure("SPAWN_ERROR", null);
  if (res.exitCode !== 0) return failure("EXIT_NONZERO", res.exitCode, res.stderr.trim());
  if (res.stdoutTruncated || res.stderrTruncated) return failure("OUTPUT_TRUNCATED", res.exitCode);

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout.endsWith("\n") ? res.stdout.slice(0, -1) : res.stdout);
  } catch {
    return failure("RESULT_UNPARSEABLE", res.exitCode);
  }
  const r = parseTaskCreateResult(parsed);
  if (r === undefined) return failure("RESULT_INVALID", res.exitCode);

  const line =
    `outcome: ${r.status} code=${r.code} taskId=${r.taskId ?? "none"} attempt=${r.attempt} replay=${r.replay}` +
    (r.mapping === undefined ? "" : ` issue=${r.mapping.repo}#${r.mapping.issueNumber} marker=${r.mapping.stableMarker}`) +
    " (not task DONE or acceptance; no dispatch grant)";
  if (r.status === "MAPPED") {
    log(line);
    return 0;
  }
  error(line);
  return r.status === "MAPPED_NEEDS_UPDATE" ? 2 : r.status === "LOCKED" ? 3 : r.status === "UNKNOWN_SEND" ? 4 : 5;
}
