# TASK-016 — GITHUB_ORCHESTRATION

**Roadmap item:** `GITHUB_ORCHESTRATION` — "GitHub Issues/Projects/PR
orchestration (zero-cost tier only)". Work class `NORMAL_IMPLEMENTATION`.

**Eligible because** its only prerequisite, `EXECUTOR_WIRING` (TASK-014 +
TASK-015), is accepted and integrated on `main` at `11662a1`.

## What the survey found, and why it decides the shape

Four facts from the existing tree, not from a desired design:

1. **`GIT_PUSH` is currently FINANCIAL.** `KNOWN_ACTION_EFFECTS` registers it
   `costKnownZero: false, canIncurUsageCharges: true`, and says why: a push
   "can start paid CI, fire paid webhooks, or consume the GitHub Actions
   allowance". The same comment names the remedy — "a push to a target with
   demonstrated zero liability could earn a minted action later, **the way
   verification commands did**. It has not, so it does not get the verdict."
   This task is where that verdict is earned or the Factory keeps refusing.

2. **The minting pattern already exists, twice.**
   `verificationCommandAction` derives effects from an allowlist and falls
   back to financial for anything unrecognised. `launchAiWorkerAction` goes
   further: it takes an `observeBilling` observation that must be in an
   unforgeable `WeakSet` **and** describe the same resource being launched,
   or it is treated as no observation at all — which is UNKNOWN, which is
   financial. A push verdict must be earned the same way, or not at all.

3. **The credential boundary is already correct and must stay that way.**
   `DEFAULT_WORKER_ENV_ALLOWLIST` forwards `HOME`/`CODEX_HOME` so a provider
   CLI can find its own credentials. `ISOLATED_EXECUTOR_ENV_ALLOWLIST`
   deliberately does not, and `--permission` denies the credential paths
   besides. `gh` stores an OAuth token in `~/.config/gh/hosts.yml`, so any
   process given `HOME` can act as the GitHub user. That makes the GitHub
   adapter a **trusted orchestration boundary**, on the opposite side of the
   line from the TASK-011 child.

4. **The repository is PUBLIC, has no workflows, no PRs and no branch
   protection.** So there is no CI to read yet: this task must build the
   binding surface `CLEAN_ROOM_CI` will later attach evidence to, and must
   not pretend evidence exists in the meantime.

## The invariant that must not move

**Remote state is evidence, never authority.** A PR number is not a commit. A
branch name is not a commit. A green check without a SHA is not evidence
about any commit. Every remote fact this task consumes is bound to the exact
object it describes, or it is refused.

And the financial invariant is unchanged: `AUTONOMOUS_SPEND_LIMIT = 0`. This
task does not relax the gate; it supplies the bound, observed evidence that
lets one specific action class be classified honestly instead of pessimistically.

### What "public" does and does not authorise here — stated so it can be attacked

This repository is ALREADY public, and pushing branches to it is what the
accepted mandate has been doing throughout TASK-014 and TASK-015. So a push
or a pull request against this already-public repository is not a "public
release" and does not make a private repository public — the two things C1
and ADR-0002 actually reserve. `MAKE_REPOSITORY_PUBLIC` and `PUBLISH_PACKAGE`
remain `PUBLICATION_ACTION` and are untouched and unreachable from this task.

The reviewer is invited to attack that reading rather than accept it. Two
consequences follow from it and are binding either way: nothing here may
change repository visibility, and everything pushed is world-readable, which
makes AC-6's secret containment a publication-safety control and not only a
hygiene one.

## Acceptance criteria (FROZEN — may not be edited to fit the implementation)

> **Owner-authorized amendment, AC-5 only.** The criteria frozen at `ac01c22`
> were internally contradictory: AC-5 required that publication produce a pull
> request, while AC-1/AC-2 and the round-3 independent adjudication established
> that a remote write can never be authorized, because an installed GitHub App
> on the exact target may create an externally metered causal effect the Factory
> cannot observe with its available credentials. No implementation could satisfy
> all three.
>
> The owner reviewed the conflict (`TASK-016-AC5-SCOPE-CONFLICT.md`), refused to
> accept the GitHub App residual, refused to weaken ZERO_COST, and directed that
> UNKNOWN_COST remains DENY. AC-5 alone is amended, replacing the unsatisfiable
> production obligation with an adoption obligation. This is an owner-authorized
> scope correction under C1/C2, not implementer self-certification: the
> implementer reported the conflict and did not choose the resolution.
>
> The amendment MUST NOT weaken AC-1, AC-2, ZERO_COST, RemoteWriteAuthorization,
> the exact-target observation requirement, the Git URL rewrite checks, the LFS
> checks, the GitHub App residual refusal, candidate SHA binding, check SHA
> binding, idempotence, credential isolation, or any existing mutation guard.
> Every other criterion stands exactly as frozen at `ac01c22`, which remains
> unchanged in history.

**AC-1.** A push is permitted only through an action whose zero-cost effects
were DERIVED from an observation of the exact push target. The bare
`GIT_PUSH` kind remains financial. An observation that is absent, was not
produced by the observer function, or describes a different target than the
one being pushed is treated as no observation — which is UNKNOWN, which is
financial, which refuses. Proven by mutation: removing the
observation-to-target binding fails a test that names it.

**AC-2.** Zero liability must be OBSERVED, not assumed. A repository that is
private, or whose visibility could not be determined, refuses — an allowance
that meters is a liability whether or not it is currently exhausted. The
observation is made in this process immediately before the gate, never read
from a persisted row, on the same reasoning as F4-3.

**AC-3.** Remote identity is a COMMIT, not a name. Every remote fact the
orchestration consumes carries the SHA it describes. A pull request whose
head SHA differs from the reviewed candidate refuses; a pull request whose
base has moved away from the reviewed base refuses. Neither the PR number nor
the branch name may substitute for the SHA in any decision. Proven by
mutation on each half.

**AC-4.** CI evidence is bound or it is not evidence. A check result whose
SHA is not the candidate's SHA says nothing about the candidate and must
refuse. "No checks are configured" is NOT a pass — it is the absence of
evidence, and it must be distinguishable in both the verdict and the
persisted record from "checks ran and succeeded". CI success alone never
implies acceptance: an independent-review verdict remains separately
required, and neither substitutes for the other.

**AC-5 (AMENDED — see "Owner-authorized amendment" below).** IDEMPOTENT
EXTERNAL PUBLICATION ADOPTION.

1. The Factory MUST NOT perform a remote pull-request-creation write unless the
   existing zero-cost gate has positively authorized that exact write.
2. If no matching pull request exists and remote-write authorization cannot be
   derived, publication returns the HUMAN_REQUIRED outcome carrying the refused
   action, performs ZERO remote writes, and does not weaken or bypass the
   zero-cost gate.
3. A human may create the pull request externally.
4. On a later run the Factory adopts an externally-created pull request ONLY
   when it is bound to the expected repository, the expected base identity, and
   the exact candidate commit SHA. Branch name, pull request number, title or a
   mutable head name are insufficient on their own.
5. When exactly one valid matching pull request exists, publication adopts it,
   binds its check evidence to the exact candidate, and records the publication
   through the existing durable provenance path.
6. Repeated execution creates ZERO additional pull requests.
7. An interrupted and resumed execution rediscovers and adopts the SAME valid
   pull request rather than duplicating publication.
8. When zero matching pull requests exist, the outcome is HUMAN_REQUIRED —
   publication required — and no write occurs.
9. When more than one valid matching pull request exists, publication FAILS
   CLOSED as ambiguous remote state: it does not arbitrarily select one, and it
   does not create another.
10. Candidate or check evidence describing a different commit must still refuse.

Proven with a scripted client across repeated and interrupted executions,
counting remote writes (which must be zero on every adoption path), and with
pure-function cases for the absent, unique, unbindable and ambiguous states.

**AC-6.** GitHub credentials never leave the trusted boundary. The
credential-bearing environment the `gh` adapter builds is never handed to the
isolated executor child; `ISOLATED_EXECUTOR_ENV_ALLOWLIST` gains no
credential-bearing variable; and no token, header or auth argument reaches
durable state, logs, tick results, provenance, review packets or fixtures.
Proven by a test that plants a token-shaped value in captured child output
and asserts it is absent from everything persisted.

**AC-7.** No second engineering loop. This capability implements nothing,
verifies nothing and reviews nothing. It creates no plan and no plan
approval, and an item without an approved plan is unaffected by it. C1's
`PLAN_APPROVAL` remains human.

**AC-8.** Git preconditions fail closed. A dirty working tree, an unexpected
remote URL, an unknown repository identity, a candidate that is not an
ancestor-compatible fast-forward of the base it claims, or an origin that has
moved since the candidate was reviewed each refuse with a named reason. No
operation in this task force-pushes, rewrites history, deletes a remote
branch, or changes repository visibility or settings.

**AC-9.** Every existing guard remains load-bearing. The financial gate,
isolation allowlist, verifier executable allowlist, provenance chain and
approval-authority guards still fail the cases that name them, proven by
mutation rather than by inspection.

**AC-10.** No test performs network access, spends anything, or invokes the
real `gh`. The adapter is exercised through the existing `ProcessRunner`
port with scripted results, exactly as `childPlanAdvancer` and
`cliResourceProbe` are.

## Out of scope

- **The autonomous merge to `main`.** Integration remains the ADR-0002 path
  it is today. This task produces the READINESS VERDICT that a later task
  consumes; it does not perform the merge. Reason: integration should require
  CI evidence, no CI exists yet, and building the executor now would bake in a
  rule `CLEAN_ROOM_CI` would immediately have to tighten.
- **Defining CI workflows** — that is `CLEAN_ROOM_CI`.
- **Issues and Projects sync.** The roadmap item names them, but the Factory's
  work queue is already durable and authoritative; mirroring it into Issues
  adds a second source of lifecycle truth without serving this lifecycle.
  Deferred until something actually consumes it (`CONTROL_ROOM`).
- Repository settings, visibility changes, releases, branch protection.
- The deferred notes in `docs/DEFERRED-REVIEW-NOTES.md`, none of which this
  task requires.

## Verification plan

Deterministic: typecheck, build, full suite, `git diff --check`. Focused
offline suites for the push verdict, the binding verdict, idempotence, and
credential containment. Mutation evidence for every security-relevant guard
named above, each mutation confirmed to have landed and compiled before its
result is trusted, with the tree verified byte-for-byte afterwards.
