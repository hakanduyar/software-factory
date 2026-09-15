/**
 * TASK-018 Part B — what counts as a verdict, and what does not.
 *
 * The consumer acts on whatever this returns, so every way of being wrong here
 * ends as a wrong durable transition. The asymmetry that matters: failing to
 * read a real verdict costs a re-review, and reading one that is not there
 * costs an unreviewed integration. Everything below is written to fail in the
 * first direction.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createFileVerdictSource } from "../src/adapters/supervision/fileVerdictSource.js";
import {
  bindingMismatch,
  isAccepted,
  parseAcceptanceVerdict,
  type AcceptanceOutcome,
} from "../src/supervision/acceptance.js";

const scratch = mkdtempSync(join(tmpdir(), "sf-verdict-parse-"));

const CANDIDATE = { commit: "339ae83", tree: "3fd1ecb", fingerprint: "e3bb12ea62ef" } as const;

function text(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

const WELL_FORMED = text([
  "VERDICT: PASS",
  "Safe to commit: YES",
  "",
  "Prose the reviewer wrote. It mentions PASS and CHANGES_REQUIRED in passing,",
  "and says `Safe to commit` without a colon-terminated line of its own.",
  "",
  "FACTORY_ACCEPTANCE_COUNTS: CRITICAL=0 HIGH=0",
  `FACTORY_ACCEPTANCE_CANDIDATE: ${CANDIDATE.commit} ${CANDIDATE.tree} ${CANDIDATE.fingerprint}`,
]);

describe("TASK-018: reading a verdict", () => {
  it("reads a well-formed verdict, and prose around it changes nothing", () => {
    const reading = parseAcceptanceVerdict(WELL_FORMED);
    assert.equal(reading.kind, "VERDICT");
    if (reading.kind !== "VERDICT") throw new Error("unreachable");
    assert.equal(reading.outcome.verdict, "PASS");
    assert.equal(reading.outcome.critical, 0);
    assert.equal(reading.outcome.high, 0);
    assert.equal(reading.outcome.safeToCommit, true);
    assert.deepEqual(reading.outcome.candidate, { ...CANDIDATE });
  });

  it("treats an empty file as ABSENT, not as a failed review", () => {
    assert.equal(parseAcceptanceVerdict("").kind, "ABSENT");
    assert.equal(parseAcceptanceVerdict("   \n\n").kind, "ABSENT");
  });

  /**
   * TWO TAGS ARE AMBIGUITY, NOT AGREEMENT. A reviewer quoting the format it was
   * asked to use is exactly how a discussion of PASS becomes a PASS.
   */
  it("REFUSES a second VERDICT line even when both say the same thing", () => {
    const doubled = text(["VERDICT: PASS", "VERDICT: PASS", "Safe to commit: YES", "FACTORY_ACCEPTANCE_COUNTS: CRITICAL=0 HIGH=0", `FACTORY_ACCEPTANCE_CANDIDATE: ${CANDIDATE.commit} ${CANDIDATE.tree} ${CANDIDATE.fingerprint}`]);
    const reading = parseAcceptanceVerdict(doubled);
    assert.equal(reading.kind, "NO_VERDICT");
  });

  it("REFUSES a verdict with no candidate binding", () => {
    const unbound = text(["VERDICT: PASS", "Safe to commit: YES", "FACTORY_ACCEPTANCE_COUNTS: CRITICAL=0 HIGH=0"]);
    const reading = parseAcceptanceVerdict(unbound);
    assert.equal(reading.kind, "NO_VERDICT");
    if (reading.kind !== "NO_VERDICT") throw new Error("unreachable");
    assert.match(reading.reason, /FACTORY_ACCEPTANCE_CANDIDATE/);
  });

  it("REFUSES a verdict with no counts, rather than assuming zero", () => {
    const uncounted = text(["VERDICT: PASS", "Safe to commit: YES", `FACTORY_ACCEPTANCE_CANDIDATE: ${CANDIDATE.commit} ${CANDIDATE.tree} ${CANDIDATE.fingerprint}`]);
    assert.equal(parseAcceptanceVerdict(uncounted).kind, "NO_VERDICT");
  });

  it("REFUSES a word that is not one of the three verdicts", () => {
    const invented = WELL_FORMED.replace("VERDICT: PASS", "VERDICT: LOOKS_FINE_TO_ME");
    const reading = parseAcceptanceVerdict(invented);
    assert.equal(reading.kind, "NO_VERDICT");
    if (reading.kind !== "NO_VERDICT") throw new Error("unreachable");
    assert.match(reading.reason, /LOOKS_FINE_TO_ME/);
  });

  it("REFUSES anything but YES or NO for safe-to-commit", () => {
    for (const word of ["yes", "Yes", "PROBABLY", "YES, with notes"]) {
      const reading = parseAcceptanceVerdict(WELL_FORMED.replace("Safe to commit: YES", `Safe to commit: ${word}`));
      assert.equal(reading.kind, "NO_VERDICT", `${word} was accepted`);
    }
  });

  it("does not find a verdict in prose that merely contains the word", () => {
    const prose = text([
      "The tests PASS and I would be inclined to say Safe to commit: YES,",
      "but the verdict tag is missing entirely.",
    ]);
    assert.equal(parseAcceptanceVerdict(prose).kind, "NO_VERDICT");
  });
});

describe("TASK-018: what counts as accepted", () => {
  const base: AcceptanceOutcome = {
    verdict: "PASS",
    critical: 0,
    high: 0,
    safeToCommit: true,
    candidate: { ...CANDIDATE },
  };

  it("accepts PASS and PASS_WITH_NON_BLOCKING_NOTES at zero and zero", () => {
    assert.equal(isAccepted(base), true);
    assert.equal(isAccepted({ ...base, verdict: "PASS_WITH_NON_BLOCKING_NOTES" }), true);
  });

  /** Each condition on its own, because ADR-0002 requires all of them. */
  it("refuses a PASS with any CRITICAL, any HIGH, or safe-to-commit NO", () => {
    assert.equal(isAccepted({ ...base, critical: 1 }), false);
    assert.equal(isAccepted({ ...base, high: 1 }), false);
    assert.equal(isAccepted({ ...base, safeToCommit: false }), false);
    assert.equal(isAccepted({ ...base, verdict: "CHANGES_REQUIRED" }), false);
  });
});

describe("TASK-018: a verdict is only about the tree it judged", () => {
  it("names which of the three facts disagrees", () => {
    assert.equal(bindingMismatch(CANDIDATE, { ...CANDIDATE }), undefined);
    assert.match(bindingMismatch(CANDIDATE, { ...CANDIDATE, commit: "041b4c3" }) ?? "", /041b4c3/);
    assert.match(bindingMismatch(CANDIDATE, { ...CANDIDATE, tree: "0000000" }) ?? "", /tree/);
    assert.match(bindingMismatch(CANDIDATE, { ...CANDIDATE, fingerprint: "0000000" }) ?? "", /fingerprint/);
  });
});

describe("TASK-018: reading a verdict off the filesystem", () => {
  const review = (source: string) => ({ reviewId: "r1", source, candidate: { ...CANDIDATE } });

  it("reports a file that does not exist as ABSENT", () => {
    const source = createFileVerdictSource();
    assert.equal(source.read(review(join(scratch, "never-written.txt"))).kind, "ABSENT");
  });

  it("reports an empty file as ABSENT — created is not written", () => {
    const path = join(scratch, "empty.txt");
    writeFileSync(path, "", "utf8");
    assert.equal(createFileVerdictSource().read(review(path)).kind, "ABSENT");
  });

  it("reads a real verdict back", () => {
    const path = join(scratch, "real.txt");
    writeFileSync(path, WELL_FORMED, "utf8");
    const reading = createFileVerdictSource().read(review(path));
    assert.equal(reading.kind, "VERDICT");
  });

  /**
   * A path resolved against the working directory would make the same durable
   * record read different files from different processes.
   */
  it("REFUSES a relative source path rather than resolving it", () => {
    const reading = createFileVerdictSource().read(review("review-lastmsg.txt"));
    assert.equal(reading.kind, "NO_VERDICT");
    if (reading.kind !== "NO_VERDICT") throw new Error("unreachable");
    assert.match(reading.reason, /absolute/);
  });

  it("REFUSES a directory, and never calls it absent", () => {
    const path = join(scratch, "a-directory");
    mkdirSync(path, { recursive: true });
    const reading = createFileVerdictSource().read(review(path));
    assert.equal(reading.kind, "NO_VERDICT");
  });
});
