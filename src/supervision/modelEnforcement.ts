/**
 * Model and effort enforcement (TASK-006 §8).
 *
 * Writing `MODEL: X` and `EFFORT: Y` in a prompt proves nothing whatsoever
 * about the process that actually ran. This module makes both into real
 * launcher-level configuration, and records the difference between what was
 * ASKED FOR, what can be PROVEN, and what is merely assumed.
 *
 * It builds the argv using the same pure builders the accepted TASK-003
 * adapters use, from flags measured on this machine:
 *
 *   claude  --model <m> --effort <level> -p --output-format json ...
 *   codex   -m <m> -c model_reasoning_effort=<level> -s <sandbox> ...
 *
 * THE HONESTY RULE. `effective*` is marked `VERIFIED_EFFECTIVE` only when the
 * provider itself echoes the identity back. Where it does not, the record says
 * `UNVERIFIED` — because recording an unverified claim as verified is precisely
 * the defect this task was created to remove. The argv is still captured as
 * evidence: it is a genuinely stronger proof of intent than prompt text, and it
 * is deterministic.
 *
 * NO SILENT DOWNGRADE. If a requested effort cannot be applied by the installed
 * CLI, this refuses rather than quietly running at the default. Proceeding at an
 * unrequested effort is exactly the substitution the mandate forbids.
 */

import { buildClaudeInvocation, resolveClaudeEffort } from "../adapters/workers/claudeCodeAdapter.js";
import { buildCodexInvocation, resolveCodexEffort } from "../adapters/workers/codexCliAdapter.js";
import { redactSecrets } from "../adapters/workers/environmentPolicy.js";
import type { WorkerTool } from "../adapters/workers/workerModelConfig.js";
import type { Workspace } from "../adapters/workers/workspace.js";
import type { FactoryRole } from "../domain/role.js";

export const CONFIG_VERIFICATIONS = ["VERIFIED_EFFECTIVE", "UNVERIFIED", "MISMATCH"] as const;

export type ConfigVerification = (typeof CONFIG_VERIFICATIONS)[number];

export interface AiRunConfigRequest {
  readonly provider: WorkerTool;
  readonly model: string;
  readonly effort?: string;
  readonly role: FactoryRole;
  /**
   * The workspace the run would execute in. Only its `root` reaches argv (Codex
   * passes `-C <root>`), and it is trusted configuration supplied by the
   * wiring — never derived from model output (TASK-003's boundary).
   */
  readonly workspace?: Workspace;
}

/** Stands in for a real workspace when only the argv SHAPE is being recorded. */
const PROBE_WORKSPACE: Workspace = { root: "<workspace>", repositoryRoot: "<workspace>" };

export interface AiRunConfigRecord {
  readonly requestedProvider: string;
  readonly requestedModel: string;
  readonly requestedEffort?: string;
  readonly effectiveProvider: string;
  readonly effectiveModel: string;
  readonly effectiveEffort?: string;
  readonly verification: ConfigVerification;
  /**
   * The argv that will actually be executed, with the prompt replaced by a
   * placeholder. Deterministic proof of what was requested at process level;
   * never carries prompt content or a credential.
   */
  readonly argvEvidence: readonly string[];
  readonly note: string;
}

export type AiRunConfigResult =
  | { readonly ok: true; readonly value: AiRunConfigRecord }
  | { readonly ok: false; readonly reason: string };

/** Stands in for the real prompt so argv can be recorded without leaking content. */
const PROMPT_PLACEHOLDER = "<prompt-redacted>";

/**
 * Codex reasoning-effort values this build will pass.
 *
 * HONESTY NOTE (review finding, honesty audit). `codex exec --help` documents
 * the `-c key=value` MECHANISM but does not enumerate the accepted values for
 * `model_reasoning_effort`, so this list is NOT "measured from help output".
 * What IS measured is that `xhigh` works: every TASK-005 independent acceptance
 * review in this repository ran successfully with
 * `-c model_reasoning_effort="xhigh"`. The remaining rungs follow the same
 * documented scale Claude Code exposes via `--effort`.
 *
 * The list exists so an unsupported value is REFUSED rather than silently
 * passed through and reported as applied — refusing a value we cannot vouch for
 * is the conservative direction.
 */
export const SUPPORTED_CODEX_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh"] as const);

/**
 * Models this build will launch, per provider (NEW-MODEL-1).
 *
 * Configuration, not architecture — C9 forbids a core object requiring a
 * specific vendor, and this is one of the two places a vendor name legitimately
 * appears (the other is the routing policy). Adding one is a deliberate,
 * reviewable edit rather than something a caller can do by passing a string.
 *
 * HONESTY NOTE (round 10). An earlier version of this comment claimed every
 * entry "has actually been run against its CLI in this repository". That is
 * true of `opus` and `gpt-5.6-luna`, which have run here many times; it is NOT
 * independently evidenced for `sonnet` or `haiku`, which are documented models
 * of an installed CLI rather than ones this repository can point at a
 * transcript for. Corrected rather than defended, because a claim of having
 * measured something is exactly the kind this task has had to retract before.
 */
export const SUPPORTED_MODELS: Readonly<Record<WorkerTool, readonly string[]>> = Object.freeze({
  "claude-code": Object.freeze(["opus", "sonnet", "haiku"]),
  "codex-cli": Object.freeze(["gpt-5.6-luna"]),
});

/**
 * Builds and validates the launcher configuration for one AI run.
 *
 * Refuses — rather than downgrading — when the installed CLI cannot honour the
 * request.
 */
export function planAiRunConfig(request: AiRunConfigRequest): AiRunConfigResult {
  if (request.model.trim().length === 0) {
    return { ok: false, reason: "a model must be named explicitly; there is no implicit default" };
  }

  /**
   * NEW-MODEL-1 (HIGH): any model name at all was accepted and recorded as
   * UNVERIFIED, so a typo or an injected identifier reached argv and AC-12's
   * "unsupported model fails closed" was not actually enforced. `UNVERIFIED`
   * is an honest label for "the provider did not echo this back" — it is not a
   * licence to launch a model nobody recognises.
   */
  // F4-7: read defensively. `request.provider` is typed, but a forged value
  // reaching here at runtime must refuse rather than throw on `undefined`.
  const supported = Object.prototype.hasOwnProperty.call(SUPPORTED_MODELS, request.provider)
    ? SUPPORTED_MODELS[request.provider]
    : undefined;
  if (supported === undefined) {
    return { ok: false, reason: `"${String(request.provider)}" is not a supported provider` };
  }
  if (!supported.includes(request.model)) {
    return {
      ok: false,
      reason: `model "${request.model}" is not a supported ${request.provider} model (${supported.join(", ")})`,
    };
  }

  // F-9 (HIGH): the accepted Codex adapter passes effort through as a TOML
  // config override and accepts any lexical token, so a bogus value like
  // "not-a-real-effort" reached argv and was reported as applied. The accepted
  // adapter is not weakened here; this layer validates BEFORE using it, which
  // is where the supervisor's own "no silent downgrade" promise lives.
  if (request.provider === "codex-cli" && request.effort !== undefined) {
    if (!(SUPPORTED_CODEX_EFFORTS as readonly string[]).includes(request.effort)) {
      return {
        ok: false,
        reason: `effort "${request.effort}" is not a supported codex reasoning effort (${SUPPORTED_CODEX_EFFORTS.join(", ")})`,
      };
    }
  }

  const effortResolution =
    request.provider === "claude-code" ? resolveClaudeEffort(request.effort) : resolveCodexEffort(request.effort);

  // NO SILENT DOWNGRADE: an effort that was asked for and cannot be applied is
  // a refusal, not a shrug.
  if (request.effort !== undefined && !effortResolution.application.applied) {
    return {
      ok: false,
      reason: `effort "${request.effort}" cannot be applied by the installed ${request.provider}: ${
        effortResolution.application.reason ?? "the CLI does not support it"
      }`,
    };
  }

  const args = {
    request: {
      runId: "config-probe",
      workItemId: "config-probe",
      role: request.role,
      title: "configuration probe",
      instructions: PROMPT_PLACEHOLDER,
      acceptanceCriteria: [],
    },
    prompt: PROMPT_PLACEHOLDER,
    model: request.model,
    workspace: request.workspace ?? PROBE_WORKSPACE,
    // `BuildInvocationArgs.effort` is required-but-nullable, so it is always
    // passed; the adapters report separately whether they could apply it.
    effort: request.effort,
  };

  const plan = request.provider === "claude-code" ? buildClaudeInvocation(args) : buildCodexInvocation(args);

  return {
    ok: true,
    value: {
      requestedProvider: request.provider,
      requestedModel: request.model,
      ...(request.effort === undefined ? {} : { requestedEffort: request.effort }),
      effectiveProvider: request.provider,
      effectiveModel: request.model,
      ...(request.effort === undefined ? {} : { effectiveEffort: request.effort }),
      // The provider does not echo its own model identity back in a form we can
      // trust, so this is honestly UNVERIFIED rather than falsely VERIFIED.
      verification: "UNVERIFIED",
      argvEvidence: [...plan.argv],
      note: "argv proves what was requested at process level; the provider does not report effective model identity, so it is not claimed as verified",
    },
  };
}

/**
 * Reconciles a recorded configuration against an identity the provider DID
 * report. This is the only path that may produce `VERIFIED_EFFECTIVE`, and a
 * contradiction fails closed as `MISMATCH`.
 *
 * REVIEW FINDING F4-8 (HIGH): the first version verified the record as a whole
 * once the model matched, so a run requesting `opus/high` whose provider echoed
 * only `{model:"opus"}` was recorded `VERIFIED_EFFECTIVE` — claiming the EFFORT
 * had been confirmed when nothing about it had been observed. It also accepted a
 * reported effort that had never been requested as a match.
 *
 * Each requested dimension is now verified independently, and the record is only
 * `VERIFIED_EFFECTIVE` when EVERY requested dimension was confirmed:
 *
 *   - model absent from the report  -> nothing observed; record unchanged
 *   - model differs                 -> MISMATCH
 *   - effort requested, not reported-> UNVERIFIED (partial evidence is not proof)
 *   - effort requested, differs     -> MISMATCH
 *   - effort NOT requested, reported-> MISMATCH (the provider applied something
 *                                      the request did not ask for, which is a
 *                                      divergence worth surfacing, not swallowing)
 *
 * "Verified" has to mean verified. A status that is optimistic about the parts
 * it did not check is worth less than an honest `UNVERIFIED`.
 */
export function reconcileReportedIdentity(
  record: AiRunConfigRecord,
  reported: { readonly provider?: string; readonly model?: string; readonly effort?: string },
): AiRunConfigRecord {
  /**
   * REVIEW FINDING F5-ID-1 (HIGH): this used to return early whenever
   * `reported.model` was absent, so a worker reporting `{ effort: "low" }` for a
   * run configured as `high` was recorded UNVERIFIED and then advanced to DONE.
   * A contradiction on ANY dimension is a contradiction. And provider was not a
   * dimension at all, so a worker could switch providers while echoing a
   * matching model.
   *
   * REVIEW FINDING F5-ID-2 (HIGH): the reported strings were written straight
   * into durable state, so a worker reporting a model named after a credential
   * put that credential in the supervisor's database. Provider-reported text is
   * untrusted input like any other.
   */
  const safe = (value: string): string => boundedIdentity(value);
  /**
   * R7-ID-1: read OWN properties only, and only non-empty strings.
   *
   * An object inheriting `model: "opus"` from a polluted prototype reported
   * nothing — but was read as though it had, and could reach
   * `VERIFIED_EFFECTIVE`. An empty string is equally not a statement. A field
   * the report does not actually contain is silence, and silence is handled
   * below as unverified rather than as agreement.
   */
  const own = (field: "provider" | "model" | "effort"): string | undefined => {
    if (!Object.prototype.hasOwnProperty.call(reported, field)) {
      return undefined;
    }
    const value = reported[field];
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  };
  const dimensions: {
    readonly name: string;
    readonly requested: string | undefined;
    readonly reported: string | undefined;
  }[] = [
    { name: "provider", requested: record.requestedProvider, reported: own("provider") },
    { name: "model", requested: record.requestedModel, reported: own("model") },
    { name: "effort", requested: record.requestedEffort, reported: own("effort") },
  ];

  if (dimensions.every((dimension) => dimension.reported === undefined)) {
    return record;
  }

  const [providerDimension, modelDimension, effortDimension] = dimensions as [
    (typeof dimensions)[number],
    (typeof dimensions)[number],
    (typeof dimensions)[number],
  ];
  const withEffective: AiRunConfigRecord = {
    ...record,
    ...(providerDimension.reported === undefined
      ? {}
      : { effectiveProvider: safe(providerDimension.reported) }),
    ...(modelDimension.reported === undefined ? {} : { effectiveModel: safe(modelDimension.reported) }),
    ...(effortDimension.reported === undefined ? {} : { effectiveEffort: safe(effortDimension.reported) }),
  };

  for (const dimension of dimensions) {
    if (dimension.reported === undefined) {
      continue;
    }
    if (dimension.requested === undefined) {
      return {
        ...withEffective,
        verification: "MISMATCH",
        note: `provider reported ${dimension.name} "${safe(dimension.reported)}" but none was requested`,
      };
    }
    if (dimension.reported !== dimension.requested) {
      return {
        ...withEffective,
        verification: "MISMATCH",
        note: `provider reported ${dimension.name} "${safe(dimension.reported)}" but "${dimension.requested}" was requested`,
      };
    }
  }

  // Nothing contradicts. That is only VERIFIED if every REQUESTED dimension was
  // actually confirmed; a silent dimension is unverified, not agreed.
  const unconfirmed = dimensions
    .filter((dimension) => dimension.requested !== undefined && dimension.reported === undefined)
    .map((dimension) => dimension.name);
  if (unconfirmed.length > 0) {
    return {
      ...withEffective,
      verification: "UNVERIFIED",
      note: `provider confirmed ${dimensions
        .filter((dimension) => dimension.reported !== undefined)
        .map((dimension) => dimension.name)
        .join(", ")} but reported no ${unconfirmed.join(", ")}, which therefore remains unverified`,
    };
  }

  return {
    ...withEffective,
    verification: "VERIFIED_EFFECTIVE",
    note: "the provider reported an identity matching every requested dimension",
  };
}

/**
 * Bounds and redacts one provider-reported identity string (F5-ID-2).
 *
 * An identity is a short token like `opus` or `xhigh`. Anything long, anything
 * containing whitespace or a credential shape, is not an identity — so it is
 * redacted and truncated hard before it can reach durable state or a log.
 */
function boundedIdentity(value: string): string {
  const redacted = redactSecrets(value).replace(/\s+/g, " ").trim();
  return redacted.length > MAX_IDENTITY_LENGTH ? `${redacted.slice(0, MAX_IDENTITY_LENGTH)}…` : redacted;
}

const MAX_IDENTITY_LENGTH = 64;
