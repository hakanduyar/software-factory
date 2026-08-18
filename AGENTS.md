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
