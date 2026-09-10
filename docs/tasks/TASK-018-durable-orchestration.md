# TASK-018 — DURABLE_ORCHESTRATION

**Status:** PROPOSED. The criteria below are a DRAFT and are **not frozen**.
Freezing them is a `PLAN_APPROVAL` decision under C1, and no implementation may
begin against this file until the owner freezes it in its own commit — the way
`c287a42` froze TASK-017.

**Proposed roadmap item:** `DURABLE_ORCHESTRATION` — "Orchestration that
survives the death of any one process". Proposed work class
`ARCHITECTURE_SECURITY`, proposed dependencies `SUPERVISOR_SERVICE` and
`EXECUTOR_WIRING`.

**Priority, by owner instruction:** ahead of Model Qualification and
`MEASURED_MODEL_ROUTER`. A router that measures models is worth little while the
thing invoking it cannot survive a restart, and every measurement it records
would inherit the losses described below.

## Why this exists: what twenty-four review rounds actually demonstrated

TASK-017 was accepted on round 24. The deliverable took eight rounds; the
remaining sixteen were spent on verification machinery, and a large share of the
WALL-CLOCK cost was not review or remediation at all. It was orchestration
failing in ways nobody noticed until a human asked.

These are observations from that run, not hypotheticals:

1. **The continuation owner was a shell script in a scratchpad.** `chain.sh`
   held the whole pipeline — gates, mutation run, freeze, reviewer launch,
   verdict. It lived outside the repository, had no schema, no tests and no
   recovery. When it died, nothing knew.

2. **"Intent is not execution" had to become a written rule** because work was
   reported as running three times when no process had been started. The
   correction was a discipline note in `AGENTS.md`. A discipline note is a
   promise; a lease with a live PID is a fact.

3. **A finished result sat unnoticed for hours.** There was no completion event
   and no durable status, so the only way to learn a review had finished was for
   a human to ask. The owner's words: there must be no state where "the result
   has existed for hours but nobody noticed".

4. **The stall detector had to be built twice** because the first one polled by
   asking a model, which costs money to learn nothing.

5. **A killed mutation run left the tree poisoned twice** — once by this session,
   once by the reviewer's own run. The fix was `.mutation-journal.json`: a
   crash-safe record that is also an exclusive lock, claimed with
   `openSync(..., "wx")` before the first edit and released only after
   byte-for-byte restoration. It works, and it is a lease for exactly one
   activity, hand-built for that activity. Every other long activity here has
   no equivalent.

6. **Round 22's chain read a scheduler path that round 21 had renamed**, produced
   a zero-byte script, and only a later self-check caught it. Classified D
   (orchestration) so a 2.5-hour mutation run was not repeated to prove a
   filename.

The pattern: the Factory's DURABLE state (SQLite, the append-only chain, the
roadmap) is well defended, and TASK-008 and TASK-012 defend it. The state of
work IN FLIGHT lives in process memory, ad-hoc files and scratchpad scripts, and
is lost whenever anything dies.

## Scope

**In scope:** durability and recovery of in-flight orchestration — the state
machine that owns a run, the lease that says who is running it, the heartbeat
that says it is alive, the completion event that says it finished, and the
reconciliation that runs at startup to make all of that true again after a
crash.

**Out of scope, explicitly:**

- Model qualification, benchmarking, and `MEASURED_MODEL_ROUTER`. This task
  makes those measurable later; it does not measure anything.
- Any change to reviewer independence, `ZERO_COST_ONLY`, `AUTONOMOUS_SPEND_LIMIT`,
  `PLAN_APPROVAL`, `STATE_INTEGRITY`, `EXECUTOR_ISOLATION` or the ADR-0002 gate.
  Recovery may never resume across a gate a human owns.
- New infrastructure. No daemon manager, message broker, container runtime or
  paid service. The runtime is the existing Windows PC and its WSL2 Ubuntu, and
  the existing SQLite database.
- Rewriting the mutation journal. It is accepted, mutation-proven and in `main`.
  If this task's lease generalises it, that is a REFACTOR proven to preserve
  every fail-closed property the journal has today, or it is not done at all.

## The invariant that must not move

**Recovery restores knowledge, never authority.** After any crash the system may
re-derive what was true, mark what is lost, and refuse. It may not infer that an
unfinished thing succeeded, resume a step whose evidence is gone, or advance past
a human gate because a process that would have stopped there is no longer alive.
Every unknown resolves to REFUSE.

## Draft acceptance criteria (to be frozen by the owner, not by the implementer)

**AC-1 — Durable run state.** A long-running orchestrated activity (review,
mutation run, verification chain) has its state in the supervisor database, not
in process memory or a scratchpad file. State transitions are explicit and
enumerable. Proven by a test that kills the owning process mid-activity, opens a
fresh process against the same database, and reads the activity's state
correctly.

**AC-2 — Leases, with a liveness fact.** An activity is owned by exactly one
holder. The lease records the holder's PID, its start time and a machine
identity, and holding it requires the process to be ALIVE — a lease whose PID is
gone is expired, not held. Proven by mutation: removing the liveness check lets a
dead holder keep the lease, and a named test must fail.

**AC-3 — Duplicate owners are refused, not merged.** A second process attempting
to take a held, live lease REFUSES and says whose it is. It does not wait, steal,
or proceed alongside. Proven by two real concurrent processes against one
database, asserting the refusal REASON and not merely a non-zero exit.

**AC-4 — Heartbeat, and a stall that is a measurement.** A holder records
progress. "Stalled" is defined as a measured absence of progress over a stated
interval, and is distinguishable in the record from "finished", "died" and
"never started". Missing output is never read as success. Proven by three
fixtures producing the three non-success states, each asserting its own reason.

**AC-5 — Completion events.** Finishing writes a durable completion record; no
observer needs to poll a model, and no human needs to ask. A result that exists
is discoverable from the database alone. Proven by a test that completes an
activity in one process and observes the completion from another that was never
told about it.

**AC-6 — Startup reconciliation.** On start, the supervisor examines every
non-terminal activity, classifies each as still-live, crashed or ambiguous, and
records the classification. Ambiguous resolves to REFUSE. Proven by fixtures for
all three, including a lease whose PID belongs to an unrelated live process.

**AC-7 — Idempotent transitions.** Applying the same transition twice has the
same effect as applying it once, and a transition interrupted between its
effect and its record is either replayable or detectably incomplete — never
silently half-applied. Proven by an interrupted-transition fixture.

**AC-8 — Survives the deaths that actually happened.** Named fixtures for:
reviewer process killed mid-review; chain owner killed between mutation run and
freeze; supervisor restarted with activities in flight; the WSL instance
restarted (or a faithful stand-in, with the substitution recorded honestly in
`docs/KNOWN-LIMITATIONS.md` if the real thing cannot be exercised in-suite).

**AC-9 — Lost notifications are recoverable.** A completion whose notification is
never delivered is still discovered by reconciliation. Proven by a fixture that
completes an activity and drops the notification.

**AC-10 — Recovery never crosses a human gate.** No recovery path advances an
item past `PLAN_APPROVAL`, `RELEASE_APPROVAL`, `PUBLISH_APPROVAL` or
`CONSTITUTION_CHANGE`, and none satisfies an ADR-0002 condition that a live
review would have had to satisfy. Proven by mutation: deleting the gate check on
the recovery path must fail a named test.

**AC-11 — Test integrity.** Every criterion above that claims a guard is proven
by `scripts/mutate.mjs` under `scripts/preflight.mjs`, with a green baseline,
zero survivors, zero unmeasured, zero wrong-test, and both closing proofs —
`restored: pass=… fail=0` and byte-for-byte verification.

**AC-12 — The roadmap entry ships with an upgrade path.** See the hazard below.
Adding this item to `DEFAULT_ROADMAP` must not refuse an installation whose
database was seeded from the previous catalog.

## A hazard this task must solve before it can even be queued

`reconcileRoadmapWithCatalog` treats `key`, `title`, `workClass`, `dependsOn` and
`order` as DEFINITION fields: a persisted row whose definition disagrees with the
catalog is REFUSED, by design, and `tests/roadmapStructuralIntegrity.test.ts`
pins that behaviour deliberately (TASK-012 AC-1/AC-2).

Inserting `DURABLE_ORCHESTRATION` ahead of `MEASURED_MODEL_ROUTER` means
renumbering `order` on the items after it, and — if the router is to genuinely
WAIT for it — adding an edge to `MEASURED_MODEL_ROUTER.dependsOn`. Both are
definition changes. Any installation already holding the old rows would then
refuse to reconcile at startup.

Appending a new key is already supported and safe; the test named "appends a
catalog entry the database has never seen" proves it. **Renumbering existing
rows is not.** So this task owns a decision it must make explicitly:

- append `DURABLE_ORCHESTRATION` at the end with the next free `order` and treat
  priority as a queue policy rather than a sort key, or
- introduce a catalog VERSION and a reconciliation path that accepts a declared,
  intentional definition change while still refusing an undeclared one — which
  is a change to a `STATE_INTEGRITY` guard and needs its own review.

The first is small and reversible. The second is the one that generalises. This
file does not choose between them, because choosing is planning work and the
criteria here are not yet frozen.

**Nothing was added to `DEFAULT_ROADMAP` when this file was written.** The
catalog is untouched, deliberately, so that the priority decision is recorded in
documentation the owner reads rather than shipped as an unreviewed production
edit with a startup-refusal hazard attached.

## Verification plan (draft)

1. `node scripts/preflight.mjs` — every mutation valid before any expensive run.
2. `npm run typecheck`, then `npm test` — the full suite green.
3. The strict AC-12 probe from TASK-017:
   `env -i PATH="$(dirname $(command -v node))" HOME="$HOME" node --test dist/tests/*.test.js`
4. `node scripts/mutate.mjs` — zero survivors, zero unmeasured, zero wrong-test,
   both closing proofs.
5. Freeze the candidate; independent acceptance review by a model that did not
   implement it (C4/C5); ADR-0002 gate before any integration.

## What must be true before implementation starts

- The owner freezes these criteria in their own commit.
- The roadmap-insertion decision above is made by the owner or by planning, not
  by the implementer.
- The implementer is not the reviewer.
