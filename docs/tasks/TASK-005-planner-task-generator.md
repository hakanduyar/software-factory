# TASK-005 — Durable Planner / Task Generator

## Objective
Build the durable planning layer that turns a human's natural-language goal
into an explicit, reviewable, **immutable-after-approval** execution plan, and
— only after a trusted human approves that exact plan revision — materializes
it into real Factory WorkItems and hands them to the accepted TASK-004
autonomous engineering loop.

TASK-005 is the bridge:

```
NATURAL-LANGUAGE INTENT
        ↓   (planner worker — untrusted proposal)
DURABLE PLAN REVISION
        ↓   (deterministic validation)
PLAN_REVIEW
        ↓   (trusted-human approval, bound to revision + content digest)
APPROVED  (frozen)
        ↓   (idempotent, crash-safe materialization)
WORK ITEMS  (real Factory Core records, READY)
        ↓   (dependency-ordered dispatch)
TASK-004 AUTONOMOUS ENGINEERING LOOPS
```

TASK-005 owns **planning and dispatch**. It does not own implement / verify /
review / remediate — that is TASK-004's accepted state machine, invoked, never
reimplemented.

## Scope boundary (non-goals)
Not implemented here, deliberately: server/VPS deployment, Telegram, n8n,
Control Room UI, GitHub Issues/Projects orchestration, Hermes, public release,
model scoring/router learning, automatic main merge, automatic release,
automatic publish, automatic deployment, broad product-management platform
functionality, parallel loop orchestration.

---

## 1. Layer placement

`src/planning/` is a new orchestration-layer sibling of `src/orchestration/`
(TASK-004), for the same reason TASK-004 gave: these types coordinate multiple
trusted `FactoryService` calls, they are **not** TASK-001 domain objects, and
`docs/DOMAIN_MODEL.md` is not modified by this task.

```
src/planning/
  planTypes.ts             durable Plan state types + canonical id helpers
  planDigest.ts            content digest of a plan revision (approval binding)
  plannerOutputContract.ts strict, fail-closed planner output parser
  planValidation.ts        deterministic plan validation (schema, DAG, authority)
  planSerialization.ts     strict parse/validate of persisted rows
  planRepository.ts        persistence port
  plannerWorker.ts         provider-neutral planner worker port (C9)
  loopDispatcher.ts        narrow port onto TASK-004 (no reimplementation)
  planningService.ts       the orchestrator
  scriptedPlannerWorkers.ts deterministic planner/dispatcher for tests + demo
src/adapters/planning/
  inMemoryPlanRepository.ts
  sqlitePlanRepository.ts
  engineeringLoopDispatcher.ts   real adapter onto EngineeringLoopService
src/cli/plan.ts            sf plan start|status|answer|approve|reject|resume|cancel
src/cli/demoPlan.ts        npm run demo:plan (offline, deterministic)
```

## 2. Planning state machine

`PlanPhase`, named consistently with `LoopPhase`:

| Phase | Meaning |
| --- | --- |
| `DRAFT` | request persisted; planner not yet launched |
| `PLANNING` | a planner action is claimed / in flight |
| `NEEDS_CLARIFICATION` | planner reported genuine blocking ambiguity; awaiting human answers |
| `PLAN_REVIEW` | a validated revision awaits a trusted-human decision |
| `APPROVED` | a human approved this exact revision; it is frozen |
| `MATERIALIZING` | creating/advancing WorkItems from the approved revision |
| `EXECUTING` | WorkItems exist; dependency-ordered TASK-004 dispatch in progress |
| `WAITING_FOR_HUMAN` | every required item finished execution and needs a human release decision |
| `COMPLETED` | derived from authoritative WorkItem state (see §11) |
| `REJECTED` | a human rejected the revision; no execution may follow |
| `BLOCKED` | budget exhausted, or a prerequisite failed so downstream cannot safely run |
| `CANCELLED` | trusted-human cancellation |
| `RECOVERY_REQUIRED` | authority/execution state cannot be safely reconstructed — fail closed |

- **Terminal** (no further automatic action): `COMPLETED`, `REJECTED`,
  `CANCELLED`, `RECOVERY_REQUIRED`.
- **Active** (subject to the one-active-plan-per-request database constraint):
  `DRAFT`, `PLANNING`, `NEEDS_CLARIFICATION`, `PLAN_REVIEW`, `APPROVED`,
  `MATERIALIZING`, `EXECUTING`.
- `BLOCKED` and `WAITING_FOR_HUMAN` are **not** terminal and **not** active:
  they take no further automatic action, but a later `resume` re-derives them
  from authoritative state (a human may have released a blocking item).

### 2.1 `PLANNING` is a lease, not a retry flag

> **Remediation round 1 (independent review HIGH 5).** `PLANNING` used to mean
> simply "retryable", so a second caller arriving while the first planner was
> still in flight claimed another attempt — and a blocked-worker probe observed
> two real planner calls running concurrently for one logical action.

A durable `PlannerAction` lease is written by CAS **before** anything external
happens, in two states that preserve safe retry without ever risking a
duplicate:

| state | written | meaning on discovery |
| --- | --- | --- |
| `CLAIMED` | before the launch | the launch **provably** never happened; a bounded, budgeted, audited retry is safe |
| `RUNNING` | immediately before invoking the planner | the outcome is unknowable if the owner is gone; fail closed to `RECOVERY_REQUIRED` rather than spend a second model run finding out |

Durable state can prove a lease exists and who took it; it cannot prove that
owner is still alive. So liveness within a process is tracked in memory and
combined with the durable `ownerId`: an in-flight lease is never stolen, a lease
belonging to a vanished owner is reconciled by its state, and a second live
service instance over the same database lands in the conservative branch by
design. That trade is deliberate — a false "needs recovery" costs a human one
command; a false "safe to relaunch" costs duplicate external work and a
corrupted planning budget.

The invariant **"a lease exists exactly while `PLANNING`"** is enforced in one
place on the write path (`commit()` releases it with any phase change away from
`PLANNING`) and re-proved on the read path by `planSerialization`. A `PLANNING`
row with no lease is not a state any code path can produce, so it fails closed
rather than silently retrying.

## 3. The critical invariant — plan approval

Natural-language intent is not execution authority. A generated Plan is not
execution authority. A model saying "the plan looks good" is not execution
authority. **Only a trusted-human `PLAN_APPROVAL` bound to an exact plan
revision and its exact content digest authorizes anything.**

Before that approval exists:
- no implementation worker runs,
- no TASK-004 loop starts,
- no WorkItem is created,
- no release/publish action occurs.

Enforced structurally: `PlanningService` performs materialization/dispatch only
from the `APPROVED`/`MATERIALIZING`/`EXECUTING` phases, and each of those
re-derives the approval through the accepted central gate
(`FactoryService.gateStatus` → `gateGuard.evaluateGate`) on **every** entry —
never from the persisted phase, which is checkpoint state, not authority. This
is the same lesson TASK-004 remediation rounds 3–5 established for
`WAITING_FOR_HUMAN`.

## 4. Plan revisions and immutability

A `PlanRevision` is an immutable, append-only record:

```ts
interface PlannedWorkItem {
  readonly key: string;            // plan-local, unique within the revision (e.g. "WI-A")
  readonly title: string;
  readonly type: WorkItemType;     // reuses the accepted domain enum
  readonly priority: Priority;     // reuses the accepted domain enum
  readonly spec: string;           // the explicit Spec for this item
  readonly acceptanceCriteria: readonly { text: string; verificationHint: string }[];
  readonly dependsOn: readonly string[];  // plan-local keys
}

interface PlanRevision {
  readonly revision: number;       // 1-based, strictly increasing, no gaps
  readonly summary: string;
  readonly assumptions: readonly string[];   // safe assumptions, recorded not asked
  readonly constraints: readonly string[];
  readonly risks: readonly string[];
  readonly items: readonly PlannedWorkItem[];
  readonly contentDigest: string;  // derived; recomputed and cross-checked on every read
  readonly plannerRunRef: string;  // audit reference to the planner action that produced it
  readonly generatedAt: Timestamp;
}
```

`contentDigest` (`planDigest.ts`) is a SHA-256 over a canonical serialization of
everything semantically authoritative — revision number, summary, assumptions,
constraints, and every item's key/title/type/priority/spec/acceptance
criteria/dependsOn, in fixed field order with items sorted by key. It
deliberately mirrors `computeSnapshotId` in
`src/domain/executionSnapshot.ts`: **derived, never stored as authority**.

Immutability is enforced three ways:
1. `planSerialization.ts` recomputes every stored revision's digest on read and
   throws `PersistenceCorruptionError` on mismatch — a tampered revision cannot
   load at all.
2. The approval is bound to `(planId, revision, approvalDigest)`; changing any
   approved content changes the digest and instantly invalidates the approval
   at the central gate.
3. Revisions are append-only: `PlanningService` never rewrites an existing
   revision; a material change produces revision N+1, which re-enters
   `PLAN_REVIEW`. Approval of revision N never authorizes N+1 — the gate binding
   compares both the revision number and the digest, and a plan carrying an
   approval alongside a newer revision is refused as an impossible lineage.

### 4.1 The APPROVAL digest — what a human is actually bound to

> **Remediation round 1 (independent review HIGH 4).** A revision digest answers
> "is the proposed WORK unchanged?". That is necessary and was never sufficient:
> independent review switched a plan's `projectId` from A to B and rewrote its
> verification commands to `sh -c ...`, and the approval survived both, because
> neither field lives inside a revision.

A human approval is bound to `computePlanApprovalDigest` (the `papr-` digest),
which covers the revision digest **and** every persisted plan field that can
change what gets executed, where it is created, or how it is verified. The
classification rule is deliberately blunt, because a subtle one produced the
finding: persisted plan **configuration** is approval-authoritative; only
provenance, append-only audit and mutable runtime checkpoints are excluded.

| class | fields |
| --- | --- |
| APPROVAL-AUTHORITATIVE (hashed) | `projectId`, `intent`, `declaredConstraints`, `budget`, `planner`, `execution` (implementer, reviewer, every verification command's `id`/`executable`/`argv`/`cwd`/`timeoutMs`, `workspaceRoot`, `loopBudget`), and the full revision content |
| AUDIT / METADATA ONLY | `events`, `startedBy`, `startedAt`, `lastTransitionAt`, `openQuestions`, `answers`, `revision.generatedAt`, `revision.plannerRunRef` |
| RUNTIME CHECKPOINT ONLY | `phase`, `version`, `plannerAction`, `attemptsForCurrentRevision`, `clarificationCycles`, `totalPlannerRuns`, `materializationClaim`, `materialized`, `dispatchClaim`, `dispatches`, `outcome`, `failureReason`, `exhaustionKind`, `cancelRequested`, `approvalId`/`approvedRevision`/`approvedDigest` |
| DERIVED / NON-PERSISTED | `requestKey`, `revision.contentDigest`, correlation and planner-lease tags, `PlanStatusView` |

`budget` and `planner` are hashed although both are spent before approval:
including them costs nothing, and "this field cannot matter after approval" is
exactly the reasoning that left `execution` unbound.

The digest is recomputed from **live** state at every decision point — recording
the approval, `status()`, materialization, dispatch — and `planSerialization`
recomputes it too, so a tampered plan does not load at all. It is deliberately
named `approvalDigest` rather than `contentDigest` wherever it crosses a
boundary: a name saying "content" is what invited leaving configuration out.

## 5. Spec revision binding

Materialized WorkItems derive their Spec and Acceptance Criteria **only** from
the approved revision's `PlannedWorkItem`. There is no second revision-authority
system: the accepted `WorkItem.specRevision` semantics are reused unchanged, and
each materialized item carries

```
planVersion = "<planId>:r<revision>:<itemKey>"
```

which is both the human-readable provenance and the **crash-recovery
correlation tag** (§9) — the same technique TASK-004 used with
`declaredWorkerId`. `planVersion` is written by the accepted
`FactoryService.createWorkItem` in the same transaction that creates the item,
so it is durable before any side effect that depends on it.

If the live plan's approved revision digest ever stops matching the digest
stamped into the approval, materialization and dispatch both refuse — the plan
fails closed to `RECOVERY_REQUIRED` rather than executing content no human
approved.

## 6. Clarification policy

Low human friction is a product goal. The planner is instructed (and the
Factory validates) to classify each unknown as exactly one of:

1. **BLOCKING AMBIGUITY** — multiple materially different interpretations exist
   and choosing one could substantially change product behaviour, safety,
   irreversible actions, architecture boundaries, or acceptance criteria.
   → ask the human (`NEEDS_CLARIFICATION`).
2. **SAFE ASSUMPTION** — a conventional, reversible choice can be made and
   documented. → do not interrupt; record it in `assumptions`.
3. **IMPLEMENTATION DETAIL** — the implementation agent can resolve it during
   approved execution without changing product intent. → do not interrupt.

Contract-level enforcement: a planner response with a non-empty
`blockingQuestions` array puts the plan in `NEEDS_CLARIFICATION` and **no
approvable revision is persisted from it**; a response with an empty
`blockingQuestions` array must contain at least one work item or it is rejected
as malformed. Answers bind to `(planId, revision, questionId)`; an answer for a
superseded revision is refused (§14 test group B).

**A clarification consumes no revision number.** This is deliberate, and worth
stating because it is easy to assume otherwise: `PlanRevision` means *an
approvable plan*, so asking a question does not create one. A plan that asks
once and then plans successfully holds exactly one revision, numbered 1 — not a
question-shaped revision 1 followed by a real revision 2. The invariant this
preserves is that **every persisted revision is approvable**, which is what lets
the approval binding stay simple: there is no class of revision a human could be
shown but never approve. The clarification itself is not lost — it is recorded
in the append-only event log as `CLARIFICATION_REQUESTED` /
`CLARIFICATION_ANSWERED`, and in the durable `answers` array.

## 7. Planner worker and output contract

### 7.1 Provider neutrality (C9)
`PlannerWorker` is a narrow port in `src/planning/plannerWorker.ts`. No model
name appears in the planning layer: tool/model/effort arrive as injected
configuration (`PlanExecutionConfig`), persisted with the plan so a restart
uses identical configuration. Automated tests and `npm run demo:plan` inject
deterministic scripted planners — **no real AI call ever happens in a test or
demo**.

The accepted `Worker`/`FactoryService.runWorker` path is deliberately **not**
reused for planning: it requires an existing WorkItem, and planning happens
strictly before any WorkItem exists. Planning actions are audited in the plan's
own append-only event log instead (§12).

### 7.2 What the planner is given
Bounded and explicit: the human goal, declared constraints, prior answered
clarifications, a curated list of project rules/invariants, and the output
contract text. It is **not** given secrets, credentials, unrelated repository
data, or unrestricted machine context. The prompt is assembled by
`planningService` from durable plan fields only.

### 7.3 Strict output contract
The planner must emit exactly one marker line followed by exactly one fenced
JSON block:

```
FACTORY_PLAN_V1
```json
{ "summary": "...", "assumptions": [...], "constraints": [...],
  "risks": [...], "blockingQuestions": [...], "items": [...] }
```
```

`plannerOutputContract.ts` applies the same defensive discipline
`reviewVerdictParser.ts` established:

- zero markers → reject; **more than one marker → reject as ambiguous** (not
  "take the first"), exactly as the reviewer parser treats duplicate verdict
  tags;
- exactly one fenced ` ```json ` block must follow the marker; zero or many → reject;
- strict `JSON.parse`, then strict schema validation of every field and enum —
  unknown work-item types, unknown priorities, non-string fields, malformed
  acceptance criteria and unknown top-level keys are all rejected;
- **no control-string smuggling**: raw planner output containing a
  `FACTORY_REVIEW_VERDICT:` tag is rejected outright, so a planner cannot plant
  a reviewer verdict into evidence that a later stage might read;
- **no self-granted authority**: any item asserting release/publish/approval
  authority (a reserved-word check over item keys and declared fields) is
  rejected;
- malformed output never becomes an approvable revision. It consumes a bounded
  planner attempt and, once the budget is exhausted, the plan fails closed to
  `BLOCKED`.

The parser is pure (no I/O) and is only invoked for a planner action whose
process-level status was `SUCCEEDED` — a crashed planner's stdout never reaches
it.

### 7.4 Exactly one structured output channel

> **Remediation round 1 (independent review HIGH 6).** `cliPlannerWorker` pooled
> transcript evidence **and** the run summary — but `cliWorker.buildSummary`
> already embeds the transcript's first 200 characters. A valid planner answer,
> whose marker is on the first line, therefore arrived carrying two markers and
> was correctly refused by the ambiguity rule above. The production planner path
> could never succeed.

The fix is the **boundary**, not the parser: the exactly-one-marker rule is
sound and was not weakened. Pooling a channel with a truncated copy of itself is
what manufactured the ambiguity.

The adapter now reads only the structured `/transcript` evidence channel — the
same constant and the same rule the accepted TASK-004 reviewer-verdict path uses.
`/raw-output` (recorded only when the tool violated its own structured contract)
and the bounded run summary remain **diagnostics**, and can never create
authority: output that merely looks like a result must fail closed, not be
adopted. If a tool ever emits more than one structured transcript, both are
passed to the parser so it can refuse — this adapter never quietly picks one.

This is exercised through the real composition (`createCliPlannerWorker` →
`createLoopWorker` → `createCliWorker` → a fake `ProcessRunner`), which closes
the previously documented "no automated test for a successful real CLI planner
start" gap for the production wiring without invoking any model.

## 8. Deterministic plan validation

Before a revision may enter `PLAN_REVIEW`, `planValidation.ts` must pass every
check:

- valid schema and non-empty goal/summary;
- valid, strictly-increasing revision number;
- plan-local item keys unique and non-empty;
- every item has a non-empty Spec;
- every item has at least one acceptance criterion (mirrors the accepted
  `createWorkItem` invariant, C2/C3);
- every `dependsOn` entry references an item key that exists in this revision;
- no self-dependency;
- the dependency graph is acyclic (Kahn's algorithm; the topological order it
  produces is reused as the materialization/dispatch order);
- no unsupported lifecycle values anywhere;
- no item claims release/publish authority;
- no item bypasses plan approval.

A revision failing validation is **not** shown to the human for approval — the
Factory never asks a human to approve malformed content. It consumes a bounded
attempt and retries or fails closed.

## 9. Materialization

Runs only from `APPROVED`/`MATERIALIZING`, only after the central gate
re-confirms the approval against the live revision digest.

Per item, in topological order, using a durable CAS-protected protocol that
mirrors TASK-004's action-claim design:

1. **Mapping exists?** Verify the mapped WorkItem still exists and its
   `planVersion` correlation tag matches this exact `(planId, revision, key)`.
   Match → skip (idempotent). Mismatch → `RECOVERY_REQUIRED` (fail closed).
2. **No mapping:** write a durable materialization claim via CAS **before**
   creating anything.
3. **Reconcile a dangling claim first:** list the project's work items and match
   the exact `planVersion` tag. Found → adopt the mapping (the create committed;
   the crash happened after). Not found → the create never committed; clear the
   claim and retry.
4. Create the WorkItem via the accepted `FactoryService.createWorkItem` with the
   approved Spec, acceptance criteria, type, priority, and resolved
   `dependencies` (real WorkItemIds, available because topological order
   guarantees prerequisites are materialized first).
5. Advance `IDEA → ANALYSIS → PLAN_REVIEW`, each step idempotent (checked
   against live status first).
6. Record the **derived** per-item `PLAN_APPROVAL` (§10), then advance
   `PLAN_REVIEW → READY` through the accepted gate.

Partial materialization is therefore always detectable and resumable, never
duplicated, and never "best effort and hope".

### 9.1 A correlation tag identifies a candidate; it does not prove one

> **Remediation round 1 (independent review HIGH 3).** Both adoption paths
> trusted `planVersion` alone. The tag is a pure function of public coordinates,
> so anyone who can create a work item can mint a candidate — and review had a
> work item with a completely different title, type, priority and acceptance
> criteria adopted as approved work and advanced past `PLAN_REVIEW`.

Before adopting any pre-existing candidate — whether found by crash
reconciliation or by the defensive pre-create lookup — `adoptIfApproved`
compares the candidate's complete authoritative content against the approved
plan item using the shared `MaterializedItemShape`. On mismatch the plan fails
closed to `RECOVERY_REQUIRED`. It deliberately does **not** create a second work
item behind the impostor, and deliberately does **not** edit the impostor into
compliance: both would be this service deciding, unattended, what a human
approved.

The same comparison is re-applied on every read and every drive step that acts
on materialized state (`verifyMaterializationIntegrity`), because a mapping is a
**reference**, never proof (round 1, HIGH 7). A mapping whose work item no
longer exists, belongs to another project, or no longer matches the approved
content makes `status()` report a read-only `RECOVERY_REQUIRED` projection and
`resume()` record it durably — instead of `status()` reporting `EXECUTING` while
`resume()` throws `NotFoundError` from the middle of a drive step. `status()`
starts no worker and writes nothing; reading a plan must never be what changes
it.

### 9.2 A dispatch record is a reference too

> **Remediation round 2 (second independent review, the one remaining HIGH).**
> Round 1 established "a mapping is a reference, not proof" and applied it to
> `plan.materialized` — and stopped there. `plan.dispatches` holds foreign
> references as well. The reviewer set a dispatch's `loopId` to a value naming
> no loop: `status()` reported `EXECUTING`, and `resume()` threw a raw
> `no scripted loop ...` error out of the middle of a drive step.
>
> Probing while fixing it found the stronger case the review did not test, and
> which an existence check would not have caught: **swap** two dispatches'
> `loopId`s and every reference still resolves to a real, live loop — just the
> wrong one. A plan whose every item is wired to another item's execution would
> have been accepted.

So what `resolveDispatchViews` proves is **lineage**, not existence, and it does
so through the accepted TASK-004 read API rather than a new one.
`LoopDispatcher.find(workItemId)` answers "which loop does this work item
actually have", which makes one comparison cover both failures at once: a
missing loop yields no view or a different id, and a substituted loop yields a
different id. Planning gains no new reach into TASK-004 and no second, weaker
authority model. Per dispatch it proves: the plan item is in the approved
revision; the mapping exists and names the same work item; the loop id is
present, non-empty and claimed by no other item; a loop exists for that work
item; its id is exactly the dispatched one; and it targets that work item.

The resolved views are **returned**, not merely validated, so the step that
needs a loop's phase uses the view already proven to belong to this dispatch
instead of looking the id up again. That is how the raw throw is *removed*
rather than merely caught.

A missing loop is treated as **ambiguous, never as proof that nothing ran**: the
plan fails closed to `RECOVERY_REQUIRED` and no replacement loop is launched.
`loopId = X` plus "X is not there" does not establish that the dispatch never
crossed its launch linearization point, and inventing that proof is exactly how
duplicate external work happens.

### 9.3 Foreign-reference inventory

Round 1 fixed one dangling-reference bug and round 2 found its sibling, so every
persisted Plan reference to an external object was swept and classified:

| reference | class | how it is proved |
| --- | --- | --- |
| `materialized[].workItemId` | authority-relevant | `verifyMaterializationIntegrity` — exists AND matches the approved shape |
| `dispatches[].loopId` | authority-relevant | `resolveDispatchViews` — exists AND belongs to this dispatch's work item |
| `dispatches[].workItemId` | authority-relevant | cross-checked against the mapping, structurally at decode and again at use |
| `approvalId` | authority-relevant | re-read from the append-only approvals table and re-judged at the central gate |
| `projectId` | authority-relevant, **transitively** proved | a store without the project is a store without the approval; approval authority is re-derived before anything is created, so it fails closed first (pinned by a test) |
| `materializationClaim` / `dispatchClaim` | checkpoint | reconciled against authoritative state before use; the claim itself is never authority |
| `plannerAction.correlationTag`, `revisions[].plannerRunRef` | structure only | derived identities, recomputed on read; no external object to resolve |
| `items[].dependsOn`, `answers[].questionId` | structure only | plan-local lineage, validated in `planSerialization` |

Only the authority-relevant rows are resolved live. Audit and checkpoint
references are deliberately NOT turned into live lookups — that would make
reading a plan depend on external availability without buying any safety.

### 9.35 An authority field that does not round-trip does not exist

> **Remediation round 3 (third independent review, the one remaining HIGH).**
> `ApprovalContext` gained four TASK-005 authority fields —
> `planContentDigest`, `derivedFromApprovalId`, `planId`, `planRevision` — while
> `src/adapters/sqlite/serialization.ts` kept an older three-field whitelist.
> Nothing threw, nothing was corrupted, and nothing was insecure: the evidence
> was simply deleted in transit, and `gateGuard` then did exactly its job and
> refused an approval with no digest. Every durable SQLite-backed plan was
> permanently unable to leave approval — the real `sf plan approve` path was
> dead — while all 928 tests passed, because the tests used an in-memory Factory
> store that stores objects directly and therefore loses nothing.

The fix is in the persistence adapter, where the defect was. The authority
checks were correct and were NOT relaxed: persistence was dropping required
evidence, so persistence was fixed. `parseApprovalContext` now reconstructs
every declared field with the same strict validation as the rest of the file —
optional-when-absent, refused when malformed, never coerced, never silently
dropped (`planRevision` is validated as a positive integer, not merely a
number).

Two rules came out of this, and both are enforced by tests rather than
intention:

1. **Every authority field must survive every production persistence adapter.**
   `tests/approvalContextRoundTrip.test.ts` round-trips a MAXIMAL context and
   asserts field-by-field equality. Its field list is typed
   `Record<keyof Required<ApprovalContext>, true>`, so adding a field to the
   domain type without listing it is a COMPILE error, and listing a field the
   adapter drops is a RUNTIME failure. A future field cannot reach production
   without surviving a real round-trip.
2. **Tests must exercise the composition production actually builds.** This was
   the third finding in a row traced to a substitute: an in-memory Factory store
   here, a fresh dispatcher in round 2, a pooled output channel in round 1.
   `tests/task005RemediationRound3Repro.test.ts` therefore integrates the real
   chain — SQLite Factory store, SQLite plan repository, real `FactoryService`
   with its real identity gate and binding resolver, real `PlanningService` —
   and drives approve → materialize → derived approval → dispatch, then closes
   both databases, reopens them, and continues with no re-approval. Only the two
   AI seams (planner, TASK-004 loop) are scripted.

A domain/adapter parity audit over every persisted type — `Project`,
`WorkItem`, `AcceptanceCriterion`, `Run`, `Review`, `Evidence`,
`AcceptanceCriterionVerification`, `Approval`, `ApprovalContext`, `Actor`,
`SubjectRef`, `StatusChange` — found no other field-loss of this class.

### 9.4 Where structural validation ends and authority begins

`planSerialization` proves everything decidable from the row **itself**: key
coherence, that a dispatch's work item agrees with its own mapping, loop-id
shape and uniqueness, and legal phase/state relationships. It deliberately does
NOT ask whether the referenced EngineeringLoop exists — that lives in another
store, and a decoder reaching across stores would make "can this row be read"
depend on live external state, so a transient outage would be indistinguishable
from corruption.

Cross-store lineage is therefore proved at **use** time, and fails closed to
`RECOVERY_REQUIRED` rather than refusing to load. `status()` and `resume()` share
one projection (`projectFailClosed`), so the read path and the write path may
differ in whether they PERSIST a conclusion but never in what the conclusion is
— including for terminal plans, where round 2 found `resume()` reporting
`COMPLETED` for a record `status()` already judged unsound.

## 10. Derived per-WorkItem plan approval (the one accepted-code extension)

The accepted transition table requires a `PLAN_APPROVAL` on each **WorkItem**
subject to reach `READY`, and `gateGuard` requires it to be `decidedBy` a HUMAN.
A single human plan approval must therefore be materialized into per-item
approvals — unattended, and crash-safely (a live `TrustedHumanToken` cannot be
held across a restart, and workers must never hold credentials).

`FactoryService.recordDerivedPlanApproval` does exactly this, and **cannot
manufacture human authority**.

> **Remediation round 1 (independent review HIGH 1 + HIGH 2).** The first
> version of this section described a weaker rule than the one below, and the
> code implemented it. It validated the source approval and the target's
> *status*, and took the caller's word for everything connecting the two — so a
> caller naming any work item at `PLAN_REVIEW` received a real, human-attributed
> approval for it, including a work item in a different project. It also never
> asked whether that decision was still current. The rule is now:
>
> **One human plan approval authorizes only the exact execution content the
> human approved — and what that is, is answered by durable plan state, not by
> the caller.**

`RecordDerivedPlanApprovalInput` therefore carries **only identifiers**
(`planId`, `sourceApprovalId`, `workItemId`). The removed
`expectedPlanRevision`/`expectedContentDigest` parameters were the vulnerability:
a caller that states what an approval covers is a caller that can widen it.

Four independent things must hold, none of them caller-supplied:

1. **MEMBERSHIP.** `PlanBindingResolver.resolveMaterializationTarget(planId,
   workItemId)` proves, from the plan's own durable materialization mapping,
   that this work item is one of the approved revision's targets — and returns
   the complete content that target is required to have. It refuses an unknown
   plan, a plan with no recorded approval, an approval superseded by a newer
   revision, a durable cancellation request, a plan whose recomputed approval
   digest no longer matches, and any work item that is simply not mapped.
2. **LINEAGE.** The source approval is re-read **by id from the repository** and
   must be `gate = PLAN_APPROVAL`, `decision = APPROVED`,
   `subject = { type: "PLAN", id: planId }`, `decidedBy.kind = "HUMAN"`, and
   stamped with exactly the revision and approval digest the resolver returned.
3. **CURRENCY.** The accepted central gate is re-evaluated **now** for the PLAN
   subject against that binding. Historical approval evidence is not current
   authority: a later rejection, a superseding revision or a cancellation
   revokes it, while the record stays in the audit trail (C8).
4. **CONTENT.** What the Factory actually stored is compared against the
   approved target field for field — project, correlation tag, title, type,
   priority, spec revision, dependencies and acceptance criteria — through the
   single `MaterializedItemShape` definition shared with creation, adoption and
   read-time mapping validation, with a whole-shape fingerprint as the backstop.

The derivation is **idempotent by identity**: `derivedPlanApprovalId()` derives
the approval's id from `(planId, revision, sourceApprovalId, workItemId,
specRevision)`, so a duplicate is refused by the append-only store itself rather
than by a check-then-act read that concurrent callers all lose.

There is no path to a WorkItem `PLAN_APPROVAL` that does not require a real
human to have approved that exact plan content, for that exact work item. The
derivation is fully audited by `derivedFromApprovalId`.

Two small, additive extensions to accepted TASK-001 code make this possible,
each mirroring an existing mechanism rather than introducing a new one:

- `ApprovalContext` gains optional `planContentDigest`, `derivedFromApprovalId`,
  `planId`, `planRevision`; `GateBinding` gains optional `planContentDigest`,
  and `evaluateGate` checks it exactly the way it already checks `snapshotId`.
- `FactoryService.recordApproval` learns a `PLAN`-subject branch that stamps the
  binding **from live state** via an injected `PlanBindingResolver` port —
  precisely the discipline the existing `WORK_ITEM` branch uses for
  `specRevision`/`snapshotId`. Without a configured resolver, a `PLAN` approval
  is refused rather than recorded unbound.

## 11. Dependency execution, TASK-004 handoff, and completion

**Prerequisite satisfaction** is deliberately *execution finished and
independently verified*, not *released*:

> a prerequisite is satisfied when its WorkItem is `DONE`, **or** it is at
> `WAITING_FOR_HUMAN` **and** `FactoryService.resolveWaitingForHumanAuthority`
> currently proves that authority.

This uses the accepted TASK-004 remediation-round-3 resolver, so a stale or
superseded `WAITING_FOR_HUMAN` can never satisfy a dependency. It keeps the
three concepts explicitly distinct: **execution finished** (`WAITING_FOR_HUMAN`
with live authority) ≠ **release approved** (`DONE`) ≠ **published**.

A prerequisite that is `CANCELLED`, `BLOCKED`, or whose loop reached
`EXHAUSTED`/`FAILED`/`RECOVERY_REQUIRED` blocks downstream dispatch and moves
the plan to `BLOCKED`.

**Dispatch** goes through the `LoopDispatcher` port, whose real adapter wraps the
accepted `EngineeringLoopService`. TASK-005 implements **no** second engineering
loop: it never touches implement/verify/review/remediate state. Before starting,
it reconciles by asking the dispatcher for an existing loop for that WorkItem —
combined with TASK-004's database-level one-active-loop-per-work-item
constraint, duplicate dispatch is impossible. Execution is sequential; parallel
orchestration is explicitly out of scope (correctness over concurrency).

**Completion** is derived from authoritative WorkItem state only — never from
"all agents returned success". The plan reaches `WAITING_FOR_HUMAN` when every
required item is execution-finished, and `COMPLETED` only when every required
item is `DONE` (i.e. a human granted each release approval). TASK-005 completion
does **not** mean release or publish approval.

## 12. Persistence and audit

One additional SQLite file (`.factory-data/plans.db`), consistent with TASK-002
philosophy and TASK-004 precedent; no new database technology.

- explicit `plan_schema_version` marker **plus** full structural validation of
  every table, column, PRIMARY KEY and index before any query trusts the file;
- a partial `UNIQUE` index over `request_key` restricted to active phases makes
  "at most one active plan per request" a database constraint, not a
  check-then-insert; its **WHERE predicate itself** is validated, following the
  TASK-004 round-2 lesson that `PRAGMA` introspection cannot see which phases a
  partial index restricts to;
- rows decode through `planSerialization.ts` (full shape/enum/range/coherence
  validation, digest recomputation, and SQL-column↔JSON cross-checks), never
  through a cast;
- CAS on a single `version` column is the linearization point for every claim,
  phase change, approval record and cancellation;
- an append-only `events` log records: request created, planner run started,
  planner run failed, revision generated, clarification requested, clarification
  answered, entered review, approved, rejected, materialization started, work
  item materialized, dispatched, item terminal, budget exhausted, cancelled,
  recovery required, completed. Event detail is bounded and carries no
  credentials or secrets.

**Request identity.** `requestKey = "req-" + sha256(projectId | intent).slice(0,16)`,
derived deterministically, so starting the same intent twice adopts the existing
active plan instead of creating a duplicate, and two concurrent starts serialize
inside SQLite with the loser receiving `ConcurrencyError`.

## 13. Budgets

Planner budgets are separate from TASK-004 execution budgets and never mixed:

```ts
interface PlanBudget {
  readonly maxPlannerAttempts: number;      // per revision, including parse-failure retries
  readonly maxClarificationCycles: number;
  readonly maxTotalPlannerRuns: number;
  readonly maxWallClockMs?: number;
}
```

Counters are persisted and survive restart. There is no unbounded
plan → parse-fail → retry loop: exhaustion fails closed to `BLOCKED` with an
explicit `exhaustionKind`.

## 14. Cancellation

Plan cancellation is a trusted-human governance action using the same
`HumanIdentityGate`/`TrustedHumanToken` mechanism as every other C1 gate —
verified **before** any state is read or written, exactly as TASK-004
remediation round 3 established for loop cancellation. Defined behaviour:

- before approval → plan `CANCELLED`; nothing was created, nothing to undo;
- after approval, before dispatch → `CANCELLED`; no WorkItem may be created or
  dispatched afterwards;
- with WorkItems already materialized → `CANCELLED`; no new WorkItem or loop may
  launch. Existing WorkItems are left in place for the human to decide on
  (TASK-005 does not mass-cancel accepted Factory records);
- with a TASK-004 loop already running → cancellation is recorded durably and no
  *new* dispatch occurs; the running loop keeps TASK-004's own accepted
  cancellation semantics. No unsafe hard-kill is attempted.

## 15. CLI

```
sf plan start <project-id> --intent <path> [--config <path>]
sf plan status <plan-id>
sf plan answer <plan-id> --answers <path>
sf plan approve <plan-id>
sf plan reject <plan-id> [--note <text>]
sf plan resume <plan-id>
sf plan cancel <plan-id>
```

`status` is strictly read-only and manufactures no authority (it re-derives, and
reports a non-persisted fail-closed projection when cached state is not backed
by live authority — the TASK-004 round-4 discipline). `approve`, `reject` and
`cancel` mint a `TrustedHumanToken` from the same local gate the rest of `sf`
uses. No CLI path bypasses the service layer.

## 16. Demo

`npm run demo:plan` — fully offline and deterministic (scripted planner,
scripted loop dispatcher, in-memory stores, fixed clock):

1. clear intent → plan generated → `PLAN_REVIEW` → human approves → WorkItem
   materialized → scripted TASK-004 loop reaches `WAITING_FOR_HUMAN`;
2. genuine blocking ambiguity → `NEEDS_CLARIFICATION` → answer → revised valid
   revision → `PLAN_REVIEW` → approve → execution;
3. multi-item dependency plan → A executes, B waits, A succeeds, B dispatches;
4. malformed planner output / budget exhaustion → fails closed;
5. crash + restart after approval with partial materialization → reconciliation
   → no duplicate WorkItems or loops.

---

## Acceptance criteria

A criterion is met only when a permanent automated test proves it. No real AI
call may occur in any test or demo.

**AC-1 — Intent is not authority.** Raw intent alone cannot create a WorkItem or
start a TASK-004 loop; an unapproved generated revision cannot either. A planner
that emits `APPROVED`, `PASS`, or a `FACTORY_REVIEW_VERDICT:` tag gains no
authority from it.

**AC-2 — Strict planner contract.** Zero markers, multiple markers, a missing or
duplicated JSON block, invalid JSON, unknown enum values, unknown top-level
keys, missing acceptance criteria, and control-string smuggling are each
rejected, and none produces an approvable revision.

**AC-3 — Clarification policy.** Genuine blocking ambiguity produces
`NEEDS_CLARIFICATION` with durable questions; safe assumptions are recorded
without interrupting the human; an answer binds to the exact `(plan, revision,
question)` and a stale answer cannot modify a newer revision.

**AC-4 — Trusted human only.** `AGENT`, `SYSTEM`, a caller-constructed HUMAN
actor, a tokenless human, a forged token, another human's token and an expired
token are each refused for approve/reject/cancel, with **zero** authoritative
mutation as a result of the refusal.

**AC-5 — Revision authority.** An approval of revision N cannot authorize
revision N+1; a content change after approval invalidates the approval at the
central gate; a stale approval can neither materialize nor dispatch; the
approval binds to plan id + revision + exact content digest.

**AC-6 — Deterministic validation.** Cyclic dependency graphs, self-dependencies,
dangling dependency references, duplicate item keys, missing specs and missing
acceptance criteria are all rejected before `PLAN_REVIEW`.

**AC-7 — Materialization.** An approved plan materializes exactly the approved
WorkItems with exactly the approved Specs and acceptance criteria; a crash
midway resumes idempotently with no duplicate WorkItems, Specs or criteria;
mappings survive a real SQLite restart; content that does not match the approved
revision fails closed.

**AC-8 — Derived approval integrity.** A per-WorkItem `PLAN_APPROVAL` can only be
derived from a real human `PLAN`-subject approval whose stamped revision and
digest match the live plan; a forged/absent/rejected/non-human/wrong-subject
source approval is refused.

**AC-9 — Dependencies.** A dependent WorkItem is not dispatched until its
prerequisites are execution-finished with live authority; a failed, exhausted,
blocked or cancelled prerequisite prevents downstream dispatch; dependency
progress survives restart.

**AC-10 — TASK-004 handoff.** Eligible WorkItems are dispatched through
`EngineeringLoopService`; no second engineering loop exists; an existing loop is
reconciled rather than duplicated; `WAITING_FOR_HUMAN`, `EXHAUSTED`, `BLOCKED`
and `RECOVERY_REQUIRED` all propagate to correct plan-level states.

**AC-11 — Crash / restart.** Every boundary in §9/§11 reconciles safely:
intent persisted but planner not launched; planner action claimed; planner
output returned but revision not finalized; clarification required; awaiting
approval; approval recorded but materialization not started; partial
materialization; materialized but not dispatched; loop already exists; one
dependency finished and the next not dispatched; cancellation racing dispatch;
all items terminal but the completion checkpoint stale. Ambiguous state fails
closed to `RECOVERY_REQUIRED`; external model work is never silently rerun.

**AC-12 — Concurrency.** Duplicate plan start, concurrent resume, double
approval processing, duplicate materialization, duplicate WorkItem creation,
duplicate dispatch, cancel-vs-dispatch and approval-vs-revision-update races are
each prevented by durable CAS / database constraints, not by caller discipline.

**AC-13 — Unattended execution.** After approval, materialization, dispatch and
the whole TASK-004 cycle proceed with zero routine human prompts and zero stdin
reads. The accepted unattended-execution invariant is preserved.

**AC-14 — Persistence integrity.** Malformed JSON, structurally valid but
semantically impossible state, stale revision references, dangling WorkItem
mappings, bad dependency ids, impossible approval lineage, digest mismatch and
schema mismatch each fail closed rather than loading.

**AC-15 — No regression.** All accepted TASK-001/002/003/004 tests still pass
unchanged (549/549 baseline), including all 14 historical HIGH findings. No
existing test is weakened to make TASK-005 pass.

**AC-16 — Completion semantics.** Plan completion is derived from authoritative
WorkItem state, never from agent self-report, and is explicitly distinct from
release approval and from publishing.
