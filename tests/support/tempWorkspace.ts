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

const createdDirs: string[] = [];

export function createTempWorkspace(prefix = "factory-worker-test-"): string {
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
