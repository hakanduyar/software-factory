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

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { LaunchAcknowledgement } from "../../supervision/acceptance.js";
import type {
  ReviewCompletionQuery,
  ReviewCompletionReading,
  ReviewLauncher,
  ReviewLaunchRequest,
  ReviewLaunchResult,
} from "../../supervision/supervisorPorts.js";

import { bootIdentity, machineIdentity } from "./procLiveness.js";
import { clearReviewRunArtifacts, readReviewCompletion, reviewRunPaths } from "./reviewCompletion.js";
import { buildWorkerEnvironment, DEFAULT_WORKER_ENVIRONMENT_POLICY } from "../workers/environmentPolicy.js";

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

/** A shell word is data, including dollar expansion, backticks and quotes. */
function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function ensureDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

function resolvedCli(name: "codex" | "claude"): string | undefined {
  const found = spawnSync("/usr/bin/which", [name], { encoding: "utf8" });
  const path = found.stdout.trim().split("\n")[0];
  return found.status === 0 && path !== undefined && isAbsolute(path) ? path : undefined;
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
    `RUN_ID=${shellQuote(request.reviewId)}`,
    `ACK=${shellQuote(request.ack)}`,
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
       *
       * SF-R3 widened this to the OUTCOME artefacts for the same reason: an old
       * `.run.rc`, log, or completion record would otherwise be read as this
       * launch's result, and a stale completion is a settled review that never
       * happened.
       */
      for (const stale of [request.ack, request.source]) {
        try {
          rmSync(stale, { force: true });
        } catch (error) {
          // A stale artifact for this same run could be mistaken for fresh
          // launch evidence. Refuse before invoking any worker.
          return { ok: false, problem: `could not clear stale review artifact: ${(error as Error).message}` };
        }
      }
      try {
        clearReviewRunArtifacts(request.source);
      } catch (error) {
        return { ok: false, problem: `could not clear stale review artifact: ${(error as Error).message}` };
      }

      const paths = reviewRunPaths(request.source);
      const packetPath = `${request.source}.packet`;
      const scriptPath = `${request.source}.sh`;

      /**
       * NO PUBLISHER, NO LAUNCH.
       *
       * The publisher is what turns a finished CLI into a verdict candidate and
       * into completion evidence. Spawning a reviewer without it would spend a
       * real call and produce a review nothing could ever settle — so this is
       * checked before anything is started, not discovered afterwards.
       */
      const publisher = fileURLToPath(new URL("./reviewPublishMain.js", import.meta.url));
      if (!existsSync(publisher)) {
        return { ok: false, problem: `the review outcome publisher is missing at ${publisher}` };
      }

      try {
        writeFileSync(packetPath, options.packet(request), { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        return { ok: false, problem: `could not write the review packet: ${(error as Error).message}` };
      }

      const executable = options.command === undefined
        ? request.provider === "codex-cli" ? resolvedCli("codex")
          : request.provider === "claude-code" ? resolvedCli("claude") : undefined
        : undefined;
      /**
       * STRUCTURED OUTPUT, both providers (SF-R3).
       *
       * `exec --json` and `--output-format json` are the measured invocations the
       * accepted worker adapters already use and document, and they are what
       * makes "the reviewer's last message" a fact rather than a guess about
       * where prose ends. Model, effort, sandbox/permission mode and the packet
       * handling are unchanged.
       */
      const command = options.command?.(request) ??
        (executable === undefined ? undefined : request.provider === "codex-cli"
          ? [executable, "exec", "--json", "-m", request.model, "-c",
              `model_reasoning_effort="${request.effort}"`, "--sandbox", "read-only", "--skip-git-repo-check"]
          : request.provider === "claude-code"
            ? [executable, "-p", "--model", request.model, "--effort", request.effort,
                "--permission-mode", "plan", "--output-format", "json"]
            : undefined);
      if (command === undefined) {
        return { ok: false, problem: `no review executable for provider ${request.provider}` };
      }
      // Claude's -p invocation takes the prompt as an argument; Codex reads stdin.
      const promptInput = request.provider === "claude-code" && options.command === undefined
        ? ` "$(cat ${shellQuote(packetPath)})"`
        : ` < ${shellQuote(packetPath)}`;

      /**
       * The verdict is the reviewer's FINAL STRUCTURED MESSAGE, and the decision
       * about which message that is belongs to `reviewPublishMain` (SF-R3).
       *
       * What this script does, and deliberately no more: keep stdout and stderr
       * in SEPARATE files so stderr text can never masquerade as a reviewer
       * message, record the exit code, and hand both to the publisher along with
       * the run id. The old `awk` copied from the first `VERDICT:` line onward,
       * which accepted a prompt echo or an earlier message as the conclusion.
       */
      const script = [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'export NVM_DIR="$HOME/.nvm"',
        '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1',
        `cd ${shellQuote(options.repository)} || exit 9`,
        acknowledgementScript(request),
        `${command.map((part) => shellQuote(part)).join(" ")}${promptInput} > ${shellQuote(paths.stdout)} 2> ${shellQuote(paths.stderr)}`,
        "RC=$?",
        `echo "$RC" > ${shellQuote(paths.exitCode)}`,
        // The publisher writes the verdict candidate only for a clean exit with
        // a valid structured final message, and publishes the completion
        // evidence either way. Its own output is kept out of both.
        `${shellQuote(process.execPath)} ${shellQuote(publisher)} ${shellQuote(request.provider)} ` +
          `${shellQuote(request.reviewId)} ${shellQuote(request.source)} "$RC" > ${shellQuote(paths.publisherLog)} 2>&1`,
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
          // Match the probe and the accepted worker adapters: no ambient API
          // keys, provider overrides, shell hooks or unrelated credentials.
          env: buildWorkerEnvironment(DEFAULT_WORKER_ENVIRONMENT_POLICY),
        });
        // spawn() reports exec failures asynchronously. Observe the event before
        // saying a launch was attempted successfully, and never leave an
        // unhandled error event on a detached child.
        await new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("spawn", resolve);
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

    /**
     * What the finished reviewer left behind (SF-R3).
     *
     * A pure read. It reports absence as absence, a torn or foreign record as
     * unusable, and never infers that a worker is running — a completion cannot
     * establish liveness, only that something ENDED.
     */
    completion(query: ReviewCompletionQuery): ReviewCompletionReading {
      return readReviewCompletion(query);
    },
  };
}

/** Where a launcher writes, when nothing else is configured. */
export function defaultReviewDirectory(): string {
  return process.env["SF_REVIEW_DIR"] ?? join(process.env["HOME"] ?? "/tmp", ".software-factory", "reviews");
}

/** Re-exported so a caller can build a lease-comparable identity in tests. */
export const launcherIdentity = { machineIdentity, bootIdentity };
