# TASK-009 — Durable blocker recording

Status: acceptance criteria FROZEN before implementation (ADR-0002 condition 1).
Type: capability gap found in operation, not a roadmap item.

## Why

`LOCAL_24_7_RUNTIME` is blocked: implementing it requires generating systemd
autostart units, and a platform safety classifier refuses agent-written
persistence code. That refusal is a correct default and is not being evaded.

The supervisor durably records that the item is `WAITING_FOR_HUMAN_REQUIRED`, so
it is correctly fail-closed and will not be selected. But the recorded REASON is
now false — it still says *"needs an approved plan"*, and the plan exists
(frozen at `9d8417e`). The true blocker, and the branch and commit needed to
resume, exist **only in a chat transcript**.

That is the exact failure TASK-006 was built to eliminate. A supervisor whose
durable state says the wrong thing about why work stopped is worse than one that
says nothing, because an operator will believe it.

There is currently no way to write a blocker into durable state: the CLI has
`tick`, `status`, `resources`, `roadmap` — three read commands and one that
advances work. Nothing records "this is blocked, here is why, here is where to
pick it up".

## Design

One command:

```
sf supervise block <ROADMAP_KEY> --reason <REASON> --detail <TEXT>
```

It routes through the supervisor's existing escalation path, which already
sanitizes, bounds and persists with CAS — rather than writing state directly,
which would be a second, unreviewed way to mutate durable state and exactly the
kind of side door every TASK-006 review punished.

`PLATFORM_CAPABILITY_BLOCKED` is added to `ESCALATION_REASONS`: work that is
correct and approved, but which the available tooling refuses to perform. It is
distinct from `HUMAN_DECISION_REQUIRED` (a person must decide) and from
`AUTH_REQUIRED` (a credential is missing) — here the human must lift or satisfy a
platform boundary.

## Acceptance criteria (FROZEN — may not be edited to fit the implementation)

**AC-1.** `sf supervise block` records, durably and atomically, a blocker against
a named roadmap item: reason, human-readable action, and free-text detail.

**AC-2.** The item is left in a fail-closed state that the scheduler will NOT
select, and `sf supervise tick` continues to select other eligible work.

**AC-3.** An unknown roadmap key is refused; the command never invents an item.

**AC-4.** The recorded text is bounded and redacted like every other durable
string, and no secret can be introduced through `--detail`.

**AC-5.** The command is idempotent in effect: blocking an already-blocked item
updates the reason rather than accumulating duplicate escalations without bound.

**AC-6.** `sf supervise roadmap` and `status` display the recorded reason, so the
information is recoverable without any chat transcript.

**AC-7.** The command cannot mark an item DONE, cannot clear a blocker, cannot
alter dependencies, and cannot touch the financial policy. It only ever
restricts.

**AC-8.** `PLATFORM_CAPABILITY_BLOCKED` round-trips through persistence, and the
parser rejects an unrecognised reason.

**AC-9.** Existing behaviour preserved: full suite passes (baseline 1347),
financial gate untouched, and `EXECUTOR_WIRING` still depends on both
`STATE_INTEGRITY` and `EXECUTOR_ISOLATION`.

**AC-10.** After the command runs against the real database, the true blocker for
`LOCAL_24_7_RUNTIME` — reason, spec path, branch and commit — is recoverable from
`sf supervise roadmap` alone.

## Verification plan

- Unit-level: unknown key refused, redaction applied, bounded, idempotent.
- Scheduler-level: a blocked item is not selected while another eligible item is.
- Persistence: the new reason survives encode → parse; an unknown reason fails.
- Real: run it against the actual supervisor database and read the truth back out
  of `sf supervise roadmap` with no conversation available.
