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
 *   1. fetch                 — so the base is not a stale local answer
 *   2. local preconditions   — refuse before anything acts, ancestry included
 *   3. derive the target     — from the URL git will ACTUALLY push to
 *   4. observe that target   — in this process, immediately before the gate
 *   5. gate the push         — the verdict is EARNED from that observation
 *   6. push                  — only if the gate cleared it
 *   7. find-or-create the PR — find FIRST; a create conflict ADOPTS
 *   8. re-bind               — the remote must still describe the reviewed commit
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
import type { GitHubClient, GitPusher, GitRepositoryReader } from "./githubPorts.js";
import {
  evaluateFinancialSafety,
  gitPushAction,
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
      /** True when this call pushed; false when the remote already held the candidate. */
      readonly pushed: boolean;
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
  readonly pusher: GitPusher;
  /**
   * `owner/name` this action is permitted to touch. An EXPECTATION that the
   * derived target must match — never the source of the target itself.
   */
  readonly expectedRepository: string;
  /** The URL git must be about to push to, asserted by the caller. */
  readonly expectedPushUrl: string;
  /** Derives `owner/name` from a push URL; `undefined` when it is not GitHub. */
  readonly targetFromUrl: (url: string) => string | undefined;
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
  const [pushUrls, headSha, baseSha, clean] = await Promise.all([
    git.pushUrls(),
    git.revision("HEAD"),
    git.revision(`origin/${candidate.baseRef}`),
    git.isClean(),
  ]);
  if (headSha === undefined || baseSha === undefined) {
    return { ok: false, reason: `HEAD or origin/${candidate.baseRef} could not be resolved to a commit` };
  }
  /**
   * EXACTLY ONE DESTINATION, or there is no single thing to observe
   * (round-2 CRITICAL 1). `git push origin` writes to EVERY configured
   * `pushurl`, so more than one means the gate would inspect one repository
   * while the push also reached another. Refused with its own reason rather
   * than folded into "could not resolve": a wrong explanation of a correct
   * refusal is its own defect.
   */
  if (pushUrls.length !== 1) {
    return {
      ok: false,
      reason:
        pushUrls.length === 0
          ? "no push URL is configured for origin"
          : `origin has ${pushUrls.length} push URLs, so a push writes to more than one destination and no single target can be observed`,
    };
  }
  const baseIsAncestorOfHead = await git
    .isAncestor(baseSha, headSha)
    .catch(() => undefined);
  return { ok: true, state: { pushUrl: pushUrls[0]!, headSha, baseSha, clean, baseIsAncestorOfHead } };
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
    expectedPushUrl: deps.expectedPushUrl,
    defaultBranch: repository.defaultBranch,
  });
  if (!preconditions.ok) {
    return { kind: "REFUSED", reason: preconditions.reason };
  }

  /**
   * THE TARGET IS DERIVED FROM WHERE THE PUSH WILL GO (round-1 CRITICAL 1).
   *
   * `expectedRepository` and `expectedPushUrl` were two independent
   * caller-supplied strings, so a URL for one repository could be paired with
   * the NAME of another — earning a free verdict from a repository that would
   * never be written to. The identity now comes from the push URL itself, and
   * the caller's expectation is checked against it rather than trusted as it.
   */
  const target = deps.targetFromUrl(local.pushUrl);
  if (target === undefined) {
    return { kind: "REFUSED", reason: `the push URL ${JSON.stringify(local.pushUrl)} is not a GitHub repository URL` };
  }
  if (target !== deps.expectedRepository) {
    return {
      kind: "REFUSED",
      reason: `git would push to ${target} but this action expects ${deps.expectedRepository}`,
    };
  }

  /**
   * And the repository we OBSERVED must be the one we will WRITE to. Without
   * this the gate could inspect a safe repository while the push went
   * elsewhere — which is the same defect one level up.
   */
  if (repository.nameWithOwner !== target) {
    return {
      kind: "REFUSED",
      reason: `the observed repository is ${JSON.stringify(repository.nameWithOwner)} but the push target is ${JSON.stringify(target)}`,
    };
  }

  /**
   * WHAT, IF ANYTHING, WOULD THIS CALL WRITE?
   *
   * Asked before the gate, because the cheapest way to stay inside a
   * zero-spend policy is to perform no remote write at all. Two independent
   * facts, and conflating them was a defect: the BRANCH already holding the
   * candidate is what makes a push unnecessary, while a PULL REQUEST existing
   * is what makes a creation unnecessary. A branch pushed by some other
   * authorised process — the ADR-0002 repository agent, say — means this call
   * needs no push even though no pull request exists yet.
   */
  const [remoteBranchSha, existing] = await Promise.all([
    deps.github.branchSha(candidate.headRef),
    deps.github.findPullRequest(candidate.headRef),
  ]);
  const needsPush = remoteBranchSha !== candidate.headSha;
  const needsCreate = existing === undefined;

  /**
   * ONE GATE FOR ANY REMOTE WRITE.
   *
   * Both writes this module can perform — the push and the pull-request
   * creation — reach GitHub through the same channels, so they are authorised
   * together or not at all. A second, narrower gate for creation would be the
   * "no shortcut for a sibling" mistake this codebase keeps finding.
   *
   * OBSERVED HERE, IN THIS PROCESS, IMMEDIATELY BEFORE THE GATE (AC-2),
   * including what THIS CANDIDATE would introduce: workflows it adds could
   * trigger the run they define, and LFS rules it adds turn the push into
   * metered transfer, so the target's current state is not sufficient alone.
   */
  if (needsPush || needsCreate) {
    const [addsWorkflows, addsLfs] = await Promise.all([
      deps.git.addsWorkflows(candidate.baseSha, candidate.headSha).catch(() => undefined),
      deps.git.addsLfs(candidate.baseSha, candidate.headSha).catch(() => undefined),
    ]);
    const observation = observePushLiability({
      target,
      visibility: repository.visibility,
      ownerType: repository.ownerType,
      repositoryWebhooks: repository.repositoryWebhooks,
      configuredWorkflows: repository.configuredWorkflows,
      candidateAddsWorkflows: addsWorkflows,
      candidateAddsLfs: addsLfs,
    });
    const action = gitPushAction({
      target,
      observation,
      description: `publish ${candidate.roadmapKey} candidate ${candidate.headSha} to ${candidate.headRef}`,
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

  let pushed = false;
  if (needsPush) {
    // The URL that was OBSERVED is the URL that is WRITTEN — no remote name in
    // between that git could resolve differently (round-2 CRITICAL 1).
    await deps.pusher.pushFastForward({
      url: local.pushUrl,
      branch: candidate.headRef,
      sha: candidate.headSha,
    });
    pushed = true;
  }

  /**
   * FIND BEFORE CREATE (AC-5), AND LET THE REMOTE BE THE ARBITER.
   *
   * Re-reading after the push is what makes an interrupted run safe: a
   * previous attempt may have created the PR and died before recording it.
   *
   * ROUND-1 REVIEW, HIGH 5. Find-then-create is not atomic, so two concurrent
   * runs could both find nothing and both create. The serialization point that
   * actually exists is GITHUB: it refuses a second open pull request for the
   * same head and base. So a failed creation is not assumed fatal — it is
   * followed by a re-find, and an existing PR is ADOPTED. The race therefore
   * ends with one pull request and one of the two runs reporting `created`.
   * (The push itself is idempotent: two pushes of the same sha to the same ref
   * leave the ref at that sha.)
   */
  const found = existing ?? (await deps.github.findPullRequest(candidate.headRef));
  let pullRequest: RemotePullRequest;
  let created = false;
  if (found === undefined) {

    try {
      pullRequest = await deps.github.createPullRequest({
        headRef: candidate.headRef,
        baseRef: candidate.baseRef,
        title: `${candidate.roadmapKey}: ${candidate.headSha.slice(0, 12)}`,
        /**
         * The body carries IDENTITY, not conclusions. It states which commit
         * is proposed and against which base; it does not claim the work is
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
    } catch (error) {
      const adopted = await deps.github.findPullRequest(candidate.headRef);
      if (adopted === undefined) {
        return {
          kind: "REFUSED",
          reason: `creating the pull request failed and none exists: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      pullRequest = adopted;
    }
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

  return { kind: "PUBLISHED", pullRequest, created, pushed, checks };
}
