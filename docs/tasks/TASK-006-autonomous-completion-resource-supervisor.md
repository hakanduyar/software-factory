# TASK-006 — Autonomous Completion & Resource Supervisor

## Objective

Make the Factory's ability to finish work independent of any single AI
conversation.

After TASK-005 the Factory can take intent → Plan → approval → WorkItems →
TASK-004 implement/verify/review loop. But every one of those steps still needed
a live Claude or Codex session driven by a human relaying prompts. That makes
completion hostage to context windows, provider rate limits, usage caps and
transient outages.

TASK-006 moves the Factory's memory and scheduling into deterministic
infrastructure — SQLite, Git, and a one-shot supervisor process — so that a
model session becomes a *disposable worker*, not the seat of the Factory's mind.

Two rules govern everything below.

**RULE 1 — AI must never be used to wait for AI.** Waiting, retry timing, quota
recovery and availability probing are deterministic infrastructure concerns. The
supervisor never keeps a model alive to ask "is the limit reset yet?".

**RULE 2 — The Factory has exactly zero autonomous financial authority.** This is
a hard security boundary, not a preference, and it is enforced by a gate that
structurally cannot be overridden. See §3.

## Runtime decision (amendment, 2026-08-23)

**The authoritative runtime for completing the Software Factory is the existing
always-on Windows PC → WSL2 Ubuntu → native Linux Factory runtime.**

A dedicated VPS is **not required and not authorized**. The earlier roadmap
assumption of a "server foundation / dedicated Ubuntu VPS" is replaced by a
**local 24/7 runtime foundation**: making the machine already owned into a
reliable, restartable, remotely manageable Factory host.

**Zero paid infrastructure.** No VPS, paid cloud VM, managed database, paid
storage or queue, paid CI minutes beyond the included allowance, paid GitHub
add-ons, paid tunnelling, or any other new infrastructure charge. This sits *on
top of* the FinancialSafetyGate rather than replacing it, and an existing
subscription is never permission to incur additional usage charges.

Resource preference, in order: deterministic local execution on the existing
WSL2 machine → existing zero-cost GitHub capability → another technically
justified zero-cost resource → wait for an unavailable existing resource →
human escalation if a genuinely necessary paid resource is the only solution.
"This would be easier with a VPS" is not a proof of necessity.

GitHub's included facilities (repos, branches, PRs, status checks, Actions,
Issues, Projects) may and should be used where they genuinely improve
verification, orchestration, recovery, auditability or reproducibility — but not
merely because they are free, and never past the included allowance: an
exhausted allowance is `WAITING_FOR_RESOURCE`, never a purchase. GCP/AWS/Azure
free tiers are optional isolated learning labs, never a dependency of core
operation, and anything capable of creating liability is `FINANCIAL_ACTION`.
The existing DigitalOcean droplet is explicitly out of scope and untouched.

Automatic recovery after a Windows reboot is **not claimed** and not implemented
here; TASK-006 builds the deterministic supervisor foundation that a later
runtime task needs in order to implement and test it.

## Scope boundary (non-goals)

- No VPS purchase, provisioning or deployment (TASK-006 runs locally on WSL, and
  under the amendment above no VPS is required at all).
- No Telegram, n8n, Control Room, GitHub orchestration, or learned Model Router.
  TASK-006 builds the *mechanism* by which those later become schedulable work.
- No replacement of TASK-004's loop or TASK-005's planner. The supervisor
  *schedules* them; it re-implements neither.
- No new AI vendor integration. Provider knowledge stays behind adapters (C9).

---

## 1. Measured environment (not assumed)

Every flag and probe below was measured on this machine before being used.
Nothing in this task invents a CLI flag, an output string or an exit code.

| Fact | Measured value |
| --- | --- |
| Claude Code | `2.1.238`, at `~/.nvm/versions/node/v22.22.3/bin/claude` |
| Claude model/effort flags | `--model <m>`, `--effort <level>`, `--fallback-model <m>`, `-p/--print`, `--output-format json` |
| Claude zero-token auth probe | `claude auth status` → JSON (`loggedIn`, `authMethod`, `subscriptionType`), exit 0 |
| Claude zero-token health probe | `claude doctor` → install health, exit 0 |
| Codex CLI | `codex-cli 0.149.0`, same bin dir |
| Codex model/effort flags | `-m/--model`, `-c <key=value>` config override, `-s/--sandbox`, `--json`, `-o/--output-last-message` |
| Codex zero-token auth probe | `codex login status` → "Logged in using ChatGPT", exit 0 |
| Codex zero-token health probe | `codex doctor --json` → `{schemaVersion, overallStatus, checks{auth.credentials{status,summary}, ...}}`, exit 0 |
| Scheduling | systemd 255 present, **user instance running**, `systemd-run` present, `crontab` present, `at` absent |

**What could NOT be measured, and is therefore not claimed.**

- Neither CLI documents its rate-limit or usage-exhaustion output format, and
  observing a real one would require deliberately exhausting a paid quota.
  TASK-006 therefore hardcodes **no** rate-limit strings. See §5.
- `codex exec --help` documents the `-c key=value` MECHANISM but does **not**
  enumerate accepted values for `model_reasoning_effort`. The accepted set in
  `SUPPORTED_CODEX_EFFORTS` is therefore not "measured from help output": what
  is measured is that `xhigh` works, since every TASK-005 independent review in
  this repository ran with it. The list exists so an unvouched-for value is
  refused rather than passed through and reported as applied.
- Only the SIGNED-IN outputs of `claude auth status` and `codex login status`
  were observed; nobody logged out. The negative text signatures are therefore
  `PROVISIONAL` and inert, and authentication is detected structurally from the
  measured `loggedIn` / `auth.credentials.status` fields instead.

This list is deliberately specific. "We measured everything" is the kind of
claim that is easy to make and hard to keep, and the first independent review of
TASK-006 caught exactly one instance of it slipping.

---

## 2. Layer placement

`src/supervision/` is an orchestration layer, peer to `src/orchestration/`
(TASK-004) and `src/planning/` (TASK-005), sitting above the accepted TASK-001
domain. It coordinates trusted services; it owns no domain rules and modifies no
accepted domain type.

```
src/supervision/          policy, state machine, tick engine (no I/O)
src/adapters/supervision/ SQLite + in-memory repositories, real CLI probes
src/cli/supervise.ts      sf supervise tick | status | resources | roadmap
```

---

## 3. FinancialSafetyGate — the blocking invariant

### 3.1 The rule

    AUTONOMOUS_SPEND_LIMIT = 0
    autonomousSpendAllowed = false

The existence of a saved card, an authenticated session, an active
subscription, stored API credentials, provider credits, or a previously
approved purchase **is never authorization to spend**. Authentication is not
authorization; payment capability is not spending authorization.

### 3.2 Why it cannot be overridden

The gate is not "a check callers should remember to call". It is designed so
that there is *no parameter through which authorization could be passed*:

```ts
evaluateFinancialSafety(action: SupervisedAction, policy: FinancialPolicyResult): FinancialVerdict
```

It accepts **no `Actor`, no `TrustedHumanToken`, no `Approval`, no plan, no
model output**. A caller holding a genuine human token cannot pass it in,
because the function does not take one. This mirrors how `Worker` never receives
the identity credential (TASK-001) — the safest boundary is one that is
structurally unable to be crossed, not one that is merely policed.

Consequently, and by test: a PLAN_APPROVAL, a RELEASE_APPROVAL, task acceptance,
the completion mandate itself, and any model output saying "purchase approved"
all have **exactly zero** effect on the verdict.

### 3.3 Classification

```
FREE_LOCAL_ACTION       runs locally, no network liability (tests, build, git)
FREE_REMOTE_ACTION      remote, deterministically zero-cost and zero-liability
FINANCIAL_ACTION        can create a charge or financial liability
HUMAN_CREDENTIAL_ACTION needs a password / sudo / MFA / CAPTCHA / OAuth consent
PUBLICATION_ACTION      makes something public or externally visible
DESTRUCTIVE_ACTION      irreversible data/infrastructure loss
```

Classification is **derived, not declared**. A caller may state a class, but the
gate independently derives one from a registry of known action kinds and takes
the **most restrictive of the two** — the same discipline TASK-005 round 1
established for approvals, applied to money.

An **unknown action kind is FINANCIAL_ACTION**. The supervisor only ever
executes actions from a closed, known set, so an unrecognised kind is genuinely
suspicious, and "when uncertain, FINANCIAL_ACTION" is the mandated rule.

`FREE_REMOTE_ACTION` requires *all* of: cost deterministically zero, no payment
method required, no usage-based charges possible, no automatic paid conversion.
A "free tier" that requires a card on file, meters usage, or can silently
convert is **FINANCIAL_ACTION**.

### 3.4 Fail-closed policy loading

`FinancialPolicy` is persisted. Missing, unreadable, malformed, or
type-invalid policy ⇒ **DENY**, never allow. The secure default is deny, and the
absence of a policy is not treated as "no restrictions".

### 3.5 What a denial does

    FINANCIAL_ACTION
      → DENY_AUTONOMOUS_EXECUTION   (before any browser/API/CLI execution)
      → durable WAITING_FOR_HUMAN_REQUIRED, reason FINANCIAL_ACTION_REQUIRED
      → zero side effects

The denial is recorded *before* execution, so nothing is attempted and then
rolled back. Provider limits therefore produce `WAITING_FOR_RESOURCE`, never
"buy more credits".

### 3.6 Defence in depth

1. This deterministic gate.
2. Least-privilege provider credentials that *technically cannot* manage
   billing, purchase resources or change subscriptions (documented requirement
   for the later server task — prompt-level prohibition is insufficient where
   provider-level permission separation exists).
3. Human-only financial transactions.

---

## 4. Resource state machine

A **resource** is a `(provider, model)` pair plus its class, e.g.
`claude-code/opus`. Persisted per resource:

`provider · resourceKey · resourceClass · state · detectedAt · lastCheckedAt ·
retryAt? · classification · backoff{attempt, delayMs} · lastSuccessAt? ·
diagnostic (bounded, redacted)`

Never persisted: credentials, tokens, raw provider payloads.

| State | Meaning |
| --- | --- |
| `AVAILABLE` | last evidence says usable |
| `BUSY` | currently claimed by an in-flight action |
| `RATE_LIMITED` | short-term provider throttle, usually with `retryAt` |
| `USAGE_LIMIT_REACHED` | plan/quota exhausted for a period |
| `MODEL_UNAVAILABLE` | provider up, this model not usable |
| `PROVIDER_UNAVAILABLE` | provider/network unreachable |
| `AUTH_REQUIRED` | credentials missing/expired — human-only to fix |
| `UNKNOWN_FAILURE` | failed, cause not deterministically classifiable |

`WAITING_FOR_RESOURCE` is deliberately **not** a resource state — it is a state
of a *task*. A resource shortage is not `FAILED` and not `RECOVERY_REQUIRED`.

---

## 5. Deterministic failure classification

Evidence is consulted in strict priority, and **only** deterministic sources:

1. **Process facts** — `terminationReason` (`SPAWN_ERROR` ⇒
   `PROVIDER_UNAVAILABLE`, `TIMEOUT` ⇒ transient) and exit code, from the
   accepted TASK-003 `ProcessRunner`. Fully under our control.
2. **Structured zero-token probes** — `codex doctor --json`
   (`checks["auth.credentials"].status`) and `claude auth status` (`loggedIn`).
   Parsed structurally, not by message text.
3. **Configured signature table** — regex → classification, each entry carrying
   its own `evidence` level.
4. Unmatched ⇒ `UNKNOWN_FAILURE`.

### 5.1 The honesty rule for signatures

Every signature records how it is known:

- `MEASURED` — observed on this machine and captured as a permanent fixture.
- `PROVISIONAL` — plausible but **not** observed. **Disabled by default**; a
  provisional match does not classify, it falls through to `UNKNOWN_FAILURE`.

Because a real rate-limit response was never observed (observing one costs real
quota), no rate-limit signature ships as `MEASURED`. This is deliberate and it
is safe: an unclassified failure becomes `UNKNOWN_FAILURE`, which is handled by
bounded backoff (§6) — which is exactly the correct treatment for a suspected
transient limit anyway. When a genuine limit response is observed in the field,
its fixture is added and promoted, and the behaviour sharpens from "back off"
to "back off until the known `retryAt`".

**No model is ever invoked to classify a provider error.** Classification is
pure, synchronous and unit-tested.

---

## 6. Zero-token recovery and bounded backoff

Recovery preference, strictly ordered:

1. explicit `retryAt` / reset metadata, when the provider gave one;
2. deterministic zero-token probe (`codex doctor --json`, `claude auth status`);
3. scheduler wake at a known time;
4. bounded deterministic backoff;
5. a model invocation *purely* to probe quota — **last resort, and not
   implemented in TASK-006** because options 1–4 cover every measured case.

**If `retryAt` is known, the supervisor does nothing until it is due.** No
per-minute polling. Between ticks no process runs at all, so waiting costs zero
tokens and zero CPU.

Backoff when no reset time is known: `5m → 15m → 30m → 60m (cap)`, persisted per
resource so a restart does not reset it, deterministic (no randomness) so it is
exactly testable.

---

## 7. Scheduler — a one-shot tick, not a daemon loop

`sf supervise tick` performs **one** bounded pass and exits:

1. reconcile any in-flight action claim (crash recovery, TASK-004/005 protocol);
2. refresh resources whose `retryAt` is due, using zero-token probes;
3. select the highest-priority roadmap item whose required resource class is
   satisfiable *now*;
4. if none: compute `nextWakeAt = min(retryAt)`, persist it, exit;
5. if one: claim it (CAS) → launch worker → reconcile result → checkpoint.

Exiting rather than sleeping is what makes waiting free. `nextWakeAt` is printed
and persisted so a systemd timer (user instance measured as running) or `cron`
can wake the next tick. TASK-006 ships the tick and the wake time; wiring it to
a unit file belongs to the later server task.

**A resource shortage never blocks the whole Factory.** Eligibility is per-item:
if Claude is exhausted, deterministic verification, Git work, and any item whose
required class is available still run.

---

## 8. Model and effort enforcement

Writing `MODEL: X` in a prompt proves nothing about the process that ran. TASK-006
makes model and effort **launcher-level configuration**, built from the flags
measured in §1.

Every AI run records six fields plus a verification verdict:

`requestedProvider/Model/Effort` · `effectiveProvider/Model/Effort` ·
`verification ∈ {VERIFIED_EFFECTIVE, UNVERIFIED, MISMATCH}`

- The **argv actually built** is recorded as evidence. That is a genuinely
  stronger proof of intent than prompt text, and it is deterministic.
- `effective*` is only marked `VERIFIED_EFFECTIVE` when the provider's own
  structured output echoes the identity back. Otherwise it is `UNVERIFIED`.
- A recorded `effective` that contradicts the request is `MISMATCH` and fails
  closed.

TASK-006 does not claim to verify effective model identity where the provider
does not report it. Recording `UNVERIFIED` honestly is the requirement; claiming
verification that was not performed is the defect.

---

## 9. Routing policy and reviewer independence

A deterministic policy maps a work class to eligible resource classes:

`DETERMINISTIC · SIMPLE_IMPLEMENTATION · NORMAL_IMPLEMENTATION ·
HIGH_RISK_IMPLEMENTATION · ARCHITECTURE_SECURITY · INDEPENDENT_REVIEW · DOCS`

Two rules are absolute:

- **Reviewer independence (C4).** A routing whose reviewer resource equals the
  implementer resource for the same work item and spec revision is refused. If
  no independent reviewer is available, the item becomes
  `WAITING_FOR_RESOURCE` — the implementer never reviews itself, and reviewer
  quality is never silently downgraded.
- **No unsuitable substitution.** If fallback would violate the work class's
  quality floor, wait rather than proceed. Moving is not more important than
  moving correctly.

---

## 10. Session rollover vs. quota exhaustion

These are different problems and get different answers:

| Condition | Response |
| --- | --- |
| context/session exhausted | checkpoint → end session → fresh worker session → reload bounded context → continue |
| provider quota exhausted | `WAITING_FOR_RESOURCE` → wait for `retryAt` |

A `SessionCheckpoint` persists what a *new* process needs to resume: project,
work item, plan id/revision, acceptance criteria ids, branch, base commit,
current action identity and iteration, completed and pending verification,
findings, next deterministic action, required resource class.

It is deliberately **bounded and structured**. Raw conversation transcripts are
never the authoritative memory — the Factory's memory is its database and its
Git history.

---

## 11. Durable roadmap queue

`RoadmapItem`: `id · key · title · dependsOn[] · status · workClass ·
requiredResourceClass · planId?`, with `PENDING → ELIGIBLE → ACTIVE → DONE`
plus `BLOCKED` / `WAITING_FOR_RESOURCE` / `WAITING_FOR_HUMAN_REQUIRED`.

Eligibility is a dependency DAG, validated on read exactly like TASK-005's plan
dependencies (no cycles, no dangling references). Completing and integrating one
item makes its dependents eligible, which is the mechanism by which the Factory
continues without a human relaying prompts.

The queue is seeded with the roadmap areas named in the mandate (server
foundation, 24/7 runtime, GitHub orchestration, Telegram, n8n, Control Room,
measured model router, release hardening, end-to-end acceptance). These are
*queue entries*, not frozen specifications: each still goes through TASK-005
planning and independent review before implementation.

---

## 12. Crash, concurrency and persistence

The TASK-004/005 protocol applies unchanged: durable action claim by CAS
**before** any external side effect; canonical derived action identity; strict
parse-on-read with `PersistenceCorruptionError`; ambiguity fails closed.

Specifically, no duplicate external worker launch may occur after a crash at:
before claim · after claim/before launch · launch in flight · after result,
before checkpoint · during a rate-limit transition · during retry scheduling ·
before next-item activation.

---

## Acceptance criteria

A criterion is met only when a permanent automated test proves it. **No test may
consume real model quota, perform a real purchase, or change real billing.**

**AC-1 — Zero autonomous spend.** `FinancialSafetyGate` denies every
`FINANCIAL_ACTION` before execution, with zero side effects. Proven for: paid
VPS, usage-billed VM, AI credit purchase, subscription upgrade, pay-as-you-go
enablement, auto-top-up, paid overage, domain purchase, marketplace add-on,
uncertain-price resource, and free-tier-with-billing-capability.

**AC-2 — Authentication is not authorization.** A saved card, an authenticated
provider account, stored credentials and an active subscription each fail to
authorize a purchase.

**AC-3 — No authority can override the gate.** Plan approval, task acceptance,
the completion mandate, a caller-created HUMAN actor, and model output claiming
approval all leave the verdict unchanged. The gate accepts no actor/token/
approval parameter.

**AC-4 — Policy fails closed.** Missing, unreadable, malformed or type-invalid
`FinancialPolicy` ⇒ deny.

**AC-5 — Uncertainty is financial.** An unknown action kind, and any action
whose cost is not deterministically zero, classify as `FINANCIAL_ACTION`.

**AC-6 — Limits never buy.** Resource exhaustion produces
`WAITING_FOR_RESOURCE` and never a purchase or billing change.

**AC-7 — Resource states are durable and fail closed.** All states persist and
round-trip; unclassifiable failures become `UNKNOWN_FAILURE`; corrupt rows are
refused at read.

**AC-8 — Classification is deterministic and model-free.** Rate limit, usage
exhaustion, auth expiry, model unavailable, provider outage, transient network
failure and unrelated worker failure are classified without invoking any model.
`PROVISIONAL` signatures do not classify.

**AC-9 — Zero-token waiting.** While a resource is unavailable: no model
invocation, no polling before `retryAt`, and the tick exits rather than sleeping.

**AC-10 — Backoff is bounded and survives restart.** `5m → 15m → 30m → 60m` cap,
persisted, deterministic.

**AC-11 — Shortage is not global failure.** Work whose required resource class
is available still runs while another resource is exhausted.

**AC-12 — Model/effort are real.** Requested model/effort produce the measured
CLI argv; requested vs effective vs verification status are recorded; unsupported
model/effort and forbidden fallback fail closed; no silent downgrade.

**AC-13 — Reviewer independence survives scheduling.** No routing lets an
implementer review its own work; absent an independent reviewer the item waits.

**AC-14 — Session rollover.** A checkpoint lets a fresh process resume the same
work item/revision/action without repeating completed work, without replaying an
ambiguous external action, and without any prior transcript.

**AC-15 — Autonomous roadmap continuation.** Offline simulation: item A passes
review and integrates ⇒ item B becomes eligible with no human prompt; item C
gets `CHANGES_REQUIRED` ⇒ remediation ⇒ re-review ⇒ pass ⇒ integrate; item D hits
a rate limit ⇒ waits with no token use ⇒ recovers on fake time advance; item E
needs human-only action ⇒ `WAITING_FOR_HUMAN_REQUIRED` with no bypass.

**AC-16 — Crash safety.** No duplicate external launch at any of the boundaries
in §12; ambiguity fails closed.

**AC-17 — Security.** No secret, env or raw provider payload leakage; no shell
interpolation; no arbitrary executable/model injection; no workspace escape; no
forged resource availability; no caller-created human authority.

**AC-18 — Accepted work preserved.** TASK-001..005 invariants intact and the
937-test baseline strictly increases through legitimate tests.

**AC-19 — No paid infrastructure dependency.** Core operation requires no VPS,
no paid cloud resource and no GitHub capability beyond the included allowance;
an exhausted allowance produces `WAITING_FOR_RESOURCE`, never a purchase.

---

## Remediation round 1 (independent review, 2026-08-23)

The first independent acceptance review returned `CHANGES_REQUIRED` with two
CRITICAL and seven HIGH findings. All are closed, each with a permanent
reproduction in `tests/task006RemediationRound1Repro.test.ts`.

One theme runs through the two CRITICALs and the worst HIGH, and it is worth
stating plainly because this codebase keeps rediscovering it:

> **A safety property that depends on data the system itself can write is not a
> safety property.**

- **F-1 (CRITICAL) — a stored policy could grant a budget.** `parseFinancialPolicy`
  accepted a positive limit and the gate honoured it, so anything able to write
  the supervisor row could authorize spending. Now a policy claiming permission
  to spend is itself refused as untrusted, and **the gate has no branch that
  allows a financial action at all**. Raising the limit is deliberately a CODE
  change — reviewed, and gated by independent acceptance — not a data edit.
- **F-2 (CRITICAL) — running a model was assumed free.** `LAUNCH_AI_WORKER` was
  registered as unconditionally free, asserting a fact about billing the verb
  does not carry. Cost is a property of the RESOURCE: `launchAiWorkerAction`
  now takes the resource's `billingMode`, only `INCLUDED_SUBSCRIPTION` is free,
  and an undeclared resource is `UNKNOWN` and therefore financial.
- **F-3 (HIGH) — an executor could act before its outcome was gated.** Roadmap
  items now DECLARE the action kinds their executor may perform, and every one
  is gated before the executor is launched. (An executor remains trusted code,
  like a `Worker`; this ensures the supervisor never *starts* work whose
  declared actions it would refuse.)
- **F-4 (HIGH) — probes trusted healthy output from a failed process.** Exit
  status is the OS's verdict and outranks anything the process printed, exactly
  as TASK-003 already refuses to let stdout override `exitCode`.
- **F-5 (HIGH) — checkpoints could name a different action.** The supervisor now
  stamps its own `actionId`, overriding whatever the executor supplied.
- **F-6 (HIGH) — the remediation budget never bit.** It counted
  `checkpoint.iteration`, but `CHANGES_REQUIRED` writes no checkpoint. The
  counter moved to the ITEM, which exists for every attempt.
- **F-7 (HIGH) — PATH could substitute the CLI.** Probe executables must now be
  absolute paths, resolved once at construction; a bare name is refused.
- **F-8 (HIGH) — a persisted `AVAILABLE` was believed forever.** Availability is
  now re-confirmed after `MAX_AVAILABILITY_AGE_MS`, and a never-probed row is
  never trusted. The probe is zero-token, so this costs nothing.
- **F-9 (HIGH) — an unsupported Codex effort was passed through.** Validated in
  this layer before it can reach argv, without weakening the accepted adapter.

Also fixed from the review's non-blocking notes: persisted escalation text is
bounded (durable state is audit data, not a transcript), and the `status`,
`resources` and `roadmap` commands no longer initialize state — a read that
writes is a read you cannot safely run to diagnose a problem.

The honesty audit's two corrections are folded into §1 above.

## Remediation round 2 (independent re-review, 2026-08-23)

The re-review confirmed F-1 through F-7 and F-9 CLOSED, found F-8 only
partially closed, and raised four new findings — **one of them a CRITICAL this
remediation itself introduced**. That is worth recording plainly rather than
burying, because it is the most instructive event in the task:

> **N-1 (CRITICAL).** Fixing F-2 required letting an action carry billing facts,
> and the quickest way to do that was to let `action.effects` REPLACE the
> registry. Which meant a caller could hand benign effects to `PROVISION_VPS`
> and get `FREE_REMOTE_ACTION` — reintroducing, through the side door, the exact
> "declared, not derived" hole this module exists to close, in the same commit
> that closed a different one.
>
> The fix distinguishes two cases. A tiny explicit set of kinds
> (`RESOURCE_PARAMETERISED_KINDS`) genuinely have resource-dependent cost; for
> those, effects are the source of truth AND are required, since missing facts
> mean missing knowledge. For every other kind the registry is authoritative and
> caller effects may only make the verdict STRICTER.

- **N-2 (HIGH) — reviewer independence broke across items.** Implementer
  identity lived only in a checkpoint for the same roadmap key, and a completed
  item's checkpoint is deleted, so a dependent `INDEPENDENT_REVIEW` item had
  nothing to exclude and selected the very resource that had implemented the
  work. C4 is a property of the LINEAGE, not of one item, so the identity is now
  recorded on the item (`implementedByResourceKey`) and a review excludes both
  its own and its dependencies' implementers.
- **N-3 (HIGH) — secrets were persisted and logged verbatim.** `boundedDiagnostic`
  bounded but did not redact, so a token in an executor's description or a
  provider's error reached durable state. It now reuses the accepted
  `redactSecrets`, so there is one definition of what a secret looks like (C6).
- **N-4 / F-8 (HIGH) — a forged FUTURE timestamp bought trust.** The first fix
  rejected stale and never-probed records but accepted
  `lastCheckedAt = now + 10^10`, parking a resource in "recently confirmed
  healthy" forever. An observation that has not happened yet is not an
  observation: a future `lastCheckedAt`, and a `retryAt` further out than the
  ladder could ever schedule, both force a re-probe.

Also fixed from the notes: the probe's executable lookup no longer goes through
a shell at all (`/usr/bin/which` takes the name as an argument, so nothing is
parsed) — it was reachable only with internal constants, but a lookup that
cannot interpolate beats one that merely happens not to.

## Remediation round 3 (independent re-review, 2026-08-23)

The third review confirmed rounds 1 and 2 closed and raised four new findings.
All four are the same sentence in different clothes — *a safety property that
depends on data the system itself can write is not a safety property* — and the
answers differ only in what "data the system can write" happened to mean:
configuration, an in-process object, executor output, a caller-supplied string.

- **NEW-FIN-1 (CRITICAL) — billing mode was declared, not observed.**
  `resourceCatalog` entries carried `billingMode`, so writing
  `billingMode: "INCLUDED_SUBSCRIPTION"` next to a metered resource made
  spending look free — the financial gate then correctly permitted what it had
  been incorrectly told. The mode is now OBSERVED: the probe reads it from the
  provider (`claude auth status` → `apiProvider`/`subscriptionType`,
  `codex doctor --json` → `stored auth mode`/`stored API key`), stores it on the
  resource record, and `billingModeFor` uses it. Configuration may only make the
  answer STRICTER, never looser. Absent observation is `UNKNOWN`, and unknown is
  financial. *Declaring is a claim; probing is evidence.*
- **NEW-FIN-2 (CRITICAL) — the effects registry was mutable.**
  `KNOWN_ACTION_EFFECTS` was a plain exported object, so anything in-process
  could assign benign effects to `PROVISION_VPS` and the gate would then permit
  it. It is now deeply frozen, entry by entry. A security-critical lookup table
  that the process can rewrite is not a control.
- **NEW-SEC-1 (HIGH) — executor text reached durable state unsanitized.**
  A `SessionCheckpoint` is authored by an EXECUTOR, and it was persisted
  unbounded and unredacted. Fixed with `sanitizeCheckpoint`. **Remediating it
  surfaced a second instance of the same hole:** `WorkOutcome.detail` — also
  executor text — was written verbatim into `RoadmapItem.detail` on the
  COMPLETED and CHECKPOINT paths, and returned raw in `TickResult` for the CLI
  to print. Sanitization now happens inside `setStatus`, which is the only way
  item text is ever set, and the same sanitized value is what is returned. A
  console is durable state with a different filename.
- **NEW-MODEL-1 (HIGH) — any model string was accepted.** An unrecognised model
  was recorded as `UNVERIFIED` and launched. `UNVERIFIED` is an honest label for
  "the provider did not echo this back"; it is not a licence to launch a model
  nobody recognises. `SUPPORTED_MODELS` is now a frozen per-provider allowlist
  and an unknown model is refused before argv is built (AC-12).

### The bug this round found in itself

`ResourceRecord.observedBillingMode` was added to the domain type and NOT to the
SQLite parser, so a supervisor that had probed its providers forgot what it had
learned the moment it restarted — and every AI action after a restart silently
became financial. This is the identical failure that caused TASK-005 remediation
round 3, one layer over.

It was caught by the restart test, which is good, and catchable ONLY
behaviourally, which is not. So `tests/supervisorStateRoundTrip.test.ts` now
holds a structural guard: each durable type has a
`Record<keyof Required<T>, true>` field list, so adding a field without listing
it is a COMPILE error, and each maximal fixture must survive `encode → parse` or
the test fails. A new durable field can no longer reach production without
proving it round-trips.

### Billing observation, measured

Both interpreters were re-verified against this installation rather than
assumed, and the fixtures in `task006RemediationRound3Repro.test.ts` use the
measured payloads:

| Command | Field | Value | Derived mode |
| --- | --- | --- | --- |
| `claude auth status` (2.1.238) | `apiProvider` / `subscriptionType` | `firstParty` / `max` | `INCLUDED_SUBSCRIPTION` |
| `codex doctor --json` (0.149.0) | `stored auth mode` / `stored API key` | `chatgpt` / `false` | `INCLUDED_SUBSCRIPTION` |

An API-key session on either CLI derives `USAGE_BILLED`, and any other
combination stays `UNKNOWN`. This matters more than it looks: had the
interpreters been wrong in the safe direction, the supervisor would have refused
to use either provider at all, and the failure would have looked like a policy
problem rather than a parsing one.

## Remediation round 4 (independent re-review, 2026-08-23)

Verdict `CHANGES_REQUIRED`: four CRITICAL and five HIGH. Rounds 1–3 kept arriving
at one sentence — *a safety property that depends on data the system itself can
write is not a safety property.* Round 4 is that sentence aimed at four things
nobody had classified as "data" at all: the ORDER of an array, a FIELD on the
caller's own object, a fresh-looking TIMESTAMP, and the absence of a command name.

### F4-1 (CRITICAL) — a mutable array decided which class was stricter
`ACTION_CLASSES` was `as const`, which gives a readonly type and a fully mutable
array, and `mostRestrictive` ranked by `indexOf`. Reordering the export inverted
the meaning of "most restrictive", after which `PROVISION_VPS` with a benign
`declaredClass` came back allowed. The array is frozen, and ranking now reads an
explicit frozen map so that reordering it cannot change a verdict at all.
Compile-time `readonly` is not a runtime control.

### F4-2 (CRITICAL) — launch billing facts were a field the caller sets
For resource-parameterised kinds, `action.effects` WAS the source of truth — so
anyone could hand `{kind:"LAUNCH_AI_WORKER", effects:{costKnownZero:true}}`
straight to the gate. `launchAiWorkerAction` was the intended door; nothing made
it the only one, and an intended door beside an open wall is decoration. This is
N-1 one level further out: N-1 let effects override the registry, F4-2 let them
BE the registry.

Authoritative effects now live in a module-private `WeakMap` keyed on the action
object, written only by the minters. A caller cannot reach the map and cannot
copy an entry — `{...mintedAction, effects: benign}` is a different object and is
therefore unminted, hence financial. `action.effects` may still make a verdict
stricter; it can no longer make one permissive.

### F4-3 (CRITICAL) — a fresh persisted row was accepted instead of a probe
Round 3 moved billing from configuration to observation and stored the
observation on the resource row. The review supplied the missing step: a row with
`lastCheckedAt = now` and `observedBillingMode: INCLUDED_SUBSCRIPTION` was
trusted with **zero probes**, so the authority for "this costs nothing" was once
again a value the system writes.

The freshness window is fine for SCHEDULING and is not evidence for a financial
decision. The chosen resource is now re-probed **in-process, immediately before
the gate**, and `billingModeFor` takes the observation as a PARAMETER rather than
looking it up — a signature that cannot reach the row cannot be tempted by it.
The probe is zero-token and local, which is what makes this affordable.

### F4-4 (CRITICAL) — "verification" was free while naming no command
`RUN_VERIFICATION_COMMAND` was registered as unconditionally free, so
`gcloud compute instances create`, `aws ec2 run-instances` and
`curl -X POST https://billing.example/charge` were all free verification. The verb
says nothing about the cost; the EXECUTABLE does. That kind is now
resource-parameterised and must be minted by `verificationCommandAction`, which
allowlists basenames and rejects shell metacharacters in the executable *and* the
arguments. What the supervisor itself emits for deterministic work is now
`RUN_DETERMINISTIC_WORK`, which honestly means "invoke the trusted local
executor" and claims nothing about any command line.

### F4-5 (HIGH) — the checkpoint sanitizer whitelisted, and missed three
`projectId`, `workItemId` and `planId` are executor-authored and were persisted
raw. Third instance of NEW-SEC-1 in two rounds, and the review predicted it in its
own attack list before finding it. Whitelisting is how you keep missing one, so
`supervisorStateRoundTrip.test.ts` now fails to COMPILE if `SessionCheckpoint`
gains a field that is not accounted for.

### F4-6 (HIGH) — C4 walked one edge of the lineage
A implemented by Codex ← B implemented by Claude ← C reviews B. With Claude
unavailable, Codex reviewed C — work built on Codex's own. N-2 already said C4 is
a property of the LINEAGE; the first fix walked one edge of it. The exclusion set
is now the full dependency ancestry, breadth-first with a visited set.

### F4-7 / F4-8 (HIGH) — a mutable allowlist, and dishonest verification
`SUPPORTED_CODEX_EFFORTS` was mutable (frozen now, and an unknown provider is
refused rather than throwing). `reconcileReportedIdentity` reported
`VERIFIED_EFFECTIVE` once the MODEL matched, so a run requesting `opus/high` whose
provider echoed only `{model:"opus"}` claimed the effort had been confirmed when
nothing about it had been observed. Each requested dimension is now verified
independently; missing evidence is `UNVERIFIED` and an unrequested reported effort
is a `MISMATCH`. "Verified" has to mean verified.

### F4-9 (HIGH) — the run configuration existed for the length of one call
It was built, handed to the executor and discarded, so an item could be DONE with
no durable record of which model produced it. `RoadmapItem.lastRunConfig` now
persists it, `WorkOutcome` carries an optional `reportedIdentity`, and a
**MISMATCH refuses to mark the item DONE** — accepting a worker's COMPLETED after
it reports running something else would be self-certification (C5) with extra
steps.

### Also fixed from the notes
- A read-only command (`status`/`resources`/`roadmap`) no longer CREATES the
  database. It refused to write state already; opening it still made the file.
- `nextWakeAt` is published once, at a single tick exit point, instead of by each
  path that happened to think of it — so completing an item no longer leaves the
  previous waiting tick's schedule behind for a timer to act on.
- `claude auth status` reporting `authMethod: "apiKey"` alongside
  `apiProvider: "firstParty"` now derives `USAGE_BILLED`. An API key is metered
  whatever the neighbouring fields claim, and two fields disagreeing about who
  pays must not resolve optimistically.
- `sf supervise resources` prints the observed billing mode, because `AVAILABLE`
  alone no longer means usable.

### Verifying the regressions are not vacuous
Each round-4 fix was reverted in the BUILT output and the suite re-run:
removing the F4-2 mint check failed 3 tests, the F4-1 rank map 1, and the F4-5
checkpoint fields 1; restoring each returned 47/47. A regression test that passes
with the fix removed is not a regression test.

## Remediation round 5 (independent re-review, 2026-08-23)

Verdict `CHANGES_REQUIRED`: four CRITICAL and seven HIGH. **Two of the four
CRITICALs were defects the round-4 remediation introduced.**

That is now the pattern rather than the exception — round 1's fix for F-2
produced N-1, round 3's fix for NEW-FIN-1 produced a serialization bug, round 4's
fixes produced F5-SEC-1 and F5-FIN-1 — and it is worth stating plainly rather
than burying. The lesson is not "try harder". It is that a fix which MOVES an
invariant to a new place needs the same adversarial attention the old place got,
and the only reliable way to get that is another reviewer. C4 is not overhead
here; it is the only thing that has caught any of these.

### F5-SEC-1 (CRITICAL) — the mint was bound to the object, not to its kind
The `WeakMap` proved an action came from a minter. It did not prove the action
was still the one that had been minted:

```ts
const a = launchAiWorkerAction({ billingMode: "INCLUDED_SUBSCRIPTION", ... });
a.kind = "RUN_VERIFICATION_COMMAND";   // same object, same mint entry
```

carried "this model runs on a subscription" into a verdict about a shell command.
Minted actions and their effects are now frozen, and the mint records the KIND it
was minted for, so a record for one kind cannot answer for another.

### F5-FIN-1 (CRITICAL) — an executable allowlist cannot constrain what it runs
Round 4 allowlisted *executables*. The review took that apart in one line, and
every one of these passed: `npm run charge`, `npx some-chargeable-package`,
`node --import /tmp/paid.mjs`, `sh -c "curl …/charge"`, `git push origin main`.
`sh` on an allowlist is not a command — it is permission to run any command.

The unit of authorization is now the WHOLE command. A caller names an identifier
(`NPM_TEST`); the argv it resolves to is fixed here and the caller cannot choose
it. Residual, stated rather than glossed: `npm test` runs a script defined in this
repository's `package.json`, so whoever can rewrite that script controls what runs
— but that is the repository's pre-existing trust level, not a hole this gate
opens.

### F5-FIN-2 (CRITICAL) — `subscriptionType: "free"` classified as included
The check was `subscription.length > 0`. `"free"`, `"trial"` and `"unknown"` all
passed it — the exact case the mandate names in as many words. There is now an
exact allowlist of paid plan values, of which only `max` is MEASURED on this
installation; that distinction is recorded in the code rather than implied.

### F5-FIN-3 (CRITICAL) — work that declared nothing was asked nothing
`declaredActionKinds` was optional, so a deterministic item could decline to
declare and the gate would only ever see `RUN_DETERMINISTIC_WORK`. It is now
required for deterministic work.

**What this does NOT do**, because the review was right to press and the answer
should not be dressed up: the executor is trusted in-process code, and an
in-process function cannot stop code that can already call `fetch`. Genuine
enforcement means running the executor WITHOUT the capability — a separate
process with restricted credentials — which is architecture for a later roadmap
item, recorded here rather than quietly assumed away. What this closes is the
part the supervisor can close: work that was never asked because it never
declared.

### The HIGH findings
- **F5-ID-1** — an effort-only report was ignored (the reconciler returned early
  when no model was present), and provider was not a dimension at all, so a
  worker could switch providers while echoing a matching model. Every dimension
  is now reconciled independently and provider is one of them.
- **F5-ID-2** — provider-reported strings went into durable state raw, so a
  worker reporting a model named after a credential put that credential in the
  database. Identity strings are redacted and hard-bounded.
- **F5-SEC-2** — the pre-launch probe's reason reached the CLI unbounded. Every
  tick result is now sanitized at the single exit point.
- **F5-C4-1** — a DONE ancestor with no recorded implementer excluded nobody, and
  a rerun overwrote the previous implementer. Unknown lineage now fails closed,
  and implementer history is append-only.
- **F5-RESUME-1** — `SessionCheckpoint.actionId` was documented as preventing
  cross-action resume, and nothing enforced it. It could not, as written: a
  rollover continues under a NEW attempt by definition, so the ids never match.
  The doc claimed a guarantee the code did not provide, which is worse than no
  guarantee. What actually holds is now stated and enforced — the checkpoint must
  belong to this roadmap item, and it is rebound to the running action with
  `resumedFromActionId` keeping the chain auditable.
- **F5-FIN-4** — `GIT_PUSH` and `PROBE_RESOURCE_REMOTE` were registered free on no
  evidence. A push can start paid CI or eat the GitHub allowance the amendment
  says must never be automatically exceeded. Both are financial now; read-only
  `GIT_FETCH` stays free.
- **F5-AUDIT-1** — `lastRunConfig` is persisted data and therefore forgeable by
  anyone who can edit the database. It is not made self-authenticating, because
  that needs a key this process does not have and must not have, and pretending
  otherwise would be theatre. Instead the limit is documented at the type, and
  the property that does hold is enforced elsewhere: a contradicted run never
  reaches DONE in the first place. Nothing in the supervisor reads this field to
  make a decision.

### What the mutation check found this round
Reverting each round-5 fix in the built output: F5-FIN-2 failed 5 tests, F5-FIN-3
1, F5-C4-1 1, F5-RESUME-1 1 — and **two fixes failed nothing**, which was the
useful result.

- `sanitizeTickResult` looked verified but was not: the probe reason was ALSO
  bounded at the construction site, so the chokepoint could be deleted with the
  test still green. Worse, the test never reached the pre-launch path at all —
  its poisoned probe fired during the scheduled refresh, routing failed first,
  and the assertion passed without exercising the leak. Both were fixed: the
  redundant inner bounding was removed so the chokepoint is load-bearing, and
  the test now asserts it reached `WAITING_FOR_RESOURCE` before checking for the
  credential.
- The F5-SEC-1 kind binding is genuinely redundant while the freeze holds — the
  only way to present a different kind is to copy the action, and a copy has no
  mint at all. It is kept as defence against a future refactor that drops the
  freeze, and the test is documented as proving the OUTCOME rather than which
  mechanism produced it.

A green regression that cannot fail is worth less than no regression, because it
also stops anyone looking.

## Remediation round 6 (independent re-review, 2026-08-23)

Verdict `CHANGES_REQUIRED`: two CRITICAL and five HIGH. The first round where the
findings are mostly NOT self-inflicted — the review ran its own delete-the-fix
experiments across sixteen earlier fixes and confirmed nine of the eleven
round-5 ones closed. What it found were places the earlier rounds had narrowed
but not finished.

### F6-FIN-1 (CRITICAL) — the mint said HOW, never WHAT
The mint recorded how an action is billed and not what it is billed FOR, so an
"included subscription" verdict issued for one resource said nothing about which
resource actually got launched:

```ts
launchAiWorkerAction({ resourceKey: "metered:model",
                       billingMode: "INCLUDED_SUBSCRIPTION" })  // passed
```

The canonical resource now travels inside the mint record where a caller cannot
rewrite it, `mintedResourceKey` exposes it, and the supervisor refuses to launch
anything the verdict was not issued for. An approval for one thing is not an
approval for another thing.

### F6-POL-1 (HIGH) — and a position reversed
Earlier rounds let purely LOCAL work continue under an unreadable policy, on the
reasoning that refusing to run the test suite because a policy row is corrupt is
brittleness rather than safety, and that it blocks the very diagnosis that would
fix it.

That reasoning is not worthless. It is, however, an argument for a different rule
than the one that was given, and the mandate states its rule without an
exception: *"Missing/corrupt/unreadable policy: DENY. Do not default to allow."*
Two consecutive independent reviews read the earlier behaviour as not satisfying
it, which answers the question of whether the exception was as self-evident as it
felt from the inside. It is gone. Diagnosis is unaffected in practice — a human
runs `npm test` directly, and the read-only CLI commands never reach the gate.
What stops is AUTONOMOUS execution, which is what the rule is about.

### F6-ID-1 (HIGH) — silence is not confirmation
An AI worker could omit `reportedIdentity` entirely and still reach DONE carrying
an honest-looking `UNVERIFIED`. That is NEW-MODEL-1's mistake in a new place: an
honest label for missing evidence is not a licence to proceed as though the
evidence existed. A COMPLETED with no stated identity is now refused.

Not closed by this, and not claimed to be: the report is an executor CLAIM. Proof
needs evidence bound to the launched process, which needs the executor to be a
process the supervisor owns.

### F6-C4-1 / F6-C4-2 (HIGH) — lineage, finished properly
"Append-only" history evicted the OLDEST entry at 32 — precisely the wrong end,
since an evicted implementer silently stops being excluded. Append-only with
eviction is not append-only; the cap is gone, and the real bound is
`MAX_REMEDIATION_ATTEMPTS`. And unknown lineage failed closed only for DONE
ancestors, so a BLOCKED or reopened one raised no objection: the question is
whether WORK HAPPENED, not what status the item currently carries.

### F6-RESUME-1 (HIGH) — the fifth-round fix leaked
`resumedFromActionId`, added by round 5, was executor-supplied, unsanitized and
forgeable: a fresh instance of the leak class it shipped beside, plus a way to
falsify audit provenance. It is now dropped from anything the executor returns
and re-derived from the checkpoint this supervisor was actually resuming. A
forgeable audit trail is worse than none, because it gets believed.

### F6-FIN-2 (CRITICAL) — NOT closed, and tracked instead
The in-process `WorkExecutor` can act outside its declaration. This cannot be
closed from inside the process: an in-process function cannot restrain code that
can already call `fetch`, which is the same boundary TASK-003's `Worker` has.
The review's own words are that the code "explicitly defers this enforcement to
later architecture", and that is the right characterisation.

Rather than argue it away or pretend a declaration is a sandbox, it is now a
roadmap item — **`EXECUTOR_ISOLATION`** — and `EXECUTOR_WIRING` depends on it, so
nothing gets wired to execute autonomous work before the thing executing it can
be constrained. A regression test asserts that dependency, so the ordering cannot
be quietly dropped later.

### Mutation results
Every round-6 fix was reverted in the built output: F6-FIN-1 failed 8 tests,
F6-POL-1 7, F6-C4-2 3, F6-RESUME-1 2, F6-ID-1 1, F6-C4-1 1. All six are
load-bearing.

One test in this round also had to be fixed rather than the code: an F6-C4-2 case
ordered the ancestor first, so the tick selected the ANCESTOR and returned
`ADVANCED` for it — the assertion passed while proving nothing about the review.
Same failure mode as the round-5 `sanitizeTickResult` test. Ordering the review
first made it real.

## Remediation round 7 (independent re-review, 2026-08-23)

Verdict `CHANGES_REQUIRED`: **no CRITICAL**, five HIGH. The first round in which
the reviewer also endorsed a deferral rather than re-reporting it — see below.

### R7-ID-1 (HIGH) — presence of a container is not a statement
The F6-ID-1 check asked whether a report object EXISTED, so
`reportedIdentity: {}` satisfied it, as did an object inheriting the right values
from a polluted prototype — which could even reach `VERIFIED_EFFECTIVE`. Provider
and model must now be own, non-empty strings, and `reconcileReportedIdentity`
reads own properties only. This is "an absent field is not agreement" arriving
from the opposite direction.

### R7-C4-1 (HIGH) — a fabricated implementer is not lineage
`implementedByResourceKeys: ["not-a-resource"]` satisfied "do we know who built
this?" while excluding nobody, so the real implementer was free to review its own
work. History entries are now checked against the resources this installation
actually has; an UNRECOGNISED implementer is more suspicious than a missing one,
not less.

### R7-DAG-1 (HIGH) — the rule this codebase keeps relearning, again
A row persisted as `ELIGIBLE` was selected while its prerequisite was still
`PENDING`, and dependent work completed before the work it depends on. The status
is written by `recomputeEligibility` and is therefore a CACHE of a dependency
computation — which makes it the same thing as every previous finding:

> A PERSISTED STATUS IS A CHECKPOINT, NEVER AUTHORITY.

`selectNextItem` now re-derives dependency satisfaction at the moment of
selection. The stored status still decides which items are candidates; it no
longer settles the question alone.

### R7-SEC-1 (HIGH) — the tests used a stricter substitute than production
The in-memory repository returned frozen state and the SQLite one did not, so the
hole existed only in production. An executor mutating `input.item.key` from A to
B marked B DONE while A stayed ACTIVE; writing a token into
`declaredActionKinds[0]` persisted it unredacted. Exactly the shape of TASK-005
remediation round 3, and the answer is the same: make production strict. The
executor input is now deep-frozen AND settlement uses identities captured before
the call, so either fix alone would close it.

### R7-C3-1 (HIGH) — a regression that could not fail
The F6-FIN-1 test exercised only the matching path, so the supervisor's
resource-binding guard could be deleted with all 1292 tests green. Worse, the
mutation run that "verified" it had broken `mintedResourceKey` — which TRIPS the
guard rather than removing it. **Mutating the wrong line proves the wrong thing**,
and only an independent reviewer caught it.

The honest repair, rather than a test that pretends: the guard cannot be driven
to a mismatch through `tick()`, because the minted and launched resources are
both computed from the same `config.option`. So it is an INVARIANT ASSERTION
against future drift — the drift that produced F6-FIN-1 — not a reachable branch.
It is now an exported function, tested directly where its behaviour is
observable, with its reachability stated in the code rather than implied by a
green test.

### The EXECUTOR_ISOLATION deferral, endorsed
The reviewer was asked to judge the deferral rather than re-report it, and
agreed: *"Deferring F6-FIN-2 to EXECUTOR_ISOLATION is the right architectural
decision for TASK-006."* It named what it would require before real autonomous
execution is wired — a separate restricted process, a fixed operation protocol,
no ambient network or billing credentials, and independent regression tests —
which is now the content of that roadmap item.

### Also fixed from the notes
- `resourceKey` refuses a component containing the `:` delimiter. Unreachable
  through the supported catalog, but this key decides reviewer independence and
  the financial resource binding, and "these are the same resource" being wrong
  is how findings arrive three rounds later.
- The parser refuses an implementer history beyond 256 entries. Removing the
  write-side eviction (F6-C4-1, correctly) left the read side unbounded, and a
  100,000-entry history parsed happily at 1.29 MB. A history that long is a
  corrupt row, and corrupt rows fail closed here rather than being truncated into
  an incomplete lineage.

### Mutation results
Every round-7 fix was reverted in the built output and the FULL suite re-run:
R7-ID-1 failed 4, R7-C4-1 3, R7-DAG-1 3, R7-SEC-1 (both halves) 2, the bounded
lineage parse 1, the delimiter rejection 1. This round the mutations removed each
GUARD ITSELF rather than something a guard depends on — the mistake that made the
round-6 F6-FIN-1 result meaningless.

## Remediation round 8 (independent re-review, 2026-08-23)

Verdict `CHANGES_REQUIRED`: one CRITICAL, three HIGH. Two of the four were
defects the ROUND-7 remediation introduced, and the review also found a false
claim in round 7's own write-up.

### R8-FIN-1 (CRITICAL) — the plan is not the payer
`{loggedIn: true, apiProvider: "firstParty", subscriptionType: "max"}` with no
`authMethod` at all classified as an included subscription, and an end-to-end
tick launched a worker on it. Round 5 allowlisted the subscription VALUE and
round 4 read `authMethod` only to catch API keys — so three fields agreeing about
the PLAN were taken as evidence about who pays for the CALLS. A recognised
`authMethod` is now required; absent or unrecognised is UNKNOWN, hence financial.
Verified against the live probe afterwards: the real session still classifies as
INCLUDED_SUBSCRIPTION, so the fix is conservative rather than merely strict.

### R8-ID-1 (HIGH) — checking harder does not close a TOCTOU gap
Introduced by R7-ID-1. Validating the reported identity and reconciling it are
two reads, and an object whose fields are GETTERS can answer differently each
time: the review built one returning valid strings to the check and `undefined`
to reconciliation, and the run reached DONE. The report is now snapshotted ONCE
into a plain frozen object containing only own data properties, and every later
step reads that. An accessor is not copied at all — it is not an error to report,
it is a statement that was never made.

### R8-C4-1 (HIGH) — the anti-forgery check consulted forgeable data
Introduced by R7-C4-1. The set of "recognised implementers" was built from the
catalog AND from `state.resources` — which is persisted. So a forged resource row
plus a matching forged implementer entry satisfied the check that exists to catch
forged lineage. That is this task's own thesis turned on the fix for it. The set
now comes only from the wiring's catalog, which is code.

### R8-SEC-1 (HIGH) — sanitizing a superset by naming a subset
`sanitizeCheckpoint` started from `...checkpoint`, so it cleaned the fields it
knew about and copied everything else through. A `secret: "sk-ant-..."` property
that `SessionCheckpoint` does not declare — and the parser silently ignores —
reached the raw SQLite JSON. Fourth variant of this hole in five rounds. The
result is now CONSTRUCTED field by field from the declared type: an undeclared
property has nowhere to land, and a new declared field is a compile error here
rather than a silent passthrough.

### The claim that was wrong
Round 7's comment said R7-SEC-1 was "two independent fixes". It was not:
`settleItem` was the same object handed to the executor, so removing the
settlement capture changed nothing and 1314 tests still passed. **The reviewer
caught the claim, not the code.**

The obvious repair — separate the clones and re-assert independence — would have
been the same error again, because while the freeze holds there is nothing for
the separation to protect against. Measured: removing the separation alone fails
nothing; removing both layers together fails two tests. So the comment now says
what is true: the freeze is load-bearing, the separate clone is defence in depth
that only becomes observable if the freeze is weakened. Defence in depth is a
real reason to keep code and a bad excuse for claiming two controls were verified
when one was.

### Mutation results, and a repeat of a known mistake
R8-ID-1 failed 3 tests when reverted, R8-C4-1 1, R8-SEC-1 1, R8-FIN-1 5.

The R8-FIN-1 figure took two attempts. The first mutation targeted the string
`typeof authMethod === "string" &&` — which matches the API-KEY check earlier in
the same function, not the auth-method requirement — and reported 0 failures.
That is precisely the round-7 lesson (*mutating the wrong line proves the wrong
thing*) repeated one round later, by the same hand, on the same day. Retargeting
the mutation at the unique `INCLUDED_CLAUDE_AUTH_METHODS` clause gave 5 failures.
Recorded because a lesson that has to be relearned is worth writing down where
the next person will trip over it.

## Remediation round 9 (independent re-review, 2026-08-23)

Verdict `CHANGES_REQUIRED`: no CRITICAL, three HIGH — and, for the first time,
**a clean financial assessment**:

> *"I found no path through the supervisor gate that classified a chargeable
> action as free or executed it autonomously."*

The reviewer listed what it had tried and failed to get through: missing,
unknown, array, object and confusable authentication methods; saved-card,
authenticated-session, active-subscription and stored-credential claims;
malformed, positive and missing policies; unknown action kinds; usage-billed and
unknown resources; free-tier and persisted "included" claims; forged persisted
billing observations; exhaustion paths; and model output, plan approval, task
acceptance or HUMAN actor claims. That is the property this task exists to hold,
and it is the first round in which an adversarial reviewer could not break it.

### R9-SEC-1 (HIGH) — the supervisor sanitizes what it writes; the CLI printed what it reads
Token-shaped text placed directly into a roadmap title, a resource diagnostic, an
escalation, or the financial policy came straight back out of `status`,
`resources` and `roadmap` — including through the policy PARSE ERROR, which
quotes the offending value back by design. Every previous sanitization fix
guarded a WRITE; a database is also an INPUT, and one that can be edited,
restored from a backup, or written by an older build with weaker rules. Every
persisted string now leaves through one chokepoint in `supervise.ts`, and the
regressions build a hostile database directly rather than through the supervisor
— because going through the supervisor cannot reach this.

### R9-C4-1 (HIGH) — recognition is not authentication
A forged history naming a REAL catalog resource is recognised, so R8-C4-1's
catalog check raises the bar without establishing lineage. The review had Codex
implement an item, rewrote the history to say Claude, and Codex reviewed its own
work.

Mitigated by cross-checking against `lastRunConfig`, which a different code path
writes at a different time, so a forger must keep both consistent. **Not closed,
and not claimed to be.** Implementer lineage is a recorded historical fact, and
there is no key on this machine to authenticate it with — unlike spending
authority, which F-1 made impossible to express in data at all. The residue is
now stated where it belongs: **the supervisor database is part of the trusted
computing base**, and `STATE_INTEGRITY` is a roadmap item that blocks
`EXECUTOR_WIRING` alongside `EXECUTOR_ISOLATION`.

A regression deliberately PINS the remaining gap — asserting that an
unverifiable forged history still passes — so that when `STATE_INTEGRITY` lands
the test fails and forces the claim to be revisited. A known gap with a failing
tripwire beats a known gap with nothing watching it.

### R9-C3-1 (HIGH) — two regressions passing for the wrong reason
Both mine, both from round 8:

- The R8-SEC test asserted against `repository.load()` — which runs the PARSER,
  and the parser silently drops undeclared fields. So the secret under test was
  hidden by the very step that made the assertion pass, and the sanitizer could
  be deleted with the test green. The subject is what reaches DISK, so the test
  now reads the database file as bytes. It also asserts a declared field IS
  present, so the scan cannot pass by finding nothing at all.
- The R8-ID getter test used getters that returned valid values once and then
  `undefined`. With the snapshot removed it passed anyway, because read-ordering
  happened to exhaust the counter before the acceptance check ran. Always-valid
  accessors remove the accident: deleting the guard now necessarily changes the
  result.

Both repairs were verified by re-running the mutation: each repaired test now
fails when its guard is removed.

### Mutation results
R9-SEC-1 failed 4 tests when reverted, R9-C4-1 1, and the two repaired round-8
tests 1 each. The R9-SEC-1 figure again took two attempts — the first pattern did
not match the built output at all and reported "substitution did not apply",
which is at least a loud failure rather than a quiet false pass.

## Remediation round 10 (independent re-review, 2026-08-23) — FINAL

Verdict `CHANGES_REQUIRED`: one CRITICAL and three HIGH, all narrow. More
importantly, round 10 **adjudicated both deferred architectural boundaries**,
which is why this is the last remediation round rather than another lap.

### The adjudication
> *"Deferring authenticated lineage provenance is legitimate for this
> scheduler-only merge, on the same architectural basis as
> `EXECUTOR_ISOLATION`."*

Accepted on three conditions, all of which hold: the shipped executor returns
`HUMAN_REQUIRED` and performs no autonomous work; `EXECUTOR_WIRING` depends on
both `EXECUTOR_ISOLATION` and `STATE_INTEGRITY`; and the limitation is documented
and pinned by a regression. The reviewer also confirmed the reasoning
independently — hashing, duplicate records and file permissions do not solve it
without a trust anchor.

### R10-FIN-1 (CRITICAL) — the last way to assert that something is free
The PUBLIC minter still took `billingMode` as a bare string:

```ts
launchAiWorkerAction({ resourceKey: "metered:model",
                       billingMode: "INCLUDED_SUBSCRIPTION" })  // allowed
```

The supervisor's own path re-probes and could not produce that — but a public API
that lets any caller declare a resource free is a defect regardless of who
currently calls it, and every finding in this file is a variation on trusting a
value someone else supplied.

A billing mode can no longer be passed as a string at all. It must arrive inside
a `BillingObservation` minted by `observeBilling` and BOUND to the provider and
model it describes; an unregistered look-alike, or a genuine observation of a
different resource, is treated as no observation, which is UNKNOWN, which is
financial. The honest limit is the same as everywhere else: this makes asserting
"that resource is free" a deliberate, greppable act rather than an incidental
argument. It does not make it impossible in-process — that is
`EXECUTOR_ISOLATION`'s territory.

### R10-SEC-1 / R10-SEC-2 — the last two output paths
`describeTick` printed persisted `roadmapKey` and `actionId` raw: identifiers
felt like structure rather than content, which is the assumption behind every
earlier instance of this bug. And the top-level CLI `catch` printed
`Error.message` raw, while parse errors quote the offending persisted value back
BY DESIGN — that is what makes them useful and what makes them dangerous.

### R10-C3-1 — a test that was wrong three times
The R8-ID getter regression passed for the wrong reason AGAIN: the getters
reported `opus` while routing had selected `sonnet`, so removing the snapshot
produced a model MISMATCH and the refusal came from a different guard. It now
echoes exactly what the run was configured with, so the only thing wrong with the
report is that its fields are accessors.

### Mutation results, and two more lessons about mutation testing
R10-FIN-1's registry check failed 1 test when reverted, its resource binding 1,
R10-SEC-1 1, R10-SEC-2 1, and the thrice-repaired R8-ID test 4.

Getting those numbers took a second, stricter harness, and the reason is worth
recording:

- The first harness verified a mutation had applied by checking the REPLACEMENT
  was present. With a replacement of `true`, `grep -qF true` matches almost any
  JavaScript file, so two mutations reported "applied — 0 failures" when they had
  not applied at all. The harness now checks the ORIGINAL text is GONE.
- R10-SEC-2 genuinely failed nothing on the first honest attempt, because there
  was no test for `main.ts`'s final `catch` — it is only reachable by an uncaught
  throw escaping a command, so covering it needs a subprocess running the real
  binary. Then it STILL passed, because the corrupt row put the credential in a
  valid neighbouring field and the parse error quoted a different one. The
  credential now IS the rejected value.

Both are the same lesson as rounds 6 and 8 in new clothing: **a mutation that
does not do what you think proves nothing, and a green result from one is worse
than no result, because it stops you looking.**

### Also corrected
`SUPPORTED_MODELS` claimed every entry had been run against its CLI in this
repository. True of `opus` and `gpt-5.6-luna`; not independently evidenced for
`sonnet` or `haiku`. Retracted rather than defended.

