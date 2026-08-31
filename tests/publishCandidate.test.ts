/**
 * TASK-016 AC-5/AC-7: publication is idempotent, gated, and is not a second
 * engineering loop.
 *
 * WHAT PUBLICATION IS, AFTER FOUR REVIEW ROUNDS. It does not push. Three rounds
 * each found a new way for git to write somewhere other than the destination
 * this process observed (`remote.pushurl`, `url.*.insteadOf`,
 * `url.*.pushInsteadOf` and redirects), all resolved at push time — so instead
 * of PREDICTING where a write lands, publication VERIFIES that the remote
 * already holds the exact candidate. Getting the branch there is the repository
 * agent's job under ADR-0002.
 *
 * The one remote write left is creating the pull request, and the financial
 * gate refuses it while a GitHub App installation remains unobservable. So a
 * publication completes only when nothing must be written — which is exactly
 * where AC-5's "a second run adopts rather than duplicating" lives.
 *
 * The client is scripted and COUNTS its calls, because "does not duplicate" is
 * a statement about how many times something happened and cannot be checked any
 * other way. Offline: no gh, no git, no network, no money.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ensurePullRequest, publishCandidate, type PublishDeps } from "../src/github/publishCandidate.js";
import type {
  RemoteCheckStatus,
  RemotePullRequest,
  RemoteRepository,
  ReviewedCandidate,
} from "../src/github/candidateBinding.js";
import type { GitHubClient, GitRepositoryReader } from "../src/github/githubPorts.js";

const A = "1111111111111111111111111111111111111111";
const B = "2222222222222222222222222222222222222222";
const BASE = "3333333333333333333333333333333333333333";

const REPO = "hakanduyar/software-factory";
const ZERO_SPEND = { autonomousSpendAllowed: false, autonomousSpendLimit: 0 };

const CANDIDATE: ReviewedCandidate = {
  roadmapKey: "GITHUB_ORCHESTRATION",
  headSha: A,
  baseSha: BASE,
  baseRef: "main",
  headRef: "feat/executor-wiring",
};

const EXISTING_PR: RemotePullRequest = {
  number: 7,
  state: "OPEN",
  headRef: CANDIDATE.headRef,
  headSha: A,
  baseRef: "main",
  baseSha: BASE,
};

interface Scripted {
  readonly client: GitHubClient;
  readonly git: GitRepositoryReader;
  creates(): number;
  finds(): number;
  gitCalls(): readonly string[];
}

function scripted(options: {
  readonly repository?: Partial<RemoteRepository>;
  readonly pullRequest?: RemotePullRequest;
  /** Answers `findPullRequest` in order; the last value repeats. */
  readonly pullRequests?: readonly (RemotePullRequest | undefined)[];
  readonly local?: {
    headSha?: string;
    baseSha?: string;
    clean?: boolean;
    ancestor?: boolean | undefined;
    addsWorkflows?: boolean | undefined;
  };
  /** Makes `createPullRequest` throw, as GitHub does for a duplicate. */
  readonly createFails?: boolean;
  /**
   * What the REMOTE branch holds. `undefined` (the default) means it already
   * holds the candidate, so nothing must be written; `null` means the branch
   * does not exist at all.
   */
  readonly remoteBranchSha?: string | null;
} = {}): Scripted {
  let pullRequest = options.pullRequest;
  const queue = options.pullRequests === undefined ? undefined : [...options.pullRequests];
  let createCount = 0;
  let findCount = 0;
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
      return options.remoteBranchSha === undefined ? A : (options.remoteBranchSha ?? undefined);
    },
    async findPullRequest(): Promise<RemotePullRequest | undefined> {
      findCount += 1;
      if (queue !== undefined) {
        return queue.length > 1 ? queue.shift() : queue[0];
      }
      return pullRequest;
    },
    async createPullRequest(input): Promise<RemotePullRequest> {
      createCount += 1;
      // GitHub REFUSES a second open pull request for one head/base, so
      // `createFails` models the losing side of a race.
      if (options.createFails === true) {
        throw new Error("A pull request already exists for this head branch");
      }
      pullRequest = {
        number: 7,
        state: "OPEN",
        headRef: input.headRef,
        headSha: A,
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
    git: {
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
    finds: () => findCount,
    gitCalls: () => gitCalls,
  };
}

function deps(s: Scripted, overrides: Partial<PublishDeps> = {}): PublishDeps {
  return {
    github: s.client,
    git: s.git,
    expectedRepository: REPO,
    financialPolicy: ZERO_SPEND,
    ...overrides,
  };
}

describe("TASK-016 AC-5: publication is idempotent", () => {
  it("completes without writing anything when the remote already holds the candidate", async () => {
    const s = scripted({ pullRequest: EXISTING_PR });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "PUBLISHED", `publishing failed: ${JSON.stringify(outcome)}`);
    if (outcome.kind !== "PUBLISHED") return;
    assert.equal(outcome.created, false, "a creation was reported when nothing was created");
    assert.equal(s.creates(), 0, "a pull request was created when one already existed");
  });

  it("adopts the existing pull request on a second run and creates no duplicate", async () => {
    const s = scripted({ pullRequest: EXISTING_PR });

    const first = await publishCandidate(deps(s), CANDIDATE);
    const second = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(first.kind, "PUBLISHED");
    assert.equal(second.kind, "PUBLISHED", `the second run failed: ${JSON.stringify(second)}`);
    assert.equal(s.creates(), 0, "a pull request was created for a candidate that already had one");
  });

  /**
   * AC-4: the check evidence must reach the caller so it can be RECORDED, and
   * must arrive bound to the published commit. This repository has no
   * workflows, so the honest value travels out as itself.
   */
  it("carries the check evidence out, bound to the published commit", async () => {
    const s = scripted({ pullRequest: EXISTING_PR });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "PUBLISHED");
    if (outcome.kind !== "PUBLISHED") return;
    assert.equal(outcome.checks?.sha, A, "the check evidence is not bound to the published commit");
    assert.equal(outcome.checks?.conclusion, "NO_CHECKS_CONFIGURED");
  });
});

describe("TASK-016 round-4 finding 3: the rebind re-reads rather than trusting a snapshot", () => {
  /**
   * THE REPRODUCTION. The pull request was read once BEFORE the gate and that
   * snapshot was then used as the answer, so a remote whose head moved in
   * between was reported at the commit it used to hold — one find call, remote
   * head B, outcome PUBLISHED reporting A.
   *
   * A snapshot older than the action cannot describe the action, so the answer
   * comes from asking again. Here the second read reports B, which must be
   * REFUSED rather than published as A.
   */
  it("refuses when the pull request moved after the first read", async () => {
    const s = scripted({
      pullRequests: [EXISTING_PR, { ...EXISTING_PR, headSha: B }],
    });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "REFUSED", `a stale snapshot was published: ${JSON.stringify(outcome)}`);
    assert.ok(s.finds() >= 2, `the remote was read only ${s.finds()} time(s); the rebind reused a snapshot`);
  });

  it("reports the pull request as the re-read describes it", async () => {
    const s = scripted({ pullRequests: [EXISTING_PR, { ...EXISTING_PR, number: 12 }] });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "PUBLISHED", JSON.stringify(outcome));
    if (outcome.kind !== "PUBLISHED") return;
    assert.equal(outcome.pullRequest.number, 12, "the returned pull request came from the stale snapshot");
  });
});

describe("TASK-016: publication verifies the remote rather than pushing to it", () => {
  /**
   * Round-4 finding 1 removed the push entirely, because three rounds could not
   * bind its destination. What replaces it is verification: the branch on the
   * remote must ALREADY be the reviewed commit.
   */
  it("refuses when the branch does not exist on the remote", async () => {
    const s = scripted({ remoteBranchSha: null });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "REFUSED", `a missing branch was published: ${JSON.stringify(outcome)}`);
    assert.match(outcome.kind === "REFUSED" ? outcome.reason : "", /does not exist/);
    assert.equal(s.creates(), 0);
  });

  it("refuses when the branch holds a different commit", async () => {
    const s = scripted({ remoteBranchSha: B });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "REFUSED");
    assert.match(outcome.kind === "REFUSED" ? outcome.reason : "", /publication does not push/);
    assert.equal(s.creates(), 0);
  });

  it("refuses when the remote is a different repository", async () => {
    const s = scripted({ repository: { nameWithOwner: "someone-else/other" } });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "REFUSED");
    assert.match(outcome.kind === "REFUSED" ? outcome.reason : "", /expects/);
    assert.equal(s.creates(), 0);
  });

  /**
   * ROUND-4 SURVIVOR. Hard-coding `defaultBranch: "main"` left 42 publish tests
   * green, because every fixture's default WAS `main` — so nothing could tell
   * the observed value from the constant. A remote whose default is `trunk`
   * can: publishing onto `trunk` must refuse, and only the OBSERVED default
   * makes that true.
   */
  it("refuses a head branch that is the remote's actual default, whatever it is called", async () => {
    const s = scripted({ repository: { defaultBranch: "trunk" } });

    const outcome = await publishCandidate(
      deps(s),
      { ...CANDIDATE, headRef: "trunk", baseRef: "release" },
    );

    assert.equal(outcome.kind, "REFUSED", `publication would have written the default branch`);
    assert.match(outcome.kind === "REFUSED" ? outcome.reason : "", /default branch trunk/);
    assert.equal(s.creates(), 0);
  });
});

describe("TASK-016 AC-1: creating a pull request goes through the financial gate", () => {
  it("stops at the gate when a pull request would have to be created", async () => {
    const s = scripted();

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "HUMAN_REQUIRED", `a pull request was created: ${JSON.stringify(outcome)}`);
    assert.equal(s.creates(), 0, "the gate refused but a pull request was created anyway");
    assert.equal(outcome.kind === "HUMAN_REQUIRED" ? outcome.action.kind : "", "CREATE_PULL_REQUEST");
  });

  it("stops at the gate when the stored policy claims spend authority", async () => {
    const s = scripted();

    const outcome = await publishCandidate(
      deps(s, { financialPolicy: { autonomousSpendAllowed: true, autonomousSpendLimit: 10 } }),
      CANDIDATE,
    );

    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    assert.equal(s.creates(), 0);
  });

  /**
   * The refusal text must come from the GATE, not from a hard-coded denial —
   * one of the reviewer's surviving mutations replaced the gate with a
   * constant and nothing noticed.
   */
  it("reports the gate's own verdict text", async () => {
    const s = scripted();

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.match(
      outcome.kind === "HUMAN_REQUIRED" ? outcome.reason : "",
      /no autonomous financial authority/,
      "the refusal did not come from the financial gate",
    );
  });
});

describe("TASK-016 round-3 HIGH 4: each observed fact reaches the report", () => {
  /**
   * THE VACUITY THE REVIEWER FOUND. Every write refuses, so asserting
   * `HUMAN_REQUIRED` passes no matter what was observed — replacing
   * `visibility: repository.visibility` with a constant left every case green.
   * What must be pinned is the WIRING: each fact the client reports has to
   * arrive in the report the human reads.
   */
  const wiring = [
    ["visibility", { repository: { visibility: "PRIVATE" as const } }, /visibility PRIVATE/],
    ["owner type", { repository: { ownerType: "ORGANIZATION" as const } }, /owner ORGANIZATION/],
    ["webhook count", { repository: { repositoryWebhooks: 3 } }, /webhooks 3/],
    ["workflow count", { repository: { configuredWorkflows: 2 } }, /workflows 2/],
    ["introduced workflows", { local: { addsWorkflows: true } }, /candidate adds workflows true/],
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

  it("names the target in the refusal", async () => {
    const s = scripted();

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.match(outcome.kind === "HUMAN_REQUIRED" ? outcome.reason : "", new RegExp(REPO));
  });
});

describe("TASK-016 AC-8: publication refuses before it acts", () => {
  for (const [label, local, pattern] of [
    ["a dirty tree", { clean: false }, /not clean/],
    ["a different HEAD", { headSha: B }, /reviewed candidate is/],
    ["a candidate that does not descend from its base", { ancestor: false }, /not an ancestor/],
  ] as const) {
    it(`refuses ${label} without creating anything`, async () => {
      const s = scripted({ local });

      const outcome = await publishCandidate(deps(s), CANDIDATE);

      assert.equal(outcome.kind, "REFUSED", `${label} was published`);
      assert.match(outcome.kind === "REFUSED" ? outcome.reason : "", pattern);
      assert.equal(s.creates(), 0, "a refused publication still created a pull request");
    });
  }

  /**
   * `origin/<base>` is a LOCAL CACHE, so deciding the base has not moved by
   * consulting a stale copy is not a check. Order can only be tested by
   * recording order.
   */
  it("fetches before reading the base", async () => {
    const s = scripted({ pullRequest: EXISTING_PR });

    await publishCandidate(deps(s), CANDIDATE);

    const calls = s.gitCalls();
    const fetched = calls.indexOf("fetch");
    const readBase = calls.indexOf(`revision:origin/${CANDIDATE.baseRef}`);
    assert.notEqual(fetched, -1, "the base was never refreshed");
    assert.ok(fetched < readBase, `the base was read before it was refreshed: ${calls.join(", ")}`);
  });
});

describe("TASK-016 AC-5 (round-3 HIGH 3): the create/adopt behaviour, demonstrated directly", () => {
  /**
   * The frozen AC-5 describes create-or-adopt behaviour that `publishCandidate`
   * cannot reach, because the gate refuses the write first. The reviewer's
   * instruction was to keep the behaviour and prove it through a separately
   * testable seam rather than delete it — and AC-5's own text prescribes
   * exactly this shape: "proven with a scripted client that counts create calls
   * across two executions".
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

  it("fails when creation fails and no pull request appears", async () => {
    const s = scripted({ createFails: true });

    const result = await ensurePullRequest(s.client, CANDIDATE);

    assert.equal(result.ok, false, "a failed creation was reported as success");
    assert.match(result.ok === false ? result.reason : "", /creating the pull request failed/);
  });
});

describe("TASK-016 AC-7: publication is not a second engineering loop", () => {
  it("performs no repeated remote writes in a completed publication", async () => {
    const s = scripted({ pullRequest: EXISTING_PR });

    await publishCandidate(deps(s), CANDIDATE);

    assert.equal(s.creates(), 0);
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
  });

  /**
   * The module surface carries no implement/verify/review capability, no
   * approval capability, and — since round 4 — no push either. The strongest
   * form of "it cannot do X" is that there is no X to call.
   */
  it("exposes no approval, merge, verification or push capability", async () => {
    const module = await import("../src/github/publishCandidate.js");
    const ports = await import("../src/github/githubPorts.js");

    const names = [...Object.keys(module), ...Object.keys(ports)].join(" ").toLowerCase();
    for (const forbidden of ["approve", "merge", "verify", "review", "implement", "push"]) {
      assert.ok(!names.includes(forbidden), `the publication surface exposes ${forbidden}`);
    }
  });
});
