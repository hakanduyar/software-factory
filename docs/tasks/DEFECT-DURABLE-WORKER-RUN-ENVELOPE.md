# DEFECT-DURABLE-WORKER-RUN-ENVELOPE

**Frozen by owner authorization on 2026-09-27 for the isolated worktree
`software-factory-durable-worker-control`.** These criteria may not be edited
to fit the implementation (C2). A material scope change is a new planning
decision, not an edit to this file.

## Objective

Add the first durable, provider-independent run envelope for external
Claude/Codex processes launched by production plan-resume supervision:
durable pre-spawn intent, real child identity and heartbeat, atomic terminal
artifact, deterministic stale/dead/max-turn reconciliation, and an idempotent
notification outbox. `MAX_TURNS` must become visible `AWAITING_CONTROLLER`;
this task must not automatically continue, escalate, or launch another model.

## Existing defect

Current ProcessRunner returns PID/result only in memory after close.
Supervisor state does not durably bind the real child PID/session/max-turn/
result. Claude structured `session_id` and `terminal_reason` are discarded.
Wrapper/supervisor death can leave work apparently active or silently
stopped, and chat delivery is currently relied on for notification.

## Scope

- Store provider-independent `WorkerRunEnvelope` in existing
  SupervisorState/SQLite repositories; do not add a separate product
  database or external queue.
- Lifecycle: PREPARED before spawn; RUNNING only after a child ACK bound to
  canonical run/action; terminal states including COMPLETED, FAILED, LOST,
  STALLED, AMBIGUOUS, and AWAITING_CONTROLLER/MAX_TURNS.
- Fields: canonical run/action/roadmap/attempt, provider/model/effort,
  configured max turns, wrapper/child PID, process-start ticks, machine and
  boot identity, factory/provider session IDs when available,
  started/heartbeat/progress/finished/reconciled times, exit code/signal/
  reason, bounded redacted result artifact path/hash, and state version/lease
  identity.
- Wrapper heartbeat is independent of model output. Normal exit paths write
  an atomic action-bound result artifact. Hard kill/power loss is handled by
  deterministic reconciliation.
- Parse Claude structured JSON `session_id` and `terminal_reason`; free text
  must not fabricate MAX_TURNS.
- Add deterministic notification outbox events for MAX_TURNS, LOST, STALLED,
  AMBIGUOUS, with stable dedupe keys and read-only CLI visibility.
- Permission/human/quota gates must be checked before
  PREPARED/RUNNING/provider spawn.

## Non-goals

No general scheduler/router rewrite; no automatic continuation/model
escalation; no credit/top-up/quota bypass; no plan approval/materialization
or blocker clearing; no review-policy change; no push/merge/release/publish/
cutover; no SaaS notification delivery; no historical run reclassification
without proof; no new daemon/external infrastructure; do not claim TASK-019
or AC-24/25/26 complete.

## Acceptance criteria

1. Production wiring with a fake executable durably records PREPARED before
   spawn. A pre-spawn CAS/write failure yields zero child launches.
2. RUNNING requires the child ACK for the same canonical run; store PID,
   start ticks, machine/boot IDs, startedAt, session ID and max turns.
   Launcher intent alone is not RUNNING.
3. Same PID with different start ticks/boot identity becomes
   AMBIGUOUS/REFUSED and never starts a second worker.
4. Wrapper heartbeat is independent of output. Repeated identical progress
   proves liveness only; increasing progress advances the progress clock.
5. Exit 0, nonzero, signal, timeout, spawn error and wrapper error each
   create bounded/redacted atomic artifacts bound to the action/run.
   Torn/foreign artifacts fail closed.
6. Verified structured Claude MAX_TURNS remains failure-like
   `AWAITING_CONTROLLER` even on exit 0, preserving session/result. It emits
   no automatic continuation/escalation. Free-text "max turns" cannot create
   this state.
7. Reconcile reads a valid completion artifact first, then lease/PID
   identity: dead owner LOST, stale live owner STALLED, unverifiable
   identity AMBIGUOUS. Launch count never increases during reconcile.
8. MAX_TURNS/LOST/STALLED/AMBIGUOUS each produce at most one pending outbox
   event across repeated reconcile and restart.
9. `sf supervisor status` or a narrow `sf supervisor notifications --json`
   shows pending run/event/controller action using durable reads only, with
   no provider call or state mutation.
10. Permission/human/quota/backoff gates produce zero provider spawns and
    zero RUNNING envelopes before authority/reset time.
11. Real offline Node child SIGKILL is reconciled from SQLite after restart
    with one terminal/reconciliation result and one event. Racing two
    supervisors still launches at most one child.
12. Old state without new fields loads. New envelope/outbox round-trips.
    Missing/malformed/noncanonical state or artifact is an integrity error
    and never continuation authority.

## Expected narrow source surface

New `src/supervision/workerRunEnvelope.ts`; supervisor types/serialization/
service/ports; `src/adapters/supervision/childPlanAdvancer.ts`; a narrow
artifact helper; ProcessRunner spawn lifecycle; Claude structured-result
parsing; supervisor CLI visibility; minimal directly related tests. Stop and
report before broadening into scheduler architecture.

## Required new tests

`workerRunEnvelope.test.ts`, `workerRunArtifact.test.ts`,
`supervisorWorkerRunRecovery.test.ts`, `supervisorWorkerRunRealKill.test.ts`.
Update only directly related childPlanAdvancer, Claude adapter,
ProcessRunner, state round-trip/scheduler/loop/plan-backed tests. All tests
use fake/offline processes, never real AI.

## Verification commands

1. `npm run build`
2. The exact new/related test files described above.
3. `npm run typecheck`
4. `npm test`
5. `node scripts/preflight.mjs --only WORKER_RUN_`
6. `node scripts/mutate.mjs --only WORKER_RUN_` — only KILLED is acceptable.
7. `git diff --check`
8. `git status --short`
9. `git diff --binary | sha256sum`

Return changed files, exact outcomes, hashes, how duplicate launch and
silent exit are prevented, remaining risks, and rollout notes. Do not commit
or push.
