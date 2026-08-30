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

## Found during TASK-014 round-2 remediation (not a review note; an operational finding)

**`tests/verificationHarnessEndToEnd.test.ts` is FLAKY on this host, and the
flake is in the fixture build rather than in any guard it tests.**

Measured, not inferred:

- Three consecutive runs of that one file produced three DIFFERENT failure sets
  — 4 failed, then 1 failed, then a different 3.
- The same file on a CLEAN worktree at `0fa20fd`, with none of TASK-014's
  round-2 changes present, failed with a third set again. So it is not caused by
  the remediation.
- Every failure reduces to one message: `verification refused: the build did not
  emit the verification checker; refusing to audit this tree using a stale copy
  of the auditor`. Several fail at the CONTROL stage, before the case has planted
  anything — the fixture simply did not build.
- No OOM kill in the kernel log; 6.4 GB available and 940 GB free at rest.

**The mechanism.** Each fixture repository symlinks this repository's
`node_modules` and then runs `scripts/verify.mjs`, which shells
`execFileSync("npx", ["tsc", ...])` up to three times per fixture (build,
`--showConfig`, `--listFilesOnly`). One file builds roughly thirty such
fixtures, `node --test` runs files concurrently, and every one of those `npx`
invocations contends for the same shared npm cache and `_npx` directory. When
one loses, `tsc` never runs, `dist/` is empty, and the harness correctly refuses
a tree it could not build.

**Why this is not fixed here.** It is a defect in the verification harness's own
tests, not in TASK-014, and the standing instruction is not to divert the
pipeline into unrelated cleanup. It is recorded rather than absorbed because a
verification that fails intermittently for reasons unrelated to the code is a
C3 problem: it trains a reader to retry until green, which is exactly how a real
regression gets waved through.

**The likely fix, for whoever picks it up:** invoke the compiler the way the
repository already does elsewhere after hitting this class of problem —
`./node_modules/.bin/tsc` — instead of `npx tsc`. That removes the shared-cache
contention without weakening any guard, since the binary resolved is the same
one. It is a change to `scripts/verify.mjs`, so it needs its own frozen criteria
and its own independent review.
