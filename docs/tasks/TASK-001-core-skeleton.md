# TASK-001 — Local Factory Core Skeleton

## Objective
Create the smallest production-shaped TypeScript skeleton that can represent a Factory workflow without calling any real AI provider or GitHub yet.

## Scope
Implement:
- project/tooling bootstrap,
- core domain types,
- workflow/status transition service,
- protected approval gate representation,
- in-memory repositories/interfaces,
- CLI command that demonstrates one fake work item moving through valid states using a mock worker,
- unit tests for allowed/forbidden transitions and approval behavior.

## Out of scope
- Claude/Codex/Gemini/OpenCode/Ollama calls
- GitHub API
- n8n
- Telegram/WhatsApp
- server deployment
- web UI
- automatic self-modification

## Required design constraints
- Domain layer must not depend on a specific AI provider.
- Workflow transitions must be explicit and testable.
- A task cannot transition to DONE directly from IMPLEMENTING.
- Protected gates cannot be bypassed by a worker result.
- No secrets/config credentials in the repo.
- Keep architecture simple; no microservices.

## Acceptance criteria
1. Fresh install and documented commands work.
2. Typecheck passes.
3. Unit tests pass.
4. A demo CLI flow can create a mock project/work item and advance it through a valid workflow.
5. Invalid state transitions fail deterministically.
6. PLAN/RELEASE/PUBLISH/CONSTITUTION approvals are represented as protected human decisions.
7. No real provider/network integration has been added.
8. README contains exact run/test commands.
9. Implementation report lists files changed, tests run and known limitations.

## Deliverable
A clean commit ready for independent architecture/code review. Do not start TASK-002 automatically.
