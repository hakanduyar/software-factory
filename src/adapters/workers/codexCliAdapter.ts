/**
 * Codex CLI adapter (TASK-003).
 *
 * Invocation shape below was independently verified against the real
 * `codex` binary on the development machine (v0.147.0), not assumed from
 * memory — see docs/tasks/TASK-003-worker-runner.md "Real, tested Codex CLI
 * invocation" for the exact experiments:
 *
 *   codex exec --json -C <workspaceRoot> -m <model> \
 *     [-c model_reasoning_effort="<effort>"] --sandbox <read-only|workspace-write> \
 *     "<prompt>"
 *
 * - `--json` prints one JSON object per line to stdout (`thread.started`,
 *   `turn.started`, `item.completed` with the final `agent_message` text,
 *   `turn.completed`); this is parsed as the informational "reported"
 *   channel only — process exit code/termination still decides success.
 * - `exec` has no interactive-approval flag; sandbox alone governs what the
 *   model may do, so there is no approval-prompt hang risk to guard here.
 * - stdin is left unset (closed immediately) — the prompt travels as an
 *   argv element, matching the tested invocation.
 * - `--sandbox read-only` for every role except IMPLEMENTER, which gets
 *   `workspace-write` (still confined to the workspace directory Codex was
 *   told about via `-C`).
 */

import { FACTORY_ROLES, type FactoryRole } from "../../domain/role.js";
import type { ProcessResult, ProcessRunner } from "../../ports/processRunner.js";
import type { Worker } from "../../ports/worker.js";
import type { BuildInvocationArgs, CliInvocationPlan, CliReportedResult } from "./cliWorker.js";
import { createCliWorker } from "./cliWorker.js";
import { DEFAULT_WORKER_ENVIRONMENT_POLICY, type EnvironmentPolicy } from "./environmentPolicy.js";
import { DEFAULT_WORKER_TIMEOUT_MS, type EffortApplication } from "./workerModelConfig.js";
import type { Workspace } from "./workspace.js";

export interface CodexCliWorkerOptions {
  readonly id?: string;
  /** Overridable so tests point this at a fake CLI fixture instead of the real `codex` binary. */
  readonly executable?: string;
  readonly model: string;
  readonly effort?: string;
  readonly timeoutMs?: number;
  readonly workspace: Workspace;
  readonly processRunner: ProcessRunner;
  readonly environmentPolicy?: EnvironmentPolicy;
  readonly roles?: readonly FactoryRole[];
}

export function sandboxForRole(role: FactoryRole): "read-only" | "workspace-write" {
  return role === "IMPLEMENTER" ? "workspace-write" : "read-only";
}

/**
 * `-c key=value` parses `value` as TOML. Only accept a plain token for the
 * effort override rather than risk handing Codex's own TOML parser
 * something unexpected — if it isn't a plain token, we honestly report the
 * effort as not applied instead of guessing at escaping.
 */
const SAFE_EFFORT_TOKEN = /^[a-zA-Z0-9_-]+$/;

export function resolveCodexEffort(effort: string | undefined): { argv: readonly string[]; application: EffortApplication } {
  if (effort === undefined) {
    return { argv: [], application: { applied: false } };
  }
  if (!SAFE_EFFORT_TOKEN.test(effort)) {
    return {
      argv: [],
      application: {
        requested: effort,
        applied: false,
        reason: "effort value is not a plain token; refusing to pass an unvalidated Codex config override",
      },
    };
  }
  return {
    argv: ["-c", `model_reasoning_effort="${effort}"`],
    application: { requested: effort, applied: true },
  };
}

export function extractCodexFinalMessage(stdout: string): string | undefined {
  let last: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // Malformed/truncated JSONL line — ignore, this channel is informational only.
    }
    if (
      typeof event === "object" &&
      event !== null &&
      (event as { type?: unknown }).type === "item.completed" &&
      typeof (event as { item?: { type?: unknown } }).item === "object"
    ) {
      const item = (event as { item: { type?: unknown; text?: unknown } }).item;
      if (item.type === "agent_message" && typeof item.text === "string") {
        last = item.text;
      }
    }
  }
  return last;
}

/** Pure argv-building: no I/O, directly unit-testable without spawning anything. */
export function buildCodexInvocation(args: BuildInvocationArgs): CliInvocationPlan {
  const { request, prompt, workspace, model, effort } = args;
  const { argv: effortArgv, application } = resolveCodexEffort(effort);
  const argv: string[] = [
    "exec",
    "--json",
    "-C",
    workspace.root,
    "-m",
    model,
    ...effortArgv,
    "--sandbox",
    sandboxForRole(request.role),
    prompt,
  ];
  return { argv, effortApplication: application };
}

/** Pure output parsing: no I/O, directly unit-testable with a fabricated ProcessResult. */
export function interpretCodexOutput(processResult: ProcessResult): CliReportedResult {
  const finalMessage = extractCodexFinalMessage(processResult.stdout);
  return finalMessage === undefined ? {} : { finalMessage };
}

export function createCodexCliWorker(options: CodexCliWorkerOptions): Worker {
  const executable = options.executable ?? "codex";
  return createCliWorker({
    id: options.id ?? "codex-cli",
    tool: "codex-cli",
    roles: options.roles ?? FACTORY_ROLES,
    executable,
    model: options.model,
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    timeoutMs: options.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS,
    workspace: options.workspace,
    processRunner: options.processRunner,
    environmentPolicy: options.environmentPolicy ?? DEFAULT_WORKER_ENVIRONMENT_POLICY,
    buildInvocation: buildCodexInvocation,
    interpretOutput: interpretCodexOutput,
  });
}
