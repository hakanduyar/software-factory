# TASK-004 — Autonomous Engineering Loop

## Objective

Give the Factory a coordination layer that drives an already-**approved**
engineering `WorkItem` through IMPLEMENT → deterministic VERIFY → independent
REVIEW → (remediate and repeat, or stop at `WAITING_FOR_HUMAN`) without a
human copying prompts or results between Claude Code and Codex CLI by hand.
This is the orchestration layer only — it consumes the trusted primitives
TASK-001/002/003 already built (`FactoryService`, `WorkflowService`, the
transition table, the worker runner) and does not change any of them.

## Key discovery that shapes this design

`src/workflow/transitions.ts` and `src/workflow/releaseSnapshotResolver.ts`
already encode almost the entire loop as accepted domain law:

```
READY --------------------------> IMPLEMENTING        (no precondition)
IMPLEMENTING --------------------> VERIFYING           (requireSuccessfulImplementationRun)
VERIFYING ------------------------> IMPLEMENTING       (checks failed, back to implementation)
VERIFYING ------------------------> REVIEW             (requireSuccessfulVerification: a SUCCEEDED
                                                          VERIFIER run + a DETERMINISTIC review
                                                          PASS produced by that run)
REVIEW ---------------------------> IMPLEMENTING       (reviewer requested changes)
REVIEW ---------------------------> WAITING_FOR_HUMAN  (requireIndependentSemanticReview: a
                                                          SUCCEEDED, independent-principal
                                                          REVIEWER run + a SEMANTIC review PASS)
```

`FactoryService.recordReview` already enforces C4 (a `SEMANTIC` review's
`reviewerPrincipalId` must differ from `implementerPrincipalId`) and does
**not** require independence for a `DETERMINISTIC` review — which is exactly
right, because deterministic verification is not an opinion, it is command
exit codes.

So TASK-004's job is: **call the existing accepted primitives in the right
order, with real workers, persist enough of its own state to resume safely,
and stop exactly where the domain model already stops (`WAITING_FOR_HUMAN`)**.
No new domain rule, no new bypass, no new trust primitive.

## Scope boundary (reaffirmed from the task brief)

In scope: an orchestration service, deterministic verification runner, strict
reviewer-verdict parser, remediation loop, budgets, persisted/resumable loop
state, cooperative cancellation, a minimal CLI surface, a deterministic
offline demo.

Out of scope (unchanged from the brief): TASK-005 planning/intent→plan,
GitHub Issues/Projects, Telegram/WhatsApp/n8n, server deployment, a scored
model router, automatic commit/push/merge/release, branch automation.

## 1. Orchestration boundary

New top-level module, `src/orchestration/`, plus adapters under
`src/adapters/orchestration/`. Nothing under `src/domain/`, `src/workflow/`,
or `src/app/factoryService.ts` is modified. The orchestrator only calls
`FactoryService`'s existing public methods (`advance`, `runWorker`,
`recordReview`, `getWorkItem`, `registerWorker`, `listEvidence`) — never a
repository directly, never a private write.

```
src/orchestration/
  loopTypes.ts              EngineeringLoop, LoopPhase, LoopIterationRecord,
                             LoopBudget, LoopWorkerConfig, VerificationCommandConfig
  loopRepository.ts         LoopRepository port (own persistence, see §5)
  reviewVerdictParser.ts    strict PASS/PASS_WITH_NON_BLOCKING_NOTES/CHANGES_REQUIRED parser
  verificationWorker.ts     Worker implementation that runs trusted, configured
                             commands (no AI, no shell)
  loopWorkerFactory.ts      builds a Claude/Codex Worker from LoopWorkerConfig
  loopPrompts.ts            bounded, iteration-aware instruction text for
                             IMPLEMENTER/REVIEWER runs
  engineeringLoopService.ts the orchestrator: start / resume / cancel / status

src/adapters/orchestration/
  inMemoryLoopRepository.ts
  sqliteLoopRepository.ts   own SQLite file (.factory-data/loops.db), see §5

src/cli/loop.ts             sf loop start|status|resume|cancel
src/cli/demoLoop.ts         npm run demo:loop (3 deterministic scenarios)
```

## 2. Input contract

```ts
interface StartLoopInput {
  workItemId: WorkItemId;
  actor: Actor;                                  // who started automation (audit only)
  taskInstructions: string;                       // bounded spec text handed to the implementer
  implementer: LoopWorkerConfig;                  // { tool, model, effort?, timeoutMs? }
  reviewer: LoopWorkerConfig;
  verificationCommands: readonly VerificationCommandConfig[]; // executable+argv+cwd+timeout, trusted config
  workspace: Workspace;                            // already resolveWorkspace()-validated
  budget?: Partial<LoopBudget>;
}
```

`start()` rejects (throws, no loop created) unless:
- the `WorkItem` exists and its status is exactly `READY` (the status a plan
  approval already gated it into — "already-approved" per the brief),
- no other **active** loop already exists for this `WorkItem` (queried via
  `LoopRepository.listByWorkItem`; active = phase not in the terminal set).

This is intentionally the only legality check TASK-004 performs. It does not
re-derive "approved" from first principles — `PLAN_REVIEW -> READY` already
required a granted `PLAN_APPROVAL` (TASK-001), so `READY` **is** "approved
engineering work item" in this system's vocabulary.

## 3. Implementer/reviewer independence

The loop never compares `tool`/`model` strings to decide independence — doing
so would reintroduce exactly the "string-role trust" pattern Round-2 review
eliminated (see `src/domain/workerPrincipal.ts`). Instead:

- the orchestrator always constructs **two separate `Worker` objects** (one
  per role, via `loopWorkerFactory`), asserts `implementerWorker !==
  reviewerWorker` by reference as a cheap sanity check, and registers each
  through the existing `WorkerRegistry`;
- the actual enforcement point is unchanged: `FactoryService.recordReview`
  throws `ReviewIntegrityError` if a `SEMANTIC` review's two runs share a
  `workerPrincipalId`. TASK-004 adds no parallel check and cannot bypass this
  one — a worker still cannot review its own work no matter how the loop is
  configured.

Default configuration (data, not law — §15 of the brief):
`IMPLEMENTER = { tool: "claude-code", model: "claude-sonnet-5", effort: "xhigh" }`,
`REVIEWER = { tool: "codex-cli", model: <configured>, effort: "xhigh" }`. Any
other legal combination is accepted.

## 4. Deterministic verification step

A **new, non-AI `Worker`** (`createVerificationWorker`), used with role
`VERIFIER`. It never invents commands: `VerificationCommandConfig` is
`{ id, executable, argv, cwd?, timeoutMs?, evidenceKind? }`, always run via the
existing `ProcessRunner` port (`argv` array, `shell` never used — same
discipline as `cliWorker.ts`). Commands run sequentially against the
workspace root; each produces one bounded, redacted `EvidenceDraft`
(`kind` defaults to `NOTE`, cwd defaults to the workspace root).

**Status split, mirroring TASK-003's core discipline:** the verifier's own
`WorkerOutcome.status` is `SUCCEEDED` whenever the harness finished running
every configured command and captured a result for each — **regardless of
whether a command's exit code was 0**. A failing `npm test` is a
successfully-observed fact, not a harness failure. `WorkerOutcome.status` is
`FAILED` only if the harness itself could not do its job (this does not
happen in normal operation; a thrown exception — reserved for a genuine bug —
still becomes an honest `FAILED` run via `FactoryService.runWorker`'s
existing catch, exactly like every other adapter).

This split is what makes `FactoryService.recordReview` callable at all: it
requires `reviewerRun.status === "SUCCEEDED"` before it will record *any*
review — including a `DETERMINISTIC` one with verdict `FAIL`. If a failing
`npm test` made the verifier run `FAILED`, the loop could never record *why*
verification failed, and `resolveVerification`'s "the verifier run must have
succeeded" check would be indistinguishable from "the harness itself broke."

After the verifier run completes, the orchestrator computes `allPassed` from
the per-command results and calls `factory.recordReview({ kind:
"DETERMINISTIC", reviewedRunId: <implementer run>, reviewerRunId: <verifier
run>, verdict: allPassed ? "PASS" : "FAIL", findings: [...failed command
summaries] })`. This is the exact review `VERIFYING -> REVIEW`'s
`requireSuccessfulVerification` precondition already looks for.

## 5. Loop state persistence

### Types (`src/orchestration/loopTypes.ts`)

```ts
type LoopPhase =
  | "READY" | "IMPLEMENTING" | "VERIFYING" | "REVIEWING"
  | "WAITING_FOR_HUMAN" | "EXHAUSTED" | "FAILED" | "CANCELLED";
// terminal: WAITING_FOR_HUMAN, EXHAUSTED, FAILED, CANCELLED

type LoopReviewVerdict = "PASS" | "PASS_WITH_NON_BLOCKING_NOTES" | "CHANGES_REQUIRED";

interface LoopIterationRecord {
  iteration: number;
  implementerRunId?: RunId;
  implementerOutcome?: "SUCCEEDED" | "FAILED";
  verificationRunId?: RunId;
  verificationReviewId?: ReviewId;        // the DETERMINISTIC Review id
  verificationPassed?: boolean;
  verificationCommandResults?: readonly VerificationCommandResult[];
  reviewerRunId?: RunId;
  reviewRecordId?: ReviewId;              // the SEMANTIC Review id
  reviewVerdict?: LoopReviewVerdict;
  reviewFindings?: readonly string[];
  reviewParseError?: string;
}

interface EngineeringLoop {
  id: string;
  workItemId: WorkItemId;
  version: number;                        // optimistic-concurrency token (CAS)
  phase: LoopPhase;
  budget: LoopBudget;                     // { maxIterations, maxTotalRuns?, maxWallClockMs?, ... }
  implementer: LoopWorkerConfig;
  reviewer: LoopWorkerConfig;
  verificationCommands: readonly VerificationCommandConfig[];
  workspaceRoot: string;
  taskInstructions: string;
  iterations: readonly LoopIterationRecord[];
  totalRunCount: number;
  outcome?: "WAITING_FOR_HUMAN" | "EXHAUSTED" | "FAILED" | "CANCELLED";
  failureReason?: string;
  cancelRequested: boolean;
  startedBy: Actor;
  startedAt: Timestamp;
  lastTransitionAt: Timestamp;
}
```

Only one macro-`phase` field plus one open-ended `LoopIterationRecord` is
needed to make resume unambiguous (§8) — deliberately not a bigger state
machine than that.

### Why a separate SQLite file (`.factory-data/loops.db`)

`FactoryStore`'s SQLite adapter owns one `DatabaseSync` connection with its
own mutex-serialized transactions; loop writes and Factory writes are never
required to commit atomically with each other (the orchestrator always
`await`s one before starting the next — see §8), so there is no correctness
reason to share a connection. Retrofitting a shared connection/mutex into the
already-accepted `sqliteStore.ts` is unnecessary risk for no benefit. The
loop repository therefore opens its own small SQLite file, with its own
minimal `schema_meta` version marker and its own `engineering_loops` table
(`id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, phase TEXT NOT NULL,
version INTEGER NOT NULL, data TEXT NOT NULL`). Both files live under
`.factory-data/` (already gitignored) and both survive process restart
independently; `sf loop status` reads the loop file, `sf worker`/`sf
demo:persistent` read the Factory file, exactly as before.

### `LoopRepository` port

```ts
interface LoopRepository {
  create(loop: EngineeringLoop): Promise<EngineeringLoop>;
  compareAndSave(loop: EngineeringLoop, expectedVersion: number): Promise<EngineeringLoop>;
  findById(id: string): Promise<EngineeringLoop | undefined>;
  listByWorkItem(workItemId: WorkItemId): Promise<readonly EngineeringLoop[]>;
}
```
Same CAS discipline as `WorkItemRepository` (TASK-001/002 precedent) — a
stale writer gets `ConcurrencyError`, nothing is silently overwritten.

## 6. Reviewer prompt / strict verdict parser

The orchestrator does not touch `src/adapters/workers/promptTemplates.ts` —
it composes its own bounded `instructions` string (§7) and passes it through
`FactoryService.runWorker`'s existing `instructions` field, which
`buildWorkerPrompt` already renders under "Task instructions:". The REVIEWER
instructions explicitly require the model's response to begin with a
constrained, single-line tag:

```
FACTORY_REVIEW_VERDICT: PASS
FACTORY_REVIEW_FINDINGS:
- <finding>
(or "- none")
```

`reviewVerdictParser.parseReviewVerdict(sourceTexts: readonly string[])` is a
pure function (directly unit-testable, no I/O):

- scans every source text with `/^FACTORY_REVIEW_VERDICT:\s*(.+)$/gm` (an
  anchored, whole-line match — "Tests PASS but the verdict below is what
  counts" cannot be mistaken for a tag because it is not on a
  `FACTORY_REVIEW_VERDICT:` line);
- **zero matches** → `{ ok: false, reason: "no verdict found" }`;
- **more than one match** (even if all equal) → `{ ok: false, reason:
  "ambiguous: N verdict tags found" }` — strictly ≥2 is rejected, which is a
  superset of "conflicting" and removes any need to define what "conflicting
  but not really" would mean;
- **exactly one match, value not in the 3-item enum** → `{ ok: false, reason:
  "invalid verdict value" }`;
- **exactly one match, valid** → `{ ok: true, verdict, findings: [...] }`,
  findings parsed from a `FACTORY_REVIEW_FINDINGS:` block the same way,
  tolerating its absence (empty findings, not an error).

Source texts passed in are, in order: every `Evidence.summary` recorded for
the reviewer run (covers the real CLI transcript evidence
`cliWorker.ts` produces, and any evidence a test double records) then
`Run.summary` as a final fallback — never raw, un-redacted process output
(evidence text is already redaction-passed by `cliWorker.ts`).

**Verdict parsing only ever happens when `reviewerRun.status === "SUCCEEDED"`.**
A non-zero-exit/timeout/spawn-failed reviewer run is treated purely as an
execution failure (§8 iteration handling) — the orchestrator never even calls
the parser on a `FAILED` run's output, so "PASS" appearing anywhere in a
failed process's stdout can never be read as approval. This is enforced
structurally (an `if (reviewerRun.status !== "SUCCEEDED")` branch before the
parser is ever reached), not by hoping the parser is careful.

Loop verdict → domain `ReviewVerdict` mapping (the domain's `SEMANTIC` review
enum, `PASS | CHANGES_REQUESTED | FAIL`, is unchanged — TASK-004 does not
touch `src/domain/review.ts`):
`PASS -> "PASS"`, `PASS_WITH_NON_BLOCKING_NOTES -> "PASS"` (findings are
still recorded on the `Review`), `CHANGES_REQUIRED -> "CHANGES_REQUESTED"`. A
parser failure (`ok: false`) never calls `recordReview` with `"PASS"` — it is
treated exactly like a `CHANGES_REQUIRED` for remediation-budget purposes
(fail closed) and the parse failure reason is preserved on the iteration
record (`reviewParseError`) for `sf loop status`/audit.

## 7. Prompts (`loopPrompts.ts`)

Bounded, current-state-only context (per the brief's explicit "no unlimited
historical transcripts"):

- **First IMPLEMENTER attempt**: `taskInstructions` verbatim.
- **Remediation IMPLEMENTER attempt**: `taskInstructions` +
  "This is remediation attempt N of maxIterations." + the *previous*
  iteration's verification failures (bounded, from
  `verificationCommandResults`) and/or reviewer findings (bounded, from
  `reviewFindings`) — only the immediately preceding iteration, never the
  whole history.
- **REVIEWER**: `taskInstructions` + verification command results summary +
  the verdict-tag contract above + an explicit "you may not modify code, you
  may not commit."

All strings are built from `LoopIterationRecord`/config fields only — never
from `process.env` — matching the C6 posture already established by
`promptTemplates.ts`.

## 8. Drive loop / resumability

`EngineeringLoopService.start()` validates input (§2), creates the loop row
(`phase: "READY"`), then calls a private `drive(loopId)`. `resume(loopId)`
calls the same `drive`. Both are therefore the same code path — "resume" is
not a special case, it is just calling `drive` again, which is what makes
resumability a property of `drive`'s own design rather than a bolt-on.

```
drive(loopId):
  loop = loops.findById(loopId)                 // always re-read from the
  while phase(loop) not terminal:                // durable store — this is how
    if loop.cancelRequested:                     // an external `sf loop cancel`
      loop = finalizeCancelled(loop); break       // (a different OS process) is
    loop = runOneStep(loop)                      // observed at all
    loop = loops.findById(loop.id)               // re-read again before the next
  return loop                                     // iteration, not reused from memory
```

`runOneStep` dispatches on `loop.phase` and the **last** `LoopIterationRecord`
(`loop.iterations.at(-1)`), never on anything held only in memory:

| phase | condition on last iteration record | action |
|---|---|---|
| READY | — | `factory.advance(READY→IMPLEMENTING)`, append iteration 1 (empty), persist `phase=IMPLEMENTING` |
| IMPLEMENTING | none open, or last one already has `implementerRunId` | append a new iteration record, persist, then `factory.runWorker(IMPLEMENTER)`, persist `implementerRunId`/`implementerOutcome` |
| IMPLEMENTING | open record has no `implementerRunId` (crash mid-attempt) | just run the implementer for the already-open record (no re-append) |
| IMPLEMENTING | `implementerOutcome` just set | `SUCCEEDED` → `factory.advance(IMPLEMENTING→VERIFYING)`, persist `phase=VERIFYING`; `FAILED` → treat as one spent iteration, remediate-or-exhaust (§9) |
| VERIFYING | no `verificationRunId` | run the verification worker, persist `verificationRunId` + `verificationCommandResults` |
| VERIFYING | has `verificationRunId`, no `verificationReviewId` | `factory.recordReview(DETERMINISTIC, ...)`, persist `verificationReviewId` + `verificationPassed` |
| VERIFYING | `verificationPassed === true` | `factory.advance(VERIFYING→REVIEW)`, persist `phase=REVIEWING` |
| VERIFYING | `verificationPassed === false` | remediate-or-exhaust (§9) |
| REVIEWING | no `reviewerRunId` | run the reviewer worker, persist `reviewerRunId` |
| REVIEWING | has `reviewerRunId`, no `reviewVerdict` | parse verdict (§6), `factory.recordReview(SEMANTIC, ...)` unless a parse failure, persist `reviewVerdict`/`reviewRecordId`/`reviewParseError` |
| REVIEWING | verdict is PASS or PASS_WITH_NON_BLOCKING_NOTES | `factory.advance(REVIEW→WAITING_FOR_HUMAN)`, persist `phase=WAITING_FOR_HUMAN`, `outcome=WAITING_FOR_HUMAN` |
| REVIEWING | verdict is CHANGES_REQUIRED or a parse failure | remediate-or-exhaust (§9) |

Every row above is **self-checking before acting**: it inspects the already-
persisted iteration record for the exact field it is about to produce, and
only calls the external action (a worker run, a `recordReview`, an
`advance`) if that field is still absent. This is what answers the crash
matrix in the brief directly:

- **A. IMPLEMENTING said RUNNING, run succeeded, crash before next
  transition** → on resume, the iteration record already has
  `implementerRunId`/`implementerOutcome=SUCCEEDED` (that write happens
  immediately after `runWorker` returns, before anything else) but
  `phase` is still `IMPLEMENTING` → the table's third IMPLEMENTING row
  fires: advances to VERYFING without re-running the implementer.
- **B. verification passed, crash before reviewer launch** → phase is
  `REVIEWING` (already advanced) with no `reviewerRunId` on the new,
  empty-so-far iteration slot → runs the reviewer once, does not repeat
  verification.
- **C. CHANGES_REQUIRED recorded, crash before remediation launch** →
  `reviewVerdict` is already persisted as `CHANGES_REQUIRED`; the
  remediate-or-exhaust branch is re-entered, which is idempotent (it checks
  the iteration count against budget again and either opens exactly one new
  iteration or moves to EXHAUSTED — it never records a second `CHANGES_REQUIRED`
  review for the same reviewer run).
- **D. remediation completed, crash before verification** → new iteration's
  `implementerRunId` is set, phase is `VERIFYING` → runs verification once.
- **E. reviewer PASS persisted, crash before WAITING_FOR_HUMAN transition** →
  `reviewVerdict=PASS` is already durable; resume re-enters the "advance to
  WAITING_FOR_HUMAN" row, which is a plain `factory.advance` — if that had
  *also* already committed before the crash, `factory.getWorkItem` would show
  `WAITING_FOR_HUMAN` already and the loop's own `phase` would too (both
  writes happen back-to-back with nothing else awaited in between), so this
  case cannot half-apply.

**Known, explicitly documented limitation:** the one crash window this cannot
close is the external call itself being *in-flight* when the OS process
dies (e.g. a real `claude`/`codex` child process was mid-execution). Nothing
in the accepted `Worker`/`ProcessRunner` port surface gives a caller a
receipt for "this specific external call, if it eventually finishes, must
not be re-attempted" independent of the awaiting process staying alive.
Resuming after *that* exact crash will re-attempt the step (at-least-once,
not exactly-once, for the in-flight call only) — consistent with the brief's
own allowance ("if full automatic resume-on-start is too broad, an explicit
`sf loop resume <loop-id>` is acceptable... persisted state must make resume
deterministic and safe"): every step that **completed and was recorded**
before the crash is never redone (proven by the crash tests below, via fault
injection at each persisted checkpoint, not by killing a real OS process);
only a step that never got the chance to record its result is retried.

## 9. Remediation / budget

`remediateOrExhaust(loop)`:
```
if loop.iterations.length >= loop.budget.maxIterations:
   -> phase=EXHAUSTED, outcome=EXHAUSTED, failureReason=<what was still failing>
   -> best-effort factory.advance(<current>, "BLOCKED", systemActor, {reason})
      (BLOCKED is reachable, gate-free, from IMPLEMENTING/VERIFYING/REVIEW —
       it is the existing domain vocabulary for "paused, needs a human", so
       EXHAUSTED reuses it instead of inventing a parallel status)
else:
   -> factory.advance(<current>, "IMPLEMENTING") [VERIFYING->IMPLEMENTING or
      REVIEW->IMPLEMENTING, both existing, precondition-free edges]
   -> persist phase=IMPLEMENTING (next drive() iteration opens iteration N+1
      and builds its remediation prompt from this just-closed iteration record)
```
Also checked at the top of every `runOneStep`, before any action: wall-clock
budget (`clock.now() - loop.startedAt > budget.maxWallClockMs`) and
`maxTotalRuns` (if configured) — both route to the same EXHAUSTED path as
running out of iterations, with a distinct `failureReason`.

`FAILED` (as opposed to `EXHAUSTED`) is reserved for the orchestration layer
breaking in a way the state machine above did not anticipate (an unexpected
thrown error from `FactoryService` that is not one of the ordinary,
already-handled outcomes) — i.e. "the loop broke" vs. EXHAUSTED's "the work
still isn't passing and the budget ran out." `drive()` wraps `runOneStep` in
a try/catch; a catch persists `phase=FAILED`, `outcome=FAILED`,
`failureReason=<message>`, and best-effort attempts the same BLOCKED
courtesy transition, swallowing (and recording, not silently dropping) any
secondary error from that attempt so the loop's own FAILED record is never
lost because the courtesy transition also failed.

## 10. Cancellation

`cancel(loopId, actor)` durably sets `cancelRequested=true` via
`compareAndSave`, then attempts to finalize to `CANCELLED` immediately
(idempotent: if it loses a race to another finalizer — including a `drive()`
loop in another process noticing the flag first — it re-reads and returns the
already-terminal result instead of throwing). `WorkItem` status is left
untouched by cancellation (the brief only requires it never reach `DONE`;
forcing `BLOCKED` on cancel is not requested and would be a surprising side
effect for something that might be cancelled for reasons unrelated to the
work itself).

**Documented limitation, not silently narrowed:** cancellation is
**cooperative between steps**, not preemptive mid-step. The accepted `Worker`
port (`src/ports/worker.ts`) has no abort channel in `WorkerRequest`, and
extending it would touch TASK-003-accepted `cliWorker.ts` beyond what this
task's "reuse existing invariants, don't broaden scope silently" instruction
comfortably allows. A `cancel()` issued while a real worker CLI process is
in-flight takes effect the moment that call returns (success or failure) —
the loop will not start a *further* step, but it cannot kill an
already-launched `claude`/`codex` child faster than that call itself
returns. This is proven directly in tests using a slow deterministic fake
worker (cancel requested mid-flight, loop settles to CANCELLED right after
the in-flight run naturally completes, no further run is launched, the
completed run's evidence is still preserved).

## 11. Telemetry

Every `LoopIterationRecord` plus the loop's top-level `implementer`/
`reviewer` config already captures, per the brief's §23 list: tool, model,
effort (via the stored `LoopWorkerConfig`), duration (derivable from the
bound `Run`'s `startedAt`/`finishedAt`, already durable via
`FactoryService.runWorker`), execution success/failure
(`implementerOutcome`), verification outcome (`verificationPassed`), review
outcome (`reviewVerdict`), and iteration number. No scoring/ranking is
computed — this task only needs the data to exist for a future Model Router
to read.

## 12. CLI surface

```
sf loop start <work-item-id> [--config <path-to-json>]
sf loop status <loop-id>
sf loop resume <loop-id>
sf loop cancel <loop-id>
```

`--config` points at a trusted local JSON file supplying
`implementer`/`reviewer`/`verificationCommands`/`workspace`/`budget` (never
inline shell-style parsing of untrusted strings into argv — the file's
`verificationCommands[].argv` are already a JSON array, so no shell splitting
ever happens). Omitting `--config` uses a small built-in default (Claude
Sonnet 5 implementer, a configurable-model Codex reviewer, `npm run
typecheck && npm test` as the two verification commands, 3 max iterations)
documented in `sf help`.

`sf loop status` prints exactly: phase, iteration/maxIterations, last
implementer run id + outcome, last verification result (pass/fail + which
commands failed), last review verdict, remaining budget, and whether human
action is required (`true` once phase is `WAITING_FOR_HUMAN`, `EXHAUSTED`, or
`FAILED`) — no raw transcripts, no secrets, matching the brief's explicit
`status` contract.

### 12a. Unattended execution policy

After an already-approved `READY` WorkItem starts a TASK-004 loop, routine
execution is unattended. The loop never asks a human to approve a test,
typecheck/build, local child process, deterministic verification, Claude/Codex
launch, remediation, re-review, or workspace inspection. Those permissions
are resolved before execution by trusted configuration and adapter policy:

- Claude Code uses `-p/--print`, structured JSON output, and a role-scoped
  `--permission-mode`; Codex uses `exec --json` with a role-scoped sandbox.
  Neither path uses a terminal approval prompt or an unrestricted global
  permission bypass.
- Deterministic verification uses trusted executable/argv configuration,
  `shell: false`, the approved workspace boundary, bounded timeouts, bounded
  output, and a default-deny environment allowlist. Model text cannot add a
  command or change these boundaries.
- The process runner closes stdin and enforces timeout/termination. If a child
  unexpectedly waits for interactive approval or otherwise fails to complete,
  the result is a bounded `FAILED`/`TIMEOUT` execution fact with safe evidence;
  the loop follows its existing remediation or fail-closed policy and does not
  wait for keyboard input.

Human interaction remains reserved for explicit governance or recovery gates:
`RECOVERY_REQUIRED`, release/main/merge approval, publish approval, and later
planning approval. TASK-004 never grants unrestricted host permissions and
never performs commit, push, merge, release, or publish actions autonomously.

## 13. Deterministic demo (`npm run demo:loop`)

Three scripted scenarios, entirely offline (deterministic scripted `Worker`
objects that record a `FACTORY_REVIEW_VERDICT:` tag exactly like a real
reviewer would, never a real CLI, never `node:child_process`):

1. implement → verify (pass) → review PASS → `WAITING_FOR_HUMAN`.
2. implement → verify (pass) → review CHANGES_REQUIRED → remediation →
   verify (pass) → review PASS → `WAITING_FOR_HUMAN`.
3. repeated CHANGES_REQUIRED past the configured budget → `EXHAUSTED`
   (+ `WorkItem` moved to `BLOCKED`).

## 14. Acceptance criteria

Restated from the task brief, mapped to what this design produces:

1. An approved (`READY`) `WorkItem` can start a loop; illegal states are
   rejected before any loop record is created.
2. `IMPLEMENTER` runs are launched automatically via
   `FactoryService.runWorker` — never inferred from prose.
3. Deterministic verification runs from trusted, argv-only configuration
   (`VerificationCommandConfig`), never invented shell text.
4. An independent `REVIEWER` run is launched automatically.
5. The reviewer verdict parser is strict/fail-closed (§6).
6. `CHANGES_REQUIRED` (or a parse failure) automatically triggers
   remediation, budget permitting.
7. Verification and review both repeat after remediation.
8. `PASS`/`PASS_WITH_NON_BLOCKING_NOTES` both advance to
   `WAITING_FOR_HUMAN`.
9. Iteration/wall-clock/run-count budgets stop infinite loops (§9).
10. Loop state is durably persisted (own SQLite file) and resumable (§8).
11. Crash/restart does not duplicate a step that already completed and was
    recorded (§8, proven by fault-injection tests, not real process kills).
12. Cancellation is durable and safe, documented as cooperative (§10).
13. Implementer/reviewer principals are always two distinct registry-issued
    principals (§3); the existing C4 check is the enforcement point.
14. A `FAILED` worker run (non-zero exit, timeout, spawn error) is never
    treated as review approval — the parser is only ever reached for a
    `SUCCEEDED` reviewer run (§6).
15. No `src/domain/`, `src/workflow/`, or `src/app/factoryService.ts`
    invariant is touched.
16. All new automated tests/demos use deterministic fakes; `npm test` never
    shells out to `claude`/`codex`.
17. No path in this task ever calls `git commit`/`push`/`merge`, and worker
    prompts explicitly prohibit them (reusing the existing
    `scopeStatement`/`allowCommit=false` default from `promptTemplates.ts`
    via the composed `instructions` text).
18. Telemetry fields listed in §11 are recorded per attempt.
19. `sf loop status` exposes exactly the safe fields listed in §12.
20. TASK-005 (planning) is not implemented.
21. Once a `READY` WorkItem enters the loop, routine execution is genuinely
    unattended: trusted non-interactive worker modes, predetermined bounded
    process/workspace/environment policy, and argv-only verification permit
    implementation, verification, review, and remediation without keyboard
    approval; an unexpected interactive prompt fails closed as a bounded
    execution failure, while human interaction remains only at explicit
    governance/recovery gates (§12a).

## 15a. Implementation addenda (found during build, not foreseeable from design alone)

- **`save()` retries on a losing CAS, reapplying the same patch.** A race
  between `cancel()` writing `cancelRequested` and an in-flight `drive()`
  step writing its own field on the *same* loop row (same process, or two
  processes sharing the SQLite file) would otherwise surface as
  `ConcurrencyError`, which `drive()`'s outer catch would misreport as a
  loop-level `FAILED` — turning a completely ordinary cancellation race into
  a false failure. Every patch any step ever applies touches only the fields
  that step decided to change, so re-reading the current row and reapplying
  the same patch on top of it (bounded to 5 attempts) is always safe and
  correct here, never a lost update. Proven by
  `tests/engineeringLoopService.test.ts`'s cancellation-race test.
- **`--config` requires `workspace` and `taskInstructions`.** These have no
  safe generic default (a workspace path and a task's own instructions are
  inherently per-run). Only `implementer`/`reviewer`/`verificationCommands`/
  `budget` fall back to the built-in default described in §12 when the
  config file omits them.
- **Evidence and `Run.summary` are two views of the same text — the reviewer
  parser must not pool both.** `cliWorker.ts` derives `Run.summary` as a
  truncated copy of the same message its transcript Evidence already carries
  in full; pooling both as separate "source texts" into
  `parseReviewVerdict` counts one real verdict tag twice and misreports
  ambiguity. The fix: prefer Evidence texts alone when any exist, and fall
  back to `Run.summary` only when a worker recorded no evidence at all.

## 15. Explicit non-goals / deferred follow-ups

- Preemptive (mid-call) cancellation of a real worker subprocess — would
  require additively extending `src/ports/worker.ts` and
  `src/adapters/workers/cliWorker.ts`; deferred rather than done silently
  (§10).
- Sharing one SQLite connection between `FactoryStore` and the loop
  repository — two independent files instead (§5); revisit only if a real
  cross-store atomicity requirement appears.
- A scored/benchmarked model router — TASK-004 only records the telemetry a
  future router would need (§11).

---

# Remediation Round 1 — The Crash-Safe Action Protocol

The independent Codex review (2026-08-20, preserved verbatim in
`AI-HANDOFF.md`) returned CHANGES_REQUIRED with six reproducible HIGH
findings against the design above: cross-database crash windows duplicating
completed Runs, loops.db trusting valid-JSON corruption, malformed CLI
output reaching the verdict parser through the raw-stdout fallback,
verification cwd escaping the workspace, unclaimed start/resume concurrency,
and a cancel/launch race. These are one root problem seen from six angles —
external side effects had no durable identity, so nothing could be claimed
before it happened or reconciled after a crash — and this section replaces
the affected parts of §5/§8/§10 with one coherent protocol. All sixteen
reviewer reproductions live permanently in
`tests/remediationRound1Repro.test.ts`; each failed against the pre-fix
implementation before any fix was written.

## R1. Action identity (PART A)

Every external worker launch is a **claimed action** persisted on the loop
row via CAS BEFORE the side effect starts:

```ts
interface WorkerActionClaim {
  actionId: string;            // stable, loop-scoped
  kind: "IMPLEMENT" | "VERIFY" | "REVIEW";
  attempt: number;             // >= 1; bumped only by crashed-owner takeover
  ownerToken: string;          // identifies the drive() invocation that owns the launch
  claimedAt: Timestamp;
  correlationTag: string;      // `sf-loop:<loopId>:<actionId>:a<attempt>`
  recovered?: boolean;         // completion adopted by reconciliation, not observed in-process (telemetry)
  supersededRunIds?: RunId[];  // FAILED runs of superseded attempts — audit only, never counted
}
```

Each `LoopIterationRecord` carries up to three worker claims
(`implementClaim`/`verifyClaim`/`reviewClaim`) plus two review-record claims
(`deterministicReviewClaim`/`semanticReviewClaim` — `{ownerToken, claimedAt}`)
for the two `recordReview` side effects. Completion fields
(`implementerRunId`/`implementerOutcome`, `verificationRunId`/results,
`reviewerRunId`, `verificationReviewId`+`verificationPassed`,
`reviewVerdict`+`reviewRecordId`) are written only downstream of their claim;
the validator (§R6) rejects any row where an artifact exists without its
claim. The two WorkItem transitions the loop performs
(TRANSITION_TO_HUMAN_GATE, BLOCK_ON_EXHAUSTION) need no journal claim: the
WorkItem's own status is their durable, authoritative record, and every
transition step observes it idempotently ("advance only if still at X, accept
if already at Y") — the loop phase is never the evidence for what happened.

## R2. Correlation (PART C)

The claim's `correlationTag` becomes the launched Worker object's `id`,
which `FactoryService.runWorker` durably records as the Run's
`declaredWorkerId` in PHASE 1 — before execution. Reconciliation matches
Runs to actions by exact tag equality (plus a role cross-check), never by
role/latest/title/model/timestamp. The tag is constructed by the
orchestrator and carried through a trusted, Factory-persisted field a model
cannot influence; it is used ONLY for idempotent correlation —
`declaredWorkerId` remains non-authority for every trust decision (C4 still
compares registry-issued principals; nothing about gates changed). Review
recordings correlate through the new read-only
`FactoryService.listReviews(workItemId)` (the round's one accepted-core API
addition, mirroring `listRuns`/`listEvidence`) matched by exact
`reviewerRunId`. A thrown `WorkerExecutionError`'s FAILED run is likewise
recovered by exact tag, replacing the previous latest-run guess.

## R3. Reconciliation matrix (PART B) — evaluated before budgets and before any new claim

For the last iteration's incomplete claim (claim present, completion absent),
querying authoritative Factory state by tag:

| Factory state for the current attempt's tag | resolution |
|---|---|
| no Run at all, claim owned by this drive() | fresh claim — launch it (exactly once) |
| no Run at all, claim owned by another token | crashed-owner takeover: CAS re-claim with `attempt+1` and a new tag, then launch exactly once |
| one Run, terminal | ADOPT: record completion (marked `recovered`, counted once), never relaunch |
| one Run, RUNNING | RECOVERY_REQUIRED (fail closed — PART Q, below) |
| multiple Runs for one tag | RECOVERY_REQUIRED (impossible under the protocol → treat as corruption) |
| any superseded-attempt Run that is RUNNING or SUCCEEDED | RECOVERY_REQUIRED (possible duplicated external work, detected post-hoc) |
| superseded-attempt Runs all FAILED | recorded in `supersededRunIds`, otherwise ignored |

Review-record claims reconcile the same way through `listReviews`: an
existing Review with the action's exact `reviewerRunId` is adopted (id and —
for the semantic case — its verdict, since Factory is authoritative);
otherwise the recording proceeds under the claim. The brief's seven windows
map directly: (1) intent persisted/crash pre-PHASE 1 → takeover relaunch,
exactly once; (2) RUNNING Run/loop stale → RECOVERY_REQUIRED, no
replacement; (3) terminal Run/loop stale → adopt; (4) Review persisted/loop
stale → adopt; (5–6) PASS authoritative or WorkItem already
WAITING_FOR_HUMAN → loop reconciles forward without another reviewer call
(the observe-idempotent transition steps); (7) EXHAUSTED durable/BLOCKED
missing → `reconcileTerminal` finishes the transition with zero worker
spend. Proven by `tests/remediationRound1Repro.test.ts` (R1–R3) plus
`tests/loopReconciliationMatrix.test.ts` (M-A/D/F/H/J/K) plus the reworked
A–E cases in `tests/engineeringLoopService.test.ts`.

## R4. Claims, concurrency, cancellation (PARTS D/E/F)

**One linearization point.** Every loop mutation is a CAS on the single
row's `version`. Two write disciplines exist, and the distinction is the
core of the fix:

- **strict writes** (claims, phase changes, iteration opens): one CAS, no
  retry. A lost CAS means someone else moved the loop — re-read once; if
  cancellation/terminality won, handle it; otherwise another live process is
  driving, so back off and return. (Round 1's blanket retry-and-reapply
  `save()` was itself the cancel/launch race: it re-applied a stale claim on
  top of a committed cancellation. Removed.)
- **fact writes** (completions of already-authorized launches, cancellation
  intent, terminal outcomes): bounded re-read-and-merge, touching only the
  fields the fact owns — the loop-side analog of `runWorker`'s PHASE 3
  "completing the audit record of authorized work is not new production
  state". A completion may land on a loop that went CANCELLED or
  RECOVERY_REQUIRED mid-flight; it never changes phase and never counts a
  superseded attempt.

**Start uniqueness (PART E)** is a persistence-level constraint, not
check-then-insert: SQLite enforces a partial UNIQUE index over
`work_item_id` restricted to the four active phases (validated structurally
at open, §R6); the in-memory adapter enforces the same rule inside its
synchronous (yield-free, therefore atomic) `create()`. A losing concurrent
`start()` fails at `create()` with `ConcurrencyError`, before any drive
step, so nothing launches from it.

**Cancellation (PART F).** `cancel()` writes `cancelRequested` as a fact
(durable immediately from the caller's perspective), then finalizes
CANCELLED. The ordering with a launch is decided by the row version: if
cancel commits first, the stale claim CAS loses and nothing launches (the
exact interleaving is pinned deterministically in repro R10 via a
read-snapshot hook); if the claim commits first, the launch is authorized
and may finish (TASK-003 workers expose no mid-call abort), but every
subsequent action sees `cancelRequested`. As a second layer, the launched
Worker is wrapped in a **pre-flight guard** that re-reads the durable loop
row inside `execute()` — after PHASE 1, before any process could spawn — and
aborts with an honest FAILED outcome (zero external side effects) if
cancellation committed, the loop went terminal, or action ownership was
lost.

**Stale-claim recovery (PART D)** is non-expiring-claim + explicit
reconciliation, exactly the simpler shape the brief suggested: no lease
timers, no heartbeats, so a legitimately slow AI worker can never be
"expired" into a duplicate. Takeover happens only for a claim with no
PHASE 1 Run; ownership is re-verified by the pre-flight guard at the last
moment; and the one residual interleaving (an alive-but-stalled prior owner
spawning inside the microseconds between its own guard check and takeover)
is detected post-hoc by the superseded-run rule and fails closed to
RECOVERY_REQUIRED rather than being silently double-counted. Documented
honestly: exactly-once under arbitrary live-process interleavings is
impossible without process fencing; the protocol's guarantee is
exactly-once-or-fail-closed-and-say-so.

## R5. Unknown in-flight work (PART Q)

A Run durably RUNNING whose owning process died is unprovable: the loop
enters **RECOVERY_REQUIRED** — a terminal phase requiring the human — with
the WorkItem best-effort moved to BLOCKED. It is never marked SUCCEEDED,
never treated as absent, and no equivalent worker is launched under the same
action. Two existing domain facts make this fail-closed compose: the RUNNING
run keeps the release snapshot unresolvable (TASK-001), and `RunRepository`
has no way to rewrite it. The known cost, accepted deliberately: `resume()`
while another live process has a worker mid-flight also lands here (the two
situations are indistinguishable without liveness), so concurrent resumes
against a healthy loop are documented operator misuse the system answers
safely rather than cleverly.

## R6. loops.db trust standard (PARTS G/H)

`src/orchestration/loopSerialization.ts` replaces the shallow decode:
every field the state machine branches on is validated on read — shapes,
enums (phase/outcome/verdict/exhaustion-kind/tool/action-kind), positive-int
versions and budgets, non-negative integer timestamps with
`startedAt <= lastTransitionAt`, strict 1..n iteration numbering, claim
coherence (no artifact without its upstream claim, no verdict without its
reviewer run, verdict+reviewRecordId atomic), terminal coherence (outcome
must equal a terminal phase; active loops carry no terminal fields;
CANCELLED requires `cancelRequested`; WAITING_FOR_HUMAN requires an
authoritative passing review reference; EXHAUSTED requires an
`exhaustionKind` its stored numbers actually support), and
`totalRunCount === completed claimed-action runs`. Every duplicated SQL
column (`id`, `work_item_id`, `phase`, `version`) is cross-checked against
the JSON payload; any divergence or violation throws
`PersistenceCorruptionError`, so a corrupted row can never launch a worker —
`resume()` dies at `findById`. Schema integrity mirrors TASK-002's lesson:
on open, every table/column/PK and every index correctness relies on —
including the partial unique active-loop index, checked for uniqueness AND
partial-ness AND columns — is validated structurally; a version marker alone
proves nothing, nothing is silently repaired, and a non-empty non-loops
database is refused. (`loop_schema_version` is now 2; version 1 never
shipped in a commit.)

## R7. Reviewer structured-output boundary (PART I)

`cliWorker.ts` now separates the channels the review verdict may come from:
`.../transcript` evidence exists ONLY when the adapter's structured parser
(Claude's one-JSON-object contract, Codex's JSONL contract) actually
recovered the tool's answer; when it recovered nothing, the bounded,
redacted raw stdout/stderr goes to `.../raw-output`, explicitly labeled
"diagnostic only". The loop parses verdicts exclusively from `/transcript`
evidence of the reviewer's run — the `Run.summary` fallback is gone, and a
clean-exiting process that violated its structured contract while printing
`FACTORY_REVIEW_VERDICT: PASS` in plain text now yields "no structured
reviewer output" → fail-closed remediation (repro R6). A FAILED process
never reaches the parser at all, unchanged. Reference strings are
adapter-authored code, not model text, so the channel cannot be forged from
inside a transcript.

## R8. Verification cwd containment (PART J)

`resolveContainedCwd(workspace, cwd)` confines every configured cwd to
**`workspace.root`** — the narrower approved execution workspace TASK-003
launches workers in; `repositoryRoot` may be broader and nothing in the
accepted contract authorizes executing outside the configured subdirectory.
Real (symlink-resolved) paths on both sides; rejected: `../` escapes,
absolute outside paths, symlinks pointing out (including one created after
loop start — the check runs at `start()` AND again per command at execution
time), nonexistent paths, non-directories, and lexical prefix cousins
(`workspace-evil` vs `workspace`). Paths with spaces are fine; no shell
exists anywhere in the chain. A start-time violation rejects before a loop
row exists; an execution-time violation throws, which now fails the loop
closed (`FAILED`) rather than remediating — a harness/config problem is not
something another model attempt can fix (this supersedes §4's "remediate on
harness failure").

## R9. Budgets, telemetry (PARTS O/P)

Reconciliation runs before the budget check, so an adopted completion is
counted (once) before anything new may launch; an adopted Run never opens an
iteration, never increments `totalRunCount` twice (`M-H` pins
`totalRunCount === 6` for a 2-iteration loop with one recovered run), and
persisted exhaustion — now carrying an explicit `exhaustionKind` — survives
restart with zero further launches (`M-K`). Telemetry per attempt keeps
tool/model/effort (loop config), duration/outcome (the bound Run),
verification and review outcomes, and iteration number, plus
`recovered: true` marking adoptions as not-fresh-model-calls; no raw
transcripts enter loop rows.

## R10. What did NOT change (PART R)

No FactoryService write path, no domain rule, no workflow
table/precondition/gate, no persistence adapter of factory.db, no worker
adapter invocation shape (`cliWorker.ts` changed only evidence labeling of
already-captured output), no TASK-001/002/003 test. The accepted-core delta
of this round is exactly: `FactoryService.listReviews` (read-only),
`createRandomIdGenerator` in `src/domain/ids.ts` (the CLI previously minted
colliding sequential ids across OS processes — a real defect this round's
multi-process tests exposed), and the `cliWorker.ts` evidence-channel split.

---

# Remediation Round 2 — Canonical Action Identity + Predicate-Aware Schema Validation

The independent Codex re-review (preserved verbatim in `AI-HANDOFF.md`)
found round 1's action-claim protocol architecturally sound but two of its
trust boundaries incomplete:

**HIGH 1.** `sqliteLoopRepository`'s schema validation checked the active-
loop partial unique index's name, uniqueness, partial-ness, and indexed
columns — but never its WHERE predicate. `PRAGMA index_list`/`index_info`
can prove an index is a unique partial index over `work_item_id`; they
cannot show *which phases* it restricts to. A semantically wrong predicate
(one phase omitted, an inverted condition, an unrelated clause) would pass
every structural check while silently permitting more than one active loop
per work item.

**HIGH 2.** `actionId` was minted via `ids.next("act")` — an opaque,
orchestrator-random token with no relationship to the claim's own position
in the loop. `loopSerialization.ts` validated that a claim's `actionId`/
`correlationTag` were *present and non-empty strings*, not that they were
the *correct* ones for that claim's (loop, iteration, kind) — so a corrupted
row could set a claim's identity to literally any string, including one
copied from an older, unrelated, already-terminal Run's real
`declaredWorkerId`. Reconciliation's exact-tag lookup would then find that
Run and adopt it as the current action's completion.

## S1. Canonical action identity — the actual fix

`src/orchestration/loopTypes.ts` now derives `actionId` deterministically:

```ts
canonicalActionId(loopId, iteration, kind) = `${loopId}:i${iteration}:${kind}`
correlationTag(actionId, attempt)          = `sf-loop:${actionId}:a${attempt}`
```

This is the **single, canonical function** used by every location that
needs an action identity — action creation (`claimIfNeeded` in
`engineeringLoopService.ts` now calls `canonicalActionId(...)` directly,
`ids.next("act")` is gone from that path entirely), persistence validation
(`loopSerialization.ts` recomputes and requires an exact match — see S2),
reconciliation (unchanged: still an exact-tag lookup, now against a value
that can no longer be forged), and worker correlation (`guardedWorker`'s
`id: claim.correlationTag`, unchanged).

The tuple `(loopId, iteration, kind)` is injective by construction:
`iteration` is validated elsewhere to be a strictly-1..n-ordered positive
integer with no duplicates/gaps, `kind` is one of three fixed uppercase
literals, and the string format itself is unambiguous (digits vs. letters).
No two claims — across any iteration, any kind, any loop — can ever share a
canonical `actionId`. `attempt` lives in the *tag*, not the *actionId*: a
takeover retry of the same logical action keeps its `actionId` (it is the
same action) but gets a new tag (`:a2` vs `:a1`), so a superseded attempt's
Run can never satisfy the current attempt's exact-tag lookup — this is what
makes PART 9's requirement ("attempt N+1 cannot reconcile against attempt
N") fall out of the design rather than needing a separate rule.

A genuine bug was caught while wiring this up: `correlationTag`'s original
signature took a separate `loopId` parameter, which — now that `actionId`
itself embeds the loop id — caused the loop id to appear twice in every tag
(`sf-loop:loop-x:loop-x:i1:IMPLEMENT:a1`). Harmless (still injective, still
correct), but sloppy; fixed by dropping the redundant parameter
(`correlationTag(actionId, attempt)`, `correlationPrefix(actionId)`).

## S2. Persistence-layer validation (PART 2/3/6)

`loopSerialization.ts` adds `validateCanonicalClaim(claim, loopId, iteration,
kind, ctx)`: for every `implementClaim`/`verifyClaim`/`reviewClaim` it
parses, it **recomputes** the expected `actionId` and `correlationTag` from
the claim's own position (the loop id already SQL/JSON-cross-checked, the
iteration index it was parsed at, the kind fixed by which field it came
from) and throws `PersistenceCorruptionError` on any deviation. This runs as
part of `parseIteration`, strictly before `parseEngineeringLoop` returns —
matching PART 6's required ordering exactly: parse → full structural
validation → canonical identity validation → SQL/JSON cross-check → only
then is an `EngineeringLoop` ever handed to `engineeringLoopService`, which
is therefore never responsible for detecting this class of corruption itself
(PART 6's explicit instruction).

PART 4's "reject duplicate actionId/correlationTag" requirement is satisfied
structurally rather than by a separate duplicate-scanning pass: since
canonical derivation makes two claims sharing an identity impossible unless
at least one of them is already non-canonical for its own position, the
per-claim canonical check alone rejects every duplicate-identity row (proven
directly — see the G/H regression, which constructs exactly this and
confirms rejection). No redundant Set-based scan was added; PART 11 asked to
keep the remediation small, and an emergent, provably-total guarantee is
smaller and more trustworthy than a second bookkeeping structure that could
itself drift out of sync with the first.

## S3. Defense in depth: completed-slot consistency (beyond the literal ask)

The Phase-0 recipe in the brief specifically corrupts an *incomplete* claim
(no run id yet) to make reconciliation's lookup adopt an old Run — S2 closes
exactly that. A related but distinct corruption is possible in principle:
directly overwriting an *already-completed* slot's `implementerRunId`/
`verificationRunId`/`reviewerRunId` field to an arbitrary existing run id,
leaving its claim's `actionId`/`correlationTag` untouched (and therefore
still canonical). `loopSerialization.ts` cannot catch this on its own — it
has no Factory access, so it cannot know whether a stored run id's real
`declaredWorkerId` matches the claim next to it.

`engineeringLoopService.reconcile()` now closes this gap too: for every
slot that already has a completion recorded, every reconciliation pass
looks up that exact run id in the (already-fetched) Factory run list and
requires `run.declaredWorkerId === claim.correlationTag`; any mismatch —
including the run simply not existing — routes to `RECOVERY_REQUIRED`
rather than being trusted. This was judged worth adding proactively (PART 5
asks for defense against old-Run adoption broadly, and a thorough re-review
would very plausibly test this exact variant) while staying inside PART 11's
"keep it small": it is one `find` + one comparison per slot per
reconciliation pass, reusing a `listRuns` call reconciliation already needed
to make.

## S4. Active-index predicate validation (PART 1)

`sqliteLoopRepository.ts` adds `validateActiveIndexPredicateSql(sql,
indexName, requiredPhases)` — a small, hand-written parser scoped to
exactly one predicate shape (`phase IN ('P1', 'P2', ...)`), deliberately not
a general SQL parser (explicit instruction). It reads the index's *actual
declared SQL text* from `sqlite_master.sql` (SQLite stores DDL verbatim, not
re-serialized — confirmed by direct experiment, not assumed), extracts the
`WHERE` clause, and compares the referenced phase set against
`ACTIVE_LOOP_PHASES` as a **set**, so entry order and whitespace/quote
spacing never matter, while every one of the seven required cases
(exact-match, formatting-variant, missing-WHERE, inverted, one-phase-
omitted, terminal-phase-included, unrelated-clause) is exercised directly as
a pure-function unit test with no database needed. Wired into schema
validation as an additional check on the existing `idx_engineering_loops_active`
entry (a new optional `requiredWherePhases` field on `ExpectedIndex`),
running only after the index's name/uniqueness/partial-ness/columns already
passed structural validation — so a malformed predicate is now
`SchemaIntegrityError` before the repository is usable at all, and (per PART
10) this is pure read-only introspection: no DDL runs, nothing is repaired,
an incompatible database is refused outright.

The set comparison is an explicit narrow policy: duplicate phase literals are
accepted only when they remain semantically equivalent to the exact required
active-phase set; they cannot add coverage or remove coverage. Any other
logical expression, extra condition, comment/parenthesized wrapper, inverted
operator, non-literal, or unrelated literal is rejected rather than being
accepted because an incidental literal scan happened to find the right names.

## S5. Phase 0 — reproduced before fixing, confirmed fixed after

Both fixes were **temporarily disabled in place** (the predicate-check call
site and the three `validateCanonicalClaim` call sites commented out, with a
`void` no-op to keep the build green) and the full round-2 regression suite
(`tests/remediationRound2Repro.test.ts`, 18 tests) was run against that
pre-fix state:

```
# tests 18
# pass 8
# fail 10
```

The 8 passes are the 7 standalone unit tests of the predicate *parser*
function itself (untouched by disabling its *call site*) plus one unrelated
schema-round-trip sanity check; every test that actually exercises the
disabled protections — both index-wiring tests, the semantic-harm
demonstration, all six correlation-identity tests, and the full end-to-end
PART 7 reproduction — failed, proving each closes a real gap. The two fixes
were then restored exactly (diffed against source control to confirm no
residual left in place) and the same suite was re-run: **18/18 pass**. Two
of the correlation tests (`I`, `G/H`) initially "passed" pre-fix for the
wrong reason — an unrelated round-1 `totalRunCount`-coherence rule
incidentally caught the malformed fixture before the (disabled) identity
check ever ran; both fixtures were corrected to isolate the property under
test, and the pre-fix run was repeated to confirm they then failed for the
right reason before being counted as valid regressions.

## S6. What did NOT change

No further FactoryService write path, no domain rule, no workflow
table/precondition/gate. The claim/reconciliation architecture from round 1
is unchanged in shape — this round replaced *how an identity is minted and
validated*, not the protocol around it. `EngineeringLoopServiceDeps` gained
nothing; `guardedWorker`, `launchClaimedWorker`, `recordWorkerCompletion`,
`remediateOrExhaust`, `finalize`, cancellation linearization, and budget
enforcement are all untouched.

# Remediation Round 3 — Trusted-Human Cancellation + Re-derived WAITING_FOR_HUMAN Authority

The final independent review (Codex CLI, GPT-5.6 Luna, reasoning effort
Extra High) returned **CHANGES_REQUIRED** with exactly two reproducible HIGH
findings. Both prior remediation rounds' eight HIGH findings were confirmed
still closed. This round closes only these two blockers; the three
non-blocking notes were deliberately left for a later change (see U4).

## U1. HIGH 1 — Untrusted loop cancellation

**Root cause.** `EngineeringLoopService.cancel(loopId, actor)` accepted an
arbitrary `Actor` and durably cancelled the loop after only checking the phase
was non-terminal. The CLI (`src/cli/loop.ts`) passed a plain
`human("user:cli-operator", …)` object with no proof of identity. `Actor` is
untrusted caller data (see `src/domain/humanIdentity.ts`): any code — an AGENT
worker included — can construct `{ kind: "HUMAN", … }`. Cancellation is a
governance operation (constitution C1), yet it bypassed the trusted-human
boundary that already guards every WorkItem cancellation
(`WorkflowService.verifyHumanAuthorization`) and every protected approval
(`FactoryService.recordApproval`). Reproduced live: an `AGENT` actor durably
cancelled a healthy IMPLEMENTING loop.

**Design.** Reuse the accepted TASK-001 mechanism verbatim — no parallel or
weaker identity system. A new read-only `FactoryService.verifyHumanAuthorization(actor, authorization)`
composes the existing `HumanIdentityGate.verify` (the same gate that mints
tokens and that `recordApproval`/`WorkflowService` already call), returning a
reason string or `undefined`. `EngineeringLoopService.cancel(loopId, actor,
authorization?)` now calls it **first**, before any durable read or write, and
throws `HumanIdentityError` on any failure. A caller-made `{ kind: "HUMAN" }`,
an AGENT/SYSTEM actor, a forged/expired/mismatched token — all refused with no
phase change, no version bump, no worker-suppression side effect. The loop
service never receives the credential or a reference to the gate; it asks the
Factory Core, which is the single authority. The CLI's `sf loop cancel` now
mints a `TrustedHumanToken` from the same local gate (`factory.authorizeHuman`)
and presents it — the interactive operator's own governance action, not a
routine unattended step.

## U2. HIGH 2 — Cached WAITING_FOR_HUMAN authority bypass

**Root cause.** A persisted loop's `phase = WAITING_FOR_HUMAN` and its last
iteration's cached `reviewVerdict = PASS` / `reviewRecordId` were treated as
authority. `drive()` returned a terminal WAITING_FOR_HUMAN loop after only
`reconcileTerminal` (which did nothing for that phase), and `stepReviewing`
accepted a cached PASS when the WorkItem was already WAITING_FOR_HUMAN without
re-consulting the Factory. A syntactically valid SQLite loop row (passing the
full strict `loopSerialization` parse) that referenced a nonexistent
review/run — even for a work item that never existed — resumed to
WAITING_FOR_HUMAN with **zero** authoritative Factory reads and zero worker
construction.

**Design.** The Factory Core stays authoritative; the loop asks it to prove
authority rather than reimplementing any rule. A new read-only
`FactoryService.resolveWaitingForHumanAuthority(workItemId)` composes the
**existing accepted** `resolveSemanticReview` resolver — the very lineage the
`REVIEW -> WAITING_FOR_HUMAN` precondition (`requireIndependentSemanticReview`)
enforces: current implementation at the current spec revision, its current
passing deterministic verification with evidence, and an independent, passing
semantic review of that exact implementation by a distinct principal, with any
newer attempt or blocking review superseding it. Before the loop exposes or
accepts a WAITING_FOR_HUMAN outcome from a reloaded row it calls this; on
`ok:false` it fails closed via `failClosedToRecovery` (a new demotion that is
the one path allowed to move a WAITING_FOR_HUMAN loop out of its terminal
phase, since `finalize` refuses to touch any terminal loop) to
`RECOVERY_REQUIRED`, launching zero new worker/model work. The fresh
`REVIEW -> WAITING_FOR_HUMAN` advance path is unchanged — `factory.advance`
already re-derives that authority through the same resolver.

Category chosen: **RECOVERY_REQUIRED**, not `PersistenceCorruptionError`. The
row is structurally valid (it is not corrupt data the parser can reject); its
*authority* simply cannot be proven after reload — a recovery condition,
human-actionable, exactly like an unprovable in-flight run. Legitimate crash
recovery is preserved: the existing `engineeringLoopService` crash/resume
"case E" (reviewer PASS persisted, crash before the WAITING transition, item
already WAITING_FOR_HUMAN) still reconciles forward because its lineage is
genuinely current, and a valid persisted WAITING_FOR_HUMAN resumes with no
duplicate reviewer/model call.

## U3. Pre-fix reproduction, then confirmed fixed

Before writing the fix, both findings were reproduced against a fresh build of
the pre-fix checkpoint (HEAD `126157d`) with standalone scripts driving the
real compiled service:

- **HIGH 1:** an `AGENT` actor's `cancel()` was ACCEPTED — durable loop phase
  `CANCELLED`, `cancelRequested=true`. After the fix: AGENT, SYSTEM, and a
  tokenless HUMAN are each refused with `HUMAN_IDENTITY`; the loop proceeds to
  WAITING_FOR_HUMAN normally.
- **HIGH 2:** a fabricated valid-serialization WAITING_FOR_HUMAN loop for an
  absent work item RETURNED phase `WAITING_FOR_HUMAN` with
  `{getWorkItem:0,listRuns:0,listReviews:0,…}` (zero authoritative reads) and
  zero workers constructed. After the fix: the same row resumes to
  `RECOVERY_REQUIRED`, still constructing zero workers.

Permanent regressions live in `tests/remediationRound3Repro.test.ts` (19
tests): HIGH 1 cases A–J (AGENT/SYSTEM/tokenless-HUMAN/forged/other-human/
expired refused; valid human accepted; refused attempt leaves phase+version
unchanged; cancel-before-launch still yields zero children; the CLI path
supplies a valid token end to end) and HIGH 2 cases (absent work item;
superseding implementation; bumped spec revision; non-independent reviewer;
superseding FAIL deterministic review; work item not at REVIEW/WAITING; valid
resume with no duplicate call and no budget double-count; stale-REVIEWING
reconcile with valid lineage and zero extra reviewer calls). Each fail-closed
case asserts zero worker/model construction.

## U4. Deferred non-blocking notes (NOT fixed this round, by instruction)

1. `LoopBudget.workerTimeoutMs` is defined but not threaded from
   `EngineeringLoopService` into the worker factory (the factory uses its own
   default). 2. Verification evidence redacts command output but not the
   executable/argv label. 3. The general worker workspace launch path has
   weaker realpath timing than the verification worker's per-command check.
   These are tracked for a future round and were explicitly out of scope here.

## U5. What did NOT change

No workflow transition, gate, precondition, or domain rule was weakened or
added. The two new `FactoryService` methods are read-only and compose existing
accepted helpers (`identityGate.verify`, `resolveSemanticReview`). The
claim/reconciliation protocol, `guardedWorker`, `launchClaimedWorker`,
`recordWorkerCompletion`, budget enforcement, and the unattended-execution
invariant are untouched — the trusted-human requirement applies only to the
explicit `cancel()` governance operation and introduces no approval prompt
into implement → verify → review → remediate → re-review.

# Remediation Round 4 — Read-Path Authority + Review Revision Lineage

The independent Codex re-review (GPT-5.6 Luna, Extra High) confirmed **both
round-3 blockers CLOSED** and all eight earlier HIGH findings still closed, but
returned **CHANGES_REQUIRED** with two NEW reproducible HIGH findings. This
round closes only those two. The three deferred non-blocking notes stay
deferred (see V6).

## V1. HIGH 1 — `status()` could expose cached WAITING_FOR_HUMAN authority

**Root cause.** Round 3 hardened the *drive* paths (`drive()`'s terminal
early-returns and `stepReviewing`'s already-WAITING branch) but
`EngineeringLoopService.status()` was still literally
`return this.requireLoop(loopId)`. `WAITING_FOR_HUMAN` is an authority RESULT,
not a display state: any read client — `sf loop status`, a future UI, Telegram
layer, Control Room, or orchestration client — would treat a stale or corrupted
checkpoint as a live human/release gate. Reproduced: a strictly-valid persisted
row for a work item that never existed returned `phase=WAITING_FOR_HUMAN` from
`status()`.

**Design (read-only, fail closed).** `status()` keeps its read-only contract.
When the persisted phase is `WAITING_FOR_HUMAN` it calls the SAME round-3
resolver (`FactoryService.resolveWaitingForHumanAuthority`) — never a second,
weaker copy of the lineage rules. If authority is currently provable the loop is
returned unchanged; if not, `status()` returns a **non-persisted**
`RECOVERY_REQUIRED` projection (phase + outcome + explanatory `failureReason`).
Nothing durable is touched: no loop version bump, no WorkItem change, no
Run/Review/Evidence, no budget consumption, no worker construction. Durably
demoting the invalid cached authority remains `resume()`/`drive()`'s job via
`failClosedToRecovery` — reading a loop must never be what changes it. The
public surface was audited end to end: `start()`, `resume()`, `status()`,
`cancel()` are the only external entry points, and `toStatusView` is a pure
projection over whatever those return, so guarding them covers every exposure
path (including the CLI, which calls exactly these).

## V2. HIGH 2 — a Review's own `specRevision` was not part of lineage authority

**Root cause.** `resolveVerification()` and `resolveSemanticReview()` filtered
reviews by `kind` and `reviewedRunId` only. Runs were revision-checked; Review
records were not — even though a `Review` carries its own `specRevision`, stamped
by `recordReview` at record time. So an off-revision Review could be selected as
*the authoritative* record. Two harms, both reproduced: (a) an off-revision PASS
could authorize (the resolver returned `ok:true` naming reviews stamped
`specRevision: 999`), and worse (b) a later off-revision PASS could **mask a
current-revision blocking review** (`CHANGES_REQUESTED`), turning a real current
failure into an apparent pass.

**Design (smallest central fix).** The review's own revision became part of
*applicability* in the lowest shared resolver
(`src/workflow/releaseSnapshotResolver.ts`), adding
`review.specRevision === item.specRevision` to both filters. Filtering — rather
than inspecting the latest record and then rejecting it — is what makes an
off-revision review unable to authorize AND unable to mask: it is invisible,
exactly like the older criterion-verification generations already are in
`resolveReleaseSnapshot`. Because every authority consumer composes these two
functions, one edit fixes them all: `requireSuccessfulVerification`,
`requireIndependentSemanticReview` (so `VERIFYING -> REVIEW` and
`REVIEW -> WAITING_FOR_HUMAN`), `resolveReleaseSnapshot` (release authority),
and the round-3 `resolveWaitingForHumanAuthority` (loop resume/status). No
isolated revision check was added inside `EngineeringLoopService`. Newest-
generation semantics are preserved: a current-revision record still supersedes
earlier ones, and a current-revision FAIL still supersedes an earlier PASS.

The full lineage now requires one coherent revision across: WorkItem,
IMPLEMENTER run, VERIFIER run, DETERMINISTIC review, REVIEWER run, SEMANTIC
review.

## V3. Pre-fix reproduction, then confirmed fixed

Against the round-3 working tree (before any round-4 edit):

- **HIGH 1:** `status()` on a fabricated valid-serialization loop returned
  `phase=WAITING_FOR_HUMAN outcome=WAITING_FOR_HUMAN` (and `toStatusView` showed
  the same). After the fix: `RECOVERY_REQUIRED`, with the durable row left
  untouched at `WAITING_FOR_HUMAN`.
- **HIGH 2 form 1:** with reviews stamped `specRevision: 999` present, the
  resolver returned `{"ok":true,"deterministic":"rev-wrong-det",…,"semantic":"rev-wrong-sem",…}`
  — off-revision records selected as authoritative. After the fix it selects the
  genuine current-revision records (`rev-0001`/`rev-0002`, revision 1).
- **HIGH 2 form 2 (the harmful shape):** a current-revision `CHANGES_REQUESTED`
  masked by a later off-revision PASS returned `ok:true`. After the fix:
  `ok:false — the authoritative semantic review rev-current-fail is
  CHANGES_REQUESTED`.

**Phase 0 (test validity).** Both fixes were then temporarily reverted in place
(byte-exact backups, restore verified with `cmp`) and the new suite was run
against that pre-fix state: **17 of 20 failed**. The 3 that passed are
deliberate positive controls that must pass in both states (a fully current
lineage still exposes `WAITING_FOR_HUMAN`; a current same-revision lineage still
resolves; a later current-revision PASS still supersedes). Fixes restored and
re-run: **20/20**.

## V4. New permanent regression tests

`tests/remediationRound4Repro.test.ts` (20 tests).

HIGH 1 (9): nonexistent review/work item; superseding implementation; stale
deterministic verification; newer blocking semantic review; wrong-revision
lineage; valid lineage still exposed; zero workers + zero durable mutation
(loop version, WorkItem version/status, Run/Review/Evidence counts, budget all
unchanged); `resume()` still durably demotes afterwards; the CLI `sf loop
status` path cannot bypass.

HIGH 2 (11): old-revision deterministic; old-revision semantic; future/wrong
revision; review pointing at the correct current run but stamped wrong; stale
deterministic cannot combine with current semantic; current deterministic cannot
combine with stale semantic; wrong-revision PASS cannot unlock
`REVIEW -> WAITING_FOR_HUMAN`; wrong-revision PASS masking a current blocking
review cannot make `status()` expose WAITING_FOR_HUMAN; wrong-revision PASS
cannot qualify a releasable snapshot; fully current lineage still works; a later
current-revision PASS legitimately supersedes; and the rule survives a SQLite
store restart.

## V5. Round-3 and all prior findings

All ten previously-fixed HIGH findings (round 1 ×6, round 2 ×2, round 3 ×2)
re-verified green, and the unattended-execution invariant is unchanged —
`status()`'s authority check is current-state validation on a read path, not a
user approval gate, and introduces no prompt into
implement → verify → review → remediate → re-review.

## V6. Deferred non-blocking notes (still NOT fixed, by instruction)

1. `LoopBudget.workerTimeoutMs` not threaded into worker creation.
2. Verification evidence redacts command output but not the executable/argv
   label. 3. The general worker workspace launch path has weaker realpath timing
   than the verification worker's per-command containment.

## V7. What did NOT change

No transition, gate, precondition or domain rule was weakened. No new authority
system: HIGH 1 reuses the round-3 resolver, HIGH 2 tightens the single existing
shared resolver so no caller can omit the rule. The claim/reconciliation
protocol, cancellation authorization, budgets, and worker execution paths are
untouched.

# Remediation Round 5 — Cancel-Path Authority + Reviewer-Run Lineage

The independent Codex **acceptance** review (GPT-5.6 Luna, Extra High, run with
`-s danger-full-access` so the deterministic fixtures could execute — it
reported 530/530 and zero sandbox artifacts) confirmed **both round-4 fixes
closed** and all ten earlier HIGH findings still closed, but its systematic
authority-surface audit returned **CHANGES_REQUIRED** with two NEW HIGH
bypasses of the same class. This round closes only those two.

## W1. HIGH 1 — `cancel()` exposed cached WAITING_FOR_HUMAN

**Root cause.** Round 3 correctly required trusted-human authorization for
cancellation and round 4 made `status()` re-derive authority — but `cancel()`'s
terminal early return still handed back the persisted row verbatim.
**Authentication and authority are separate invariants**: verifying the trusted
human answers *"who may cancel?"* and says nothing about whether a cached
terminal `WAITING_FOR_HUMAN` is still backed by current Factory authority.
Reproduced on one stale loop: `status() => RECOVERY_REQUIRED` while an
authenticated `cancel() => WAITING_FOR_HUMAN`.

**Design.** The WAITING revalidation was extracted from `reconcileTerminal` into
`reconcileWaitingAuthority` — now THE single durable answer to "may this
persisted WAITING_FOR_HUMAN be exposed as authoritative?", shared by
`drive()`/`resume()` (via `reconcileTerminal`) and by both of `cancel()`'s
terminal returns (the initial read and the concurrent-terminality case).
`status()` asks the same Factory resolver but keeps its read-only projection.
Only `WAITING_FOR_HUMAN` is revalidated: CANCELLED/EXHAUSTED/FAILED/
RECOVERY_REQUIRED claim no current authority, so their existing no-op semantics
are untouched. Because `cancel()` is already a mutating governance command, its
fail-closed path performs the durable demotion via `failClosedToRecovery` —
launching zero workers and creating no replacement Run/Review/Evidence.

Note on the courtesy WorkItem transition: `tryBlockWorkItem` is best-effort and
`WAITING_FOR_HUMAN` is deliberately not in `BLOCKABLE_STATUSES`, so the item
stays at WAITING_FOR_HUMAN (itself a human-attention state) while the loop
carries the authoritative RECOVERY_REQUIRED signal. Widening the accepted
TASK-001 transition table was out of scope.

## W2. HIGH 2 — a semantic Review's backing reviewer Run was never dereferenced

**Root cause.** `resolveSemanticReview` filtered reviews by kind, reviewed run
and (since round 4) revision, then compared the review's **copied principal
strings** for C4. It never dereferenced `reviewerRunId`. `recordReview` enforces
the backing run at creation, but a resolver reading durable state must re-prove
it: a directly-written or corrupted Review carrying entirely plausible copied
fields could point at a reviewer run that does not exist, failed, is still
running, or has the wrong role/revision/target — and still become authoritative,
surviving SQLite close/reopen. Reproduced: `authorityOk=true`,
`reviewerRun="run-wrong-revision"`, `snapshotQualified=true`.

**Design (mirror the proven deterministic structure).** `resolveSemanticReview`
now resolves the authoritative REVIEWER *attempt* from the runs themselves —
role REVIEWER, current `specRevision`, targeting the current implementation,
newest attempt authoritative, must be SUCCEEDED — then derives C4 independence
from those Run records, and finally **pins** the review to that run
(`review.reviewerRunId === reviewerRun.id`). Copied principal fields are demoted
to audit/display data that must *agree* with the runs they describe and may
never substitute for them. This is exactly the shape `resolveVerification`
already used for the verifier/deterministic pair. Fixed in the lowest shared
resolver, so `requireIndependentSemanticReview`,
`resolveWaitingForHumanAuthority`, `resolveReleaseSnapshot`, the
REVIEW -> WAITING_FOR_HUMAN transition, `status()` authority and crash
reconciliation all inherit it.

## W3. Deterministic sibling audit — already safe, no change required

The deterministic path was audited for the identical persistence-authority
class and found **already correct**: `resolveVerification` independently
resolves the verifier run (role/revision/target/SUCCEEDED/evidence) and then
pins the deterministic review to it
(`deterministicReview.reviewerRunId !== verifierRun.id` fails closed). A corrupt
deterministic review must therefore name the genuine current verifier attempt to
count, and its copied principal fields are never consulted for any authority
decision — so there is no analogous bypass. No change was made there, to avoid
unrelated hardening. The semantic path simply lacked this pinning; round 5 gives
it the same shape.

## W4. Pre-fix reproductions, then confirmed fixed

- **HIGH 1 pre-fix:** `status() => RECOVERY_REQUIRED`, authorized
  `cancel() => WAITING_FOR_HUMAN`, durable row unchanged. **Post-fix:**
  `cancel() => RECOVERY_REQUIRED`, durable demotion recorded.
- **HIGH 2 pre-fix:** `{"ok":true,"semantic":"rev-corrupt-sem","reviewerRun":"run-does-not-exist"}`
  with `releaseSnapshot qualified => true`; and across SQLite close/reopen
  `authorityOk=true, reviewerRun="run-wrong-revision", snapshotQualified=true`.
  **Post-fix:** `ok:false — … was produced by run-does-not-exist, not the current
  reviewer attempt run-0003`, snapshot not qualified, and the SQLite restart case
  rejected too.

**Phase 0 (test validity).** Both fixes were temporarily reverted in place
(byte-exact backups, restore verified with `cmp`) and the new suite run against
that pre-fix state: **14 of 18 failed**. The 4 that passed are positive controls
that must pass in both states. Restored and re-run: **18/18**.

## W5. New permanent regression tests

`tests/remediationRound5Repro.test.ts` (18 tests). HIGH 1 (7): status/cancel
agreement; the CLI `sf loop cancel` path; zero workers and zero replacement
Run/Review/Evidence; canonical recovery behaviour; a valid authoritative WAITING
loop keeping its no-op semantics with no cosmetic version bump; unauthorized
cancellation still rejected before any authority-side mutation with zero durable
change; and status/resume/drive/cancel all agreeing. HIGH 2 (11): nonexistent
backing run; FAILED and RUNNING reviewer attempts; wrong role; wrong
revision/target; copied-principal mismatch; C4 proven from Run records;
`status()` and release-snapshot paths; SQLite close/reopen; a corrupted PASS
unable to mask a genuine current blocking review; and the fully valid lineage
still authorizing, pinned to the real reviewer attempt.

Existing `tests/preconditions.test.ts` fixtures were **modernized, not
weakened**: they previously built a SEMANTIC review whose `reviewerRunId`
pointed at a run that did not exist in the fixture — passing only because the
old resolver never dereferenced it (the very defect). They now carry the real
REVIEWER run, exactly as `recordReview` requires in production; every assertion
is unchanged, the C4 case models the violation on the Run records, and a new
dangling-reviewer-run case was added.

## W6. Focused authority-surface audit (post-fix)

All four public entry points and the reconciliation paths were re-audited.
`start()` → `drive()`; `resume()` → `drive()`; `drive()`'s two terminal early
returns → `reconcileTerminal` → `reconcileWaitingAuthority`; `status()` →
same Factory resolver, read-only projection; `cancel()` → both terminal returns
→ `reconcileWaitingAuthority`; `stepReviewing()` → re-derives before accepting a
cached PASS, and the fresh transition goes through `factory.advance`'s
precondition; `toStatusView` is a pure projection over service results. No
remaining path exposes WAITING_FOR_HUMAN without current Factory authority,
accepts a caller-created human identity, trusts copied principal strings over
backing Run authority, or lets corrupted persisted authority survive a restart.

## W7. Deferred non-blocking notes (still NOT fixed, by instruction)

1. `LoopBudget.workerTimeoutMs` not fully threaded into worker creation.
2. Verification executable/argv labels may contain sensitive material.
3. General worker workspace launch realpath timing is weaker than the
   verification worker's per-command containment.
