/**
 * Gemini CLI adapter (opt-in, explicit caller only).
 *
 * Invocation (geminicli.com/docs/cli/cli-reference, /docs/cli/headless):
 * `gemini --model MODEL --output-format json --prompt PROMPT`, where the
 * complete built prompt is the single value of --prompt. Headless output is one
 * JSON envelope `{ response: string, stats: object, error?: ... }`.
 *
 * ACTUAL-DISPATCH PREREQUISITE: constructing this Worker admits nothing and is
 * not dispatch authority. The caller must separately admit the executable,
 * version, configuration, tool policy, extensions/MCP, workspace, auth, model
 * availability, data handling and quota/billing behaviour. This adapter proves
 * no account, free quota, effective model, local-only or read-only behaviour.
 *
 * No approval-mode, yolo, trust, tool-allow or policy flags are set. Plan mode
 * is NOT a read-only boundary (noninteractive plan exit may switch to YOLO).
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

export interface GeminiCliWorkerOptions {
  readonly id?: string;
  /** Overridable so tests use a stub runner; defaults to `gemini`. */
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
export function validateGeminiModel(model: unknown): string | undefined {
  if (typeof model !== "string" || model.length === 0) {
    return "a Gemini model must be named explicitly as a nonempty string; there is no default";
  }
  if (/\s/.test(model) || /\0/.test(model)) {
    return "a Gemini model must be a single token without whitespace, NUL or newline characters";
  }
  if (model.startsWith("-")) {
    return "a Gemini model must not begin with '-' (it would be read as an option)";
  }
  if (model.toLowerCase() === "auto") {
    return "a Gemini model must be named explicitly; the automatic selector 'auto' is refused";
  }
  return undefined;
}

export function resolveGeminiEffort(effort: string | undefined): EffortApplication {
  if (effort === undefined) {
    return { applied: false };
  }
  return {
    requested: effort,
    applied: false,
    reason: "the gemini CLI has no verified effort option; effort is recorded as requested but not applied",
  };
}

/** Pure argv building: no I/O, no stdin copy, no hidden flags. */
export function buildGeminiInvocation(args: BuildInvocationArgs): CliInvocationPlan {
  return {
    argv: ["--model", args.model, "--output-format", "json", "--prompt", args.prompt],
    effortApplication: resolveGeminiEffort(args.effort),
  };
}

/**
 * Parses only an ordinary single JSON object carrying its own string
 * `response` and no own non-null `error`. Anything else yields no message.
 * Informational only: the process result governs status.
 */
export function interpretGeminiOutput(processResult: ProcessResult): CliReportedResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(processResult.stdout);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  if (Object.prototype.hasOwnProperty.call(parsed, "error") && (parsed as { error?: unknown }).error != null) {
    return {};
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, "response")) {
    return {};
  }
  const response = (parsed as { response?: unknown }).response;
  if (typeof response !== "string") {
    return {};
  }
  const text = response.trim();
  return text.length === 0 ? {} : { finalMessage: text };
}

export function createGeminiCliWorker(options: GeminiCliWorkerOptions): Worker {
  const modelProblem = validateGeminiModel(options.model);
  if (modelProblem !== undefined) {
    throw new ValidationError(modelProblem);
  }
  if (!Array.isArray(options.roles) || options.roles.length === 0) {
    throw new ValidationError("a Gemini worker must declare at least one role; there is no default role list");
  }
  return createCliWorker({
    id: options.id ?? "gemini-cli",
    tool: "gemini-cli",
    roles: options.roles,
    executable: options.executable ?? "gemini",
    model: options.model,
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    timeoutMs: normalizeAuthorTimeoutMs(options.timeoutMs),
    workspace: options.workspace,
    processRunner: options.processRunner,
    environmentPolicy: options.environmentPolicy ?? DEFAULT_WORKER_ENVIRONMENT_POLICY,
    buildInvocation: buildGeminiInvocation,
    interpretOutput: interpretGeminiOutput,
  });
}
