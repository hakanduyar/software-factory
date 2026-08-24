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

> AC-2 and AC-4 were amended once, by explicit human authorisation under
> ADR-0002, because they were demonstrably contradictory as first frozen. The
> reasoning, the evidence and the scope of that authorisation are recorded in
> "Human-authorised criteria correction" below. Every other criterion stands as
> originally frozen, and the freeze rule is unchanged: these may not be edited to
> fit an implementation.

**AC-1.** Test discovery is derived from source test files, not from a glob over
generated output.

**AC-2.** *(amended — see "Human-authorised criteria correction" below.)* If the
initial artifact audit finds a compiled test artifact with no corresponding
source file, verification names the orphan and never executes it. The initial
generated state is treated as invalid: the canonical build output is safely
discarded and recreated, the tree is rebuilt from source, and a complete
re-audit runs **within the same invocation**.

Verification FAILS if the orphan or any resulting inconsistency remains after
that clean rebuild, or if safe cleanup, rebuild or re-audit cannot be completed.
If the clean rebuild produces a fully consistent tree and every other
verification requirement passes, the same invocation may complete successfully.

**AC-3.** A source test file with no compiled counterpart causes verification to
FAIL, so a partial or failed build cannot masquerade as a passing run with fewer
tests.

**AC-4.** *(amended — see "Human-authorised criteria correction" below.)*
Verification is branch-clean BY CONSTRUCTION. For a source-valid tree whose
generated output contains only stale artifacts left by another branch, a single
invocation converges to the same final pass/fail outcome, and an equivalent
verified generated state, as a freshly cloned tree.

Stale artifacts that are detected are reported and are never executed. Safe
cleanup, rebuild and final re-audit happen automatically inside that same
invocation: no human re-run or other manual recovery step may be required.

"The same result" means the same FINAL outcome and an equivalent final generated
state — not byte-identical diagnostics. A contaminated tree is expected to report
that stale artifacts were found and removed; a fresh clone has nothing stale to
report. Contamination that does NOT cleanly converge still fails closed.

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

## Human-authorised criteria correction (AC-2 and AC-4)

Status: authorised by Hakan Duyar, in-session, under ADR-0002. Scope: AC-2 and
AC-4 of this task only.

**AC-2 and AC-4 were empirically contradictory as originally frozen.** AC-2
required an orphan to make verification FAIL; AC-4 required a tree carrying
another branch's artifacts to yield the freshly-cloned result with no human step.
A branch switch generally leaves orphans, so the two criteria demanded opposite
outcomes for the same tree, and no implementation could satisfy both.

This was not inferred from prose. Two independent review rounds demonstrated it
from opposite directions:

- Round 11 reviewed an implementation that satisfied AC-2, and the AC-4 breach
  was reproduced empirically: with a planted orphan, a single `npm test` exited 1
  saying "Re-run to verify a clean tree", while a fresh clone passed immediately.
- Round 12 reviewed an implementation that satisfied AC-4 and recorded, on the
  record, that it weakened AC-2.

Remediation could not close both, because closing either one re-opened the other.
`CLAUDE.md` requires a requirements conflict to be reported rather than silently
resolved, and ADR-0002 lists weakening acceptance criteria as HUMAN-ONLY without
exception. The conflict was therefore escalated rather than decided by the
implementer.

**The human decision was explicit reconciliation of both criteria**, amending each
to state the agreed behaviour rather than choosing a winner. The amendment
preserves the original security intent exactly:

- stale artifacts are still reported, and still never executed;
- they must still disappear after a clean rebuild;
- anything that survives the rebuild, and any failure of cleanup, rebuild or
  re-audit, still fails closed.

And it preserves unattended operation, which is the property this task exists to
create: a valid source tree does not require a second human invocation merely
because generated output from another branch happened to be present. An
`rm -rf dist` typed by whoever remembers is the control this task set out to
abolish, and a mandatory second `npm test` is the same control wearing a
different hat.

**This is a human-authorised requirements correction, not an implementer
weakening acceptance criteria.** No other criterion, and no constitutional or
ADR-0002 provision, is changed by it.

## Verification plan

- Unit: orphan detection, missing detection, and the path-safety guard, driven by
  fixtures rather than the real tree.
- Real: plant an orphan `.test.js` in `dist/tests/`, run verification ONCE, and
  observe it name the orphan, clean, rebuild, re-audit and converge — then a case
  whose inconsistency survives the rebuild, and observe it fail with the
  surviving problem named.
- Negative control: delete each check in turn and confirm its regression fails.
- Safety: assert the clean guard refuses the repository root, a path outside the
  repository, and `src/`.

## Relationship to other work

Independent of TASK-008 and TASK-009 in content, but **it must be accepted and
integrated before any further autonomous verification is relied upon**, because
it is the instrument those verifications are measured with. TASK-009's own
review ran against a manually cleaned build, so that result stands on its own;
everything after this point uses the fixed harness.
