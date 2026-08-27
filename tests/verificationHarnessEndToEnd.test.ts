/**
 * TASK-010 remediation — END-TO-END regressions for the verification harness.
 *
 * The independent review's sharpest point was that every TASK-010 test drove the
 * PURE checker, so `scripts/verify.mjs` — the thing that actually deletes files
 * and decides whether a tree is trustworthy — had no test at all. Removing its
 * `rmSync` call left the focused tests at 15/15 and the full suite green.
 *
 * A guard nothing exercises is a guard nobody knows is broken. These run the
 * real script, in a real temporary repository, and assert on its exit code and
 * output.
 *
 * Offline: no provider, no model, no money. Each case builds a throwaway tree
 * under the OS temp directory and removes it afterwards.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const REPO_ROOT = process.cwd();
const created: string[] = [];

after(() => {
  for (const path of created) {
    rmSync(path, { recursive: true, force: true });
  }
});

/**
 * A minimal repository the harness can actually verify: one passing test, the
 * real script, the real checker source, and a tsconfig that compiles them.
 */
function makeFixtureRepo(
  options: { readonly tsconfigOutDir?: string; readonly compileMts?: boolean } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "sf-verify-"));
  created.push(root);

  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "src/verification"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });

  cpSync(join(REPO_ROOT, "scripts/verify.mjs"), join(root, "scripts/verify.mjs"));
  cpSync(
    join(REPO_ROOT, "src/verification/testArtifacts.ts"),
    join(root, "src/verification/testArtifacts.ts"),
  );

  writeFileSync(
    join(root, "tests/sample.test.ts"),
    [
      'import assert from "node:assert/strict";',
      'import { describe, it } from "node:test";',
      'describe("sample", () => { it("passes", () => { assert.equal(1, 1); }); });',
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          rootDir: ".",
          outDir: options.tsconfigOutDir ?? "dist",
          strict: true,
          skipLibCheck: true,
        },
        // `tests/**/*.ts` does NOT match `helper.mts`; a tree that compiles
        // `.mts` says so explicitly, which is why the suffix case needs its own
        // fixture rather than riding on the default one.
        include: options.compileMts
          ? ["src/**/*.ts", "tests/**/*.ts", "tests/**/*.mts"]
          : ["src/**/*.ts", "tests/**/*.ts"],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module" }, null, 2));

  // Reuse this repository's typescript rather than installing one.
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"), "dir");
  return root;
}

/**
 * The fixture harness must run in a process that is NOT inside this test run.
 *
 * `node --test` sets `NODE_TEST_CONTEXT`, and a nested `node --test` that sees it
 * prints "run() is being called recursively within a test file. skipping running
 * files" and RUNS NOTHING — exiting 0. Every end-to-end fixture inherited it, so
 * the fixture suites never executed and the harness reported "verification
 * complete" over an empty run. Cases that only asserted refusal still passed,
 * which is why it went unnoticed: the vacuity was invisible until a fixture was
 * required to FAIL and did not.
 *
 * Stripped here rather than per call site, so a future case cannot reintroduce
 * it by forgetting.
 */
function harnessEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith("NODE_TEST_")) delete env[key];
  }
  return env;
}

function runHarness(root: string): { status: number; output: string } {
  const result = spawnSync(process.execPath, ["scripts/verify.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: harnessEnv({ PATH: process.env["PATH"] ?? "" }),
  });
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/**
 * Run the harness with a shim `npx` that answers `--showConfig` with `answer`
 * and delegates everything else to the REAL npx BY ABSOLUTE PATH.
 *
 * The absolute path is the whole point. Delegating by name re-enters the shim,
 * because the shim's directory is first on PATH — an earlier version did
 * exactly that, the build died in two seconds, and the test passed on the
 * resulting non-zero exit while proving nothing about the guard under test.
 * The build must genuinely SUCCEED so the only thing wrong is the config the
 * verifier was handed.
 */
function runWithShowConfigShim(root: string, answer: string): { status: number; output: string } {
  /**
   * The shimmed answer inherits the fixture's real `include` unless the caller
   * set one.
   *
   * A `--showConfig` with NO `include` is not a realistic config: tsc then
   * compiles everything under the project root, and the verifier correctly
   * derives its source roots as `.`. These fixtures are about the `outDir`
   * question and carry helper symlinks at the root, so an unrealistic shim made
   * them fail for a reason unrelated to what they test — the fixture was wrong,
   * not the guard.
   */
  const shown = JSON.parse(answer) as Record<string, unknown>;
  if (shown["include"] === undefined && shown["files"] === undefined) {
    const real = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
      include?: readonly string[];
    };
    if (real.include !== undefined) {
      shown["include"] = [...real.include];
    }
  }
  const realisticAnswer = JSON.stringify(shown);

  const realNpx = spawnSync("sh", ["-c", "command -v npx"], { encoding: "utf8" }).stdout.trim();
  assert.ok(realNpx.length > 0, "the fixture needs a real npx to delegate to");

  const shimDir = mkdtempSync(join(tmpdir(), "sf-shim-"));
  created.push(shimDir);
  writeFileSync(
    join(shimDir, "npx"),
    [
      "#!/bin/sh",
      'for a in "$@"; do',
      `  if [ "$a" = "--showConfig" ]; then cat <<'SHOWCONFIG'`,
      realisticAnswer,
      "SHOWCONFIG",
      "    exit 0",
      "  fi",
      "done",
      `exec ${realNpx} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const result = spawnSync(process.execPath, ["scripts/verify.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: harnessEnv({ PATH: `${shimDir}:${process.env["PATH"] ?? ""}` }),
  });
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/**
 * Runs the harness with an `npx` that delegates everything to the real one and
 * then runs `after` once the build has finished.
 *
 * This is the only way to reach the POST-BUILD guards. Every condition a fixture
 * can set up beforehand is caught by the pre-build layer — correctly, since
 * refusing before anything is written is the whole point — which left the later
 * layer's wiring untestable, and a reviewer's mutation of it duly survived. A
 * build that CREATES the condition is not an artificial case either: a compiler
 * plugin, a postinstall script or a `prepare` hook can emit whatever it likes.
 */
function runWithBuildThatPlants(root: string, after: string): { status: number; output: string } {
  const realNpx = spawnSync("sh", ["-c", "command -v npx"], { encoding: "utf8" }).stdout.trim();
  assert.ok(realNpx.length > 0, "the fixture needs a real npx to delegate to");

  const shimDir = mkdtempSync(join(tmpdir(), "sf-buildshim-"));
  created.push(shimDir);
  writeFileSync(
    join(shimDir, "npx"),
    [
      "#!/bin/sh",
      'for a in "$@"; do',
      `  if [ "$a" = "--showConfig" ]; then exec ${realNpx} "$@"; fi`,
      "done",
      `${realNpx} "$@" || exit $?`,
      after,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const result = spawnSync(process.execPath, ["scripts/verify.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: harnessEnv({ PATH: `${shimDir}:${process.env["PATH"] ?? ""}` }),
  });
  return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("TASK-010 remediation: the harness itself, end to end", () => {
  it("passes on a clean fixture repository", () => {
    const root = makeFixtureRepo();
    const { status, output } = runHarness(root);
    assert.equal(status, 0, `expected success, got:\n${output}`);
    assert.match(output, /verification complete: 1 test files/);
  });

  /**
   * AC-4, decided against AC-2 by the adjudication recorded in `scripts/verify.mjs`.
   *
   * Another branch's artifacts must yield the fresh-clone RESULT in ONE
   * invocation with no human step — while AC-2's substantive guarantees hold:
   * the orphan is NAMED, and it is never executed. An earlier round exited 1
   * here and told the operator to run the command again, which is the very
   * "remember to clean it" convention this task exists to abolish.
   */
  it("CONVERGES in one invocation when another branch's artifacts are present", () => {
    const root = makeFixtureRepo();
    const clean = runHarness(root);
    assert.equal(clean.status, 0, "the fixture must pass before contamination");

    writeFileSync(
      join(root, "dist/tests/ghostFromAnotherBranch.test.js"),
      'import test from "node:test";\ntest("ghost-must-never-run", () => {});\n',
    );
    const { status, output } = runHarness(root);

    // AC-4: same result as a freshly cloned tree, first time, no second run.
    assert.equal(status, 0, `a stale artifact must not require a second invocation:\n${output}`);
    assert.match(output, /verification complete: 1 test files/);
    // AC-2: never silently ignored.
    assert.match(output, /ghostFromAnotherBranch\.test\.js/, "the orphan must be named");
    assert.match(output, /Removing the stale build output/);
    // AC-2: never executed — proven by the orphan's own test NAME never
    // appearing in the runner output, not merely by the file being gone.
    assert.doesNotMatch(output, /ghost-must-never-run/, "the orphan was executed");
    // ...and the artifact is gone, not merely skipped.
    assert.equal(
      existsSync(join(root, "dist/tests/ghostFromAnotherBranch.test.js")),
      false,
      "the stale artifact must not survive the run",
    );
    // The rebuild genuinely happened and the FINAL audit is what passed.
    assert.equal(
      existsSync(join(root, "dist/tests/sample.test.js")),
      true,
      "the tree was cleaned but not rebuilt",
    );
    // Equivalent final generated state to a fresh clone: same discovered count.
    assert.match(clean.output, /verifying 1 test files derived from source/);
    assert.match(output, /verifying 1 test files derived from source/);
  });

  it("converges for an orphan OUTSIDE dist/tests and with a non-.js extension", () => {
    for (const relative of ["dist/ghost.test.js", "dist/nested/ghost.test.js", "dist/tests/ghost.test.mjs"]) {
      const root = makeFixtureRepo();
      assert.equal(runHarness(root).status, 0);
      mkdirSync(join(root, relative, ".."), { recursive: true });
      writeFileSync(join(root, relative), "// stale\n");

      const { status, output } = runHarness(root);
      assert.equal(status, 0, `${relative} did not converge:\n${output}`);
      assert.match(output, /ghost\.test\./, `${relative} was not named`);
      assert.equal(existsSync(join(root, relative)), false, `${relative} survived the run`);
    }
  });

  /**
   * The other half of the same adjudication, and the reason converging is not
   * the same as ignoring: an inconsistency that SURVIVES a clean rebuild is a
   * real disagreement between the tree and its build, and it fails closed.
   *
   * Driven by `exclude`, so the disagreement is deterministic and needs no
   * privileged setup: the source test exists and the build genuinely refuses to
   * emit it, exactly as a partial build would.
   */
  /**
   * REWRITTEN IN ROUND 10, because its fixture was the defect.
   *
   * It added a test source, EXCLUDED it in tsconfig, and expected the missing
   * artifact to be a disagreement that survived the rebuild. That only worked
   * because the source set was globbed from the filesystem and ignored
   * `exclude` — the very hole round-10 review used to run a stale artifact. An
   * excluded file is not a disagreement; it is a configuration change, and the
   * tree without it is correct.
   *
   * A genuine survivor is one the REBUILD reproduces. A build that emits
   * something no source explains does exactly that: cleaning removes it, the
   * rebuild puts it back, and the second audit is entitled to conclude the tree
   * disagrees with itself rather than that it is holding another branch's
   * leftovers.
   */
  it("FAILS CLOSED when a source/artifact disagreement survives a clean rebuild", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass first");

    const { status, output } = runWithBuildThatPlants(
      root,
      'printf "export const ghost = 1;\\n" > dist/src/ghost.js',
    );
    assert.notEqual(status, 0, `a real disagreement must fail:\n${output}`);
    assert.match(output, /ghost\.js/, "the unexplained artifact must be named");
    assert.match(output, /survived a clean rebuild/, "it must say why this is not merely stale output");
  });

  /**
   * AC-7 at the HARNESS level, as a deterministic negative control.
   *
   * The independent review's finding E: every end-to-end case would survive
   * deletion of the script's contamination branch, so nothing proved that branch
   * was what caught anything. This removes exactly that branch in a COPY of the
   * script and shows the same contaminated tree then reports success.
   *
   * The mutation is asserted to have matched before it is trusted — a mutation
   * that silently changed nothing would make this test prove the opposite of
   * what it claims, which is the failure mode round 7 and round 8 both hit.
   */
  it("negative control: without the contamination branch, a stale artifact passes unnoticed", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass first");

    const scriptPath = join(root, "scripts/verify.mjs");
    const original = readFileSync(scriptPath, "utf8");
    // The bare guard text appears TWICE — the outer contamination branch and the
    // post-rebuild fail-closed check (round-12 finding). Matching on substring
    // presence alone would let this control mutate whichever came first and
    // still report success, which is the round-7/round-8 mistake a third time.
    // The target is therefore anchored to its unique two-line form AND asserted
    // to occur exactly once.
    const GUARD = "\nif (!audit.clean) {\n  const diagnosis = checker.describeContamination(audit);";
    assert.equal(
      original.split(GUARD).length - 1,
      1,
      "the mutation target must occur exactly once, or this control proves nothing about which guard it removed",
    );
    const mutated = original.replace(GUARD, "\nif (false) {\n  const diagnosis = checker.describeContamination(audit);");
    assert.notEqual(mutated, original, "the mutation did not change the script");
    writeFileSync(scriptPath, mutated);

    writeFileSync(join(root, "dist/tests/ghostFromAnotherBranch.test.js"), "// stale\n");
    const { status, output } = runHarness(root);

    assert.equal(status, 0, "with the branch removed the contaminated tree should sail through");
    assert.doesNotMatch(output, /ghostFromAnotherBranch/, "the orphan must go unreported once the branch is gone");
    assert.equal(
      existsSync(join(root, "dist/tests/ghostFromAnotherBranch.test.js")),
      true,
      "and the stale artifact should survive, since nothing cleaned it",
    );
  });

  /**
   * AC-1 proven at the harness level (review finding F).
   *
   * Every earlier end-to-end case would still pass if `audit.expected` were
   * swapped for `compiledTests`, because contaminated trees fail before
   * execution and clean trees make the two lists identical. This one makes the
   * lists DIFFER on a tree that is otherwise clean: a compiled artifact whose
   * source exists is executed, and the reported count is the SOURCE count.
   */
  it("executes the source-derived set, and reports that count", () => {
    const root = makeFixtureRepo();
    writeFileSync(
      join(root, "tests/second.test.ts"),
      'import { describe, it } from "node:test";\ndescribe("second", () => { it("passes", () => {}); });\n',
    );
    const { status, output } = runHarness(root);
    assert.equal(status, 0, output);
    assert.match(output, /verifying 2 test files derived from source/);
    assert.match(output, /verification complete: 2 test files/);
  });

  /** Review finding B4: a run with nothing in it must not look like a pass. */
  it("REFUSES a repository with no tests instead of reporting 0/0 success", () => {
    const root = makeFixtureRepo();
    rmSync(join(root, "tests/sample.test.ts"));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "an empty suite reported success");
    assert.match(output, /no test files were discovered/);
  });

  /**
   * Review finding B3. `rmSync` does not follow a symlinked `dist`, which looked
   * safe — but `tsc`, the checker import and the test runner all do, so code was
   * written to and executed from outside the repository.
   */
  it("REFUSES a symlinked output directory", () => {
    const root = makeFixtureRepo();
    const decoy = mkdtempSync(join(tmpdir(), "sf-decoy-"));
    created.push(decoy);
    symlinkSync(decoy, join(root, "dist"), "dir");

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "a symlinked output directory was accepted");
    assert.match(output, /outside the repository|refusing/i);
  });

  /**
   * Review finding B2. The checker was imported from an assumed `dist` while
   * tsc built somewhere else, so stale artifacts were audited, imported and
   * executed while verification declared the tree consistent.
   */
  it("REFUSES when tsconfig builds somewhere other than the managed directory", () => {
    const root = makeFixtureRepo({ tsconfigOutDir: "build-output" });
    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "a redirected outDir was accepted");
    assert.match(output, /tsconfig builds into/);
  });
});

/**
 * Round-2 review findings. Each is a demonstrated escape, not a hypothetical —
 * the reviewer executed external code through three of them and showed the
 * fourth was accepted by the checker.
 */
describe("TASK-010 round 2: paths are judged by what they resolve to", () => {
  /** B5 — a symlinked `tests/` compiled and ran an EXTERNAL suite. */
  it("REFUSES a symlinked tests directory", () => {
    const root = makeFixtureRepo();
    const external = mkdtempSync(join(tmpdir(), "sf-external-tests-"));
    created.push(external);
    writeFileSync(
      join(external, "outsider.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { it } from "node:test";',
        'it("outsider", () => { assert.ok(true); });',
        "",
      ].join("\n"),
    );
    rmSync(join(root, "tests"), { recursive: true, force: true });
    symlinkSync(external, join(root, "tests"), "dir");

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "an external suite was compiled and executed");
    assert.match(output, /tests directory is a symlink/);
  });

  /** B5 — an individual symlinked source test is source from somewhere else. */
  it("REFUSES a symlinked individual test source", () => {
    const root = makeFixtureRepo();
    const external = mkdtempSync(join(tmpdir(), "sf-external-src-"));
    created.push(external);
    const outsider = join(external, "outsider.test.ts");
    writeFileSync(
      outsider,
      ['import { it } from "node:test";', 'it("outsider", () => {});', ""].join("\n"),
    );
    symlinkSync(outsider, join(root, "tests/linked.test.ts"), "file");

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "a symlinked source test was accepted");
    assert.match(output, /symlinked or hardlinked entries under the source roots/);
  });

  /**
   * B7 — a symlinked artifact is neither `isFile()` nor `isDirectory()` to
   * `readdir`, so the ordinary walk could not see it while `node --test` could
   * still run it.
   */
  it("REFUSES a symlinked stale artifact the ordinary walk cannot see", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0);

    const external = mkdtempSync(join(tmpdir(), "sf-external-art-"));
    created.push(external);
    const ghost = join(external, "linkedGhost.test.js");
    writeFileSync(ghost, "// stale\n");
    symlinkSync(ghost, join(root, "dist/tests/linkedGhost.test.js"), "file");

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "an invisible-but-runnable artifact was tolerated");
    assert.match(output, /symlinked test artifacts|linkedGhost/);
  });

  /**
   * B6 — the checker is imported from the very tree it audits. With `noEmit`,
   * the build wrote nothing, a poisoned stale checker stayed in charge, and the
   * run reported `0 test files, tree-consistent` having executed nothing.
   */
  /**
   * B11 — a symlinked DIRECTORY under the output was neither walked into nor
   * reported, because the symlink filter only kept entries whose own name ended
   * in `.test.js`. The check caught the shape of the escape already
   * demonstrated, and nothing more.
   */
  it("REFUSES a symlinked directory under the output, not just symlinked files", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0);

    const external = mkdtempSync(join(tmpdir(), "sf-foreign-out-"));
    created.push(external);
    writeFileSync(join(external, "ghost.test.js"), "// stale\n");
    symlinkSync(external, join(root, "dist/foreign-output"), "dir");

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "a symlinked output subdirectory was invisible");
    assert.match(output, /symlinked test artifacts|foreign-output/);
  });

  /**
   * B9 — a hardlink is indistinguishable from an ordinary file by name, type or
   * realpath. Link count is the ordinary signal, and it catches the accidental
   * case; see the threat-model note for what it does not catch.
   */
  it("REFUSES a hardlinked external test source", () => {
    const root = makeFixtureRepo();
    const external = mkdtempSync(join(tmpdir(), "sf-hardlink-"));
    created.push(external);
    const outsider = join(external, "outsider.test.ts");
    writeFileSync(
      outsider,
      ['import { it } from "node:test";', 'it("outsider", () => {});', ""].join("\n"),
    );
    linkSync(outsider, join(root, "tests/hardlinked.test.ts"));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "a hardlinked external source was compiled and executed");
    assert.match(output, /symlinked entries under tests|hardlinked/);
  });

  /**
   * Amended AC-2, case D: safe cleanup cannot be completed → FAIL CLOSED.
   *
   * The convergence path is allowed to finish successfully, which makes the
   * failure branches the load-bearing ones. `rmSync` was previously unguarded,
   * so a read-only parent ended the run with an uncaught exception. The exit
   * code was non-zero either way — which is exactly why nothing noticed — but
   * failing closed has to mean the verifier DECIDED to fail and said why.
   */
  it("FAILS CLOSED, with a diagnosis, when the stale output cannot be removed", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass first");
    writeFileSync(join(root, "dist/tests/ghostFromAnotherBranch.test.js"), "// stale\n");

    // Removing `dist` needs write permission on its PARENT, not on itself.
    /**
     * The OUTPUT directory is made read-only, not its parent.
     *
     * Cleanup used to delete `dist` itself, so an unwritable parent was enough
     * to make it fail. It now empties the directory instead — deleting `dist`
     * left an accepted `dist-alias` dangling and broke convergence — so the
     * condition that actually blocks cleanup is an unwritable `dist`.
     */
    chmodSync(join(root, "dist"), 0o555);
    let result: { status: number; output: string };
    try {
      result = runHarness(root);
    } finally {
      chmodSync(join(root, "dist"), 0o755);
    }

    assert.notEqual(result.status, 0, "an unremovable stale tree reported success");
    assert.match(result.output, /could NOT be removed/, "the failure must name the cleanup problem");
    assert.match(result.output, /ghostFromAnotherBranch/, "and must still name the orphan that caused it");
  });

  /**
   * Amended AC-2/AC-4, case E: an INVALID source tree must not be laundered into
   * a pass by the cleanup path.
   *
   * The convergence behaviour exists to remove another branch's leftovers, not
   * to make a broken tree look repaired. Both halves are checked: a tree whose
   * tests fail, and a tree that does not compile — each with a stale orphan
   * present, so the cleanup path is genuinely entered on the way to failing.
   */
  it("does NOT convert an invalid source tree into a pass by cleaning it", () => {
    const failing = makeFixtureRepo();
    writeFileSync(
      join(failing, "tests/sample.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { describe, it } from "node:test";',
        'describe("sample", () => { it("fails on purpose", () => { assert.equal(1, 2); }); });',
        "",
      ].join("\n"),
    );
    mkdirSync(join(failing, "dist/tests"), { recursive: true });
    writeFileSync(join(failing, "dist/tests/ghostFromAnotherBranch.test.js"), "// stale\n");
    const failed = runHarness(failing);
    assert.notEqual(failed.status, 0, "a failing suite was reported as success after cleaning");
    assert.match(failed.output, /ghostFromAnotherBranch/, "the orphan should still have been reported");
    assert.match(failed.output, /fails on purpose/, "the real test failure must be the reported outcome");

    const broken = makeFixtureRepo();
    writeFileSync(join(broken, "tests/sample.test.ts"), "this is not valid typescript at all\n");
    mkdirSync(join(broken, "dist/tests"), { recursive: true });
    writeFileSync(join(broken, "dist/tests/ghostFromAnotherBranch.test.js"), "// stale\n");
    const brokeResult = runHarness(broken);
    assert.notEqual(brokeResult.status, 0, "a non-compiling tree was reported as success");
    assert.doesNotMatch(
      brokeResult.output,
      /verification complete/,
      "a tree that does not compile must never reach the success line",
    );
  });

  /**
   * Round 12 CRITICAL, reproduced exactly: a hardlinked checker that wins by
   * being IMPORTED before the guard that rejects it.
   *
   * `src/verification/testArtifacts.ts` is imported from the build output to do
   * the auditing. Hardlink it to a module whose top level calls
   * `process.exit(0)` and the process ends, successfully, during that import —
   * before `assessTreeSafety` is ever consulted. The guard existed; it simply
   * ran after the thing it was guarding.
   *
   * The assertion is deliberately about the EXIT CODE as well as the message: a
   * false success here is the whole defect, so "it printed something" is not
   * evidence.
   */
  it("REFUSES a hardlinked checker before importing it, so it cannot exit 0 first", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass first");

    const external = mkdtempSync(join(tmpdir(), "sf-evilchecker-"));
    created.push(external);
    const evil = join(external, "evil.ts");
    writeFileSync(
      evil,
      [
        "// A checker that reports nothing and simply declares success on import.",
        "process.exit(0);",
        "export function auditTestArtifacts(): unknown { return { clean: true, expected: [] }; }",
        "",
      ].join("\n"),
    );
    rmSync(join(root, "src/verification/testArtifacts.ts"));
    linkSync(evil, join(root, "src/verification/testArtifacts.ts"));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, `a hardlinked checker produced a SUCCESSFUL verification:\n${output}`);
    assert.match(output, /before building/, "the refusal must happen before the build and the import");
    assert.match(output, /testArtifacts\.ts/, "the offending source must be named");
  });

  /**
   * Round 12 finding — the RUNTIME mount guard, not merely its pure logic.
   *
   * Removing the `assessMountTopology` call from `scripts/verify.mjs` left every
   * pure mount test and every end-to-end test green, because no fixture had a
   * mount. The decision logic was proven and its WIRING was not, which is the
   * same "guard vs guard's input" error round 7 recorded.
   *
   * This performs a REAL same-device bind mount — the exact case `st_dev` cannot
   * see — inside an unprivileged user+mount namespace, so it needs no sudo and
   * cannot affect the host mount table. The bind is asserted to have actually
   * taken effect before the harness's refusal is believed; a test that silently
   * failed to mount would otherwise "pass" while proving nothing.
   *
   * Skipped, loudly, where unprivileged user namespaces are unavailable. The
   * pure decision tests still cover the logic there; only this wiring proof is
   * environment-dependent, and that limitation is stated rather than hidden.
   */
  it("REFUSES a real same-device bind-mounted output directory", () => {
    const namespaces = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "true"], {
      encoding: "utf8",
    });
    if (namespaces.status !== 0) {
      // Not an assertion-free pass: the reason is printed so a green run in a
      // restricted environment cannot be mistaken for a proven guard.
      console.error("SKIPPED: unprivileged user namespaces unavailable; bind-mount wiring not proven here");
      return;
    }

    const root = makeFixtureRepo();
    const external = mkdtempSync(join(tmpdir(), "sf-bindsrc-"));
    created.push(external);
    writeFileSync(join(external, "marker.txt"), "must survive\n");
    mkdirSync(join(root, "dist"), { recursive: true });

    const script = [
      "set -e",
      `mount --bind ${JSON.stringify(external)} ${JSON.stringify(join(root, "dist"))}`,
      // Prove the bind actually happened before trusting anything that follows.
      `grep -qF ${JSON.stringify(join(root, "dist"))} /proc/self/mountinfo || { echo "BIND-DID-NOT-TAKE"; exit 97; }`,
      `cd ${JSON.stringify(root)}`,
      // `set -e` must not swallow the harness's own non-zero exit before it can
      // be reported — that made an earlier version of this test fail while the
      // guard under test was working correctly.
      "set +e",
      `${JSON.stringify(process.execPath)} scripts/verify.mjs`,
      'echo "HARNESS-EXIT=$?"',
    ].join("\n");

    const result = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "sh", "-c", script], {
      encoding: "utf8",
      env: harnessEnv(),
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    assert.doesNotMatch(output, /BIND-DID-NOT-TAKE/, "the fixture failed to bind-mount, so it proved nothing");
    assert.match(output, /HARNESS-EXIT=1/, `the harness must refuse a bind-mounted output:\n${output}`);
    // Anchored to the PRE-BUILD refusal specifically. Asserting only "mount
    // point" let the post-build `assessMountTopology` satisfy this test, so
    // deleting the pre-build guard — the one that stops `tsc` writing through
    // the mount — left it green. Two guards covering one case is defence in
    // depth; a test that cannot tell them apart proves neither.
    assert.match(
      output,
      /refused before building: dist is or contains a mount point/,
      "the refusal must come from the pre-build guard, before tsc writes through the mount",
    );
    // The mounted tree's contents must be intact: refusing means never deleting.
    assert.equal(existsSync(join(external, "marker.txt")), true, "the bind-mounted tree was deleted through");
  });

  /**
   * Round 11 finding C — the scan covered `tests/` only, while the threat model
   * claimed "symlinks and hardlinks that pull code in from outside the tree" and
   * `findHardlinkedSources` itself said "EVERY compilable source counts ... What
   * runs is the whole compiled graph". `src/` IS the compiled graph, and it was
   * unscanned: an external module hardlinked into `src/` was compiled and
   * executed while verification exited 0.
   *
   * The narrow fix is enforcing the claim already made, with the same policy and
   * the same already-documented legitimate-hardlink false positive — not a new
   * restriction invented because a reviewer called it CRITICAL.
   */
  it("REFUSES a hardlinked external module under src/", () => {
    const root = makeFixtureRepo();
    const external = mkdtempSync(join(tmpdir(), "sf-srclink-"));
    created.push(external);
    const outsider = join(external, "outsider.ts");
    writeFileSync(outsider, "export const smuggled = 1;\n");
    linkSync(outsider, join(root, "src/smuggled.ts"));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "a hardlinked external src/ module was compiled and executed");
    assert.match(output, /src\/smuggled\.ts/, "the offending source must be named");
  });

  /**
   * Round 11 finding D — `emitDeclarationOnly` is `noEmit` wearing a hat. `tsc`
   * exits 0 having written only `.d.ts`, so every compiled test AND the checker
   * keep their previous content; a build started soon after a real one then
   * slips through the checker-freshness grace window with the old auditor in
   * charge of detecting exactly that.
   */
  it("REFUSES an emitDeclarationOnly build, which exits 0 having emitted no JavaScript", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass first");

    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
      compilerOptions: Record<string, unknown>;
    };
    tsconfig.compilerOptions["emitDeclarationOnly"] = true;
    tsconfig.compilerOptions["declaration"] = true;
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "a build that emits no JavaScript was accepted");
    assert.match(output, /emitDeclarationOnly/, "the specific misconfiguration must be named");
  });

  /**
   * Round 4 — the hardlink check covered only `*.test.ts`, so a hardlinked
   * HELPER imported by an ordinary test was compiled and executed from outside
   * the tree. What runs is the whole compiled graph, not the files whose names
   * happen to say `test`.
   */
  it("REFUSES a hardlinked helper imported by an ordinary test", () => {
    const root = makeFixtureRepo();
    const external = mkdtempSync(join(tmpdir(), "sf-helper-"));
    created.push(external);
    const outsider = join(external, "helper.ts");
    writeFileSync(outsider, "export const smuggled = 1;\n");
    linkSync(outsider, join(root, "tests/helper.ts"));
    writeFileSync(
      join(root, "tests/sample.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { it } from "node:test";',
        'import { smuggled } from "./helper.js";',
        'it("uses a helper", () => { assert.equal(smuggled, 1); });',
        "",
      ].join("\n"),
    );

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "a hardlinked helper was compiled and executed");
    assert.match(output, /symlinked entries under tests|helper\.ts/);
  });

  /**
   * Round 4 — rejecting only `undefined` let a `--showConfig` returning `{}`
   * through, after which optional chaining read a missing `noEmit` as `false`.
   * Absence of a field is not evidence about its value.
   */
  it("REFUSES a structurally invalid effective tsconfig", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "fixture must pass first");

    const { status, output } = runWithShowConfigShim(root, "{}");

    assert.notEqual(status, 0, "an empty effective config was accepted");
    assert.match(
      output,
      /declares no compilerOptions object/,
      `expected the config-shape refusal, got:\n${output.slice(0, 400)}`,
    );
  });

  /** B12 — `extends` can carry noEmit in without the root file mentioning it. */
  it("REFUSES an INHERITED noEmit, not just one written in the root tsconfig", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "fixture must pass first");

    writeFileSync(
      join(root, "tsconfig.base.json"),
      JSON.stringify({ compilerOptions: { noEmit: true } }, null, 2),
    );
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as Record<
      string,
      unknown
    >;
    tsconfig["extends"] = "./tsconfig.base.json";
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "an inherited noEmit produced a passing verification");
    assert.ok(!output.includes("tree-consistent"), "it must not claim consistency");
  });

  /**
   * Round 5, finding B13 — the escape the round-4 fix left open.
   *
   * Step 1 compares the RAW tsconfig with the managed directory. The effective
   * config was then checked only for HAVING an `outDir`, never for it being the
   * SAME one. So `--showConfig` reporting `build-output` while the root file
   * said `dist` satisfied both: tsc emitted into `build-output`, the audit
   * examined an untouched `dist`, found nothing wrong, and reported a
   * consistent tree — a verification of a directory the build never wrote to.
   *
   * Exit was 0 with one test executed, which is the dangerous shape: it looks
   * exactly like a healthy run.
   */
  it("REFUSES an effective outDir that differs from the managed directory", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "fixture must pass first");

    const { status, output } = runWithShowConfigShim(
      root,
      JSON.stringify({ compilerOptions: { outDir: "build-output", noEmit: false } }),
    );

    assert.notEqual(status, 0, "a mismatched effective outDir was accepted");
    assert.match(
      output,
      /builds into "build-output", but verification manages/,
      `expected the effective-outDir refusal, got:\n${output.slice(0, 400)}`,
    );
    assert.ok(!output.includes("tree-consistent"), "it must not claim consistency");
  });

  /**
   * The same guard must not fire on a spelling difference. A check that refuses
   * `./dist` when it manages `dist` would be "safe" by being useless, and the
   * next person would delete it rather than debug it.
   */
  it("ACCEPTS an equivalent effective outDir written differently", () => {
    const root = makeFixtureRepo();
    const { status, output } = runWithShowConfigShim(
      root,
      JSON.stringify({ compilerOptions: { outDir: "./dist", noEmit: false } }),
    );
    assert.equal(status, 0, `an equivalent outDir spelling was refused:\n${output.slice(0, 400)}`);
  });

  /**
   * Round-5 note — a failure to resolve the config must say WHICH failure.
   *
   * Reporting a wedged toolchain and a rejected config with the same words
   * sends the operator to the wrong place. This exercises the signal branch,
   * which is cheap to provoke; the ETIMEDOUT branch is the same code path with
   * a different label and is not separately exercised here, because forcing it
   * honestly would mean either a two-minute test or a test-only timeout
   * override in a security-relevant script — and an escape hatch in the
   * verifier is worse than an untested message.
   */
  it("distinguishes a killed config resolution from an unreadable one", () => {
    const root = makeFixtureRepo();
    const realNpx = spawnSync("sh", ["-c", "command -v npx"], { encoding: "utf8" }).stdout.trim();
    assert.ok(realNpx.length > 0);

    const shimDir = mkdtempSync(join(tmpdir(), "sf-shim-kill-"));
    created.push(shimDir);
    writeFileSync(
      join(shimDir, "npx"),
      [
        "#!/bin/sh",
        'for a in "$@"; do',
        '  if [ "$a" = "--showConfig" ]; then kill -TERM $$; sleep 5; fi',
        "done",
        `exec ${realNpx} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(process.execPath, ["scripts/verify.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${shimDir}:${process.env["PATH"] ?? ""}` },
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    assert.notEqual(result.status, 0, "an unresolvable config was accepted");
    assert.match(
      output,
      /terminated by SIGTERM/,
      `expected the signal to be named, got:\n${output.slice(0, 400)}`,
    );
  });

  /**
   * Round-5 note — `.mts`/`.cts` were in the hardlink clause but nothing
   * exercised them: deleting those two suffixes left the focused suite at
   * 15/15. This compiles and imports a hardlinked `.mts` helper, so with the
   * suffixes removed the external file is genuinely built and executed.
   */
  it("REFUSES a hardlinked .mts source that the tree actually compiles", () => {
    const root = makeFixtureRepo({ compileMts: true });
    const external = mkdtempSync(join(tmpdir(), "sf-mts-"));
    created.push(external);
    const outsider = join(external, "helper.mts");
    writeFileSync(outsider, "export const smuggled = 2;\n");
    linkSync(outsider, join(root, "tests/helper.mts"));
    writeFileSync(
      join(root, "tests/sample.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { it } from "node:test";',
        'import { smuggled } from "./helper.mjs";',
        'it("uses an mts helper", () => { assert.equal(smuggled, 2); });',
        "",
      ].join("\n"),
    );

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "a hardlinked .mts source was compiled and executed");
    assert.match(output, /symlinked entries under tests|helper\.mts/);
  });

  /**
   * Round-5 note — deleting the PRE-BUILD noEmit guard left the focused suite
   * green, because `assessTreeSafety` catches the same condition afterwards and
   * said almost the same words. The existing test therefore passed for a
   * different reason than it claimed.
   *
   * The layers are not redundant: only the earlier one can tell the operator
   * that nothing was built. This pins that specific layer by its distinct
   * wording, so removing it fails here even though the later guard still fires.
   */
  it("refuses noEmit BEFORE building, not only at the later safety gate", () => {
    const root = makeFixtureRepo();
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
      compilerOptions: Record<string, unknown>;
    };
    tsconfig.compilerOptions["noEmit"] = true;
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0);
    assert.match(
      output,
      /refused before building/,
      `the pre-build layer did not fire; the later gate may be masking it:\n${output.slice(0, 400)}`,
    );
  });

  it("REFUSES a noEmit build rather than auditing with a stale auditor", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "fixture must pass first");

    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
      compilerOptions: Record<string, unknown>;
    };
    tsconfig.compilerOptions["noEmit"] = true;
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "a noEmit build produced a passing verification");
    assert.match(output, /noEmit/);
    assert.ok(!output.includes("tree-consistent"), "it must not claim consistency");
  });
});

/**
 * A directory is judged by what it RESOLVES to, not by how it is spelled.
 *
 * Independent review reproduced the opposite of the escapes this file mostly
 * pins: paths that were CORRECT being refused. An absolute `outDir` naming the
 * managed directory, `dist/../dist`, a trailing separator, and a
 * `dist-alias -> dist` symlink were all rejected — the last being the managed
 * directory itself under another name.
 *
 * This matters as much as an escape. A verifier that refuses valid trees is its
 * own failure mode: it trains people to work around verification, which is the
 * habit this task exists to end. Both directions are pinned, so the guard
 * cannot be "fixed" into refusing everything.
 */
describe("TASK-010 follow-up: equivalent outDir spellings are one directory", () => {
  it("ACCEPTS an absolute outDir naming the managed directory", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "fixture must pass first");

    const { status, output } = runWithShowConfigShim(
      root,
      JSON.stringify({ compilerOptions: { outDir: join(root, "dist"), noEmit: false } }),
    );
    assert.equal(status, 0, `an absolute outDir was wrongly refused:\n${output.slice(0, 500)}`);
    assert.match(output, /verification complete/);
  });

  /**
   * The check above shims `--showConfig`, which leaves the real `tsconfig.json`
   * still saying `"dist"` — so it exercises only the EFFECTIVE comparison. The
   * pre-build check reads the raw file, and mutation testing showed the shimmed
   * case passing happily with the old raw string comparison restored.
   *
   * A test that claims to cover a guard and does not is worse than no test, so
   * this one writes the absolute path into the file the guard actually reads.
   */
  it("ACCEPTS an absolute outDir written in the real tsconfig", () => {
    const root = makeFixtureRepo();
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
      compilerOptions: Record<string, unknown>;
    };
    tsconfig.compilerOptions["outDir"] = join(root, "dist");
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { status, output } = runHarness(root);
    assert.equal(status, 0, `an absolute outDir in tsconfig was refused:\n${output.slice(0, 500)}`);
    assert.match(output, /verification complete/);
  });

  it("ACCEPTS a traversal spelling written in the real tsconfig", () => {
    const root = makeFixtureRepo();
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
      compilerOptions: Record<string, unknown>;
    };
    tsconfig.compilerOptions["outDir"] = "dist/../dist";
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { status, output } = runHarness(root);
    assert.equal(status, 0, `"dist/../dist" in tsconfig was refused:\n${output.slice(0, 500)}`);
  });

  it("ACCEPTS traversal and trailing-separator spellings", () => {
    for (const spelling of ["dist/../dist", "dist/"]) {
      const root = makeFixtureRepo();
      assert.equal(runHarness(root).status, 0, `${spelling}: fixture must pass first`);

      const { status, output } = runWithShowConfigShim(
        root,
        JSON.stringify({ compilerOptions: { outDir: spelling, noEmit: false } }),
      );
      assert.equal(status, 0, `${spelling} was wrongly refused:\n${output.slice(0, 500)}`);
    }
  });

  /**
   * The sharpest case: tsc writes THROUGH the alias into the very directory
   * being audited, so there is nothing to refuse — but a lexical comparison
   * cannot see that.
   */
  it("ACCEPTS a symlink alias that resolves into the managed directory", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "fixture must pass first");
    symlinkSync(join(root, "dist"), join(root, "dist-alias"), "dir");

    const { status, output } = runWithShowConfigShim(
      root,
      JSON.stringify({ compilerOptions: { outDir: "dist-alias", noEmit: false } }),
    );
    assert.equal(status, 0, `a symlink alias into dist was wrongly refused:\n${output.slice(0, 500)}`);
  });

  it("still REFUSES a sibling directory", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "fixture must pass first");

    const { status, output } = runWithShowConfigShim(
      root,
      JSON.stringify({ compilerOptions: { outDir: "dist-2", noEmit: false } }),
    );
    assert.notEqual(status, 0, "a sibling output directory was accepted");
    assert.ok(!output.includes("tree-consistent"), "it must not claim consistency");
  });

  it("still REFUSES an alias that resolves somewhere else entirely", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "fixture must pass first");
    const decoy = mkdtempSync(join(tmpdir(), "sf-decoy-out-"));
    created.push(decoy);
    symlinkSync(decoy, join(root, "dist-elsewhere"), "dir");

    const { status, output } = runWithShowConfigShim(
      root,
      JSON.stringify({ compilerOptions: { outDir: "dist-elsewhere", noEmit: false } }),
    );
    assert.notEqual(status, 0, "an alias resolving outside the managed directory was accepted");
    assert.ok(!output.includes("tree-consistent"), "it must not claim consistency");
  });

  /**
   * A tsconfig that inherits `outDir` through `extends` without naming it was
   * refused outright by the raw-file check — a false positive with no attacker
   * involved and no misconfiguration.
   */
  /**
   * DISCLOSED: the first version of this test was VACUOUS and the independent
   * review caught it. It wrote `outDir: "dist"` into the ROOT config as well as
   * the base, so nothing was ever inherited — the raw check found what it
   * always finds and the test passed without exercising the case it named. A
   * genuinely inherited-only config was, at that moment, refused outright.
   *
   * The root config here declares NO `outDir` at all. If the raw-file check
   * ever becomes load-bearing again, this fails.
   */
  it("ACCEPTS an outDir inherited through extends and named nowhere else", () => {
    const root = makeFixtureRepo();
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const options = tsconfig["compilerOptions"] as Record<string, unknown>;

    // The base carries outDir; the root carries everything else and never
    // mentions it.
    writeFileSync(
      join(root, "tsconfig.base.json"),
      JSON.stringify({ compilerOptions: { outDir: "dist" } }, null, 2),
    );
    delete options["outDir"];
    tsconfig["extends"] = "./tsconfig.base.json";
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    // The fixture must genuinely inherit: prove the root file is silent.
    const written = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
      compilerOptions: Record<string, unknown>;
    };
    assert.ok(
      !("outDir" in written.compilerOptions),
      "the fixture must not name outDir in the root file, or it tests nothing",
    );

    const { status, output } = runHarness(root);
    assert.equal(status, 0, `an inherited-only outDir was wrongly refused:\n${output.slice(0, 500)}`);
    assert.match(output, /verification complete/, "it must actually build and run, not merely exit 0");
  });

  /**
   * ...and the guard must still catch a genuinely wrong inherited value, or
   * tolerating absence would have opened a hole rather than closed a false
   * positive.
   */
  it("still REFUSES an outDir inherited from a base that names the wrong directory", () => {
    const root = makeFixtureRepo();
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const options = tsconfig["compilerOptions"] as Record<string, unknown>;

    writeFileSync(
      join(root, "tsconfig.base.json"),
      JSON.stringify({ compilerOptions: { outDir: "build-output" } }, null, 2),
    );
    delete options["outDir"];
    tsconfig["extends"] = "./tsconfig.base.json";
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "an inherited mismatched outDir was accepted");
    assert.ok(!output.includes("tree-consistent"), "it must not claim consistency");
    /**
     * Asserting the SPECIFIC refusal, not merely a non-zero exit. Mutation
     * testing showed the loose version passing for the wrong reason: with the
     * effective-outDir guard disabled the build lands in `build-output`, the
     * checker import from `dist` then fails, and the run exits non-zero having
     * caught nothing. "It failed" is not evidence that the guard under test is
     * what failed it.
     */
    // `--showConfig` normalises the inherited value to `./build-output`, so the
    // prefix is optional here. Matching the literal without it asserted a
    // spelling tsc does not produce.
    assert.match(
      output,
      /the effective tsconfig builds into "\.?\/?build-output", but verification manages/,
      `expected the effective-outDir refusal, got:\n${output.slice(0, 500)}`,
    );
  });
});

// =====================================================================
// ROUND-3 — the pre-build layer, pinned by what only it can guarantee
// =====================================================================

describe("TASK-010 round 3: nothing is written through a hostile path", () => {
  /**
   * These guards duplicate the later `assessTreeSafety` clauses on PURPOSE:
   * one runs before the build, the other is the reviewable rule. Round-3
   * review showed the duplication had made the earlier layer untestable —
   * deleting it left the named tests green, because the later guard produced a
   * refusal too. But by then `tsc` had already written through the symlink,
   * and the reviewer found the compiled checker and test files sitting in the
   * external target of a "refused" run.
   *
   * So these assert the property only the EARLY layer can provide: the outside
   * directory is still EMPTY afterwards. A later refusal cannot satisfy that,
   * which is what makes these regressions load-bearing where wording alone
   * would not be.
   */
  function decoy(): string {
    const dir = mkdtempSync(join(tmpdir(), "sf-decoy-target-"));
    created.push(dir);
    return dir;
  }

  /** A fixture has no `dist/` until something builds; absent counts as empty. */
  function listing(path: string): readonly string[] {
    try {
      return readdirSync(path).sort();
    } catch {
      return [];
    }
  }

  it("writes NOTHING into the target of a symlinked output directory", () => {
    const root = makeFixtureRepo();
    const target = decoy();
    rmSync(join(root, "dist"), { recursive: true, force: true });
    symlinkSync(target, join(root, "dist"), "dir");

    const { status, output } = runHarness(root);

    assert.notEqual(status, 0, "a symlinked output directory was accepted");
    /**
     * SUBSTANCE FIRST, wording second (round-4 finding).
     *
     * The first version asserted the message before the filesystem state, so a
     * mutated run failed on the message and never reached the assertion that
     * actually matters — the mutation proof was wording-driven, which is
     * circular. Checking the emptiness first means removing the guard fails on
     * the property, not on a string.
     */
    assert.deepEqual(
      listing(target),
      [],
      "the build wrote through the symlink before the refusal — the early guard did not run first",
    );
    assert.match(
      output,
      /refused before building: the build output directory is a symlink/,
      `the PRE-BUILD layer did not fire:\n${output.slice(0, 400)}`,
    );
  });

  it("writes NOTHING when the tests directory is a symlink", () => {
    const root = makeFixtureRepo();
    const external = mkdtempSync(join(tmpdir(), "sf-ext-tests-"));
    created.push(external);
    writeFileSync(
      join(external, "outsider.test.ts"),
      ['import { it } from "node:test";', 'it("outsider", () => {});', ""].join("\n"),
    );
    rmSync(join(root, "tests"), { recursive: true, force: true });
    symlinkSync(external, join(root, "tests"), "dir");
    const distBefore = listing(join(root, "dist"));

    const { status, output } = runHarness(root);

    assert.notEqual(status, 0);
    // Substance first — see the note above.
    assert.deepEqual(
      listing(join(root, "dist")),
      distBefore,
      "the external suite was compiled before the refusal",
    );
    assert.match(
      output,
      /refused before building: the tests directory is a symlink/,
      `the PRE-BUILD layer did not fire:\n${output.slice(0, 400)}`,
    );
  });

  it("writes NOTHING when a linked source is present under a source root", () => {
    const root = makeFixtureRepo();
    const external = mkdtempSync(join(tmpdir(), "sf-ext-src-"));
    created.push(external);
    const outsider = join(external, "foreign.ts");
    writeFileSync(outsider, "export const smuggled = 9;\n");
    symlinkSync(outsider, join(root, "src/foreign.ts"), "file");
    const distBefore = listing(join(root, "dist"));

    const { status, output } = runHarness(root);

    assert.notEqual(status, 0);
    // Substance first — see the note above.
    assert.deepEqual(
      listing(join(root, "dist")),
      distBefore,
      "the linked source was compiled before the refusal",
    );
    assert.match(output, /refused before building: symlinked or hardlinked entries/);
  });
});


// =====================================================================
// ROUND-4 CRITICAL — a symlinked source ROOT produced a FALSE SUCCESS
// =====================================================================

describe("TASK-010 round 4: an entire source root cannot be a link", () => {
  /**
   * `findSymlinks("src")` walked what was INSIDE `src` and never asked whether
   * `src` itself was a link. `tests` was checked; `src` was not — two roots
   * written as two lines, one of which grew a guard the other did not.
   *
   * The consequence was the worst outcome this script can produce: the
   * external `testArtifacts.ts` was compiled and imported, and because a module
   * calling `process.exit(0)` at import time wins before any later guard runs,
   * the run EXITED 0 WITH NO OUTPUT. Not a crash — a false pass.
   */
  for (const root of ["src", "tests"] as const) {
    it(`REFUSES a symlinked ${root} root, and does not exit 0`, () => {
      const fixture = makeFixtureRepo();
      const external = mkdtempSync(join(tmpdir(), `sf-external-${root}-`));
      created.push(external);

      // Mirror the real layout so the build would genuinely succeed if the
      // link were followed — otherwise the refusal proves nothing.
      cpSync(join(fixture, root), external, { recursive: true });
      if (root === "src") {
        // ...and make the external checker hostile, exactly as reproduced.
        writeFileSync(
          join(external, "verification/testArtifacts.ts"),
          "process.exit(0);\nexport {};\n",
        );
      }
      rmSync(join(fixture, root), { recursive: true, force: true });
      symlinkSync(external, join(fixture, root), "dir");

      const { status, output } = runHarness(fixture);

      assert.notEqual(status, 0, `a symlinked ${root} root produced a SUCCESS`);
      assert.ok(
        !output.includes("tree-consistent"),
        "it must not claim consistency about a tree it did not read",
      );
      assert.match(output, new RegExp(`refused before building: the ${root} directory is a symlink`));
    });
  }
});


// =====================================================================
// ROUND-5 — a bind-mounted SOURCE root, and links under the output
// =====================================================================

describe("TASK-010 round 5: a mount is not a directory just because it looks like one", () => {
  /**
   * THE CRITICAL. The mount guard asked only whether `dist` was a mount point.
   * A bind-mounted `src/` is invisible to every other check: `isSymlink` says
   * no, link counts say no, and `realpath` resolves INSIDE the repository,
   * because a bind mount IS the path it is mounted at.
   *
   * The reviewer mounted an external `src` whose `testArtifacts.ts` began with
   * `process.exit(0)`. The run returned EXIT 0 WITH NO OUTPUT — a false pass,
   * from a check that covered one managed path and not its siblings.
   */
  for (const root of ["src", "tests"] as const) {
    it(`REFUSES a real bind-mounted ${root} root before building`, () => {
      const namespaces = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "true"], {
        encoding: "utf8",
      });
      if (namespaces.status !== 0) {
        // Printed, not silently skipped: a green run in a restricted
        // environment must not be mistaken for a proven guard.
        console.error(`SKIPPED: unprivileged user namespaces unavailable; ${root} bind-mount not proven here`);
        return;
      }

      const fixture = makeFixtureRepo();
      const external = mkdtempSync(join(tmpdir(), `sf-bind-${root}-`));
      created.push(external);
      // Mirror the real layout so the build would genuinely succeed if the
      // mount were followed — otherwise the refusal proves nothing.
      cpSync(join(fixture, root), external, { recursive: true });
      if (root === "src") {
        writeFileSync(join(external, "verification/testArtifacts.ts"), "process.exit(0);\nexport {};\n");
      }

      const script = [
        "set -e",
        `mount --bind ${JSON.stringify(external)} ${JSON.stringify(join(fixture, root))}`,
        `grep -qF ${JSON.stringify(join(fixture, root))} /proc/self/mountinfo || { echo "BIND-DID-NOT-TAKE"; exit 97; }`,
        `cd ${JSON.stringify(fixture)}`,
        "set +e",
        `${JSON.stringify(process.execPath)} scripts/verify.mjs`,
        'echo "HARNESS-EXIT=$?"',
      ].join("\n");

      const result = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "sh", "-c", script], {
        encoding: "utf8",
        env: harnessEnv(),
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      assert.doesNotMatch(output, /BIND-DID-NOT-TAKE/, "the fixture failed to bind-mount, so it proved nothing");
      assert.match(output, /HARNESS-EXIT=1/, `a bind-mounted ${root} produced a SUCCESS:\n${output}`);
      assert.match(output, new RegExp(`refused before building: ${root} is or contains a mount point`));
      assert.ok(!output.includes("tree-consistent"), "it must not claim consistency");
    });
  }
});

describe("TASK-010 round 5: links under the output are refused before the build", () => {
  /**
   * These were scanned only AFTER `tsc` ran, so the build wrote THROUGH them
   * first. The symlink case eventually refused with the damage already done;
   * the hardlink case was not looked at all — the external file was
   * overwritten and the run still reported the tree consistent.
   *
   * Asserted by the external file's CONTENT surviving, which only a pre-build
   * refusal can achieve.
   */
  it("does not write through a symlinked artifact under the output", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass first");

    const external = mkdtempSync(join(tmpdir(), "sf-outlink-"));
    created.push(external);
    const target = join(external, "external.js");
    writeFileSync(target, "MARKER-MUST-SURVIVE");
    rmSync(join(root, "dist/tests/sample.test.js"), { force: true });
    symlinkSync(target, join(root, "dist/tests/sample.test.js"), "file");

    const { status, output } = runHarness(root);

    assert.notEqual(status, 0, "a symlinked artifact under the output was accepted");
    assert.equal(
      readFileSync(target, "utf8"),
      "MARKER-MUST-SURVIVE",
      "the build wrote through the symlink before the refusal",
    );
    assert.match(output, /refused before building: linked entries under dist/);
  });

  it("does not overwrite a HARDLINKED artifact under the output", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass first");

    const external = mkdtempSync(join(tmpdir(), "sf-outhard-"));
    created.push(external);
    const target = join(external, "external.js");
    writeFileSync(target, "MARKER-MUST-SURVIVE");
    rmSync(join(root, "dist/tests/sample.test.js"), { force: true });
    linkSync(target, join(root, "dist/tests/sample.test.js"));

    const { status, output } = runHarness(root);

    assert.notEqual(status, 0, "a hardlinked artifact under the output was accepted");
    assert.equal(
      readFileSync(target, "utf8"),
      "MARKER-MUST-SURVIVE",
      "the build overwrote the hardlinked external file",
    );
    assert.ok(!output.includes("tree-consistent"), "it must not claim consistency");
  });
});

describe("TASK-010 round 5: an accepted alias still converges", () => {
  /**
   * My own regression. Accepting a `dist-alias -> dist` spelling was right —
   * refusing an equivalent name is a false positive. But cleanup then deleted
   * `dist` itself, leaving the alias dangling and the rebuild failing with
   * TS5033, which breaks the convergence AC-4 requires.
   */
  it("converges when contaminated while the config names an alias", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass first");
    symlinkSync(join(root, "dist"), join(root, "dist-alias"), "dir");
    writeFileSync(join(root, "dist/tests/ghostFromAnotherBranch.test.js"), "// stale\n");

    const { status, output } = runWithShowConfigShim(
      root,
      JSON.stringify({ compilerOptions: { outDir: "dist-alias", noEmit: false } }),
    );

    assert.equal(status, 0, `an aliased outDir did not converge:\n${output.slice(0, 600)}`);
    assert.match(output, /verification complete/);
  });
});


// =====================================================================
// ROUND-6 — an unreadable subtree is not an empty one
// =====================================================================

describe("TASK-010 round 6: verification covers the tree, not its readable projection", () => {
  /**
   * THE CRITICAL. Every walker caught `readdirSync` and returned nothing, so a
   * subtree with mode 000 was indistinguishable from an empty one. The reviewer
   * hid an orphan under `dist/hidden` and a test under `tests/hidden`; the run
   * reported "tree-consistent" and exited 0.
   *
   * That is verification of the part of the tree this process happens to be
   * allowed to see, presented as verification of the tree.
   */
  it("REFUSES when a subtree under the output cannot be read", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass first");

    mkdirSync(join(root, "dist/hidden"), { recursive: true });
    writeFileSync(join(root, "dist/hidden/ghost.test.js"), "// stale\n");
    chmodSync(join(root, "dist/hidden"), 0o000);
    try {
      const { status, output } = runHarness(root);
      assert.notEqual(status, 0, "an unreadable subtree hid an orphan and the run reported success");
      assert.match(output, /could not be read/);
      assert.ok(!output.includes("tree-consistent"), "it must not claim consistency about what it could not see");
    } finally {
      chmodSync(join(root, "dist/hidden"), 0o755);
    }
  });

  it("REFUSES when a subtree under a source root cannot be read", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass first");

    mkdirSync(join(root, "tests/hidden"), { recursive: true });
    writeFileSync(join(root, "tests/hidden/ghost.test.ts"), 'import { it } from "node:test";\nit("x", () => {});\n');
    chmodSync(join(root, "tests/hidden"), 0o000);
    try {
      const { status, output } = runHarness(root);
      assert.notEqual(status, 0, "an unreadable source subtree was silently omitted");
      assert.match(output, /could not be read/);
    } finally {
      chmodSync(join(root, "tests/hidden"), 0o755);
    }
  });

  /**
   * A directory that does not EXIST is genuinely empty. Conflating the two
   * would refuse every fresh checkout, where `dist` has not been built yet —
   * which is exactly what the first version of this guard did.
   */
  it("does NOT refuse a fixture whose output directory has never been built", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "a missing dist must not be treated as unreadable");
  });
});

describe("TASK-010 round 6: an ancestor mount is an ordinary workspace", () => {
  /**
   * The mount condition also matched ANCESTORS, so bind-mounting the whole
   * repository onto its own path — a normal layout — was refused with
   * "dist is or contains a mount point".
   *
   * An ancestor mount splices nothing INTO the tree: everything below it moves
   * together and stays consistent. Only a mount AT or INSIDE a managed path
   * splices foreign content in.
   */
  it("ACCEPTS a repository that is itself a bind mount", () => {
    const namespaces = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "true"], {
      encoding: "utf8",
    });
    if (namespaces.status !== 0) {
      console.error("SKIPPED: unprivileged user namespaces unavailable; repository bind mount not proven here");
      return;
    }

    const root = makeFixtureRepo();
    const script = [
      "set -e",
      `mount --bind ${JSON.stringify(root)} ${JSON.stringify(root)}`,
      `grep -qF ${JSON.stringify(root)} /proc/self/mountinfo || { echo "BIND-DID-NOT-TAKE"; exit 97; }`,
      `cd ${JSON.stringify(root)}`,
      "set +e",
      `${JSON.stringify(process.execPath)} scripts/verify.mjs`,
      'echo "HARNESS-EXIT=$?"',
    ].join("\n");

    const result = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "sh", "-c", script], {
      encoding: "utf8",
      env: harnessEnv(),
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    assert.doesNotMatch(output, /BIND-DID-NOT-TAKE/, "the fixture failed to bind-mount, so it proved nothing");
    assert.match(output, /HARNESS-EXIT=0/, `a repository-level bind mount was wrongly refused:\n${output.slice(0, 500)}`);
  });
});


// =====================================================================
// ROUND-7 — what a compiler reads is not predictable from a filename
// =====================================================================

describe("TASK-010 round 7: hardlinked sources of any kind", () => {
  /**
   * THE CRITICAL. The hardlink scan filtered by compilable SUFFIX, encoding an
   * assumption about what tsc reads — and with `allowJs` the assumption was
   * wrong. An external `foreign.js` hardlinked into `src/` was compiled,
   * executed by a test, and the run exited 0 with "tree-consistent".
   */
  it("REFUSES a hardlinked .js source that allowJs makes compilable", () => {
    const root = makeFixtureRepo();
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
      compilerOptions: Record<string, unknown>;
      include: string[];
    };
    tsconfig.compilerOptions["allowJs"] = true;
    tsconfig.include = [...tsconfig.include, "src/**/*.js"];
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const external = mkdtempSync(join(tmpdir(), "sf-alljs-"));
    created.push(external);
    const outsider = join(external, "foreign.js");
    writeFileSync(outsider, "export const smuggled = 7;\n");
    linkSync(outsider, join(root, "src/foreign.js"));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "a hardlinked .js source was compiled and executed");
    assert.match(output, /foreign\.js/);
    assert.ok(!output.includes("tree-consistent"), "it must not claim consistency");
  });

  /** ...and any other extension, because the filter is gone entirely. */
  it("REFUSES a hardlinked file of an extension nobody anticipated", () => {
    const root = makeFixtureRepo();
    const external = mkdtempSync(join(tmpdir(), "sf-anyext-"));
    created.push(external);
    const outsider = join(external, "data.json");
    writeFileSync(outsider, "{}\n");
    linkSync(outsider, join(root, "src/data.json"));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "a hardlinked file was accepted because of its extension");
    assert.match(output, /data\.json/);
  });
});

describe("TASK-010 round 7: a path whose PARENT is a symlink", () => {
  /**
   * `resolvedPath` fell back to lexical resolution when the path did not exist
   * yet, so with `workspace -> .` and no `dist` built, `workspace/dist`
   * resolved somewhere other than `dist` and was refused — even though tsc
   * would write to exactly the managed directory.
   */
  it("ACCEPTS an outDir reached through a symlinked parent, before dist exists", () => {
    const root = makeFixtureRepo();
    rmSync(join(root, "dist"), { recursive: true, force: true });
    symlinkSync(root, join(root, "workspace"), "dir");

    const { status, output } = runWithShowConfigShim(
      root,
      JSON.stringify({ compilerOptions: { outDir: "workspace/dist", noEmit: false } }),
    );
    assert.equal(status, 0, `a symlinked-parent outDir was wrongly refused:\n${output.slice(0, 500)}`);
  });
});

describe("TASK-010 round 7: each readability layer is pinned separately", () => {
  /**
   * Round-7 review: removing EITHER readability assertion left both
   * unreadable-subtree tests green, because the other caught it. Two guards
   * covering one case is defence in depth; a test that cannot tell them apart
   * proves neither.
   *
   * Each stage names itself, so each can be pinned by the message only it
   * produces.
   */
  it("refuses BEFORE BUILDING when a source subtree is unreadable", () => {
    const root = makeFixtureRepo();
    mkdirSync(join(root, "tests/hidden"), { recursive: true });
    writeFileSync(join(root, "tests/hidden/x.test.ts"), 'import { it } from "node:test";\nit("x", () => {});\n');
    chmodSync(join(root, "tests/hidden"), 0o000);
    try {
      const { output } = runHarness(root);
      assert.match(
        output,
        /refused before building: these directories could not be read/,
        "the PRE-BUILD layer did not fire; the later one may be masking it",
      );
    } finally {
      chmodSync(join(root, "tests/hidden"), 0o755);
    }
  });

  it("refuses BEFORE AUDITING when the output becomes unreadable after the build", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass first");

    // Readable while the source is scanned, unreadable by the time the output
    // is audited: only the later layer can catch this.
    mkdirSync(join(root, "dist/hidden"), { recursive: true });
    writeFileSync(join(root, "dist/hidden/ghost.test.js"), "// stale\n");
    chmodSync(join(root, "dist/hidden"), 0o000);
    try {
      const { status, output } = runHarness(root);
      assert.notEqual(status, 0);
      assert.match(output, /could not be read/);
    } finally {
      chmodSync(join(root, "dist/hidden"), 0o755);
    }
  });
});


// =====================================================================
// ROUND-8 — the source roots are the config's, not a guess
// =====================================================================

describe("TASK-010 round 8: compiler inputs outside the assumed roots", () => {
  /**
   * THE CRITICAL. `SOURCE_ROOTS` was hard-coded to `["src", "tests"]` — a guess
   * about this project's shape. Round-8 review put a compiler input somewhere
   * else and it was compiled and executed with no objection. Hard-coding closed
   * the two roots this repository happens to use and left the class open, which
   * is the same mistake as filtering hardlinks by suffix, one level up.
   *
   * The roots now come from the effective tsconfig, which is what tsc actually
   * reads.
   */
  it("REFUSES a linked source under a root the tsconfig declares but nobody hard-coded", () => {
    const root = makeFixtureRepo();

    // A third root, declared in the config exactly as a real project would.
    mkdirSync(join(root, "extra"), { recursive: true });
    writeFileSync(join(root, "extra/helper.ts"), "export const helper = 1;\n");
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
      include: string[];
    };
    tsconfig.include = [...tsconfig.include, "extra/**/*.ts"];
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
    assert.equal(runHarness(root).status, 0, "the fixture must pass before the link is planted");

    const external = mkdtempSync(join(tmpdir(), "sf-extraroot-"));
    created.push(external);
    const outsider = join(external, "foreign.ts");
    writeFileSync(outsider, "export const smuggled = 8;\n");
    linkSync(outsider, join(root, "extra/foreign.ts"));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "a declared source root outside src/ and tests/ was never scanned");
    assert.match(output, /foreign\.ts/);
    assert.ok(!output.includes("tree-consistent"), "it must not claim consistency");
  });

  /** ...and an ordinary project with a linked node_modules still passes. */
  it("does not report a symlinked node_modules as foreign source", () => {
    const root = makeFixtureRepo();
    // makeFixtureRepo already symlinks node_modules; with roots derived from a
    // config that includes only src/ and tests/, it is out of scope anyway —
    // this pins the exclusion for the case where a config declares no include
    // and the root becomes ".".
    assert.equal(runHarness(root).status, 0, "a linked node_modules was treated as foreign source");
  });
});

// =====================================================================
// ROUND-9 — an absolute root, a stale non-test file, and a post-build guard
// =====================================================================

describe("TASK-010 round 9: the config may spell its roots absolutely", () => {
  /**
   * CRITICAL. `deriveSourceRoots` returned an absolute include unchanged and
   * every caller then did `join(REPO_ROOT, root)`, prefixing the repository a
   * second time. The resulting path does not exist, so the symlink check, the
   * hardlink scan and the mount check all ran against nothing and found nothing
   * wrong. The reviewer pointed absolute includes at the fixture's own `src`,
   * replaced `testArtifacts.ts` with a symlink to a module calling
   * `process.exit(0)`, and the run EXITED 0 WITH NO OUTPUT.
   *
   * A false pass is the worst thing this file can produce. This is the third
   * round in which the roots were the way in — hard-coded, then derived but not
   * normalised — which is why the fix is normalisation rather than another
   * special case.
   */
  it("REFUSES a symlinked source when the roots are declared as absolute paths", () => {
    const root = makeFixtureRepo();
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
      include: string[];
    };
    tsconfig.include = [`${root}/src/**/*.ts`, `${root}/tests/**/*.ts`];
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
    assert.equal(runHarness(root).status, 0, "the fixture must pass before the link is planted");

    const external = mkdtempSync(join(tmpdir(), "sf-absroot-"));
    created.push(external);
    const hostile = join(external, "testArtifacts.ts");
    writeFileSync(hostile, "process.exit(0);\nexport const nothing = 0;\n");
    rmSync(join(root, "src/verification/testArtifacts.ts"));
    symlinkSync(hostile, join(root, "src/verification/testArtifacts.ts"));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "an absolute include left the source roots unscanned");
    assert.ok(output.trim().length > 0, "it exited without saying anything, which is the false pass itself");
    assert.match(output, /testArtifacts\.ts/);
  });

  /** ...and a config that compiles from OUTSIDE the repository is refused. */
  it("REFUSES a config whose sources live outside the repository", () => {
    const root = makeFixtureRepo();
    const external = mkdtempSync(join(tmpdir(), "sf-outside-"));
    created.push(external);
    mkdirSync(join(external, "elsewhere"), { recursive: true });
    writeFileSync(join(external, "elsewhere/thing.ts"), "export const thing = 1;\n");

    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
      include: string[];
    };
    tsconfig.include = [...tsconfig.include, `${external}/elsewhere/**/*.ts`];
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "source outside the repository was compiled without objection");
    assert.match(output, /outside this repository/);
  });
});

describe("TASK-010 round 9: a test declared outside tests/", () => {
  /**
   * AC-1 FAIL. Discovery was pinned to `tests/**\/*.test.ts` while the roots were
   * derived from the config, so the two halves disagreed: a test the config
   * declares elsewhere was COMPILED, matched no discovered source, and was
   * reported as an orphan of the tree that legitimately produced it. The run
   * cleaned, rebuilt, produced it again, and failed.
   *
   * Discovery follows the same derived roots now, which is the only way the two
   * halves can stay in agreement.
   */
  it("discovers and RUNS a test from a root the config declares", () => {
    const root = makeFixtureRepo();
    mkdirSync(join(root, "extra"), { recursive: true });
    writeFileSync(
      join(root, "extra/foreign.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { describe, it } from "node:test";',
        'describe("declared elsewhere", () => { it("runs", () => { assert.equal(2, 2); }); });',
        "",
      ].join("\n"),
    );
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
      include: string[];
    };
    tsconfig.include = [...tsconfig.include, "extra/**/*.ts"];
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { status, output } = runHarness(root);
    assert.equal(status, 0, `a config-declared test was rejected by its own tree:\n${output}`);
    assert.match(output, /2 test files/, "the declared test was not discovered");
    assert.match(output, /tree-consistent/);
  });
});

describe("TASK-010 round 9: stale output that is not a test", () => {
  /**
   * HIGH. The audit filtered the output through `isTestArtifact`, so a planted
   * `dist/src/old-branch.js` survived the run, which exited 0 and reported
   * `tree-consistent`. AC-4 requires an equivalent final generated state, and a
   * file another branch left behind is imported by whatever still references it.
   */
  it("names a stale non-test artifact, removes it, and still converges", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass before anything is planted");

    const stale = join(root, "dist/src/old-branch.js");
    writeFileSync(stale, "export const fromAnotherBranch = 1;\n");
    assert.ok(existsSync(stale));

    const { status, output } = runHarness(root);
    assert.match(output, /old-branch\.js/, "the stale file was never mentioned");
    assert.match(output, /stale build output/);
    assert.equal(status, 0, `the repair cycle should converge:\n${output}`);
    assert.ok(!existsSync(stale), "AC-4: the final generated state still contained another branch's output");
  });
});

describe("TASK-010 round 9: a whole-repository source root", () => {
  /**
   * The `node_modules` exclusion had a test that passed for the wrong reason:
   * its fixture declared `src/**\/*.ts` and `tests/**\/*.ts`, so the symlinked
   * `node_modules` was never in scope and the exclusion was never exercised.
   *
   * A config whose include begins with a glob roots at the repository itself,
   * which is when the exclusion actually decides anything.
   */
  it("passes with a symlinked node_modules when the root is the repository", () => {
    const root = makeFixtureRepo();
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as Record<string, unknown>;
    tsconfig["include"] = ["**/*.ts"];
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { status, output } = runHarness(root);
    assert.equal(status, 0, `a linked node_modules under a "." root was treated as foreign source:\n${output}`);
    assert.match(output, /tree-consistent/);
  });
});

describe("TASK-010 round 9: the guard that runs AFTER the build", () => {
  /**
   * A reviewer's mutation of the post-build `assessTreeSafety` wiring survived,
   * because every fixture condition is caught earlier by the pre-build layer.
   * That is the right order and it left the later layer unproven.
   *
   * A build that plants the link itself is the case only the post-build scan can
   * see — and it is not contrived: anything running as part of the build can
   * write into the output directory.
   */
  it("REFUSES a symlink the BUILD placed under the output directory", () => {
    const root = makeFixtureRepo();
    const external = mkdtempSync(join(tmpdir(), "sf-postbuild-"));
    created.push(external);
    const outsider = join(external, "ghost.test.js");
    writeFileSync(outsider, "export const ghost = 1;\n");

    const { status, output } = runWithBuildThatPlants(
      root,
      `ln -s ${JSON.stringify(outsider)} dist/tests/planted.test.js`,
    );
    assert.notEqual(status, 0, "a symlink created during the build was never noticed");
    assert.match(output, /planted\.test\.js/);
    assert.ok(!output.includes("tree-consistent"), "it must not claim consistency");
  });

  /** The same shim, planting nothing, must still pass — or it proves nothing. */
  it("passes when the build plants nothing", () => {
    const root = makeFixtureRepo();
    const { status, output } = runWithBuildThatPlants(root, "true");
    assert.equal(status, 0, `the shim itself broke the run:\n${output}`);
    assert.match(output, /tree-consistent/);
  });
});

// =====================================================================
// ROUND-10 — the compiler's own inputs, and a second build judged like a build
// =====================================================================

describe("TASK-010 round 10: an EXCLUDED source explains nothing", () => {
  /**
   * CRITICAL. The source set was globbed from the derived roots, which ignores
   * `exclude` entirely — so a test the config excludes still counted as current,
   * and an old artifact at the same path was therefore "explained" by it. The
   * reviewer excluded a test, planted its previous build output, and the stale
   * artifact RAN while the harness reported success.
   *
   * The set now comes from `tsc --listFilesOnly`: the actual program, which is
   * `include` minus `exclude` PLUS whatever imports reach — a distinction a glob
   * gets wrong in both directions.
   */
  it("REFUSES a stale artifact whose only explanation is an excluded source", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass before anything is planted");

    // A second test, compiled once so that a real artifact exists...
    writeFileSync(
      join(root, "tests/excluded.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { describe, it } from "node:test";',
        'describe("excluded", () => { it("passes", () => { assert.equal(1, 1); }); });',
        "",
      ].join("\n"),
    );
    assert.equal(runHarness(root).status, 0, "the second test must compile and pass first");
    assert.ok(existsSync(join(root, "dist/tests/excluded.test.js")), "its artifact must exist");

    // ...then excluded, leaving the artifact behind. Nothing compiles it now, so
    // nothing explains it, and it must not be treated as current.
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
      exclude?: string[];
    };
    tsconfig.exclude = ["tests/excluded.test.ts"];
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { status, output } = runHarness(root);
    assert.match(output, /excluded\.test\.js/, "the unexplained artifact was never mentioned");
    assert.ok(
      !existsSync(join(root, "dist/tests/excluded.test.js")),
      "the artifact an excluded source cannot explain is still in the final tree",
    );
    assert.equal(status, 0, `the repair cycle should converge:\n${output}`);
  });

  /** An import from an included file DOES make a file an input, exclude or not. */
  it("still counts a file the program reaches by import", () => {
    const root = makeFixtureRepo();
    writeFileSync(join(root, "tests/helper.ts"), "export const helper = 41;\n");
    writeFileSync(
      join(root, "tests/sample.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { describe, it } from "node:test";',
        'import { helper } from "./helper.js";',
        'describe("sample", () => { it("passes", () => { assert.equal(helper + 1, 42); }); });',
        "",
      ].join("\n"),
    );
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
      exclude?: string[];
    };
    // Excluded, and imported anyway — tsc compiles it, so the audit must expect
    // its artifact rather than calling it an orphan.
    tsconfig.exclude = ["tests/helper.ts"];
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { status, output } = runHarness(root);
    assert.equal(status, 0, `an imported-but-excluded file confused the audit:\n${output}`);
    assert.match(output, /tree-consistent/);
  });
});

describe("TASK-010 round 10: the repair rebuild is a build like any other", () => {
  /**
   * HIGH. After cleaning, the second build ran and only the AUDIT looked at the
   * result — no output-link scan, no output-directory check, no mount check, no
   * readability check. The reviewer made the second build replace `dist` with a
   * symlink to an external generated tree; the run exited 0 and executed that
   * tree's tests.
   *
   * The safety judgement is one function now, called after every build, and it
   * gathers its facts fresh each time — a fact captured before the second build
   * says nothing about after it.
   */
  it("REFUSES an output directory the SECOND build replaced with a symlink", () => {
    const root = makeFixtureRepo();
    const external = mkdtempSync(join(tmpdir(), "sf-second-build-"));
    created.push(external);
    mkdirSync(join(external, "tests"), { recursive: true });

    // Build once, so there is a `dist` to contaminate.
    assert.equal(runHarness(root).status, 0, "the fixture must pass before anything is planted");

    // Contaminate, so the repair cycle definitely runs; then swap the output on
    // the SECOND build only, using a marker the first build leaves behind.
    writeFileSync(join(root, "dist/src/old-branch.js"), "export const stale = 1;\n");
    const marker = join(root, ".second-build");
    const { status, output } = runWithBuildThatPlants(
      root,
      `if [ -f ${JSON.stringify(marker)} ]; then rm -rf dist && ln -s ${JSON.stringify(external)} dist; ` +
        `else : > ${JSON.stringify(marker)}; fi`,
    );

    assert.notEqual(status, 0, "the second build redirected the output and nothing looked again");
    assert.match(output, /after the repair rebuild/, "the refusal must say which stage caught it");
  });
});
