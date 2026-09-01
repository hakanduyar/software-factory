/**
 * TASK-017: the clean-room workflow is asserted by PARSING THE FILE IT SHIPS.
 *
 * Every case here reads `.github/workflows/verify.yml` from disk. That is the
 * point: a test against a string literal in this file would prove that the
 * literal satisfies the criteria, which is a fact about the test. AC-12 also
 * forbids depending on a real Actions run, so the file is the only evidence
 * available before integration — and it is genuine evidence, because it is the
 * same bytes GitHub will read.
 *
 * Each policy gets a POSITIVE case against the shipped file and a NEGATIVE case
 * against a synthetic workflow that violates it. Without the negative half, a
 * check that always returned `ok` would pass every positive case.
 *
 * Offline: reads two files, spawns nothing, touches no network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  FREE_RUNNER_LABELS,
  checkActionPins,
  checkInstall,
  checkNodePin,
  checkPermissions,
  checkRunners,
  checkTriggers,
  checkVerificationCommand,
  get,
  parseWorkflow,
  runCommands,
  steps,
  type YamlMap,
} from "../src/verification/workflowPolicy.js";

/**
 * `process.cwd()`, matching what every other test here does — the compiled test
 * lives in `dist/tests/`, so resolving relative to the module would climb to
 * `dist/` and look for a workflow directory that does not exist there. The
 * suite runs from the repository root, which is the thing being described.
 */
const REPO_ROOT = process.cwd();
const WORKFLOW_PATH = join(REPO_ROOT, ".github/workflows/verify.yml");

const SOURCE = readFileSync(WORKFLOW_PATH, "utf8");
const PACKAGE = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  readonly engines?: { readonly node?: string };
};

function shipped(): YamlMap {
  const parsed = parseWorkflow(SOURCE);
  assert.equal(parsed.ok, true, `the shipped workflow does not parse: ${parsed.ok ? "" : parsed.reason}`);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.root;
}

/** A synthetic workflow, so a negative case can violate exactly one rule. */
function workflow(overrides: {
  readonly runsOn?: string;
  readonly uses?: readonly string[];
  readonly on?: readonly string[];
  readonly permissions?: string | undefined;
  readonly runs?: readonly string[];
  readonly nodeVersion?: string | undefined;
} = {}): YamlMap {
  const on = overrides.on ?? ["pull_request", "push"];
  const uses = overrides.uses ?? ["actions/checkout@" + "a".repeat(40)];
  const runs = overrides.runs ?? ["npm ci", "npm test"];
  const lines: string[] = ["name: synthetic", "on:"];
  for (const event of on) {
    lines.push(`  ${event}:`, "    branches:", '      - "**"');
  }
  if (overrides.permissions !== undefined) {
    lines.push("permissions:", `  ${overrides.permissions}`);
  }
  lines.push("jobs:", "  verify:", `    runs-on: ${overrides.runsOn ?? "ubuntu-latest"}`, "    steps:");
  for (const use of uses) {
    lines.push(`      - uses: ${use}`);
    if (use.includes("setup-node") && overrides.nodeVersion !== undefined) {
      lines.push("        with:", `          node-version: "${overrides.nodeVersion}"`);
    }
  }
  for (const run of runs) {
    lines.push(`      - run: ${run}`);
  }
  const parsed = parseWorkflow(lines.join("\n") + "\n");
  assert.equal(parsed.ok, true, `the synthetic workflow does not parse: ${parsed.ok ? "" : parsed.reason}`);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.root;
}

describe("TASK-017: the reader refuses what it does not implement", () => {
  /**
   * THE PARSER'S HONESTY IS THE FOUNDATION. Every policy below is a claim about
   * structure, so a parser that guessed at an unimplemented construct would
   * make every one of those claims a guess too. These cases pin the refusals.
   */
  for (const [label, source] of [
    ["a tab", "name: x\n\tfoo: 1\n"],
    ["a document marker", "---\nname: x\n"],
    ["an anchor", "name: x\nbase: &anchor 1\n"],
    ["an alias", "name: x\nother: *anchor\n"],
    ["a block scalar", "name: x\nscript: |\n  line\n"],
    ["a flow mapping", "name: x\nwith: { a: 1 }\n"],
    ["a flow sequence", 'name: x\nbranches: ["**"]\n'],
    ["odd indentation", "name: x\njobs:\n   verify: 1\n"],
  ] as const) {
    it(`refuses ${label} rather than approximating it`, () => {
      const parsed = parseWorkflow(source);

      assert.equal(parsed.ok, false, `${label} was parsed instead of refused`);
    });
  }

  it("parses the shipped workflow, so the refusals above are not refusing everything", () => {
    const parsed = parseWorkflow(SOURCE);

    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
  });

  /** Structure, not text: the shipped file really does yield jobs and steps. */
  it("reads the shipped workflow's structure", () => {
    const root = shipped();

    assert.equal(get(root, "name"), "verify");
    assert.ok(steps(root).length >= 4, `expected the shipped steps, got ${steps(root).length}`);
    assert.deepEqual(runCommands(root), ["npm ci", "npm test"]);
  });

  /**
   * A `#` inside a quoted scalar is not a comment, and QUOTE TRACKING is what
   * makes that true — not the "preceded by a space" rule, which this very
   * value satisfies. Worth stating: a mutation removing the space rule leaves
   * this passing, because the quote state had already skipped the character.
   */
  it("does not truncate a value at a hash inside quotes", () => {
    const parsed = parseWorkflow('name: "a # b"\n');

    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(get(parsed.root, "name"), "a # b");
  });

  /** And a bare `#` with no leading space is part of the value, not a comment. */
  it("does not truncate a value at a hash with no space before it", () => {
    const parsed = parseWorkflow("name: a#b\n");

    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(get(parsed.root, "name"), "a#b");
  });
});

describe("TASK-017 AC-1: only runners this repository knows to be unmetered", () => {
  it("accepts the shipped workflow's runner", () => {
    assert.equal(checkRunners(shipped()).ok, true);
  });

  /**
   * Larger runners are metered even on public repositories, which is what would
   * take this out of the included allowance.
   */
  for (const label of ["ubuntu-latest-8-cores", "ubuntu-latest-64-core", "macos-14", "windows-latest"]) {
    it(`refuses ${label}`, () => {
      const verdict = checkRunners(workflow({ runsOn: label }));

      assert.equal(verdict.ok, false, `${label} was accepted as unmetered`);
      assert.match(verdict.ok === false ? verdict.reason : "", /unmetered/);
    });
  }

  /** An allowlist, so a label nobody anticipated is refused rather than assumed. */
  it("refuses a runner label nobody has heard of", () => {
    assert.equal(checkRunners(workflow({ runsOn: "some-future-runner" })).ok, false);
  });

  it("keeps the allowlist to labels that are actually free", () => {
    for (const label of FREE_RUNNER_LABELS) {
      assert.match(label, /^ubuntu-/, `${label} is on the free allowlist but is not a standard Linux runner`);
    }
  });
});

describe("TASK-017 AC-6: every action is pinned to an immutable commit", () => {
  it("accepts the shipped workflow's pins", () => {
    assert.equal(checkActionPins(shipped()).ok, true);
  });

  /** And the shipped file really does use actions, so the check has work to do. */
  it("has actions to check in the shipped workflow", () => {
    const uses = steps(shipped())
      .map((step) => get(step, "uses"))
      .filter((value): value is string => typeof value === "string");

    assert.ok(uses.length >= 2, `expected pinned actions, found ${uses.length}`);
    for (const value of uses) {
      assert.match(value, /@[0-9a-f]{40}$/, `${value} is not commit-pinned`);
    }
  });

  for (const [label, pin] of [
    ["a major tag", "actions/checkout@v4"],
    ["a branch", "actions/checkout@main"],
    ["an abbreviated sha", "actions/checkout@3d3c42e"],
    ["an uppercase sha", `actions/checkout@${"A".repeat(40)}`],
    ["no ref at all", "actions/checkout"],
  ] as const) {
    it(`refuses ${label}`, () => {
      const verdict = checkActionPins(workflow({ uses: [pin] }));

      assert.equal(verdict.ok, false, `${pin} was accepted as commit-pinned`);
    });
  }
});

describe("TASK-017 AC-5: the workflow fires on the events a human's pull request raises", () => {
  it("accepts the shipped workflow's triggers", () => {
    assert.equal(checkTriggers(shipped()).ok, true);
  });

  it("refuses a workflow that never sees a pull request", () => {
    const verdict = checkTriggers(workflow({ on: ["push"] }));

    assert.equal(verdict.ok, false, "a workflow blind to pull requests was accepted");
    assert.match(verdict.ok === false ? verdict.reason : "", /pull_request/);
  });

  it("refuses a workflow that never sees a push", () => {
    assert.equal(checkTriggers(workflow({ on: ["pull_request"] })).ok, false);
  });
});

describe("TASK-017 AC-7: no secret, and no permission beyond reading contents", () => {
  it("accepts the shipped workflow's permissions", () => {
    assert.equal(checkPermissions(shipped(), SOURCE).ok, true);
  });

  it("refuses a workflow that references a secret", () => {
    const verdict = checkPermissions(workflow(), "run: echo ${{ secrets.GITHUB_TOKEN }}");

    assert.equal(verdict.ok, false, "a secret reference was accepted");
    assert.match(verdict.ok === false ? verdict.reason : "", /secret/);
  });

  it("refuses a workflow with no permissions block at all", () => {
    const verdict = checkPermissions(workflow({ permissions: undefined }), "clean");

    assert.equal(verdict.ok, false, "an inherited-permissions workflow was accepted");
    assert.match(verdict.ok === false ? verdict.reason : "", /no permissions block/);
  });

  it("refuses write access to contents", () => {
    assert.equal(checkPermissions(workflow({ permissions: "contents: write" }), "clean").ok, false);
  });

  it("refuses a scope beyond contents", () => {
    assert.equal(checkPermissions(workflow({ permissions: "packages: read" }), "clean").ok, false);
  });

  /** The shipped file must genuinely contain the block, not merely parse. */
  it("declares the permissions block in the shipped file", () => {
    assert.match(SOURCE, /^permissions:\n {2}contents: read$/m);
  });
});

describe("TASK-017 AC-3: dependencies come from the lockfile", () => {
  it("accepts the shipped workflow's install", () => {
    assert.equal(checkInstall(shipped()).ok, true);
  });

  /**
   * `npm ci` IS PRESENT, so only the `npm install` refusal can decide this.
   *
   * The first version omitted `npm ci`, which let the "never installs" guard
   * refuse instead — and the case then passed with the `npm install` guard
   * deleted. My own mutation harness caught that; a negative case must leave
   * exactly one guard able to fire.
   */
  it("refuses npm install even alongside npm ci, because it may resolve differently", () => {
    const verdict = checkInstall(workflow({ runs: ["npm ci", "npm install", "npm test"] }));

    assert.equal(verdict.ok, false, "npm install was accepted");
    assert.match(verdict.ok === false ? verdict.reason : "", /lockfile/);
  });

  it("refuses a workflow that installs nothing", () => {
    assert.equal(checkInstall(workflow({ runs: ["npm test"] })).ok, false);
  });
});

describe("TASK-017 AC-4: CI runs this repository's own verification", () => {
  it("accepts the shipped workflow's verification command", () => {
    assert.equal(checkVerificationCommand(shipped()).ok, true);
  });

  /**
   * A second definition of "verified" is the defect this prevents, so invoking
   * the underlying tools directly is refused even though it would run — because
   * it would run while meaning something else.
   */
  for (const command of ["node --test dist/tests/*.js", "tsc -p tsconfig.json", "node scripts/verify.mjs"]) {
    /**
     * `npm test` IS PRESENT, so only the direct-invocation refusal can decide.
     * Omitting it let the "never runs npm test" guard refuse instead, and the
     * case survived deleting the guard it was named for.
     */
    it(`refuses ${JSON.stringify(command)} as a second definition of verified`, () => {
      const verdict = checkVerificationCommand(workflow({ runs: ["npm ci", "npm test", command] }));

      assert.equal(verdict.ok, false, `${command} was accepted as verification`);
      assert.match(verdict.ok === false ? verdict.reason : "", /second definition/);
    });
  }

  it("refuses a workflow that never runs npm test", () => {
    assert.equal(checkVerificationCommand(workflow({ runs: ["npm ci"] })).ok, false);
  });
});

describe("TASK-017 AC-2: the Node version is a decision bound to engines", () => {
  it("accepts the shipped pin against the real engines range", () => {
    const verdict = checkNodePin(shipped(), PACKAGE.engines?.node);

    assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);
  });

  /** The premise: package.json really does declare a range to check against. */
  it("finds an engines.node range in package.json", () => {
    assert.match(PACKAGE.engines?.node ?? "", /^>=\s*\d+\.\d+\.\d+$/);
  });

  it("refuses a pin below the engines floor", () => {
    const pinned = workflow({
      uses: [`actions/setup-node@${"b".repeat(40)}`],
      nodeVersion: "20.0.0",
    });

    const verdict = checkNodePin(pinned, ">=22.5.0");

    assert.equal(verdict.ok, false, "a Node version below the engines floor was accepted");
    assert.match(verdict.ok === false ? verdict.reason : "", /22\.5\.0/);
  });

  it("accepts a pin above the engines floor", () => {
    const pinned = workflow({
      uses: [`actions/setup-node@${"b".repeat(40)}`],
      nodeVersion: "24.1.0",
    });

    assert.equal(checkNodePin(pinned, ">=22.5.0").ok, true);
  });

  it("refuses a workflow that pins no Node version at all", () => {
    const verdict = checkNodePin(workflow(), ">=22.5.0");

    assert.equal(verdict.ok, false, "an unpinned Node version was accepted");
    assert.match(verdict.ok === false ? verdict.reason : "", /pins no Node version/);
  });

  it("refuses an inexact pin, which is a range rather than a decision", () => {
    const pinned = workflow({
      uses: [`actions/setup-node@${"b".repeat(40)}`],
      nodeVersion: "22",
    });

    assert.equal(checkNodePin(pinned, ">=22.5.0").ok, false);
  });

  /** An engines form this check does not implement refuses rather than guesses. */
  it("refuses an engines range it does not implement", () => {
    const pinned = workflow({
      uses: [`actions/setup-node@${"b".repeat(40)}`],
      nodeVersion: "22.5.0",
    });

    assert.equal(checkNodePin(pinned, "^22.5.0").ok, false);
  });
});
