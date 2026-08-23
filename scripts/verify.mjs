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
 * ON CONTAMINATION IT FAILS, LOUDLY. An earlier version cleaned, rebuilt and
 * exited 0 — contradicting this task's own frozen AC-2 ("causes verification to
 * FAIL with a message naming the orphan"). A verifier that silently repairs the
 * condition it exists to detect teaches everyone that contamination is normal.
 * It still cleans, so the NEXT run is honest; but this run names the problem and
 * exits non-zero.
 */

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = "dist";
const CHECKER_PATH = join(REPO_ROOT, OUTPUT_DIR, "src/verification/testArtifacts.js");

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

/** Symlinked entries anywhere beneath a directory, as repo-relative paths. */
function findSymlinks(directory, keep = () => true) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      const rel = relative(REPO_ROOT, full).replace(/\\/g, "/");
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

/** The `outDir` tsconfig actually declares — not the one this script assumes. */
function declaredOutDir() {
  const raw = readFileSync(join(REPO_ROOT, "tsconfig.json"), "utf8");
  // tsconfig permits comments; JSON.parse does not.
  const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const outDir = JSON.parse(stripped)?.compilerOptions?.outDir;
  if (typeof outDir !== "string" || outDir.trim().length === 0) {
    fail("tsconfig.json declares no outDir; verification cannot know where the build lands");
  }
  return outDir;
}

function listFiles(directory) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      // Deliberately do NOT follow directory symlinks: a linked subtree is not
      // part of this build, and walking into it would pull someone else's
      // artifacts into the audit as though they belonged here.
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(full);
      } else if (entry.isFile()) {
        found.push(relative(REPO_ROOT, full).replace(/\\/g, "/"));
      }
    }
  };
  walk(join(REPO_ROOT, directory));
  return found.sort();
}

function build() {
  execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: REPO_ROOT, stdio: "inherit" });
}

// --- 1. does tsconfig build where we manage? ---------------------------------
// Checked BEFORE building, and inline rather than through the tested checker,
// because the checker is imported FROM the output directory — if that is not
// where tsc writes, the import fails first and the operator gets a module-not-
// found stack instead of the real diagnosis. Deliberately a plain string
// comparison, with the substantive realpath/symlink rules still applied by the
// tested function once the checker exists.
const declared = declaredOutDir().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
if (declared !== OUTPUT_DIR) {
  fail(
    `verification refused: tsconfig builds into ${JSON.stringify(declared)} but verification manages ` +
      `${JSON.stringify(OUTPUT_DIR)}; they must be the same directory or stale artifacts elsewhere would be executed`,
  );
}

// --- 2. refuse an unreasonable tree BEFORE building --------------------------
// Building is itself a write through whatever these paths resolve to, so the
// structural checks that do not need the compiled checker happen first. A
// symlinked output directory was previously refused only AFTER the build had
// already written into the external target.
const tsconfigRaw = readFileSync(join(REPO_ROOT, "tsconfig.json"), "utf8");
const noEmit = /"noEmit"\s*:\s*true/.test(tsconfigRaw);
if (isSymlink(join(REPO_ROOT, "tests"))) {
  fail("verification refused: the tests directory is a symlink; an external suite would be compiled and executed as though it belonged to this tree");
}
if (isSymlink(join(REPO_ROOT, OUTPUT_DIR))) {
  fail("verification refused: the build output directory is a symlink; the build would write outside the repository");
}
const rootDevice = deviceOf(REPO_ROOT);
const outputDevice = deviceOf(join(REPO_ROOT, OUTPUT_DIR));
if (outputDevice !== undefined && rootDevice !== undefined && outputDevice !== rootDevice) {
  fail("verification refused: the build output directory is on a different device (a mount or bind mount); a recursive delete could reach outside the repository");
}
if (noEmit) {
  fail("verification refused: tsconfig sets noEmit, so the build produces nothing and any audit would run against whatever was already there");
}

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

// --- 3b. the realpath-based output check, now that the checker exists -------
// A path is judged by what it RESOLVES to, not by its name. `rmSync` does not
// follow a symlinked `dist`, which looked safe — but `tsc`, this import and the
// test runner all do.
const outputVerdict = checker.assessOutputDirectory({
  repositoryRoot: REPO_ROOT,
  realRepositoryRoot: realOrUndefined(REPO_ROOT) ?? REPO_ROOT,
  configuredOutputDirectory: OUTPUT_DIR,
  outputDirectory: join(REPO_ROOT, OUTPUT_DIR),
  realOutputDirectory: realOrUndefined(join(REPO_ROOT, OUTPUT_DIR)),
  tsconfigOutDir: declaredOutDir(),
});
if (!outputVerdict.trusted) {
  fail(`verification refused: ${outputVerdict.reason}`);
}

// --- 4. the full tested safety judgement, now that the checker exists --------
const safety = checker.assessTreeSafety({
  testsRootIsSymlink: isSymlink(join(REPO_ROOT, "tests")),
  outputIsSymlink: isSymlink(join(REPO_ROOT, OUTPUT_DIR)),
  outputOnDifferentDevice:
    outputDevice !== undefined && rootDevice !== undefined && outputDevice !== rootDevice,
  // A symlinked artifact is neither `isFile()` nor `isDirectory()` to `readdir`,
  // so the ordinary walk cannot see it — which made a symlinked stale test
  // invisible to the audit while still being runnable.
  symlinkedArtifacts: findSymlinks(OUTPUT_DIR, (path) => checker.isTestArtifact(path)),
  symlinkedSources: findSymlinks("tests"),
  buildEmitsNothing: noEmit,
  checkerFreshlyEmitted,
});
if (!safety.safe) {
  fail(`verification refused: ${safety.reason}`);
}

// --- 5. audit every artifact that could RUN, anywhere in the output ----------
const sourceTests = listFiles("tests").filter((path) => path.endsWith(".test.ts"));
const compiledTests = listFiles(OUTPUT_DIR).filter((path) => checker.isTestArtifact(path));
const audit = checker.auditTestArtifacts({ sourceTests, compiledTests });

// --- 6. contaminated? clean so the next run is honest, then FAIL ------------
if (!audit.clean) {
  const diagnosis = checker.describeContamination(audit);
  const cleanVerdict = checker.assessCleanTarget({
    repositoryRoot: REPO_ROOT,
    target: join(REPO_ROOT, OUTPUT_DIR),
    configuredOutputDirectory: OUTPUT_DIR,
  });
  if (!cleanVerdict.safe) {
    fail(`${diagnosis}\n\nThe stale output could NOT be removed: ${cleanVerdict.reason}`);
  }
  rmSync(cleanVerdict.target, { recursive: true, force: true });
  fail(`${diagnosis}\n\nThe stale output has been removed. Re-run to verify a clean tree.`);
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
