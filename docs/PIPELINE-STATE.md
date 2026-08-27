# Pipeline state

Where the autonomous review/remediation loop stands, recorded here rather than
left in whatever conversation happened to be open. Written 2026-08-27.

## Reviewer quota: do not trust the reset time it reports

The independent reviewer (Codex CLI, `gpt-5.6-luna`, effort `xhigh`) exhausts its
usage quota periodically. On 2026-08-27 it refused with "try again at Sep 1st,
2026 5:43 PM" — and was available again the same evening, roughly five days
early.

So the reported reset time is not evidence. **Probe rather than wait**: a
one-token read-only call answers the only question that matters, which is whether
a review can run right now. `scratchpad/review_scheduler2.sh` does exactly that
on a five-minute loop, and is how the earlier queue eventually ran unattended.

Not worked around, and this stands whenever the quota is genuinely out:

- Buying credits or upgrading is a purchase. `AUTONOMOUS_SPEND_LIMIT = 0`.
- No alternative reviewer exists on this machine (`gemini`, `ollama`,
  `opencode` are all absent). Installing a weaker local model and letting it
  stand in for the configured acceptance reviewer would be weakening reviewer
  independence to manufacture progress. An ADDITIONAL reviewer could only help;
  a SUBSTITUTE one is a different decision and belongs to the user.

While the quota is out, ADR-0002 condition 3 — an independent reviewer at PASS
or PASS_WITH_NON_BLOCKING_NOTES — cannot be satisfied, and **no branch may be
integrated**. That is the gate working, not a failure.

## Branches, all pushed and matching origin

| Branch | Head | State |
|---|---|---|
| `feat/executor-isolation` | `790b840` | TASK-011 + TASK-008 + TASK-012 + register. Round-9 findings remediated. Awaiting review. |
| `feat/state-integrity-rebased` | `c4e4054` | TASK-008 + TASK-012. Now an ancestor of the branch above. |
| `fix/verify-path-equivalence` | `88eaa8f` | Verification harness. Round-9 findings remediated; its round-10 review never started (quota). |
| `docs/known-limitations` | `d55deef` | The limitations register. Also an ancestor of `feat/executor-isolation`. |
| `main` | `0087787` | Untouched. |

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
   - `feat/executor-isolation` @ `790b840` — TASK-011 round 10, TASK-008 round
     10, TASK-012 round 2, as one review of the combined tree.
   - `fix/verify-path-equivalence` @ `88eaa8f` — round 10.
3. On CHANGES_REQUIRED: remediate, verify, freeze, review again.
4. On PASS with zero CRITICAL/HIGH and an explicit "Safe to commit: YES": run
   the ADR-0002 gate (`scratchpad/adr0002_gate.sh`) before integrating. It
   reports and never acts, and it says UNVERIFIABLE-HERE for the conditions a
   machine cannot check rather than scoring them as passes.

`EXECUTOR_WIRING` stays forbidden until both prerequisites are accepted AND
integrated. `LOCAL_24_7_RUNTIME` remains `PLATFORM_CAPABILITY_BLOCKED`.
