/**
 * A throwaway git-initialized directory for workspace-boundary and CLI
 * worker tests. Mirrors `tempDbPath`/`cleanupTempDbs` in factoryFixtures.ts:
 * every directory created this way is tracked and removed by
 * `cleanupTempWorkspaces()`, which test files must call from an `after()`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureNodeGit } from "./nodeGit.js";

const createdDirs: string[] = [];

export function createTempWorkspace(prefix = "factory-worker-test-"): string {
  /**
   * THE SHIM, THEN GIT (round-21 review, HIGH 3 — AC-12).
   *
   * This called `git init` directly, so with a PATH holding only Node the suite
   * failed 89 tests with `spawnSync git ENOENT`, and AC-12 says no test may
   * require anything installed beyond Node.
   *
   * The answer is not to stop asking git: `assertWorkspace` deliberately proves
   * a workspace is a real repository by asking it, "not merely a `.git`
   * filesystem entry", and a fixture that planted the directory itself would
   * make that guard untestable. So the tests bring a `git` written in Node and
   * put it first on PATH, and everything below is unchanged.
   */
  ensureNodeGit();
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  return dir;
}

export function cleanupTempWorkspaces(): void {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
