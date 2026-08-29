/**
 * COMMIT ATTRIBUTION POLICY — the guard, and proof it is not vacuous.
 *
 * Two layers, deliberately:
 *
 *   The RULE is pure and is tested exhaustively, including the spellings a
 *   regex written in five minutes would miss.
 *
 *   The REPOSITORY check runs the rule against commits after the baseline. That
 *   half cannot be made to fail on demand without creating a bad commit, so its
 *   non-vacuity is established separately by driving the same function with a
 *   synthetic commit that MUST be rejected — otherwise "no violations found"
 *   would be indistinguishable from "the check looked at nothing", which is the
 *   defect that has cost this repository the most review rounds.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

import {
  ATTRIBUTION_BASELINE,
  describeViolations,
  findAttributionTrailers,
} from "../src/governance/commitPolicy.js";

/** A delimiter no commit message will contain, and no control characters. */
const RECORD = "===SF-COMMIT-RECORD===";
const FIELD = "===SF-FIELD===";

describe("commit attribution policy: the rule", () => {
  it("rejects the trailer this repository actually produced", () => {
    const violations = findAttributionTrailers([
      {
        sha: "aaaaaaa",
        message: "fix: something\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n",
      },
    ]);
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.marker, "claude");
  });

  it("rejects every named tool, however the trailer is spaced or capitalised", () => {
    const spellings = [
      "Co-Authored-By: Claude <x@y>",
      "co-authored-by: anthropic <x@y>",
      "Co-authored-by:   Codex <x@y>",
      "CO-AUTHORED-BY: OpenAI <x@y>",
      "Co Authored By: Copilot <x@y>",
      "\tCo-Authored-By: ChatGPT <x@y>",
      "Co-Authored-By: Someone <noreply@anthropic.com>",
    ];
    for (const line of spellings) {
      const violations = findAttributionTrailers([{ sha: "b", message: `t\n\n${line}\n` }]);
      assert.equal(violations.length, 1, `not rejected: ${line}`);
    }
  });

  /**
   * THE CONTROL. Without it the rule could be "reject every trailer", or even
   * "reject everything", and every case above would still pass.
   */
  it("ACCEPTS an ordinary commit and a human co-author", () => {
    const violations = findAttributionTrailers([
      { sha: "c", message: "feat: a change\n\nA normal body.\n" },
      {
        sha: "d",
        message: "feat: pair work\n\nCo-Authored-By: Hakan Duyar <iamhakanduyar@gmail.com>\n",
      },
      { sha: "e", message: "docs: mention Claude in prose rather than a trailer\n" },
    ]);
    assert.deepEqual(violations, []);
  });

  it("does not treat a mention inside the subject as a trailer", () => {
    const violations = findAttributionTrailers([
      { sha: "f", message: "chore: drop the Co-Authored-By: Claude trailer from the template\n" },
    ]);
    assert.deepEqual(violations, [], "only a trailer LINE counts, not a mention of one");
  });

  it("names the offending commit and the reason", () => {
    const text = describeViolations(
      findAttributionTrailers([
        { sha: "0123456789abcdef", message: "x\n\nCo-Authored-By: Claude <n@a>\n" },
      ]),
    );
    assert.match(text, /0123456789/);
    assert.match(text, /matched "claude"/);
    assert.match(text, /iamhakanduyar@gmail\.com/);
  });
});

describe("commit attribution policy: this repository", () => {
  function gitAvailable(): boolean {
    try {
      execFileSync("git", ["rev-parse", "--git-dir"], { cwd: process.cwd(), stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  /** Commits reachable from HEAD but NOT from the baseline: the governed set. */
  function commitsAfterBaseline(): readonly { sha: string; message: string }[] {
    const raw = execFileSync(
      "git",
      ["log", `--format=${RECORD}%H${FIELD}%B`, `${ATTRIBUTION_BASELINE}..HEAD`],
      { cwd: process.cwd(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return raw
      .split(RECORD)
      .map((record) => record.trim())
      .filter((record) => record.length > 0)
      .map((record) => {
        const index = record.indexOf(FIELD);
        return {
          sha: record.slice(0, index).trim(),
          message: record.slice(index + FIELD.length),
        };
      });
  }

  it("has no AI attribution trailer in any commit after the baseline", (t) => {
    if (!gitAvailable()) {
      t.skip("not a git checkout; the repository half of this policy is unproven here");
      return;
    }

    let commits: readonly { sha: string; message: string }[];
    try {
      commits = commitsAfterBaseline();
    } catch {
      t.skip("the baseline commit is not present in this checkout (shallow clone?)");
      return;
    }

    const violations = findAttributionTrailers(commits);
    assert.deepEqual(violations, [], describeViolations(violations));
  });

  /**
   * NON-VACUITY of the half above.
   *
   * "No violations after the baseline" is also exactly what a check that
   * examined ZERO commits would report. This drives the same function with a
   * commit that must be rejected, so a green result above means the rule works
   * rather than that nothing was looked at.
   */
  it("would reject a new commit carrying the trailer", () => {
    const violations = findAttributionTrailers([
      {
        sha: "deadbeef",
        message: "feat: x\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n",
      },
    ]);
    assert.equal(violations.length, 1, "the repository check cannot detect anything");
  });

  /**
   * The historical deviation is REAL and stays. If this ever reports zero, the
   * published history has been rewritten — which this policy forbids more
   * strongly than it forbids the trailers themselves, because rewriting the
   * record to tidy a governance breach destroys the evidence of it.
   */
  it("still finds the historical trailers before the baseline, unrewritten", (t) => {
    if (!gitAvailable()) {
      t.skip("not a git checkout");
      return;
    }
    let count = 0;
    try {
      const raw = execFileSync(
        "git",
        ["log", "--format=%H", "-i", "--grep=Co-Authored-By: Claude", ATTRIBUTION_BASELINE],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      count = raw.split("\n").filter((line) => line.trim().length > 0).length;
    } catch {
      t.skip("baseline not present in this checkout");
      return;
    }
    assert.ok(
      count > 0,
      "the historical trailers are gone, which means published history was rewritten",
    );
  });
});
