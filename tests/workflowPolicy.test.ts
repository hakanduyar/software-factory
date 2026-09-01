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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  FREE_RUNNER_LABELS,
  checkActionPins,
  checkCheckout,
  checkInstall,
  checkRunAllowlist,
  checkStepExecution,
  checkWorkflowShape,
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
  /** Applied to every `run` step, so a case can make them not execute. */
  readonly stepIf?: string;
  readonly continueOnError?: boolean;
  /** Raw lines appended under `on:`, for trigger-filter cases. */
  readonly onFilters?: Readonly<Record<string, readonly string[]>>;
  /** Which action carries the node-version, so the pin can be misplaced. */
  readonly nodeVersionOn?: string;
} = {}): YamlMap {
  const on = overrides.on ?? ["pull_request", "push"];
  const uses = overrides.uses ?? ["actions/checkout@" + "a".repeat(40)];
  const runs = overrides.runs ?? ["npm ci", "npm test"];
  const lines: string[] = ["name: synthetic", "on:"];
  for (const event of on) {
    lines.push(`  ${event}:`);
    const filters = overrides.onFilters?.[event];
    if (filters === undefined) {
      lines.push("    branches:", '      - "**"');
    } else {
      lines.push(...filters);
    }
  }
  if (overrides.permissions !== undefined) {
    lines.push("permissions:", `  ${overrides.permissions}`);
  }
  lines.push("jobs:", "  verify:", `    runs-on: ${overrides.runsOn ?? "ubuntu-latest"}`, "    steps:");
  const carrier = overrides.nodeVersionOn ?? "setup-node";
  for (const use of uses) {
    lines.push(`      - uses: ${use}`);
    if (use.includes(carrier) && overrides.nodeVersion !== undefined) {
      lines.push("        with:", `          node-version: "${overrides.nodeVersion}"`);
    }
  }
  for (const run of runs) {
    lines.push(`      - run: ${run}`);
    if (overrides.stepIf !== undefined) {
      lines.push(`        if: ${overrides.stepIf}`);
    }
    if (overrides.continueOnError === true) {
      lines.push("        continue-on-error: true");
    }
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

  /**
   * A `setup-node` THAT DOES NOT RUN PINS NOTHING.
   *
   * The shape allowlist refuses a step-level `if` before this is reached, so
   * this check is defence in depth — and it survived mutation until this case
   * existed, because nothing could tell it from its absence. Asserted directly
   * against `checkNodePin` so only that filter can decide it.
   */
  it("refuses a node-version on a setup-node a condition would skip", () => {
    const parsed = parseWorkflow(
      [
        "name: x",
        "on:",
        "  push:",
        "    branches:",
        '      - "**"',
        "jobs:",
        "  verify:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        `      - uses: actions/setup-node@${"b".repeat(40)}`,
        "        if: ${{ false }}",
        "        with:",
        '          node-version: "22.5.0"',
        "",
      ].join("\n"),
    );
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;

    const verdict = checkNodePin(parsed.root, ">=22.5.0");

    assert.equal(verdict.ok, false, "a skipped setup-node counted as a pin");
    assert.match(verdict.ok === false ? verdict.reason : "", /setup-node step pins a node-version/);
  });

  it("refuses a workflow that pins no Node version at all", () => {
    const verdict = checkNodePin(workflow(), ">=22.5.0");

    assert.equal(verdict.ok, false, "an unpinned Node version was accepted");
    assert.match(verdict.ok === false ? verdict.reason : "", /setup-node step pins a node-version/);
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

/**
 * TASK-017 round-1 review: a command that APPEARS is not a command that RUNS.
 *
 * The reviewer's CRITICAL, and it was exact. `run: npm test` under
 * `if: ${{ false }}` never executes; under `continue-on-error: true` it
 * executes, fails, and the job passes anyway; `echo npm test` merely contains
 * the words. All three satisfied the substring searches these checks used to
 * do, so the workflow could verify nothing while every policy said ok.
 */
describe("TASK-017 round-1 CRITICAL: the policies read execution, not text", () => {
  it("refuses an install step that a condition prevents from running", () => {
    const verdict = checkInstall(workflow({ stepIf: "${{ false }}" }));

    assert.equal(verdict.ok, false, "a skipped npm ci counted as an install");
    assert.match(verdict.ok === false ? verdict.reason : "", /unconditionally/);
  });

  it("refuses a verification step that a condition prevents from running", () => {
    const verdict = checkVerificationCommand(workflow({ stepIf: "${{ false }}" }));

    assert.equal(verdict.ok, false, "a skipped npm test counted as verification");
    assert.match(verdict.ok === false ? verdict.reason : "", /unconditionally/);
  });

  /** ANY condition, not just a false one — evaluating them would be guessing. */
  it("refuses a verification step under a condition that might be true", () => {
    const verdict = checkVerificationCommand(workflow({ stepIf: "${{ github.event_name == 'push' }}" }));

    assert.equal(verdict.ok, false, "a conditional verification step was accepted");
  });

  it("refuses a verification step whose failure would not fail the job", () => {
    const verdict = checkVerificationCommand(workflow({ continueOnError: true }));

    assert.equal(verdict.ok, false, "continue-on-error verification was accepted");
  });

  it("refuses continue-on-error anywhere in the workflow", () => {
    const verdict = checkStepExecution(workflow({ continueOnError: true }));

    assert.equal(verdict.ok, false, "a step that cannot fail the job was accepted");
    assert.match(verdict.ok === false ? verdict.reason : "", /continue-on-error/);
  });

  it("accepts the shipped workflow, whose steps are unconditional", () => {
    assert.equal(checkStepExecution(shipped()).ok, true);
  });

  /** `echo npm ci` contains the words and installs nothing. */
  for (const [label, command] of [
    ["echoed", "echo npm ci"],
    ["commented into a longer command", "true && echo 'npm ci'"],
  ] as const) {
    it(`refuses an install that is only ${label}`, () => {
      const verdict = checkInstall(workflow({ runs: [command, "npm test"] }));

      assert.equal(verdict.ok, false, `${command} counted as an install`);
    });
  }

  it("refuses a verification command that is only echoed", () => {
    const verdict = checkVerificationCommand(workflow({ runs: ["npm ci", "echo npm test"] }));

    assert.equal(verdict.ok, false, "echo npm test counted as verification");
  });
});

/**
 * TASK-017 round-1 HIGH 4: `npm i` is an official alias for `npm install`, and
 * npm accepts a family of abbreviations besides. A check written for the long
 * spelling caught one of them.
 */
describe("TASK-017 round-1 HIGH 4: every spelling of npm install is refused", () => {
  for (const alias of ["i", "install", "in", "ins", "inst", "add", "isntall"]) {
    it(`refuses npm ${alias}`, () => {
      const verdict = checkInstall(workflow({ runs: ["npm ci", `npm ${alias}`, "npm test"] }));

      assert.equal(verdict.ok, false, `npm ${alias} was accepted alongside npm ci`);
      assert.match(verdict.ok === false ? verdict.reason : "", /lockfile/);
    });
  }

  /** The control: `npm ci` and `npm test` are not install aliases. */
  it("still accepts a workflow whose only npm commands are ci and test", () => {
    assert.equal(checkInstall(workflow()).ok, true);
  });
});

/**
 * TASK-017 round-1 HIGH 2: `with: node-version:` on some other action
 * configures that action. The runner's Node is pinned by `setup-node` or by
 * nothing.
 */
describe("TASK-017 round-1 HIGH 2: the Node pin must be on setup-node", () => {
  it("refuses a node-version carried by an unrelated action", () => {
    const misplaced = workflow({
      uses: [`actions/cache@${"c".repeat(40)}`],
      nodeVersion: "22.5.0",
      nodeVersionOn: "cache",
    });

    const verdict = checkNodePin(misplaced, ">=22.5.0");

    assert.equal(verdict.ok, false, "a node-version on another action counted as a pin");
    assert.match(verdict.ok === false ? verdict.reason : "", /setup-node/);
  });

  it("accepts a node-version carried by setup-node", () => {
    const pinned = workflow({
      uses: [`actions/setup-node@${"b".repeat(40)}`],
      nodeVersion: "22.5.0",
    });

    assert.equal(checkNodePin(pinned, ">=22.5.0").ok, true);
  });
});

/**
 * TASK-017 round-1 HIGH 3: naming an event is not triggering on it. `types`
 * narrows which activity fires the workflow, and `branches-ignore` can exclude
 * every branch — so a workflow can name both events and run for neither.
 */
describe("TASK-017 round-1 HIGH 3: trigger filters are read, not just event names", () => {
  it("refuses a pull_request narrowed to closed", () => {
    const narrowed = workflow({
      onFilters: { pull_request: ["    types:", "      - closed"] },
    });

    const verdict = checkTriggers(narrowed);

    assert.equal(verdict.ok, false, "a workflow that never sees a new pull request was accepted");
    assert.match(verdict.ok === false ? verdict.reason : "", /opened/);
  });

  it("refuses a pull_request that misses synchronize, so updates produce nothing", () => {
    const narrowed = workflow({
      onFilters: { pull_request: ["    types:", "      - opened"] },
    });

    assert.equal(checkTriggers(narrowed).ok, false);
  });

  it("accepts a pull_request whose types include opened and synchronize", () => {
    const explicit = workflow({
      onFilters: { pull_request: ["    types:", "      - opened", "      - synchronize"] },
    });

    assert.equal(checkTriggers(explicit).ok, true);
  });

  it("refuses branches-ignore, which can exclude every branch", () => {
    const ignored = workflow({
      onFilters: { push: ["    branches-ignore:", '      - "**"'] },
    });

    const verdict = checkTriggers(ignored);

    assert.equal(verdict.ok, false, "a push excluded from every branch was accepted");
    assert.match(verdict.ok === false ? verdict.reason : "", /branches-ignore/);
  });

  it("refuses a branch list that does not cover every branch", () => {
    const limited = workflow({
      onFilters: { push: ["    branches:", "      - main"] },
    });

    assert.equal(checkTriggers(limited).ok, false);
  });

  it("accepts the shipped workflow's filters", () => {
    assert.equal(checkTriggers(shipped()).ok, true);
  });
});

describe("TASK-017 round-1 note: permissions must be a mapping", () => {
  it("refuses a permissions sequence, which grants nothing legible", () => {
    const parsed = parseWorkflow(
      ["name: x", "on:", "  push:", "    branches:", '      - "**"', "permissions:", "  - contents", "jobs:", "  v:", "    runs-on: ubuntu-latest", "    steps:", "      - run: npm test", ""].join("\n"),
    );
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;

    const verdict = checkPermissions(parsed.root, "clean");

    assert.equal(verdict.ok, false, "a permissions sequence was accepted");
    assert.match(verdict.ok === false ? verdict.reason : "", /sequence/);
  });
});

/**
 * TASK-017 round-2 review: the policies now refuse what they do not reason
 * about, the way the parser does.
 *
 * Six findings, one cause. The parser refuses YAML constructs it does not
 * implement; the policies accepted GitHub FEATURES they did not know about.
 * Job-level `if`, job-level `continue-on-error`, job-level `permissions`,
 * `paths-ignore`, a negative branch pattern, `with: repository:` on checkout —
 * all documented, all changing what runs, all previously green.
 *
 * These cases are written as raw YAML rather than through the synthetic
 * builder, because each is the reviewer's exact reproduction and should be
 * readable as such.
 */
describe("TASK-017 round-2: the workflow shape is an allowlist", () => {
  const BASE = [
    "name: x",
    "on:",
    "  pull_request:",
    "    branches:",
    '      - "**"',
    "  push:",
    "    branches:",
    '      - "**"',
    "permissions:",
    "  contents: read",
    "jobs:",
    "  verify:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    `      - uses: actions/checkout@${"a".repeat(40)}`,
    `      - uses: actions/setup-node@${"b".repeat(40)}`,
    "        with:",
    '          node-version: "22.5.0"',
    "      - run: npm ci",
    "      - run: npm test",
  ];

  function from(lines: readonly string[]): YamlMap {
    const parsed = parseWorkflow(lines.join("\n") + "\n");
    assert.equal(parsed.ok, true, `fixture does not parse: ${parsed.ok ? "" : parsed.reason}`);
    if (!parsed.ok) throw new Error("unreachable");
    return parsed.root;
  }

  /** Inserts lines after the first line matching `after`. */
  function withLines(after: string, added: readonly string[]): YamlMap {
    const index = BASE.findIndex((line) => line === after);
    assert.notEqual(index, -1, `the fixture has no line ${JSON.stringify(after)}`);
    return from([...BASE.slice(0, index + 1), ...added, ...BASE.slice(index + 1)]);
  }

  it("accepts the fixture it starts from, so the refusals below mean something", () => {
    assert.equal(checkWorkflowShape(from(BASE)).ok, true);
  });

  it("accepts the SHIPPED workflow", () => {
    const verdict = checkWorkflowShape(shipped());

    assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);
  });

  /** The reviewer's four job- and step-level execution controls. */
  for (const [label, after, added] of [
    ["a job-level condition", "  verify:", ["    if: ${{ false }}"]],
    ["job-level continue-on-error", "  verify:", ["    continue-on-error: true"]],
    ["job-level permissions", "  verify:", ["    permissions:", "      contents: write"]],
    ["a step-level condition", `      - uses: actions/setup-node@${"b".repeat(40)}`, ["        if: ${{ false }}"]],
  ] as const) {
    it(`refuses ${label}`, () => {
      const verdict = checkWorkflowShape(withLines(after, added));

      assert.equal(verdict.ok, false, `${label} was accepted`);
    });
  }

  it("refuses paths-ignore, which can stop the workflow running entirely", () => {
    const verdict = checkWorkflowShape(withLines("  push:", ["    paths-ignore:", '      - "**"']));

    assert.equal(verdict.ok, false, "paths-ignore was accepted");
    assert.match(verdict.ok === false ? verdict.reason : "", /paths-ignore/);
  });

  it("refuses branches-ignore at the shape level", () => {
    const verdict = checkWorkflowShape(withLines("  push:", ["    branches-ignore:", '      - "**"']));

    assert.equal(verdict.ok, false, "branches-ignore was accepted");
  });

  /**
   * A NEGATIVE PATTERN AFTER `**` excludes everything it just included, and a
   * check that only looked for `**` being present saw nothing wrong. The
   * allowlist does not help here — `branches` is allowed — so the branch list
   * itself is checked for exclusions.
   */
  it("refuses a negative branch pattern that undoes the wildcard", () => {
    const undone = from(BASE.map((line) => (line === '      - "**"' ? '      - "**"\n      - "!**"' : line)));

    const verdict = checkTriggers(undone);

    assert.equal(verdict.ok, false, "a negative pattern excluding every branch was accepted");
  });

  it("refuses a repository input on checkout, which would verify another repository", () => {
    const repointed = withLines(`      - uses: actions/checkout@${"a".repeat(40)}`, [
      "        with:",
      "          repository: attacker/other",
    ]);

    const verdict = checkWorkflowShape(repointed);

    assert.equal(verdict.ok, false, "checkout was allowed to point elsewhere");
    assert.match(verdict.ok === false ? verdict.reason : "", /repository/);
  });

  it("refuses a ref input on checkout", () => {
    const repointed = withLines(`      - uses: actions/checkout@${"a".repeat(40)}`, [
      "        with:",
      "          ref: main",
    ]);

    assert.equal(checkWorkflowShape(repointed).ok, false);
  });

  it("refuses an unknown key at the workflow root", () => {
    assert.equal(checkWorkflowShape(from([...BASE, "concurrency:", "  group: x"])).ok, false);
  });

  /**
   * A MAP-SHAPED unknown event, so only the EVENT allowlist can refuse it.
   *
   * The first version used `schedule:`, which takes a sequence — and the
   * "filters are not a mapping" branch refused it whether or not the event
   * allowlist existed. `release` takes a mapping whose only key here is one the
   * allowlist already permits, leaving exactly one guard able to decide.
   */
  it("refuses an event nobody has reasoned about", () => {
    const released = from([
      ...BASE.slice(0, 8),
      "  release:",
      "    types:",
      "      - published",
      ...BASE.slice(8),
    ]);

    const verdict = checkWorkflowShape(released);

    assert.equal(verdict.ok, false, "an unreasoned-about event was accepted");
    assert.match(verdict.ok === false ? verdict.reason : "", /release/);
  });
});

describe("TASK-017 round-2 CRITICAL 2: the repository must actually be checked out", () => {
  it("accepts the shipped workflow, which checks out first", () => {
    assert.equal(checkCheckout(shipped()).ok, true);
  });

  it("refuses a workflow that never checks out", () => {
    const verdict = checkCheckout(workflow({ uses: [`actions/setup-node@${"b".repeat(40)}`] }));

    assert.equal(verdict.ok, false, "a workflow verifying an unfetched tree was accepted");
    assert.match(verdict.ok === false ? verdict.reason : "", /never checks out/);
  });

  it("refuses a workflow that checks out twice, so what ran is ambiguous", () => {
    const twice = workflow({
      uses: [`actions/checkout@${"a".repeat(40)}`, `actions/checkout@${"c".repeat(40)}`],
    });

    assert.equal(checkCheckout(twice).ok, false);
  });

  it("refuses a checkout that is not the first step", () => {
    const late = workflow({
      uses: [`actions/setup-node@${"b".repeat(40)}`, `actions/checkout@${"a".repeat(40)}`],
    });

    const verdict = checkCheckout(late);

    assert.equal(verdict.ok, false, "a step ran before the tree was fetched");
    assert.match(verdict.ok === false ? verdict.reason : "", /first step/);
  });
});

/**
 * TASK-017 round-2 HIGH 5: modelling shell execution is another guessing
 * machine, so the commands are simply written down.
 */
describe("TASK-017 round-2 HIGH 5: only allowlisted commands may run", () => {
  it("accepts the shipped workflow's two commands", () => {
    assert.equal(checkRunAllowlist(shipped()).ok, true);
  });

  for (const command of [
    "command npm install",
    "./node_modules/.bin/tsc -p tsconfig.json",
    "npx tsc",
    "sh -c 'npm install'",
    "npm ci --ignore-scripts",
  ]) {
    it(`refuses ${JSON.stringify(command)}`, () => {
      const verdict = checkRunAllowlist(workflow({ runs: ["npm ci", "npm test", command] }));

      assert.equal(verdict.ok, false, `${command} was accepted`);
    });
  }
});

/**
 * TASK-017 round-3 review: a scalar can be spelled so the reader does not see
 * what GitHub sees.
 *
 * YAML decodes escapes inside double quotes. `"\x21**"` IS `!**`, a negative
 * branch pattern excluding every branch, and `"${{ secrets\x2eSENSITIVE }}"`
 * IS a secret reference. Both passed every check, because the reader kept the
 * bytes and the checks looked at the bytes.
 *
 * Refused rather than decoded: a partial decoder handling `\x` but not `\u`
 * would reproduce the defect with a different spelling.
 */
describe("TASK-017 round-3 CRITICAL: escaped scalars are refused, not misread", () => {
  for (const [label, escaped] of [
    ["a hex escape", '"\\x21**"'],
    ["a unicode escape", '"\\u0021**"'],
    ["a newline escape", '"a\\nb"'],
    ["an escaped backslash", '"a\\\\b"'],
  ] as const) {
    it(`refuses ${label}`, () => {
      const parsed = parseWorkflow(`name: x\nvalue: ${escaped}\n`);

      assert.equal(parsed.ok, false, `${label} was read literally instead of refused`);
      assert.match(parsed.ok === false ? parsed.reason : "", /backslash/);
    });
  }

  /** The reviewer's exact branch reproduction. */
  it("refuses a branch list hiding a negative pattern behind an escape", () => {
    const parsed = parseWorkflow(
      ["name: x", "on:", "  push:", "    branches:", '      - "**"', '      - "\\x21**"', ""].join("\n"),
    );

    assert.equal(parsed.ok, false, "an escaped negative pattern was read literally");
  });

  /** And the secret reproduction. */
  it("refuses an input hiding a secret reference behind an escape", () => {
    const parsed = parseWorkflow(
      ["name: x", "jobs:", "  v:", "    steps:", "      - with:", '          k: "${{ secrets\\x2eS }}"', ""].join("\n"),
    );

    assert.equal(parsed.ok, false, "an escaped secret reference was read literally");
  });

  /** The shipped workflow uses no escapes, so the refusals are not universal. */
  it("still parses the shipped workflow", () => {
    assert.equal(parseWorkflow(SOURCE).ok, true);
  });
});

describe("TASK-017 round-3 CRITICAL 2: a secret is refused in values, not only raw text", () => {
  it("refuses a secret reference found in a parsed value", () => {
    const parsed = parseWorkflow(
      [
        "name: x",
        "on:",
        "  push:",
        "    branches:",
        '      - "**"',
        "permissions:",
        "  contents: read",
        "jobs:",
        "  v:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npm test",
        "        name: ${{ secrets.SENSITIVE }}",
        "",
      ].join("\n"),
    );
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;

    // The RAW source given here is clean, so only the value scan can refuse it.
    const verdict = checkPermissions(parsed.root, "nothing suspicious here");

    assert.equal(verdict.ok, false, "a secret in a parsed value was accepted");
    assert.match(verdict.ok === false ? verdict.reason : "", /secret/);
  });
});

describe("TASK-017 round-3 HIGH 3: nothing runs before the checkout", () => {
  it("refuses a run step placed before the checkout", () => {
    const parsed = parseWorkflow(
      [
        "name: x",
        "jobs:",
        "  v:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npm test",
        `      - uses: actions/checkout@${"a".repeat(40)}`,
        "",
      ].join("\n"),
    );
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;

    const verdict = checkCheckout(parsed.root);

    assert.equal(verdict.ok, false, "a step ran before the tree was fetched");
    assert.match(verdict.ok === false ? verdict.reason : "", /first step/);
  });
});

/**
 * TASK-017 round-3 CRITICAL 4: a guard whose test can vanish is not a guard.
 *
 * The reviewer deleted `tests/workflowPolicy.test.ts`, set the runner to a
 * metered one, and the suite passed 2,042/2,042 — every policy in this task
 * switched off by removing one file, with nothing to notice it.
 *
 * `scripts/verify.mjs` now refuses when a required test source is absent. These
 * cases assert that the manifest exists and names the files whose loss would be
 * silent. THIS FILE IS ITSELF IN THE MANIFEST, so emptying these assertions
 * means deleting a file whose absence verification reports. That mutual
 * protection is where the regress stops; there is no further turtle.
 *
 * What it does NOT establish: that a required test is HONEST. A file emptied of
 * assertions is still present. Mutation and independent review cover that, and
 * a list of filenames does not pretend to.
 */
describe("TASK-017 round-3 CRITICAL 4: required tests cannot silently vanish", () => {
  const VERIFIER = readFileSync(join(REPO_ROOT, "scripts/verify.mjs"), "utf8");

  it("declares a required-test manifest", () => {
    assert.match(
      VERIFIER,
      /const REQUIRED_TESTS = \[/,
      "the verifier has no required-test manifest, so deleting a test file is a smaller test run rather than a failure",
    );
  });

  it("refuses when a required test is missing, rather than reporting a smaller run", () => {
    /**
     * The CONDITIONAL, not merely the name near a `fail(`. Matching
     * `missingRequired ... fail(` still matched when the guard became
     * `if (false)`, because the const declaration kept the name in scope and
     * the `fail(` a few lines down was unrelated. My own harness caught it.
     */
    assert.match(
      VERIFIER,
      /if \(missingRequired\.length > 0\)\s*\{[\s\S]{0,400}?fail\(/,
      "the manifest is declared but nothing fails when an entry is missing",
    );
  });

  /**
   * The files whose loss would be silent. Named individually rather than
   * counted, because "the manifest has at least N entries" is satisfied by any
   * N strangers — the round-3 review made exactly that point about the honesty
   * test's premise.
   */
  for (const required of [
    "tests/workflowPolicy.test.ts",
    "tests/knownLimitationsHonesty.test.ts",
    "tests/pushAuthorization.test.ts",
    "tests/githubCredentialBoundary.test.ts",
    "tests/financialSafetyGate.test.ts",
    "tests/executorIsolation.test.ts",
  ]) {
    it(`requires ${required}`, () => {
      assert.ok(
        VERIFIER.includes(`"${required}"`),
        `${required} is not in the manifest, so deleting it would disable its guards silently`,
      );
    });
  }

  /** And every named file actually exists, so the manifest cannot rot. */
  it("names only files that exist", () => {
    const listed = [...VERIFIER.matchAll(/"(tests\/[^"]+\.test\.ts)"/g)].map((match) => match[1]);
    assert.ok(listed.length > 0, "no test paths were found in the verifier");
    for (const path of listed) {
      assert.ok(
        existsSync(join(REPO_ROOT, path ?? "")),
        `the manifest names ${path}, which does not exist — a manifest that has rotted refuses every run`,
      );
    }
  });
});

/**
 * TASK-017 round-4 review: the parser accepted YAML that YAML rejects.
 *
 * Four ways, each producing a structure GitHub would never see. The last is the
 * worst — not a refusal that failed to fire, but a confident WRONG ANSWER about
 * what the file says.
 */
describe("TASK-017 round-4 CRITICAL: invalid YAML is refused, not reinterpreted", () => {
  it("refuses an invalid escape, not merely the valid ones", () => {
    // The refusal list matched valid escape FORMS, so `\q` — which YAML
    // rejects outright — passed through as a literal.
    const parsed = parseWorkflow('name: "\\q"\n');

    assert.equal(parsed.ok, false, "an invalid escape was read literally");
  });

  it("refuses an unterminated quoted scalar", () => {
    const parsed = parseWorkflow('name: "verify\n');

    assert.equal(parsed.ok, false, "an unterminated quote became part of the value");
    assert.match(parsed.ok === false ? parsed.reason : "", /unterminated/);
  });

  it("refuses non-breaking spaces used as indentation", () => {
    // `trimStart()` treats U+00A0 as whitespace and YAML does not, so the
    // reader computed a depth the file does not have.
    const parsed = parseWorkflow("jobs:\n\u00a0\u00a0verify: x\n");

    assert.equal(parsed.ok, false, "non-ASCII whitespace was counted as indentation");
  });

  /**
   * THE CONFIDENT WRONG ANSWER. `get()` returned the FIRST match, so a second
   * `permissions:` granting write was reported as read-only. YAML
   * implementations disagree about duplicates and GitHub's is not this one, so
   * refusing is the only honest move.
   */
  it("refuses a mapping that declares the same key twice", () => {
    const parsed = parseWorkflow(
      ["permissions:", "  contents: read", "other: x", "permissions:", "  contents: write", ""].join("\n"),
    );

    assert.equal(parsed.ok, false, "a duplicate key was silently resolved");
    assert.match(parsed.ok === false ? parsed.reason : "", /more than once/);
  });

  it("refuses a duplicate key nested inside a job", () => {
    const parsed = parseWorkflow(
      ["jobs:", "  v:", "    runs-on: ubuntu-latest", "    runs-on: macos-14", ""].join("\n"),
    );

    assert.equal(parsed.ok, false, "a duplicate nested key was silently resolved");
  });

  /** A plain scalar may CONTAIN quotes; only an opening quote makes it quoted. */
  it("still reads a plain scalar that ends with a quote", () => {
    const parsed = parseWorkflow("run: true && echo 'npm ci'\n");

    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;
    assert.equal(get(parsed.root, "run"), "true && echo 'npm ci'");
  });

  it("still parses the shipped workflow", () => {
    assert.equal(parseWorkflow(SOURCE).ok, true);
  });
});

/**
 * TASK-017 round-4 CRITICAL 2: the manifest gate must not be a renameable label.
 *
 * I gated it on the package NAME and wrote that renaming would break the
 * package scripts. The reviewer renamed it to "fixture", deleted a required
 * test, and the suite passed. The claim was false, and it was stated in the one
 * place a reader would go for the reasoning.
 */
describe("TASK-017 round-4 CRITICAL 2: the manifest gate is derived from the tree", () => {
  const VERIFIER_SOURCE = readFileSync(join(REPO_ROOT, "scripts/verify.mjs"), "utf8");

  /**
   * THE PROPERTY, NOT A SPELLING.
   *
   * My first version asserted the absence of the identifier `packageName`, so a
   * mutation that inlined the same comparison restored the renameable gate and
   * the test saw nothing. What matters is that the gate does not NAME this
   * repository — any such name is a one-word edit away from disabling it.
   */
  it("nowhere names this repository, which would make the gate renameable", () => {
    assert.ok(
      !VERIFIER_SOURCE.includes("software-factory"),
      "the verifier names this repository, so a rename can change what it enforces",
    );
  });

  it("derives the manifest's scope from the tree's own contents", () => {
    assert.match(
      VERIFIER_SOURCE,
      /const presentRequired = REQUIRED_TESTS\.filter\(\(required\) => sourceTests\.includes\(required\)\)/,
      "the manifest does not derive its scope from which required tests are present",
    );
  });
});
