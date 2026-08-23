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
import { readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = "dist";

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

// --- 2. build, so the tested checker exists ----------------------------------
build();
const checker = await import(
  `file://${join(REPO_ROOT, OUTPUT_DIR, "src/verification/testArtifacts.js")}`
);

// --- 2. is the output directory trustworthy at all? --------------------------
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

// --- 3. audit every artifact that could RUN, anywhere in the output ----------
const sourceTests = listFiles("tests").filter((path) => path.endsWith(".test.ts"));
const compiledTests = listFiles(OUTPUT_DIR).filter((path) => checker.isTestArtifact(path));
const audit = checker.auditTestArtifacts({ sourceTests, compiledTests });

// --- 4. contaminated? clean so the next run is honest, then FAIL -------------
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

// --- 5. refuse a run that would prove nothing --------------------------------
const emptiness = checker.assertRunnableSuite(audit.expected);
if (emptiness !== undefined) {
  fail(emptiness);
}

// --- 6. run exactly the tests this tree declares ------------------------------
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
