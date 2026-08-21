/**
 * Builds a real CLI-backed `Worker` from loop configuration (TASK-004 §3).
 *
 * Deliberately does not hardcode "Claude implements, Codex reviews" — the
 * `tool` field of a `LoopWorkerConfig` selects the adapter; the same
 * function is used for both the IMPLEMENTER and REVIEWER role. Independence
 * between the two is never decided here by comparing `tool`/`model` strings
 * (see design doc §3) — the caller always constructs two separate `Worker`
 * objects, and the actual C4 enforcement stays in
 * `FactoryService.recordReview`.
 */

import { createClaudeCodeWorker } from "../adapters/workers/claudeCodeAdapter.js";
import { createCodexCliWorker } from "../adapters/workers/codexCliAdapter.js";
import { DEFAULT_WORKER_TIMEOUT_MS } from "../adapters/workers/workerModelConfig.js";
import type { Workspace } from "../adapters/workers/workspace.js";
import { ValidationError } from "../domain/errors.js";
import type { FactoryRole } from "../domain/role.js";
import type { ProcessRunner } from "../ports/processRunner.js";
import type { Worker } from "../ports/worker.js";
import type { LoopWorkerConfig } from "./loopTypes.js";

export interface LoopWorkerFactoryOptions {
  readonly workspace: Workspace;
  readonly processRunner: ProcessRunner;
  readonly roles: readonly FactoryRole[];
  readonly defaultTimeoutMs?: number;
  readonly executable?: string;
}

export function createLoopWorker(config: LoopWorkerConfig, options: LoopWorkerFactoryOptions): Worker {
  const shared = {
    ...(options.executable === undefined ? {} : { executable: options.executable }),
    model: config.model,
    ...(config.effort === undefined ? {} : { effort: config.effort }),
    timeoutMs: config.timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS,
    workspace: options.workspace,
    processRunner: options.processRunner,
    roles: options.roles,
  };

  switch (config.tool) {
    case "claude-code":
      return createClaudeCodeWorker(shared);
    case "codex-cli":
      return createCodexCliWorker(shared);
    default: {
      const exhaustive: never = config.tool;
      throw new ValidationError(`unsupported worker tool: ${String(exhaustive)}`);
    }
  }
}
