# Known limitations

Things this system does NOT do, recorded where an operator will find them.

A limitation that lives only in a review transcript is a limitation nobody knows
about. Each entry says what is not covered, why it is not covered, what would
close it, and how it is prevented from being forgotten.

This register exists because the opposite failure — overstating what a control
achieves — has been the single most repeated defect in this project's review
history. Several entries below were written after a reviewer caught exactly that.

---

## L-1 — Supervisor state is not forward-compatible across schema additions

**Status:** OPEN. Found in operation 2026-08-24, during cross-machine handoff.

Adding a value to a persisted enum makes durable state unreadable by any build
that predates the addition.

Concretely: TASK-009 adds `PLATFORM_CAPABILITY_BLOCKED` to `ESCALATION_REASONS`
and records a blocker with it. The database then contains a value that only a
build carrying TASK-009 can parse. A build from `main` — which does not yet have
TASK-009 — refuses the whole state file:

```
supervisor state.escalations[0]: field "reason" must be one of ..., got "PLATFORM_CAPABILITY_BLOCKED"
```

**This is correct fail-closed behaviour and should not be "fixed" by making the
parser lenient.** An unrecognised value in security-relevant state must not be
silently ignored or coerced — that is the rule every TASK-006 review round
reinforced. The defect is not the refusal; it is that:

1. durable state is coupled to *which branch is built*, so switching branches or
   rolling back a deployment can leave the supervisor unable to read its own
   database;
2. the failure surfaces as a total refusal to start rather than as a specific,
   actionable message about a version mismatch;
3. there is no schema version on the state blob that would let a build say "this
   was written by something newer than me" instead of "this row is corrupt" —
   which are very different problems with very different remedies.

**Why it is recorded here rather than fixed now:** it was found while a frozen
independent review was running, and it will *appear* to resolve the moment
TASK-009 integrates into `main` — which is exactly how a real defect gets lost.
The underlying coupling survives that integration and will recur on the next
enum addition.

**What would close it:** a schema/compatibility version on the persisted state,
so a build can distinguish "written by a newer version" (refuse, and say so
clearly, with the version that wrote it) from "genuinely corrupt" (refuse, and
say that instead). Candidate work for `STATE_INTEGRITY`, which already owns the
durability of this file.

**Workaround today:** delete `.factory/supervisor.db` and re-run
`sf supervise tick` to re-seed from `DEFAULT_ROADMAP`, then re-record any
blocker. Nothing of value is lost — the roadmap definition lives in source — but
recorded blockers and escalation history are.

---

## L-2 — The verifier does not defend against a concurrent local adversary

**Status:** ACCEPTED BOUNDARY. Adjudicated legitimate by independent review
(TASK-010 round 4).

`scripts/verify.mjs` defends against accidental contamination and
misconfiguration: stale build output from another branch, a redirected or
inherited `outDir`, `noEmit`, symlinks and hardlinks pulling in outside code, a
bind-mounted output directory, and a run that would report success having
executed nothing.

It does **not** defend against an adversary with concurrent write access to the
working tree, or control of `PATH`, during the run. Two such escapes were
demonstrated: swapping `tests/` between the check and the build, and shadowing
`npx` so nothing compiled while the stale checker's mtime was touched.

**Why it is not closed:** such an adversary can already edit `src/`, replace
`node`, or rewrite the verifier itself. No verifier running inside the tree it
audits can defend against that, and building something that appears to would
manufacture assurance without substance.

**What would close it:** running verification in a clean checkout in an isolated
environment — the `CLEAN_ROOM_CI` roadmap item.

**Kept honest by:** the boundary is stated in `scripts/verify.mjs` and pinned by
a test asserting that statement is present, so it cannot quietly disappear.

---

## L-3 — The in-process executor can act outside what it declared

**Status:** ACCEPTED BOUNDARY, tracked as the `EXECUTOR_ISOLATION` roadmap item.
Adjudicated legitimate by independent review (TASK-006 round 7).

The financial gate authorises a LAUNCH. It cannot police what trusted in-process
executor code does afterwards, because an in-process function cannot restrain
code that can already call `fetch` — the same trust boundary TASK-003's `Worker`
has.

**What would close it:** running executors in a restricted process with no
ambient network or billing capability.

**Kept honest by:** `EXECUTOR_WIRING` depends on `EXECUTOR_ISOLATION`, and a test
asserts that dependency, so nothing can be wired to execute autonomous work
before the executor can be constrained.

---

## L-4 — Implementer lineage is tamper-evident, not tamper-proof

**Status:** ACCEPTED BOUNDARY, tracked as the `STATE_INTEGRITY` roadmap item.
Adjudicated legitimate by independent review (TASK-006 round 10).

Lineage is a recorded historical fact living in a database, and there is no key
on this machine to authenticate it. Catalog recognition, a cross-check against
`lastRunConfig`, and fail-closed handling of anything missing or contradictory
raise the cost of forgery; none of them make the record self-proving.

The hash chain added by TASK-008 detects edits, deletions, reordering and broken
links. With no secret it detects nothing against someone who recomputes it.

**The contrast worth remembering:** spending authority has no equivalent
weakness, because F-1 made it impossible to EXPRESS in data — no row can grant
it, so no row has to be trusted. Lineage cannot be built that way.

**Consequence:** the supervisor database is part of the trusted computing base.

**Kept honest by:** `EXECUTOR_WIRING` depends on `STATE_INTEGRITY` in
`DEFAULT_ROADMAP`, and `tests/task006RemediationRound10Repro.test.ts` asserts
that dependency, so nothing can be wired to execute autonomous work while this
gap is open.

**Not yet kept honest by:** there is no test pinning the residual forgery gap
itself. The header of `provenanceChain.ts` states the tamper-evident/tamper-proof
distinction in prose only, and that file is still on `feat/state-integrity`
awaiting integration. Prose can be deleted without failing anything. Closing
`STATE_INTEGRITY` should add that pin.

---

## L-5 — Provisional failure signatures are inert

**Status:** OPEN, documented in TASK-006.

Neither installed CLI documents its rate-limit or usage-limit output, so the
signature table entries for those states are marked PROVISIONAL and do not fire.
Real provider failures classify as `UNKNOWN_FAILURE` and take the bounded backoff
ladder.

This is deliberate: inventing a signature that has never been observed would be
the "measured vs assumed" dishonesty this codebase repeatedly removes. The cost
is that the more specific resource states are not currently reachable in
practice.

**What would close it:** observing and recording real rate-limit output from each
provider, then promoting the signature from PROVISIONAL to MEASURED.
