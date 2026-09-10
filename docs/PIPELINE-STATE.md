# Pipeline state

Where the autonomous review/remediation loop stands, recorded here rather than
left in whatever conversation happened to be open. Written 2026-08-27,
updated 2026-09-10.

## Where this stands — 2026-09-10

`TASK-017` (`CLEAN_ROOM_CI`) is ACCEPTED and INTEGRATED. `main` was
fast-forwarded from `665bc35` to `d124e1b`; nothing was force-pushed and no
history was rewritten, and `main`'s tree was proven equal to the reviewed tree
before the push.

| Fact | Value |
|---|---|
| Candidate reviewed | `d124e1b` on `feat/clean-room-ci` |
| Tree | `bd7dbaeb8180429ebcc53d0628773ca4b30b497b`, unchanged across the review |
| Frozen criteria | `docs/tasks/TASK-017-clean-room-ci.md` at `c287a42`, object `563d4cb` |
| Verdict | `PASS_WITH_NON_BLOCKING_NOTES`, `Safe to commit: YES`, CRITICAL 0, HIGH 0 |
| Reviewer | Codex CLI, `gpt-5.6-luna`, effort `xhigh`, fresh session, round 24 |
| Suite | 2524 pass, 0 fail |
| Strict AC-12 probe | 2513 pass, 0 fail, 11 expected `unshare` skips |
| Mutation set | 94 KILLED, 0 survived, 0 unmeasured, both closing proofs present |

Twenty-four rounds. The deliverable took eight; the other sixteen were spent on
the machinery that proves the deliverable, and round 23 ended with an owner
decision to REMOVE the "canary" rather than harden it an eighth time. Every
version of it asked a child process to attest to its own honesty, and anything
that child can produce it can fake. The reviewer was asked directly whether the
removal took away a property `AC-1`–`AC-12` requires and answered that it did
not: it removed an optional, repeatedly forgeable self-attestation surface, and
`AC-11` rests where it always did, on the out-of-process mutation harness.
`L-19` now says so in the register.

### What comes next, and why

`DURABLE_ORCHESTRATION` (`docs/tasks/TASK-018-durable-orchestration.md`),
PROPOSED and awaiting `PLAN_APPROVAL`. It is placed ahead of model
qualification and `MEASURED_MODEL_ROUTER` by owner instruction.

The reason is in the twenty-four rounds themselves. The Factory's DURABLE state
is well defended and TASK-008 and TASK-012 defend it; the state of work IN
FLIGHT lived in process memory, ad-hoc files and scratchpad scripts, and was
lost whenever anything died. A finished review sat unnoticed for hours because
nothing emitted a completion event. Work was reported as running three times
when no process had been started. A killed mutation run left the tree poisoned
twice. Measuring models is worth little while the thing invoking them cannot
survive a restart.

Note that TASK-018 cannot simply be appended to the roadmap catalog: `order` and
`dependsOn` are reconciled DEFINITION fields, so renumbering the items after it
would make an existing installation refuse its own persisted roadmap at startup.
`DEFAULT_ROADMAP` was therefore left untouched, and the choice between appending
at the end and introducing a declared catalog upgrade belongs to planning. The
task file states both options and picks neither.

## Reviewer quota: probe, do not read the reset time

The independent reviewer (Codex CLI, `gpt-5.6-luna`, effort `xhigh`) exhausts its
quota regularly, and there appear to be two ceilings: a short rolling one that
resets in a few hours, and a weekly one.

The reported reset time is not evidence. On 2026-08-27 a refusal named
"Sep 1st, 2026 5:43 PM" and the reviewer was available again the same evening;
another the same night named a time three hours out and was accurate. Recording
the first as fact would have idled the pipeline for five days over nothing.

**Probe instead.** One read-only call answers the only question that matters.
`scratchpad/review_scheduler5.sh` does it on a five-minute loop and runs the
queued reviews the moment it succeeds — which is how every queue here has
eventually run unattended.

Not worked around, and this stands whenever the quota is genuinely out:

- Buying credits or upgrading is a purchase. `AUTONOMOUS_SPEND_LIMIT = 0`.
- No alternative reviewer exists on this machine (`gemini`, `ollama`,
  `opencode` are all absent). Installing a weaker local model and letting it
  stand in for the configured acceptance reviewer would be weakening reviewer
  independence to manufacture progress. An ADDITIONAL reviewer could only help;
  a SUBSTITUTE one is a different decision and belongs to the user.

While the quota is out, ADR-0002 condition 3 cannot be satisfied and **no branch
may be integrated**. That is the gate working, not a failure.

## Branches — INTEGRATED 2026-08-28

Both branches reached a passing independent verdict and were integrated into
`main` at `f712408` under ADR-0002. Nothing was force-pushed and no history was
rewritten; `main` was fast-forwarded to an integration branch that had already
passed the full suite, so it never sat half-merged.

| Branch | Head reviewed | Verdict | State |
|---|---|---|---|
| `feat/executor-isolation` | `507e30e` | PASS, safe to commit YES, 1651/1651 | Merged as `b73da45` |
| `fix/verify-path-equivalence` | `fd626a5` | PASS_WITH_NON_BLOCKING_NOTES, safe to commit YES, 1511/1511 | Merged as `f712408` |
| `feat/state-integrity-rebased` | `c4e4054` | — | An ancestor of `feat/executor-isolation`; never reviewed separately. |
| `docs/known-limitations` | `d1595f2` | — | The limitations register and this file; an ancestor of both. |
| `main` | `f712408` | — | 1721/1721 on the merged tree, verifier reports it tree-consistent. |

The merged tree was tested before `main` moved, because neither reviewer saw it:
1721 = `main`'s base plus both branches' additions, with nothing lost to the
merge. The one merge conflict was in L-8 of the limitations register, where both
branches had appended; it was resolved as a union, since this file records
defects and dropping either side deletes the record of one.

Review rounds to acceptance: seventeen on the supervisor work, fourteen on the
verification harness. Every round found something real, and the later rounds
almost all found a test of MINE that was passing for the wrong reason — one of
them passing BECAUSE of the defect being reported.

## What is unblocked now

`EXECUTOR_WIRING` required `EXECUTOR_ISOLATION` and `STATE_INTEGRITY` to be both
accepted AND integrated. Both now are, so it is permissible to start.

The roadmap rows for those two stay `PENDING`, deliberately, and this is not an
oversight to tidy up later. `unprovenCompletion` in
`src/supervision/roadmapCatalog.ts` refuses a `DONE` item whose class needs AI
when durable provenance holds no record of anything running on it, and it rests
on the invariant that every item this build SHIPS starts `PENDING`. Shipping
`DONE` rows for work done by the bootstrap engineer rather than by the
supervisor's own executor would make every fresh installation fail that check on
first run. The roadmap describes what the SUPERVISOR has executed; it is not a
changelog of the bootstrap.

## Why executor-isolation now contains state-integrity

TASK-011's round-9 review raised one blocking finding that was not about the
executor at all: a resource that CHECKPOINTED work was missing from the
append-only history, so the C4 exclusion walk could not exclude it and it
reviewed work it had partly authored. The reviewer said the defect is in
pre-existing supervisor logic and that it is a system-level acceptance failure
regardless.

STATE_INTEGRITY is the task that owns lineage and already fixes it, so the
branches were merged rather than the fix copied: one implementation instead of
two that can drift, `EXECUTOR_WIRING` already depends on both so they were
always arriving together, and one review of the combined tree costs half of what
two reviews of the same content would — which matters while the quota is the
scarce resource.

## To resume

Both queued reviews named here are DONE and their branches are integrated; the
steps below are the standing procedure, not a work list. Round-15 review found
this section still naming `8a34e5e` and `8f4985e` as pending after the table
above had been updated to say they were merged — a document contradicting
itself, which for an autonomous pipeline reading its own notes is a live hazard
rather than untidiness.

1. PROBE the quota; do not read the reset time it printed.
2. Run any queued review. The prompt names the exact commit, and the runner
   fingerprints the repository before and after so a tree that moved during a
   review is visible rather than assumed away.
3. On CHANGES_REQUIRED: remediate, verify, freeze, review again.
4. On PASS with zero CRITICAL/HIGH and an explicit "Safe to commit: YES": run
   the ADR-0002 gate (`scratchpad/adr0002_gate.sh`) before integrating. It
   reports and never acts, and it says UNVERIFIABLE-HERE for the conditions a
   machine cannot check rather than scoring them as passes.

Nothing is queued for review. `fix/review-notes-r14` named here previously is
long since answered, and every branch this file lists is integrated.

`EXECUTOR_WIRING`, `GITHUB_ORCHESTRATION` and `CLEAN_ROOM_CI` are all accepted
and integrated. `LOCAL_24_7_RUNTIME` remains `PLATFORM_CAPABILITY_BLOCKED`. The
next review this pipeline runs is TASK-018's, and it cannot start until the
owner freezes that task's criteria.

## One finding answered with a limit rather than a fix

Round-10 review showed that deleting an item's implementer history, its
`lastRunConfig`, the provenance chain and the anchor lets the resource that
reviewed it review it again. It is not closed, and the reasoning is in L-4 of
`docs/KNOWN-LIMITATIONS.md` together with the survivors that were tried and
rejected — `lastSuccessAt` is written by a successful probe, `attempts` by a
claim that may never have launched, `detail` is free text.

The round-11 prompt asks the reviewer to JUDGE that answer rather than take it.
If a survivor exists that was dismissed too quickly, it is blocking again. That
question is open and should not be treated as settled.
