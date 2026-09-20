# TASK-019 — AUTONOMOUS_SUPERVISOR

**Roadmap item:** a repo-owned, always-recoverable supervisor process that owns
workflow state and advances it without a human message. Work class
`ARCHITECTURE_SECURITY`.

**Direction approved by the owner on 2026-09-20.** The criteria below are FROZEN
by that approval and may not be edited to fit the implementation (C2). A
material scope change is a new planning decision, not an edit to this file.

**This task is a BLOCKING predecessor** for any claim that the Software Factory
has an end-to-end autonomous review loop. Until it is accepted, L-25 stands and
no such claim may be made.

## Why this exists: the failure TASK-018 kept reproducing in its own acceptance

TASK-018 Part B built durable verdict consumption and proved it against a real
database from a cold supervisor. It did not close the gap, and the evidence is
this task's own history:

- **Round 7.** The reviewer wrote a valid CHANGES_REQUIRED verdict at 22:15. The
  chain validated it against an unchanged fingerprint, logged it, and exited —
  by design, because consuming a verdict had never been its job. Remediation
  began TWENTY-TWO HOURS later, when a person sent a message.
- **Round 8.** The verdict landed at 02:49 and was consumed about twenty hours
  later, on the next human message.
- **Round 9.** The verdict landed at 14:52 and was consumed about twenty-five
  hours later, on the next human message.

Nothing crashed in any of those. Three times, a correct result sat on disk while
the Factory had no owner whose job it was to notice. The consumption mechanism
existed from round 7 onwards; what was missing is that nothing in production
CREATES the durable review record, because the supervisor does not launch
reviews — a shell script outside the repository does (L-25).

The pattern this task removes: **a process whose lifetime is a chat session, a
terminal window, or a shell script is not an owner.**

## What this is NOT

- Not a new state database. The existing supervisor state and repository are the
  source of truth; this task gives them an owner that runs.
- Not a relaxation of ADR-0002. The supervisor records that a candidate is
  accepted; it does not integrate on its own authority beyond what ADR-0002
  already permits, and it never reviews its own work.
- Not a replacement for the shell chain on day one. The chain remains a
  compatibility/bootstrap mechanism until this task is accepted and cut over.

## Acceptance criteria

Frozen. Each is a behaviour that must be PROVEN by an executable check, not
asserted.

### A. Durable ownership of workflow state

- **AC-1** — Every stage of a unit of work is represented in durable state:
  claimed, launching, running, and terminal outcomes, together with the
  exceptional states the existing domain already names (waiting for a resource,
  needing a human, blocked, ambiguous). No stage exists only in memory, only in
  a log line, or only in a shell variable.
- **AC-2** — A review is a first-class durable record created BY THE SUPERVISOR
  before the reviewer is launched, carrying at minimum: review/run identity,
  the activity it belongs to, attempt/round, provider, model, effort, candidate
  commit, candidate tree, working-tree fingerprint, where the verdict will
  appear, ownership lease, launch state and timestamps. **L-25 is closed by this
  criterion and by nothing less.**
- **AC-3** — No shell script is required for any transition. A run in which the
  shell chain is absent entirely must still reach a verdict and act on it.

### B. Launch handshake and identity

- **AC-4** — Launching is a two-phase handshake: the run record and its identity
  are committed BEFORE the process is spawned, and the transition to running
  happens only on evidence from the spawned process that names the same run id.
  "The supervisor intended to launch" is never recorded as "running".
- **AC-5** — A supervisor killed between the two phases resolves the run on
  restart to exactly one of: adopted (the worker exists and proves the same run
  id), retryable (no such worker exists), or ambiguous (refuse). It never
  launches a second worker for a run that may already have one.
- **AC-6** — Worker identity survives PID reuse: a recycled PID is never
  mistaken for the worker that held it.

### C. Liveness, heartbeat and progress

- **AC-7** — A worker's record distinguishes "alive" from "getting somewhere".
  A repeated identical progress value does not refresh the progress clock, and a
  long-running worker that IS progressing is never killed for elapsed time
  alone.
- **AC-8** — Within one supervisor decision, one lease yields one answer.

### D. Reconciliation as the safety net

- **AC-9** — A periodic deterministic reconciliation advances state with NO
  model invocation and no user message. Events and notifications may accelerate
  it; losing every one of them must not lose progress.
- **AC-10** — On startup the supervisor reconciles before it schedules: results
  that already exist are consumed first, dead workers are reclassified, and
  ownership is re-established from durable state alone.

### E. Verdicts

- **AC-11** — A valid verdict is found and consumed exactly once even if the
  scheduler died, the waiter died, the notification was lost, the model session
  ended, the supervisor restarted, or the machine restarted after the durable
  write.
- **AC-12** — Consumption validates run identity, candidate commit, tree and
  fingerprint, and the expected reviewer identity. A verdict for a different
  candidate is REFUSED and the refusal is durable.
- **AC-13** — CHANGES_REQUIRED releases the prior review's ownership and makes
  remediation claimable automatically. PASS or PASS_WITH_NON_BLOCKING_NOTES with
  zero CRITICAL, zero HIGH and an explicit safe-to-commit reaches the ADR-0002
  integration gate and stops there.
- **AC-14** — A reviewer that produced no valid verdict is NEVER a pass. It
  becomes an explicit no-verdict state, and a fresh review may be scheduled only
  after the candidate's integrity is re-established.

### F. Resource limits

- **AC-15** — Provider quota exhaustion is a durable waiting state carrying
  provider, model, attempt, the observed evidence and a locally computed next
  probe time. Waiting consumes no model tokens, requires no user message, and
  the provider's own displayed reset time is not treated as proof. No autonomous
  purchase, top-up or payment change is ever made.

### G. Exactly-once effects

- **AC-16** — Replaying reconciliation cannot launch a duplicate reviewer or
  remediation worker, consume one verdict twice, duplicate a review round,
  integrate twice, or overwrite newer state with older.
- **AC-17** — Two supervisors started concurrently converge on one durable
  owner; the other stands down without writing. Ownership is a durable lease,
  not a process-table lookup, and an unresolvable lease fails closed.

### H. Surviving restarts

- **AC-18** — The supervisor process is disposable: killing it at any point
  leaves durable state from which a fresh one continues, with no duplicate
  effects and no human prompt.
- **AC-19** — A production launcher starts the supervisor after a machine or WSL
  restart without the owner opening a terminal. It detects its environment
  rather than assuming one, requires no administrator privilege unless genuinely
  unavoidable, and restarts the deterministic supervisor — never a model. Any
  irreducible human-only step is surfaced as exactly one named action.

### I. Honesty of reported state

- **AC-20** — Every reported state is derived from durable, measured state. A
  running state requires launch evidence; a mutation run in progress requires an
  owned run record. A transition that could not happen is recorded as such and
  refused or retried; it is never reported as having happened.
- **AC-21** — A compact machine-readable status command reads durable state only
  and invokes no model.

### J. Evidence

- **AC-22** — Deterministic end-to-end tests with REAL process kills cover at
  least: lost notification; scheduler death after a verdict; reviewer killed
  before a verdict; supervisor killed while a worker runs; supervisor killed
  between verdict persistence and consumption; two supervisors racing; a worker
  spawned whose parent died before acknowledgement; a reused PID; quota
  exhaustion and its local backoff; waiter disappearance; restart simulation;
  candidate/fingerprint mismatch; a verdict processed twice; an event delivered
  twice; a stalled worker; and a slow but progressing worker.
- **AC-23** — The cheap mutation preflight remains mandatory before every
  expensive full mutation run, with its existing checks intact.
- **AC-24** — A soak run crossing at least one real worker completion boundary
  and several reconciliation ticks demonstrates the Factory advancing with the
  user doing nothing: no chat prompt, no model session held open, no manual
  health check, no manual watcher, no duplicate process, and no token-consuming
  polling.

### K. Cutover

- **AC-25** — The supervisor runs in shadow mode against the existing workflow
  first: observing and reconciling without duplicating the chain's actions, with
  recorded evidence that its decisions match the transitions that actually
  occurred.
- **AC-26** — After acceptance and cutover, no acceptance round depends on a
  human message or a model session being awake. The shell chain becomes
  non-authoritative tooling or is removed.

## Out of scope

Model qualification, routing measurement, and any new provider. This task owns
the LOOP, not who runs inside it.

## Relationship to TASK-018

TASK-018's frozen criteria are unchanged and are not reinterpreted by this
document. TASK-018 Part B remains what it is: durable activity state and durable
verdict CONSUMPTION. This task owns the half TASK-018 could not close without
changing its own frozen scope — the supervisor creating and owning the review in
the first place, and running as a process that outlives every session.
