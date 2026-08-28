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
      // ...and the file LISTING, which is a question rather than a build. Round
      // 11 added `--listFilesOnly` before the first build, so without this the
      // `after` action fires on it and a case meaning "on the second BUILD"
      // silently acts one invocation early.
      `  if [ "$a" = "--listFilesOnly" ]; then exec ${realNpx} "$@"; fi`,
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
   * AC-1 at the harness level (review finding F) — and an honest statement of
   * how far that goes.
   *
   * This comment used to claim the case makes `audit.expected` and
   * `compiledTests` DIFFER on an otherwise-clean tree. That is impossible, and
   * round-14 review said so: execution is reached only after a CLEAN audit, and
   * clean means those two lists are equal. No end-to-end case can distinguish
   * them, because on every tree that runs they are the same argv.
   *
   * What this case does prove is that the count reported is the count DERIVED
   * FROM SOURCE, and that adding a source file changes it — so discovery is not
   * a glob over whatever happens to sit in the output directory. The part AC-1
   * rests on is the AUDIT itself, whose removal fails several named regressions
   * in this file and in tests/verificationArtifacts.test.ts.
   *
   * Recorded as a coverage limit in docs/KNOWN-LIMITATIONS.md L-8.
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
   * Skipped, and COUNTED as skipped, where unprivileged user namespaces are
   * unavailable. The pure decision tests still cover the logic there; only this
   * wiring proof is environment-dependent, and that limitation is stated rather
   * than hidden.
   */
  it("REFUSES a real same-device bind-mounted output directory", (t) => {
    const namespaces = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "true"], {
      encoding: "utf8",
    });
    if (namespaces.status !== 0) {
      // `t.skip`, not `console.error` plus a bare return (round-14 note 5). The
      // earlier form printed a reason and then reported `pass 1, skipped 0`, so
      // the summary a reader actually looks at claimed coverage this
      // environment never obtained. A lost proof has to show in the counts.
      t.skip("unprivileged user namespaces unavailable; bind-mount wiring not proven here");
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
    it(`REFUSES a real bind-mounted ${root} root before building`, (t) => {
      const namespaces = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "true"], {
        encoding: "utf8",
      });
      if (namespaces.status !== 0) {
        // Counted as skipped rather than printed and passed — round-14 note 5.
        t.skip(`unprivileged user namespaces unavailable; ${root} bind-mount not proven here`);
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
  it("ACCEPTS a repository that is itself a bind mount", (t) => {
    const namespaces = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "true"], {
      encoding: "utf8",
    });
    if (namespaces.status !== 0) {
      // Counted as skipped rather than printed and passed — round-14 note 5.
      t.skip("unprivileged user namespaces unavailable; repository bind mount not proven here");
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

  /**
   * ...and an ordinary project with a linked node_modules still passes.
   *
   * VACUOUS AS FIRST WRITTEN (round-17 review). Its own comment admitted
   * `node_modules` was "out of scope anyway" with the fixture's `src`/`tests`
   * includes, and then claimed to pin the `.`-root case regardless. The reviewer
   * deleted the whole-root setup from the neighbouring control and it still
   * passed 1/1, which is what a test proving nothing looks like.
   *
   * It needs the root to be `.`, or `node_modules` is never walked and the
   * exclusion under test is never reached.
   */
  it("does not report a symlinked node_modules as foreign source", () => {
    const root = makeFixtureRepo();
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
      include?: string[];
    };
    tsconfig.include = ["**/*.ts"];
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { status, output } = runHarness(root);
    assert.equal(status, 0, `a linked node_modules was treated as foreign source:\n${output}`);
    assert.match(output, /tree-consistent/, "and the run must actually have audited the tree");
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
    /**
     * The external tree is a COPY of what the build just produced, so the
     * redirected output is complete and fresh.
     *
     * That matters: an empty external directory is caught one step earlier, by
     * the "the rebuild did not emit the checker" guard, and the case would then
     * prove that guard rather than this one. The reviewer's scenario is a
     * redirect to a WORKING external generated tree, where the only thing wrong
     * is that it is not this repository's.
     */
    const marker = join(root, ".second-build");
    const { status, output } = runWithBuildThatPlants(
      root,
      `if [ -f ${JSON.stringify(marker)} ]; then cp -r dist/. ${JSON.stringify(external)}/ && ` +
        `rm -rf dist && ln -s ${JSON.stringify(external)} dist; ` +
        `else : > ${JSON.stringify(marker)}; fi`,
    );

    assert.notEqual(status, 0, "the second build redirected the output and nothing looked again");
    assert.match(output, /after the repair rebuild/, "the refusal must say which stage caught it");
  });
});

// =====================================================================
// ROUND-11 — a skipped directory name is not a safe directory
// =====================================================================

describe("TASK-010 round 11: a compiler input inside a skipped directory", () => {
  /**
   * CRITICAL. The source scan skipped entries named `dist`, `.git` and
   * `node_modules` AT EVERY DEPTH, before any link inspection. That exclusion
   * exists for a good reason — a `.` source root must not report an ordinary
   * workspace as foreign — and it was a name filter over a set the compiler does
   * not define.
   *
   * The reviewer put `src/dist/evil.ts` in the tree, excluded it in tsconfig,
   * imported it from a test (which makes tsc compile it anyway: `exclude` is
   * about the initial file list, not reachability) and hardlinked it to an
   * external file. `--listFilesOnly` listed it. The scan skipped it by directory
   * name. The external content executed under a "tree-consistent" report.
   */
  it("REFUSES a hardlinked source under a directory the walk skips by name", () => {
    const root = makeFixtureRepo();
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as Record<string, unknown>;
    tsconfig["include"] = ["**/*.ts"];
    tsconfig["exclude"] = ["src/dist/**/*.ts"];
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    mkdirSync(join(root, "src/dist"), { recursive: true });
    writeFileSync(join(root, "src/dist/evil.ts"), "export const evil = 1;\n");
    writeFileSync(
      join(root, "tests/sample.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { describe, it } from "node:test";',
        'import { evil } from "../src/dist/evil.js";',
        'describe("sample", () => { it("passes", () => { assert.equal(evil, 1); }); });',
        "",
      ].join("\n"),
    );
    assert.equal(runHarness(root).status, 0, "the fixture must pass before the link is planted");

    const external = mkdtempSync(join(tmpdir(), "sf-nested-skip-"));
    created.push(external);
    const outsider = join(external, "evil.ts");
    writeFileSync(outsider, "export const evil = 1;\n");
    rmSync(join(root, "src/dist/evil.ts"));
    linkSync(outsider, join(root, "src/dist/evil.ts"));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "a hardlinked compiler input was skipped by its directory's name");
    assert.match(output, /evil\.ts/);
    assert.ok(!output.includes("tree-consistent"), "it must not claim consistency");
  });

  /**
   * A symlinked DIRECTORY holding compiler inputs, in a place the walk skips by
   * name — the same escape as the hardlink above, one level up.
   *
   * WHICH GUARD CATCHES IT, measured: not the compiler-input file scan, and not
   * an ancestor-directory check (one was written, and a mutation showed it
   * redundant, so it was removed). `tsc --showConfig` resolves `**` into a
   * `files` list, so `src/dist/linked` becomes a DERIVED ROOT and the
   * root-symlink refusal names it directly.
   *
   * The case stays because the PROPERTY is what matters — external code must not
   * arrive through a directory the walk skips — and it is asserted end to end
   * rather than attributed to a guard that a mutation contradicts.
   */
  it("REFUSES a compiler input reached through a symlinked directory the walk skips", () => {
    const root = makeFixtureRepo();
    const external = mkdtempSync(join(tmpdir(), "sf-linked-dir-"));
    created.push(external);
    writeFileSync(join(external, "helper.ts"), "export const helper = 1;\n");

    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as Record<string, unknown>;
    tsconfig["include"] = ["**/*.ts"];
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    mkdirSync(join(root, "src/dist"), { recursive: true });
    symlinkSync(external, join(root, "src/dist/linked"), "dir");
    writeFileSync(
      join(root, "tests/sample.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { describe, it } from "node:test";',
        'import { helper } from "../src/dist/linked/helper.js";',
        'describe("sample", () => { it("passes", () => { assert.equal(helper, 1); }); });',
        "",
      ].join("\n"),
    );

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "external source arrived through a symlinked directory the walk skips");
    assert.match(output, /linked/);
  });

  /** NEGATIVE CONTROL: an ordinary workspace is still not foreign source. */
  it("still passes with a linked node_modules under a whole-repository root", () => {
    const root = makeFixtureRepo();
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as Record<string, unknown>;
    tsconfig["include"] = ["**/*.ts"];
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { status, output } = runHarness(root);
    assert.equal(status, 0, `an ordinary workspace was refused:\n${output}`);
    assert.match(output, /tree-consistent/);
  });
});

describe("TASK-010 round 11: readability, AFTER the build for real", () => {
  /**
   * The existing "after the build" case created the unreadable directory BEFORE
   * invoking the harness, so the PRE-build readability walk caught it — a test
   * passing for a reason other than the one it claimed. Here the BUILD creates
   * the condition, so only a check running afterwards can see it.
   *
   * WHAT THIS DOES AND DOES NOT PIN, measured rather than assumed: readability
   * is asserted at more than one point after the build, so removing any single
   * one of them leaves this green. It pins the PROPERTY — an unreadable
   * directory the build leaves behind is refused — and not one call site. Said
   * here because the alternative is a comment claiming a guard is tested when a
   * mutation shows it is not.
   */
  it("REFUSES when the BUILD makes part of the output unreadable", () => {
    const root = makeFixtureRepo();
    const { status, output } = runWithBuildThatPlants(root, "mkdir -p dist/hidden && chmod 000 dist/hidden");
    try {
      assert.notEqual(status, 0, "a directory the build made unreadable was scanned as empty");
      assert.match(output, /could not be read|unreadable/i);
    } finally {
      // Leave it removable, or the fixture cleanup fails.
      try {
        chmodSync(join(root, "dist/hidden"), 0o700);
      } catch {
        /* already gone */
      }
    }
  });
});

// =====================================================================
// ROUND-12 — a symlink ABOVE every root, and a test that proved nothing
// =====================================================================

describe("TASK-010 round 12: a symlinked ancestor of a derived root", () => {
  /**
   * CRITICAL, and the correction of a removal I made on incomplete evidence.
   *
   * Round 11 added an ancestor check, a mutation showed it caught nothing the
   * suite already caught, and I removed it on that evidence. This is the case it
   * existed for: `src` is a symlink to an external directory, and `include`
   * names `src/foo/**` and `src/verification/...`, so the DERIVED ROOTS are
   * `src/foo`, `src/verification` and `tests`. `src` itself is never a root, so
   * the root-symlink refusal never looks at it; the walk starts below the link;
   * and `lstat` on each file follows it. Exit 0, "tree-consistent", external code
   * executed.
   *
   * The measurement was right about the case it measured and wrong as a
   * generalisation. "A mutation shows this is redundant" means redundant for the
   * cases the suite covers, and the question that should have followed — what
   * case would make it necessary? — was not asked.
   */
  it("REFUSES when a directory ABOVE every derived root is a symlink", () => {
    const root = makeFixtureRepo();
    const external = mkdtempSync(join(tmpdir(), "sf-ancestor-"));
    created.push(external);

    // The external tree holds everything `src` used to.
    mkdirSync(join(external, "verification"), { recursive: true });
    mkdirSync(join(external, "foo"), { recursive: true });
    cpSync(join(root, "src/verification/testArtifacts.ts"), join(external, "verification/testArtifacts.ts"));
    writeFileSync(join(external, "foo/helper.ts"), "export const helper = 1;\n");

    rmSync(join(root, "src"), { recursive: true, force: true });
    symlinkSync(external, join(root, "src"), "dir");

    // Roots that sit INSIDE the symlink, so none of them is the link itself.
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as Record<string, unknown>;
    tsconfig["include"] = ["src/foo/**/*.ts", "src/verification/testArtifacts.ts", "tests/**/*.ts"];
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "external source arrived through a symlink above every root");
    assert.ok(output.trim().length > 0, "it exited silently, which is the false pass itself");
    assert.match(output, /src/);
    assert.ok(!output.includes("tree-consistent"), "it must not claim consistency");
  });

  /**
   * THE CASE THE ROOT-SIDE ANCESTOR CHECK IS THE ONLY ANSWER TO.
   *
   * Mutation testing showed the reproduction above is caught by the INPUT scan's
   * ancestor walk alone — removing the root loop's copy left it green. The
   * lesson of this very round is not to delete a guard on that evidence without
   * asking what case would need it, so: a declared root inside a symlink that
   * holds no compiler inputs YET.
   *
   * The input scan never looks, because there is nothing under it to look at.
   * The root loop does. Refusing is the closed direction — the config has
   * declared that source will be compiled from inside a symlink, and "it is
   * empty today" is not a property anyone maintains.
   */
  it("REFUSES when the config declares a root inside a symlink that holds no sources yet", () => {
    const root = makeFixtureRepo();
    const external = mkdtempSync(join(tmpdir(), "sf-empty-ancestor-"));
    created.push(external);
    mkdirSync(join(external, "none"), { recursive: true });

    symlinkSync(external, join(root, "vendor"), "dir");
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as Record<string, unknown>;
    tsconfig["include"] = ["src/**/*.ts", "tests/**/*.ts", "vendor/none/**/*.ts"];
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "a declared root inside a symlink was accepted because it happened to be empty");
    assert.match(output, /vendor/);
  });

  /**
   * THE CASE THE INPUT-SIDE ANCESTOR CHECK IS THE ONLY ANSWER TO.
   *
   * The root-side walk covers ancestors of DECLARED roots. A file reached by
   * IMPORT does not have to live under one: `exclude` does not stop an import,
   * and neither does never having been declared. So `vendor` here is not a root
   * — nothing in `include` mentions it — and the root-side walk never considers
   * it. Only the input-side walk, over what the compiler says it actually reads,
   * sees that the file arrives through a symlink.
   *
   * Asked BEFORE deciding whether the check was redundant, because last round I
   * deleted its sibling on a mutation that only proved redundancy for the cases
   * the suite happened to cover.
   */
  it("REFUSES an imported file that arrives through a symlink outside every declared root", () => {
    const root = makeFixtureRepo();
    const external = mkdtempSync(join(tmpdir(), "sf-imported-"));
    created.push(external);
    writeFileSync(join(external, "helper.ts"), "export const helper = 1;\n");

    // `vendor` is a symlink and is NOT in `include`; the import is what pulls it
    // into the program.
    symlinkSync(external, join(root, "vendor"), "dir");
    writeFileSync(
      join(root, "tests/sample.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { describe, it } from "node:test";',
        'import { helper } from "../vendor/helper.js";',
        'describe("sample", () => { it("passes", () => { assert.equal(helper, 1); }); });',
        "",
      ].join("\n"),
    );

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "an imported file arrived through a symlink no declared root covers");
    assert.match(output, /vendor/);
  });

  /** NEGATIVE CONTROL: nested roots with no symlink above them still pass. */
  it("still passes when the same roots are ordinary directories", () => {
    const root = makeFixtureRepo();
    mkdirSync(join(root, "src/foo"), { recursive: true });
    writeFileSync(join(root, "src/foo/helper.ts"), "export const helper = 1;\n");
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as Record<string, unknown>;
    tsconfig["include"] = ["src/foo/**/*.ts", "src/verification/testArtifacts.ts", "tests/**/*.ts"];
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { status, output } = runHarness(root);
    assert.equal(status, 0, `ordinary nested roots were refused:\n${output}`);
    assert.match(output, /tree-consistent/);
  });
});

describe("TASK-010 round 13: an artifact kind the configuration no longer emits", () => {
  /**
   * HIGH. `sourceForGeneratedPath` accepted `.d.ts`, `.d.ts.map` and `.js.map`
   * whenever their source existed, without asking whether this configuration
   * emits them. The reviewer built a fixture with neither `declaration` nor
   * `sourceMap`, planted a `.d.ts`, and the run exited 0 reporting
   * `tree-consistent` with the stale file still in place.
   *
   * A fresh clone has no such file. That is precisely what AC-4's "equivalent
   * final generated state" forbids.
   */
  it("removes a declaration left by a configuration that no longer emits one", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass before anything is planted");

    const stale = join(root, "dist/src/verification/testArtifacts.d.ts");
    writeFileSync(stale, "export declare const stale: number;\n");
    assert.ok(existsSync(stale));

    const { status, output } = runHarness(root);
    assert.match(output, /testArtifacts\.d\.ts/, "the stale declaration was never mentioned");
    assert.ok(!existsSync(stale), "AC-4: a kind this configuration does not emit survived the run");
    assert.equal(status, 0, `the repair cycle should converge:\n${output}`);
  });
});

// ---------------------------------------------------------------------------
// ROUND-14 non-blocking note 6 — an entry that is neither file nor directory
// ---------------------------------------------------------------------------

/**
 * The walk kept directories and `entry.isFile()` and dropped everything else.
 * The reviewer planted a FIFO under `dist/` and the run exited 0: not an orphan,
 * not an expected artifact, not mentioned.
 *
 * Correctly scored NON-BLOCKING — a FIFO cannot execute through a
 * source-derived runner, so nothing was made to run by it. It is fixed anyway
 * because "cannot execute" is not "is accounted for", and the audit reported on
 * the tree having examined only the regular files in it. That is the
 * unreadable-directory defect one class over, and that one was CRITICAL.
 */
describe("TASK-010 round 14: an entry that is neither a file nor a directory", () => {
  /** True when a FIFO was created; false where the platform has no `mkfifo`. */
  function makeFifo(path: string): boolean {
    if (process.platform === "win32") {
      return false;
    }
    return spawnSync("mkfifo", [path], { encoding: "utf8" }).status === 0;
  }

  it("REFUSES a FIFO planted under the output directory", (t) => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass before anything is planted");

    const fifo = join(root, "dist/tests/pipe.test.js");
    if (!makeFifo(fifo)) {
      // COUNTED as skipped, not reported as passed. An environment that cannot
      // create a FIFO must not present this coverage as obtained — which is
      // round-14 note 5, applied here rather than only complained about.
      t.skip("mkfifo unavailable on this platform; FIFO handling not proven here");
      return;
    }

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, `a FIFO under the output directory was ignored:\n${output}`);
    assert.match(output, /pipe\.test\.js/, "the refusal must name the entry it refuses");
    assert.match(output, /FIFO/, "and say what it is, so a reader can act on it");
    // The STAGE, so this pins the PRE-BUILD call site rather than the property
    // that some stage eventually notices. Without it the three call sites mask
    // each other and any one of them satisfies this case -- measured, not
    // assumed: removing each one alone left this green.
    assert.match(output, /refused before building/, `expected the pre-build stage to catch it:\n${output}`);
  });

  /**
   * The AFTER-BUILD call site, pinned the same way the readability one was.
   *
   * A FIFO planted before the run is caught pre-build, so it cannot distinguish
   * the post-build call. This one is created BY the build — the case that call
   * site exists for: output the pre-build inspection never saw, because it did
   * not exist yet.
   */
  it("REFUSES a FIFO the BUILD creates, at the after-building stage", (t) => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass before the shim is used");
    if (process.platform === "win32") {
      t.skip("no mkfifo on this platform; build-created FIFO not proven here");
      return;
    }

    const realNpx = spawnSync("sh", ["-c", "command -v npx"], { encoding: "utf8" }).stdout.trim();
    assert.ok(realNpx.length > 0, "the fixture needs a real npx to delegate to");

    const shimDir = mkdtempSync(join(tmpdir(), "sf-fifoshim-"));
    created.push(shimDir);
    writeFileSync(
      join(shimDir, "npx"),
      [
        "#!/bin/sh",
        "# Config and file-list queries pass straight through: making the FIFO",
        "# during them would put it in the tree BEFORE the pre-build walk, which",
        "# is the case the other test already covers.",
        'for a in "$@"; do',
        '  case "$a" in',
        `    --showConfig|--listFilesOnly) exec ${realNpx} "$@" ;;`,
        "  esac",
        "done",
        `${realNpx} "$@"`,
        "rc=$?",
        'if [ "$rc" -eq 0 ]; then',
        "  mkdir -p dist/tests",
        "  mkfifo dist/tests/emitted.test.js 2>/dev/null || true",
        "fi",
        'exit "$rc"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(process.execPath, ["scripts/verify.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: harnessEnv({ PATH: `${shimDir}:${process.env["PATH"] ?? ""}` }),
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    if (!existsSync(join(root, "dist/tests/emitted.test.js"))) {
      t.skip("mkfifo unavailable inside the shim; build-created FIFO not proven here");
      return;
    }

    assert.notEqual(result.status, 0, `a FIFO created by the build was accepted:\n${output}`);
    assert.match(output, /emitted\.test\.js/, "the refusal must name it");
    assert.match(
      output,
      /refused after building/,
      `the post-build call site must be what caught it:\n${output}`,
    );
  });

  /**
   * The negative control must SUCCEED, not merely fail to refuse. Without it the
   * case above is satisfied by a harness that refuses every tree.
   */
  it("still accepts a tree whose output holds only regular files", () => {
    const root = makeFixtureRepo();
    const { status, output } = runHarness(root);
    assert.equal(status, 0, `an ordinary tree was refused:\n${output}`);
    assert.match(output, /tree-consistent/);
  });
});

// ---------------------------------------------------------------------------
// ROUND-14 non-blocking note 4 — proofs that pin a CALL SITE, not a property
// ---------------------------------------------------------------------------

/**
 * Two guards were exercised only by tests a LATER guard also satisfies.
 *
 * Round-14 review removed the pre-build `linkedCompilerInputs()` call and the
 * imported-symlink test stayed green, because the post-build safety check caught
 * the same tree. It removed the post-build readability assertion and the run
 * still refused, because the pre-audit readability check caught it. Both are
 * real property tests and neither proves the call site it was credited to.
 *
 * A property test that any of three guards can satisfy tells you the property
 * holds. It does not tell you the guard you are about to delete is the one
 * holding it. These two ask the narrower question: WHERE did the refusal happen?
 */
describe("TASK-010 round 14: each refusal happens at the stage it claims", () => {
  /**
   * The pre-build call, pinned by the build NEVER RUNNING.
   *
   * A symlinked compiler input OUTSIDE every derived root is invisible to
   * `findSymlinks`, which only walks the roots. `tsc --listFilesOnly` reports it,
   * so `linkedCompilerInputs()` refuses before anything is built.
   *
   * Delete that call and the tree is still refused — by the post-build check,
   * AFTER tsc has run and written `dist`. So the discriminator is not whether it
   * refuses but whether `dist` exists afterwards, and that is a fact about the
   * call site rather than about the property.
   */
  it("refuses a symlinked compiler input BEFORE building, not after", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass before the link is planted");
    rmSync(join(root, "dist"), { recursive: true, force: true });

    // Outside src/ and tests/, so no root walk sees it; imported by a test, so
    // tsc compiles it anyway -- `include` does not stop an import.
    const external = mkdtempSync(join(tmpdir(), "sf-callsite-"));
    created.push(external);
    const outsider = join(external, "smuggled.ts");
    writeFileSync(outsider, "export const smuggled = 14;\n");
    mkdirSync(join(root, "helpers"), { recursive: true });
    symlinkSync(outsider, join(root, "helpers/smuggled.ts"));
    writeFileSync(
      join(root, "tests/sample.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { describe, it } from "node:test";',
        'import { smuggled } from "../helpers/smuggled.js";',
        'describe("sample", () => { it("passes", () => { assert.equal(smuggled, 14); }); });',
        "",
      ].join("\n"),
    );

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, `a symlinked compiler input outside the roots was accepted:\n${output}`);
    assert.match(output, /refused before building/, "the refusal must come from the PRE-build call");
    assert.ok(
      !existsSync(join(root, "dist")),
      "the build ran before the tree was refused, so the pre-build call is not what refused it",
    );
  });

  /**
   * The post-build readability assertion, pinned by the STAGE IT NAMES.
   *
   * The unreadable directory has to appear DURING the build, or the pre-build
   * readability check sees it first and the post-build one is never the guard
   * under test. So the shim runs the real tsc and then locks a directory under
   * the output — which is exactly the situation the post-build assertion exists
   * for: a build that leaves the tree in a state nobody inspected before it ran.
   */
  it("reports an unreadable output directory created BY the build at the after-building stage", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass before the shim is used");

    const realNpx = spawnSync("sh", ["-c", "command -v npx"], { encoding: "utf8" }).stdout.trim();
    assert.ok(realNpx.length > 0, "the fixture needs a real npx to delegate to");

    const shimDir = mkdtempSync(join(tmpdir(), "sf-lockshim-"));
    created.push(shimDir);
    writeFileSync(
      join(shimDir, "npx"),
      [
        "#!/bin/sh",
        "# Config and file-list queries pass straight through: locking during",
        "# them would be caught by the PRE-build check and prove nothing.",
        'for a in "$@"; do',
        '  case "$a" in',
        `    --showConfig|--listFilesOnly) exec ${realNpx} "$@" ;;`,
        "  esac",
        "done",
        `${realNpx} "$@"`,
        "rc=$?",
        'if [ "$rc" -eq 0 ]; then',
        "  mkdir -p dist/locked",
        "  chmod 000 dist/locked",
        "fi",
        'exit "$rc"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const locked = join(root, "dist/locked");
    try {
      const result = spawnSync(process.execPath, ["scripts/verify.mjs"], {
        cwd: root,
        encoding: "utf8",
        env: harnessEnv({ PATH: `${shimDir}:${process.env["PATH"] ?? ""}` }),
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      assert.notEqual(result.status, 0, `an unreadable directory under the output was accepted:\n${output}`);
      assert.match(output, /could not be read/, "the refusal must be the readability one");
      assert.match(
        output,
        /refused after building/,
        `the post-build assertion must be what caught it, not a later stage:\n${output}`,
      );
    } finally {
      // Restore the mode or the fixture cleanup cannot remove the tree.
      if (existsSync(locked)) {
        chmodSync(locked, 0o755);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ROUND-15 blocking finding 2 — a skipped directory NAME is not a safe directory
// ---------------------------------------------------------------------------

/**
 * The scan skipped ANY directory called `dist`, at any depth, so a hardlink in
 * `src/dist/` was never looked at and the run reported `tree-consistent`. The
 * reviewer demonstrated it with `src/dist/data.json` at `nlink=2`.
 *
 * This is the round-11 finding a second time: round 11 closed it for COMPILER
 * INPUTS via `linkedCompilerInputs`, and a `.json` is not a compiler input, so
 * it fell through both guards.
 *
 * It is also the defect I introduced by widening L-6 to claim every regular
 * file under every derived root was scanned. The documentation was made to
 * match what I believed the code did instead of what it did, which is the third
 * of the four shapes -- a claim nothing tests.
 */
describe("TASK-010 round 15: a source directory named like the output directory", () => {
  it("REFUSES a hardlinked file under src/dist, which is not the build output", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass before the link is planted");

    const external = mkdtempSync(join(tmpdir(), "sf-srcdist-"));
    created.push(external);
    const outsider = join(external, "data.json");
    writeFileSync(outsider, '{"smuggled":true}\n');

    mkdirSync(join(root, "src/dist"), { recursive: true });
    linkSync(outsider, join(root, "src/dist/data.json"));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, `a hardlink under src/dist was never scanned:\n${output}`);
    assert.match(output, /src\/dist\/data\.json/, "the refusal must name the file it refuses");
    assert.ok(!output.includes("tree-consistent"), "it must not also claim the tree is consistent");
  });

  /**
   * The control that keeps the fix from being a blanket "scan everything".
   *
   * The real output directory must STILL be skipped by source scans, or every
   * build artifact is reported as foreign source and no tree ever verifies.
   * This is the case that fails if the path check is replaced by scanning
   * everything, so the fix cannot be over-applied without being noticed.
   */
  it("still skips the REAL output directory during the source scan", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "a clean fixture must pass");

    // A hardlink in the true output directory is the OUTPUT scan's business,
    // and it is caught there -- by a refusal that names the output, not one
    // that calls it foreign source.
    const external = mkdtempSync(join(tmpdir(), "sf-realdist-"));
    created.push(external);
    const outsider = join(external, "artifact.js");
    writeFileSync(outsider, "// external\n");
    linkSync(outsider, join(root, "dist/artifact.js"));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, "a hardlink under the real output directory was accepted");
    assert.match(
      output,
      /linked entries under dist/,
      `the output scan should be what objects, not the source scan:\n${output}`,
    );
  });

  /**
   * THE CONTROL THAT WAS WRONG, kept here as the record of why.
   *
   * This case used to assert the opposite — that a hardlink under
   * `src/vendor/node_modules` is ACCEPTED — on my reasoning that a nested
   * `node_modules` is a dependency install wherever it sits, so the name
   * identifies it. Round-16 review refuted that with a working exploit, and this
   * test had passed only because its hardlinked dependency was never USED: a
   * fixture satisfying an assertion for a reason unrelated to the claim, which
   * is the fourth shape and the ninth time it has been mine.
   *
   * The name never made the CONTENT safe. Same error as `src/dist` in round 15
   * and the skipped directory in round 11.
   */
  it("REFUSES a hardlink under a node_modules that is not the root install", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass before the link is planted");

    mkdirSync(join(root, "src/vendor/node_modules"), { recursive: true });
    const external = mkdtempSync(join(tmpdir(), "sf-nested-nm-"));
    created.push(external);
    const dep = join(external, "payload.cjs");
    writeFileSync(dep, "module.exports = 1;\n");
    linkSync(dep, join(root, "src/vendor/node_modules/payload.cjs"));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, `external code under a nested node_modules was accepted:\n${output}`);
    assert.match(output, /payload\.cjs/, "the refusal must name the file it refuses");
    assert.ok(!output.includes("tree-consistent"), "it must not also claim the tree is consistent");
  });

  /**
   * THE ROUND-16 CRITICAL, end to end: the payload is not merely present, it
   * RUNS.
   *
   * The reviewer hardlinked an external `.cjs` into `src/vendor/node_modules`,
   * loaded it through `createRequire` from a file a source test imports, and the
   * verifier exited 0 reporting `tree-consistent` while external code executed.
   * No concurrency, no PATH manipulation — the ordinary path.
   *
   * `linkedCompilerInputs` did not cover it because it keeps only
   * `.ts`/`.mts`/`.cts`, so a `.cjs` fell through exactly as the `.json` did.
   */
  it("REFUSES a hardlinked payload that a source test actually executes", () => {
    const root = makeFixtureRepo();

    mkdirSync(join(root, "src/vendor/node_modules"), { recursive: true });
    const external = mkdtempSync(join(tmpdir(), "sf-exec-"));
    created.push(external);
    const marker = join(external, "EXECUTED");
    const payload = join(external, "payload.cjs");
    writeFileSync(
      payload,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes");\nmodule.exports = 1;\n`,
    );
    linkSync(payload, join(root, "src/vendor/node_modules/payload.cjs"));

    writeFileSync(
      join(root, "src/loader.ts"),
      [
        'import { createRequire } from "node:module";',
        "const req = createRequire(import.meta.url);",
        'export const loaded = req("../../src/vendor/node_modules/payload.cjs") as number;',
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "tests/loads.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { describe, it } from "node:test";',
        'import { loaded } from "../src/loader.js";',
        'describe("loads", () => { it("loaded", () => { assert.equal(loaded, 1); }); });',
        "",
      ].join("\n"),
    );

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, `a hardlinked payload reached execution:\n${output}`);
    assert.match(output, /payload\.cjs/, "the refusal must name the payload");
    assert.ok(
      !existsSync(marker),
      "the payload EXECUTED — verification ran external code it had not audited",
    );
  });

  /**
   * THE CONTROL FOR OVER-APPLICATION IS NOT HERE, deliberately.
   *
   * A case was written here asserting that hardlinks inside the ROOT install are
   * still accepted, and it was DELETED for doing real damage:
   * `makeFixtureRepo` symlinks `node_modules` at the shared install, so
   * `mkdirSync(join(root, "node_modules/pkg/..."))` wrote THROUGH the symlink
   * into this repository's own `node_modules`. A fixture is supposed to be
   * disposable; that one modified the tree under review. It also passed on a
   * clean run and failed on the next, because the residue it left changed the
   * result — a test whose outcome depends on whether it has been run before.
   *
   * What it was trying to prove is already proved, without writing anywhere:
   * "passes with a symlinked node_modules when the root is the repository" and
   * "still passes with a linked node_modules under a whole-repository root"
   * both put `node_modules` genuinely in scope under a `.` root and require
   * acceptance. Excluding nothing fails them, which is the control this branch
   * needs. Two tests asserting one thing is coverage; three, one of which
   * pollutes a shared directory, is a liability.
   */
});

// ---------------------------------------------------------------------------
// ROUND-16 finding 1 — an equivalent spelling of outDir must not be refused
// ---------------------------------------------------------------------------

/**
 * `sameDirectory` accepts `dist`, `./dist`, an absolute path and a symlinked
 * alias as ONE outDir, because that is what tsc obeys. The source scan did not
 * agree: with a root of `.`, a `dist-alias -> dist` symlink was reported as a
 * symlinked entry under the source roots and the run was refused before
 * building. Two parts of the same program disagreeing about what the output
 * directory is.
 *
 * The reviewer also showed why the EXISTING alias case could not catch this: it
 * shims `--showConfig`, so only the EFFECTIVE configuration is aliased while the
 * real build still reads `outDir: "dist"` from the fixture's raw tsconfig. This
 * one writes a real tsconfig and makes a real symlink, so the build genuinely
 * emits through the alias.
 */
describe("TASK-010 round 16: an aliased outDir is the same directory", () => {
  it("ACCEPTS a real build whose outDir is a symlinked alias of the output", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass before it is aliased");

    /**
     * THE ROOT MUST BE `.`, or this case proves nothing.
     *
     * Written first with the fixture's own `src`/`tests` includes, it passed
     * WITHOUT the fix — a `dist-alias` at the repository root is not under
     * either root, so no scan ever looked at it. My own mutation run caught
     * that: deleting the resolved-alias check left this green. The reviewer's
     * reproduction used `include: ["**\/*.ts"]`, which makes the derived root
     * `.` and puts the alias in scope, and that is the only arrangement in
     * which the guard under test is reachable.
     */
    symlinkSync("dist", join(root, "dist-alias"));
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
      compilerOptions: Record<string, unknown>;
      include?: string[];
    };
    tsconfig.compilerOptions["outDir"] = "dist-alias";
    tsconfig.include = ["**/*.ts"];
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { status, output } = runHarness(root);
    assert.equal(status, 0, `an equivalent spelling of outDir was refused:\n${output}`);
    assert.match(output, /tree-consistent/, "and the aliased build must still be audited");
  });

  /**
   * An alias pointing OUTSIDE the repository stays refused.
   *
   * NOT the control against over-application, and saying so matters. I wrote it
   * as one — "this fails if `sameDirectory` becomes 'it is a symlink, skip
   * it'" — and mutation showed that claim is false: this case is refused by the
   * `sameDirectory(options.outDir, OUTPUT_DIR)` CONFIG check long before any
   * scan exclusion runs, so it passes under that mutation too. It still asserts
   * something worth asserting; it just does not assert what its comment said.
   *
   * The real control is the case below, and finding it took a second mutation
   * run. The obvious candidate — "REFUSES a symlinked individual test source" —
   * does NOT fail when every symlink is excluded, because a symlinked `.test.ts`
   * is a COMPILER INPUT and `linkedCompilerInputs` catches it independently of
   * the scan. It is masked, exactly like the guards in round 14.
   */
  it("still REFUSES an outDir alias that resolves outside the repository", () => {
    const root = makeFixtureRepo();
    const external = mkdtempSync(join(tmpdir(), "sf-outalias-"));
    created.push(external);

    symlinkSync(external, join(root, "dist-alias"));
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
      compilerOptions: Record<string, unknown>;
      include?: string[];
    };
    tsconfig.compilerOptions["outDir"] = "dist-alias";
    tsconfig.include = ["**/*.ts"];
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, `an outDir resolving outside the repository was accepted:\n${output}`);
  });

  /**
   * THE CONTROL AGAINST OVER-APPLYING THE ALIAS RESOLUTION, and the only case
   * that can detect it.
   *
   * A symlinked NON-COMPILER-INPUT under a source root is reported by
   * `findSymlinks` and by nothing else: `linkedCompilerInputs` keeps only
   * `.ts`/`.mts`/`.cts`, so a `.json` reaches the scan or reaches nothing. If
   * the resolved-alias check ever becomes "it is a symlink, skip it", this is
   * what fails — every other symlink case in this file is covered twice and
   * stays green.
   *
   * It also closes a coverage gap that predates this branch: nothing proved
   * `findSymlinks`' reach beyond compiler inputs was load-bearing.
   */
  it("REFUSES a symlinked non-source file under a source root", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass before the link is planted");

    const external = mkdtempSync(join(tmpdir(), "sf-symjson-"));
    created.push(external);
    const outsider = join(external, "data.json");
    writeFileSync(outsider, '{"external":true}\n');
    symlinkSync(outsider, join(root, "src/data.json"));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, `a symlinked non-source file was accepted:\n${output}`);
    assert.match(output, /src\/data\.json/, "the refusal must name the link it refuses");
  });
});

// ---------------------------------------------------------------------------
// ROUND-17 CRITICAL — the root node_modules and .git were execution bypasses
// ---------------------------------------------------------------------------

/**
 * Round 16 moved the exclusions from NAME to IDENTITY and I argued the
 * repository-root `node_modules` and `.git` had to stay excluded, because npm's
 * cache and pnpm's store hardlink package files and scanning would refuse
 * ordinary repositories.
 *
 * The reviewer hardlinked an external `.cjs` under each of them, required it
 * from a source test, and both RAN while the verifier exited 0 reporting
 * `tree-consistent`. The defence I offered had never been measured: this
 * repository has ZERO hardlinked files in `node_modules` and ZERO in `.git`, and
 * scanning both takes 12ms. The cost I traded a code-execution hole for was, in
 * the place it mattered, nothing.
 *
 * Only HARDLINKS are reported inside those two. A symlinked `node_modules` is an
 * ordinary shared install — this fixture harness uses one — so the top-level
 * entry is followed rather than refused, and symlinks inside it are skipped.
 * What that leaves open is L-10.
 */
describe("TASK-010 round 17: hardlinks inside the repository's own node_modules and .git", () => {
  /**
   * A fixture with a REAL `node_modules`, not the shared symlink.
   *
   * Writing through the symlink is how an earlier test of mine modified this
   * repository's own `node_modules`. A test that plants something under
   * `node_modules` must own the directory it plants into.
   */
  function withRealNodeModules(root: string): void {
    const nm = join(root, "node_modules");
    rmSync(nm, { recursive: true, force: true });
    mkdirSync(nm, { recursive: true });
    /**
     * EVERY package, linked individually.
     *
     * Symlinking only `@types` left `undici-types` unresolvable — `@types/node`
     * depends on it — so the fixture failed to build and the precondition
     * failed before anything was planted. Linking each top-level entry gives an
     * ordinary install whose packages are symlinks (skipped by the hardlink
     * walk, exactly as a shared install relies on) inside a directory the
     * fixture owns, so a planted hardlink lands here and not in this
     * repository's own `node_modules`.
     */
    for (const entry of readdirSync(join(REPO_ROOT, "node_modules"))) {
      symlinkSync(join(REPO_ROOT, "node_modules", entry), join(nm, entry), "dir");
    }
  }

  it("REFUSES a hardlinked payload inside the root node_modules", () => {
    const root = makeFixtureRepo();
    withRealNodeModules(root);
    const before = runHarness(root);
    assert.equal(
      before.status,
      0,
      `a real (unlinked) node_modules must verify before anything is planted:\n${before.output}`,
    );

    const external = mkdtempSync(join(tmpdir(), "sf-rootnm-"));
    created.push(external);
    const payload = join(external, "payload.cjs");
    writeFileSync(payload, "module.exports = 1;\n");
    linkSync(payload, join(root, "node_modules/payload.cjs"));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, `a hardlink inside the root node_modules was accepted:\n${output}`);
    assert.match(output, /payload\.cjs/, "the refusal must name it");
    assert.ok(!output.includes("tree-consistent"), "and must not also claim consistency");
  });

  it("REFUSES a hardlinked payload inside .git", () => {
    const root = makeFixtureRepo();
    mkdirSync(join(root, ".git/objects"), { recursive: true });

    const external = mkdtempSync(join(tmpdir(), "sf-rootgit-"));
    created.push(external);
    const payload = join(external, "payload.cjs");
    writeFileSync(payload, "module.exports = 1;\n");
    linkSync(payload, join(root, ".git/objects/payload.cjs"));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, `a hardlink inside .git was accepted:\n${output}`);
    assert.match(output, /payload\.cjs/, "the refusal must name it");
  });

  /**
   * THE EXPLOIT, end to end: the payload is not merely present, it RUNS.
   *
   * This is the round-17 reproduction, and its marker assertion is the whole
   * point — an exit code says the tree was refused, the marker says no external
   * code executed on the way to that decision.
   */
  it("REFUSES a root-node_modules payload that a source test actually executes", () => {
    const root = makeFixtureRepo();
    withRealNodeModules(root);

    const external = mkdtempSync(join(tmpdir(), "sf-rootexec-"));
    created.push(external);
    const marker = join(external, "EXECUTED");
    const payload = join(external, "payload.cjs");
    writeFileSync(
      payload,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes");\nmodule.exports = 1;\n`,
    );
    linkSync(payload, join(root, "node_modules/payload.cjs"));

    writeFileSync(
      join(root, "src/loader.ts"),
      [
        'import { createRequire } from "node:module";',
        "const req = createRequire(import.meta.url);",
        'export const loaded = req("../../node_modules/payload.cjs") as number;',
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "tests/loads.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { describe, it } from "node:test";',
        'import { loaded } from "../src/loader.js";',
        'describe("loads", () => { it("loaded", () => { assert.equal(loaded, 1); }); });',
        "",
      ].join("\n"),
    );

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, `the payload reached execution:\n${output}`);
    assert.ok(
      !existsSync(marker),
      "the payload EXECUTED — verification ran code from outside the tree it audited",
    );
  });

  /**
   * THE CONTROL: an ordinary install must still verify.
   *
   * A shared `node_modules` reached through a symlink, with no hardlinks in it,
   * is the layout every fixture here uses and the one this repository has. If
   * this fails, the scan has been over-applied and every real tree is refused —
   * which is the outcome that gets a guard deleted rather than fixed.
   */
  /**
   * A REAL install whose packages are SYMLINKS — a shared store, a pnpm farm, a
   * hoisted monorepo — must verify.
   *
   * This exists because the code had an `isSymbolicLink()` branch expressing
   * exactly this intent and the branch was DEAD: `Dirent` reflects `lstat`, so
   * the later regular-file check already skipped symlinks, and deleting the
   * branch failed nothing. Removing it and leaving the intent untested would
   * have traded an unreachable guard for no guard at all; this is the guard.
   *
   * It fails if the walk is ever made to report symlinked entries.
   */
  it("still accepts a real node_modules whose packages are symlinks", () => {
    const root = makeFixtureRepo();
    withRealNodeModules(root);

    const { status, output } = runHarness(root);
    assert.equal(status, 0, `an install of symlinked packages was refused:\n${output}`);
    assert.match(output, /tree-consistent/);
  });

  it("still accepts an ordinary symlinked node_modules with no hardlinks in it", () => {
    const root = makeFixtureRepo();
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
      include?: string[];
    };
    tsconfig.include = ["**/*.ts"];
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { status, output } = runHarness(root);
    assert.equal(status, 0, `an ordinary shared install was refused:\n${output}`);
    assert.match(output, /tree-consistent/);
  });
});

// ---------------------------------------------------------------------------
// ROUND-18 — a worktree is ordinary, a symlinked .git is not, and a mount over
// any compiler input is invisible to every other check
// ---------------------------------------------------------------------------

describe("TASK-010 round 18: .git may be a file, must not be a symlink", () => {
  /**
   * THE REGRESSION I INTRODUCED, and the one that mattered most in practice.
   *
   * In a `git worktree` — and in a submodule — `.git` is a FILE containing
   * `gitdir: ...`. The round-17 walker called `readdirSync` on it, recorded it
   * as an unreadable directory, and refused before building.
   *
   * THIS REPOSITORY HAS THREE WORKTREES, and the independent reviews of the
   * supervisor branch ran inside one of them. A guard added to protect
   * verification would have refused the trees the pipeline actually verifies —
   * the precise shape of a guard that gets disabled rather than obeyed.
   */
  it("ACCEPTS a checkout whose .git is a gitfile, as a worktree's is", () => {
    const root = makeFixtureRepo();
    writeFileSync(join(root, ".git"), "gitdir: /somewhere/else/.git/worktrees/wt\n");

    const { status, output } = runHarness(root);
    assert.equal(status, 0, `a worktree-style gitfile was refused:\n${output}`);
    assert.match(output, /tree-consistent/);
  });

  /**
   * L-10 covers `node_modules` and explicitly does NOT cover this.
   *
   * That entry's argument is that `node_modules` holds third-party code which
   * executes by design and whose store legitimately lives outside the
   * repository. `.git` has neither property: nothing imports from it, and it has
   * no reason to be a symlink. The reviewer pointed a `.git` symlink at an
   * external directory and a source test importing `.git/payload.cjs` executed
   * it while the run reported `tree-consistent`.
   */
  it("REFUSES a symlinked .git", () => {
    const root = makeFixtureRepo();
    const external = mkdtempSync(join(tmpdir(), "sf-gitlink-"));
    created.push(external);
    writeFileSync(join(external, "payload.cjs"), "module.exports = 1;\n");
    symlinkSync(external, join(root, ".git"), "dir");

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, `a symlinked .git was accepted:\n${output}`);
    assert.match(output, /\.git is a symlink/, "the refusal must say what it refused and why");
  });

  /** The same, proved by execution rather than by exit code. */
  it("REFUSES a symlinked .git whose payload a source test would execute", () => {
    const root = makeFixtureRepo();
    const external = mkdtempSync(join(tmpdir(), "sf-gitexec-"));
    created.push(external);
    const marker = join(external, "EXECUTED");
    writeFileSync(
      join(external, "payload.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes");\nmodule.exports = 1;\n`,
    );
    symlinkSync(external, join(root, ".git"), "dir");

    writeFileSync(
      join(root, "src/loader.ts"),
      [
        'import { createRequire } from "node:module";',
        "const req = createRequire(import.meta.url);",
        'export const loaded = req("../../.git/payload.cjs") as number;',
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "tests/loads.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { describe, it } from "node:test";',
        'import { loaded } from "../src/loader.js";',
        'describe("loads", () => { it("loaded", () => { assert.equal(loaded, 1); }); });',
        "",
      ].join("\n"),
    );

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, `the .git payload reached execution:\n${output}`);
    assert.ok(!existsSync(marker), "the payload EXECUTED from a symlinked .git");
  });

  /** An ordinary `.git` DIRECTORY with nothing planted must still verify. */
  it("still accepts an ordinary .git directory", () => {
    const root = makeFixtureRepo();
    mkdirSync(join(root, ".git/objects"), { recursive: true });
    writeFileSync(join(root, ".git/HEAD"), "ref: refs/heads/main\n");

    const { status, output } = runHarness(root);
    assert.equal(status, 0, `an ordinary .git directory was refused:\n${output}`);
  });
});

describe("TASK-010 round 18: a mount over any compiler input, not just a root", () => {
  /**
   * THE ROUND-8 LESSON, IN THE MOUNT DIMENSION.
   *
   * Round 8 found the source SCAN hard-coded to two roots while tsc compiled
   * from elsewhere, and the roots were derived from the config to fix it. The
   * MOUNT check kept the narrower list and inherited the same gap: it asked only
   * about `dist` and the derived roots.
   *
   * The reviewer bind-mounted an external directory over an ordinary `helpers/`
   * directory that no root covers, imported `helpers/helper.ts` from a source
   * file, and the run COMPILED AND EXECUTED it and exited 0. A bind mount defeats
   * every other check by construction — it IS the path it is mounted at, so
   * `isSymlink` says no, link counts say no, and `realpath` resolves inside the
   * repository.
   */
  it("REFUSES a bind mount over an imported directory outside every derived root", (t) => {
    const namespaces = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "true"], {
      encoding: "utf8",
    });
    if (namespaces.status !== 0) {
      t.skip("unprivileged user namespaces unavailable; bind-mount wiring not proven here");
      return;
    }

    const root = makeFixtureRepo();
    mkdirSync(join(root, "helpers"), { recursive: true });
    writeFileSync(join(root, "helpers/helper.ts"), "export const helper = 1;\n");
    writeFileSync(
      join(root, "tests/uses.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { describe, it } from "node:test";',
        'import { helper } from "../helpers/helper.js";',
        'describe("uses", () => { it("works", () => { assert.equal(helper, 1); }); });',
        "",
      ].join("\n"),
    );
    assert.equal(runHarness(root).status, 0, "the fixture must pass before anything is mounted");

    const external = mkdtempSync(join(tmpdir(), "sf-mounthelpers-"));
    created.push(external);
    writeFileSync(join(external, "helper.ts"), "export const helper = 1;\n");

    const script = [
      "set -e",
      `mount --bind ${JSON.stringify(external)} ${JSON.stringify(join(root, "helpers"))}`,
      `grep -qF ${JSON.stringify(join(root, "helpers"))} /proc/self/mountinfo || { echo "BIND-DID-NOT-TAKE"; exit 97; }`,
      `cd ${JSON.stringify(root)} && node scripts/verify.mjs; echo "HARNESS-EXIT=$?"`,
    ].join("\n");
    const result = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "sh", "-c", script], {
      encoding: "utf8",
      env: harnessEnv({ PATH: process.env["PATH"] ?? "" }),
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    assert.ok(!output.includes("BIND-DID-NOT-TAKE"), `the bind mount never took effect:\n${output}`);
    assert.ok(
      !output.includes("HARNESS-EXIT=0"),
      `a bind-mounted compiler-input directory was accepted:\n${output}`,
    );
    assert.match(output, /is or contains a mount point/, "the refusal must name the mount");
  });

  /**
   * NEGATIVE CONTROL, preserving round 6: bind-mounting the WHOLE repository
   * onto its own path is an ordinary layout. Everything below moves together and
   * stays consistent, so an ancestor mount splices nothing in. If this starts
   * failing, the ancestor exception has been lost and ordinary workspaces are
   * refused.
   */
  it("still ACCEPTS a repository that is itself a bind mount, with inputs below it", (t) => {
    const namespaces = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "true"], {
      encoding: "utf8",
    });
    if (namespaces.status !== 0) {
      t.skip("unprivileged user namespaces unavailable; ancestor-mount exception not proven here");
      return;
    }

    const root = makeFixtureRepo();
    mkdirSync(join(root, "helpers"), { recursive: true });
    writeFileSync(join(root, "helpers/helper.ts"), "export const helper = 1;\n");
    writeFileSync(
      join(root, "tests/uses.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { describe, it } from "node:test";',
        'import { helper } from "../helpers/helper.js";',
        'describe("uses", () => { it("works", () => { assert.equal(helper, 1); }); });',
        "",
      ].join("\n"),
    );

    const script = [
      "set -e",
      `mount --bind ${JSON.stringify(root)} ${JSON.stringify(root)}`,
      `grep -qF ${JSON.stringify(root)} /proc/self/mountinfo || { echo "BIND-DID-NOT-TAKE"; exit 97; }`,
      `cd ${JSON.stringify(root)} && node scripts/verify.mjs; echo "HARNESS-EXIT=$?"`,
    ].join("\n");
    const result = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "sh", "-c", script], {
      encoding: "utf8",
      env: harnessEnv({ PATH: process.env["PATH"] ?? "" }),
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    assert.ok(!output.includes("BIND-DID-NOT-TAKE"), `the bind mount never took effect:\n${output}`);
    assert.match(output, /HARNESS-EXIT=0/, `an ancestor mount was refused:\n${output}`);
  });
});
