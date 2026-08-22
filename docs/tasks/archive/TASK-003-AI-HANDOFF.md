# AI HANDOFF

Status: IMPLEMENTED_AWAITING_VERIFICATION
Current task: TASK-003
Plan version: worker-runner-v1

Prior task: TASK-002 (Durable Persistence + Run Ledger) shipped as commit
`29c1d61` after a three-round independent persistence review. Its full
implementer/reviewer history is archived at
`docs/tasks/archive/TASK-002-AI-HANDOFF.md`.

## Implementer output

Worker: Claude Code (Sonnet 5), role IMPLEMENTATION ENGINEER.

Wrote `docs/tasks/TASK-003-worker-runner.md` before implementation (per
protocol), then added the worker-execution layer: a process-isolation
abstraction, an environment/workspace boundary, and real Claude Code / Codex
CLI adapters, all plugging into the **existing, unchanged**
`FactoryService.runWorker` three-phase lifecycle from TASK-001/002. No line
of `src/domain/`, `src/workflow/`, or `src/app/factoryService.ts` changed.

### 1. Environment finding, and how it was handled

The `claude` CLI binary is not installed on this machine — only the VS Code
extension is present, which is not a subprocess-invocable non-interactive
CLI. Confirmed by exhaustive search (PATH, `npm ls -g`, shell rc files,
`/usr/local/bin`, `~/.claude/local`, a filesystem-wide search for
`claude-code`/`cli.js`), and the configured npm registry (a corporate proxy,
`registry.hmb.gov.tr`) is unreachable from this sandbox, so installing it
would have required bypassing that registry — a global, persistent machine
change outside this task's scope. Asked the user how to proceed
(`AskUserQuestion`); they chose to handle installing/locating the real CLI
separately. Consequence, carried through honestly rather than silently
assumed: the Codex adapter's invocation was independently tested against the
real `codex` binary (v0.147.0, authenticated); the Claude Code adapter is
implemented against the CLI's publicly documented flag surface only,
explicitly flagged UNVERIFIED everywhere it matters (file header, README,
this report, acceptance criteria), and not real-smoke-tested. `sf worker
doctor` reports this machine's actual state at any time.

### 2. Real, tested Codex CLI invocation

```
codex exec --json -C <workspaceRoot> -m <model> [-c model_reasoning_effort="<effort>"] \
  --sandbox <read-only|workspace-write> "<prompt>"
```

Verified by direct experiment (not memory): exit 0 on success, exit 1 with
structured `ERROR` events on a bad model name; `--json` prints JSONL
(`thread.started`/`turn.started`/`item.completed` with the final
`agent_message` text/`turn.completed`); `-o/--output-last-message` writes
just the final text to a file (not used — JSONL parsing keeps everything
within captured stdout, no extra file lifecycle); `-c
model_reasoning_effort="<level>"` genuinely overrides the configured effort
per-invocation (config default `xhigh` → overridden to `low`, confirmed via
the CLI's own printed banner); `codex exec` has no approval-prompt flag at
all (rejected as unexpected), so sandbox alone governs safety with no
interactive-hang risk; stdin is explicitly closed by the adapter (never left
inherited). Full experiment transcript in
`docs/tasks/TASK-003-worker-runner.md`.

### 3. Claude Code CLI invocation — UNVERIFIED

```
claude -p "<prompt>" --model <model> --output-format json
```

Documented, not tested. No permission-bypass flag is passed (which one would
even be safe/correct cannot be confirmed without the real binary); effort is
always reported as requested-but-not-applied (no verified flag). Because
`WorkerOutcome.status` is derived only from the process's actual exit
code/termination — never from parsed stdout (see design point 5) — a wrong
flag assumption here fails safe: worst case is a clean `FAILED` run with
real stderr/stdout as evidence, or a `TIMEOUT`-terminated `FAILED` run if
the process hangs on something unanticipated (e.g. an interactive
permission prompt) — never a false success. Must be re-verified for real
(`npm run smoke:claude-worker`) once a `claude` binary is available.

### 4. Process isolation / security controls

- `src/ports/processRunner.ts` + `src/adapters/process/nodeProcessRunner.ts`:
  `child_process.spawn(executable, argv, { cwd, env })` only — `argv` is
  always an array, `shell` is never set, so there is no shell-interpolation
  surface regardless of prompt/instruction content.
- Timeout/cancellation escalate SIGTERM → (grace period) → SIGKILL against
  the child's whole process group (`detached: true`, negative-pid signal),
  so grandchildren (git, ripgrep, etc. a CLI shells out to) are terminated
  too, not just the immediate child.
- Exactly one `close` listener settles the result; a `settled` guard plus a
  `requestedReason` flag (not a second racing listener) makes a timeout that
  fires microseconds before a natural exit — or vice versa — resolve
  deterministically to one outcome. Proven directly:
  `tests/processRunner.test.ts` "exactly-once settlement" and the
  does-not-report-TIMEOUT/CANCELLED-when-the-process-exits-first tests.
- stdout/stderr are bounded (default 5 MiB/stream); a chatty child is still
  drained past the cap rather than deadlocking the runner on backpressure,
  and truncation is recorded (`stdoutTruncated`/`stderrTruncated`).
- stdin is always explicitly ended (`child.stdin.end(input)`), never left
  open/inherited; a child that closes its own stdin early cannot crash the
  runner (stream `error` listeners are no-ops).
- `src/adapters/workers/environmentPolicy.ts`: `process.env` is never
  forwarded wholesale. `DEFAULT_WORKER_ENV_ALLOWLIST` names only
  `PATH`/`HOME`/`CODEX_HOME`/locale/temp-dir variables — no API
  key/token/secret name is ever on it (asserted directly by a test). A
  best-effort `redactSecrets` regex pass runs on captured output before it
  becomes Evidence, as defense in depth.
- `src/adapters/workers/workspace.ts`: a worker's `cwd` is trusted
  configuration supplied at adapter construction. `WorkerRequest` (the only
  data `Worker.execute()` receives — see `src/ports/worker.ts`) has no `cwd`
  field at all, so there is no path for model-generated text to choose a
  process's working directory. `resolveWorkspace` requires the path to
  exist, be a directory, and (by default) be a git repository.
- Codex's `--sandbox` is role-derived: `workspace-write` only for
  `IMPLEMENTER`, `read-only` for every other role.
- The Codex effort override (`-c model_reasoning_effort=...`) only accepts a
  plain token (`^[a-zA-Z0-9_-]+$`); anything else is refused with a recorded
  reason rather than risking an unescaped Codex-side TOML override.

### 5. Structured result / model-vs-process separation

`src/adapters/workers/cliWorker.ts` is the one place both adapters share.
Core discipline: `ProcessResult` (OS-level: exit code, termination reason)
decides `WorkerOutcome.status`; the tool's own reported text
(`CliReportedResult`, parsed from stdout by each adapter's
`interpretOutput`) is attached as informational evidence/summary only and
never influences status. Tested directly both ways: a process that exits 0
while `FAKE_CODEX_MESSAGE="I failed"` still reports `SUCCEEDED`; a process
that exits 1 while `FAKE_CODEX_MESSAGE="PASS"` still reports `FAILED`.
`claimsAcceptanceMet` is always `false` from a real CLI adapter — no
PASS/CHANGES_REQUIRED free-text parsing exists yet (explicit TASK-004
scope), so no free-form model text is ever treated as a trusted claim.
Process-level failure (non-zero exit, timeout, cancellation, spawn error)
returns a `FAILED` `WorkerOutcome` with rich, adapter-supplied diagnostic
evidence rather than throwing — a thrown exception is reserved for genuine
adapter/programmer bugs (proven distinctly in
`tests/workerRunnerIntegration.test.ts`).

### 6. Model/effort configuration

`src/adapters/workers/workerModelConfig.ts`: `WorkerModelConfig` (tool,
model, effort, timeout) is plain configuration passed to
`createClaudeCodeWorker`/`createCodexCliWorker` — nothing about which
model/effort a run uses is hardcoded in workflow or adapter logic. `tool`
(`"claude-code"`/`"codex-cli"`) and `model` are always distinct fields,
never conflated (C9). `EffortApplication` makes honesty about capability
explicit and structured rather than silently dropped: Codex reports
`applied: true` for a safe token, `applied: false` with a reason for an
unsafe one or when unset; Claude Code always reports `applied: false` with
a reason (no verified flag).

### 7. Same-run lifecycle / persistence

Not reimplemented — reused. `FactoryService.runWorker`'s existing
PHASE1(durable RUNNING)/PHASE2(execute)/PHASE3(finalize-exactly-once)
transaction structure (TASK-001 Round-6, TASK-002-proved durable) already
gives every CLI adapter: RUNNING persisted before the child process starts,
the same run finalized exactly once regardless of success/non-zero
exit/timeout/cancellation/spawn failure, and no work-item status change from
a worker result. New proof this task adds is that a *real spawned process*
(a fake CLI, never a real AI provider, in automated tests) goes through this
identical path:

- `tests/workerRunnerIntegration.test.ts` (in-memory store): Codex/Claude-
  backed workers through the real three-phase lifecycle; FAILED-not-RUNNING
  on non-zero exit/timeout/spawn failure; two distinct adapter `Worker`
  objects get two distinct registry-issued principals even with the same
  declared id; a Codex-backed IMPLEMENTER + Claude-backed REVIEWER complete
  an independent `SEMANTIC` review (C4) with genuinely different tools
  behind the two principals; a same-Claude-worker self-review is still
  refused with `REVIEW_INTEGRITY`; a throwing adapter (a real bug, not a
  process result) still leaves an honest `FAILED` run via
  `WorkerExecutionError`.
- `tests/workerRunnerPersistence.test.ts` (real SQLite file): starts a run
  against a deliberately slow fake CLI, reads the `RUNNING` row back
  through the *same store instance* while the child is still mid-flight
  (proving PHASE 1 committed before PHASE 2 finished, not just before it
  started), awaits completion, confirms `SUCCEEDED` and exactly one run
  record, closes the store, reopens a new store instance against the same
  file, and confirms the run and its evidence are still there, principal id
  intact.

### 8. Tests

All new automated tests are fully offline — no real AI CLI is ever spawned
by `npm test`. Fake CLIs live at `tests/fixtures/fake-clis/` as plain Node
scripts, run either via `process.execPath <script>` (generic process-runner
fixtures) or directly via their own shebang + exec bit (the two adapter
fixtures, `fake-codex.mjs`/`fake-claude.mjs`, which must themselves act as
"the executable" to exercise the adapters' real `executable`/`argv`
plumbing). `fake-codex.mjs` mimics the independently-verified real `codex
exec --json` contract (JSONL events, exit codes, env-var-controlled
failure/timeout modes) so `codexCliAdapter.ts` is exercised against a
faithful simulation, not a guess.

New suites: `tests/processRunner.test.ts` (19 tests: argv/cwd/stdin/env
exactness, clean/non-zero exit, spawn failure incl. bad executable and bad
cwd, timeout incl. SIGKILL escalation against a SIGTERM-ignoring process,
cancellation incl. already-aborted and races-against-natural-exit, bounded
capture incl. large-output draining and truncation, hostile early-stdin-
close, exactly-once settlement under a timeout/close race),
`tests/environmentPolicy.test.ts`, `tests/workspace.test.ts`,
`tests/promptTemplates.test.ts`, `tests/codexCliAdapter.test.ts` (pure argv/
effort/output-parsing unit tests plus fake-CLI end-to-end execute() tests),
`tests/claudeCodeAdapter.test.ts` (same shape, explicitly noting the
UNVERIFIED-contract caveat in its own header),
`tests/workerRunnerIntegration.test.ts`,
`tests/workerRunnerPersistence.test.ts`.

Two real fixture-timing bugs were found and fixed while stabilizing this
suite (both about output flushing on POSIX pipes, not adapter logic): (a)
several fixtures called `process.exit()` immediately after
`process.stdout.write()`, which is asynchronous on a piped stdout on POSIX
and can be truncated by an immediate exit — fixed by switching to
synchronous `fs.writeSync(1, ...)` fd writes, or by not calling `exit()` at
all where the fixture doesn't need a specific exit code; (b) the
SIGKILL-escalation test used a 100 ms timeout that was occasionally too
tight for a **fresh `node` child process's own startup** (module load,
handler registration) under a loaded machine, killing it before it had run
any of its code at all — fixed by widening that one test's margin to
500 ms/300 ms grace, which is about the escalation actually working, not
sub-100 ms responsiveness. Confirmed stable across 6 consecutive full-suite
runs after both fixes (325/325 every time; before the fixes, 1/325 failed
intermittently, always the same test).

### 9. Real smoke-test results

`npm run worker:doctor` on this machine:

```
claude-code (claude): NOT FOUND (tried "claude") — spawn claude ENOENT
codex-cli (codex): found (codex), version: codex-cli 0.147.0
```

`npm run smoke:codex-worker` (real, controlled, one invocation — through
`sf worker smoke codex`, i.e. through the actual `FactoryService.runWorker`
path, not just the adapter in isolation):

```
scratch workspace: /tmp/sf-worker-smoke-codex-E32NK9
launching codex (executable=codex, model=gpt-5.6-luna, timeoutMs=60000) against <scratch> ...
run run-0002 status=SUCCEEDED
summary: [codex-cli:gpt-5.6-luna] role=REVIEWER exit=0: I can see `.git/` and `README.md` in the workspace.
evidence [NOTE] cli://codex-cli/run/run-0002: codex-cli model=gpt-5.6-luna role=REVIEWER exit=0 duration=17174ms
evidence [NOTE] cli://codex-cli/run/run-0002/transcript: I can see `.git/` and `README.md` in the workspace.
```

Scratch workspace removed afterward. `npm run smoke:claude-worker` was
**not** run at this point in the task — no `claude` binary existed on this
machine to invoke. (It was run successfully in a later continuation once
the CLI became available — see "Implementer follow-up" below.)

### 10. Files changed

Created: `docs/tasks/TASK-003-worker-runner.md`;
`src/ports/processRunner.ts`; `src/adapters/process/nodeProcessRunner.ts`;
`src/adapters/workers/{workspace,environmentPolicy,promptTemplates,
workerModelConfig,cliWorker,claudeCodeAdapter,codexCliAdapter}.ts`;
`src/cli/{workerDoctor,workerSmoke}.ts`;
`tests/{processRunner,environmentPolicy,workspace,promptTemplates,
codexCliAdapter,claudeCodeAdapter,workerRunnerIntegration,
workerRunnerPersistence}.test.ts`;
`tests/support/{fakeCli,tempWorkspace}.ts`;
`tests/fixtures/fake-clis/*.mjs` (9 fixture scripts);
`docs/tasks/archive/TASK-002-AI-HANDOFF.md` (this file's prior content,
archived per protocol).

Modified: `src/cli/main.ts` (added `worker doctor`/`worker smoke` dispatch,
lazy-imported like `demo:persistent` so `sf demo`/`sf transitions` pay no
extra cost); `package.json` (`worker:doctor`, `smoke:claude-worker`,
`smoke:codex-worker`, `smoke:workers` scripts — none run by `test`);
`README.md` (new "Worker Runner (TASK-003)" section); `AI-HANDOFF.md` (this
file).

Not touched: `src/domain/`, `src/workflow/`, `src/app/factoryService.ts`,
`src/ports/{worker,workerRegistry,repositories}.ts`, either persistence
adapter, any TASK-001/002 test.

### 11. Exact verification results (clean state)

- `npm run typecheck` — PASS
- `npm run build` — PASS
- `npm test` — **325 tests, 325 pass, 0 fail** (up from 260; +65 from this
  task), confirmed stable across 6 consecutive full runs after the two
  fixture-timing fixes above
- `npm run demo` — DONE, 15 refusals, unchanged
- `npm run demo:persistent` run twice (seed, then a second real OS process
  reading back) — unchanged behavior
- `npm run worker:doctor` — see section 9
- `npm run smoke:codex-worker` — see section 9 (real invocation, SUCCEEDED)
- `git diff --check` — clean
- `git status --short` — matches the files listed above

### 12. Remaining limitations

- No PASS/CHANGES_REQUIRED free-text parsing; `claimsAcceptanceMet` is
  always `false` from a real CLI worker — explicit TASK-004 scope, not an
  oversight.
- No autonomous implement → verify → review loop, no remediation loop, no
  GitHub Issues/Projects/PR integration, no Telegram/WhatsApp/n8n, no server
  deployment, no full model router/benchmark engine, no multi-machine
  worker scheduling.
- The environment allowlist and secret redaction are bootstrap-scale
  defenses (an explicit list plus regex patterns), not a substitute for a
  fully isolated credential boundary a later phase may want.
- Prompt templates (`promptTemplates.ts`) exist for all six `FactoryRole`s
  but only `IMPLEMENTER`/`REVIEWER`/`VERIFIER` are exercised by real
  tests/demo, matching what TASK-003 actually needed to execute.
- All prior TASK-001/TASK-002 limitations still apply unchanged.

### 13. Ready for independent review: YES (pending the follow-up below)

## Implementer follow-up: Claude Code CLI verification

Worker: Claude Code (Sonnet 5), role IMPLEMENTATION ENGINEER. Continuation
of the same TASK-003 work above, triggered by the human installing a real
`claude` binary (via a one-command `npmjs.org` registry override for that
one install only — no global npm registry configuration was changed) and
asking for the previously-unverified adapter to be checked against it. This
is a correction pass, not a restart: no code outside the Claude adapter and
its tests changed.

**1. Claude path/version**

```
command -v claude   -> /home/hakan/.nvm/versions/node/v22.23.1/bin/claude
claude --version    -> 2.1.235 (Claude Code)
claude doctor       -> No installation issues found.
```

**2. Actual tested Claude invocation**

```
claude -p "<prompt>" --model <model> --output-format json \
  [--effort <low|medium|high|xhigh|max>] --permission-mode <plan|acceptEdits>
```

Full experiment detail in `docs/tasks/TASK-003-worker-runner.md` ("Real,
tested Claude Code CLI invocation"). Summary of what a real `claude --help`
plus three minimal, harmless, non-tool-using probes actually showed:

- `-p`/`--print` + a positional prompt argument: confirmed correct.
- `--output-format json` prints exactly one JSON object with a `.result`
  string field: **confirmed correct** — this was already the adapter's
  primary parsing path before the real binary was available, so no change
  was needed there.
- `--effort <level>` (choices: low, medium, high, xhigh, max): **real and
  working** — accepted without error in a live call. The original
  assumption that no such flag existed was wrong.
- `--permission-mode <mode>` (choices: acceptEdits, auto, bypassPermissions,
  manual, dontAsk, plan): real and documented; not previously used at all.
- No `-C`/`--cwd`-equivalent flag exists: confirmed absent, matching the
  original assumption that the child process's OS-level `cwd` (which
  `ProcessRunner` always sets) is the only mechanism.
- Authentication is file-based (`$HOME/.claude/.credentials.json`); a probe
  run with `env -i HOME=$HOME PATH=$PATH` (i.e. shaped exactly like the
  adapter's own restricted environment allowlist) succeeded, confirming
  `DEFAULT_WORKER_ENV_ALLOWLIST` needs no changes for Claude to
  authenticate.

**3. Differences from previous adapter assumptions**

Two corrections, both narrowly scoped to `claudeCodeAdapter.ts`:

- Effort was previously always reported `applied: false` ("no verified
  flag"). Now `resolveClaudeEffort` validates against the CLI's exact
  five-value choice set and applies `--effort <level>` for a valid one,
  honestly refusing (with a reason) anything else — mirroring how
  `resolveCodexEffort` already validated its own TOML-override input.
- Permission/sandbox control was previously entirely absent (deliberately —
  "which flag is correct... cannot be confirmed without the real binary").
  Added `permissionModeForRole`: `acceptEdits` for `IMPLEMENTER`, `plan` for
  every other role — the direct Claude-side counterpart to
  `codexCliAdapter.ts`'s `sandboxForRole` (`workspace-write` only for
  `IMPLEMENTER`, `read-only` otherwise), now that the task explicitly asked
  for permission/sandbox controls to be verified and the real `--help`
  output confirmed the flag and its choices.

Everything else (the `-p`/`--model`/`--output-format json` core, the
process-exit-decides-status discipline, no `claimsAcceptanceMet` trust,
environment allowlist, workspace-via-`cwd`) was already correct and is
unchanged.

**4. Changes made**

- `src/adapters/workers/claudeCodeAdapter.ts`: file header rewritten from
  "UNVERIFIED" framing to the confirmed invocation, with the prior
  unavailability preserved as an explicit historical note (not deleted);
  `resolveClaudeEffort` now validates/applies a real flag; added
  `permissionModeForRole`; `buildClaudeInvocation` now appends `--effort`
  (when applicable) and always appends `--permission-mode`.
- `tests/claudeCodeAdapter.test.ts`: updated the argv-shape and effort
  tests for the corrected behavior; added a `permissionModeForRole` test
  and an argv test covering the `--effort`+`--permission-mode plan` path.
  No fake-CLI fixture changes were needed.
- `docs/tasks/TASK-003-worker-runner.md`: added the "Real, tested Claude
  Code CLI invocation" section; updated the environment-finding section to
  preserve history while recording the update; marked acceptance criteria
  2 and 15 satisfied for Claude.
- `README.md`: replaced the "Claude Code CLI — UNVERIFIED" paragraph with
  the verified one; removed the now-resolved bullet from "Known
  limitations".
- `AI-HANDOFF.md`: this section.

No file outside this list changed. No source file was modified by either
real Claude invocation itself (both ran against a throwaway scratch
directory, never this repository) — confirmed by `git status --short`
before and after showing only the intentional edits above.

**5. Real Claude smoke result**

One minimal direct probe first (a trivial, tool-free prompt, run twice: once
with the shell's ambient environment to learn the real output shape, once
with an `env -i HOME=... PATH=...` environment to confirm the adapter's
restricted allowlist is sufficient for authentication) — both exit 0,
`result: "OK"`. Then exactly one real Factory-path smoke run through the
implemented path (`sf worker smoke claude`, i.e.
`FactoryService.runWorker` -> durable RUNNING Run -> `ClaudeCodeWorker` ->
`ProcessRunner` -> real `claude` CLI -> normalized result/evidence -> same
Run finalized terminally):

```
scratch workspace: /tmp/sf-worker-smoke-claude-qf1dgU
launching claude (executable=claude, model=claude-sonnet-5, timeoutMs=60000) against <scratch> ...
run run-0002 status=SUCCEEDED
summary: [claude-code:claude-sonnet-5] role=REVIEWER exit=0: I can see the workspace contents: a `.git` directory and a `README.md` file.
evidence [NOTE] cli://claude-code/run/run-0002: claude-code model=claude-sonnet-5 role=REVIEWER exit=0 duration=24477ms
evidence [NOTE] cli://claude-code/run/run-0002/transcript: I can see the workspace contents: a `.git` directory and a `README.md` file.
```

Verified: the real CLI was genuinely launched (the model's answer correctly
describes the scratch directory's actual contents, which only exist because
`sf worker smoke claude` created them); `run-0002` (not `run-0001`, the
zero-cost mock IMPLEMENTER placeholder the smoke harness seeds first) is the
real-CLI run, meaning `runWorker`'s PHASE 1 durably attached it before
execution — the same structural guarantee already proven exhaustively by
`tests/workerRunnerPersistence.test.ts` for a process-backed worker, not
re-derived per invocation here; process exit status (0) is what decided
`SUCCEEDED`, not the printed text; evidence is short, contains no secrets,
and used `plan` permission-mode (read-only intent) since role was
`REVIEWER`; exactly one run record for the real CLI (`run-0002`, terminal);
`git status --short` unchanged by the run; no commit/push occurred. Scratch
workspace and probe directories removed afterward.

**6. Worker doctor result**

```
claude-code (claude): found (claude), version: 2.1.235 (Claude Code)
codex-cli (codex): found (codex), version: codex-cli 0.147.0
```

No credentials printed.

**7. Regression results**

- `npm run typecheck` — PASS
- `npm run build` — PASS
- `npm test` — **328 tests, 328 pass, 0 fail** (up from 325; +3 from the
  new/updated Claude adapter tests), confirmed stable across 3 additional
  consecutive full runs
- `npm run demo` — DONE, 15 refusals, unchanged
- `npm run demo:persistent` run twice (seed, then a second real OS process
  reading back) — unchanged behavior
- `git diff --check` — clean
- `git status --short` — matches the files listed in section 4 above

The real Codex smoke was **not** re-run — no change touched the shared
`cliWorker.ts` engine or `codexCliAdapter.ts`, only `claudeCodeAdapter.ts`
and its own tests, so the prior Codex smoke result (section 9 above)
remains current evidence.

**8. Remaining limitations (updated)**

Unchanged from section 12 above, minus the now-resolved Claude-unverified
item. No new limitation was introduced by this correction.

**9. Ready for independent review: YES**

## Verification output
Pending — an independent verification pass should re-run `npm run verify &&
npm run demo && npm run demo:persistent && npm run worker:doctor` from a
clean checkout, and (separately, deliberately, burning real usage) `npm run
smoke:codex-worker` and `npm run smoke:claude-worker`.

## Reviewer output
Independent defensive review (Codex, 2026-08-20): **CHANGES_REQUIRED**.

### HIGH — captured worker output bypasses redaction in the persisted Run summary

`src/adapters/workers/cliWorker.ts` redacts the parsed final message before
creating transcript Evidence, but `buildSummary()` uses the raw parsed
message. `FactoryService.runWorker()` persists that summary as
`Run.summary`, and `workerSmoke.ts` also prints it directly.

Reproduction with the deterministic fake Codex executable and a synthetic
token-shaped message: transcript Evidence was `[REDACTED]`, while the same
Run summary contained the original value. The value remained present after
closing and reopening the SQLite store. This violates C6 and TASK-003's
requirement that captured output not be blindly persisted when redaction is
claimed.

Smallest remediation: apply the same redaction (and existing summary bound)
to the message before it enters `buildSummary()`/`Run.summary`, then add a
Factory + SQLite regression assertion covering both Evidence and Run
summary after reopen. Do not rely on Evidence redaction alone.

### MEDIUM — workspace validation accepts a false Git repository

`src/adapters/workers/workspace.ts:45` accepts a workspace when
`<root>/.git` merely exists. A temporary directory containing an empty `.git`
directory was accepted by `resolveWorkspace()`, without being a usable Git
repository. This fails the TASK-003 acceptance criterion requiring meaningful
repository validation and can misroute a trusted configuration to an
arbitrary directory that only has a marker with that name.

Smallest remediation: validate the repository using a non-shell Git probe
with explicit argv/cwd (or equivalent strict filesystem validation), and add
the empty/invalid `.git` regression case.

### Non-blocking notes

- `src/cli/workerSmoke.ts` creates a throwaway directory but has no
  `finally` cleanup, so successful and failed smoke runs leave scratch trees
  behind despite the handoff saying they are removed.
- README/layout comments and the fake Claude fixture retain historical
  `UNVERIFIED` wording after the real Claude CLI verification. This does not
  change runtime behavior, but it is stale documentation.

### Verification performed

- Installed tools: Node `v22.23.1`; Claude `2.1.235 (Claude Code)`;
  Codex `codex-cli 0.147.0`. Direct `--help` inspection confirmed the
  adapter argv families, Claude `--effort`/`--permission-mode`, and Codex
  `exec --json`, `-C/--cd`, `-m`, `-c`, and `--sandbox` options.
- Process tests covered argv/cwd/env separation, stdin closure, spawn
  failure, non-zero exit, timeout, SIGTERM/SIGKILL escalation, cancellation,
  natural-exit races, large-output draining, bounded capture, truncation, and
  exactly-once settlement. No shell execution is used.
- Worker integration covered success, non-zero exit, timeout, spawn failure,
  process-result authority over printed PASS/failure text, trusted
  principal binding, reviewer independence, and thrown-adapter failure.
- SQLite integration observed a RUNNING process-backed Run before completion,
  finalized the same Run once, and verified Run/evidence durability after
  close/reopen.
- `npm run typecheck` PASS; `npm run build` PASS; host-permission `npm test`
  PASS (328/328); `npm run demo` PASS; `npm run demo:persistent` PASS on
  initial seed and second-process readback; `npm run worker:doctor` PASS;
  `git diff --check` PASS. Real AI smoke tests were not rerun because the
  existing Claude and Codex smoke artifacts plus direct CLI inspection were
  sufficient and the task explicitly limits repeated usage.
- No automatic TASK-004 loop, commit, push, merge, release, publish,
  external orchestration, or deployment path was found.

## Implementer remediation round 1

Worker: Claude Code (Sonnet 5), role IMPLEMENTATION ENGINEER. Responds to
the independent Codex review directly above (preserved verbatim, not
edited). Closes all three findings — HIGH, MEDIUM, LOW/CLEANUP — plus the
two non-blocking documentation notes. No unrelated refactoring; no
FACTORY_CONSTITUTION.md change; TASK-004 not started.

### 1. HIGH — Run.summary redaction

**Root cause:** `src/adapters/workers/cliWorker.ts`'s `buildEvidence()`
redacted the tool's reported text before it became transcript Evidence, but
`buildSummary()` read `reported.finalMessage` directly and unredacted —
exactly as the reviewer found. `FactoryService.runWorker()` persists that
string as `Run.summary` verbatim.

**Reproduction first:** added `tests/workerOutputRedaction.test.ts`
(SQLite, real close/reopen) and `tests/cliWorker.test.ts` (fast, no process
spawned — a stub `ProcessRunner` stands in), both using the synthetic,
clearly-fake secret `sk-ant-test-1234567890abcdefghijklmnop`. Run against
the pre-fix code, both failed with the leak: `Run.summary` = `"...exit=0:
sk-ant-test-1234567890abcdefghijklmnop"`, Evidence already redacted.
Confirmed the exact asymmetry the review described.

**Fix — one redaction boundary, not a patched string:** added
`safeFinalMessage(reported)` in `cliWorker.ts`, the single place
`reported.finalMessage` is ever read for display/persistence. `execute()`
now calls it once and passes the *already-redacted* value into both
`buildSummary` and `buildEvidence`; neither function accepts a raw
`CliReportedResult` anymore — the type signature itself makes the bug
impossible to reintroduce by accident (a caller literally cannot pass
unredacted text to either builder without changing their signatures back).
The separate raw-stdout/stderr fallback `buildEvidence` uses when nothing
could be parsed was already being redacted at its own call site before this
round and still is — scope stayed on the parsed-message field the review
actually flagged, not a rewrite of Evidence's fallback semantics. Trusted
fields (tool, model, effort, exit code, termination reason, duration,
truncation flags) are Factory-supplied/OS-reported metadata, never
externally-supplied text, and are untouched by redaction — proven by a
dedicated test.

**Proof across SQLite restart:** `tests/workerOutputRedaction.test.ts`
asserts, in order: the `WorkerOutcome`-derived Run/Evidence are clean → the
live store's own `runs.findById` is clean → the store closes → a new store
instance reopens the same file → `runs.findById` and `factory.listEvidence`
are still clean. A second test proves ordinary non-secret output ("All 12
tests passed, no issues found.") is not mangled. `tests/cliWorker.test.ts`
additionally covers `sk-ant-`, `ghp_`, `Bearer`, and labeled `api_key:`
shapes (the patterns `environmentPolicy.ts`'s `redactSecrets` already
claims to detect — no new pattern was added, since the bug was the missing
call, not a missing pattern), plus the raw-stdout-fallback path and the
trusted-metadata-untouched case. 9 new tests total across the two files, all
failing pre-fix and passing post-fix.

### 2. MEDIUM — workspace validation

**Root cause:** `resolveWorkspace()` accepted a workspace whenever
`<root>/.git` existed on disk at all — a directory containing an empty
`.git` file or directory passed, with no real repository behind it.

**Fix:** replaced the filesystem-marker check with a real Git probe run as
a non-shell child process — `git -C <candidate> rev-parse --show-toplevel`
via `node:child_process.spawnSync` (`shell` never set, executable and argv
always separate, `candidate` only ever passed as an argv element / the
child's own `cwd`). Bounded: 10s timeout, and any diagnostic text
(`error.message` or `stderr`) is flattened to one line and capped at 300
chars before it can appear in the thrown `ValidationError` — a test asserts
the thrown message is single-line and bounded, so raw arbitrary Git stderr
is never blindly persisted into Factory audit state.

**Policy decision (explicit, not silent):** `Workspace` gained a second
field, `repositoryRoot` — the real repository root Git reports, distinct
from `root` (the exact directory the caller configured and the one a worker
process actually launches in). A configured workspace **may** be a
subdirectory of an approved repository; `root` stays exactly what was
configured, `repositoryRoot` is canonicalized so the execution boundary is
unambiguous either way. This matches the task's stated preferred TASK-003
behavior. The field is purely additive — nothing else in the codebase
constructs a `Workspace` literal outside `resolveWorkspace()`, confirmed by
a repo-wide search before making the change, so no other call site needed
updating.

### 3. Adversarial workspace tests (A–I)

All nine cases added to `tests/workspace.test.ts`: (A) no `.git` at all →
reject; (B) empty `.git` **file** → reject; (C) empty `.git` **directory**
→ reject (the exact reviewer reproduction); (D) a `.git` directory with
plausible-looking but garbage `HEAD`/`config` content, no real object
database → reject, proving Git's own validation is being used, not a
filename check with a slightly longer checklist; (E) a real temporary repo
root → accept, `repositoryRoot === root`; (F) a real subdirectory inside a
real repo → accept, `root` stays the subdirectory, `repositoryRoot` is the
real top-level; (G) nonexistent path → reject; (H) a file, not a directory
→ reject; (I) a workspace path containing spaces, quotes, `$()`, backticks
and semicolons → resolves correctly with no shell interpolation (proven by
embedding a command substitution shape in the directory name itself and
confirming it is treated as an inert literal path segment). Two more tests
cover a missing `git` executable (controlled `ValidationError`, not a
crash) and the bounded/flattened diagnostic text. All fixtures use `git
init` only — no commit, no dependency on global Git user identity.

One environment note from building case (I): this sandbox's own filesystem
policy independently refuses `mkdir` for a directory name containing an
absolute-path-shaped substring (e.g. literally `/tmp/should-not-run` inside
the name) — unrelated to this code, reproduced and confirmed in isolation
with a standalone Node script before adjusting the test to avoid that
specific shape while keeping every shell-metacharacter case (quotes, `$()`,
backticks, semicolons, spaces) that actually matters for proving no shell
interpolation occurs.

### 4. LOW/CLEANUP — smoke scratch directory cleanup

**Fix:** `src/cli/workerSmoke.ts` now creates the scratch directory, then
runs the entire smoke body (workspace validation, Factory setup, the real
worker run) inside a `try { … } finally { rmSync(scratchRoot, { recursive:
true, force: true }) }`, extracted into a `runSmokeInWorkspace` helper so
the cleanup wrapper stays trivially readable. Cleanup now runs on success,
on a FAILED `WorkerOutcome` (non-zero exit, spawn failure — proven with a
nonexistent executable), and on a thrown adapter error (proven with a
`ProcessRunner` stub that rejects, simulating a genuine adapter bug rather
than an ordinary process failure). Only the exact `mkdtemp`-created path is
ever removed; no other directory is touched. `tests/workerSmoke.test.ts`
(3 tests, using the fake Codex CLI, never a real one) proves all three
paths.

### 5. Non-blocking documentation notes

Both addressed, cheaply, since they were flagged by the same review: the
stale `(UNVERIFIED — see below)` annotation in README's file-layout block
(the surrounding prose had already been corrected in the prior Claude
verification round, this one inline comment was missed) and
`fake-claude.mjs`'s header comment (said "documented (unverified...)",
updated to say "confirmed real-CLI contract"). Runtime behavior unchanged
either way — pure documentation accuracy.

### 6. Files changed this round

Modified: `src/adapters/workers/cliWorker.ts` (redaction boundary),
`src/adapters/workers/workspace.ts` (real Git validation, new
`repositoryRoot` field), `src/cli/workerSmoke.ts` (try/finally cleanup),
`tests/workspace.test.ts` (rewritten with the A–I adversarial suite),
`README.md` (stale wording), `tests/fixtures/fake-clis/fake-claude.mjs`
(stale wording), `AI-HANDOFF.md` (this section).

Created: `tests/workerOutputRedaction.test.ts`, `tests/cliWorker.test.ts`,
`tests/workerSmoke.test.ts`.

Not touched: `src/domain/`, `src/workflow/`, `src/app/factoryService.ts`,
`src/ports/`, either persistence adapter, `codexCliAdapter.ts`,
`claudeCodeAdapter.ts` (beyond what the stale-wording note above covers —
no logic in either concrete adapter changed), any TASK-001/002 test,
`docs/FACTORY_CONSTITUTION.md`.

### 7. Exact verification results

- `npm run typecheck` — PASS
- `npm run build` — PASS
- `npm test` — **347 tests, 347 pass, 0 fail** (up from 328; +19 from this
  round: 9 redaction, 8 workspace [3 new beyond the prior 5], 3 smoke
  cleanup, minus overlap already counted — see individual suite counts
  above), confirmed stable across 3 consecutive full runs
- `npm run demo` — DONE, 15 refusals, unchanged
- `npm run demo:persistent` run twice (seed, then a second real OS process
  reading back) — unchanged behavior
- `npm run worker:doctor` — unchanged: both CLIs still found with version
- `git diff --check` — clean
- `git status --short` — matches the files listed in section 6

### 8. Whether any real AI smoke was rerun: NO, deliberately

`cliWorker.ts`'s change is entirely post-processing of already-captured
output (`Run.summary`/Evidence construction) — it does not touch
`buildInvocation`, argv, environment, stdin, or anything else that reaches
the real CLI. `workspace.ts`'s change adds a real `git rev-parse` probe at
workspace-resolution time, before any worker CLI is ever invoked, and does
not alter what gets passed to Claude or Codex. Both are exhaustively proven
by deterministic fake-CLI/fake-git tests. Per the task's explicit
instruction not to burn usage repeating a real smoke unless a changed code
path makes it genuinely necessary, neither `npm run smoke:codex-worker` nor
`npm run smoke:claude-worker` was rerun; the results already on record
above (both SUCCEEDED) remain current evidence.

### 9. Remaining limitations

Unchanged from the prior rounds' lists, plus: the environment sandbox this
was built in has its own (unrelated) filesystem policy quirk noted in
section 3 — worth knowing if a future contributor writes a similar
special-character path test in this environment.

### 10. Ready for independent re-review: YES

## TASK-003 REVIEWER

### Final focused re-review after remediation — 2026-08-20

**Verdict: PASS**

The three prior findings are closed and no new CRITICAL or HIGH TASK-003
correctness issue was found.

- The deterministic fake Codex path emits the synthetic
  `sk-ant-test-1234567890abcdefghijklmnop` value. The returned Run.summary,
  Evidence, live SQLite rows, and the same rows after close/reopen contain
  `[REDACTED]` and never the original value. Ordinary model text remains
  available.
- `cliWorker.ts` has one `safeFinalMessage()` boundary for parsed
  `reported.finalMessage`; both summary and evidence builders receive only
  the safe value. Raw stdout/stderr fallback is redacted separately. Process
  status and trusted metadata remain OS/config-derived.
- `resolveWorkspace()` now validates repository membership with non-shell
  `spawnSync(git, ["-C", candidate, "rev-parse", "--show-toplevel"])`, with
  bounded diagnostics. Empty/fake `.git`, missing/file paths are rejected;
  real repository roots and valid subdirectories are accepted, including
  argv-special paths.
- `workerSmoke.ts` removes only its own `mkdtemp` path in `finally` on
  success, worker failure, and thrown adapter failure.
- Existing worker process, adapter, lifecycle, SQLite durability, trust,
  environment, and TASK-001/TASK-002 suites remain green. No real AI smoke
  was rerun because the remediation did not change CLI invocation or
  authentication paths; prior real Claude and Codex smoke results remain
  applicable.

Required verification: `npm run typecheck`, `npm run build`, `npm test`
(347 passed, 0 failed), `npm run demo`, `npm run demo:persistent`,
`npm run worker:doctor`, `git diff --check`, plus focused redaction,
workspace, smoke-cleanup, adapter, process-runner, lifecycle, and persistence
suites — all passed.

**TASK-003 is safe for human acceptance and commit.**

## Human decision
Pending.
