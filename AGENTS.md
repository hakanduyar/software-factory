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

## Execution discipline

These are the rules that repeated failures produced. They are here rather than
in a prompt because both implementers and reviewers must follow them.

- **Deterministic work must not consume model tokens.** Process inspection,
  waiting, polling, builds, tests, checksums, log watching and mechanical git
  operations are shell work. Never invoke a model to discover whether a process
  is alive.
- **Intent is not execution.** "I'll run", "running next" and "waiting for" are
  not evidence. Before claiming work continues, point at a live PID, a
  registered background task, or output the process created.
- **Every long-running chain has exactly one deterministic continuation owner.**
  It uses local sleep/backoff, detects completion and fail-closed gates, surfaces
  the result, and never reads missing output as success.
- **Cheapest evidence first.** Focused test, then typecheck, then mutation
  preflight, then the suite, then the strict AC-12 probe, and only then an
  expensive full mutation run. A multi-hour run must never be the first place a
  definition defect is found.
- **A mutation result is valid only with both closing proofs** — `restored:
  pass=... fail=0` and the byte-for-byte line. Their absence is exactly what an
  interrupted run looks like, so absence is never a pass.
- **Loop-breaker.** If two or more review cycles keep finding defects in a
  mechanism that exists to prove another mechanism, stop before adding a third.
  Ask which frozen criterion requires it, which real failure requires it, and
  whether less machinery would do. Test and guard counts are not quality.
- **Classify a finding before engineering it**: production defect,
  verification-integrity defect, self-inflicted harness defect, process defect,
  documentation defect, or out of scope. Only the first two justify changing the
  deliverable.
- **Do not manufacture certainty.** Resolve uncertainty from frozen criteria,
  the specification, the repository, ADRs, tests and runtime facts. Proceed alone
  when the requirement is clear and the choice is reversible. Stop and ask the
  owner when two materially different readings remain, when proceeding would
  invent a requirement or materially expand scope, when frozen criteria might
  need weakening, or when a mechanism would be added mainly because the agent is
  uncertain. Ask the smallest question; do not keep implementing the ambiguous
  branch meanwhile.
- **Reviewers follow the same rule.** A reviewer must not manufacture findings
  from requirements outside the frozen criteria or a demonstrated security
  property. Genuine ambiguity is reported as OWNER_DECISION_REQUIRED, which is
  neither a pass nor authority to implement. An implementer may not treat a
  reviewer's suggestion as a requirement unless it maps to a frozen criterion, a
  demonstrated failure, or an owner decision.

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
