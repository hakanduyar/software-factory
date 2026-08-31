/**
 * Publishing one reviewed candidate to GitHub (TASK-016).
 *
 * This module CONNECTS existing capabilities to GitHub. It does not implement,
 * verify or review anything, it creates no plan and no approval, and it has no
 * loop: one call performs at most one pull-request creation, then returns.
 * AC-7 is a property of there being nothing else here.
 *
 * IT DOES NOT PUSH (round-4 review, finding 1). Three consecutive rounds each
 * found a new way for git to write somewhere other than the destination this
 * process observed — a second `remote.pushurl`, then `url.*.insteadOf`, then
 * `url.*.pushInsteadOf` and HTTP redirects — all resolved at push time. So
 * instead of PREDICTING where a write would land, publication VERIFIES that the
 * remote already holds the exact candidate, and refuses when it does not. A
 * branch reaches the remote through the repository agent under ADR-0002.
 *
 * The order of operations is the design:
 *
 *   1. fetch                 — so the base is not a stale local answer
 *   2. local preconditions   — refuse before anything acts, ancestry included
 *   3. verify the remote     — the branch must already hold this candidate
 *   4. observe the target    — in this process, immediately before the gate
 *   5. gate the write        — creating a pull request is a remote write
 *   6. find-or-create the PR — find FIRST; a create conflict ADOPTS
 *   7. re-bind               — RE-READ the remote; the snapshot from step 3 is
 *                              older than the write and cannot describe it
 *
 * Steps 4 and 5 are adjacent on purpose (F4-3): an observation is evidence
 * about a moment, and a gate consulting a stale one is deciding about the past.
 */

import {
  checkPublishPreconditions,
  checkRemoteCandidateBinding,
  isCommitSha,
  type LocalRepositoryState,
  type RemoteCheckStatus,
  type RemotePullRequest,
  type ReviewedCandidate,
} from "./candidateBinding.js";
import type { GitHubClient, GitRepositoryReader } from "./githubPorts.js";
import {
  evaluateFinancialSafety,
  createPullRequestAction,
  observePushLiability,
  parseFinancialPolicy,
  type SupervisedAction,
} from "../supervision/financialSafety.js";

export type PublishOutcome =
  | {
      readonly kind: "PUBLISHED";
      readonly pullRequest: RemotePullRequest;
      /** True when this call created the PR; false when it adopted an existing one. */
      readonly created: boolean;
      /**
       * CI evidence for the published commit, carried out so the caller can
       * RECORD it (AC-4). `undefined` only when the status could not be read —
       * which the record states as its own fact rather than as "no checks".
       */
      readonly checks: RemoteCheckStatus | undefined;
    }
  | { readonly kind: "REFUSED"; readonly reason: string }
  /**
   * A human must decide. Carries the ACTION that was refused, so the caller
   * escalates the same object the gate judged rather than a description of it.
   */
  | { readonly kind: "HUMAN_REQUIRED"; readonly action: SupervisedAction; readonly reason: string };

export interface PublishDeps {
  readonly github: GitHubClient;
  readonly git: GitRepositoryReader;
  /**
   * `owner/name` this action is permitted to touch. An EXPECTATION that the
   * derived target must match — never the source of the target itself.
   */
  readonly expectedRepository: string;
  /** The supervisor's stored policy, parsed by the same strict parser as everywhere else. */
  readonly financialPolicy: unknown;
}

/**
 * Reads the local repository into the shape the pure checks consume.
 *
 * FETCHES FIRST (round-1 HIGH 3): `origin/<base>` is a local cache, and
 * deciding that the base has not moved by consulting a stale copy of it is not
 * a check. `GIT_FETCH` is free-but-remote in the effects table and triggers
 * nothing on the far side.
 */
export type LocalStateResult =
  | { readonly ok: true; readonly state: LocalRepositoryState }
  | { readonly ok: false; readonly reason: string };

export async function readLocalState(
  git: GitRepositoryReader,
  candidate: ReviewedCandidate,
): Promise<LocalStateResult> {
  await git.fetch();
  const [headSha, baseSha, clean] = await Promise.all([
    git.revision("HEAD"),
    git.revision(`origin/${candidate.baseRef}`),
    git.isClean(),
  ]);
  if (headSha === undefined || baseSha === undefined) {
    return { ok: false, reason: `HEAD or origin/${candidate.baseRef} could not be resolved to a commit` };
  }
  const baseIsAncestorOfHead = await git.isAncestor(baseSha, headSha).catch(() => undefined);
  return { ok: true, state: { headSha, baseSha, clean, baseIsAncestorOfHead } };
}

/**
 * Find-or-create-or-adopt for one candidate's pull request (AC-5).
 *
 * EXTRACTED AS ITS OWN SEAM (round-3 HIGH 3). With every remote write refused,
 * this logic was never executed by any test — `publishCandidate` stops at the
 * gate first, so the create/adopt behaviour the frozen AC-5 describes had no
 * positive demonstration at all, only a proof that the race cannot begin.
 *
 * Extracting it changes nothing about the production gate: `publishCandidate`
 * still refuses before reaching here. What it buys is that the BEHAVIOUR can be
 * exercised directly, so "creates when none exists", "adopts an existing one"
 * and "adopts the winner of a creation race" are demonstrated rather than
 * asserted in a comment.
 *
 * FIND BEFORE CREATE, and let the remote arbitrate: GitHub refuses a second
 * open pull request for the same head and base, so a failed creation is
 * followed by a re-find and an existing pull request is adopted. A failure with
 * no pull request afterwards stays a failure — adoption must not swallow real
 * errors.
 */
export async function ensurePullRequest(
  github: GitHubClient,
  candidate: ReviewedCandidate,
  known?: RemotePullRequest,
): Promise<
  | { readonly ok: true; readonly pullRequest: RemotePullRequest; readonly created: boolean }
  | { readonly ok: false; readonly reason: string }
> {
  const found = known ?? (await github.findPullRequest(candidate.headRef));
  if (found !== undefined) {
    return { ok: true, pullRequest: found, created: false };
  }
  try {
    const pullRequest = await github.createPullRequest({
      headRef: candidate.headRef,
      baseRef: candidate.baseRef,
      title: `${candidate.roadmapKey}: ${candidate.headSha.slice(0, 12)}`,
      /**
       * The body carries IDENTITY, not conclusions. It states which commit is
       * proposed and against which base; it does not claim the work is
       * accepted, because a pull-request body is not an acceptance and this
       * module is not the thing that decides one.
       */
      body: [
        `Roadmap item: ${candidate.roadmapKey}`,
        `Candidate commit: ${candidate.headSha}`,
        `Reviewed against base: ${candidate.baseSha} (${candidate.baseRef})`,
        "",
        "Acceptance is recorded by the Factory's independent review process, not by this pull request.",
      ].join("\n"),
    });
    return { ok: true, pullRequest, created: true };
  } catch (error) {
    const adopted = await github.findPullRequest(candidate.headRef);
    if (adopted === undefined) {
      return {
        ok: false,
        reason: `creating the pull request failed and none exists: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return { ok: true, pullRequest: adopted, created: false };
  }
}

export async function publishCandidate(
  deps: PublishDeps,
  candidate: ReviewedCandidate,
): Promise<PublishOutcome> {
  if (!isCommitSha(candidate.headSha)) {
    return { kind: "REFUSED", reason: "the candidate does not name a full commit id" };
  }

  const read = await readLocalState(deps.git, candidate);
  if (!read.ok) {
    return { kind: "REFUSED", reason: read.reason };
  }
  const local = read.state;

  /**
   * The repository is fetched BEFORE the preconditions, because the default
   * branch is one of them: publication may never write it (round-2 HIGH 3),
   * and that must be refused before anything acts.
   */
  const repository = await deps.github.repository();
  const preconditions = checkPublishPreconditions({
    candidate,
    local,
    defaultBranch: repository.defaultBranch,
  });
  if (!preconditions.ok) {
    return { kind: "REFUSED", reason: preconditions.reason };
  }

  /**
   * THE TARGET IS THE REPOSITORY THE CLIENT ADDRESSES.
   *
   * `gh --repo owner/name` has no git-config indirection: the destination is
   * the argument. That is why removing the push removed an entire class of
   * defect rather than one more layer of it — there is nothing left to predict.
   * What remains to check is that the repository answering is the one this
   * action is permitted to touch.
   */
  const target = repository.nameWithOwner;
  if (target !== deps.expectedRepository) {
    return {
      kind: "REFUSED",
      reason: `the remote reports ${JSON.stringify(target)} but this action expects ${JSON.stringify(deps.expectedRepository)}`,
    };
  }

  /**
   * THE REMOTE MUST ALREADY HOLD THIS CANDIDATE.
   *
   * Verification instead of prediction: rather than proving where a push would
   * land, publication requires that the branch on the remote is ALREADY the
   * reviewed commit. If it is not, this call refuses and says so — getting the
   * branch there is the repository agent's job under ADR-0002, not the
   * Factory's.
   */
  const [remoteBranchSha, existing] = await Promise.all([
    deps.github.branchSha(candidate.headRef),
    deps.github.findPullRequest(candidate.headRef),
  ]);
  if (remoteBranchSha !== candidate.headSha) {
    return {
      kind: "REFUSED",
      reason:
        remoteBranchSha === undefined
          ? `${candidate.headRef} does not exist on ${target}; publication does not push`
          : `${candidate.headRef} holds ${remoteBranchSha} on ${target} but the candidate is ${candidate.headSha}; publication does not push`,
    };
  }

  /**
   * CREATING A PULL REQUEST IS A REMOTE WRITE, so it is gated — and it is the
   * ONLY write this module can perform, which is what makes one gate
   * sufficient rather than a shortcut.
   *
   * OBSERVED HERE, IN THIS PROCESS, IMMEDIATELY BEFORE THE GATE (AC-2),
   * including what THIS CANDIDATE would introduce: a workflow it adds can run
   * on the `pull_request` event the creation raises.
   */
  const needsCreate = existing === undefined;
  if (needsCreate) {
    const addsWorkflows = await deps.git
      .addsWorkflows(candidate.baseSha, candidate.headSha)
      .catch(() => undefined);
    const observation = observePushLiability({
      target,
      visibility: repository.visibility,
      ownerType: repository.ownerType,
      repositoryWebhooks: repository.repositoryWebhooks,
      configuredWorkflows: repository.configuredWorkflows,
      candidateAddsWorkflows: addsWorkflows,
    });
    const action = createPullRequestAction({
      target,
      observation,
      description: `open a pull request for ${candidate.roadmapKey} candidate ${candidate.headSha}`,
    });
    const verdict = evaluateFinancialSafety(action, parseFinancialPolicy(deps.financialPolicy));
    if (!verdict.allowed) {
      return {
        kind: "HUMAN_REQUIRED",
        action,
        reason: `${verdict.humanActionRequired} Failing target: ${target}. ${action.detail ?? ""}`.trim(),
      };
    }
  }

  /**
   * FIND BEFORE CREATE (AC-5), through the extracted seam.
   *
   * Re-reading after the push is what makes an interrupted run safe: a
   * previous attempt may have created the pull request and died before
   * recording it. The find/create/adopt behaviour itself lives in
   * `ensurePullRequest`, where it can be exercised directly -- round-3 HIGH 3
   * observed that the gate stops publication before this point, so the
   * behaviour had no positive demonstration while it was inline here.
   */
  const ensured = await ensurePullRequest(deps.github, candidate, existing);
  if (!ensured.ok) {
    return { kind: "REFUSED", reason: ensured.reason };
  }
  const created = ensured.created;

  /**
   * RE-BIND AFTER ACTING, FROM A FRESH READ (round-4 review, finding 3).
   *
   * The previous version bound against `existing` — the snapshot taken BEFORE
   * the gate — so a remote whose pull request moved in between was reported at
   * the commit it used to hold. The reviewer's probe made exactly that happen:
   * one find call, remote head B, outcome PUBLISHED reporting A. A snapshot
   * older than the action cannot describe the action, so the answer this
   * function returns comes from asking again.
   *
   * The re-read is also what the RETURNED pull request is built from, so the
   * record and the binding describe one observation rather than two.
   */
  const current = await deps.github.findPullRequest(candidate.headRef);
  if (current === undefined) {
    return {
      kind: "REFUSED",
      reason: `the pull request for ${candidate.headRef} could not be read back after acting`,
    };
  }
  const pullRequest = current;
  const rebound = checkRemoteCandidateBinding({
    candidate,
    repository,
    expectedRepository: target,
    pullRequest,
  });
  if (!rebound.ok) {
    return { kind: "REFUSED", reason: rebound.reason };
  }

  /**
   * The check status is read AFTER the binding holds, and a failure to read it
   * does not fail the publication: the publication succeeded, and "the status
   * could not be retrieved" is a fact to record rather than a reason to
   * pretend the push did not happen. It is deliberately NOT interpreted here —
   * `checkCheckEvidence` is the only thing that decides what a status means.
   */
  let checks: RemoteCheckStatus | undefined;
  try {
    checks = await deps.github.checkStatus(candidate.headSha);
  } catch {
    checks = undefined;
  }

  return { kind: "PUBLISHED", pullRequest, created, checks };
}
