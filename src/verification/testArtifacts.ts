/**
 * VERIFICATION ARTIFACT INTEGRITY (TASK-010).
 *
 * ================================================================
 * THE INVARIANT
 * ================================================================
 *   A verification run must reflect the tree it is run against, and NOTHING
 *   ELSE. A branch may never appear verified against tests or code it does not
 *   contain.
 * ================================================================
 *
 * `dist/` is gitignored and git does not clean it on checkout, while the test
 * command discovered tests by globbing the compiled output. So compiled tests
 * from one branch survived into another branch's run. This was observed, not
 * theorised: the isolated TASK-009 branch reported 1372 tests including a
 * TASK-008 test whose source was not present. It failed, which is the only
 * reason anyone noticed — a stale artifact that merely PASSED would have
 * inflated the count in silence.
 *
 * That matters more than an ordinary bug because it corrupts the instrument.
 * Every ADR-0002 integration turns on "deterministic verification passes"; if
 * discovery can include foreign artifacts, that condition is satisfiable by code
 * from somewhere else entirely. Ten TASK-006 reviews were spent deleting tests
 * that passed for the wrong reason — this is the same defect one level up, at
 * the harness, where no amount of careful test-writing reaches it.
 *
 * Two independent properties, because either alone leaves a gap:
 *
 *   1. Discovery is derived from SOURCE, so an orphan is never executed.
 *   2. An orphan is an ERROR, so a contaminated tree is reported rather than
 *      quietly tolerated and left to confuse the next run.
 */

/** Where compiled test output is expected to live, relative to the repo root. */
export const SOURCE_TEST_ROOT = "tests";
export const COMPILED_TEST_ROOT = "dist/tests";

/**
 * Every suffix node's test runner will execute (review finding B4).
 *
 * The first version audited only `.test.js` beneath `dist/tests`, so a stale
 * `dist/ghost.test.js`, `dist/nested-dist/ghost.test.js` or
 * `dist/tests/ghost.test.mjs` sat untouched while verification still declared
 * the tree consistent. An audit that inspects a subset of what can RUN is not an
 * audit; it is a filter that resembles one.
 */
export const TEST_ARTIFACT_SUFFIXES: readonly string[] = Object.freeze([
  ".test.js",
  ".test.mjs",
  ".test.cjs",
]);

export function isTestArtifact(path: string): boolean {
  return TEST_ARTIFACT_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

/** Normalises a path so Windows and POSIX separators compare equal. */
function normalise(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * The compiled artifact a source test is expected to produce.
 *
 * `tests/a/b.test.ts` → `dist/tests/a/b.test.js`, matching the tsconfig
 * `rootDir: "."` / `outDir: "dist"` layout this repository uses.
 */
export function compiledPathForSourceTest(sourceRelativePath: string): string {
  const normalised = normalise(sourceRelativePath);
  if (!normalised.startsWith(`${SOURCE_TEST_ROOT}/`) || !normalised.endsWith(".test.ts")) {
    throw new Error(
      `not a source test path: ${JSON.stringify(sourceRelativePath)} (expected ${SOURCE_TEST_ROOT}/**/*.test.ts)`,
    );
  }
  return `dist/${normalised.slice(0, -".ts".length)}.js`;
}

export interface ArtifactAudit {
  /** Compiled tests to run, derived from source. Never from a dist glob. */
  readonly expected: readonly string[];
  /** Compiled tests with NO corresponding source — a stale/foreign tree. */
  readonly orphaned: readonly string[];
  /** Source tests with no compiled output — a partial or failed build. */
  readonly missing: readonly string[];
  readonly clean: boolean;
}

/**
 * Compares what SHOULD be there against what IS there.
 *
 * `missing` matters as much as `orphaned` (AC-3): without it, a build that
 * silently produced fewer files would run fewer tests and still report success,
 * which is the same lie told from the other direction.
 */
export function auditTestArtifacts(input: {
  readonly sourceTests: readonly string[];
  readonly compiledTests: readonly string[];
}): ArtifactAudit {
  const expected = [...input.sourceTests].map(compiledPathForSourceTest).sort();
  // Only genuine test artifacts count — but ALL of them, wherever they sit in
  // the output tree, not merely those under `dist/tests` (B4).
  const present = new Set(input.compiledTests.map(normalise).filter(isTestArtifact));
  const expectedSet = new Set(expected);

  const missing = expected.filter((path) => !present.has(path));
  const orphaned = [...present].filter((path) => !expectedSet.has(path)).sort();

  return {
    expected,
    orphaned,
    missing,
    clean: orphaned.length === 0 && missing.length === 0,
  };
}

/**
 * Refuses a verification run that would prove nothing (review finding B4).
 *
 * A repository with no test files reported `verifying 0 test files`, `0/0`,
 * exit 0 — and `node --test` with no arguments independently exits 0 too. Two
 * separate ways to certify a tree without executing a single assertion, in the
 * one component whose entire job is to be trustworthy about that.
 */
export function assertRunnableSuite(expected: readonly string[]): string | undefined {
  if (expected.length === 0) {
    return [
      "no test files were discovered from source.",
      "",
      "Refusing to report success: a run with nothing in it proves nothing, and",
      "`node --test` with an empty list exits 0, which would look like a pass.",
    ].join("\n");
  }
  return undefined;
}

// =====================================================================
// Output-directory trust
// =====================================================================

/**
 * Filesystem facts the runner observes before it builds or deletes anything.
 *
 * Gathered by the script (which can call `lstat`) and judged here (which can be
 * tested). Round-2 review findings B5, B7 and B8 were all the same mistake in
 * different clothes: a path was trusted because of what it was CALLED, while
 * `tsc`, the module loader, the test runner and `rmSync` each resolved it
 * differently.
 */
export interface TreeFacts {
  /** `tests/` is itself a symlink — an external suite would be compiled and run. */
  readonly testsRootIsSymlink: boolean;
  /** The output directory is a symlink — the build writes outside the repo. */
  readonly outputIsSymlink: boolean;
  /**
   * The output directory sits on a different device from the repository root.
   *
   * A BIND MOUNT has the same lexical path AND the same realpath as the
   * directory it replaces, so neither string comparison nor `realpath` can see
   * it — but `rmSync(recursive)` will happily delete through it into whatever
   * was mounted. The device number is the one signal that differs.
   */
  readonly outputOnDifferentDevice: boolean;
  /** Symlinked test artifacts found under the output directory. */
  readonly symlinkedArtifacts: readonly string[];
  /**
   * Symlinked or hardlinked entries found under the SOURCE ROOTS.
   *
   * Both `src/` and `tests/`, not `tests/` alone (round-11 finding C). What the
   * build compiles and the runner executes is the whole graph; `src/` is in it.
   * Scanning only `tests/` enforced less than this file's threat model claimed
   * — "symlinks and hardlinks that pull code in from outside the tree" — and a
   * hardlinked `src/` module was compiled and executed from outside the tree
   * while verification exited 0.
   */
  readonly symlinkedSources: readonly string[];
  /** True when tsconfig sets `noEmit`, so a build would emit nothing. */
  readonly buildEmitsNothing: boolean;
  /** True when the compiled checker was (re)written by the build just run. */
  readonly checkerFreshlyEmitted: boolean;
}

export type TreeSafetyVerdict =
  | { readonly safe: true }
  | { readonly safe: false; readonly reason: string };

/**
 * Refuses any tree the verifier cannot honestly reason about.
 *
 * Each clause corresponds to a demonstrated escape, not a hypothetical:
 * an external suite executed through a symlinked `tests/`; a symlinked artifact
 * rendered invisible because it is neither a file nor a directory to `readdir`;
 * a `noEmit` build leaving a poisoned checker in place to audit itself; and a
 * bind mount that no path comparison can distinguish.
 */
export function assessTreeSafety(facts: TreeFacts): TreeSafetyVerdict {
  if (facts.testsRootIsSymlink) {
    return {
      safe: false,
      reason: "the tests directory is a symlink; an external suite would be compiled and executed as though it belonged to this tree",
    };
  }
  if (facts.outputIsSymlink) {
    return {
      safe: false,
      reason: "the build output directory is a symlink; the build would write outside the repository",
    };
  }
  if (facts.outputOnDifferentDevice) {
    return {
      safe: false,
      reason: "the build output directory is on a different device (a mount or bind mount); a recursive delete could reach outside the repository",
    };
  }
  if (facts.buildEmitsNothing) {
    return {
      safe: false,
      reason: "tsconfig sets noEmit, so the build produces nothing and any audit would run against whatever was already there",
    };
  }
  if (!facts.checkerFreshlyEmitted) {
    return {
      safe: false,
      reason: "the build did not emit the verification checker; refusing to audit this tree using a stale copy of the auditor",
    };
  }
  if (facts.symlinkedSources.length > 0) {
    return {
      safe: false,
      reason: `symlinked or hardlinked entries under the source roots (src/, tests/): ${facts.symlinkedSources.join(", ")}; source must live in this repository`,
    };
  }
  if (facts.symlinkedArtifacts.length > 0) {
    return {
      safe: false,
      reason: `symlinked test artifacts under the build output: ${facts.symlinkedArtifacts.join(", ")}; these are invisible to an ordinary file walk and must not remain`,
    };
  }
  return { safe: true };
}

export type OutputDirectoryVerdict =
  | { readonly trusted: true; readonly directory: string }
  | { readonly trusted: false; readonly reason: string };

/**
 * Decides whether the build output directory may be trusted (findings B2, B3).
 *
 * Two ways the previous version could be pointed somewhere else entirely:
 *
 *   - `tsconfig`'s `outDir` was never consulted, so changing it left the real
 *     output elsewhere while stale `dist` artifacts were audited, imported and
 *     EXECUTED. Verification reported a consistent tree while running foreign
 *     code.
 *   - `dist` as a SYMLINK was not refused. `rmSync` does not follow it, which
 *     looked safe — but `tsc`, the checker import and the test runner all do, so
 *     generated code was written to and executed from outside the repository.
 *
 * Both are the same underlying mistake: trusting a path by its name rather than
 * by what it resolves to. `realPath` is therefore compared, not the literal.
 */
export function assessOutputDirectory(input: {
  readonly repositoryRoot: string;
  readonly realRepositoryRoot: string;
  readonly configuredOutputDirectory: string;
  readonly outputDirectory: string;
  /** `realpath` of the output directory, or `undefined` if it does not exist. */
  readonly realOutputDirectory: string | undefined;
  /**
   * The ABSOLUTE path the declared `outDir` resolves to — `realpath` where it
   * exists, otherwise lexically resolved.
   *
   * Deliberately not the raw string. Comparing spellings refused every
   * equivalent way of naming the same directory: an absolute path,
   * `dist/../dist`, a trailing separator, and a `dist-alias -> dist` symlink.
   * A verifier that rejects valid trees is its own failure mode — it teaches
   * people to bypass verification, which is the habit this task exists to end.
   *
   * The caller resolves, because this function is pure and must stay testable
   * without a filesystem; the RULE — that the two must be one directory —
   * stays here, where it is tested.
   */
  readonly resolvedTsconfigOutDir: string;
}): OutputDirectoryVerdict {
  const configured = normalise(input.configuredOutputDirectory).replace(/\/+$/, "");
  const managed = normalise(input.realOutputDirectory ?? input.outputDirectory).replace(/\/+$/, "");
  const declared = normalise(input.resolvedTsconfigOutDir).replace(/\/+$/, "");

  if (declared !== managed) {
    return {
      trusted: false,
      reason: `tsconfig builds into ${JSON.stringify(declared)} but verification manages ${JSON.stringify(managed)}; they must be the same directory or stale artifacts elsewhere would be executed`,
    };
  }
  if (normalise(input.repositoryRoot) !== normalise(input.realRepositoryRoot)) {
    return {
      trusted: false,
      reason: `the repository path resolves elsewhere (${input.realRepositoryRoot}); refusing to build or delete through a link`,
    };
  }
  if (input.realOutputDirectory !== undefined) {
    const expected = `${normalise(input.realRepositoryRoot).replace(/\/+$/, "")}/${configured}`;
    if (normalise(input.realOutputDirectory).replace(/\/+$/, "") !== expected) {
      return {
        trusted: false,
        reason: `${configured} resolves to ${input.realOutputDirectory}, outside the repository; refusing to build into or delete a linked directory`,
      };
    }
  }
  return { trusted: true, directory: input.outputDirectory };
}

/** A human-readable account of a contaminated tree, or `undefined` if clean. */
export function describeContamination(audit: ArtifactAudit): string | undefined {
  if (audit.clean) {
    return undefined;
  }
  const lines: string[] = [];
  if (audit.orphaned.length > 0) {
    lines.push(
      `${audit.orphaned.length} compiled test(s) have no source in this tree — almost certainly left by another branch:`,
      ...audit.orphaned.map((path) => `  orphan:  ${path}`),
    );
  }
  if (audit.missing.length > 0) {
    lines.push(
      `${audit.missing.length} source test(s) produced no compiled output — the build is incomplete:`,
      ...audit.missing.map((path) => `  missing: ${path}`),
    );
  }
  lines.push(
    "",
    "Refusing to run: a verification that includes foreign artifacts, or silently",
    "omits tests, does not describe the tree it was run against.",
  );
  return lines.join("\n");
}

// =====================================================================
// Safe cleaning
// =====================================================================

/**
 * Paths that must never be removed, whatever a caller asks for (AC-5).
 *
 * The clean step is the only destructive operation in the verification path, and
 * a destructive operation driven by a computed path is exactly the kind of thing
 * that deletes a repository at 3am. C7 asks for reversibility; the cheapest way
 * to honour it here is to make the irreversible case unreachable.
 */
const NEVER_REMOVE: readonly string[] = Object.freeze([
  "",
  ".",
  "/",
  "src",
  "tests",
  "docs",
  ".git",
  ".factory",
  "node_modules",
]);

export type CleanTargetVerdict =
  | { readonly safe: true; readonly target: string }
  | { readonly safe: false; readonly reason: string };

/**
 * Decides whether a path may be removed as build output.
 *
 * Deliberately a pure function taking the repository root and the requested
 * target, so the rule can be tested without a filesystem — and so the answer
 * cannot depend on where the process happens to be running.
 */
export function assessCleanTarget(input: {
  readonly repositoryRoot: string;
  readonly target: string;
  readonly configuredOutputDirectory: string;
}): CleanTargetVerdict {
  const root = normalise(input.repositoryRoot).replace(/\/+$/, "");
  const target = normalise(input.target).replace(/\/+$/, "");
  const configured = normalise(input.configuredOutputDirectory).replace(/\/+$/, "");

  if (!target.startsWith("/")) {
    return { safe: false, reason: `clean target must be absolute, got ${JSON.stringify(input.target)}` };
  }
  // The repository root is checked BEFORE "outside the repository", because it
  // is neither outside nor removable, and reporting it as outside would send
  // whoever reads the error hunting the wrong problem.
  if (target === root) {
    return { safe: false, reason: "refusing to remove the repository root" };
  }
  if (!target.startsWith(`${root}/`)) {
    return { safe: false, reason: `refusing to remove ${target}: outside the repository ${root}` };
  }
  const relative = target.slice(root.length + 1);
  if (relative.length === 0) {
    return { safe: false, reason: "refusing to remove the repository root" };
  }
  if (relative !== configured) {
    return {
      safe: false,
      reason: `refusing to remove ${relative}: only the configured build output (${configured}) may be cleaned`,
    };
  }
  const firstSegment = relative.split("/")[0] ?? "";
  if (NEVER_REMOVE.includes(relative) || NEVER_REMOVE.includes(firstSegment)) {
    return { safe: false, reason: `refusing to remove ${relative}: protected path` };
  }
  if (relative.includes("..")) {
    return { safe: false, reason: `refusing to remove ${relative}: path traversal` };
  }
  return { safe: true, target };
}

/**
 * A single mount point, as reported by the kernel.
 *
 * Only the mount point path is needed: this module decides whether the build
 * output directory is itself a mount, or contains one. What is mounted there is
 * irrelevant — a recursive delete does not care.
 */
export interface MountPoint {
  /** Absolute mount point path, as the kernel reports it. */
  readonly mountPoint: string;
}

/**
 * Parses `/proc/self/mountinfo`.
 *
 * WHY THIS EXISTS AT ALL. `st_dev` was the only bind-mount signal the verifier
 * had, and it is not sufficient: a bind mount of a directory that already lives
 * on the SAME filesystem shares the repository's device number, so
 * `outputOnDifferentDevice` is false and the guard never fires. `rmSync(...,
 * { recursive: true })` then deletes through the mount into whatever was bound
 * there — outside the repository, which is exactly what AC-5 forbids and what
 * this file's threat model claims to defend against. Adding a second device
 * comparison would have been pseudo-protection; the mount table is the only
 * ordinary source that actually knows.
 *
 * Format, per `Documentation/filesystems/proc.rst`:
 *
 *   36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw,errors=continue
 *   (1)(2)(3)  (4)   (5)   (6)        (7)      (8)(9)  (10)     (11)
 *
 * Field 5 is the mount point. Fields 7+ are optional and variable in number,
 * terminated by a literal `-`, which is why the mount point is read positionally
 * from the LEFT rather than by counting from the right.
 *
 * Octal escapes: the kernel encodes space, tab, newline and backslash in paths
 * as `\040`, `\011`, `\012` and `\134`. A mount point containing a space would
 * otherwise be silently truncated at the space and compare unequal — a
 * false NEGATIVE in a guard, which is the dangerous direction.
 *
 * Malformed lines are skipped rather than failing the parse: a single
 * unparseable row must not blind the caller to every other mount. The CALLER
 * decides what an unreadable or empty table means, and it fails closed.
 */
export function parseMountInfo(content: string): readonly MountPoint[] {
  const mounts: MountPoint[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const fields = line.split(" ");
    // Fields 1-5 are mandatory and positional; anything shorter is not a
    // mountinfo row we can read.
    if (fields.length < 5) continue;
    const mountPoint = fields[4];
    if (mountPoint === undefined || !mountPoint.startsWith("/")) continue;
    mounts.push({ mountPoint: unescapeMountPath(mountPoint) });
  }
  return mounts;
}

/** Decodes the kernel's octal escapes for space, tab, newline and backslash. */
function unescapeMountPath(path: string): string {
  return path.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

export type MountTopologyVerdict =
  | { readonly safe: true }
  | { readonly safe: false; readonly reason: string };

/**
 * Refuses to treat the build output as deletable when the mount table says a
 * recursive delete would cross a filesystem boundary.
 *
 * Two distinct refusals, because they are two different accidents:
 *
 * 1. The output directory IS a mount point. Deleting its contents deletes the
 *    contents of whatever is mounted there, which is not this repository's
 *    build output however much the path suggests otherwise. This is the
 *    same-device bind mount that `st_dev` cannot see.
 *
 * 2. A mount point is NESTED INSIDE the output directory. The directory itself
 *    is ordinary, so refusal (1) does not fire, but the recursive walk reaches
 *    the nested mount and deletes through it.
 *
 * PLATFORM BOUNDARY, stated rather than implied. This guarantee is implemented
 * for Linux only, because `/proc/self/mountinfo` is where it comes from. On any
 * other platform the verifier does NOT claim bind-mount safety; it says so and
 * continues, so that the claim in the threat model matches the code. A test
 * pins this so the boundary cannot be quietly widened into a promise.
 *
 * FAILS CLOSED on Linux: an unreadable, empty or unparseable mount table means
 * the question cannot be answered, and an unanswerable safety question is not a
 * pass. `mountInfo === undefined` is "could not read it", which is precisely
 * when a guard must refuse rather than assume.
 */
export function assessMountTopology(input: {
  readonly platform: string;
  readonly mountInfo: string | undefined;
  readonly outputDirectory: string;
  readonly realOutputDirectory: string | undefined;
}): MountTopologyVerdict {
  if (input.platform !== "linux") {
    // Not a refusal, and deliberately not silence either.
    return { safe: true };
  }
  if (input.mountInfo === undefined) {
    return {
      safe: false,
      reason:
        "the mount table (/proc/self/mountinfo) could not be read, so it is unknown whether the build output is a mount point; refusing to run a destructive clean on an unanswerable question",
    };
  }
  const mounts = parseMountInfo(input.mountInfo);
  if (mounts.length === 0) {
    return {
      safe: false,
      reason:
        "the mount table (/proc/self/mountinfo) contained no readable entries, so bind-mount safety cannot be established; refusing to run a destructive clean",
    };
  }
  // Judge the path the build and the delete actually reach, which is the
  // resolved one. `realOutputDirectory` is undefined only when the directory
  // does not exist yet, and a directory that does not exist is not a mount.
  const output = stripTrailingSlash(normalise(input.realOutputDirectory ?? input.outputDirectory));
  for (const mount of mounts) {
    const mountPoint = stripTrailingSlash(normalise(mount.mountPoint));
    if (mountPoint === output) {
      return {
        safe: false,
        reason: `the build output directory is itself a mount point (${mount.mountPoint}); a recursive delete would remove the contents of a separately mounted filesystem, not this repository's build output`,
      };
    }
    if (output !== "" && mountPoint.startsWith(`${output}/`)) {
      return {
        safe: false,
        reason: `a filesystem is mounted inside the build output directory (${mount.mountPoint}); a recursive delete would reach through it into a separately mounted tree`,
      };
    }
  }
  return { safe: true };
}

/** Removes a trailing slash so `/a/b` and `/a/b/` compare equal (root stays `/`). */
function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}
