# TASK-007 — LOCAL_24_7_RUNTIME

Roadmap key: `LOCAL_24_7_RUNTIME` (order 1, no dependencies)
Selected by: `sf supervise tick` — the deterministic supervisor, not by a human
or an AI choosing what felt next.
Status: acceptance criteria FROZEN before implementation (ADR-0002 condition 1).

## Objective

Make the existing always-on Windows PC + WSL2 Ubuntu a reliable Factory host, so
that `sf supervise tick` runs on a schedule, survives restart, and needs nobody
watching.

TASK-006 built the one-shot tick and publishes `nextWakeAt` precisely so that
something else can own the waiting. This task is that something else. It adds no
new decision-making: the supervisor still decides what to do, and this only
decides *when it gets asked*.

## Runtime amendment (binding, from the completion mandate)

The runtime is the **existing** always-on Windows PC running WSL2 Ubuntu.

- **No VPS. No paid infrastructure of any kind.**
- GitHub zero-cost capabilities may be used where they add concrete value.
- GCP/AWS/Azure free tiers are optional isolated labs, never dependencies.
- The existing DigitalOcean droplet is out of scope.

## Measured environment (not assumed)

Audited 2026-08-23 on this machine:

| Fact | Value |
| --- | --- |
| OS | Ubuntu 24.04.1 LTS under WSL2, `WSL_DISTRO_NAME=Ubuntu` |
| systemd | 255 (255.4-1ubuntu8.17); system **running**, user instance **running** |
| `/etc/wsl.conf` | `[boot] systemd=true` already set |
| Linger | was `no`; `loginctl enable-linger` succeeded **without sudo** → now `yes` |
| Schedulers | `systemd-run` ✓, `crontab` ✓, `at` ✗, `anacron` ✗ |
| Node | `/home/hakanduyar/.nvm/versions/node/v22.22.3/bin/node` |
| Repo | `/home/hakanduyar/GitHub/software-factory`, `dist/src/cli/main.js` present |
| Interop | enabled (Windows binaries callable from WSL) |

That linger could be enabled without sudo is the finding that makes this task
possible autonomously: user units can run with no active login session, so no
password boundary is crossed.

## Design

A **systemd user timer** invoking the existing one-shot tick. Deliberately not a
daemon:

```
software-factory-supervisor.timer   →   software-factory-supervisor.service
                                          ExecStart=<node> dist/src/cli/main.js supervise tick
```

Between firings **no process runs**, which is what keeps waiting free — the same
property TASK-006 exists to protect. A daemon would reintroduce exactly the
"something is always running" cost this architecture rejects.

The repository gains a `sf runtime` command that GENERATES and INSTALLS the
units from measured facts. The units are not hand-written into the repo as
literals, because absolute paths differ per machine and a wrong path fails
silently at 3am; they are derived and validated at install time, failing closed
if anything is missing.

### Scope boundary

- **In scope:** unit generation, install/status/uninstall, verification, tests.
- **In scope:** Windows-side boot start IF it can be configured without
  elevation; otherwise reported honestly as the one manual step.
- **Out of scope:** wiring the supervisor to execute autonomous work. That is
  `EXECUTOR_WIRING`, which is blocked behind `EXECUTOR_ISOLATION` and
  `STATE_INTEGRITY`. This task schedules ticks; it does not enable execution.

## Acceptance criteria (FROZEN — may not be edited to fit the implementation)

**AC-1.** `sf runtime install` writes a systemd user service and timer using
ABSOLUTE paths for the node binary, the CLI entry point and the working
directory. No unit may depend on `PATH`, on an interactive shell, or on nvm
having been sourced.

**AC-2.** Install is idempotent: running it twice leaves byte-identical unit
files, exactly one enabled timer, and no duplicate or orphaned units.

**AC-3.** Install FAILS CLOSED if any required fact is missing or unusable — no
node binary, no built CLI, no repository, no systemd user instance. It must
never write a partial or non-functional unit.

**AC-4.** The timer demonstrably fires and runs a real tick unattended, proven by
observing supervisor state advance (or `nextWakeAt`/journal evidence), not by
asserting the unit file's contents.

**AC-5.** The scheduled unit survives a full WSL restart (`wsl --shutdown` then
re-entry) and is still enabled and scheduled afterwards, with linger enabled so
no login session is required.

**AC-6.** `sf runtime status` reports honestly and without side effects:
installed, enabled, linger state, last run result, next scheduled run — and says
plainly when something is NOT set up rather than implying it is.

**AC-7.** `sf runtime uninstall` removes exactly what install created and nothing
else, and is safe to run when nothing is installed.

**AC-8.** The service runs with a bounded timeout, so a hung tick cannot block
the schedule forever, and a failing tick does not disable or wedge the timer.

**AC-9.** No secret, token, credential or account identifier appears in any
generated unit file, in `sf runtime status` output, or in the journal lines the
service produces. Unit files are world-readable; treat them accordingly.

**AC-10.** The scheduled invocation is the same one-shot `supervise tick`. No
daemon, no polling loop, no process between firings, and zero model tokens
consumed by scheduling or waiting.

**AC-11.** Windows-side start-at-boot is either configured without elevation, or
reported precisely as the single manual step, with the exact command. It is
never silently assumed.

**AC-12.** Existing behaviour is preserved: the full suite still passes (baseline
1347), and nothing in this task relaxes the financial gate, the HUMAN-ONLY
boundaries, or the `STATE_INTEGRITY` + `EXECUTOR_ISOLATION` → `EXECUTOR_WIRING`
ordering.

## Verification plan

- Unit generation tested against a temporary `XDG_CONFIG_HOME`, never the real
  one, so tests cannot disturb the operator's actual runtime.
- Idempotency proven by hashing generated files across repeated installs.
- Fail-closed paths driven by removing each required fact in turn.
- A REAL install performed on this machine, a real timer firing observed, and a
  real `wsl --shutdown` restart survived — because a scheduler that only works in
  tests is the exact failure this task exists to prevent.
- Secret scan over generated units and status output.

## Independent review

Codex CLI, `gpt-5.6-luna`, effort `xhigh`, per C4. Integration follows ADR-0002:
independent PASS with zero CRITICAL/HIGH and an explicit "Safe to commit = YES".
