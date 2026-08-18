# Claude Code Bootstrap Prompt

MODEL: Use the strongest Claude Code model currently available within the user's existing plan for normal repository implementation. Do not upgrade or spend usage credits solely for this task unless the user explicitly chooses to.
EFFORT: High

Read, in order:
1. `AGENTS.md`
2. `CLAUDE.md`
3. `docs/FACTORY_CONSTITUTION.md`
4. `docs/PRODUCT.md`
5. `docs/ARCHITECTURE.md`
6. `docs/DOMAIN_MODEL.md`
7. `docs/MODEL_ROUTING.md`
8. `docs/ROADMAP.md`
9. `docs/tasks/TASK-001-core-skeleton.md`

Then implement **TASK-001 only**.

Before modifying files:
- inspect the repository and current git status,
- state your intended file-level plan,
- identify any contradiction between the task and constitution,
- do not expand scope.

Implementation requirements:
- use TypeScript,
- keep the core provider-independent,
- create executable unit tests for workflow transitions and protected approvals,
- do not integrate any real external AI/GitHub/Telegram/n8n service,
- do not add server deployment,
- do not start TASK-002,
- never weaken acceptance criteria to make the implementation pass.

At completion:
- run all relevant typecheck/tests/build commands,
- show concise results,
- list every created/modified file,
- explain the architecture implemented,
- identify known limitations,
- leave the repo in a reviewable state.
