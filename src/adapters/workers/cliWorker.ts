/**
 * Shared CLI-worker execution engine (TASK-003).
 *
 * Implements the `Worker` port exactly once. Each concrete tool
 * (claudeCodeAdapter.ts, codexCliAdapter.ts) supplies only tool-specific
 * configuration — how to build argv for one request, and how to interpret
 * that tool's own output — so process handling, environment policy,
 * evidence shaping and the execution-vs-reported-result split cannot
 * silently diverge between adapters.
 *
 * The core discipline this module enforces (TASK-003 items 9/10/11):
 *
 *   PROCESS EXECUTION RESULT (`ProcessResult`, from the OS) decides
 *   `WorkerOutcome.status`. MODEL/WORKER REPORTED RESULT (`CliReportedResult`,
 *   parsed from the tool's own stdout) is attached as informational
 *   evidence/summary text only. A process that exits 0 while printing "I
 *   failed" is still SUCCEEDED at the process level; a process that exits
 *   non-zero while printing "PASS" is still FAILED. `claimsAcceptanceMet` is
 *   always false here — no free-form model text is treated as a trusted
 *   claim (TASK-004 owns PASS/CHANGES_REQUIRED parsing).
 */

import type { EvidenceDraft } from "../../domain/evidence.js";
import type { ProcessResult, ProcessRunner } from "../../ports/processRunner.js";
import type { Worker, WorkerOutcome, WorkerRequest } from "../../ports/worker.js";
import type { FactoryRole } from "../../domain/role.js";
import { buildWorkerEnvironment, redactSecrets, type EnvironmentPolicy } from "./environmentPolicy.js";
import { buildWorkerPrompt } from "./promptTemplates.js";
import type { EffortApplication, WorkerTool } from "./workerModelConfig.js";
import type { Workspace } from "./workspace.js";

export interface CliInvocationPlan {
  readonly argv: readonly string[];
  readonly input?: string;
  readonly effortApplication: EffortApplication;
}

export interface BuildInvocationArgs {
  readonly request: WorkerRequest;
  readonly prompt: string;
  readonly workspace: Workspace;
  readonly model: string;
  readonly effort: string | undefined;
}

export interface CliReportedResult {
  /** The tool's own final answer text, if one could be parsed. Informational only. */
  readonly finalMessage?: string;
}

export interface CliWorkerAdapterConfig {
  /** Worker.id — self-declared, never trusted for identity (see src/ports/workerRegistry.ts). */
  readonly id: string;
  readonly tool: WorkerTool;
  readonly roles: readonly FactoryRole[];
  /** Executable path/name. Overridable so tests point this at a fake CLI fixture. */
  readonly executable: string;
  readonly model: string;
  readonly effort?: string;
  readonly timeoutMs: number;
  readonly workspace: Workspace;
  readonly processRunner: ProcessRunner;
  readonly environmentPolicy: EnvironmentPolicy;
  readonly maxOutputBytes?: number;
  /** Evidence transcript text is bounded independently of raw process-output bounding. Default 4000. */
  readonly maxEvidenceChars?: number;
  readonly buildInvocation: (args: BuildInvocationArgs) => CliInvocationPlan;
  readonly interpretOutput: (processResult: ProcessResult) => CliReportedResult;
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, maxChars)}\n…[truncated]`, truncated: true };
}

/**
 * The single redaction boundary for the tool's own parsed final message
 * (TASK-003 remediation round 1, HIGH finding). `buildSummary` and
 * `buildEvidence` below both take this pre-redacted value instead of the
 * raw `CliReportedResult` — neither may read `reported.finalMessage`
 * directly — so a persisted or displayed field can no longer forget to
 * redact it the way `Run.summary` previously did. (The separate raw
 * stdout/stderr fallback `buildEvidence` uses when nothing could be parsed
 * was already redacted at its own call site and still is — see below; it is
 * intentionally not folded into this function; scope stays the parsed
 * message, matching the reviewer's finding, not a rewrite of Evidence's
 * fallback semantics.)
 *
 * Deliberately does NOT touch trusted internal fields (tool, model, effort,
 * exit code, termination reason, timestamps, truncation flags) — those are
 * Factory-supplied configuration or OS-reported metadata, never externally
 * supplied text, so redacting them would only destroy useful audit data.
 */
function safeFinalMessage(reported: CliReportedResult): string | undefined {
  return reported.finalMessage === undefined ? undefined : redactSecrets(reported.finalMessage);
}

function describeTermination(processResult: ProcessResult): string {
  switch (processResult.terminationReason) {
    case "EXITED":
      return `exit=${String(processResult.exitCode)}`;
    case "TIMEOUT":
      return "TIMEOUT (process was terminated)";
    case "CANCELLED":
      return "CANCELLED (process was terminated)";
    case "SPAWN_ERROR":
      return `SPAWN_ERROR: ${processResult.spawnError ?? "unknown"}`;
  }
}

function buildEvidence(
  tool: WorkerTool,
  model: string,
  effortApplication: EffortApplication,
  request: WorkerRequest,
  processResult: ProcessResult,
  safeMessage: string | undefined,
  maxEvidenceChars: number,
): EvidenceDraft[] {
  const evidence: EvidenceDraft[] = [
    {
      kind: "NOTE",
      summary:
        `${tool} model=${model}` +
        (effortApplication.requested === undefined
          ? ""
          : ` effort=${effortApplication.requested}(applied=${String(effortApplication.applied)})`) +
        ` role=${request.role} ${describeTermination(processResult)} duration=${processResult.durationMs}ms`,
      reference: `cli://${tool}/run/${request.runId}`,
    },
  ];

  // `safeMessage` (the parsed final message) is already redacted by the caller
  // (see safeFinalMessage). The raw stdout/stderr fallback below — used only
  // when nothing could be parsed — is NOT yet redacted, so redactSecrets still
  // runs on the combined value; re-redacting an already-safe message is a
  // harmless no-op (our patterns never match "[REDACTED]").
  const rawTranscript = safeMessage ?? (processResult.stdout.length > 0 ? processResult.stdout : processResult.stderr);
  if (rawTranscript.length > 0) {
    const { text, truncated } = truncate(redactSecrets(rawTranscript), maxEvidenceChars);
    evidence.push({
      kind: "NOTE",
      summary: truncated ? `${text}\n(evidence text truncated to ${maxEvidenceChars} chars)` : text,
      reference: `cli://${tool}/run/${request.runId}/transcript`,
    });
  }

  if (processResult.stdoutTruncated || processResult.stderrTruncated) {
    evidence.push({
      kind: "NOTE",
      summary: `raw process output was bounded: stdoutTruncated=${processResult.stdoutTruncated}, stderrTruncated=${processResult.stderrTruncated}`,
      reference: `cli://${tool}/run/${request.runId}/output-bounds`,
    });
  }

  return evidence;
}

function buildSummary(
  tool: WorkerTool,
  model: string,
  request: WorkerRequest,
  processResult: ProcessResult,
  safeMessage: string | undefined,
  succeeded: boolean,
): string {
  const head = `[${tool}:${model}] role=${request.role} ${describeTermination(processResult)}`;
  if (succeeded) {
    return safeMessage === undefined || safeMessage.length === 0 ? head : `${head}: ${truncate(safeMessage, 200).text}`;
  }
  return `${head}: worker did not complete successfully`;
}

export function createCliWorker(config: CliWorkerAdapterConfig): Worker {
  return {
    id: config.id,
    capabilities: {
      roles: config.roles,
      // A real model behind the CLI is not guaranteed to answer identically twice.
      deterministic: false,
    },
    async execute(request: WorkerRequest): Promise<WorkerOutcome> {
      const prompt = buildWorkerPrompt(request.role, {
        workItemTitle: request.title,
        instructions: request.instructions,
        workspaceRoot: config.workspace.root,
        acceptanceCriteria: request.acceptanceCriteria,
      });

      const plan = config.buildInvocation({
        request,
        prompt,
        workspace: config.workspace,
        model: config.model,
        effort: config.effort,
      });

      const env = buildWorkerEnvironment(config.environmentPolicy);

      const processResult = await config.processRunner.run({
        executable: config.executable,
        argv: plan.argv,
        cwd: config.workspace.root,
        env,
        timeoutMs: config.timeoutMs,
        ...(plan.input === undefined ? {} : { input: plan.input }),
        ...(config.maxOutputBytes === undefined ? {} : { maxOutputBytes: config.maxOutputBytes }),
      });

      const reported = config.interpretOutput(processResult);
      // Redacted once, here — see safeFinalMessage's own comment for why
      // buildSummary/buildEvidence never read reported.finalMessage directly.
      const safeMessage = safeFinalMessage(reported);
      const succeeded = processResult.terminationReason === "EXITED" && processResult.exitCode === 0;
      const maxEvidenceChars = config.maxEvidenceChars ?? 4000;

      return {
        status: succeeded ? "SUCCEEDED" : "FAILED",
        summary: buildSummary(config.tool, config.model, request, processResult, safeMessage, succeeded),
        evidence: buildEvidence(config.tool, config.model, plan.effortApplication, request, processResult, safeMessage, maxEvidenceChars),
        // TASK-003 explicitly defers PASS/CHANGES_REQUIRED text parsing to TASK-004;
        // free-form model text is never trusted as a claim in the meantime.
        claimsAcceptanceMet: false,
      };
    },
  };
}
