/**
 * Ollama CLI adapter (opt-in, explicit caller only).
 *
 * Invocation (docs.ollama.com/cli): `ollama run MODEL`, with the complete
 * prompt written to a non-terminal stdin. No positional prompt, no flags.
 *
 * ACTUAL-DISPATCH PREREQUISITE: constructing this Worker admits nothing. The
 * `ollama` CLI may automatically pull a missing model and may resolve cloud
 * models, so a loopback/client environment does not establish local-only or
 * free operation. Before a real dispatch the caller must separately admit the
 * executable, server, model availability, download behaviour and any
 * cloud/billing behaviour. This adapter makes no such claim and has no
 * local-only switch.
 *
 * There is deliberately no default model and no default role list.
 */

import { ValidationError } from "../../domain/errors.js";
import type { FactoryRole } from "../../domain/role.js";
import type { ProcessResult, ProcessRunner } from "../../ports/processRunner.js";
import type { Worker } from "../../ports/worker.js";
import type { BuildInvocationArgs, CliInvocationPlan, CliReportedResult } from "./cliWorker.js";
import { createCliWorker } from "./cliWorker.js";
import { DEFAULT_WORKER_ENVIRONMENT_POLICY, type EnvironmentPolicy } from "./environmentPolicy.js";
import { normalizeAuthorTimeoutMs, type EffortApplication } from "./workerModelConfig.js";
import type { Workspace } from "./workspace.js";

export interface OllamaCliWorkerOptions {
  readonly id?: string;
  /** Overridable so tests use a stub runner; defaults to `ollama`. */
  readonly executable?: string;
  /** Required: no default model. */
  readonly model: string;
  readonly effort?: string;
  /** Author execution has no total deadline: absent/`null` mean none; a finite value is refused by createCliWorker. */
  readonly timeoutMs?: number | null;
  readonly workspace: Workspace;
  readonly processRunner: ProcessRunner;
  readonly environmentPolicy?: EnvironmentPolicy;
  /** Required and non-empty: declared roles are preserved exactly. */
  readonly roles: readonly FactoryRole[];
}

/** Returns a refusal reason, or undefined when the model string is acceptable. */
export function validateOllamaModel(model: string): string | undefined {
  if (typeof model !== "string" || model.trim().length === 0) {
    return "an Ollama model must be named explicitly; there is no default";
  }
  if (model.startsWith("-") || model.trimStart().startsWith("-")) {
    return "an Ollama model must not begin with '-' (it would be read as an option)";
  }
  if (/[\0\r\n]/.test(model)) {
    return "an Ollama model must not contain NUL or newline characters";
  }
  return undefined;
}

export function resolveOllamaEffort(effort: string | undefined): EffortApplication {
  if (effort === undefined) {
    return { applied: false };
  }
  return {
    requested: effort,
    applied: false,
    reason: "the ollama run CLI has no verified effort option; effort is recorded as requested but not applied",
  };
}

/** Pure argv/stdin building: no I/O. */
export function buildOllamaInvocation(args: BuildInvocationArgs): CliInvocationPlan {
  return {
    argv: ["run", args.model],
    input: args.prompt,
    effortApplication: resolveOllamaEffort(args.effort),
  };
}

/** Plain stdout is informational only; process result governs status. */
export function interpretOllamaOutput(processResult: ProcessResult): CliReportedResult {
  const text = processResult.stdout.trim();
  return text.length === 0 ? {} : { finalMessage: text };
}

export function createOllamaCliWorker(options: OllamaCliWorkerOptions): Worker {
  const modelProblem = validateOllamaModel(options.model);
  if (modelProblem !== undefined) {
    throw new ValidationError(modelProblem);
  }
  if (!Array.isArray(options.roles) || options.roles.length === 0) {
    throw new ValidationError("an Ollama worker must declare at least one role; there is no default role list");
  }
  return createCliWorker({
    id: options.id ?? "ollama-cli",
    tool: "ollama-cli",
    roles: options.roles,
    executable: options.executable ?? "ollama",
    model: options.model,
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    timeoutMs: normalizeAuthorTimeoutMs(options.timeoutMs),
    workspace: options.workspace,
    processRunner: options.processRunner,
    environmentPolicy: options.environmentPolicy ?? DEFAULT_WORKER_ENVIRONMENT_POLICY,
    buildInvocation: buildOllamaInvocation,
    interpretOutput: interpretOllamaOutput,
  });
}
