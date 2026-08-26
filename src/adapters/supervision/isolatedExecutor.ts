/**
 * A `WorkExecutor` that runs in ITS OWN PROCESS (TASK-011).
 *
 * ================================================================
 * THE GAP THIS CLOSES
 * ================================================================
 * TASK-006 findings F5-FIN-3 and F6-FIN-2: the financial gate authorises a
 * LAUNCH, and cannot police what in-process executor code does afterwards,
 * because an in-process function cannot restrain code that can already call
 * `fetch`. Every supervisor guard decides whether to CALL the executor; none of
 * them constrain it once called.
 *
 * A child process can be constrained by what it is GIVEN. This gives it an
 * explicit environment with no credential store, a bounded request, and a
 * timeout — and treats everything it says as untrusted.
 *
 * ================================================================
 * WHAT THIS IS NOT — read this before claiming the executor is sandboxed
 * ================================================================
 * THIS IS NOT A NETWORK SANDBOX. Raw egress is NOT blocked. A child can still
 * open a socket, and nothing here stops it.
 *
 * Blocking egress needs OS-level privilege — a network namespace, seccomp, or a
 * firewall rule — and acquiring that privilege needs a sudo password, which
 * ADR-0002 reserves to the human and autonomous work cannot obtain. Building
 * something that LOOKED like a sandbox without that privilege would manufacture
 * assurance rather than provide it, which is the overstatement this project has
 * removed over and over.
 *
 * WHAT IS ACTUALLY REMOVED IS BILLING CAPABILITY, which is the property
 * `AUTONOMOUS_SPEND_LIMIT = 0` depends on. The allowlist below deliberately
 * omits `HOME`, `CODEX_HOME` and `XDG_*`: the provider CLIs authenticate from
 * credential stores under those paths, so a child without them cannot
 * authenticate to a provider, and a process that cannot authenticate cannot
 * cause a charge — whether or not it can open a socket. A child reaching an
 * unauthenticated endpoint is a real but much smaller problem than one that can
 * spend money.
 *
 * This is why the isolated executor performs DETERMINISTIC work only. Launching
 * an AI worker requires exactly the credential access this child is denied, so
 * an AI launch stays with the supervisor, behind the gate that authorises it.
 * That is a deliberate division, not an omission.
 *
 * The remaining egress gap is recorded in docs/KNOWN-LIMITATIONS.md and closes
 * with an OS-level control a human must install.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildWorkerEnvironment, redactSecrets, type EnvironmentPolicy } from "../workers/environmentPolicy.js";
import {
  buildExecutorRequest,
  parseExecutorResponse,
  MAX_RESPONSE_BYTES,
} from "../../supervision/executorProtocol.js";
import type { WorkExecutionInput, WorkExecutor, WorkOutcome } from "../../supervision/supervisorPorts.js";

/**
 * The environment an isolated executor child receives.
 *
 * Deliberately NOT `DEFAULT_WORKER_ENV_ALLOWLIST`. That list forwards `HOME`
 * and `CODEX_HOME` precisely so a provider CLI can find its own credentials —
 * correct for a worker the gate has authorised, and exactly wrong here. The
 * difference between the two lists IS the isolation, so they must not be
 * merged for tidiness later.
 *
 * `PATH` is forwarded because a child that cannot find `node` cannot run at
 * all; it grants no authority by itself.
 */
export const ISOLATED_EXECUTOR_ENV_ALLOWLIST: readonly string[] = ["PATH", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP"];

export const ISOLATED_EXECUTOR_ENVIRONMENT_POLICY: EnvironmentPolicy = Object.freeze({
  allowedVars: ISOLATED_EXECUTOR_ENV_ALLOWLIST,
});

/** Default ceiling on a single execution. Overridable for tests. */
export const DEFAULT_EXECUTOR_TIMEOUT_MS = 15 * 60 * 1000;

export interface IsolatedExecutorOptions {
  /** Absolute path to the child entry script. */
  readonly childScript: string;
  readonly timeoutMs?: number;
  readonly environmentPolicy?: EnvironmentPolicy;
  /** Injected for tests; defaults to the running node binary. */
  readonly nodePath?: string;
  readonly sourceEnv?: NodeJS.ProcessEnv;
}

/**
 * Turns any failure into a definite `RESOURCE_FAILURE` (AC-6).
 *
 * Every abnormal path lands here rather than throwing, because a throw from an
 * executor becomes an unhandled rejection inside a tick, and a tick that dies
 * leaves a claim held with nothing to release it. The SUPERVISOR classifies
 * what a failure means about a resource; this only reports the process facts.
 */
function processFailure(
  terminationReason: "EXITED" | "TIMEOUT" | "CANCELLED" | "SPAWN_ERROR",
  exitCode: number | null,
  stdout: string,
  stderr: string,
): WorkOutcome {
  return {
    kind: "RESOURCE_FAILURE",
    // Redacted here, not at the point of storage: this is the boundary where
    // untrusted output enters the Factory, and a later redaction is one missed
    // call site away from a leak (C6).
    process: {
      terminationReason,
      exitCode,
      stdout: redactSecrets(stdout).slice(0, 8_000),
      stderr: redactSecrets(stderr).slice(0, 8_000),
    },
  };
}

export function createIsolatedExecutor(options: IsolatedExecutorOptions): WorkExecutor {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXECUTOR_TIMEOUT_MS;
  const policy = options.environmentPolicy ?? ISOLATED_EXECUTOR_ENVIRONMENT_POLICY;

  /** One spawn, one outcome, whatever happens to the child. */
  const spawnChild = (requestPath: string, env: Record<string, string>): Promise<WorkOutcome> =>
    new Promise<WorkOutcome>((resolve) => {
      let settled = false;
      const settle = (outcome: WorkOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(options.nodePath ?? process.execPath, [options.childScript, requestPath], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
          // No shell: an item title is attacker-influenced text, and a shell
          // would make it a command line.
          shell: false,
        });
      } catch (error) {
        settle(processFailure("SPAWN_ERROR", null, "", error instanceof Error ? error.message : String(error)));
        return;
      }

      let stdout = "";
      let stderr = "";
      let overflowed = false;
      /**
       * Bounded as it ARRIVES, not after (AC-6). Waiting until the process
       * exits to notice it wrote a gigabyte means holding a gigabyte first.
       */
      const capture = (chunk: string, into: "out" | "err"): void => {
        if (overflowed) return;
        if (into === "out") {
          stdout += chunk;
          if (stdout.length > MAX_RESPONSE_BYTES) {
            overflowed = true;
            child.kill("SIGKILL");
          }
        } else {
          stderr = (stderr + chunk).slice(0, 16_000);
        }
      };
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => capture(chunk, "out"));
      child.stderr?.on("data", (chunk: string) => capture(chunk, "err"));

      /**
       * AC-7: a child does not outlive the wait. SIGTERM first so it can exit
       * cleanly, SIGKILL shortly after so a child that ignores SIGTERM —
       * including one deliberately trapping it — cannot linger holding
       * resources.
       */
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
        settle(processFailure("TIMEOUT", null, stdout, `${stderr}\n[timed out after ${timeoutMs}ms]`));
      }, timeoutMs);

      child.on("error", (error: Error) => {
        settle(processFailure("SPAWN_ERROR", null, stdout, `${stderr}\n${error.message}`));
      });

      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (overflowed) {
          settle(processFailure("EXITED", code, "", `${stderr}\n[response exceeded ${MAX_RESPONSE_BYTES} bytes]`));
          return;
        }
        if (signal !== null) {
          settle(processFailure("EXITED", code, stdout, `${stderr}\n[killed by ${signal}]`));
          return;
        }
        if (code !== 0) {
          settle(processFailure("EXITED", code, stdout, stderr));
          return;
        }
        // Exit 0 is NOT success. It means the child chose to stop; what it
        // actually reported still has to parse.
        const parsed = parseExecutorResponse(stdout);
        if (!parsed.ok) {
          settle(processFailure("EXITED", code, stdout, `${stderr}\n[unusable response: ${parsed.reason}]`));
          return;
        }
        settle(parsed.outcome);
      });
    });

  return {
    async execute(input: WorkExecutionInput): Promise<WorkOutcome> {
      const env = buildWorkerEnvironment(policy, options.sourceEnv ?? process.env);

      /**
       * The request goes in a FILE, not down the child's standard input.
       *
       * TASK-004's unattended-execution invariant forbids any interactive-I/O
       * primitive in this source tree, and reading standard input is exactly
       * the one that hangs forever if a terminal is ever attached — a child run
       * by hand for debugging would wait for a human who is not coming. A file
       * has no such failure mode, and the invariant's structural scan is right
       * to refuse the alternative rather than take "but it is piped" on trust.
       *
       * Owner-only, in a private directory, removed in `finally`: the request
       * carries no credential, but it does carry work detail, and durable
       * scratch nobody deletes is how such things end up somewhere unexpected.
       */
      const requestDir = mkdtempSync(join(tmpdir(), "sf-executor-"));
      const requestPath = join(requestDir, "request.json");
      writeFileSync(requestPath, JSON.stringify(buildExecutorRequest(input)), { mode: 0o600 });

      try {
        return await spawnChild(requestPath, env);
      } finally {
        rmSync(requestDir, { recursive: true, force: true });
      }
    },
  };
}
