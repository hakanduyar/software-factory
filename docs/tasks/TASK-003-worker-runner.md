# TASK-003 — Worker Runner

## Objective
Give the Factory the ability to launch real, local, non-interactive AI
coding/review CLIs itself — Claude Code and Codex CLI — instead of requiring
a human to copy prompts between tools by hand. This is the
worker-*execution* layer only.

## Environment finding (historical — see update below)
At the start of this task, only the **Codex CLI** (`codex`, v0.147.0,
authenticated) was actually installed on the development machine. The
**Claude Code CLI** (`claude`) was **not installed** — only the VS Code
extension was present, which is not a subprocess-invocable non-interactive
CLI. This was confirmed by exhaustive search (`PATH`, npm global packages,
shell rc files, common install locations) — see the implementation report
for detail. The configured npm registry (a corporate proxy) was also
unreachable from this sandbox.

Consequence at the time: the Codex adapter's exact invocation was
independently tested against the real binary (see below). The Claude Code
adapter was implemented against its publicly documented non-interactive
("print mode") flag surface, but could not be verified against a real
binary. This was called out explicitly everywhere it mattered (code
comments, doctor output, acceptance criteria, implementation report) rather
than silently assumed. The user was asked how to proceed and chose to
handle installing/locating the CLI separately.

**Update:** the `claude` CLI (2.1.235) is now installed and authenticated on
this machine (installed by the human via a one-command npmjs.org registry
override — no global registry configuration was changed). The Claude Code
adapter's invocation was subsequently inspected and corrected against the
real binary — see "Real, tested Claude Code CLI invocation" below — and one
real Factory-path smoke test (`sf worker smoke claude`) succeeded. This
history is preserved above rather than deleted, since the original
fail-safe design (process exit status always decides success, never parsed
text) is exactly what made shipping the unverified version safe in the
first place.

## Real, tested Codex CLI invocation
Confirmed by direct experiment (not memory) on this machine:

```
codex exec --json -C <workspaceRoot> -m <model> -c model_reasoning_effort="<effort>" \
  --sandbox <read-only|workspace-write> -o <lastMessageFile> "<prompt>"
```

- Exit code `0` on success, non-zero on failure (tested with an invalid
  model name → exit `1`, structured `ERROR` events on stderr).
- `--json` prints one JSON object per line to stdout: `thread.started`,
  `turn.started`, `item.completed` (the final `agent_message` text lives
  here), `turn.completed` (token usage). This is the normalized "reported"
  channel — informational only, never used to decide success/failure.
- `-o/--output-last-message <file>` independently writes just the plain
  final message text — used as the primary evidence text since it needs no
  JSON parsing.
- `-c model_reasoning_effort="<level>"` genuinely overrides the configured
  reasoning effort per-invocation (verified: config default `xhigh`,
  overridden to `low`, CLI's own printed banner reflected `low`).
- `codex exec` has **no** `--ask-for-approval` flag (rejected as unexpected);
  `exec` is inherently non-interactive and is governed entirely by
  `--sandbox`, so there is no interactive-approval-prompt hang risk to guard
  against for this tool.
- `codex exec` prints "Reading additional input from stdin..." even when
  stdin is `/dev/null` and a prompt argv is given — harmless, but confirms
  the adapter must explicitly manage/close the child's stdin rather than
  leaving it inherited.
- No CLI-level timeout flag exists — timeout/cancellation is the Factory's
  own responsibility via process signals, not something to delegate to the
  tool.

## Real, tested Claude Code CLI invocation
Confirmed by direct experiment (not memory) once the real binary (2.1.235)
became available:

```
claude -p "<prompt>" --model <model> --output-format json \
  [--effort <low|medium|high|xhigh|max>] --permission-mode <plan|acceptEdits>
```

- Exit code `0` on success (tested with a trivial prompt end to end, twice —
  once with the adapter's exact restricted environment allowlist, to
  confirm authentication still works with only `HOME`/`PATH` forwarded, not
  the full ambient environment).
- `--output-format json` prints exactly **one JSON object** to stdout (not
  JSONL, unlike Codex's `--json`), with a `.result` string field holding the
  final answer text, plus `type`, `subtype`, `is_error`, `session_id`,
  `total_cost_usd`, `usage`, `permission_denials`, `terminal_reason`. This
  matches what the adapter already parsed as its primary path before the
  real binary was available — confirmed correct, not corrected.
- `--effort <level>` is a **real, documented, working flag** (`--help`
  choices: `low`, `medium`, `high`, `xhigh`, `max`) — the original
  assumption that no such flag existed was wrong and has been corrected.
  Accepted without error in a live call (`--effort low`).
- `--permission-mode <mode>` is real and documented (choices: `acceptEdits`,
  `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`). The adapter now
  passes `plan` for every role except `IMPLEMENTER` (investigate/report,
  never mutate — the Claude-side equivalent of Codex's `--sandbox
  read-only`) and `acceptEdits` for `IMPLEMENTER` (edits proceed without an
  unanswerable interactive prompt, still scoped to the process's `cwd`).
  This is a newly added capability, not present in the original unverified
  version, added because the real `--help` output confirmed it exists and
  the task asked explicitly to verify permission/sandbox controls.
- No `-C`/`--cwd`-equivalent flag exists (confirmed absent from `--help`) —
  the child process's OS-level `cwd`, which `ProcessRunner` always sets
  explicitly, is the only workspace mechanism, exactly as originally
  assumed.
- Authentication is file-based, under `$HOME/.claude/.credentials.json` —
  confirmed a real call succeeds with an `env -i HOME=... PATH=...`
  environment matching the adapter's own restricted allowlist shape; no
  DBUS/keychain environment variables are needed, so no change to
  `DEFAULT_WORKER_ENV_ALLOWLIST` was required.

## Scope
Implement:
- a `ProcessRunner` abstraction (`src/ports/processRunner.ts` +
  `src/adapters/process/nodeProcessRunner.ts`) wrapping `node:child_process`
  with explicit executable/argv separation, timeout, cancellation, bounded
  output capture, and clean spawn-failure/timeout/exit reporting;
- an explicit environment allowlist policy and best-effort output redaction
  (`src/adapters/workers/environmentPolicy.ts`);
- an explicit, validated workspace boundary (`src/adapters/workers/workspace.ts`);
- a shared CLI-worker execution engine (`src/adapters/workers/cliWorker.ts`)
  implementing the `Worker` port once, parameterized by a per-tool spec
  (argv builder + result interpreter), so the Claude and Codex adapters are
  thin configuration, not duplicated process-handling logic;
- `src/adapters/workers/claudeCodeAdapter.ts` and
  `src/adapters/workers/codexCliAdapter.ts`;
- a minimal prompt-template layer (`src/adapters/workers/promptTemplates.ts`);
- a minimal `WorkerModelConfig` (tool/model/effort/timeout as configuration,
  not hardcoded workflow logic);
- `sf worker doctor` / `sf worker smoke claude` / `sf worker smoke codex` CLI
  commands;
- deterministic, offline tests using fake CLI fixtures (Node scripts invoked
  as the "executable") covering process handling, adapter argv/parsing, and
  full `FactoryService.runWorker` integration (in-memory and SQLite);
- guarded `npm run smoke:*` scripts that invoke the real installed CLIs,
  never run by `npm test`.

## Out of scope (do not implement)
- TASK-004 autonomous implement → test → review loop
- automatic remediation loop
- GitHub Issues/Projects/PR integration
- Telegram/WhatsApp/n8n
- server deployment
- a full model router/scoring engine
- multi-machine worker scheduling
- automatic commit/push/merge/release by the Factory
- any weakening of TASK-001/TASK-002 invariants

## Required design constraints
- No shell string concatenation; `shell: true` is never used. Executable and
  argv are always passed separately.
- Workspace `cwd` is trusted configuration supplied at adapter construction,
  never derived from `WorkerRequest.instructions` (model-generated text has
  no path to choose a process's cwd).
- `process.env` is never forwarded wholesale. Only an explicit allowlist
  (tool discovery + the tool's own local credential/config mechanism) is
  forwarded; no API keys/tokens are ever added to that allowlist.
- Captured stdout/stderr is bounded (a max-capture-size cap, with a recorded
  "truncated" flag) and passed through a best-effort secret-pattern redactor
  before becoming Evidence.
- Timeout and cancellation genuinely terminate the child process (no orphans
  where avoidable); exactly one settlement path per invocation.
- `FactoryService.runWorker`'s existing three-phase lifecycle (already
  proven durable in TASK-001/002 — RUNNING persisted before `execute()`,
  finalized exactly once, thrown/failed/timed-out all become an honest
  terminal Run) is reused unchanged. Adapters implement `Worker.execute()`
  and return a `WorkerOutcome`; they do not need to and must not reimplement
  run persistence.
- A CLI adapter's `execute()` returns a `FAILED` `WorkerOutcome` (never
  throws) for ordinary process-level failure (non-zero exit, timeout,
  cancellation, spawn failure) so the Factory records rich, adapter-supplied
  diagnostic evidence for the failure rather than a generic caught-exception
  note. A thrown exception is reserved for genuine adapter/programmer bugs.
- Process exit status and the tool's own reported text are kept as two
  separate values; `WorkerOutcome.status`/success is derived only from the
  process's actual exit/termination, never from parsing what the model said.
- `claimsAcceptanceMet` is always `false` from real CLI adapters in this
  task — no PASS/CHANGES_REQUIRED free-text parsing yet (explicitly deferred
  to TASK-004), so no free-form model text is ever treated as a trusted
  claim.
- Trusted worker identity is unchanged: a CLI adapter is a `Worker` object
  registered through the existing `WorkerRegistry`; nothing about its output
  can mint or influence a `WorkerPrincipal`.

## Acceptance criteria
1. Factory can launch a real local Codex CLI worker non-interactively via
   `sf worker smoke codex`, proven with an actual invocation on this
   machine.
2. Factory can launch a real local Claude Code worker non-interactively via
   `sf worker smoke claude` — **satisfied**: a `claude` binary is now
   available, the adapter's invocation was corrected against it (effort and
   permission-mode were wrong/missing in the original unverified version),
   and one real Factory-path smoke run succeeded.
3. Tool name (`claude-code` / `codex-cli`) and model name are represented as
   separate fields throughout (config, adapters, evidence).
4. Model and effort are adapter configuration (`WorkerModelConfig`), not
   hardcoded in workflow/adapter logic.
5. No shell injection surface: argv arrays only, `shell` never `true`.
6. Workspace boundary is explicit, validated (exists, is a directory, is a
   git repository) and supplied as trusted configuration, never from
   worker-request text.
7. Environment forwarded to child processes is an explicit allowlist; no
   secrets are logged, persisted, or forwarded wholesale.
8. Timeout and cancellation are proven (deterministic tests) to terminate
   the child process and settle the run exactly once.
9. The RUNNING Run is durably persisted (SQLite) before the child process
   starts (integration test).
10. The same Run is finalized exactly once, for success, non-zero exit,
    spawn failure, timeout, and cancellation alike (deterministic tests).
11. A non-zero/timed-out/failed-to-spawn process cannot be recorded as a
    successful run regardless of what it printed, and vice versa.
12. Captured output attached as evidence is bounded in size and passed
    through redaction; truncation is recorded when it occurs.
13. All existing TASK-001/TASK-002 tests remain green, unmodified in intent.
14. New automated tests are fully offline/deterministic (fake CLI
    fixtures) and do not consume real AI usage; `npm test` never shells out
    to `claude`/`codex`.
15. At least one controlled real smoke run demonstrates the Factory
    actually launching an installed CLI end to end through
    `FactoryService.runWorker`, with normalized evidence recorded —
    **satisfied for both**: Codex (initial pass) and Claude Code (after the
    CLI became available).
16. No commit/push/release/merge happens automatically anywhere in this
    task's code or demos.
17. TASK-004 (autonomous loop) is not implemented.

## Deliverable
A clean, reviewable diff on top of committed TASK-001/TASK-002. Do not start
TASK-004 automatically. Do not commit or push.
