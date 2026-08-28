# TASK-011 — EXECUTOR_ISOLATION

Roadmap key: `EXECUTOR_ISOLATION`
Status: acceptance criteria FROZEN before implementation (ADR-0002 condition 1).

## The problem, stated exactly

From TASK-006 review findings F5-FIN-3 and F6-FIN-2, restated in the roadmap
entry itself:

> The financial gate authorises a LAUNCH. It cannot police what trusted
> in-process executor code does afterwards, because an in-process function
> cannot restrain code that can already call `fetch` — the same boundary
> TASK-003's `Worker` has.

`SupervisorService` calls `WorkExecutor.execute()` as an ordinary function in
its own process. Every guard the supervisor applies — the financial gate, the
action classification, the resource selection — decides whether to CALL that
function. None of them constrain what it does once called. An executor that
decided to bill a provider, read the supervisor database, or write anywhere in
the tree would simply do it, and nothing in this codebase would notice.

That is the last of the two boundaries `EXECUTOR_WIRING` waits on. It matters
most precisely because wiring is what makes executors run unattended.

## What isolation can and cannot mean on this machine

**It can mean:** a separate process, started with an explicit environment that
contains no credentials, given only a bounded declared request, whose output is
treated as untrusted data.

**It cannot mean, here, a network sandbox.** Blocking raw egress needs OS-level
privilege — network namespaces, seccomp, or a firewall rule — and acquiring that
privilege requires a sudo password, which is a HUMAN-ONLY action under ADR-0002
and is not available to autonomous work. Any criterion below that implied
network isolation would be a criterion this task cannot honestly meet.

**What is achieved instead is the removal of BILLING capability**, which is the
property that actually matters for `AUTONOMOUS_SPEND_LIMIT = 0`: a process with
no provider credentials cannot cause a charge, whether or not it can open a
socket. A child that opens a socket to an unauthenticated endpoint is a
different and much smaller problem than one that can spend money.

This distinction must survive into the implementation's own documentation. An
implementation claiming "the executor is sandboxed" would be exactly the kind of
overstatement this project has removed repeatedly.

## Acceptance criteria (FROZEN — may not be edited to fit the implementation)

**AC-1.** The executor runs in a SEPARATE OS PROCESS. The supervisor does not
call executor code as an in-process function on the path that performs work.

**AC-2.** The child's environment is an explicit ALLOWLIST. No variable outside
that list is forwarded, and the list contains no credential, token, key or
secret. A test asserts a planted secret in the parent's environment does not
reach the child.

**AC-3.** The child receives ONLY a bounded, declared request: the work item,
its action kind, and the resource configuration the supervisor already chose.
It is not handed the supervisor state, the database path, or the financial
policy.

**AC-4.** The child's output is UNTRUSTED DATA. It is parsed strictly, field by
field, with unknown fields refused and any malformed response failing closed —
never coerced, never partially believed.

**AC-5.** A child cannot grant itself spending authority: no value it returns
can cause the supervisor to treat a subsequent action as permitted, and the
financial gate's decision is not derived from anything the child says.

**AC-6.** Failure modes are bounded and fail closed: a child that crashes, hangs,
exits non-zero, writes garbage, or returns nothing produces a definite supervisor
outcome rather than a hang or an assumed success. A timeout is enforced.

**AC-7.** The child cannot silently outlive its work: it is terminated when the
supervisor stops waiting, and the termination is observable.

**AC-8.** No secret reaches logs, durable state, or evidence from the child's
output; existing redaction and bounding apply to everything it returns.

**AC-9.** The implementation NEVER claims network isolation or sandboxing. Its
documentation states plainly that raw egress is not blocked, that removing
credentials removes BILLING capability rather than network capability, and names
the OS-level control that would close the remainder. A test asserts that
statement is present where an implementer will read it.

**AC-10.** Existing behaviour is preserved: the full suite still passes, the
financial gate is untouched, and `EXECUTOR_WIRING` still depends on both
`EXECUTOR_ISOLATION` and `STATE_INTEGRITY`.

**AC-11.** The in-process executor path is not left available as a silent
fallback for real work. If it remains for tests, it is named as such and cannot
be selected by the production path without an explicit, visible choice.

**AC-12.** The trust-boundary notes that currently point at `EXECUTOR_ISOLATION`
as future work (in `financialSafety.ts` and `supervisorService.ts`) are updated
to say what is now true — narrowed deliberately and visibly, not deleted, and
not overstated.

## Verification plan

- A real child process, started by the real adapter, with a planted secret in
  the parent environment that must not appear in the child.
- Crash, hang, non-zero exit, garbage output and empty output each driven end to
  end, asserting a definite fail-closed outcome for every one.
- Timeout enforcement measured, not assumed.
- Mutation testing: every guard removed in turn, confirming its own regression
  fails. Removing the guard, not its input — the lesson of rounds 6, 8 and 10,
  and of TASK-008, where two guards masked each other and neither was
  load-bearing.

## Sequencing note

`LOCAL_24_7_RUNTIME` (TASK-007) remains `PLATFORM_CAPABILITY_BLOCKED`: writing
systemd autostart units is refused by a platform safety classifier, which is a
correct default for agent-authored persistence code. Nothing in this task
depends on it. The declared dependency of `EXECUTOR_ISOLATION` on
`SUPERVISOR_SERVICE` is conservative rather than technical — isolating a child
process does not require a scheduler to exist — and the roadmap's dependency
edges are NOT being edited.
