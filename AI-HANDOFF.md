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

## Human decision
Pending.
