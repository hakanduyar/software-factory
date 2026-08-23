# ADR-0002 — Scoped Autonomous Completion Mandate for the software-factory repository

Status: Accepted
Date: 2026-08-23
Authorized by: Hakan Duyar (explicit, in-session direction)

## Context

TASK-006 exists to make the Factory independent of any single AI session. It
succeeded technically — durable roadmap, deterministic scheduling, zero-token
waiting, a financial gate that ten independent reviews could not get through —
and then stalled on a governance contradiction:

`CLAUDE.md` instructed the bootstrap agent *"Do not merge to main or perform
production deployment."* So every completed task still required a routine human
merge decision, which is precisely the dependency TASK-006 was built to remove.
A supervisor that cannot integrate its own reviewed, passing work is not
autonomous; it is a very thorough assistant.

Notably, this was **not** a constitutional restriction:

- `FACTORY_CONSTITUTION.md` C1 reserves production release, public publishing,
  credential changes, destructive data operations and constitutional changes.
  Integrating an internally reviewed task into `main` is not among them.
- `DOMAIN_MODEL.md` names four protected gates — `PLAN_APPROVAL`,
  `RELEASE_APPROVAL`, `PUBLISH_APPROVAL`, `CONSTITUTION_CHANGE`. There is no
  `MERGE_APPROVAL`.

The blocker was a bootstrap-role instruction written before the Factory could
review its own work. That is what this ADR amends, and nothing else.

## Decision

For **this repository (`software-factory`) and for the purpose of completing the
approved Software Factory roadmap only**, an implementation task MAY be accepted
and integrated without a further human decision when **all ten** of the
following hold:

1. Acceptance criteria were frozen **before** implementation began.
2. Deterministic verification passes (typecheck, build, full test suite,
   `git diff --check`).
3. An **eligible independent reviewer** returns `PASS` or
   `PASS_WITH_NON_BLOCKING_NOTES`.
4. Zero CRITICAL and zero HIGH blockers remain.
5. The reviewer explicitly states **Safe to commit = YES**.
6. Reviewer independence is preserved (C4 — the implementing model is not the
   sole semantic reviewer).
7. A repository fingerprint taken before and after the review confirms the
   reviewer made no unauthorized mutation.
8. Required regression verification passes, including the permanent
   reproductions for every previously found defect.
9. Integration tree equivalence passes — the merged tree matches the reviewed
   tree exactly.
10. No HUMAN-ONLY boundary (below) is crossed.

`CHANGES_REQUIRED` returns automatically to remediation and re-review. The human
is **not** consulted between rounds.

## What this mandate does NOT authorize

These remain `WAITING_FOR_HUMAN_REQUIRED`, without exception:

- any financial transaction, or any spending whatsoever
- VPS or cloud purchase; paid credits, overage or top-up
- password entry, sudo password, MFA, CAPTCHA
- OAuth consent that requires the human
- billing configuration changes of any kind
- public release, or making a private repository public
- irreversible destructive actions outside the mandate
- force push or history rewriting
- bypassing `FinancialSafetyGate`
- weakening acceptance criteria
- bypassing independent review
- fabricating human identity or trusted-human tokens

**Autonomous spend authority remains exactly ZERO.** Nothing in this ADR touches
`financialSafety.ts`, and F-1 still makes spending authority impossible to
express in data: no persisted row can grant it, so no row has to be trusted.

## Scope limit

This authority is bounded to:

- **repository/project:** `software-factory`
- **purpose:** completion of the approved Software Factory roadmap

It is **not** a general rule permitting autonomous merges or releases in other
projects, and it does not survive the completion of that roadmap.

## The distinction that must not be blurred

Two different things are called "human authority" in this codebase, and
conflating them would be a serious security regression:

| | Repository-agent governance (this ADR) | Runtime Factory trusted-human authorization |
| --- | --- | --- |
| Governs | what the bootstrap agent may do to THIS repo while completing the roadmap | what the running Factory accepts as human authority at protected gates |
| Mechanism | this document, plus `CLAUDE.md` | `Actor` / `TrustedHumanToken`, HMAC-verified, TASK-001/003/004 semantics |
| Changed here | yes, narrowly | **NO — unchanged** |

This ADR grants an agent permission to integrate reviewed work. It does **not**
make caller-created `HUMAN` actors trusted, does not weaken token verification,
and does not alter what the Factory requires at `PLAN_APPROVAL`,
`RELEASE_APPROVAL`, `PUBLISH_APPROVAL` or `CONSTITUTION_CHANGE`. A model that
announces it is a human is exactly as untrusted after this ADR as before it.

## The two adjudicated security boundaries are unaffected

The tenth independent review accepted deferring both boundaries **only** because
the shipped executor performs no autonomous work, both gate `EXECUTOR_WIRING`,
and each limitation is documented and pinned by a test. That adjudication stands
and its conditions are binding:

```
STATE_INTEGRITY  +  EXECUTOR_ISOLATION   →   EXECUTOR_WIRING
```

No bypass. Nothing capable of executing autonomous work may be wired until both
are closed. This ADR does not relax that ordering, and a regression test asserts
it.

## Consequences

- TASK-006 and subsequent roadmap tasks can complete end-to-end without routine
  human involvement, which is what the task was for.
- The human remains in the loop for every boundary that actually needs a human —
  money, credentials, publication, destruction, and the constitution itself.
- If the ten conditions cannot all be met, the work stops and waits. The mandate
  is a permission to integrate *verified* work, not a permission to proceed
  without verification.
- C11 is respected: this change was proposed to, and explicitly authorized by,
  the user. An AI may not enact it unilaterally, and this one did not — the
  agent drafted it and the human applied it.
