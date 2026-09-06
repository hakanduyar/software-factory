#!/usr/bin/env node
/**
 * THE VERIFICATION ENTRY POINT (TASK-010).
 *
 * Invariant, and the reason this file exists:
 *
 *   A verification run must reflect the tree it is run against, and NOTHING
 *   ELSE. A branch may never appear verified against tests or code it does not
 *   contain.
 *
 * `dist/` is gitignored and git does not clean it on checkout. The previous test
 * command globbed `dist/tests/**`, so compiled tests from another branch were
 * discovered and run — observed twice during this work, each time caught only
 * because the stale artifact FAILED. One that merely passed would have inflated
 * the count in silence, and every ADR-0002 integration turns on "deterministic
 * verification passes".
 *
 * ORDER, and why. The rule deciding what may be deleted lives in tested
 * TypeScript, so it exists only once something is compiled. This therefore
 * builds first, loads the tested checker, and only then cleans. A destructive
 * step guarded by an untested inline copy of the rule would be worse on both
 * counts.
 *
 * ON CONTAMINATION IT REPORTS, REPAIRS ONCE, AND RE-AUDITS — and the frozen
 * criteria genuinely conflict here, so the reasoning is recorded rather than
 * assumed.
 *
 *   AC-2: an orphan "causes verification to FAIL with a message naming the
 *         orphan — it is never silently ignored and never executed".
 *   AC-4: after a branch switch, "with another branch's artifacts present",
 *         verification "yields the same result as running it on a freshly
 *         cloned tree. No human step is required."
 *
 * A branch switch generally LEAVES orphans, so read literally AC-2 demands a
 * failure exactly where AC-4 demands the fresh-clone result. Both are frozen;
 * neither may be edited. The adjudication, taken from the spec and not from
 * reviewer prose:
 *
 *   - The task's own Design direction specifies "a deterministic clean BEFORE
 *     build". Under that shape a branch-switch leftover never reaches the audit
 *     at all — the spec's intent is that it resolves INSIDE the run.
 *   - AC-4 is unconditional, names the property "BY CONSTRUCTION", and rules out
 *     a human step. A second invocation is a human step.
 *   - AC-2's substantive guarantees are what carry its meaning: the orphan is
 *     never silently ignored (it is named on stderr before anything is touched)
 *     and never executed (execution derives from source, and the artifact is
 *     deleted before any test runs).
 *   - AC-2's FAIL is preserved where failing is the honest answer: anything that
 *     SURVIVES a clean rebuild from source is a genuine disagreement between the
 *     tree and its build, and that fails closed.
 *
 * So: transient stale output is named, removed, rebuilt and re-audited within a
 * single invocation; a real inconsistency still fails. An earlier round chose
 * the opposite reading and satisfied AC-2 by breaking AC-4 — a second `npm test`
 * was required, which is precisely the "convention that depends on whoever runs
 * the command remembering" this task exists to abolish. The repair is bounded to
 * ONE cycle so it can never loop.
 *
 * ================================================================
 * THREAT MODEL — what this defends against, and what it does not
 * ================================================================
 * DEFENDS AGAINST (the observed, real problem): gitignored build output that git
 * does not clean on checkout; stale artifacts from another branch; a partial or
 * redirected build; a misconfigured `outDir`; an inherited `noEmit`; symlinks
 * and hardlinks that pull code in from outside the tree, under every DERIVED
 * source root; an `emitDeclarationOnly` build that exits 0 having emitted no
 * JavaScript; a bind-mounted output directory that a recursive delete would
 * reach through, INCLUDING a same-device bind mount that no device-number
 * comparison can see; and a run that would report success having executed
 * nothing.
 *
 * NO DIRECTORY IS EXCLUDED BY NAME ALONE, and that sentence was bought
 * expensively. Three consecutive review rounds found the same error in a new
 * place: a directory NAME treated as evidence about its contents. `src/dist/`
 * skipped as though it were build output; `src/vendor/node_modules/` skipped as
 * though it were an install; then the repository's own `node_modules` and `.git`
 * skipped as though their contents were beyond reach — and the last of those
 * permitted arbitrary code execution, demonstrated with an external `.cjs`
 * hardlinked in and required from a source test while the run reported
 * `tree-consistent`.
 *
 * The previous wording here was "NOTHING IS EXCLUDED BY NAME", and round-18
 * review pointed out that it is literally false: `excludedFromSourceScan` still
 * compares the first path COMPONENT against `node_modules` and `.git`. The
 * distinction it was reaching for is real — a name at the repository ROOT
 * identifies a specific directory, whereas the same name at any depth identifies
 * nothing — but the sentence as written overstated it, which is the defect this
 * file keeps being corrected for.
 *
 * What is excluded from the source walk is IDENTITY: the resolved output
 * directory, and the repository-ROOT `node_modules` and `.git`.
 *
 * Of those two, only `node_modules` has its CONTENTS scanned for hardlinks.
 * `.git` does not, and the reason is measured rather than argued: `git clone
 * --local` and `git submodule` hardlink a repository's objects and raise the
 * link count on BOTH sides, so a third party cloning this repository makes its
 * `.git/objects` hardlinked. Scanning it made this repository refuse itself with
 * 902 hardlinked objects after a reviewer built a submodule fixture in `/tmp`.
 * An install is this project's own business; who clones it is not.
 *
 * A symlinked `.git` IS still refused — no false positives, no legitimate use.
 *
 * NOT COVERED, and stated here because the previous version of this paragraph
 * claimed otherwise for two rounds: a `node_modules` symlinked at an
 * attacker-controlled directory (L-10), and a `.git` that is mounted, symlinked
 * away from, or hardlinked into (L-11). The second is the class TASK-013's clean
 * room exists to close; no guard here is relaxed on the strength of that.
 *
 * PLATFORM BOUNDARY, stated so the claim matches the code: the bind-mount
 * guarantee is derived from `/proc/self/mountinfo` and is therefore LINUX-ONLY.
 * On other platforms the different-device check still applies, but same-device
 * bind mounts are not claimed to be detected. On Linux an unreadable or
 * unparseable mount table fails closed.
 *
 * DOES NOT DEFEND AGAINST an adversary with concurrent write access to this
 * working tree, or control of `PATH`, during the run. Round-3 review
 * demonstrated two such escapes: pausing the compiler and swapping `tests/`
 * between the check and the build, and shadowing `npx` so no compilation
 * happened while the stale checker's mtime was touched.
 *
 * Those are real, and they are NOT closed. The honest reason is that such an
 * adversary can already edit `src/` directly, replace `node`, or rewrite this
 * file — so no verifier running inside the tree it audits can defend against
 * them. Claiming otherwise would be the same overstatement this task exists to
 * remove. Time-of-check/time-of-use gaps here are bounded by that boundary, not
 * by cleverness, and closing them needs the verification to run somewhere the
 * adversary is not: a clean checkout in an isolated environment, which is the
 * `CLEAN_ROOM_CI` roadmap item.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * ONE ANSWER TO "IS THIS PATH OUTSIDE THE REPOSITORY?" (round-23 CRITICAL).
 *
 * The same question was asked in four places and got three different answers,
 * two of them wrong:
 *
 *   `startsWith("../")` — used by `deriveSourceRoots` and the `rootDir` check.
 *   It misses the exact string `".."`, which is what `relative()` returns when
 *   the path IS the parent directory. The reviewer set `include: [".."]`,
 *   pointed a runtime `require` at `../payload.cjs`, and the run exited 0
 *   reporting `tree-consistent` while the payload executed. The compiler was
 *   reading from outside the repository and every containment check said yes.
 *
 *   `startsWith("..")` — used by the escaping-symlink walk. It catches `".."`
 *   but OVER-matches: an ordinary internal directory named `..hidden` has a
 *   relative path beginning with two dots and was refused as an escape.
 *
 * Neither error is exotic. They are the two ends of the same off-by-one, and
 * having three spellings of one predicate is what let each site be wrong in its
 * own way. `isAbsolute` is included because `relative()` returns an absolute
 * path when no relative route exists — a different drive on Windows — and an
 * absolute answer means "not under this root" just as `..` does.
 */
function toRepoRelative(absolutePath) {
  return relative(REPO_ROOT, absolutePath).split("\\").join("/");
}

function escapesRepository(relativePath) {
  return relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath);
}
const OUTPUT_DIR = "dist";
/**
 * Which directories this build compiles FROM — DERIVED, not assumed.
 *
 * `["src", "tests"]` was a hard-coded guess about the project's shape, and
 * round-8 review compiled and executed a file that simply lived somewhere else.
 * Hard-coding closed the two roots this repository happens to use and left the
 * class wide open — the same mistake as filtering hardlinks by suffix, one
 * level up.
 *
 * The roots come from the effective tsconfig's `include`/`files`: the literal
 * prefix of each pattern, up to the first glob. A pattern beginning with a glob
 * roots at the repository itself. That is what tsc actually reads, which is the
 * only thing worth scanning.
 *
 * Populated after the effective config is resolved; `sourceRoots()` is called
 * only from code that runs after that point.
 */
let SOURCE_ROOTS = ["src", "tests"];
/** `rootDir` from the effective config: what the output layout is relative to. */
let ROOT_DIR = ".";
function deriveSourceRoots(config) {
  const patterns = [
    ...(Array.isArray(config?.include) ? config.include : []),
    ...(Array.isArray(config?.files) ? config.files : []),
  ].filter((pattern) => typeof pattern === "string");

  const roots = new Set();
  const outside = new Set();
  for (const pattern of patterns) {
    const segments = pattern.replace(/\\/g, "/").replace(/^\.\//, "").split("/");
    const literal = [];
    for (const segment of segments) {
      if (segment.includes("*") || segment.includes("?")) break;
      literal.push(segment);
    }
    // A `files` entry names a FILE, so its directory is the root; a glob's
    // literal prefix is already one.
    const candidate = literal.length > 0 && literal[literal.length - 1].includes(".")
      ? literal.slice(0, -1).join("/")
      : literal.join("/");
    /**
     * NORMALISED against the repository root (round-9 CRITICAL).
     *
     * A tsconfig may declare its includes ABSOLUTELY, and this returned the
     * absolute path unchanged. Every caller then did `join(REPO_ROOT, root)`,
     * which prefixed the repository a second time and produced a path that does
     * not exist — so the symlink check, the hardlink scan and the mount check
     * all ran against nothing and found nothing wrong. The reviewer pointed an
     * absolute include at the fixture's own `src`, replaced `testArtifacts.ts`
     * with a symlink to a module calling `process.exit(0)`, and the run exited 0
     * WITH NO OUTPUT.
     *
     * `resolve` treats an absolute candidate as absolute and a relative one as
     * relative to the repository, so both spellings land on the same directory;
     * `relative` then puts it back in the form every caller expects.
     */
    const absolute = resolve(REPO_ROOT, candidate.length === 0 ? "." : candidate);
    const rel = relative(REPO_ROOT, absolute).replace(/\\/g, "/");
    if (escapesRepository(rel)) {
      // The compiler reads from OUTSIDE the repository. Nothing here can scan
      // it meaningfully, and a build that compiles foreign source is precisely
      // what these guards exist to refuse.
      outside.add(absolute);
      continue;
    }
    roots.add(rel === "" ? "." : rel);
  }
  return { roots: roots.size === 0 ? ["."] : [...roots].sort(), outside: [...outside].sort() };
}
/** How long `--showConfig` may take before the run fails closed, saying so. */
const CONFIG_TIMEOUT_MS = 120_000;
const CHECKER_PATH = join(REPO_ROOT, OUTPUT_DIR, "src/verification/testArtifacts.js");

/**
 * Directories the walk COULD NOT READ (round-6 CRITICAL).
 *
 * Every walker caught `readdirSync` and returned nothing, so a subtree with
 * mode 000 was indistinguishable from an empty one. The reviewer hid an orphan
 * under `dist/hidden` and a test under `tests/hidden`, and the run reported
 * "tree-consistent" and exited 0 — verification of the READABLE PROJECTION of
 * the tree, presented as verification of the tree.
 *
 * Collected rather than thrown from inside the walk, so the refusal names
 * every unreadable path at once instead of the first one; a reader fixing
 * permissions wants the whole list.
 */
const unreadable = [];
function noteUnreadable(path) {
  const rel = relative(REPO_ROOT, path).replace(/\\/g, "/");
  const shown = rel.length === 0 ? "." : rel;
  if (!unreadable.includes(shown)) {
    unreadable.push(shown);
  }
}

/** Refuses if anything scanned so far could not be read. */
function assertEverythingWasReadable(stage) {
  if (unreadable.length === 0) {
    return;
  }
  fail(
    `verification refused ${stage}: these directories could not be read, so their contents are unknown: ` +
      `${unreadable.sort().join(", ")}. An unreadable subtree is not an empty one, and treating it as empty ` +
      "would verify only the part of the tree this process happens to be allowed to see.",
  );
}

/**
 * Entries that are neither directories, regular files nor symlinks — FIFOs,
 * sockets, device nodes.
 *
 * THE SAME DEFECT AS `unreadable`, ONE CLASS OVER (round-14 review). The walk
 * kept directories and `entry.isFile()` and silently dropped everything else, so
 * a FIFO planted under `dist/` was not an orphan, not an expected artifact and
 * not reported: the run exited 0. The reviewer demonstrated it and correctly
 * scored it non-blocking, because a FIFO cannot execute through a
 * source-derived runner — but "cannot execute" is not "is accounted for", and an
 * audit that answers questions about the tree must not quietly answer them about
 * the regular-file projection of the tree instead.
 *
 * `tsc` emits regular files only. Anything else under the output directory was
 * put there by something that is not this build, which is the whole subject of
 * TASK-010.
 *
 * Symlinks are deliberately NOT collected here: they are neither dropped nor
 * ignored, they have dedicated detection with a better message
 * (`findSymlinks`, `assertTreeIsSafe`), and noting them twice would report one
 * problem as two.
 */
const irregular = [];
function noteIrregular(path, kind) {
  const rel = relative(REPO_ROOT, path).replace(/\\/g, "/");
  const shown = `${rel.length === 0 ? "." : rel} (${kind})`;
  if (!irregular.includes(shown)) {
    irregular.push(shown);
  }
}

/** Describes what an entry is, for a refusal a reader can act on. */
function entryKind(entry) {
  if (entry.isFIFO()) return "FIFO";
  if (entry.isSocket()) return "socket";
  if (entry.isBlockDevice()) return "block device";
  if (entry.isCharacterDevice()) return "character device";
  return "not a regular file";
}

/** Refuses if any scanned entry was neither a directory, a file nor a symlink. */
function assertEverythingWasRegular(stage) {
  if (irregular.length === 0) {
    return;
  }
  fail(
    `verification refused ${stage}: these entries are neither directories, regular files nor symlinks: ` +
      `${irregular.sort().join(", ")}. The compiler emits regular files, so something other than this build ` +
      "created them, and skipping them would audit the regular-file projection of the tree while reporting " +
      "on the tree.",
  );
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function deviceOf(path) {
  try {
    return statSync(path).dev;
  } catch {
    return undefined;
  }
}

/**
 * Sources under a directory that are hardlinks to a file living elsewhere (B9).
 *
 * A hardlink is indistinguishable from an ordinary file by name, type or
 * `realpath` — the only ordinary signal is a link count above one.
 *
 * EVERY compilable source counts, not only `*.test.ts` (round-4 finding). The
 * first version checked test files alone, so a hardlinked `tests/helper.ts`
 * IMPORTED by an ordinary test was compiled and executed from outside the tree
 * while verification exited 0. What runs is the whole compiled graph, not the
 * files whose names happen to say `test`.
 *
 * POLICY, stated because it refuses a legitimate case too: a hardlink INSIDE the
 * repository is indistinguishable from one pointing outside it, so all are
 * refused. If a tree genuinely needs the same content twice, it needs two files
 * or an import — a rule that is occasionally inconvenient beats one that is
 * sometimes wrong.
 */
function findHardlinkedSources(directory) {
  /**
   * EVERY file, not only `.ts`/`.mts`/`.cts` (round-7 CRITICAL).
   *
   * The suffix filter encoded an assumption about what tsc compiles, and the
   * assumption was wrong: with `allowJs`, an external `foreign.js` hardlinked
   * into `src/` was compiled, executed by a test, and the run exited 0 with
   * "tree-consistent". `resolveJsonModule` and future options make the same
   * mistake available again.
   *
   * What a compiler decides to read is not a fact this file can predict from a
   * filename, so it stops guessing. The POLICY is unchanged and already refuses
   * more than strictly necessary: a hardlink inside the repository is
   * indistinguishable from one pointing outside, so all are refused.
   */
  return findHardlinkedUnder(directory, true);
}

/**
 * ANY file beneath a directory with a link count above one.
 *
 * THE SUFFIX FILTER IS GONE and this comment described it for four rounds after
 * it was removed (round-21 finding). `findHardlinkedSources` no longer filters
 * by compilable suffix — it scans every regular file under the derived roots,
 * which is why a hardlinked `src/dist/data.json` is refused even though a
 * `.json` is not a compiler input.
 *
 * The round-5 finding this paragraph was written for still stands and is why
 * the OUTPUT scan exists separately: a hardlinked `dist/tests/x.test.js` is not
 * a source file, and it was overwritten by the build while the run still
 * reported the tree consistent.
 */
// `SKIP_IN_SOURCE_SCAN` stood here and was DEAD once `excludedFromSourceScan`
// replaced name matching with identity. Round-18 review found it still defined
// and no longer read. A set of names that no longer decides anything is exactly
// the thing a later reader reintroduces by wiring it back up, which is how the
// name-matching defect would return.

/**
 * Whether a source scan should refuse to descend into this entry.
 *
 * NO DIRECTORY IS EXCLUDED BY NAME ALONE — and note "alone", because the
 * sentence here has been too absolute twice. `excludedFromSourceScan` DOES
 * compare the first path component against `node_modules` and `.git`; what it
 * no longer does is match those names at any DEPTH. A name at the repository
 * root identifies one specific directory; the same name three levels down
 * identifies nothing. Round-22 review caught the previous wording still
 * claiming more than the code does.
 *
 * The rule that was wrong three times is the one about depth.
 *
 *   Round 11: a compiler input inside a directory skipped by name.
 *   Round 15: `src/dist/data.json`, hardlinked, never scanned, run reported
 *             `tree-consistent`.
 *   Round 16: `src/vendor/node_modules/payload.cjs`, hardlinked from outside,
 *             loaded through `createRequire` by a file a source test imports.
 *             The verifier exited 0 and reported `tree-consistent` while
 *             EXTERNAL CODE EXECUTED. CRITICAL, and demonstrated with no
 *             concurrency and no PATH manipulation.
 *
 * Round 15 fixed the output directory and I argued the `node_modules`/`.git`
 * exemption was a different claim rather than the same one relaxed, because a
 * nested `node_modules` "IS a dependency install wherever it sits". The reviewer
 * was asked to judge that reasoning and refuted it: the NAME never made the
 * CONTENT safe, which is the same error in all three rounds. `linkedCompilerInputs`
 * did not cover it either, because it keeps only `.ts`/`.mts`/`.cts` and the
 * payload was `.cjs` — so it fell through both guards exactly as `.json` did.
 *
 * What is excluded now is identity, not spelling:
 *
 *   - the package manager's install directory and everything beneath it, which
 *     is the ROOT `node_modules` — nested copies inside it included, since npm
 *     genuinely creates those. Hardlinks there are normal (npm's cache, pnpm's
 *     store hardlink every package file), so scanning it would refuse ordinary
 *     repositories for doing nothing wrong.
 *   - the repository's own `.git`, on the same footing.
 *   - the configured output directory, by RESOLVED PATH, so an equivalent
 *     spelling is one answer. `sameDirectory` already accepts `dist`, `./dist`,
 *     an absolute path and a symlinked alias as the same outDir; the scan has to
 *     agree with it or a valid alias is refused (round-16 finding 1).
 *
 * A `node_modules` under a SOURCE ROOT is scanned. In a workspace layout that
 * can mean scanning a package's own install, which is a real cost and belongs to
 * the same trade-off L-6 already records for hardlinked trees. The cost of the
 * alternative was measured, not guessed: it is arbitrary code execution.
 */
function excludedFromSourceScan(relativePath, entry) {
  const first = relativePath.split("/")[0];
  if (first === "node_modules" || first === ".git") {
    return true;
  }
  if (relativePath === OUTPUT_DIR || relativePath.startsWith(`${OUTPUT_DIR}/`)) {
    return true;
  }
  /**
   * An equivalent SPELLING of the output directory — only worth resolving for
   * something that could BE a directory. A regular file is never the outDir,
   * and resolving every file would cost a syscall each to answer no.
   */
  if (entry !== undefined && (entry.isDirectory() || entry.isSymbolicLink())) {
    return sameDirectory(relativePath, OUTPUT_DIR);
  }
  return false;
}

function findHardlinkedUnder(directory, skipExcluded = false) {
  const found = [];
  for (const rel of listFiles(directory, skipExcluded)) {
    try {
      if (lstatSync(join(REPO_ROOT, rel)).nlink > 1) found.push(rel);
    } catch {
      /* unreadable entries are reported by the walk itself */
    }
  }
  return found.sort();
}

/** Symlinked entries anywhere beneath a directory, as repo-relative paths. */
function findSymlinks(directory, keep = () => true, skipExcluded = false) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        noteUnreadable(current);
      }
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      /**
       * Skipped by IDENTITY before the link test, and only for SOURCE scans.
       *
       * "By NAME" is what this said, and it stopped being true in round 16 when
       * `excludedFromSourceScan` replaced name matching: the output directory is
       * matched by RESOLVED PATH, so an aliased spelling is one answer, and only
       * the repository-ROOT `node_modules` and `.git` are matched by their first
       * path component. A nested directory sharing either name is scanned.
       *
       * Relevant once a root can be `.`: `node_modules` is commonly a symlink
       * to a shared install, tsc excludes it by default, and reporting it as
       * foreign source refuses an ordinary workspace. The OUTPUT scan passes
       * `skipExcluded = false`, because a link under the output is exactly what
       * it is looking for.
       */
      const rel = relative(REPO_ROOT, full).replace(/\\/g, "/");
      if (skipExcluded && excludedFromSourceScan(rel, entry)) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        if (keep(rel)) found.push(rel);
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(join(REPO_ROOT, directory));
  return found.sort();
}

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function realOrUndefined(path) {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * The absolute path `candidate` names, resolved through links where possible.
 *
 * Two spellings name the same directory when they RESOLVE to the same place,
 * not when their text matches. Comparing spellings refused every equivalent way
 * of naming the managed directory: an absolute path, `dist/../dist`, a trailing
 * separator, and a `dist-alias -> dist` symlink — the last of which is the
 * managed directory itself under another name.
 *
 * `realpath` is preferred; a path that does not exist yet falls back to lexical
 * resolution, which still normalises `..`, `./` and trailing separators.
 */
function resolvedPath(candidate) {
  const absolute = resolve(REPO_ROOT, candidate);
  const direct = realOrUndefined(absolute);
  if (direct !== undefined) {
    return direct;
  }
  /**
   * The path does not exist YET — but its parents might, and one of them might
   * be a symlink (round-7 finding). With `workspace -> .` and no `dist` built,
   * `workspace/dist` resolved lexically to a different directory than `dist`
   * and was refused, even though tsc would write to exactly the managed one.
   *
   * So: resolve the longest EXISTING ancestor, then re-attach the remainder.
   * Falls back to the lexical answer when nothing on the path exists, which is
   * the same conservative result as before.
   */
  const parts = absolute.split("/");
  const tail = [];
  while (parts.length > 1) {
    tail.unshift(parts.pop());
    const real = realOrUndefined(parts.join("/") || "/");
    if (real !== undefined) {
      return [real.replace(/\/+$/, ""), ...tail].join("/");
    }
  }
  return absolute;
}

/** True when two path spellings name one directory. */
function sameDirectory(a, b) {
  return resolvedPath(a) === resolvedPath(b);
}

function listFiles(directory, skipExcluded = false) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        noteUnreadable(current);
      }
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (skipExcluded && excludedFromSourceScan(relative(REPO_ROOT, full).replace(/\\/g, "/"), entry)) {
        continue;
      }
      // Deliberately do NOT follow directory symlinks: a linked subtree is not
      // part of this build, and walking into it would pull someone else's
      // artifacts into the audit as though they belonged here.
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(full);
      } else if (entry.isFile()) {
        found.push(relative(REPO_ROOT, full).replace(/\\/g, "/"));
      } else if (!entry.isSymbolicLink()) {
        // Neither a directory, a regular file nor a symlink. Not silently
        // dropped — see `noteIrregular`.
        noteIrregular(full, entryKind(entry));
      }
    }
  };
  walk(join(REPO_ROOT, directory));
  return found.sort();
}

function build() {
  execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: REPO_ROOT, stdio: "inherit" });
}

// --- 1. refuse an unreasonable tree BEFORE building --------------------------
//
// THE RAW-TSCONFIG CHECK IS GONE (round-2 finding). It read the root file and
// compared its `outDir` before resolving `extends`, and it was:
//
//   - the source of a false positive, refusing a legitimate `extends`-only
//     config outright; and then, once that was fixed,
//   - not load-bearing at all. Deleting it left the whole end-to-end suite
//     green, because the EFFECTIVE check below runs before the build too and
//     catches every mismatch the raw one could.
//
// Its stated justification was an earlier diagnostic than the checker import.
// The effective check already provides that, so the raw one was two things at
// once — a duplicate and a hazard. A guard nothing exercises is not defence in
// depth; it is code that will be wrong one day with nothing to notice.
// Building is itself a write through whatever these paths resolve to, so the
// structural checks that do not need the compiled checker happen first. A
// symlinked output directory was previously refused only AFTER the build had
// already written into the external target.
// EFFECTIVE config, not the raw root file (round-3 finding B12). `extends` means
// a root tsconfig that mentions nothing can still inherit `noEmit`, and scanning
// the raw text would miss it entirely — a silent pass with no attacker involved.
const configResolution = (() => {
  try {
    const shown = execFileSync("npx", ["tsc", "-p", "tsconfig.json", "--showConfig"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      // A hung `--showConfig` would otherwise produce no verdict at all, which
      // is neither a pass nor a failure — the worst of the three.
      timeout: CONFIG_TIMEOUT_MS,
    });
    return { value: JSON.parse(shown) };
  } catch (error) {
    // A wedged toolchain, a killed process and a config the compiler rejected
    // are three different operator problems, and round-5 review noted that
    // reporting all of them as "could not resolve" — after a silent two-minute
    // pause — sends the reader to the wrong place.
    //
    // Kept as three branches rather than folding the signal case into the
    // timeout: `execFileSync` enforces its own timeout by SIGTERM, so treating
    // any SIGTERM as a timeout would confidently misreport an external kill as
    // a slow toolchain. ETIMEDOUT is the specific claim and is tested first.
    const failure = (() => {
      if (typeof error !== "object" || error === null) return "could not resolve the effective tsconfig";
      if (error.code === "ETIMEDOUT") {
        return `resolving the effective tsconfig timed out after ${CONFIG_TIMEOUT_MS / 1000}s`;
      }
      if (typeof error.signal === "string") {
        return `resolving the effective tsconfig was terminated by ${error.signal}`;
      }
      return "could not resolve the effective tsconfig";
    })();
    return { failure };
  }
})();
const effectiveConfig = configResolution.value;

/**
 * The parsed config must be STRUCTURALLY what it claims (round-4 finding).
 *
 * Rejecting only `undefined` was not enough: a `--showConfig` returning `{}`
 * satisfied that, optional chaining then read a missing `noEmit` as `false`, and
 * verification passed while the real build did something else entirely. Absence
 * of a field is not evidence about its value — the same mistake as treating an
 * unreported model identity as agreement.
 */
const configProblem = (() => {
  if (configResolution.failure !== undefined) {
    return configResolution.failure;
  }
  if (typeof effectiveConfig !== "object" || effectiveConfig === null || Array.isArray(effectiveConfig)) {
    return "the effective tsconfig is not an object";
  }
  const options = effectiveConfig.compilerOptions;
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    return "the effective tsconfig declares no compilerOptions object";
  }
  if (typeof options.outDir !== "string" || options.outDir.trim().length === 0) {
    return "the effective tsconfig declares no outDir";
  }
  /**
   * ...and it must be the directory this script MANAGES (round-5 finding B13).
   *
   * Step 1 compared the RAW tsconfig. Checking here only that the effective
   * value was a nonempty string left the actual escape open: `--showConfig`
   * reporting `build-output` while the root file said `dist` passed both
   * checks. tsc then emitted into `build-output` while the audit examined an
   * untouched `dist`, found nothing wrong with it, and reported a consistent
   * tree — verification of a directory the build never touched.
   *
   * The EFFECTIVE config is the authority, because it is what tsc obeys;
   * `extends` means the root file can be silent or contradicted. Compared by
   * resolution rather than by string so that `dist`, `./dist` and an absolute
   * path are one answer, and a sibling like `dist-2` is not.
   */
  if (!sameDirectory(options.outDir, OUTPUT_DIR)) {
    return (
      `the effective tsconfig builds into ${JSON.stringify(options.outDir)}, but verification manages ` +
      `${JSON.stringify(OUTPUT_DIR)}; the audit would examine a directory the build never wrote to`
    );
  }
  if (options.noEmit !== undefined && typeof options.noEmit !== "boolean") {
    return `noEmit is ${JSON.stringify(options.noEmit)}, which is not a boolean`;
  }
  /**
   * `emitDeclarationOnly` is `noEmit` wearing a hat (round-11 finding D).
   *
   * It emits `.d.ts` and NO JavaScript, so `tsc` exits 0 while every compiled
   * test and the checker itself keep whatever content and mtime they already
   * had. The freshness check then compares the stale checker's mtime against a
   * build that legitimately succeeded, and a build started within a second of
   * the previous one slips through the grace window with the OLD auditor in
   * charge. Rejected here, next to `noEmit`, because it is the same ordinary
   * misconfiguration with the same consequence: an audit of whatever was
   * already lying there.
   */
  if (options.emitDeclarationOnly !== undefined && typeof options.emitDeclarationOnly !== "boolean") {
    return `emitDeclarationOnly is ${JSON.stringify(options.emitDeclarationOnly)}, which is not a boolean`;
  }
  if (options.emitDeclarationOnly === true) {
    return "the effective tsconfig sets emitDeclarationOnly, so the build emits no JavaScript and the audit would run against stale compiled output";
  }
  return undefined;
})();
if (configProblem !== undefined) {
  fail(`verification refused: ${configProblem}; refusing to build a configuration it cannot read`);
}
const noEmit = effectiveConfig.compilerOptions.noEmit === true;
// The roots are a fact about the CONFIG, so they are derived the moment the
// config is known and before anything scans a directory.
const derivedRoots = deriveSourceRoots(effectiveConfig);
if (derivedRoots.outside.length > 0) {
  fail(
    `verification refused: the effective tsconfig compiles source from outside this repository ` +
      `(${derivedRoots.outside.join(", ")}); nothing here can scan or vouch for it`,
  );
}
SOURCE_ROOTS = derivedRoots.roots;
/**
 * The output layout is DERIVED too, for the same reason the roots are.
 *
 * `rootDir` decides where a source lands under `outDir`, so the audit cannot map
 * one to the other without it. An absolute `rootDir` is normalised exactly as
 * the roots are; one outside the repository is refused for the same reason.
 */
ROOT_DIR = (() => {
  const declared = effectiveConfig.compilerOptions.rootDir;
  if (declared === undefined) return ".";
  if (typeof declared !== "string") {
    fail(`verification refused: rootDir is ${JSON.stringify(declared)}, which is not a string`);
  }
  const rel = relative(REPO_ROOT, resolve(REPO_ROOT, declared)).replace(/\\/g, "/");
  if (escapesRepository(rel)) {
    fail(`verification refused: rootDir (${declared}) is outside this repository`);
  }
  return rel === "" ? "." : rel;
})();
/**
 * DERIVED, like everything else about the layout (round-13 HIGH).
 *
 * `declaration`, `sourceMap` and `declarationMap` decide which artifact kinds
 * the build produces. Without them the audit accepted a `.d.ts` as explained by
 * its source even when nothing would emit one, so a declaration left behind by a
 * previous configuration survived as "clean".
 */
const EMIT_LAYOUT = {
  rootDir: ROOT_DIR,
  outputDirectory: OUTPUT_DIR,
  declaration: effectiveConfig.compilerOptions.declaration === true,
  sourceMap: effectiveConfig.compilerOptions.sourceMap === true,
  declarationMap: effectiveConfig.compilerOptions.declarationMap === true,
};
/**
 * Refused BEFORE the build, and the wording says so (round-3 finding).
 *
 * The later `assessTreeSafety` clauses cover the same conditions, so removing
 * these left their named tests green — but only because the build had ALREADY
 * written through the link by the time the later guard ran. The reviewer found
 * compiled checker and test files sitting in the external target of a symlinked
 * `dist` after a "refused" run.
 *
 * That is the whole point of checking here: not to produce a different verdict,
 * but to produce it before anything is written. The distinct wording lets a
 * test pin THIS layer, and the regressions also assert the external target is
 * still empty — which is the property that actually matters and cannot be
 * satisfied by a later refusal.
 */
/**
 * EVERY source root, not just `tests` (round-4 CRITICAL).
 *
 * `findSymlinks("src")` walks what is INSIDE `src`; it never asked whether
 * `src` itself was a link. `tests` was checked here and `src` was not, so a
 * repository whose entire `src` pointed elsewhere passed every guard: the
 * external `testArtifacts.ts` was compiled and imported, and a module calling
 * `process.exit(0)` at import time produced EXIT 0 WITH NO OUTPUT.
 *
 * A false success is the worst outcome this file can produce — worse than a
 * crash, because nothing looks wrong. The asymmetry existed only because the
 * two roots were written as separate lines instead of a list, which is exactly
 * the kind of omission a list prevents and a pair of lines invites.
 */
for (const root of SOURCE_ROOTS) {
  /**
   * The root AND everything above it (round-12 CRITICAL). A root is checked for
   * being a link; an ANCESTOR of a root is not a root, and was checked by
   * nothing.
   */
  for (const linked of linkedAncestors(root)) {
    fail(
      `verification refused before building: ${linked} is a symlink and a derived source root sits inside it; ` +
        "external code would be compiled and executed as though it belonged to this tree",
    );
  }
  if (isSymlink(resolve(REPO_ROOT, root))) {
    fail(
      `verification refused before building: the ${root} directory is a symlink; external code would be ` +
        "compiled and executed as though it belonged to this tree",
    );
  }
}
if (isSymlink(join(REPO_ROOT, OUTPUT_DIR))) {
  fail("verification refused before building: the build output directory is a symlink; the build would write outside the repository");
}

/**
 * THE COMPILER'S OWN FILE LIST (round-10 CRITICAL).
 *
 * Globbing the derived roots was still a guess — a better one than
 * `["src", "tests"]`, and still not what tsc reads. `exclude` was ignored
 * entirely, so a test source the config EXCLUDES counted as current, and an old
 * artifact at the same path was therefore explained by it. The reviewer excluded
 * a test, planted its previous build output, and watched the stale artifact RUN
 * while the harness reported success.
 *
 * Asking the compiler removes the last of the guessing. `--listFilesOnly`
 * enumerates the actual program: `include` minus `exclude`, PLUS anything
 * reachable by import — which matters, because `exclude` does not stop an
 * excluded file being pulled in by an included one, and a glob-based answer gets
 * that wrong in both directions.
 *
 * Filtered to this repository, because the list also names `lib.*.d.ts` and
 * whatever `node_modules` types the program pulls in, and those are not this
 * tree's source.
 */
function compilerInputs() {
  let listed;
  try {
    listed = execFileSync("npx", ["tsc", "-p", "tsconfig.json", "--listFilesOnly"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: CONFIG_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(
      `verification refused: the compiler could not list its own inputs (${detail}); refusing to audit a tree ` +
        "whose source set is unknown",
    );
  }
  const inRepo = [];
  for (const line of listed.split("\n")) {
    const path = line.trim();
    if (path.length === 0) continue;
    const rel = relative(REPO_ROOT, resolve(REPO_ROOT, path)).replace(/\\/g, "/");
    if (escapesRepository(rel) || rel.length === 0) continue;
    if (rel.startsWith("node_modules/") || rel.startsWith(`${OUTPUT_DIR}/`)) continue;
    // Declaration files are inputs but emit nothing, so they explain no artifact.
    if (/\.d\.(ts|mts|cts)$/.test(rel)) continue;
    if (!/\.(ts|mts|cts)$/.test(rel)) continue;
    inRepo.push(rel);
  }
  if (inRepo.length === 0) {
    fail("verification refused: the compiler reported no source files of its own in this repository");
  }
  return [...new Set(inRepo)].sort();
}
const allSources = compilerInputs();

/**
 * Individual source links, refused BEFORE the build and BEFORE the checker is
 * imported (round-12 finding).
 *
 * `assessTreeSafety` covers exactly this ground, and it was unreachable for the
 * case that matters: it runs AFTER `await import(CHECKER_PATH)`, so a hardlinked
 * `src/verification/testArtifacts.ts` was compiled and then EXECUTED — a module
 * calling `process.exit(0)` at import time wins long before the guard meant to
 * reject it is consulted. A guard placed after the thing it protects is not a
 * guard. The tested clause stays as defence in depth; this one exists to run
 * first, and it runs before the build too, because the build compiles the link.
 */
/**
 * EVERY COMPILER INPUT, whatever directory it sits in (round-11 CRITICAL).
 *
 * The walk skipped entries named `dist`, `.git` and `node_modules` AT EVERY
 * DEPTH, before any link inspection. That exclusion exists so a `.` source root
 * does not report an ordinary workspace as foreign — and it was a name filter
 * over a set the compiler does not define, which is the subset-for-the-whole
 * substitution this file keeps being caught by.
 *
 * The reviewer put `src/dist/evil.ts` in the tree, excluded it in tsconfig,
 * imported it from a test — which makes tsc compile it anyway, `exclude` being
 * about the initial file list rather than reachability — and hardlinked it to an
 * external file. `tsc --listFilesOnly` listed it correctly. The link scan
 * skipped it by directory name, and the external content executed under a
 * "tree-consistent" report.
 *
 * So the scan is the UNION of two sets, and neither replaces the other:
 *
 *   - every `.ts`/`.mts`/`.cts` file the compiler says it reads that lives in
 *     this repository, excluding declaration files, `node_modules` and the
 *     output directory. Narrower than "every compiler input", and said exactly:
 *     with `allowJs` or `resolveJsonModule` a `.js` or `.json` input would not
 *     be scanned here. That direction is CONSERVATIVE — such a file is not
 *     matched by the walk's exclusions either, so it is still covered by the
 *     other half of this union — but the claim is narrowed rather than left
 *     overstated. The property that matters is that the set comes from the
 *     program rather than from a path; and
 *   - the directory walk, which still skips those names, because it covers
 *     files that are NOT compiler inputs and would otherwise report an ordinary
 *     `node_modules` as foreign source.
 *
 * The union is strictly larger than either, which is the only property that
 * matters here.
 *
 * ANCESTORS ARE CHECKED, and this paragraph is the correction of a mistake worth
 * recording rather than quietly undoing.
 *
 * An ancestor walk was written here, a mutation showed it caught nothing the
 * suite already caught, and it was REMOVED on that evidence. Round-12 review
 * then produced the case it existed for: `src` a symlink to an external
 * directory, with `include` naming `src/foo/**` and `src/verification/...`. The
 * derived roots are then `src/foo`, `src/verification` and `tests` — and `src`
 * ITSELF is never a root, so the root-symlink refusal never looks at it. The
 * walk starts below the link and `lstat` on each file follows it. The run exited
 * 0, reported the tree consistent, and executed external code.
 *
 * The measurement was right about the case it measured and wrong as a
 * generalisation: a symlinked directory that BECOMES a root is caught by the
 * root check; a symlinked directory ABOVE every root is caught by nothing. "A
 * mutation shows this is redundant" only ever means redundant for the cases the
 * suite covers, and the question that should have followed it — what case would
 * make it necessary? — was not asked.
 *
 * So every lexical ancestor of every derived root AND of every compiler input is
 * inspected, up to the repository root.
 */
function linkedAncestors(relativePath) {
  const found = [];
  const parts = relativePath.split("/").filter((part) => part.length > 0 && part !== ".");
  // STRICT ancestors. The path itself is judged by its own check, which says
  // something more specific — "the tests directory is a symlink" reads better
  // than "a root sits inside a symlink" when the root IS the symlink.
  for (let depth = 1; depth < parts.length; depth += 1) {
    const directory = parts.slice(0, depth).join("/");
    if (isSymlink(resolve(REPO_ROOT, directory))) {
      found.push(directory);
      break;
    }
  }
  return found;
}

function linkedCompilerInputs() {
  const found = [];
  for (const rel of allSources) {
    const absolute = join(REPO_ROOT, rel);
    let stats;
    try {
      stats = lstatSync(absolute);
    } catch (error) {
      if (error?.code !== "ENOENT") noteUnreadable(absolute);
      continue;
    }
    found.push(...linkedAncestors(rel));
    if (stats.isSymbolicLink() || stats.nlink > 1) {
      found.push(rel);
      continue;
    }
  }
  return found;
}

/**
 * HARDLINKS INSIDE THE ROOT `node_modules` (round-17 CRITICAL, narrowed in 19).
 *
 * Excluding the root installs from the source walk left an execution path open,
 * and the reviewer demonstrated it twice: an external `.cjs` hardlinked under
 * `node_modules` or under `.git`, required by a source test, RAN — while the run
 * exited 0 and reported `tree-consistent`.
 *
 * ONLY `node_modules` IS SCANNED. `.git` was scanned too and it broke this
 * repository — see the reversal below. The `.git` execution vector is L-11 and
 * belongs to TASK-013's clean room.
 *
 * I had defended the exemption on the ground that scanning would refuse
 * ordinary repositories, because npm's cache and pnpm's store hardlink package
 * files. That was asserted and never measured. Measured on this repository:
 * ZERO hardlinked files in `node_modules` (248 files) and ZERO in `.git` (997),
 * with a full link scan of both taking 12ms. The cost I used to justify leaving
 * a code-execution hole open was, here, nothing at all.
 *
 * WHAT THIS DOES NOT CLAIM. Only HARDLINKS are reported, not symlinks: a
 * `node_modules` symlinked at a shared install is an ordinary layout, and this
 * fixture harness uses exactly that. The top-level entry is therefore FOLLOWED
 * rather than reported — its contents are what matter. A `node_modules` pointing
 * wholly at an attacker-controlled directory still has `nlink == 1` everywhere
 * and is NOT detected; that residue is L-10.
 *
 * THE COST IS REAL WHERE IT LANDS. `git clone --local` hardlinks its objects —
 * measured at 888 in a local clone of this repository — so a `--local` clone is
 * now refused. That is the same trade-off L-6 already records for `cp -al`, and
 * the same instruction applies: if this starts refusing ordinary working copies,
 * revisit the trade-off rather than adding a bypass flag.
 */
/**
 * A SYMLINKED `.git` IS REFUSED, and a worktree's `.git` FILE is not (round-18).
 *
 * Two findings, one place:
 *
 *   CRITICAL. The walk followed `.git`'s realpath and only reported hardlinks,
 *   so a `.git` symlinked at an external directory passed — and a source test
 *   importing `.git/payload.cjs` executed it. L-10 does NOT cover this: that
 *   entry's argument is that `node_modules` holds third-party code which
 *   executes by design and whose store legitimately lives outside the
 *   repository. `.git` has no such property. Nothing legitimately imports from
 *   it, and it has no reason to be a symlink.
 *
 *   HIGH, and a regression I introduced. In a `git worktree` — and in a
 *   submodule — `.git` is a FILE containing `gitdir: ...`. `readdirSync` on it
 *   fails, which this recorded as an unreadable directory and refused. THIS
 *   REPOSITORY HAS THREE WORKTREES and the earlier independent reviews ran in
 *   one of them, so the guard I added to protect verification would have
 *   refused the trees the pipeline actually verifies. A guard that refuses
 *   ordinary work gets disabled rather than obeyed.
 *
 * ONLY THE SYMLINK QUESTION IS LEFT (round-19 note). This returned a `walk`
 * answer distinguishing a gitfile from a directory, and once `.git` stopped
 * being scanned for hardlinks nothing read it. The reviewer forced every
 * non-symlink result to `{ walk: true }` and both the gitfile and directory
 * tests still passed, which is the definition of a distinction that decides
 * nothing.
 *
 * The worktree behaviour it was written for is NOT lost: a gitfile is accepted
 * because nothing here refuses it, and "ACCEPTS a checkout whose .git is a
 * gitfile" still fails if that changes. What is gone is a computed answer with
 * no reader.
 */
function refuseSymlinkedGit() {
  const gitPath = join(REPO_ROOT, ".git");
  let stats;
  try {
    stats = lstatSync(gitPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined; // not a git checkout at all; nothing to say
    }
    return `.git could not be inspected (${error?.code ?? "unknown error"})`;
  }
  if (stats.isSymbolicLink()) {
    return (
      ".git is a symlink; nothing legitimately imports from it and a linked .git can " +
      "carry code from outside this repository into a run that reports on this tree"
    );
  }
  return undefined;
}

function hardlinksInsideRootInstalls() {
  const found = [];
  const gitRefusal = refuseSymlinkedGit();
  if (gitRefusal !== undefined) {
    fail(`verification refused before building: ${gitRefusal}`);
  }
  /**
   * `.git` IS NOT SCANNED FOR HARDLINKS, and this reversal was forced by
   * evidence rather than argued (round 19).
   *
   * Round 17 added `.git` to this walk on a measurement — 0 hardlinked files in
   * `.git`, so the guard looked free. It is not free, and the measurement was
   * taken at the wrong moment. `git clone --local` and `git submodule` hardlink
   * a repository's objects, which raises the link count on BOTH sides: the
   * SOURCE repository's `.git/objects` become hardlinked by an action taken
   * entirely outside it.
   *
   * Not hypothetical. The round-19 reviewer built a submodule fixture under
   * `/tmp` while reviewing this branch, and this repository's own verification
   * then refused with 902 hardlinked objects, sharing inodes with
   * `/tmp/sf-review-layouts-.../super/.git/modules/sub/objects/...`. The guard
   * broke the repository it protects, at a distance, because somebody cloned it
   * — and would stay broken until an unrelated directory elsewhere was deleted.
   *
   * `node_modules` is KEPT, and the difference is the whole reason: an install
   * is within this repository's control and measures 0 here, so its cost is
   * this project's to bear. Who clones this repository is not.
   *
   * THIS IS NOT "WEAKENED BECAUSE A CLEAN ROOM WILL EXIST." That instruction is
   * explicit and is respected — no guard is relaxed on the strength of future
   * work. This one goes because it demonstrably refuses ordinary trees for a
   * legitimate action by a third party, which is the definition of a guard that
   * gets disabled rather than obeyed. A symlinked `.git` is STILL refused: that
   * has no false positives and no legitimate use.
   *
   * The vector this leaves open — a linked or mounted `.git` supplying `.cjs`
   * that a source test imports — is L-11, and belongs to TASK-013's clean room,
   * which is where the round-19 reviewer placed it.
   */
  for (const name of ["node_modules"]) {
    /**
     * realpath, so a shared install reached through a symlink is still walked.
     *
     * FAILS CLOSED when it cannot be resolved (round-18 note): a broken link or
     * a symlink cycle used to be skipped silently, which is the quiet
     * "unreadable subtree treated as empty" this file exists to refuse.
     */
    let base;
    try {
      base = realpathSync(join(REPO_ROOT, name));
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue; // genuinely absent, which is not a hiding place
      }
      fail(
        `verification refused before building: ${name} could not be resolved ` +
          `(${error?.code ?? "unknown error"}); an unresolvable install is not an empty one`,
      );
    }
    const walk = (current, shown) => {
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch (error) {
        if (error?.code !== "ENOENT") noteUnreadable(current);
        return;
      }
      for (const entry of entries) {
        const full = join(current, entry.name);
        const label = `${shown}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(full, label);
          continue;
        }
        /**
         * Regular files only — which is also how a SYMLINKED package escapes.
         *
         * An `isSymbolicLink()` branch stood above this and was DEAD. `Dirent`
         * reflects `lstat`, so a symlink is neither `isDirectory()` nor
         * `isFile()` and this line already skipped it. My own mutation found
         * that: deleting the branch changed no behaviour and failed no test,
         * which is the definition of a guard nobody can check.
         *
         * The INTENT it recorded is real and is kept — a symlinked package is an
         * ordinary install (a shared store, a pnpm farm, a hoisted monorepo) and
         * reporting one would refuse the common case. That intent now has a test
         * of its own rather than an unreachable branch: "still accepts a real
         * node_modules whose packages are symlinks".
         */
        if (!entry.isFile()) {
          continue;
        }
        try {
          if (lstatSync(full).nlink > 1) found.push(label);
        } catch {
          /* unreadable entries are reported by the walk itself */
        }
      }
    };
    walk(base, name);
  }
  return found.sort();
}

/**
 * SYMLINKS ANYWHERE IN THE REPOSITORY WHOSE TARGET ESCAPES IT (round-22
 * CRITICAL).
 *
 * The reviewer put `helpers/payload.cjs` — a symlink to `/tmp` code — outside
 * every derived root, had a source test `require` it at RUNTIME, and the run
 * reported `verification complete: 1 test files, tree-consistent` with
 * `STATUS=0 MARKER=yes`. The payload executed.
 *
 * Nothing saw it. `findSymlinks` walks only the derived roots.
 * `linkedCompilerInputs` covers what tsc compiles, and a `.cjs` pulled in by a
 * runtime `require` is not a compiler input. The path was not under
 * `node_modules` (L-10) and not a `.git` mount or hardlink (L-11), so it was in
 * no register either.
 *
 * WHY THIS IS FIXED HERE RATHER THAN DEFERRED TO THE CLEAN ROOM. The
 * architectural boundary in L-11 is about things the verifier CANNOT SEE from
 * inside: a bind mount IS the path it is mounted at, so `lstat` and `realpath`
 * both agree with the attacker and only the mount table disagrees. A symlink is
 * not like that. `lstat` reports it and `realpath` resolves it, so the verifier
 * can answer the question directly and cheaply. Deferring an observable defect
 * to a future clean room would be using the boundary as an excuse.
 *
 * ONLY ESCAPING links are reported, which is narrower than the source-root scan
 * (that one refuses every symlink, including internal ones, because a source
 * root is small and the stricter rule is affordable there). A link resolving
 * INSIDE the repository moves nothing across the boundary.
 *
 * `node_modules` is excluded, and that is L-10 rather than an oversight: a
 * package store legitimately lives outside the repository, so every symlink in
 * a pnpm-style install escapes by design. Excluding it is the same trade-off
 * already recorded there, not a new hole.
 */
function escapingSymlinks() {
  const found = [];
  const walk = (absolute) => {
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") noteUnreadable(absolute);
      return;
    }
    for (const entry of entries) {
      const full = join(absolute, entry.name);
      const rel = relative(REPO_ROOT, full).replace(/\\/g, "/");
      if (rel === "node_modules" || rel.startsWith("node_modules/")) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        const target = realOrUndefined(full);
        if (target === undefined) {
          // Unresolvable is not harmless: it is a link this process cannot
          // judge, and an unjudgeable entry is refused rather than assumed safe.
          found.push(`${rel} (unresolvable)`);
          continue;
        }
        if (escapesRepository(toRepoRelative(target))) {
          found.push(rel);
        }
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(REPO_ROOT);
  return found.sort();
}

const linkedRootInstalls = hardlinksInsideRootInstalls();
if (linkedRootInstalls.length > 0) {
  fail(
    `verification refused before building: hardlinked entries inside the repository's own ` +
      `node_modules: ${linkedRootInstalls.join(", ")}; their contents are outside this tree ` +
      "and a source file can require them, so the run would execute code the audit never saw",
  );
}

const linkedSources = [
  ...new Set([
    ...SOURCE_ROOTS.flatMap((root) => findSymlinks(root, () => true, true)),
    ...SOURCE_ROOTS.flatMap((root) => findHardlinkedSources(root)),
    ...linkedCompilerInputs(),
  ]),
].sort();
if (linkedSources.length > 0) {
  fail(
    `verification refused before building: symlinked or hardlinked entries under the source roots ` +
      `(${SOURCE_ROOTS.join(", ")}): ` +
      `${linkedSources.join(", ")}; source must live in this repository`,
  );
}

const rootDevice = deviceOf(REPO_ROOT);
const outputDevice = deviceOf(join(REPO_ROOT, OUTPUT_DIR));
if (outputDevice !== undefined && rootDevice !== undefined && outputDevice !== rootDevice) {
  fail("verification refused: the build output directory is on a different device (a mount or bind mount); a recursive delete could reach outside the repository");
}
// The device comparison above catches only a DIFFERENT-device mount. A bind
// mount of a directory already on this filesystem shares the device number and
// is invisible to it, to `realpath` and to any string comparison — while
// `rmSync(recursive)` deletes straight through it. The mount table is read
// here, before anything is built or removed; the decision itself lives in the
// tested checker and is applied once that exists (step 4).
function readMountInfo() {
  try {
    return readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return undefined;
  }
}
const mountInfo = readMountInfo();

/**
 * ...and refuse a mounted output BEFORE the build writes into it (round-12
 * finding on AC-5).
 *
 * `assessMountTopology` is the authority and is applied once the checker exists,
 * but it runs AFTER the build — so `tsc` had already written through a
 * bind-mounted `dist` into a separately mounted tree before anything objected.
 * Refusing early costs a conservative string comparison and removes the write.
 *
 * Deliberately the SAME conservative shape as the inline `outDir` comparison
 * above: a refusal, never a deletion, with the substantive rule still living in
 * the tested function. The octal decode is not optional — omitting it would
 * silently fail to match a mount point containing a space, and a guard that
 * under-matches is worse than no guard because it looks like one.
 */
if (process.platform === "linux") {
  /**
   * EVERY managed path, not just the output (round-5 CRITICAL).
   *
   * The guard asked only whether `dist` was a mount point. A bind-mounted
   * `src/` therefore sailed past every source check — `isSymlink` says no, link
   * counts say no, and `realpath` resolves inside the repository because a bind
   * mount IS the path it is mounted at. The reviewer mounted an external `src`
   * whose `testArtifacts.ts` began with `process.exit(0)`, and the run returned
   * EXIT 0 WITH NO OUTPUT. A false pass, again, from a check that covered one
   * path and not its siblings.
   *
   * The same list the source scan uses, so the two cannot drift apart.
   *
   * EVERY COMPILER INPUT AND ITS ANCESTORS TOO (round-18 CRITICAL).
   *
   * The derived roots are not the whole compiled program. The reviewer
   * bind-mounted an external directory over an ordinary `helpers/` directory
   * that no root covers, a source file imported `helpers/helper.ts`, and the run
   * COMPILED AND EXECUTED it, wrote an external marker, and exited 0. Every
   * other check was blind for the reason a bind mount always defeats them: it
   * IS the path it is mounted at, so `isSymlink` says no, link counts say no,
   * and `realpath` resolves inside the repository.
   *
   * This is the round-8 lesson in the mount dimension. There, the SCAN was
   * hard-coded to two roots while tsc compiled from elsewhere; the roots were
   * derived from the config to fix it. The MOUNT check kept the narrower list
   * and inherited the same gap, so the fix was applied in one place and not the
   * other.
   *
   * Ancestors are included because a mount over any directory ON THE WAY to an
   * input splices in everything below it. `REPO_ROOT` itself is deliberately
   * NOT included: an ancestor mount moves the whole tree together and stays
   * consistent, which is round 6's finding and is preserved here.
   */
  const inputPaths = new Set();
  for (const rel of allSources) {
    inputPaths.add(rel);
    const parts = rel.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      inputPaths.add(parts.slice(0, depth).join("/"));
    }
  }
  const managedPaths = [...new Set([OUTPUT_DIR, ...SOURCE_ROOTS, ...inputPaths])].map((managed) => {
    const absolute = resolve(REPO_ROOT, managed);
    return { relative: managed, path: (realOrUndefined(absolute) ?? absolute).replace(/\/+$/, "") };
  });
  /**
   * Rows are VALIDATED, not merely counted (round-9 HIGH).
   *
   * `split(" ")[4]` accepted `not a mountinfo row /unrelated` as a mount at
   * `/unrelated`. Arbitrary text became a mount point, which is wrong in both
   * directions: garbage rows kept the "could not be read" refusal below
   * unreachable, and a table of garbage missing the real mount looked safe.
   *
   * Deliberately the same shape as `parseMountInfoRow` in the tested checker.
   * This copy exists because this guard runs BEFORE anything is compiled, so
   * the checker does not exist yet; the tested one remains the authority.
   */
  const earlyMountRow = (line) => {
    const fields = line.split(" ").filter((field) => field.length > 0);
    if (fields.length < 10) return undefined;
    if (!/^\d+$/.test(fields[0] ?? "")) return undefined;
    if (!/^\d+$/.test(fields[1] ?? "")) return undefined;
    if (!/^\d+:\d+$/.test(fields[2] ?? "")) return undefined;
    if (!(fields[3] ?? "").startsWith("/")) return undefined;
    const point = fields[4] ?? "";
    if (!point.startsWith("/")) return undefined;
    const separator = fields.indexOf("-", 6);
    if (separator === -1 || fields.length - separator < 4) return undefined;
    return point.replace(/\\([0-7]{3})/g, (_m, o) => String.fromCharCode(Number.parseInt(o, 8)));
  };
  const earlyLines = (mountInfo ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const earlyMountPoints = earlyLines.map(earlyMountRow).filter((point) => point !== undefined);
  if (mountInfo !== undefined && earlyMountPoints.length !== earlyLines.length) {
    fail(
      "verification refused: the mount table (/proc/self/mountinfo) contains lines this verifier does not " +
        "recognise as mountinfo rows, so the mount topology is not fully known",
    );
  }
  if (mountInfo === undefined || earlyMountPoints.length === 0) {
    fail("verification refused: the mount table (/proc/self/mountinfo) could not be read, so it is unknown whether the build output is a mount point");
  }
  for (const managed of managedPaths) {
    /**
     * AT or BELOW the managed path only (round-6 finding).
     *
     * The condition also matched ANCESTORS, so bind-mounting the whole
     * repository onto its own path — an ordinary workspace layout — was
     * refused with "dist is or contains a mount point". An ancestor mount
     * splices nothing INTO the tree: everything below it moves together and
     * stays consistent. What matters is a mount AT or INSIDE a managed path,
     * which is exactly how foreign content gets spliced in.
     */
    const offending = earlyMountPoints.find(
      (point) => point === managed.path || point.startsWith(`${managed.path}/`),
    );
    if (offending !== undefined && offending !== "/") {
      fail(
        `verification refused before building: ${managed.relative} is or contains a mount point (${offending}); ` +
          "a bind mount is indistinguishable from an ordinary directory by name, link count or realpath, so code " +
          "from outside this tree would be compiled and executed as though it belonged to it",
      );
    }
  }
}
if (noEmit) {
  // Worded differently from the `assessTreeSafety` clause that covers the same
  // condition later. Round-5 review observed that deleting this guard still
  // left the focused suite green, because the later guard caught it and said
  // almost the same words — so the test passed for a different reason than it
  // claimed. They are two checks at two different moments, and the distinct
  // thing this one can report is that NOTHING WAS BUILT.
  fail("verification refused before building: tsconfig sets noEmit, so the build would produce nothing and any audit would run against whatever was already there");
}

/**
 * Links UNDER the output directory, refused BEFORE the build (round-5 finding).
 *
 * These were scanned only after `tsc` ran, so a symlinked
 * `dist/tests/whatever.test.js` was written THROUGH into an external file
 * before anything objected: the run refused, and the damage was already done.
 * A hardlinked artifact was worse — it was overwritten and the run still
 * reported the tree consistent, because nothing looked at link counts under
 * the output at all.
 *
 * Refusing here costs a walk of a directory that is usually small, and removes
 * a write the later guard could only report.
 */
const outputLinksBeforeBuild = [
  ...findSymlinks(OUTPUT_DIR),
  ...findHardlinkedUnder(OUTPUT_DIR),
].sort();
if (outputLinksBeforeBuild.length > 0) {
  fail(
    `verification refused before building: linked entries under ${OUTPUT_DIR}: ` +
      `${outputLinksBeforeBuild.join(", ")}; the build would write through them into files outside this tree`,
  );
}

/**
 * THE CATCH-ALL RUNS LAST, and the ordering was a regression before it was a
 * decision.
 *
 * This repository-wide escape check was placed first and it PREEMPTED the
 * specific guards: five source-root cases and then the output-link case began
 * failing — not because their trees were accepted, but because a DIFFERENT
 * guard refused them, and those assertions name the refusal they exist to
 * prove. Relaxing them to accept either message would have been fitting the
 * tests to the implementation, and would have destroyed exactly the specificity
 * rounds 19 and 21 forced me to add.
 *
 * So every SPECIFIC pre-build link rule answers first — the source-root scan,
 * which refuses even an internal link because a root is small and the stricter
 * rule is affordable there, and the output-directory scan, which refuses links
 * the build would write through. This runs afterwards for everything else in
 * the repository, where only an ESCAPING link matters.
 *
 * The general lesson, recorded because it is the shape of five regressions on
 * this branch: a guard correct in isolation can still be wrong in position. The
 * AC-5 inventory pins guards individually and says nothing about their order,
 * which is where these mistakes actually live.
 */
const escaping = escapingSymlinks();
if (escaping.length > 0) {
  fail(
    `verification refused before building: symlinks whose target is outside this repository: ` +
      `${escaping.join(", ")}; a source file can require one at runtime, so the run would ` +
      "execute code the audit never saw",
  );
}

assertEverythingWasReadable("before building");
assertEverythingWasRegular("before building");

// --- 3. build, and prove it actually emitted the checker ---------------------
const buildStartedAt = Date.now();
build();
const checkerStat = (() => {
  try {
    return statSync(CHECKER_PATH);
  } catch {
    return undefined;
  }
})();
const checkerFreshlyEmitted = checkerStat !== undefined && checkerStat.mtimeMs + 1000 >= buildStartedAt;
if (!checkerFreshlyEmitted) {
  // The checker is imported from the very tree it audits, so a build that did
  // not rewrite it would leave a stale — possibly poisoned — auditor in charge
  // of detecting exactly that.
  fail("verification refused: the build did not emit the verification checker; refusing to audit this tree using a stale copy of the auditor");
}
const checker = await import(`file://${CHECKER_PATH}?t=${buildStartedAt}`);

// --- 3b. output, mount and tree safety, together and REPEATABLY ------------
// These used to be three separate blocks that ran once. They are one function
// now, called after every build, because the repair rebuild is a build too —
// see `assertTreeIsSafe`.

// --- 4. the full tested safety judgement, now that the checker exists --------
/**
 * A FUNCTION, because it has to happen TWICE (round-10 HIGH).
 *
 * The repair cycle cleans and rebuilds, and the second build is a build like any
 * other: the reviewer made it replace `dist` with a symlink to an external
 * generated tree, and nothing looked again. The run reported success and
 * executed the external tree's tests.
 *
 * The facts are gathered fresh on each call rather than reused, which is the
 * whole point — a fact captured before the second build says nothing about
 * after it.
 */
function assertTreeIsSafe(stage, checkerIsFresh) {
  const safety = checker.assessTreeSafety({
  /**
   * EVERY derived root, not the one called `tests` (round-9).
   *
   * The pre-build loop already asks this of every root; this fact was still
   * phrased as a question about one hard-coded directory, which is the same
   * subset-for-the-whole substitution the roots themselves stopped making.
   */
  testsRootIsSymlink: SOURCE_ROOTS.some((root) => isSymlink(resolve(REPO_ROOT, root))),
    outputIsSymlink: isSymlink(join(REPO_ROOT, OUTPUT_DIR)),
    outputOnDifferentDevice: (() => {
      const nowDevice = deviceOf(join(REPO_ROOT, OUTPUT_DIR));
      return nowDevice !== undefined && rootDevice !== undefined && nowDevice !== rootDevice;
    })(),
  // EVERY symlink under the output, not only those whose own name ends in
  // `.test.js` (round-3 finding B11). A symlinked DIRECTORY called
  // `foreign-output` was neither walked into nor reported, so an external
  // `ghost.test.js` inside it was invisible and the run reported a consistent
  // tree. Filtering by name meant the check only caught the shape of the escape
  // that had already been demonstrated.
    symlinkedArtifacts: [...findSymlinks(OUTPUT_DIR), ...findHardlinkedUnder(OUTPUT_DIR)],
  // BOTH source roots (round-11 finding C). `src/` is compiled and executed
  // just as `tests/` is, and scanning only `tests/` enforced less than the
  // threat model above claims. Same policy, same already-documented
  // legitimate-hardlink false positive — applied consistently rather than to
  // whichever directory happened to be named first.
    symlinkedSources: [
      ...new Set([
        ...SOURCE_ROOTS.flatMap((root) => findSymlinks(root, () => true, true)),
        ...SOURCE_ROOTS.flatMap((root) => findHardlinkedSources(root)),
        ...linkedCompilerInputs(),
      ]),
    ].sort(),
    buildEmitsNothing: noEmit,
    checkerFreshlyEmitted: checkerIsFresh,
  });
  if (!safety.safe) {
    fail(`verification refused ${stage}: ${safety.reason}`);
  }

  const outputVerdictNow = checker.assessOutputDirectory({
    repositoryRoot: REPO_ROOT,
    realRepositoryRoot: realOrUndefined(REPO_ROOT) ?? REPO_ROOT,
    configuredOutputDirectory: OUTPUT_DIR,
    outputDirectory: join(REPO_ROOT, OUTPUT_DIR),
    realOutputDirectory: realOrUndefined(join(REPO_ROOT, OUTPUT_DIR)),
    resolvedTsconfigOutDir: resolvedPath(effectiveConfig.compilerOptions.outDir),
  });
  if (!outputVerdictNow.trusted) {
    fail(`verification refused ${stage}: ${outputVerdictNow.reason}`);
  }

  const mountNow = checker.assessMountTopology({
    platform: process.platform,
    mountInfo: readMountInfo(),
    outputDirectory: join(REPO_ROOT, OUTPUT_DIR),
    realOutputDirectory: realOrUndefined(join(REPO_ROOT, OUTPUT_DIR)),
  });
  if (!mountNow.safe) {
    fail(`verification refused ${stage}: ${mountNow.reason}`);
  }

  assertEverythingWasReadable(stage);
  assertEverythingWasRegular(stage);
}
assertTreeIsSafe("after building", checkerFreshlyEmitted);

// --- 5. audit every artifact that could RUN, anywhere in the output ----------
/**
 * DISCOVERED FROM THE DERIVED ROOTS (round-9 AC-1 finding).
 *
 * `listFiles("tests")` was the same hard-coded guess the roots used to be: a
 * test the config declares elsewhere was compiled, matched no source, and was
 * reported as an orphan of the tree that legitimately produced it.
 */

const sourceTests = allSources.filter((path) => checker.isSourceTest(path));

/**
 * THE REQUIRED DELIVERABLE SET IS A LITERAL HERE, AND THE GIT QUESTION FAILS
 * CLOSED (round-14 review, CRITICAL 1 and HIGH 2).
 *
 * FIVE ROUNDS, ONE ATTACK, EACH FIX ADDRESSING THE SPELLING RATHER THAN THE
 * CLASS:
 *
 *   round 8   the guard rested on the manifest's ENTRIES   -> comment them out
 *   round 12  it rested on the ANCHOR file                 -> delete the workflow
 *   round 13  it rested on `workflowPolicy.ts`             -> delete that too
 *   round 14  it rested on the manifest's CONTENTS         -> shrink the manifest
 *
 * Round 13 moved the EXISTENCE question to HEAD and left the CONTENTS question
 * in the working tree, so round 14 kept the committed path and replaced its
 * contents with a single benign entry pointing at a trivial surviving test. The
 * same round redirected `GIT_DIR` at an empty repository: `git ls-tree` failed,
 * the `catch` returned `false`, and the guard switched itself off. Absent
 * evidence read as permission — the shape this repository has produced more
 * often than any other.
 *
 * TWO SEPARATE MISTAKES, SO TWO SEPARATE REPAIRS.
 *
 * 1. WHAT is required no longer lives in a file the tree can edit. The list is
 *    a literal below, so shrinking the manifest cannot shrink the requirement.
 *
 * 2. WHETHER it is required consults NO SUBPROCESS AT ALL. `.git` present means
 *    this is a repository and the deliverable is owed — read from the
 *    filesystem, so there is nothing to redirect and nothing to make fail.
 *    Asking git and refusing when it cannot answer would also have closed the
 *    hole, but a question never asked cannot be answered wrongly.
 *
 * WHY NOT AN IDENTITY CHECK. The obvious repair — "is this the repository that
 * owes the deliverable?" — is the round-4 CRITICAL: keying the gate on the
 * package NAME let a one-word rename disable it, and
 * `tests/workflowPolicy.test.ts` still asserts this verifier nowhere names this
 * repository. A first attempt at this round reintroduced exactly that and was
 * caught by that case. Any identity a tree asserts about itself is a switch, and
 * a switch can be thrown.
 *
 * WHY NOT UNCONDITIONAL. The verifier is legitimately run against synthetic
 * trees — the fixtures in `tests/verificationHarnessEndToEnd.test.ts` build
 * repositories with deliberately unusual source roots, several of which cannot
 * even load a manifest. Requiring the deliverable there would couple every
 * unrelated fixture to this machinery and mask the guards those fixtures exist
 * to test. They are not git repositories, which is precisely what distinguishes
 * them from a candidate.
 *
 * RESIDUAL LIMIT, RECORDED RATHER THAN PAPERED OVER: deleting `.git` outright
 * skips this. That is L-18. A tree with no `.git` has no candidate SHA, no
 * fingerprint and no criteria history, so it cannot be reviewed or integrated by
 * any part of this system — the bypass costs the attacker the thing the attack
 * was for. Substituting this verifier is likewise outside the local threat model
 * (L-17), defended by clean checkout and independent review.
 */
const REQUIRED_GUARDS = [
  { module: "src/verification/workflowPolicy.ts", test: "tests/workflowPolicy.test.ts" },
  { module: "src/verification/workflowDocument.ts", test: "tests/workflowPolicy.test.ts" },
  { module: "src/verification/workflowDigest.ts", test: "tests/workflowDigest.test.ts" },
];
const REQUIRED_ANCHOR = ".github/workflows/verify.yml";
const MANIFEST_SOURCE = "src/verification/guardedModules.ts";

/**
 * A repository owes the deliverable. `.git` may be a directory or, in a linked
 * worktree, a file — both count, and both are read with `existsSync` rather than
 * by asking git, so the question of whether we are in a repository cannot itself
 * be answered by a subprocess an attacker can break.
 */
const looksLikeRepository = existsSync(join(REPO_ROOT, ".git"));


const generatedFiles = listFiles(OUTPUT_DIR);
const compiledTests = generatedFiles.filter((path) => checker.isTestArtifact(path));
assertEverythingWasReadable("before auditing");
/**
 * RESTORED (round-23), because the reviewer answered the question I put to them.
 *
 * Round 19 deleted this call: measurement showed the three
 * `assertEverythingWasRegular` sites masked each other, so no single removal
 * failed anything. Round 22 then found the SAME thing true of
 * `assertEverythingWasReadable("before auditing")` — removing it left 107/107
 * green — and I kept that one, which left two identical situations treated
 * oppositely. I flagged the inconsistency rather than resolving it alone.
 *
 * The answer: keep both. Under a frozen AC-5, restoring the deleted guard is
 * the correct way to make them consistent, not deleting a second one. Neither
 * is individually pinned and both are recorded as masked in L-8; that is what
 * the register is for.
 */
assertEverythingWasRegular("before auditing");
let audit = checker.auditTestArtifacts({
  sourceTests,
  compiledTests,
  sources: allSources,
  generated: generatedFiles,
  layout: EMIT_LAYOUT,
});

// --- 6. contaminated? report it, repair it, and re-audit the REBUILT tree ----
// Bounded to exactly ONE repair cycle: clean, rebuild from source, re-audit.
// Anything still inconsistent after that is not stale output, it is a real
// source/artifact disagreement, and it fails closed. There is no loop.
if (!audit.clean) {
  const diagnosis = checker.describeContamination(audit);
  // Reported before anything is touched, on stderr, naming the artifacts —
  // AC-2's "never silently ignored". A repair nobody is told about is the
  // silence this task exists to remove.
  console.error(`\n${diagnosis}\n`);
  console.error("Removing the stale build output and rebuilding from source, then re-auditing.\n");

  const cleanVerdict = checker.assessCleanTarget({
    repositoryRoot: REPO_ROOT,
    target: join(REPO_ROOT, OUTPUT_DIR),
    configuredOutputDirectory: OUTPUT_DIR,
  });
  if (!cleanVerdict.safe) {
    fail(`${diagnosis}\n\nThe stale output could NOT be removed: ${cleanVerdict.reason}`);
  }
  // Amended AC-2 requires a FAILURE, not a stack trace, when safe cleanup or the
  // rebuild cannot be completed. Both were previously unguarded: `rmSync`
  // throwing on a read-only parent, or `tsc` failing on the second pass, ended
  // the run with an uncaught exception. The exit code was non-zero either way,
  // which is why nothing noticed — but "fails closed" has to mean the verifier
  // decided to fail, not that it fell over on the way to deciding.
  /**
   * Removes the CONTENTS, not the directory (round-5 finding, and my own
   * regression).
   *
   * Accepting a `dist-alias -> dist` spelling was right — refusing an
   * equivalent name is a false positive. But cleanup then deleted `dist`
   * itself, leaving the alias dangling and the rebuild failing with TS5033,
   * which broke the convergence AC-4 requires. Emptying the directory achieves
   * the same thing without invalidating any path that points at it.
   */
  try {
    for (const entry of readdirSync(cleanVerdict.target)) {
      rmSync(join(cleanVerdict.target, entry), { recursive: true, force: true });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${diagnosis}\n\nThe stale output could NOT be removed: ${detail}`);
  }

  const rebuildStartedAt = Date.now();
  try {
    build();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${diagnosis}\n\nThe rebuild after cleaning FAILED, so the tree could not be returned to a verifiable state: ${detail}`);
  }
  // The rebuild must actually have emitted, or the re-audit would be judging an
  // empty directory and calling it consistent. Same discipline as the first
  // build, for the same reason.
  const rebuiltChecker = (() => {
    try {
      return statSync(CHECKER_PATH);
    } catch {
      return undefined;
    }
  })();
  const rebuiltCheckerIsFresh =
    rebuiltChecker !== undefined && rebuiltChecker.mtimeMs + 1000 >= rebuildStartedAt;
  if (!rebuiltCheckerIsFresh) {
    fail(`${diagnosis}\n\nThe rebuild after cleaning did not emit the verification checker; refusing to report a tree it could not rebuild`);
  }

  // The second build is a build like any other, so it is judged like one.
  assertTreeIsSafe("after the repair rebuild", rebuiltCheckerIsFresh);

  const rebuiltGenerated = listFiles(OUTPUT_DIR);
  const rebuiltCompiled = rebuiltGenerated.filter((path) => checker.isTestArtifact(path));
  audit = checker.auditTestArtifacts({
    sourceTests,
    compiledTests: rebuiltCompiled,
    sources: allSources,
    generated: rebuiltGenerated,
    layout: EMIT_LAYOUT,
  });
  if (!audit.clean) {
    // Survived a clean rebuild from source. That is not another branch's
    // leftovers; the tree genuinely disagrees with itself.
    fail(
      `${checker.describeContamination(audit)}\n\nThis survived a clean rebuild from source, so it is not stale ` +
        `output from another branch — the source tree and the build genuinely disagree. Verification fails.`,
    );
  }
  console.error("Stale output removed and rebuilt; the rebuilt tree is consistent. Continuing.\n");
}

// --- 6a. the manifest, read from the output the build actually produced ----
/**
 * ONE READ, AFTER THE REPAIR, FOR EVERY TREE (round-16 review, HIGH 2).
 *
 * The manifest used to be imported near the top of this file, before the
 * stale-output repair, and three consumers read that value: the anchor check,
 * `unguarded`, and the empty-manifest guard. Round 15 fixed the required-set
 * check alone by re-importing inside its own branch, and round 16 walked
 * straight through the gap that left — on a tree with no `.git` the re-import
 * never happened, so a preseeded `dist` manifest satisfied the empty-manifest
 * guard while the rebuilt manifest was absent. Exit 0, one test run.
 *
 * Repairing three consumers separately would have been three chances to miss
 * one, which is how round 15 became round 16. There is now a single read, it
 * happens after the rebuild, and everything downstream uses it.
 */
/**
 * GUARDED MODULES AND THE TESTS THAT GUARD THEM (TASK-017 rounds 3-8).
 *
 * The list itself lives in `src/verification/guardedModules.ts` and is imported
 * from the COMPILED module, so the verifier and its tests read the same values.
 * It used to live here with tests asserting this file's SOURCE TEXT, and
 * commenting every entry out then left the text present, the tests passing, and
 * the runtime manifest empty (round-8 review, HIGH 4).
 *
 * A pair means: if the MODULE is present, the TEST must be present, compiled,
 * and must MENTION the module. An ANCHOR makes a pair mandatory even when the
 * module is gone, because removing a module and its test together once left the
 * shipped workflow completely unvalidated.
 *
 * NO CACHE-BUSTER, AND THE REASON IS THE POINT. Round 15 imported this module
 * twice — once near the top of the file and once after the repair — and the
 * second import needed `?v=${Date.now()}` or Node would have returned the first
 * one, which was read from exactly the stale artifact the repair deleted. There
 * is now ONE import, after the rebuild, so there is no earlier copy to defeat.
 *
 * A mutation is what settled this: deleting the cache-buster changed nothing,
 * because nothing could depend on it. Keeping it would have been a third
 * unfalsifiable claim in the same file. If a second read of this module is ever
 * added, it needs one again — and it should not be added.
 *
 * Imported dynamically, and a failure to load is DISTINCT from an empty
 * manifest: `manifest` is `undefined` when the import threw and an array when
 * it did not. Round 8 emptied the entries; round 16 arranged for the file to be
 * absent from the rebuilt output. Those need different messages, so `guarded`
 * is the value the checks below iterate and `manifest` is the value that says
 * whether there was anything to iterate at all.
 */
const manifest = await (async () => {
  try {
    const url = `file://${join(REPO_ROOT, OUTPUT_DIR, "src/verification/guardedModules.js")}`;
    const loaded = await import(url);
    return loaded.GUARDED_MODULES ?? [];
  } catch {
    return undefined;
  }
})();
const guarded = manifest ?? [];

const unguarded = guarded.flatMap(({ module, test, marker, anchor }) => {
  /**
   * A DECLARED ANCHOR MUST EXIST (round-12 review, HIGH 1).
   *
   * The anchor used to be consulted only when the anchor FILE was still there,
   * which made the guard conditional on the very thing an attacker deletes.
   * Removing the workflow, all four modules and both test files together left
   * the suite green at 102 test files — the entire deliverable gone, and
   * verification reporting success.
   *
   * The requirement is now tied to the DECLARATION rather than to the artifact:
   * this manifest says `.github/workflows/verify.yml` is guarded, so it has to
   * be there. Removing the workflow legitimately means removing these entries
   * too, which is a visible diff in a file whose whole purpose is to be read.
   */
  const anchored = anchor !== undefined;
  if (anchored && !existsSync(join(REPO_ROOT, module))) {
    return [[module, test, `is missing while ${anchor} is still present and unvalidated`]];
  }
  if (!existsSync(join(REPO_ROOT, module))) return [];
  if (!existsSync(join(REPO_ROOT, test))) return [[module, test, "is missing"]];
  if (!sourceTests.includes(test)) return [[module, test, "exists but is not compiled, so it never runs"]];
  let body = "";
  try {
    body = readFileSync(join(REPO_ROOT, test), "utf8");
  } catch {
    return [[module, test, "could not be read"]];
  }
  if (!body.includes(marker)) {
    return [[module, test, `never mentions ${marker}, so it does not guard this module`]];
  }
  return [];
});

/**
 * A DECLARED ANCHOR MUST BE IN THE TREE (round-12 review, HIGH 1).
 *
 * The anchor used to be consulted only when the anchor FILE still existed,
 * which made the guard conditional on the very thing an attacker deletes.
 * Removing the workflow, all four verification modules and both test files
 * together left the suite green at 102 test files: the entire deliverable gone,
 * and verification reporting success.
 *
 * The requirement is tied to the DECLARATION instead. This manifest says
 * `.github/workflows/verify.yml` is guarded, so it has to be there. Removing
 * the workflow legitimately means removing those entries too, which is a
 * visible diff in a file whose whole purpose is to be read.
 *
 * Reported separately from `unguarded` because the subject is different: that
 * message is about a module lacking its test, and this is about the manifest
 * naming an artifact the tree does not have.
 */
const missingAnchors = [
  ...new Set(
    guarded
      .filter(({ anchor }) => anchor !== undefined && !existsSync(join(REPO_ROOT, anchor)))
      .map(({ anchor }) => anchor),
  ),
];
if (missingAnchors.length > 0) {
  fail(
    "verification refused: the guarded-module manifest anchors " +
      missingAnchors.map((anchor) => `\`${anchor}\``).join(", ") +
      ", which the tree does not contain. Deleting the artifact a guard exists for does not remove the guard; " +
      "removing it deliberately means removing its manifest entries in the same change.",
  );
}

if (unguarded.length > 0) {
  fail(
    "verification refused: a guarded module is present without the test that guards it — " +
      unguarded.map(([module, test, why]) => `${module} needs ${test}, which ${why}`).join("; ") +
      ". These pin safety properties whose loss would otherwise be silent, so this is a " +
      "verification failure rather than a smaller test run.",
  );
}



/**
 * ONE GUARD, ONE TRIGGER, TWO DIAGNOSES (round-8 bypass; round-16 HIGH 2).
 *
 * A manifest that says nothing disables every deletion guard at once, and there
 * are two ways to arrange that: EMPTY the entries (round 8 commented them out)
 * or arrange for the file to be ABSENT from the rebuilt output (round 16
 * preseeded `dist` and excluded the source from compilation).
 *
 * These were briefly two checks. They are one, because their trigger condition
 * is identical — the source is present and the run has no entries — so a
 * separate "unloadable" check could never be the SOLE reason for any refusal.
 * That is the unfalsifiable-claim shape this task has now deleted three times.
 * What genuinely differs is the DIAGNOSIS, so that is what branches, and a
 * mutation can switch the branch off and be killed by the case that names it.
 *
 * Keyed on the SOURCE being present, so a tree that legitimately declares no
 * manifest owes nothing. Placed BEFORE the required-set check because "the
 * manifest did not survive the build" is a more precise account of such a tree
 * than any list of pairs it failed to declare.
 */
if (existsSync(join(REPO_ROOT, MANIFEST_SOURCE)) && guarded.length === 0) {
  fail(
    manifest === undefined
      ? `verification refused: ${MANIFEST_SOURCE} could not be loaded from the rebuilt output. ` +
          "Every deletion guard reads it, so a manifest that does not survive the build disables all of them."
      : `verification refused: ${MANIFEST_SOURCE} produced no entries while its source is present. ` +
          "An empty manifest disables every deletion guard at once.",
  );
}

/**
 * A PAIR IS DECLARED ONCE (round-16 review, non-blocking note).
 *
 * The reviewer observed that a manifest may declare the same pair twice, that
 * nothing was bypassed by it, and that the handling was not explicit. Both
 * halves of that are worth acting on: a duplicate entry is checked twice and
 * reported twice, which is harmless, and it is also the shape that makes a
 * later "the manifest declares N pairs" claim quietly wrong.
 *
 * So it refuses rather than de-duplicating. Silently collapsing duplicates
 * would make the manifest's text and its meaning disagree, and this file exists
 * because that disagreement is where every round-8-to-16 finding lived.
 */
const declaredPairs = guarded.map(({ module, test }) => `${module} -> ${test}`);
const duplicatePairs = [...new Set(declaredPairs.filter((pair, index) => declaredPairs.indexOf(pair) !== index))];
if (duplicatePairs.length > 0) {
  fail(
    "verification refused: the guarded-module manifest declares " +
      duplicatePairs.map((pair) => `\`${pair}\``).join(", ") +
      " more than once. A pair checked twice is not checked harder, and a manifest whose text and meaning " +
      "disagree is how this guard has been defeated before.",
  );
}

// --- 6b. the deliverable must be present, compiled, paired AND EXECUTED -----
/**
 * SIXTH ITERATION OF ONE ATTACK (round-15 review, CRITICAL 1 and 2).
 *
 *   round 8   the guard rested on the manifest's ENTRIES    -> comment them out
 *   round 12  it rested on the ANCHOR file                  -> delete the workflow
 *   round 13  it rested on `workflowPolicy.ts`              -> delete that too
 *   round 14  it rested on the manifest's CONTENTS          -> shrink the manifest
 *   round 15  it rested on the manifest's module->TEST pair -> relabel the pair,
 *                                                              or stop compiling
 *
 * Round 14 moved WHICH MODULES are required into this file and left WHICH TEST
 * GUARDS EACH of them in the manifest, on the reasoning that `unguarded`
 * separately requires that test to exist, compile and mention its marker. That
 * reasoning was wrong, and the review broke it exactly: point all three required
 * modules at ONE trivial compiled test containing all three markers, delete the
 * real tests, and every check passed while the suite ran one trivial file.
 *
 * The second reproduction needed no relabelling at all — exclude the required
 * modules from `tsconfig.json`. They still exist, the manifest still names them,
 * and nothing they guard ever runs. `verification complete: 1 test files`.
 *
 * So presence is not the property worth checking. EXECUTION is:
 *
 *   - the module must exist AND be compiled, or nothing it guards can run;
 *   - the test must exist AND be in the set this run actually EXECUTES;
 *   - the manifest must pair them the way THIS FILE says, so relabelling a pair
 *     is a divergence from the verifier rather than a redefinition of the rule;
 *   - the manifest source itself must be compiled, so it cannot be excluded from
 *     the build and served from a preseeded stale artifact.
 *
 * PLACED AFTER THE STALE-OUTPUT REPAIR, deliberately. Round 15's second
 * reproduction preseeded a stale `dist` manifest, let the repair remove and
 * rebuild it, and exited 0 because the guard had already read the stale copy and
 * was never re-run. `audit.expected` here is the post-repair set — the tests
 * this process is about to execute, not the ones it hoped to.
 */
if (looksLikeRepository) {
  const shortfalls = [];

  for (const { module, test } of REQUIRED_GUARDS) {
    if (!existsSync(join(REPO_ROOT, module))) {
      shortfalls.push(`${module} is missing from the working tree`);
    } else if (!allSources.includes(module)) {
      shortfalls.push(`${module} is present but not compiled, so nothing that guards it runs`);
    }

    /**
     * THE TEST MUST EXIST. Whether it is COMPILED is deliberately not re-checked
     * here: `audit.expected` is `sourceTests` mapped one-to-one, and `unguarded`
     * above already requires `sourceTests.includes(test)` for every declared
     * pair — so a second check could never fire on its own. A mutation proved
     * exactly that by switching it off with nothing failing. A guard that cannot
     * be the sole reason for a refusal is not defence in depth, it is an
     * unfalsifiable claim, and this repository has spent six rounds learning to
     * delete those rather than keep them.
     *
     * The pairing check below is what makes `unguarded` load-bearing for the
     * REQUIRED set: it forces the manifest to name this exact test, so
     * `unguarded` cannot be satisfied by a relabelled trivial survivor.
     */
    if (!existsSync(join(REPO_ROOT, test))) {
      shortfalls.push(`${test}, which must guard ${module}, is missing from the working tree`);
    }

    if (!guarded.some((entry) => entry.module === module && entry.test === test)) {
      shortfalls.push(`${MANIFEST_SOURCE} does not pair ${module} with ${test}`);
    }
  }

  if (!existsSync(join(REPO_ROOT, REQUIRED_ANCHOR))) {
    shortfalls.push(`${REQUIRED_ANCHOR} is missing from the working tree`);
  }

  if (shortfalls.length > 0) {
    fail(
      "verification refused: this repository does not run the deliverable this verifier exists to check.\n" +
        shortfalls.map((line) => `  - ${line}`).join("\n") +
        `\nThe required pairs are a literal in scripts/verify.mjs precisely so that editing ${MANIFEST_SOURCE}, ` +
        "deleting files, excluding them from compilation, or breaking git cannot shrink them. Removing this " +
        "deliverable legitimately means editing REQUIRED_GUARDS in the verifier — a visible, deliberate diff.",
    );
  }
}
  // --- 6c. and the tests must DETECT a change in what they guard -----------
  /**
   * SEVENTH ITERATION OF ONE ATTACK (round-16 review, CRITICAL 1).
   *
   *   round 8   the guard rested on the manifest's ENTRIES    -> comment them out
   *   round 12  it rested on the ANCHOR file                  -> delete the workflow
   *   round 13  it rested on `workflowPolicy.ts`              -> delete that too
   *   round 14  it rested on the manifest's CONTENTS          -> shrink the manifest
   *   round 15  it rested on the module->TEST pair            -> relabel it, or
   *                                                              stop compiling
   *   round 16  it rested on PRESENCE                         -> keep every file,
   *                                                              empty them all
   *
   * Round 16 kept `.git`, the workflow, the manifest and every exact pair, and
   * replaced the three required modules with `export {};` and their paired tests
   * with marker-bearing bodies containing no assertions. Presence, compilation
   * and pairing all held. Exit 0, three tests executed, nothing guarded.
   *
   * Every previous fix asked a question about FILES. This one asks a question
   * about BEHAVIOUR, which is the only kind an empty file cannot satisfy: each
   * required test is run against a version of its module whose every export has
   * been replaced, and it must FAIL. A test that passes either way does not
   * guard anything, whatever it is named and wherever it is declared.
   *
   * WHAT THIS PROVES, EXACTLY, and no more: that the paired test EXERCISES the
   * module. A test that calls into it and asserts nothing about the result
   * would still fail here, because the replacement throws. Proving the
   * assertions are MEANINGFUL is what `scripts/mutate.mjs` is for, and L-19
   * records the boundary rather than letting this look like more than it is.
   *
   * The substitution happens in an ESM load hook, so nothing on disk changes:
   * the tree stays byte-identical, `cwd` stays this repository, and every path
   * a test resolves relative to the repository root still resolves.
   */
if (looksLikeRepository) {
  /**
   * SUBSTITUTED IN PLACE, WITH A BASELINE AND A TIMEOUT (round-17 CRITICAL,
   * HIGH 2).
   *
   * The first version of this canary passed the replacement through the
   * environment and installed it with an ESM load hook, then treated ANY
   * non-zero exit as detection. Round 16's reviewer wrote a test that ignored
   * the module entirely and threw whenever `SF_CANARY_SOURCE` was set: it
   * "failed" on cue, the canary called that detection, and verification exited
   * 0 over a deliverable that guarded nothing. The mechanism announced itself
   * and then believed the answer it had prompted.
   *
   * Two things were wrong, and they need different repairs.
   *
   * 1. THE SUBSTITUTION MUST NOT BE VISIBLE. It now replaces the compiled
   *    module ON DISK and restores it, so there is no environment variable, no
   *    `--import` in `process.execArgv`, and nothing to key on except the
   *    module's own contents — which is the thing under test. This is what
   *    `scripts/mutate.mjs` has always done, and the reason it works.
   *
   * 2. A FAILURE MUST BE ATTRIBUTABLE. The test is run FIRST against its real
   *    module and must PASS. A test that fails either way tells us nothing, and
   *    counting it as detection is the empty-set-authority shape this
   *    repository has now found five times. Only a pass-then-fail pair is
   *    evidence, which is exactly the discipline mutation testing rests on.
   *
   * A run that neither passes nor fails — killed on timeout, or never spawned —
   * is UNMEASURED and refuses. Round 17 hung the verifier indefinitely with a
   * test that looped forever; silence is not a pass.
   */
  /**
   * A LABEL FOR ANYONE WHO SEES ONE, NOT A GUARD.
   *
   * An earlier version of this section refused when a compiled module still
   * held the marker, reasoning that an interrupted run could leave a
   * replacement behind. A fixture proved that cannot happen: this project sets
   * no `incremental`, so every verification rebuilds and re-emits every module
   * before reaching here, and the poisoned copy is gone before it can be read.
   * The check could never fire, and an unfalsifiable claim is worse than no
   * claim — the fourth one deleted in three rounds. What protects the tree is
   * the restore in the `finally` below plus that unconditional rebuild.
   */
  const CANARY_MARKER = "SF_CANARY_REPLACEMENT";
  /**
   * LIVENESS, NOT CORRECTNESS, AND SHORTENABLE SO IT CAN BE EVIDENCED.
   *
   * Round 17 hung the verifier with a paired test that looped forever, and this
   * bounds that. A timeout is also the ONLY way a canary run reaches the
   * "neither passed nor failed" path: `node --test` runs each file in a child,
   * so a test that kills itself still leaves the runner exiting non-zero, which
   * is an ordinary failure. Without a shortenable bound the unmeasured branch
   * could not be reached by any fixture that finishes in reasonable time, and
   * an unreachable branch is the shape this task has deleted four times.
   *
   * So the override exists to make the branch testable, and it can only
   * SHORTEN. Setting it low makes canary runs unmeasured, which refuses; there
   * is no value that makes anything pass that would otherwise fail.
   *
   * NO MUTATION COVERS THE OVERRIDE ITSELF, deliberately and stated rather than
   * left to be discovered: removing it changes no outcome, only how long the
   * fixture waits. It is an affordance, not a guard, and pretending otherwise
   * would be one more unfalsifiable claim.
   */
  const CANARY_TIMEOUT_MS = Math.min(120_000, Number(process.env["SF_CANARY_TIMEOUT_MS"]) || 120_000);

  const runPairedTest = (artifact) => {
    const env = { ...process.env };
    delete env["NODE_TEST_CONTEXT"];
    const run = spawnSync(process.execPath, ["--test", artifact], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: CANARY_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env,
    });
    /**
     * ONE CONDITION. These were two clauses — `run.error` and a null status —
     * and a mutation switched the second off with nothing failing, because a
     * timeout sets BOTH and the first already caught it. The remaining case for
     * a null status without an error is a child killed from outside, which the
     * merged condition covers. The detail reports every fact rather than
     * branching on one, so there is no untested arm of a message either.
     */
    if (run.error !== undefined || run.status === null) {
      return {
        outcome: "unmeasured",
        detail:
          `the run did not complete (error: ${run.error?.message ?? "none"}, ` +
          `signal: ${run.signal ?? "none"}, status: ${run.status ?? "none"})`,
      };
    }
    return { outcome: run.status === 0 ? "passed" : "failed", detail: `exit ${run.status}` };
  };

  const undetected = [];
  for (const { module, test } of REQUIRED_GUARDS) {
    const compiledModule = join(REPO_ROOT, checker.compiledPathForSource(module, EMIT_LAYOUT));
    const testArtifact = join(REPO_ROOT, checker.compiledPathForSourceTest(test, EMIT_LAYOUT));

    let original;
    try {
      original = readFileSync(compiledModule, "utf8");
    } catch (error) {
      undetected.push(
        `${module} could not be read from the build: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    let real;
    try {
      real = await import(`file://${compiledModule}`);
    } catch (error) {
      undetected.push(
        `${module} could not be loaded from the build: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    /**
     * NOTHING TO REPLACE IS NOTHING TO DETECT. `export {};` compiles, is
     * paired, and is exactly what round 16 shipped in place of the deliverable.
     */
    const names = Object.keys(real);
    if (names.length === 0) {
      undetected.push(`${module} exports nothing at run time, so no test could detect a change in it`);
      continue;
    }

    const baseline = runPairedTest(testArtifact);
    if (baseline.outcome !== "passed") {
      undetected.push(
        `${test} does not pass against its own ${module} (${baseline.detail}), so nothing it does against a ` +
          "replaced one could be attributed to the replacement",
      );
      continue;
    }

    const replacement = [
      `// ${CANARY_MARKER}`,
      ...names.map((name) => {
        const sentinel = 'Object.freeze({ sfCanary: "replaced" })';
        if (name === "default") {
          return typeof real[name] === "function"
            ? 'export default function () { throw new Error("SF_CANARY"); }'
            : `export default ${sentinel};`;
        }
        return typeof real[name] === "function"
          ? `export function ${name}() { throw new Error("SF_CANARY"); }`
          : `export const ${name} = ${sentinel};`;
      }),
    ].join("\n");

    let substituted;
    try {
      writeFileSync(compiledModule, replacement);
      substituted = runPairedTest(testArtifact);
    } finally {
      writeFileSync(compiledModule, original);
    }

    if (substituted.outcome === "passed") {
      undetected.push(
        `${test} passes against a ${module} whose every export has been replaced, so it does not exercise it`,
      );
    } else if (substituted.outcome !== "failed") {
      undetected.push(`${test} could not be measured against a replaced ${module}: ${substituted.detail}`);
    }
  }

  if (undetected.length > 0) {
    fail(
      "verification refused: this repository runs the tests that name the deliverable, but they do not guard it.\n" +
        undetected.map((line) => `  - ${line}`).join("\n") +
        "\nEach required test had to PASS against its own module and FAIL against a build of it with every export " +
        "replaced. A test that passes either way is a label rather than a guard; one that fails either way proves " +
        "nothing about the module at all.",
    )
  }
}



// --- 7. refuse a run that would prove nothing -------------------------------
const emptiness = checker.assertRunnableSuite(audit.expected);
if (emptiness !== undefined) {
  fail(emptiness);
}

// --- 8. run exactly the tests this tree declares ----------------------------
for (const path of audit.expected) {
  statSync(join(REPO_ROOT, path));
}
console.log(`verifying ${audit.expected.length} test files derived from source\n`);
try {
  execFileSync(process.execPath, ["--test", ...audit.expected], { cwd: REPO_ROOT, stdio: "inherit" });
} catch {
  process.exit(1);
}
console.log(`\nverification complete: ${audit.expected.length} test files, tree-consistent`);
