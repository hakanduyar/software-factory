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
 * The claim is about THIS child's own capabilities. It is not a claim that
 * no path from a compromised child to a provider can exist — round-2 review
 * found one through the parent's inspector, closed above, and finding one
 * class of escape is not proof there is no other.
 *
 * ================================================================
 * WHAT A CHILD CAN STILL DO TO ITS PARENT
 * ================================================================
 * A child runs as the SAME UID as the supervisor, so it can signal it:
 * `process.kill(process.ppid, "SIGTERM")` terminates the supervisor, and
 * SIGKILL cannot be caught by anything. Round-5 review demonstrated it.
 *
 * Nothing in this file can prevent that, and no in-process guard can: signal
 * permission is a property of the UID pair, not of the code. Preventing it
 * needs the child to run as a DIFFERENT user, which needs privilege this
 * process does not have and ADR-0002 reserves to the human.
 *
 * What IS true is that a killed supervisor produces no false success: the tick
 * dies with it, no outcome is recorded, and durable state keeps whatever it
 * last committed. That is a denial of service, not a bypass of the gate — a
 * real limitation, and a smaller one than a child that can spend money.
 *
 * The remaining egress and signalling gaps are recorded in
 * docs/KNOWN-LIMITATIONS.md on the docs/known-limitations branch, and close
 * with OS-level controls a human must install.
 */

import { spawn, spawnSync } from "node:child_process";
import * as inspector from "node:inspector";
import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { buildWorkerEnvironment, redactSecrets, type EnvironmentPolicy } from "../workers/environmentPolicy.js";
import {
  buildExecutorRequest,
  serializeExecutorRequest,
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

/**
 * Closes the INSPECTOR door before any child exists (round-2 CRITICAL).
 *
 * The reviewer escaped the whole isolation without reading a single file from
 * the child: it sent `SIGUSR1` to its parent. Node's default handler for that
 * signal opens an UNAUTHENTICATED inspector on 127.0.0.1:9229, and the child —
 * which is allowed network access, because nothing here can take it away —
 * connected and issued `Runtime.evaluate` IN THE SUPERVISOR. From there it read
 * the credential file the child itself could not touch.
 *
 * Restricting the child's filesystem was never going to stop that, because the
 * capability being abused belonged to the PARENT.
 *
 * Installing our own `SIGUSR1` listener replaces Node's default, so the signal
 * no longer opens anything. Measured: without a listener the port accepts a
 * connection; with one it is refused.
 *
 * Idempotent, and deliberately global rather than per-executor: the supervisor
 * has one signal disposition, and a child spawned by any path can send the
 * signal.
 */
/**
 * An ALREADY-OPEN inspector is not closed by owning the signal (round-4
 * CRITICAL).
 *
 * `closeInspectorDoor` stops SIGUSR1 from OPENING the inspector. It does
 * nothing about a supervisor started with `--inspect`, where the port is
 * already listening — and the reviewer connected to it and evaluated
 * `process.env.OPENAI_API_KEY` in the parent.
 *
 * The inspector is closed if it is open. If it cannot be closed, this refuses
 * to run rather than spawning a child into a process that is already
 * remotely controllable: an isolated executor whose parent is open to
 * evaluation is not isolated at all.
 */
function assertInspectorClosed(): void {
  const url = inspector.url();
  if (url === undefined) {
    return;
  }
  inspector.close();
  if (inspector.url() !== undefined) {
    throw new Error(
      "refusing to run an isolated executor: this process has an active inspector " +
        `(${url}) that could not be closed. A child can connect to it and evaluate code here, ` +
        "which defeats every restriction placed on the child.",
    );
  }
}

let inspectorDoorClosed = false;
function closeInspectorDoor(): void {
  if (inspectorDoorClosed) return;
  inspectorDoorClosed = true;
  process.on("SIGUSR1", () => {
    // Deliberately does nothing. The point is to OWN the signal so Node's
    // default inspector-opening handler does not run.
  });
}

/** Default ceiling on a single execution. Overridable for tests. */
export const DEFAULT_EXECUTOR_TIMEOUT_MS = 15 * 60 * 1000;

export interface IsolatedExecutorOptions {
  /**
   * The repository being verified. EVERYTHING else is derived from it.
   *
   * Round-4 review: `childScript` and `readablePaths` were caller-supplied, and
   * every one of them turned out to be a capability rather than a
   * configuration. A parameter that can hand a child the credential store is
   * not a parameter; production now supplies none.
   */
  readonly repositoryRoot: string;
  readonly timeoutMs?: number;
}

/**
 * Capability overrides that exist ONLY for tests, and are named so.
 *
 * Round-3 review: `nodePath` and `environmentPolicy` were ordinary options, so
 * a caller could hand over a runtime that merely CLAIMS to enforce permissions,
 * or an `allowedVars` list naming `OPENAI_API_KEY`. Both restore exactly the
 * capability this adapter exists to remove.
 *
 * They are not validated away, because a test genuinely needs them. They are
 * moved behind a differently-named factory so that reaching them is a visible
 * choice in the source rather than an option someone passes by accident — the
 * same rule AC-11 applies to the in-process executor.
 */
export interface UnsafeTestOverrides {
  readonly nodePath?: string;
  readonly environmentPolicy?: EnvironmentPolicy;
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
/**
 * Redacts EVERY string in an outcome, wherever it sits (round-8).
 *
 * The first version named `COMPLETED.detail` and `CHANGES_REQUIRED.findings` —
 * the two places a leak had been demonstrated. The reviewer then used the
 * others: `reportedIdentity`, a CHILD-DECLARED `RESOURCE_FAILURE` whose
 * `process.stdout`/`stderr` never pass through `processFailure`, the whole of
 * `CHECKPOINT`, and `HUMAN_REQUIRED.detail`. Each returned credential-shaped
 * strings unchanged.
 *
 * Enumerating the variants was the mistake: the list is a subset of the type and
 * silently becomes a smaller subset every time the type grows. Walking the value
 * covers the ones that exist and the ones added later, and cannot fall behind.
 *
 * The outcome has already been parsed field by field by `parseExecutorResponse`,
 * so this walks a validated shape — it is a redaction pass, not a sanitiser
 * standing in for one.
 */
function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) out[key] = redactDeep(nested);
    return out;
  }
  return value;
}

function redactOutcome(outcome: WorkOutcome): WorkOutcome {
  return redactDeep(outcome) as WorkOutcome;
}

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

/**
 * Refuses a read grant that would hand back what the isolation removes.
 *
 * `/` and the home directory are the two that matter: either one contains the
 * provider credential stores, and granting them makes every other control in
 * this file decorative. Checked by RESOLUTION, so `/tmp/..` does not sneak past
 * a string comparison.
 */
/** `realpath` where it exists; the lexical path where it does not. */
function realOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * A granted directory is only as contained as its CONTENTS (round-5 CRITICAL).
 *
 * `assertGrantIsContained` validated the granted path itself and stopped there.
 * Node's permission model follows symlinks INSIDE a granted directory, so a
 * `dist/credential-link -> ~/.codex/auth.json` was readable by a child granted
 * only `dist` — and replacing a validated directory with a symlink after
 * construction did the same thing.
 *
 * This is the identical rule the verifier already applies to the tree it
 * audits: a link is refused because a link inside the tree cannot be told apart
 * from one pointing outside it.
 *
 * HONEST LIMIT: this is a check, and a check has a moment. A writer that
 * creates a symlink between this scan and the child's read defeats it. That is
 * the same concurrent-adversary boundary the verifier documents, and closing it
 * needs the child to run somewhere the adversary is not — a different UID or a
 * namespace, which need privilege this process does not have.
 */
function assertNoLinksUnder(paths: readonly string[]): void {
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      /**
       * FAILS CLOSED (round-7 CRITICAL).
       *
       * The catch returned silently, so a directory inside a grant that could
       * not be read was scanned as though it were empty — and a link hiding
       * there was never found. "The walk did not crash" is not "the walk found
       * nothing"; the verifier had exactly this defect in its own scans, one
       * round earlier.
       *
       * A directory that does not EXIST is genuinely nothing; one that exists
       * and cannot be read is unknown, and unknown must not be granted.
       */
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw new Error(
          `refusing to run an isolated executor: ${current} is inside a granted directory and could not be ` +
            "read, so whether it contains a link is unknown. An unreadable directory is not an empty one.",
        );
      }
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `refusing to run an isolated executor: ${full} is a symlink inside a granted directory. ` +
            "The permission model follows it, so the grant would reach wherever it points.",
        );
      }
      /**
       * HARD LINKS TOO (round-6 CRITICAL).
       *
       * The scan rejected symbolic links and stopped there. A hard link is
       * indistinguishable from an ordinary file by name, type or realpath —
       * the permission model authorises the allowed PATHNAME and follows it —
       * so `dist/credential-link` hard-linked to `~/.codex/auth.json` was
       * opened by a child granted only `dist`.
       *
       * Link count above one is the ordinary signal, and it is the same rule
       * the verifier already applies to the tree it audits. It refuses some
       * legitimate trees too; a grant that is occasionally inconvenient beats
       * one that is sometimes a credential.
       */
      if (entry.isFile()) {
        const stats = lstatSync(full, { throwIfNoEntry: false });
        if (stats !== undefined && stats.nlink > 1) {
          throw new Error(
            `refusing to run an isolated executor: ${full} is a hard link inside a granted directory. ` +
              "It cannot be told apart from one pointing at a credential store, so it is refused.",
          );
        }
      }
      if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  for (const granted of paths) {
    if (lstatSync(granted, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
      throw new Error(
        `refusing to run an isolated executor: the granted path ${granted} is itself a symlink.`,
      );
    }
    walk(granted);
  }
}

/**
 * Every granted path must be INSIDE the tree being verified (round-4 finding).
 *
 * The first version was a denylist — `/`, the home directory, its ancestors —
 * and a denylist on a capability is a list of the attacks someone already
 * thought of. The reviewer granted `$HOME/.codex/auth.json` directly, then
 * `*`, then `/proc`, and read credentials and the parent's environment through
 * all three. None of them is `/` or `$HOME`.
 *
 * Containment is the only rule that holds: a child may read inside the
 * repository and nowhere else. `*` is not a path and is refused by the same
 * test, because it does not resolve inside anything.
 */
function assertGrantIsContained(paths: readonly string[], repositoryRoot: string): void {
  const base = realOrUndefined(repositoryRoot) ?? resolve(repositoryRoot);
  for (const candidate of paths) {
    if (candidate.includes("*") || candidate.includes("?")) {
      throw new Error(
        `refusing to run an isolated executor: read grant ${JSON.stringify(candidate)} is a pattern, not a path; ` +
          "a wildcard grant is not something this adapter can reason about.",
      );
    }
    const granted = realOrUndefined(resolve(candidate)) ?? resolve(candidate);
    if (granted !== base && !granted.startsWith(`${base}/`)) {
      throw new Error(
        `refusing to run an isolated executor: read grant ${granted} is outside the repository (${base}). ` +
          "A child may read the tree being verified and nothing else.",
      );
    }
  }
}

/**
 * THE PRODUCTION FACTORY. Derives every capability from the repository root.
 */
export function createIsolatedExecutor(options: IsolatedExecutorOptions): WorkExecutor {
  const base = realOrUndefined(options.repositoryRoot) ?? resolve(options.repositoryRoot);
  return buildExecutor(
    {
      repositoryRoot: base,
      childScript: join(base, "dist/src/cli/isolatedExecutorChild.js"),
      readablePaths: [join(base, "dist")],
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
    {},
  );
}

/**
 * THE TEST FACTORY. Named unsafe because everything it accepts is a capability.
 *
 * A test genuinely needs to point at a throwaway child and to substitute a
 * runtime; production must not be able to do either without saying so in the
 * source. Containment is still enforced — a test that wants to read outside
 * its own tree has to say which tree.
 */
export function createIsolatedExecutorForTests(
  options: ResolvedExecutorOptions,
  overrides: UnsafeTestOverrides = {},
): WorkExecutor {
  return buildExecutor(options, overrides);
}

export interface ResolvedExecutorOptions {
  readonly repositoryRoot: string;
  readonly childScript: string;
  readonly readablePaths: readonly string[];
  readonly timeoutMs?: number;
}

function buildExecutor(options: ResolvedExecutorOptions, overrides: UnsafeTestOverrides): WorkExecutor {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXECUTOR_TIMEOUT_MS;
  const policy = overrides.environmentPolicy ?? ISOLATED_EXECUTOR_ENVIRONMENT_POLICY;
  const nodePath = overrides.nodePath ?? process.execPath;
  /**
   * COPIED at construction, then used (round-4 finding).
   *
   * Validation read the caller's array and execution read it again, so a
   * caller could pass a safe directory, wait for the check, and then mutate
   * the array to `["*"]`. Check-then-use on mutable input checks nothing.
   */
  const readablePaths = Object.freeze([...options.readablePaths]);
  const childScript = options.childScript;
  // Containment of the NAMES is a property of the options, so it is settled
  // here and the frozen copy is what executes.
  assertGrantIsContained([...readablePaths, childScript], options.repositoryRoot);
  const permissionFlag = permissionFlagFor(nodePath);
  closeInspectorDoor();

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
            // EXACTLY what the caller declared, plus the child's own script
            // and request. Nothing is inferred from a path, because the
            // inference granted `/` for a child under /tmp.
            ...readablePaths.map((path) => `--allow-fs-read=${path}`),
            `--allow-fs-read=${childScript}`,
            `--allow-fs-read=${requestPath}`,
            childScript,
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

      /**
       * SETTLES ONLY ONCE THE CHILD IS ACTUALLY DEAD (round-2 finding AC-7).
       *
       * The first version signalled and resolved immediately, so the supervisor
       * moved on while the child was still running — "terminated" as a
       * statement of intent rather than of fact. SIGKILL follows SIGTERM, and
       * the outcome is delivered from the `close` handler, which fires when the
       * process has genuinely exited.
       *
       * HONEST LIMIT: a descendant that calls `setsid` leaves the process group
       * and cannot be reached this way. Following it needs a PID namespace,
       * which needs privilege this process does not have — the same boundary as
       * network egress, recorded in docs/KNOWN-LIMITATIONS.md.
       */
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        signalGroup("SIGTERM");
        setTimeout(() => signalGroup("SIGKILL"), 2_000).unref();
        // Backstop: if `close` never arrives, still produce a verdict rather
        // than hanging the tick forever.
        setTimeout(() => {
          settle(processFailure("TIMEOUT", null, stdout, `${stderr}\n[timed out after ${timeoutMs}ms; the child did not exit]`));
        }, 10_000).unref();
      }, timeoutMs);

      child.on("error", (error: Error) => {
        settle(processFailure("SPAWN_ERROR", null, stdout, `${stderr}\n${error.message}`));
      });

      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (timedOut) {
          settle(processFailure("TIMEOUT", code, stdout, `${stderr}\n[timed out after ${timeoutMs}ms]`));
          return;
        }
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
        // Redacted at THIS boundary, not only later (round-6 note):
        // SupervisorService sanitizes a completion before it becomes durable
        // state, which is correct and is not the same as this adapter handing
        // back clean data to whoever calls it.
        settle(redactOutcome(parsed.outcome));
      });
    });

  return {
    async execute(input: WorkExecutionInput): Promise<WorkOutcome> {
      /**
       * The policy's `extraVars` are IGNORED here (round-2 finding AC-2).
       *
       * `buildWorkerEnvironment` layers them on top of the allowlist by design,
       * which is right for a worker the gate has authorised and wrong for this
       * child: a caller-supplied policy could inject HOME or an API key and
       * walk straight past the allowlist. The isolated environment is built
       * from allowed names ONLY, so there is no channel to add to it.
       */
      /**
       * RE-CHECKED PER EXECUTION, not once at construction (round-5 CRITICALs).
       *
       * Both of these are properties of the WORLD rather than of the options,
       * and the world moves between constructing an executor and running one:
       * the parent can reopen its inspector, and a validated directory can gain
       * a symlink or become one. Checking at construction was check-then-use
       * with a longer gap than usual.
       */
      assertInspectorClosed();
      assertNoLinksUnder([...readablePaths]);

      const env = buildWorkerEnvironment(
        { allowedVars: policy.allowedVars },
        overrides.sourceEnv ?? process.env,
      );

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
      writeFileSync(requestPath, serializeExecutorRequest(buildExecutorRequest(input)), { mode: 0o600 });

      try {
        return await spawnChild(requestPath, env);
      } finally {
        rmSync(requestDir, { recursive: true, force: true });
      }
    },
  };
}
