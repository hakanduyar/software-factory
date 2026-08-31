/**
 * Publishing one reviewed candidate to GitHub (TASK-016).
 *
 * This module CONNECTS existing capabilities to GitHub. It does not implement,
 * verify or review anything, it creates no plan and no approval, and it has no
 * loop: one call performs at most one push and at most one pull-request
 * creation, then returns. AC-7 is a property of there being nothing else here.
 *
 * The order of operations is the design:
 *
 *   1. local preconditions   — refuse before anything acts
 *   2. observe the target    — in this process, immediately before the gate
 *   3. gate the push         — the verdict is EARNED from that observation
 *   4. push                  — only if the gate cleared it
 *   5. find-or-create the PR — find FIRST, so a re-run adopts rather than duplicates
 *   6. re-bind               — the remote must still describe the reviewed commit
 *
 * Steps 2 and 3 are adjacent on purpose (F4-3): an observation is evidence
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
import type { GitHubClient, GitPusher, GitRepositoryReader } from "./githubPorts.js";
import {
  evaluateFinancialSafety,
  gitPushAction,
  observeRepositoryBilling,
  parseFinancialPolicy,
  type SupervisedAction,
} from "../supervision/financialSafety.js";

export type PublishOutcome =
  | {
      readonly kind: "PUBLISHED";
      readonly pullRequest: RemotePullRequest;
      /** True when this call created the PR; false when it adopted an existing one. */
      readonly created: boolean;
      /** True when this call pushed; false when the remote already held the candidate. */
      readonly pushed: boolean;
      /**
       * CI evidence for the published commit, carried out so the caller can
       * RECORD it (AC-4). Retrieved after the remote settled, and `undefined`
       * only when the status could not be read — which the record states as its
       * own fact rather than as an absence of checks.
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
  readonly pusher: GitPusher;
  /** `owner/name` this action is permitted to touch. */
  readonly expectedRepository: string;
  readonly expectedRemoteUrl: string;
  /** The supervisor's stored policy, parsed by the same strict parser as everywhere else. */
  readonly financialPolicy: unknown;
}

/** Reads the local repository into the shape the pure checks consume. */
export async function readLocalState(
  git: GitRepositoryReader,
  baseRef: string,
): Promise<LocalRepositoryState | undefined> {
  const [remoteUrl, headSha, baseSha, clean] = await Promise.all([
    git.remoteUrl(),
    git.revision("HEAD"),
    git.revision(`origin/${baseRef}`),
    git.isClean(),
  ]);
  if (headSha === undefined || baseSha === undefined) {
    return undefined;
  }
  return { remoteUrl, headSha, baseSha, clean };
}

export async function publishCandidate(
  deps: PublishDeps,
  candidate: ReviewedCandidate,
): Promise<PublishOutcome> {
  if (!isCommitSha(candidate.headSha)) {
    return { kind: "REFUSED", reason: "the candidate does not name a full commit id" };
  }

  const local = await readLocalState(deps.git, candidate.baseRef);
  if (local === undefined) {
    return { kind: "REFUSED", reason: `HEAD or origin/${candidate.baseRef} could not be resolved to a commit` };
  }
  const preconditions = checkPublishPreconditions({
    candidate,
    local,
    expectedRemoteUrl: deps.expectedRemoteUrl,
  });
  if (!preconditions.ok) {
    return { kind: "REFUSED", reason: preconditions.reason };
  }

  const repository = await deps.github.repository();
  if (repository.nameWithOwner !== deps.expectedRepository) {
    return {
      kind: "REFUSED",
      reason: `the remote reports ${JSON.stringify(repository.nameWithOwner)} but this action expects ${JSON.stringify(deps.expectedRepository)}`,
    };
  }

  /**
   * IS THE PUSH EVEN NEEDED? Asked before the gate, because the cheapest way
   * to stay inside a zero-spend policy is not to perform a remote write at
   * all. An existing PR already pointing at the candidate means the remote
   * holds this exact commit.
   */
  const existing = await deps.github.findPullRequest(candidate.headRef);
  const alreadyPublished = existing !== undefined && existing.headSha === candidate.headSha;

  let pushed = false;
  if (!alreadyPublished) {
    /**
     * OBSERVED HERE, IN THIS PROCESS, IMMEDIATELY BEFORE THE GATE (AC-2). The
     * repository row above was fetched moments ago by this same call; nothing
     * persisted contributes to this decision.
     */
    const observation = observeRepositoryBilling({
      target: repository.nameWithOwner,
      visibility: repository.visibility,
      billableIntegrations: repository.billableIntegrations,
    });
    const action = gitPushAction({
      target: repository.nameWithOwner,
      observation,
      description: `publish ${candidate.roadmapKey} candidate ${candidate.headSha} to ${candidate.headRef}`,
    });
    const verdict = evaluateFinancialSafety(action, parseFinancialPolicy(deps.financialPolicy));
    if (!verdict.allowed) {
      return {
        kind: "HUMAN_REQUIRED",
        action,
        reason: `${verdict.humanActionRequired} Failing target: ${repository.nameWithOwner}.`,
      };
    }
    await deps.pusher.pushFastForward({ branch: candidate.headRef, sha: candidate.headSha });
    pushed = true;
  }

  /**
   * FIND BEFORE CREATE (AC-5). `existing` was read before the push; re-reading
   * after it is what makes an interrupted run safe — a previous attempt may
   * have created the PR and died before recording it, and creating a second
   * one would leave two lifecycles for one work item.
   */
  const found = existing ?? (await deps.github.findPullRequest(candidate.headRef));
  let pullRequest: RemotePullRequest;
  let created = false;
  if (found === undefined) {
    pullRequest = await deps.github.createPullRequest({
      headRef: candidate.headRef,
      baseRef: candidate.baseRef,
      title: `${candidate.roadmapKey}: ${candidate.headSha.slice(0, 12)}`,
      /**
       * The body carries IDENTITY, not conclusions. It states which commit is
       * proposed and against which base; it does not claim the work is
       * accepted, because a PR body is not an acceptance and this module is
       * not the thing that decides one.
       */
      body: [
        `Roadmap item: ${candidate.roadmapKey}`,
        `Candidate commit: ${candidate.headSha}`,
        `Reviewed against base: ${candidate.baseSha} (${candidate.baseRef})`,
        "",
        "Acceptance is recorded by the Factory's independent review process, not by this pull request.",
      ].join("\n"),
    });
    created = true;
  } else {
    pullRequest = found;
  }

  /**
   * RE-BIND AFTER ACTING. Everything above could have been true while the
   * remote moved underneath it, and the answer this function returns is about
   * the remote as it is NOW. Cheap, and it closes the window between the push
   * and the record.
   */
  const rebound = checkRemoteCandidateBinding({
    candidate,
    repository,
    expectedRepository: deps.expectedRepository,
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

  return { kind: "PUBLISHED", pullRequest, created, pushed, checks };
}
