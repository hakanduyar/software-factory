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
function makeFixtureRepo(options: { readonly tsconfigOutDir?: string } = {}): string {
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
        include: ["src/**/*.ts", "tests/**/*.ts"],
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
