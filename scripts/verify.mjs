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
 *
 * ================================================================
 * THREAT MODEL — what this defends against, and what it does not
 * ================================================================
 * DEFENDS AGAINST (the observed, real problem): gitignored build output that git
 * does not clean on checkout; stale artifacts from another branch; a partial or
 * redirected build; a misconfigured `outDir`; an inherited `noEmit`; symlinks
 * and hardlinks that pull code in from outside the tree; a bind-mounted output
 * directory that a recursive delete would reach through; and a run that would
 * report success having executed nothing.
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

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = "dist";
/** How long `--showConfig` may take before the run fails closed, saying so. */
const CONFIG_TIMEOUT_MS = 120_000;
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
  const found = [];
  for (const rel of listFiles(directory)) {
    if (!rel.endsWith(".ts") && !rel.endsWith(".mts") && !rel.endsWith(".cts")) continue;
    try {
      if (lstatSync(join(REPO_ROOT, rel)).nlink > 1) found.push(rel);
    } catch {
      /* unreadable entries are reported by the walk itself */
    }
  }
  return found.sort();
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
  if (resolve(REPO_ROOT, options.outDir) !== resolve(REPO_ROOT, OUTPUT_DIR)) {
    return (
      `the effective tsconfig builds into ${JSON.stringify(options.outDir)}, but verification manages ` +
      `${JSON.stringify(OUTPUT_DIR)}; the audit would examine a directory the build never wrote to`
    );
  }
  if (options.noEmit !== undefined && typeof options.noEmit !== "boolean") {
    return `noEmit is ${JSON.stringify(options.noEmit)}, which is not a boolean`;
  }
  return undefined;
})();
if (configProblem !== undefined) {
  fail(`verification refused: ${configProblem}; refusing to build a configuration it cannot read`);
}
const noEmit = effectiveConfig.compilerOptions.noEmit === true;
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
  // Worded differently from the `assessTreeSafety` clause that covers the same
  // condition later. Round-5 review observed that deleting this guard still
  // left the focused suite green, because the later guard caught it and said
  // almost the same words — so the test passed for a different reason than it
  // claimed. They are two checks at two different moments, and the distinct
  // thing this one can report is that NOTHING WAS BUILT.
  fail("verification refused before building: tsconfig sets noEmit, so the build would produce nothing and any audit would run against whatever was already there");
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
  // EVERY symlink under the output, not only those whose own name ends in
  // `.test.js` (round-3 finding B11). A symlinked DIRECTORY called
  // `foreign-output` was neither walked into nor reported, so an external
  // `ghost.test.js` inside it was invisible and the run reported a consistent
  // tree. Filtering by name meant the check only caught the shape of the escape
  // that had already been demonstrated.
  symlinkedArtifacts: findSymlinks(OUTPUT_DIR),
  symlinkedSources: [...findSymlinks("tests"), ...findHardlinkedSources("tests")].sort(),
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
