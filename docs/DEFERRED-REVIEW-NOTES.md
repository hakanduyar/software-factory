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

## Tooling artifact: source files committed with the executable bit

Several files created during recent tasks are tracked as `100755` when they
should be `100644`: `src/governance/commitPolicy.ts`,
`tests/commitPolicy.test.ts`, `docs/governance/COMMIT-ATTRIBUTION-POLICY.md`,
`docs/DEFERRED-REVIEW-NOTES.md`, and both frozen task files
(`docs/tasks/TASK-013-*.md`, `docs/tasks/TASK-014-*.md`).

It is an artifact of writing them across the Windows/WSL filesystem boundary,
not a deliberate mode. It changes nothing about content, and the TASK-014 freeze
is unaffected — `git diff 968d7ea..HEAD -- docs/tasks/TASK-014-*` reports zero
lines, which covers mode as well as content.

Not corrected here because these are files outside the current task, and
normalising them would put unrelated changes into a review diff. Worth a single
`git update-index --chmod=-x` pass when something else is already touching them.

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

**THE CAUSE IS NOT IDENTIFIED, and this section says so because an earlier draft
of it did not.**

That draft asserted a mechanism — concurrent `npx tsc` invocations contending
for one npm cache — and proposed `./node_modules/.bin/tsc` as the fix. It was
committed before it was tested, and testing disproved it. Recording a confident
wrong mechanism is worse than recording an open question, because the next
person stops looking. It is the same defect class this repository has caught
three times under a different name: a claim a measurement has made false.

**What has been RULED OUT, each by measurement:**

- *Test-runner concurrency.* Serialising made no difference (5 failures, then 2).
  `--test-concurrency` gates FILES, and the subtests inside this one file already
  run sequentially, so there was no contention to remove.
- *Clock skew between `Date.now()` and file mtime.* The freshness check is
  `mtimeMs + 1000 >= buildStartedAt`, so drift would explain it exactly. Measured
  skew is 2–6 ms, and two real builds emitted the checker 3.0 s and 5.5 s AFTER
  their start — comfortably fresh.
- *A single fixture being unreliable.* Eight fixtures built and verified by hand,
  one at a time, outside the test runner: 8/8 green.
- *Contamination of the shared `node_modules`.* No hardlinked file inside it, and
  `tsc` still resolves to the real 5.9.3.

**What CORRELATES but does not explain it.** The file leaves its fixture
directories behind: 934 had accumulated under `/tmp`, and roughly 58 more appear
per run, so its `after()` cleanup is not keeping up. Clearing them produced a
110/110 run — and the very next run failed again with 58 present. So the
leftovers are at most a contributing factor, not the cause, and saying otherwise
would repeat the mistake above.

**What is certain** is the failing check: `scripts/verify.mjs` refuses when the
freshly built checker's mtime is more than a second older than the build start.
The build exits zero and prints nothing, so the compiler is not reporting an
error — the emitted artifact simply does not look new. Anyone picking this up
should start by instrumenting that one comparison inside a failing fixture
rather than by changing how the compiler is invoked.

**Why this is not fixed here.** It is a defect in the verification harness's own
tests, not in TASK-014, and the standing instruction is not to divert the
pipeline into unrelated cleanup. It is recorded rather than absorbed because a
verification that fails intermittently for reasons unrelated to the code is a
C3 problem: it trains a reader to retry until green, which is exactly how a real
regression gets waved through. The discipline that makes retrying defensible
here is that every failure ever observed has been in this ONE file, and is
nameable in advance.

## Mutation-harness versioning (parallel structural audit, TASK-015 round 9)

The mutation harness that produces this branch's kill/survive evidence lives in
session scratchpad files, outside the repository. After it silently corrupted a
source file in round 8 (multi-edit mutations re-captured mutated text as the
baseline), it was hardened: run-start byte+SHA-256 baselines, hash-verified
restores, and a hard abort on any mismatch. What remains open:

- the harness is not versioned in the repository, so its evidence is not
  reproducible from the repo alone (a C8 gap);
- older, still-buggy variants sit beside it in the scratchpad and nothing
  prevents their reuse;
- there is no committed regression test replaying the two-edits-one-file
  corruption.

The fix is a `scripts/mutation/` harness with a self-test, reviewed under its
own criteria. Deferred rather than folded into TASK-015, whose frozen scope is
multi-resource authorization, not evidence tooling.
