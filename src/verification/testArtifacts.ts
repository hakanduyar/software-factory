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
  /** The `outDir` tsconfig actually declares, relative to the repo root. */
  readonly tsconfigOutDir: string;
}): OutputDirectoryVerdict {
  const configured = normalise(input.configuredOutputDirectory).replace(/\/+$/, "");
  const declared = normalise(input.tsconfigOutDir).replace(/^\.\//, "").replace(/\/+$/, "");

  if (declared !== configured) {
    return {
      trusted: false,
      reason: `tsconfig builds into ${JSON.stringify(declared)} but verification manages ${JSON.stringify(configured)}; they must be the same directory or stale artifacts elsewhere would be executed`,
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
