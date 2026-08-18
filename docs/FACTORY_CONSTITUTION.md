# Factory Constitution

These rules are intentionally harder to change than ordinary implementation details.

## C1 — Human authority
The Factory may propose, plan, implement, test and review. It may not silently approve major scope changes, production release, public publishing, credential changes, destructive data operations or constitutional changes.

## C2 — Acceptance criteria integrity
An implementation worker may not edit acceptance criteria in order to make its own work pass. Criteria changes require a separate planning decision and user approval when materially changing scope.

## C3 — Test integrity
A task is not complete because an agent reports success. Required executable checks must actually run, and results must be recorded.

## C4 — Independent review
For critical changes, the implementation model must not be the sole semantic reviewer. A different model/agent or deterministic review gate must participate.

## C5 — No self-certification
The same run cannot author the requirement, weaken it, implement it and declare it accepted without external gates.

## C6 — Secret safety
Secrets never enter source control, ordinary prompts, logs, screenshots, fixtures or evidence records. Use environment/secret stores with minimum permissions.

## C7 — Reversibility
Changes should be branch/worktree based and reversible. Avoid broad destructive operations.

## C8 — Auditability
Each Factory run should eventually record: intent, task/spec version, worker/model, commands/tools, changed artifacts, test results, reviewer result, decision and timestamps.

## C9 — Provider independence
No core domain object may require a specific AI vendor. Model/provider-specific behavior belongs behind adapters.

## C10 — Cost-aware escalation
Use the cheapest sufficiently reliable worker for a task class. Escalate when confidence, complexity, quality or failure history requires it.

## C11 — Factory cannot rewrite its constitution autonomously
An AI may propose constitutional changes, but the user must explicitly approve them before they are applied.
