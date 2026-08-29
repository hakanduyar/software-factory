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
 */

import type { Clock } from "../ports/clock.js";
import type { Plan, PlanPhase } from "../planning/planTypes.js";
import type { WorkExecutionInput, WorkExecutor, WorkOutcome } from "./supervisorPorts.js";
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
export interface PlanAdvancer {
  resume(planId: string): Promise<Plan>;
}

export interface PlanBackedExecutorDeps {
  readonly plans: RoadmapPlanLookup;
  /**
   * OPTIONAL, and the absence is a real deployment rather than a gap.
   *
   * Driving a plan needs the whole TASK-005 construction — planner worker, loop
   * dispatcher, workspace, verification commands — which the supervisor CLI only
   * has when an operator supplies a planning configuration. Without one, an
   * approved plan is reported as needing a human instead of being driven.
   *
   * This is why the CLI can stop wiring `createUnimplementedExecutor` (AC-1)
   * without pretending to capabilities it lacks: the SAME executor runs in both
   * deployments, and the honest answer for an unconfigured supervisor comes out
   * of the real path rather than a stub that hard-codes it.
   */
  readonly planning?: PlanAdvancer;
  readonly clock: Clock;
  readonly log?: (line: string) => void;
}

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

function authorPlan(item: RoadmapItem, detail: string): WorkOutcome {
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

export function createPlanBackedExecutor(deps: PlanBackedExecutorDeps): WorkExecutor {
  const log = deps.log ?? ((): void => {});
  return {
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
        const plan = await deps.plans.findPlanForItem(input.item);
        if (plan === undefined) {
          return authorPlan(
            input.item,
            "no plan exists for this roadmap item; creating and approving one is a human decision",
          );
        }

        if (!DRIVABLE.includes(plan.phase)) {
          return outcomeForPhase(input.item, plan, input, deps.clock);
        }

        if (deps.planning === undefined) {
          return humanRequired(
            input.item,
            "CONFIGURE_PLANNING",
            `plan ${plan.id} is ${plan.phase} but this supervisor has no planning configuration, so it cannot drive the engineering loop`,
          );
        }

        // Approved: hand it to planning, which owns every transition from here.
        const advanced = await deps.planning.resume(plan.id);
        log(`plan ${plan.id} for ${input.item.key}: ${plan.phase} -> ${advanced.phase}`);
        return outcomeForPhase(input.item, advanced, input, deps.clock);
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
}
