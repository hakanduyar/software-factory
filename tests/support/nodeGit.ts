/**
 * A `git` IMPLEMENTED IN NODE, SO NO TEST NEEDS GIT INSTALLED (AC-12).
 *
 * AC-12 is unqualified: "No test requires network access, a real GitHub Actions
 * run, the real `gh`, or anything installed on the host beyond Node itself."
 * The round-21 review ran the compiled suite with a PATH holding only Node and
 * found 89 failures, all `spawnSync git ENOENT`.
 *
 * They come from a guard that exists on purpose. `assertWorkspace` verifies a
 * workspace is a real repository by asking git — "not merely a `.git`
 * filesystem entry" — so a planted directory cannot satisfy it. That is a
 * security property worth keeping, and it is why the fix is not to stop asking.
 *
 * So the tests bring their own `git`. This writes a small executable that is a
 * Node script, puts it FIRST on `PATH`, and implements exactly the two
 * questions the suite asks:
 *
 *   git init [--quiet]                 create a repository layout
 *   git -C <dir> rev-parse --show-toplevel   answer only for a real one
 *
 * FAITHFUL, NOT PERMISSIVE. `rev-parse` walks upward for a `.git` DIRECTORY and
 * exits non-zero when there is none, so the cases asserting that a planted or
 * absent repository is REFUSED still fail if it answers wrongly. Anything else
 * exits non-zero rather than pretending to succeed.
 *
 * WHAT THIS COSTS, and it is recorded in `docs/KNOWN-LIMITATIONS.md`: the suite
 * now exercises a reimplementation of two git queries rather than git itself.
 * If real git disagrees with this shim about what a repository is, the tests
 * would not notice. The alternative was a suite that cannot run without a host
 * dependency the frozen criteria forbid.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

let installed: string | undefined;

const SHIM = `#!/usr/bin/env node
"use strict";
const { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");

const argv = process.argv.slice(2);
let cwd = process.cwd();
while (argv[0] === "-C") {
  argv.shift();
  cwd = resolve(cwd, argv.shift());
}

/**
 * A repository is a directory holding \`.git\`, at or above here — as a
 * DIRECTORY or as the FILE a linked worktree uses (round-22 review, HIGH 5).
 * Recognising only the directory made this shim stricter than git, so a
 * worktree checkout would have been refused by the suite and accepted in
 * production.
 *
 * \`GIT_DIR\` IS honoured, as real git honours it — and that is the whole point
 * of the shim rather than an accident of it.
 *
 * The first version ignored it, reasoning that \`probeGitRepository\` now strips
 * the variable so the shim need only match the environment production gives
 * git. That reasoning made the production guard UNTESTABLE: with the
 * sanitisation disabled, the shim still refused the directory, so the case
 * asserting the guard passed either way. A mutation removing the sanitisation
 * SURVIVED, which is how it was found.
 *
 * A test double has to model the thing it stands in for, not the thing the
 * caller currently does. Real git with \`GIT_DIR\` set treats the working
 * directory as the work tree, so that is what this reports.
 */
function toplevel(from) {
  /**
   * The environment answers first, exactly as git lets it. probeGitRepository
   * strips these before asking, so seeing one here means the guard under test
   * is not doing its job.
   */
  const redirected = process.env.GIT_DIR;
  if (redirected !== undefined && redirected.length > 0 && existsSync(redirected)) {
    return resolve(process.env.GIT_WORK_TREE ?? from);
  }
  let dir = resolve(from);
  for (;;) {
    const dot = join(dir, ".git");
    if (existsSync(dot)) {
      const stats = statSync(dot);
      if (stats.isDirectory()) return dir;
      if (stats.isFile() && /^gitdir:\s*\S/.test(readFileSync(dot, "utf8"))) return dir;
    }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

const command = argv.shift();

if (command === "init") {
  mkdirSync(join(cwd, ".git/refs/heads"), { recursive: true });
  mkdirSync(join(cwd, ".git/objects"), { recursive: true });
  writeFileSync(join(cwd, ".git/HEAD"), "ref: refs/heads/main\\n");
  writeFileSync(join(cwd, ".git/config"), "[core]\\n\\trepositoryformatversion = 0\\n");
  if (!argv.includes("--quiet")) process.stdout.write("Initialized empty Git repository in " + join(cwd, ".git/") + "\\n");
  process.exit(0);
}

if (command === "rev-parse" && argv.includes("--show-toplevel")) {
  const root = toplevel(cwd);
  if (root === undefined) {
    process.stderr.write("fatal: not a git repository (or any of the parent directories): .git\\n");
    process.exit(128);
  }
  process.stdout.write(root + "\\n");
  process.exit(0);
}

process.stderr.write("fatal: this test git implements only 'init' and 'rev-parse --show-toplevel', not " +
  JSON.stringify([command, ...argv]) + "\\n");
process.exit(129);
`;

/**
 * Put the Node `git` first on `PATH` for this process. Idempotent, and safe to
 * call from any test file: `node --test` gives each file its own process.
 */
export function ensureNodeGit(): string {
  if (installed !== undefined) return installed;
  const dir = mkdtempSync(join(tmpdir(), "sf-node-git-"));
  const shim = join(dir, "git");
  writeFileSync(shim, SHIM);
  chmodSync(shim, 0o755);
  process.env["PATH"] = `${dir}${delimiter}${process.env["PATH"] ?? ""}`;
  installed = dir;
  return dir;
}

/** Remove the shim directory. Test files that install it should call this. */
export function removeNodeGit(): void {
  if (installed === undefined) return;
  rmSync(installed, { recursive: true, force: true });
  installed = undefined;
}

/** Exported for a test that asserts the shim refuses a planted `.git`. */
export function shimPath(): string | undefined {
  return installed === undefined ? undefined : join(installed, "git");
}

/** True when a directory really holds a `.git` directory. */
export function looksLikeRepository(dir: string): boolean {
  const dot = join(dir, ".git");
  return existsSync(dot) && statSync(dot).isDirectory();
}

/** Create the layout directly, for fixtures that do not want a subprocess. */
export function writeRepositoryLayout(dir: string): void {
  mkdirSync(join(dir, ".git/refs/heads"), { recursive: true });
  mkdirSync(join(dir, ".git/objects"), { recursive: true });
  writeFileSync(join(dir, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, ".git/config"), "[core]\n\trepositoryformatversion = 0\n");
}
