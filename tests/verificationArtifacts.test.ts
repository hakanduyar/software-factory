/**
 * TASK-010 — verification artifact integrity.
 *
 * The defect these pin was observed, not imagined: verifying an isolated branch
 * reported 1372 tests including one whose SOURCE was not in the tree, because
 * discovery globbed gitignored compiled output that git does not clean on
 * checkout. It failed, which is the only reason it surfaced. One that passed
 * would have inflated the count silently — and every ADR-0002 integration turns
 * on "deterministic verification passes".
 *
 * Offline and filesystem-free: these drive the pure checker with fixtures, so
 * they cannot themselves be contaminated by the tree they run in.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assessCleanTarget,
  auditTestArtifacts,
  compiledPathForSourceTest,
  describeContamination,
} from "../src/verification/testArtifacts.js";

const SOURCES = ["tests/alpha.test.ts", "tests/nested/beta.test.ts"];
const COMPILED = ["dist/tests/alpha.test.js", "dist/tests/nested/beta.test.js"];

describe("TASK-010 AC-1: discovery is derived from source", () => {
  it("maps a source test to its compiled artifact", () => {
    assert.equal(compiledPathForSourceTest("tests/alpha.test.ts"), "dist/tests/alpha.test.js");
    assert.equal(compiledPathForSourceTest("tests/nested/beta.test.ts"), "dist/tests/nested/beta.test.js");
    assert.equal(compiledPathForSourceTest("./tests/alpha.test.ts"), "dist/tests/alpha.test.js");
  });

  it("refuses anything that is not a source test path", () => {
    for (const bad of ["src/thing.ts", "tests/helper.ts", "dist/tests/alpha.test.js", "alpha.test.ts"]) {
      assert.throws(() => compiledPathForSourceTest(bad), /not a source test path/);
    }
  });

  it("expects exactly the artifacts the source declares", () => {
    const audit = auditTestArtifacts({ sourceTests: SOURCES, compiledTests: COMPILED });
    assert.deepEqual(audit.expected, [...COMPILED].sort());
    assert.equal(audit.clean, true);
  });
});

describe("TASK-010 AC-2: a foreign compiled test is an ERROR", () => {
  it("detects an orphan left by another branch", () => {
    // This is the real event: provenanceChain.test.js surviving a checkout onto
    // a branch whose source does not contain it.
    const audit = auditTestArtifacts({
      sourceTests: SOURCES,
      compiledTests: [...COMPILED, "dist/tests/provenanceChain.test.js"],
    });
    assert.equal(audit.clean, false);
    assert.deepEqual(audit.orphaned, ["dist/tests/provenanceChain.test.js"]);
    // And it is NOT in the run list — an orphan is never executed.
    assert.ok(!audit.expected.includes("dist/tests/provenanceChain.test.js"));
  });

  it("names the orphan in the failure message", () => {
    const audit = auditTestArtifacts({
      sourceTests: SOURCES,
      compiledTests: [...COMPILED, "dist/tests/ghost.test.js"],
    });
    const message = describeContamination(audit);
    assert.ok(message !== undefined);
    assert.match(message, /ghost\.test\.js/);
    assert.match(message, /another branch/);
  });

  it("says nothing when the tree is clean", () => {
    assert.equal(
      describeContamination(auditTestArtifacts({ sourceTests: SOURCES, compiledTests: COMPILED })),
      undefined,
    );
  });
});

describe("TASK-010 AC-3: a missing artifact is also an ERROR", () => {
  it("detects a source test that produced no output", () => {
    // The same lie from the other direction: a partial build runs fewer tests
    // and still reports success.
    const audit = auditTestArtifacts({
      sourceTests: SOURCES,
      compiledTests: ["dist/tests/alpha.test.js"],
    });
    assert.equal(audit.clean, false);
    assert.deepEqual(audit.missing, ["dist/tests/nested/beta.test.js"]);
    assert.match(describeContamination(audit) ?? "", /build is incomplete/);
  });

  it("reports orphans and missing together", () => {
    const audit = auditTestArtifacts({
      sourceTests: SOURCES,
      compiledTests: ["dist/tests/alpha.test.js", "dist/tests/ghost.test.js"],
    });
    assert.equal(audit.orphaned.length, 1);
    assert.equal(audit.missing.length, 1);
  });
});

describe("TASK-010 AC-5: the clean step cannot destroy anything that matters", () => {
  const root = "/home/user/repo";
  const ok = (target: string) =>
    assessCleanTarget({ repositoryRoot: root, target, configuredOutputDirectory: "dist" });

  it("permits exactly the configured output directory", () => {
    const verdict = ok(`${root}/dist`);
    assert.equal(verdict.safe, true);
  });

  it("refuses the repository root", () => {
    const verdict = ok(root);
    assert.equal(verdict.safe, false);
    if (!verdict.safe) assert.match(verdict.reason, /repository root/);
  });

  it("refuses anything outside the repository", () => {
    for (const outside of ["/", "/home/user", "/etc", "/home/user/other-repo/dist"]) {
      const verdict = ok(outside);
      assert.equal(verdict.safe, false, `${outside} must be refused`);
    }
  });

  it("refuses source, tests, docs, git and durable Factory state", () => {
    for (const protectedPath of ["src", "tests", "docs", ".git", ".factory", "node_modules"]) {
      const verdict = ok(`${root}/${protectedPath}`);
      assert.equal(verdict.safe, false, `${protectedPath} must be refused`);
    }
  });

  it("refuses path traversal and a relative target", () => {
    assert.equal(ok(`${root}/dist/../src`).safe, false);
    assert.equal(
      assessCleanTarget({ repositoryRoot: root, target: "dist", configuredOutputDirectory: "dist" }).safe,
      false,
      "a relative target must be refused; the answer must not depend on cwd",
    );
  });

  it("refuses a directory that merely looks like the output", () => {
    for (const lookalike of ["dist-backup", "distribution", "dist/tests"]) {
      assert.equal(ok(`${root}/${lookalike}`).safe, false, `${lookalike} must be refused`);
    }
  });
});

describe("TASK-010 AC-8: the invariant is stated where it will be found", () => {
  it("documents why the verification path exists", async () => {
    const fs = await import("node:fs/promises");
    for (const path of ["scripts/verify.mjs", "src/verification/testArtifacts.ts"]) {
      const source = await fs.readFile(path, "utf8");
      assert.match(
        source,
        /must reflect the tree it is run against/,
        `${path} must state the invariant it enforces`,
      );
    }
  });
});
