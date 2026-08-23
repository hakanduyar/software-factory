# TASK-010 — Verification artifact integrity

Status: acceptance criteria FROZEN before implementation (ADR-0002 condition 1).
Type: verification-infrastructure defect found in operation.

## The defect

`dist/` is gitignored and is **not** cleaned when git switches branches, while
`npm test` discovers tests by globbing `dist/tests/**/*.test.js`. So compiled
tests from one branch survive into another branch's test run.

Observed, not theorised: verifying the isolated `feat/durable-blocker-recording`
branch reported **1372 tests including `provenanceChain.test.js`** — a TASK-008
test whose source does not exist on that branch. It then FAILED, which is the
only reason it was noticed. Had the stale artifact merely passed, the branch
would have reported a higher pass count than it earned and nobody would have
looked.

This is worse than an ordinary bug, because it corrupts the instrument every
other correctness claim in this project depends on:

> **A branch can appear verified against tests and code it does not contain.**

Every ADR-0002 integration turns on "deterministic verification passes" and
"required regression verification passes". If discovery is contaminated, both
conditions can be satisfied by artifacts from somewhere else. Ten TASK-006
reviews were spent removing vacuous tests; a contaminated runner reintroduces the
same failure at the harness level, where no amount of careful test-writing
reaches it.

An `rm -rf dist` typed into a terminal is not a fix. It is a convention that
depends on whoever runs the command remembering — which is exactly the class of
control this codebase has repeatedly refused to accept elsewhere.

## Design direction

Two independent properties, because either alone leaves a gap:

1. **Discovery is driven by SOURCE.** The set of tests to run is derived from
   `tests/**/*.test.ts`, mapped to expected compiled paths — not from whatever
   happens to be lying in `dist/`. An orphan is then not discovered at all.

2. **Orphans are an ERROR, not merely ignored.** Compiled test files with no
   corresponding source indicate a stale tree, and the run fails loudly rather
   than quietly skipping them. Silence would leave the contaminated tree in place
   to confuse the next person.

Plus a deterministic clean before build, guarded so it can only ever remove the
configured build output.

## Acceptance criteria (FROZEN — may not be edited to fit the implementation)

**AC-1.** Test discovery is derived from source test files, not from a glob over
generated output.

**AC-2.** A compiled test artifact with no corresponding source file causes
verification to FAIL with a message naming the orphan — it is never silently
ignored and never executed.

**AC-3.** A source test file with no compiled counterpart causes verification to
FAIL, so a partial or failed build cannot masquerade as a passing run with fewer
tests.

**AC-4.** Verification is branch-clean BY CONSTRUCTION: running it immediately
after a branch switch, with another branch's artifacts present, yields the same
result as running it on a freshly cloned tree. No human step is required.

**AC-5.** The clean step can only ever remove the configured build output
directory. It refuses, with an error, if asked to remove the repository root,
anything outside the repository, or any path containing tracked source. Nothing
under `src/`, `tests/`, `docs/` or `.git/` may be removed, and no durable
Factory state (for example `.factory/`) may be touched.

**AC-6.** A permanent regression test reproduces the contamination: given a set
of source tests and a `dist` containing an extra compiled test, the checker
reports the orphan; given a missing compiled test, it reports that.

**AC-7.** That regression is proven non-vacuous by a deterministic negative
control: with the orphan/missing checks removed, the regression fails.

**AC-8.** The invariant is documented in the shared verification path itself, so
the reason survives without this conversation.

**AC-9.** `npm test` uses the corrected path, so the default command every human
and agent already runs is the fixed one. A correct-but-optional runner would
leave the defect in place for anyone who types the obvious thing.

**AC-10.** Existing behaviour preserved: the full suite still passes, and no
Factory control (financial gate, HUMAN-ONLY boundaries, C4, the
`STATE_INTEGRITY` + `EXECUTOR_ISOLATION` → `EXECUTOR_WIRING` ordering) is
weakened.

## Verification plan

- Unit: orphan detection, missing detection, and the path-safety guard, driven by
  fixtures rather than the real tree.
- Real: plant an orphan `.test.js` in `dist/tests/`, run verification, observe it
  fail; remove it, observe it pass.
- Negative control: delete each check in turn and confirm its regression fails.
- Safety: assert the clean guard refuses the repository root, a path outside the
  repository, and `src/`.

## Relationship to other work

Independent of TASK-008 and TASK-009 in content, but **it must be accepted and
integrated before any further autonomous verification is relied upon**, because
it is the instrument those verifications are measured with. TASK-009's own
review ran against a manually cleaned build, so that result stands on its own;
everything after this point uses the fixed harness.
