# Software Factory — Bootstrap Pack

Bu repo, Hakan'ın kişisel Software Factory sisteminin çekirdeğini kurmak içindir.

Amaç: yazılım, içerik ve ileride medya üretimini tek bir orkestrasyon sistemi üzerinden; doğru görevi doğru modele yönlendirerek, test/review/insan onayı kapılarıyla yürütmek.

## İlk hedef

Önce localde çalışan küçük ama güvenilir bir Factory Core kurulur. Sunucuya taşıma, Telegram/WhatsApp, n8n ve geniş model havuzu daha sonra eklenir.

## Başlangıç sırası

1. `docs/PRODUCT.md`
2. `docs/FACTORY_CONSTITUTION.md`
3. `docs/ARCHITECTURE.md`
4. `docs/DOMAIN_MODEL.md`
5. `docs/MODEL_ROUTING.md`
6. `docs/ROADMAP.md`
7. `docs/tasks/TASK-001-core-skeleton.md`
8. `BOOTSTRAP_PROMPT.md`

## Çalışma ilkesi

Plan -> Ticket -> Implementasyon -> Otomatik test -> Bağımsız review -> İnsan onayı -> Merge/Release -> Evidence -> İçerik türetme

Factory ilk aşamada kendi reposunu geliştiren ilk proje olacaktır.

## Factory Core (TASK-001)

Local TypeScript skeleton of the Control Plane. No AI provider, GitHub, n8n,
Telegram or server integration — everything runs in-memory with deterministic
mock workers.

### Requirements

- Node.js >= 22.5 (developed on Node 22.23; bumped from >=20.11 in TASK-002
  because durable persistence uses `node:sqlite`, built into Node since
  22.5 — no npm dependency added)
- npm

### Exact commands

```bash
npm install          # install dev dependencies (typescript, @types/node)
                     # if your npm registry is unreachable, use:
                     #   npm install --registry=https://registry.npmjs.org
npm run typecheck    # TypeScript strict typecheck, no emit
npm run build        # compile src/ and tests/ to dist/
npm test             # build, then run the unit tests with node --test
npm run verify       # typecheck + tests (the full check for this task)
npm run demo         # build, then run the in-memory demo work item IDEA -> DONE
npm run demo:persistent   # build, then run (or resume) the SQLite-backed persistent demo
node dist/src/cli/main.js transitions   # print the workflow table and gates
```

`npm run demo` walks one fake work item through the whole lifecycle —
including a new implementation that arrives *after* release approval and
forces the item to re-earn every proof — and prints the fifteen bypass
attempts the Factory refuses along the way.

### Layout

```
src/domain/              entities, statuses, gates, typed errors, trusted identities, release snapshot
src/workflow/            transition table, snapshot resolver, preconditions, gate guard, WorkflowService
src/ports/               repository (with unit of work), worker, worker-registry, human-identity, clock
src/adapters/memory/     in-memory FactoryStore: staged transactions, append-only tables, frozen writes
src/adapters/sqlite/     durable FactoryStore: node:sqlite, real transactions, schema + row validation
src/adapters/shared/     logic shared by every adapter (single-read Run capture)
src/adapters/workers/    deterministic mock worker
src/adapters/security/   local human-identity gate and worker registry
src/app/                 FactoryService use cases
src/cli/                 `sf` CLI, the in-memory demo, and the persistent demo
tests/                   node:test unit tests, including reproduced review exploits
```

### The four root invariants

Earlier rounds guarded each bypass individually and reviewers kept finding a
way around the guards. These four invariants remove whole classes of bypass
instead.

**1. Trusted principals.** Anything a caller says about identity is data. A
`TrustedHumanToken` can only be minted by `HumanIdentityGate` against a
configured credential, and a `WorkerPrincipal` can only be minted by
`WorkerRegistry`, keyed on the Worker *object*. So a worker that renames
itself or re-declares its roles keeps the same principal, and reviewer
independence (C4) compares principals rather than strings.

**2. Content-addressed release snapshots over the implementation lineage.**
The current implementation is the newest IMPLEMENTER *attempt* at the current
spec revision — a FAILED newer attempt supersedes an older success and leaves
nothing releasable until fresh proof exists. The authoritative review is the
*latest applicable* one in append order (a newer FAIL supersedes an older
PASS; a still-newer PASS may supersede the FAIL), and criterion proof must
come from the *current verifier attempt*: one coherent verification
generation (implementation -> verifier -> that verifier's criterion results
-> review), with no cross-generation mixing. A `ReleaseSnapshot` id is a
hash of the exact implementation run, verifier run, deterministic review,
semantic review and acceptance-criterion verifications currently in force,
and a RELEASE_APPROVAL is bound to that hash — so any change to the lineage
orphans the old verification, review and approval at once.

**3. Append-only lifecycle records, terminal all the way up.** A Run is
created `RUNNING` and completed exactly once to a runtime-validated
`SUCCEEDED`/`FAILED`; terminal is terminal. A DONE or CANCELLED WorkItem is
operationally terminal too: runs, reviews and criterion verifications are
refused, not just status changes. Evidence, reviews, approvals and criterion
verifications reject id reuse. Timestamps are epoch numbers, never `Date`
objects — `deepFreeze` refuses to persist a `Date` and traverses through
pre-frozen roots so nested arrays cannot stay mutable.

**4. Atomic units of work, start-before-execute.** `FactoryStore.transaction`
stages writes and revalidates them at commit. A worker run happens in three
phases: an atomic START transaction creates the RUNNING attempt and attaches
it to the work item *before* the worker executes — from that commit on, the
in-flight attempt is the lineage head, nothing is releasable, and a release
that commits first makes the start fail before the worker is ever invoked.
Execution happens outside any transaction; an atomic FINALIZE transaction
then completes that exact run with its true outcome, touching only run and
evidence tables so a concurrent item change can never orphan the audit
record. A role may only start in workflow states where it is valid
(`src/workflow/rolePolicy.ts`): no execution-role runs before PLAN_APPROVAL.

### Rules enforced in code

| Rule | Where |
| --- | --- |
| Only declared transitions are legal | `src/workflow/transitions.ts` |
| No `IMPLEMENTING -> DONE`; `DONE` only from `WAITING_FOR_HUMAN` | `src/workflow/transitions.ts` |
| Each of the four evidence-bearing edges requires real, current records | `src/workflow/preconditions.ts`, `src/workflow/releaseSnapshotResolver.ts` |
| A verification/review names the exact implementation run it examined | `src/domain/run.ts` (`targetRunId`), `src/domain/review.ts` |
| `PLAN_APPROVAL` is decidable only at `PLAN_REVIEW`, bound to `specRevision` | `src/domain/approval.ts`, `src/app/factoryService.ts` |
| `RELEASE_APPROVAL` is decidable only at `WAITING_FOR_HUMAN`, bound to the snapshot hash | `src/app/factoryService.ts`, `src/workflow/gateGuard.ts` |
| ANY newer implementation attempt (even FAILED) invalidates prior verification, review and approval | `src/workflow/releaseSnapshotResolver.ts` |
| The latest applicable review is authoritative; a newer FAIL blocks release | `src/workflow/releaseSnapshotResolver.ts` |
| Criterion proof only counts from the current verifier generation — older PASSes cannot fill gaps or override a current FAIL | `src/workflow/releaseSnapshotResolver.ts` |
| Run create/complete inputs are captured single-read; hostile getters cannot validate clean and store dirty | `src/adapters/memory/inMemoryStore.ts` |
| A RUNNING attempt is durable and attached before its worker executes; in-flight work blocks release | `src/app/factoryService.ts` (three-phase `runWorker`), `src/workflow/releaseSnapshotResolver.ts` |
| Worker roles start only in workflow states where the operation is valid | `src/workflow/rolePolicy.ts` |
| DONE/CANCELLED items refuse all production-state operations | `src/app/factoryService.ts` (`requireOperableWorkItem`) |
| `BLOCKED` can only resume to the exact status it was blocked from | `src/workflow/workflowService.ts` |
| Protected human decisions (approvals *and* cancellation) need a verified token | `src/app/factoryService.ts`, `src/workflow/workflowService.ts` |
| Worker output cannot move a work item or open a gate (C3, C5) | `src/ports/worker.ts`, `src/workflow/workflowService.ts` |
| A worker's thrown exception is persisted as a FAILED run, never left RUNNING | `src/app/factoryService.ts` |
| Reviewer independence compares registry-issued principals (C4) | `src/adapters/security/localWorkerRegistry.ts`, `src/app/factoryService.ts` |
| Acceptance criteria are verified from a run's own evidence, never a claim (C3) | `src/app/factoryService.ts` |
| Terminal runs are immutable; audit tables are append-only | `src/ports/repositories.ts`, `src/adapters/memory/inMemoryStore.ts` |
| Multi-record writes are atomic; stale writers get `ConcurrencyError` | `src/adapters/memory/inMemoryStore.ts` |
| Domain names no AI vendor (C9) | `src/domain/`, `src/ports/worker.ts` |

### Trust boundaries, and their limits

TASK-001 adds no external auth infrastructure. `HumanIdentityGate` checks a
locally-configured credential before minting a short-lived signed token;
`WorkerRegistry` anchors worker identity to in-process object identity. Both
are documented in their adapters as bootstrap-scale boundaries, not as
substitutes for real authentication or process isolation. Workers never
receive the credential, the gate, or the registry.

## Durable Persistence (TASK-002)

Everything above described the in-memory adapter (`src/adapters/memory/`),
which is still what `npm test` and `sf demo` use — fast, no disk I/O. TASK-002
adds a second adapter, `src/adapters/sqlite/`, satisfying the exact same
`FactoryStore` port so the domain and `FactoryService` needed **zero**
changes.

### Where data lives

The persistent demo's database defaults to `.factory-data/factory.db` under
the current working directory. Override with `FACTORY_DB_PATH` or by passing
`dbPath` to `runPersistentDemo`. The whole `.factory-data/` directory (plus
any stray `*.db`/`*.sqlite` files and their `-wal`/`-shm` siblings) is
gitignored — runtime data is never committed.

### Why SQLite via `node:sqlite`, no ORM

`node:sqlite` has shipped in Node since 22.5 (still marked experimental
upstream; exercised here on Node 22.23). It needed no new dependency and no
query-builder/ORM layer — the adapter is ~450 lines of explicit SQL because
the schema is eight small tables, one per repository.

### How the same guarantees hold with a different mechanism

| TASK-001 guarantee (in-memory) | TASK-002 mechanism (SQLite) |
| --- | --- |
| Staged overlay + revalidate at commit | Real `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`, serialized by an in-process FIFO mutex so two logical units of work never touch the one `DatabaseSync` connection at once (`node:sqlite` throws on nested transactions) |
| `WorkItem.compareAndSave` rejects a stale `version` | A real `UPDATE work_items SET ... WHERE id = ? AND version = ?`; `changes = 0` means stale, and throws `ConcurrencyError` |
| `Run.complete` only from `RUNNING`, exactly once | `UPDATE runs SET status = ?, data = ? WHERE id = ? AND status = 'RUNNING'`, `changes = 0` means already terminal |
| Append-only Evidence/Review/Approval/Verification | The `id` `PRIMARY KEY`'s own `UNIQUE` constraint; the violation is translated to `AppendOnlyViolationError` |
| Every returned value is frozen; no `Date` ever persisted | Same `deepFreeze` (`src/domain/freeze.ts`) applied to every row on the way in and on the way back out of JSON |
| Insertion-order reads (`.at(-1)` semantics the resolver relies on) | SQLite's implicit `rowid`, `ORDER BY rowid ASC` |
| Hostile getters can't validate-clean-store-dirty (`captureRun`/`captureCompletion`) | Extracted into `src/adapters/shared/runCapture.ts` and used by **both** adapters, so this guarantee cannot silently diverge between them |

One genuine behavioral difference, not a regression: the in-memory adapter's
`transaction()` opens an independent overlay per call, so two *concurrent*
`transaction()` calls can each read the same pre-race snapshot and race on
the final write (one wins, one gets `ConcurrencyError`). The SQLite adapter's
mutex fully serializes transactions, so a second transaction's read always
sees the first's already-committed result — closer to how a real database
behaves under `BEGIN IMMEDIATE`. Concretely: two concurrent
`FactoryService.advance()` calls against the in-memory store can produce one
winner and one `ConcurrencyError` loser; against the SQLite store, the second
call's fresh read may find a *different* legitimate transition and succeed
too, rather than losing a race. Both behaviors are correct — races are still
never allowed to corrupt state or double-apply a change, which is what
`tests/persistenceRollback.test.ts` proves for SQLite specifically, alongside
`tests/support/storeContract.ts`, which runs the same append-only/CAS/
run-lifecycle/atomicity assertions against **both** adapters.

### Restart proof

`tests/persistenceRestart.test.ts` builds a fully-released work item through
one store instance, closes it, opens a second instance against the same
database file, and confirms identical status/version/specRevision/history
plus every run/evidence/review/approval/criterion-verification — and that a
brand-new `FactoryService` built on the reopened store still enforces every
invariant (forged cancellation still refused, a new worker run still
succeeds). `npm run demo:persistent` demonstrates the same thing from the
CLI: run it once to seed and watch an in-process close+reopen; run it again
(a genuinely new OS process) to see a previous process's data read back with
no re-seeding.

### Schema versioning

`src/adapters/sqlite/schema.ts` stamps a `schema_meta.schema_version` row on
a fresh database and refuses to open one written by a different version
(`SchemaVersionError`) rather than guessing. TASK-002 ships no migration
runner — only this detection — so a later migration mechanism has a safe
failure mode to build on.

## Worker Runner (TASK-003)

TASK-001/002 could represent a worker run; nothing could actually launch a
real AI CLI. TASK-003 adds that: the Factory can spawn a real, local,
non-interactive Claude Code or Codex CLI process itself, feed it a prompt,
and turn its process-level outcome into a normalized `WorkerOutcome` through
the exact same `FactoryService.runWorker` three-phase lifecycle TASK-001/002
already proved durable — no new persistence path, no weakened invariant.

### Layout additions

```
src/ports/processRunner.ts       explicit process-execution contract (no shell, ever)
src/adapters/process/            node:child_process implementation: timeout/cancel -> SIGTERM -> SIGKILL,
                                  bounded output capture, exactly-once settlement
src/adapters/workers/workspace.ts        explicit, validated workspace boundary
src/adapters/workers/environmentPolicy.ts  env allowlist (default-deny) + best-effort output redaction
src/adapters/workers/promptTemplates.ts    one small template per FactoryRole
src/adapters/workers/workerModelConfig.ts  tool/model/effort/timeout as configuration, not code
src/adapters/workers/cliWorker.ts          shared Worker-port engine used by both adapters
src/adapters/workers/claudeCodeAdapter.ts  Claude Code CLI adapter (invocation independently verified)
src/adapters/workers/codexCliAdapter.ts    Codex CLI adapter (invocation independently tested)
src/cli/workerDoctor.ts, src/cli/workerSmoke.ts   `sf worker doctor` / `sf worker smoke <tool>`
tests/fixtures/fake-clis/        fake executables (plain Node scripts) all offline tests spawn instead
```

### Process isolation

`executable` and `argv` are always passed to `child_process.spawn` as
separate values — `shell` is never `true`, so there is no shell-injection
surface regardless of what a prompt or instruction string contains. Timeout
and cancellation escalate SIGTERM → (grace period) → SIGKILL against the
child's whole process group (`detached: true` + a negative-pid signal), so a
CLI that shells out to git/ripgrep/etc. as grandchildren is terminated too.
stdout/stderr are captured up to a configurable byte cap (default 5 MiB per
stream); a chatty child is still drained past the cap so it can never
deadlock the runner, and truncation is recorded rather than hidden.

### Environment and workspace boundaries

`process.env` is never forwarded wholesale to a worker child process. Only
an explicit, default-deny allowlist (`PATH`, `HOME`, `CODEX_HOME`, and a
handful of other locale/temp-dir variables — see
`DEFAULT_WORKER_ENV_ALLOWLIST` in `environmentPolicy.ts`) is forwarded, so
each CLI authenticates through its own already-configured local credential
store rather than the Factory ever touching a secret. Captured process
output additionally passes through a best-effort secret-pattern redactor
before becoming Evidence — defense in depth, not a substitute for the
allowlist.

A worker's workspace (`resolveWorkspace` in `workspace.ts`) is trusted
configuration supplied when an adapter is constructed — `WorkerRequest` (the
data a `Worker.execute()` call actually receives) has no `cwd` field at all,
so there is no path for a prompt or instruction string to choose a
process's working directory. The resolved path must exist, be a directory,
and (by default) be a git repository.

### Claude Code and Codex CLI adapters

Both implement the provider-neutral `Worker` port
(`src/ports/worker.ts`) through a shared engine
(`src/adapters/workers/cliWorker.ts`) that keeps two channels strictly
separate: the **process execution result** (exit code / timeout / spawn
failure — from the OS) decides `WorkerOutcome.status`, while the **tool's
own reported text** (parsed from its stdout) is attached as informational
evidence/summary only. A process that exits 0 while printing "I failed" is
still `SUCCEEDED`; a process that exits non-zero while printing "PASS" is
still `FAILED`. `claimsAcceptanceMet` is always `false` from a real CLI
adapter in TASK-003 — no free-form model text is trusted as a claim
(PASS/CHANGES_REQUIRED parsing is explicit TASK-004 scope).

**Codex CLI** — invocation independently tested against the real `codex`
binary (v0.147.0) on the development machine, not assumed from memory:

```
codex exec --json -C <workspaceRoot> -m <model> [-c model_reasoning_effort="<effort>"] \
  --sandbox <read-only|workspace-write> "<prompt>"
```

`--sandbox workspace-write` only for the `IMPLEMENTER` role; every other
role gets `read-only`. `--json` prints one JSON object per line
(`item.completed` with the final `agent_message` text is the parsed
"reported" channel). Full experiment log:
`docs/tasks/TASK-003-worker-runner.md`.

**Claude Code CLI** — the `claude` binary was not installed when this
adapter was first built (only the VS Code extension was present, which is
not a subprocess-invocable non-interactive CLI); it was implemented against
the publicly documented flag surface only, with every capability the
`--help` output couldn't confirm reported as honestly not-applied. Once a
real binary (2.1.235) became available, the invocation was independently
tested and corrected against it, not assumed from memory:

```
claude -p "<prompt>" --model <model> --output-format json \
  [--effort <low|medium|high|xhigh|max>] --permission-mode <plan|acceptEdits>
```

`--output-format json` prints one JSON result object with a `.result`
string field (confirmed — this matched the adapter's original guess).
`--effort` turned out to be a real, working flag (the original assumption
that none existed was wrong and has been corrected). `--permission-mode
plan` is used for every role except `IMPLEMENTER`, which gets
`acceptEdits` — the Claude-side equivalent of Codex's `read-only` /
`workspace-write` split, added once `--help` confirmed the flag exists.
Because the two-channel design above means a wrong flag assumption fails
safe (a clean `FAILED` run with real stderr/stdout as evidence, never a
false success), the originally-shipped unverified version was safe despite
being wrong about effort — this is the corrected, verified version. Full
experiment log and the preserved "originally unavailable" history:
`docs/tasks/TASK-003-worker-runner.md`; file header of
`claudeCodeAdapter.ts` for the code-level detail.

Effort/reasoning level is `WorkerModelConfig` data, never hardcoded. Codex
applies it via `-c model_reasoning_effort=...` (only for a plain-token
value — anything else is refused with a recorded reason rather than risking
an unescaped config override); Claude Code applies it via `--effort` (only
for one of its five documented levels — anything else is refused the same
way).

### `sf worker doctor` / `sf worker smoke`

```bash
npm run worker:doctor        # reports found/not-found + version for claude and codex, no secrets printed
npm run smoke:codex-worker   # REAL invocation of the installed Codex CLI — burns real usage
npm run smoke:claude-worker  # REAL invocation of the installed Claude Code CLI — burns real usage
npm run smoke:workers        # both smoke tests
```

Neither smoke command runs as part of `npm test`. Each drives a real
`FactoryService.runWorker` call (proving the *Factory* launched the CLI, not
just the adapter in isolation) with role `REVIEWER` against a zero-cost mock
implementation run, in a brand-new throwaway git-initialized scratch
directory under the OS temp dir — never this repository — with a short
timeout and a read-only prompt ("list the files here and confirm you can
see them; do not modify anything").

### Tests never touch a real AI CLI

Every automated test (`npm test`) spawns a **fake** CLI — a plain Node
script under `tests/fixtures/fake-clis/`, run via `process.execPath` (or
directly, via its own shebang) — never `claude`/`codex`. `fake-codex.mjs`
mimics the independently-verified real `codex exec --json` contract exactly
(JSONL events, exit codes, an env-var-controlled failure/timeout mode) so
`codexCliAdapter.ts` is exercised against a faithful simulation. Argv
construction and output parsing are pure functions
(`buildCodexInvocation`/`buildClaudeInvocation`,
`extractCodexFinalMessage`/`extractClaudeFinalMessage`) tested directly with
no process spawned at all; `execute()` end-to-end behavior (success,
non-zero exit, timeout, spawn failure) is tested against the fake
executables. `tests/workerRunnerPersistence.test.ts` proves the SQLite
durability chain specifically for a real spawned process: the RUNNING run is
read back — through the same store instance — while a deliberately slow
fake CLI is still mid-flight, then the run is finalized exactly once and
survives a store close+reopen.

### Known limitations (TASK-003)

- No PASS/CHANGES_REQUIRED free-text parsing yet; `claimsAcceptanceMet` is
  always `false` from a real CLI worker (explicit TASK-004 scope).
- No autonomous implement → verify → review loop, no remediation loop, no
  GitHub Issues/PR integration, no Telegram/n8n, no server deployment, no
  full model router, no multi-machine scheduling — all later phases.
- The environment allowlist and secret redaction are bootstrap-scale
  defenses (an explicit list plus regex patterns), not a substitute for
  running workers in a fully isolated credential boundary later.
