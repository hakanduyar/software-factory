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
  setPullRequest(value: RemotePullRequest | undefined): void;
}

function scripted(options: {
  readonly repository?: Partial<RemoteRepository>;
  readonly pullRequest?: RemotePullRequest;
  readonly local?: { headSha?: string; baseSha?: string; clean?: boolean; remoteUrl?: string };
} = {}): Scripted {
  let pullRequest = options.pullRequest;
  let createCount = 0;
  const pushed: string[] = [];

  const repository: RemoteRepository = {
    nameWithOwner: REPO,
    defaultBranch: "main",
    visibility: "PUBLIC",
    billableIntegrations: 0,
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
       * whatever the branch currently holds, which is what was pushed.
       */
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
      async remoteUrl(): Promise<string> {
        return options.local?.remoteUrl ?? URL;
      },
      async revision(rev): Promise<string | undefined> {
        return rev === "HEAD" ? (options.local?.headSha ?? A) : (options.local?.baseSha ?? BASE);
      },
      async isClean(): Promise<boolean> {
        return options.local?.clean ?? true;
      },
    },
    creates: () => createCount,
    pushes: () => pushed,
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
    expectedRemoteUrl: URL,
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

  it("stops before pushing when the integration count is unknown", async () => {
    const s = scripted({ repository: { billableIntegrations: undefined } });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    assert.deepEqual(s.pushes(), [], "a push happened with an unknown integration count");
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
    ["an unexpected origin", { remoteUrl: "https://github.com/other/other.git" }, /origin/],
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
