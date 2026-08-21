/**
 * Deterministic verification `Worker` (TASK-004 §4).
 *
 * Not an AI worker and never invokes one: it runs a fixed list of trusted,
 * explicitly configured commands (`executable` + `argv` array + `cwd` +
 * `timeoutMs` — never a shell string, same discipline as
 * src/adapters/workers/cliWorker.ts) via the existing `ProcessRunner` port.
 *
 * Status split (see design doc §4 for the full rationale): `WorkerOutcome
 * .status` is `SUCCEEDED` whenever every configured command was actually run
 * and its result captured — a failing `npm test` is a successfully-observed
 * fact, not a harness failure, and `FactoryService.recordReview` requires a
 * SUCCEEDED run before it will record *any* review, including a failing one.
 * Only a genuine bug in this module throws (becoming an honest FAILED run
 * via FactoryService's existing catch, exactly like every other adapter).
 */

import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

import { ValidationError } from "../domain/errors.js";
import type { EvidenceDraft } from "../domain/evidence.js";
import type { ProcessRunner } from "../ports/processRunner.js";
import type { Worker, WorkerOutcome, WorkerRequest } from "../ports/worker.js";
import { buildWorkerEnvironment, redactSecrets, type EnvironmentPolicy } from "../adapters/workers/environmentPolicy.js";
import { DEFAULT_WORKER_ENVIRONMENT_POLICY } from "../adapters/workers/environmentPolicy.js";
import type { Workspace } from "../adapters/workers/workspace.js";
import type { VerificationCommandConfig, VerificationCommandResult } from "./loopTypes.js";

export const DEFAULT_VERIFICATION_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_EVIDENCE_CHARS = 4000;

/**
 * Confines a configured verification cwd to the approved workspace
 * (remediation round 1, HIGH 4 / PART J). Containment is against
 * `workspace.root` — the narrower approved *execution* workspace TASK-003's
 * contract launches workers in — not `repositoryRoot` (a configured
 * workspace may be a subdirectory of the repository; nothing in the accepted
 * contract authorizes executing outside that subdirectory).
 *
 * Real (symlink-resolved) paths are compared, so `../` escapes, absolute
 * outside paths, AND a symlink inside the workspace pointing outside are all
 * rejected; so are nonexistent paths and non-directories. Called both at
 * loop start (fail fast, before any worker launches) and again immediately
 * before every command execution (the filesystem can change between start
 * and verify — a symlink created mid-loop must not open the boundary).
 */
export function resolveContainedCwd(workspace: Workspace, configuredCwd: string | undefined): string {
  const candidate = resolve(workspace.root, configuredCwd ?? ".");

  let realRoot: string;
  try {
    realRoot = realpathSync(workspace.root);
  } catch {
    throw new ValidationError(`approved workspace root does not exist: ${workspace.root}`);
  }

  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new ValidationError(`verification cwd does not exist: ${candidate}`);
  }

  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new ValidationError(
      `verification cwd escapes the approved workspace: ${candidate} resolves to ${real}, outside ${realRoot}`,
    );
  }

  if (!statSync(real).isDirectory()) {
    throw new ValidationError(`verification cwd is not a directory: ${real}`);
  }

  return real;
}

/** Start-time validation of a full command list against the approved workspace. Throws ValidationError. */
export function assertVerificationCommandsContained(
  commands: readonly VerificationCommandConfig[],
  workspace: Workspace,
): void {
  for (const command of commands) {
    resolveContainedCwd(workspace, command.cwd);
  }
}

export interface VerificationWorkerOptions {
  readonly id?: string;
  readonly commands: readonly VerificationCommandConfig[];
  readonly workspace: Workspace;
  readonly processRunner: ProcessRunner;
  readonly environmentPolicy?: EnvironmentPolicy;
  readonly defaultTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxEvidenceChars?: number;
  /** Invoked synchronously, once per command, as its result is produced — the orchestrator's channel for structured per-command results (see engineeringLoopService.ts). */
  readonly onCommandResult?: (result: VerificationCommandResult) => void;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…[truncated]`;
}

export function createVerificationWorker(options: VerificationWorkerOptions): Worker {
  return {
    id: options.id ?? "verification-runner",
    capabilities: { roles: ["VERIFIER"], deterministic: false },
    async execute(request: WorkerRequest): Promise<WorkerOutcome> {
      const env = buildWorkerEnvironment(options.environmentPolicy ?? DEFAULT_WORKER_ENVIRONMENT_POLICY);
      const maxEvidenceChars = options.maxEvidenceChars ?? DEFAULT_MAX_EVIDENCE_CHARS;
      const evidence: EvidenceDraft[] = [];
      const results: VerificationCommandResult[] = [];

      for (const command of options.commands) {
        // Re-validated per command at execution time, not just at loop start:
        // a symlink created after start must not open the workspace boundary.
        const cwd = resolveContainedCwd(options.workspace, command.cwd);
        const timeoutMs = command.timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;

        const processResult = await options.processRunner.run({
          executable: command.executable,
          argv: command.argv,
          cwd,
          env,
          timeoutMs,
          ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
        });

        const passed = processResult.terminationReason === "EXITED" && processResult.exitCode === 0;
        const result: VerificationCommandResult = {
          commandId: command.id,
          passed,
          exitCode: processResult.exitCode,
          terminationReason: processResult.terminationReason,
          durationMs: processResult.durationMs,
          stdoutTruncated: processResult.stdoutTruncated,
          stderrTruncated: processResult.stderrTruncated,
        };
        results.push(result);
        options.onCommandResult?.(result);

        const commandLabel = `${command.executable} ${command.argv.join(" ")}`.trim();
        const outputTail = processResult.stdout.length > 0 ? processResult.stdout : processResult.stderr;
        const status =
          processResult.terminationReason === "EXITED"
            ? `exit=${String(processResult.exitCode)}`
            : processResult.terminationReason;
        evidence.push({
          kind: command.evidenceKind ?? "NOTE",
          summary: truncate(
            `[${command.id}] ${commandLabel} — ${passed ? "PASSED" : "FAILED"} (${status}, ${processResult.durationMs}ms)` +
              (outputTail.length > 0 ? `\n${redactSecrets(outputTail)}` : ""),
            maxEvidenceChars,
          ),
          reference: `verify://command/${command.id}`,
        });
      }

      const passedCount = results.filter((r) => r.passed).length;
      const allPassed = results.every((r) => r.passed);

      return {
        status: "SUCCEEDED",
        summary: `[verification] role=${request.role} ${passedCount}/${results.length} commands passed`,
        evidence,
        claimsAcceptanceMet: allPassed,
      };
    },
  };
}
