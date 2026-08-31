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
} from "../src/github/candidateBinding.js";

const A = "1111111111111111111111111111111111111111";
const B = "2222222222222222222222222222222222222222";
const BASE = "3333333333333333333333333333333333333333";
const BASE_MOVED = "4444444444444444444444444444444444444444";

const REPO = "hakanduyar/software-factory";
const URL = "https://github.com/hakanduyar/software-factory.git";

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
  billableIntegrations: 0,
};

function local(overrides: Partial<LocalRepositoryState> = {}): LocalRepositoryState {
  return { remoteUrl: URL, headSha: A, baseSha: BASE, clean: true, ...overrides };
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
    const verdict = checkPublishPreconditions({ candidate: CANDIDATE, local: local(), expectedRemoteUrl: URL });

    assert.equal(verdict.ok, true, `a valid publish was refused: ${JSON.stringify(verdict)}`);
  });

  it("refuses a dirty working tree", () => {
    const verdict = checkPublishPreconditions({
      candidate: CANDIDATE,
      local: local({ clean: false }),
      expectedRemoteUrl: URL,
    });

    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : "", /not clean/);
  });

  /**
   * The wrong remote is checked FIRST and separately: pushing to another
   * repository is not recoverable by noticing afterwards.
   */
  it("refuses an unexpected origin", () => {
    const verdict = checkPublishPreconditions({
      candidate: CANDIDATE,
      local: local({ remoteUrl: "https://github.com/someone-else/other.git" }),
      expectedRemoteUrl: URL,
    });

    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : "", /origin/);
  });

  it("refuses when HEAD is not the reviewed candidate", () => {
    const verdict = checkPublishPreconditions({
      candidate: CANDIDATE,
      local: local({ headSha: B }),
      expectedRemoteUrl: URL,
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
      expectedRemoteUrl: URL,
    });

    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : "", /does not describe this base/);
  });

  it("refuses a candidate that carries an abbreviated sha", () => {
    const verdict = checkPublishPreconditions({
      candidate: { ...CANDIDATE, headSha: "11662a1" },
      local: local(),
      expectedRemoteUrl: URL,
    });

    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : "", /not an identity/);
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
    expectedRemoteUrl: URL,
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
