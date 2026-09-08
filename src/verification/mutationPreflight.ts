/**
 * MUTATION PREFLIGHT — a full run must never be the first thing that discovers
 * a mutation definition is invalid.
 *
 * Rounds 21 and 22 each ended at the chain's fail-closed gate after more than
 * three hours, and every cause was a broken DEFINITION rather than a defect in
 * the code under test: an anchor that matched twice, an anchor that matched
 * nothing after the code it named was rewritten, and a weakened form that did
 * not compile. Roughly ten hours of machine time to learn things a few
 * milliseconds of string comparison can establish.
 *
 * The classification here is pure so it can be tested directly. Reading files,
 * copying trees and invoking a compiler belong to `scripts/preflight.mjs`; this
 * module decides what the gathered facts mean.
 *
 * IT FAILS CLOSED. A fact the caller could not gather is `undefined`, and every
 * check treats `undefined` as INVALID rather than as "nothing to object to" —
 * the empty-set-authority shape this repository has found five times.
 */

/** What the driver measured about one mutation. */
export interface MutationFacts {
  readonly id: string;
  /** Repository-relative path the mutation edits. */
  readonly target: string;
  /** The anchor text the harness will search for. */
  readonly from: string;
  /** The text it will be replaced with. */
  readonly to: string;
  /** Occurrences of `from` in the target file. `undefined` if unreadable. */
  readonly anchorOccurrences: number | undefined;
  /**
   * Set ONLY when the mutation edits the file its own definitions live in.
   * `undefined` means it does not, which is the ordinary case and not a fault.
   *
   * The first version of this check counted the anchor in the definition file
   * for EVERY mutation and demanded exactly one, which flagged thirty sound
   * definitions: an anchor may appear in several definitions, and one
   * mutation's replacement may contain another's anchor. What actually breaks a
   * run is an anchor that matches both the code and the text naming it, and
   * that can only happen when the two are the same file.
   */
  readonly selfReferentialOccurrences: number | undefined;
  /** Did applying it to a scratch copy actually change the bytes? */
  readonly changedBytes: number | undefined;
  /**
   * Did the mutated scratch copy still parse/typecheck? `undefined` when the
   * driver could not check. `false` is invalid UNLESS the mutation exists to
   * prove invalid source is rejected, which none here do.
   */
  readonly compiles: boolean | undefined;
  /** Compiled artifacts the mutation says it will run. */
  readonly namedTests: readonly string[];
  /** Which of those the driver could not find on disk. */
  readonly missingTests: readonly string[];
  /** Does a test with the `expect` name exist in the sources behind them? */
  readonly namedTestFound: boolean | undefined;
  /** The `expect` string itself, reported so a stale one is readable. */
  readonly expect: string;
}

export type PreflightResult = "VALID" | "INVALID";

export interface PreflightVerdict {
  readonly id: string;
  readonly result: PreflightResult;
  /** Empty when VALID; otherwise every reason, so one run reports all of them. */
  readonly reasons: readonly string[];
}

/**
 * Every reason a mutation is not measurable, gathered rather than short-circuited
 * so a single preflight tells the author everything wrong with the definition.
 */
export function classifyMutation(facts: MutationFacts): PreflightVerdict {
  const reasons: string[] = [];

  if (facts.from === facts.to) {
    reasons.push("its replacement is identical to its anchor, so it changes nothing");
  }
  if (facts.from.length === 0) {
    reasons.push("its anchor is empty, which matches everywhere");
  }

  if (facts.anchorOccurrences === undefined) {
    reasons.push(`${facts.target} could not be read, so the anchor could not be counted`);
  } else if (facts.anchorOccurrences === 0) {
    reasons.push(
      `its anchor does not occur in ${facts.target} — the code it names has been renamed or rewritten`,
    );
  } else if (facts.anchorOccurrences > 1) {
    reasons.push(
      `its anchor occurs ${facts.anchorOccurrences} times in ${facts.target}; the harness refuses anything but one`,
    );
  }

  /**
   * SELF-REFERENCE. When a mutation edits the harness itself, the anchor lives
   * both in the code and in the definition naming it, so it matches twice and
   * measures nothing. Reported separately from the count because the fix is
   * different: split the literal, rather than rewrite the anchor.
   */
  if (facts.selfReferentialOccurrences !== undefined && facts.selfReferentialOccurrences > 1) {
    reasons.push(
      `its anchor appears ${facts.selfReferentialOccurrences} times in the file it edits, which is the file its own ` +
        "definition lives in, so it also matches its own description; build the anchor by concatenation so the " +
        "whole text exists only in the code",
    );
  }

  if (facts.changedBytes === undefined) {
    reasons.push("it could not be applied to a scratch copy");
  } else if (facts.changedBytes === 0) {
    reasons.push("applying it to a scratch copy changed nothing");
  }

  if (facts.compiles === undefined) {
    reasons.push("the mutated scratch copy was never checked, so it may not build");
  } else if (!facts.compiles) {
    reasons.push(
      "the mutated form does not build, so the harness would report UNMEASURED rather than measuring the guard",
    );
  }

  if (facts.namedTests.length === 0) {
    reasons.push("it names no test to run");
  }
  for (const missing of facts.missingTests) {
    reasons.push(`it names ${missing}, which is not present`);
  }

  if (facts.namedTestFound === undefined) {
    reasons.push("the killing test could not be looked for");
  } else if (!facts.namedTestFound) {
    reasons.push(`no test matching ${JSON.stringify(facts.expect)} exists in the files it runs`);
  }

  return { id: facts.id, result: reasons.length === 0 ? "VALID" : "INVALID", reasons };
}

/** The whole selection. An empty one measures nothing and is refused. */
export function classifySelection(all: readonly MutationFacts[]): {
  readonly verdicts: readonly PreflightVerdict[];
  readonly ok: boolean;
  readonly summary: string;
} {
  if (all.length === 0) {
    return {
      verdicts: [],
      ok: false,
      summary: "preflight refused: the selection is empty, and a run that measures nothing must not report a result",
    };
  }
  const verdicts = all.map(classifyMutation);
  const invalid = verdicts.filter((verdict) => verdict.result === "INVALID");
  return {
    verdicts,
    ok: invalid.length === 0,
    summary:
      invalid.length === 0
        ? `preflight: ${verdicts.length} mutations, all VALID`
        : `preflight refused: ${invalid.length} of ${verdicts.length} mutations are not measurable`,
  };
}

/** Occurrences of `needle` in `haystack`, counted without regex escaping. */
export function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  return haystack.split(needle).length - 1;
}
