# AI HANDOFF

Status: REMEDIATED_ROUND_6_AWAITING_RE_REVIEW
Current task: TASK-001
Plan version: bootstrap-v1

## Implementer output

### Round 1 (Claude Code / Opus 5, IMPLEMENTATION ENGINEER)
Implemented the local Factory core skeleton: domain types, an explicit workflow
transition table, a gate guard for the four protected approvals, in-memory
repository adapters, a provider-neutral worker port with a deterministic mock
worker, a FactoryService application layer, and an `sf` CLI with a demo flow.
Independent review (Codex-class, see below) returned CHANGES_REQUIRED with
3 CRITICAL, 4 HIGH and 2 MEDIUM findings.

### Round 2 — remediation (Claude Code / Fable 5, IMPLEMENTATION ENGINEER)
Closed every CRITICAL and HIGH finding, plus the architectural-prerequisite
MEDIUM findings, without weakening `docs/FACTORY_CONSTITUTION.md`. Summary of
what changed, mapped to the reviewer's findings:

1. **Hollow-DONE CRITICAL** — the transition table (`src/workflow/transitions.ts`)
   now carries a `precondition` on `IMPLEMENTING -> VERIFYING`,
   `VERIFYING -> REVIEW`, `REVIEW -> WAITING_FOR_HUMAN` and
   `WAITING_FOR_HUMAN -> DONE`. Each precondition (`src/workflow/preconditions.ts`)
   reads real Run/Review/AcceptanceCriterionVerification records — never a
   worker's claim — and is revision-bound. A work item can no longer reach
   DONE by traversing statuses with zero runs and zero evidence.
2. **BLOCKED plan-gate-bypass CRITICAL** — `WorkItem` gained `blockedFrom`
   (`src/domain/workItem.ts`); `WorkflowService` now refuses any resume target
   other than the exact status the item was blocked from
   (`src/workflow/workflowService.ts`), even though the transition table still
   declares `BLOCKED -> READY` as a row (because READY is itself a legitimate
   blockable origin). `ANALYSIS -> BLOCKED -> READY` no longer skips
   PLAN_REVIEW/PLAN_APPROVAL.
3. **Caller-asserted HUMAN CRITICAL** — added a trusted-human boundary:
   `TrustedHumanToken` (`src/domain/humanIdentity.ts`), the
   `HumanIdentityGate` port (`src/ports/humanIdentityGate.ts`), and a local,
   credential-checked, HMAC-signed implementation
   (`src/adapters/security/localHumanIdentityGate.ts`). No external auth
   infrastructure was added, per the task's constraint — the boundary is a
   locally-configured shared secret that a Worker adapter is never given.
   `FactoryService.recordApproval` now rejects any actor without a token that
   verifies for that exact actor (`src/app/factoryService.ts`).
4. **Reviewer-independence-by-string HIGH** — `RecordReviewInput` now takes a
   `reviewerRunId`, not a caller-supplied `reviewerId` string; the reviewer's
   identity and independence are derived from a real, `SUCCEEDED`,
   `REVIEWER`-role Run (`src/app/factoryService.ts`). A passing review is now
   a hard precondition, not optional, for `REVIEW -> WAITING_FOR_HUMAN`.
5. **Approvals not bound to plan/spec version HIGH** — `WorkItem` gained a
   `revision` counter, bumped only on the four "sent back for rework" edges
   (`PLAN_REVIEW -> ANALYSIS`, `VERIFYING -> IMPLEMENTING`,
   `REVIEW -> IMPLEMENTING`, `WAITING_FOR_HUMAN -> IMPLEMENTING`); ordinary
   forward progress does not bump it, so evidence recorded earlier in the same
   attempt stays valid all the way to DONE. `Approval.context.revision` is
   stamped by `FactoryService` from the work item itself — never
   caller-supplied — and `evaluateGate`/`requireGate`
   (`src/workflow/gateGuard.ts`) refuse a stale approval whose recorded
   revision no longer matches. A later REJECTED decision still revokes an
   earlier APPROVED one (unchanged, already correct).
6. **Worker exceptions leave RUNNING runs HIGH** — `FactoryService.runWorker`
   now wraps `worker.execute()` in try/catch: on throw, it persists the Run as
   FAILED with a failure summary and a NOTE evidence record, then rethrows
   `WorkerExecutionError`. A FAILED run (from a throw or a normal FAILED
   outcome) never satisfies the `IMPLEMENTING -> VERIFYING` precondition.
7. **No AC verification path HIGH** — added `AcceptanceCriterionVerification`
   (`src/domain/acceptanceCriterionVerification.ts`) and
   `FactoryService.verifyAcceptanceCriteria`, which derives PASSED/FAILED
   per criterion from a successful VERIFIER run's own recorded Evidence
   (matched via a new `Evidence.criterionId` field, not text parsing) — never
   from `claimsAcceptanceMet`. `WAITING_FOR_HUMAN -> DONE` requires every
   criterion PASSED at the current revision. `createWorkItem` now also
   requires at least one acceptance criterion.
8. **Synchronous approval lookup MEDIUM** — `ApprovalRepository.listBySubject`
   is now `Promise`-returning like every other repository method;
   `evaluateGate`/`requireGate`/`WorkflowService.check`/`transition` are all
   async (`src/workflow/gateGuard.ts`, `src/workflow/workflowService.ts`).
   `WorkItemRepository` was split into `create` (new item) and
   `compareAndSave` (optimistic-concurrency update via a new `WorkItem.version`
   counter, bumped on every write) so a real filesystem/SQLite/PostgreSQL
   adapter has a concurrency-safe contract to implement, without needing to
   build one now.
9. **Concurrency / lost update** (self-identified while fixing #8) —
   `compareAndSave` throws `ConcurrencyError` when the stored version has
   moved on; see `tests/concurrency.test.ts` for a genuine two-writer race.
10. **Audit integrity** (self-identified while fixing #8) — Evidence, Review,
    Approval and AcceptanceCriterionVerification tables are append-only
    (`AppendOnlyViolationError` on id reuse); every object returned by the
    in-memory store is deep-frozen (`src/domain/freeze.ts`) so a caller
    cannot mutate stored state through a held reference.
11. **Untracked duplicate MEDIUM** — confirmed `software-factory-bootstrap/`
    was a byte-identical copy of the tracked bootstrap docs (`diff -rq`
    showed no differences beyond files this task itself edited) and removed
    it. No unique content was deleted.

Commands run (see below for the final clean-state run):
- `npm install --registry=https://registry.npmjs.org` — OK (the npmrc-configured
  registry `registry.hmb.gov.tr` did not resolve from this machine)
- `npm run typecheck` — PASS
- `npm run build` — PASS
- `npm test` — 131 tests, 131 pass, 0 fail (up from 69; +62 test cases across
  8 test files, 3 of them new: `preconditions.test.ts`, `concurrency.test.ts`,
  `auditIntegrity.test.ts`)
- `npm run demo` — reached DONE via the full path; refused all 10 bypass
  attempts (up from 5), one for each remediation above
- `git diff --check` — clean, no whitespace errors

Not done by the implementer, by design: no commit, no push, no merge;
TASK-002 was not started; no GitHub/n8n/Telegram/server/real-provider
integration was added; the Constitution was not modified.

### Round 3 — remediation (Claude Code / Fable 5, IMPLEMENTATION ENGINEER)
Round-2 re-review found that per-case guards kept being circumvented. This
round replaced the guards with four root invariants rather than adding more
special cases. `docs/FACTORY_CONSTITUTION.md` was not modified.

**Step 1 — reproduced first.** `tests/round2Exploits.test.ts` was written
against the Round-2 code and confirmed failing before any fix: 7 tests, 0
pass, 7 fail, each for the correct reason ("Missing expected rejection: a plan
approval must only be grantable while the item is at PLAN_REVIEW"; "... a
worker must not review its own run by renaming itself"; "... a terminal run
must never be rewritten as SUCCEEDED"; "... cancellation must require trusted
human authorization"; a mutated Date changing a stored record; and "run
run-0002 is durable but was never attached to the WorkItem (orphan)"). That
file now holds 19 passing tests.

**Root-cause fixes.**
1. *Trusted principals* — `WorkerPrincipal` (`src/domain/workerPrincipal.ts`),
   the `WorkerRegistry` port and `createLocalWorkerRegistry`, which keys
   principals on the Worker **object** via a WeakMap. Runs store
   `workerPrincipalId` (trusted) alongside `declaredWorkerId` (audit only),
   roles are captured at registration, and C4 compares principals. Renaming,
   re-roling or aliasing a worker no longer makes it independent of itself,
   and an unregistered worker cannot run at all.
2. *Content-addressed release snapshots* — `ReleaseSnapshot`
   (`src/domain/executionSnapshot.ts`) plus `releaseSnapshotResolver.ts`. The
   snapshot id hashes the exact implementation run, verifier run,
   deterministic review, semantic review and criterion-verification ids in
   force. Verifier/reviewer runs now carry `targetRunId` and criterion
   verifications carry `implementationRunId`, so a new implementation run
   orphans all prior proof by construction. `WorkItem.revision` was replaced
   by `specRevision` (plan identity only) — the counter no longer pretends to
   track implementation state, which is what Round 2 exploited.
3. *Status-bound, snapshot-bound approvals* — `GATE_DECISION_STATUS` plus
   checks in `recordApproval`: PLAN_APPROVAL is only recordable at
   PLAN_REVIEW, RELEASE_APPROVAL only at WAITING_FOR_HUMAN and only when a
   complete snapshot exists. Pre-recording at IDEA is now impossible rather
   than merely ineffective, and the gate guard compares the approval's
   snapshot hash against the live one.
4. *Append-only lifecycle* — `RunRepository` lost its general `save`; a run is
   `create`d RUNNING and `complete`d once, terminal is immutable
   (`RunLifecycleError`). Timestamps became `Timestamp` (epoch ms) everywhere
   and `deepFreeze` now throws on any `Date`, so the Round-2 timestamp
   mutation has no surface left.
5. *Atomic units of work* — `FactoryStore.transaction` stages writes in an
   overlay and revalidates every operation against a working copy at commit,
   applying all-or-nothing. `runWorker`, `advance`, `recordApproval`,
   `recordReview`, `verifyAcceptanceCriteria` and `createWorkItem` each run as
   one unit, so a lost CAS race discards the whole operation instead of
   leaving an orphan run.
6. *Cancellation is a protected human decision* — the rule flag became
   `requiresHumanAuthorization` and `WorkflowService` verifies a
   `TrustedHumanToken` through the identity gate, the same boundary approvals
   use.

**Commands run** (final clean-state run below): `npm run typecheck` PASS,
`npm run build` PASS, `npm test` 158 tests / 158 pass / 0 fail (up from 131),
`npm run demo` reaches DONE and refuses all 15 bypass attempts,
`git diff --check` clean.

Two demo/message defects were found and fixed by the new tests themselves: a
refusal was mislabelled (it tripped the evidence precondition, not the
release gate), and the C4 error message embedded a random principal id, which
broke transcript determinism. The message now names the two run ids instead.

Not done by the implementer, by design: no commit, no push, no merge;
TASK-002 was not started; no GitHub/n8n/Telegram/server/real-provider
integration was added; the Constitution was not modified.

### Round 4 — remediation (Claude Code / Fable 5, IMPLEMENTATION ENGINEER)
Fixed the five Round-3 findings at the invariant level, no Constitution
changes, no scope growth.

**Step 1 — reproduced first.** `tests/round3Exploits.test.ts` was written
against the Round-3 code and confirmed failing before any fix: 15 tests,
3 pass (companion cases already guarded), 12 fail, each for the intended
reason ("Missing expected rejection" on: DONE after failed implementation B,
DONE after a later FAIL review, runWorker/recordReview/verify on a DONE item,
worker ops on CANCELLED, RUNNING and bogus completion statuses; "Missing
expected exception (TypeError)" on pre-frozen nested arrays; and the smuggled
nested Date being accepted). That file now holds 15 passing tests.

**Root-cause fixes, one per finding:**
1. *CRITICAL — failed implementation B ignored*: `resolveCurrentImplementation`
   now selects the newest IMPLEMENTER **attempt** at the current spec revision
   (lineage head) and fails resolution unless that exact attempt SUCCEEDED.
   The same lineage rule was applied to verifier attempts. Falling back to an
   older successful run is structurally impossible; a failed head leaves the
   item unreleasable until fresh proof exists.
2. *HIGH — earlier PASS review outranked a later FAIL*: review resolution now
   selects the **latest applicable** review (semantic and deterministic) in
   append-only insertion order — deterministic, no timestamp races — and
   requires that authoritative review to be PASS and independent. PASS->FAIL
   blocks; FAIL->PASS may re-qualify; a fresh approval is still needed since
   the snapshot hash changes with the review id.
3. *HIGH — DONE items writable via runWorker*: one central policy,
   `FactoryService.requireOperableWorkItem`, refuses runWorker, recordReview
   and verifyAcceptanceCriteria on DONE and CANCELLED items (checked again
   inside the run-attachment transaction to close the execute/commit race).
   Transitions need no extra check: terminal statuses have no outgoing edges.
4. *MEDIUM — pre-frozen root bypassed deep freeze*: `deepFreeze` no longer
   short-circuits on `Object.isFrozen(root)`; it traverses through frozen
   nodes with a visited-set cycle guard, freezing every nested value and
   still refusing any nested `Date`.
5. *MEDIUM — `complete` accepted runtime status "RUNNING"*: the repository
   now validates the completion status at runtime (only SUCCEEDED/FAILED)
   and copies completion fields explicitly instead of spreading the caller's
   object, so smuggled runtime fields cannot rewrite a run's identity.

**Commands run** (final clean-state run below): `npm run typecheck` PASS,
`npm run build` PASS, `npm test` 175 tests / 175 pass / 0 fail (up from 158),
`npm run demo` reaches DONE with 15 refusals, `git diff --check` clean.
All Rounds 1–3 adversarial coverage re-ran green (round2Exploits.test.ts,
round3Exploits.test.ts and the 8 prior suites).

Not done by the implementer, by design: no commit, no push, no merge;
TASK-002 not started; no external integrations; Constitution untouched.

### Round 5 — remediation (Claude Code / Fable 5, IMPLEMENTATION ENGINEER)
Fixed the Round-4 blocker (cross-generation criterion proof) and the runtime
completion-input hardening concern. No Constitution changes, no scope growth.

**Step 1 — reproduced first.** `tests/round4Exploits.test.ts` was written
against the Round-4 code and confirmed failing before any fix: 9 tests,
3 pass (cases Round 4 already guarded), 6 fail for the intended reasons —
release still possible after a newer verifier attempt produced a FAILED
criterion result, after an incomplete newer generation, and with partial
B results backfilled from A; plus a completion status getter read more than
once and hostile getters on the run object given to create(). The file now
holds 9 passing tests.

**Root-cause fixes:**
1. *CRITICAL — criterion proof mixed across verification generations*:
   `resolveReleaseSnapshot` previously did "find a PASSED record per
   criterion" filtered only by implementation run. It now restricts criterion
   records to the CURRENT verification generation — records whose
   `verifierRunId` is the authoritative (lineage-head) verifier attempt, for
   the current implementation, at the current spec revision — and takes the
   latest record per criterion within that generation. An older generation
   can neither fill a gap nor override a current FAIL. The snapshot hash was
   already bound to `verifierRunId` + the criterion-verification id set, so a
   new qualifying generation changes the snapshot id and stales any prior
   RELEASE_APPROVAL automatically (tested).
2. *Runtime completion-input hardening*: `RunRepository.create` and
   `.complete` now capture every caller-supplied field exactly once into a
   plain internal value (`captureRun`/`captureCompletion`) BEFORE any
   validation; validation and persistence consult only the captured copy and
   the caller's object is never re-read. A getter answering "SUCCEEDED" to
   the validator and "RUNNING" to persistence is neutralised (read-count
   asserted in tests); identity fields (id, principal, role, targetRunId,
   specRevision, startedAt) come only from the stored row.

One Round-3 test was updated to match the strengthened boundary: runs are now
capture-copied, so a caller's retained nested array stays mutable but can no
longer touch durable state; the test now asserts the durable-state invariant
(stored copy frozen and unchanged) instead of requiring the caller's own
array to throw.

**Commands run** (final clean-state run below): `npm run typecheck` PASS,
`npm run build` PASS, `npm test` 184 tests / 184 pass / 0 fail (up from 175),
`npm run demo` DONE with 15 refusals, `git diff --check` clean. All Rounds
1–4 adversarial coverage re-ran green (round2/round3/round4 exploit suites
plus the 8 core suites).

Not done by the implementer, by design: no commit, no push, no merge;
TASK-002 not started; no external integrations; Constitution untouched.

### Round 6 — remediation (Claude Code / Fable 5, IMPLEMENTATION ENGINEER)
Fixed the Round-5 CRITICAL race: runWorker invoked the worker before the
RUNNING attempt was durably created, so while a delayed IMPLEMENTER/VERIFIER
B executed, generation A stayed authoritative, DONE could succeed mid-flight,
and B then failed to persist against the terminal item.

**Step 1 — reproduced first.** `tests/round5Exploits.test.ts` uses gated
workers whose execution pauses deterministically after start. Against
Round-5 code: 4 tests, 2 fail for the intended reason — "a RUNNING attempt
must be durable before the worker executes" for both the delayed IMPLEMENTER
and delayed VERIFIER cases (no audit run existed while the worker ran, and
DONE succeeded mid-flight). The two race tests passed pre-fix (the
sequential terminal case was already guarded). All 4 now pass.

**Root-cause fix — three-phase runWorker (`src/app/factoryService.ts`):**
- PHASE 1 (atomic start): validate operable item + role/state legality +
  target run, create the Run RUNNING, attach it to the WorkItem under CAS,
  commit — all BEFORE Worker.execute(). If this transaction fails the worker
  is never invoked and nothing is durable.
- PHASE 2 (execute): external call with no transaction held open.
- PHASE 3 (atomic finalize): persist evidence and complete that exact run
  (repository refuses unless still RUNNING); touches only run/evidence
  tables, so a concurrent item change can never orphan the audit record.
  Success, returned failure and thrown exception all finalize the same run.

**Supporting invariants:**
- `resolveReleaseSnapshot` now refuses while ANY attached run is RUNNING
  (implementer, verifier or reviewer): nothing is releasable while an
  attempt is in flight, and RELEASE_APPROVAL cannot be minted mid-flight
  either (it requires a resolvable snapshot).
- Serialization via the existing CAS/transaction abstraction, no ad-hoc
  flags: either DONE commits first (PHASE 1's CAS fails; no execution) or
  PHASE 1 commits first (RUNNING head; DONE refused). Tested: no
  interleaving lets both succeed.
- New central role/state policy (`src/workflow/rolePolicy.ts`, code
  INVALID_OPERATION_STATE): execution roles (IMPLEMENTER/VERIFIER/REVIEWER)
  start only in IMPLEMENTING/VERIFYING/REVIEW/WAITING_FOR_HUMAN — never
  before PLAN_APPROVAL gates the item into execution, never in BLOCKED;
  ANALYST/PLANNER map to the planning states; CONTENT has no startable state
  in TASK-001 (Roadmap Phase 11). Existing rework/resume behavior unchanged
  (all prior suites pass unmodified).

**Commands run** (final clean-state run below): `npm run typecheck` PASS,
`npm run build` PASS, `npm test` 188 tests / 188 pass / 0 fail (up from
184), `npm run demo` DONE with 15 refusals, `git diff --check` clean. All
Rounds 1–5 adversarial coverage re-ran green.

Not done by the implementer, by design: no commit, no push, no merge;
TASK-002 not started; no external integrations; Constitution untouched.

## Verification output
Rounds 1–5 verification are superseded by the Round-6 remediation. An
independent verification pass should re-run `npm run verify && npm run demo`
from a clean checkout against the current code before re-review.

## Reviewer output

### Round 1 (Codex-class independent reviewer) — preserved verbatim
Independent review verdict: CHANGES_REQUIRED.

Blocking findings:
- CRITICAL: workflow transitions do not require successful implementation or
  verification runs, passing deterministic/semantic reviews, or verified
  acceptance criteria. With approvals present, an agent can advance a work
  item to DONE with zero runs and zero evidence.
- CRITICAL: `BLOCKED -> READY|IMPLEMENTING` loses the pre-block state and can
  bypass PLAN_REVIEW and PLAN_APPROVAL entirely.
- CRITICAL: approval authority is caller-asserted data. Any caller, including
  an AI-controlled adapter, can construct an Actor whose `kind` is `HUMAN` and
  record a protected approval; no trusted human identity boundary exists.
- HIGH: reviewer independence is only an arbitrary string inequality and a
  passing review is not required for REVIEW -> WAITING_FOR_HUMAN.
- HIGH: approvals are not bound to plan/spec version or reviewed evidence and
  may be pre-recorded/reused after rework; revocation cannot affect a completed
  transition.
- HIGH: worker exceptions leave runs stuck RUNNING, while FAILED outcomes do
  not prevent later workflow advancement.
- HIGH: acceptance criteria have no executable verification/attestation path;
  worker-authored evidence is accepted without provenance or validation.
- MEDIUM: synchronous approval lookup conflicts with the otherwise async
  persistence ports and cannot be implemented by normal filesystem/SQLite/
  PostgreSQL adapters without redesign; read-modify-save operations also lack
  optimistic concurrency/version checks.
- MEDIUM: an untracked `software-factory-bootstrap/` duplicate repository tree
  is present and is not part of the implementation report.

Reviewer verification on 2026-08-18:
- `npm run typecheck` — PASS
- `npm run build` — PASS
- `npm test` — PASS (Node reports 5 test-file subtests)
- `npm run demo` — PASS (reaches DONE and prints 5 expected refusals)

TASK-001 is not technically ready for human acceptance or commit. See the
independent review report for precise remediation requirements.

### Round 2
Independent re-review verdict: CHANGES_REQUIRED.

Verified blocking findings:
- CRITICAL: approvals may be recorded at any workflow status and forward
  progress does not change `revision`. PLAN_APPROVAL and RELEASE_APPROVAL
  recorded while the item was still IDEA remained valid; the item reached
  DONE using both pre-recorded approvals.
- CRITICAL: running a new IMPLEMENTER after RELEASE_APPROVAL does not bump the
  revision. After adding a new semantic review but no new verification, the
  item reached DONE using the old release approval and old acceptance-
  criterion verifications. The stored approval's `runIds`/`reviewId` snapshot
  is not checked by the gate guard.
- HIGH: reviewer independence remains based on mutable, self-asserted worker
  metadata. The same Worker object implemented, changed its `id` and role,
  then successfully recorded a passing semantic review of its own run.
- HIGH: Run records remain overwriteable. A FAILED implementation Run was
  replaced through `RunRepository.save` with `SUCCEEDED`, after which
  IMPLEMENTING -> VERIFYING succeeded.
- HIGH: human-only cancellation checks only caller-supplied `Actor.kind`; an
  AI-created `{ kind: "HUMAN" }` actor successfully cancelled a work item
  without a TrustedHumanToken.
- MEDIUM: `deepFreeze` does not make Date values immutable. Mutating a retained
  Evidence `createdAt` Date changed the stored append-only audit record.
- MEDIUM: concurrent `runWorker` calls are not atomic: one call returned a
  concurrency conflict after both successful Runs and their evidence had
  already been persisted; the rejected run was left stored but unattached.

Correctly refused in re-review: no implementation run, ordinary FAILED run,
missing verifier/review/criterion verification, same-id self-review, forged or
mismatched human approval token, BLOCKED resume to the wrong state, approvals
after an actual revision bump, stale WorkItem CAS write, and a thrown worker
(persisted FAILED with no RUNNING residue).

Reviewer commands on 2026-08-18:
- `npm run typecheck` — PASS
- `npm run build` — PASS
- `npm test` — PASS (8 test-file subtests reported)
- `npm run demo` — PASS (DONE; 10 expected refusals)
- `git diff --check` — PASS
- `git status --short` — inspected; duplicate bootstrap tree is gone

TASK-001 is not technically ready for human acceptance or commit.

### Round 3
Independent re-review verdict: CHANGES_REQUIRED.

Verified blocking findings:
- CRITICAL: `resolveCurrentImplementation` ignores newer FAILED IMPLEMENTER
  runs. Starting legitimate rework from WAITING_FOR_HUMAN, recording failed
  implementation B, then advancing VERIFYING -> REVIEW -> WAITING_FOR_HUMAN
  -> DONE succeeded using implementation A's verification, review, criterion
  verifications and RELEASE_APPROVAL. The final status was DONE.
- HIGH: snapshot resolution uses an earlier passing semantic review even when
  a later semantic review of the same implementation records FAIL. The live
  snapshot id remained unchanged and DONE succeeded despite the later
  blocking review.
- HIGH: terminal WorkItems are still writable through `runWorker`. After a
  valid transition to DONE, a new successful IMPLEMENTER run was persisted
  and attached to the DONE item; the item remained DONE while its release
  snapshot became unresolved.
- MEDIUM: `deepFreeze` returns immediately for an already-frozen root without
  traversing its children. A pre-frozen Review with a mutable `findings` array
  and a pre-frozen Run with mutable `evidenceIds` were saved, then their nested
  arrays were mutated through retained references, changing durable state.
- MEDIUM: `RunRepository.complete` does not validate the terminal status at
  runtime. Passing `status: "RUNNING"` through the JavaScript boundary rewrote
  the same RUNNING record's content and allowed a later second completion.

Correctly refused/contained in Round 3: early PLAN/RELEASE approval, forged
approval and cancellation identity, same-object worker rename/re-role,
unregistered workers, direct same-id or terminal run replacement, missing
implementation/verification/evidence/criterion verification/semantic review/
release approval, stale plan approval, successful implementation B using A's
proof, invalid BLOCKED resumes, direct stored-object mutation, mutable Date
storage, stale WorkItem CAS writes, and concurrent run attachment (one loser;
zero durable orphan runs/evidence).

NOTE: two distinct registered Worker wrapper objects sharing one execute
closure are treated as independent principals. This was reproduced, but is
the explicitly documented TASK-001 in-process object-identity trust boundary;
workers do not receive the registry, so it is not classified as a blocker for
this task.

Reviewer commands on 2026-08-19:
- `npm run typecheck` — PASS
- `npm run build` — PASS
- `npm test` — PASS (9 test-file subtests reported)
- `npm run demo` — PASS (DONE; 15 expected refusals)
- `git diff --check` — PASS
- `git status --short` — inspected

TASK-001 is not technically ready for human acceptance or commit.

### Round 4
Independent re-review verdict: CHANGES_REQUIRED (blocker: release snapshot
resolution reused PASSED criterion verifications from an older verifier
attempt after a newer verifier attempt produced FAILED/incomplete results;
concern: completion-object getters were read more than once at the repository
boundary).

### Round 5
Independent final review verdict: CHANGES_REQUIRED.

Reproducible blocker:
- CRITICAL: `FactoryService.runWorker` invokes `worker.execute` before the
  RUNNING Run is created and attached. Starting a delayed IMPLEMENTER B or
  VERIFIER B after release approval A, waiting until its `execute` method has
  entered, and then advancing the item allowed `WAITING_FOR_HUMAN -> DONE`
  with snapshot/approval A. When B subsequently finished, its transaction was
  rejected with `TERMINAL_WORK_ITEM`, leaving no durable record of the newer
  attempt. This bypasses newest-attempt authority while the attempt is in
  flight and loses the failed/superseding attempt from audit history.

Round-5 fixes independently verified:
- Criterion proof is restricted to the current verifier generation. A newer
  generation with a FAILED result, no results, or only one current result
  could not borrow generation A records and produced no release snapshot.
- After a failed B, a complete C produced a snapshot containing only C's
  criterion-verification ids; approval A was stale and DONE required a fresh
  release approval.
- Run create/complete getters and proxies were captured once per accepted
  field; completion identity extras were not read, stored identity remained
  unchanged, invalid statuses were refused, and a second completion failed.
- A genuinely persisted RUNNING or FAILED IMPLEMENTER/VERIFIER head correctly
  invalidated the old release snapshot. The bypass is specifically the public
  `runWorker` execute-before-persist window.

Required remediation:
- Atomically create and attach the RUNNING Run before invoking the worker, and
  invoke the worker only after that transaction commits. This makes the new
  lineage head visible to snapshot resolution immediately.
- Atomically record evidence and complete that same Run exactly once after the
  worker returns or throws. Define cancellation handling so a Run already in
  progress is terminalized without reopening release state or being erased.
- Add delayed-worker regression tests for both IMPLEMENTER and VERIFIER roles:
  after `execute` enters but before it resolves, the old snapshot/approval
  must not permit DONE; success, failure and throw must all leave the expected
  terminal audit record without an orphan.

Reviewer commands on 2026-08-19:
- `npm run typecheck` — PASS
- `npm run build` — PASS
- `npm test` — PASS (11 test-file subtests, 0 failures)
- `npm run demo` — PASS (DONE; 15 expected refusals)
- `git diff --check` — PASS after the reviewer-only handoff update
- `git status --short` — inspected

TASK-001 is not safe for human acceptance or commit.

### Round 6
Independent final review verdict: PASS.

No CRITICAL or HIGH TASK-001 correctness defect remains.

Round-6 verification:
- A delayed IMPLEMENTER and delayed VERIFIER were each observed after their
  Phase-1 transaction: the exact Run was RUNNING, attached to the WorkItem,
  and visible before `execute()` began. The prior snapshot disappeared and
  both DONE and a new RELEASE_APPROVAL were refused while each run was in
  flight.
- With release committed first, a later worker start was rejected before
  execution, with no Run or Evidence residue. With worker start committed
  first, the RUNNING head rejected DONE. The existing race regression also
  passed, so both operations cannot commit successfully.
- Successful, returned-failure and thrown worker outcomes finalized the exact
  Phase-1 Run once. Evidence referenced that same Run; no replacement or
  orphan was observed.
- IMPLEMENTER/VERIFIER/REVIEWER starts before plan execution, while BLOCKED,
  DONE or CANCELLED, and invalid planning/content combinations were refused
  before execution. A legitimate WAITING_FOR_HUMAN -> IMPLEMENTING rework
  path succeeded.
- A trusted human cancellation during an in-flight run left the WorkItem
  CANCELLED, allowed the already-authorized Run to finalize its audit record,
  and refused later progress or worker starts.

Historical TASK-001 regression suites remained green for lineage and verifier
coherence, review ordering, approval timing and staleness, trusted identities,
verification/evidence/criteria gates, BLOCKED/resume, terminal WorkItems and
runs, CAS/transaction rollback, orphan prevention, and audit immutability.

Reviewer commands on 2026-08-19:
- `npm run typecheck` — PASS
- `npm run build` — PASS
- `npm test` — PASS (12 test-file subtests, 0 failures)
- `npm run demo` — PASS (DONE; 15 expected refusals)
- `git diff --check` — PASS after the reviewer-only handoff update
- `git status --short` — inspected

TASK-001 is safe for human acceptance and commit.

## Human decision
Pending.
