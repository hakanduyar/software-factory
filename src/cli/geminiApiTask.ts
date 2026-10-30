/**
 * `sf gemini-api task` — one explicit, operator-driven ANALYST request through
 * the existing Gemini API worker (`createGeminiApiWorker`).
 *
 * What it is: a strict parser plus a runner that makes ONE WorkerRequest and
 * writes the whole redacted WorkerOutcome (summary, evidence, usage semantics
 * as the adapter reports them) into a fresh directory.
 *
 * What it is not: no default model, no key/model/endpoint discovery, no retry,
 * fallback, tools, loop routing, acceptance, DONE or approval
 * (claimsAcceptanceMet stays false). A credential REFERENCE (environment
 * variable name) is not eligibility: it grants no billing, project, quota or
 * free-tier standing. The real credential resolver and the real HTTP transport
 * are supplied by the operator host through `GeminiApiTaskDeps.host`. The
 * ordinary CLI supplies none, so it refuses with CONFIGURATION_REQUIRED before
 * any credential or network access.
 */

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { GEMINI_API_ORIGIN, createGeminiApiWorker, validateGeminiApiModel, type GeminiApiTransport } from "../adapters/workers/geminiApiAdapter.js";
import { redactSecrets } from "../adapters/workers/environmentPolicy.js";
import { resolveWorkspace, type Workspace } from "../adapters/workers/workspace.js";
import { createRandomIdGenerator } from "../domain/ids.js";
import type { WorkerOutcome, WorkerRequest } from "../ports/worker.js";
import { boundedDiagnostic } from "../supervision/resourceClassifier.js";

const CONTROL_RX = /[\u0000-\u001f\u007f]/;
const MAX_PATH = 4096;
const MAX_MODEL = 256;
const ENV_NAME_RX = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const GEMINI_API_TASK_USAGE =
  "Usage: sf gemini-api task --model <gemini-model> --task-file <abs-path> --workspace <abs-path> " +
  "--output-dir <fresh-abs-path> --credential-env <ENV_VAR_NAME>";

export const GEMINI_API_TASK_HELP = `${GEMINI_API_TASK_USAGE}

Makes ONE explicit ANALYST request through the Gemini API worker and writes the
whole redacted worker outcome into a NEW directory. Every flag is required and
may appear once; there are no defaults, retries, fallbacks, tools or endpoint
overrides.
  --model          exact Gemini model id (one path segment; never defaulted)
  --task-file      UTF-8 file whose content becomes the request instructions
  --workspace      existing directory inside a real Git repository (validated
                   only; the model receives no files or tools)
  --output-dir     must not exist; its parent must exist and no ancestor may be a
                   symlink; created exclusively and never overwritten
  --credential-env NAME of an environment variable holding the key. Only the
                   name is accepted; a key is never an argument and never printed
This command is NOT eligibility. It does not verify project, billing, free-tier
standing, privacy or the key, and a flag grants none of them. The operator host
must inject the credential resolver and the HTTP transport. Without that host
configuration (the ordinary CLI) it exits 1 with "outcome: CONFIGURATION_REQUIRED"
before any credential or network access (${GEMINI_API_ORIGIN} is not contacted).
Result: <output-dir>/result.json (schema sf.gemini-api-task.result/v1) holds the
redacted outcome (status, summary, evidence incl. usage as REPORTED/UNKNOWN/
INVALID, claimsAcceptanceMet=false), a task-file sha256 and the credential
variable NAME. Nothing is accepted and no work item is advanced.
Exit 0: request succeeded; 1: refused before any request; 2: request failed
(outcome preserved, not retried); 3: error after output creation.
Read the "outcome:" line.`;

const FLAGS = ["--model", "--task-file", "--workspace", "--output-dir", "--credential-env"] as const;
type Flag = (typeof FLAGS)[number];

export interface GeminiApiTaskArgs {
  readonly model: string;
  readonly taskFile: string;
  readonly workspace: string;
  readonly outputDir: string;
  readonly credentialEnv: string;
}

function absolutePath(v: string): boolean {
  return v.length > 0 && v.length <= MAX_PATH && isAbsolute(v) && !CONTROL_RX.test(v) && resolve(v) === v;
}

export function parseGeminiApiTaskArgs(
  args: readonly string[],
): { readonly ok: true; readonly value: GeminiApiTaskArgs } | { readonly ok: false; readonly error: string } {
  const seen = new Map<Flag, string>();
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    if (!(FLAGS as readonly string[]).includes(token)) {
      return { ok: false, error: `unexpected argument ${JSON.stringify(boundedDiagnostic(token).slice(0, 64))}` };
    }
    const flag = token as Flag;
    if (seen.has(flag)) return { ok: false, error: `duplicate option ${flag}` };
    const value = args[i + 1];
    if (value === undefined || value.startsWith("-")) return { ok: false, error: `option ${flag} requires a value` };
    seen.set(flag, value);
    i += 1;
  }
  for (const flag of FLAGS) {
    if (!seen.has(flag)) return { ok: false, error: `${flag} is required` };
  }
  const get = (f: Flag): string => seen.get(f) as string;
  const model = get("--model");
  const modelProblem = validateGeminiApiModel(model);
  if (modelProblem !== undefined) return { ok: false, error: `--model: ${modelProblem}` };
  if (model.length > MAX_MODEL) return { ok: false, error: "--model is too long" };
  for (const f of ["--task-file", "--workspace", "--output-dir"] as const) {
    if (!absolutePath(get(f))) return { ok: false, error: `${f} must be a normalized absolute path` };
  }
  const credentialEnv = get("--credential-env");
  if (!ENV_NAME_RX.test(credentialEnv)) {
    return { ok: false, error: "--credential-env must be an environment variable NAME (letters, digits, underscore), never a key" };
  }
  return {
    ok: true,
    value: {
      model,
      taskFile: get("--task-file"),
      workspace: get("--workspace"),
      outputDir: get("--output-dir"),
      credentialEnv,
    },
  };
}

// ---------------------------------------------------------------- run

/** Operator-host supplied I/O. Absent for the ordinary CLI, by design. */
export interface GeminiApiHostConfig {
  /** Resolves the secret for a variable NAME. Called only inside the admitted worker request. */
  readonly resolveCredential: (envName: string) => string | undefined | Promise<string | undefined>;
  /** The explicitly admitted transport that performs the real I/O. */
  readonly transport: GeminiApiTransport;
}

export interface GeminiApiTaskDeps {
  readonly log?: (line: string) => void;
  readonly error?: (line: string) => void;
  /** Never reachable from a CLI flag; the operator host injects it. */
  readonly host?: GeminiApiHostConfig;
}

class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message);
}

function isSymlinkOrNotDir(path: string): "ok" | "symlink" | "notdir" | "missing" {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return "symlink";
    return st.isDirectory() ? "ok" : "notdir";
  } catch {
    return "missing";
  }
}

/**
 * Input path must be an ordinary `want` (file or directory): no symlink or
 * junction at the leaf or at any ancestor, and every ancestor a directory.
 * Uses lstat only, so nothing is followed and nothing is created.
 */
function checkOrdinaryInput(path: string, want: "file" | "dir", label: string): void {
  let leaf: Stats;
  try {
    leaf = lstatSync(path);
  } catch {
    refuse(`${label} does not exist`);
  }
  if (leaf.isSymbolicLink()) refuse(`${label} is a symlink/reparse point`);
  if (want === "file" ? !leaf.isFile() : !leaf.isDirectory()) {
    refuse(`${label} is not an ordinary ${want === "file" ? "file" : "directory"}`);
  }
  let current = dirname(path);
  for (;;) {
    const state = isSymlinkOrNotDir(current);
    if (state === "missing") refuse(`${label} has an inaccessible ancestor`);
    if (state === "symlink") refuse(`${label} has a symlink/reparse ancestor`);
    if (state === "notdir") refuse(`${label} has a non-directory ancestor`);
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
}

function checkOutputPath(outputDir: string): void {
  try {
    lstatSync(outputDir);
    refuse("--output-dir already exists");
  } catch (e) {
    if (e instanceof Refusal) throw e;
  }
  let current = dirname(outputDir);
  for (;;) {
    const state = isSymlinkOrNotDir(current);
    if (state === "missing") refuse("--output-dir parent does not exist");
    if (state === "symlink") refuse("--output-dir has a symlink/reparse ancestor");
    if (state === "notdir") refuse("--output-dir has a non-directory ancestor");
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
}

function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}

/** Exit codes: 0 request succeeded; 1 refused before any request; 2 request failed; 3 error after output creation. */
export async function runGeminiApiTask(args: GeminiApiTaskArgs, deps: GeminiApiTaskDeps = {}): Promise<number> {
  const log = deps.log ?? ((): void => {});
  const error = deps.error ?? ((): void => {});
  const host = deps.host;

  if (host === undefined || typeof host.resolveCredential !== "function" || typeof host.transport !== "function") {
    error(
      "outcome: CONFIGURATION_REQUIRED — no operator-host credential resolver and admitted Gemini API transport are configured; " +
        "no credential was read and no request was sent",
    );
    return 1;
  }

  let key: string | undefined;
  const scrub = (text: string): string => {
    let t = text;
    if (key !== undefined) {
      t = t.split(key).join("[REDACTED]");
      const escaped = JSON.stringify(key).slice(1, -1);
      if (escaped !== key) t = t.split(escaped).join("[REDACTED]");
    }
    return redactSecrets(t);
  };

  let taskText: string;
  let taskBytes: Buffer;
  let workspace: Workspace;
  let worker: ReturnType<typeof createGeminiApiWorker>;
  try {
    try {
      checkOrdinaryInput(args.taskFile, "file", "--task-file");
      taskBytes = readFileSync(args.taskFile);
      taskText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(taskBytes);
    } catch (e) {
      if (e instanceof Refusal) throw e;
      refuse("--task-file is missing or not valid UTF-8");
    }
    if (taskText.trim().length === 0 || taskText.includes("\0")) refuse("--task-file is empty or contains NUL");
    try {
      checkOrdinaryInput(args.workspace, "dir", "--workspace");
      workspace = resolveWorkspace(args.workspace);
    } catch (e) {
      refuse(`--workspace refused: ${boundedDiagnostic(e instanceof Error ? e.message : String(e))}`);
    }
    checkOutputPath(args.outputDir);

    const { resolveCredential, transport } = host;
    // Constructed before any directory exists so a construction failure leaves nothing behind.
    worker = createGeminiApiWorker({
      model: args.model,
      transport,
      getCredential: async () => {
        const value = await resolveCredential(args.credentialEnv);
        if (typeof value !== "string" || value.length === 0) {
          throw new Error("credential variable is not set");
        }
        key = value;
        return value;
      },
    });
  } catch (e) {
    error(`outcome: PRECHECK_REFUSED — ${scrub(boundedDiagnostic(e instanceof Error ? e.message : String(e)))}`);
    return 1;
  }

  const ids = createRandomIdGenerator();
  const runId = ids.next("run");
  const workItemId = ids.next("wi");
  const request: WorkerRequest = {
    runId,
    workItemId,
    role: "ANALYST",
    title: "sf gemini-api task",
    instructions: taskText,
    acceptanceCriteria: [
      {
        id: ids.next("ac"),
        workItemId,
        text: "Informational only: the model's response to the supplied task. No acceptance is claimed or verified.",
        verificationHint: "none (operator reads the output; nothing is accepted by this command)",
      },
    ],
  };

  let created = false;
  const write = (name: string, data: unknown): void => {
    const text = scrub(`${JSON.stringify(redactDeep(data), null, 2)}\n`);
    writeFileSync(join(args.outputDir, name), text, { flag: "wx", mode: 0o600 });
  };
  try {
    mkdirSync(args.outputDir, { mode: 0o700 });
    created = true;
    if (isSymlinkOrNotDir(args.outputDir) !== "ok") throw new Error("created output directory is not a plain directory");

    const outcome: WorkerOutcome = await worker.execute(request);
    write("result.json", {
      schema: "sf.gemini-api-task.result/v1",
      runId,
      workItemId,
      role: "ANALYST",
      model: args.model,
      credentialEnv: args.credentialEnv,
      workspace: { root: workspace.root, repositoryRoot: workspace.repositoryRoot },
      taskFile: { path: args.taskFile, bytes: taskBytes.length, sha256: createHash("sha256").update(taskBytes).digest("hex") },
      outcome,
      note: "informational; no eligibility, billing or acceptance is claimed; claimsAcceptanceMet is not acceptance",
    });
    log(`outcome: ${outcome.status}`);
    log(`output-dir: ${args.outputDir}`);
    return outcome.status === "SUCCEEDED" ? 0 : 2;
  } catch (e) {
    const message = scrub(boundedDiagnostic(e instanceof Error ? e.message : String(e)));
    if (created) {
      try {
        write("error.json", { schema: "sf.gemini-api-task.error/v1", runId, error: message });
      } catch {
        // Evidence already present is preserved; never overwrite.
      }
    }
    error(`outcome: ERROR — ${message}`);
    return 3;
  }
}
