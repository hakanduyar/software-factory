/**
 * The `gh` and `git` adapters — the TRUSTED ORCHESTRATION BOUNDARY (TASK-016).
 *
 * WHY THIS FILE IS THE CREDENTIAL BOUNDARY, stated plainly because the whole
 * of AC-6 rests on it. `gh` keeps an OAuth token in `~/.config/gh/hosts.yml`,
 * so any process handed `HOME` can act as the GitHub user. That is acceptable
 * here — this adapter runs inside the supervisor, which is trusted code — and
 * it is exactly what must never be true of the TASK-011 isolated child, whose
 * `ISOLATED_EXECUTOR_ENV_ALLOWLIST` omits `HOME` for this reason and is not
 * touched by this file.
 *
 * The environment below is therefore a THIRD allowlist rather than a reuse of
 * either existing one. `DEFAULT_WORKER_ENV_ALLOWLIST` would work, but reusing
 * it would say that a GitHub-credentialed environment and an AI-worker
 * environment are the same thing, and the next person to edit one would
 * silently change the other.
 *
 * Everything else here follows disciplines this repository already established:
 * argv arrays never concatenated into a command string, no shell, absolute
 * executables (F-7: a bare name resolves through PATH and can be substituted),
 * exit code is authority and stdout is only ever diagnostic, output bounded and
 * redacted before it can become a message.
 */

import { spawnSync } from "node:child_process";

import { buildWorkerEnvironment, redactSecrets } from "../workers/environmentPolicy.js";
import { boundedDiagnostic } from "../../supervision/resourceClassifier.js";
import {
  isCommitSha,
  type CheckConclusion,
  type PullRequestState,
  type RemoteCheckStatus,
  type RemotePullRequest,
  type RemoteRepository,
} from "../../github/candidateBinding.js";
import type { GitHubClient, GitPusher, GitRepositoryReader } from "../../github/githubPorts.js";
import type { RepositoryVisibility } from "../../supervision/financialSafety.js";
import type { ProcessRunner } from "../../ports/processRunner.js";

/**
 * The credential-bearing environment. `HOME`/`XDG_CONFIG_HOME` are present so
 * `gh` finds its OWN already-authenticated store — the Factory never handles a
 * token itself, exactly as it never handles a provider API key.
 *
 * `GH_TOKEN`/`GITHUB_TOKEN` are deliberately ABSENT. Forwarding them would make
 * the Factory a token-carrier and put a credential into a process environment
 * that shows up in `ps` output on a shared machine.
 */
export const GITHUB_CLI_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
]);

export const GITHUB_CLI_ENVIRONMENT_POLICY = Object.freeze({ allowedVars: GITHUB_CLI_ENV_ALLOWLIST });

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Absolute paths only (F-7, from `cliResourceProbe`).
 *
 * A bare `gh` would be resolved through `PATH`, and `PATH` is inherited — so
 * anything able to put a `gh` earlier on it would be running with the
 * Factory's GitHub credentials. Resolved ONCE here, via an absolute `which`.
 */
function resolveExecutable(name: string, override?: string): string {
  if (override !== undefined) {
    if (!override.startsWith("/")) {
      throw new Error(`executable override for ${name} must be an absolute path, got ${JSON.stringify(override)}`);
    }
    return override;
  }
  const found = spawnSync("/usr/bin/which", [name], { encoding: "utf8", timeout: 10_000 });
  const resolved = (found.stdout ?? "").trim().split("\n")[0] ?? "";
  if (!resolved.startsWith("/")) {
    throw new Error(`${name} was not found as an absolute path on PATH`);
  }
  return resolved;
}

export interface GhCliDeps {
  readonly processRunner: ProcessRunner;
  readonly cwd: string;
  /** `owner/name`. Passed explicitly so the adapter never infers its own target. */
  readonly repository: string;
  readonly ghPath?: string;
  readonly gitPath?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/** Bounded, redacted, and never allowed to decide anything. */
function diagnostic(text: string): string {
  return redactSecrets(boundedDiagnostic(text));
}

async function run(
  deps: GhCliDeps,
  executable: string,
  argv: readonly string[],
): Promise<string> {
  const result = await deps.processRunner.run({
    executable,
    argv,
    cwd: deps.cwd,
    env: buildWorkerEnvironment(GITHUB_CLI_ENVIRONMENT_POLICY, deps.env ?? process.env),
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  /**
   * EXIT CODE IS AUTHORITY. No quantity of reassuring text on stdout turns a
   * non-zero exit into a success, and the captured output is only ever used to
   * say why something failed.
   */
  if (result.terminationReason !== "EXITED" || result.exitCode !== 0) {
    const detail = diagnostic(result.stderr.length > 0 ? result.stderr : result.stdout);
    throw new Error(
      `${executable} ${argv[0] ?? ""} failed (${result.terminationReason}, exit ${String(result.exitCode)}): ${detail}`,
    );
  }
  return result.stdout;
}

/**
 * Parses one JSON object from CLI stdout, strictly.
 *
 * Untrusted input: the remote decides this text. A parse failure is a refusal,
 * never a default value — an adapter that returned an empty object here would
 * hand the binding checks "no pull request" when the truth is "we could not
 * tell", and those two must not be the same answer.
 */
function parseObject(raw: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${what} did not return parseable JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${what} returned ${Array.isArray(parsed) ? "an array" : typeof parsed}, expected an object`);
  }
  return parsed as Record<string, unknown>;
}

function requireString(row: Record<string, unknown>, field: string, what: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${what} did not report a usable ${field}`);
  }
  return value;
}

function requireSha(row: Record<string, unknown>, field: string, what: string): string {
  const value = row[field];
  if (!isCommitSha(value)) {
    // The message quotes nothing from the remote beyond the field name: a
    // malformed sha is a shape problem, and echoing arbitrary remote text into
    // a diagnostic is how untrusted data reaches a log.
    throw new Error(`${what} did not report a full 40-character commit id for ${field}`);
  }
  return value;
}

function visibilityOf(raw: unknown): RepositoryVisibility {
  // Anything the remote says that is not exactly one of the two known values is
  // UNKNOWN, which the financial gate treats as financial.
  return raw === "PUBLIC" ? "PUBLIC" : raw === "PRIVATE" ? "PRIVATE" : "UNKNOWN";
}

function stateOf(raw: unknown): PullRequestState {
  return raw === "OPEN" ? "OPEN" : raw === "MERGED" ? "MERGED" : "CLOSED";
}

export function createGhCliClient(deps: GhCliDeps): GitHubClient {
  const gh = resolveExecutable("gh", deps.ghPath);

  return {
    async repository(): Promise<RemoteRepository> {
      const raw = await run(deps, gh, [
        "repo",
        "view",
        deps.repository,
        "--json",
        "nameWithOwner,visibility,defaultBranchRef",
      ]);
      const row = parseObject(raw, "gh repo view");
      const defaultBranchRef = row["defaultBranchRef"];
      const defaultBranch =
        typeof defaultBranchRef === "object" && defaultBranchRef !== null
          ? requireString(defaultBranchRef as Record<string, unknown>, "name", "gh repo view")
          : (() => {
              throw new Error("gh repo view did not report a default branch");
            })();

      /**
       * The integration count is a SEPARATE call that is allowed to fail
       * softly into `undefined` — which the push verdict treats as unknown,
       * which is financial. Soft here means "we could not establish it", never
       * "there are none": the difference is the whole guard.
       */
      let billableIntegrations: number | undefined;
      try {
        const hooks = await run(deps, gh, [
          "api",
          `repos/${deps.repository}/hooks`,
          "--jq",
          "length",
        ]);
        const count = Number.parseInt(hooks.trim(), 10);
        billableIntegrations = Number.isSafeInteger(count) && count >= 0 ? count : undefined;
      } catch {
        billableIntegrations = undefined;
      }

      return {
        nameWithOwner: requireString(row, "nameWithOwner", "gh repo view"),
        defaultBranch,
        visibility: visibilityOf(row["visibility"]),
        billableIntegrations,
      };
    },

    async findPullRequest(headRef: string): Promise<RemotePullRequest | undefined> {
      const raw = await run(deps, gh, [
        "pr",
        "list",
        "--repo",
        deps.repository,
        "--head",
        headRef,
        "--state",
        "all",
        "--limit",
        "10",
        "--json",
        "number,state,headRefName,headRefOid,baseRefName,baseRefOid",
      ]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("gh pr list did not return parseable JSON");
      }
      if (!Array.isArray(parsed)) {
        throw new Error("gh pr list did not return an array");
      }
      if (parsed.length === 0) {
        return undefined;
      }
      /**
       * MORE THAN ONE OPEN PR FOR ONE BRANCH IS AMBIGUOUS, and ambiguity is
       * refused rather than resolved by picking the first. GitHub does not
       * normally permit it, which is precisely why encountering it means
       * something is not as assumed.
       */
      const open = parsed.filter(
        (entry) => typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)["state"] === "OPEN",
      );
      if (open.length > 1) {
        throw new Error(`more than one open pull request reports head ${JSON.stringify(headRef)}`);
      }
      const chosen = (open[0] ?? parsed[0]) as Record<string, unknown>;
      const number = chosen["number"];
      if (typeof number !== "number" || !Number.isSafeInteger(number)) {
        throw new Error("gh pr list did not report a usable pull request number");
      }
      return {
        number,
        state: stateOf(chosen["state"]),
        headRef: requireString(chosen, "headRefName", "gh pr list"),
        headSha: requireSha(chosen, "headRefOid", "gh pr list"),
        baseRef: requireString(chosen, "baseRefName", "gh pr list"),
        baseSha: requireSha(chosen, "baseRefOid", "gh pr list"),
      };
    },

    async createPullRequest(input): Promise<RemotePullRequest> {
      await run(deps, gh, [
        "pr",
        "create",
        "--repo",
        deps.repository,
        "--head",
        input.headRef,
        "--base",
        input.baseRef,
        "--title",
        input.title,
        "--body",
        input.body,
      ]);
      /**
       * The created PR is READ BACK rather than parsed out of the create
       * output, so the object returned carries the same SHA-bound shape every
       * other path produces. `gh pr create` prints a URL; a URL is a label.
       */
      const created = await this.findPullRequest(input.headRef);
      if (created === undefined) {
        throw new Error(`the pull request for ${input.headRef} could not be read back after creation`);
      }
      return created;
    },

    async checkStatus(sha: string): Promise<RemoteCheckStatus> {
      if (!isCommitSha(sha)) {
        throw new Error("checkStatus requires a full 40-character commit id");
      }
      const raw = await run(deps, gh, [
        "api",
        `repos/${deps.repository}/commits/${sha}/check-runs`,
        "--jq",
        "{total: .total_count, conclusions: [.check_runs[].conclusion], statuses: [.check_runs[].status]}",
      ]);
      const row = parseObject(raw, "gh api check-runs");
      const total = row["total"];
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
        throw new Error("the check-runs response did not report a usable count");
      }
      const conclusions = Array.isArray(row["conclusions"]) ? row["conclusions"] : [];
      const statuses = Array.isArray(row["statuses"]) ? row["statuses"] : [];

      let conclusion: CheckConclusion;
      if (total === 0) {
        // AC-4: distinct from success, and it stays distinct all the way out.
        conclusion = "NO_CHECKS_CONFIGURED";
      } else if (statuses.some((entry) => entry !== "completed")) {
        conclusion = "PENDING";
      } else if (conclusions.every((entry) => entry === "success" || entry === "neutral" || entry === "skipped")) {
        conclusion = "SUCCESS";
      } else {
        conclusion = "FAILURE";
      }
      // The sha travels with the answer: this is what makes the evidence bound.
      return { sha, conclusion, total };
    },
  };
}

/** Local git reads. No credentials are needed and none are forwarded. */
export function createGitRepositoryReader(deps: GhCliDeps): GitRepositoryReader {
  const git = resolveExecutable("git", deps.gitPath);
  return {
    async remoteUrl(): Promise<string> {
      return (await run(deps, git, ["remote", "get-url", "origin"])).trim();
    },
    async revision(rev: string): Promise<string | undefined> {
      try {
        const resolved = (await run(deps, git, ["rev-parse", "--verify", `${rev}^{commit}`])).trim();
        return isCommitSha(resolved) ? resolved : undefined;
      } catch {
        // An unresolvable revision is an answer ("it is not there"), not a fault.
        return undefined;
      }
    },
    async isClean(): Promise<boolean> {
      return (await run(deps, git, ["status", "--porcelain"])).trim().length === 0;
    },
  };
}

/**
 * The single remote WRITE.
 *
 * `--force-with-lease` is NOT used, and neither is `--force`: this pushes a
 * fast-forward or it fails. `refs/heads/<branch>` is written explicitly so a
 * ref name that happens to match a tag cannot redirect the push.
 */
export function createGitPusher(deps: GhCliDeps): GitPusher {
  const git = resolveExecutable("git", deps.gitPath);
  return {
    async pushFastForward(input): Promise<void> {
      if (!isCommitSha(input.sha)) {
        throw new Error("pushFastForward requires a full 40-character commit id");
      }
      await run(deps, git, ["push", "origin", `${input.sha}:refs/heads/${input.branch}`]);
    },
  };
}
