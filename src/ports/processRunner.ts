/**
 * Explicit, minimal process-execution abstraction (TASK-003).
 *
 * Every worker CLI adapter runs its child process through this port instead
 * of touching `node:child_process` directly, so "no shell string
 * concatenation", "timeout actually kills the child", "cancellation leaves
 * no orphan" and "output capture is bounded" are proven once here rather
 * than re-implemented (and re-reviewed) per adapter.
 */

import type { Timestamp } from "../domain/time.js";

/**
 * `executable` and `argv` are always separate — never concatenate a command
 * string. There is deliberately no `shell` option: this port never runs a
 * shell.
 */
export interface ProcessRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  /** Explicit and required: no worker ever inherits the caller's cwd implicitly. */
  readonly cwd: string;
  /**
   * Already policy-filtered (see `environmentPolicy.ts`). This port does not
   * itself decide what a child may inherit — it just uses exactly this map.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Written to the child's stdin, then stdin is closed. Omit to close stdin immediately. */
  readonly input?: string;
  /**
   * Explicit and required. A finite positive number is a total wall-clock
   * budget; exceeding it terminates the child (SIGTERM, then SIGKILL if
   * needed). `null` means NO total execution deadline: the child runs until
   * it exits on its own or `signal` aborts. `null` is never encoded as 0,
   * Infinity or a huge number, and an omitted field is not a bypass — the
   * runner rejects any other value before launching a child.
   */
  readonly timeoutMs: number | null;
  /** Cooperative cancellation, e.g. from the caller's own request lifecycle. */
  readonly signal?: AbortSignal;
  /**
   * Optional diagnostic ceiling on captured bytes per stream. `null` or
   * omitted means NO artificial capture ceiling: every chunk is retained in
   * memory (not spooled to disk) and `stdoutTruncated`/`stderrTruncated`
   * stay false. A finite value must be a positive safe integer (anything else
   * is refused before launch); excess bytes are then discarded, the stream is
   * still drained, and truncation is reported. Never encoded as a huge number.
   */
  readonly maxOutputBytes?: number | null;
}

export const PROCESS_TERMINATION_REASONS = ["EXITED", "TIMEOUT", "CANCELLED", "SPAWN_ERROR"] as const;

export type ProcessTerminationReason = (typeof PROCESS_TERMINATION_REASONS)[number];

/**
 * OS-level truth about one invocation. Deliberately carries no interpretation
 * of what the process *meant* — only what actually happened to it. A CLI
 * adapter builds its `WorkerOutcome` from this plus its own parsing of
 * `stdout`, but `stdout` content must never be allowed to override
 * `terminationReason`/`exitCode` when deciding success or failure.
 */
export interface ProcessResult {
  readonly terminationReason: ProcessTerminationReason;
  /** `null` when the process never produced an exit code (spawn failure, or killed by signal). */
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly startedAt: Timestamp;
  readonly finishedAt: Timestamp;
  readonly durationMs: number;
  /** Set only when `terminationReason === "SPAWN_ERROR"`. A safe message — never raw env/paths beyond what Node already reports. */
  readonly spawnError?: string;
}

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}
