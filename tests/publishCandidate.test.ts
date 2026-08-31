/**
 * TASK-016 AC-5/AC-7: publication is idempotent, gated, and is not a second
 * engineering loop.
 *
 * The client is scripted and COUNTS its calls, because "does not duplicate" is
 * a statement about how many times something happened and cannot be checked any
 * other way. Offline: no gh, no git, no network, no money.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ensurePullRequest, publishCandidate, type PublishDeps } from "../src/github/publishCandidate.js";
import { githubTargetFromUrl } from "../src/adapters/github/ghCliClient.js";
import type {
  RemoteCheckStatus,
  RemotePullRequest,
  RemoteRepository,
  ReviewedCandidate,
} from "../src/github/candidateBinding.js";
import type { GitHubClient, GitPusher, GitRepositoryReader } from "../src/github/githubPorts.js";

const A = "1111111111111111111111111111111111111111";
const B = "2222222222222222222222222222222222222222";
const BASE = "3333333333333333333333333333333333333333";

const REPO = "hakanduyar/software-factory";
const URL = "https://github.com/hakanduyar/software-factory.git";
const ZERO_SPEND = { autonomousSpendAllowed: false, autonomousSpendLimit: 0 };

const CANDIDATE: ReviewedCandidate = {
  roadmapKey: "GITHUB_ORCHESTRATION",
  headSha: A,
  baseSha: BASE,
  baseRef: "main",
  headRef: "feat/executor-wiring",
};

interface Scripted {
  readonly client: GitHubClient;
  readonly pusher: GitPusher;
  readonly git: GitRepositoryReader;
  creates(): number;
  pushes(): readonly string[];
  /** Git calls in order, so "before" can be asserted rather than assumed. */
  gitCalls(): readonly string[];
  setPullRequest(value: RemotePullRequest | undefined): void;
}

function scripted(options: {
  readonly repository?: Partial<RemoteRepository>;
  readonly pullRequest?: RemotePullRequest;
  readonly local?: {
    headSha?: string;
    baseSha?: string;
    clean?: boolean;
    pushUrl?: string;
    /** More than one destination: `git push origin` writes to all of them. */
    pushUrls?: readonly string[];
    ancestor?: boolean | undefined;
    addsWorkflows?: boolean | undefined;
    usesLfs?: boolean | undefined;
    /** What `url.*.insteadOf` would rewrite the push URL to; `null` = unresolvable. */
    effectiveUrl?: string | null;
  };
  /** Makes `createPullRequest` throw, as GitHub does for a duplicate. */
  readonly createFails?: boolean;
  /**
   * What the REMOTE branch holds. `undefined` (the default) means it already
   * holds the candidate, so no push is needed; `null` means the branch does
   * not exist, which is what makes a push necessary.
   */
  readonly remoteBranchSha?: string | null;
} = {}): Scripted {
  let pullRequest = options.pullRequest;
  let createCount = 0;
  const pushed: string[] = [];
  const gitCalls: string[] = [];

  const repository: RemoteRepository = {
    nameWithOwner: REPO,
    defaultBranch: "main",
    visibility: "PUBLIC",
    ownerType: "USER",
    repositoryWebhooks: 0,
    configuredWorkflows: 0,
    ...options.repository,
  };

  const client: GitHubClient = {
    async repository(): Promise<RemoteRepository> {
      return repository;
    },
    async branchSha(): Promise<string | undefined> {
      // Defaults to "the branch already holds the candidate", so the ordinary
      // fixture needs no remote WRITE and the gate has nothing to authorise.
      return options.remoteBranchSha === undefined ? A : (options.remoteBranchSha ?? undefined);
    },
    async findPullRequest(): Promise<RemotePullRequest | undefined> {
      return pullRequest;
    },
    async createPullRequest(input): Promise<RemotePullRequest> {
      createCount += 1;
      /**
       * The scripted client behaves like the real one: a created PR points at
       * whatever the branch currently holds, which is what was pushed. And
       * GitHub REFUSES a second open pull request for the same head/base, so
       * `createFails` models the losing side of a race.
       */
      if (options.createFails === true) {
        throw new Error("A pull request already exists for this head branch");
      }
      pullRequest = {
        number: 7,
        state: "OPEN",
        headRef: input.headRef,
        headSha: pushed[pushed.length - 1] ?? A,
        baseRef: input.baseRef,
        baseSha: BASE,
      };
      return pullRequest;
    },
    async checkStatus(sha): Promise<RemoteCheckStatus> {
      return { sha, conclusion: "NO_CHECKS_CONFIGURED", total: 0 };
    },
  };

  return {
    client,
    pusher: {
      async pushFastForward(input): Promise<void> {
        pushed.push(input.sha);
      },
    },
    git: {
      async pushUrls(): Promise<readonly string[]> {
        gitCalls.push("pushUrls");
        return options.local?.pushUrls ?? [options.local?.pushUrl ?? URL];
      },
      async revision(rev): Promise<string | undefined> {
        gitCalls.push(`revision:${rev}`);
        return rev === "HEAD" ? (options.local?.headSha ?? A) : (options.local?.baseSha ?? BASE);
      },
      async isClean(): Promise<boolean> {
        gitCalls.push("isClean");
        return options.local?.clean ?? true;
      },
      async fetch(): Promise<void> {
        gitCalls.push("fetch");
      },
      async isAncestor(): Promise<boolean> {
        gitCalls.push("isAncestor");
        return options.local?.ancestor ?? true;
      },
      async addsWorkflows(): Promise<boolean | undefined> {
        gitCalls.push("addsWorkflows");
        return options.local?.addsWorkflows ?? false;
      },
      async usesLfs(): Promise<boolean | undefined> {
        gitCalls.push("usesLfs");
        return options.local?.usesLfs ?? false;
      },
      async effectiveUrl(url: string): Promise<string | undefined> {
        gitCalls.push("effectiveUrl");
        return options.local?.effectiveUrl === undefined ? url : (options.local.effectiveUrl ?? undefined);
      },
    },
    creates: () => createCount,
    pushes: () => pushed,
    gitCalls: () => gitCalls,
    setPullRequest: (value) => {
      pullRequest = value;
    },
  };
}

function deps(s: Scripted, overrides: Partial<PublishDeps> = {}): PublishDeps {
  return {
    github: s.client,
    git: s.git,
    pusher: s.pusher,
    expectedRepository: REPO,
    expectedPushUrl: URL,
    // The real derivation, so a test cannot pass by stubbing the very step
    // round-1 CRITICAL 1 was about.
    targetFromUrl: githubTargetFromUrl,
    financialPolicy: ZERO_SPEND,
    ...overrides,
  };
}

/**
 * WHAT A PUBLICATION CAN COMPLETE TODAY, and why.
 *
 * Round-2 review established that a push cannot be demonstrated free while a
 * GitHub App installation is unobservable, so EVERY remote write is refused —
 * both the push and the pull-request creation, which reach GitHub through the
 * same channels and are therefore gated together.
 *
 * A publication that needs NO remote write is unaffected: the branch already
 * holds the candidate (pushed by whatever authorised process put it there) and
 * the pull request already exists. That is the case the fixtures default to,
 * and it is where AC-5's "a second run adopts rather than duplicating" lives.
 */
const EXISTING_PR: RemotePullRequest = {
  number: 7,
  state: "OPEN",
  headRef: "feat/executor-wiring",
  headSha: A,
  baseRef: "main",
  baseSha: BASE,
};

describe("TASK-016 AC-5: publication is idempotent", () => {
  it("completes without writing anything when the remote already holds the candidate", async () => {
    const s = scripted({ pullRequest: EXISTING_PR });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "PUBLISHED", `publishing failed: ${JSON.stringify(outcome)}`);
    if (outcome.kind !== "PUBLISHED") return;
    assert.equal(outcome.created, false);
    assert.equal(outcome.pushed, false);
    assert.equal(s.creates(), 0, "a pull request was created when one already existed");
    assert.deepEqual(s.pushes(), [], "a push happened when the remote already held the candidate");
  });

  /**
   * EVERY REMOTE WRITE IS GATED, and the gate refuses today. Both halves are
   * asserted separately, because "needs a push" and "needs a creation" are
   * independent facts and gating only one of them would be the sibling
   * mistake.
   */
  it("stops at the gate when the branch does not yet hold the candidate", async () => {
    const s = scripted({ remoteBranchSha: null, pullRequest: EXISTING_PR });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "HUMAN_REQUIRED", `a push was performed: ${JSON.stringify(outcome)}`);
    assert.deepEqual(s.pushes(), [], "the gate refused but a push happened anyway");
  });

  it("stops at the gate when a pull request would have to be created", async () => {
    const s = scripted();

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "HUMAN_REQUIRED", `a pull request was created: ${JSON.stringify(outcome)}`);
    assert.equal(s.creates(), 0, "the gate refused but a pull request was created anyway");
    assert.deepEqual(s.pushes(), []);
  });

  /**
   * AC-4: the check evidence must reach the caller so it can be RECORDED, and
   * it must arrive bound to the published commit. This repository has no
   * workflows, so the honest value is `NO_CHECKS_CONFIGURED` — which must
   * travel out as itself rather than as an absence.
   */
  it("carries the check evidence out, bound to the published commit", async () => {
    const s = scripted({ pullRequest: EXISTING_PR });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "PUBLISHED");
    if (outcome.kind !== "PUBLISHED") return;
    assert.equal(outcome.checks?.sha, A, "the check evidence is not bound to the published commit");
    assert.equal(
      outcome.checks?.conclusion,
      "NO_CHECKS_CONFIGURED",
      "the absence of checks did not survive out of publication as its own fact",
    );
  });

  /**
   * THE CORE OF AC-5. Two runs, one pull request, and no remote write on
   * either — the second call adopts what the first found rather than
   * duplicating it.
   */
  it("adopts the existing pull request on a second run and creates no duplicate", async () => {
    const s = scripted({ pullRequest: EXISTING_PR });

    const first = await publishCandidate(deps(s), CANDIDATE);
    const second = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(first.kind, "PUBLISHED");
    assert.equal(second.kind, "PUBLISHED", `the second run failed: ${JSON.stringify(second)}`);
    assert.equal(s.creates(), 0, "a pull request was created for a candidate that already had one");
    assert.equal(second.kind === "PUBLISHED" && second.created, false, "the second run reported a creation");
    assert.deepEqual(s.pushes(), [], "a push happened on a repeat run");
  });

  /**
   * RESUME AFTER AN INTERRUPTION. A previous attempt created the PR and died
   * before recording it, so this process starts with no memory of it at all.
   * Finding before creating is what makes that safe.
   */
  it("finds a pull request a previous run created before it was recorded", async () => {
    const s = scripted({ pullRequest: EXISTING_PR });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "PUBLISHED");
    assert.equal(s.creates(), 0, "an existing pull request was duplicated after a restart");
    assert.deepEqual(s.pushes(), [], "an already-published candidate was pushed again");
  });

  /**
   * A DIFFERENT CANDIDATE ON THE SAME BRANCH IS NOT THE SAME PUBLICATION. The
   * PR exists but points at another commit, so a push WOULD be needed — and
   * the gate stops it, without any duplicate being created on the way.
   */
  it("stops at the gate when the existing pull request holds another commit", async () => {
    const s = scripted({
      remoteBranchSha: B,
      pullRequest: { ...EXISTING_PR, headSha: B },
    });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "HUMAN_REQUIRED", `a stale remote head was written: ${JSON.stringify(outcome)}`);
    assert.equal(s.creates(), 0, "a duplicate pull request was created");
    assert.deepEqual(s.pushes(), [], "the gate refused but a push happened anyway");
  });
});

describe("TASK-016 round-3 HIGH 4: each observed fact reaches the report", () => {
  /**
   * THE VACUITY THE REVIEWER FOUND. Every push refuses, so a test asserting
   * `HUMAN_REQUIRED` passes no matter what the orchestration observed —
   * replacing `visibility: repository.visibility` with a hard-coded `"PUBLIC"`
   * left all 27 cases green. What must be pinned is the WIRING: each fact the
   * client reports has to arrive in the report the human reads.
   *
   * Asserted on the refusal's own text, which carries the action detail, so a
   * hard-coded value shows up as the wrong word.
   */
  const wiring = [
    ["visibility", { repository: { visibility: "PRIVATE" as const } }, /visibility PRIVATE/],
    ["owner type", { repository: { ownerType: "ORGANIZATION" as const } }, /owner ORGANIZATION/],
    ["webhook count", { repository: { repositoryWebhooks: 3 } }, /webhooks 3/],
    ["workflow count", { repository: { configuredWorkflows: 2 } }, /workflows 2/],
    ["introduced workflows", { local: { addsWorkflows: true } }, /candidate adds workflows true/],
    ["LFS tracking", { local: { usesLfs: true } }, /candidate uses LFS true/],
  ] as const;

  for (const [label, options, pattern] of wiring) {
    it(`carries the observed ${label} into the refusal a human reads`, async () => {
      const s = scripted(options);

      const outcome = await publishCandidate(deps(s), CANDIDATE);

      assert.equal(outcome.kind, "HUMAN_REQUIRED", `expected a gated refusal: ${JSON.stringify(outcome)}`);
      assert.match(
        outcome.kind === "HUMAN_REQUIRED" ? outcome.reason : "",
        pattern,
        `the observed ${label} did not reach the report`,
      );
    });
  }

  /** And the target itself, so the human knows which repository is meant. */
  it("names the derived target in the refusal", async () => {
    const s = scripted();

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.match(outcome.kind === "HUMAN_REQUIRED" ? outcome.reason : "", new RegExp(REPO));
  });
});

describe("TASK-016 round-3 HIGH 1: a rewritten push URL is refused", () => {
  /**
   * `url.*.insteadOf` rewrites a URL at the moment of use, so naming one
   * explicitly was not enough — the reviewer demonstrated an observed
   * `safe/actual` being contacted as `other/actual`. A rewrite in play means
   * the destination observed is not the destination written, so it refuses.
   */
  it("refuses when git rewrites the push URL to somewhere else", async () => {
    const s = scripted({ local: { effectiveUrl: "https://github.com/other/actual.git" } });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "REFUSED", `a rewritten destination was accepted: ${JSON.stringify(outcome)}`);
    assert.match(outcome.kind === "REFUSED" ? outcome.reason : "", /rewrites the push URL/);
    assert.deepEqual(s.pushes(), [], "a push reached a rewritten destination");
  });

  it("refuses when the effective push URL cannot be resolved", async () => {
    const s = scripted({ local: { effectiveUrl: null } });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "REFUSED");
    assert.match(outcome.kind === "REFUSED" ? outcome.reason : "", /could not be resolved/);
  });

  /** The control: an unrewritten URL still publishes. */
  it("permits a push URL that git does not rewrite", async () => {
    const s = scripted({ pullRequest: EXISTING_PR, local: { effectiveUrl: URL } });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "PUBLISHED", `an unrewritten URL was refused: ${JSON.stringify(outcome)}`);
  });
});

describe("TASK-016 AC-1: publication goes through the financial gate", () => {
  /**
   * A PRIVATE repository must stop the whole publication BEFORE the push, and
   * the outcome must carry the action so the caller escalates the same object
   * the gate judged.
   */
  it("stops before pushing when the target is private", async () => {
    const s = scripted({ repository: { visibility: "PRIVATE" } });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "HUMAN_REQUIRED", `a private target was published: ${JSON.stringify(outcome)}`);
    assert.deepEqual(s.pushes(), [], "a push happened despite the gate refusing");
    assert.equal(s.creates(), 0, "a pull request was created despite the gate refusing");
    assert.equal(outcome.kind === "HUMAN_REQUIRED" ? outcome.action.kind : "", "GIT_PUSH");
    assert.match(outcome.kind === "HUMAN_REQUIRED" ? outcome.reason : "", new RegExp(REPO));
  });

  it("stops before pushing when the webhook count is unknown", async () => {
    const s = scripted({ repository: { repositoryWebhooks: undefined } });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    assert.deepEqual(s.pushes(), [], "a push happened with an unknown webhook count");
  });

  /**
   * Round-1 CRITICAL 2, at the orchestration level: a workflow on the target
   * means an Actions run can start, and a larger runner would bill it even on
   * a public repository.
   */
  it("stops before pushing when the target has a configured workflow", async () => {
    const s = scripted({ repository: { configuredWorkflows: 1 } });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    assert.deepEqual(s.pushes(), [], "a push happened into a repository that can run Actions");
  });

  /** And the push must not be the thing that CREATES that possibility. */
  it("stops before pushing when the candidate introduces a workflow", async () => {
    const s = scripted({ local: { addsWorkflows: true } });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "HUMAN_REQUIRED", "a push carrying a workflow was permitted");
    assert.deepEqual(s.pushes(), [], "a workflow-introducing push happened");
  });

  /**
   * AND AN UNTRUSTED POLICY STOPS IT TOO. The target is perfectly unmetered
   * here, so only the policy can produce the refusal.
   */
  it("stops before pushing when the stored policy claims spend authority", async () => {
    const s = scripted();

    const outcome = await publishCandidate(
      deps(s, { financialPolicy: { autonomousSpendAllowed: true, autonomousSpendLimit: 10 } }),
      CANDIDATE,
    );

    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    assert.deepEqual(s.pushes(), [], "a push proceeded under an untrusted policy");
  });
});

describe("TASK-016 AC-8: publication refuses before it acts", () => {
  for (const [label, local, pattern] of [
    ["a dirty tree", { clean: false }, /not clean/],
    ["a different HEAD", { headSha: B }, /reviewed candidate is/],
    ["a candidate that does not descend from its base", { ancestor: false }, /not an ancestor/],
    ["an unexpected push url", { pushUrl: "https://github.com/other/other.git" }, /expects/],
  ] as const) {
    it(`refuses ${label} without pushing or creating anything`, async () => {
      const s = scripted({ local });

      const outcome = await publishCandidate(deps(s), CANDIDATE);

      assert.equal(outcome.kind, "REFUSED", `${label} was published`);
      assert.match(outcome.kind === "REFUSED" ? outcome.reason : "", pattern);
      assert.deepEqual(s.pushes(), [], "a refused publication still pushed");
      assert.equal(s.creates(), 0, "a refused publication still created a pull request");
    });
  }

  it("refuses when the remote is a different repository", async () => {
    const s = scripted({ repository: { nameWithOwner: "someone-else/other" } });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "REFUSED");
    assert.deepEqual(s.pushes(), [], "a push targeted an unexpected repository");
  });
});

describe("TASK-016 round-1 HIGH 3: the base is refreshed before it is trusted", () => {
  /**
   * `origin/<base>` is a LOCAL CACHE. Deciding that the base has not moved by
   * consulting a stale copy of it is not a check — the reviewer's point — so
   * the fetch must happen BEFORE the read, which is a statement about order
   * and can only be tested by recording order.
   */
  it("fetches before reading the base", async () => {
    const s = scripted();

    await publishCandidate(deps(s), CANDIDATE);

    const calls = s.gitCalls();
    const fetched = calls.indexOf("fetch");
    const readBase = calls.indexOf(`revision:origin/${CANDIDATE.baseRef}`);
    assert.notEqual(fetched, -1, "the base was never refreshed");
    assert.notEqual(readBase, -1, "the base was never read");
    assert.ok(fetched < readBase, `the base was read before it was refreshed: ${calls.join(", ")}`);
  });
});

describe("TASK-016 round-1 CRITICAL 1: the verdict binds to where the push will actually go", () => {
  /**
   * THE REPRODUCTION. `--repo` and `--remote-url` were independent caller
   * inputs, so a URL for one repository could be paired with the NAME of
   * another: the gate would observe `owner/safe` (public, unmetered) while git
   * wrote to `other/actual`. The target is now DERIVED from the push URL, so
   * the pairing cannot be asserted.
   *
   * Everything else here is impeccable — clean tree, right commits, a public
   * unmetered observation — so only the derivation can refuse.
   */
  it("refuses when the push url names a different repository than --repo", async () => {
    const s = scripted({ local: { pushUrl: "https://github.com/other/actual.git" } });

    const outcome = await publishCandidate(
      deps(s, { expectedPushUrl: "https://github.com/other/actual.git" }),
      CANDIDATE,
    );

    assert.equal(outcome.kind, "REFUSED", `a diverted push was permitted: ${JSON.stringify(outcome)}`);
    assert.match(outcome.kind === "REFUSED" ? outcome.reason : "", /other\/actual/);
    assert.deepEqual(s.pushes(), [], "a push went to a repository the gate never observed");
  });

  /**
   * A `remote.origin.pushurl` produces exactly the same divergence even when
   * the fetch URL is right — which is why the reader reports `--push`.
   */
  it("refuses when the observed repository is not the push target", async () => {
    const s = scripted({
      local: { pushUrl: "https://github.com/other/actual.git" },
      repository: { nameWithOwner: REPO },
    });

    const outcome = await publishCandidate(
      deps(s, { expectedRepository: "other/actual", expectedPushUrl: "https://github.com/other/actual.git" }),
      CANDIDATE,
    );

    assert.equal(outcome.kind, "REFUSED");
    assert.match(outcome.kind === "REFUSED" ? outcome.reason : "", /observed repository/);
    assert.deepEqual(s.pushes(), [], "a push went to an unobserved repository");
  });

  /**
   * ROUND-2 REVIEW, CRITICAL 1. `git push origin` writes to EVERY configured
   * `pushurl`, and reading only the first let the gate approve a public
   * repository whose push also reached a private one. More than one
   * destination means there is no single thing to observe, so there is nothing
   * to authorise.
   */
  it("refuses when origin has more than one push destination", async () => {
    const s = scripted({
      local: { pushUrls: [URL, "https://github.com/other/private.git"] },
    });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "REFUSED", `a multi-destination push was allowed: ${JSON.stringify(outcome)}`);
    assert.match(outcome.kind === "REFUSED" ? outcome.reason : "", /more than one destination/);
    assert.deepEqual(s.pushes(), [], "a push reached an unobserved destination");
  });

  it("refuses when origin has no push destination at all", async () => {
    const s = scripted({ local: { pushUrls: [] } });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "REFUSED");
    assert.match(outcome.kind === "REFUSED" ? outcome.reason : "", /no push URL/);
  });

  it("refuses a push url that is not a GitHub repository at all", async () => {
    const s = scripted({ local: { pushUrl: "https://gitlab.com/someone/thing.git" } });

    const outcome = await publishCandidate(
      deps(s, { expectedPushUrl: "https://gitlab.com/someone/thing.git" }),
      CANDIDATE,
    );

    assert.equal(outcome.kind, "REFUSED");
    assert.match(outcome.kind === "REFUSED" ? outcome.reason : "", /not a GitHub repository URL/);
    assert.deepEqual(s.pushes(), []);
  });
});

describe("TASK-016 AC-5 (round-3 HIGH 3): the create/adopt behaviour, demonstrated directly", () => {
  /**
   * The frozen AC-5 describes create-or-adopt behaviour that `publishCandidate`
   * can no longer reach, because the gate refuses every remote write first. The
   * reviewer's instruction was to keep the behaviour and prove it through a
   * separately testable seam rather than delete it — so these cases drive
   * `ensurePullRequest` directly. Nothing about the production gate is
   * weakened: publication still refuses before reaching this code.
   */
  it("creates a pull request when none exists", async () => {
    const s = scripted();

    const result = await ensurePullRequest(s.client, CANDIDATE);

    assert.equal(result.ok, true, `creation failed: ${JSON.stringify(result)}`);
    if (!result.ok) return;
    assert.equal(result.created, true, "an existing pull request was reported");
    assert.equal(s.creates(), 1, "the pull request was not created exactly once");
  });

  it("adopts an existing pull request instead of creating a second", async () => {
    const s = scripted({ pullRequest: EXISTING_PR });

    const result = await ensurePullRequest(s.client, CANDIDATE);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.created, false, "an existing pull request was duplicated");
    assert.equal(result.pullRequest.number, EXISTING_PR.number);
    assert.equal(s.creates(), 0);
  });

  /**
   * TWO RUNS, ONE PULL REQUEST. The second call finds what the first created,
   * which is the resume-after-interruption case: a previous attempt may have
   * created the pull request and died before recording it.
   */
  it("creates once across two runs", async () => {
    const s = scripted();

    const first = await ensurePullRequest(s.client, CANDIDATE);
    const second = await ensurePullRequest(s.client, CANDIDATE);

    assert.equal(first.ok && first.created, true, "the first run did not create");
    assert.equal(second.ok && second.created, false, "the second run created a duplicate");
    assert.equal(s.creates(), 1, "more than one pull request was created for one candidate");
  });

  /**
   * THE LOST RACE. GitHub refuses a second open pull request for the same head
   * and base, so the losing run must ADOPT the winner's rather than failing.
   */
  it("adopts the pull request that won a creation race", async () => {
    const s = scripted({ createFails: true });
    let attempted = false;
    const racing: GitHubClient = {
      ...s.client,
      async findPullRequest(headRef: string): Promise<RemotePullRequest | undefined> {
        // The winner's pull request becomes visible only after this run's
        // creation attempt has failed.
        return attempted
          ? { number: 9, state: "OPEN", headRef, headSha: A, baseRef: "main", baseSha: BASE }
          : undefined;
      },
      async createPullRequest(input) {
        attempted = true;
        return s.client.createPullRequest(input);
      },
    };

    const result = await ensurePullRequest(racing, CANDIDATE);

    assert.equal(result.ok, true, `the losing run failed instead of adopting: ${JSON.stringify(result)}`);
    if (!result.ok) return;
    assert.equal(result.pullRequest.number, 9, "the winner's pull request was not adopted");
    assert.equal(result.created, false, "the losing run reported creating a pull request");
  });

  /** Adoption must not swallow a genuine failure. */
  it("fails when creation fails and no pull request appears", async () => {
    const s = scripted({ createFails: true });

    const result = await ensurePullRequest(s.client, CANDIDATE);

    assert.equal(result.ok, false, "a failed creation was reported as success");
    assert.match(result.ok === false ? result.reason : "", /creating the pull request failed/);
  });
});

describe("TASK-016 round-1 HIGH 5: a creation race cannot even begin", () => {
  /**
   * Round 1 asked for the losing side of a creation race to ADOPT the winner's
   * pull request rather than duplicating it, and that logic is in place: a
   * failed creation is followed by a re-find, and an existing pull request is
   * taken. GitHub is the serialization point, since it refuses a second open
   * pull request for the same head and base.
   *
   * Round 2 then established that every remote write is refused, so the race
   * is currently unreachable: the gate stops both runs before either attempts
   * a creation. THAT is what these cases pin — the ordering, which is the
   * property that makes the race impossible rather than merely survivable.
   * The adoption branch is retained for when the gate can permit a write, and
   * the round-3 prompt asks the reviewer whether to keep or remove it.
   */
  it("refuses before any creation is attempted", async () => {
    const s = scripted({ createFails: true });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "HUMAN_REQUIRED", `a creation was attempted: ${JSON.stringify(outcome)}`);
    assert.equal(s.creates(), 0, "the gate refused but a creation was attempted anyway");
  });

  /** Two concurrent runs both stop at the gate, so neither can duplicate. */
  it("stops both sides of a concurrent publication", async () => {
    const s = scripted();

    const [first, second] = await Promise.all([
      publishCandidate(deps(s), CANDIDATE),
      publishCandidate(deps(s), CANDIDATE),
    ]);

    assert.equal(first.kind, "HUMAN_REQUIRED");
    assert.equal(second.kind, "HUMAN_REQUIRED");
    assert.equal(s.creates(), 0, "a concurrent run created a pull request");
    assert.deepEqual(s.pushes(), [], "a concurrent run pushed");
  });
});

describe("TASK-016 AC-7: publication is not a second engineering loop", () => {
  /**
   * One publication performs at most one push and at most one create, and
   * nothing iterates. A loop would show up here as repeated calls — so the
   * no-write case, which is the one that runs to completion, must show none.
   */
  it("performs no repeated remote calls in a completed publication", async () => {
    const s = scripted({ pullRequest: EXISTING_PR });

    await publishCandidate(deps(s), CANDIDATE);

    assert.equal(s.pushes().length, 0);
    assert.equal(s.creates(), 0);
  });

  /**
   * The module surface itself carries no implement/verify/review capability
   * and no approval capability. Asserted structurally, because the strongest
   * form of "it cannot do X" is that there is no X to call.
   */
  it("exposes no approval, merge or verification capability", async () => {
    const module = await import("../src/github/publishCandidate.js");
    const ports = await import("../src/github/githubPorts.js");

    const names = [...Object.keys(module), ...Object.keys(ports)].join(" ").toLowerCase();
    for (const forbidden of ["approve", "merge", "verify", "review", "implement"]) {
      assert.ok(!names.includes(forbidden), `the publication surface exposes ${forbidden}`);
    }
  });
});
