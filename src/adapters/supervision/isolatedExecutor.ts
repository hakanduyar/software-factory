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
 * ADR-0002 reserves to the human and autonomous work cannot obtain.
 *
 * ================================================================
 * HOW BILLING CAPABILITY IS REMOVED — and why the first attempt did not
 * ================================================================
 * `AUTONOMOUS_SPEND_LIMIT = 0` depends on the child being unable to make a
 * chargeable call. The first version tried to achieve that by omitting `HOME`,
 * `CODEX_HOME` and `XDG_*` from the environment, and claimed a child therefore
 * "cannot authenticate to a provider".
 *
 * THAT CLAIM WAS FALSE, and independent review demonstrated it in one step:
 * `os.homedir()` does not read `HOME`, it falls back to the passwd database, so
 * the child resolved `/home/<user>` anyway and read
 * `~/.claude/.credentials.json` and `~/.codex/auth.json` directly. Both provider
 * CLIs were also on `PATH`. Removing an environment variable hides a path; it
 * does not remove the ability to read one.
 *
 * What actually removes it is a FILESYSTEM RESTRICTION the runtime enforces.
 * The child runs under Node's permission model with reads confined to the build
 * output and its own request file, and with child processes and worker threads
 * denied outright. Measured on this host, that turns both credential reads and
 * any attempt to spawn a provider CLI into `ERR_ACCESS_DENIED`.
 *
 * So the honest statement is narrow and testable: a child cannot READ the
 * provider credential stores and cannot SPAWN the provider CLIs, therefore it
 * cannot authenticate, therefore it cannot cause a charge — even though it can
 * still open a socket to an endpoint that does not require credentials.
 *
 * The environment allowlist remains, frozen, as defence in depth. It is no
 * longer load-bearing on its own, and this file no longer pretends it is.
 *
 * This is also why the isolated executor performs DETERMINISTIC work only:
 * launching an AI worker needs exactly the access this child is denied, so
 * launches stay with the supervisor behind the gate that authorises them.
 *
 * The remaining egress gap is recorded in docs/KNOWN-LIMITATIONS.md and closes
 * with an OS-level control a human must install.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
export const ISOLATED_EXECUTOR_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "PATH",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
]);

export const ISOLATED_EXECUTOR_ENVIRONMENT_POLICY: EnvironmentPolicy = Object.freeze({
  allowedVars: ISOLATED_EXECUTOR_ENV_ALLOWLIST,
});

/**
 * The runtime flags that actually enforce the isolation.
 *
 * `--permission` confines the child to the paths granted below. Everything not
 * granted is denied, including the provider credential stores — which is the
 * point, because the environment allowlist alone did NOT deny them
 * (`os.homedir()` reads the passwd database, not `HOME`).
 *
 * Child processes and worker threads are NOT granted. A child that could spawn
 * would simply run the provider CLI from `PATH`, which is the same capability
 * by another route.
 *
 * Node 22 spells this `--experimental-permission`; later versions use
 * `--permission`. Both are passed and the unrecognised one is rejected by the
 * runtime, so `permissionFlagFor` picks the spelling this binary accepts rather
 * than guessing from a version string.
 */
export const PERMISSION_DENIED_CODE = "ERR_ACCESS_DENIED";

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

/**
 * Which spelling of the permission flag THIS binary accepts.
 *
 * Node 22 uses `--experimental-permission`; later versions use `--permission`.
 * Probed once by running the binary rather than parsed from a version string:
 * the question is what the runtime in front of us accepts, and a version
 * comparison is a guess about that.
 *
 * A binary supporting NEITHER cannot enforce the isolation this file promises,
 * so it fails closed rather than silently running an unrestricted child.
 */
function permissionFlagFor(nodePath: string): string {
  /**
   * Probes the CAPABILITY, not the exit code.
   *
   * The first version ran `<flag> -e 0` and accepted any zero exit — which
   * `/bin/true` also returns, for any arguments at all. It would have reported
   * a working permission model on a binary that has none, and the child would
   * then run unrestricted behind a claim that it was contained. Measuring the
   * wrong thing confidently is precisely how the original CRITICAL happened.
   *
   * So this asks the runtime to do the thing that must be denied: read a file
   * it was not granted. Only a genuinely active permission model answers
   * `ERR_ACCESS_DENIED`.
   */
  const probeScript =
    "try{require('node:fs').readFileSync('/etc/hostname');console.log('ALLOWED')}" +
    "catch(e){console.log(e.code||'ERROR')}";
  for (const flag of ["--permission", "--experimental-permission"]) {
    const probe = spawnSync(nodePath, [flag, "-e", probeScript], { encoding: "utf8" });
    if (probe.status === 0 && (probe.stdout ?? "").trim() === PERMISSION_DENIED_CODE) {
      return flag;
    }
  }
  throw new Error(
    `refusing to run an isolated executor: ${nodePath} supports neither --permission nor ` +
      "--experimental-permission, so filesystem access cannot be restricted and the child could read " +
      "provider credentials. Isolation that is claimed but not enforced is worse than none.",
  );
}

export function createIsolatedExecutor(options: IsolatedExecutorOptions): WorkExecutor {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXECUTOR_TIMEOUT_MS;
  const policy = options.environmentPolicy ?? ISOLATED_EXECUTOR_ENVIRONMENT_POLICY;
  const nodePath = options.nodePath ?? process.execPath;
  const permissionFlag = permissionFlagFor(nodePath);

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
        child = spawn(
          nodePath,
          [
            permissionFlag,
            // Only the compiled tree the child must import, and its own
            // request. Everything else — notably the provider credential
            // stores under the home directory — is denied by the runtime.
            `--allow-fs-read=${dirname(dirname(options.childScript))}`,
            `--allow-fs-read=${options.childScript}`,
            `--allow-fs-read=${requestPath}`,
            options.childScript,
            requestPath,
          ],
          {
            env,
            stdio: ["ignore", "pipe", "pipe"],
            // No shell: an item title is attacker-influenced text, and a shell
            // would make it a command line.
            shell: false,
            /**
             * Its OWN process group, so termination reaches DESCENDANTS
             * (round-1 finding AC-7). Signalling only the direct child left
             * grandchildren running after the supervisor had moved on.
             */
            detached: true,
            // Not the repository: a child that inherits the repo as cwd can
            // reach durable state by relative path.
            cwd: dirname(requestPath),
          },
        );
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
          // Measured in BYTES, not code units (round-1 finding): a UTF-8
          // response can exceed the byte limit while its JavaScript string
          // length stays under it, so a 1,000,057-byte reply was accepted.
          if (Buffer.byteLength(stdout, "utf8") > MAX_RESPONSE_BYTES) {
            overflowed = true;
            signalGroup("SIGKILL");
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
      /**
       * Signals the process GROUP, not just the child (round-1 finding AC-7).
       *
       * `child.kill()` reaches one process. The reviewer showed a child that
       * forked a grandchild and exited, leaving the grandchild running after
       * the supervisor had moved on — a "terminated" executor that was still
       * doing whatever it liked. The child is spawned `detached`, so it leads
       * its own group and a negative pid reaches every descendant.
       */
      function signalGroup(signal: NodeJS.Signals): void {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          // The group is already gone, or the child never started. Fall back to
          // the direct child so a partial failure still signals what it can.
          try {
            child.kill(signal);
          } catch {
            /* nothing left to signal */
          }
        }
      }

      const timer = setTimeout(() => {
        signalGroup("SIGTERM");
        setTimeout(() => signalGroup("SIGKILL"), 2_000).unref();
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
