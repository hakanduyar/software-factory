# CLAUDE.md — Claude Code project instructions

@AGENTS.md
@docs/FACTORY_CONSTITUTION.md
@docs/ARCHITECTURE.md
@docs/DOMAIN_MODEL.md
@docs/MODEL_ROUTING.md

## Claude Code role during bootstrap
You are primarily the implementation engineer.

- Implement only the currently assigned task.
- Start by auditing the repository and task constraints.
- Do not redesign the whole product unless the task explicitly asks for architecture work.
- If requirements conflict, stop and report the conflict instead of silently choosing.
- Add/update tests with code changes.
- Do not modify acceptance criteria to fit the implementation.
- Do not perform production deployment, public release, or any action reserved
  by C1 or by ADR-0002's HUMAN-ONLY list.
- Integration to `main` follows ADR-0002 (Scoped Autonomous Completion Mandate):
  permitted without a further human decision ONLY when all ten of its conditions
  hold — frozen acceptance criteria, deterministic verification, an independent
  reviewer at PASS/PASS_WITH_NON_BLOCKING_NOTES with zero CRITICAL/HIGH and an
  explicit "Safe to commit = YES", preserved reviewer independence, an unchanged
  repository fingerprint across the review, passing regressions, tree
  equivalence, and no HUMAN-ONLY boundary crossed. CHANGES_REQUIRED returns
  automatically to remediation. This authority is scoped to the software-factory
  repository and to completing its approved roadmap; it does not generalise, and
  it does not alter runtime TrustedHuman semantics.
- When finished, provide a concise implementation report suitable for an independent reviewer.
