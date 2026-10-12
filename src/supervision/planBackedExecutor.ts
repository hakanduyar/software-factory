/**
 * TASK-014 — the connection from the supervisor's queue to TASK-005 planning.
 *
 * The supervisor schedules, gates, checkpoints, escalates and records
 * provenance, and until now had nothing to hand work to:
 * `createUnimplementedExecutor` answered every item with
 * `HUMAN_REQUIRED / AUTHOR_PLAN`. Everything downstream already existed and is
 * accepted — `PlanningService` drives approved work into the TASK-004 loop
 * through the narrow `LoopDispatcher` port.
 *
 * THIS FILE IS DELIBERATELY THIN, and that is the design rather than an
 * omission. It answers one question — "what is the state of the plan serving
 * this roadmap item?" — and translates the answer into a `WorkOutcome`. It does
 * not implement, verify, review, remediate, reconcile worker actions or
 * interpret a reviewer verdict. `loopDispatcher.ts` exists so that boundary is
 * structural, and a second engineering loop is exactly what every previous task
 * here refused to build.
 *
 * WHAT IT WILL NOT DO, each written down because each is a way this task could
 * have been "finished" by violating it:
 *
 *   - It never approves a plan. `PLAN_APPROVAL` is a protected gate under C1 and
 *     `PlanningService.approve` requires a `TrustedHumanToken`. An item whose
 *     plan is not approved comes back as `HUMAN_REQUIRED`, which is the honest
 *     answer and also the one that keeps the queue from flowing on work no human
 *     has agreed to.
 *   - It never routes an AI launch through the isolated child executor. That
 *     child is denied credentials on purpose (L-3); a launch through it would
 *     either fail or require restoring the capability TASK-011 removed.
 *   - It never turns a terminal failure into success. A plan that is BLOCKED,
 *     REJECTED, CANCELLED or in RECOVERY_REQUIRED is reported as needing a
 *     human, naming the phase.
 *   - It never launches a plan whose configuration disagrees with what the
 *     supervisor authorised. `checkPlanAuthorization` runs immediately before
 *     the launch and refuses; it does not substitute a provider or rewrite
 *     either side into agreement.
 *
 * IT DOES NOT PERFORM THE WORK ITSELF, and that is a process boundary rather
 * than a convention. `PlanAdvancer` is one method wide, and the shipped wiring
 * satisfies it with `createChildPlanAdvancer`, which runs `sf plan resume` in a
 * SEPARATE OS PROCESS (TASK-011 AC-1). Round-2 review found the first version
 * calling `PlanningService.resume()` in this process, which put the whole
 * engineering loop and every AI worker inside the supervisor — the exact
 * arrangement TASK-011 exists to remove.
 */

import { checkPlanAuthorization, declaredPlanResources } from "./planAuthorization.js";
import { checkPlanBinding } from "./planBinding.js";
import type { Clock } from "../ports/clock.js";
import type { Plan, PlanPhase } from "../planning/planTypes.js";
import { planTicketExecutability } from "../planning/planValidation.js";
import type {
  NoLaunchEvidence,
  RequiredResource,
  WorkExecutionInput,
  WorkExecutor,
  WorkOutcome,
} from "./supervisorPorts.js";
import type { RoadmapItem } from "./supervisorTypes.js";

/**
 * The plan serving a roadmap item, if a human has created one.
 *
 * A PORT rather than a repository call, because the binding between a roadmap
 * key and a plan is a convention this task should not be free to invent in
 * three places. Production supplies one implementation; tests script it without
 * a database.
 */
export interface RoadmapPlanLookup {
  findPlanForItem(item: RoadmapItem): Promise<Plan | undefined>;
}

/**
 * The single planning operation this executor is allowed to perform.
 *
 * Typed as this narrow shape rather than as `PlanningService` so that there is
 * no reachable API through which the executor could approve, reject, cancel or
 * answer on a human's behalf — the same reason `LoopDispatcher` is four methods
 * instead of the whole loop service.
 */
/**
 * Everything a durable worker-run envelope needs to be opened for this launch
 * (DEFECT-DURABLE-WORKER-RUN-ENVELOPE), carried ALONGSIDE the existing
 * `resume(planId, expectApprovedDigest?)` call as a third, OPTIONAL argument
 * rather than folded into a replacement request type.
 *
 * DELIBERATELY ADDITIVE. `PlanAdvancer` is implemented by real `PlanningService`
 * instances and by more than a dozen scripted fakes across this repository's
 * test suite, every one of them written against a TWO-argument
 * `resume(planId, expectApprovedDigest?)`. Widening the signature to a single
 * request object would be a breaking change to every one of them for a
 * capability only `createChildPlanAdvancer` needs — exactly the kind of
 * broadening this defect's own scope note asks to stop and report rather than
 * do. A third OPTIONAL parameter is structurally backward compatible: every
 * existing implementation (fewer parameters than the interface declares)
 * still satisfies it unchanged, and only `createChildPlanAdvancer` reads it.
 *
 * `actionId`/`roadmapKey`/`attempt` are the SAME canonical coordinates the
 * supervisor already committed a claim under — this executor never invents a
 * second identity for the same launch. `provider`/`model`/`effort` are what
 * this action was CONFIGURED to run, taken from `input.config` when the
 * supervisor's model-enforcement layer produced one, so the envelope records
 * a fact this layer already has rather than asking the plan what it thinks it
 * is running.
 */
export interface WorkerRunLaunchContext {
  readonly actionId: string;
  readonly roadmapKey: string;
  readonly attempt: number;
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
}

export interface PlanAdvancer {
  /**
   * `expectApprovedDigest` closes the last of the time-of-check window
   * (TASK-015 round-1 finding 3, CRITICAL).
   *
   * Re-reading the plan immediately before launching NARROWED the window and did
   * not close it: the child is handed a plan ID and reads the row itself, so a
   * revision approved in between replaces the very configuration that was just
   * checked. Nothing in a plan id carries which content was authorised.
   *
   * So the check travels WITH the request. The digest is the one a human
   * approval is bound to, and the child refuses to act on a plan whose approval
   * digest is no longer the one the supervisor authorised.
   *
   * `runContext`: see `WorkerRunLaunchContext` above. Absent for any caller
   * that does not need a durable worker-run envelope for this launch.
   */
  resume(planId: string, expectApprovedDigest?: string, runContext?: WorkerRunLaunchContext): Promise<Plan>;
}

/**
 * The plan's phase, RE-DERIVED FROM AUTHORITY rather than read from a row.
 *
 * Round-3 finding 1: a persisted phase is a claim, not a fact. A row saying
 * `COMPLETED` with a fabricated `approvalId` is indistinguishable, to a reader
 * of the plans database alone, from work a human really approved and the loop
 * really finished. `PlanningService.status()` knows the difference because it
 * can re-derive the approval from the Factory's own records; this port is how
 * the supervisor asks it that question without holding it in-process.
 */
export interface PlanStateReader {
  /** Throws if the answer cannot be obtained. Never guesses. */
  verifiedPhase(planId: string): Promise<PlanPhase>;
}

export interface PlanBackedExecutorDeps {
  readonly plans: RoadmapPlanLookup;
  /**
   * OPTIONAL, and the absence is a real deployment rather than a gap.
   *
   * Driving a plan launches AI workers and therefore spends, so the shipped CLI
   * wires this only when an operator asks for it with `--drive-plans`. Without
   * it a supervisor still FINDS the plan and reports its true state — blocked,
   * awaiting approval, running — and says a human must enable driving before it
   * will launch anything.
   *
   * This is why the CLI can stop wiring `createUnimplementedExecutor` (AC-1)
   * without pretending to capabilities it lacks: the SAME executor runs in both
   * deployments, and the honest answer for a read-only supervisor comes out of
   * the real path rather than a stub that hard-codes it.
   */
  readonly planning?: PlanAdvancer;
  /**
   * REQUIRED IN PRODUCTION, optional only so a test can drive the phases that
   * assert nothing. Its absence does not weaken anything: without it, a plan in
   * any authority-asserting phase is reported as unverifiable rather than
   * believed.
   */
  readonly state?: PlanStateReader;
  readonly clock: Clock;
  readonly log?: (line: string) => void;
}

/**
 * Phases that are a CLAIM ABOUT A HUMAN APPROVAL, mirroring
 * `PHASES_ASSERTING_APPROVAL` in `planningService.ts`.
 *
 * Round-3 review found `COMPLETED` being believed from a fabricated row. The
 * defect is the class, not that one branch: every phase here asserts that a
 * human approved this exact content, and a plans database is not evidence of
 * that. `WAITING_FOR_HUMAN` claims approved work FINISHED; `APPROVED` and its
 * successors claim there is authority to run. None may be taken from the row.
 */
const ASSERTS_APPROVAL: readonly PlanPhase[] = [
  "APPROVED",
  "MATERIALIZING",
  "EXECUTING",
  "WAITING_FOR_HUMAN",
  "COMPLETED",
];

/** Phases in which a human, and only a human, can move the plan forward. */
const AWAITING_HUMAN: readonly PlanPhase[] = [
  "DRAFT",
  "PLANNING",
  "NEEDS_CLARIFICATION",
  "PLAN_REVIEW",
  "WAITING_FOR_HUMAN",
];

/** Phases that ended badly. None of them may be reported as progress. */
const TERMINAL_UNSUCCESSFUL: readonly PlanPhase[] = [
  "REJECTED",
  "BLOCKED",
  "CANCELLED",
  "RECOVERY_REQUIRED",
];

/** Phases in which the plan carries a human approval and may be driven. */
const DRIVABLE: readonly PlanPhase[] = ["APPROVED", "MATERIALIZING", "EXECUTING"];

/**
 * Recovers the attempt number a canonical action id was minted with
 * (`canonicalActionId` in supervisorTypes.ts: `${roadmapKey}:${kind}:a${attempt}`).
 *
 * DERIVED where possible, never invented: `WorkExecutionInput` carries no
 * separate attempt field, and the number is already encoded — by the ONE
 * place action ids are ever minted in production — in the id this executor
 * already has. `1` is the fallback for an action id that does not carry the
 * suffix, which is informational-only (this feeds the worker-run envelope's
 * audit `attempt` field, never any authorization or lifecycle decision) —
 * never a throw, because a launch this gate already authorised must not be
 * blocked by a display field it cannot fully recover.
 */
function attemptFromActionId(actionId: string): number {
  const match = /:a(\d+)$/.exec(actionId);
  return match === null ? 1 : Number(match[1]);
}

/** What this launch was CONFIGURED to run, for the worker-run envelope (DEFECT-DURABLE-WORKER-RUN-ENVELOPE). */
function runResourceOf(input: WorkExecutionInput): { readonly provider: string; readonly model: string; readonly effort?: string } {
  if (input.config !== undefined) {
    return {
      provider: input.config.effectiveProvider,
      model: input.config.effectiveModel,
      ...(input.config.effectiveEffort === undefined ? {} : { effort: input.config.effectiveEffort }),
    };
  }
  const fallback = input.authorizedResources?.[0];
  if (fallback !== undefined) {
    return {
      provider: fallback.provider,
      model: fallback.model,
      ...(fallback.effort === undefined ? {} : { effort: fallback.effort }),
    };
  }
  // Unreachable in production (a plan-driven launch always carries a
  // configuration or an authorized resource), kept honest rather than thrown:
  // the envelope still needs SOME provider/model to record.
  return { provider: "unknown", model: "unknown" };
}

function authorPlan(item: RoadmapItem, detail: string): Extract<WorkOutcome, { kind: "HUMAN_REQUIRED" }> {
  return {
    kind: "HUMAN_REQUIRED",
    action: {
      kind: "AUTHOR_PLAN",
      description: `roadmap item ${item.key} ("${item.title}") needs an approved plan before it can be executed`,
    },
    detail,
  };
}

function humanRequired(item: RoadmapItem, kind: string, detail: string): WorkOutcome {
  return {
    kind: "HUMAN_REQUIRED",
    action: {
      kind,
      description: `roadmap item ${item.key} ("${item.title}"): ${detail}`,
    },
    detail,
  };
}

/**
 * Translate a plan's phase into a fact about the work.
 *
 * Every branch is a FACT the supervisor then decides about — never an
 * instruction. That rule is why `WorkOutcome` has no "retry" or "skip" variant
 * and why this function has no access to the supervisor's state.
 */
function outcomeForPhase(
  item: RoadmapItem,
  plan: Plan,
  input: WorkExecutionInput,
  clock: Clock,
): WorkOutcome {
  if (plan.phase === "COMPLETED") {
    return {
      kind: "COMPLETED",
      detail: `plan ${plan.id} for roadmap item ${item.key} reached COMPLETED`,
    };
  }
  if (TERMINAL_UNSUCCESSFUL.includes(plan.phase)) {
    /**
     * THE LOOP'S REASON, not just the phase (round-1 finding 2).
     *
     * `PlanningService` records WHY a plan blocked -- "verifier failed for
     * command test", the loop phase that ended it, the work item -- in
     * `failureReason`. Reporting only `BLOCKED` throws that away at exactly the
     * moment a human is being asked to decide something, and the supervisor's
     * escalation record is the last place that detail could still be useful.
     */
    return humanRequired(
      item,
      "REVIEW_PLAN",
      plan.failureReason === undefined
        ? `plan ${plan.id} is ${plan.phase} and cannot proceed without a human decision`
        : `plan ${plan.id} is ${plan.phase} and cannot proceed without a human decision: ${plan.failureReason}`,
    );
  }
  if (AWAITING_HUMAN.includes(plan.phase)) {
    return plan.phase === "WAITING_FOR_HUMAN"
      ? humanRequired(item, "REVIEW_PLAN", `plan ${plan.id} finished its work and is WAITING_FOR_HUMAN`)
      : authorPlan(item, `plan ${plan.id} is ${plan.phase}; approval is a human gate (C1)`);
  }
  /**
   * Still running. Reported as a CHECKPOINT, which the supervisor handles as
   * "persist and continue on the next tick" — precisely what an EXECUTING plan
   * needs, and the only outcome variant that says work continues without
   * claiming success, failure, or that a human is needed.
   *
   * EVERY FIELD IS CARRIED OR DERIVED, none invented. `iteration` counts from
   * the checkpoint the supervisor handed back, so a long-running loop does not
   * reset it to zero on every tick. The verification lists and findings are
   * carried forward because THIS executor performed no verification and has no
   * findings — stating `[]` fresh each time would be a claim that previous
   * verification did not happen.
   *
   * `roadmapKey` and `actionId` are stamped by the SUPERVISOR from the action
   * that actually ran, overriding whatever is supplied here (finding F-5). They
   * are still filled in truthfully rather than left blank, because a record that
   * depends on someone else overwriting it is a record that is wrong whenever
   * they do not.
   */
  return {
    kind: "CHECKPOINT",
    checkpoint: {
      roadmapKey: item.key,
      actionId: input.actionId,
      planId: plan.id,
      iteration: (input.checkpoint?.iteration ?? 0) + 1,
      completedVerification: input.checkpoint?.completedVerification ?? [],
      pendingVerification: input.checkpoint?.pendingVerification ?? [],
      findings: input.checkpoint?.findings ?? [],
      nextAction: `resume plan ${plan.id} and let the engineering loop continue`,
      requiredWorkClass: item.workClass,
      updatedAt: clock.now(),
      ...(plan.approvedRevision === undefined ? {} : { planRevision: plan.approvedRevision }),
    },
    detail: `plan ${plan.id} is ${plan.phase}; the engineering loop is running`,
  };
}

/**
 * The authority-checked phase, or a refusal to proceed on an unverified one.
 *
 * A supervisor with no `PlanStateReader` cannot verify these phases, so it must
 * not act on them. Throwing here is deliberate: `execute` turns it into a
 * definite outcome, and the alternative — silently falling back to the row —
 * is precisely the defect this exists to close.
 */
async function verifiedPhaseOf(plan: Plan, deps: PlanBackedExecutorDeps): Promise<PlanPhase> {
  if (deps.state === undefined) {
    throw new Error(
      `plan ${plan.id} is recorded ${plan.phase}, which asserts a human approval, and this supervisor has no way to verify that against Factory authority`,
    );
  }
  const verified = await deps.state.verifiedPhase(plan.id);
  if (verified !== plan.phase) {
    (deps.log ?? ((): void => {}))(
      `plan ${plan.id}: persisted ${plan.phase} but authority re-derives it as ${verified}`,
    );
  }
  return verified;
}

/**
 * DEFECT-NO-LAUNCH-LINEAGE, round 4, and DEFECT-NO-LAUNCH-LINEAGE-C4/C5,
 * round 5.
 *
 * Round 3 closed import-order races by making the mint/registry
 * module-private, but `createPlanBackedExecutor` itself is public and takes
 * caller-controlled `deps`. Round 4 bound evidence to the exact executor
 * OBJECT that minted it, which closed the nested-helper attack — an arbitrary
 * `WorkExecutor.execute` building its OWN helper through this same factory
 * and forwarding the helper's genuine evidence, which stayed bound to the
 * helper, never to the outer, untrusted object.
 *
 * Round 5 (C5) closed what object identity alone cannot: the factory returns
 * a MUTABLE object, so a caller holding the exact executor `SupervisorService`
 * will dispatch to can do `const genuine = executor.execute.bind(executor)`,
 * REPLACE `executor.execute` in place with a wrapper that does uncertain work
 * and then calls `genuine`, and forward the trusted call's `noLaunchEvidence`
 * field into a NEW, self-authored `WorkOutcome`. Binding evidence to the exact
 * `WorkOutcome` object minted alongside it (below) closes REPACKAGING: a
 * wrapper that builds a new envelope around the forwarded evidence produces an
 * object this module never minted, so the reference check fails.
 *
 * Round 5 left one gap independent review measured (C6): a wrapper that does
 * `return genuine(input)` UNMODIFIED still passed, on the reasoning that the
 * settled outcome then genuinely IS this module's own result. That reasoning
 * is not enough — `uncertainCalls` in the wrapper itself proves the EXECUTION
 * SupervisorService actually invoked was the wrapper, doing uncertain work,
 * not the trusted boundary; that the wrapper happened to forward the genuine
 * object unmodified is a property of this one wrapper's code, not something
 * settlement can know about the next one. So round 6 does not try to
 * distinguish "forwarded unmodified" from "repackaged" after the fact. It
 * removes the seam that both need: `executor.execute` is made a
 * runtime-immutable OWN PROPERTY (`writable: false, configurable: false`)
 * before the factory returns. `const genuine = executor.execute.bind(executor)`
 * still works — reading the property is unaffected — but
 * `executor.execute = wrapper` now THROWS (this module runs under ESM, which
 * is always strict) before any wrapper body ever runs. There is no longer a
 * later point at which uncertain work can have already happened and only THEN
 * decide whether to forward genuine evidence: the assignment that would
 * install such a wrapper never completes, so `uncertainCalls` cannot become
 * nonzero through this seam at all. `declareResources` is deliberately left
 * mutable/replaceable: it carries no evidence and authorises nothing by
 * itself, so locking it would narrow nothing this defect needs and would only
 * make instrumentation strictly harder.
 */
const mintedNoLaunchEvidence = new WeakMap<
  NoLaunchEvidence,
  { readonly executor: WorkExecutor; readonly outcome: WorkOutcome }
>();

function mintNoLaunchOutcome(
  item: RoadmapItem,
  actionId: string,
  detail: string,
  reason: string,
  mintedBy: WorkExecutor,
): WorkOutcome {
  const evidence: NoLaunchEvidence = Object.freeze({ actionId, reason });
  const outcome: WorkOutcome = Object.freeze({
    ...authorPlan(item, detail),
    noLaunchEvidence: evidence,
  });
  mintedNoLaunchEvidence.set(evidence, { executor: mintedBy, outcome });
  return outcome;
}

/**
 * Fail-closed: an outcome that is not `HUMAN_REQUIRED`, carries no evidence,
 * carries unfrozen or never-minted evidence, was minted against a DIFFERENT
 * executor instance, is bound to a different action, or — round 5 — is not
 * itself (by reference) the exact object this module minted, all return
 * `false`. `false` means settlement treats the outcome as it would any
 * ordinary `HUMAN_REQUIRED` — real lineage recorded, nothing suppressed.
 *
 * `outcome` must be the exact `WorkOutcome` `SupervisorService` is actually
 * settling and `executor` the exact `WorkExecutor` it actually dispatched to
 * for this action — never reconstructed, rewrapped, or looked up by action id
 * — or the checks this closes are not being checked at all.
 *
 * Round 6 (C6) does not add a check here: it closes the gap one layer
 * earlier, by making `executor.execute` itself impossible to replace in place
 * (see the comment above `createPlanBackedExecutor`'s return). This function's
 * contract is unchanged.
 */
export function verifyNoLaunchEvidence(
  outcome: WorkOutcome | undefined,
  actionId: string,
  executor: WorkExecutor,
): boolean {
  if (outcome === undefined || outcome.kind !== "HUMAN_REQUIRED") {
    return false;
  }
  const evidence = outcome.noLaunchEvidence;
  if (evidence === undefined || !Object.isFrozen(evidence)) {
    return false;
  }
  const entry = mintedNoLaunchEvidence.get(evidence);
  return (
    entry !== undefined &&
    entry.executor === executor &&
    entry.outcome === outcome &&
    evidence.actionId === actionId
  );
}

export function createPlanBackedExecutor(deps: PlanBackedExecutorDeps): WorkExecutor {
  const log = deps.log ?? ((): void => {});
  // Named so `execute` can mint evidence bound to THIS exact object (round 4)
  // rather than to any executor that merely happens to construct one like it.
  const executor: WorkExecutor = {
    /**
     * WHAT THIS WORK WILL LAUNCH (TASK-015 AC-2).
     *
     * The supervisor cannot know a plan's worker configuration, so it asks
     * before it authorises anything. Declaring is not permission: the set that
     * comes back is authorised member by member, and `execute` then refuses to
     * launch anything outside it — so under-declaring here buys nothing.
     *
     * An unreadable plan means the declaration cannot be made, and the throw is
     * deliberate: the supervisor treats a failed declaration as a refusal rather
     * than as "nothing to authorise", which is the fail-closed direction.
     */
    async declareResources(item): Promise<readonly RequiredResource[]> {
      const plan = await deps.plans.findPlanForItem(item);
      if (plan === undefined) {
        return [];
      }
      // A plan bound to the wrong item is not this item's resource list.
      if (!checkPlanBinding(item.key, plan).ok) {
        return [];
      }
      /**
       * NOTHING TO AUTHORISE FOR A PLAN THAT WILL NOT RUN.
       *
       * A blocked, rejected or unapproved plan launches no worker, so asking the
       * supervisor to probe and gate its three configured models would make
       * every tick pay for resources nothing is going to use — and would turn a
       * plan whose provider is simply unreachable into WAITING_FOR_RESOURCE
       * instead of the honest "this plan is BLOCKED, a human is needed".
       *
       * The row's phase is untrusted, and it is safe to use HERE precisely
       * because it only decides whether to ASK for authorisation. Wrong in the
       * permissive direction authorises more than needed; wrong in the
       * restrictive direction leaves the set empty and `execute` refuses at the
       * authorization check. Both directions fail closed.
       */
      if (!DRIVABLE.includes(plan.phase)) {
        return [];
      }
      return declaredPlanResources(plan).map((resource) => ({
        role: resource.role,
        provider: resource.tool,
        model: resource.model,
        ...(resource.effort === undefined ? {} : { effort: resource.effort }),
      }));
    },
    async execute(input: WorkExecutionInput): Promise<WorkOutcome> {
      /**
       * EVERY failure becomes a definite outcome (AC-9).
       *
       * A throw from an executor becomes an unhandled rejection inside a tick,
       * and a tick that dies leaves the supervisor's durable state describing
       * work that is not happening. `isolatedExecutor` already applies this
       * rule; the seam to planning is no different.
       */
      try {
        const found = await deps.plans.findPlanForItem(input.item);
        if (found === undefined) {
          /**
           * THE ONE PLACE THIS EXECUTOR CAN PROVE NO WORKER LAUNCHED
           * (DEFECT-NO-LAUNCH-LINEAGE).
           *
           * Nothing above this line touched `deps.planning`, so no AI resource
           * was routed, dispatched, or ran. `mintNoLaunchEvidence` is private to
           * this module and this is its only call site, so settlement can trust
           * the result without trusting this function's honesty in general —
           * see the comment above `verifyNoLaunchEvidence`.
           */
          return mintNoLaunchOutcome(
            input.item,
            input.actionId,
            "no plan exists for this roadmap item; creating and approving one is a human decision",
            "no plan exists for this roadmap item; no worker was launched",
            executor,
          );
        }

        /**
         * IS THIS PLAN EVEN FOR THIS ITEM? (round-3 finding 3, HIGH)
         *
         * Checked before ANY outcome is derived from the plan, because a plan
         * belonging to another roadmap item is the wrong answer to every
         * question that follows — not only to "may it launch?" but to "what is
         * this item's state?". Reporting an unrelated plan's BLOCKED as this
         * item's blocker would be a false record even though nothing ran.
         */
        const binding = checkPlanBinding(input.item.key, found);
        if (!binding.ok) {
          return humanRequired(input.item, "RECONCILE_PLAN_BINDING", binding.reason);
        }

        /**
         * THE PHASE IS RE-DERIVED BEFORE IT IS USED (round-3 finding 1, HIGH).
         *
         * Everything below decides on `plan.phase`, and the row's phase is a
         * claim. For the five phases that assert a human approval, the real
         * phase comes from `PlanStateReader`, which asks `sf plan status` — the
         * command that re-derives approval authority from the Factory's records
         * and demotes to RECOVERY_REQUIRED when it cannot.
         *
         * The rest of this function then works on a phase that has been
         * verified, so no later branch has to remember to check. The
         * CONFIGURATION on the row (execution config, failureReason) is still
         * used as-is: it is not a claim of authority, and the authorization gate
         * below treats it as the untrusted input it is.
         */
        const plan = ASSERTS_APPROVAL.includes(found.phase)
          ? { ...found, phase: await verifiedPhaseOf(found, deps) }
          : found;

        if (!DRIVABLE.includes(plan.phase)) {
          return outcomeForPhase(input.item, plan, input, deps.clock);
        }

        if (deps.planning === undefined) {
          return humanRequired(
            input.item,
            "CONFIGURE_PLANNING",
            `plan ${plan.id} is ${plan.phase} but this supervisor is not permitted to drive plans, so it cannot launch the engineering loop (start it with --drive-plans to allow that)`,
          );
        }

        /**
         * THE LAST CHECK BEFORE THE LAUNCH (round-2 finding 2, CRITICAL).
         *
         * The supervisor authorised ONE provider/model/effort for this action:
         * it routed it, probed its billing mode in-process, put that exact
         * resource through the financial gate and will record it as provenance.
         * The plan carries its OWN persisted configuration, and the engineering
         * loop launches THAT. Nothing reconciled the two, so the gate could
         * authorise `claude-code/opus`, the loop could run `codex-cli`, and the
         * evidence would name the resource that did not run.
         *
         * Refused rather than repaired. Substituting a provider, or re-routing
         * to whatever the plan declares, would be this layer granting authority
         * it does not have. It sits HERE, immediately before the launch, rather
         * than earlier where another path could reach the launch around it.
         */
        /**
         * RE-READ AT THE LAST SAFE POINT (TASK-015 §4, time-of-check/time-of-use).
         *
         * The plan authorised above was read at the top of this function, and
         * the supervisor's set was decided before that, from a `declareResources`
         * call that read the plan earlier still. Between then and now the
         * persisted execution configuration can have changed — a re-plan, an
         * operator edit, or anything with write access to the plans database.
         *
         * So the resources are checked against a FRESH read, immediately before
         * the launch. Checking the stale in-memory copy would authorise what the
         * plan used to say while the child runs what it says now, which is the
         * same defect as authorising X and running Y, arrived at by waiting.
         */
        /**
         * A MISSING RE-READ IS A REFUSAL, NOT A FALLBACK (round-3 finding 2).
         *
         * This was `?? plan`, which authorised the STALE copy whenever the fresh
         * read came back empty — a deleted plan, an unavailable database, a
         * lookup that failed. The entire point of re-reading is that the earlier
         * copy is not evidence any more, so falling back to it when the check
         * cannot be performed is the one thing this line must not do.
         */
        const atLaunch = await deps.plans.findPlanForItem(input.item);
        if (atLaunch === undefined) {
          return humanRequired(
            input.item,
            "RECONCILE_PLAN_BINDING",
            `plan ${plan.id} could not be re-read immediately before launch, so what would run cannot be checked against what was authorised`,
          );
        }
        const rebound = checkPlanBinding(input.item.key, atLaunch);
        if (!rebound.ok) {
          return humanRequired(input.item, "RECONCILE_PLAN_BINDING", rebound.reason);
        }
        const authorization = checkPlanAuthorization(atLaunch, input.config, input.authorizedResources);
        if (!authorization.ok) {
          return humanRequired(input.item, "RECONCILE_PLAN_AUTHORIZATION", authorization.reason);
        }

        /**
         * TICKET AUTHORITY, CHECKED ON THE SAME FRESH READ (e954).
         *
         * `checkPlanAuthorization` just confirmed WHO may run this plan; this
         * confirms WHAT a worker would be authorised to do once launched. The
         * only source of that authority is a structured ticket template bound
         * to the plan's OWN approved revision (NC-RUNTIME-01) — never plan
         * prose, never the untrusted row phase. A legacy plan with no
         * templates, an incomplete, malformed, duplicated, orphaned or
         * criteria-mismatched template, or a plan with no approved revision at
         * all, is never launched; each returns a bounded HUMAN_REQUIRED naming
         * a replan or reconciliation rather than inventing the missing
         * authority.
         *
         * Read from `atLaunch`, the SAME re-read `checkPlanAuthorization` above
         * just used, so a template that changed or disappeared between the
         * top-of-function read and this one is caught here rather than
         * grandfathered in on stale state.
         */
        if (atLaunch.approvedRevision === undefined) {
          return humanRequired(
            input.item,
            "RECONCILE_PLAN_TICKETS",
            `plan ${atLaunch.id} carries no approved revision, so no ticket templates can be bound to one; replan and have a human approve the revision carrying them`,
          );
        }
        const approvedRevisionRecord = atLaunch.revisions.find(
          (revision) => revision.revision === atLaunch.approvedRevision,
        );
        if (approvedRevisionRecord === undefined) {
          return humanRequired(
            input.item,
            "RECONCILE_PLAN_TICKETS",
            `plan ${atLaunch.id} approved revision ${atLaunch.approvedRevision} is not among its recorded revisions; reconcile the plan before it can be driven`,
          );
        }
        const executability = planTicketExecutability(
          approvedRevisionRecord.items,
          atLaunch.execution.ticketTemplates,
        );
        if (executability.status !== "EXECUTABLE") {
          const detail =
            executability.status === "NON_EXECUTABLE"
              ? `plan ${atLaunch.id} is not executable: ${executability.reason}; ${executability.replanAction}`
              : `plan ${atLaunch.id} carries invalid ticket templates: ${executability.reason}; reconcile the plan's execution configuration before it can be driven`;
          return humanRequired(input.item, "RECONCILE_PLAN_TICKETS", detail);
        }

        // Approved AND authorised: hand it to planning, which owns every
        // transition from here. In the shipped wiring `resume` runs the plan in
        // a SEPARATE OS PROCESS (`createChildPlanAdvancer`); this file holds the
        // narrow port so that fact is a property of the wiring rather than of
        // this decision.
        /**
         * The digest of the plan THIS CHECK PASSED, handed to the child so it
         * cannot act on a different one. `undefined` for a plan carrying no
         * approval digest is not a bypass: such a plan cannot be APPROVED, so it
         * never reaches this line.
         */
        const runResource = runResourceOf(input);
        const advanced = await deps.planning.resume(plan.id, atLaunch.approvedDigest, {
          actionId: input.actionId,
          roadmapKey: input.item.key,
          attempt: attemptFromActionId(input.actionId),
          provider: runResource.provider,
          model: runResource.model,
          ...(runResource.effort === undefined ? {} : { effort: runResource.effort }),
        });
        /**
         * VERIFIED ON THE WAY OUT TOO, so the invariant is uniform.
         *
         * `resume` returns the plan's ROW after the child exited, and a row is a
         * claim wherever it is read — the same reason the phase was re-derived
         * on the way in. Without this, the one path that can report COMPLETED
         * after real work would be the one path that did not check.
         *
         * The extra child is a status read of a couple of seconds, taken only
         * when the result asserts an approval, immediately after a child that
         * may have run for half an hour.
         */
        const settled = ASSERTS_APPROVAL.includes(advanced.phase)
          ? { ...advanced, phase: await verifiedPhaseOf(advanced, deps) }
          : advanced;
        log(`plan ${plan.id} for ${input.item.key}: ${plan.phase} -> ${settled.phase}`);
        return outcomeForPhase(input.item, settled, input, deps.clock);
      } catch (error) {
        return {
          kind: "RESOURCE_FAILURE",
          process: {
            terminationReason: "EXITED",
            exitCode: null,
            stdout: "",
            stderr: `planning seam failed for ${input.item.key}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        };
      }
    },
  };
  /**
   * THE C6 CORRECTION: `execute` is made a runtime-immutable own property
   * before this factory ever hands `executor` to a caller.
   *
   * `Object.freeze(executor)` would also do this, but it would additionally
   * lock `declareResources`, which carries no evidence and is not the seam
   * round 5/6 are about; narrowing exactly to `execute` keeps the boundary as
   * small as the defect it closes. `writable: false` makes
   * `executor.execute = anything` a no-op in sloppy-mode code and a thrown
   * `TypeError` under strict mode (which is what this module, its tests, and
   * every ESM caller run under) — either way, the assignment never takes
   * effect, so no wrapper body can ever run in its place. Reading the
   * property — `executor.execute`, `executor.execute.bind(executor)` — is
   * completely unaffected; only replacing it is.
   */
  Object.defineProperty(executor, "execute", {
    value: executor.execute,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  return executor;
}
