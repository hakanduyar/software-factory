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
      answer,
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
  it("FAILS CLOSED when a source/artifact disagreement survives a clean rebuild", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass first");

    writeFileSync(
      join(root, "tests/excluded.test.ts"),
      'import { describe, it } from "node:test";\ndescribe("excluded", () => { it("never compiles", () => {}); });\n',
    );
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
      exclude?: string[];
    };
    tsconfig.exclude = ["tests/excluded.test.ts"];
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { status, output } = runHarness(root);
    assert.notEqual(status, 0, `a real disagreement must fail:\n${output}`);
    assert.match(output, /excluded\.test/, "the missing artifact must be named");
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
    chmodSync(root, 0o555);
    let result: { status: number; output: string };
    try {
      result = runHarness(root);
    } finally {
      chmodSync(root, 0o755);
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
      /refused before building: the build output directory is or contains a mount point/,
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
  it("ACCEPTS an outDir inherited through extends", () => {
    const root = makeFixtureRepo();
    writeFileSync(
      join(root, "tsconfig.base.json"),
      JSON.stringify({ compilerOptions: { outDir: "dist" } }, null, 2),
    );
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as Record<
      string,
      unknown
    >;
    (tsconfig["compilerOptions"] as Record<string, unknown>)["outDir"] = "dist";
    tsconfig["extends"] = "./tsconfig.base.json";
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { status, output } = runHarness(root);
    assert.equal(status, 0, `an inherited outDir was wrongly refused:\n${output.slice(0, 500)}`);
  });
});
