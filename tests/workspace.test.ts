/**
 * `resolveWorkspace` (src/adapters/workers/workspace.ts).
 *
 * TASK-003 remediation round 1, MEDIUM finding (independent Codex review,
 * 2026-08-20): the original implementation accepted a workspace merely
 * because `<root>/.git` existed on disk — a directory containing an empty
 * `.git` file/directory, with no real repository behind it, passed. The
 * adversarial cases below (B/C/D) reproduce exactly that gap and prove the
 * fix (real `git rev-parse --show-toplevel` validation via a non-shell
 * child process) closes it, alongside the full case list the remediation
 * asked for (A–I).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

import { resolveWorkspace } from "../src/adapters/workers/workspace.js";
import { ValidationError } from "../src/domain/errors.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./support/tempWorkspace.js";

after(cleanupTempWorkspaces);

const bareDirs: string[] = [];
function createBareTempDir(prefix = "factory-worker-test-nogit-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  bareDirs.push(dir);
  return dir;
}
after(() => {
  while (bareDirs.length > 0) {
    const dir = bareDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveWorkspace", () => {
  it("(A) rejects an ordinary directory with no .git entry at all", () => {
    const dir = createBareTempDir();
    assert.throws(() => resolveWorkspace(dir), ValidationError);
  });

  it("(B) rejects a directory containing an empty `.git` FILE (not a real gitlink)", () => {
    const dir = createBareTempDir();
    writeFileSync(join(dir, ".git"), "");
    assert.throws(() => resolveWorkspace(dir), ValidationError);
  });

  it("(C) rejects a directory containing an empty `.git` DIRECTORY (the exact reviewer reproduction)", () => {
    const dir = createBareTempDir();
    mkdirSync(join(dir, ".git"));
    assert.throws(() => resolveWorkspace(dir), ValidationError);
  });

  it("(D) rejects a directory with a copied/fake `.git` shape that Git itself does not recognize", () => {
    const dir = createBareTempDir();
    mkdirSync(join(dir, ".git"));
    // Looks structurally plausible at a glance, but is not a valid repository
    // (garbage HEAD content, no objects/refs database) — Git must refuse it,
    // not just check that files with these names exist.
    writeFileSync(join(dir, ".git", "HEAD"), "not a valid ref format at all garbage 12345\n");
    writeFileSync(join(dir, ".git", "config"), "[not a real git config]\ngarbage = true\n");
    assert.throws(() => resolveWorkspace(dir), ValidationError);
  });

  it("(E) accepts the root of a real temporary Git repository", () => {
    const dir = createTempWorkspace();
    const workspace = resolveWorkspace(dir);
    assert.equal(workspace.root, resolve(dir));
    assert.equal(workspace.repositoryRoot, resolve(dir));
  });

  it("(F) accepts a subdirectory inside a real Git repository, recording the actual repository root", () => {
    const repoDir = createTempWorkspace();
    const nested = join(repoDir, "nested", "sub");
    mkdirSync(nested, { recursive: true });

    const workspace = resolveWorkspace(nested);

    assert.equal(workspace.root, resolve(nested), "root stays the exact directory the caller configured");
    assert.equal(workspace.repositoryRoot, resolve(repoDir), "repositoryRoot is canonicalized to the real repo root");
  });

  it("(G) rejects a nonexistent path", () => {
    assert.throws(() => resolveWorkspace("/definitely/not/a/real/path/xyz"), ValidationError);
  });

  it("(H) rejects a file path instead of a directory", () => {
    const dir = createTempWorkspace();
    const filePath = join(dir, "not-a-dir.txt");
    writeFileSync(filePath, "hello");
    assert.throws(() => resolveWorkspace(filePath), ValidationError);
  });

  it("(I) works for a workspace path containing spaces and argv-unsafe special characters, without shell interpolation", () => {
    const parent = createBareTempDir("factory-worker-test-special-");
    // Characters that would be dangerous if this path were ever concatenated
    // into a shell command: spaces, quotes, $(), backticks, semicolons.
    const trickyName = `weird dir '"; $(echo pwned) \`echo also-pwned\``;
    const trickyPath = join(parent, trickyName);
    mkdirSync(trickyPath);
    execFileSync("git", ["init", "--quiet"], { cwd: trickyPath });

    const workspace = resolveWorkspace(trickyPath);

    assert.equal(workspace.root, resolve(trickyPath));
    assert.equal(workspace.repositoryRoot, resolve(trickyPath));
  });

  it("allows opting out of the git-repository requirement entirely", () => {
    const dir = createBareTempDir();
    const workspace = resolveWorkspace(dir, { requireGitRepository: false });
    assert.equal(workspace.root, resolve(dir));
    assert.equal(workspace.repositoryRoot, resolve(dir));
  });

  it("wraps a missing git executable as a controlled ValidationError, not a crash", () => {
    const dir = createTempWorkspace();
    assert.throws(() => resolveWorkspace(dir, { gitExecutable: "/definitely/not/a/real/git-binary" }), ValidationError);
  });

  it("bounds and flattens the diagnostic text in the thrown error (no raw multi-line git stderr dump)", () => {
    const dir = createBareTempDir();
    try {
      resolveWorkspace(dir);
      assert.fail("expected resolveWorkspace to throw");
    } catch (error) {
      assert.ok(error instanceof ValidationError);
      assert.ok(!error.message.includes("\n"), "thrown message must be a single line, not raw multi-line stderr");
      assert.ok(error.message.length < 1000, "thrown message must be bounded, not an unbounded dump");
    }
  });
});
