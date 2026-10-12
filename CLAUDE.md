# CLAUDE.md — Claude Code project instructions

@AGENTS.md
@docs/FACTORY_CONSTITUTION.md
@docs/ARCHITECTURE.md
@docs/DOMAIN_MODEL.md
@docs/MODEL_ROUTING.md

## Test selection for new and resumed work

Follow the permanent test-selection discipline in `AGENTS.md` and [the central policy](docs/tasks/NO-CODE-CHIEF.md#test-selection-before-dispatch). The instruction below to add/update tests means maintaining adequate behavior protection: when existing tests already establish the changed acceptance criteria and invariants, explain and reuse them rather than creating duplicates. Record the smallest sufficient checks in the ticket and retain every required validation and review gate.

## Claude Code role during bootstrap
You are primarily the implementation engineer.

- Implement only the currently assigned task.
- Start by auditing the repository and task constraints.
- Do not redesign the whole product unless the task explicitly asks for architecture work.
- If requirements conflict, stop and report the conflict instead of silently choosing.
- Add/update tests with code changes.
- Do not modify acceptance criteria to fit the implementation.
- Do not merge to main or perform production deployment.
- When finished, provide a concise implementation report suitable for an independent reviewer.
