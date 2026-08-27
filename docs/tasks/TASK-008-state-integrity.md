# TASK-008 — STATE_INTEGRITY

Roadmap key: `STATE_INTEGRITY`
Status: acceptance criteria FROZEN before implementation (ADR-0002 condition 1).

## Why this is being done now

The roadmap orders `LOCAL_24_7_RUNTIME` first, and its implementation is
currently blocked by a platform boundary (see "Sequencing note"). `STATE_INTEGRITY`
is pure code with no scheduling or persistence mechanism, and the completion
mandate names it — with `EXECUTOR_ISOLATION` — as a prerequisite that must be
closed before `EXECUTOR_WIRING` or anything capable of autonomous execution.

Its declared dependency on `SUPERVISOR_SERVICE` is conservative rather than
technical: protecting durable state does not require a timer to exist. Doing it
now closes one of the two boundaries gating the dangerous work, which is the
highest-value thing available.

**The roadmap's dependency edges are not being edited.** `EXECUTOR_WIRING` still
depends on both prerequisites; only the order in which the two prerequisites are
worked is affected.

## The problem, stated exactly

From TASK-006 review round 9 (finding R9-C4-1), and restated in the tenth
review's adjudication:

> Implementer lineage is a recorded historical fact. It lives in the
> supervisor's SQLite database, and there is no key on this machine to
> authenticate it, so anything able to write that database can rewrite who built
> what — and a review that should have been excluded then proceeds.

The financial gate does **not** have this weakness, because F-1 made spending
authority impossible to EXPRESS in data: no row can grant it, so no row has to
be trusted. Lineage cannot be handled that way. "Who ran this last week" is
inherently a record, and a record is only as good as its protection.

What already exists, in increasing cost to an attacker: recognition against the
code-level catalog (R8-C4-1), a cross-check against `lastRunConfig` which a
different code path writes at a different time (R9-C4-1), and fail-closed
handling of anything missing, unrecognised or contradictory.

What does **not** exist: any reason to believe the record itself.

## Design direction

Two independent layers, neither of which pretends to be the other:

1. **Restrictive permissions.** The database and its directory should not be
   world-readable or world-writable. This raises the bar against other local
   users and stray processes. It does nothing against the operator's own account,
   and will not be claimed to.

2. **An append-only, hash-chained audit log.** Each provenance event (an item
   implemented by a resource, a run configuration recorded) is appended with a
   digest over the previous entry, so the chain cannot be edited in the middle
   without every subsequent digest disagreeing. Tampering becomes *detectable*
   even though it cannot be *prevented* without a key.

**The honest limit, stated up front so no criterion can quietly drop it:** a
hash chain with no secret detects edits by anyone who does not bother to
recompute it, and detects nothing against someone who does. It is tamper-
EVIDENT, not tamper-PROOF. Making it tamper-proof requires a trust anchor this
machine does not have. Any acceptance criterion or comment claiming otherwise is
wrong and must be rejected in review.

## Acceptance criteria (FROZEN — may not be edited to fit the implementation)

**AC-1.** Provenance events are appended to a durable log that is never rewritten
in place: existing entries are immutable once written.

**AC-2.** Each entry carries a digest computed over its own content AND the
previous entry's digest, so the log forms a chain from a fixed genesis.

**AC-3.** Verification detects, and names precisely, each of: an edited entry, a
deleted entry, a reordered pair, and an entry appended with a wrong previous
digest.

**AC-4.** Verification is deterministic and model-free — no AI is consulted about
whether a chain is intact.

**AC-5.** A broken chain FAILS CLOSED for reviewer-independence decisions: if
lineage cannot be verified, the review waits for a human rather than proceeding
on unverifiable history.

**AC-6.** The chain is a SECOND source, not a replacement: existing roadmap
lineage checks (catalog recognition, `lastRunConfig` cross-check, missing/unknown
handling) continue to apply, and a disagreement between the two fails closed.

**AC-7.** The database file and its directory are created with restrictive
permissions (not world-readable, not world-writable), and existing permissions
are tightened on open rather than only on creation.

**AC-8.** The implementation NEVER claims tamper-proofness. Its documentation and
its status output describe it as tamper-evident, and a test asserts the
distinction is stated where an operator will see it.

**AC-9.** No secret, token, or credential enters the audit log; entries are
bounded and redacted like every other durable string in this codebase.

**AC-10.** Performance is bounded: verification is linear in chain length and the
chain has an explicit, enforced maximum size with a fail-closed response to
overflow — never silent truncation, which would discard exactly the oldest
provenance an attacker most wants gone.

**AC-11.** Existing behaviour is preserved: the full suite still passes (baseline
1347), the financial gate is untouched, and `EXECUTOR_WIRING` still depends on
both `STATE_INTEGRITY` and `EXECUTOR_ISOLATION`.

**AC-12.** The TASK-006 test that PINS the current lineage-forgery gap is updated
deliberately and visibly when the gap narrows — it must not be left asserting an
outdated limitation, nor deleted to make room.

## Verification plan

- Chain tampering driven by mutating a real persisted log: edit, delete,
  reorder, append-with-wrong-digest — each must be detected and named.
- Permission assertions against a real file created by the real adapter.
- Fail-closed behaviour driven end-to-end through the supervisor, not only at the
  unit level.
- Mutation testing: every guard removed in turn, confirming its regression fails.
  Removing the guard, not its input — the lesson of rounds 6, 8 and 10.

## Sequencing note

`LOCAL_24_7_RUNTIME` (TASK-007) has frozen acceptance criteria committed at
`9d8417e` and is implementation-blocked: generating and installing systemd units
is refused by a platform safety classifier, which is a correct default for
autostart/persistence code written by an agent. That task resumes when the
boundary is resolved by the human owner. Nothing in TASK-008 depends on it.
