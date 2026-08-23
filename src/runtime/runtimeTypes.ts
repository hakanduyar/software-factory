/**
 * The local 24/7 runtime (TASK-007).
 *
 * TASK-006 built a tick that does one bounded pass and exits, and publishes
 * `nextWakeAt` precisely so that something else can own the waiting. This is
 * that something else, and it is deliberately the smallest thing that could
 * work: a systemd USER TIMER.
 *
 * WHY NOT A DAEMON. A resident process would reintroduce exactly the cost
 * TASK-006 exists to remove — something always running, something to leak,
 * something to restart, something that can hold a model session open. With a
 * timer, between firings NO PROCESS RUNS AT ALL. Waiting is free because nothing
 * is waiting.
 *
 * WHY GENERATED, NOT COMMITTED AS LITERALS. Unit files need absolute paths — to
 * the node binary, the CLI entry point, the repository — and those differ per
 * machine. A wrong path in a committed unit file does not fail loudly at review
 * time; it fails silently at 3am when nobody is watching. So the units are
 * derived from facts measured at install time, and installation fails closed if
 * any fact is missing.
 */

import type { Timestamp } from "../domain/time.js";

/** The unit names this task owns. Nothing else may be written or removed. */
export const SERVICE_UNIT = "software-factory-supervisor.service";
export const TIMER_UNIT = "software-factory-supervisor.timer";

/** Every path this task will ever touch, so uninstall can be exact (AC-7). */
export const OWNED_UNITS: readonly string[] = Object.freeze([SERVICE_UNIT, TIMER_UNIT]);

/**
 * How long after the previous tick finishes the next one fires.
 *
 * Fifteen minutes is a deliberate default rather than a tuned one. The
 * supervisor already refuses to probe a resource whose `retryAt` is in the
 * future, so ticking more often costs almost nothing and buys responsiveness;
 * ticking much less often makes a recovered provider sit idle. If this ever
 * needs tuning it should be tuned against observed behaviour, not guessed
 * harder.
 */
export const DEFAULT_INTERVAL_SECONDS = 900;

/**
 * How long a single tick may run before systemd kills it (AC-8).
 *
 * A tick is one bounded pass: probe, decide, possibly launch, settle. Ten
 * minutes is generous for that and still short enough that a wedged tick cannot
 * silently own the schedule forever.
 */
export const DEFAULT_TIMEOUT_SECONDS = 600;

/** First tick after a boot, giving the machine a moment to settle. */
export const DEFAULT_BOOT_DELAY_SECONDS = 120;

/**
 * The measured facts a unit file is built from.
 *
 * All absolute (AC-1). A unit runs with no shell, no profile, no nvm and no
 * inherited PATH, so anything relative here would resolve differently — or not
 * at all — when systemd runs it rather than a terminal.
 */
export interface RuntimeFacts {
  /** Absolute path to the node binary that will run the CLI. */
  readonly nodeBinary: string;
  /** Absolute path to the built CLI entry point. */
  readonly cliEntry: string;
  /** Absolute repository root; becomes the unit's WorkingDirectory. */
  readonly repositoryRoot: string;
  /** Absolute path to the supervisor database. */
  readonly databasePath: string;
  /** Absolute path of the systemd user unit directory. */
  readonly unitDirectory: string;
  readonly intervalSeconds: number;
  readonly timeoutSeconds: number;
  readonly bootDelaySeconds: number;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The seam between runtime logic and the machine.
 *
 * Exists so unit rendering, idempotency and fail-closed behaviour can be tested
 * without writing to the operator's real `~/.config/systemd/user` — a test that
 * installs a timer on the developer's actual machine is not a test, it is an
 * incident.
 */
export interface RuntimeHost {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, contents: string): Promise<void>;
  makeDirectory(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Runs an absolute-path executable with fixed arguments. Never a shell. */
  run(executable: string, args: readonly string[]): Promise<CommandResult>;
  now(): Timestamp;
}

export type RuntimeOutcome =
  | { readonly ok: true; readonly detail: string; readonly changed: boolean }
  | { readonly ok: false; readonly reason: string };

/** What `sf runtime status` reports. Every field is observed, never assumed. */
export interface RuntimeStatus {
  readonly serviceInstalled: boolean;
  readonly timerInstalled: boolean;
  readonly timerEnabled: boolean;
  readonly timerActive: boolean;
  readonly lingerEnabled: boolean;
  readonly lastResult?: string;
  readonly nextRun?: string;
  readonly problems: readonly string[];
}
