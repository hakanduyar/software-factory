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
  /** The pull request whose head is `headRef`, or `undefined` when none exists. */
  findPullRequest(headRef: string): Promise<RemotePullRequest | undefined>;
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
