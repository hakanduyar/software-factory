# TASK-018 — DURABLE_ORCHESTRATION

**Roadmap item:** `DURABLE_ORCHESTRATION` — "Orchestration that survives the
death of any one process". Work class `ARCHITECTURE_SECURITY`, dependencies
`SUPERVISOR_SERVICE` and `EXECUTOR_WIRING`.

**Direction approved by the owner on 2026-09-12**, including the versioned
catalog-upgrade requirement. The criteria below are FROZEN by that approval and
may not be edited to fit the implementation (C2). A material scope change is a
new planning decision, not an edit to this file.

**Priority, by owner decision:** `DURABLE_ORCHESTRATION` comes before the Model
Qualification Harness and before `MEASURED_MODEL_ROUTER`, and it does so as a
REAL DEPENDENCY rather than as a note about ordering. A router that measures
models is worth little while the thing invoking it cannot survive a restart, and
every measurement it recorded would inherit the losses described below.

## Why this exists: what twenty-four review rounds actually demonstrated

TASK-017 was accepted on round 24. The deliverable took eight rounds; the
remaining sixteen went to verification machinery, and a large share of the
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
   a human to ask.

4. **The stall detector had to be built twice** because the first one polled by
   asking a model, which costs money to learn nothing.

5. **A killed mutation run left the tree poisoned twice** — once by this
   session, once by the reviewer's own run. The fix was
   `.mutation-journal.json`: a crash-safe record that is also an exclusive lock,
   claimed with `openSync(..., "wx")` before the first edit and released only
   after byte-for-byte restoration. It works, and it is a lease for exactly one
   activity, hand-built for that activity. Every other long activity here has no
   equivalent.

6. **Round 22's chain read a scheduler path that round 21 had renamed**,
   produced a zero-byte script, and only a later self-check caught it.

The pattern: the Factory's DURABLE state — SQLite, the append-only chain, the
roadmap — is well defended, and TASK-008 and TASK-012 defend it. The state of
work IN FLIGHT lives in process memory, ad-hoc files and scratchpad scripts, and
is lost whenever anything dies.

## The two parts, and why the order is not negotiable

Making `DURABLE_ORCHESTRATION` a real dependency means changing
`DEFAULT_ROADMAP`: adding the item, and adding an edge to
`MEASURED_MODEL_ROUTER.dependsOn` so the router genuinely waits.

`reconcileRoadmapWithCatalog` treats `key`, `title`, `workClass`, `dependsOn`
and `order` as DEFINITION fields and REFUSES any persisted row that disagrees
with the catalog. TASK-012 AC-1/AC-2 pin that deliberately, and it is the guard
that stopped a rewritten `workClass` from skipping independent review. So the
edge cannot simply be added: an installation seeded from today's catalog would
refuse its own roadmap at startup, and the only ways out would be to weaken the
guard or to hand-edit the database — the two things this repository exists to
make impossible.

Appending a brand-new key is already safe and already proven ("appends a catalog
entry the database has never seen"). **Changing an existing row's definition is
not.** That is what Part A builds, and it is the first migration mechanism in
this codebase. `schema.ts` has carried a fail-closed `SCHEMA_VERSION` since
TASK-002, which "intentionally ships no migration runner — only detection, so a
future migration mechanism has a safe, loud failure mode to build on rather than
silently misreading rows"; and `sqliteSupervisorRepository.ts` refuses a
mismatched `SUPERVISOR_SCHEMA_VERSION` outright rather than "silently migrated:
guessing at another version's semantics is how state gets quietly corrupted".
Part A is the mechanism those two notes were left waiting for, and it inherits
their posture rather than replacing it.

**Part A is a separately reviewable increment and integrates before Part B
begins.** It is small, it is the risky part, and it is the part that touches a
guard other tasks depend on.

## The invariant that governs both parts

**Recovery restores knowledge, never authority.** After any crash — or any
upgrade — the system may re-derive what was true, mark what is lost, and refuse.
It may not infer that an unfinished thing succeeded, resume a step whose
evidence is gone, advance an item's status, or pass a gate a human owns because
the process that would have stopped there is no longer alive. Every unknown
resolves to REFUSE.

## Scope

**In scope:** the versioned catalog-upgrade mechanism (Part A); and the
durability and recovery of in-flight orchestration (Part B) — the state machine
that owns a run, the lease that says who is running it, the heartbeat that says
it is alive, the completion event that says it finished, and the reconciliation
that runs at startup to make all of that true again after a crash.

**Out of scope, explicitly:**

- Model qualification, benchmarking, and `MEASURED_MODEL_ROUTER`. This task
  makes those measurable later and gates them; it does not measure anything.
- Any change to reviewer independence, `ZERO_COST_ONLY`,
  `AUTONOMOUS_SPEND_LIMIT`, `PLAN_APPROVAL`, `EXECUTOR_ISOLATION`, the ADR-0002
  gate, or the commit attribution policy in `src/governance/commitPolicy.ts`.
- Weakening `reconcileRoadmapWithCatalog`. Part A ADDS a declared, versioned
  path; every refusal that exists today must still happen, and TASK-012's cases
  must pass unchanged.
- A general-purpose migration framework. One mechanism, for the roadmap catalog,
  with exactly the steps this task needs.
- New infrastructure. No daemon manager, message broker, container runtime or
  paid service. The runtime is the existing Windows PC and its WSL2 Ubuntu, and
  the existing SQLite databases.
- Rewriting the mutation journal. It is accepted, mutation-proven and in `main`.
  If Part B's lease generalises it, that is a REFACTOR proven to preserve every
  fail-closed property the journal has today, or it is not done at all.
- History rewriting of any kind, in git or in the provenance chain.

---

# PART A — Versioned catalog upgrade

**AC-1 — The catalog carries an explicit version, recorded durably.**
`ROADMAP_CATALOG_VERSION` is declared in source beside `DEFAULT_ROADMAP` and
recorded in the supervisor database. A fresh database records the current
version on creation. A database that predates this task carries no such record,
and that absence means exactly one thing — the catalog version that shipped
before this task — and is never read as "any version" or "whatever the rows
happen to be". Proven by: a fresh database reporting the current version; a
database written by the previous build reporting the previous version; and a
database whose recorded version is absent AND whose rows do not match that
version's catalog being REFUSED under AC-4 rather than adopted.

**AC-2 — Nothing rewrites a persisted definition except a declared upgrade.**
Every refusal `reconcileRoadmapWithCatalog` performs today still happens, and
TASK-012's existing cases pass unchanged and unedited. The reconciliation path
itself gains no power to correct, adopt or overwrite a disagreeing row. Proven
by mutation: a mutation that lets reconciliation accept or overwrite a
disagreeing definition must fail a NAMED test.

**AC-3 — Migration runs only between recognised versions, by declared steps.**
Upgrades are an explicit ordered list of steps, each naming the exact version it
upgrades FROM and the version it produces. A recorded version with no declared
step leading forward from it is REFUSED, naming that version. A recorded version
NEWER than this build's is REFUSED, and never downgraded. A gap in the declared
chain is REFUSED rather than bridged. No step is inferred from the difference
between two catalogs. Proven by fixtures for all four: unknown-older,
newer-than-build, a gap, and the legitimate adjacent step.

**AC-4 — Unexpected divergence refuses, and changes nothing.**
A step applies only if every row it will touch matches, exactly, the definition
its FROM version declares. Anything else — a hand-edited definition, a key the
FROM catalog does not declare, a row left by a partially applied earlier
attempt, a duplicate key — REFUSES the entire upgrade. On refusal the database
is left byte-identical to what it was before the attempt. Proven by fixtures
that each assert both the refusal REASON and post-refusal byte-equality of the
stored state.

**AC-5 — Deterministic, transactional, idempotent.**
Determinism: the same input database and the same declared steps produce
byte-identical output, twice, with no dependence on wall-clock ordering or map
iteration order. Transactionality: the row changes and the recorded version move
together in ONE database transaction, so no observable state exists in which the
rows advanced and the version did not, or the reverse. Idempotence: applying an
upgrade to a database already at the target version is a no-op that reports
"already at version N" and writes nothing. Proven by: byte-equality across two
independent runs; a fault injected between the row write and the version write
leaving the database fully at the PRE state; and a second run writing nothing.

**AC-6 — Restart and retry produce neither a partial nor a duplicate upgrade.**
A process killed at any point during an upgrade leaves the database either fully
pre-upgrade or fully post-upgrade. The next start completes the upgrade or
refuses it; it never resumes into a half-applied state, and never applies a step
twice. Proven by a fixture that kills a REAL process at no fewer than two
distinct points inside the upgrade and asserts the database is in one of the two
whole states each time, then that a subsequent start reaches the target version
exactly once.

**AC-7 — Completed work and history survive the upgrade.**
Every PROGRESS field — `status`, `attempts`, `unlaunchedAttempts`,
`implementedByResourceKeys`, `lastRunConfig`, `detail`, `humanActionRequired` —
is carried across unchanged for every item. The provenance chain and its anchor
are carried across unchanged and still verify against that anchor afterwards.
The upgrade APPENDS an audit record naming the from-version, the to-version and
the steps applied; it rewrites no existing chain entry. Proven by a fixture
whose pre-state holds DONE items, non-zero attempts, recorded lineage and a
non-genesis anchor: progress compares byte-identical, and the chain verifies
after.

**AC-8 — The upgrade restores knowledge, never authority.**
No upgrade changes an item's `status`, makes eligible an item that was not
eligible for a reason other than the new dependency edge, satisfies or bypasses
a protected gate (`PLAN_APPROVAL`, `RELEASE_APPROVAL`, `PUBLISH_APPROVAL`,
`CONSTITUTION_CHANGE`), or changes what `unprovenCompletion` would refuse.
Proven by mutation: removing the status-preservation clause, or the gate check
on the upgrade path, must fail a NAMED test.

**AC-9 — After the upgrade the dependency is real, not documentary.**
`DURABLE_ORCHESTRATION` is present in the catalog, and
`MEASURED_MODEL_ROUTER.dependsOn` contains it, so the router is not eligible
while durable orchestration is not DONE. Proven by a test that reconciles a
roadmap and asserts `MEASURED_MODEL_ROUTER` is refused eligibility while
`DURABLE_ORCHESTRATION` is PENDING, and that the refusal names the dependency.

**AC-10 — Sequencing: the mechanism and the catalog change ship together.**
`DEFAULT_ROADMAP` is not modified until AC-1 through AC-9 hold. The commit that
adds the item and the edge is the commit that carries the mechanism proving
them, and an installation upgraded by that commit starts without manual
intervention.

---

# PART B — Durable orchestration

**AC-11 — Durable run state.** A long-running orchestrated activity — a review,
a mutation run, a verification chain — has its state in the supervisor database,
not in process memory and not in a scratchpad file. Its transitions are explicit
and enumerable. Proven by a test that kills the owning process mid-activity,
opens a fresh process against the same database, and reads the activity's state
correctly.

**AC-12 — Leases, with a liveness fact.** An activity is owned by exactly one
holder. The lease records the holder's PID, its start time and a machine
identity, and holding it requires the process to be ALIVE: a lease whose PID is
gone is EXPIRED, not held. Proven by mutation — removing the liveness check lets
a dead holder keep the lease, and a NAMED test must fail.

**AC-13 — Duplicate owners are refused, not merged.** A second process
attempting to take a held, live lease REFUSES and names the current holder. It
does not wait, steal, or proceed alongside. Proven by two REAL concurrent
processes against one database, asserting the refusal REASON and not merely a
non-zero exit.

**AC-14 — Heartbeat, and a stall that is a measurement.** A holder records
progress. "Stalled" is defined as a measured absence of progress over a stated
interval, and is distinguishable in the record from "finished", "died" and
"never started". Missing output is never read as success. Proven by three
fixtures producing the three non-success states, each asserting its own reason.

**AC-15 — Completion events.** Finishing writes a durable completion record. No
observer needs to poll a model, and no human needs to ask. A result that exists
is discoverable from the database alone. Proven by a test that completes an
activity in one process and observes the completion from another that was never
told about it.

**AC-16 — Startup reconciliation.** On start, the supervisor examines every
non-terminal activity, classifies each as still-live, crashed or ambiguous, and
records the classification. Ambiguous resolves to REFUSE. Proven by fixtures for
all three, including a lease whose recorded PID now belongs to an unrelated live
process.

**AC-17 — Idempotent transitions.** Applying the same transition twice has the
same effect as applying it once. A transition interrupted between its effect and
its record is either replayable or detectably incomplete — never silently
half-applied. Proven by an interrupted-transition fixture.

**AC-18 — It survives the deaths that actually happened.** Named fixtures for:
a reviewer process killed mid-review; a chain owner killed between the mutation
run and the candidate freeze; the supervisor restarted with activities in
flight; and the WSL instance restarted. Where the real event cannot be exercised
in-suite, the stand-in is named and the substitution is recorded in
`docs/KNOWN-LIMITATIONS.md` rather than implied to be the real thing.

**AC-19 — Lost notifications are recoverable.** A completion whose notification
is never delivered is still discovered by reconciliation. Proven by a fixture
that completes an activity and drops the notification.

**AC-20 — Recovery never crosses a human gate.** No recovery path advances an
item past `PLAN_APPROVAL`, `RELEASE_APPROVAL`, `PUBLISH_APPROVAL` or
`CONSTITUTION_CHANGE`, and none satisfies an ADR-0002 condition that a live
review would have had to satisfy. Proven by mutation: deleting the gate check on
the recovery path must fail a NAMED test.

---

# PART C — Integrity of the evidence

**AC-21 — Test integrity.** Every criterion above that claims a guard is proven
by `scripts/mutate.mjs` under `scripts/preflight.mjs`, with a green baseline,
zero SURVIVED, zero UNMEASURED, zero WRONG TEST, and both closing proofs —
`restored: pass=… fail=0` and byte-for-byte restoration verified. A negative
test leaves exactly one guard able to fire and asserts the refusal REASON, not
merely an exit code. A clause that can never be the sole reason for a refusal is
deleted rather than kept as decoration.

## Verification plan

1. `node scripts/preflight.mjs` — every mutation valid before any expensive run.
2. `npm run typecheck`, then `npm test` — the full suite green.
3. The strict clean-environment probe TASK-017 established:
   `env -i PATH="$(dirname $(command -v node))" HOME="$HOME" node --test dist/tests/*.test.js`
4. `node scripts/mutate.mjs` — zero survivors, zero unmeasured, zero wrong-test,
   both closing proofs.
5. Freeze the candidate; independent acceptance review by a model that did not
   implement it (C4/C5); the ADR-0002 gate before any integration.

Part A and Part B are frozen together and reviewed separately, in that order.
