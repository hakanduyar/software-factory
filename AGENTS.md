# AGENTS.md — Repository-wide agent instructions

## Mission
Build a model-independent Software Factory that can orchestrate planning, implementation, testing, review, evidence collection, approvals, and later content/media production.

## Non-negotiable rules
- Read `docs/FACTORY_CONSTITUTION.md` before changing code.
- Never weaken or bypass approval, test, security, or audit rules to make a task pass.
- Never mark a task DONE only because an LLM says it is done.
- Every implementation task must have explicit acceptance criteria.
- Every code change must have an executable verification path.
- The model that implements a critical change must not be the only reviewer of that change.
- Do not put secrets, API keys, OAuth tokens, personal credentials, or production data in repository files, prompts, fixtures, logs, screenshots, or commits.
- Prefer small reversible increments over large rewrites.
- Do not introduce external infrastructure before the current task requires it.
- Do not add Jira. GitHub Issues/Projects/PRs are the planned work system unless an ADR changes this later.

## Permanent test selection discipline

All planners, controllers, implementers and reviewers, including resumed agents, follow [Test selection before dispatch](docs/tasks/NO-CODE-CHIEF.md#test-selection-before-dispatch). Read it before choosing checks or requesting additional tests; keep that central policy as the single detailed reference.

- Before dispatch or resume, record acceptance criterion/system invariant -> observable failure -> smallest sufficient test group, required commands, and any fingerprint-bound evidence reuse in the ticket's validation rationale. Resume from recorded evidence, not a fresh blanket test plan.
- Implementers reuse existing protection where sufficient; new tests need a distinct behavior or invariant they protect. Avoid implementation-mirroring mocks, incidental helper/call-order assertions, coverage quotas and redundant unchanged full-suite runs. Necessary authority-boundary counts, concurrency and failure-integrity checks remain valid evidence.
- Reviewers tie each requested additional test to a frozen criterion, demonstrated failure or security invariant, explain the missing protection, and consider the smallest sufficient check. Do not ask for tests merely to increase their count.
- Preserve all required checks, approvals and independent exact-fingerprint review. Never delete tests to obtain green results or silently weaken frozen criteria. This is durable instruction; it does not itself prove automated runtime enforcement or propagation to other checkouts.

## Source of truth order
1. `docs/FACTORY_CONSTITUTION.md`
2. Accepted ADRs in `docs/decisions/`
3. Current task acceptance criteria
4. `docs/ARCHITECTURE.md`
5. `docs/DOMAIN_MODEL.md`
6. `docs/MODEL_ROUTING.md`

## Required before completion
- Run relevant tests/checks.
- Report exactly what changed.
- Report commands run and their outcomes.
- Report remaining risks or TODOs.
- Leave unrelated files untouched.

## No-Code Chief
- The Chief only assigns, manages, monitors, observes, and evaluates bounded worker results through orchestration/status tools. It never authors code or writes/edits any file, including docs, state, evidence, and tickets, and never executes shell commands, tests, checks, hashes, or environment probes. Delegate all filesystem/command work to scoped controller/writer agents.
- This permanent boundary applies to initial work, corrections, restart, quota exhaustion, and unavailable delegation without exceptions. Scoped controllers persist durable waits/checkpoints; inability to delegate never authorizes Chief self-implementation or direct filesystem/command work.
- Before dispatch, a scoped controller freezes a structured WorkerTicket as specified in `docs/tasks/NO-CODE-CHIEF.md`, including finite context/attempt budgets. Permit one active writer per owned path; independent work may run only with disjoint ownership.
- Select the cheapest sufficiently capable model AND reasoning effort for each task. Every ticket records `model`, `reasoningEffort`, and `rationale`; stronger selections require evidence, risk, complexity, or failure history. Avoid unnecessary high model/effort defaults and underpowered assignments merely to save money; preserve eligibility, quota, approval, and escalation gates.
- Require a bounded structured WorkerResult, actual deterministic validation, and an independent reviewer of the exact candidate fingerprint. A writer cannot approve its own work; any candidate change invalidates prior review.
- Reuse durable worker-envelope/controller quota, stall, checkpoint, and outbox mechanisms. After two failed correction attempts, stop blind retries and route to diagnosis, replanning, or escalation.
- Runtime structured state is authoritative. Obsidian, if used, is a human reading/planning layer and cannot grant runtime authority.
- Already authorized local reversible actions require no repeated permission. This policy grants no spending/credit, remote push/PR/merge, release, publishing, cutover, or external-transfer authority; existing protected gates remain binding.
- This is a staged policy increment. `docs/tasks/NO-CODE-CHIEF.md` freezes future contract/enforcement criteria; documentation alone does not prove runtime enforcement.
- Historical Chief source/test edits remain zero. Earlier Chief shell/state operations remain in the audit record; the permanent boundary is effective from the explicit user instruction on 2026-09-28 and does not erase history.

## Standing Claude sharing authorization

Before dispatch or resume, consult [Standing human authorization for Claude development transfers](docs/tasks/NO-CODE-CHIEF.md#standing-human-authorization-for-claude-development-transfers) and its authoritative consent lineage. Reuse the user's standing authorization for matching current/future Factory development packets, including derived corrections and retained session context; do not request new human consent merely because files or byte counts change. Keep normal review and protected-data boundaries intact, and report any actual platform rejection separately from human authorization.