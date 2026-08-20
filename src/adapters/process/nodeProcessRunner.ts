/**
 * `ProcessRunner` implemented on `node:child_process`.
 *
 * Design notes (TASK-003 process-isolation requirements):
 *
 * - `spawn(executable, argv, { cwd, env })` only — argv is always an array,
 *   `shell` is never set, so there is no shell-interpolation surface.
 * - The child is spawned `detached: true` on POSIX, making it its own
 *   process-group leader. Termination signals a negative pid (the group),
 *   so a CLI that shells out to git/ripgrep/etc. as grandchildren is
 *   terminated too, not just the immediate child.
 * - There is exactly one `close` listener. Timeout/cancellation do not race
 *   a second listener against it — they set `terminationReason` and send
 *   signals; the single `close` handler is what actually settles the
 *   promise, consulting that reason instead of always reporting `EXITED`.
 *   A `settled` guard plus clearing every timer/listener on first
 *   settlement makes every further event a no-op, so a timeout that fires
 *   microseconds before a natural exit (or vice versa) can never
 *   double-report or leave the returned Promise unresolved.
 * - Timeout/cancellation escalate SIGTERM -> (grace period) -> SIGKILL
 *   rather than assuming the child honours SIGTERM.
 * - stdout/stderr are capped at `maxOutputBytes` per stream (default 5 MiB):
 *   once the cap is hit, further bytes are discarded but the stream is
 *   still drained, so a chatty child cannot block on a full pipe forever
 *   while the runner is quietly ignoring it.
 * - stdin is always explicitly ended (with `input`, if given) — never left
 *   open and inherited — so a CLI that only proceeds once stdin reaches EOF
 *   never hangs waiting on it. Errors writing to stdin (a child that closes
 *   its own stdin early) are swallowed rather than crashing the runner.
 */

import { spawn } from "node:child_process";

import type { Timestamp } from "../../domain/time.js";
import type { ProcessRequest, ProcessResult, ProcessRunner, ProcessTerminationReason } from "../../ports/processRunner.js";

const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 3000;

export interface NodeProcessRunnerOptions {
  /** Time to wait after SIGTERM before escalating to SIGKILL. Lower this in tests. */
  readonly killGraceMs?: number;
}

class BoundedCollector {
  private readonly limit: number;
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private truncated = false;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: Buffer): void {
    if (this.size >= this.limit) {
      this.truncated = true;
      return;
    }
    const remaining = this.limit - this.size;
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.size += remaining;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }

  wasTruncated(): boolean {
    return this.truncated;
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    // Negative pid targets the whole process group created by `detached: true`.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already dead. Nothing left to signal.
    }
  }
}

export function createNodeProcessRunner(options: NodeProcessRunnerOptions = {}): ProcessRunner {
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return {
    run(request: ProcessRequest): Promise<ProcessResult> {
      const startedAt: Timestamp = Date.now();
      const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const stdout = new BoundedCollector(maxOutputBytes);
      const stderr = new BoundedCollector(maxOutputBytes);

      return new Promise<ProcessResult>((resolvePromise) => {
        let settled = false;
        let spawned = false;
        let terminating = false;
        /** Set once timeout/cancellation is requested; the `close` handler defers to this. */
        let requestedReason: "TIMEOUT" | "CANCELLED" | undefined;
        let timeoutTimer: NodeJS.Timeout | undefined;
        let killTimer: NodeJS.Timeout | undefined;
        let abortListener: (() => void) | undefined;

        const child = spawn(request.executable, [...request.argv], {
          cwd: request.cwd,
          env: { ...request.env },
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });

        function cleanup(): void {
          if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
          if (killTimer !== undefined) clearTimeout(killTimer);
          if (abortListener !== undefined) request.signal?.removeEventListener("abort", abortListener);
        }

        function finish(partial: {
          terminationReason: ProcessTerminationReason;
          exitCode: number | null;
          signal: NodeJS.Signals | null;
          spawnError?: string;
        }): void {
          if (settled) return;
          settled = true;
          cleanup();
          const finishedAt: Timestamp = Date.now();
          resolvePromise({
            terminationReason: partial.terminationReason,
            exitCode: partial.exitCode,
            signal: partial.signal,
            stdout: stdout.text(),
            stderr: stderr.text(),
            stdoutTruncated: stdout.wasTruncated(),
            stderrTruncated: stderr.wasTruncated(),
            startedAt,
            finishedAt,
            durationMs: finishedAt - startedAt,
            ...(partial.spawnError === undefined ? {} : { spawnError: partial.spawnError }),
          });
        }

        function sendTermSignal(): void {
          if (settled || child.pid === undefined) return;
          killGroup(child.pid, "SIGTERM");
          killTimer = setTimeout(() => {
            if (settled || child.pid === undefined) return;
            killGroup(child.pid, "SIGKILL");
          }, killGraceMs);
        }

        /**
         * Safe to call before the child has actually spawned (e.g. a near-zero
         * timeout racing process startup): it just records intent, and the
         * `spawn` handler below sends the real signal once a pid exists.
         */
        function requestTermination(reason: "TIMEOUT" | "CANCELLED"): void {
          if (settled || terminating) return;
          terminating = true;
          requestedReason = reason;
          if (spawned) {
            sendTermSignal();
          }
        }

        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        // Never let a stream error (e.g. EPIPE after the child exits) crash the process.
        child.stdout.on("error", () => {});
        child.stderr.on("error", () => {});
        child.stdin.on("error", () => {});

        child.on("spawn", () => {
          spawned = true;
          try {
            child.stdin.end(request.input);
          } catch {
            // A child that closes stdin immediately is a hostile-but-legal case, not a crash.
          }
          if (terminating) {
            sendTermSignal();
          }
        });

        child.on("error", (error: Error) => {
          if (!spawned) {
            finish({ terminationReason: "SPAWN_ERROR", exitCode: null, signal: null, spawnError: error.message });
          }
          // Already spawned: 'error' here means kill/IPC failed after the fact — the single
          // 'close' handler below still owns settlement.
        });

        child.on("close", (code, signal) => {
          finish({ terminationReason: requestedReason ?? "EXITED", exitCode: code, signal });
        });

        timeoutTimer = setTimeout(() => requestTermination("TIMEOUT"), request.timeoutMs);

        if (request.signal !== undefined) {
          if (request.signal.aborted) {
            requestTermination("CANCELLED");
          } else {
            abortListener = () => requestTermination("CANCELLED");
            request.signal.addEventListener("abort", abortListener, { once: true });
          }
        }
      });
    },
  };
}
