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
import type { DirectHostAdmissionSurface } from "../../supervision/directWorkerAdmission.js";
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
  /** See CliWorkerAdapterConfig.maxEvidenceChars in cliWorker.ts. */
  readonly maxEvidenceChars?: number;
  readonly maxTurns?: number;
  /** See CliWorkerAdapterConfig.directAdmissionChannel in cliWorker.ts. Omitted when absent; missing default fails closed there. */
  readonly directAdmissionChannel?: DirectHostAdmissionSurface;
  /** See CliWorkerAdapterConfig.maxTotalOutputBytes in cliWorker.ts. Omitted preserves unbounded-aggregate behavior. */
  readonly maxTotalOutputBytes?: number;
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
interface ClaudeOutputScan {
  readonly finalMessage?: string;
  /**
   * See CliReportedResult.streamCorrupted in cliWorker.ts. Only the JSONL
   * fallback scan below can observe this — the primary single-object path
   * either parses or doesn't. Also true when the fallback scan finds more
   * than one line carrying a `result` string: this adapter's documented
   * contract is exactly ONE JSON object per invocation (see this file's
   * header), so reaching this fallback at all already means that contract
   * was violated; finding two or more independently well-formed candidate
   * results is a second, distinct way that violation can hide an
   * authoritative-vs-stale ambiguity behind lines that each parse cleanly on
   * their own — the malformed-line case above catches corruption BETWEEN
   * valid lines, this catches multiple COMPETING valid lines. Reuses the same
   * signal/evidence channel as the malformed-line case (see
   * cliPlannerWorker.ts) rather than adding a second one, since both mean the
   * same thing to every consumer: the reported finalMessage cannot be trusted
   * as the tool's one authoritative answer.
   */
  readonly corrupted: boolean;
}

function scanClaudeOutput(stdout: string): ClaudeOutputScan {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { corrupted: false };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      const result = (parsed as { result?: unknown }).result;
      if (typeof result === "string") {
        return { finalMessage: result, corrupted: false };
      }
    }
  } catch {
    // Not a single JSON object — fall through to a JSONL-style scan below.
  }
  let last: string | undefined;
  let resultLineCount = 0;
  let corrupted = false;
  for (const line of trimmed.split("\n")) {
    const candidate = line.trim();
    if (candidate.length === 0) continue;
    try {
      const event: unknown = JSON.parse(candidate);
      if (typeof event === "object" && event !== null) {
        const result = (event as { result?: unknown }).result;
        if (typeof result === "string") {
          last = result;
          resultLineCount += 1;
        }
      }
    } catch {
      // Same reasoning as Codex's JSONL scan: a later authoritative message
      // could be hidden behind a malformed line.
      corrupted = true;
      continue;
    }
  }
  if (resultLineCount > 1) {
    // Two or more independently valid `result` lines: this adapter's single-
    // JSON-object contract does not permit more than one, and there is no
    // principled way to pick between them — see this interface's doc comment.
    corrupted = true;
  }
  return { ...(last === undefined ? {} : { finalMessage: last }), corrupted };
}

export function extractClaudeFinalMessage(stdout: string): string | undefined {
  return scanClaudeOutput(stdout).finalMessage;
}

/**
 * The subset of claude-code's structured `.result` object
 * `WorkerRunEnvelope` is durably allowed to trust (DEFECT-DURABLE-WORKER-RUN-ENVELOPE
 * AC-6).
 */
export interface ClaudeStructuredResult {
  readonly sessionId?: string;
  /** Present ONLY when the provider's own field said so, verbatim. Never inferred from prose. */
  readonly terminalReason?: "MAX_TURNS";
}

/**
 * Strictly parses claude-code's single JSON result object for `session_id`
 * and a verified MAX_TURNS terminal reason.
 *
 * Deliberately STRICT, mirroring `strictClaudeFinalMessage` in
 * reviewFinalMessage.ts rather than this file's own lenient
 * `scanClaudeOutput`: a durable MAX_TURNS record is a stronger claim than an
 * informational transcript, and free text must never be able to fabricate it
 * (AC-6, and the task's own "free-text 'max turns' cannot create this state").
 * Only a single, well-formed `type: "result"` object whose OWN
 * `terminal_reason` field is exactly `"max_turns"` produces `MAX_TURNS`;
 * anything else — a malformed object, a missing or different reason, or a
 * stream this adapter's lenient JSONL fallback would otherwise have salvaged
 * — produces `{}` rather than a guess.
 *
 * MEASUREMENT NOTE: the field's existence and shape (`type`, `session_id`,
 * `terminal_reason`) were verified against the real `claude` binary (see
 * TASK-003-worker-runner.md), which also measured `terminal_reason:
 * "api_error"` for an unrelated failure — establishing the field is a short,
 * snake_case reason code. The exact string for a max-turns exhaustion was NOT
 * independently reproduced here: doing so would mean deliberately exhausting
 * a real, paid session's turn budget, which is outside what a fake/offline
 * test may do and outside this defect's spending boundary. `"max_turns"` is
 * therefore an informed, closed-set match on the measured naming convention,
 * not an independently reproduced measurement — a residual risk recorded in
 * this defect's final report rather than hidden behind an assertion of
 * certainty this module cannot back up.
 */
export function parseClaudeStructuredResult(stdout: string): ClaudeStructuredResult {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const row = parsed as Record<string, unknown>;
  if (row["type"] !== "result") {
    return {};
  }
  const sessionId = typeof row["session_id"] === "string" ? row["session_id"] : undefined;
  const terminalReason = row["terminal_reason"] === "max_turns" ? ("MAX_TURNS" as const) : undefined;
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(terminalReason === undefined ? {} : { terminalReason }),
  };
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
  const scan = scanClaudeOutput(processResult.stdout);
  const structured = parseClaudeStructuredResult(processResult.stdout);
  return {
    ...(structured.sessionId === undefined ? {} : { providerSessionId: structured.sessionId }),
    ...(structured.terminalReason === undefined ? {} : { terminalReason: structured.terminalReason }),
    ...(scan.finalMessage === undefined ? {} : { finalMessage: scan.finalMessage }),
    ...(scan.corrupted ? { streamCorrupted: true } : {}),
  };
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
    ...(options.maxEvidenceChars === undefined ? {} : { maxEvidenceChars: options.maxEvidenceChars }),
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    ...(options.directAdmissionChannel === undefined ? {} : { directAdmissionChannel: options.directAdmissionChannel }),
    ...(options.maxTotalOutputBytes === undefined ? {} : { maxTotalOutputBytes: options.maxTotalOutputBytes }),
    buildInvocation: (args) => {
      const plan = buildClaudeInvocation(args);
      if (options.maxTurns === undefined) return plan;
      if (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1) throw new Error("invalid maxTurns");
      return { ...plan, argv: [...plan.argv, "--max-turns", String(options.maxTurns)] };
    },
    interpretOutput: interpretClaudeOutput,
  });
}
