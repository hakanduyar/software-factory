# ADR-0003 — No-Code Chief and bounded worker contracts

Status: Accepted policy; runtime enforcement pending

## Context and authorization

The user explicitly authorized this No-Code Chief policy increment, including AGENTS.md and constitutional additions under C11. The Chief must remain an orchestrator when a writer fails, quota expires, or the terminal stops. A model claim of success cannot substitute for validation or independent review.

On 2026-09-28 the user explicitly authorized the permanent stricter boundary and cost-quality routing below, including the constitutional changes under C11. Historical Chief source/test edits remain zero. Earlier Chief shell/state operations remain audited; this decision does not retroactively erase them.

This checkout is a staged baseline. ADR-0002 in the newer worker-envelope workspace was consulted read-only to avoid conflicting governance. This ADR neither revokes nor expands ADR-0002's scoped autonomous completion mandate, its ten acceptance/integration conditions, its human-only boundaries, or its STATE_INTEGRITY and EXECUTOR_ISOLATION prerequisites to EXECUTOR_WIRING. The current task's narrower boundary takes precedence: older ADR authority does not authorize remote push/PR/merge or any other integration operation for this increment. Later integration requires a separately scoped decision under the applicable mandate.

## Decision

1. The Chief only assigns, manages, monitors, observes, and evaluates bounded worker results through orchestration/status tools. It never authors code or writes/edits any file, including docs, state, evidence, and tickets, and never executes shell commands, tests, checks, hashes, or environment probes. Scoped controller/writer agents perform all filesystem/command work. This permanent rule covers initial work, corrections, restart, quota exhaustion, and unavailable delegation without exceptions; inability to delegate cannot authorize Chief self-implementation.
2. Before every dispatch, a scoped controller freezes a structured WorkerTicket with explicit acceptance criteria, read scope, owned and forbidden paths, dependencies, `model`, `reasoningEffort`, `rationale`, executable validation, finite budget, checkpoint policy, stop/escalation conditions, and result schema. Scoped controllers reserve ownership and persist tickets/state/evidence. One active writer may own a path; disjoint writers may proceed independently.
3. Every writer returns a structured WorkerResult of at most 2048 UTF-8 bytes. Large evidence remains behind durable references. Validation must actually execute. An independent reviewer evaluates the exact candidate fingerprint; writers cannot approve themselves and subsequent mutation invalidates review.
4. Reuse the durable worker-envelope/controller quota, stall, checkpoint, and outbox facilities. Do not build a competing scheduler or bypass their gates. No eligible quota means a durable waiting state and zero model launches. Recovery resumes from recorded state and does not duplicate active ownership or terminal notifications.
5. After two failed correction attempts, persist the failure history and route to diagnosis, replanning, or escalation. A third unchanged correction is prohibited. Any newly authorized attempt requires a recorded decision and a new finite budget; counters cannot be reset merely by relaunching.
6. Runtime structured state owns status and authority. Obsidian may show plans, evidence links, and human-readable progress; it is not a command, approval, or execution database.
7. Proceed with already authorized reversible local actions without repetitive permission requests. Money/credits, remote push/PR/merge, release, publishing, cutover, and external transfers remain outside this increment. Preserve every existing security and approval boundary.
8. For each task, select the cheapest sufficiently capable model AND reasoning effort. Record the selection and rationale in every ticket. Stronger selections require evidence, risk, complexity, or failure history; avoid unnecessary high model/effort defaults and underpowered assignments merely for savings. Existing routing preferences, eligibility, quota, approval, and escalation gates remain binding; preferences do not override task suitability.

## Consequences and rollout

`docs/tasks/NO-CODE-CHIEF.md` freezes measurable future contract and enforcement criteria. This policy does not claim those mechanisms are implemented in this checkout. The coupled C6 implementation remains with its existing writer; no duplicate writer or runtime changes are part of this increment. Subsequent work must reconcile with the newer baseline before implementation and prove the criteria with deterministic checks and independent review.
