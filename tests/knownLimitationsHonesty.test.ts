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
   * NAMED ENTRIES, not a count (round-3 review, HIGH 5).
   *
   * Requiring "at least two entries mention the clean room" was satisfied by
   * L-2, L-4 and L-9 — so removing every mention from L-10 and L-11, the two
   * entries the clean room is actually ABOUT, left all five cases green. A
   * premise check that any two strangers can satisfy is not a premise check.
   */
  for (const entry of ["L-10", "L-11"]) {
    it(`requires ${entry} itself to discuss the clean room`, () => {
      const found = entries().find(([heading]) => heading.startsWith(entry));

      assert.ok(found !== undefined, `${entry} is missing from the register`);
      assert.match(
        found?.[1] ?? "",
        /CLEAN_ROOM_CI|clean room/i,
        `${entry} does not discuss the clean room, so the honesty rules below never examine it`,
      );
    });
  }

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

      /**
       * AND THE PROSE, because the structural rule alone is bypassable
       * (round-2 review, HIGH 6). Adding the plain sentence "The clean room
       * closes this limitation." to an entry left all five honesty cases
       * green: it is not a `What would close it` lead-in, so nothing looked at
       * it.
       *
       * This rule is narrow on purpose, and narrower than the two attempts
       * that failed before it. It matches the clean room as the SUBJECT of a
       * closure verb — "the clean room closes", "CLEAN_ROOM_CI closed" — with
       * at most two words between, and allows an intervening negation, which
       * is the honest form. It does not try to understand the sentence.
       * "fail-closed verification" has no subject before the verb and does not
       * match; "a clean room does not close this" does.
       */
      const flatBody = body.replace(/\s+/g, " ");
      /**
       * THE VERB AND THE OBJECT TOGETHER (round-4 review, HIGH 3).
       *
       * Matching only `clos(e|es|ed)` let "CLEAN_ROOM_CI eliminates this
       * limitation entirely" through. Broadening the verbs alone would fire on
       * honest sentences — L-10 says the clean room "removes the environment
       * this attack needs", which is true — so the OBJECT decides: eliminating
       * a LIMITATION is a closure claim, removing an ENVIRONMENT is not.
       */
      /**
       * A DENYLIST OVER ENGLISH, AND IT IS ONE ON PURPOSE.
       *
       * Round 4 found "eliminates", round 8 found "ends", round 18 found
       * "seals". There are more synonyms than there are review rounds, and a
       * closed grammar — the move that fixed the YAML reader — has no
       * equivalent here: the admissible set for prose is "anything a person
       * might write", so nothing can be closed over.
       *
       * The pattern of the misses is worth more than the list. Each one was a
       * verb I had not thought of while writing entries I believed were
       * honest, which is the point: this catches a claim I did not notice
       * making, and it cannot catch one nobody has phrased yet. It is a
       * tripwire, not a proof, and L-14 says so.
       *
       * So this catches the common phrasings and NOT every possible one, which
       * is worth stating plainly rather than leaving a reader to infer that a
       * passing suite means the register is honest. What actually keeps these
       * entries honest is a person reading them; this reduces how often that
       * person has to catch the obvious cases.
       */
      const CLOSURE_VERB = "(?:clos(?:e|es|ed)|eliminat(?:e|es|ed)|remov(?:e|es|ed)|solv(?:e|es|ed)|fix(?:es|ed)?|resolv(?:e|es|ed)|address(?:es|ed)?|end(?:s|ed)?|obviat(?:e|es|ed)|negat(?:e|es|ed)|cur(?:e|es|ed)|prevent(?:s|ed)?|stop(?:s|ped)?|seal(?:s|ed)?|plug(?:s|ged)?|settl(?:e|es|ed)|neutralis(?:e|es|ed)|neutraliz(?:e|es|ed))";
      const CLOSED_THING = "(?:this|the|that)\\s+(?:limitation|entry|gap|defect|class|problem|issue|vector)";
      for (const match of flatBody.matchAll(
        new RegExp(`(clean room|CLEAN_ROOM_CI)\\s+((?:\\w+\\s+){0,3}?)${CLOSURE_VERB}\\s+((?:\\w+\\s+){0,2}?)${CLOSED_THING}`, "gi"),
      )) {
        const between = `${match[2] ?? ""} ${match[3] ?? ""}`;
        if (/\b(not|never|cannot|nor)\b/i.test(between)) continue;
        offenders.push(`${heading}: …${match[0]}…`);
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
