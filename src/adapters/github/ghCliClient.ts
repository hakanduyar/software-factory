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
import type { GitHubClient, GitRepositoryReader } from "../../github/githubPorts.js";
import { isRemoteWriteAuthorized } from "../../supervision/financialSafety.js";
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
/**
 * How many pull requests one listing may report. A page that comes back FULL is
 * treated as possibly truncated and refused — see `listPullRequests` — so this
 * is a threshold for "ask a human", not a silent cap.
 */
const PULL_REQUEST_PAGE = 100;

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

    async listPullRequests(headRef: string): Promise<readonly RemotePullRequest[]> {
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
        String(PULL_REQUEST_PAGE),
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
      /**
       * A FULL PAGE MEANS "THERE MAY BE MORE", WHICH IS UNKNOWN, WHICH FAILS
       * CLOSED (round-8 review, finding 2).
       *
       * The port promises every pull request the remote reports, and the
       * adapter was asking for at most ten. An eleventh could hold the second
       * binding pull request, so a genuinely AMBIGUOUS remote state arrived
       * looking unambiguous and was adopted. Raising the limit alone would
       * only move the number at which that happens; what closes it is
       * refusing to answer when the answer might be incomplete.
       */
      if (parsed.length >= PULL_REQUEST_PAGE) {
        throw new Error(
          `gh pr list returned ${parsed.length} pull requests for ${JSON.stringify(headRef)}, which is the page limit; the listing may be incomplete and an incomplete listing cannot establish that exactly one pull request matches`,
        );
      }
      /**
       * EVERY entry is parsed and returned. The adapter no longer chooses:
       * it used to throw when more than one was open and silently take
       * `parsed[0]` when none were, which is arbitrary selection wearing a
       * different hat. `selectAdoptablePullRequest` decides, and refuses
       * ambiguity rather than resolving it.
       *
       * Parsing stays STRICT — a malformed entry throws rather than being
       * skipped, because dropping an unreadable pull request from the list is
       * how a listing of two becomes an unambiguous listing of one.
       */
      return parsed.map((entry) => {
        if (typeof entry !== "object" || entry === null) {
          throw new Error("gh pr list returned an entry that is not an object");
        }
        const record = entry as Record<string, unknown>;
        const number = record["number"];
        if (typeof number !== "number" || !Number.isSafeInteger(number)) {
          throw new Error("gh pr list did not report a usable pull request number");
        }
        return {
          number,
          state: stateOf(record["state"]),
          headRef: requireString(record, "headRefName", "gh pr list"),
          headSha: requireSha(record, "headRefOid", "gh pr list"),
          baseRef: requireString(record, "baseRefName", "gh pr list"),
          baseSha: requireSha(record, "baseRefOid", "gh pr list"),
        };
      });
    },

    async createPullRequest(input, authorization): Promise<RemotePullRequest> {
      /**
       * REFUSED WITHOUT PROOF (round-6 review, finding 1). The check is here,
       * at the point of the write, because that is the only place no caller
       * can route around — a guard in the orchestrator protects the
       * orchestrator, not the capability.
       */
      /**
       * THE TARGET IS THIS CLIENT'S OWN, NOT THE TOKEN'S (round-7 HIGH 2).
       *
       * Stated as its own comparison with its own message, and that is a
       * deliberate redundancy: `isRemoteWriteAuthorized` below already refuses
       * a target mismatch, so deleting these four lines changes not WHETHER a
       * mismatched token is refused but only WHY.
       *
       * It earns its place by being OBSERVABLE. Asking the token where it may
       * be spent — `isRemoteWriteAuthorized(auth, kind, auth.target)` — is the
       * whole of the round-7 finding, and it is a mutation that no test could
       * catch through the combined check alone, because a genuine
       * CREATE_PULL_REQUEST token cannot be minted (the App channel never
       * closes) and every obtainable token fails on KIND first. Splitting the
       * comparison out is what makes "the adapter names its own repository"
       * a fact a test can hold, rather than a line a reader must trust.
       */
      const claimed = (authorization as { readonly target?: unknown } | undefined)?.target;
      if (claimed !== deps.repository) {
        throw new Error(
          `the authorization names target ${JSON.stringify(String(claimed))} but this client writes to ${deps.repository}; authorizeRemoteWrite must issue for the repository being written`,
        );
      }
      if (!isRemoteWriteAuthorized(authorization, "CREATE_PULL_REQUEST", deps.repository)) {
        throw new Error(
          `createPullRequest requires an authorization minted by authorizeRemoteWrite for CREATE_PULL_REQUEST on ${deps.repository}`,
        );
      }
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
      const created = await this.listPullRequests(input.headRef);
      if (created.length !== 1) {
        throw new Error(
          `the pull request for ${input.headRef} could not be read back unambiguously after creation (${created.length} reported)`,
        );
      }
      return created[0]!;
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
     * Where `origin` actually points (AC-8).
     *
     * `get-url` reports the FETCH url, which is the one `git fetch` uses and so
     * the one that decides what `origin/<base>` contains — the fact this check
     * is about. An unparseable or absent remote yields `undefined`, which the
     * core treats as a refusal rather than as permission.
     */
    async originTarget(): Promise<string | undefined> {
      try {
        /**
         * `ls-remote --get-url` IS THE URL-REWRITE CONTROL (round-8 review,
         * finding 3), restored on the side that still exists.
         *
         * Rounds 2-4 established that naming a URL is not knowing where git
         * goes: `url.*.insteadOf` rewrites it at the moment of use. The push
         * those rounds were about is gone, but `git fetch origin` is not, and
         * a rewritten origin means `origin/<base>` came from somewhere else.
         *
         * `ls-remote --get-url` prints what git will really contact, applying
         * those rewrites, and contacts nothing itself. `remote get-url`
         * happens to expand `insteadOf` too on current git — but "happens to"
         * is not a control, and this is the primitive whose documented job is
         * exactly this question.
         */
        const url = (await run(deps, git, ["ls-remote", "--get-url", "origin"])).trim();
        return githubTargetFromUrl(url);
      } catch {
        return undefined;
      }
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
     * Whether the candidate tracks ANY content through Git LFS (round-2
     * CRITICAL 2, restored after the round-8 review).
     *
     * LFS storage and bandwidth are metered even on public repositories. The
     * push this originally guarded is gone, so it no longer decides a push —
     * it feeds the liability channel a human reads, where omitting a metered
     * mechanism entirely would be the dishonest option.
     *
     * ANY tracking at the candidate, not a CHANGE to it (round-3 HIGH 2): the
     * first version compared `.gitattributes` between base and head and missed
     * the ordinary case where the base already tracks `*.bin`, the candidate
     * adds `new.bin`, and `.gitattributes` is untouched. `git grep` against a
     * commit reads the tree, so no checkout is involved.
     */
    async usesLfs(headSha: string): Promise<boolean | undefined> {
      try {
        const matches = await run(deps, git, [
          "grep",
          "-I",
          "-l",
          "filter=lfs",
          headSha,
          "--",
          ".gitattributes",
          "*.gitattributes",
        ]);
        return matches.trim().length > 0;
      } catch (error) {
        /**
         * `git grep` exits 1 for "no matches", which is an ANSWER, and
         * anything else is genuinely unknown. Distinguished by the message the
         * runner builds, because a bare catch would report "no LFS" for a
         * repository it could not read — failing open on a metered channel.
         */
        return /exit 1\b/.test(error instanceof Error ? error.message : "") ? false : undefined;
      }
    },
  };
}
