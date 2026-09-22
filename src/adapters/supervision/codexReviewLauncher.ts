/**
 * Starting an independent reviewer, and letting it prove it started
 * (TASK-019 AC-2, AC-4, AC-6).
 *
 * THE ADAPTER HALF. The supervisor decides that a candidate should be reviewed,
 * by whom, and at what effort; this is the part that knows those decisions are
 * carried out today by a CLI in a detached process. Nothing above this file
 * knows that, which is the point: the shell chain being replaceable is the
 * whole task.
 *
 * WHY A WRAPPER SCRIPT RATHER THAN SPAWNING THE CLI DIRECTLY. Two reasons, both
 * learned the hard way:
 *
 *   - the ACKNOWLEDGEMENT must be written by the process that is actually doing
 *     the work, before it does any of it. A pid recorded by the LAUNCHER proves
 *     only that the launcher believed something; a pid the worker writes about
 *     itself, next to the run id it was given and the start tick it reads from
 *     its own `/proc` entry, cannot be an unrelated process that inherited a
 *     recycled number.
 *   - the reviewer must outlive this supervisor. A supervisor restart is
 *     ordinary and must not kill a review that is an hour into its work, so the
 *     child is detached and its output goes to files rather than to a pipe
 *     nobody will be alive to read.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { LaunchAcknowledgement } from "../../supervision/acceptance.js";
import type {
  ReviewLauncher,
  ReviewLaunchRequest,
  ReviewLaunchResult,
} from "../../supervision/supervisorPorts.js";

import { bootIdentity, machineIdentity } from "./procLiveness.js";

export interface CodexReviewLauncherOptions {
  /** The prompt the reviewer is given. Task-specific, so it is injected. */
  readonly packet: (request: ReviewLaunchRequest) => string;
  /** Where the reviewer runs. The candidate's worktree. */
  readonly repository: string;
  /** Overridable for tests: what to run instead of the real CLI. */
  readonly command?: (request: ReviewLaunchRequest) => readonly string[];
  readonly log?: (line: string) => void;
}

/** Messages a provider gives when it has nothing left to give. */
const EXHAUSTED = /usage limit|rate limit|quota|insufficient[_ ]quota|out of credit/i;

function ensureDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

/**
 * The reviewer's own first act: say who it is, and name the run it was given.
 *
 * Written with a temporary file and a rename so a reader can never see half an
 * acknowledgement — the supervisor polls this path on every tick, and a
 * half-written JSON object read at the wrong moment would be indistinguishable
 * from a corrupt one.
 */
function acknowledgementScript(request: ReviewLaunchRequest): string {
  return [
    `RUN_ID=${JSON.stringify(request.reviewId)}`,
    `ACK=${JSON.stringify(request.ack)}`,
    'START_TICKS=$(awk \'{ n = split($0, f, ") "); print f[n] }\' /proc/$$/stat | cut -d" " -f20)',
    'MACHINE=$(cat /etc/machine-id 2>/dev/null || echo unknown)',
    'BOOT=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)',
    'printf \'{"runId":"%s","pid":%s,"processStartedAt":%s,"machine":"%s","boot":"%s","at":%s}\\n\' ' +
      '"$RUN_ID" "$$" "$START_TICKS" "$MACHINE" "$BOOT" "$(date +%s000)" > "$ACK.tmp"',
    'mv "$ACK.tmp" "$ACK"',
  ].join("\n");
}

export function createCodexReviewLauncher(options: CodexReviewLauncherOptions): ReviewLauncher {
  const log = options.log ?? (() => {});

  return {
    async launch(request: ReviewLaunchRequest): Promise<ReviewLaunchResult> {
      ensureDirectory(request.ack);
      ensureDirectory(request.source);

      /**
       * A RELAUNCH STARTS FROM NOTHING.
       *
       * A retry reuses the run id — it is derived from the request, not
       * generated — and therefore reuses these paths. An acknowledgement left by
       * the attempt that died would otherwise be adopted as proof that THIS
       * attempt is running, which is the same lie by a longer route. Removing
       * them makes "the file exists" mean "this launch's worker wrote it".
       */
      for (const stale of [request.ack, request.source]) {
        try {
          rmSync(stale, { force: true });
        } catch {
          // Unremovable is not fatal here: the domain still checks the run id,
          // and a stale file that survives is refused there rather than adopted.
        }
      }

      const base = `${request.source}.run`;
      const packetPath = `${request.source}.packet`;
      const scriptPath = `${request.source}.sh`;

      try {
        writeFileSync(packetPath, options.packet(request), { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        return { ok: false, problem: `could not write the review packet: ${(error as Error).message}` };
      }

      const command =
        options.command?.(request) ??
        [
          "codex",
          "exec",
          "-m",
          request.model,
          "-c",
          `model_reasoning_effort="${request.effort}"`,
          "--skip-git-repo-check",
        ];

      /**
       * The verdict is the reviewer's LAST message, and it is written by the
       * wrapper rather than parsed out of a transcript by the supervisor: the
       * supervisor's parser is strict on purpose, and handing it a whole
       * transcript would give prose a second chance to look like a verdict.
       */
      const script = [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'export NVM_DIR="$HOME/.nvm"',
        '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1',
        `cd ${JSON.stringify(options.repository)} || exit 9`,
        acknowledgementScript(request),
        `${command.map((part) => JSON.stringify(part)).join(" ")} < ${JSON.stringify(packetPath)} > ${JSON.stringify(`${base}.log`)} 2>&1`,
        "RC=$?",
        // Only a successful run may produce a verdict. A crashed reviewer's
        // output is never handed to the parser: "PASS" printed by a process
        // that died is exactly the approval this must never manufacture.
        `if [ "$RC" -eq 0 ]; then`,
        `  awk '/^VERDICT: /{found=1} found{print}' ${JSON.stringify(`${base}.log`)} > ${JSON.stringify(request.source)}`,
        "fi",
        `echo "$RC" > ${JSON.stringify(`${base}.rc`)}`,
      ].join("\n");

      try {
        writeFileSync(scriptPath, script, { encoding: "utf8", mode: 0o700 });
        chmodSync(scriptPath, 0o700);
      } catch (error) {
        return { ok: false, problem: `could not write the reviewer wrapper: ${(error as Error).message}` };
      }

      try {
        const child = spawn("/usr/bin/env", ["bash", scriptPath], {
          cwd: options.repository,
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        log(`[launcher] started ${request.reviewId} as pid ${child.pid ?? "unknown"}`);
        /**
         * `ok` means THE ATTEMPT WAS MADE. It deliberately does not mean the
         * reviewer is running: `child.pid` here is the wrapper, and the only
         * thing that establishes a running review is the acknowledgement the
         * wrapper writes about itself.
         */
        return { ok: true, detail: `spawned ${request.reviewId}` };
      } catch (error) {
        const message = (error as Error).message;
        return { ok: false, problem: message, ...(EXHAUSTED.test(message) ? { exhausted: true } : {}) };
      }
    },

    acknowledgement(request: ReviewLaunchRequest): LaunchAcknowledgement | undefined {
      if (!existsSync(request.ack)) {
        return undefined;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(request.ack, "utf8"));
      } catch {
        // Mid-write, or corrupt. Either way there is no proof yet, and the next
        // tick asks again — which is why this returns absence rather than an
        // error the caller would have to invent a meaning for.
        return undefined;
      }
      if (typeof parsed !== "object" || parsed === null) {
        return undefined;
      }
      const row = parsed as Record<string, unknown>;
      const runId = row["runId"];
      const pid = row["pid"];
      const startedAt = row["processStartedAt"];
      const machine = row["machine"];
      const boot = row["boot"];
      const at = row["at"];
      if (
        typeof runId !== "string" ||
        typeof pid !== "number" ||
        typeof startedAt !== "number" ||
        typeof machine !== "string" ||
        typeof boot !== "string" ||
        typeof at !== "number"
      ) {
        return undefined;
      }
      /**
       * The run id is checked by the DOMAIN, not here: `adoptLaunchedReview`
       * compares it against the record that predates the worker. This adapter's
       * job is to report faithfully what the file says, including when what it
       * says is wrong.
       */
      return { runId, pid, processStartedAt: startedAt, machine, boot, at };
    },
  };
}

/** Where a launcher writes, when nothing else is configured. */
export function defaultReviewDirectory(): string {
  return process.env["SF_REVIEW_DIR"] ?? join(process.env["HOME"] ?? "/tmp", ".software-factory", "reviews");
}

/** Re-exported so a caller can build a lease-comparable identity in tests. */
export const launcherIdentity = { machineIdentity, bootIdentity };
