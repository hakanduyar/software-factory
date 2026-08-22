/**
 * Adversarial coverage for the strict, fail-closed reviewer-verdict parser
 * (TASK-004 §10). Pure function, no I/O — every case from the task brief's
 * §10 list is represented here in the tag-based format the loop actually
 * asks reviewers to use (see loopPrompts.ts's VERDICT_CONTRACT).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseReviewVerdict } from "../src/orchestration/reviewVerdictParser.js";

describe("reviewVerdictParser", () => {
  it("parses a clean PASS", () => {
    const result = parseReviewVerdict(["FACTORY_REVIEW_VERDICT: PASS\nFACTORY_REVIEW_FINDINGS:\n- none"]);
    assert.deepEqual(result, { ok: true, verdict: "PASS", findings: [] });
  });

  it("parses PASS_WITH_NON_BLOCKING_NOTES with findings", () => {
    const result = parseReviewVerdict([
      "FACTORY_REVIEW_VERDICT: PASS_WITH_NON_BLOCKING_NOTES\nFACTORY_REVIEW_FINDINGS:\n- minor naming nit\n- consider a comment",
    ]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.verdict, "PASS_WITH_NON_BLOCKING_NOTES");
      assert.deepEqual(result.findings, ["minor naming nit", "consider a comment"]);
    }
  });

  it("parses CHANGES_REQUIRED", () => {
    const result = parseReviewVerdict(["FACTORY_REVIEW_VERDICT: CHANGES_REQUIRED\nFACTORY_REVIEW_FINDINGS:\n- missing null check"]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.verdict, "CHANGES_REQUIRED");
    }
  });

  it('is not fooled by incidental use of "PASS" elsewhere in prose (brief §10: "tests PASS but verdict CHANGES_REQUIRED")', () => {
    const result = parseReviewVerdict([
      "FACTORY_REVIEW_VERDICT: CHANGES_REQUIRED\nFACTORY_REVIEW_FINDINGS:\n- Tests PASS locally but the API contract is broken",
    ]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.verdict, "CHANGES_REQUIRED");
    }
  });

  it('rejects "PASS and CHANGES_REQUIRED" style ambiguity: two tags in one text', () => {
    const result = parseReviewVerdict(["FACTORY_REVIEW_VERDICT: PASS\nsome text\nFACTORY_REVIEW_VERDICT: CHANGES_REQUIRED"]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /ambiguous/i);
    }
  });

  it("rejects two tags with the same value too (ambiguity, not merely conflict)", () => {
    const result = parseReviewVerdict(["FACTORY_REVIEW_VERDICT: PASS\nFACTORY_REVIEW_VERDICT: PASS"]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /ambiguous/i);
    }
  });

  it("pools matches across multiple source texts before checking ambiguity", () => {
    const result = parseReviewVerdict(["FACTORY_REVIEW_VERDICT: PASS", "FACTORY_REVIEW_VERDICT: CHANGES_REQUIRED"]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /ambiguous/i);
    }
  });

  it('rejects "no verdict" — plain prose with no tag at all, even containing the word PASS', () => {
    const result = parseReviewVerdict(["This implementation looks good, I'd say it's a PASS overall."]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /no .*verdict/i);
    }
  });

  it("rejects an empty/missing source entirely", () => {
    const result = parseReviewVerdict([]);
    assert.equal(result.ok, false);
  });

  it("rejects an invalid enum value", () => {
    const result = parseReviewVerdict(["FACTORY_REVIEW_VERDICT: MAYBE"]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /invalid/i);
    }
  });

  it("requires the tag to be the start of its own line — a substring occurrence does not count", () => {
    const result = parseReviewVerdict(["Prefix text FACTORY_REVIEW_VERDICT: PASS should not match"]);
    assert.equal(result.ok, false);
  });

  it("tolerates a missing findings block (treated as empty, not an error)", () => {
    const result = parseReviewVerdict(["FACTORY_REVIEW_VERDICT: PASS"]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.findings, []);
    }
  });

  it('treats a "- none" findings line as no findings', () => {
    const result = parseReviewVerdict(["FACTORY_REVIEW_VERDICT: PASS\nFACTORY_REVIEW_FINDINGS:\n- none"]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.findings, []);
    }
  });

  it("stops collecting findings at the first non-bullet line after the header", () => {
    const result = parseReviewVerdict([
      "FACTORY_REVIEW_VERDICT: CHANGES_REQUIRED\nFACTORY_REVIEW_FINDINGS:\n- first\n- second\nSome trailing prose not part of the list.\n- not collected",
    ]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.findings, ["first", "second"]);
    }
  });

  it("tolerates surrounding whitespace on the verdict line", () => {
    const result = parseReviewVerdict(["FACTORY_REVIEW_VERDICT:   PASS   "]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.verdict, "PASS");
    }
  });
});
