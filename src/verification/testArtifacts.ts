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

/** Suffixes tsc compiles, and the JavaScript suffix each one emits. */
const SOURCE_TO_OUTPUT: readonly (readonly [string, string])[] = Object.freeze([
  [".mts", ".mjs"],
  [".cts", ".cjs"],
  [".ts", ".js"],
]);

/**
 * Every suffix the build can EMIT, and the source suffix that produces it.
 *
 * Round-9 review (HIGH): the audit filtered the output through `isTestArtifact`,
 * so a stale `dist/src/old-branch.js` sat there while the run reported
 * `tree-consistent`. AC-4 asks for an equivalent final generated state, and a
 * check that looks only at files whose names say `test` describes a subset while
 * claiming the whole — the same error as the suffix-filtered hardlink scan and
 * the hard-coded source roots, one level further out.
 *
 * Longest first, so `.d.ts.map` is not read as `.ts.map`.
 */
const OUTPUT_TO_SOURCE: readonly (readonly [string, string])[] = Object.freeze([
  [".d.mts.map", ".mts"],
  [".d.cts.map", ".cts"],
  [".d.ts.map", ".ts"],
  [".mjs.map", ".mts"],
  [".cjs.map", ".cts"],
  [".js.map", ".ts"],
  [".d.mts", ".mts"],
  [".d.cts", ".cts"],
  [".d.ts", ".ts"],
  [".mjs", ".mts"],
  [".cjs", ".cts"],
  [".js", ".ts"],
]);

export interface EmitLayout {
  /** `rootDir` from the effective tsconfig; `"."` for a whole-repository root. */
  readonly rootDir: string;
  /** `outDir` from the effective tsconfig. */
  readonly outputDirectory: string;
  /**
   * Which artifact KINDS this configuration actually emits (round-13 HIGH).
   *
   * A `.d.ts` was accepted as explained whenever its source existed, whatever
   * the config said. So a declaration left by a build whose `declaration` has
   * since been turned off survived as "clean" — the reviewer planted one, and
   * the run exited 0 reporting `tree-consistent` with the stale file still
   * there. A fresh clone has no such file, which is exactly what AC-4 forbids.
   *
   * The suffix table says what a source COULD produce; only the options say
   * what it DOES. Both are needed, and the second was missing.
   */
  readonly declaration: boolean;
  readonly sourceMap: boolean;
  readonly declarationMap: boolean;
}

/** Whether `layout` emits the artifact kind ending in `suffix`. */
function emitsSuffix(suffix: string, layout: EmitLayout): boolean {
  if (suffix.endsWith(".d.ts.map") || suffix.endsWith(".d.mts.map") || suffix.endsWith(".d.cts.map")) {
    return layout.declarationMap;
  }
  if (suffix.endsWith(".map")) {
    return layout.sourceMap;
  }
  if (suffix.startsWith(".d.")) {
    return layout.declaration;
  }
  // The JavaScript itself is emitted unless the build emits nothing at all,
  // which is refused before the audit ever runs.
  return true;
}

function rootPrefix(rootDir: string): string {
  const root = stripTrailingSlash(normalise(rootDir));
  return root === "" || root === "." ? "" : `${root}/`;
}

/**
 * The primary JavaScript artifact a source is expected to produce.
 *
 * Round-9 review (AC-1): discovery was pinned to `tests/**\/*.test.ts`, so a
 * test the CONFIG declares somewhere else was compiled, found no source, and was
 * reported as an orphan. The mapping now takes the layout as an argument for the
 * same reason the roots are derived: what the compiler reads is a fact about the
 * configuration, not about this repository's habits.
 */
export function compiledPathForSource(sourceRelativePath: string, layout: EmitLayout): string {
  const source = normalise(sourceRelativePath);
  const prefix = rootPrefix(layout.rootDir);
  if (prefix !== "" && !source.startsWith(prefix)) {
    throw new Error(
      `source ${JSON.stringify(sourceRelativePath)} is outside rootDir ${JSON.stringify(layout.rootDir)}`,
    );
  }
  const withinRoot = source.slice(prefix.length);
  const rule = SOURCE_TO_OUTPUT.find(([from]) => withinRoot.endsWith(from) && !withinRoot.endsWith(`.d${from}`));
  if (rule === undefined) {
    throw new Error(`not a compilable source path: ${JSON.stringify(sourceRelativePath)}`);
  }
  const out = stripTrailingSlash(normalise(layout.outputDirectory));
  return `${out}/${withinRoot.slice(0, -rule[0].length)}${rule[1]}`;
}

/**
 * The source a generated file must have come from, or `undefined` if nothing in
 * this configuration could have produced it.
 *
 * `undefined` is the interesting answer: a file under the output directory that
 * no source explains is stale, whatever it is called.
 */
export function sourceForGeneratedPath(
  generatedRelativePath: string,
  layout: EmitLayout,
): string | undefined {
  const generated = normalise(generatedRelativePath);
  const out = `${stripTrailingSlash(normalise(layout.outputDirectory))}/`;
  if (!generated.startsWith(out)) {
    return undefined;
  }
  const withinOutput = generated.slice(out.length);
  const rule = OUTPUT_TO_SOURCE.find(([from]) => withinOutput.endsWith(from) && emitsSuffix(from, layout));
  if (rule === undefined) {
    return undefined;
  }
  return `${rootPrefix(layout.rootDir)}${withinOutput.slice(0, -rule[0].length)}${rule[1]}`;
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
export function compiledPathForSourceTest(
  sourceRelativePath: string,
  layout: EmitLayout = {
    rootDir: ".",
    outputDirectory: "dist",
    declaration: true,
    sourceMap: true,
    declarationMap: false,
  },
): string {
  const normalised = normalise(sourceRelativePath);
  if (!SOURCE_TEST_SUFFIXES.some((suffix) => normalised.endsWith(suffix))) {
    throw new Error(
      `not a source test path: ${JSON.stringify(sourceRelativePath)} (expected a ${SOURCE_TEST_SUFFIXES.join("/")} file)`,
    );
  }
  return compiledPathForSource(normalised, layout);
}

/**
 * Test sources the runner recognises.
 *
 * `.mts`/`.cts` are here because the OUTPUT side has always accepted `.test.mjs`
 * and `.test.cjs`: a discovery rule narrower than the artifact rule means a
 * legitimate test compiles into something the audit then calls an orphan, which
 * is a false positive rather than a false pass — but it is still the two halves
 * disagreeing about the same question.
 */
export const SOURCE_TEST_SUFFIXES: readonly string[] = Object.freeze([
  ".test.ts",
  ".test.mts",
  ".test.cts",
]);

export function isSourceTest(path: string): boolean {
  return SOURCE_TEST_SUFFIXES.some((suffix) => normalise(path).endsWith(suffix));
}

export interface ArtifactAudit {
  /** Compiled tests to run, derived from source. Never from a dist glob. */
  readonly expected: readonly string[];
  /** Compiled tests with NO corresponding source — a stale/foreign tree. */
  readonly orphaned: readonly string[];
  /** Sources with no compiled output — a partial or failed build. */
  readonly missing: readonly string[];
  /**
   * Generated files no source explains, excluding the test artifacts already
   * listed as `orphaned` (round-9 HIGH). A stale `dist/src/old-branch.js` is
   * imported by whatever still references it and is every bit as much "another
   * branch's code running in this one" as a stale test is.
   */
  readonly staleOutput: readonly string[];
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
  /**
   * EVERY compilable source under the derived roots, and EVERY file under the
   * output directory. Required, not optional: an optional input is one a caller
   * can forget, and the audit would then report a clean tree because it was
   * handed nothing to object to.
   */
  readonly sources: readonly string[];
  readonly generated: readonly string[];
  readonly layout: EmitLayout;
}): ArtifactAudit {
  const layout = input.layout;
  const expected = [...input.sourceTests].map((path) => compiledPathForSourceTest(path, layout)).sort();
  // Only genuine test artifacts count — but ALL of them, wherever they sit in
  // the output tree, not merely those under `dist/tests` (B4).
  const present = new Set(input.compiledTests.map(normalise).filter(isTestArtifact));
  const expectedSet = new Set(expected);

  const orphaned = [...present].filter((path) => !expectedSet.has(path)).sort();

  const sources = input.sources.map(normalise);
  const sourceSet = new Set(sources);
  const generated = new Set(input.generated.map(normalise));

  // A source must produce at least its primary JavaScript. Sources the layout
  // cannot map are reported rather than skipped, for the same reason: a file the
  // audit cannot place is not a file it has checked.
  const missing: string[] = [];
  for (const source of sources) {
    let primary: string;
    try {
      primary = compiledPathForSource(source, layout);
    } catch {
      missing.push(source);
      continue;
    }
    if (!generated.has(primary)) missing.push(primary);
  }

  const orphanSet = new Set(orphaned);
  const staleOutput = [...generated]
    .filter((path) => !orphanSet.has(path))
    .filter((path) => {
      const source = sourceForGeneratedPath(path, layout);
      return source === undefined || !sourceSet.has(source);
    })
    .sort();

  return {
    expected,
    orphaned,
    missing: missing.sort(),
    staleOutput,
    clean: orphaned.length === 0 && missing.length === 0 && staleOutput.length === 0,
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
      reason: `symlinked or hardlinked entries under the source roots: ${facts.symlinkedSources.join(", ")}; source must live in this repository`,
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
  /**
   * CONTAINMENT IS CHECKED WHETHER OR NOT THE OUTPUT EXISTS YET (round-2 note).
   *
   * The first version only compared when `realOutputDirectory` was defined, so
   * an output path pointing outside the repository was trusted whenever the
   * directory did not exist. The production caller cannot currently produce
   * that combination — it fixes the path inside the repository and validates
   * the effective `outDir` first — so the reviewer rated it non-blocking.
   *
   * It is closed anyway. "Unreachable from today's only caller" is a fact about
   * the caller, not about this function, and this function is the reviewable
   * rule. A second caller, or a change to the first, would inherit a hole that
   * nothing here refuses.
   */
  const expected = `${normalise(input.realRepositoryRoot).replace(/\/+$/, "")}/${configured}`;
  const effective = normalise(input.realOutputDirectory ?? input.outputDirectory).replace(/\/+$/, "");
  if (effective !== expected) {
    return {
      trusted: false,
      reason: `${configured} resolves to ${input.realOutputDirectory ?? input.outputDirectory}, outside the repository; refusing to build into or delete a linked directory`,
    };
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
      `${audit.missing.length} source file(s) produced no compiled output — the build is incomplete:`,
      ...audit.missing.map((path) => `  missing: ${path}`),
    );
  }
  if (audit.staleOutput.length > 0) {
    lines.push(
      `${audit.staleOutput.length} generated file(s) have no source in this tree — stale build output:`,
      ...audit.staleOutput.map((path) => `  stale:   ${path}`),
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
export interface MountTable {
  readonly mounts: readonly MountPoint[];
  /** Lines this parser did not recognise as mountinfo rows. */
  readonly malformed: readonly string[];
}

/**
 * One mountinfo row, or `undefined` if the line is not one.
 *
 * Round-9 review (HIGH): the previous test was "at least five space-separated
 * tokens, the fifth starting with `/`", and `not a mountinfo row /unrelated`
 * satisfies it. Arbitrary text therefore became a MOUNT POINT, which matters in
 * both directions: garbage rows made the "no readable entries" refusal
 * unreachable, and a table of garbage that happened to omit the real mount was
 * assessed as safe.
 *
 * Every mandatory field is now checked for its documented SHAPE — two decimal
 * ids, a `major:minor` device, an absolute root and mount point, and the
 * literal `-` separator with the three fields that must follow it.
 */
function parseMountInfoRow(line: string): MountPoint | undefined {
  const fields = line.split(" ").filter((field) => field.length > 0);
  // 6 mandatory + the `-` separator + fstype, source, super options.
  if (fields.length < 10) return undefined;
  const [mountId, parentId, deviceId, root, mountPoint] = fields;
  if (mountId === undefined || !/^\d+$/.test(mountId)) return undefined;
  if (parentId === undefined || !/^\d+$/.test(parentId)) return undefined;
  if (deviceId === undefined || !/^\d+:\d+$/.test(deviceId)) return undefined;
  if (root === undefined || !root.startsWith("/")) return undefined;
  if (mountPoint === undefined || !mountPoint.startsWith("/")) return undefined;
  // Optional fields (7+) are `tag[:value]` and are terminated by a literal `-`;
  // none of them can BE `-`, so the first one from field 7 is the separator.
  const separator = fields.indexOf("-", 6);
  if (separator === -1 || fields.length - separator < 4) return undefined;
  return { mountPoint: unescapeMountPath(mountPoint) };
}

/**
 * Reads the table AND reports what it could not read.
 *
 * Skipping a malformed line quietly was the fail-open: the caller saw a shorter
 * list and no indication that anything was missing from it. A caller that must
 * fail closed needs to know the difference between "no mount is inside the
 * output" and "some rows were not understood".
 */
export function readMountTable(content: string): MountTable {
  const mounts: MountPoint[] = [];
  const malformed: string[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const mount = parseMountInfoRow(line);
    if (mount === undefined) malformed.push(line);
    else mounts.push(mount);
  }
  return { mounts, malformed };
}

export function parseMountInfo(content: string): readonly MountPoint[] {
  return readMountTable(content).mounts;
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
  const table = readMountTable(input.mountInfo);
  if (table.malformed.length > 0) {
    const first = table.malformed[0] ?? "";
    return {
      safe: false,
      reason:
        `the mount table (/proc/self/mountinfo) contains ${table.malformed.length} line(s) this parser does not ` +
        `recognise as mountinfo rows (first: ${JSON.stringify(first.slice(0, 120))}); the mount topology is ` +
        "therefore not fully known, and an unanswerable safety question is not a pass",
    };
  }
  const mounts = table.mounts;
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
