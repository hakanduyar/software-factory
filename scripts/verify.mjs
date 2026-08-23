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
 * discovered and run. Observed, not theorised: the isolated TASK-009 branch
 * reported 1372 tests including a TASK-008 test whose source was absent. It
 * failed, which is the only reason it was caught — one that merely passed would
 * have inflated the count in silence, and every ADR-0002 integration turns on
 * "deterministic verification passes".
 *
 * ORDER OF OPERATIONS, and why it is this way. The rule that decides what may be
 * deleted lives in tested TypeScript (`assessCleanTarget`), which means it is
 * only available once something has been compiled. So this builds FIRST, loads
 * the tested checker, and only then cleans — and cleans only when the audit
 * proves the tree is actually contaminated. A destructive step that runs
 * unconditionally, guarded by an untested inline copy of the rule, would be
 * worse on both counts.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = "dist";
const CHECKER = join(REPO_ROOT, OUTPUT_DIR, "src/verification/testArtifacts.js");

function listFiles(directory, suffix) {
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
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(suffix)) {
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

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function auditTree(checker) {
  return checker.auditTestArtifacts({
    sourceTests: listFiles("tests", ".test.ts"),
    compiledTests: listFiles(join(OUTPUT_DIR, "tests"), ".test.js"),
  });
}

// --- 1. build, so the tested checker exists ----------------------------------
build();

const checker = await import(`file://${CHECKER}`);

// --- 2. audit: does the compiled tree correspond to THIS tree? ----------------
let audit = auditTree(checker);

// --- 3. contaminated? clean (guarded) and rebuild, then insist it is fixed ----
if (!audit.clean) {
  console.log("stale build artifacts detected; cleaning and rebuilding\n");

  const target = join(REPO_ROOT, OUTPUT_DIR);
  const verdict = checker.assessCleanTarget({
    repositoryRoot: REPO_ROOT,
    target,
    configuredOutputDirectory: OUTPUT_DIR,
  });
  if (!verdict.safe) {
    fail(`verification refused to clean: ${verdict.reason}`);
  }

  rmSync(verdict.target, { recursive: true, force: true });
  build();

  const rebuilt = await import(`file://${CHECKER}?t=${Date.now()}`);
  audit = auditTree(rebuilt);
  if (!audit.clean) {
    // A clean rebuild that still disagrees is a genuine inconsistency, not
    // leftover state, so there is nothing left to try.
    fail(rebuilt.describeContamination(audit) ?? "tree remains inconsistent after a clean rebuild");
  }
}

// --- 4. run exactly the tests this tree declares ------------------------------
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
