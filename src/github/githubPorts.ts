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
  /**
   * EVERY URL `git push origin` would write to.
   *
   * A list rather than a value because git supports multiple `pushurl`
   * entries and writes to all of them; reporting only the first let the gate
   * approve one destination while the push reached another (round-2
   * CRITICAL 1). The caller refuses anything other than exactly one.
   */
  pushUrls(): Promise<readonly string[]>;
  /** Full 40-hex id for a revision, or `undefined` when it cannot be resolved. */
  revision(rev: string): Promise<string | undefined>;
  /** True only when nothing is modified, staged or untracked. */
  isClean(): Promise<boolean>;
  /** Refreshes remote-tracking refs, so `origin/<base>` is not a stale answer. */
  fetch(): Promise<void>;
  /** True when `ancestor` is reachable from `descendant`. */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  /** Whether this push would ADD workflow files; `undefined` when unknown. */
  addsWorkflows(baseSha: string, headSha: string): Promise<boolean | undefined>;
  /** Whether this push would introduce Git LFS tracking; `undefined` when unknown. */
  addsLfs(baseSha: string, headSha: string): Promise<boolean | undefined>;
}

/** The one WRITE this task performs against a remote. */
export interface GitPusher {
  /**
   * Pushes `sha` to `branch` at `url`, FAST-FORWARD ONLY.
   *
   * The URL is explicit rather than a remote NAME: `origin` is resolved by git
   * config at push time, so a named remote could reach a destination other
   * than the one the gate observed (round-2 CRITICAL 1).
   *
   * There is no force option and no delete option, by construction — ADR-0002
   * lists force push and history rewriting among the things the mandate never
   * authorises, and the safest place to enforce that is an API that cannot
   * express it.
   */
  pushFastForward(input: {
    readonly url: string;
    readonly branch: string;
    readonly sha: string;
  }): Promise<void>;
}

export interface GitHubClient {
  /** Repository identity plus the facts the push report is derived from. */
  repository(): Promise<RemoteRepository>;
  /**
   * The commit a remote branch points at, or `undefined` when it does not
   * exist.
   *
   * Asked so that publication can tell "this branch already holds the
   * candidate" from "a pull request exists". Only the first means no write is
   * needed, and only a publication that needs no write can complete without
   * the financial gate having anything to authorise.
   */
  branchSha(branch: string): Promise<string | undefined>;
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
