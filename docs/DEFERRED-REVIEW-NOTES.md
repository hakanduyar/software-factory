# Deferred review notes

Non-blocking notes from accepted reviews, preserved here rather than pursued as
a cleanup branch. They are addressed when they become a prerequisite for the
current task, or when the dependency graph makes them the correct next work.

A note recorded here has been judged NON-BLOCKING by an independent reviewer on
an accepted verdict. That is the only reason it is deferred rather than fixed.

## From round-10 of the note-remediation branch (verdict: PASS_WITH_NON_BLOCKING_NOTES, main @ 8f0c240)

1. **A false claim in round-23 comments.** `scripts/verify.mjs` and the round-23
   test say "the compiler [was] reading from outside"; the payload was executed
   by a runtime `require()`, not by the compiler. The predicate defect was real,
   but this sentence describes the wrong mechanism. Shape-3 defect, mine.

2. **A stage-attribution inaccuracy in a fixture.** The unreadable-output fixture
   plants the directory before invoking the verifier, so the PRE-build check
   refuses it; the later build-created fixture is what actually tests the
   after-building stage. The test is not wrong, its framing is.

3. **A count discrepancy.** Documentation says 107 harness tests; the source
   contains 108 runtime cases (106 static plus two two-item loops).

4. **The runtime-`require` boundary needs documenting as accepted.** A source
   test requiring `/tmp/payload.cjs` produces `status=0` and an execution
   marker. The reviewer judged this acceptable under the documented threat
   model — it is an explicit, visible source dependency, and malicious
   source/Node/PATH control is already out of scope. It should be written into
   the threat model as an accepted boundary if the "and NOTHING ELSE" invariant
   in the header is intended literally, because as written the header claims
   more than the code delivers.

## Standing masked-guard record

Five guard pairs are covered but not individually pinned; they are recorded in
`docs/KNOWN-LIMITATIONS.md` L-8 and excluded from TASK-013 AC-5's
"individually pinned" inventory. That is a deliberate accuracy, not an omission.
