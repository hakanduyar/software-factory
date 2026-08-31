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
import type { RepositoryOwnerType, RepositoryVisibility } from "../../supervision/financialSafety.js";
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

function ownerTypeOf(raw: unknown): RepositoryOwnerType {
  return raw === "User" ? "USER" : raw === "Organization" ? "ORGANIZATION" : "UNKNOWN";
}

/**
 * A count, or `undefined` when the text is not exactly a count.
 *
 * ROUND-1 REVIEW, HIGH 4. `Number.parseInt` reads a leading number and
 * DISCARDS the rest, so `"0trailing-garbage"` became a confident zero — a
 * malformed response failing OPEN into "no webhooks". A remote-supplied string
 * is parsed strictly or not at all.
 */
function strictCount(raw: string): number | undefined {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    return undefined;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * `owner/name` from a git remote URL, or `undefined` when it is not a GitHub
 * URL this adapter understands.
 *
 * ROUND-1 REVIEW, CRITICAL 1. The push target must be derived from the URL git
 * will ACTUALLY write to, never from a second caller-supplied string that is
 * merely asserted to describe it.
 */
export function githubTargetFromUrl(url: string): string | undefined {
  const text = url.trim().replace(/\.git$/, "");
  const https = /^https:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+)$/.exec(text);
  if (https !== null) {
    return `${https[1]}/${https[2]}`;
  }
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+)$/.exec(text);
  if (ssh !== null) {
    return `${ssh[1]}/${ssh[2]}`;
  }
  return undefined;
}

function stateOf(raw: unknown): PullRequestState {
  return raw === "OPEN" ? "OPEN" : raw === "MERGED" ? "MERGED" : "CLOSED";
}

export function createGhCliClient(deps: GhCliDeps): GitHubClient {
  const gh = resolveExecutable("gh", deps.ghPath);

  return {
    async repository(): Promise<RemoteRepository> {
      /**
       * `owner.type` comes from the REST view rather than `gh repo view`,
       * because the distinction between a user and an organisation decides
       * whether organisation-scoped webhooks can exist at all — and that is a
       * financial fact, not a cosmetic one (round-1 CRITICAL 2).
       */
      const raw = await run(deps, gh, [
        "api",
        `repos/${deps.repository}`,
        "--jq",
        "{nameWithOwner: .full_name, visibility: (.visibility | ascii_upcase), defaultBranch: .default_branch, ownerType: .owner.type}",
      ]);
      const row = parseObject(raw, "gh api repos");

      /**
       * Each count is a SEPARATE call allowed to fail softly into `undefined`
       * — which the push verdict treats as unknown, which is financial. Soft
       * here means "we could not establish it", never "there are none": the
       * difference is the whole guard.
       */
      const count = async (path: string, jq: string): Promise<number | undefined> => {
        try {
          return strictCount(await run(deps, gh, ["api", path, "--jq", jq]));
        } catch {
          return undefined;
        }
      };

      return {
        nameWithOwner: requireString(row, "nameWithOwner", "gh api repos"),
        defaultBranch: requireString(row, "defaultBranch", "gh api repos"),
        visibility: visibilityOf(row["visibility"]),
        ownerType: ownerTypeOf(row["ownerType"]),
        repositoryWebhooks: await count(`repos/${deps.repository}/hooks`, "length"),
        // Zero workflows means no Actions run can start, which is what makes
        // runner size — including billable larger runners — unreachable.
        configuredWorkflows: await count(`repos/${deps.repository}/actions/workflows`, ".total_count"),
      };
    },

    async branchSha(branch: string): Promise<string | undefined> {
      try {
        const raw = await run(deps, gh, [
          "api",
          `repos/${deps.repository}/git/ref/heads/${branch}`,
          "--jq",
          ".object.sha",
        ]);
        const sha = raw.trim();
        return isCommitSha(sha) ? sha : undefined;
      } catch {
        // A branch that does not exist is an ANSWER, not a fault.
        return undefined;
      }
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
      if (conclusions.length !== total || statuses.length !== total) {
        /**
         * AGREEMENT IS CHECKED FIRST, before any interpretation (round-1
         * HIGH 4, then round-2 HIGH 4 for the ordering).
         *
         * Round 1: `every([])` is TRUE, so `total: 1` with empty arrays read
         * as SUCCESS. Round 2: the fix sat AFTER the `total === 0` branch, so
         * `total: 0` with a listed conclusion still read as
         * NO_CHECKS_CONFIGURED — a contradictory response producing a
         * confident record of "there are no checks", which is durable evidence
         * that is simply wrong. A response that disagrees with itself is
         * unusable in EVERY direction, so the disagreement is caught before
         * anything is concluded from it.
         */
        conclusion = "FAILURE";
      } else if (total === 0) {
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
    /**
     * The URL git will ACTUALLY PUSH TO — `--push`, not the fetch URL
     * (round-1 CRITICAL 1).
     *
     * `remote.origin.pushurl` overrides the fetch URL for writes, so reading
     * the fetch URL and calling it the push target let a configured pushurl
     * send the write somewhere the gate never observed. This is the value the
     * push target is derived from.
     */
    async pushUrls(): Promise<readonly string[]> {
      /**
       * `--all`, because `git push origin` writes to EVERY configured
       * `pushurl` and `--push` alone reports only the first (round-2
       * CRITICAL 1). Reporting one while git writes to two is how the gate
       * could approve a public repository whose push also reached a private
       * one.
       */
      const raw = await run(deps, git, ["remote", "get-url", "--push", "--all", "origin"]);
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
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
    /**
     * Refreshes remote-tracking refs so `origin/<base>` is not a stale answer
     * (round-1 HIGH 3). `GIT_FETCH` is registered free-but-remote in the
     * effects table; it triggers nothing on the far side.
     */
    async fetch(): Promise<void> {
      await run(deps, git, ["fetch", "origin", "--quiet"]);
    },
    /** True when `ancestor` is reachable from `descendant`. */
    async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
      try {
        await run(deps, git, ["merge-base", "--is-ancestor", ancestor, descendant]);
        return true;
      } catch {
        // A non-zero exit is the ANSWER here ("no"), not a fault — the same
        // documented exception `sf plan status` relies on.
        return false;
      }
    },
    /**
     * Whether pushing `head` would ADD workflow files that the base does not
     * already have.
     *
     * A push carrying `.github/workflows/*` can trigger the very run it
     * introduces, on a runner it chooses — so "the target has no workflows"
     * is not sufficient unless this push keeps it that way.
     */
    async addsWorkflows(baseSha: string, headSha: string): Promise<boolean | undefined> {
      try {
        const changed = await run(deps, git, [
          "diff",
          "--name-only",
          `${baseSha}..${headSha}`,
          "--",
          ".github/workflows",
        ]);
        return changed.trim().length > 0;
      } catch {
        // Unknown, which the gate treats as financial.
        return undefined;
      }
    },
    /**
     * Whether this push would introduce Git LFS tracking (round-2 CRITICAL 2).
     *
     * LFS storage and bandwidth are metered even on public repositories, so a
     * candidate adding `filter=lfs` rules turns the push into billed transfer.
     * Any change to a `.gitattributes` counts: deciding which rules are
     * "really" LFS from a diff is the kind of cleverness that fails open.
     */
    async addsLfs(baseSha: string, headSha: string): Promise<boolean | undefined> {
      try {
        const changed = await run(deps, git, [
          "diff",
          "--name-only",
          `${baseSha}..${headSha}`,
          "--",
          "*.gitattributes",
          ".gitattributes",
        ]);
        return changed.trim().length > 0;
      } catch {
        return undefined;
      }
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
      /**
       * PUSHES TO THE URL, NOT TO `origin` (round-2 CRITICAL 1).
       *
       * `origin` is an indirection resolved by git config AT PUSH TIME, so the
       * gate could observe one destination while the push resolved to another
       * — through a second `pushurl`, or through a config change between the
       * observation and the write. Naming the URL removes the indirection
       * entirely: the destination that was observed is the destination
       * written, with nothing in between that can be reconfigured.
       */
      if (!/^https:\/\/github\.com\//.test(input.url)) {
        throw new Error("pushFastForward requires an https github.com URL");
      }
      await run(deps, git, ["push", input.url, `${input.sha}:refs/heads/${input.branch}`]);
    },
  };
}
