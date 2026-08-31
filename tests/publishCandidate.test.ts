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

import { publishCandidate, type PublishDeps } from "../src/github/publishCandidate.js";
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
    ancestor?: boolean | undefined;
    addsWorkflows?: boolean | undefined;
  };
  /** Makes `createPullRequest` throw, as GitHub does for a duplicate. */
  readonly createFails?: boolean;
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
      async pushUrl(): Promise<string> {
        gitCalls.push("pushUrl");
        return options.local?.pushUrl ?? URL;
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

describe("TASK-016 AC-5: publication is idempotent", () => {
  it("publishes a candidate once", async () => {
    const s = scripted();

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "PUBLISHED", `publishing failed: ${JSON.stringify(outcome)}`);
    assert.equal(s.creates(), 1, "the first publish did not create a pull request");
    assert.deepEqual(s.pushes(), [A], "the candidate was not pushed exactly once");
  });

  /**
   * AC-4: the check evidence must reach the caller so it can be RECORDED, and
   * it must arrive bound to the published commit. This repository has no
   * workflows, so the honest value is `NO_CHECKS_CONFIGURED` — which must
   * travel out as itself rather than as an absence.
   */
  it("carries the check evidence out, bound to the published commit", async () => {
    const s = scripted();

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
   * THE CORE OF AC-5. Two runs, one pull request. The second call must ADOPT
   * the first one's PR — and must not push again either, because the remote
   * already holds the candidate.
   */
  it("adopts the existing pull request on a second run and creates no duplicate", async () => {
    const s = scripted();

    const first = await publishCandidate(deps(s), CANDIDATE);
    const second = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(first.kind, "PUBLISHED");
    assert.equal(second.kind, "PUBLISHED", `the second run failed: ${JSON.stringify(second)}`);
    assert.equal(s.creates(), 1, "a second pull request was created for the same candidate");
    assert.equal(second.kind === "PUBLISHED" && second.created, false, "the second run reported a creation");
    assert.deepEqual(s.pushes(), [A], "the candidate was pushed twice");
  });

  /**
   * RESUME AFTER AN INTERRUPTION. A previous attempt created the PR and died
   * before recording it, so this process starts with no memory of it at all.
   * Finding before creating is what makes that safe.
   */
  it("finds a pull request a previous run created before it was recorded", async () => {
    const s = scripted({
      pullRequest: {
        number: 7,
        state: "OPEN",
        headRef: CANDIDATE.headRef,
        headSha: A,
        baseRef: "main",
        baseSha: BASE,
      },
    });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "PUBLISHED");
    assert.equal(s.creates(), 0, "an existing pull request was duplicated after a restart");
    assert.deepEqual(s.pushes(), [], "an already-published candidate was pushed again");
  });

  /**
   * A DIFFERENT CANDIDATE ON THE SAME BRANCH IS NOT THE SAME PUBLICATION. The
   * PR exists but points at another commit, so this run must push — and must
   * still not create a second PR.
   */
  it("pushes but does not duplicate when the existing pull request holds another commit", async () => {
    const s = scripted({
      pullRequest: {
        number: 7,
        state: "OPEN",
        headRef: CANDIDATE.headRef,
        headSha: B,
        baseRef: "main",
        baseSha: BASE,
      },
    });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    // The remote still reports the stale head, so the re-bind refuses — which
    // is correct: the answer describes the remote as it is, not as intended.
    assert.equal(outcome.kind, "REFUSED", `a stale remote head was accepted: ${JSON.stringify(outcome)}`);
    assert.equal(s.creates(), 0, "a duplicate pull request was created");
    assert.deepEqual(s.pushes(), [A], "the candidate was not pushed");
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

describe("TASK-016 round-1 HIGH 5: a lost creation race adopts rather than duplicating", () => {
  /**
   * Find-then-create is not atomic, so two concurrent runs can both find
   * nothing. The serialization point that actually exists is GITHUB: it
   * refuses a second open pull request for the same head and base. So the
   * losing run must ADOPT the winner's pull request instead of failing or
   * duplicating.
   *
   * Modelled by a client whose create throws exactly as GitHub does, with the
   * winner's PR appearing on the re-find.
   */
  it("adopts the pull request that won the race", async () => {
    const s = scripted({ createFails: true });
    // The winner's PR appears only AFTER this run's create attempt fails.
    const client = s.client;
    let attempted = false;
    const racing: GitHubClient = {
      ...client,
      async findPullRequest(headRef: string): Promise<RemotePullRequest | undefined> {
        if (!attempted) return undefined;
        return { number: 9, state: "OPEN", headRef, headSha: A, baseRef: "main", baseSha: BASE };
      },
      async createPullRequest(input) {
        attempted = true;
        return client.createPullRequest(input);
      },
    };

    const outcome = await publishCandidate(deps(s, { github: racing }), CANDIDATE);

    assert.equal(outcome.kind, "PUBLISHED", `the losing run failed instead of adopting: ${JSON.stringify(outcome)}`);
    if (outcome.kind !== "PUBLISHED") return;
    assert.equal(outcome.pullRequest.number, 9, "the losing run did not adopt the winner's pull request");
    assert.equal(outcome.created, false, "the losing run reported creating a pull request");
  });

  /**
   * And a create failure with NO pull request afterwards is a genuine failure,
   * not something to paper over — otherwise the adoption path would swallow
   * every error.
   */
  it("refuses when creation fails and no pull request exists", async () => {
    const s = scripted({ createFails: true });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "REFUSED", "a failed creation was reported as success");
    assert.match(outcome.kind === "REFUSED" ? outcome.reason : "", /creating the pull request failed/);
  });
});

describe("TASK-016 AC-7: publication is not a second engineering loop", () => {
  /**
   * One publication performs at most one push and at most one create, and
   * nothing iterates. A loop would show up here as repeated calls.
   */
  it("performs at most one push and one create per call", async () => {
    const s = scripted();

    await publishCandidate(deps(s), CANDIDATE);

    assert.equal(s.pushes().length, 1);
    assert.equal(s.creates(), 1);
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
