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
import { normalizeAuthorTimeoutMs } from "../adapters/workers/workerModelConfig.js";
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
  /** Absent/`null`: no total author deadline. A finite value is refused when the worker is constructed. */
  readonly defaultTimeoutMs?: number | null;
  readonly executable?: string;
}

export function createLoopWorker(config: LoopWorkerConfig, options: LoopWorkerFactoryOptions): Worker {
  const shared = {
    ...(options.executable === undefined ? {} : { executable: options.executable }),
    model: config.model,
    ...(config.effort === undefined ? {} : { effort: config.effort }),
    // Explicit null must stay null: no `??` fallback to a finite value. Finite/malformed values are
    // refused by createCliWorker before any process runner call.
    timeoutMs: normalizeAuthorTimeoutMs(config.timeoutMs !== undefined ? config.timeoutMs : options.defaultTimeoutMs),
    workspace: options.workspace,
    processRunner: options.processRunner,
    roles: options.roles,
  };

  switch (config.tool) {
    case "claude-code":
      return createClaudeCodeWorker(shared);
    case "codex-cli":
      return createCodexCliWorker(shared);
    case "ollama-cli":
      throw new ValidationError("supervised ollama-cli admission is unavailable; no worker was constructed");
    case "gemini-cli":
      throw new ValidationError(
        "supervised gemini-cli model/server/account/tool-policy admission is unavailable; no worker was constructed",
      );
    default: {
      const exhaustive: never = config.tool;
      throw new ValidationError(`unsupported worker tool: ${String(exhaustive)}`);
    }
  }
}
