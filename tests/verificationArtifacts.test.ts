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
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  assessCleanTarget,
  assessOutputDirectory,
  assessTreeSafety,
  auditTestArtifacts,
  compiledPathForSourceTest,
  describeContamination,
  assessMountTopology,
  parseMountInfo,
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

describe("TASK-010 round 2: every tree-safety clause, judged directly", () => {
  const SAFE = {
    testsRootIsSymlink: false,
    outputIsSymlink: false,
    outputOnDifferentDevice: false,
    symlinkedArtifacts: [] as readonly string[],
    symlinkedSources: [] as readonly string[],
    buildEmitsNothing: false,
    checkerFreshlyEmitted: true,
  };

  it("accepts an ordinary tree", () => {
    assert.equal(assessTreeSafety(SAFE).safe, true);
  });

  /**
   * Each clause is asserted HERE as well as through the end-to-end harness,
   * because mutation testing showed the two layers masking each other: removing
   * the script's pre-build check left the tested judgement to catch it, and
   * removing the tested judgement left the pre-build check — so neither was
   * individually load-bearing and the mutation run reported "0 failures" for
   * four real guards.
   *
   * Two layers is still the right design: one must run BEFORE the build to
   * avoid writing through a hostile path, the other is the reviewable rule. But
   * each needs its own test, or "it is covered" quietly comes to mean "something
   * covers it, I think".
   */
  const clauses: readonly [string, Partial<typeof SAFE>, RegExp][] = [
    ["a symlinked tests root", { testsRootIsSymlink: true }, /tests directory is a symlink/],
    ["a symlinked output directory", { outputIsSymlink: true }, /output directory is a symlink/],
    ["output on another device", { outputOnDifferentDevice: true }, /different device/],
    ["a noEmit build", { buildEmitsNothing: true }, /noEmit/],
    ["a stale auditor", { checkerFreshlyEmitted: false }, /stale copy of the auditor/],
    ["symlinked sources", { symlinkedSources: ["tests/linked.test.ts"] }, /symlinked or hardlinked entries under the source roots/],
    ["symlinked artifacts", { symlinkedArtifacts: ["dist/tests/g.test.js"] }, /symlinked test artifacts/],
  ];

  for (const [label, override, expected] of clauses) {
    it(`refuses ${label}`, () => {
      const verdict = assessTreeSafety({ ...SAFE, ...override });
      assert.equal(verdict.safe, false, `${label} was accepted`);
      if (!verdict.safe) {
        assert.match(verdict.reason, expected);
      }
    });
  }

  it("names the offending paths so an operator can act on them", () => {
    const verdict = assessTreeSafety({ ...SAFE, symlinkedArtifacts: ["dist/tests/ghost.test.js"] });
    assert.equal(verdict.safe, false);
    if (!verdict.safe) {
      assert.match(verdict.reason, /ghost\.test\.js/);
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

  /**
   * Round 3 demonstrated two escapes that are NOT closed: swapping `tests/`
   * between the check and the build, and shadowing `npx` so nothing compiled.
   * Both need an adversary with concurrent write access to the tree or control
   * of PATH — who can equally edit `src/` or replace `node`, which is why no
   * verifier running inside the tree it audits can defend against them.
   *
   * The limit is therefore STATED rather than fixed. This test exists so the
   * statement cannot quietly disappear in a later edit, leaving a verifier that
   * silently implies more assurance than it has.
   */
  it("states the threat-model boundary it does NOT cover", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile("scripts/verify.mjs", "utf8");
    assert.match(source, /DOES NOT DEFEND AGAINST/, "the boundary must be stated explicitly");
    assert.match(source, /concurrent write access/, "the adversary must be named");
    assert.match(source, /CLEAN_ROOM_CI/, "the item that would close it must be named");
  });
});

/**
 * TASK-010 round-11 finding B — the bind mount `st_dev` cannot see.
 *
 * The verifier claimed to defend against "a bind-mounted output directory that a
 * recursive delete would reach through", but implemented that claim as a device-
 * number comparison. A bind mount of a directory ALREADY ON THIS FILESYSTEM
 * shares the device number, so the guard never fired and `rmSync(recursive)`
 * would delete through it — outside the repository, which AC-5 forbids.
 *
 * The decision is tested here as a pure function over mount-table text, so it
 * needs no privileged mounting to be exercised deterministically. A real
 * bind-mount integration test would require root (`mount --bind`), which this
 * suite must never need; that environment-level gap is stated rather than faked.
 */
describe("TASK-010 round 11: mount topology, not device numbers", () => {
  const LINE = (mountPoint: string) =>
    `36 35 8:2 / ${mountPoint} rw,relatime shared:1 - ext4 /dev/sdb2 rw`;
  const BASE = [LINE("/"), LINE("/home"), LINE("/proc")].join("\n");

  it("parses the mount point out of field 5, past the variable optional fields", () => {
    const mounts = parseMountInfo(
      ["36 35 8:2 / /a rw shared:1 master:2 - ext4 /dev/sdb2 rw", "37 36 8:2 / /b rw - ext4 /dev/sdb2 rw"].join("\n"),
    );
    assert.deepEqual(
      mounts.map((m) => m.mountPoint),
      ["/a", "/b"],
    );
  });

  it("decodes octal escapes so a mount point containing a space still compares equal", () => {
    // A false NEGATIVE is the dangerous direction: truncating at the space would
    // make `/mnt/my dir` compare unequal to itself and silently pass.
    const mounts = parseMountInfo(LINE("/mnt/my\\040dir"));
    assert.deepEqual(mounts.map((m) => m.mountPoint), ["/mnt/my dir"]);
  });

  it("skips malformed rows without blinding the caller to the rest", () => {
    const mounts = parseMountInfo(["garbage", "", LINE("/real")].join("\n"));
    assert.deepEqual(mounts.map((m) => m.mountPoint), ["/real"]);
  });

  it("REFUSES when the output directory is itself a mount point (the same-device bind mount)", () => {
    const verdict = assessMountTopology({
      platform: "linux",
      mountInfo: [BASE, LINE("/repo/dist")].join("\n"),
      outputDirectory: "/repo/dist",
      realOutputDirectory: "/repo/dist",
    });
    assert.equal(verdict.safe, false);
    assert.match(verdict.safe === false ? verdict.reason : "", /itself a mount point/);
  });

  it("REFUSES when a filesystem is mounted INSIDE the output directory", () => {
    const verdict = assessMountTopology({
      platform: "linux",
      mountInfo: [BASE, LINE("/repo/dist/nested")].join("\n"),
      outputDirectory: "/repo/dist",
      realOutputDirectory: "/repo/dist",
    });
    assert.equal(verdict.safe, false);
    assert.match(verdict.safe === false ? verdict.reason : "", /mounted inside/);
  });

  it("judges the RESOLVED path, not the lexical one", () => {
    const verdict = assessMountTopology({
      platform: "linux",
      mountInfo: [BASE, LINE("/elsewhere/output")].join("\n"),
      outputDirectory: "/repo/dist",
      realOutputDirectory: "/elsewhere/output",
    });
    assert.equal(verdict.safe, false);
  });

  it("does not confuse a sibling whose name merely starts the same", () => {
    const verdict = assessMountTopology({
      platform: "linux",
      mountInfo: [BASE, LINE("/repo/dist-2")].join("\n"),
      outputDirectory: "/repo/dist",
      realOutputDirectory: "/repo/dist",
    });
    assert.equal(verdict.safe, true);
  });

  it("accepts an ordinary tree whose output is not a mount", () => {
    const verdict = assessMountTopology({
      platform: "linux",
      mountInfo: BASE,
      outputDirectory: "/repo/dist",
      realOutputDirectory: "/repo/dist",
    });
    assert.equal(verdict.safe, true);
  });

  it("FAILS CLOSED on Linux when the mount table cannot be read", () => {
    const verdict = assessMountTopology({
      platform: "linux",
      mountInfo: undefined,
      outputDirectory: "/repo/dist",
      realOutputDirectory: "/repo/dist",
    });
    assert.equal(verdict.safe, false);
    assert.match(verdict.safe === false ? verdict.reason : "", /could not be read/);
  });

  it("FAILS CLOSED on Linux when the mount table has no readable entries", () => {
    const verdict = assessMountTopology({
      platform: "linux",
      mountInfo: "garbage\nmore garbage\n",
      outputDirectory: "/repo/dist",
      realOutputDirectory: "/repo/dist",
    });
    assert.equal(verdict.safe, false);
    assert.match(verdict.safe === false ? verdict.reason : "", /no readable entries/);
  });

  /**
   * PINS THE PLATFORM BOUNDARY. The guarantee is Linux-only because
   * `/proc/self/mountinfo` is where it comes from. If someone later widens this
   * to claim cross-platform bind-mount safety, this test must be confronted
   * rather than quietly passing.
   */
  it("does NOT claim the bind-mount guarantee off Linux, and says so in the threat model", () => {
    const verdict = assessMountTopology({
      platform: "darwin",
      mountInfo: undefined,
      outputDirectory: "/repo/dist",
      realOutputDirectory: "/repo/dist",
    });
    assert.equal(verdict.safe, true, "off Linux this check must not fail closed on an unreadable Linux-only file");

    const header = readFileSync(new URL("../../scripts/verify.mjs", import.meta.url), "utf8");
    assert.match(header, /LINUX-ONLY/, "the threat model must state the platform boundary it actually implements");
  });
});

/**
 *  had NO unit tests: it was exercised only incidentally
 * through the end-to-end harness, which is how a string comparison came to
 * reject equivalent paths without anything noticing.
 *
 * Both directions are tested. A guard that refuses everything is not "safe by
 * default" — it is a guard the next person deletes because it blocks valid work.
 */
describe("assessOutputDirectory: one directory, however it is spelled", () => {
  const ROOT = "/repo";
  const base = {
    repositoryRoot: ROOT,
    realRepositoryRoot: ROOT,
    configuredOutputDirectory: "dist",
    outputDirectory: "/repo/dist",
    realOutputDirectory: "/repo/dist" as string | undefined,
    resolvedTsconfigOutDir: "/repo/dist",
  };

  it("trusts the managed directory", () => {
    assert.equal(assessOutputDirectory(base).trusted, true);
  });

  it("trusts a trailing-separator spelling of the same directory", () => {
    assert.equal(assessOutputDirectory({ ...base, resolvedTsconfigOutDir: "/repo/dist/" }).trusted, true);
  });

  it("trusts the managed directory when the output does not exist yet", () => {
    assert.equal(assessOutputDirectory({ ...base, realOutputDirectory: undefined }).trusted, true);
  });

  it("REFUSES a sibling the build would actually write to", () => {
    const verdict = assessOutputDirectory({ ...base, resolvedTsconfigOutDir: "/repo/dist-2" });
    assert.equal(verdict.trusted, false);
    if (!verdict.trusted) {
      assert.match(verdict.reason, /builds into "\/repo\/dist-2" but verification manages/);
    }
  });

  it("REFUSES an outDir outside the repository", () => {
    assert.equal(
      assessOutputDirectory({ ...base, resolvedTsconfigOutDir: "/elsewhere/dist" }).trusted,
      false,
    );
  });

  it("REFUSES a repository path that resolves elsewhere", () => {
    const verdict = assessOutputDirectory({ ...base, realRepositoryRoot: "/somewhere/else" });
    assert.equal(verdict.trusted, false);
    if (!verdict.trusted) {
      assert.match(verdict.reason, /resolves elsewhere/);
    }
  });

  it("REFUSES an output directory that resolves outside the repository", () => {
    const verdict = assessOutputDirectory({
      ...base,
      realOutputDirectory: "/tmp/decoy",
      resolvedTsconfigOutDir: "/tmp/decoy",
    });
    assert.equal(verdict.trusted, false);
    if (!verdict.trusted) {
      assert.match(verdict.reason, /outside the repository/);
    }
  });
  /**
   * Round-2 non-blocking note, closed anyway: an output path outside the
   * repository was trusted whenever the directory did not exist yet, because
   * containment was only checked when `realOutputDirectory` was defined.
   *
   * Today's only caller cannot produce that combination. That is a fact about
   * the caller, not about this function — and this function is the rule.
   */
  it("REFUSES an output path outside the repository even when it does not exist yet", () => {
    const verdict = assessOutputDirectory({
      ...base,
      outputDirectory: "/elsewhere/dist",
      realOutputDirectory: undefined,
      resolvedTsconfigOutDir: "/elsewhere/dist",
    });
    assert.equal(verdict.trusted, false, "a non-existent outside path must not be trusted");
    if (!verdict.trusted) assert.match(verdict.reason, /outside the repository/);
  });
});
