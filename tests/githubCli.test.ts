/**
 * TASK-016: the SHIPPED command surface, not a test-only double.
 *
 * The argument parser is where an operator's mistake either stops or becomes a
 * remote action, so it gets the same treatment `parseSuperviseTickArgs` got
 * after inline `indexOf` parsing was found silently ignoring a misspelled flag.
 *
 * Offline: parsing only — nothing here constructs a client or runs a process.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { parseGithubPublishArgs } from "../src/cli/github.js";

const A = "1111111111111111111111111111111111111111";
const BASE = "3333333333333333333333333333333333333333";

const COMPLETE = [
  "--roadmap-key", "GITHUB_ORCHESTRATION",
  "--head", A,
  "--base", BASE,
  "--head-ref", "feat/executor-wiring",
  "--base-ref", "main",
  "--repo", "hakanduyar/software-factory",
  "--remote-url", "https://github.com/hakanduyar/software-factory.git",
];

describe("TASK-016: sf github publish refuses malformed invocations", () => {
  it("accepts a complete invocation", () => {
    const parsed = parseGithubPublishArgs(COMPLETE);

    assert.equal(parsed.ok, true, `a complete invocation was refused: ${JSON.stringify(parsed)}`);
    assert.equal(parsed.ok === true ? parsed.value.headSha : "", A);
    assert.equal(parsed.ok === true ? parsed.value.repository : "", "hakanduyar/software-factory");
  });

  /**
   * AN ABBREVIATED SHA IS REFUSED AT THE DOOR. It would be refused by the pure
   * checks too, but only after a remote round trip — and an operator pasting
   * `git log --oneline` output is the likeliest way this command is ever
   * invoked wrongly.
   */
  it("refuses an abbreviated head sha", () => {
    const parsed = parseGithubPublishArgs(COMPLETE.map((token) => (token === A ? "11662a1" : token)));

    assert.equal(parsed.ok, false);
    assert.match(parsed.ok === false ? parsed.error : "", /40-character/);
  });

  it("refuses an abbreviated base sha", () => {
    const parsed = parseGithubPublishArgs(COMPLETE.map((token) => (token === BASE ? "8f0c240" : token)));

    assert.equal(parsed.ok, false);
  });

  /** A misspelled flag must stop the command, not be ignored. */
  it("refuses an unknown flag", () => {
    const parsed = parseGithubPublishArgs([...COMPLETE, "--forse", "yes"]);

    assert.equal(parsed.ok, false);
    assert.match(parsed.ok === false ? parsed.error : "", /unknown flag/);
  });

  it("refuses a stray positional argument", () => {
    const parsed = parseGithubPublishArgs([...COMPLETE, "extra"]);

    assert.equal(parsed.ok, false);
    assert.match(parsed.ok === false ? parsed.error : "", /unexpected argument/);
  });

  it("refuses a repeated flag rather than silently taking one", () => {
    const parsed = parseGithubPublishArgs([...COMPLETE, "--repo", "someone-else/other"]);

    assert.equal(parsed.ok, false);
    assert.match(parsed.ok === false ? parsed.error : "", /more than once/);
  });

  it("refuses a flag whose value is missing", () => {
    const parsed = parseGithubPublishArgs(COMPLETE.slice(0, -1));

    assert.equal(parsed.ok, false);
    assert.match(parsed.ok === false ? parsed.error : "", /requires a value/);
  });

  /** Every flag is required: a partially specified candidate is not a candidate. */
  for (const flag of ["--roadmap-key", "--head", "--base", "--head-ref", "--base-ref", "--repo", "--remote-url"]) {
    it(`refuses an invocation missing ${flag}`, () => {
      const index = COMPLETE.indexOf(flag);
      const without = [...COMPLETE.slice(0, index), ...COMPLETE.slice(index + 2)];

      const parsed = parseGithubPublishArgs(without);

      assert.equal(parsed.ok, false, `${flag} was not required`);
      assert.match(parsed.ok === false ? parsed.error : "", new RegExp(`${flag} is required`));
    });
  }
});

describe("TASK-016: the shipped CLI wires the real capability and no merge", () => {
  /**
   * AC-1 asks for the SHIPPED construction path. `main.ts` must dispatch the
   * command, and it must import the real module rather than a double.
   */
  it("dispatches sf github from main", () => {
    const source = readFileSync("src/cli/main.ts", "utf8");

    assert.match(source, /case "github"/, "sf github is not dispatched");
    assert.match(source, /await import\("\.\/github\.js"\)/, "the shipped path does not import the real module");
    assert.match(source, /parseGithubPublishArgs/, "the shipped path does not use the checked parser");
  });

  /**
   * NO MERGE COMMAND EXISTS. TASK-016's frozen scope produces the readiness
   * verdict and stops; a merge verb would be the thing CLEAN_ROOM_CI has to
   * tighten later, built before its evidence exists.
   */
  it("offers no merge or integrate verb", () => {
    const source = readFileSync("src/cli/github.ts", "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

    for (const forbidden of ["merge", "integrate", "approve"]) {
      assert.ok(!code.toLowerCase().includes(`run${forbidden}`), `the CLI exposes run${forbidden}`);
    }
    assert.ok(!code.includes('"pr", "merge"'), "the CLI can merge a pull request");
  });
});
