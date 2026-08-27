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
 * and hardlinks that pull code in from outside the tree, under BOTH source roots
 * (`src/` and `tests/`, not `tests/` alone); an `emitDeclarationOnly` build that
 * exits 0 having emitted no JavaScript; a bind-mounted output directory that a
 * recursive delete would reach through, INCLUDING a same-device bind mount that
 * no device-number comparison can see; and a run that would report success
 * having executed nothing.
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
  return realOrUndefined(absolute) ?? absolute;
}

/** True when two path spellings name one directory. */
function sameDirectory(a, b) {
  return resolvedPath(a) === resolvedPath(b);
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
if (isSymlink(join(REPO_ROOT, "tests"))) {
  fail("verification refused: the tests directory is a symlink; an external suite would be compiled and executed as though it belonged to this tree");
}
if (isSymlink(join(REPO_ROOT, OUTPUT_DIR))) {
  fail("verification refused: the build output directory is a symlink; the build would write outside the repository");
}

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
const linkedSources = [
  ...findSymlinks("src"),
  ...findSymlinks("tests"),
  ...findHardlinkedSources("src"),
  ...findHardlinkedSources("tests"),
].sort();
if (linkedSources.length > 0) {
  fail(
    `verification refused before building: symlinked or hardlinked entries under the source roots (src/, tests/): ` +
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
const mountInfo = (() => {
  try {
    return readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return undefined;
  }
})();

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
  const outputPath = (realOrUndefined(join(REPO_ROOT, OUTPUT_DIR)) ?? join(REPO_ROOT, OUTPUT_DIR)).replace(/\/+$/, "");
  const earlyMountPoints = (mountInfo ?? "")
    .split("\n")
    .map((line) => line.trim().split(" ")[4])
    .filter((point) => typeof point === "string" && point.startsWith("/"))
    .map((point) => point.replace(/\\([0-7]{3})/g, (_m, o) => String.fromCharCode(Number.parseInt(o, 8))));
  if (mountInfo === undefined || earlyMountPoints.length === 0) {
    fail("verification refused: the mount table (/proc/self/mountinfo) could not be read, so it is unknown whether the build output is a mount point");
  }
  const offending = earlyMountPoints.find(
    (point) => point === outputPath || point.startsWith(`${outputPath}/`),
  );
  if (offending !== undefined) {
    fail(
      `verification refused before building: the build output directory is or contains a mount point (${offending}); ` +
        `the build would write into a separately mounted tree and a recursive delete would reach through it`,
    );
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
  // The EFFECTIVE outDir, which is validated above and always present. The raw
  // file may legitimately declare none (an `extends`-only config), so reading
  // it here would reintroduce the false positive this round removed.
  resolvedTsconfigOutDir: resolvedPath(effectiveConfig.compilerOptions.outDir),
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
  // BOTH source roots (round-11 finding C). `src/` is compiled and executed
  // just as `tests/` is, and scanning only `tests/` enforced less than the
  // threat model above claims. Same policy, same already-documented
  // legitimate-hardlink false positive — applied consistently rather than to
  // whichever directory happened to be named first.
  symlinkedSources: linkedSources,
  buildEmitsNothing: noEmit,
  checkerFreshlyEmitted,
});
if (!safety.safe) {
  fail(`verification refused: ${safety.reason}`);
}

// --- 4b. mount topology, the part `st_dev` cannot answer ---------------------
// DEFENCE IN DEPTH, and deliberately unreachable through the ordinary path: the
// pre-build refusal above already rejects a mounted output, so no fixture can
// arrive here with one. Its reachability is stated here rather than implied by
// a green test — the repository's established answer for a guard the public
// path cannot reach (see `resourceBindingHolds`). The DECISION is proven by the
// pure `assessMountTopology` tests, which mutation-check each clause; this call
// exists so that a future reordering which weakens the early check still meets a
// tested guard before anything is deleted.
const mountVerdict = checker.assessMountTopology({
  platform: process.platform,
  mountInfo,
  outputDirectory: join(REPO_ROOT, OUTPUT_DIR),
  realOutputDirectory: realOrUndefined(join(REPO_ROOT, OUTPUT_DIR)),
});
if (!mountVerdict.safe) {
  fail(`verification refused: ${mountVerdict.reason}`);
}

// --- 5. audit every artifact that could RUN, anywhere in the output ----------
const sourceTests = listFiles("tests").filter((path) => path.endsWith(".test.ts"));
const compiledTests = listFiles(OUTPUT_DIR).filter((path) => checker.isTestArtifact(path));
let audit = checker.auditTestArtifacts({ sourceTests, compiledTests });

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
  try {
    rmSync(cleanVerdict.target, { recursive: true, force: true });
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
  if (rebuiltChecker === undefined || rebuiltChecker.mtimeMs + 1000 < rebuildStartedAt) {
    fail(`${diagnosis}\n\nThe rebuild after cleaning did not emit the verification checker; refusing to report a tree it could not rebuild`);
  }

  const rebuiltCompiled = listFiles(OUTPUT_DIR).filter((path) => checker.isTestArtifact(path));
  audit = checker.auditTestArtifacts({ sourceTests, compiledTests: rebuiltCompiled });
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
