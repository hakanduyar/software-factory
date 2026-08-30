# TASK-015 — MULTI_RESOURCE_AUTHORIZATION

**Why this exists, and why it is a task rather than a patch.**

TASK-014's round-3 independent review found (finding 2, HIGH) that the shipped
supervisor cannot drive a C4-compliant plan. The gate `checkPlanAuthorization`
is correct — it refuses to launch a plan that would run anything the financial
gate did not authorise — but the supervisor authorises exactly ONE
provider/model/effort per action, while a plan declares three: planner,
implementer and reviewer. A plan whose reviewer differs from its implementer is
therefore always refused, and that is the shape C4 REQUIRES for critical work.

So the capability gap is real and blocking. The fix, however, is not in
TASK-014: it changes how `SupervisorService` routes and gates, which is
TASK-006's accepted design. Making that change silently, inside another task's
remediation, would be exactly the self-certification C2 and C5 forbid — the
change would be reviewed as a side effect rather than against criteria.

This file is those criteria, frozen before implementation. It adds no roadmap
entry: it is the remaining work of `EXECUTOR_WIRING`, not a new product goal.

## The invariant that must not move

From TASK-014 round 2, and it is the reason any of this exists:

> THE RESOURCE AUTHORISED BY THE SUPERVISOR MUST BE THE RESOURCE THAT CAN
> ACTUALLY EXECUTE. There must be no state where the gate authorises X, the plan
> runs Y, and provenance records X.

Widening authorisation from one resource to a set MUST NOT weaken this. A set is
still an exact set: every resource that can run must be in it, and every member
must have been gated individually.

## Acceptance criteria (FROZEN — may not be edited to fit the implementation)

**AC-1.** The supervisor can authorise MORE THAN ONE AI resource for a single
action, and each one goes through the SAME path the single resource goes through
today: probed in-process immediately before the gate, its observed billing mode
bound to it, minted into an action, and evaluated by `evaluateFinancialSafety`.
No second, shorter gate is introduced. Proven by mutation: removing the gate for
any one resource fails a test that names that resource.

**AC-2.** The set is DECLARED BY THE WORK, not guessed. The executor states which
resources the work will launch, before it launches anything, and the supervisor
authorises exactly that set. An executor that declares nothing gets today's
behaviour unchanged.

**AC-3.** A resource that fails its probe, its billing observation or the
financial gate STOPS THE WHOLE ACTION. There is no partial authorisation, and no
"launch the ones that passed" path. The failure names which resource failed and
why.

**AC-4.** `AUTONOMOUS_SPEND_LIMIT = 0` is unaffected. A set containing a resource
whose observed billing mode is anything other than `INCLUDED_SUBSCRIPTION`
requires a human, exactly as a single such resource does today. Proven by a test
that puts one billable resource in an otherwise free set.

**AC-5.** Provenance records EVERY authorised resource, not just the first. A
reader of the audit record can tell which resources an action was permitted to
use. The existing single-resource fields keep their current meaning for
single-resource actions.

**AC-6.** `checkPlanAuthorization` compares the plan's declared resources against
the authorised SET rather than a single record, and still refuses any resource
not in it. A C4-shaped plan whose implementer and reviewer are both authorised
runs; one with an unauthorised third resource does not.

**AC-7.** Every existing financial, provenance, routing and isolation guard
remains load-bearing and unchanged in strength. Proven by mutation over the
guards TASK-006 and TASK-011 already pin, not by inspection.

**AC-8.** No test launches a real AI CLI, spends anything, or requires network
access.

**AC-9.** The reported-identity reconciliation (F5-ID-1) still refuses a worker
that reports running something other than what was authorised — now meaning
"anything outside the authorised set" rather than "not the single record".

## Out of scope

- Routing POLICY changes: which resources a work class prefers is unchanged.
- Per-resource budgets or quotas. A set is authorised or it is not.
- Anything about local/zero-cost providers; they enter through the existing
  catalog when they are qualified.

## Verification plan

- Mutation over each new branch, confirming each LANDED and COMPILED first.
- A C4-shaped plan driven end to end through the real seam with a scripted
  dispatcher, asserting it now runs where it previously could not.
- A negative control: the same plan with one resource removed from the
  authorised set must still refuse, so the widening did not become a bypass.
