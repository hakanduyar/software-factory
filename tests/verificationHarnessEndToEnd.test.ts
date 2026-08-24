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
  cpSync,
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

function runHarness(root: string): { status: number; output: string } {
  const result = spawnSync(process.execPath, ["scripts/verify.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: process.env["PATH"] ?? "" },
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
    env: { ...process.env, PATH: `${shimDir}:${process.env["PATH"] ?? ""}` },
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
   * AC-2, and review finding B1. The first implementation cleaned the orphan and
   * exited 0 — contradicting this task's own frozen criterion. Silently
   * repairing the condition you exist to detect teaches everyone it is normal.
   */
  it("FAILS and names the orphan when a foreign artifact is present", () => {
    const root = makeFixtureRepo();
    assert.equal(runHarness(root).status, 0, "the fixture must pass before contamination");

    writeFileSync(join(root, "dist/tests/ghostFromAnotherBranch.test.js"), "// stale\n");
    const { status, output } = runHarness(root);

    assert.notEqual(status, 0, "a contaminated tree must not report success");
    assert.match(output, /ghostFromAnotherBranch\.test\.js/, "the orphan must be named");
    assert.match(output, /Re-run to verify a clean tree/);

    // And the next run is honest, because the stale output was removed.
    assert.equal(runHarness(root).status, 0, "the follow-up run should be clean");
  });

  it("detects an orphan OUTSIDE dist/tests and with a non-.js extension", () => {
    for (const relative of ["dist/ghost.test.js", "dist/nested/ghost.test.js", "dist/tests/ghost.test.mjs"]) {
      const root = makeFixtureRepo();
      assert.equal(runHarness(root).status, 0);
      mkdirSync(join(root, relative, ".."), { recursive: true });
      writeFileSync(join(root, relative), "// stale\n");

      const { status, output } = runHarness(root);
      assert.notEqual(status, 0, `${relative} was not detected`);
      assert.match(output, /ghost\.test\./);
    }
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
    assert.match(output, /symlinked entries under tests/);
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
