# Pipeline state

Where the autonomous review/remediation loop stands, recorded here rather than
left in whatever conversation happened to be open. Written 2026-08-27.

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

## Branches, all pushed and matching origin

| Branch | Head | State |
|---|---|---|
| `feat/executor-isolation` | `8a34e5e` | TASK-011 + TASK-008 + TASK-012 + register. Round-10 findings answered. Awaiting round 11. |
| `fix/verify-path-equivalence` | `8f4985e` | Verification harness. Round-10 findings answered. Awaiting round 11. |
| `feat/state-integrity-rebased` | `c4e4054` | An ancestor of `feat/executor-isolation`; not reviewed separately any more. |
| `docs/known-limitations` | `93c0653`+ | The limitations register and this file. Also an ancestor of the combined branch. |
| `main` | `0087787` | Untouched. |

Review rounds so far: the verification harness has had ten, the supervisor work
nine plus two on the combined tree. Every round has found something real, and
the last two rounds each found a test of mine that was passing for the wrong
reason — one of them passing BECAUSE of the defect being reported.

`main` has not moved. Every branch merges onto it cleanly, and pairwise.

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

1. PROBE the quota; do not read the reset time it printed.
2. Run the queued reviews. The prompts are written and the runner verifies the
   worktree is at the exact commit before launching:
   - `feat/executor-isolation` @ `8a34e5e` — one review of the combined tree.
   - `fix/verify-path-equivalence` @ `8f4985e` — round 11.
3. On CHANGES_REQUIRED: remediate, verify, freeze, review again.
4. On PASS with zero CRITICAL/HIGH and an explicit "Safe to commit: YES": run
   the ADR-0002 gate (`scratchpad/adr0002_gate.sh`) before integrating. It
   reports and never acts, and it says UNVERIFIABLE-HERE for the conditions a
   machine cannot check rather than scoring them as passes.

`EXECUTOR_WIRING` stays forbidden until both prerequisites are accepted AND
integrated. `LOCAL_24_7_RUNTIME` remains `PLATFORM_CAPABILITY_BLOCKED`.

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
