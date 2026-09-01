/**
 * TASK-017 AC-10: the limitations register may not claim a closure it does not
 * have.
 *
 * The round-1 review found L-10 and L-11 contradicting themselves — appended
 * notes saying the clean room does NOT close them, above older sentences
 * promising `CLEAN_ROOM_CI` "would close it" and "closes the broader class".
 * Both cannot be true, and a reader meeting the optimistic one first stops
 * reading.
 *
 * The optimistic sentences were written BEFORE the clean room existed, which is
 * when a prediction is cheapest to make and hardest to check. This test exists
 * because that is a recurring shape rather than one mistake: a register that
 * describes a future fix in the present tense is a register that will be wrong
 * exactly when someone relies on it.
 *
 * WHAT IT ASSERTS, narrowly: no entry may pair `CLEAN_ROOM_CI` with a bare
 * claim of closure. Saying a clean room reduces, removes the environment for,
 * or has nothing to act on is fine — those are true. "Closes" is not.
 *
 * Offline: reads one file.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REGISTER = readFileSync(join(process.cwd(), "docs/KNOWN-LIMITATIONS.md"), "utf8");

/** Each `## L-n` entry, so a claim can be attributed to the entry making it. */
function entries(): readonly (readonly [string, string])[] {
  const found: (readonly [string, string])[] = [];
  const parts = REGISTER.split(/^## /m);
  for (const part of parts.slice(1)) {
    const heading = (part.split("\n")[0] ?? "").trim();
    found.push([heading, part]);
  }
  return found;
}

describe("TASK-017 AC-10: no entry claims a closure the clean room does not deliver", () => {
  /**
   * The premise. If the register stopped mentioning the clean room the test
   * below would pass vacuously, so the mention is asserted first.
   */
  it("discusses the clean room in the entries it is relevant to", () => {
    const mentioning = entries().filter(([, body]) => /CLEAN_ROOM_CI|clean room/i.test(body));

    assert.ok(mentioning.length >= 2, `expected L-10 and L-11 to discuss it, found ${mentioning.length}`);
  });

  /**
   * "Closes"/"closed"/"would close" within a sentence that also names the clean
   * room. Deliberately sentence-scoped: an entry may legitimately say a
   * DIFFERENT thing was closed, and may say the clean room does NOT close this
   * one — which is why the negations are excluded rather than the word banned.
   */
  it("pairs no closure verb with the clean room", () => {
    const offenders: string[] = [];
    for (const [heading, body] of entries()) {
      /**
       * PARAGRAPHS, not sentences.
       *
       * Sentence scoping split on `:` and so separated "What would close it:"
       * from the `CLEAN_ROOM_CI` that answered it — the claim and its subject
       * landed in different fragments and neither tripped. My own mutation
       * harness caught that: restoring the overclaimed heading survived a test
       * written to forbid exactly it.
       *
       * A paragraph is the unit a reader actually takes the claim from, so it
       * is the unit this checks.
       */
      /**
       * STRUCTURAL, NOT LINGUISTIC — and the two failed attempts are the
       * argument for it.
       *
       * Sentence scoping split "What would close it:" from the answer that
       * followed. Paragraph scoping with a nearby-negation rule then fired on
       * "fail-closed verification" and on other entries' unrelated remedies,
       * and I was two iterations into writing a parser for English — the same
       * guessing machine this task refused to build for YAML.
       *
       * The register has its own convention: a bolded "What would close it"
       * lead-in introduces the remedy for that entry. So the rule is narrow and
       * checkable — that lead-in may not answer with the clean room, because
       * the clean room does not close anything. Prose elsewhere is left alone,
       * which is right: prose is where the honest nuance lives.
       */
      for (const paragraph of body.split(/\n\s*\n/)) {
        const flat = paragraph.replace(/\s+/g, " ");
        const lead = /^\*\*What would ([^*]*?):?\*\*(.*)$/i.exec(flat.trim());
        if (lead === null) continue;
        const promise = lead[1] ?? "";
        const answer = lead[2] ?? "";
        // Only closure promises are in scope; "what would REDUCE it" is fine.
        if (!/\bclos\w+/i.test(promise)) continue;
        // A lead-in that explicitly denies closure is the honest form.
        if (/\bnot\s+clos\w+/i.test(promise)) continue;
        // And it is the ANSWER that must not be the clean room — an entry may
        // mention it elsewhere in the same paragraph while answering with
        // something else entirely, which L-4 does.
        if (!/CLEAN_ROOM_CI|clean room/i.test(answer)) continue;
        offenders.push(`${heading}: ${flat.trim().slice(0, 140)}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `an entry claims the clean room closes something:\n  ${offenders.join("\n  ")}`,
    );
  });

  /**
   * And each entry that discusses the clean room must say what it does NOT do,
   * because omitting that is how the contradiction got in: the appended note
   * was honest and the older sentence was not, and nothing required them to
   * agree.
   */
  it("states the limits of the clean room wherever it is discussed", () => {
    for (const [heading, body] of entries()) {
      if (!/clean room/i.test(body)) continue;
      /**
       * A LIMIT, not one particular sentence.
       *
       * The first version demanded "local runs are unchanged" everywhere, which
       * is the right limit for L-9/L-10/L-11 and the wrong one for L-4 — where
       * what matters is that a clean room is not a witness and holds no key.
       * Requiring the fixed phrase there would have added filler that says
       * nothing, which is how registers start reading as boilerplate.
       *
       * `\s+` throughout because these phrases wrap across lines in a
       * hand-written document.
       */
      assert.match(
        body,
        /local runs?\s+(are|is)\s+(entirely\s+|completely\s+)?un(changed|affected)|untouched\s+by\s+it|is\s+not\s+(that|a\s+witness)|witnesses\s+nothing/i,
        `${heading} discusses the clean room without stating any limit of it`,
      );
    }
  });

  /** L-10 and L-11 must still be OPEN, since nothing has closed them. */
  for (const entry of ["L-10", "L-11"]) {
    it(`keeps ${entry} open`, () => {
      const found = entries().find(([heading]) => heading.startsWith(entry));

      assert.ok(found !== undefined, `${entry} is missing from the register`);
      assert.ok(
        !/\*\*Status:\*\*\s*CLOSED/i.test(found?.[1] ?? ""),
        `${entry} is marked CLOSED, but nothing has closed it`,
      );
    });
  }
});
