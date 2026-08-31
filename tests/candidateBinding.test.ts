/**
 * TASK-016 AC-3/AC-4: remote state is evidence bound to a commit, never
 * authority, and never a name.
 *
 * Every case here is an ordinary event — someone pushes one more commit, a base
 * advances, a PR is closed — which is exactly why they must be refusals rather
 * than assumptions. Offline: pure functions, no client, no network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkCheckEvidence,
  checkIntegrationReadiness,
  checkPublishPreconditions,
  checkRemoteCandidateBinding,
  isCommitSha,
  type LocalRepositoryState,
  type RemoteCheckStatus,
  type RemotePullRequest,
  type RemoteRepository,
  type ReviewedCandidate,
  selectAdoptablePullRequest,
} from "../src/github/candidateBinding.js";

const A = "1111111111111111111111111111111111111111";
const B = "2222222222222222222222222222222222222222";
const BASE = "3333333333333333333333333333333333333333";
const BASE_MOVED = "4444444444444444444444444444444444444444";

const REPO = "hakanduyar/software-factory";

const CANDIDATE: ReviewedCandidate = {
  roadmapKey: "GITHUB_ORCHESTRATION",
  headSha: A,
  baseSha: BASE,
  baseRef: "main",
  headRef: "feat/executor-wiring",
};

const REPOSITORY: RemoteRepository = {
  nameWithOwner: REPO,
  defaultBranch: "main",
  visibility: "PUBLIC",
  ownerType: "USER",
  repositoryWebhooks: 0,
  configuredWorkflows: 0,
};

function local(overrides: Partial<LocalRepositoryState> = {}): LocalRepositoryState {
  return {
    headSha: A,
    baseSha: BASE,
    clean: true,
    baseIsAncestorOfHead: true,
    ...overrides,
  };
}

function pr(overrides: Partial<RemotePullRequest> = {}): RemotePullRequest {
  return {
    number: 7,
    state: "OPEN",
    headRef: "feat/executor-wiring",
    headSha: A,
    baseRef: "main",
    baseSha: BASE,
    ...overrides,
  };
}

function checks(overrides: Partial<RemoteCheckStatus> = {}): RemoteCheckStatus {
  return { sha: A, conclusion: "SUCCESS", total: 3, ...overrides };
}

describe("TASK-016: a sha is an identity and a prefix is not", () => {
  it("accepts a full 40-character lowercase id", () => {
    assert.equal(isCommitSha(A), true);
  });

  /**
   * An abbreviated sha is a display convenience. Accepting one would mean
   * `11662a1` matching any commit beginning with those characters, which is
   * matching on a prefix and calling it identity.
   */
  // `A` is all digits, so `A.toUpperCase()` is `A` — an uppercase case needs
  // actual letters, or it silently asserts that a valid sha is invalid.
  const UPPERCASE = "ABCDEF7890ABCDEF7890ABCDEF7890ABCDEF7890";

  for (const value of ["11662a1", "", UPPERCASE, `${A}5`, A.slice(0, 39), 42, null, undefined]) {
    it(`refuses ${JSON.stringify(value)} as a commit id`, () => {
      assert.equal(isCommitSha(value), false);
    });
  }
});

describe("TASK-016 AC-8: local preconditions fail closed", () => {
  it("permits a clean tree at the reviewed candidate", () => {
    const verdict = checkPublishPreconditions({ candidate: CANDIDATE, local: local(), defaultBranch: "main" });

    assert.equal(verdict.ok, true, `a valid publish was refused: ${JSON.stringify(verdict)}`);
  });

  it("refuses a dirty working tree", () => {
    const verdict = checkPublishPreconditions({
      candidate: CANDIDATE,
      local: local({ clean: false }),
      defaultBranch: "main",
    });

    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : "", /not clean/);
  });

  it("refuses when HEAD is not the reviewed candidate", () => {
    const verdict = checkPublishPreconditions({
      candidate: CANDIDATE,
      local: local({ headSha: B }),
      defaultBranch: "main",
    });

    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : "", /reviewed candidate is/);
  });

  /**
   * ORIGIN MOVED. The tree is clean and HEAD is the reviewed commit — only the
   * base advancing can produce this refusal, so no sibling check can be what
   * catches it.
   */
  it("refuses when the base has moved since the review", () => {
    const verdict = checkPublishPreconditions({
      candidate: CANDIDATE,
      local: local({ baseSha: BASE_MOVED }),
      defaultBranch: "main",
    });

    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : "", /does not describe this base/);
  });

  it("refuses a candidate that carries an abbreviated sha", () => {
    const verdict = checkPublishPreconditions({
      candidate: { ...CANDIDATE, headSha: "11662a1" },
      local: local(),
      defaultBranch: "main",
    });

    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : "", /not an identity/);
  });

  /**
   * ROUND-1 REVIEW, HIGH 3. Equality was the only test, so two UNRELATED
   * commits passed everything: the tree is clean, the push URL is expected,
   * HEAD equals the candidate and the base equals the reviewed base. Only the
   * ancestry check can refuse here, which is what makes it load-bearing.
   */
  it("refuses a candidate that does not descend from its base", () => {
    const verdict = checkPublishPreconditions({
      candidate: CANDIDATE,
      local: local({ baseIsAncestorOfHead: false }),
      defaultBranch: "main",
    });

    assert.equal(verdict.ok, false, "an unrelated commit passed as a publishable candidate");
    assert.match(verdict.ok === false ? verdict.reason : "", /not an ancestor/);
  });

  /** Unknown ancestry is not permission — uncertainty refuses. */
  it("refuses when ancestry could not be established", () => {
    const verdict = checkPublishPreconditions({
      candidate: CANDIDATE,
      local: local({ baseIsAncestorOfHead: undefined }),
      defaultBranch: "main",
    });

    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : "", /could not be established/);
  });

  /**
   * ROUND-2 REVIEW, HIGH 3. A candidate declaring `headRef: "main"` passed
   * every other check and the pusher then wrote `main` directly — which is an
   * INTEGRATION, explicitly outside this task's frozen scope. On real GitHub
   * the pull-request creation would fail afterwards because head and base
   * match, but by then the branch has already moved.
   */
  it("refuses a candidate whose head branch is its own base", () => {
    /**
     * The base is `release` and the DEFAULT is `main`, deliberately.
     *
     * The first version of this case used `main` for both, so the
     * default-branch guard caught it too and deleting the base-equality guard
     * left the suite green — my own mutation harness found it. A guard whose
     * test a sibling also satisfies is not known to work.
     */
    const verdict = checkPublishPreconditions({
      candidate: { ...CANDIDATE, headRef: "release", baseRef: "release" },
      local: local(),
      defaultBranch: "main",
    });

    assert.equal(verdict.ok, false, "publication would have written the base branch directly");
    assert.match(verdict.ok === false ? verdict.reason : "", /which is its own base/);
  });

  /**
   * And the DEFAULT branch specifically, even when it is not this candidate's
   * base — `main` is not special because it is named `main`, it is special
   * because the remote says it is the default.
   */
  it("refuses a candidate whose head branch is the remote default", () => {
    const verdict = checkPublishPreconditions({
      candidate: { ...CANDIDATE, headRef: "trunk", baseRef: "release" },
      local: local(),
      defaultBranch: "trunk",
    });

    assert.equal(verdict.ok, false, "publication would have written the default branch directly");
    assert.match(verdict.ok === false ? verdict.reason : "", /default branch trunk/);
  });

  /** The control: an ordinary feature branch is still publishable. */
  it("permits a head branch that is neither the base nor the default", () => {
    const verdict = checkPublishPreconditions({
      candidate: { ...CANDIDATE, headRef: "feat/something", baseRef: "main" },
      local: local(),
      defaultBranch: "main",
    });

    assert.equal(verdict.ok, true, `an ordinary branch was refused: ${JSON.stringify(verdict)}`);
  });
});

describe("TASK-016 AC-3: the remote must still describe the reviewed commit", () => {
  it("permits a pull request pointing at the candidate", () => {
    const verdict = checkRemoteCandidateBinding({
      candidate: CANDIDATE,
      repository: REPOSITORY,
      expectedRepository: REPO,
      pullRequest: pr(),
    });

    assert.equal(verdict.ok, true, `a bound pull request was refused: ${JSON.stringify(verdict)}`);
  });

  /**
   * THE CASE THE MODULE EXISTS FOR. PR #7 was reviewed at A; someone pushed B.
   * The number, the branch name, the base and the state are all unchanged —
   * ONLY the head sha differs, so only the head comparison can refuse.
   */
  it("refuses when the pull request head moved after the review", () => {
    const verdict = checkRemoteCandidateBinding({
      candidate: CANDIDATE,
      repository: REPOSITORY,
      expectedRepository: REPO,
      pullRequest: pr({ headSha: B }),
    });

    assert.equal(verdict.ok, false, "an acceptance transferred to an unreviewed commit");
    assert.match(verdict.ok === false ? verdict.reason : "", /does not transfer/);
  });

  it("refuses when the pull request base sha moved", () => {
    const verdict = checkRemoteCandidateBinding({
      candidate: CANDIDATE,
      repository: REPOSITORY,
      expectedRepository: REPO,
      pullRequest: pr({ baseSha: BASE_MOVED }),
    });

    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : "", /is based on/);
  });

  it("refuses when the pull request targets a different base branch", () => {
    const verdict = checkRemoteCandidateBinding({
      candidate: CANDIDATE,
      repository: REPOSITORY,
      expectedRepository: REPO,
      pullRequest: pr({ baseRef: "release" }),
    });

    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : "", /targets release/);
  });

  for (const state of ["CLOSED", "MERGED"] as const) {
    it(`refuses a ${state} pull request`, () => {
      const verdict = checkRemoteCandidateBinding({
        candidate: CANDIDATE,
        repository: REPOSITORY,
        expectedRepository: REPO,
        pullRequest: pr({ state }),
      });

      assert.equal(verdict.ok, false);
      assert.match(verdict.ok === false ? verdict.reason : "", new RegExp(state));
    });
  }

  it("refuses when the remote is a different repository", () => {
    const verdict = checkRemoteCandidateBinding({
      candidate: CANDIDATE,
      repository: { ...REPOSITORY, nameWithOwner: "someone-else/other" },
      expectedRepository: REPO,
      pullRequest: pr(),
    });

    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : "", /expects/);
  });

  it("refuses when no pull request exists", () => {
    const verdict = checkRemoteCandidateBinding({
      candidate: CANDIDATE,
      repository: REPOSITORY,
      expectedRepository: REPO,
      pullRequest: undefined,
    });

    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : "", /no pull request/);
  });

  /**
   * A PR NUMBER IS NOT AN IDENTITY. Same number, different commit: if the
   * number were doing any of the work, this would pass.
   */
  it("does not accept a matching number as a substitute for a matching commit", () => {
    const verdict = checkRemoteCandidateBinding({
      candidate: CANDIDATE,
      repository: REPOSITORY,
      expectedRepository: REPO,
      pullRequest: pr({ number: 7, headSha: B }),
    });

    assert.equal(verdict.ok, false, "the pull request number stood in for the commit");
  });
});

describe("TASK-016 AC-4: CI evidence is bound to a commit or it is not evidence", () => {
  it("accepts a successful run against the candidate", () => {
    assert.equal(checkCheckEvidence({ candidate: CANDIDATE, checks: checks() }).ok, true);
  });

  /**
   * A GREEN RUN AGAINST ANOTHER COMMIT. The conclusion is SUCCESS and the count
   * is positive — only the sha differs, so only the sha comparison can refuse.
   */
  it("refuses a successful run that describes a different commit", () => {
    const verdict = checkCheckEvidence({ candidate: CANDIDATE, checks: checks({ sha: B }) });

    assert.equal(verdict.ok, false, "a pass for another commit was accepted as evidence");
    assert.match(verdict.ok === false ? verdict.reason : "", /not evidence about this one/);
  });

  /**
   * ABSENCE IS NOT SUCCESS — and this is the value this repository produces
   * today, since it has no workflows at all.
   */
  it("refuses when no checks are configured", () => {
    const verdict = checkCheckEvidence({
      candidate: CANDIDATE,
      checks: checks({ conclusion: "NO_CHECKS_CONFIGURED", total: 0 }),
    });

    assert.equal(verdict.ok, false, "the absence of checks was read as a pass");
    assert.match(verdict.ok === false ? verdict.reason : "", /not evidence of a pass/);
  });

  for (const conclusion of ["PENDING", "FAILURE"] as const) {
    it(`refuses a ${conclusion} conclusion`, () => {
      assert.equal(checkCheckEvidence({ candidate: CANDIDATE, checks: checks({ conclusion }) }).ok, false);
    });
  }

  /** A success that counted nothing is a contradiction, not a pass. */
  it("refuses a SUCCESS that counted zero checks", () => {
    const verdict = checkCheckEvidence({ candidate: CANDIDATE, checks: checks({ total: 0 }) });

    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : "", /counted 0/);
  });

  /**
   * ROUND-1 REVIEW, HIGH 4. Enumerating the known FAILURE values and passing
   * everything else let an unrecognised conclusion — a future API value, or a
   * malformed one — fall through to a pass. Success is an allowlist now, so a
   * conclusion nobody has heard of refuses.
   */
  it("refuses a conclusion it does not recognise", () => {
    const verdict = checkCheckEvidence({
      candidate: CANDIDATE,
      checks: { sha: A, conclusion: "banana" as never, total: 1 },
    });

    assert.equal(verdict.ok, false, "an unrecognised conclusion was accepted as a pass");
    assert.match(verdict.ok === false ? verdict.reason : "", /not a pass/);
  });

  it("refuses a non-integer check count", () => {
    const verdict = checkCheckEvidence({
      candidate: CANDIDATE,
      checks: { sha: A, conclusion: "SUCCESS", total: Number.NaN },
    });

    assert.equal(verdict.ok, false, "a nonsense count was accepted");
  });

  it("refuses when no check status was retrieved", () => {
    assert.equal(checkCheckEvidence({ candidate: CANDIDATE, checks: undefined }).ok, false);
  });
});

describe("TASK-016 AC-4: neither CI nor review substitutes for the other", () => {
  const ready = {
    candidate: CANDIDATE,
    repository: REPOSITORY,
    expectedRepository: REPO,
    pullRequest: pr(),
    checks: checks(),
    local: local(),
    reviewAccepted: true,
  };

  it("permits integration when both the review and the bound checks agree", () => {
    assert.equal(checkIntegrationReadiness(ready).ok, true, "a fully evidenced candidate was refused");
  });

  /**
   * CI SUCCESS ALONE IS NOT ACCEPTANCE. Everything else here is green: the
   * checks pass, against the right commit, on an open PR at the right base.
   * Only the missing review can refuse.
   */
  it("refuses passing checks with no accepted review", () => {
    const verdict = checkIntegrationReadiness({ ...ready, reviewAccepted: false });

    assert.equal(verdict.ok, false, "green CI was treated as an acceptance");
    assert.match(verdict.ok === false ? verdict.reason : "", /not an acceptance/);
  });

  /**
   * AND AN ACCEPTANCE ALONE IS NOT TREE IDENTITY. The review is accepted, but
   * the remote holds a different commit.
   */
  it("refuses an accepted review when the remote head moved", () => {
    const verdict = checkIntegrationReadiness({ ...ready, pullRequest: pr({ headSha: B }) });

    assert.equal(verdict.ok, false, "an acceptance covered a commit the remote no longer holds");
  });

  it("refuses an accepted review when no checks are configured", () => {
    const verdict = checkIntegrationReadiness({
      ...ready,
      checks: checks({ conclusion: "NO_CHECKS_CONFIGURED", total: 0 }),
    });

    assert.equal(verdict.ok, false, "an accepted review compensated for absent CI evidence");
  });

  it("refuses before consulting the remote when the local tree is dirty", () => {
    const verdict = checkIntegrationReadiness({ ...ready, local: local({ clean: false }) });

    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : "", /not clean/);
  });
});


describe("TASK-016 AC-5 (amended): which pull request may be adopted", () => {
  const repository: RemoteRepository = {
    nameWithOwner: "hakanduyar/software-factory",
    defaultBranch: "main",
    visibility: "PUBLIC",
    ownerType: "USER",
    repositoryWebhooks: 0,
    configuredWorkflows: 0,
  };
  const candidate: ReviewedCandidate = {
    roadmapKey: "GITHUB_ORCHESTRATION",
    headSha: A,
    baseSha: BASE,
    baseRef: "main",
    headRef: "feat/executor-wiring",
  };
  const bound: RemotePullRequest = {
    number: 7,
    state: "OPEN",
    headRef: candidate.headRef,
    headSha: A,
    baseRef: "main",
    baseSha: BASE,
  };
  const select = (pullRequests: readonly RemotePullRequest[]) =>
    selectAdoptablePullRequest({
      candidate,
      repository,
      expectedRepository: repository.nameWithOwner,
      pullRequests,
    });

  it("adopts the single pull request that binds", () => {
    const outcome = select([bound]);

    assert.equal(outcome.kind, "ADOPT");
    if (outcome.kind !== "ADOPT") return;
    assert.equal(outcome.pullRequest.number, 7);
  });

  /** An unrelated pull request in the listing must not make the match unclear. */
  it("adopts the bound one even when unbound pull requests are listed beside it", () => {
    const outcome = select([{ ...bound, number: 3, headSha: B }, bound]);

    assert.equal(outcome.kind, "ADOPT");
    if (outcome.kind !== "ADOPT") return;
    assert.equal(outcome.pullRequest.number, 7);
  });

  it("reports ABSENT when the remote lists nothing", () => {
    assert.equal(select([]).kind, "ABSENT");
  });

  /**
   * Distinguished from ABSENT on purpose: something IS published, so the
   * remedy is not "publish this candidate" but "look at what is there".
   */
  it("reports UNBINDABLE when pull requests exist but none names the candidate", () => {
    const outcome = select([{ ...bound, headSha: B }]);

    assert.equal(outcome.kind, "UNBINDABLE");
    if (outcome.kind !== "UNBINDABLE") return;
    assert.match(outcome.reason, new RegExp(B), "the specific reason was discarded");
  });

  it("reports UNBINDABLE for a pull request that is not OPEN", () => {
    assert.equal(select([{ ...bound, state: "MERGED" }]).kind, "UNBINDABLE");
  });

  it("reports UNBINDABLE for a pull request against a different base", () => {
    assert.equal(select([{ ...bound, baseSha: B }]).kind, "UNBINDABLE");
  });

  it("fails closed when two pull requests bind", () => {
    const outcome = select([bound, { ...bound, number: 9 }]);

    assert.equal(outcome.kind, "AMBIGUOUS");
    if (outcome.kind !== "AMBIGUOUS") return;
    assert.deepEqual([...outcome.numbers].sort((x, y) => x - y), [7, 9]);
  });

  /**
   * The same pull request reported twice is still more than one. A remote whose
   * count we quietly correct is a remote we have stopped reading.
   */
  it("fails closed when the same pull request is listed twice", () => {
    assert.equal(select([bound, bound]).kind, "AMBIGUOUS");
  });

  /**
   * An empty listing from the WRONG repository must not read as "none exist,
   * please publish" — which is what a caller-side-only check would allow.
   */
  it("refuses a listing from a repository other than the expected one", () => {
    const outcome = selectAdoptablePullRequest({
      candidate,
      repository: { ...repository, nameWithOwner: "someone-else/software-factory" },
      expectedRepository: repository.nameWithOwner,
      pullRequests: [],
    });

    assert.equal(outcome.kind, "UNBINDABLE");
    if (outcome.kind !== "UNBINDABLE") return;
    assert.match(outcome.reason, /someone-else/);
  });
});
