/**
 * `sf ollama task` — one explicit, operator-driven ANALYST request through the
 * existing Ollama CLI worker.
 *
 * What it is: a readiness check against a fixed loopback Ollama endpoint, then
 * ONE normal WorkerRequest through `createOllamaCliWorker`, with the redacted
 * WorkerOutcome plus readiness/model provenance written to a fresh directory.
 *
 * What it is not: no default model/task/workspace/executable, no loop routing,
 * no acceptance, DONE or authority (claimsAcceptanceMet stays false), and no
 * structured-output guarantee — model prose is never repaired or verified.
 *
 * Readiness is a point-in-time observation. It does not stop the model or
 * server changing afterwards, is not a global free/billing claim, and setting
 * OLLAMA_HOST for the child does not disable any server-side cloud feature.
 * Nothing here installs, pulls, logs in or falls back to a cloud model.
 */

import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { createNodeProcessRunner } from "../adapters/process/nodeProcessRunner.js";
import { DEFAULT_WORKER_ENV_ALLOWLIST, redactSecrets, type EnvironmentPolicy } from "../adapters/workers/environmentPolicy.js";
import { createOllamaCliWorker, validateOllamaModel } from "../adapters/workers/ollamaCliAdapter.js";
import { resolveWorkspace, type Workspace } from "../adapters/workers/workspace.js";
import { createRandomIdGenerator } from "../domain/ids.js";
import type { ProcessRunner } from "../ports/processRunner.js";
import type { WorkerOutcome, WorkerRequest } from "../ports/worker.js";
import { boundedDiagnostic } from "../supervision/resourceClassifier.js";

export const OLLAMA_ENDPOINT = "http://127.0.0.1:11434";
const OLLAMA_HOST_NAME = "127.0.0.1";
const OLLAMA_PORT = 11434;
/** Readiness probes are bounded; this is not author work. */
const READINESS_TIMEOUT_MS = 15_000;
const READINESS_MAX_BYTES = 8 * 1024 * 1024;
const CONTROL_RX = /[\u0000-\u001f\u007f]/;
const MAX_PATH = 4096;
const MAX_MODEL = 256;

export const OLLAMA_TASK_USAGE =
  "Usage: sf ollama task --model <local-model> --task-file <abs-path> --workspace <abs-path> " +
  "--output-dir <fresh-abs-path> --executable <abs-path>";

export const OLLAMA_TASK_HELP = `${OLLAMA_TASK_USAGE}

Makes ONE explicit ANALYST request to a local Ollama model and writes the
redacted worker outcome plus readiness/model provenance into a NEW directory.
Every flag is required and may appear once; there are no defaults.
  --model       exact cached model name as listed by Ollama (e.g. name:tag)
  --task-file   UTF-8 file whose content becomes the request instructions
  --workspace   existing directory inside a real Git repository
  --output-dir  must not exist; its parent must exist and no ancestor may be a
                symlink; created exclusively and never overwritten
  --executable  existing Ollama executable (never searched on PATH)
Before any process starts it checks ${OLLAMA_ENDPOINT} (/api/tags, /api/show):
the model must be an exact local GGUF entry with a digest. That is a
point-in-time observation, not a billing or cloud-isolation guarantee. Nothing
is installed, pulled or logged in. The model's text is informational only: it
is not accepted, verified or parsed, and no work item is advanced.
Exit 0: process succeeded; 1: refused before any process; 2: process failed;
3: error after output creation. Read the "outcome:" line.`;

const FLAGS = ["--model", "--task-file", "--workspace", "--output-dir", "--executable"] as const;
type Flag = (typeof FLAGS)[number];

export interface OllamaTaskArgs {
  readonly model: string;
  readonly taskFile: string;
  readonly workspace: string;
  readonly outputDir: string;
  readonly executable: string;
}

function absolutePath(v: string): boolean {
  return v.length > 0 && v.length <= MAX_PATH && isAbsolute(v) && !CONTROL_RX.test(v) && resolve(v) === v;
}

export function parseOllamaTaskArgs(
  args: readonly string[],
): { readonly ok: true; readonly value: OllamaTaskArgs } | { readonly ok: false; readonly error: string } {
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
  const modelProblem = validateOllamaModel(model);
  if (modelProblem !== undefined) return { ok: false, error: `--model: ${modelProblem}` };
  if (model.length > MAX_MODEL || CONTROL_RX.test(model) || model !== model.trim()) {
    return { ok: false, error: "--model must be a plain name without surrounding whitespace or control characters" };
  }
  for (const f of ["--task-file", "--workspace", "--output-dir", "--executable"] as const) {
    if (!absolutePath(get(f))) return { ok: false, error: `${f} must be a normalized absolute path` };
  }
  return {
    ok: true,
    value: {
      model,
      taskFile: get("--task-file"),
      workspace: get("--workspace"),
      outputDir: get("--output-dir"),
      executable: get("--executable"),
    },
  };
}

// ---------------------------------------------------------------- readiness

export interface OllamaModelProvenance {
  readonly model: string;
  readonly digest: string;
  readonly size?: number;
  readonly modifiedAt?: string;
  readonly format: "gguf";
  readonly family?: string;
  readonly parameterSize?: string;
  readonly quantizationLevel?: string;
}

export type OllamaHttpJson = (call: {
  readonly method: "GET" | "POST";
  readonly path: "/api/tags" | "/api/show";
  readonly body?: unknown;
}) => Promise<unknown>;

/** Fixed endpoint, no proxy, bounded time and size. The only HTTP this command makes. */
export const loopbackOllamaHttpJson: OllamaHttpJson = (call) =>
  new Promise((resolvePromise, reject) => {
    const payload = call.body === undefined ? undefined : JSON.stringify(call.body);
    const req = httpRequest(
      {
        host: OLLAMA_HOST_NAME,
        port: OLLAMA_PORT,
        path: call.path,
        method: call.method,
        timeout: READINESS_TIMEOUT_MS,
        headers: payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > READINESS_MAX_BYTES) {
            req.destroy(new Error("response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`${call.path} returned HTTP ${String(res.statusCode)}`));
            return;
          }
          try {
            resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
          } catch {
            reject(new Error(`${call.path} returned malformed JSON`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`${call.path} timed out`)));
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function hasRemote(entry: Json): boolean {
  return nonEmptyString(entry["remote_model"]) || nonEmptyString(entry["remote_host"]);
}

const CLOUD_NAME_RX = /(^|[:\-_./])cloud($|[:\-_.])/i;

/** Pure: decides readiness from the two observed responses. Throws a refusal message. */
export function evaluateOllamaReadiness(model: string, tags: unknown, show: unknown): OllamaModelProvenance {
  if (CLOUD_NAME_RX.test(model)) throw new Error("model name looks like a cloud alias; only cached local models are accepted");
  if (!isObject(tags) || !Array.isArray(tags["models"])) throw new Error("/api/tags response is malformed");
  const matches = (tags["models"] as unknown[]).filter(
    (e): e is Json => isObject(e) && (e["name"] === model || e["model"] === model),
  );
  if (matches.length === 0) throw new Error("model is not an exact cached model name in /api/tags (aliases are not resolved)");
  if (matches.length > 1) throw new Error("model identity is ambiguous in /api/tags");
  const entry = matches[0] as Json;
  if ((entry["name"] !== undefined && entry["name"] !== model) || (entry["model"] !== undefined && entry["model"] !== model)) {
    throw new Error("model identity is ambiguous in /api/tags (name and model differ)");
  }
  if (hasRemote(entry)) throw new Error("/api/tags marks this model as remote/cloud");
  const digest = entry["digest"];
  if (!nonEmptyString(digest) || !/^[A-Za-z0-9:._-]{1,256}$/.test(digest)) throw new Error("/api/tags digest is missing or malformed");
  const tagDetails = entry["details"];
  if (!isObject(tagDetails) || tagDetails["format"] !== "gguf") throw new Error("/api/tags details.format is not gguf");

  if (!isObject(show)) throw new Error("/api/show response is malformed");
  if (hasRemote(show)) throw new Error("/api/show marks this model as remote/cloud");
  const showDetails = show["details"];
  if (!isObject(showDetails) || showDetails["format"] !== "gguf") throw new Error("/api/show details.format is not gguf");
  for (const key of ["family", "parameter_size", "quantization_level"] as const) {
    const a = tagDetails[key];
    const b = showDetails[key];
    if (a !== undefined && b !== undefined && a !== b) throw new Error(`/api/show details.${key} disagrees with /api/tags`);
  }
  if (show["digest"] !== undefined && show["digest"] !== digest) throw new Error("/api/show digest disagrees with /api/tags");

  const text = (v: unknown): string | undefined => (typeof v === "string" && v.length <= 256 ? v : undefined);
  const family = text(showDetails["family"] ?? tagDetails["family"]);
  const parameterSize = text(showDetails["parameter_size"] ?? tagDetails["parameter_size"]);
  const quantizationLevel = text(showDetails["quantization_level"] ?? tagDetails["quantization_level"]);
  const modifiedAt = text(entry["modified_at"]);
  return {
    model,
    digest,
    ...(typeof entry["size"] === "number" && Number.isFinite(entry["size"]) ? { size: entry["size"] } : {}),
    ...(modifiedAt === undefined ? {} : { modifiedAt }),
    format: "gguf",
    ...(family === undefined ? {} : { family }),
    ...(parameterSize === undefined ? {} : { parameterSize }),
    ...(quantizationLevel === undefined ? {} : { quantizationLevel }),
  };
}

// ---------------------------------------------------------------- run

export interface OllamaTaskDeps {
  readonly log?: (line: string) => void;
  readonly error?: (line: string) => void;
  /** Internal test seams only; never reachable from a CLI flag. */
  readonly httpJson?: OllamaHttpJson;
  readonly processRunner?: ProcessRunner;
  readonly now?: () => Date;
}

/** Fixed child environment: the existing default allowlist plus the checked endpoint. */
export const OLLAMA_TASK_ENVIRONMENT_POLICY: EnvironmentPolicy = Object.freeze({
  allowedVars: DEFAULT_WORKER_ENV_ALLOWLIST,
  extraVars: Object.freeze({ OLLAMA_HOST: OLLAMA_ENDPOINT }),
});

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
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  return value;
}

function writeExclusive(dir: string, name: string, data: unknown): void {
  writeFileSync(join(dir, name), `${JSON.stringify(redactDeep(data), null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

/** Exit codes: 0 process succeeded; 1 refused before any process; 2 process failed; 3 error after output creation. */
export async function runOllamaTask(args: OllamaTaskArgs, deps: OllamaTaskDeps = {}): Promise<number> {
  const log = deps.log ?? ((): void => {});
  const error = deps.error ?? ((): void => {});
  const now = deps.now ?? ((): Date => new Date());

  let taskText: string;
  let taskBytes: Buffer;
  let workspace: Workspace;
  let provenance: OllamaModelProvenance;
  let worker: ReturnType<typeof createOllamaCliWorker>;
  const observedAt = now().toISOString();
  try {
    try {
      if (!statSync(args.executable).isFile()) refuse("--executable is not a file");
      if (process.platform !== "win32") accessSync(args.executable, constants.X_OK);
    } catch (e) {
      if (e instanceof Refusal) throw e;
      refuse("--executable does not exist or is not executable");
    }
    try {
      if (!statSync(args.taskFile).isFile()) refuse("--task-file is not a file");
      taskBytes = readFileSync(args.taskFile);
      taskText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(taskBytes);
    } catch (e) {
      if (e instanceof Refusal) throw e;
      refuse("--task-file is missing or not valid UTF-8");
    }
    if (taskText.trim().length === 0 || taskText.includes("\0")) refuse("--task-file is empty or contains NUL");
    try {
      workspace = resolveWorkspace(args.workspace);
    } catch (e) {
      refuse(`--workspace refused: ${boundedDiagnostic(e instanceof Error ? e.message : String(e))}`);
    }
    checkOutputPath(args.outputDir);

    const httpJson = deps.httpJson ?? loopbackOllamaHttpJson;
    try {
      const tags = await httpJson({ method: "GET", path: "/api/tags" });
      const show = await httpJson({ method: "POST", path: "/api/show", body: { model: args.model } });
      provenance = evaluateOllamaReadiness(args.model, tags, show);
    } catch (e) {
      refuse(`readiness refused: ${boundedDiagnostic(e instanceof Error ? e.message : String(e))}`);
    }

    // Constructed before any directory exists so a construction failure leaves nothing behind.
    worker = createOllamaCliWorker({
      executable: args.executable,
      model: args.model,
      timeoutMs: null,
      workspace,
      processRunner: deps.processRunner ?? createNodeProcessRunner(),
      environmentPolicy: OLLAMA_TASK_ENVIRONMENT_POLICY,
      roles: ["ANALYST"],
    });
  } catch (e) {
    error(`outcome: PRECHECK_REFUSED — ${boundedDiagnostic(e instanceof Error ? e.message : String(e))}`);
    return 1;
  }

  const ids = createRandomIdGenerator();
  const runId = ids.next("run");
  const workItemId = ids.next("wi");
  const request: WorkerRequest = {
    runId,
    workItemId,
    role: "ANALYST",
    title: "sf ollama task",
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
  try {
    mkdirSync(args.outputDir, { mode: 0o700 });
    created = true;
    if (isSymlinkOrNotDir(args.outputDir) !== "ok") throw new Error("created output directory is not a plain directory");
    const readinessRecord = {
      schema: "sf.ollama-task.readiness/v1",
      observedAt,
      endpoint: OLLAMA_ENDPOINT,
      note: "point-in-time observation; not an atomic guarantee and not a billing or cloud-isolation claim",
      model: provenance,
    };
    writeExclusive(args.outputDir, "readiness.json", readinessRecord);

    const outcome: WorkerOutcome = await worker.execute(request);
    writeExclusive(args.outputDir, "result.json", {
      schema: "sf.ollama-task.result/v1",
      runId,
      workItemId,
      role: "ANALYST",
      executable: args.executable,
      workspace: { root: workspace.root, repositoryRoot: workspace.repositoryRoot },
      taskFile: { path: args.taskFile, bytes: taskBytes.length, sha256: createHash("sha256").update(taskBytes).digest("hex") },
      childEnvironment: { allowedVars: [...DEFAULT_WORKER_ENV_ALLOWLIST], extraVars: { OLLAMA_HOST: OLLAMA_ENDPOINT } },
      readiness: readinessRecord,
      outcome,
      note: "process status only; model text is informational and unverified, claimsAcceptanceMet is not acceptance",
    });
    log(`outcome: ${outcome.status}`);
    log(`output-dir: ${args.outputDir}`);
    log(`model-digest: ${provenance.digest}`);
    return outcome.status === "SUCCEEDED" ? 0 : 2;
  } catch (e) {
    const message = boundedDiagnostic(e instanceof Error ? e.message : String(e));
    if (created) {
      try {
        writeExclusive(args.outputDir, "error.json", { schema: "sf.ollama-task.error/v1", runId, error: message });
      } catch {
        // Evidence already present is preserved; never overwrite.
      }
    }
    error(`outcome: ERROR — ${message}`);
    return 3;
  }
}
