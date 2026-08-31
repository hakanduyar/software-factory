/**
 * The narrow remote surface TASK-016 needs, and deliberately nothing more.
 *
 * Every method returns SHA-bound facts (see `candidateBinding.ts`), and there
 * is no method for anything the frozen criteria scope out: no merge, no
 * repository settings, no visibility change, no branch deletion, no force
 * push. A capability that does not exist cannot be reached by mistake, which is
 * a stronger guarantee than one guarded by a check.
 */

import type { RemoteCheckStatus, RemotePullRequest, RemoteRepository } from "./candidateBinding.js";

/** Reads the LOCAL repository. Separate port: local git is not GitHub. */
export interface GitRepositoryReader {
  /** The `origin` push URL. */
  remoteUrl(): Promise<string>;
  /** Full 40-hex id for a revision, or `undefined` when it cannot be resolved. */
  revision(rev: string): Promise<string | undefined>;
  /** True only when nothing is modified, staged or untracked. */
  isClean(): Promise<boolean>;
}

/** The one WRITE this task performs against a remote. */
export interface GitPusher {
  /**
   * Pushes `sha` to `branch` on `origin`, FAST-FORWARD ONLY.
   *
   * There is no force option and no delete option, by construction — ADR-0002
   * lists force push and history rewriting among the things the mandate never
   * authorises, and the safest place to enforce that is an API that cannot
   * express it.
   */
  pushFastForward(input: { readonly branch: string; readonly sha: string }): Promise<void>;
}

export interface GitHubClient {
  /** Repository identity plus the two facts the push verdict is derived from. */
  repository(): Promise<RemoteRepository>;
  /** The pull request whose head is `headRef`, or `undefined` when none exists. */
  findPullRequest(headRef: string): Promise<RemotePullRequest | undefined>;
  /**
   * Creates a pull request and returns it.
   *
   * Callers must call `findPullRequest` first: this method does not
   * de-duplicate, because a client that silently returned an existing PR would
   * make the idempotence AC-5 depends on untestable at the level where it
   * actually matters.
   */
  createPullRequest(input: {
    readonly headRef: string;
    readonly baseRef: string;
    readonly title: string;
    readonly body: string;
  }): Promise<RemotePullRequest>;
  /** Check status for one commit, always carrying the sha it describes. */
  checkStatus(sha: string): Promise<RemoteCheckStatus>;
}
