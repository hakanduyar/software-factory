# Model Routing Policy — Initial

This file describes roles, not permanent vendor lock-in. Exact model choices are configurable and should later be benchmark-driven.

## Permanent cost-quality rule

For every task, select the cheapest sufficiently capable model AND reasoning effort. Every frozen WorkerTicket records `model`, a supported `reasoningEffort`, and a task-specific `rationale`. Stronger selections require evidence, risk, complexity, or failure history. Avoid unnecessary high model/effort defaults and underpowered assignments merely to save money. The role preferences below guide eligible choices; task suitability governs the final combination. Existing quota, approval, routing, and escalation gates remain binding; this policy grants no spending or credit authority.

The Chief only assigns, manages, monitors, observes, and evaluates bounded worker results through orchestration/status tools. It never authors code or writes/edits any file, including docs, state, evidence, and tickets, and never executes shell commands, tests, checks, hashes, or environment probes. Scoped controller/writer agents perform all filesystem/command work and freeze tickets with recorded routing decisions. This permanent boundary covers initial work, corrections, restart, quota exhaustion, and unavailable delegation without exceptions. Inability to delegate never authorizes Chief self-implementation; scoped controllers persist durable waits/checkpoints. This staged governance policy does not establish runtime enforcement.

## Roles

### Product / Requirements Analyst
Goal: clarify intent, scope, business/domain behavior and acceptance criteria.
Preferred initial family: GPT/Codex-class reasoning; compare with Claude when useful.

### Architect / Planner
Goal: architecture, decomposition, risks, sequencing and GitHub-ready work items.
Preferred initial family: Codex-class strong reasoning; critical plans receive a second-model critique.

### Implementation Engineer
Goal: edit repo, run commands, implement task, add tests.
Preferred initial worker: Claude Code.
Use Fable-class model selectively for large, long-horizon or unusually complex milestones.

### Reviewer
Goal: compare implementation to spec/acceptance criteria and identify defects/risks.
Rule: critical work should use a different model/role than the implementer.
Preferred initial family when Claude implements: Codex-class reviewer.

### High-volume / Long-context Analyst
Preferred: Gemini where its strengths and quota/cost make sense.

### Cheap/Free Worker
Preferred pool: Gemini free tier where permitted, OpenCode free models, local Ollama models.
Good for low-risk docs, classification, formatting, extraction and simple bounded changes after benchmarks prove reliability.

### Content Pipeline
Do not hard-code one writer forever. Separate:
1. evidence extraction,
2. outline/editorial plan,
3. draft,
4. factual/technical review,
5. human publish approval.
Benchmark GPT/Claude/Gemini per content type.

## Escalation policy
FREE/LOCAL -> INCLUDED SUBSCRIPTION -> PAID/CREDIT MODEL

Escalate when:
- task complexity exceeds configured threshold,
- prior attempt failed,
- reviewer confidence is low,
- security/architecture impact is high,
- long-context requirement exceeds worker capability.

Escalation may increase model capability, supported reasoning effort, or both as the recorded evidence requires. Do not use high effort by default or reset failure history to justify repeated underpowered attempts. Eligibility and quota must be rechecked before dispatch; unavailable quota leads to durable waiting, with zero launches, rather than bypassing gates.

## Standing user routing refinement (2026-10-09)

The latest explicit human override on 2026-10-09 supersedes the earlier concurrent-provider preference below: author Factory changes only through eligible promo Claude Cloud until the user explicitly changes this instruction. Do not start or resume Claude Code model calls, including after quota resets. Existing completed Code evidence remains valid; local nonmodel checks and eligible OpenAI controller/reviewer work remain permitted. Keep paid usage off and preserve finite tickets, single writers, normal approval and exact independent review.

Minimize total cost including failed retries while preserving quality. Claude Sonnet at supported medium effort is the usual coding choice; verified current Haiku may handle small tasks. Suitable bounded OpenAI work may use Luna/Terra; Opus/Sol/Astra or high effort requires complexity, risk or failure evidence. Record the actual supported model, effort and rationale in each ticket. Finite context, output and elapsed budgets must be sufficient for the atomic operation; repeatedly choosing an inadequate cap is not economical.

Eligible promo Claude Cloud may run continuously alongside eligible Claude Code on useful disjoint tasks. Code quota exhaustion permits eligible Cloud work; a fresh check after an actual reset permits new Code work again. Preserve active workers and single ownership. Paid usage, purchase/reset, protected approvals and release gates remain unchanged.

Distinguish the provider's per-response generation cap from total phase output accounting, context capacity and transport limits. Bind the actual settings and ticket amendment in preflight. Remove arbitrary script-character limits unless a real transport constraint requires them; keep realistically sufficient finite token, turn and elapsed budgets. Preserve completed native edits and evidence, checkpoint exact hashes/hunks, and resume only missing pieces. Record budget breaches separately from functional evidence without asserting retrospective process compliance or waiving protected gates. The bounded WorkerResult requirement remains intact.
