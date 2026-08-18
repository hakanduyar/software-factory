# Model Routing Policy — Initial

This file describes roles, not permanent vendor lock-in. Exact model choices are configurable and should later be benchmark-driven.

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
