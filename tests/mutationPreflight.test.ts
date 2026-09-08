/**
 * THE PREFLIGHT MUST REFUSE, NOT MERELY EXIST.
 *
 * A gate that always says VALID is worse than no gate: it costs the same and
 * certifies nothing. Every class the preflight is meant to catch is a real
 * failure this task has already paid for, so each has a case here, and each is
 * paired with a positive control so "refuse everything" cannot satisfy them.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyMutation,
  classifySelection,
  occurrences,
  type MutationFacts,
} from "../src/verification/mutationPreflight.js";

/** A definition with nothing wrong with it. Every case below spoils one field. */
function sound(overrides: Partial<MutationFacts> = {}): MutationFacts {
  return {
    id: "a guard is switched off",
    target: "scripts/verify.mjs",
    from: "  if (shortfalls.length > 0) {",
    to: "  if (false) {",
    anchorOccurrences: 1,
    selfReferentialOccurrences: undefined,
    changedBytes: 12,
    compiles: true,
    namedTests: ["dist/tests/verificationHarnessEndToEnd.test.js"],
    missingTests: [],
    namedTestFound: true,
    expect: "refuses a shrunk manifest",
    ...overrides,
  };
}

describe("TASK-017: the mutation preflight refuses what a full run would waste hours discovering", () => {
  /** POSITIVE CONTROL, first: without it every case below is satisfied by "refuse everything". */
  it("accepts a definition with nothing wrong with it", () => {
    const verdict = classifyMutation(sound());

    assert.equal(verdict.result, "VALID", verdict.reasons.join("; "));
    assert.deepEqual(verdict.reasons, []);
  });

  /** Round 21 and 22: an anchor naming code that has since been rewritten. */
  it("refuses an anchor that occurs nowhere", () => {
    const verdict = classifyMutation(sound({ anchorOccurrences: 0 }));

    assert.equal(verdict.result, "INVALID");
    assert.match(verdict.reasons.join(" "), /does not occur in scripts\/verify\.mjs/);
  });

  /**
   * Round 22, three times: the harness mutates its own file, so an anchor
   * written as one literal matches the code AND the definition naming it.
   */
  it("refuses an anchor that occurs more than once in its target", () => {
    const verdict = classifyMutation(sound({ anchorOccurrences: 2 }));

    assert.equal(verdict.result, "INVALID");
    assert.match(verdict.reasons.join(" "), /occurs 2 times/);
  });

  /**
   * ONLY WHEN THE MUTATION EDITS ITS OWN DEFINITION FILE. Counting the anchor
   * in the definitions for every mutation flagged thirty sound ones, because an
   * anchor may appear in several definitions and one replacement may contain
   * another's anchor.
   */
  it("names self-reference separately, because the fix is different", () => {
    const verdict = classifyMutation(sound({ selfReferentialOccurrences: 2 }));

    assert.equal(verdict.result, "INVALID");
    assert.match(verdict.reasons.join(" "), /matches its own description/);
    assert.match(verdict.reasons.join(" "), /concatenation/);
  });

  it("does not object when a mutation simply does not edit its definition file", () => {
    const verdict = classifyMutation(sound({ selfReferentialOccurrences: undefined }));

    assert.equal(verdict.result, "VALID", verdict.reasons.join("; "));
  });

  it("refuses a mutation whose replacement is its own anchor", () => {
    const verdict = classifyMutation(sound({ to: sound().from }));

    assert.equal(verdict.result, "INVALID");
    assert.match(verdict.reasons.join(" "), /changes nothing/);
  });

  it("refuses a mutation that changed no bytes in the scratch copy", () => {
    const verdict = classifyMutation(sound({ changedBytes: 0 }));

    assert.equal(verdict.result, "INVALID");
    assert.match(verdict.reasons.join(" "), /changed nothing/);
  });

  /** Round 22: a weakened form that left a binding unused and failed the build. */
  it("refuses a mutated form that does not build", () => {
    const verdict = classifyMutation(sound({ compiles: false }));

    assert.equal(verdict.result, "INVALID");
    assert.match(verdict.reasons.join(" "), /does not build/);
  });

  it("refuses a mutation naming a test artifact that is not there", () => {
    const verdict = classifyMutation(sound({ missingTests: ["dist/tests/gone.test.js"] }));

    assert.equal(verdict.result, "INVALID");
    assert.match(verdict.reasons.join(" "), /dist\/tests\/gone\.test\.js, which is not present/);
  });

  it("refuses a mutation naming no test at all", () => {
    const verdict = classifyMutation(sound({ namedTests: [] }));

    assert.equal(verdict.result, "INVALID");
    assert.match(verdict.reasons.join(" "), /names no test/);
  });

  /** A renamed killing test is how a mutation becomes WRONG TEST. */
  it("refuses a killing test that no longer exists under that name", () => {
    const verdict = classifyMutation(sound({ namedTestFound: false, expect: "a name nobody uses" }));

    assert.equal(verdict.result, "INVALID");
    assert.match(verdict.reasons.join(" "), /no test matching "a name nobody uses"/);
  });

  /**
   * EVERY UNGATHERED FACT IS INVALID, NOT ACCEPTABLE. Absent evidence reading
   * as permission is the shape this repository has found five times.
   */
  for (const field of [
    "anchorOccurrences",
    "changedBytes",
    "compiles",
    "namedTestFound",
  ] as const) {
    it(`refuses when ${field} could not be measured`, () => {
      const verdict = classifyMutation(sound({ [field]: undefined }));

      assert.equal(verdict.result, "INVALID", `${field} being unknown was treated as acceptable`);
    });
  }

  it("reports every reason at once rather than the first", () => {
    const verdict = classifyMutation(sound({ anchorOccurrences: 0, compiles: false, namedTestFound: false }));

    assert.equal(verdict.result, "INVALID");
    assert.ok(verdict.reasons.length >= 3, `expected several reasons, got ${verdict.reasons.length}`);
  });

  /** An empty selection measures nothing, and a run that measures nothing must not report. */
  it("refuses an empty selection", () => {
    const { ok, summary, verdicts } = classifySelection([]);

    assert.equal(ok, false);
    assert.deepEqual(verdicts, []);
    assert.match(summary, /selection is empty/);
  });

  it("accepts a selection whose every member is sound", () => {
    const { ok, summary } = classifySelection([sound(), sound({ id: "another" })]);

    assert.equal(ok, true, summary);
    assert.match(summary, /2 mutations, all VALID/);
  });

  it("refuses the whole selection when one member is not measurable", () => {
    const { ok, summary } = classifySelection([sound(), sound({ id: "broken", anchorOccurrences: 0 })]);

    assert.equal(ok, false);
    assert.match(summary, /1 of 2 mutations are not measurable/);
  });

  it("counts occurrences without treating the anchor as a pattern", () => {
    assert.equal(occurrences("a.b a.b axb", "a.b"), 2);
    assert.equal(occurrences("nothing here", "missing"), 0);
    assert.equal(occurrences("anything", ""), 0);
  });
});
