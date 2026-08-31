/**
 * The narrow remote surface TASK-016 needs, and deliberately nothing more.
 *
 * Every method returns SHA-bound facts (see `candidateBinding.ts`), and there
 * is no method for anything the frozen criteria scope out: no merge, no
 * repository settings, no visibility change, no branch deletion, no force
 * push. A capability that does not exist cannot be reached by mistake, which is
 * a stronger guarantee than one guarded by a check.
 *
 * THERE IS NO PUSH HERE EITHER, and that is a finding rather than an omission
 * (round-4 review, finding 1). Three consecutive rounds each demonstrated a new
 * way for git to write somewhere other than the destination this process
 * observed — a second `remote.pushurl`, then `url.*.insteadOf`, then
 * `url.*.pushInsteadOf` and HTTP redirects. All of them resolve at push time,
 * so binding the destination means predicting git's resolution rather than
 * observing it. The reviewer's words were that this "blocks safely retaining
 * the write path", so the write path is gone.
 *
 * A branch reaches the remote through the repository agent under ADR-0002,
 * which is governance rather than this runtime gate. What remains here is a
 * pull request created through `gh --repo owner/name`, whose destination is the
 * argument itself and carries no git-config indirection at all.
 */

import type { RemoteCheckStatus, RemotePullRequest, RemoteRepository } from "./candidateBinding.js";
import type { RemoteWriteAuthorization } from "../supervision/financialSafety.js";

/** Reads the LOCAL repository. Separate port: local git is not GitHub. */
export interface GitRepositoryReader {
  /** Full 40-hex id for a revision, or `undefined` when it cannot be resolved. */
  revision(rev: string): Promise<string | undefined>;
  /** True only when nothing is modified, staged or untracked. */
  isClean(): Promise<boolean>;
  /** Refreshes remote-tracking refs, so `origin/<base>` is not a stale answer. */
  fetch(): Promise<void>;
  /**
   * `owner/name` that the local `origin` remote actually points at, or
   * `undefined` when it is absent or is not a GitHub repository URL.
   *
   * REQUIRED BY AC-8, and missing until the round-7 review said so. The base a
   * candidate is measured against is read from `origin/<base>`, so an `origin`
   * pointing somewhere unexpected means the ancestry, the base SHA and the
   * "has the base moved" check were all computed against a repository nobody
   * verified — while the `gh` client addressed the right one and agreed.
   *
   * The URL is PARSED in the adapter, because parsing remote text is what
   * adapters are for; the comparison happens in the core, because deciding what
   * is expected is not the adapter's business.
   */
  originTarget(): Promise<string | undefined>;
  /** True when `ancestor` is reachable from `descendant`. */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  /**
   * Whether the candidate ADDS workflow files relative to its base;
   * `undefined` when unknown.
   *
   * Still observed with no push in play: opening a pull request raises
   * `pull_request` events, and a workflow the candidate introduces can run on
   * them.
   */
  addsWorkflows(baseSha: string, headSha: string): Promise<boolean | undefined>;
  /**
   * Whether the candidate tracks any content through Git LFS; `undefined` when
   * it could not be established.
   *
   * LFS storage and bandwidth are metered even on public repositories. Kept as
   * an observed fact rather than dropped with the push (round-8 review,
   * finding 3): it feeds the liability channel a human reads before deciding.
   */
  usesLfs(headSha: string): Promise<boolean | undefined>;
}

export interface GitHubClient {
  /** Repository identity plus the facts the liability report is derived from. */
  repository(): Promise<RemoteRepository>;
  /**
   * The commit a remote branch points at, or `undefined` when it does not
   * exist.
   *
   * This is what replaced predicting where a push would go: rather than proving
   * a write will reach the right repository, publication proves the repository
   * ALREADY holds the exact candidate. Verification instead of prediction.
   */
  branchSha(branch: string): Promise<string | undefined>;
  /**
   * EVERY pull request the remote reports for `headRef`, in the order given.
   *
   * A LIST rather than an Option (AC-5 amended, 9). Returning one pull request
   * forced the adapter to decide what "the" pull request was, and it decided
   * badly: it threw when several were open, and picked `parsed[0]` when none
   * were. Both are answers to a question the adapter has no standing to
   * answer. `selectAdoptablePullRequest` decides, purely, and fails closed on
   * ambiguity instead of resolving it.
   */
  listPullRequests(headRef: string): Promise<readonly RemotePullRequest[]>;
  /**
   * Creates a pull request and returns it.
   *
   * REQUIRES PROOF THAT THE GATE ALLOWED IT (round-6 review, finding 1).
   * Exporting a client with a write method exported a way to write without
   * passing the gate, wherever that client was constructed. The authorization
   * can only be obtained from `authorizeRemoteWrite`, which mints one only on
   * an ALLOWED verdict it computed itself — so this method cannot be reached
   * by a caller that skipped the gate, rather than merely being expected not
   * to be.
   *
   * Callers must still call `findPullRequest` first: this method does not
   * de-duplicate, because a client that silently returned an existing PR would
   * make the idempotence AC-5 depends on untestable at the level where it
   * actually matters.
   */
  createPullRequest(
    input: {
      readonly headRef: string;
      readonly baseRef: string;
      readonly title: string;
      readonly body: string;
    },
    authorization: RemoteWriteAuthorization,
  ): Promise<RemotePullRequest>;
  /** Check status for one commit, always carrying the sha it describes. */
  checkStatus(sha: string): Promise<RemoteCheckStatus>;
}
