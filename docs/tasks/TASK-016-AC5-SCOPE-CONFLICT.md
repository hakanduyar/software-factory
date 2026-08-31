# TASK-016 — AC-5 scope conflict (RESOLVED by owner decision)

**Status: RESOLVED 2026-09-01 by owner decision — Option A. Retained as the
record of the conflict and of how it was decided.**

The owner chose Option A: do not accept the GitHub App installation residual,
do not weaken ZERO_COST, UNKNOWN_COST remains DENY, and a remote write must not
be authorized merely to make AC-5 reachable. External pull-request creation is
a legitimate HUMAN_REQUIRED boundary under the current policy.

AC-5 was amended accordingly in `ba6c6c8`, a dedicated criteria-only commit.
`ac01c22` is unchanged in history. The amended criterion and the amendment
record live in `TASK-016-github-orchestration.md`; this document is the
reasoning that preceded them, kept because the decision is only auditable
alongside the problem it answered.

The TASK-016 round-7 independent review confirmed the conflict on the original
criteria and explicitly declined to resolve it — "amending AC-5 requires a
separate human scope decision; it cannot be accepted implicitly by this
review". It recommended staying blocked; the owner decided otherwise. That
divergence is worth recording: the implementer did not choose the outcome, and
neither did the reviewer.

Everything below is the analysis as written before the decision, unchanged.

## The conflict

Three frozen requirements cannot all hold at once.

- **AC-5** requires that running publication twice for the same candidate
  "produces exactly one pull request". Producing one requires that a remote
  write be PERMITTED at least once.
- **AC-1/AC-2** require that a write be permitted only when its zero-cost
  effects were DERIVED from an observation of the exact target, and that an
  absent or unbindable observation is UNKNOWN, which is financial, which
  refuses.
- The **round-3 independent adjudication** established that zero liability
  cannot be demonstrated for a GitHub remote write, because a GitHub App
  installation on the target repository can carry a paid subscription and is
  not observable with the credentials the Factory holds. The reviewer
  explicitly ruled this is NOT equivalent to the accepted `npm test` residual.

Therefore no write is ever authorized, and AC-5's "exactly one pull request"
is unreachable by construction.

## Why it was not resolved inside the task

Both available resolutions are barred to the implementer:

- Weakening the gate to let the write through would violate AC-1/AC-2 and the
  standing instruction never to weaken a security control to make a task pass.
- Editing AC-5 to match what was built is exactly the self-certification C2
  forbids: "an implementation worker may not edit acceptance criteria in order
  to make its own work pass."

AGENTS.md governs the remainder: "if requirements conflict, stop and report the
conflict instead of silently choosing."

## What was actually built

Everything AC-5 asks for EXCEPT the write itself is implemented and proven:

- a second run adopts an existing pull request rather than creating a second,
- an interrupted run finds the existing one rather than duplicating it,
- the candidate is bound by commit identity rather than by branch name,
- check evidence is refused unless it describes the candidate's own commit,
- the only exported write capability refuses without an authorization the
  financial gate itself minted, and the gate mints none for this action.

The scripted client counts ZERO creates across two executions, where AC-5
anticipated one. The duplication bound AC-5 exists to enforce holds; the
production of the first pull request does not happen.

## The two options

**Option A — amend AC-5 to the delivered shape.** TASK-016 delivers
read/verify/report/record with every remote write human-gated. AC-5 becomes a
duplication bound ("never more than one; adopt what exists") rather than a
production requirement. The Factory can then verify a candidate, bind its
checks, and record its publication, but a human performs the `gh pr create`.
This matches what the reviewer called acceptance in principle, and it keeps
the financial gate strictly intact.

**Option B — accept the App-installation residual.** Declare the unobservable
GitHub App channel an accepted residual risk, the way the `npm test` residual
was accepted, so `observePushLiability` may treat it as closed and the gate may
mint a write authorization. This makes AC-5 reachable as written. It is a
constitutional-adjacent decision about the ZERO_COST policy, and the round-3
reviewer specifically declined to treat it as equivalent to the accepted
residual — so it needs the human, not the reviewer.

A third path exists but is not an option today: obtain a credential that can
enumerate App installations on the target repository, making the channel
observable and the residual unnecessary. That is a credential question, and
credentials are HUMAN-ONLY.

## Recommendation

Option A. The delivered capability is coherent, useful, and honest about what
it cannot prove; Option B trades a real (if small) financial exposure for the
convenience of not typing one command. Nothing in the roadmap after TASK-016
depends on the Factory creating pull requests autonomously — CLEAN_ROOM_CI
binds verification to a candidate, which the delivered read/verify path already
supports.

This recommendation is advisory. The decision is the user's.
