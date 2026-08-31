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

import { publishCandidate, readLocalState, type PublishDeps } from "../src/github/publishCandidate.js";
import type {
  RemoteCheckStatus,
  RemotePullRequest,
  RemoteRepository,
  ReviewedCandidate,
} from "../src/github/candidateBinding.js";
import type { GitHubClient, GitRepositoryReader } from "../src/github/githubPorts.js";
import {
  authorizeRemoteWrite,
  createPullRequestAction,
  isRemoteWriteAuthorized,
  parseFinancialPolicy,
} from "../src/supervision/financialSafety.js";

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
  authorization(): unknown;
  gitCalls(): readonly string[];
}

function scripted(options: {
  readonly repository?: Partial<RemoteRepository>;
  readonly pullRequest?: RemotePullRequest;
  /**
   * Answers `listPullRequests` in order; the LAST list repeats. A queue of
   * lists is what models an interrupted run: the remote answers differently
   * on the second call because a human published in between.
   */
  readonly pullRequests?: readonly (readonly RemotePullRequest[])[];
  readonly local?: {
    headSha?: string;
    baseSha?: string;
    clean?: boolean;
    ancestor?: boolean | undefined;
    addsWorkflows?: boolean | undefined;
    usesLfs?: boolean | undefined;
  };
  /** Makes `createPullRequest` throw, as GitHub does for a duplicate. */
  readonly createFails?: boolean;
  /**
   * What the REMOTE branch holds. `undefined` (the default) means it already
   * holds the candidate, so nothing must be written; `null` means the branch
   * does not exist at all.
   */
  readonly remoteBranchSha?: string | null;
  /** What `checkStatus` reports as ITS sha; defaults to the one requested. */
  readonly checkStatusSha?: string;
  /**
   * What the LOCAL `origin` resolves to. `undefined` (the default) means the
   * expected repository; `null` means origin is absent or unparseable.
   */
  readonly originTarget?: string | null;
} = {}): Scripted {
  let pullRequest = options.pullRequest;
  const queue = options.pullRequests === undefined ? undefined : [...options.pullRequests];
  let createCount = 0;
  let findCount = 0;
  let lastAuthorization: unknown;
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
    async listPullRequests(): Promise<readonly RemotePullRequest[]> {
      findCount += 1;
      if (queue !== undefined) {
        return (queue.length > 1 ? queue.shift() : queue[0]) ?? [];
      }
      return pullRequest === undefined ? [] : [pullRequest];
    },
    async createPullRequest(input, authorization): Promise<RemotePullRequest> {
      createCount += 1;
      lastAuthorization = authorization;
      // The fake enforces what the real adapter enforces; a permissive double
      // would make the authorization untested where it matters.
      if (!isRemoteWriteAuthorized(authorization, "CREATE_PULL_REQUEST", REPO)) {
        throw new Error("createPullRequest requires an authorization minted by authorizeRemoteWrite");
      }
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
      return { sha: options.checkStatusSha ?? sha, conclusion: "NO_CHECKS_CONFIGURED", total: 0 };
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
      async usesLfs(): Promise<boolean | undefined> {
        gitCalls.push("usesLfs");
        return options.local?.usesLfs ?? false;
      },
      async originTarget(): Promise<string | undefined> {
        gitCalls.push("originTarget");
        return options.originTarget === undefined ? REPO : (options.originTarget ?? undefined);
      },
    },
    creates: () => createCount,
    finds: () => findCount,
    authorization: () => lastAuthorization,
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

describe("TASK-016 round-8 finding 1: the origin guard is not per-caller", () => {
  /**
   * THE REVIEWER'S REPRODUCTION. The guard lived in `publishCandidate`, so
   * `sf github readiness` — which reaches `readLocalState` by another route —
   * fetched and resolved `origin/<base>` without ever asking where origin
   * points, and could report readiness computed against a repository nobody
   * verified.
   *
   * The guard now lives in `readLocalState`, beside the reads it protects, so
   * these cases are about the FUNCTION rather than about one of its callers.
   */
  it("refuses in readLocalState itself when origin is a different repository", async () => {
    const s = scripted({ originTarget: "someone-else/software-factory" });

    const read = await readLocalState(s.git, CANDIDATE, REPO);

    assert.equal(read.ok, false, "readLocalState resolved a base through an unverified origin");
    if (read.ok) return;
    assert.match(read.reason, /someone-else/);
  });

  it("does not fetch or resolve anything when origin is wrong", async () => {
    const s = scripted({ originTarget: "someone-else/software-factory" });

    await readLocalState(s.git, CANDIDATE, REPO);

    const calls = s.gitCalls();
    assert.deepEqual(calls, ["originTarget"], `origin was used before it was checked: ${calls.join(",")}`);
  });

  /** The control: a matching origin still reads normally. */
  it("reads the local state when origin is the expected repository", async () => {
    const s = scripted({});

    const read = await readLocalState(s.git, CANDIDATE, REPO);

    assert.equal(read.ok, true, `a correct origin was refused: ${JSON.stringify(read)}`);
    assert.ok(s.gitCalls().includes("fetch"), "the fetch never happened");
  });
});

describe("TASK-016 AC-8: an unexpected local origin refuses", () => {
  /**
   * THE GAP THE ROUND-7 REVIEW NAMED. The base a candidate is measured against
   * is read from `origin/<base>`, and nothing ever checked where `origin`
   * points — so the ancestry, the base SHA and the "has the base moved" check
   * could all be computed against a repository nobody verified, while the `gh`
   * client addressed the right one and agreed.
   */
  it("refuses when the local origin points at a different repository", async () => {
    const s = scripted({ pullRequest: EXISTING_PR, originTarget: "someone-else/software-factory" });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "REFUSED", `an unexpected origin was accepted: ${JSON.stringify(outcome)}`);
    if (outcome.kind !== "REFUSED") return;
    assert.match(outcome.reason, /someone-else/);
  });

  it("refuses when the local origin is absent or not a GitHub url", async () => {
    const s = scripted({ pullRequest: EXISTING_PR, originTarget: null });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "REFUSED", `an unresolvable origin was accepted: ${JSON.stringify(outcome)}`);
  });

  /**
   * AND IT IS CHECKED BEFORE THE BASE IS READ. Refusing after resolving
   * `origin/<base>` would mean the refusal came too late to matter: the value
   * it was protecting had already been taken from the wrong place.
   */
  it("checks the origin before resolving anything through it", async () => {
    const s = scripted({ pullRequest: EXISTING_PR, originTarget: "someone-else/software-factory" });

    await publishCandidate(deps(s), CANDIDATE);

    const calls = s.gitCalls();
    assert.ok(calls.includes("originTarget"), "the origin was never read");
    assert.equal(calls[0], "originTarget", `the origin was checked after ${JSON.stringify(calls[0])}`);
    assert.ok(!calls.includes("fetch"), "the repository was fetched through an unverified origin");
  });
});

describe("TASK-016 AC-5 (amended): idempotent external publication adoption", () => {
  /**
   * THE POSITIVE CASE THE AMENDED CRITERION IS ABOUT. A human opened the pull
   * request; the Factory finds it, verifies it names the exact reviewed commit
   * against the exact reviewed base, adopts it, and writes NOTHING.
   */
  it("adopts a human-created pull request bound to the exact candidate", async () => {
    const s = scripted({ pullRequest: EXISTING_PR });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "PUBLISHED", `not published: ${JSON.stringify(outcome)}`);
    if (outcome.kind !== "PUBLISHED") return;
    assert.equal(outcome.created, false, "the Factory claimed to have created the pull request");
    assert.equal(outcome.pullRequest.number, 7);
    assert.equal(outcome.pullRequest.headSha, A);
    assert.equal(s.creates(), 0, "a remote write occurred on an adoption path");
  });

  it("adopts the SAME pull request on a second run and writes nothing either time", async () => {
    const s = scripted({ pullRequest: EXISTING_PR });

    const first = await publishCandidate(deps(s), CANDIDATE);
    const second = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(first.kind, "PUBLISHED");
    assert.equal(second.kind, "PUBLISHED");
    if (first.kind !== "PUBLISHED" || second.kind !== "PUBLISHED") return;
    assert.equal(first.pullRequest.number, second.pullRequest.number, "a second run adopted a different pull request");
    assert.equal(s.creates(), 0, "repeated execution performed a remote write");
  });

  /**
   * THE INTERRUPTED RUN (amended AC-5, 7). The first execution found nothing
   * and stopped at the gate; a human then published; the resumed execution
   * rediscovers and adopts that same pull request without duplicating.
   */
  it("rediscovers and adopts the same pull request when a run is resumed", async () => {
    const s = scripted({ pullRequests: [[], [EXISTING_PR]] });

    const interrupted = await publishCandidate(deps(s), CANDIDATE);
    assert.equal(interrupted.kind, "HUMAN_REQUIRED", `expected the gate to stop the first run: ${JSON.stringify(interrupted)}`);

    const resumed = await publishCandidate(deps(s), CANDIDATE);
    assert.equal(resumed.kind, "PUBLISHED", `the resumed run did not adopt: ${JSON.stringify(resumed)}`);
    if (resumed.kind !== "PUBLISHED") return;
    assert.equal(resumed.pullRequest.number, 7);
    assert.equal(resumed.created, false);
    assert.equal(s.creates(), 0, "the resumed run duplicated publication");
  });

  /**
   * PUBLICATION OBSERVES LFS RATHER THAN ASSERTING IT (round-8 finding 3).
   *
   * Hard-coding `candidateUsesLfs: false` survived mutation, because every
   * refusal happens anyway and no case looked at the REPORT. The report is what
   * a human reads before deciding, so it is what this asserts: a candidate that
   * tracks LFS must show the metered channel OPEN.
   */
  it("reports the lfs channel open for a candidate that tracks LFS", async () => {
    const s = scripted({ pullRequests: [[]], local: { usesLfs: true } });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "HUMAN_REQUIRED", JSON.stringify(outcome));
    if (outcome.kind !== "HUMAN_REQUIRED") return;
    assert.match(outcome.action.detail ?? "", /git-lfs/, "the lfs channel is absent from the report");
    assert.ok(s.gitCalls().includes("usesLfs"), "lfs was never actually observed");
  });

  /** The control: a candidate without LFS does NOT show the channel open. */
  it("does not report the lfs channel open for a candidate without LFS", async () => {
    const s = scripted({ pullRequests: [[]], local: { usesLfs: false } });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    if (outcome.kind !== "HUMAN_REQUIRED") return;
    const open = /open: ([^;]*)/.exec(outcome.action.detail ?? "")?.[1] ?? "";
    assert.ok(!open.includes("git-lfs"), `a clean candidate reported lfs open: ${open}`);
  });

  /** Amended AC-5, 8: nothing to adopt means a human must publish. No write. */
  it("stops at HUMAN_REQUIRED when no pull request exists, and writes nothing", async () => {
    const s = scripted({ pullRequests: [[]] });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "HUMAN_REQUIRED", `expected HUMAN_REQUIRED: ${JSON.stringify(outcome)}`);
    if (outcome.kind !== "HUMAN_REQUIRED") return;
    assert.match(outcome.reason, /externally/, "the refusal does not say what the human should do");
    assert.equal(s.creates(), 0, "a write was attempted with no authorization");
  });

  /**
   * Amended AC-5, 9: two bound pull requests is a state GitHub does not
   * normally permit, so it means something is not as assumed. Fail closed —
   * and in particular do NOT create a third.
   */
  it("fails closed when more than one pull request binds to the candidate", async () => {
    const s = scripted({
      pullRequests: [[EXISTING_PR, { ...EXISTING_PR, number: 9 }]],
    });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "REFUSED", `ambiguity was resolved instead of refused: ${JSON.stringify(outcome)}`);
    if (outcome.kind !== "REFUSED") return;
    assert.match(outcome.reason, /ambiguous/i);
    assert.equal(s.creates(), 0, "a pull request was created while the remote state was ambiguous");
  });

  /**
   * Pull requests exist, but for a commit nobody reviewed. That is NOT a
   * request for publication: creating another would publish a second thing.
   */
  it("refuses when pull requests exist but none names the candidate", async () => {
    const s = scripted({ pullRequests: [[{ ...EXISTING_PR, headSha: B }]] });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "REFUSED", `expected a refusal: ${JSON.stringify(outcome)}`);
    if (outcome.kind !== "REFUSED") return;
    assert.match(outcome.reason, new RegExp(B));
    assert.equal(s.creates(), 0);
  });
});

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
      pullRequests: [[EXISTING_PR], [{ ...EXISTING_PR, headSha: B }]],
    });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "REFUSED", `a stale snapshot was published: ${JSON.stringify(outcome)}`);
    assert.ok(s.finds() >= 2, `the remote was read only ${s.finds()} time(s); the rebind reused a snapshot`);
  });

  it("reports the pull request as the re-read describes it", async () => {
    const s = scripted({ pullRequests: [[EXISTING_PR], [{ ...EXISTING_PR, number: 12 }]] });

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

/**
 * WHY THERE IS NO DIRECT-SEAM SUITE HERE ANY MORE.
 *
 * Round 3 asked for the create/adopt behaviour to be exercised through an
 * extracted seam, and it was — exported. Round 5 showed what that cost: an
 * exported helper reaching `createPullRequest` without minting an action or
 * consulting the gate is a way AROUND the gate, whatever the intended caller
 * does. Their instruction was "private, or require an unforgeable post-gate
 * capability", and private is the honest answer: any capability a test could
 * obtain, an ungated caller could obtain too.
 *
 * So the CREATE half is no longer executed. What is demonstrated below through
 * the public function is the half that matters operationally — two runs yield
 * one pull request, an interrupted run adopts rather than duplicating, and
 * nothing is created when one already exists — plus, structurally, that the
 * module exposes no ungated way to write at all.
 */
describe("TASK-016 round-6 finding 1: the write demands proof the gate allowed it", () => {
  /**
   * Round 5 made the create/adopt helper private, which fixed the MODULE. It
   * did not fix the ADAPTER: a client with a write method is a write
   * capability wherever it is constructed, and `createGhCliClient` is
   * exported. The remedy the reviewer named in round 5 is now implemented —
   * an unforgeable post-gate capability — and the objection I raised then is
   * answered by minting it ONLY from an allowed verdict the gate computed
   * itself, which a caller can neither supply nor forge.
   */
  it("refuses a create with no authorization at all", async () => {
    const s = scripted();

    await assert.rejects(
      () => s.client.createPullRequest(
        { headRef: "x", baseRef: "main", title: "t", body: "b" },
        undefined as never,
      ),
      /authorizeRemoteWrite/,
      "an unauthorized write was accepted",
    );
  });

  it("refuses a hand-built object that looks like an authorization", async () => {
    const s = scripted();

    await assert.rejects(
      () => s.client.createPullRequest(
        { headRef: "x", baseRef: "main", title: "t", body: "b" },
        { kind: "CREATE_PULL_REQUEST", target: REPO },
      ),
      /authorizeRemoteWrite/,
      "a forged authorization was accepted",
    );
  });

  /**
   * And the gate does not mint one for this action today, so the write is
   * unreachable by construction rather than by discipline.
   */
  it("mints no authorization for the action publication would perform", () => {
    const action = createPullRequestAction({
      target: REPO,
      description: "publish",
    });

    const result = authorizeRemoteWrite(
      action,
      parseFinancialPolicy({ autonomousSpendAllowed: false, autonomousSpendLimit: 0 }),
    );

    assert.equal(result.ok, false, "the gate minted a write authorization");
  });
});

describe("TASK-016 round-5 finding 1: no ungated write is reachable", () => {
  it("exports no helper that can create a pull request", async () => {
    const module = await import("../src/github/publishCandidate.js");

    assert.ok(
      !Object.keys(module).includes("ensurePullRequest"),
      "the create/adopt helper is exported, which is a path around the financial gate",
    );
  });

  /**
   * And the only exported function that can reach a write refuses before
   * reaching it — asserted by counting, because "the gate came first" is a
   * claim about order.
   */
  it("creates nothing through the only exported entry point", async () => {
    const s = scripted();

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    assert.equal(s.creates(), 0, "the exported entry point reached a write");
  });
});

describe("TASK-016 round-5 finding 2: check evidence is bound before it is reported", () => {
  /**
   * THE REPRODUCTION. `checkCheckEvidence` refuses a mismatched sha, but
   * publication never asked it — so a client returning a status for a
   * DIFFERENT commit had that status reported and, through
   * `publicationDetail`, written into the provenance chain. Unbound evidence
   * recorded as if it were bound is what AC-4 exists to prevent.
   *
   * This is also the reviewer's "sixth gap": every fixture returned the
   * requested sha, so replacing the result with a constant would have
   * survived. This one does not return the requested sha.
   */
  it("refuses a check status that describes a different commit", async () => {
    const s = scripted({ pullRequest: EXISTING_PR, checkStatusSha: B });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "REFUSED", `unbound evidence was published: ${JSON.stringify(outcome)}`);
    assert.match(outcome.kind === "REFUSED" ? outcome.reason : "", /evidence for another commit/);
  });

  it("refuses a check status that does not name a full commit id", async () => {
    const s = scripted({ pullRequest: EXISTING_PR, checkStatusSha: "11662a1" });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "REFUSED");
    assert.match(outcome.kind === "REFUSED" ? outcome.reason : "", /full commit id/);
  });

  /** The control: a correctly bound status still publishes. */
  it("publishes when the check status describes the candidate", async () => {
    const s = scripted({ pullRequest: EXISTING_PR });

    const outcome = await publishCandidate(deps(s), CANDIDATE);

    assert.equal(outcome.kind, "PUBLISHED", JSON.stringify(outcome));
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
