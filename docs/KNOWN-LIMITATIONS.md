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

## L-3 — The executor's process is not a network sandbox

**Status:** NARROWED by TASK-011 (`feat/executor-isolation`, `e3fe829`),
IMPLEMENTED and AWAITING INDEPENDENT REVIEW. The original in-process form was
adjudicated a legitimate boundary by independent review (TASK-006 round 7).

**What it used to say:** the financial gate authorises a LAUNCH and cannot
police what trusted in-process executor code does afterwards, because an
in-process function cannot restrain code that can already call `fetch`.

**What changed:** the executor now runs in a separate process with an explicit
environment, a bounded request, a timeout, and strict parsing of everything it
returns. It holds no credential store, and the response format has no field
through which a child could grant itself authority.

**What is STILL open, and is the reason this entry survives rather than being
deleted:** raw network egress is **not blocked**. A child can still open a
socket. Closing that needs an OS-level control — a network namespace, seccomp,
or a firewall rule — and installing one needs a sudo password, which ADR-0002
reserves to the human. Autonomous work cannot acquire it.

**What is genuinely removed is BILLING capability**, which is the property
`AUTONOMOUS_SPEND_LIMIT = 0` actually rests on: provider CLIs authenticate from
credential stores under `HOME`/`CODEX_HOME`/`XDG_*`, the isolated allowlist
omits all of them, and a process that cannot authenticate cannot cause a charge
whether or not it can reach the network. A child reaching an unauthenticated
endpoint is a real but much smaller problem than one that can spend money.

**Consequence for the design:** the isolated child performs deterministic work
only. An AI launch needs exactly the credential access it is denied, so launches
stay with the supervisor behind the gate that authorises them — a deliberate
division, not a missing feature.

**Kept honest by:** `EXECUTOR_WIRING` depends on `EXECUTOR_ISOLATION`, and a test
asserts that dependency. A second test reads the implementation source and fails
if it ever claims to be sandboxed, or claims egress is blocked.

**Watch for:** anyone merging the executor allowlist with the WORKER allowlist
"for tidiness". The difference between those two lists IS this control; a worker
is given `HOME` on purpose, and an executor must not be.

---

## L-4 — Implementer lineage is tamper-evident, not tamper-proof

**Status:** NARROWED by TASK-008 (`feat/state-integrity-rebased`, `7f5e96a`),
IMPLEMENTED and AWAITING INDEPENDENT REVIEW. Adjudicated a legitimate boundary
by independent review in its original form (TASK-006 round 10).

Lineage is a recorded historical fact living in a database, and there is no key
on this machine to authenticate it. Catalog recognition, a cross-check against
`lastRunConfig`, and fail-closed handling of anything missing or contradictory
raise the cost of forgery; none of them make the record self-proving.

**What changed:** there is now a SECOND record — an append-only hash chain
written at the same moment as the mutable row. A row rewritten to name a
different implementer contradicts the chain and the review waits for a human; a
chain that does not verify makes every AI ancestor ambiguous. The database and
its directory are also owner-only now, tightened on every open.

**What is STILL open:** the chain has no secret, so it detects nothing against
someone who recomputes it after editing. It catches the corrupted row, the
partial restore, the hand-edit "just fixing one field" — the realistic cases —
and not a determined forger.

**And one gap the second record does not close:** an EMPTY chain is treated as
silence rather than contradiction, because a database written before TASK-008
has no entries for work already done. An attacker who can write the database can
also delete the whole chain, which returns the system to the pre-TASK-008
behaviour for that item. Refusing instead would strand every existing database;
the trade-off was made deliberately and is flagged here rather than buried.

**The contrast worth remembering:** spending authority has no equivalent
weakness, because F-1 made it impossible to EXPRESS in data — no row can grant
it, so no row has to be trusted. Lineage cannot be built that way.

**Consequence:** the supervisor database is part of the trusted computing base.

**Kept honest by:** `EXECUTOR_WIRING` depends on `STATE_INTEGRITY` in
`DEFAULT_ROADMAP`, and `tests/task006RemediationRound10Repro.test.ts` asserts
that dependency, so nothing can be wired to execute autonomous work while this
gap is open.

**Also kept honest by:** `sf supervise status` prints the chain verdict with the
words "tamper-evident, not tamper-proof" beside it, and a test fails if that
wording disappears — so the distinction reaches an operator rather than living
only in a source comment. `tests/task006RemediationRound9Repro.test.ts` still
pins the residual forgery case and now states precisely what narrowed and what
did not.

---

## L-6 — Verification refuses trees containing any hardlinked source

**Status:** OPEN, deliberate. Raised by independent review (TASK-010 round 5) as
a false positive; referred back to the reviewer for a judgement on the
trade-off rather than settled unilaterally by the implementer.

`scripts/verify.mjs` refuses any `.ts`/`.mts`/`.cts` under `tests/` whose link
count exceeds one. A hardlink is indistinguishable from an ordinary file by
name, type or `realpath`; link count is the only ordinary signal, and it cannot
tell a hardlink pointing outside the repository from one pointing inside it.

**The cost is real and it lands on valid trees.** A clean checkout copied with
`cp -al` is refused — the reviewer demonstrated it. So, potentially, are
hardlinking backup tools, some container layer implementations, and any workflow
that de-duplicates files across checkouts.

**Why it is still the policy:** the alternative — permitting hardlinks whose
target resolves inside the repository — accepts precisely the case that cannot
be told apart from the dangerous one. `npm test` is the default verification for
every human and agent here, so a rule that is occasionally inconvenient was
preferred to one that is sometimes wrong.

**What would make this reconsiderable:** `CLEAN_ROOM_CI` exists to run
verification in an environment the adversary is not in. Once it does, the local
hardlink rule is defending much less and could reasonably become a warning.

**Watch for:** if this begins refusing ordinary working copies, the cost has
exceeded the benefit and the trade-off should be revisited — not worked around
with a bypass flag. A bypass flag would delete the guard for everyone while
appearing to keep it.

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
