# TASK-014 — EXECUTOR_WIRING

**Roadmap item:** `EXECUTOR_WIRING` — "Wire the roadmap queue to TASK-005
planning and the TASK-004 loop". Work class `HIGH_RISK_IMPLEMENTATION`.

**Eligible because** both mandatory prerequisites are accepted AND integrated on
`main`: `EXECUTOR_ISOLATION` (TASK-011) and `STATE_INTEGRITY` (TASK-008).

## What is actually missing

Everything downstream already exists and is accepted. `PlanningService` dispatches
approved work into the TASK-004 loop through the narrow `LoopDispatcher` port,
and `src/cli/plan.ts` wires the real dispatcher onto `EngineeringLoopService`.

What does not exist is the connection from the SUPERVISOR's queue to that seam.
`src/cli/supervise.ts` wires `createUnimplementedExecutor`, which answers every
item with `HUMAN_REQUIRED / AUTHOR_PLAN`. The supervisor schedules, gates,
checkpoints, escalates and records provenance — and then has nothing to hand the
work to.

## Boundaries this task does NOT cross

- **No second engineering loop.** `loopDispatcher.ts` exists so that boundary is
  structural rather than a matter of discipline. This task consumes that port;
  it does not reimplement implement/verify/review/remediate.
- **Plan approval stays human.** `PLAN_APPROVAL` is a protected gate under C1.
  Wiring the queue to planning must not manufacture an approval, and an item
  without an approved plan must still return `HUMAN_REQUIRED`.
- **No AI launch inside the isolated child.** `createIsolatedExecutor` denies the
  credential access an AI launch requires, deliberately (L-3). The child does
  DETERMINISTIC work. Routing a launch through it would either fail or require
  giving it credentials, and the second is the capability TASK-011 exists to
  remove.
- **The financial gate is not bypassed.** Every launch stays behind the gate that
  authorises it. `AUTONOMOUS_SPEND_LIMIT = 0` is unaffected by this task.

## Acceptance criteria (FROZEN — may not be edited to fit the implementation)

**AC-1.** The shipped CLI no longer wires `createUnimplementedExecutor`.
`src/cli/supervise.ts` constructs a plan-backed executor, and a test asserts the
SHIPPED construction path rather than a test-only double.

**AC-2.** An item whose work item has no APPROVED plan yields
`HUMAN_REQUIRED` with an `AUTHOR_PLAN` action naming the item. The executor
never treats an unapproved or draft plan as approved, and never creates an
approval. Proven by mutation: removing the approval check fails a case that
names it.

**AC-3.** An item WITH an approved plan is dispatched through `LoopDispatcher`,
and the resulting supervisor outcome reflects the loop's reported phase. The
executor reads loop state; it does not compute loop state.

**AC-4.** Dispatch is IDEMPOTENT. If a loop already exists for the work item the
executor adopts it via `find` rather than calling `start` again. Proven with a
dispatcher that counts `start` calls across two executions of the same item.

**AC-5.** A terminal loop outcome is never reported as success. `FAILED`,
`EXHAUSTED`, `RECOVERY_REQUIRED` and `CANCELLED` map to a non-completed
supervisor outcome that names the loop's failure reason. Only a loop that
finished its work maps to a completed outcome, and `WAITING_FOR_HUMAN` maps to
an outcome requiring a human — not to completion.

**AC-6.** No AI launch is routed through the isolated child executor. Proven by a
test asserting that the plan-backed path never constructs an isolated executor
for an AI work class, and that deterministic work is unaffected.

**AC-7.** Every existing guard remains load-bearing. Verifier, isolation,
provenance and financial-gate guards are unchanged, and the guards listed in
TASK-013's AC-5 inventory still fail the cases that name them. Proven by
mutation, not by inspection.

**AC-8.** No test launches a real AI CLI, spends anything, or requires network
access. Planning tests already use a scripted dispatcher; this task's tests do
the same.

**AC-9.** An executor failure is a definite outcome, never an unhandled
rejection. A throw from the planning seam becomes a reported failure, because a
throw inside a tick kills the tick — the rule `isolatedExecutor` already applies.

## Out of scope

- Approving plans automatically. That is `PLAN_APPROVAL`, a human gate.
- Driving the loop's internals, reconciling worker actions, or interpreting
  reviewer verdicts. That is TASK-004's, reached only through the port.
- `GITHUB_ORCHESTRATION`, `MEASURED_MODEL_ROUTER`, `CLEAN_ROOM_CI` — all
  downstream roadmap items.
