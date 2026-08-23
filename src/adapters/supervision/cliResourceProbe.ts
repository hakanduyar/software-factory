/**
 * The REAL zero-token availability probe (TASK-006 §6).
 *
 * Uses only commands measured on this machine, each of which is a local or
 * auth-status check that consumes no model quota:
 *
 *   codex doctor --json    -> checks["auth.credentials"].status, and
 *                             .details{"stored auth mode","stored API key"}
 *   claude auth status     -> {loggedIn, authMethod, apiProvider, subscriptionType}
 *
 * Measured on this installation (claude 2.1.238, codex-cli 0.149.0): a
 * subscription-backed session reports `apiProvider:"firstParty"` with
 * `subscriptionType:"max"`, and codex reports `"stored auth mode":"chatgpt"`
 * with `"stored API key":"false"`. Those exact fields — not the surrounding
 * prose — are what `claudeBillingModeFrom`/`codexBillingModeFrom` read to decide
 * whether using the resource is a FINANCIAL action (NEW-FIN-1).
 *
 * NO MODEL IS EVER INVOKED HERE. Asking a model whether a model is available is
 * the exact circularity TASK-006 exists to remove, and it would also consume
 * the very quota the probe is trying to measure.
 *
 * What this probe can and cannot tell you, stated honestly: it proves
 * authentication and local health. It does NOT prove remaining quota, because
 * neither CLI exposes quota without spending some. A resource that passes this
 * probe is therefore "not known to be unusable" — and the moment a real run
 * fails, `classifyResourceOutcome` records the truth and the backoff ladder
 * takes over. That ordering (cheap probe first, real evidence second) is what
 * keeps waiting free.
 */

import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

import { ValidationError } from "../../domain/errors.js";
import type { ProcessRunner } from "../../ports/processRunner.js";
import {
  interpretClaudeAuthStatus,
  interpretCodexDoctorJson,
  type Classification,
} from "../../supervision/resourceClassifier.js";
import type { ResourceProbe } from "../../supervision/supervisorPorts.js";
import { DEFAULT_WORKER_ENVIRONMENT_POLICY, type EnvironmentPolicy } from "../workers/environmentPolicy.js";

export interface CliResourceProbeDeps {
  readonly processRunner: ProcessRunner;
  /**
   * ABSOLUTE paths to the provider CLIs. Overridable so tests point at fake
   * executables — but never a bare name.
   *
   * Review finding F-7 (HIGH): these defaulted to `"claude"`/`"codex"` while
   * the environment policy forwards `PATH`, so a shim earlier in `PATH` was
   * executed and reported both resources healthy. A bare name is a request for
   * whatever the environment feels like providing; an absolute path is a
   * decision. TASK-003 already refuses to let model output choose a working
   * directory — the executable deserves the same treatment.
   */
  readonly claudeExecutable?: string;
  readonly codexExecutable?: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly environmentPolicy?: EnvironmentPolicy;
}

const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
/** A status payload is small; anything larger is a malfunctioning CLI. */
const MAX_PROBE_OUTPUT_BYTES = 256 * 1024;

/**
 * Resolves a CLI to an absolute path ONCE, at construction.
 *
 * This still consults PATH — there is no way to find an installed CLI without
 * doing so — but it does it exactly once, in a controlled place, and the
 * resolved absolute path is what every later probe executes. That converts a
 * per-invocation lookup (which a shim could win at any time) into a single
 * startup decision that a reviewer can inspect and a caller can override.
 */
function resolveFromPathOnce(name: string): string {
  // NO SHELL. The review flagged the earlier `sh -c "command -v ${name}"` as
  // interpolation; it was reachable only with internal constants, but a lookup
  // that cannot interpolate is simply better than one that merely happens not
  // to. `which` takes the name as an argument, so nothing is ever parsed.
  const result = spawnSync("/usr/bin/which", [name], { encoding: "utf8" });
  const resolved = result.stdout.trim().split("\n")[0] ?? "";
  if (result.status !== 0 || resolved.length === 0) {
    throw new ValidationError(
      `the ${name} CLI could not be located; configure an absolute executable path explicitly`,
    );
  }
  return resolved;
}

/** F-7: a probe executable must be an explicit absolute path, never PATH lookup. */
function requireAbsolute(executable: string, label: string): string {
  if (!isAbsolute(executable)) {
    throw new ValidationError(
      `the ${label} probe executable must be an absolute path, got "${executable}"; a bare name would be resolved through PATH and could be substituted`,
    );
  }
  return executable;
}

export function createCliResourceProbe(deps: CliResourceProbeDeps): ResourceProbe {
  const policy = deps.environmentPolicy ?? DEFAULT_WORKER_ENVIRONMENT_POLICY;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const claudeExecutable = requireAbsolute(deps.claudeExecutable ?? resolveFromPathOnce("claude"), "claude");
  const codexExecutable = requireAbsolute(deps.codexExecutable ?? resolveFromPathOnce("codex"), "codex");

  async function run(executable: string, argv: readonly string[]) {
    return deps.processRunner.run({
      executable,
      argv,
      cwd: deps.cwd,
      // Same allow-listed environment the accepted worker layer uses: a probe
      // is not a reason to hand a child process the whole environment.
      env: buildEnv(policy),
      timeoutMs,
      maxOutputBytes: MAX_PROBE_OUTPUT_BYTES,
    });
  }

  return {
    async probe(provider: string, model: string): Promise<Classification> {
      void model; // Neither CLI exposes per-model availability without spending.

      /**
       * F-4 (HIGH): this previously checked only `terminationReason`, so a CLI
       * that exited NON-ZERO while printing healthy-looking JSON was reported
       * AVAILABLE. Process exit status is the OS's own verdict and outranks
       * anything the process chose to print — the same rule TASK-003 applies
       * when it refuses to let stdout override `exitCode`.
       */
      function requireCleanExit(
        result: { terminationReason: string; exitCode: number | null },
        label: string,
      ): Classification | undefined {
        if (result.terminationReason !== "EXITED") {
          return { state: "PROVIDER_UNAVAILABLE", reason: `${label} did not complete (${result.terminationReason})` };
        }
        if (result.exitCode !== 0) {
          return {
            state: "UNKNOWN_FAILURE",
            reason: `${label} exited ${String(result.exitCode)}; its output is not trusted`,
          };
        }
        return undefined;
      }

      if (provider === "claude-code") {
        const result = await run(claudeExecutable, ["auth", "status"]);
        return requireCleanExit(result, "claude auth status") ?? interpretClaudeAuthStatus(result.stdout);
      }

      if (provider === "codex-cli") {
        const result = await run(codexExecutable, ["doctor", "--json"]);
        return requireCleanExit(result, "codex doctor") ?? interpretCodexDoctorJson(result.stdout);
      }

      // An unknown provider is not optimistically assumed usable.
      throw new ValidationError(`no zero-token probe is defined for provider "${provider}"`);
    },
  };
}

function buildEnv(policy: EnvironmentPolicy): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const name of policy.allowedVars) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}
