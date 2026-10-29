/**
 * OpenCode CLI adapter (opt-in, explicit caller only).
 *
 * Invocation (opencode.ai/docs/cli): `opencode run --model PROVIDER/MODEL MESSAGE`,
 * where the complete built worker input is the single positional message. No
 * stdin copy, no shell interpolation, default formatted text output only.
 *
 * ACTUAL-DISPATCH PREREQUISITE: constructing this Worker admits nothing and is
 * not dispatch authority. `opencode run` may discover or start a shared
 * background server, and permissions depend on effective configuration with
 * permissive defaults. The caller must separately admit the executable,
 * version, effective configuration, extensions/MCP, agent, model, workspace,
 * data handling, credentials, billing, server behaviour and shared-server
 * process lifecycle/cancellation. This adapter proves no working model,
 * account, free quota, read-only, sandbox, paid-off or local-only behaviour.
 *
 * No --auto, --attach, --server, --share, --session, --continue, --fork,
 * --command, --agent, --file, --variant, limit, trust or permission flags are
 * set; omitted flags are not a policy guess.
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

export interface OpenCodeCliWorkerOptions {
  readonly id?: string;
  /** Overridable so tests use a stub runner; defaults to `opencode`. */
  readonly executable?: string;
  /** Required: lexical `provider/model`, no default. */
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

/** Returns a refusal reason, or undefined when the model string is acceptable. Lexical check only. */
export function validateOpenCodeModel(model: unknown): string | undefined {
  if (typeof model !== "string" || model.length === 0) {
    return "an OpenCode model must be named explicitly as a nonempty provider/model string; there is no default";
  }
  if (/\s/.test(model) || /[\u0000-\u001f\u007f]/.test(model)) {
    return "an OpenCode model must not contain whitespace, control or NUL characters";
  }
  if (model.startsWith("-")) {
    return "an OpenCode model must not begin with '-' (it would be read as an option)";
  }
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    return "an OpenCode model must be a nonempty provider, a slash, and a nonempty model (provider/model)";
  }
  if (model.slice(slash + 1).toLowerCase() === "auto") {
    return "an OpenCode model must be named explicitly; an automatic selector is refused";
  }
  return undefined;
}

export function resolveOpenCodeEffort(effort: string | undefined): EffortApplication {
  if (effort === undefined) {
    return { applied: false };
  }
  return {
    requested: effort,
    applied: false,
    reason:
      "the opencode --variant option is provider/model-specific and no mapping was independently admitted; effort is recorded as requested but not applied",
  };
}

/** Pure argv building: no I/O, no stdin copy, no hidden flags. */
export function buildOpenCodeInvocation(args: BuildInvocationArgs): CliInvocationPlan {
  if (args.prompt.startsWith("-")) {
    // The documented positional message has no verified end-of-options transport; refuse rather than invent one.
    throw new ValidationError("the OpenCode message must not begin with '-' (it would be read as an option)");
  }
  return {
    argv: ["run", "--model", args.model, args.prompt],
    effortApplication: resolveOpenCodeEffort(args.effort),
  };
}

/** Default formatted stdout is informational only; process result governs status. */
export function interpretOpenCodeOutput(processResult: ProcessResult): CliReportedResult {
  const text = processResult.stdout.trim();
  return text.length === 0 ? {} : { finalMessage: text };
}

export function createOpenCodeCliWorker(options: OpenCodeCliWorkerOptions): Worker {
  const modelProblem = validateOpenCodeModel(options.model);
  if (modelProblem !== undefined) {
    throw new ValidationError(modelProblem);
  }
  if (!Array.isArray(options.roles) || options.roles.length === 0) {
    throw new ValidationError("an OpenCode worker must declare at least one role; there is no default role list");
  }
  return createCliWorker({
    id: options.id ?? "opencode-cli",
    tool: "opencode-cli",
    roles: options.roles,
    executable: options.executable ?? "opencode",
    model: options.model,
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    timeoutMs: normalizeAuthorTimeoutMs(options.timeoutMs),
    workspace: options.workspace,
    processRunner: options.processRunner,
    environmentPolicy: options.environmentPolicy ?? DEFAULT_WORKER_ENVIRONMENT_POLICY,
    buildInvocation: buildOpenCodeInvocation,
    interpretOutput: interpretOpenCodeOutput,
  });
}
