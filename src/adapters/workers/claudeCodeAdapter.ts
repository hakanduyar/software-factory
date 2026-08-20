/**
 * Claude Code CLI adapter (TASK-003).
 *
 * Invocation shape below was independently verified against the real
 * `claude` binary (2.1.235) on the development machine — not assumed from
 * memory — once it became available. See
 * docs/tasks/TASK-003-worker-runner.md "Real, tested Claude Code CLI
 * invocation" for the exact experiments:
 *
 *   claude -p "<prompt>" --model <model> --output-format json \
 *     [--effort <low|medium|high|xhigh|max>] --permission-mode <plan|acceptEdits>
 *
 * - `-p`/`--print` is the documented non-interactive mode; the prompt
 *   travels as a positional argument, exactly like the tested invocation.
 * - `--output-format json` prints exactly ONE JSON object to stdout (not
 *   JSONL, unlike Codex's `--json`) with a `.result` string field holding
 *   the final answer text — confirmed by a real probe. This is parsed as
 *   the informational "reported" channel only; process exit code/
 *   termination still decides success (see cliWorker.ts).
 * - `--effort <level>` is a real, documented flag (choices: low, medium,
 *   high, xhigh, max) — confirmed via `claude --help` and a live probe that
 *   accepted `--effort low` without error. Applied only for a value in that
 *   exact set; anything else is honestly reported as not applied.
 * - `--permission-mode` is real and documented (choices: acceptEdits, auto,
 *   bypassPermissions, manual, dontAsk, plan). This adapter passes `plan`
 *   for every role except IMPLEMENTER (mirrors Codex's read-only sandbox
 *   for non-implementing roles: investigate/report, never mutate) and
 *   `acceptEdits` for IMPLEMENTER (edits are scoped to the process's cwd —
 *   the resolved Workspace — same boundary Codex's `workspace-write`
 *   sandbox uses). Neither choice can hang on an unanswerable interactive
 *   approval prompt.
 * - Workspace boundary: there is no `-C`/`--cwd`-equivalent flag (confirmed
 *   absent from `--help`) — the child process's OS-level `cwd`, which
 *   `ProcessRunner` always sets explicitly, is the only mechanism, exactly
 *   as originally assumed.
 *
 * Historical note: this adapter was originally implemented, and shipped for
 * initial TASK-003 review, without access to a real `claude` binary (only
 * the VS Code extension was present on the build machine, which is not a
 * subprocess-invocable non-interactive CLI). At that time this file
 * intentionally never applied an effort flag and passed no permission-mode
 * flag, on the principle that an unverified assumption must fail safe
 * rather than be asserted as fact. Once a real binary became available, the
 * assumptions above were corrected against it — see AI-HANDOFF.md for the
 * verification pass and the real Factory-path smoke-test result.
 */

import { FACTORY_ROLES, type FactoryRole } from "../../domain/role.js";
import type { ProcessResult, ProcessRunner } from "../../ports/processRunner.js";
import type { Worker } from "../../ports/worker.js";
import type { BuildInvocationArgs, CliInvocationPlan, CliReportedResult } from "./cliWorker.js";
import { createCliWorker } from "./cliWorker.js";
import { DEFAULT_WORKER_ENVIRONMENT_POLICY, type EnvironmentPolicy } from "./environmentPolicy.js";
import { DEFAULT_WORKER_TIMEOUT_MS, type EffortApplication } from "./workerModelConfig.js";
import type { Workspace } from "./workspace.js";

export interface ClaudeCodeWorkerOptions {
  readonly id?: string;
  /** Overridable so tests point this at a fake CLI fixture instead of the real `claude` binary. */
  readonly executable?: string;
  readonly model: string;
  readonly effort?: string;
  readonly timeoutMs?: number;
  readonly workspace: Workspace;
  readonly processRunner: ProcessRunner;
  readonly environmentPolicy?: EnvironmentPolicy;
  readonly roles?: readonly FactoryRole[];
}

/** The exact choice set `--help` documents for `--effort` on this installed CLI. */
const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export function resolveClaudeEffort(effort: string | undefined): { argv: readonly string[]; application: EffortApplication } {
  if (effort === undefined) {
    return { argv: [], application: { applied: false } };
  }
  if (!(CLAUDE_EFFORT_LEVELS as readonly string[]).includes(effort)) {
    return {
      argv: [],
      application: {
        requested: effort,
        applied: false,
        reason: `effort must be one of ${CLAUDE_EFFORT_LEVELS.join(", ")} for this installed CLI's --effort flag, got "${effort}"`,
      },
    };
  }
  return { argv: ["--effort", effort], application: { requested: effort, applied: true } };
}

/**
 * Mirrors codexCliAdapter.ts's `sandboxForRole`: IMPLEMENTER may edit inside
 * the workspace without an unanswerable interactive prompt; every other
 * role stays in `plan` mode (investigate/report, never mutate).
 */
export function permissionModeForRole(role: FactoryRole): "acceptEdits" | "plan" {
  return role === "IMPLEMENTER" ? "acceptEdits" : "plan";
}

/**
 * `--output-format json` prints one JSON result object with a `.result`
 * string field — confirmed by a real probe. Parsed defensively: if the
 * shape is ever anything else (a future CLI version, an error path), this
 * returns `undefined` rather than throwing — this channel is informational
 * only and must never affect `WorkerOutcome.status`. The JSONL-style
 * fallback scan is kept as cheap extra defense against a format change, not
 * because it is expected to be needed.
 */
export function extractClaudeFinalMessage(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      const result = (parsed as { result?: unknown }).result;
      if (typeof result === "string") {
        return result;
      }
    }
  } catch {
    // Not a single JSON object — fall through to a JSONL-style scan below.
  }
  let last: string | undefined;
  for (const line of trimmed.split("\n")) {
    const candidate = line.trim();
    if (candidate.length === 0) continue;
    try {
      const event: unknown = JSON.parse(candidate);
      if (typeof event === "object" && event !== null) {
        const result = (event as { result?: unknown }).result;
        if (typeof result === "string") {
          last = result;
        }
      }
    } catch {
      continue;
    }
  }
  return last;
}

/** Pure argv-building: no I/O, directly unit-testable without spawning anything. */
export function buildClaudeInvocation(args: BuildInvocationArgs): CliInvocationPlan {
  const { request, prompt, model, effort } = args;
  const { argv: effortArgv, application } = resolveClaudeEffort(effort);
  const argv: string[] = [
    "-p",
    prompt,
    "--model",
    model,
    "--output-format",
    "json",
    ...effortArgv,
    "--permission-mode",
    permissionModeForRole(request.role),
  ];
  return { argv, effortApplication: application };
}

/** Pure output parsing: no I/O, directly unit-testable with a fabricated ProcessResult. */
export function interpretClaudeOutput(processResult: ProcessResult): CliReportedResult {
  const finalMessage = extractClaudeFinalMessage(processResult.stdout);
  return finalMessage === undefined ? {} : { finalMessage };
}

export function createClaudeCodeWorker(options: ClaudeCodeWorkerOptions): Worker {
  const executable = options.executable ?? "claude";
  return createCliWorker({
    id: options.id ?? "claude-code",
    tool: "claude-code",
    roles: options.roles ?? FACTORY_ROLES,
    executable,
    model: options.model,
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    timeoutMs: options.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS,
    workspace: options.workspace,
    processRunner: options.processRunner,
    environmentPolicy: options.environmentPolicy ?? DEFAULT_WORKER_ENVIRONMENT_POLICY,
    buildInvocation: buildClaudeInvocation,
    interpretOutput: interpretClaudeOutput,
  });
}
