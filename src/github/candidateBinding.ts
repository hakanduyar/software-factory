/**
 * REMOTE STATE IS EVIDENCE, NEVER AUTHORITY (TASK-016).
 *
 * Everything in this module exists to answer one question: is the thing GitHub
 * is describing the same thing that was reviewed? Nothing here talks to the
 * network, spawns anything, or decides that work is acceptable — it compares
 * identities and refuses when they disagree.
 *
 * THE IDENTITY IS A COMMIT. Not a pull-request number, not a branch name,
 * not "the latest push". Those are labels a remote can move at any time and
 * without any commit changing, so a decision resting on one is a decision about
 * nothing in particular. Every field this module compares is a SHA, and the two
 * label-shaped fields it does read are used narrowly and never permitted to
 * stand IN PLACE of a SHA: `baseRef` is compared for agreement, and `headRef`
 * is used only to refuse a candidate whose head IS its base or the remote's
 * default branch, and to name things in refusals. Corrected after the round-10
 * review observed that the earlier wording claimed `headRef` was checked for
 * agreement, which it is not — the head is bound by SHA, which is the stronger
 * check and the reason no label comparison is needed there.
 *
 * The refusals here are deliberately boring restatements of that rule. That is
 * the point: a stale acceptance is not an exotic attack, it is what happens by
 * default when a human pushes one more commit while a review is running.
 */

import type { RepositoryOwnerType, RepositoryVisibility } from "../supervision/financialSafety.js";

/** A commit id, as it came back from git or from GitHub. */
export type CommitSha = string;

/** Exactly 40 lowercase hex characters. Nothing shorter is an identity. */
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * A SHA is compared as a WHOLE VALUE, never by prefix.
 *
 * An abbreviated sha is a display convenience, and treating one as an identity
 * would mean `11662a1` matching any commit that happens to start with those
 * characters. Anything that is not a full 40-hex id is refused as unusable
 * rather than compared loosely — the same "uncertainty is not permission" rule
 * the financial gate uses.
 */
export function isCommitSha(value: unknown): value is CommitSha {
  return typeof value === "string" && FULL_SHA.test(value);
}

/** What GitHub says about the repository itself. */
export interface RemoteRepository {
  /** `owner/name`. The push target identity. */
  readonly nameWithOwner: string;
  readonly defaultBranch: string;
  readonly visibility: RepositoryVisibility;
  /** USER or ORGANIZATION — decides whether org-scoped webhooks can exist. */
  readonly ownerType: RepositoryOwnerType;
  /** Repository webhooks; `undefined` when the count could not be established. */
  readonly repositoryWebhooks: number | undefined;
  /** Configured Actions workflows; `undefined` when unknown. */
  readonly configuredWorkflows: number | undefined;
}

export const PULL_REQUEST_STATES = ["OPEN", "CLOSED", "MERGED"] as const;

export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

/**
 * One pull request, ALWAYS carrying the commits it points at.
 *
 * `number` is present because a human needs it and because the API needs it to
 * address the PR — never because it identifies a tree.
 */
export interface RemotePullRequest {
  readonly number: number;
  readonly state: PullRequestState;
  readonly headRef: string;
  readonly headSha: CommitSha;
  readonly baseRef: string;
  readonly baseSha: CommitSha;
}

export const CHECK_CONCLUSIONS = ["SUCCESS", "FAILURE", "PENDING", "NO_CHECKS_CONFIGURED"] as const;

export type CheckConclusion = (typeof CHECK_CONCLUSIONS)[number];

/**
 * CI evidence, bound to the commit it describes.
 *
 * `NO_CHECKS_CONFIGURED` is a distinct value rather than an absence, because
 * the difference between "checks ran and passed" and "there are no checks"
 * is the whole of AC-4 and must survive into every record that quotes it.
 * This repository has no workflows today, so that is the value it produces —
 * and it must never read as success.
 */
export interface RemoteCheckStatus {
  readonly sha: CommitSha;
  readonly conclusion: CheckConclusion;
  /** How many checks were counted. Zero with a SUCCESS conclusion is a contradiction. */
  readonly total: number;
}

/** The candidate an independent reviewer actually examined. */
export interface ReviewedCandidate {
  readonly roadmapKey: string;
  /** The exact commit reviewed. */
  readonly headSha: CommitSha;
  /** The base that commit was reviewed against. */
  readonly baseSha: CommitSha;
  readonly baseRef: string;
  /** The branch the candidate is published on — a label, used for addressing only. */
  readonly headRef: string;
}

/** What the LOCAL repository looks like right now. */
export interface LocalRepositoryState {
  readonly headSha: CommitSha;
  /** Where `origin/<baseRef>` points right now, AFTER a fetch. */
  readonly baseSha: CommitSha;
  /** False when anything is uncommitted, staged or untracked. */
  readonly clean: boolean;
  /**
   * Whether the base is an ANCESTOR of the candidate.
   *
   * ROUND-1 REVIEW, HIGH 3. Equality of two shas says they are the ones that
   * were reviewed; it says nothing about whether the candidate can actually be
   * fast-forwarded onto the base. Two unrelated commits passed every equality
   * check. `undefined` means it could not be established, which refuses.
   */
  readonly baseIsAncestorOfHead: boolean | undefined;
}

export type BindingVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

function refuse(reason: string): BindingVerdict {
  return { ok: false, reason };
}

/**
 * Whether the LOCAL repository may publish this candidate at all.
 *
 * Checked before anything is pushed, and deliberately separate from the remote
 * comparison below: a dirty tree or an unexpected remote is a reason to do
 * nothing whatsoever, not a reason to compare identities and then decide.
 */
export function checkPublishPreconditions(input: {
  readonly candidate: ReviewedCandidate;
  readonly local: LocalRepositoryState;
  /** The remote's default branch, which publication may never write to. */
  readonly defaultBranch: string;
}): BindingVerdict {
  const { candidate, local } = input;

  /**
   * PUBLICATION MAY NOT WRITE THE BASE OR THE DEFAULT BRANCH (round-2 HIGH 3).
   *
   * A candidate declaring `headRef: "main"` passed every other check and the
   * pusher then wrote `main` directly — an INTEGRATION, which TASK-016's
   * frozen scope explicitly excludes. On real GitHub the pull-request creation
   * would fail afterwards because head and base match, but by then the branch
   * has already moved, so the refusal has to come first.
   *
   * Checked before anything else because it is a property of the REQUEST, not
   * of the repository: nothing about the world can make it acceptable.
   */
  if (candidate.headRef === candidate.baseRef) {
    return refuse(
      `publication would write ${candidate.headRef}, which is its own base; publishing is not integrating`,
    );
  }
  if (candidate.headRef === input.defaultBranch) {
    return refuse(
      `publication would write the default branch ${input.defaultBranch} directly; publishing is not integrating`,
    );
  }

  if (!isCommitSha(candidate.headSha) || !isCommitSha(candidate.baseSha)) {
    return refuse(
      `the reviewed candidate does not carry full commit ids (head ${JSON.stringify(candidate.headSha)}, base ${JSON.stringify(candidate.baseSha)}); an abbreviated or absent sha is not an identity`,
    );
  }
  if (!isCommitSha(local.headSha) || !isCommitSha(local.baseSha)) {
    return refuse("the local repository did not report full commit ids for HEAD and the base");
  }
  if (!local.clean) {
    return refuse(
      "the working tree is not clean, so the commit that would be published is not the tree that was reviewed",
    );
  }
  if (local.headSha !== candidate.headSha) {
    return refuse(
      `HEAD is ${local.headSha} but the reviewed candidate is ${candidate.headSha}; publishing would put a different tree behind the review`,
    );
  }
  /**
   * ORIGIN MOVED. The candidate was reviewed against one base; if the base has
   * advanced since, the review examined a merge that no longer exists, and
   * whether the new base is compatible is a fresh question rather than an
   * assumption this function may make.
   */
  if (local.baseSha !== candidate.baseSha) {
    return refuse(
      `${candidate.baseRef} was ${candidate.baseSha} when the candidate was reviewed and is ${local.baseSha} now; the review does not describe this base`,
    );
  }
  /**
   * AND THE CANDIDATE MUST ACTUALLY SIT ON THAT BASE (round-1 HIGH 3).
   *
   * Equality proves the two shas are the reviewed ones. It does not prove the
   * candidate descends from the base — two unrelated commits satisfy every
   * check above — and a candidate that does not descend from its base cannot
   * be fast-forwarded onto it, so the publication being prepared is not the
   * one anybody could integrate. `undefined` is unknown, which refuses.
   */
  if (local.baseIsAncestorOfHead !== true) {
    return refuse(
      local.baseIsAncestorOfHead === false
        ? `${candidate.baseSha} is not an ancestor of ${candidate.headSha}; the candidate does not sit on the base it claims`
        : `whether ${candidate.baseSha} is an ancestor of ${candidate.headSha} could not be established`,
    );
  }
  return { ok: true };
}

/**
 * Whether REMOTE state still describes the reviewed candidate.
 *
 * Every branch below is a way for the remote to have moved out from under an
 * acceptance. None of them is unusual — a colleague pushing to the branch, a
 * base advancing, a PR being closed and reopened are all ordinary — which is
 * exactly why they must be checked rather than assumed away.
 */
/**
 * Which pull request, if any, this candidate may ADOPT (AC-5 amended, 4/5/8/9).
 *
 * Publication cannot create a pull request: the zero-cost gate never authorizes
 * the write, because an installed GitHub App on the target can meter it and is
 * not observable with these credentials. So a human creates the pull request,
 * and the Factory's job is to ADOPT the right one — which makes "the right one"
 * a question that must be answered by identity rather than by convenience.
 *
 * FOUR OUTCOMES, because collapsing them loses the distinction that matters:
 *
 *   ADOPT       exactly one listed pull request BINDS to this candidate
 *   ABSENT      none exist; a human must publish, and no write happens here
 *   UNBINDABLE  some exist, none bind — the head moved, the base differs, the
 *               state is not OPEN. NOT the same as absent: creating another
 *               pull request would be wrong, so this is a refusal, not a
 *               request for publication.
 *   AMBIGUOUS   more than one binds. GitHub does not normally permit this,
 *               which is exactly why encountering it means something is not as
 *               assumed. Fail closed: do not pick one, do not create another.
 *
 * The ambiguity decision lives HERE rather than in the adapter on purpose. The
 * adapter used to throw on multiple open pull requests, and — when none were
 * open — fall back to `parsed[0]`, which is arbitrary selection by another
 * name. A pure function makes both the choice and its absence testable.
 *
 * A repeated listing of the SAME number still counts as more than one. A remote
 * that reports one pull request twice is not a remote whose count we should be
 * quietly correcting.
 */
export type PullRequestAdoption =
  | { readonly kind: "ADOPT"; readonly pullRequest: RemotePullRequest }
  | { readonly kind: "ABSENT"; readonly reason: string }
  | { readonly kind: "UNBINDABLE"; readonly reason: string }
  | { readonly kind: "AMBIGUOUS"; readonly reason: string; readonly numbers: readonly number[] };

export function selectAdoptablePullRequest(input: {
  readonly candidate: ReviewedCandidate;
  readonly repository: RemoteRepository;
  readonly expectedRepository: string;
  readonly pullRequests: readonly RemotePullRequest[];
}): PullRequestAdoption {
  /**
   * Checked before anything else so this function is correct on its own rather
   * than only in the caller that already checked. An empty listing from the
   * WRONG repository must not read as "none exist, please publish".
   */
  if (input.repository.nameWithOwner !== input.expectedRepository) {
    return {
      kind: "UNBINDABLE",
      reason: `the remote reports repository ${JSON.stringify(input.repository.nameWithOwner)} but this action expects ${JSON.stringify(input.expectedRepository)}`,
    };
  }

  const bound = input.pullRequests.filter(
    (pullRequest) =>
      checkRemoteCandidateBinding({
        candidate: input.candidate,
        repository: input.repository,
        expectedRepository: input.expectedRepository,
        pullRequest,
      }).ok,
  );

  if (bound.length > 1) {
    const numbers = bound.map((pullRequest) => pullRequest.number);
    return {
      kind: "AMBIGUOUS",
      reason: `${bound.length} pull requests bind to ${input.candidate.headSha} (#${numbers.join(", #")}); ambiguous remote state is refused rather than resolved by choosing one`,
      numbers,
    };
  }
  if (bound.length === 1) {
    return { kind: "ADOPT", pullRequest: bound[0]! };
  }
  if (input.pullRequests.length === 0) {
    return {
      kind: "ABSENT",
      reason: `no pull request exists for ${input.candidate.headRef} on ${input.expectedRepository}`,
    };
  }
  /**
   * Pull requests exist but none bind. The FIRST refusal is reported verbatim,
   * because "pull request #7 now points at B but A was reviewed" is the fact
   * the operator needs — a generic "none matched" would discard it.
   */
  const first = checkRemoteCandidateBinding({
    candidate: input.candidate,
    repository: input.repository,
    expectedRepository: input.expectedRepository,
    pullRequest: input.pullRequests[0],
  });
  return {
    kind: "UNBINDABLE",
    reason: first.ok
      ? "a pull request bound and was then filtered out, which cannot happen"
      : first.reason,
  };
}

export function checkRemoteCandidateBinding(input: {
  readonly candidate: ReviewedCandidate;
  readonly repository: RemoteRepository;
  readonly expectedRepository: string;
  readonly pullRequest: RemotePullRequest | undefined;
}): BindingVerdict {
  const { candidate, repository, pullRequest } = input;

  if (repository.nameWithOwner !== input.expectedRepository) {
    return refuse(
      `the remote reports repository ${JSON.stringify(repository.nameWithOwner)} but this action expects ${JSON.stringify(input.expectedRepository)}`,
    );
  }
  if (pullRequest === undefined) {
    return refuse(`no pull request exists for ${candidate.headRef}, so there is no remote state to bind to`);
  }
  if (!isCommitSha(pullRequest.headSha) || !isCommitSha(pullRequest.baseSha)) {
    return refuse(
      `the pull request did not report full commit ids (head ${JSON.stringify(pullRequest.headSha)}, base ${JSON.stringify(pullRequest.baseSha)})`,
    );
  }
  /**
   * THE HEAD MOVED. This is the case the whole module exists for: PR #7 was
   * reviewed at commit A, someone pushed B, and the acceptance for A must not
   * silently become an acceptance for B. The PR number is unchanged throughout,
   * which is precisely why the number cannot be the identity.
   */
  if (pullRequest.headSha !== candidate.headSha) {
    return refuse(
      `pull request #${pullRequest.number} now points at ${pullRequest.headSha} but ${candidate.headSha} was reviewed; an acceptance does not transfer to a commit nobody examined`,
    );
  }
  if (pullRequest.baseRef !== candidate.baseRef) {
    return refuse(
      `pull request #${pullRequest.number} targets ${pullRequest.baseRef} but the candidate was reviewed against ${candidate.baseRef}`,
    );
  }
  if (pullRequest.baseSha !== candidate.baseSha) {
    return refuse(
      `pull request #${pullRequest.number} is based on ${pullRequest.baseSha} but the candidate was reviewed against ${candidate.baseSha}`,
    );
  }
  /**
   * A merged or closed pull request is not a place to integrate from. Reopening
   * one is a human decision about intent, not a state this function may infer.
   */
  if (pullRequest.state !== "OPEN") {
    return refuse(`pull request #${pullRequest.number} is ${pullRequest.state}, not OPEN`);
  }
  return { ok: true };
}

/**
 * Whether CI evidence says anything about THIS candidate (AC-4).
 *
 * Separate from the binding above because the two failures are different facts:
 * "the remote moved" and "the evidence is about a different commit" need
 * different words in front of a human.
 */
/**
 * Whether a check status is INTERNALLY COHERENT (round-7 review, HIGH 3).
 *
 * Distinct from `checkCheckEvidence`, which asks whether the status is a PASS.
 * This asks a smaller and earlier question — is this a thing that could have
 * happened? — because the recorder must write `NO_CHECKS_CONFIGURED (0)`, which
 * is a legitimate fact and not a pass, while refusing `SUCCESS (0)`,
 * `NO_CHECKS_CONFIGURED (3)` and a conclusion that is not a conclusion.
 *
 * The reviewer's point is that a hash-linked append-only chain makes whatever
 * it records permanent AND credible, so nonsense recorded there is worse than
 * nonsense discarded. `CheckConclusion` is a compile-time type and the adapter
 * parses untrusted remote text, so the membership test has to exist at runtime.
 */
export function checkStatusCoherent(checks: RemoteCheckStatus): BindingVerdict {
  if (!isCommitSha(checks.sha)) {
    return refuse(`the check status did not name a full commit id (${JSON.stringify(checks.sha)})`);
  }
  if (!(CHECK_CONCLUSIONS as readonly string[]).includes(checks.conclusion)) {
    return refuse(
      `${JSON.stringify(String(checks.conclusion))} is not a check conclusion this Factory recognises`,
    );
  }
  if (!Number.isSafeInteger(checks.total) || checks.total < 0) {
    return refuse(
      `the check status counted ${JSON.stringify(checks.total)} checks, which is not a count`,
    );
  }
  /**
   * The two contradictions that would otherwise read as evidence: a success
   * that counted nothing, and an absence of checks that counted some.
   */
  if (checks.conclusion === "SUCCESS" && checks.total === 0) {
    return refuse(`the check status claims SUCCESS for ${checks.sha} but counted no checks`);
  }
  if (checks.conclusion === "NO_CHECKS_CONFIGURED" && checks.total !== 0) {
    return refuse(
      `the check status claims no checks are configured for ${checks.sha} but counted ${checks.total}`,
    );
  }
  return { ok: true };
}

export function checkCheckEvidence(input: {
  readonly candidate: ReviewedCandidate;
  readonly checks: RemoteCheckStatus | undefined;
}): BindingVerdict {
  const { candidate, checks } = input;

  if (checks === undefined) {
    return refuse(`no check status was retrieved for ${candidate.headSha}`);
  }
  if (!isCommitSha(checks.sha)) {
    return refuse(`the check status did not name a full commit id (${JSON.stringify(checks.sha)})`);
  }
  /**
   * EVIDENCE IS BOUND OR IT IS NOT EVIDENCE. A green run against some other
   * commit is not a weaker form of proof about this one; it is not about this
   * one at all.
   */
  if (checks.sha !== candidate.headSha) {
    return refuse(
      `the check status describes ${checks.sha} but the candidate is ${candidate.headSha}; a result for another commit is not evidence about this one`,
    );
  }
  /**
   * ABSENCE IS NOT SUCCESS. This repository has no workflows, so this is the
   * value it produces today — and the temptation to read "nothing failed" as
   * "everything passed" is exactly the reading AC-4 forbids.
   *
   * REDUNDANT FOR THE VERDICT, AND SAID SO PLAINLY (round-5 review note). The
   * SUCCESS allowlist below already refuses this value, so deleting this branch
   * changes not WHETHER the candidate is refused but only WHY. It is kept for
   * the reason string, because "no checks are configured" and "the status is
   * not a pass" send an operator to completely different places — and the test
   * asserts the reason rather than merely the refusal. A reader should not
   * mistake this for a second line of defence.
   */
  if (checks.conclusion === "NO_CHECKS_CONFIGURED") {
    return refuse(
      `no checks are configured for ${candidate.headSha}; the absence of a failure is not evidence of a pass`,
    );
  }
  /**
   * SUCCESS IS AN ALLOWLIST, NOT THE ABSENCE OF KNOWN FAILURES (round-1
   * HIGH 4). Enumerating PENDING and FAILURE and accepting everything else let
   * an unrecognised conclusion — a value from a future API, or a malformed
   * one — fall through to a pass. Only the one value that means success is
   * success.
   */
  if (checks.conclusion !== "SUCCESS") {
    return refuse(
      `the check status for ${candidate.headSha} is ${JSON.stringify(String(checks.conclusion))}, which is not a pass`,
    );
  }
  /**
   * A SUCCESS that counted nothing is a contradiction, and contradictions are
   * refused rather than resolved in the permissive direction.
   */
  if (!Number.isSafeInteger(checks.total) || checks.total <= 0) {
    return refuse(
      `the check status for ${candidate.headSha} claims success but counted ${JSON.stringify(checks.total)} checks`,
    );
  }
  return { ok: true };
}

/**
 * Everything that must hold before a candidate may be INTEGRATED.
 *
 * This function is the seam `CLEAN_ROOM_CI` attaches to, and it deliberately
 * does not perform the integration: TASK-016 produces the verdict, a later task
 * consumes it. Keeping the decision separate from the act is what allows the
 * decision to be tested exhaustively without anything being pushed anywhere.
 *
 * `reviewAccepted` is passed IN rather than derived here. Whether an
 * independent reviewer accepted the work is not a fact about GitHub, and a
 * module that reads remote state must not be the place that decides it —
 * C4/C5. What this function enforces is that BOTH facts exist and that both
 * are about the same commit: CI success alone never implies acceptance, and an
 * acceptance alone never implies the remote holds the reviewed tree.
 */
export function checkIntegrationReadiness(input: {
  readonly candidate: ReviewedCandidate;
  readonly repository: RemoteRepository;
  readonly expectedRepository: string;
  readonly pullRequest: RemotePullRequest | undefined;
  readonly checks: RemoteCheckStatus | undefined;
  readonly local: LocalRepositoryState;
  readonly reviewAccepted: boolean;
}): BindingVerdict {
  const preconditions = checkPublishPreconditions({
    candidate: input.candidate,
    local: input.local,
    defaultBranch: input.repository.defaultBranch,
  });
  if (!preconditions.ok) {
    return preconditions;
  }
  const binding = checkRemoteCandidateBinding({
    candidate: input.candidate,
    repository: input.repository,
    expectedRepository: input.expectedRepository,
    pullRequest: input.pullRequest,
  });
  if (!binding.ok) {
    return binding;
  }
  const evidence = checkCheckEvidence({ candidate: input.candidate, checks: input.checks });
  if (!evidence.ok) {
    return evidence;
  }
  if (!input.reviewAccepted) {
    return refuse(
      `no accepted independent review is recorded for ${input.candidate.headSha}; passing checks are not an acceptance`,
    );
  }
  return { ok: true };
}
