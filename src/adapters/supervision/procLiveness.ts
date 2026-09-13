/**
 * TASK-018 PART B — whether the process holding a lease is still there.
 *
 * `activity.ts` treats liveness as a fact that arrives as an argument. This is
 * where that fact comes from on Linux, and it is deliberately the only place
 * that reads the process table.
 *
 * ================================================================
 * WHY A PID IS NOT AN IDENTITY
 * ================================================================
 * Process ids are reused. A lease naming pid 4242 would read as "still running"
 * forever once some unrelated process happened to be given that number — and
 * AC-16 names exactly that case, because it is the one that turns a recovery
 * mechanism into a permanent deadlock: nothing can ever take the lease again.
 *
 * `/proc/<pid>/stat` field 22 is the process's start time in clock ticks since
 * boot. Together with the pid it is unique for as long as the machine is up,
 * which is exactly as long as a lease can matter. So the lease records it, and
 * a pid whose start time disagrees is a DIFFERENT process: GONE, not alive.
 *
 * ================================================================
 * WHY "UNKNOWN" IS A REAL ANSWER
 * ================================================================
 * A lease from another machine cannot be checked from here at all, and a
 * `/proc` entry this user may not read is genuinely unknowable. Both are
 * UNKNOWN, and `activity.ts` turns UNKNOWN into a refusal rather than into a
 * guess. Reporting either as GONE would let a second owner take a lease whose
 * holder is still writing, which is how two mutation runs poisoned the same
 * tree.
 */

import { readFileSync } from "node:fs";
import { hostname } from "node:os";

import type { ActivityLease, Liveness, LivenessProbe } from "../../supervision/activity.js";

/**
 * Field 22 of `/proc/<pid>/stat`, counting from 1.
 *
 * The tokens are read AFTER the last `)`, because field 2 is the executable
 * name in parentheses and may itself contain spaces and parentheses — a process
 * called `my ) program` breaks every naive split, and a parser that can be
 * confused by a filename is a parser an attacker chooses the filename for.
 * After the last `)` the first token is field 3, so field 22 is index 19.
 */
const STARTTIME_INDEX_AFTER_COMM = 19;
const STATE_INDEX_AFTER_COMM = 0;

export interface ProcLivenessOptions {
  /** Overridable so a test can point at a fixture tree instead of real `/proc`. */
  readonly procRoot?: string;
  /** Overridable so a test can state which machine it is pretending to be. */
  readonly machine?: string;
}

/**
 * This machine, as stably as this host can say it.
 *
 * `/etc/machine-id` survives a hostname change and a reboot, which a hostname
 * does not; the hostname is the fallback rather than the first choice because a
 * lease that stops matching its own machine after a rename would be read as
 * "another machine" — UNKNOWN — and would never be reclaimable.
 */
export function machineIdentity(): string {
  for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (value.length > 0) return value;
    } catch {
      // Fall through: an absent or unreadable machine-id is ordinary.
    }
  }
  return `hostname:${hostname()}`;
}

/** The start time of a process, or undefined when it cannot be established. */
export function processStartTime(pid: number, procRoot = "/proc"): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(`${procRoot}/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  return startTimeFromStat(raw);
}

/** Exported for the parser's own tests: the filename cases are the whole risk. */
export function startTimeFromStat(raw: string): number | undefined {
  const close = raw.lastIndexOf(")");
  if (close === -1) return undefined;
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  const value = fields[STARTTIME_INDEX_AFTER_COMM];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Exported for the same reason: a zombie is not a running process. */
export function stateFromStat(raw: string): string | undefined {
  const close = raw.lastIndexOf(")");
  if (close === -1) return undefined;
  return raw.slice(close + 1).trim().split(/\s+/)[STATE_INDEX_AFTER_COMM];
}

/**
 * A lease for THIS process, ready to be recorded.
 *
 * Built here rather than by the caller so that the start time in the lease and
 * the start time the probe compares against always come from the same reader.
 * A lease whose start time was obtained some other way would fail its own check
 * and the holder would immediately look dead to itself.
 */
export function leaseForThisProcess(
  claimedAt: number,
  options: ProcLivenessOptions = {},
): ActivityLease | undefined {
  const started = processStartTime(process.pid, options.procRoot ?? "/proc");
  if (started === undefined) {
    // Refuse to invent one. A lease whose liveness can never be checked is
    // worse than no lease: it reads as UNKNOWN forever and blocks every retry.
    return undefined;
  }
  return {
    pid: process.pid,
    processStartedAt: started,
    machine: options.machine ?? machineIdentity(),
    claimedAt,
  };
}

export function createProcLivenessProbe(options: ProcLivenessOptions = {}): LivenessProbe {
  const procRoot = options.procRoot ?? "/proc";
  const machine = options.machine ?? machineIdentity();

  return {
    check(lease: ActivityLease): Liveness {
      if (lease.machine !== machine) {
        // Not a judgement about the process: a statement that this host is not
        // in a position to make one.
        return "UNKNOWN";
      }
      if (!Number.isSafeInteger(lease.pid) || lease.pid <= 0) {
        return "UNKNOWN";
      }

      let raw: string;
      try {
        raw = readFileSync(`${procRoot}/${lease.pid}/stat`, "utf8");
      } catch (error) {
        // ENOENT is the ordinary answer for a process that ended. Anything else
        // — a permission error, a /proc that is not mounted — is not evidence
        // of death and must not be reported as such.
        return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "GONE" : "UNKNOWN";
      }

      const started = startTimeFromStat(raw);
      if (started === undefined) {
        return "UNKNOWN";
      }
      if (started !== lease.processStartedAt) {
        /**
         * THE PID WAS REUSED. Something is running under this number, and it is
         * not the holder. Reporting ALIVE here is what makes a lease permanent.
         */
        return "GONE";
      }
      if (stateFromStat(raw) === "Z") {
        /**
         * A zombie has terminated and is waiting to be reaped. It cannot write,
         * cannot finish the activity, and will never release the lease itself,
         * so treating it as alive would deadlock the activity for as long as its
         * parent neglects it. It is gone in every sense this mechanism cares
         * about, and the takeover it permits is safe precisely because a zombie
         * cannot act.
         */
        return "GONE";
      }
      return "ALIVE";
    },
  };
}
