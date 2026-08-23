# AI HANDOFF

Status: IMPLEMENTED_AWAITING_VERIFICATION
Current task: TASK-004
Plan version: autonomous-loop-v1

Prior task: TASK-003 (Worker Runner) shipped as commit `61ba880` after
independent review including one remediation round. Its full
implementer/reviewer history is archived at
`docs/tasks/archive/TASK-003-AI-HANDOFF.md`.

## Implementer output

Worker: Claude Code (Sonnet 5), role IMPLEMENTATION ENGINEER.

Read the full accepted contract before writing any code: `AGENTS.md`,
`CLAUDE.md`, `docs/FACTORY_CONSTITUTION.md`, `docs/PRODUCT.md`,
`docs/ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`, `docs/MODEL_ROUTING.md`,
`docs/ROADMAP.md`, `LOOP.md`, `LOOP-PLANS.md`, this file's TASK-003 history,
`docs/tasks/TASK-003-worker-runner.md`, and every TASK-001/002/003 source
file the orchestrator would need to call correctly
(`src/app/factoryService.ts`, the whole `src/workflow/` transition/gate/
precondition/snapshot machinery, `src/ports/`, the worker adapters, both
persistence adapters, the CLI, and representative tests). Wrote
`docs/tasks/TASK-004-autonomous-engineering-loop.md` before implementing, per
protocol.

### 1. The core discovery that shaped the whole design

`src/workflow/transitions.ts` and `src/workflow/releaseSnapshotResolver.ts`
already encode almost the entire autonomous loop as accepted TASK-001 domain
law:

```
READY -------------> IMPLEMENTING        (no precondition)
IMPLEMENTING -------> VERIFYING          (requireSuccessfulImplementationRun)
VERIFYING -----------> IMPLEMENTING      (checks failed, back to implementation — free edge)
VERIFYING -----------> REVIEW            (requireSuccessfulVerification: a SUCCEEDED VERIFIER
                                            run + a DETERMINISTIC review PASS produced by it)
REVIEW --------------> IMPLEMENTING      (reviewer requested changes — free edge)
REVIEW --------------> WAITING_FOR_HUMAN (requireIndependentSemanticReview: a SUCCEEDED,
                                            independent-principal REVIEWER run + a SEMANTIC
                                            review PASS)
```

`FactoryService.recordReview` already enforces C4 for `SEMANTIC` reviews and
deliberately does **not** require independence for a `DETERMINISTIC` review
(correct: deterministic verification is command exit codes, not opinion).
TASK-004's job was therefore to call these existing, unmodified primitives in
the right order with real workers, add its own persisted/resumable
bookkeeping around that, and stop exactly where the domain model already
stops (`WAITING_FOR_HUMAN`) — never a new domain rule, never a new bypass.
**No line of `src/domain/`, `src/workflow/`, or `src/app/factoryService.ts`
changed.**

### 2. Autonomous-loop architecture

New top-level layer, `src/orchestration/` (+ `src/adapters/orchestration/`
for persistence), calling only `FactoryService`'s existing public methods —
`advance`, `runWorker`, `recordReview`, `registerWorker`, `getWorkItem`,
`listRuns`, `listEvidence` — never a repository directly.

```
src/orchestration/
  loopTypes.ts              EngineeringLoop, LoopPhase, LoopIterationRecord,
                             LoopBudget, LoopWorkerConfig, VerificationCommandConfig
  loopRepository.ts         LoopRepository port (create/compareAndSave/findById/listByWorkItem)
  engineeringLoopService.ts the orchestrator: start/resume/cancel/status + drive()
  verificationWorker.ts     a Worker that runs trusted, configured commands — no AI
  reviewVerdictParser.ts    strict PASS/PASS_WITH_NON_BLOCKING_NOTES/CHANGES_REQUIRED parser
  loopWorkerFactory.ts      builds a real Claude Code/Codex CLI Worker from LoopWorkerConfig
  loopPrompts.ts            bounded, iteration-aware instruction text (IMPLEMENTER/REVIEWER)
  scriptedLoopWorkers.ts    deterministic scripted Workers for demo/tests (mockWorker.ts's peer)

src/adapters/orchestration/
  inMemoryLoopRepository.ts
  sqliteLoopRepository.ts   its own SQLite file — see §4 below for why

src/cli/loop.ts              sf loop start|status|resume|cancel
src/cli/demoLoop.ts          npm run demo:loop (3 deterministic scenarios)
```

Implementer/reviewer independence (C4) is never decided by comparing
`tool`/`model` strings — that would reintroduce the exact "string-role
trust" pattern Round-2 review eliminated. The orchestrator always constructs
two separate `Worker` objects (one per role), asserts they are distinct by
reference as a cheap sanity check, and lets `FactoryService.recordReview`'s
existing principal-identity check be the only real enforcement point.

### 3. Persisted loop state model

`EngineeringLoop` (`src/orchestration/loopTypes.ts`): id, workItemId, an
optimistic-concurrency `version`, a small `LoopPhase` (`READY →
IMPLEMENTING → VERIFYING → REVIEWING → {WAITING_FOR_HUMAN | EXHAUSTED |
FAILED | CANCELLED}`), budget, implementer/reviewer `LoopWorkerConfig`,
`verificationCommands`, workspace root, task instructions, and an array of
`LoopIterationRecord` — one per implement/verify/review attempt, each
accumulating `implementerRunId`/`implementerOutcome` →
`verificationRunId`/`verificationCommandResults`/`verificationReviewId`/
`verificationPassed` → `reviewerRunId` → `reviewVerdict`/`reviewRecordId`/
`reviewFindings`/`reviewParseError`, in that fixed order.

`EXHAUSTED` reuses the existing `BLOCKED` WorkItem status (best-effort,
non-fatal if it fails) rather than inventing a parallel "needs a human"
signal — `BLOCKED` is already the domain's precondition-free, reachable-from-
execution-states vocabulary for exactly this.

### 4. Why a second SQLite file, not a shared connection

`FactoryStore`'s SQLite adapter owns one `DatabaseSync` connection with its
own mutex-serialized transactions. Loop writes and Factory writes never need
to commit atomically with each other (the orchestrator always fully awaits
one before starting the next), so `src/adapters/orchestration/
sqliteLoopRepository.ts` opens its own small file (`.factory-data/loops.db`
by default — same gitignored directory), with its own minimal
`schema_meta`-versioned `engineering_loops` table and the same
create/CAS-via-conditional-`UPDATE` discipline as the Factory's own SQLite
adapter. Deliberately scoped down from `src/adapters/sqlite/serialization.ts`'s
full adversarial rigor (this table has not been through multiple rounds of
persistence-focused review yet) but still validates on the way out rather
than casting.

### 5. Deterministic verification runner

`createVerificationWorker` implements the `Worker` port directly (no AI, no
shell): `VerificationCommandConfig` is `{ id, executable, argv, cwd?,
timeoutMs?, evidenceKind? }`, run via the existing `ProcessRunner` — argv
array only, `shell` never used, same discipline as `cliWorker.ts`.

The load-bearing design point: its own `WorkerOutcome.status` stays
`SUCCEEDED` whenever every configured command actually ran and its result
was captured, **regardless of individual exit codes** — a failing `npm test`
is a successfully observed fact, not a harness failure. This is what makes a
`DETERMINISTIC` review with verdict `FAIL` even legal to record:
`FactoryService.recordReview` refuses to record *any* review — passing or
failing — unless the reviewer run's own status is `SUCCEEDED`. Only a
genuine bug in the harness itself would leave a `FAILED` run (via
`FactoryService`'s existing thrown-exception catch), and that case is
handled by remediating directly rather than trying to record a review that
cannot legally exist.

### 6. Reviewer output contract / strict parser

The orchestrator never touches `src/adapters/workers/promptTemplates.ts` —
it composes its own bounded `instructions` text
(`src/orchestration/loopPrompts.ts`), passed through the existing
`FactoryService.runWorker` `instructions` field. The REVIEWER is asked to
put a single tag as the first line of its response:

```
FACTORY_REVIEW_VERDICT: PASS
FACTORY_REVIEW_FINDINGS:
- <finding>
```

`src/orchestration/reviewVerdictParser.ts` (pure, no I/O) matches only a
whole, anchored `^FACTORY_REVIEW_VERDICT:` line — never a bare substring —
so "tests PASS but the verdict below is what counts" cannot be
mistaken for a tag. Zero tags → reject ("no verdict"); more than one tag,
even identical values → reject ("ambiguous", a strict superset of
"conflicting"); an unrecognized value → reject ("invalid"). The parser is
only ever invoked when the reviewer run's process-level status is
`SUCCEEDED` — a non-zero-exit/timeout/spawn-failed run is treated purely as
an execution failure and the parser is never even called on its output, so
"PASS" printed by a crashed process can never become approval.

**A real bug found and fixed while wiring this up, not merely designed
around:** `cliWorker.ts` derives `Run.summary` as a truncated copy of the
*same* message its transcript Evidence already carries in full. My first
implementation pooled both as separate "source texts" for the parser, which
made one real verdict tag get counted twice and misreported as ambiguous —
caught by `tests/engineeringLoopService.test.ts`'s malformed-reviewer test,
reproduced with a debug harness against the real code path, and fixed by
preferring Evidence texts alone whenever any exist (falling back to
`Run.summary` only for a worker that recorded no evidence at all).

### 7. Remediation loop behavior

`CHANGES_REQUIRED` (or a parse failure — fail-closed, treated identically for
budget purposes) automatically triggers exactly one new IMPLEMENTER
iteration, budget permitting: `VERIFYING → IMPLEMENTING` / `REVIEW →
IMPLEMENTING` (both existing, precondition-free edges), then the loop opens
a fresh `LoopIterationRecord` and re-runs the whole implement → verify →
review chain. `PASS` and `PASS_WITH_NON_BLOCKING_NOTES` both advance to
`WAITING_FOR_HUMAN` (findings from the latter are preserved on the
iteration record, never discarded). Remediation prompts
(`loopPrompts.ts`) are bounded to the *immediately preceding* iteration's
verification failures/review findings — never the whole loop history.

### 8. Crash/resume behavior

Every external action (a worker run, `recordReview`, `advance`) is preceded
by checking the already-persisted iteration record for the exact field that
action is about to produce, and followed immediately (no other `await` in
between) by persisting it — see `docs/tasks/TASK-004-autonomous-engineering-loop.md`
§8 for the full per-phase table. `resume()` is not a special code path: it
calls the same `drive()` that `start()` calls, which always re-reads current
state from the store rather than trusting anything held in memory.

All five crash cases from the task brief (A–E: implementer succeeded/crash
before next transition; verification passed/crash before reviewer launch;
CHANGES_REQUIRED recorded/crash before remediation launch; remediation
complete/crash before re-verification; reviewer PASS persisted/crash before
the WAITING_FOR_HUMAN transition) are proven in
`tests/engineeringLoopService.test.ts` via fault injection — a
`LoopRepository` wrapper that makes the (N+1)-th `compareAndSave` call throw,
simulating the OS process dying at that exact persisted checkpoint (the
`start()`/`resume()` call itself rejects, exactly as a real crash would never
let it return cleanly) — then a **fresh** `EngineeringLoopService` instance
is constructed against the same, real repository and `resume()`d, asserting
no duplicated implementer/verifier/reviewer run and the correct eventual
terminal state.

**Documented, not silently narrowed, limitation:** the one crash window this
cannot close is the external call itself being genuinely in-flight when the
OS process dies (a real `claude`/`codex` child mid-execution) — resuming
after *that* exact crash can re-attempt that one step (at-least-once, not
exactly-once, for the in-flight call only). Every step that **completed and
was recorded** before a crash is never redone, which is what the five test
cases above actually prove.

### 9. Cancellation behavior

`cancel(loopId, actor)` durably sets `cancelRequested` and attempts to
finalize to `CANCELLED` immediately; a losing race (another finalizer, e.g. a
`drive()` loop noticing the flag first) is tolerated, not thrown. `drive()`
re-reads the loop from the store at the top of every iteration — which is
also how a cancellation issued by a *different process* (a separate `sf loop
cancel` invocation, sharing only the SQLite file) is observed at all.

**Real concurrency bug found and fixed during testing, not just
theorized:** a cancellation racing an in-flight step's own completion-write
on the same loop row produced a losing `ConcurrencyError` that `drive()`'s
outer catch mistook for an orchestration `FAILED` — turning an ordinary
cancellation race into a false failure. Fixed by making `save()` retry on a
losing CAS, re-reading the current row and reapplying the same patch (bounded
to 5 attempts) — safe because every patch a step ever applies touches only
the fields that step decided to change. Proven by a test that gates an
in-flight implementer call, requests cancellation concurrently, then releases
the gate and asserts the loop settles to `CANCELLED` with the completed run's
evidence preserved, not `FAILED`.

**Documented limitation:** cancellation is cooperative between steps, not
preemptive mid-step — the accepted `Worker` port has no abort channel, and
extending it would touch TASK-003-accepted `cliWorker.ts` beyond this task's
scope; stopped and documented rather than silently broadened (design doc
§10, §15).

### 10. Budget/exhaustion behavior

`LoopBudget`: `maxIterations` (hard ceiling on IMPLEMENTER attempts, checked
before opening each new iteration), optional `maxTotalRuns` and
`maxWallClockMs` (both checked at the top of every `drive()` step, before any
action), optional per-worker/per-verification timeout defaults. Exhausting
any of these moves the loop to `EXHAUSTED` and best-effort transitions the
WorkItem to `BLOCKED` (evidence/runs/reviews are all still fully preserved —
nothing is deleted or rewritten). `FAILED` is reserved for the orchestration
layer breaking in a way this state machine did not anticipate (an unexpected
thrown error), distinct from `EXHAUSTED`'s "the work still isn't passing and
the budget ran out."

### 11. CLI / demo

```
sf loop start <work-item-id> --config <path>
sf loop status <loop-id>
sf loop resume <loop-id>
sf loop cancel <loop-id>
npm run demo:loop
```

`--config` is a trusted local JSON file; `workspace`/`taskInstructions` are
required (no safe generic default), `implementer`/`reviewer`/
`verificationCommands`/`budget` fall back to a small built-in default.
`verificationCommands[].argv` is validated to be an array of strings at load
time (never a shell string). `sf loop status` prints exactly: phase,
iteration/max, last implementer run+outcome, last verification result (which
commands failed), last review verdict, total runs, outcome/reason, and
whether human action is required — no raw transcripts, no secrets.

`npm run demo:loop` runs three fully offline scenarios (scripted
`Worker`s from `scriptedLoopWorkers.ts` for IMPLEMENTER/REVIEWER — never a
real CLI; real, trivial, deterministic `node -e process.exit(N)` processes
for verification, exactly like TASK-003's own fake-CLI fixtures spawn a real
Node process without ever calling that "AI"): clean PASS →
`WAITING_FOR_HUMAN`; `CHANGES_REQUIRED` → one remediation → PASS →
`WAITING_FOR_HUMAN`; repeated `CHANGES_REQUIRED` past budget → `EXHAUSTED` +
WorkItem `BLOCKED`. Verified directly by running it — transcript matches the
design doc's three scenarios exactly.

### 12. Tests and exact results

New suites (69 new tests): `tests/reviewVerdictParser.test.ts` (15,
covering every adversarial case from the brief's §10 list),
`tests/verificationWorker.test.ts` (7), `tests/inMemoryLoopRepository.test.ts`
(6), `tests/sqliteLoopRepository.test.ts` (5, including a real close/reopen
restart proof), `tests/loopPrompts.test.ts` (5), `tests/loopCli.test.ts` (10,
config-validation and not-found paths), `tests/engineeringLoopService.test.ts`
(21 — start-time legality, clean-PASS/PASS_WITH_NON_BLOCKING_NOTES/
remediation/repeated-exhaustion scenarios, reviewer-integrity fail-closed
cases, budget enforcement including a deterministic wall-clock test via a
fast-forwarding fake clock, cooperative cancellation racing a gated in-flight
run, all five crash/resume cases, and a status-view leak check).
`tests/support/factoryFixtures.ts` gained one small additive helper
(`toReady`, extracted from the existing `toImplementing`, itself unchanged
in behavior) — no existing test file's assertions were touched.

All new tests are fully deterministic and offline: scripted `Worker`s or
real-but-trivial local `node`/`git` subprocesses only, never `claude`/`codex`.

- `npm run typecheck` — PASS
- `npm run build` — PASS
- `npm test` — **416 tests, 416 pass, 0 fail** (up from 347; +69 from this
  task), confirmed stable across 3 consecutive full runs
- `npm run demo` — DONE, 15 refusals, unchanged
- `npm run demo:persistent` run twice (seed, then a second real OS process
  reading back) — unchanged behavior
- `npm run worker:doctor` — both `claude` (2.1.235) and `codex` (0.147.0)
  still found, unchanged
- `npm run demo:loop` — all three scenarios match the design exactly
  (`WAITING_FOR_HUMAN`, `WAITING_FOR_HUMAN` after one remediation,
  `EXHAUSTED` + WorkItem `BLOCKED`)
- `git diff --check` — clean
- `git status --short` — matches the files listed below

Two real bugs were found and fixed while stabilizing this suite, both
described in sections 6 and 9 above (the evidence/`Run.summary` double-count
in the verdict parser, and the cancellation/step-completion CAS race) — both
via reproduction against the real orchestrator code, not hypothesized.

### 13. Whether a real-loop smoke was run

**Not run.** Per the task's own instruction, a controlled real smoke (actual
Claude + Codex, one minimal harmless task in a scratch repo) is optional and
should only be spent once the deterministic implementation is stable, and
must never be repeated to save usage. The deterministic suite above
(including the crash/resume, cancellation, and reviewer-parser adversarial
cases) fully establishes the orchestration logic without spending any real
model usage. `sf loop start` is wired to the real `createClaudeCodeWorker`/
`createCodexCliWorker` adapters via `loopWorkerFactory.ts` exactly as
`workerSmoke.ts` already does, so a real smoke — if the human wants one run
— is a single `sf loop start <work-item-id> --config <path>` against a
throwaway scratch repo with a trivial task; not run here to avoid spending
real usage during an implementation/review cycle that may still need
remediation rounds.

### 14. Files changed

Created: `docs/tasks/TASK-004-autonomous-engineering-loop.md`;
`docs/tasks/archive/TASK-003-AI-HANDOFF.md` (prior `AI-HANDOFF.md` content,
archived per protocol); `src/orchestration/{loopTypes,loopRepository,
engineeringLoopService,verificationWorker,reviewVerdictParser,
loopWorkerFactory,loopPrompts,scriptedLoopWorkers}.ts`;
`src/adapters/orchestration/{inMemoryLoopRepository,sqliteLoopRepository}.ts`;
`src/cli/{loop,demoLoop}.ts`; `tests/{reviewVerdictParser,verificationWorker,
inMemoryLoopRepository,sqliteLoopRepository,loopPrompts,loopCli,
engineeringLoopService}.test.ts`.

Modified: `src/cli/main.ts` (`loop`/`demo:loop` dispatch, lazy-imported like
every other TASK-003 command); `package.json` (`demo:loop` script);
`tests/support/factoryFixtures.ts` (additive `toReady` helper);
`README.md` (new TASK-004 section + command list); `LOOP.md`,
`LOOP-PLANS.md` (status update); `AI-HANDOFF.md` (this file).

Not touched: `src/domain/`, `src/workflow/`, `src/app/factoryService.ts`,
`src/ports/{worker,workerRegistry,repositories}.ts`, either existing
`FactoryStore` adapter's internals, `src/adapters/workers/*` (Claude/Codex
adapters, prompt templates, environment policy, workspace resolution — all
reused exactly as TASK-003 shipped them), any TASK-001/002/003 test file,
`docs/FACTORY_CONSTITUTION.md`, `docs/DOMAIN_MODEL.md`.

### 15. Remaining limitations

- Cancellation cannot interrupt an already-launched real CLI subprocess
  mid-call (documented, §9 above) — a genuine limitation of the accepted
  `Worker` port, not silently narrowed scope.
- The loop repository is a second SQLite file, not a shared
  connection/transaction with `FactoryStore` (§4 above) — a deliberate,
  documented simplification; revisit only if a real cross-store atomicity
  requirement appears.
- `sqliteLoopRepository.ts`'s row validation is intentionally less
  adversarially hardened than `src/adapters/sqlite/serialization.ts` (that
  module earned its rigor through multiple rounds of persistence-focused
  review this new table has not yet been through).
- No real Claude/Codex smoke test was run this round (§13) — the wiring is
  identical to TASK-003's already-verified adapters, invoked through the same
  `FactoryService.runWorker` path `sf worker smoke` already proved works.
- All prior TASK-001/002/003 limitations still apply unchanged.
- TASK-005 (planning/intent→plan), GitHub Issues/Projects, Telegram/n8n,
  server deployment, and a scored/benchmarked model router remain explicitly
  out of scope, as instructed.

### 16. Ready for independent review: YES

## Verification output
Pending — an independent verification pass should re-run `npm run verify &&
npm run demo && npm run demo:persistent && npm run worker:doctor && npm run
demo:loop` from a clean checkout, plus `git diff --check`.

## TASK-004 REVIEWER

### Independent defensive review — 2026-08-20

**Verdict: CHANGES_REQUIRED**

TASK-004's ordinary deterministic scenarios and existing TASK-001/002/003
regression suite pass, but the following reproducible correctness blockers
prevent safe human acceptance or commit:

1. **HIGH — cross-database checkpoint loss duplicates work.**
   `src/orchestration/engineeringLoopService.ts` records Factory worker runs
   and reviews before saving their ids/outcomes in `loops.db`. If the process
   dies after the Factory commit and before the loop CAS, resume does not
   re-derive the committed run/review from Factory state and launches the
   external step again. A focused probe observed one implementer run before
   the simulated crash and two after resume. The same boundary exists for
   verifier/reviewer runs and deterministic/semantic reviews. A crash while
   `FactoryService.runWorker` has left a durable `RUNNING` run also has no
   recovery/reconciliation path; the later duplicate cannot remove the
   orphaned RUNNING record, which keeps release snapshots unresolved.

2. **HIGH — loop persistence accepts unsafe valid-JSON corruption.**
   `src/adapters/orchestration/sqliteLoopRepository.ts:141-180` validates only
   shallow top-level fields. Probes showed acceptance of malformed iteration
   records, impossible duplicate attempts, invalid negative timestamps,
   malformed command/config shapes, `WAITING_FOR_HUMAN` without reviewer
   authority, `EXHAUSTED` without exhausted budget, and SQL `phase`/JSON phase
   divergence. Terminal corruption is trusted without Factory reconciliation;
   active corruption can select an external worker step.

3. **HIGH — malformed reviewer protocol can become PASS.**
   The CLI adapters ignore malformed JSON and `cliWorker.ts` falls back to raw
   stdout as evidence. A successful process emitting `not-json` followed by
   `FACTORY_REVIEW_VERDICT: PASS` was parsed as PASS. TASK-004 requires this
   case to fail closed.

4. **HIGH — verification cwd is not confined to the approved workspace.**
   `src/orchestration/verificationWorker.ts:59-60` resolves `cwd` without
   checking containment; `../../outside` produced `/approved/outside` in a
   focused probe. CLI validation does not close this boundary.

5. **HIGH — start/resume concurrency is not claimed atomically.**
   `start()` performs list-then-create without a per-work-item CAS/lock, and
   `resume()` has no per-loop action lease. Focused probes created two loop
   rows for one concurrent start and two implementer runs for two concurrent
   resumes; the latter ended in a failed loop.

6. **HIGH — cancellation can race a new worker launch.**
   A probe paused immediately before `FactoryService.runWorker`, durably
   cancelled the loop, then released the call; an implementer run still
   launched after cancellation. The loop ended CANCELLED, but the new Factory
   run and WorkItem transition were already recorded, violating the required
   no-further-autonomous-step guarantee.

Smallest required remediation: add authoritative cross-store reconciliation or
an equivalent durable action/lease protocol; reject unsafe loop rows before
resume; make reviewer protocol parsing depend on validated adapter output;
confine verification cwd; serialize start/resume actions; and make cancellation
win before any new external action. No fixes were implemented during this
review.

Verification run locally: `node --version` v22.23.1, `npm run typecheck`,
`npm run build`, `npm test` (416/416), focused TASK-004 suites (48/48),
`npm run demo`, `npm run demo:persistent` twice, `npm run worker:doctor`,
`npm run demo:loop`, and `git diff --check` all passed. No real Claude/Codex
model was invoked. Host process permission was required only for deterministic
local child-process/git fixtures.

**TASK-004 is not safe for human acceptance or commit.**

### Focused independent re-review after remediation round 1 — 2026-08-21

**Verdict: CHANGES_REQUIRED**

The original six HIGH reproductions are closed by the current permanent tests:
`tests/remediationRound1Repro.test.ts` passes all 16 cases, and the expanded
crash/reconciliation, concurrency, cancellation, structured-output, cwd, and
authority suites also pass. The action-claim ordering, exact-tag reconciliation,
unknown RUNNING fail-closed state, current Factory lineage checks, and offline
loop demos were independently exercised.

Two additional reproducible HIGH persistence/integrity blockers remain:

1. **HIGH — the active-loop partial-index predicate is not validated.**
   `src/adapters/orchestration/sqliteLoopRepository.ts:149-177` validates the
   index name, uniqueness, partial flag, and indexed columns, but never checks
   its `WHERE` expression. A v2 database with the expected index name and
   columns but `WHERE phase = 'WAITING_FOR_HUMAN'` opens successfully. That
   schema no longer enforces uniqueness for active `READY`/`IMPLEMENTING`/
   `VERIFYING`/`REVIEWING` rows, so concurrent starts can bypass the claimed
   invariant. Smallest remediation: validate the normalized `sqlite_master.sql`
   predicate (or an equivalent structural representation) against the exact
   active-phase predicate and refuse mismatches.

2. **HIGH — corrupted action correlation can adopt a stale Factory Run and
   continue autonomously.** `src/orchestration/loopSerialization.ts:215-229`
   accepts any non-empty `correlationTag` and does not bind it to
   `correlationTag(loopId, actionId, attempt)` or reject reused action identities.
   `EngineeringLoopService.reconcile()` at
   `src/orchestration/engineeringLoopService.ts:447-489` then adopts an exact
   tag match. A temporary end-to-end probe inserted a valid JSON loop claim with
   the exact tag of an earlier terminal implementer Run; `resume()` marked that
   old Run recovered, launched a new verifier and reviewer, and reached
   `WAITING_FOR_HUMAN`. This violates corrupted-loop fail-closed behavior and
   stale generation/action isolation. Smallest remediation: validate the
   canonical tag/claim identity, enforce action-id/tag uniqueness and
   iteration/slot coherence, and refuse invalid or ambiguous references before
   reconciliation.

The narrow live-owner takeover race remains explicitly fail-closed: a duplicate
child may be detected as a superseded non-FAILED Run and move the loop to
`RECOVERY_REQUIRED`; no such duplicate was silently accepted as current
authority. A concurrent semantic `recordReview` race can duplicate a Review
record with the same reviewer Run, but it does not create a second model call or
change current authority; this is non-blocking relative to the two findings
above.

Verification: host-permission `npm test` passed 458/458; focused remediation and
reconciliation suites passed; required demos/doctor and `git diff --check`
passed. No real Claude/Codex model was invoked. No implementation fix was made.

**TASK-004 remains not safe for human acceptance or commit.**

## Implementer remediation round 1

Worker: Claude Code (Fable 5), role IMPLEMENTATION ENGINEER. Responds to the
independent Codex review directly above (preserved verbatim, not edited).
The six HIGH findings were treated as one root problem — external side
effects had no durable identity, so nothing could be claimed before it
happened or reconciled after a crash — and answered with one coherent
crash-safe action protocol rather than six local patches. Full protocol
specification: `docs/tasks/TASK-004-autonomous-engineering-loop.md`,
"Remediation Round 1" section (R1–R10). No FACTORY_CONSTITUTION.md change;
TASK-005 not started; nothing committed or pushed.

### 1. Root-cause map for the six HIGH findings

- **HIGH 1 (cross-DB duplication):** loop checkpoints were written only
  AFTER `FactoryService` commits, with no pre-launch identity — resume could
  not tell "crashed before the Run" from "crashed after it", so it
  relaunched. Root cause: no durable action identity, no reconciliation.
- **HIGH 2 (valid-JSON corruption accepted):** `sqliteLoopRepository`
  validated only shallow top-level fields, then cast.
- **HIGH 3 (raw-stdout PASS):** `cliWorker.ts` labeled its raw-stdout
  fallback with the same `/transcript` evidence reference as a genuinely
  parsed structured answer, and the loop parsed verdicts from all of it plus
  `Run.summary`.
- **HIGH 4 (cwd escape):** `resolve(workspace.root, cwd)` with no
  containment check.
- **HIGH 5 (unclaimed concurrency):** start was check-then-insert with no
  persistence-level uniqueness; resume had no claim at all, so two drivers
  both launched.
- **HIGH 6 (cancel/launch race):** round 1's `save()` retried a lost CAS by
  re-applying its patch onto the fresh row — which is precisely how a step
  that lost its CAS **to a committed cancellation** still went on to launch.
  The "fix things by retrying" convenience was itself the bug.

### 2. Crash-safe action / idempotency protocol

Every external side effect is now a **claimed action**: a `WorkerActionClaim`
(`actionId`, `kind`, `attempt`, `ownerToken`, `claimedAt`, `correlationTag`)
persisted onto the single loop row via CAS BEFORE the launch, with the two
`recordReview` side effects claimed the same way
(`deterministicReviewClaim`/`semanticReviewClaim`). The claim's
`correlationTag` (`sf-loop:<loopId>:<actionId>:a<attempt>`) becomes the
launched Worker object's `id`, which `runWorker` durably records as
`Run.declaredWorkerId` in PHASE 1 — a stable, pre-execution,
Factory-persisted identity for the side effect. Completions are written as
FACTS (bounded re-read-and-merge touching only the completion's own fields,
counting each attempt exactly once); claims and phase changes are STRICT
single CAS writes with no retry. WorkItem transitions need no journal row:
the WorkItem status is itself the authoritative durable record, observed
idempotently ("advance only if still at X, accept if already at Y").

### 3. Cross-database reconciliation

Kept factory.db + loops.db (option B) with a real reconciliation pass that
runs at the top of every drive step, BEFORE budgets and before any new
claim: the last incomplete claim is matched against `factory.listRuns` by
exact tag (role cross-checked) — terminal Run → adopt (marked `recovered`,
counted once, never relaunched); RUNNING Run → RECOVERY_REQUIRED (PART Q:
never invent evidence, never relaunch — the RUNNING run also keeps release
snapshots unresolvable by existing TASK-001 law); no Run → the crash
preceded PHASE 1, relaunch exactly once (takeover re-claim, attempt+1, new
tag); superseded-attempt Runs that are RUNNING/SUCCEEDED → RECOVERY_REQUIRED
(post-hoc double-launch detection). Reviews reconcile through the new
read-only `FactoryService.listReviews` matched by exact `reviewerRunId`.
All seven PART B windows are covered by tests (see §9/§10). Recovery never
guesses by role/latest/title/timestamp (PART C) — the previous latest-run
guess in the WorkerExecutionError path was also replaced with exact-tag
lookup.

### 4. Durable start/resume concurrency control

Start uniqueness is DB-enforced (PART E): a partial UNIQUE index on
`engineering_loops(work_item_id) WHERE phase IN (active…)` in SQLite —
validated structurally at open, including its partial-ness — and the
equivalent check inside the in-memory adapter's synchronous (yield-free,
atomic) `create()`. A losing concurrent `start()` dies at `create()` with
`ConcurrencyError` before anything launches. Resume concurrency is decided
at the claim CAS: exactly one process wins the claim; a loser re-reads once
and backs off ("another process is driving"). Stale claims never expire by
time (no lease-expiry double-worker risk, per the brief's warning); recovery
is explicit reconciliation, with the crashed-owner takeover path and its one
residual alive-but-stalled-owner interleaving documented and detected
post-hoc rather than papered over.

### 5. Cancellation / launch linearization

`cancel()` durably records `cancelRequested` (a fact write — durable
immediately from the caller's perspective), then finalizes CANCELLED. The
loop row's `version` is the single linearization point: CANCEL WON → the
step's stale claim CAS loses, and the conflict handler sees the committed
cancellation — no external action begins (repro R10 pins the exact
read-then-cancel-then-launch interleaving with a deterministic snapshot
hook: zero worker executions, zero Factory runs, loop CANCELLED). LAUNCH WON
→ the already-claimed action may finish (TASK-003 workers expose no mid-call
abort) and every subsequent action is refused; as a second layer, a
pre-flight guard wrapped around every launched Worker re-reads the durable
loop row inside `execute()` — after PHASE 1, before any process could
spawn — and aborts with an honest FAILED outcome on committed cancellation,
terminal loop, or lost ownership. Both race orderings are proven with
deterministic barriers (R10; the launch-won ordering by the existing
gated-worker cancellation test, which also proves the completed run's
evidence is preserved).

### 6. loops.db validation / schema hardening

New `src/orchestration/loopSerialization.ts` validates every row on read —
shapes, enums, ranges, strict 1..n iteration numbering, claim coherence (no
run id without its upstream claim, no verdict without its reviewer run,
verdict+reviewRecordId atomic), terminal coherence (outcome equals the
terminal phase; active loops carry no terminal fields; CANCELLED requires
cancelRequested; WAITING_FOR_HUMAN requires an authoritative passing review
reference; EXHAUSTED requires an `exhaustionKind` its stored numbers
actually support), `totalRunCount` equal to the completed claimed-action
runs on record, and cross-checks of every duplicated SQL column (id,
work_item_id, phase, version) against the JSON payload. Violations throw
`PersistenceCorruptionError`; a corrupted row kills `resume()` at
`findById`, before any launch decision (proven). Schema integrity at open
mirrors TASK-002: tables/columns/PKs and every relied-upon index — including
the active-loop partial unique index's uniqueness, partial-ness and
columns — are validated structurally; version markers alone prove nothing;
nothing is silently repaired; non-loops databases are refused.

### 7. Reviewer structured-output fix

`cliWorker.ts` now emits two distinct evidence channels: `/transcript` ONLY
for a structured-parse-recovered tool answer, `/raw-output` (bounded,
redacted, labeled "diagnostic only") when the structured contract was
violated. The loop parses verdicts exclusively from the reviewer run's
`/transcript` evidence — the `Run.summary` fallback is deleted. A clean-exit
process printing a plain-text PASS tag now fails closed ("no structured
reviewer output") into remediation/exhaustion (repro R6, driven through the
real Codex adapter against a contract-violating fake CLI). Non-zero exit +
valid PASS JSON still never reaches the parser (unchanged, still tested).
References are adapter-authored code, not model text — the channel cannot be
forged from inside a transcript.

### 8. Verification cwd containment fix

`resolveContainedCwd` confines every configured cwd to `workspace.root` (the
narrower approved execution workspace of the TASK-003 contract;
`repositoryRoot` may be broader and nothing authorizes executing outside the
configured subdirectory — rule documented in the design doc R8). Real
symlink-resolved paths on both sides; `../` escapes, absolute outside paths,
symlink escapes (including a symlink created AFTER loop start — the check
runs at `start()` and again per command at execution time), nonexistent
paths, non-directories and lexical prefix cousins are all rejected; spaces
are safe; no shell exists anywhere. An execution-time violation now fails
the loop closed (`FAILED`) instead of remediating — remediation cannot fix a
configuration problem.

### 9. Crash/concurrency adversarial tests

Three permanent suites beyond the reworked originals:

- `tests/remediationRound1Repro.test.ts` — 16 tests, one per reviewer
  reproduction (R1/R2a/R2b/R3 for HIGH 1; R4a–f/R5 for HIGH 2; R6–R10 for
  HIGH 3–6).
- `tests/loopReconciliationMatrix.test.ts` — 10 tests: PART M windows
  M-A (claimed/no Run → relaunch exactly once under attempt 2, tag-exact),
  M-D (verifier terminal → adopt, `recovered` telemetry), M-F
  (DETERMINISTIC review persisted → adopt, exactly one review), M-H
  (remediation run terminal → adopt with `totalRunCount === 6`, no budget
  double-spend — PART O), M-J (WorkItem WAITING/loop stale → reconcile
  forward, zero extra reviewer calls), M-K (EXHAUSTED durable/BLOCKED
  missing → resume finishes the transition with zero worker spend,
  exhaustion survives restart); PART K (a claimed-but-unlaunched remediation
  action never adopts the previous iteration's run); PART L (a tampered
  loop-local PASS with no authoritative Factory review fails closed to
  FAILED at the advance's own precondition — Factory authority wins); PART N
  (two independent SQLite connections racing one claim launch exactly one
  run — DB-enforced CAS across real connections; corrupted row blocks resume
  with zero runs).
- Containment suite in `tests/verificationWorker.test.ts` (9 new tests,
  including the late-symlink defense-in-depth case) and a CLI-level
  containment rejection in `tests/loopCli.test.ts`.

Crash simulation is condition-based fault injection pinned to durable-state
shapes (never write counts) with full post-crash poisoning — after the
simulated death, every repository operation throws, so the orchestrator's
own failure bookkeeping cannot run through a "dead" store (and `drive()`'s
failure path was restructured accordingly: if the loop store is unavailable,
the original error propagates and the WorkItem is left untouched, exactly
like a real crash). The five original A–E window tests in
`tests/engineeringLoopService.test.ts` were reworked onto the same
discipline and kept. All races use explicit barriers/hooks, and assertions
count exact loop rows, implementer/verifier/reviewer runs, and Reviews.

### 10. Proof each finding reproduced pre-fix

Phase 0 was run before any fix, exactly as instructed: all 16 reproduction
tests were written first and executed against the unfixed implementation —
**16/16 failed** (`node --test dist/tests/remediationRound1Repro.test.js`:
"tests 16, pass 0, fail 16"), reproducing every finding: duplicate
implementer run after resume (R1), duplicate reviewer run/Review (R2a/R2b),
duplicate launch beside a durable RUNNING run (R3), all six valid-JSON
corruption shapes accepted (R4a–f), SQL/JSON phase divergence accepted (R5),
raw-stdout PASS accepted end-to-end through the real Codex adapter (R6),
`../outside` execution with a marker file written outside the workspace
(R7), two active loops from two concurrent starts once non-colliding id
generation is used (R8 — the first probe also exposed that the round-1 CLI
wiring minted colliding sequential ids across OS processes, fixed via
`createRandomIdGenerator`), two implementer runs from two concurrent resumes
(R9), and a worker launching after a durably-committed cancellation (R10).
Post-fix: 16/16 pass, unchanged assertions.

### 11. Exact post-fix verification results

From a clean build (`rm -rf dist .factory-data`):

- `npm run typecheck` — PASS
- `npm run build` — PASS
- `npm test` — **458 tests, 458 pass, 0 fail** (up from 416; +42 net from
  this round), stable across 3 consecutive full runs
- `npm run demo` — DONE, 15 refusals, unchanged
- `npm run demo:persistent` twice (seed, then a second OS process reading
  back) — unchanged
- `npm run worker:doctor` — claude 2.1.235 and codex-cli 0.147.0 still found
- `npm run demo:loop` — all three scenarios unchanged
  (WAITING_FOR_HUMAN / WAITING_FOR_HUMAN after one remediation / EXHAUSTED +
  WorkItem BLOCKED)
- `git diff --check` — clean; `git status --short` matches §12
- Focused suites all green: remediationRound1Repro (16),
  loopReconciliationMatrix (10), engineeringLoopService (21),
  verificationWorker (16), sqliteLoopRepository (9), inMemoryLoopRepository
  (8), loopCli (11), reviewVerdictParser (15), loopPrompts (5), cliWorker.

No real Claude/Codex model was invoked: the changed TASK-003 surface
(`cliWorker.ts`) alters only how already-captured output is labeled as
evidence — argv construction, environment, workspace and authentication
paths are untouched — so deterministic fake-CLI coverage suffices and no
real smoke was re-burned, per the brief's instruction.

### 12. Files created/modified

Created: `src/orchestration/loopSerialization.ts`;
`tests/remediationRound1Repro.test.ts`;
`tests/loopReconciliationMatrix.test.ts`.

Modified: `src/orchestration/{loopTypes,engineeringLoopService,
verificationWorker}.ts` (protocol, guard, containment; `loopRepository.ts`
contract docs unchanged in shape);
`src/adapters/orchestration/{sqliteLoopRepository,inMemoryLoopRepository}.ts`
(schema v2 + integrity validation + active-loop uniqueness);
`src/adapters/workers/cliWorker.ts` (evidence-channel split only);
`src/app/factoryService.ts` (additive read-only `listReviews`);
`src/domain/ids.ts` (additive `createRandomIdGenerator`);
`src/cli/loop.ts` (random ids); `tests/fixtures/fake-clis/fake-codex.mjs`
(new `raw` mode); reworked tests:
`tests/{engineeringLoopService,sqliteLoopRepository,inMemoryLoopRepository,
verificationWorker,loopCli,cliWorker}.test.ts`;
`docs/tasks/TASK-004-autonomous-engineering-loop.md` ("Remediation Round 1"
section, R1–R10); `AI-HANDOFF.md` (this section);
README updated where the changed behavior required it.

Not touched: `src/domain/` (beyond the additive id generator),
`src/workflow/`, `FactoryService` write paths, both factory.db persistence
adapters, `src/adapters/workers/{claudeCodeAdapter,codexCliAdapter,
promptTemplates,environmentPolicy,workspace}.ts`, `src/ports/`, any
TASK-001/002/003 test, `docs/FACTORY_CONSTITUTION.md`.

### 13. Remaining limitations

- Exactly-once under arbitrary LIVE-process interleavings is impossible
  without process fencing; the protocol's guarantee is
  exactly-once-or-fail-closed: the one residual window (an
  alive-but-stalled prior owner spawning inside the microseconds between its
  pre-flight ownership check and its spawn, concurrent with a takeover) is
  detected post-hoc by the superseded-run rule and lands in
  RECOVERY_REQUIRED, never silently double-counted. Documented in the design
  doc R4.
- `resume()` while another live process has a worker legitimately mid-flight
  is indistinguishable from a crashed owner with a stuck RUNNING run and
  fails closed to RECOVERY_REQUIRED — safe, but destructive to a healthy
  concurrent run's loop; concurrent resumes against an actively-driven loop
  are documented operator misuse.
- RECOVERY_REQUIRED is terminal with no in-band operator workflow yet
  (inspect + cancel or start a fresh loop after the WorkItem is resumed by a
  human); an `sf loop recover` surface is future work.
- Duplicate-review residual: two live processes racing the semantic-review
  recording inside the narrow claim-steal window could still record two
  identical Reviews in append-only factory.db (harmless to verdict
  authority — latest-in-append-order wins — but a duplicate side effect);
  narrowed by the claim + immediate listReviews re-check, not eliminated.
- Mid-call worker abort remains unavailable (TASK-003 Worker port has no
  abort channel) — cancellation stops every SUBSEQUENT action; the pre-flight
  guard additionally stops claimed-but-not-yet-spawned launches.
- All prior TASK-001/002/003 limitations still apply unchanged.

### 14. Ready for independent re-review: YES

## TASK-004 REVIEWER — Independent re-review round 2

### Verbatim remediation brief (2026-08-21)

> TASK-004 — Autonomous Engineering Loop Remediation Round 2
>
> Independent Codex re-review returned CHANGES_REQUIRED with TWO remaining HIGH
> findings.
>
> Do NOT start TASK-005.
> Do NOT commit or push.
> Do NOT modify FACTORY_CONSTITUTION.md.
> Do NOT perform unrelated refactoring.
>
> Preserve the latest independent reviewer report verbatim in AI-HANDOFF.md.
>
> The two blockers are:
>
> HIGH 1
> sqliteLoopRepository validates the active-loop partial unique index's:
> - name
> - uniqueness
> - partial flag
> - indexed columns
>
> but NOT its WHERE predicate.
>
> A semantically wrong partial index can therefore pass schema validation while
> allowing multiple active loops for one WorkItem.
>
> HIGH 2
> Persisted action correlation metadata is not canonical enough.
> loopSerialization accepts arbitrary/reused correlation tags/action identities.
>
> A corrupted claim was able to adopt an older terminal Factory Run, then launch
> new verification/review work and reach WAITING_FOR_HUMAN.
>
> Both findings must be closed before TASK-004 can be committed.
>
> ==================================================
> PHASE 0 — PERMANENT PRE-FIX REPRODUCTIONS
> ==================================================
>
> Before implementation changes, add deterministic regressions for BOTH findings.
>
> Do not weaken them after fixing.
>
> --------------------------------------------------
> A. WRONG PARTIAL-INDEX PREDICATE
> --------------------------------------------------
>
> Create a loops.db whose active-loop index has:
>
> - expected name
> - expected UNIQUE flag
> - expected indexed column(s)
> - partial = true
>
> BUT a semantically wrong WHERE predicate.
>
> Choose the wrong predicate so the schema demonstrably permits a state that the
> real active-loop uniqueness rule must prohibit.
>
> Prove pre-fix:
>
> 1. SQLiteLoopRepository opens the malformed DB.
> 2. The malformed predicate can permit more than one logically-active loop for
>    the same WorkItem, or otherwise fails to enforce the expected invariant.
>
> Expected post-fix:
>
> - repository open fails explicitly with SchemaIntegrityError
> - no autonomous action can run from that malformed DB
> - DB is not silently repaired
>
> Also test harmless SQL formatting variations of the CORRECT predicate if the
> validator is intended to tolerate them.
>
> --------------------------------------------------
> B. CORRUPTED/REUSED ACTION CORRELATION
> --------------------------------------------------
>
> Reproduce the exact reviewer authority failure.
>
> Create:
>
> - an older terminal Factory Run belonging to another historical action
> - a current loop/action claim whose persisted action identity/correlation
>   metadata is maliciously/corruptly changed to reference/adopt that older Run
>
> Prove pre-fix that reconciliation can:
>
> - adopt the old Run
> - treat it as current action completion
> - continue verification/review
> - reach WAITING_FOR_HUMAN incorrectly
>
> Expected post-fix:
>
> - corrupted action/correlation state is rejected before reconciliation
> - zero new verification/reviewer worker launches
> - old Run is never adopted as current authority
> - WAITING_FOR_HUMAN is unreachable through the corrupted state
>
> ==================================================
> PART 1 — VALIDATE THE EXACT ACTIVE-INDEX PREDICATE
> ==================================================
>
> Inspect the actual v2 loop schema DDL and derive the authoritative active-loop
> predicate from the schema contract itself.
>
> Do NOT invent a new policy.
>
> The schema validator must verify the semantic WHERE predicate relied upon by
> the active-loop uniqueness invariant.
>
> SQLite PRAGMA index_list only tells us that an index is partial; that is not
> enough.
>
> Inspect sqlite_master / sqlite_schema SQL for the specific index as needed.
>
> Validation must establish:
>
> - correct table
> - correct UNIQUE property
> - exact indexed column sequence
> - partial index expected
> - correct logical predicate defining which phases count as active
>
> Do NOT accept:
>
> same index name
> + same columns
> + partial=true
> + arbitrary WHERE expression
>
> as valid.
>
> Avoid fragile byte-for-byte SQL comparison if harmless:
> - whitespace
> - casing
> - quoting
>
> differences can occur.
>
> Use the smallest robust normalization/parser appropriate to this ONE
> Factory-owned predicate.
>
> Do not introduce a general SQL parser dependency unless absolutely necessary.
>
> Tests must include:
>
> 1. exact correct schema => accepted
> 2. correct predicate with harmless formatting variation => accepted if intended
> 3. missing WHERE => rejected
> 4. inverted/wrong phase predicate => rejected
> 5. predicate omitting one required phase => rejected
> 6. predicate including a terminal phase as active, if contrary to contract =>
>    rejected
> 7. same name/columns/unique/partial but unrelated predicate => rejected
>
> The schema validator must fail closed.
>
> ==================================================
> PART 2 — ONE CANONICAL ACTION IDENTITY FUNCTION
> ==================================================
>
> The core rule must become:
>
> Persisted correlation metadata is NOT arbitrary trusted text.
>
> Define one canonical trusted action identity derivation used by:
>
> - action creation
> - persistence validation
> - reconciliation
> - worker correlation
>
> Do not let each location construct IDs independently.
>
> Prefer a deterministic identity derived from immutable action coordinates,
> conceptually including enough of:
>
> - loopId
> - WorkItem association
> - iteration
> - action kind
> - attempt
>
> The exact representation is an implementation choice.
>
> For example, a canonical tuple-derived identifier or hash is acceptable.
>
> Important properties:
>
> - same logical action/attempt => same expected identity after restart
> - different loop => different identity
> - different iteration => different identity
> - different action kind => different identity
> - different attempt => different identity
> - value cannot be arbitrarily supplied by persisted JSON and trusted
> - no model-controlled text contributes to identity
>
> Do NOT use:
> - title
> - prompt
> - timestamps
> - tool output
> - latest Run
> - role alone
>
> as identity.
>
> ==================================================
> PART 3 — CANONICAL correlationTag
> ==================================================
>
> correlationTag must be derived from trusted canonical action identity.
>
> Do not deserialize and trust:
>
> correlationTag: "whatever was stored"
>
> Instead, on read:
>
> 1. validate immutable action coordinates
> 2. derive EXPECTED action identity
> 3. derive EXPECTED correlation tag
> 4. compare persisted values exactly to expected canonical values
> 5. mismatch => PersistenceCorruptionError / appropriate orchestration
>    corruption error
>
> Reconciliation must use the derived/validated canonical value.
>
> It must never use unchecked persisted arbitrary correlation text as a Factory
> Run lookup key.
>
> ==================================================
> PART 4 — ACTION IDENTITY UNIQUENESS / COHERENCE
> ==================================================
>
> Validate the complete EngineeringLoop on read for identity collisions.
>
> Within one loop, reject:
>
> - duplicate actionId
> - duplicate canonical correlationTag
> - two different logical actions mapping to same identity
> - reused identity across different iterations
> - reused identity across IMPLEMENT / VERIFY / REVIEW / REMEDIATE
> - attempt number inconsistent with identity
> - claim coordinates inconsistent with containing iteration
> - completion metadata referencing an action identity belonging to another
>   action
>
> If historical/superseded attempts remain in the loop, their canonical
> identities must remain unique and internally coherent.
>
> Do not reject legitimate recovery records simply because they are historical.
>
> ==================================================
> PART 5 — CROSS-LOOP / OLD-RUN ADOPTION DEFENSE
> ==================================================
>
> Add explicit adversarial tests proving that reconciliation cannot adopt:
>
> - an older IMPLEMENTER Run from a previous iteration
> - an older Run from a different loop
> - a Run with the same role/model but different canonical correlation
> - an older REVIEWER Run
> - a superseded attempt's Run as the current attempt
>
> even if corrupted persisted loop JSON tries to point at them.
>
> Factory Run matching must require exact current canonical correlation identity.
>
> No "closest match", latest-role match, title match, or timestamp inference.
>
> ==================================================
> PART 6 — VALIDATE BEFORE ANY RECONCILIATION
> ==================================================
>
> A corrupted loop row must die at the persistence trust boundary.
>
> Required ordering:
>
> SQLite row
> ↓
> parse JSON
> ↓
> full loop validation
> ↓
> canonical action identity validation
> ↓
> SQL/JSON metadata cross-check
> ↓
> ONLY THEN return EngineeringLoop
> ↓
> ONLY THEN reconciliation is allowed
>
> Do not make engineeringLoopService responsible for detecting arbitrary
> persistence corruption after it has already received trusted-looking state.
>
> ==================================================
> PART 7 — AUTHORITATIVE PASS DEFENSE
> ==================================================
>
> Add a regression reproducing the reviewer's exact dangerous outcome.
>
> Corrupt correlation metadata so it attempts to reuse an old PASS-compatible
> lineage.
>
> Then call resume.
>
> Assert:
>
> - PersistenceCorruptionError / explicit fail-closed result occurs
> - no verification worker launches
> - no semantic reviewer launches
> - no new Review is recorded
> - WorkItem does NOT transition to WAITING_FOR_HUMAN
> - loop does not gain PASS authority
> - old terminal Run remains historical only
>
> This should be a permanent TASK-004 regression.
>
> ==================================================
> PART 8 — DO NOT BREAK CRASH RECOVERY
> ==================================================
>
> Canonical identity must preserve the good Round-1 behavior.
>
> Re-run:
>
> claim durable
> + crash
> + no Run
> => legitimate attempt recovery works according to documented protocol
>
> terminal matching Run
> + missing loop checkpoint
> => exact Run adopted once
>
> RUNNING matching Run
> => RECOVERY_REQUIRED
>
> completed Review
> + missing loop checkpoint
> => exact Review adopted safely
>
> The new validation must not make legitimate crash recovery impossible.
>
> ==================================================
> PART 9 — TAKEOVER / ATTEMPT BUMP
> ==================================================
>
> Review the existing takeover semantics.
>
> If a new legitimate attempt is created:
>
> attempt N
> => canonical identity N
>
> attempt N+1
> => NEW canonical identity
>
> They must not collide.
>
> A takeover must never reuse the correlation identity of a superseded attempt.
>
> Regression:
>
> attempt 1 historical terminal Run exists
> attempt 2 current
> => attempt 2 cannot reconcile against attempt 1
>
> ==================================================
> PART 10 — SCHEMA VALIDATION MUST REMAIN SIDE-EFFECT FREE
> ==================================================
>
> A malformed active-loop index predicate must be detected before normal use.
>
> Do not silently:
>
> DROP INDEX
> CREATE INDEX
>
> or otherwise repair the database during ordinary open.
>
> Existing incompatible/corrupt DB:
> => refuse explicitly
>
> Fresh DB:
> => create canonical v2 schema
>
> Preserve the schema-hardening principles already established in TASK-002/004.
>
> ==================================================
> PART 11 — KEEP THE REMEDIATION SMALL
> ==================================================
>
> Do NOT redesign the entire Round-1 action journal.
>
> The reviewer explicitly found the normal claim/reconciliation architecture
> sound.
>
> This round should primarily touch:
>
> - canonical action identity helpers
> - loopSerialization validation
> - reconciliation lookup usage if necessary
> - sqlite loop schema/index validation
> - focused tests/docs
>
> Do not change real Claude/Codex invocation unless genuinely required.
>
> Do not rerun real AI models.
>
> ==================================================
> PART 12 — REQUIRED REGRESSION SET
> ==================================================
>
> Permanent tests must prove:
>
> INDEX:
>
> A. same index name + wrong predicate rejected
> B. omitted predicate condition rejected
> C. wrong active-phase set rejected
> D. valid canonical index accepted
>
> CORRELATION:
>
> E. arbitrary correlation tag rejected
> F. mismatched canonical actionId rejected
> G. duplicate action identity rejected
> H. duplicate correlation tag rejected
> I. prior-iteration Run cannot be adopted
> J. different-loop Run cannot be adopted
> K. superseded-attempt Run cannot be adopted
> L. corrupted claim cannot reach verification/review
> M. corrupted claim cannot reach WAITING_FOR_HUMAN
>
> RECOVERY:
>
> N. legitimate exact current terminal Run still reconciles
> O. legitimate exact current Review still reconciles
> P. unknown matching RUNNING Run still reaches RECOVERY_REQUIRED
>
> ==================================================
> PART 13 — PRESERVE ALL PRIOR FIXES
> ==================================================
>
> Do not regress the six Round-1 HIGH fixes:
>
> - crash reconciliation
> - loops.db runtime validation
> - transcript-only reviewer authority
> - verification cwd containment
> - concurrent start/resume protection
> - cancellation/launch ordering
>
> Also preserve TASK-001/002/003 invariants.
>
> ==================================================
> FINAL VERIFICATION
> ==================================================
>
> Run:
>
> npm run typecheck
> npm run build
> npm test
> npm run demo
> npm run demo:persistent
> npm run worker:doctor
> npm run demo:loop
> git diff --check
> git status --short
>
> Also run focused tests for:
>
> - malformed active index predicate
> - canonical action/correlation validation
> - historical Run adoption
> - crash reconciliation
>
> Automated tests only.
> Do NOT invoke real Claude/Codex models.
>
> Update:
>
> - TASK-004 design doc
> - TASK-004 IMPLEMENTER remediation section in AI-HANDOFF.md
>
> Preserve all previous reviewer reports verbatim.
>
> Do NOT commit.
> Do NOT push.
> Do NOT start TASK-005.
>
> Final response only:
>
> 1. Root cause of the two remaining HIGH findings
> 2. Active-index predicate validation design
> 3. Canonical action identity design
> 4. Correlation validation/reconciliation changes
> 5. Historical/superseded Run adoption defenses
> 6. Pre-fix reproduction results
> 7. New permanent regression tests
> 8. Exact full verification results
> 9. Files changed
> 10. Remaining limitations
> 11. Ready for independent re-review: YES/NO
>
> STOP after TASK-004.


## Implementer remediation round 2

Worker: Claude Code (Sonnet 5), role IMPLEMENTATION ENGINEER. Responds to the
independent Codex re-review directly above (preserved verbatim, not edited).
No FACTORY_CONSTITUTION.md change; TASK-005 not started; nothing committed or
pushed; no unrelated refactoring. Full protocol detail:
`docs/tasks/TASK-004-autonomous-engineering-loop.md`, "Remediation Round 2"
section (S1–S6).

### 1. Root cause of the two remaining HIGH findings

- **HIGH 1:** `PRAGMA index_list`/`index_info` prove an index is unique,
  partial, and over the right column — they cannot show *which phases* a
  partial condition restricts to. `sqliteLoopRepository`'s schema validation
  stopped at that structural proof, so a same-name/same-columns/unique=true/
  partial=true index with a semantically wrong `WHERE` clause (a phase
  omitted, an inverted condition, an unrelated predicate) passed validation
  while not actually enforcing "at most one active loop per work item."
- **HIGH 2:** `actionId` was minted via `ids.next("act")` — an opaque random
  token with no relationship to the claim's own position (loop, iteration,
  kind). `loopSerialization.ts` checked that a claim's `actionId`/
  `correlationTag` were present, non-empty strings — never that they were
  the *correct* ones for that position — so a corrupted row could set them to
  any string, including one copied from an older, unrelated, already-
  terminal Run's real `declaredWorkerId`, which reconciliation's exact-tag
  lookup would then dutifully adopt as the current action's completion.

### 2. Active-index predicate validation design

`validateActiveIndexPredicateSql(sql, indexName, requiredPhases)` — a small,
hand-written parser scoped to exactly one predicate shape (`phase IN
('P1', 'P2', ...)`), not a general SQL parser. It reads the index's real
declared text from `sqlite_master.sql` (confirmed by direct experiment that
SQLite stores DDL verbatim, not re-serialized), extracts the `WHERE` clause
via one anchored regex, and compares the referenced phase set against
`ACTIVE_LOOP_PHASES` as a **set** — so entry order, whitespace, and keyword
casing never matter, while a missing/extra/wrong phase, an inverted
condition, or an unrelated clause are all rejected. Wired into
`validateTable`'s per-index loop as an additional check (a new
`requiredWherePhases` field on `ExpectedIndex`), running only after the
existing structural checks pass, and — per PART 10 — this is pure read-only
introspection at open time: no DDL runs, nothing is auto-repaired, an
incompatible database is refused outright with `SchemaIntegrityError`.

### 3. Canonical action identity design

One pure function, `canonicalActionId(loopId, iteration, kind) =
"${loopId}:i${iteration}:${kind}"`, used everywhere an action identity is
needed: action creation (`claimIfNeeded` computes it directly — `ids.next
("act")` is gone from that path), persistence validation
(`loopSerialization.ts` recomputes and requires an exact match),
reconciliation (unchanged exact-tag lookup, now against a value that cannot
be forged), and worker correlation (`guardedWorker`'s `id`, unchanged). The
tuple is injective by construction — `iteration` is validated elsewhere to
be strictly 1..n with no duplicates, `kind` is one of three fixed literals,
the format is unambiguous — so no two claims anywhere in one loop can share
a canonical `actionId`. `attempt` lives in the tag, not the actionId: a
takeover keeps the same logical `actionId` (it is the same action) but gets
a new tag, so attempt N+1 can structurally never satisfy attempt N's
exact-tag lookup (closes PART 9 directly, no separate rule needed).

**A real bug caught while wiring this up:** `correlationTag`'s original
signature took a separate `loopId` parameter, which — once `actionId` itself
started embedding the loop id — caused the loop id to appear twice in every
tag (`sf-loop:loop-x:loop-x:i1:IMPLEMENT:a1`). Harmless but sloppy; fixed by
dropping the now-redundant parameter, caught by a test asserting the exact
expected tag string rather than merely "does not throw."

### 4. Correlation validation / reconciliation changes

`loopSerialization.ts`'s new `validateCanonicalClaim` recomputes the
expected `actionId`/`correlationTag` for every `implementClaim`/
`verifyClaim`/`reviewClaim` it parses and throws `PersistenceCorruptionError`
on any deviation — inside `parseIteration`, strictly before
`parseEngineeringLoop` ever returns, matching PART 6's required ordering
exactly (`engineeringLoopService` is never asked to detect this class of
corruption itself; it only ever receives an already-validated
`EngineeringLoop`).

PART 4's duplicate-actionId/duplicate-correlationTag requirement is
satisfied structurally, not by a second scanning pass: since canonical
derivation makes two claims sharing an identity impossible unless one of
them is already non-canonical for its own position, the same per-claim check
that closes E/F/I/J also closes G/H — proven directly by constructing a
row that tries to duplicate iteration 1's identity onto iteration 2 and
confirming rejection. PART 11 asked to keep this small; an emergent,
provably-total guarantee is smaller than a second bookkeeping structure that
could itself drift out of sync with the first.

**Defense in depth added beyond the literal reproduction recipe:**
`engineeringLoopService.reconcile()` now also re-verifies every *already-
completed* slot on each reconciliation pass — looking up its stored run id
in the (already-fetched) Factory run list and requiring
`run.declaredWorkerId === claim.correlationTag`, routing to
`RECOVERY_REQUIRED` on any mismatch or missing run. The brief's literal
Phase-0 recipe corrupts an *incomplete* claim (no run id yet, matching
reconciliation's lookup path); a row could instead corrupt an
*already-completed* slot's run id field directly, bypassing the claim
entirely — `loopSerialization.ts` alone cannot catch this (it has no Factory
access), so this check closes that adjacent gap at the one extra cost of one
`find()` per completed slot per reconciliation pass, reusing a `listRuns`
call reconciliation already needed.

### 5. Historical/superseded Run adoption defenses

Directly tested (`tests/remediationRound2Repro.test.ts`): a claim cannot
reference a prior iteration's canonical identity (I), a foreign loop's
identity (J), or a duplicate of another claim's identity (G/H) — all three
rejected by the same canonical-match check, never by role/latest/title/
timestamp inference (PART 5's explicit prohibition — unchanged from round 1,
now additionally impossible to route around via a forged claim). Superseded-
attempt Run adoption (K) remains covered by round 1's `dangerousStale`
detection in `reconcile()`, now operating on canonically-guaranteed tags
rather than trusted-as-given ones; PART 9's specific attempt-bump regression
is a direct test confirming attempt 2's tag can never equal attempt 1's.

### 6. Pre-fix reproduction results

Both fixes were **temporarily disabled in place** — the predicate-check call
site in `sqliteLoopRepository.ts` and the three `validateCanonicalClaim`
call sites in `loopSerialization.ts` were commented out (with a `void`
no-op to keep the build green) — and the full round-2 suite was run against
that pre-fix state:

```
# tests 18
# pass 8
# fail 10
```

The 8 passes are the 7 standalone unit tests of the predicate *parser*
function itself (unaffected by disabling its *call site* — they test the
function directly) plus one unrelated schema-round-trip sanity check. Every
test that actually exercises a disabled protection failed: both index-wiring
tests, the semantic-harm demonstration (proving via raw SQL that the
malformed predicate really does let SQLite accept two "active" rows for one
work item), all six correlation-identity tests, and the full end-to-end PART
7 reproduction (which copies a real, observed `declaredWorkerId` from a
genuinely-completed loop's implementer run onto a forged claim on an
unrelated work item and confirms — pre-fix — that it is *not* rejected).

One correction made mid-verification: two correlation tests (`I`, `G/H`)
initially "passed" pre-fix for the wrong reason — an unrelated round-1
`totalRunCount`-coherence rule incidentally caught the malformed fixture
(a missing `totalRunCount: 1` to match iteration 1's one completed run)
before the disabled identity check ever ran. Both fixtures were corrected to
isolate the property actually under test, and the pre-fix run was repeated
to confirm they then failed for the intended reason before being counted as
valid regressions — exactly the kind of check Phase-0 discipline exists to
catch.

Both fixes were then restored exactly (confirmed via `grep` for the "TEMP
PRE-FIX PROBE" markers finding nothing, and by `npm run typecheck` passing
clean) and the same suite re-run: **18/18 pass.**

### 7. New permanent regression tests

`tests/remediationRound2Repro.test.ts` (18 tests):
- **HIGH 1** (11): the 7 pure-parser cases from PART 1 (exact-match,
  formatting-variant, missing-WHERE, inverted, phase-omitted, terminal-
  phase-included, unrelated-clause) plus 4 end-to-end SQLite-repository
  tests (PART 12 INDEX A–D: wrong predicate refused, inverted-set refused,
  canonical schema round-trips, and the direct raw-SQL semantic-harm
  demonstration).
- **HIGH 2** (7): E (arbitrary tag), F (mismatched actionId), I (prior-
  iteration adoption), J (cross-loop adoption), G/H (duplicate identity),
  PART 9 (attempt-bump non-collision), and the full PART 7 end-to-end
  authoritative-PASS-defense reproduction (asserts zero new runs, zero new
  Reviews, WorkItem status untouched, and `PersistenceCorruptionError` on
  `resume()`).

All prior suites (round 1's `remediationRound1Repro.test.ts`,
`loopReconciliationMatrix.test.ts`, and the full `engineeringLoopService`/
`sqliteLoopRepository`/`inMemoryLoopRepository` suites) were re-run
unmodified in intent (two test fixtures needed only mechanical updates —
canonical actionId/correlationTag values instead of the old opaque-token
shape) and remain green, satisfying PART 8 and PART 13's "do not regress"
requirements directly.

### 8. Exact full verification results

From a clean build (`rm -rf dist .factory-data`):

- `npm run typecheck` — PASS
- `npm run build` — PASS
- `npm test` — **476 tests, 476 pass, 0 fail** (up from 458; +18 from this
  round), stable across 3 consecutive full runs
- `npm run demo` — DONE, 15 refusals, unchanged
- `npm run demo:persistent` twice (seed, then a second OS process reading
  back) — unchanged
- `npm run worker:doctor` — claude 2.1.235 and codex-cli 0.147.0 still found
- `npm run demo:loop` — all three scenarios unchanged (WAITING_FOR_HUMAN /
  WAITING_FOR_HUMAN after one remediation / EXHAUSTED + WorkItem BLOCKED)
- `git diff --check` — clean; `git status --short` matches §9
- Focused re-runs all green: `remediationRound2Repro` (18),
  `remediationRound1Repro` (16), `loopReconciliationMatrix` (10),
  `sqliteLoopRepository` (9), `engineeringLoopService` (21)

No real Claude/Codex model was invoked — every change this round is
persistence-layer validation and identity derivation; no worker invocation
path changed.

### 9. Files changed

Modified: `src/orchestration/loopTypes.ts` (canonical `canonicalActionId`;
`correlationTag`/`correlationPrefix` signatures simplified to drop the
redundant `loopId` parameter); `src/orchestration/loopSerialization.ts`
(`validateCanonicalClaim`, threaded `loopId` through `parseIteration`);
`src/orchestration/engineeringLoopService.ts` (`claimIfNeeded` uses
`canonicalActionId`; `reconcile()` adds the completed-slot consistency
check, fetches `listRuns` once and reuses it); `src/adapters/orchestration/
sqliteLoopRepository.ts` (`validateActiveIndexPredicateSql` + wiring);
`tests/sqliteLoopRepository.test.ts` (fixture updated to canonical claim
shape). Created: `tests/remediationRound2Repro.test.ts`;
`docs/tasks/TASK-004-autonomous-engineering-loop.md` ("Remediation Round 2"
section, S1–S6); `AI-HANDOFF.md` (this section).

Not touched: `src/domain/`, `src/workflow/`, `FactoryService` write paths,
both factory.db persistence adapters, `src/adapters/workers/*` (Claude/Codex
adapters, prompt templates, environment policy, workspace resolution — all
unchanged from round 1), `src/ports/`, any TASK-001/002/003 test,
`docs/FACTORY_CONSTITUTION.md`, and every round-1 behavior not directly
covered by S1–S4 above (cancellation linearization, budgets/exhaustion,
verification cwd containment, transcript-only reviewer authority — all
re-confirmed green, none modified).

### 10. Remaining limitations

- Everything listed in round 1's "Remaining limitations" (AI-HANDOFF.md,
  Implementer remediation round 1, §13) still applies unchanged — this round
  did not touch cancellation linearization, mid-call worker abort, or the
  `RECOVERY_REQUIRED` operator-workflow gap.
- The completed-slot consistency check (§4 above) adds one Factory
  `listRuns` read's worth of `find()` calls to every reconciliation pass;
  not a correctness concern, noted for completeness.
- Canonical action identity is now string-derived and human-legible
  (`sf-loop:loop-x:i2:REVIEW:a1`), which is a minor, deliberate departure
  from "opaque random token" — nothing about it is secret or trust-bearing,
  so this is not a new exposure, but it does mean loop ids are now visible
  inside Factory `Run.declaredWorkerId` values wherever those are displayed
  (already true before this round, since `declaredWorkerId` always echoed
  the loop's chosen worker id).

### 11. Ready for independent re-review: YES

### Final focused independent re-review after remediation round 2 — 2026-08-21

**Verdict: PASS**

The two remaining HIGH findings are closed by the current implementation and
permanent regression coverage:

1. `sqliteLoopRepository` reads the active index's actual `sqlite_master.sql`
   and accepts only the narrow `phase IN (<required active phases>)` form. A
   same-name/unique/partial/right-column index with a wrong predicate is
   rejected with `SCHEMA_INTEGRITY_VIOLATION` before use, without schema repair.
   The supported set policy tolerates order/spacing/casing and intentionally
   treats duplicate literals as semantically equivalent only when the covered
   active-phase set is unchanged; unrelated logic, comments, wrappers,
   inverted operators, missing/extra phases, and non-literals fail closed.
2. `canonicalActionId(loopId, iteration, kind)` and
   `correlationTag(actionId, attempt)` are the single derived identity path.
   Loop deserialization recomputes and compares both values before a trusted
   `EngineeringLoop` reaches reconciliation. Cross-loop, cross-iteration,
   cross-kind, arbitrary-tag, prior-attempt, and completed-slot old-Run
   corruption probes fail closed; no historical Run, verifier, reviewer, or
   Review is adopted from those rows.

Round-1 recovery remains intact: exact terminal Run/Review matches are adopted
once, unknown RUNNING Runs become durable `RECOVERY_REQUIRED`, stale loop PASS
does not authorize the human gate, concurrent SQLite starts leave one active
loop/one implementer, and cancellation prevents later autonomous progression.
The narrow known live-owner duplicate-call race remains fail-closed or produces
an auditable duplicate Review with the same current Factory lineage; it cannot
change authoritative verdict/release state or progress after cancellation.

The additional unattended-execution acceptance invariant was verified and made
explicit in `docs/tasks/TASK-004-autonomous-engineering-loop.md` (§12a and
acceptance criteria): Claude/Codex use programmatic non-interactive modes,
stdin is closed, permissions are bounded by trusted workspace/sandbox/config
policy, and an interactive-looking child is bounded to `FAILED`/`TIMEOUT` with
safe evidence rather than waiting for keyboard input. No unrestricted bypass
or autonomous Git release action exists.

Verification performed without real Claude/Codex model calls:

- `node --version` — v22.23.1
- `npm run typecheck` — PASS
- `npm run build` — PASS
- `npm test` — **476/476 PASS**
- focused Round-2, Round-1, reconciliation, schema, authority, reviewer,
  verifier, adapter, process, and CLI suites — **157/157 PASS**
- `npm run demo` — PASS
- `npm run demo:persistent` — PASS on seed and second-process readback
- `npm run worker:doctor` — Claude 2.1.235 and Codex 0.147.0 found
- `npm run demo:loop` — all three scenarios PASS
- `git diff --check` — PASS

**TASK-004 is safe for human acceptance and commit.**

## Implementer addendum — Unattended Execution Invariant test coverage

Worker: Claude Code (Sonnet 5), role IMPLEMENTATION ENGINEER. The final
reviewer verdict above already confirmed the unattended-execution invariant
on inspection (§12a, non-interactive Claude/Codex modes, closed stdin,
bounded timeouts). This addendum adds the permanent, automated regression
coverage the human owner separately requested before final sign-off, so the
invariant is enforced going forward rather than only true today. No
production code changed — this is test coverage only. No FACTORY_CONSTITUTION.md
change; TASK-005 not started; nothing committed or pushed.

New file: `tests/unattendedExecutionInvariant.test.ts` (15 tests, 5 groups):

- **A — structural (5 tests):** every `.ts` file under `src/orchestration/`,
  `src/cli/`, `src/adapters/workers/`, `src/adapters/process/`, and
  `src/adapters/orchestration/` is scanned for interactive-I/O primitives
  (`readline`, `inquirer`, `prompts`, `process.stdin`, `.question(`,
  `setRawMode`, `confirm("...")`) — none found, and this now fails loudly if
  one is ever introduced.
- **B — structural (4 tests):** `permissionModeForRole`/`sandboxForRole` and
  the actual argv `buildClaudeInvocation`/`buildCodexInvocation` produce are
  directly asserted, for every `FactoryRole`, to never select an interactive
  permission mode or emit an approval-prompt flag.
- **C — dynamic (3 tests):** the three loop scenarios the brief specifically
  named (clean PASS; reviewer `CHANGES_REQUIRED` → remediation → PASS;
  deterministic-verification failure → remediation → PASS — the latter
  driven by a real fixture command that fails once then passes, to force a
  genuine verification-triggered remediation distinct from the reviewer-
  triggered one) each run to `WAITING_FOR_HUMAN` while a counting spy on
  `process.stdin.on`/`.once`/`.resume` proves zero listener registrations.
- **D — dynamic (1 test):** the real Claude adapter, pointed at the existing
  TASK-003 fixture `never-exits.mjs` (ignores SIGTERM, never exits — the
  fixture already used to prove SIGKILL escalation works), simulating a
  child stuck on an unanswerable interactive prompt. With a short worker
  timeout, the loop resolves in well under a second: the run is recorded
  `FAILED` via the existing timeout/SIGKILL mechanism, budget policy takes
  over normally, and the loop reaches `EXHAUSTED` with the WorkItem left
  `BLOCKED` for a human — never a hang, never a prompt, never a silent PASS.
- **E — governance gates remain (2 tests):** re-affirms, as direct
  assertions rather than incidental coverage, that `cancel()` still requires
  an explicit actor call and stops an otherwise-healthy loop, and that a
  durably `RUNNING` run with no provable outcome still resolves to
  `RECOVERY_REQUIRED`, not silent success — proving the invariant narrows
  only *routine* steps, not these two explicit human-actionable gates.

All 15 passed on first run (the underlying mechanisms — closed stdin,
non-interactive CLI flags, bounded timeout/SIGKILL — already existed from
TASK-003 and were exercised piecemeal by earlier suites; this file is what
makes the invariant itself, not just its ingredients, a named, permanent,
directly-tested property). No real Claude/Codex model was invoked.

### Exact verification results

- `npm run typecheck` — PASS
- `npm run build` — PASS
- `npm test` — **491 tests, 491 pass, 0 fail** (up from 476; +15), stable
  across 3 consecutive full runs
- `npm run demo:loop` — all three scenarios unchanged
- `git diff --check` — clean; `git status --short` matches the files below

### Files changed

Created: `tests/unattendedExecutionInvariant.test.ts`. Modified: this file
(AI-HANDOFF.md, this addendum). No other file touched — `docs/tasks/TASK-004-autonomous-engineering-loop.md`'s
§12a and acceptance criterion 21 were already in place from the prior pass
this addendum verifies.

### Ready for independent final re-review: YES

## TASK-004 FINAL INDEPENDENT REVIEW — Codex CLI (GPT-5.6 Luna, effort Extra High), 2026-08-21

Run non-interactively in the native WSL Linux checkout via
`codex exec -m gpt-5.6-luna -c model_reasoning_effort=xhigh -s workspace-write`.
The reviewer independently re-verified the repository (not prior reports),
reran the deterministic suite/demos, and confirmed all eight prior HIGH
findings (rounds 1 & 2) remain closed. It returned:

**Verdict: CHANGES_REQUIRED** — two reproducible HIGH findings. No repository
files were changed by the review (git clean before/after, HEAD `126157d`).

1. **HIGH — Untrusted cancellation.** `EngineeringLoopService.cancel(loopId,
   actor)` accepted any `Actor` and durably cancelled a healthy loop; the CLI
   passed a tokenless actor. Reproduced live with an `AGENT` actor. Bypassed
   the trusted-human boundary enforced for WorkItem cancellation/approvals.
2. **HIGH — Cached WAITING_FOR_HUMAN authority.** `drive()` returned a terminal
   WAITING_FOR_HUMAN loop, and `stepReviewing()` accepted a cached PASS at an
   already-WAITING WorkItem, without re-deriving Factory authority. A
   valid-serialization SQLite loop with a nonexistent review id resumed to
   WAITING_FOR_HUMAN with zero authoritative reads.

The review's "16 failed / demo:loop failed" test numbers were an artifact of
Codex's own `workspace-write` sandbox blocking nested `git` subprocess spawns
(`spawnSync git EPERM`), NOT a repository regression — the direct native-WSL
run outside that sandbox was 491/491.

## Implementer remediation round 3

Worker: Claude Code, role IMPLEMENTATION ENGINEER.
Execution record (model traceability):
- Requested model: Fable 5.
- Actual model used: Opus 4.8. Claude Code's UI reported that Fable 5's
  safeguards flagged the Round-3 remediation prompt and it automatically
  switched execution to Opus 4.8 (an automatic safeguard/model fallback, not an
  operator choice). All of Round 3 was therefore implemented by Opus 4.8.
- Test/verification results are unaffected by the fallback and remain exactly as
  reported below (510/510, 3× consecutive; demos PASS).

### 1. HIGH 1 root cause
`EngineeringLoopService.cancel` checked only phase terminality, never actor
identity; `Actor` is untrusted caller data (`src/domain/humanIdentity.ts`), and
`src/cli/loop.ts` supplied a bare `human(…)`. Cancellation (a C1 governance
operation) therefore bypassed the trusted-human boundary that already guards
WorkItem cancellation (`WorkflowService.verifyHumanAuthorization`) and every
approval (`FactoryService.recordApproval`).

### 2. Trusted-human cancellation design
Reused the accepted TASK-001 mechanism — no second/weaker identity system. New
read-only `FactoryService.verifyHumanAuthorization(actor, authorization)`
composes the existing `HumanIdentityGate.verify`. `cancel(loopId, actor,
authorization?)` calls it first, before any read/write, throwing
`HumanIdentityError` on failure (non-HUMAN actor, missing/forged/expired/
mismatched token). The loop never sees the credential or the gate. The CLI's
`sf loop cancel` mints a `TrustedHumanToken` (`factory.authorizeHuman`) and
presents it — the operator's explicit governance action.

### 3. HIGH 1 pre-fix reproduction / post-fix
Pre-fix (built at `126157d`): `AGENT` actor `cancel()` ACCEPTED → durable
`CANCELLED`, `cancelRequested=true`. Post-fix: AGENT, SYSTEM, tokenless-HUMAN,
forged token, another human's token, and expired token are each refused with
`HUMAN_IDENTITY`; a valid authorized human still cancels; the loop otherwise
proceeds to WAITING_FOR_HUMAN. A refused cancel leaves phase + version + intent
unchanged.

### 4. HIGH 2 root cause
Persisted `phase = WAITING_FOR_HUMAN` and cached `reviewVerdict = PASS` were
trusted as authority: `drive()`'s terminal early-return and `stepReviewing()`'s
already-WAITING branch exposed/accepted WAITING_FOR_HUMAN without re-consulting
the Factory.

### 5. Factory-authority revalidation design
The Factory Core stays authoritative. New read-only
`FactoryService.resolveWaitingForHumanAuthority(workItemId)` composes the
existing accepted `resolveSemanticReview` (current implementation at the
current spec revision → current passing deterministic verification with
evidence → independent passing semantic review of that exact implementation,
newest attempt/review authoritative). `reconcileTerminal` (both `drive()`
terminal returns) and `stepReviewing`'s already-WAITING branch call it before
exposing/accepting WAITING_FOR_HUMAN; `ok:false` demotes via
`failClosedToRecovery` (the one write allowed to move a terminal
WAITING_FOR_HUMAN loop) to **RECOVERY_REQUIRED** — structurally-valid but
unprovable-authority is a recovery condition, not `PersistenceCorruptionError`.
Zero new worker/model work on the fail-closed path. The fresh
`REVIEW -> WAITING_FOR_HUMAN` advance is unchanged (advance already re-derives
via the same resolver). Legitimate crash recovery (case E; valid persisted
WAITING_FOR_HUMAN resume) is preserved with no duplicate model call.

### 6. HIGH 2 pre-fix reproduction / post-fix
Pre-fix: a fabricated valid-serialization WAITING_FOR_HUMAN loop for an absent
work item RETURNED WAITING_FOR_HUMAN with zero authoritative reads / zero
workers. Post-fix: same row resumes to RECOVERY_REQUIRED (still zero workers).

### 7. New permanent regression tests
`tests/remediationRound3Repro.test.ts` — 19 tests (11 HIGH 1 + 8 HIGH 2),
including CLI-path authorization and stale-REVIEWING reconcile-with-zero-extra-
reviewer-calls. Each fail-closed case asserts zero worker/model construction.
Existing cancellation call sites (CLI + 3 tests) updated for the new signature;
their behavioral assertions are unchanged.

### 8. Exact native-WSL full verification results (outside Codex sandbox)
`node v22.22.3`, `npm 10.9.8`. typecheck PASS · build PASS. `npm test`
**510/510 pass, run 3× consecutively** (491 prior baseline + 19 new). demo PASS
· demo:persistent PASS · worker:doctor PASS (claude 2.1.238, codex 0.149.0) ·
demo:loop PASS (WAITING_FOR_HUMAN / WAITING_FOR_HUMAN / EXHAUSTED). `git diff
--check` clean.

### 9. All eight prior HIGH findings + unattended invariant
Re-confirmed closed by the full suite (remediationRound1Repro,
remediationRound2Repro, unattendedExecutionInvariant, loopReconciliationMatrix,
reviewVerdictParser all green). The trusted-human requirement applies only to
the explicit `cancel()` governance operation; no approval prompt was introduced
into implement → verify → review → remediate → re-review.

### 10. Deferred non-blocking notes (NOT fixed, by instruction)
(1) `LoopBudget.workerTimeoutMs` not threaded through; (2) verification
evidence redacts output but not the executable/argv label; (3) general worker
workspace launch path has weaker realpath timing than the verification worker.

### 11. Files changed
`src/app/factoryService.ts`, `src/orchestration/engineeringLoopService.ts`,
`src/cli/loop.ts`, `tests/engineeringLoopService.test.ts`,
`tests/unattendedExecutionInvariant.test.ts`,
`tests/remediationRound1Repro.test.ts`, and new
`tests/remediationRound3Repro.test.ts`, plus docs
(`docs/tasks/TASK-004-autonomous-engineering-loop.md`, this file).

### 12. Ready for independent re-review: YES

## TASK-004 INDEPENDENT RE-REVIEW (round 2) — Codex CLI (GPT-5.6 Luna, effort Extra High), 2026-08-22

Run non-interactively in the native WSL Linux checkout via
`codex exec -m gpt-5.6-luna -c model_reasoning_effort=xhigh -s workspace-write`.
No tracked files were changed by the review (git status identical before/after,
HEAD `126157d`).

**Verdict: CHANGES_REQUIRED** — round-3's two blockers were independently
verified **CLOSED**, and all eight earlier HIGH findings (rounds 1 & 2) remain
closed, but two NEW reproducible HIGH findings were reported:

1. **HIGH — `EngineeringLoopService.status()` exposes persisted
   `WAITING_FOR_HUMAN` without authority re-derivation.** Round 3 fixed
   `drive()`/`resume()`/`stepReviewing()` but not the read path; a strict
   SQLite-parseable fabricated row returned `WAITING_FOR_HUMAN` with
   `resolverCalls: 0` (CLI path `src/cli/loop.ts` inherits it).
2. **HIGH — `resolveSemanticReview()`/`resolveVerification()` accept reviews
   with the wrong `specRevision`** because the filters omit a revision check. A
   probe appending deterministic + semantic reviews at `specRevision: 999`
   yielded `{"ok":true,"deterministic":"rev-wrong-det","semantic":"rev-wrong-sem"}`.

The review's `npm test` numbers (24 passed / 17 failed) were again the
`spawnSync git EPERM` artifact of Codex's own `workspace-write` sandbox blocking
nested subprocess spawns, explicitly attributed as such by the reviewer — NOT a
repository regression. The authoritative native-WSL run outside that sandbox was
510/510 at the time.

## Implementer remediation round 4

Worker: Claude Code, role IMPLEMENTATION ENGINEER.
Execution record (model traceability):
- TOOL: Claude Code · MODEL: Opus 5 · EFFORT: Extra High.
- Prior rounds' implementation-model history is unchanged (round 3 was Opus 4.8
  after an automatic safeguard fallback from the requested Fable 5; rounds 1–2
  and the TASK-004 build were Sonnet 5 / Fable 5 as already recorded above).

### 1. HIGH 1 root cause
`status()` was literally `return this.requireLoop(loopId)`. `WAITING_FOR_HUMAN`
is an authority RESULT, not a display state, so any read client (CLI, UI,
Telegram, Control Room, future orchestration client) could treat a stale or
corrupted checkpoint as a live human/release gate. Round 3 had hardened only the
drive paths.

### 2. status() authority design
`status()` stays READ-ONLY (its established contract). When the persisted phase
is `WAITING_FOR_HUMAN` it calls the SAME round-3 resolver
(`FactoryService.resolveWaitingForHumanAuthority`) — no second, weaker copy of
the lineage rules. Provable → the loop is returned unchanged. Not provable →
it returns a **non-persisted** `RECOVERY_REQUIRED` projection (phase + outcome +
`failureReason`), touching nothing durable: no loop version bump, no WorkItem
change, no Run/Review/Evidence, no budget consumption, no worker construction.
`resume()`/`drive()` remain the operations that durably demote (via
`failClosedToRecovery`) — reading must never be what changes state. The public
surface was audited: `start`/`resume`/`status`/`cancel` are the only external
entry points and `toStatusView` is a pure projection over them, so the CLI and
any future client are covered.

### 3. HIGH 1 pre-fix reproduction / post-fix
Pre-fix: `status()` on a fabricated valid-serialization loop for a nonexistent
work item returned `phase=WAITING_FOR_HUMAN outcome=WAITING_FOR_HUMAN`
(`toStatusView` likewise). Post-fix: `RECOVERY_REQUIRED`, while the durable row
is left untouched at `WAITING_FOR_HUMAN`; a later `resume()` durably demotes it.

### 4. HIGH 2 root cause
`resolveVerification()`/`resolveSemanticReview()` filtered reviews by `kind` and
`reviewedRunId` only. Runs were revision-checked; the Review record's OWN
`specRevision` (stamped by `recordReview`) was not — so an off-revision Review
could be selected as authoritative, both to authorize and, worse, to MASK a
current-revision blocking review.

### 5. Review.specRevision authority design
Smallest central fix: the review's own revision is now part of *applicability*
in the lowest shared resolver (`src/workflow/releaseSnapshotResolver.ts`), i.e.
`review.specRevision === item.specRevision` in both filters. Filtering (rather
than inspecting-then-rejecting the latest record) makes an off-revision review
invisible — unable to authorize and unable to mask — exactly like the older
criterion-verification generations already are in `resolveReleaseSnapshot`. Every
consumer inherits it: `requireSuccessfulVerification`,
`requireIndependentSemanticReview`, `resolveReleaseSnapshot`, and the round-3
`resolveWaitingForHumanAuthority`. No isolated revision check was added inside
`EngineeringLoopService`. Newest-generation semantics preserved. One coherent
revision is now required across WorkItem, IMPLEMENTER run, VERIFIER run,
DETERMINISTIC review, REVIEWER run, SEMANTIC review.

### 6. HIGH 2 pre-fix reproduction / post-fix
Pre-fix form 1: resolver returned
`{"ok":true,"deterministic":"rev-wrong-det","deterministicRev":999,"semantic":"rev-wrong-sem","semanticRev":999}`.
Pre-fix form 2 (harmful shape): a current-revision `CHANGES_REQUESTED` masked by
a later off-revision PASS returned `ok:true`. Post-fix: form 1 selects the
genuine current-revision records (revision 1); form 2 returns
`ok:false — the authoritative semantic review rev-current-fail is CHANGES_REQUESTED`.

### 7. Phase 0 — new tests proven non-vacuous
Both fixes were temporarily reverted in place (byte-exact backups; restore
verified with `cmp`) and the new suite run against that pre-fix state:
**17 of 20 failed**. The 3 that passed are deliberate positive controls that
must pass in both states. Fixes restored, re-run: **20/20**.

### 8. Tests added
`tests/remediationRound4Repro.test.ts` — 20 tests (9 HIGH 1 + 11 HIGH 2),
covering every case in the remediation brief including status() read-only
proof (no loop/WorkItem version change, no Run/Review/Evidence created, no
budget consumed, zero workers constructed), the CLI `sf loop status` path, the
release-snapshot path, and SQLite restart durability.

### 9. Exact native-WSL full verification (outside Codex's sandbox)
`node v22.22.3` (`/home/hakanduyar/.nvm/...`), `npm 10.9.8`. typecheck PASS ·
build PASS · `npm test` **530/530 pass, run 3× consecutively** (510 prior
baseline + 20 new) · focused suites 185/185 · Factory authority / release
snapshot / workflow suites 68/68 · demo PASS · demo:persistent PASS ·
worker:doctor PASS (claude 2.1.238, codex 0.149.0) · demo:loop PASS
(WAITING_FOR_HUMAN / WAITING_FOR_HUMAN / EXHAUSTED) · `git diff --check` clean.

### 10. All prior HIGH findings + unattended execution
All ten previously-fixed HIGH findings (round 1 ×6, round 2 ×2, round 3 ×2)
re-verified green by the full suite. The unattended-execution invariant is
unchanged: `status()`'s authority check is read-path current-state validation,
not a user approval gate, and adds no prompt to
implement → verify → review → remediate → re-review.

### 11. Deferred non-blocking notes (still NOT fixed, by instruction)
(1) `LoopBudget.workerTimeoutMs` not threaded through; (2) verification evidence
redacts output but not the executable/argv label; (3) general worker workspace
launch path has weaker realpath timing than the verification worker.

### 12. Files changed (round 4)
`src/workflow/releaseSnapshotResolver.ts` (both review filters + lineage doc),
`src/orchestration/engineeringLoopService.ts` (`status()`), new
`tests/remediationRound4Repro.test.ts`, plus docs
(`docs/tasks/TASK-004-autonomous-engineering-loop.md`, this file). Round-3
changes remain in the same uncommitted working tree.

### 13. Ready for independent re-review: YES

## TASK-004 FINAL INDEPENDENT ACCEPTANCE REVIEW — Codex CLI (GPT-5.6 Luna, Extra High), 2026-08-22

Run non-interactively in the native WSL Linux checkout. **Sandbox note:** the two
previous reviews' `spawnSync git EPERM` failures were diagnosed as a Codex
sandbox artifact — system `bubblewrap` is absent, so Codex fell back to its
bundled copy, under which `spawnSync` reports a spurious `error.code = EPERM`
even when the child succeeds (probe: `{"status":0,"err":"EPERM","out":"git
version 2.43.0"}`). Measured per policy against the real fixtures: native WSL
10/10, `workspace-write` 0/10, `danger-full-access` 10/10. The review therefore
ran with `-s danger-full-access` (least-permissive supported mode that works;
installing bubblewrap needs a sudo password). Result: **zero sandbox artifacts**
and the implementer's baseline independently confirmed at 530/530.

**Verdict: CHANGES_REQUIRED.** Both round-4 fixes independently VERIFIED CLOSED
(`status()` authority; `Review.specRevision` central filtering), all ten earlier
HIGH findings still closed, TASK-001/002/003 intact, unattended execution
15/15 — but the systematic authority-surface audit found two NEW HIGH bypasses:

1. **HIGH — `cancel()` exposes cached `WAITING_FOR_HUMAN`.** Its terminal early
   return precedes any authority revalidation. Probe:
   `statusPhase=RECOVERY_REQUIRED` but authorized `cancelPhase=WAITING_FOR_HUMAN`.
   CLI reproduces via `cli/loop.ts`.
2. **HIGH — semantic Reviews do not validate their reviewer Run.**
   `resolveSemanticReview` checks only copied principal strings; it never
   verifies `reviewerRunId` exists, is current, successful, REVIEWER-role or
   target-aligned. Probe (surviving SQLite close/reopen): `authorityOk=true`,
   `reviewerRun="run-wrong-revision"`, `snapshotQualified=true`.

Reviewer changed no repository files (verified by sha256 fingerprint of
`git status --porcelain` + `git diff` before/after: `REPO_UNCHANGED_BY_REVIEW=YES`).

## Implementer remediation round 5

Worker: Claude Code, role IMPLEMENTATION ENGINEER.
Execution record — TOOL: Claude Code · MODEL: Opus 5 · EFFORT: Extra High.
(Prior rounds' model history is unchanged: round 4 Opus 5; round 3 Opus 4.8
after an automatic safeguard fallback from the requested Fable 5; rounds 1–2 and
the original build as already recorded above.)

### 1. HIGH 1 root cause
Round 3 made cancellation require trusted-human authorization and round 4 made
`status()` re-derive authority, but `cancel()`'s terminal early return still
returned the persisted row. **Authentication and authority are separate
invariants**: proving *who* may cancel says nothing about whether a cached
terminal WAITING_FOR_HUMAN is still authoritative.

### 2. cancel() authority design
Extracted the WAITING revalidation from `reconcileTerminal` into
`reconcileWaitingAuthority` — now THE single durable answer, shared by
`drive()`/`resume()` and by BOTH of `cancel()`'s terminal returns (initial read
and the concurrent-terminality case). `status()` asks the same Factory resolver
but keeps its read-only projection. Only WAITING_FOR_HUMAN is revalidated; the
other terminal phases claim no authority and keep their no-op semantics. As a
mutating governance command, `cancel()`'s fail-closed path demotes durably via
`failClosedToRecovery`, launching zero workers and creating no replacement
Run/Review/Evidence. Trusted-human authentication still runs FIRST, unchanged.

### 3. HIGH 1 pre-fix / post-fix
Pre-fix: `status() => RECOVERY_REQUIRED` while authorized
`cancel() => WAITING_FOR_HUMAN` (durable row unchanged). Post-fix:
`cancel() => RECOVERY_REQUIRED` with the demotion recorded durably.

### 4. HIGH 2 root cause
`resolveSemanticReview` never dereferenced `reviewerRunId`; C4 was judged from
strings copied onto the Review row. `recordReview` validates the backing run at
creation, but a resolver reading durable state must re-prove it — persistence
can be corrupted or written directly.

### 5. Reviewer-Run authority design
`resolveSemanticReview` now resolves the authoritative REVIEWER *attempt* from
the runs themselves (role, current specRevision, targeting the current
implementation, newest attempt authoritative, must be SUCCEEDED), derives C4
independence from those Run records, and **pins** the review to that run
(`review.reviewerRunId === reviewerRun.id`). Copied principal fields are demoted
to audit data that must agree with the runs they describe. Fixed in the lowest
shared resolver, so `requireIndependentSemanticReview`,
`resolveWaitingForHumanAuthority`, `resolveReleaseSnapshot`, the
REVIEW -> WAITING_FOR_HUMAN transition, `status()` authority and crash
reconciliation all inherit it. No isolated check inside EngineeringLoopService.

### 6. Deterministic sibling audit — ALREADY SAFE, no change required
`resolveVerification` already resolves the verifier run independently
(role/revision/target/SUCCEEDED/evidence) and pins the deterministic review to
it, so a corrupt deterministic review must name the genuine current verifier
attempt to count; its copied principal fields are never consulted for an
authority decision. No analogous bypass exists, so nothing was changed there.
The semantic path simply lacked this pinning and now has the same shape.

### 7. HIGH 2 pre-fix / post-fix
Pre-fix: `{"ok":true,"semantic":"rev-corrupt-sem","reviewerRun":"run-does-not-exist"}`,
`releaseSnapshot qualified => true`; SQLite close/reopen: `authorityOk=true`,
`reviewerRun="run-wrong-revision"`, `snapshotQualified=true`. Post-fix: rejected
in every case (`… was produced by run-does-not-exist, not the current reviewer
attempt run-0003`), snapshot not qualified, restart case rejected.

### 8. Phase 0 — new tests proven non-vacuous
Both fixes temporarily reverted in place (byte-exact backups; restore verified
with `cmp`); the new suite then failed **14 of 18**. The 4 passing are positive
controls that must pass in both states. Restored, re-run: **18/18**.

### 9. Tests added / fixtures modernized
`tests/remediationRound5Repro.test.ts` — 18 tests (7 HIGH 1 + 11 HIGH 2)
covering every case in the brief, including CLI cancel, zero-worker/zero-record
proof, canonical recovery, SQLite restart, masking attempts, and the valid
lineage still authorizing. `tests/preconditions.test.ts` fixtures were
**modernized, not weakened**: they built a SEMANTIC review whose `reviewerRunId`
named a run absent from the fixture — passing only because the old resolver
never dereferenced it (the defect itself). They now carry the real REVIEWER run
as production requires; all assertions unchanged, the C4 case models the
violation on the Run records, and a dangling-reviewer-run case was added.

### 10. Focused authority-surface audit (post-fix)
`start()`/`resume()` → `drive()`; `drive()`'s terminal returns →
`reconcileTerminal` → `reconcileWaitingAuthority`; `status()` → same resolver,
read-only; `cancel()` → both terminal returns → `reconcileWaitingAuthority`;
`stepReviewing()` → re-derives before accepting cached PASS; `toStatusView` is a
pure projection. No remaining path exposes WAITING_FOR_HUMAN without current
Factory authority, accepts caller-created human identity, trusts copied
principal strings over backing Run authority, or lets corrupted persisted
authority survive a restart.

### 11. Exact native-WSL verification (outside any nested sandbox)
`node v22.22.3`, `npm 10.9.8`. typecheck PASS · build PASS · `npm test`
**549/549 pass, run 3× consecutively** (530 prior baseline + 18 round-5 + 1 new
preconditions case) · focused suites 203/203 · Factory authority / release
snapshot / workflow / persistence / concurrency suites 101/101 · demo PASS ·
demo:persistent PASS · worker:doctor PASS · demo:loop PASS · `git diff --check`
clean.

### 12. All prior HIGH findings + unattended execution
All twelve previously-fixed HIGH findings (rounds 1–4) remain closed, and the
unattended-execution invariant is unchanged — authority revalidation is
internal deterministic validation on read/governance paths, never a human gate,
and adds no prompt to implement → verify → review → remediate → re-review.

### 13. Deferred non-blocking notes (still NOT fixed, by instruction)
(1) `LoopBudget.workerTimeoutMs` threading; (2) verification executable/argv
labels; (3) general worker workspace realpath timing.

### 14. Files changed (round 5)
`src/workflow/releaseSnapshotResolver.ts` (reviewer-run resolution + pinning +
principal cross-checks), `src/orchestration/engineeringLoopService.ts`
(`cancel()` terminal returns + `reconcileWaitingAuthority` extraction),
`tests/preconditions.test.ts` (fixture modernization + new case), new
`tests/remediationRound5Repro.test.ts`, plus docs.

### 15. Ready for independent re-review: YES

## Human decision
TASK-004 ACCEPTED. The final independent review (Codex CLI, GPT-5.6 Luna, Extra
High) returned `PASS_WITH_NON_BLOCKING_NOTES` — zero CRITICAL/HIGH blockers, all
14 historical HIGH findings closed, repository fingerprint unchanged by the
reviewer. Committed as `aec067e` on `feat/autonomous-engineering-loop` and
squash-merged to `main` as `1b32854` ("feat: add autonomous engineering loop").
The three deferred non-blocking notes were preserved, not fixed.

---

# TASK-005 — Durable Planner / Task Generator

**TOOL:** Claude Code · **MODEL:** Opus 5 · **EFFORT:** Extra High ·
**BRANCH:** `feat/planner-task-generator` (from `main` @ `1b32854`)
**STATUS:** implementation complete, awaiting independent review. Nothing
committed, pushed or merged.

## 1. What was built
The planning layer above WorkItems: natural-language intent → durable, validated
plan revision → trusted-human approval bound to exact content → idempotent,
crash-safe materialization into real Factory work items → dependency-ordered
dispatch into the accepted TASK-004 loop. Full design and the 16 acceptance
criteria: `docs/tasks/TASK-005-planner-task-generator.md`.

TASK-005 implements **no** second engineering loop. Implement/verify/review/
remediate stays entirely in TASK-004, reached through one narrow port
(`src/planning/loopDispatcher.ts`), so that boundary is structural rather than a
matter of discipline.

## 2. The load-bearing decisions
1. **A persisted phase is a checkpoint, never authority.** `phase = "APPROVED"`
   in `plans.db` does not mean a human approved anything — it means the last
   writer believed so. Every operation that creates, readies or dispatches work
   re-derives the approval from the Factory's own append-only records through
   the accepted central gate. This is the TASK-004 round 3–5 lesson applied from
   the start rather than after fourteen HIGH findings.
2. **The approval binds to content, not a counter.** `(planId, revision,
   contentDigest)` — the same reasoning that made `RELEASE_APPROVAL` bind a
   snapshot id. `planSerialization` recomputes every revision's digest on read,
   so edited approved content cannot load at all.
3. **One human approval, materialized — never manufactured.**
   `FactoryService.recordDerivedPlanApproval` re-reads the source approval BY ID
   and requires a real, `APPROVED`, human-decided `PLAN_APPROVAL` whose stamped
   revision and digest match the live plan. No combination of arguments produces
   an approval a human did not make; each derived approval records
   `derivedFromApprovalId`.
4. **Asking is not planning.** A clarification-only planner response persists no
   revision, preserving the invariant that every persisted revision is
   approvable.
5. **Prerequisite satisfied = execution finished, not released.** A dependency
   is met when the item is `DONE`, or is at `WAITING_FOR_HUMAN` *and*
   `resolveWaitingForHumanAuthority` currently proves it. A status field alone
   satisfies nothing.

## 3. Changes to accepted TASK-001 code (small, additive, each mirroring an existing mechanism)
- `ApprovalContext` gains optional `planContentDigest`, `derivedFromApprovalId`,
  `planId`, `planRevision`; `GateBinding` gains `planContentDigest`, checked by
  `evaluateGate` exactly the way it already checks `snapshotId`.
- `FactoryService`: a `PLAN`-subject branch in `recordApproval` that stamps the
  binding from live state via an injected `PlanBindingResolver` port (with no
  resolver configured, a PLAN approval is refused rather than recorded unbound);
  plus `recordDerivedPlanApproval` and read-only `getProject`,
  `listWorkItemsByProject`, `listApprovals`.
- `tests/unattendedExecutionInvariant.test.ts`: SCAN_ROOTS **extended** with
  `src/planning` and `src/adapters/planning` — a strengthening, not a weakening.

No existing test was weakened and no accepted behaviour was changed.

## 4. Self-audit findings, found and fixed during implementation
Each has a permanent regression test in `tests/planHardening.test.ts`:
1. `start()` claimed to fail fast on an unknown project but inferred existence
   from an empty work-item list — which is also exactly what a real, empty
   project looks like. A typo'd project id would have created a plan row and
   charged a real model invocation. Now uses `getProject`.
2. Persisted clarification answers had no lineage validation at all, while every
   other reference in the same file is rigorously checked. Modelling it properly
   surfaced that question ids are only unique *within a round*, so
   `(questionId, askedAtCycle)` is the real key — id-only uniqueness would have
   rejected a perfectly valid multi-round history.
3. `dispatches` enforced uniqueness on `planItemKey` but not on `loopId`.
4. The duplicate-id vs duplicate-request-key diagnosis depended on SQLite's
   internal index-check order when an insert violated both; now determined by
   reading, not by parsing an error message.
5. `status()` re-derived authority for `APPROVED`/`MATERIALIZING`/`EXECUTING`
   but not for `WAITING_FOR_HUMAN` — the exact class of the TASK-004 round-4
   finding. `BLOCKED` is deliberately excluded, since planner-budget exhaustion
   blocks a plan long before any approval exists.
6. `planningService` built a planner prompt it never used; prompt rendering
   belongs to the adapter, so `previousRejection` moved into `PlannerRequest`.

## 5. Verification (native WSL, `node v22.22.3`, `npm 10.9.8`)
typecheck PASS · build PASS · `npm test` **822/822, run 3× consecutively**
(549 accepted baseline + 273 new) · `demo` PASS · `demo:persistent` PASS ·
`worker:doctor` PASS · `demo:loop` PASS · `demo:plan` PASS ·
`git diff --check` clean. No real AI CLI is invoked by any test or demo.

## 6. Known limitations / deferred
Sequential (not parallel) dispatch; a rejected plan is terminal; the real CLI
planner has no automated end-to-end test because it would launch a real model
and `sf plan start` intentionally has no injection seam; no `sf plan recover`
workflow yet; the planner is assumed to be read-only in the workspace. The three
TASK-004 deferred non-blocking notes remain untouched.

## 7. Ready for independent TASK-005 review: YES

## Human decision
Pending.

# TASK-005 INDEPENDENT ACCEPTANCE REVIEW — Codex CLI (GPT-5.6 Luna, Extra High), 2026-08-21

Reviewer: native `codex` 0.149.0, model `gpt-5.6-luna`, effort `xhigh`, sandbox
`danger-full-access` (empirically re-confirmed: `bwrap` absent, so
`workspace-write` reports spurious `EPERM` while the operation actually
succeeds). Repository fingerprint identical before and after the run
(`d523225008693e7577a667ec5def30d85346d1ee4e7668d343b2dff5e17d0e40`); no commit,
push, merge or TASK-006 work occurred.

**Verdict: `CHANGES_REQUIRED`. Safe to commit: NO.** The reviewer independently
reproduced the implementer's numbers — typecheck PASS, build PASS, `npm test`
825/825 three consecutive times, all five demos PASS — and then observed the
finding that matters: *"the green suite does not cover the adversarial cases
reproduced above."* Seven HIGH findings, all acceptance blockers:

1. **`recordDerivedPlanApproval` authorized arbitrary work items.** It validated
   the source approval and the target's STATUS, not plan membership, project,
   tag, title, type, criteria or dependencies. One plan's approval was derived
   onto unrelated same-project AND different-project work items; both reached
   `READY`.
2. **Stale approval replay.** The derived API never re-checked that the source
   approval was still the current live PLAN gate; after approval-then-rejection
   the gate was false but the old approval still derived authority. Repeated
   calls also appended duplicate derived approvals.
3. **Materialization adopted caller-created wrong content** on the canonical
   `planVersion` tag alone — different title, type, priority and criteria were
   adopted and readied.
4. **`projectId` and `execution` configuration sat outside the approval
   digest.** Switching project A→B preserved the approval and materialized into
   B; rewriting verification commands to `sh -c ...` preserved `EXECUTING`
   authority, and CLI restart uses the persisted configuration.
5. **Concurrent planner resumes launched duplicate external planner actions** —
   `PLANNING` was treated as generically recoverable, and a blocked-worker probe
   observed two planner calls in flight at once.
6. **The production CLI planner rejected its own valid output.** The adapter
   pooled transcript evidence with the run summary, which already embeds the
   first 200 characters of that transcript, so a valid answer carried two
   `FACTORY_PLAN_V1` markers and the strict parser refused it.
7. **Dangling work item mappings loaded as executable state** — `status()`
   reported `EXECUTING` while `resume()` threw `NotFoundError`.

Confirmed sound: normal PLAN approval recording, revision digest coverage and
read-time recomputation, the planner output parser, planner run lineage and
worker configuration, clarification lineage, trusted-human governance (zero
mutation on refusal), the dependency DAG including the `WAITING_FOR_HUMAN`
prerequisite rule, TASK-004 dispatch (no second loop), completion semantics,
planner budgets, unattended execution, CLI wiring, the prompt/security boundary,
and all TASK-001..004 regressions.

## Human decision
Remediate all seven HIGH findings (round 1). Do not fix the six non-blocking
notes unless a HIGH fix requires it.

# TASK-005 — Implementer remediation round 1

Every finding was reproduced against a byte-exact pre-fix copy of the working
tree BEFORE any fix was written: **10/10 reproductions of the broken behaviour
passed**. Re-run against the fixed tree, **0/10 pass** — every reproduction is
closed. The reproductions are now permanent, in
`tests/task005RemediationRound1Repro.test.ts`.

## 1. HIGH 1 — a plan approval may authorize only its own approved items
**Root cause.** `recordDerivedPlanApproval` accepted a bare `workItemId` plus a
caller-stated `expectedPlanRevision`/`expectedContentDigest`. Nothing connected
the target to the approval: a caller that named any work item at `PLAN_REVIEW`
got a real, human-attributed `PLAN_APPROVAL` for it.

**Remediation.** Membership became a question answered by durable plan state.
`PlanBindingResolver` gained `resolveMaterializationTarget(planId, workItemId)`,
which proves from the plan's own materialization mapping that the work item is
one of the approved revision's targets and returns the complete content that
target must have (`MaterializedItemShape`). `RecordDerivedPlanApprovalInput` now
carries only identifiers — the removed parameters were the vulnerability, since
a caller that states what an approval covers is a caller that can widen it.
FactoryService then proves four independent things, none caller-supplied:
membership, lineage (source approval re-read by id, bound to the resolved
revision and digest), currency (see HIGH 2), and content (project, tag, title,
type, priority, spec revision, dependencies and acceptance criteria compared
field for field, with a whole-shape fingerprint as the backstop).

**Pre/post.** Pre-fix, derivation onto an unrelated same-project item and onto a
project-B item both succeeded and both reached `READY`. Post-fix both are
refused, and the refusal is proven inert: no approval row, no status change, no
satisfied gate. Eleven adversarial cases cover unrelated/cross-project/other-plan
targets, substituted mappings, wrong title/type/priority/criteria, a spec revised
outside the plan, an unmapped squatter holding the canonical tag, and the
legitimate path still succeeding.

## 2. HIGH 2 — historical approval evidence is not current authority
**Root cause.** Two defects with one cause: the derived API read the source
approval by id and never asked the central gate whether that decision was still
current, and idempotence was a check-then-act read that concurrent callers all
lost.

**Remediation.** Derivation now re-evaluates the accepted central gate for the
PLAN subject against the resolved binding, so a later rejection, a superseding
revision or a durable cancellation revokes it while the record stays in the
audit trail. Idempotence became structural: `derivedPlanApprovalId()` derives the
approval's id from `(planId, revision, sourceApprovalId, workItemId,
specRevision)`, so a duplicate is refused by the append-only store itself — in
memory and in SQLite alike — rather than by a racing read. A lost race re-reads
the winner's record and returns it.

**Pre/post.** Pre-fix, an approval followed by a rejection still derived
authority, and two identical calls produced two approval rows. Post-fix both are
refused/collapsed; three concurrent identical derivations yield exactly one row,
as does a derivation repeated after restart.

## 3. HIGH 3 — a correlation tag identifies a candidate, it does not prove one
**Root cause.** Both adoption paths trusted `planVersion`. The tag is a pure
function of public coordinates, so anyone who can create a work item can mint a
candidate.

**Remediation.** `adoptIfApproved` compares the candidate's complete
authoritative content against the approved item through the same
`MaterializedItemShape` definition used by creation and derived approval. A
mismatch fails closed to `RECOVERY_REQUIRED`; it deliberately does not create a
second work item behind the impostor and does not edit the impostor into
compliance, because both would be the service deciding unattended what a human
approved.

**Pre/post.** Pre-fix, a work item with the canonical tag and a completely
different title, type, priority and criteria was adopted and advanced past
`PLAN_REVIEW`. Post-fix every variant fails closed with the impostor left at
`IDEA`, untouched, and no second work item created — while a genuine
crash-orphaned item is still adopted exactly once, across a SQLite restart and
under concurrent materialization.

## 4. HIGH 4 — the approval digest covers everything that decides execution
**Root cause.** The digest covered `PlanRevision` fields only. `projectId` and
`execution` are plan-level, so both could change while the approval survived —
the review changed the project and rewrote verification commands to `sh -c ...`.

**Digest authority-field audit.** Every persisted plan field is now classified,
by a deliberately blunt rule (persisted plan CONFIGURATION is
approval-authoritative; only provenance, append-only audit and runtime
checkpoints are excluded), because a subtle rule is what produced the finding:

| class | fields |
| --- | --- |
| APPROVAL-AUTHORITATIVE (hashed) | `projectId`, `intent`, `declaredConstraints`, `budget`, `planner`, `execution` (implementer, reviewer, every verification command's id/executable/argv/cwd/timeout, `workspaceRoot`, `loopBudget`), and the full revision content (`revision`, `summary`, `assumptions`, `constraints`, `risks`, and each item's key/title/type/priority/spec/acceptance criteria/dependencies) |
| AUDIT / METADATA ONLY | `events`, `startedBy`, `startedAt`, `lastTransitionAt`, `openQuestions`, `answers`, `revision.generatedAt`, `revision.plannerRunRef` |
| RUNTIME CHECKPOINT ONLY | `phase`, `version`, `plannerAction`, `attemptsForCurrentRevision`, `clarificationCycles`, `totalPlannerRuns`, `materializationClaim`, `materialized`, `dispatchClaim`, `dispatches`, `outcome`, `failureReason`, `exhaustionKind`, `cancelRequested`, `approvalId`/`approvedRevision`/`approvedDigest` |
| DERIVED / NON-PERSISTED | `requestKey` (from hashed inputs), `revision.contentDigest` (recomputed on read), correlation and lease tags (recomputed), `PlanStatusView` |

`budget` and `planner` are hashed although both are spent before approval:
including them costs nothing, and "this field cannot matter after approval" is
exactly the reasoning that left `execution` unbound.

**Remediation.** `computePlanApprovalDigest` / `approvalDigestOfPlan` produce the
`papr-` digest a human approval is bound to; the revision digest keeps its own
independent read-time check. The digest is recomputed from live state at every
decision point — recording the approval, `status()`, materialization, dispatch —
and `planSerialization` recomputes it too, so a tampered plan no longer loads at
all.

**Pre/post.** Pre-fix, switching the project preserved the approval and
materialized into the unapproved project, and `sh -c ...` verification commands
preserved `EXECUTING` authority. Post-fix ten mutations (project, four execution
variants, loop budget, constraints, intent, an item's spec, an item's
dependencies) each invalidate the approval on both the read and write paths,
nothing is created in the unapproved project, and audit/checkpoint changes
correctly do NOT invalidate it.

## 5. HIGH 5 — one logical planning action, one external planner run
**Root cause.** `PLANNING` meant "retryable", so a second caller claimed another
attempt while the first planner was still in flight.

**Planner action claim/reconciliation design.** A durable `PlannerAction` lease
is written by CAS before anything external happens, with two states that
preserve safe retry without ever risking a duplicate: `CLAIMED` (written before
the launch — finding it proves no planner ran, so a bounded budgeted retry is
safe) and `RUNNING` (written immediately before invoking the planner — finding it
under a lost owner means the outcome is unknowable, so the plan fails closed).
Liveness within a process is tracked in memory and combined with the durable
owner id: an in-flight lease is never stolen, a lease belonging to a vanished
owner is reconciled by state, and a second live instance over the same database
lands in the conservative branch by design. `commit()` enforces "a lease exists
exactly while PLANNING" in one place, and `planSerialization` re-proves it on
read; a `PLANNING` row with no lease now fails closed instead of silently
retrying.

**Pre/post.** Pre-fix, two concurrent drives produced two planner calls. Post-fix
two and three concurrent drives produce exactly one, the budget is charged once,
a second service instance over a `RUNNING` lease launches nothing and reports
`RECOVERY_REQUIRED`, a `CLAIMED` lease is audibly retried, a committed
cancellation launches no planner at all, and a cancellation racing a live action
lets it finish while starting nothing new.

## 6. HIGH 6 — the production CLI planner must accept its own valid output
**Root cause.** A boundary error, not a parser error. `cliPlannerWorker` pooled
transcript evidence with the run summary, and `cliWorker.buildSummary` embeds the
transcript's first 200 characters — so pooling a channel with a truncated copy of
itself manufactured the ambiguity the parser then correctly refused.

**Remediation.** The parser's exactly-one-marker rule was NOT weakened. The
adapter now consumes only the structured `/transcript` evidence channel, the same
constant and the same rule the accepted TASK-004 reviewer-verdict path uses;
`/raw-output` and the bounded run summary remain diagnostics that can never
create authority.

**Pre/post.** Pre-fix, a valid answer arrived with two markers and was rejected.
Post-fix it parses to exactly one proposal — proven through the REAL composition
(`createCliPlannerWorker` → `createLoopWorker` → `createCliWorker` → a fake
`ProcessRunner` emitting Claude Code's documented `--output-format json`
contract), and a plan drives all the way to `PLAN_REVIEW` on that wiring. Genuine
ambiguity, malformed transcripts, marker-bearing stderr and unstructured stdout
are all still refused. This closes the previously documented "no automated test
for a successful real CLI planner start" gap for the production composition. No
real model is invoked.

## 7. HIGH 7 — a mapping is a reference, never proof
**Root cause.** Persistence validated mapping keys and tags but could not check
work item EXISTENCE (a cross-store question), and the service never re-derived
it, so `status()` and `resume()` disagreed.

**Mapping authority/recovery design.** `verifyMaterializationIntegrity` re-derives
every mapping against authoritative Factory state before a plan is exposed or
acted on, using the same shape comparison as adoption and derived approval. A
missing work item is reported as a reason, never propagated as `NotFoundError`.
`status()` returns a read-only `RECOVERY_REQUIRED` projection and writes nothing;
`resume()` records it durably.

**Pre/post.** Pre-fix, `status()` reported `EXECUTING` and `resume()` threw.
Post-fix `MATERIALIZING`, `EXECUTING`, `WAITING_FOR_HUMAN` and `COMPLETED` all
fail closed on a dangling mapping, as do mappings pointing at another project or
at unapproved content; `status()` starts no worker and mutates nothing; `resume()`
starts no replacement loop; valid mappings keep working across a SQLite restart.

## 8. Systematic authority-surface audit (post-fix)
Every public planning operation and the internal paths they reach were re-read
against the twelve anti-patterns. Findings:

- **One new defect, introduced by this round's own refactor and fixed here.**
  Routing the write-path checks through the same phase list as the read
  projection would have let a `BLOCKED` plan reach `stepExecute` with fewer
  questions asked, because `BLOCKED` also routes into the execution step.
  `authorityProblem(plan, mode)` now checks EVERYTHING on the act path whatever
  the phase claims, and only phase-appropriate assertions on the read path. A
  regression test covers it.
- `COMPLETED` was added to the approval-asserting read set: it is terminal, but
  it is still a claim about an approval.
- No remaining instance of: historical approval as current authority; a caller
  target trusted without membership; a tag trusted without content; an
  execution-authoritative field outside the digest; `PLANNING` relaunching model
  work; duplicated structured output; a trusted dangling mapping; a cached
  phase exposed without revalidation; a copied identity string as authority;
  latest-record selection before lineage filtering; raw stdout as control
  authority; or cross-project authority transfer.

## 9. Tests added
`tests/task005RemediationRound1Repro.test.ts` — 64 permanent adversarial tests,
one group per HIGH plus the audit regression. Lower-layer suites were tightened
where the shared invariant changed: `planSerialization.test.ts` gained six
digest-tampering cases (project switched in the payload and in both payload and
column, `sh -c` verification commands, moved workspace root, swapped implementer
config, superseded revision); `planMaterialization.test.ts` split crash boundary
2/3 into the two states the lease now distinguishes; `planningService.test.ts`
AC-8 was re-pointed at the strengthened API (a caller can no longer state the
binding at all, so the tests now attack the binding the service derives for
itself). No accepted test was weakened.

## 10. TASK-001 authority regression
Proven, all NO: arbitrary work item derivation; cross-project widening; stale
replay; fake HUMAN; AGENT/SYSTEM derivation; expired/forged/mismatched
authorization; a derived approval not bound to an exact approved plan item;
`PLAN_APPROVAL` implying release or publish. Existing TASK-001 approval behaviour
for non-planner callers is unchanged — `recordApproval`, `evaluateGate`,
`GateBinding` and `ApprovalContext` keep their accepted semantics, and the round-1
work is additive plus one removed caller-supplied parameter.

## 11. Verification (native WSL, `node v22.22.3`, `npm 10.9.8`)
typecheck PASS · build PASS · `npm test` **896/896, three consecutive runs, zero
flakes** (825 pre-round-1 → 896) · `demo` PASS · `demo:persistent` PASS ·
`worker:doctor` PASS (only `claude --version` / `codex --version`) · `demo:loop`
PASS · `demo:plan` PASS (all five scenarios) · `git diff --check` clean. No real
AI CLI is invoked by any test or demo.

## 12. Deferred non-blocking notes
Two of the six were required by a HIGH and are now fixed: derived-approval
idempotence (HIGH 2) and the CLI planner start test gap (HIGH 6, for the
production composition). Still deferred by instruction: duplicate JSON keys in
planner output, pre-approval `BLOCKED` resuming into recovery, deferred cycle
rejection timing, and the CLI's fixture-scale local operator credential. The
three TASK-004 deferred notes remain untouched.

## 13. Ready for independent TASK-005 re-review: YES

# TASK-005 INDEPENDENT ACCEPTANCE RE-REVIEW (round 1) — Codex CLI (GPT-5.6 Luna, Extra High), 2026-08-22

Reviewer: native `codex` 0.149.0, `gpt-5.6-luna`, effort `xhigh`, sandbox
`danger-full-access`. Repository fingerprint identical before and after
(`a4598f134bc3ffdb1b4a87f7ea0c34b18416118ed3da87880f3030377a538135`); no commit,
push, merge or TASK-006 work.

**Verdict: `CHANGES_REQUIRED`. Safe to commit: NO.** No CRITICAL findings.

Independently CLOSED: all seven first-review HIGHs, and the
remediation-introduced BLOCKED-phase defect. Also confirmed: the TASK-001
authority extension is sound; TASK-002/003/004 regressions intact; typecheck,
build, 896/896 ×3 with no flakes, 534/534 focused, all demos PASS.

**One remaining HIGH — dangling dispatch → EngineeringLoop.** The reviewer
mutated a dispatched plan's `loopId` to `loop-missing` and observed
`status → EXECUTING` with `resume → Error("no scripted loop loop-missing")`.
Same class as the round-1 dangling-mapping fix, in the sibling `plan.dispatches`
collection.

The **RUNNING-lease multi-process trade-off was judged NON-BLOCKING**:
`docs/ARCHITECTURE.md` starts the Factory as a local application and promises no
multi-process coordination, so conservative fail-closed behaviour there preserves
the stronger no-duplicate-external-work invariant.

Non-blocking notes added: a narrow cancellation TOCTOU where an already-created
item became READY after cancellation — no new WorkItem or loop launched, so not a
violation of the "no new work after durable cancellation" invariant.

## Human decision
Remediate the single remaining HIGH (round 2). Do not redesign, do not reopen
accepted fixes, do not fix unrelated deferred notes.

# TASK-005 — Implementer remediation round 2

Reproduced on a byte-exact copy of the round-1 tree BEFORE fixing: **3/3
reproductions of the broken behaviour passed**. Re-run unmodified against the
fixed tree: **0/3 pass**. The reproductions are permanent in
`tests/task005RemediationRound2Repro.test.ts`.

## 1. Root cause
Round 1 established "a persisted reference is a checkpoint, never proof" and
applied it to `plan.materialized` only. `plan.dispatches` holds foreign
references too, and nothing re-derived them: `status()` trusted the stored phase,
and `stepExecute` called `dispatcher.status(dispatch.loopId)` — a lookup BY THE
UNVERIFIED ID — so a missing loop surfaced as a raw adapter error thrown out of
the middle of a drive step rather than as a classified recovery state.

## 2. Dispatch integrity architecture
One central resolver, `PlanningService.resolveDispatchViews`, called from the
same `authorityProblem` that already governs approval and materialization
integrity — so the two sibling collections can never drift apart again. It
verifies **lineage, not existence**, through the accepted TASK-004 read API:
`LoopDispatcher.find(workItemId)` answers "which loop does this work item
actually have", so one comparison covers both a missing loop and a substituted
one. No new TASK-004 API was added and no second authority model was created.

Per dispatch it proves: the plan item is in the approved revision; a mapping
exists and names the same work item; the loop id is present, non-empty, and
claimed by no other plan item; a loop exists for that work item; its id is
exactly the dispatched one; and it targets that work item.

The resolved views are RETURNED, so `stepExecute` reads each loop's phase from
the view already proven to belong to that dispatch instead of looking the id up
again. That removes the raw-throw path rather than catching it.

A missing loop is treated as **ambiguous** — never as proof nothing ran — so the
plan fails closed and no replacement loop is launched.

## 3. Pre-fix exact reproduction
1. `status()` → `EXECUTING`; `resume()` → `Error("no scripted loop loop-missing")`.
2. Same after a SQLite close/reopen: the row loads and is still exposed as
   `EXECUTING`.
3. **Stronger case the review did not test:** two dispatches with their
   `loopId`s SWAPPED — every reference resolves to a real, live loop, just the
   wrong one — was fully accepted by both `status()` and `resume()`.

## 4. Post-fix exact result
All three now fail (i.e. the vulnerabilities are gone). Missing loop and
cross-wired loop both produce `RECOVERY_REQUIRED` on the read path and a durable
`RECOVERY_REQUIRED` on the write path, with zero replacement launches.

## 5. Wrong-loop lineage result
Closed. Existence alone is never accepted: a dispatch is sound only if the loop
`find(workItemId)` returns IS the dispatched loop. Cross-wired lineage,
mapping/dispatch work-item disagreement, two items claiming one loop, and a
dispatch naming a plan item outside the approved revision all fail closed.

## 6. `status()` behaviour
Read-only fail-closed projection, as for dangling mappings. Proven by test to
perform zero plan writes, zero work-item writes, zero loop launches and zero
planner runs, and to leave the stored checkpoint untouched.

## 7. `resume()` behaviour
Durably records `RECOVERY_REQUIRED` and launches nothing — no replacement loop,
no redispatch, no second work item, no raw `NotFoundError`/`no scripted loop`
escaping as the externally meaningful result. Repeated resumes stay in recovery.

**A second defect found by the required status/resume matrix, and fixed here:**
`drive()` returned terminal plans verbatim, so `resume()` reported `COMPLETED`
for a plan whose dispatch no longer resolved while `status()` reported
`RECOVERY_REQUIRED` for the same row. Both now share one projection
(`projectFailClosed`). The paths may differ in whether they PERSIST a conclusion;
they may never differ in what it is. A terminal record is still not rewritten —
history is reported as unsound, not edited.

## 8. Persistence/serialization boundary
Deliberate and documented. `planSerialization` proves everything decidable from
the row itself (key coherence, dispatch/mapping agreement, loop-id shape and
uniqueness — an empty loop id is now corruption, legal phase/state relationships)
and does NOT reach across stores: a decoder that did would make "can this row be
read" depend on live external state, so a transient outage would be
indistinguishable from corruption. Cross-store lineage is proved at USE time and
fails closed to recovery rather than refusing to load. Pinned by two tests.

## 9. Foreign-reference inventory
Every persisted Plan → external object reference was swept and classified (full
table in the design doc §9.3). Authority-relevant and live-proved:
`materialized[].workItemId`, `dispatches[].loopId`, `dispatches[].workItemId`,
`approvalId`. Authority-relevant but **transitively** proved: `projectId` — a
Factory store without the project is a store without the approval, and approval
authority is re-derived before anything is created, so it fails closed first.
That was probed as a possible third sibling bug and proven not to be one; two
tests pin the reasoning so a future reader neither "fixes" it nor assumes another
reference is equally safe without checking. Checkpoint and structure-only
references (claims, planner-action tag, `plannerRunRef`, `dependsOn`,
`questionId`) are deliberately NOT turned into live lookups.

## 10. Status/resume consistency matrix
Verified across `MATERIALIZING`, `EXECUTING`, `WAITING_FOR_HUMAN`, `COMPLETED`
and `BLOCKED` with an unsound dispatch, plus the sound path. Both paths reach the
same authority conclusion everywhere. The single deliberate asymmetry is
`BLOCKED`, which claims no authority and is therefore reported verbatim by the
read path — the same pre-approval-BLOCKED reasoning already documented and
deferred.

## 11. Tests added
`tests/task005RemediationRound2Repro.test.ts` — 38 permanent tests: missing loop
across four phases, durable recovery on resume, BLOCKED cannot act on an unproven
dispatch, no blind relaunch, cross-wired loops, mapping/dispatch disagreement,
duplicate loop claim, unknown plan item, read-path inertness (plan, work item,
loop, planner), the status/resume matrix, SQLite restart for missing and
cross-wired loops plus the sound case, the persistence/runtime boundary, the
foreign-reference sweep, and five preserved-behaviour tests (EXECUTING,
WAITING_FOR_HUMAN on live authority, COMPLETED on release, blocking on a real
failed loop, dependent dispatch after a prerequisite finishes).

One round-1 test was corrected, not weakened: its "survives a SQLite restart"
case handed the restarted service a fresh EMPTY dispatcher, which models a wiped
loop database rather than a restart. It now carries the loop store across, as a
real restart does — and round 2 correctly reports the wiped-database case as
`RECOVERY_REQUIRED`.

## 12. Verification (native WSL, `node v22.22.3`, `npm 10.9.8`)
typecheck PASS · build PASS · `npm test` **928/928, three consecutive runs, zero
flakes** (896 → 928) · all five demos PASS · `git diff --check` clean.

## 13. Deferred, unchanged
The RUNNING-lease multi-process limitation (reviewer-classified non-blocking) is
deliberately untouched. Still deferred: the cancellation TOCTOU, duplicate
planner JSON keys, pre-approval `BLOCKED` recovery behaviour, cycle rejection
timing, the fixture credential, and TASK-004's three notes.

## 14. Ready for independent TASK-005 re-review: YES

# TASK-005 INDEPENDENT ACCEPTANCE RE-REVIEW (round 2) — Codex CLI (GPT-5.6 Luna, Extra High), 2026-08-22

Reviewer: native `codex` 0.149.0, `gpt-5.6-luna`, effort `xhigh`, sandbox
`danger-full-access`. Fingerprint identical before and after
(`657bb98abd38ab22718ebaa48a7b8eaf211f77c142ce5ebda9d428856786a8ce`); no commit,
push, merge or TASK-006 work.

**Verdict: `CHANGES_REQUIRED`. Safe to commit: NO.** No CRITICAL findings; one
HIGH.

Independently CLOSED: the round-2 dispatch-loop HIGH, the cross-wired-loop
sibling, the terminal status/resume disagreement, all seven round-1 HIGHs, and
the BLOCKED-phase defect. The foreign-reference inventory was re-derived against
the code and **no fourth ID-only authority bypass was found**; the `projectId`
reasoning was upheld. RUNNING-lease limitation and cancellation TOCTOU remain
non-blocking. Verified independently: 928/928 ×3, focused 679/679, all demos,
`git diff --check` clean. Non-vacuity was proven by mutating a `/tmp` copy —
16 round-2 tests failed.

**HIGH — SQLite drops TASK-005 approval bindings.**
`src/adapters/sqlite/serialization.ts` reconstructed `ApprovalContext` from a
whitelist of `statusWhenDecided`, `specRevision`, `snapshotId`, omitting
`planContentDigest`, `derivedFromApprovalId`, `planId` and `planRevision`.
Reproduced with real SQLite Factory + real SQLite plan repositories: a valid PLAN
approval was recorded, `gateStatus` returned `satisfied:false` immediately and
after close/reopen because the approval lacked a plan content digest. Durable
SQLite-backed plans could never materialize or dispatch — the production
`sf plan approve` path was broken. The reviewer classified it as fail-closed
binding LOSS, not authority substitution.

## Human decision
Remediate the single remaining HIGH (round 3). Narrow scope: fix persistence, do
not weaken authority, do not reopen closed findings.

# TASK-005 — Implementer remediation round 3

## 1. Root cause
A domain type evolved and one of its production adapters did not. `ApprovalContext`
gained four TASK-005 authority fields; `parseApprovalContext` kept its original
three-field whitelist. The loss was silent: no error, no corruption, no insecure
acceptance — the evidence an approval carries was deleted between write and read,
and `gateGuard` then correctly refused an approval with no digest.

It passed 928 tests because every TASK-005 test used the in-memory Factory store,
which holds objects directly and therefore cannot lose a field. **This is the
third finding in a row traced to testing a substitute instead of the composition
production builds** (round 1: a pooled output channel; round 2: a fresh
dispatcher standing in for a persisted loop store).

## 2. Remediation
`src/adapters/sqlite/serialization.ts` only. `parseApprovalContext` reconstructs
every declared field, with the same strict discipline as the rest of the file:
`optionalStr` for the three string fields, and a new `optionalPositiveInt` for
`planRevision` (a revision is a positive integer, not merely a number). Absent
stays absent; malformed is refused with `PersistenceCorruptionError`; nothing is
coerced. The authority checks were NOT relaxed — persistence was dropping
required evidence, so persistence was fixed.

## 3. Field-by-field round-trip
`statusWhenDecided`, `specRevision`, `snapshotId`, `planContentDigest`,
`derivedFromApprovalId`, `planId`, `planRevision` — all preserved exactly, proven
individually rather than by whole-object equality alone. A minimal context gains
no invented fields; a RELEASE approval is unaffected.

## 4. Pre-fix reproduction (real production stack, recorded)
- context after SQLite read: `{"statusWhenDecided":"PLAN_REVIEW","specRevision":1}`
  — four fields gone
- `gateStatus` → `false`, "approval is not bound to a plan content digest and
  cannot authorise planned work"
- `resume()` → `RECOVERY_REQUIRED`, "refusing to materialize: PLAN_APPROVAL gate
  is not satisfied"; zero work items created
- same after close/reopen
- a derived approval lost `derivedFromApprovalId`, `planId` and `planRevision`

## 5-7. Post-fix, restart, derived approval
The identical scenario now succeeds: the stored approval carries the digest, the
gate is satisfied, and the plan materializes and dispatches. Across a real
close/reopen of BOTH databases the gate stays satisfied with no re-approval, the
work item is READY-or-beyond, and the derived per-item approval still carries
`planId`, `planRevision` and `derivedFromApprovalId` and still satisfies its own
gate. Exactly one plan approval and one derived approval exist after restart, and
exactly one loop was ever dispatched.

## 8-9. Production composition and the CLI approve path
`tests/task005RemediationRound3Repro.test.ts` builds the same chain
`src/cli/plan.ts` builds — real SQLite Factory store, real SQLite plan
repository, real `FactoryService` with its real `HumanIdentityGate` and
`PlanBindingResolver`, real `PlanningService` — scripting only the planner and
the TASK-004 loop seam, so no model is invoked. It covers approve → materialize
→ derived approval → dispatch → close → reopen → continue, plus a rejected plan
and a post-approval content change, both of which must stay non-authoritative
after reopen. The CLI's own wiring was read and mirrored; the test names it so a
future change to that composition is re-questioned deliberately.

## 10-11. Parity audit and siblings
Every persisted domain type was compared field-for-field against its SQLite
parser: `Project` 4/4, `WorkItem` 17/17, `AcceptanceCriterion` 5/5, `Run` 13/13,
`Review` 11/11, `Evidence` 8/8, `AcceptanceCriterionVerification` 10/10,
`Approval` 8/8, `ApprovalContext` 7/7, `Actor` 3/3, `SubjectRef` 2/2,
`StatusChange` 5/5. **No other field-loss of this class exists.** The SQLite
adapter is the only production serializer for `Approval`; the in-memory store
persists object references and cannot drop a field.

`tests/approvalContextRoundTrip.test.ts` makes the class permanently visible: its
field list is typed `Record<keyof Required<ApprovalContext>, true>`, so a new
domain field that is not listed fails to COMPILE, and a listed field the adapter
drops fails at RUNTIME.

## 12. Tests added
Two files, 9 tests: the parity guard (maximal round-trip, minimal round-trip,
release-context round-trip, declared-field coverage, ten malformed-value
refusals) and the production-composition suite (gate after approval, full
restart drive, rejected plan after reopen, post-approval content change after
reopen).

## 13. Non-vacuity
The four fields were reverted in a `/tmp` copy of the tree. `approvalContextRoundTrip`
failed 1/5 and `task005RemediationRound3Repro` failed 2/4 — the maximal
round-trip and both production-composition drives. The authoritative tree was
never modified.

## 14-18. Regressions
TASK-001: approval semantics unchanged — HUMAN verification, forged/mismatched/
expired rejection, immutability, exact gate binding, no PLAN→RELEASE/PUBLISH
widening. Approvals without TASK-005 fields remain valid where their gate does
not require them (optional semantics preserved, proven by the minimal- and
release-context tests). TASK-002: schema validation, transactions, CAS,
append-only, corruption handling and restart durability all still pass; the
change adds validation and removes none. TASK-003/004 untouched. All round-1 and
round-2 TASK-005 adversarial suites pass unchanged, including that a stale or
rejected approval is still not applicable after reopen. Unattended execution
preserved.

## 19-22. Verification (native WSL, `node v22.22.3`, `npm 10.9.8`)
typecheck PASS · build PASS · `npm test` **937/937, FIVE consecutive runs, zero
flakes** (928 → 937) · all five demos PASS · `git diff --check` clean.

### A real flake, found and fixed rather than averaged away
The first stability attempt failed once in three runs: `planningService.test.ts`
"refuses a forged token" forged a token by replacing the last two characters of
the signature with `"00"`. The signature is a random-keyed HMAC, so roughly once
in 256 runs the "forged" value WAS the genuine signature — the token verified,
the approval succeeded, and the test failed for the wrong reason.

Measured, not assumed: over 20,000 minted tokens the old idiom collided **83
times (~1/241**, against a theoretical 1/256) and the replacement idiom —
changing the final character to a guaranteed-different one, the same pattern the
accepted TASK-004 forgery tests already use — collided **0 times**, and cannot by
construction. The governance suite then ran 40 consecutive times with zero
failures, and the full suite five consecutive times.

This was a defect in a TASK-005 test I wrote, not in the product and not in any
accepted test; the two accepted TASK-004 forgery tests were already correct.

## 23. Deferred, unchanged
All nine previously deferred notes remain deferred and untouched.

## 24. Ready for independent TASK-005 re-review: YES

# TASK-005 FINAL INDEPENDENT ACCEPTANCE — Codex CLI (GPT-5.6 Luna, Extra High), 2026-08-23

**Verdict: `PASS_WITH_NON_BLOCKING_NOTES`. "TASK-005 is safe for human acceptance
and commit." Safe to commit: YES.** Zero CRITICAL/HIGH findings.

Independently closed: all seven round-1 HIGHs, the round-1 BLOCKED-phase defect,
the round-2 dispatch-loop HIGH, the cross-wired-loop sibling, the terminal
status/resume disagreement, and the round-3 SQLite `ApprovalContext` field-loss
HIGH. The reviewer re-derived the domain/adapter parity audit against the code
(all twelve types), confirmed the `Record<keyof Required<ApprovalContext>, true>`
guard is non-vacuous including its compile-time claim, and independently proved
non-vacuity by mutating a `/tmp` copy (1/5 parity-guard and 2/4 round-3 tests
failed). 937/937 across three consecutive runs; focused groups 386/386 and
259/259; all demos PASS; repository unchanged by review.

## Human decision
"TASK-005'i kabul ediyorum." — accepted, integrated, and merged to `main` as
`01f9e5d` (squash), with feature branch `feat/planner-task-generator` retained at
`562d15c`.

# TASK-006 — Autonomous Completion & Resource Supervisor

Branch: `feat/autonomous-completion-supervisor`, based on `01f9e5d`.

## 1. What it is for
After TASK-005 the Factory could take intent → plan → approval → work items →
the TASK-004 loop, but every step still needed a live AI session with a human
relaying prompts. TASK-006 moves the Factory's memory and scheduling into
deterministic infrastructure — SQLite, Git, and a one-shot supervisor process —
so a model session becomes a disposable worker rather than the seat of the
Factory's mind.

Two rules govern the design:

- **AI must never be used to wait for AI.** `sf supervise tick` does ONE bounded
  pass and exits. Between ticks no process runs at all, so waiting for a
  provider costs zero tokens and zero CPU. There is no loop in which a model
  could be held open to ask "is the limit reset yet?".
- **The Factory has exactly zero autonomous financial authority.** Enforced by a
  gate that structurally cannot be overridden (§3 below).

## 2. Everything was measured, nothing invented
No CLI flag, output string or exit code in this task was assumed. Measured on
this machine before use: Claude Code `2.1.238` (`--model`, `--effort`,
`--fallback-model`, `-p`, `--output-format json`); codex-cli `0.149.0` (`-m`,
`-c model_reasoning_effort=`, `-s`, `--json`, `-o`); zero-token probes
`claude auth status` (JSON with `loggedIn`) and `codex doctor --json`
(`checks["auth.credentials"].status`); systemd 255 with the **user instance
running**, `systemd-run` and `crontab` present, `at` absent.

**What could NOT be measured is not claimed.** Neither CLI documents its
rate-limit or usage-exhaustion output, and observing a real one would mean
deliberately exhausting a paid quota. So no rate-limit signature ships as
`MEASURED`: provisional patterns are listed, clearly labelled, and **inert**. A
real limit therefore classifies as `UNKNOWN_FAILURE` — which is safe, because an
unclassified failure gets bounded backoff, exactly the right treatment for a
suspected transient limit. When a genuine response is captured its fixture is
added and behaviour sharpens from "back off" to "wait until the stated reset".

## 3. FinancialSafetyGate — the blocking invariant
`AUTONOMOUS_SPEND_LIMIT = 0`, `autonomousSpendAllowed = false`.

The gate's signature is `evaluateFinancialSafety(action, policy)` — **no Actor,
no TrustedHumanToken, no Approval, no plan, no model output**. There is no
parameter through which authorization could be passed, so a caller holding
genuine authority for something else cannot pass it. A PLAN_APPROVAL, a
RELEASE_APPROVAL, task acceptance, the completion mandate itself and a model
announcing "purchase approved" therefore have exactly zero effect, because none
of them can reach the function. Same discipline as TASK-001's `Worker`, which
never receives the identity credential.

Classification is **derived, not declared**: a caller may state a class, and the
gate takes the most restrictive of declared and derived — TASK-005 round 1's
"a caller that describes its own target favourably widens its own authority",
applied to money. An **unknown action kind is FINANCIAL_ACTION**; the supervisor
executes a closed set, so an unrecognised kind is suspicious, not merely
unlisted. A "free tier" requiring a card, metering usage, or auto-converting is
financial. Missing/malformed/self-contradictory policy **denies**. There is no
de minimis exception.

Using an already-paid subscription within its included quota is
`FREE_REMOTE_ACTION`; every action that would ENLARGE spend — overage, top-up,
credits, plan upgrade, payment method — is separately registered and financial.

Defence in depth is documented as: this gate, then least-privilege provider
credentials that technically cannot manage billing (a requirement recorded for
the later server task, since prompt-level prohibition is insufficient where
provider-level permission separation exists), then human-only transactions.

## 4. Resource state machine and zero-token recovery
Eight durable states (`AVAILABLE`, `BUSY`, `RATE_LIMITED`,
`USAGE_LIMIT_REACHED`, `MODEL_UNAVAILABLE`, `PROVIDER_UNAVAILABLE`,
`AUTH_REQUIRED`, `UNKNOWN_FAILURE`). `WAITING_FOR_RESOURCE` is deliberately NOT
a resource state — a resource is exhausted, a TASK waits; a shortage is not
`FAILED` and not `RECOVERY_REQUIRED`.

Classification consults, in strict priority: process facts from the accepted
TASK-003 `ProcessRunner`; structured zero-token probe output parsed by FIELD not
by prose; the signature table; then `UNKNOWN_FAILURE`. **No model is ever
invoked to classify a provider error.**

Recovery prefers a provider-stated reset time, then a zero-token probe, then a
scheduled wake, then bounded backoff `5m → 15m → 30m → 60m` (deterministic, no
jitter, persisted so a restart continues the ladder rather than hammering the
provider at the first rung forever). **A resource with a known `retryAt` in the
future is not probed at all.** `AUTH_REQUIRED` schedules no retry, because no
timer can supply a credential.

## 5. Model/effort enforcement, honestly
Requested model and effort become real argv built by the same pure builders the
accepted adapters use. Every run records requested/effective/verification. The
verification status is `UNVERIFIED` unless the provider itself echoes the
identity back — recording an unverified claim as verified is the exact defect
this task exists to remove. The argv is captured as evidence (prompt redacted),
which is a genuinely stronger proof of intent than prompt text. An effort the
installed CLI cannot apply is **refused, not silently downgraded**.

## 6. Reviewer independence and no unsuitable substitution
A routing whose reviewer resource equals the implementer's is refused, not
deprioritised; absent an independent reviewer the item WAITS. Each work class
carries a quality floor, and a resource below it is not a fallback but a
different, worse answer — so the work waits instead. An equally-qualified
alternative IS a legitimate fallback.

## 7. Session rollover vs. quota exhaustion
Different problems, different answers: a full context checkpoints and rolls the
session over; an exhausted quota waits for `retryAt`. `SessionCheckpoint` is
bounded and structured (project, work item, plan/revision, branch, base commit,
action identity, iteration, completed/pending verification, findings, next
action, required work class). Raw transcripts are never the authoritative
memory — if resuming needed the previous chat, the Factory would still be
hostage to a session.

## 8. A defect found by running it, not by testing it
The first live `sf supervise tick` reported that a roadmap item needing a PLAN
required "a human to personally perform this transaction". The refusal was
correct — `PLAN_ROADMAP_ITEM` was an unregistered kind, and uncertainty is
financial — but telling an operator to make a PAYMENT when they need to write a
document is a wrong answer even when the refusal is right. Fixed by registering
`AUTHOR_PLAN` as free/local and adding `HUMAN_DECISION_REQUIRED`, so a free
action that still needs a person is reported as a decision rather than a
transaction. A regression test asserts the advice never mentions
payment/purchase for a zero-cost action.

## 9. What TASK-006 deliberately does NOT do
It schedules work; it does not perform it. Turning a roadmap item into an
approved plan and driving TASK-004 belongs to the next roadmap task, and
inventing it here would be exactly the "second engineering loop" every previous
task refused to build. The shipped executor therefore reports honestly that an
approved plan is required. Every other part — resource states, waiting, backoff,
gating, routing, checkpointing, escalation, persistence, CLI — is fully live and
was exercised end-to-end against real probes and a real SQLite file.

No deployment, no systemd unit file: TASK-006 publishes `nextWakeAt` and ships
the one-shot tick, which is what a timer needs. Wiring it to a timer belongs to
`LOCAL_24_7_RUNTIME`, the first roadmap item — which, per the amendment, means
making the always-on Windows PC + WSL2 a reliable Factory host. **No VPS and no
paid infrastructure of any kind is in scope.**

## 10. Remediation rounds 1–10
Ten independent reviews, fifty-six findings closed and two ADJUDICATED as
architectural boundaries and tracked as roadmap items rather than claimed closed.
Full record in
`docs/tasks/TASK-006-autonomous-completion-resource-supervisor.md`. The
condensed version:

- **Round 1 (F-1…F-9).** A persisted row could grant a spending budget (F-1); a
  persisted row could assert a provider was healthy (F-8); a VERB asserted that
  running a model was free (F-2).
- **Round 2 (N-1…N-4).** N-1 was a CRITICAL **the round-1 remediation itself
  introduced**: fixing F-2 by letting `action.effects` replace the registry
  reopened the "declared, not derived" hole in the same commit that closed a
  different one. Recorded plainly rather than buried, because it is the most
  instructive event in the task.
- **Round 3 (NEW-FIN-1, NEW-FIN-2, NEW-SEC-1, NEW-MODEL-1).** Billing mode is
  now OBSERVED from the provider rather than declared in configuration; the
  effects registry is deeply frozen; executor-authored text is redacted and
  bounded at a single chokepoint (`setStatus`), not per call site; and only
  allowlisted models reach argv.

- **Round 4 (F4-1…F4-9).** The same sentence aimed at four things nobody had
  filed under "data": the ORDER of an exported array decided which class was
  stricter; the authoritative billing facts for a model launch were a FIELD on
  the caller's own object; a fresh-looking TIMESTAMP was accepted instead of a
  probe; and `RUN_VERIFICATION_COMMAND` was free while naming no command, which
  made `gcloud compute instances create` free verification. Plus: C4 walked one
  edge of the lineage instead of the whole ancestry, two allowlists were mutable,
  "verified" was reported for dimensions nothing had verified, and the run
  configuration existed only for the length of one call.

- **Round 5 (F5-*).** Four CRITICAL, seven HIGH — **two of the CRITICALs
  introduced by round 4's own fixes.** The mint bound effects to an object but
  not to its KIND, so mutating `kind` laundered "this model is on a subscription"
  into a verdict about a shell command. The round-4 executable allowlist could
  not constrain what those executables did: `npm run charge`, `npx anything`,
  `node --import`, `sh -c` and `git push` all passed it — `sh` on an allowlist is
  not a command, it is permission to run any command. Plus:
  `subscriptionType: "free"` classified as an included subscription, deterministic
  work could decline to declare its actions and was therefore never asked, an
  effort-only identity report was ignored, provider was not a verified dimension
  at all, and `GIT_PUSH` was claimed free on no evidence.

- **Round 6 (F6-*).** Two CRITICAL, five HIGH — and the first round whose
  findings were mostly not self-inflicted: the reviewer ran its own
  delete-the-fix experiments across sixteen earlier fixes and confirmed most held.
  The mint said HOW an action was billed but never WHAT it was billed for, so an
  "included" verdict for one resource authorized launching another. An unreadable
  policy still permitted local work. An AI worker could omit its identity
  entirely and reach DONE on an honest-looking `UNVERIFIED`. "Append-only"
  implementer history evicted the OLDEST entry at 32. Unknown lineage failed
  closed only for DONE ancestors. And round 5's own `resumedFromActionId` was
  executor-supplied, unsanitized and forgeable.

- **Round 7 (R7-*).** No CRITICAL, five HIGH, and the reviewer endorsed the
  `EXECUTOR_ISOLATION` deferral instead of re-reporting it. `reportedIdentity: {}`
  satisfied "did the worker say what it ran?" because the check asked only
  whether a container existed. A fabricated `["not-a-resource"]` implementer
  satisfied "do we know who built this?" while excluding nobody. A row persisted
  as `ELIGIBLE` ran while its prerequisite was still `PENDING`. The SQLite
  repository returned mutable state while the in-memory one returned frozen
  state — so an executor could mutate `input.item.key` and settle the wrong item,
  in production only. And the F6-FIN-1 regression could not fail: deleting its
  guard left all 1292 tests green, because the mutation that "verified" it had
  broken the guard's INPUT rather than the guard.

- **Round 8 (R8-*).** One CRITICAL, three HIGH — two introduced by round 7. A
  Claude payload with a recognised plan and provider but NO `authMethod`
  classified as an included subscription, and a tick launched a worker on it:
  three fields agreeing about the PLAN taken as evidence about who pays for the
  CALLS. Validating a reported identity and reconciling it were two reads, so
  getters could answer differently each time. The set of "recognised
  implementers" included PERSISTED resource rows — the anti-forgery check
  validated against forgeable data. And `sanitizeCheckpoint` spread the
  executor's object, so an undeclared `secret:` property reached the raw SQLite
  JSON.

- **Round 9 (R9-*).** No CRITICAL, three HIGH, and **the first clean financial
  assessment**: the reviewer could find no path through the gate that classified
  a chargeable action as free or executed one autonomously, after trying
  confusable auth methods, saved-card and subscription claims, malformed
  policies, forged billing observations, exhaustion paths and model-output
  claims. The findings: the CLI printed persisted text unbounded and unredacted
  (every prior sanitization fix guarded a WRITE; a database is also an INPUT); a
  forged implementer history naming a REAL catalog resource is recognised; and
  two of my own round-8 regressions passed for the wrong reason — one asserted
  against parsed state, where the parser drops the very field under test.

- **Round 10 (R10-*).** One CRITICAL, three HIGH, all narrow — and the round that
  ADJUDICATED both open boundaries as legitimate deferrals. The public minter
  still took `billingMode` as a bare string, so any caller could declare a
  metered resource free; a billing mode must now arrive inside an observation
  bound to the resource it describes. `describeTick` printed persisted
  identifiers raw, and the top-level CLI `catch` printed parse errors raw — and
  a parse error quotes the offending persisted value back by design. Plus the
  R8-ID getter test, wrong for the third time.

Every finding is the same sentence: **a safety property that depends on data the
system itself can write is not a safety property.** Configuration, an in-process
object, executor output, a caller-supplied string, an array's order and a
timestamp are all data the system can write.

**And the meta-pattern, stated plainly because it is the useful one:** five of the
six rounds found a defect that the PREVIOUS round's remediation introduced. A fix
that moves an invariant to a new place needs the same adversarial attention the
old place got, and nothing in a single session reliably supplies that. C4 is not
overhead on this task; it is the only thing that has caught any of it.

**Two things NOT closed, deliberately not claimed, and tracked as roadmap items
that both block `EXECUTOR_WIRING`:**

1. **`EXECUTOR_ISOLATION`** — the in-process `WorkExecutor` can act outside what
   it declared (F5-FIN-3 / F6-FIN-2). Uncloseable from inside the process: an
   in-process function cannot restrain code that can already call `fetch`. Same
   boundary TASK-003's `Worker` has. Round 7 reviewed the deferral itself and
   endorsed it.
2. **`STATE_INTEGRITY`** — implementer lineage and audit records are recorded
   historical facts living in a database, with no key on this machine to
   authenticate them (R9-C4-1, F5-AUDIT-1). The supervisor raises the cost
   (catalog recognition, a cross-check against a field a different path writes,
   fail-closed on anything missing or contradictory) but cannot make the record
   self-proving. **The supervisor database is part of the trusted computing
   base.**

Regression tests assert both dependencies so the ordering cannot be quietly
dropped, and one test deliberately PINS the remaining lineage gap so that closing
it will fail the test and force the claim to be revisited.

Note the contrast that makes these honest rather than excuses: spending authority
has no such gap, because F-1 made it impossible to express in data at all. No row
can grant it, so no row has to be trusted. Lineage cannot be handled that way —
"who ran this last week" is inherently a record.

The structural answers now in place, in escalating order of how hard they are to
get around: freeze it (allowlists, the effects registry, the class list); derive
it rather than read it (rank map, not `indexOf`); sanitize at a chokepoint rather
than per call site (`setStatus`, `sanitizeCheckpoint`); make the signature unable
to reach the tempting value (`billingModeFor` takes the observation as a
parameter); and make the authoritative value unforgeable by putting it somewhere
the caller cannot address at all (the `WeakMap` mint).

### The round-3 bug the round-3 fix caused
`ResourceRecord.observedBillingMode` was added to the domain type and not to the
SQLite parser, so a restart erased what the supervisor had learned about billing
and every subsequent AI action silently became financial — the identical failure
that caused TASK-005 remediation round 3, one layer over. The restart test
caught it; that it was catchable only behaviourally is the problem, so
`tests/supervisorStateRoundTrip.test.ts` now makes a missing serializer field a
COMPILE error for every durable supervisor type.

## 11. Verification (native WSL, `node v22.22.3`, `npm 10.9.8`)
typecheck PASS · build PASS · `npm test` **1347/1347** (937 → 1347, +410) ·
`git diff --check` clean · `demo`, `demo:persistent`, `demo:loop`, `demo:plan`
all PASS · `sf supervise tick|status|resources|roadmap` exercised against real
zero-token probes and a real SQLite database.

The live run confirms the billing change end-to-end rather than only in tests:
all three catalogued resources report `billing=INCLUDED_SUBSCRIPTION` derived
from the real probes, and `sf supervise tick` escalates `LOCAL_24_7_RUNTIME` as
`HUMAN_DECISION_REQUIRED` — a decision, not a transaction. A read command on a
fresh machine now prints "not initialized" and leaves no database behind.

**Mutation-checked, and it earned its keep.** Each round-4 and round-5 fix was
reverted in the built output and the suite re-run. Most failed as they should.
Two did not, which was the useful result:

- `sanitizeTickResult` could be deleted with its test still green, because the
  probe reason was redundantly bounded at the construction site too — and the
  test never even reached the path it claimed to cover, since its poisoned probe
  fired during the scheduled refresh and routing failed first. The redundant
  bounding was removed so the chokepoint is load-bearing, and the test now
  asserts it got to `WAITING_FOR_RESOURCE` before looking for the credential.
- The F5-SEC-1 kind binding is genuinely redundant while the freeze holds. It is
  kept against a future refactor, and the test is documented as proving the
  outcome rather than which of the two mechanisms produced it.

A green regression that cannot fail is worth less than no regression, because it
also stops anyone from looking.

**And the round-7 refinement of that lesson: mutating the wrong line proves the
wrong thing.** The round-6 F6-FIN-1 result was reported as verified because the
mutation broke `mintedResourceKey` — the guard's INPUT, which trips the guard
rather than removing it. The guard itself was deletable with all 1292 tests
green. Round-7 mutations therefore remove each guard itself, and where a guard is
genuinely unreachable through the public path (`resourceBindingHolds`) it is
tested as a function and its reachability is stated in the code instead of being
implied by a green test.

**That lesson then had to be learned twice.** The first round-8 mutation of the
R8-FIN-1 auth-method guard matched `typeof authMethod === "string" &&` — which is
also the API-key check earlier in the same function — and reported 0 failures.
Same mistake, one round later, same day. Retargeted at the unique
`INCLUDED_CLAUDE_AUTH_METHODS` clause it fails 5 tests.

**And a claim that was simply false.** Round 7's comment asserted R7-SEC-1 was
"two independent fixes"; the eighth review showed one of them was untested,
because both names pointed at the same object. The reviewer caught the CLAIM, not
the code. The repair that re-asserts independence would have been the same error
again — while the freeze holds, the separation protects against nothing — so the
comment now says what is measured: freeze load-bearing, separation defence in
depth, both-removed fails two tests.

## 12. Independent review status: TEN ROUNDS COMPLETE

The tenth review's readiness section, after the four items it named were fixed:

> *"After the four immediate findings are fixed, TASK-006 is acceptable as a
> scheduler that executes no autonomous work."*

All four are fixed and mutation-verified. Round 9 produced the first clean
financial assessment — no path found to autonomous spend or to a chargeable
action classified as free — and round 10 found none either, with its one
CRITICAL being a public-API shape rather than a reachable supervisor path.

**Awaiting human acceptance (C1).** Not merged. `CLAUDE.md` reserves merging for
the user, and the two adjudicated boundaries are conditions on what may be built
NEXT rather than on this merge: nothing in TASK-006 executes autonomous work, and
`EXECUTOR_WIRING` cannot proceed until `EXECUTOR_ISOLATION` and `STATE_INTEGRITY`
do.
