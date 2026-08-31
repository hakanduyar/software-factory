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
 * label-shaped fields it does read (`baseRef`, `headRef`) are checked for
 * agreement but are never permitted to stand IN PLACE of a SHA.
 *
 * The refusals here are deliberately boring restatements of that rule. That is
 * the point: a stale acceptance is not an exotic attack, it is what happens by
 * default when a human pushes one more commit while a review is running.
 */

import type { RepositoryVisibility } from "../supervision/financialSafety.js";

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
  /** Repository-level integrations; `undefined` when the count is unknown. */
  readonly billableIntegrations: number | undefined;
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
  /** The `origin` URL, to prove we are talking about the repository we think we are. */
  readonly remoteUrl: string;
  readonly headSha: CommitSha;
  /** Where `origin/<baseRef>` points right now. */
  readonly baseSha: CommitSha;
  /** False when anything is uncommitted, staged or untracked. */
  readonly clean: boolean;
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
  readonly expectedRemoteUrl: string;
}): BindingVerdict {
  const { candidate, local } = input;

  if (!isCommitSha(candidate.headSha) || !isCommitSha(candidate.baseSha)) {
    return refuse(
      `the reviewed candidate does not carry full commit ids (head ${JSON.stringify(candidate.headSha)}, base ${JSON.stringify(candidate.baseSha)}); an abbreviated or absent sha is not an identity`,
    );
  }
  if (!isCommitSha(local.headSha) || !isCommitSha(local.baseSha)) {
    return refuse("the local repository did not report full commit ids for HEAD and the base");
  }
  /**
   * The remote URL is compared before anything else that could act. Pushing to
   * the wrong repository is not recoverable by noticing afterwards, and the
   * comparison costs one string.
   */
  if (local.remoteUrl !== input.expectedRemoteUrl) {
    return refuse(
      `the local 'origin' is ${JSON.stringify(local.remoteUrl)} but this action expects ${JSON.stringify(input.expectedRemoteUrl)}`,
    );
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
   */
  if (checks.conclusion === "NO_CHECKS_CONFIGURED") {
    return refuse(
      `no checks are configured for ${candidate.headSha}; the absence of a failure is not evidence of a pass`,
    );
  }
  if (checks.conclusion === "PENDING") {
    return refuse(`checks for ${candidate.headSha} have not finished`);
  }
  if (checks.conclusion === "FAILURE") {
    return refuse(`checks failed for ${candidate.headSha}`);
  }
  /**
   * A SUCCESS that counted nothing is a contradiction, and contradictions are
   * refused rather than resolved in the permissive direction.
   */
  if (checks.total <= 0) {
    return refuse(`the check status for ${candidate.headSha} claims success but counted ${checks.total} checks`);
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
  readonly expectedRemoteUrl: string;
  readonly reviewAccepted: boolean;
}): BindingVerdict {
  const preconditions = checkPublishPreconditions({
    candidate: input.candidate,
    local: input.local,
    expectedRemoteUrl: input.expectedRemoteUrl,
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
