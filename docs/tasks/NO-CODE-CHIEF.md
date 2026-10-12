# No-Code Chief — frozen acceptance criteria

Status: Policy staged; contract/enforcement implementation pending

## Scope

NC-POLICY-01 changes governance and freezes this specification only. It does not implement runtime contracts, controller behavior, or C6 worker-envelope code. Future implementation must start from the reconciled newer baseline, reuse the existing durable envelope/controller, and respect its active writer ownership. No source/test changes or external actions are authorized by this document alone.

These criteria are frozen before implementation. A writer may not weaken them to pass. Changes require a separate planning decision and user approval for material scope changes, under C2. Existing constitutional/security/approval rules remain binding.

The explicit user instruction on 2026-09-28 permanently strengthens this staged policy: the Chief only assigns, manages, monitors, observes, and evaluates bounded worker results through orchestration/status tools. It never authors code or writes/edits any file, including docs, state, evidence, and tickets, and never executes shell commands, tests, checks, hashes, or environment probes. Scoped controller/writer agents perform all filesystem/command work, including ticket freezing, ownership reservation, validation, and durable bookkeeping. This boundary covers initial work, corrections, restart, quota exhaustion, and unavailable delegation without exceptions; inability to delegate cannot authorize Chief self-implementation. Scoped controllers persist durable waits/checkpoints. Historical Chief source/test edits remain zero; earlier Chief shell/state operations remain audited without retroactive erasure.

## Required WorkerTicket contract

New user messages add or steer authorized work; they do not implicitly cancel or erase unfinished tasks. Only explicit cancellation or an incompatible instruction replaces earlier scope. Maintain each open task's owner, status, next action, blocker, dependency and completion evidence in the existing runtime plan/checkpoint. Reconcile unfinished tasks, actual claims and outbox on continuation or restart. An ended agent turn or a new message is not completion. This rule does not promise operation without an active supported host or eligible quota.

Use the standing model/effort and continuous disjoint Code/Cloud guidance in [Model Routing](../MODEL_ROUTING.md#standing-user-routing-refinement-2026-10-09), preserving the structured ticket and all protected gates.

Every dispatched ticket must contain these structured fields; omission or invalid values prevent dispatch:

| Field | Required meaning |
| --- | --- |
| `objective` | Concrete bounded outcome. |
| `acceptanceCriteria` | Frozen versioned conditions and measurable evidence. |
| `ownedPaths` | Explicit canonical write scope; reserve before dispatch. |
| `forbiddenPaths` | Explicit prohibited paths; deny wins on overlap. |
| `requiredReads` | Bounded authoritative inputs and evidence references. |
| `dependencies` | Ticket identifiers and required completion conditions. |
| `model`, `reasoningEffort`, `rationale` | Selected eligible model AND supported reasoning effort with task-specific cost/capability rationale. Choose the cheapest sufficiently capable combination; stronger selections require evidence, risk, complexity, or failure history. No unnecessary high defaults or underpowered assignments merely for savings. |
| `validationCommands` | Executable commands and expected success conditions. |
| `budget` | Finite positive context, output, elapsed-time and attempt limits. No unlimited defaults. |
| `checkpointPolicy` | Durable checkpoint location, triggers, and restart behavior. |
| `stopConditions`, `escalationConditions` | Explicit boundaries, failure routing, and quota handling. |
| `resultSchema` | Versioned bounded WorkerResult schema below. |

Ownership must account for canonical paths, directory descendants, aliases and case rules of the host filesystem; textual inequality is insufficient. Unmet dependencies, unavailable quota, invalid scope, or invalid budgets cannot launch a model. Budget exhaustion checkpoints and stops or escalates; it cannot silently widen scope or context.

The permanent cost-quality rule applies to every task and retains the routing preferences and escalation gates in `docs/MODEL_ROUTING.md`, including eligibility, quota, and approval constraints. A scoped controller records and validates the model/effort/rationale fields before dispatch; the Chief evaluates bounded routing results without filesystem or command operations.

## Test selection before dispatch

Choose the least costly checks that establish the acceptance criteria and system invariants, rather than targeting a coverage percentage or test count. In the ticket's validation rationale, record **invariant -> observable failure -> smallest sufficient test group**, the exact command, expected outcome, and evidence to reuse. This is controller planning guidance within the existing ticket contract, not a new runtime schema or enforced selector.

| Invariant | Observable failure | Smallest useful group |
| --- | --- | --- |
| Only the issued channel handle grants admission | A clone, proxy or foreign handle obtains authority | One valid issuance control plus representative identity refusals; verify the protected authority boundary was not crossed. |
| Consumption is one-shot and current | Replay, stale context or racing callers launch twice | Focused freshness and retirement scenarios with a deterministic overlap barrier and observable consume outcomes; use a real process/store race when that boundary is the claim. |
| Stream progress survives restart | Records are lost/duplicated, or an incomplete UTF-8 tail becomes a record | One incremental/restart sequence covering the relevant byte boundaries, plus malformed/final-tail cases where behavior differs. |
| Invalid evidence cannot authorize work | Malformed state, wrong-case identity or unrelated validation failure is treated as success | A valid baseline and targeted invalid partitions with the intended refusal reason or boundary outcome; preserve distinct case-identity and schema protections. |

These are examples for the admission/cursor work, not mandatory new tests for every ticket. Select groups by the changed behavior and its dependencies. Do not assert private helper structure or incidental call order. A count at an externally meaningful authority boundary can be essential evidence of no launch or at-most-once consumption; it is not redundant merely because a mock records it.

Before adding a test, identify the distinct observable regression it detects and whether an existing test already detects it. A negative test must start from a demonstrably valid fixture and reach its intended refusal; a generic rejection caused by an invalid baseline proves nothing about later lifecycle checks. Use bounded synchronization and completion checks for concurrency, not sleeps or gates that the test cannot release. Prefer a small parameterized group for equivalent cases; retain separate cases where they protect different fields, failure modes or boundaries.

Run the affected group while correcting a candidate. If compilation fails, stop checks that require a valid fresh build; any emitted-code diagnostic is explicitly non-acceptance evidence. Do not repeat the same failing compiler pass through another wrapper without a new diagnostic purpose. Once the candidate stabilizes, execute all checks required by its frozen ticket and applicable repository gates. Do not silently replace a required typecheck, build or integration command with a cheaper command. Changes to those requirements belong to a separate planning decision under C2, not to the implementation worker.

Reuse passing evidence only when its source, tests, dependencies, configuration and relevant environment still match the recorded fingerprint; record that justification. A change invalidates affected evidence and always requires fresh review of the new candidate fingerprint under C13. Broaden checks when a changed shared boundary, new failure or unresolved risk warrants it; do not automatically repeat an unchanged full suite after every review message. Required clean-build/artifact-provenance, security, approval and release gates remain intact.

Record actual durations and generation cost when available, separating test execution from model authoring, compilation and environment setup. Do not infer elapsed savings from test counts. There is no arbitrary test-count cap, automatic deletion, or permission to remove a failing test to obtain green results. A proposed consolidation must identify retained unique protections, obtain independent review, and respect the source/test owner's implementation routing.

## Required WorkerResult contract

Every result is a valid schema-checked JSON object, serialized as at most **2048 UTF-8 bytes**, containing `summary`, `changedPaths`, `commandsRun`, `validationResults`, `fingerprint`, `checkpointRef`, `blockers`, and `recommendedNextAction`. Empty lists are explicit. Commands and validation outcomes must distinguish executed, failed, and not run; never infer success from prose. Use durable evidence references for detailed output; raw logs do not belong in the result.

`fingerprint` identifies a durable SHA-256 candidate manifest covering every changed/owned candidate file (including deletion markers), the frozen ticket/spec, and referenced validation evidence. The result itself is excluded to avoid circular hashing. Review records bind reviewer identity, independence, verdict, and the exact fingerprint. Candidate or evidence mutation requires fresh validation as applicable and fresh review. A result is evidence, not approval or DONE authority.

## Frozen executable acceptance matrix

Future implementation must supply automated positive, negative, restart, and boundary checks as applicable, with actual commands and recorded outcomes:

| ID | Measurable criterion |
| --- | --- |
| NC-01 | Chief code authorship and all file writes/edits = 0, including docs/state/evidence/tickets; Chief shell commands, tests, checks, hashes, and environment probes = 0. Cover initial work, correction, restart, quota exhaustion, and unavailable delegation with no exception. Attempts are denied and recorded by scoped controllers; historical source/test edits zero and earlier shell/state audit records remain intact. |
| NC-02 | Duplicate active writers for any canonical owned path = 0 under concurrent dispatch and crash recovery. Out-of-scope writes are denied. |
| NC-03 | Unstructured or invalid results accepted = 0. Missing fields, malformed JSON, invalid evidence refs, and oversized results fail closed. |
| NC-04 | Accepted results are <=2048 UTF-8 bytes; test exact 2048/2049-byte boundaries and multibyte text. Large evidence is referenced, not inlined. |
| NC-05 | Accepted candidates missing independent review of the exact fingerprint = 0. Self-approval, stale review, and mutated candidate/evidence fail closed. |
| NC-06 | DONE without required executed and passing deterministic validation = 0, even when a writer or reviewer claims success. |
| NC-07 | Model launches with no eligible quota = 0. Durable wait survives restart and resumes only after eligibility is rechecked, without Chief implementation. |
| NC-08 | Silent terminal stalls = 0. A persisted finite stall deadline produces an observable checkpoint and recovery/escalation decision; restart preserves pending outbox delivery and deduplication. |
| NC-09 | Blind third corrections after two failed corrections = 0. Persisted counters survive restart; further work needs recorded diagnosis/replan/escalation and a new bounded authorization. |
| NC-10 | Dispatches lacking finite context/output/time/attempt budgets = 0. Exhaustion records a durable checkpoint and bounded next action. |
| NC-11 | Runtime authority derived from Obsidian or other human notes = 0. Structured state and existing trusted authorization gates remain authoritative. |
| NC-12 | Existing security, approval, audit, and executor prerequisites remain effective. Local authorized reversible work proceeds without repeated approval; excluded financial/external actions gain no authority from this policy. |
| NC-13 | Every dispatch records a valid eligible `model`, supported `reasoningEffort`, and task-specific `rationale`; omissions fail closed. Routing selects the cheapest sufficiently capable combination. Stronger selections cite evidence/risk/complexity/failure history; unnecessary high defaults and underpowered savings assignments are rejected while existing routing/escalation gates remain effective. |

## Verification and release boundary

The policy increment requires scoped agents to run `git diff --check`, assertions that pre-existing constitutional rules were retained, and independent review of its exact file manifest. Product tests do not establish enforcement of this docs-only increment and are not required for it. Documentation alone does not establish runtime enforcement. Runtime work must add executable tests for every matrix row and run the repository's applicable validation suite before independent acceptance. Integration, deployment, external transfer, and publication are not completion steps for this ticket.

## Standing human authorization for Claude development transfers

On 2026-10-07, the user explicitly authorized current and future SoftwareFactory files, source, tests, documents, requirements, derived corrections and retained development-session context to be shared with Anthropic Claude, and asked not to be asked again for each sharing action. The user's wording uses "Cloud"; the conversation identifies Claude/Anthropic. Preserve the exact wording and provenance in the existing authoritative [standing-consent record](../../.factory-data/chief/controller-runtime/control/standing-consent.json), including its prior lineage. This records a human decision, not a new platform permission.

Before new or resumed work, controllers consult that record and bind each concrete destination, packet hash/bytes, session and retained context to its scope. Matching development transfers reuse the standing authorization; a new file, byte count, test or correction alone does not require another human consent question. Later human revocation or narrowing supersedes it. Secrets, credentials, personal or production data and unrelated projects remain outside this protected development workflow; spending, publishing and security changes need their existing separate authority.

Normal automatic review still runs. Persist the genuine authorization and exact request before submission, then the actual review decision and process evidence separately. An automatic rejection is a platform-review rejection, not proof that this scope-matching human authorization is missing. Preserve its exact reason, stop the rejected action, and do not bypass it through another route or settings change. This document neither guarantees acceptance nor fabricates a native approval grant; all constitutional, test and independent-review requirements remain in force.


## Standing human authorization for routine GitHub task tracking

On 2026-10-09, the user explicitly authorized routine current and future Factory Issue creation, reads, updates and factual task progress/status synchronization in https://github.com/hakanduyar/software-factory. Matching routine tracking does not require a new human consent question merely because the task ID or payload bytes change. The separate GitHub lineage is recorded in the existing control/standing-consent.json githubRoutineTaskTracking field; it is not the Anthropic development-transfer consent.

Each remote review request includes the exact destination, action and bounded public payload together with the trusted human instruction scope. Preserve stable-marker deduplication, one writer, normal platform review and actual readback. This grants no push, PR, merge, release, spending, security change, unrelated destination or protected-data disclosure authority. Preserve and report actual automatic-review rejection; assess supported safe alternatives without bypassing it or promising approval.
