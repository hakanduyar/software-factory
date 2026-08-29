# Commit attribution policy

## The rule

New commits may not carry AI attribution trailers. The canonical author of this
repository's history is **Hakan Duyar <iamhakanduyar@gmail.com>**. The tools used
to produce a change are not co-authors of it.

Rejected trailer values (case-insensitive, however the trailer is spaced):
`Claude`, `Anthropic`, `Codex`, `OpenAI`, `Copilot`, `ChatGPT`, and addresses at
those domains.

## Historical deviation, recorded rather than erased

**Thirteen commits carry `Co-Authored-By: Claude`**, from `1b32854`
(2026-08-22) to `8f0c240` (2026-08-29). They are published, they are on `main`,
and they are **left exactly as they are**.

Rewriting published history to remove them would destroy the record of the
deviation in the act of tidying it, and history rewriting is a larger governance
breach than the trailers were. C7 (reversibility) and C8 (auditability) both
point the same way: the honest response to a governance breach in the record is
to record it, bound it, and prevent recurrence.

So the rule applies from a **baseline** forward:

```
ATTRIBUTION_BASELINE = 8f0c2403157d8217c749838b51f00b1a35b1f02b
```

Everything reachable from that commit is history and is exempt. Everything after
it is new work and is governed.

## Enforcement

`tests/commitPolicy.test.ts`, which runs under `npm test` and therefore under
every ADR-0002 verification. It cannot be skipped by forgetting to install
anything.

The rule itself is pure (`src/governance/commitPolicy.ts`) and is tested against
the spellings a hastily written regex would miss, with a control asserting that
an ordinary commit and a HUMAN co-author trailer are accepted — without that
control the rule could be "reject every trailer" and still look correct.

**Proven non-vacuous.** "No violations after the baseline" is also what a check
that examined zero commits would report, so the guarantee was verified by
creating a real offending commit on a throwaway branch: the check failed and
named the commit, the line and the matched marker. The branch was deleted and
never pushed.

A test also asserts the historical trailers are **still present** before the
baseline. If that ever reports zero, published history has been rewritten, which
this policy forbids more strongly than it forbids the trailers.

## Optional local hook

`scripts/hooks/commit-msg` catches a violation at commit time instead of at
verification time. It is convenience, not the guarantee:

```
git config core.hooksPath scripts/hooks
```

## Author identity

87 of 91 commits use `Hakan Duyar <iamhakanduyar@gmail.com>`; four early ones use
a work address. Those four are also history and are not rewritten. New commits
use the canonical identity.
