/**
 * `sf worker doctor` — reports whether the Claude Code and Codex CLIs are
 * findable on this machine, and their version, without ever printing
 * credentials (TASK-003 item 15).
 */

import { createNodeProcessRunner } from "../adapters/process/nodeProcessRunner.js";
import { buildWorkerEnvironment, DEFAULT_WORKER_ENVIRONMENT_POLICY } from "../adapters/workers/environmentPolicy.js";
import type { ProcessRunner } from "../ports/processRunner.js";

export interface CliDoctorReport {
  readonly tool: string;
  readonly executable: string;
  readonly found: boolean;
  readonly version?: string;
  readonly detail?: string;
}

export interface WorkerDoctorOptions {
  readonly processRunner?: ProcessRunner;
  readonly claudeExecutable?: string;
  readonly codexExecutable?: string;
  readonly log?: (line: string) => void;
}

export interface WorkerDoctorResult {
  readonly claude: CliDoctorReport;
  readonly codex: CliDoctorReport;
}

async function detectCli(tool: string, executable: string, runner: ProcessRunner): Promise<CliDoctorReport> {
  const result = await runner.run({
    executable,
    argv: ["--version"],
    cwd: process.cwd(),
    env: buildWorkerEnvironment(DEFAULT_WORKER_ENVIRONMENT_POLICY),
    timeoutMs: 5000,
  });

  if (result.terminationReason === "SPAWN_ERROR") {
    return { tool, executable, found: false, detail: result.spawnError ?? "spawn failed" };
  }
  if (result.terminationReason !== "EXITED" || result.exitCode !== 0) {
    return {
      tool,
      executable,
      found: true,
      detail: `"${executable} --version" did not exit cleanly (${result.terminationReason}, exit=${String(result.exitCode)})`,
    };
  }
  const version = result.stdout.trim().length > 0 ? result.stdout.trim() : result.stderr.trim();
  return { tool, executable, found: true, ...(version.length > 0 ? { version } : {}) };
}

function describe(report: CliDoctorReport): string {
  if (!report.found) {
    return `${report.tool}: NOT FOUND (tried "${report.executable}") — ${report.detail ?? "no further detail"}`;
  }
  if (report.version !== undefined) {
    return `${report.tool}: found (${report.executable}), version: ${report.version}`;
  }
  return `${report.tool}: found (${report.executable}), but ${report.detail ?? "--version behaved unexpectedly"}`;
}

export async function runWorkerDoctor(options: WorkerDoctorOptions = {}): Promise<WorkerDoctorResult> {
  const emit = options.log ?? ((): void => {});
  const runner = options.processRunner ?? createNodeProcessRunner();

  const claude = await detectCli("claude-code (claude)", options.claudeExecutable ?? "claude", runner);
  const codex = await detectCli("codex-cli (codex)", options.codexExecutable ?? "codex", runner);

  emit(describe(claude));
  emit(describe(codex));

  return { claude, codex };
}
