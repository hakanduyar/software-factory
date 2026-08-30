/**
 * TASK-005 durable planner / task generator.
 *
 * Turns a natural-language goal into a durable, reviewable plan; waits for a
 * trusted human to approve one exact revision; then materializes that revision
 * into real Factory WorkItems and hands them, dependency-ordered, to the
 * accepted TASK-004 engineering loop.
 *
 * THE INVARIANT THIS SERVICE EXISTS TO PROTECT: a persisted phase is a
 * CHECKPOINT, never authority. `phase = "APPROVED"` in plans.db does not mean a
 * human approved anything; it means the last writer believed so. Every
 * operation that creates work, readies work or dispatches work therefore
 * re-derives approval from the Factory's own append-only approval records
 * through the accepted central gate — bound to the plan id, the exact revision
 * AND the exact content digest — before it acts. This is the lesson TASK-004
 * remediation rounds 3 through 5 paid for with fourteen HIGH findings, applied
 * here from the start rather than after the fact.
 *
 * What this service deliberately does NOT do: implement, verify, review or
 * remediate anything. That is TASK-004's accepted state machine, reached only
 * through the narrow `LoopDispatcher` port. There is no second engineering loop
 * here, and no API through which one could be written by accident.
 */

import { planSubject } from "../domain/approval.js";
import type { Actor } from "../domain/actor.js";
import { ConcurrencyError, HumanIdentityError, NotFoundError, ValidationError } from "../domain/errors.js";
import type { TrustedHumanToken } from "../domain/humanIdentity.js";
import type { IdGenerator, ProjectId, WorkItemId } from "../domain/ids.js";
import type { WorkItem } from "../domain/workItem.js";
import type { FactoryService } from "../app/factoryService.js";
import type { Clock } from "../ports/clock.js";
import {
  compareMaterializedItemShape,
  type BindingResult,
  type MaterializedItemShape,
  type PlanBindingResolver,
} from "../ports/planBindingResolver.js";
import { approvalDigestOfPlan, computePlanContentDigest, sha256Hex } from "./planDigest.js";
import {
  LOOP_PHASES_BLOCKING,
  LOOP_PHASE_EXECUTION_FINISHED,
  type DispatchedLoopView,
  type LoopDispatcher,
} from "./loopDispatcher.js";
import { PLANNER_OUTPUT_CONTRACT } from "./planPrompts.js";
import { parsePlannerOutput } from "./plannerOutputContract.js";
import type { PlannerQuestionAnswer, PlannerWorker } from "./plannerWorker.js";
import type { PlanRepository } from "./planRepository.js";
import {
  DEFAULT_PLAN_BUDGET,
  MAX_EVENT_DETAIL_LENGTH,
  canonicalCorrelationTag,
  canonicalPlannerActionTag,
  canonicalRequestKey,
  expectedMaterializedItemShape,
  isTerminalPlanPhase,
  type ClarificationAnswer,
  type Plan,
  type PlanBudget,
  type PlanEventKind,
  type PlanExecutionConfig,
  type PlannedWorkItem,
  type PlannerConfig,
  type PlanPhase,
  type PlanRevision,
} from "./planTypes.js";
import { topologicalOrder, validateProposal } from "./planValidation.js";

export interface PlanningServiceDeps {
  readonly factory: FactoryService;
  readonly plans: PlanRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly planner: PlannerWorker;
  readonly dispatcher: LoopDispatcher;
  readonly log?: (line: string) => void;
  /** Curated, bounded rules handed to the planner. Never secrets, never repository contents. */
  readonly projectRules?: readonly string[];
  /**
   * Identity of THIS service instance, durably recorded on a planner lease.
   * Defaults to a pid-scoped value; injectable so a test can make two instances
   * indistinguishable or deliberately distinct.
   */
  readonly ownerId?: string;
}

export interface StartPlanInput {
  readonly projectId: ProjectId;
  readonly actor: Actor;
  /** The human's goal, stored verbatim and never rewritten by any model. */
  readonly intent: string;
  readonly constraints?: readonly string[];
  readonly planner: PlannerConfig;
  readonly execution: PlanExecutionConfig;
  readonly budget?: Partial<PlanBudget>;
}

export interface SubmittedAnswer {
  readonly questionId: string;
  readonly answer: string;
}

type StepResult =
  | { readonly kind: "advanced"; readonly plan: Plan }
  | { readonly kind: "halt"; readonly plan: Plan }
  | { readonly kind: "conflict" };

interface EventDraft {
  readonly kind: PlanEventKind;
  readonly detail: string;
}

/** Backstop against a step function that always claims progress. Far above any real plan's needs. */
const MAX_DRIVE_STEPS = 2000;

/**
 * Phases whose very existence ASSERTS that a human approved this plan's exact
 * content — and from which further work can still follow. No public read path
 * may present one as authoritative just because plans.db says so (the TASK-004
 * remediation round-4 lesson, applied here from the start).
 *
 * `BLOCKED` is deliberately absent: a plan can be blocked by planner-budget
 * exhaustion long BEFORE any approval exists, so demanding approval authority
 * of it would misreport a legitimately-blocked draft as corrupted. `COMPLETED`,
 * `REJECTED`, `CANCELLED` and `RECOVERY_REQUIRED` are absent because they are
 * terminal: nothing further can be dispatched from them.
 */
const PHASES_ASSERTING_APPROVAL: readonly PlanPhase[] = [
  "APPROVED",
  "MATERIALIZING",
  "EXECUTING",
  "WAITING_FOR_HUMAN",
  // Terminal, but still a claim ABOUT an approval ("the approved work is
  // finished"), so a reader may not be shown one whose approval no longer
  // holds. Nothing further can be dispatched from it either way.
  "COMPLETED",
];

/**
 * Phases whose existence ASSERTS that real Factory WorkItems back this plan
 * (remediation round 1, HIGH 7). A mapping is a REFERENCE, never proof: before
 * this, a plan whose mapping pointed at a work item that no longer existed
 * loaded happily, reported `EXECUTING` from `status()`, and only failed when
 * `resume()` threw `NotFoundError` out of the middle of a drive step.
 *
 * `COMPLETED` is included even though it is terminal: "all work items reached
 * DONE" is a claim about objects that must still exist and still be this plan's.
 */
const PHASES_ASSERTING_MATERIALIZATION: readonly PlanPhase[] = [
  "MATERIALIZING",
  "EXECUTING",
  "WAITING_FOR_HUMAN",
  "COMPLETED",
];

/**
 * The PlanBindingResolver `FactoryService` consults when stamping a PLAN
 * approval. Deliberately backed by the repository rather than by
 * `PlanningService`, so there is no construction cycle (the service needs the
 * factory; the factory needs the resolver) and so the binding can never be
 * influenced by in-flight service state — only by what is durably stored.
 */
function refuse<T>(reason: string): BindingResult<T> {
  return { ok: false, reason };
}

export function createPlanBindingResolver(plans: PlanRepository): PlanBindingResolver {
  return {
    async resolveApprovalBinding(planId: string) {
      const plan = await plans.findById(planId);
      if (plan === undefined) {
        return refuse(`plan ${planId} does not exist`);
      }
      if (plan.cancelRequested) {
        return refuse(`plan ${planId} has a durable cancellation request`);
      }
      if (plan.phase !== "PLAN_REVIEW") {
        return refuse(`plan ${planId} is ${plan.phase}, not awaiting a human decision at PLAN_REVIEW`);
      }
      const latest = plan.revisions.at(-1);
      if (latest === undefined) {
        return refuse(`plan ${planId} has no generated revision to approve`);
      }
      // The digest covers the revision AND the configuration deciding where and
      // how it executes (round 1, HIGH 4) — see computePlanApprovalDigest.
      return { ok: true, value: { planRevision: latest.revision, approvalDigest: approvalDigestOfPlan(plan, latest) } };
    },

    /**
     * ROUND 1, HIGH 1 + HIGH 2. The ONLY proof of "this work item is covered by
     * that human approval". Everything it asserts is read from durable plan
     * state; nothing is taken from the caller except the two identifiers it is
     * asked about.
     */
    async resolveMaterializationTarget(planId: string, workItemId: string) {
      const plan = await plans.findById(planId);
      if (plan === undefined) {
        return refuse(`plan ${planId} does not exist`);
      }
      if (plan.cancelRequested) {
        return refuse(`plan ${planId} has a durable cancellation request; it authorizes no further work`);
      }
      const { approvalId, approvedRevision, approvedDigest } = plan;
      if (approvalId === undefined || approvedRevision === undefined || approvedDigest === undefined) {
        return refuse(`plan ${planId} has no recorded human approval`);
      }
      const revision = plan.revisions.find((entry) => entry.revision === approvedRevision);
      if (revision === undefined) {
        return refuse(`approved revision ${approvedRevision} no longer exists on plan ${planId}`);
      }
      // A newer revision supersedes the decision: a human approved revision N,
      // not "whatever the plan says next".
      if (plan.revisions.length !== approvedRevision) {
        return refuse(
          `plan ${planId} now has ${plan.revisions.length} revision(s); the approval of revision ${approvedRevision} is superseded`,
        );
      }
      const digest = approvalDigestOfPlan(plan, revision);
      if (digest !== approvedDigest) {
        return refuse(
          `plan ${planId} content/configuration digest ${digest} no longer matches the approved ${approvedDigest}`,
        );
      }
      // MEMBERSHIP. Not "the caller says so", not "the tag looks right": the
      // durable materialization mapping is what names this plan's work items.
      const mapping = plan.materialized.find((entry) => entry.workItemId === workItemId);
      if (mapping === undefined) {
        return refuse(
          `work item ${workItemId} is not a materialized target of plan ${planId} revision ${approvedRevision}`,
        );
      }
      const item = revision.items.find((entry) => entry.key === mapping.planItemKey);
      if (item === undefined) {
        return refuse(`approved revision ${approvedRevision} has no item "${mapping.planItemKey}"`);
      }
      const expectedTag = canonicalCorrelationTag(plan.id, approvedRevision, mapping.planItemKey);
      if (mapping.correlationTag !== expectedTag) {
        return refuse(`mapping tag ${mapping.correlationTag} is not the canonical ${expectedTag}`);
      }
      const dependencyWorkItemIds: string[] = [];
      for (const dependencyKey of item.dependsOn) {
        const dependency = plan.materialized.find((entry) => entry.planItemKey === dependencyKey);
        if (dependency === undefined) {
          return refuse(`dependency "${dependencyKey}" of "${mapping.planItemKey}" is not materialized`);
        }
        dependencyWorkItemIds.push(dependency.workItemId);
      }
      return {
        ok: true,
        value: {
          planRevision: approvedRevision,
          approvalDigest: approvedDigest,
          planItemKey: mapping.planItemKey,
          expected: expectedMaterializedItemShape(plan.projectId, expectedTag, item, dependencyWorkItemIds),
        },
      };
    },
  };
}

export class PlanningService {
  private readonly factory: FactoryService;
  private readonly plans: PlanRepository;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly planner: PlannerWorker;
  private readonly dispatcher: LoopDispatcher;
  private readonly log: (line: string) => void;
  private readonly projectRules: readonly string[];
  private readonly ownerId: string;
  /**
   * Plans whose planner lease THIS instance currently holds in flight.
   *
   * Durable state can prove a lease exists and who took it; it cannot prove
   * whether that owner is still alive. So liveness is tracked here, and the two
   * signals are combined in `reconcilePlannerAction`: an unsettled lease is
   * never stolen, and only a lease that is provably not running here is
   * reconciled. Deliberately NOT a substitute for the durable lease — an
   * in-memory mutex alone would be silent about the restart case, which is the
   * one that actually launches duplicate model work.
   */
  private readonly plannerActionsInFlight = new Set<string>();

  constructor(deps: PlanningServiceDeps) {
    this.factory = deps.factory;
    this.plans = deps.plans;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.planner = deps.planner;
    this.dispatcher = deps.dispatcher;
    this.log = deps.log ?? ((): void => {});
    this.projectRules = deps.projectRules ?? [];
    this.ownerId = deps.ownerId ?? `planner-owner:${process.pid}:${this.ids.next("own")}`;
  }

  // =====================================================================
  // Public surface
  // =====================================================================

  /**
   * Starts (or adopts) planning for a human request.
   *
   * The request key is derived from the project and the intent text, so
   * starting the same intent twice adopts the existing active plan rather than
   * creating a second one — and two concurrent starts serialize inside the
   * repository, where the loser's `create` is refused by the active-plan
   * constraint rather than by a check-then-insert race.
   */
  async start(input: StartPlanInput): Promise<Plan> {
    if (input.intent.trim().length === 0) {
      throw new ValidationError("a plan needs a non-empty intent");
    }
    if (input.execution.verificationCommands.length === 0) {
      throw new ValidationError("plan execution config must declare at least one deterministic verification command");
    }
    // Fail fast on a project that does not exist, BEFORE a plan row is created
    // and before a planner attempt is charged — a typo'd project id must not
    // cost a real model invocation. `getProject` throws NotFoundError; an
    // empty work-item list would not, which is why this asks for the project
    // itself rather than inferring existence from its contents.
    await this.factory.getProject(input.projectId);

    const budget: PlanBudget = { ...DEFAULT_PLAN_BUDGET, ...(input.budget ?? {}) };
    if (budget.maxPlannerAttempts < 1 || budget.maxTotalPlannerRuns < 1) {
      throw new ValidationError("plan budget must allow at least one planner attempt and one planner run");
    }

    const requestKey = canonicalRequestKey(input.projectId, input.intent, sha256Hex);
    const existing = await this.plans.findActiveByRequestKey(requestKey);
    if (existing !== undefined) {
      this.log(`[plan ${existing.id}] adopting existing active plan for this request`);
      return this.drive(existing.id);
    }

    const now = this.clock.now();
    const plan: Plan = {
      id: this.ids.next("plan"),
      projectId: input.projectId,
      requestKey,
      version: 1,
      phase: "DRAFT",
      intent: input.intent,
      declaredConstraints: input.constraints ?? [],
      budget,
      planner: input.planner,
      execution: input.execution,
      revisions: [],
      openQuestions: [],
      answers: [],
      attemptsForCurrentRevision: 0,
      clarificationCycles: 0,
      totalPlannerRuns: 0,
      materialized: [],
      dispatches: [],
      cancelRequested: false,
      events: [{ seq: 1, kind: "REQUEST_CREATED", detail: bound(`request ${requestKey} created`), at: now }],
      startedBy: input.actor,
      startedAt: now,
      lastTransitionAt: now,
    };

    await this.plans.create(plan);
    this.log(`[plan ${plan.id}] started for project ${input.projectId} by ${input.actor.displayName}`);
    return this.drive(plan.id);
  }

  /**
   * `expectApprovedDigest` pins WHICH APPROVAL the caller cleared.
   *
   * An unattended caller checks a plan's configuration and then asks for it to
   * be resumed, and a revision approved in between replaces what was checked.
   * Verifying once before calling `drive()` is NOT enough — TASK-015 round 2
   * found exactly that: `drive()` re-reads the plan on every step, so a check
   * outside it protected the call and not the launch.
   *
   * The pin is therefore enforced inside the loop, against every read. An
   * interactive human passes nothing and is unaffected.
   */
  async resume(planId: string, expectApprovedDigest?: string): Promise<Plan> {
    return this.drive(planId, expectApprovedDigest);
  }

  /**
   * Read-only status.
   *
   * Applies the TASK-004 round-4 discipline: a phase that ASSERTS AUTHORITY —
   * here `APPROVED`, `MATERIALIZING` and `EXECUTING`, all of which claim a human
   * approved this exact content — may not be presented as authoritative merely
   * because the database says so. A future Control Room, Telegram layer or API
   * client reading this would otherwise treat a stale or corrupted checkpoint as
   * a live human decision.
   *
   * When authority cannot currently be proven this FAILS CLOSED by returning a
   * `RECOVERY_REQUIRED` projection. That projection is computed in memory and
   * deliberately NOT persisted: reading a plan must never be what changes it.
   * Durably demoting the invalid checkpoint is `resume()`'s job.
   */
  async status(planId: string): Promise<Plan> {
    return this.projectFailClosed(await this.requirePlan(planId));
  }

  /**
   * THE read-only fail-closed projection, shared by `status()` and by the one
   * `drive()` path that returns without acting (a terminal plan).
   *
   * Round 2 found the disagreement that made this shared: `drive()` returned a
   * terminal plan verbatim, so `resume()` reported `COMPLETED` for a plan whose
   * dispatch no longer resolved while `status()` reported `RECOVERY_REQUIRED`
   * for the same row. A reader and a writer may differ in whether they PERSIST
   * a conclusion; they may never differ in what the conclusion IS.
   *
   * Computed in memory and deliberately not persisted: reading a plan must
   * never be what changes it, and a terminal record is history — demoting it
   * durably would rewrite what happened rather than report what is wrong.
   */
  private async projectFailClosed(plan: Plan): Promise<Plan> {
    const problem = await this.authorityProblem(plan, "read");
    if (problem === undefined) {
      return plan;
    }
    const hint = isTerminalPlanPhase(plan.phase)
      ? "reported read-only; this plan is terminal, so a human must reconcile the record"
      : "reported read-only; run `sf plan resume` to durably record RECOVERY_REQUIRED";
    return {
      ...plan,
      phase: "RECOVERY_REQUIRED",
      outcome: "RECOVERY_REQUIRED",
      failureReason: `persisted ${plan.phase} is not backed by current Factory authority: ${problem} (${hint})`,
    };
  }

  /**
   * The one place that decides whether a persisted phase is still backed by
   * live authority — used by the read-only projection above and by the durable
   * fail-closed checks in the drive steps, so a reader and a writer can never
   * disagree about whether a plan is sound.
   *
   * The two modes differ ONLY in how much they check, never in how strictly:
   *
   *   "read" asks what a phase CLAIMS, so it checks only what that phase
   *          asserts. A pre-approval `BLOCKED` draft must not be reported as
   *          corrupted merely for having no approval, because it never claimed
   *          one.
   *   "act"  asks whether it is safe to CREATE OR DISPATCH WORK RIGHT NOW, so
   *          it checks everything, whatever the phase says. Gating this on the
   *          phase would be the same mistake as trusting the phase: `BLOCKED`
   *          also routes into the execution step, and it must not be a way in
   *          with fewer questions asked.
   */
  private async authorityProblem(plan: Plan, mode: "read" | "act"): Promise<string | undefined> {
    if (mode === "act" || PHASES_ASSERTING_APPROVAL.includes(plan.phase)) {
      const authority = await this.verifyApprovalAuthority(plan);
      if (!authority.ok) {
        return authority.reason;
      }
    }
    if (mode === "act" || PHASES_ASSERTING_MATERIALIZATION.includes(plan.phase)) {
      const mappings = await this.verifyMaterializationIntegrity(plan);
      if (!mappings.ok) {
        return mappings.reason;
      }
      // Round 2: the sibling foreign-reference collection. Checked in the same
      // place and under the same rule, so the two can never drift apart again.
      const dispatches = await this.resolveDispatchViews(plan);
      if (!dispatches.ok) {
        return `dispatch record is not sound: ${dispatches.reason}`;
      }
    }
    return undefined;
  }

  /**
   * Records human answers to blocking clarification questions.
   *
   * Held to the trusted-human boundary even though it is not itself a C1 gate:
   * an answer becomes part of the goal the plan is built from, so accepting one
   * from an unauthenticated caller would let an agent steer what a human is
   * later asked to approve. Answers bind to the revision that ASKED — a stale
   * answer for a superseded revision is refused rather than silently applied.
   */
  async answer(
    planId: string,
    actor: Actor,
    authorization: TrustedHumanToken | undefined,
    answers: readonly SubmittedAnswer[],
  ): Promise<Plan> {
    this.requireTrustedHuman(actor, authorization, `answer clarifications on plan ${planId}`);
    if (answers.length === 0) {
      throw new ValidationError("provide at least one answer");
    }

    const plan = await this.requirePlan(planId);
    if (plan.phase !== "NEEDS_CLARIFICATION") {
      throw new ValidationError(`plan ${planId} is ${plan.phase}; there are no open clarification questions to answer`);
    }

    const askedAtRevision = plan.revisions.length;
    const open = new Map(plan.openQuestions.map((question) => [question.id, question]));
    const recorded: ClarificationAnswer[] = [];
    const at = this.clock.now();
    for (const submitted of answers) {
      const question = open.get(submitted.questionId);
      if (question === undefined) {
        throw new ValidationError(
          `question "${submitted.questionId}" is not open on plan ${planId}; an answer to a superseded or unknown question cannot be applied`,
        );
      }
      if (submitted.answer.trim().length === 0) {
        throw new ValidationError(`answer to "${submitted.questionId}" is empty`);
      }
      recorded.push({
        questionId: question.id,
        // The round that asked is the one already counted when the questions
        // were persisted, so this is `clarificationCycles`, not +1.
        askedAtCycle: plan.clarificationCycles,
        askedAtRevision,
        question: question.question,
        answer: submitted.answer.trim(),
        answeredBy: actor,
        answeredAt: at,
      });
    }

    const remaining = plan.openQuestions.filter((question) => !recorded.some((entry) => entry.questionId === question.id));
    if (remaining.length > 0) {
      throw new ValidationError(
        `plan ${planId} still has unanswered blocking question(s): ${remaining.map((question) => question.id).join(", ")}`,
      );
    }

    const committed = await this.commit(
      plan,
      { ...plan, phase: "DRAFT", openQuestions: [], answers: [...plan.answers, ...recorded], attemptsForCurrentRevision: 0 },
      recorded.map((entry) => ({ kind: "CLARIFICATION_ANSWERED" as const, detail: `${entry.questionId}: ${entry.answer}` })),
    );
    if (committed === undefined) {
      throw new ConcurrencyError(`plan ${planId} changed while answers were being recorded; re-read and retry`);
    }
    return this.drive(planId);
  }

  /**
   * The one operation that creates execution authority.
   *
   * The trusted-human check happens BEFORE any state is read or written, so a
   * refused caller produces no phase change, no version bump and no side
   * effect. The approval itself is recorded by the accepted
   * `FactoryService.recordApproval`, which stamps the revision and content
   * digest from live state — this service never supplies the binding it is
   * about to be judged against.
   */
  async approve(planId: string, actor: Actor, authorization: TrustedHumanToken | undefined, note?: string): Promise<Plan> {
    this.requireTrustedHuman(actor, authorization, `approve plan ${planId}`);

    const plan = await this.requirePlan(planId);
    if (plan.cancelRequested) {
      throw new ValidationError(`plan ${planId} has a durable cancellation request and may not be approved`);
    }
    if (plan.phase !== "PLAN_REVIEW") {
      throw new ValidationError(`plan ${planId} is ${plan.phase}; only a plan at PLAN_REVIEW may be approved`);
    }
    const revision = plan.revisions.at(-1);
    if (revision === undefined) {
      throw new ValidationError(`plan ${planId} has no generated revision to approve`);
    }

    const approval = await this.factory.recordApproval({
      gate: "PLAN_APPROVAL",
      subject: planSubject(planId),
      decision: "APPROVED",
      actor,
      // `authorization` is defined: requireTrustedHuman threw otherwise.
      authorization: authorization as TrustedHumanToken,
      ...(note === undefined ? {} : { note }),
    });

    // The SAME derivation `recordApproval` stamped through the resolver, from
    // the same durable plan — never a second, subtly different definition.
    const approvedDigest = approvalDigestOfPlan(plan, revision);
    const committed = await this.commit(
      plan,
      {
        ...plan,
        phase: "APPROVED",
        approvalId: approval.id,
        approvedRevision: revision.revision,
        approvedDigest,
      },
      [{ kind: "APPROVED", detail: `revision ${revision.revision} (${approvedDigest}) approved by ${actor.displayName}` }],
    );
    if (committed === undefined) {
      // Someone else advanced the plan. If it is already approved for this
      // exact revision, treat this as the idempotent double-approval it is;
      // otherwise report the conflict rather than guessing.
      const current = await this.requirePlan(planId);
      if (current.approvedRevision !== revision.revision) {
        throw new ConcurrencyError(`plan ${planId} changed while the approval was being recorded; re-read and retry`);
      }
    }
    this.log(`[plan ${planId}] revision ${revision.revision} approved by ${actor.displayName}`);
    return this.drive(planId);
  }

  async reject(planId: string, actor: Actor, authorization: TrustedHumanToken | undefined, note?: string): Promise<Plan> {
    this.requireTrustedHuman(actor, authorization, `reject plan ${planId}`);

    const plan = await this.requirePlan(planId);
    if (plan.phase !== "PLAN_REVIEW") {
      throw new ValidationError(`plan ${planId} is ${plan.phase}; only a plan at PLAN_REVIEW may be rejected`);
    }
    const revision = plan.revisions.at(-1);
    if (revision === undefined) {
      throw new ValidationError(`plan ${planId} has no generated revision to reject`);
    }

    await this.factory.recordApproval({
      gate: "PLAN_APPROVAL",
      subject: planSubject(planId),
      decision: "REJECTED",
      actor,
      authorization: authorization as TrustedHumanToken,
      ...(note === undefined ? {} : { note }),
    });

    const committed = await this.commit(
      plan,
      { ...plan, phase: "REJECTED", outcome: "REJECTED", failureReason: note ?? `revision ${revision.revision} rejected by ${actor.displayName}` },
      [{ kind: "REJECTED", detail: `revision ${revision.revision} rejected by ${actor.displayName}${note === undefined ? "" : `: ${note}`}` }],
    );
    if (committed === undefined) {
      throw new ConcurrencyError(`plan ${planId} changed while the rejection was being recorded; re-read and retry`);
    }
    return committed;
  }

  /**
   * Durably records cancellation intent, then finalizes.
   *
   * Like TASK-004's loop cancellation, the trusted-human check precedes every
   * read and write. Once the intent write lands, every claim attempt with a
   * stale version loses its CAS, so no new work item and no new loop can begin.
   * Already-running loops keep TASK-004's own accepted cancellation semantics —
   * no unsafe hard kill is attempted from here — and already-created WorkItems
   * are left in place for a human to decide on rather than mass-cancelled.
   */
  async cancel(planId: string, actor: Actor, authorization: TrustedHumanToken | undefined): Promise<Plan> {
    this.requireTrustedHuman(actor, authorization, `cancel plan ${planId}`);

    const plan = await this.requirePlan(planId);
    if (isTerminalPlanPhase(plan.phase)) {
      return plan;
    }

    const committed = await this.commit(
      plan,
      { ...plan, phase: "CANCELLED", outcome: "CANCELLED", cancelRequested: true, failureReason: `cancelled by ${actor.displayName}` },
      [{ kind: "CANCELLED", detail: `cancelled by ${actor.displayName}` }],
    );
    if (committed === undefined) {
      const current = await this.requirePlan(planId);
      if (isTerminalPlanPhase(current.phase)) {
        return current;
      }
      throw new ConcurrencyError(`plan ${planId} changed while cancellation was being recorded; re-read and retry`);
    }
    this.log(`[plan ${planId}] cancelled by ${actor.displayName}`);
    return committed;
  }

  // =====================================================================
  // Drive loop
  // =====================================================================

  private async drive(planId: string, expectApprovedDigest?: string): Promise<Plan> {
    for (let step = 0; step < MAX_DRIVE_STEPS; step += 1) {
      const plan = await this.requirePlan(planId);

      /**
       * THE PIN IS CHECKED AGAINST EVERY READ (TASK-015 round-2 finding 1).
       *
       * This loop re-reads the plan on each step, so a revision approved
       * between two steps would be driven by the later ones even though the
       * caller only ever cleared the earlier content. Checking once outside the
       * loop protected the CALL, not the LAUNCH — which is the same
       * check-then-use shape one level down from where it was first found.
       */
      if (expectApprovedDigest !== undefined && plan.approvedDigest !== expectApprovedDigest) {
        throw new ValidationError(
          `plan ${planId} is no longer the approval that was authorized: expected digest ` +
            `${expectApprovedDigest}, found ${plan.approvedDigest ?? "none"}. Refusing to drive it.`,
        );
      }

      if (isTerminalPlanPhase(plan.phase)) {
        // Same conclusion as `status()`, by construction (round 2): a terminal
        // plan takes no action, but it must not be REPORTED as sound by the
        // write path when the read path can prove it is not.
        return this.projectFailClosed(plan);
      }
      if (plan.cancelRequested) {
        const finalized = await this.commit(
          plan,
          { ...plan, phase: "CANCELLED", outcome: "CANCELLED", failureReason: "cancellation requested" },
          [{ kind: "CANCELLED", detail: "finalized a durable cancellation request" }],
        );
        if (finalized === undefined) {
          continue;
        }
        return finalized;
      }

      const result = await this.stepFor(plan, expectApprovedDigest);
      if (result.kind === "conflict") {
        continue;
      }
      if (result.kind === "halt") {
        return result.plan;
      }
    }
    throw new ValidationError(`plan ${planId} did not settle within ${MAX_DRIVE_STEPS} steps; refusing to loop further`);
  }

  private async stepFor(plan: Plan, expectApprovedDigest?: string): Promise<StepResult> {
    switch (plan.phase) {
      case "DRAFT":
      case "PLANNING":
        return this.stepPlanner(plan);
      case "NEEDS_CLARIFICATION":
      case "PLAN_REVIEW":
        // Waiting on a human. Not an error, not progress.
        return { kind: "halt", plan };
      case "APPROVED":
      case "MATERIALIZING":
        return this.stepMaterialize(plan);
      case "EXECUTING":
      case "WAITING_FOR_HUMAN":
      case "BLOCKED":
        return this.stepExecute(plan, expectApprovedDigest);
      default:
        return { kind: "halt", plan };
    }
  }

  // =====================================================================
  // Planning
  // =====================================================================

  private plannerBudgetProblem(plan: Plan): { reason: string; kind: Plan["exhaustionKind"] } | undefined {
    if (plan.totalPlannerRuns >= plan.budget.maxTotalPlannerRuns) {
      return {
        reason: `planner run budget exhausted (${plan.totalPlannerRuns}/${plan.budget.maxTotalPlannerRuns} total runs)`,
        kind: "TOTAL_PLANNER_RUNS",
      };
    }
    if (plan.attemptsForCurrentRevision >= plan.budget.maxPlannerAttempts) {
      return {
        reason: `planner attempt budget exhausted for this revision (${plan.attemptsForCurrentRevision}/${plan.budget.maxPlannerAttempts})`,
        kind: "PLANNER_ATTEMPTS",
      };
    }
    if (plan.budget.maxWallClockMs !== undefined && this.clock.now() - plan.startedAt > plan.budget.maxWallClockMs) {
      return { reason: `planning wall-clock budget exhausted (${plan.budget.maxWallClockMs}ms)`, kind: "WALL_CLOCK" };
    }
    return undefined;
  }

  /**
   * ROUND 1, HIGH 5. Decides what to do about an existing planner lease before
   * any new one can be taken. Three signals, in the only order that is safe:
   *
   *   1. The lease is in flight IN THIS INSTANCE  -> halt. Never steal, never
   *      launch a second run alongside a live one.
   *   2. `CLAIMED`                                -> the launch provably never
   *      happened; clear the lease and let the normal budgeted path retry.
   *   3. `RUNNING`, owner not live here           -> the outcome is unknowable.
   *      Fail closed rather than spend a second real model run guessing.
   *
   * Case 3 is deliberately conservative: a second live PlanningService instance
   * over the same database would land here too. That trade is correct — a false
   * "needs recovery" costs a human a command; a false "safe to relaunch" costs
   * duplicate external work and a corrupted planning budget.
   */
  private async reconcilePlannerAction(plan: Plan): Promise<StepResult | undefined> {
    const action = plan.plannerAction;
    if (action === undefined) {
      return undefined;
    }
    if (this.plannerActionsInFlight.has(plan.id)) {
      this.log(`[plan ${plan.id}] planner attempt ${action.attempt} is already running; not launching another`);
      return { kind: "halt", plan };
    }
    if (action.state === "CLAIMED") {
      // `commit` releases the lease for us: it cannot survive a phase that is
      // not PLANNING.
      const cleared = await this.commit(plan, { ...plan, phase: "DRAFT" }, [
        {
          kind: "PLANNER_RUN_FAILED",
          detail: `attempt ${action.attempt} was claimed but never launched (owner ${action.ownerId} is gone); retrying under a fresh, budgeted attempt`,
        },
      ]);
      return cleared === undefined ? { kind: "conflict" } : { kind: "advanced", plan: cleared };
    }

    return this.failClosed(
      plan,
      `planner attempt ${action.attempt} for revision ${action.revision} (${action.correlationTag}) was RUNNING under owner ${action.ownerId}, which is no longer live here; its outcome cannot be determined and a second planner run must not be launched`,
    );
  }

  private async stepPlanner(plan: Plan): Promise<StepResult> {
    // Reconcile BEFORE the budget check: a lingering lease must never be left
    // behind on a plan that is about to be blocked or retried.
    const reconciled = await this.reconcilePlannerAction(plan);
    if (reconciled !== undefined) {
      return reconciled;
    }
    // PLANNING without a lease is not a state any code path can produce (the
    // claim writes both in one CAS). Encountering it means the row was written
    // by something else, so what the planner did — if anything — is unknowable.
    if (plan.phase === "PLANNING") {
      return this.failClosed(
        plan,
        "phase is PLANNING but no planner lease is recorded; the outcome of the claimed planner action cannot be determined",
      );
    }

    const problem = this.plannerBudgetProblem(plan);
    if (problem !== undefined) {
      return this.blockPlan(plan, problem.reason, problem.kind, "BUDGET_EXHAUSTED");
    }

    const revisionNumber = plan.revisions.length + 1;
    const attempt = plan.attemptsForCurrentRevision + 1;
    const correlationTag = canonicalPlannerActionTag(plan.id, revisionNumber, attempt);

    // CLAIM before any side effect. Charging the budget here (rather than after
    // a successful launch) is deliberate: an attempt that may have run must
    // cost the same as one that certainly did.
    const claimed = await this.commit(
      plan,
      {
        ...plan,
        phase: "PLANNING",
        plannerAction: {
          revision: revisionNumber,
          attempt,
          correlationTag,
          ownerId: this.ownerId,
          state: "CLAIMED",
          claimedAt: this.clock.now(),
        },
        attemptsForCurrentRevision: attempt,
        totalPlannerRuns: plan.totalPlannerRuns + 1,
      },
      [{ kind: "PLANNER_RUN_STARTED", detail: `revision ${revisionNumber} attempt ${attempt} (${correlationTag})` }],
    );
    if (claimed === undefined) {
      return { kind: "conflict" };
    }
    // Synchronous with winning the claim, so any caller that reads this plan
    // afterwards sees the lease as live rather than abandoned.
    this.plannerActionsInFlight.add(plan.id);
    try {
      return await this.runPlannerAction(claimed, revisionNumber, attempt, correlationTag);
    } finally {
      this.plannerActionsInFlight.delete(plan.id);
    }
  }

  private async runPlannerAction(
    claimedPlan: Plan,
    revisionNumber: number,
    attempt: number,
    correlationTag: string,
  ): Promise<StepResult> {
    // Second durable write: from here on, the launch may have happened, so a
    // lost owner means RECOVERY_REQUIRED rather than a free retry.
    const action = claimedPlan.plannerAction;
    if (action === undefined) {
      return { kind: "conflict" };
    }
    const claimed = await this.commit(claimedPlan, { ...claimedPlan, plannerAction: { ...action, state: "RUNNING" } }, []);
    if (claimed === undefined) {
      return { kind: "conflict" };
    }

    const answered: PlannerQuestionAnswer[] = claimed.answers.map((entry) => ({ question: entry.question, answer: entry.answer }));
    const previousRejection = lastRejectionReason(claimed);

    this.log(`[plan ${claimed.id}] planning revision ${revisionNumber} (attempt ${attempt})`);

    let rawOutput = "";
    let status: "SUCCEEDED" | "FAILED" = "FAILED";
    let summary = "";
    try {
      const outcome = await this.planner.plan({
        planId: claimed.id,
        revision: revisionNumber,
        attempt,
        correlationTag,
        projectKey: claimed.projectId,
        intent: claimed.intent,
        constraints: claimed.declaredConstraints,
        answeredQuestions: answered,
        projectRules: this.projectRules,
        outputContract: PLANNER_OUTPUT_CONTRACT,
        ...(previousRejection === undefined ? {} : { previousRejection }),
      });
      status = outcome.status;
      rawOutput = outcome.rawOutput;
      summary = outcome.summary;
    } catch (error) {
      status = "FAILED";
      summary = `planner threw: ${error instanceof Error ? error.message : String(error)}`;
    }

    // Every settle path below moves the phase away from PLANNING, and `commit`
    // releases the lease with that same write — so a lease can never outlive
    // the action it describes.
    const current = await this.requirePlan(claimed.id);
    if (current.version !== claimed.version) {
      return { kind: "conflict" };
    }

    if (status === "FAILED") {
      // A crashed planner's output never reaches the contract parser, exactly
      // as a FAILED reviewer run's output never reaches the verdict parser.
      const next = await this.commit(current, { ...current, phase: "DRAFT" }, [
        { kind: "PLANNER_RUN_FAILED", detail: `attempt ${attempt}: ${summary}` },
      ]);
      return next === undefined ? { kind: "conflict" } : { kind: "advanced", plan: next };
    }

    const parsed = parsePlannerOutput(rawOutput);
    if (!parsed.ok) {
      const next = await this.commit(current, { ...current, phase: "DRAFT" }, [
        { kind: "PLANNER_OUTPUT_REJECTED", detail: `attempt ${attempt}: ${parsed.reason}` },
      ]);
      return next === undefined ? { kind: "conflict" } : { kind: "advanced", plan: next };
    }

    // Asking is not planning: a response with blocking questions yields no
    // approvable revision at all (TASK-005 §6).
    if (parsed.proposal.blockingQuestions.length > 0) {
      if (current.clarificationCycles >= current.budget.maxClarificationCycles) {
        return this.blockPlan(
          current,
          `clarification budget exhausted (${current.clarificationCycles}/${current.budget.maxClarificationCycles} cycles) and the planner still reports blocking ambiguity`,
          "CLARIFICATION_CYCLES",
          "BUDGET_EXHAUSTED",
        );
      }
      const next = await this.commit(
        current,
        {
          ...current,
          phase: "NEEDS_CLARIFICATION",
          openQuestions: parsed.proposal.blockingQuestions,
          clarificationCycles: current.clarificationCycles + 1,
          attemptsForCurrentRevision: 0,
        },
        [
          {
            kind: "CLARIFICATION_REQUESTED",
            detail: `${parsed.proposal.blockingQuestions.length} blocking question(s): ${parsed.proposal.blockingQuestions
              .map((question) => question.id)
              .join(", ")}`,
          },
        ],
      );
      return next === undefined ? { kind: "conflict" } : { kind: "halt", plan: next };
    }

    const validation = validateProposal(parsed.proposal);
    if (!validation.ok) {
      // Never show a human malformed content to approve.
      const next = await this.commit(current, { ...current, phase: "DRAFT" }, [
        { kind: "PLANNER_OUTPUT_REJECTED", detail: `attempt ${attempt}: ${validation.reason}` },
      ]);
      return next === undefined ? { kind: "conflict" } : { kind: "advanced", plan: next };
    }

    const generatedAt = this.clock.now();
    const digest = computePlanContentDigest({
      revision: revisionNumber,
      summary: parsed.proposal.summary,
      assumptions: parsed.proposal.assumptions,
      constraints: parsed.proposal.constraints,
      risks: parsed.proposal.risks,
      items: parsed.proposal.items,
    });
    const revision: PlanRevision = {
      revision: revisionNumber,
      summary: parsed.proposal.summary,
      assumptions: parsed.proposal.assumptions,
      constraints: parsed.proposal.constraints,
      risks: parsed.proposal.risks,
      items: parsed.proposal.items,
      contentDigest: digest,
      plannerRunRef: correlationTag,
      generatedAt,
    };

    const next = await this.commit(
      current,
      { ...current, phase: "PLAN_REVIEW", revisions: [...current.revisions, revision], attemptsForCurrentRevision: 0, openQuestions: [] },
      [
        { kind: "REVISION_GENERATED", detail: `revision ${revisionNumber} (${digest}) with ${revision.items.length} work item(s)` },
        { kind: "ENTERED_PLAN_REVIEW", detail: `revision ${revisionNumber} awaits a trusted human decision` },
      ],
    );
    if (next === undefined) {
      return { kind: "conflict" };
    }
    this.log(`[plan ${next.id}] revision ${revisionNumber} awaits human approval (${revision.items.length} item(s))`);
    return { kind: "halt", plan: next };
  }

  // =====================================================================
  // Authority
  // =====================================================================

  /**
   * Re-derives, from authoritative Factory records, that a human really did
   * approve THIS plan's currently-approved revision AND that the live revision
   * content still hashes to what was approved.
   *
   * Both halves matter. The gate proves a human decided; the digest proves the
   * content did not change afterwards. Either alone is exactly the weakness
   * TASK-004's release-snapshot work existed to close.
   */
  private async verifyApprovalAuthority(plan: Plan): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (plan.approvalId === undefined || plan.approvedRevision === undefined || plan.approvedDigest === undefined) {
      return { ok: false, reason: "no approval is recorded on this plan" };
    }
    const revision = plan.revisions.find((entry) => entry.revision === plan.approvedRevision);
    if (revision === undefined) {
      return { ok: false, reason: `approved revision ${plan.approvedRevision} no longer exists on this plan` };
    }
    // A newer revision means the human decided about something older.
    if (plan.revisions.length !== plan.approvedRevision) {
      return {
        ok: false,
        reason: `this plan now has ${plan.revisions.length} revision(s); the approval of revision ${plan.approvedRevision} is superseded`,
      };
    }
    // ROUND 1, HIGH 4: recomputed from LIVE content AND live configuration, not
    // read back from the stored `contentDigest` field and not limited to the
    // revision — switching `projectId` or rewriting `execution` changes what
    // gets built and where, so it must change this hash.
    const digest = approvalDigestOfPlan(plan, revision);
    if (digest !== plan.approvedDigest) {
      return {
        ok: false,
        reason: `plan content/configuration digest ${digest} no longer matches the approved ${plan.approvedDigest}`,
      };
    }
    // The gate proves the CURRENT decision for this plan approves exactly this
    // revision and this content: a later rejection, or an approval of anything
    // else, fails here.
    const gate = await this.factory.gateStatus("PLAN_APPROVAL", planSubject(plan.id), {
      specRevision: plan.approvedRevision,
      planContentDigest: plan.approvedDigest,
    });
    if (!gate.satisfied) {
      return { ok: false, reason: `PLAN_APPROVAL gate is not satisfied: ${gate.reason}` };
    }

    // ...and the approval this plan actually recorded must itself still be a
    // real, human, identically-bound decision. Checked separately rather than
    // by comparing ids with `gate.approval`: two legitimate approvals of the
    // same content (a retried or double-submitted decision) are harmless and
    // must not brick the plan, while a stale, forged, non-human or
    // differently-bound recorded id must still be refused.
    const approvals = await this.factory.listApprovals(planSubject(plan.id));
    const recorded = approvals.find((approval) => approval.id === plan.approvalId);
    if (recorded === undefined) {
      return { ok: false, reason: `the recorded approval ${plan.approvalId} does not exist` };
    }
    if (recorded.gate !== "PLAN_APPROVAL" || recorded.decision !== "APPROVED") {
      return { ok: false, reason: `the recorded approval ${recorded.id} is a ${recorded.gate} ${recorded.decision}` };
    }
    if (recorded.decidedBy.kind !== "HUMAN") {
      return { ok: false, reason: `the recorded approval ${recorded.id} was decided by actor kind ${recorded.decidedBy.kind}` };
    }
    if (recorded.context?.specRevision !== plan.approvedRevision || recorded.context?.planContentDigest !== plan.approvedDigest) {
      return {
        ok: false,
        reason: `the recorded approval ${recorded.id} is bound to revision ${String(recorded.context?.specRevision)} / content ${String(recorded.context?.planContentDigest)}, not the approved ${plan.approvedRevision} / ${plan.approvedDigest}`,
      };
    }
    return { ok: true };
  }

  private approvedRevisionOf(plan: Plan): PlanRevision | undefined {
    return plan.approvedRevision === undefined
      ? undefined
      : plan.revisions.find((entry) => entry.revision === plan.approvedRevision);
  }

  /**
   * Reads a materialized work item's ACTUAL shape from authoritative Factory
   * state, so it can be compared against what the approved plan says it must
   * be. Returns a reason instead of throwing when the item is gone: a dangling
   * reference is a recoverable state to report, not a runtime surprise to
   * propagate out of the middle of a drive step (round 1, HIGH 7).
   */
  private async actualShapeOf(workItemId: WorkItemId): Promise<BindingResult<MaterializedItemShape>> {
    let item: WorkItem;
    try {
      item = await this.factory.getWorkItem(workItemId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return { ok: false, reason: `work item ${workItemId} no longer exists` };
      }
      throw error;
    }
    const criteria = await this.factory.listCriteria(workItemId);
    return {
      ok: true,
      value: {
        projectId: item.projectId,
        correlationTag: item.planVersion,
        title: item.title,
        type: item.type,
        priority: item.priority,
        specRevision: item.specRevision,
        dependencyWorkItemIds: [...item.dependencies],
        acceptanceCriteria: criteria.map((criterion) => ({
          text: criterion.text,
          verificationHint: criterion.verificationHint,
        })),
      },
    };
  }

  /**
   * Proves the CANDIDATE work item is exactly the approved plan item — the
   * central round-1 invariant. `planItemKey` names which approved item it is
   * supposed to be; everything else is derived from the approved revision and
   * from the plan's own materialization mappings.
   */
  private async matchesApprovedItem(
    plan: Plan,
    revision: PlanRevision,
    planItemKey: string,
    candidateId: WorkItemId,
  ): Promise<BindingResult<MaterializedItemShape>> {
    const item = revision.items.find((entry) => entry.key === planItemKey);
    if (item === undefined) {
      return { ok: false, reason: `approved revision ${revision.revision} has no item "${planItemKey}"` };
    }
    const dependencies = this.approvedDependencyIds(plan, item);
    if (!dependencies.ok) {
      return dependencies;
    }
    const expected = expectedMaterializedItemShape(
      plan.projectId,
      canonicalCorrelationTag(plan.id, revision.revision, planItemKey),
      item,
      dependencies.value,
    );
    const actual = await this.actualShapeOf(candidateId);
    if (!actual.ok) {
      return actual;
    }
    const comparison = compareMaterializedItemShape(expected, actual.value);
    if (!comparison.ok) {
      return { ok: false, reason: `work item ${candidateId} for "${planItemKey}": ${comparison.reason}` };
    }
    return { ok: true, value: actual.value };
  }

  private approvedDependencyIds(plan: Plan, item: PlannedWorkItem): BindingResult<readonly WorkItemId[]> {
    const ids: WorkItemId[] = [];
    for (const dependencyKey of item.dependsOn) {
      const mapped = plan.materialized.find((entry) => entry.planItemKey === dependencyKey);
      if (mapped === undefined) {
        return { ok: false, reason: `dependency "${dependencyKey}" of "${item.key}" is not materialized` };
      }
      ids.push(mapped.workItemId);
    }
    return { ok: true, value: ids };
  }

  /**
   * ROUND 1, HIGH 7. Every recorded mapping must still resolve to a real work
   * item that is still exactly the approved item. Applied on the read path and
   * before every drive step that acts on materialized state, so `status()` and
   * `resume()` can never disagree about whether a plan is executable.
   */
  private async verifyMaterializationIntegrity(plan: Plan): Promise<{ ok: true } | { ok: false; reason: string }> {
    const revision = this.approvedRevisionOf(plan);
    if (revision === undefined) {
      return plan.materialized.length === 0
        ? { ok: true }
        : { ok: false, reason: "work items are mapped to this plan but it has no approved revision" };
    }
    for (const mapping of plan.materialized) {
      const match = await this.matchesApprovedItem(plan, revision, mapping.planItemKey, mapping.workItemId);
      if (!match.ok) {
        return { ok: false, reason: `materialization mapping is not sound: ${match.reason}` };
      }
    }
    return { ok: true };
  }

  /**
   * ROUND 2, the second review's remaining HIGH. The sibling of the check
   * above, and the one round 1 missed: `plan.dispatches` holds foreign
   * references too, and a `loopId` is no more proof of a loop than a
   * `workItemId` was proof of a work item.
   *
   * The reviewer mutated a dispatch's `loopId` to a value naming no loop;
   * `status()` reported `EXECUTING` and `resume()` threw a raw
   * `no scripted loop ...` error out of the middle of a drive step. Probing
   * further while fixing it found the stronger case the review did not test:
   * two dispatches whose `loopId`s were SWAPPED both named real, live loops, so
   * an existence check alone would have accepted a plan whose every item was
   * wired to another item's execution.
   *
   * So lineage, not existence, is what is verified — and it is verified through
   * the accepted TASK-004 read API rather than a new one. `find(workItemId)`
   * answers "which loop does this work item actually have", which makes one
   * comparison cover both failures at once: a missing loop yields no view or a
   * different id, and a substituted loop yields a different id. Planning gains
   * no new reach into TASK-004, and no weaker second authority model.
   *
   * The resolved views are RETURNED, not just validated, so the caller that
   * needs a loop's phase uses the view proven to belong to this dispatch
   * instead of looking the id up again — which is how the raw throw is removed
   * rather than merely caught.
   */
  private async resolveDispatchViews(plan: Plan): Promise<BindingResult<ReadonlyMap<string, DispatchedLoopView>>> {
    const revision = this.approvedRevisionOf(plan);
    if (revision === undefined) {
      return plan.dispatches.length === 0
        ? { ok: true, value: new Map() }
        : { ok: false, reason: "loops are dispatched for this plan but it has no approved revision" };
    }
    const views = new Map<string, DispatchedLoopView>();
    const seenLoopIds = new Set<string>();
    for (const dispatch of plan.dispatches) {
      const label = `dispatch of "${dispatch.planItemKey}"`;
      if (!revision.items.some((item) => item.key === dispatch.planItemKey)) {
        return { ok: false, reason: `${label} names a plan item that is not in the approved revision` };
      }
      const mapping = plan.materialized.find((entry) => entry.planItemKey === dispatch.planItemKey);
      if (mapping === undefined) {
        return { ok: false, reason: `${label} has no materialization mapping` };
      }
      if (mapping.workItemId !== dispatch.workItemId) {
        return {
          ok: false,
          reason: `${label} names work item ${dispatch.workItemId}, but its mapping names ${mapping.workItemId}`,
        };
      }
      if (dispatch.loopId.trim().length === 0) {
        return { ok: false, reason: `${label} records an empty loop id` };
      }
      // Two plan items may never share one loop, whatever the rows say.
      if (seenLoopIds.has(dispatch.loopId)) {
        return { ok: false, reason: `${label} reuses loop ${dispatch.loopId}, which another plan item already claims` };
      }
      seenLoopIds.add(dispatch.loopId);

      const actual = await this.dispatcher.find(dispatch.workItemId);
      if (actual === undefined) {
        return {
          ok: false,
          reason: `${label} records loop ${dispatch.loopId}, but work item ${dispatch.workItemId} has no engineering loop at all`,
        };
      }
      if (actual.loopId !== dispatch.loopId) {
        return {
          ok: false,
          reason: `${label} records loop ${dispatch.loopId}, but work item ${dispatch.workItemId}'s loop is ${actual.loopId}`,
        };
      }
      if (actual.workItemId !== dispatch.workItemId) {
        return {
          ok: false,
          reason: `loop ${dispatch.loopId} targets work item ${actual.workItemId}, not the dispatched ${dispatch.workItemId}`,
        };
      }
      views.set(dispatch.planItemKey, actual);
    }
    return { ok: true, value: views };
  }

  // =====================================================================
  // Materialization
  // =====================================================================

  private async stepMaterialize(plan: Plan): Promise<StepResult> {
    const problem = await this.authorityProblem(plan, "act");
    if (problem !== undefined) {
      return this.failClosed(plan, `refusing to materialize: ${problem}`);
    }
    const revision = this.approvedRevisionOf(plan);
    if (revision === undefined) {
      return this.failClosed(plan, "refusing to materialize: the approved revision is missing");
    }
    const order = topologicalOrder(revision.items);
    if (!order.ok) {
      return this.failClosed(plan, `refusing to materialize: ${order.reason}`);
    }

    if (plan.phase === "APPROVED") {
      const started = await this.commit(plan, { ...plan, phase: "MATERIALIZING" }, [
        { kind: "MATERIALIZATION_STARTED", detail: `revision ${revision.revision} with ${revision.items.length} item(s)` },
      ]);
      return started === undefined ? { kind: "conflict" } : { kind: "advanced", plan: started };
    }

    // 1. Reconcile a dangling claim BEFORE anything else: a crash between
    //    claiming and creating is the one window where a work item may or may
    //    not exist, and it is resolved by exact correlation-tag match against
    //    authoritative Factory state — never by guessing.
    if (plan.materializationClaim !== undefined) {
      return this.reconcileMaterializationClaim(plan, revision);
    }

    // 2. Create the next unmaterialized item, in dependency order.
    const materializedKeys = new Set(plan.materialized.map((entry) => entry.planItemKey));
    const nextKey = order.order.find((key) => !materializedKeys.has(key));
    if (nextKey !== undefined) {
      return this.claimAndCreate(plan, revision, nextKey);
    }

    // 3. Ready the next materialized-but-not-ready item.
    const pending = plan.materialized.find((entry) => !entry.readied);
    if (pending !== undefined) {
      return this.readyItem(plan, revision, pending.planItemKey);
    }

    // 4. Everything exists and is READY.
    const advanced = await this.commit(plan, { ...plan, phase: "EXECUTING" }, [
      { kind: "WORK_ITEM_READIED", detail: `all ${plan.materialized.length} work item(s) are READY` },
    ]);
    return advanced === undefined ? { kind: "conflict" } : { kind: "advanced", plan: advanced };
  }

  private async findByCorrelationTag(projectId: ProjectId, tag: string): Promise<WorkItem | undefined> {
    const items = await this.factory.listWorkItemsByProject(projectId);
    return items.find((item) => item.planVersion === tag);
  }

  /**
   * ROUND 1, HIGH 3. A correlation tag makes a work item a CANDIDATE. Adoption
   * additionally requires that the candidate is, field for field, the item the
   * human approved — otherwise a caller who guessed the tag (it is a pure
   * function of public coordinates) could have arbitrary content adopted as
   * approved work.
   *
   * A mismatch fails closed. It deliberately does NOT create a second work item
   * with the same tag, and deliberately does NOT edit the impostor into
   * compliance: both would be this service deciding, unattended, what a human
   * approved.
   */
  private async adoptIfApproved(
    plan: Plan,
    revision: PlanRevision,
    planItemKey: string,
    candidate: WorkItem,
    detail: string,
  ): Promise<StepResult> {
    const match = await this.matchesApprovedItem(plan, revision, planItemKey, candidate.id);
    if (!match.ok) {
      return this.failClosed(
        plan,
        `refusing to adopt ${candidate.id} for "${planItemKey}": it carries the canonical correlation tag but is not the approved item (${match.reason})`,
      );
    }
    const { materializationClaim: _dropped, ...withoutClaim } = plan;
    void _dropped;
    const adopted = await this.commit(
      plan,
      {
        ...withoutClaim,
        materialized: [
          ...plan.materialized,
          {
            planItemKey,
            workItemId: candidate.id,
            correlationTag: canonicalCorrelationTag(plan.id, revision.revision, planItemKey),
            materializedAt: this.clock.now(),
            readied: false,
          },
        ],
      },
      [{ kind: "WORK_ITEM_MATERIALIZED", detail }],
    );
    return adopted === undefined ? { kind: "conflict" } : { kind: "advanced", plan: adopted };
  }

  private async reconcileMaterializationClaim(plan: Plan, revision: PlanRevision): Promise<StepResult> {
    const claim = plan.materializationClaim;
    if (claim === undefined) {
      return { kind: "conflict" };
    }
    const existing = await this.findByCorrelationTag(plan.projectId, claim.correlationTag);
    const { materializationClaim: _dropped, ...withoutClaim } = plan;
    void _dropped;

    if (existing === undefined) {
      // The create never committed. Clear the claim and let the normal path
      // retry — no duplicate is possible because nothing exists.
      const cleared = await this.commit(plan, { ...withoutClaim }, [
        {
          kind: "WORK_ITEM_MATERIALIZED",
          detail: `claim for "${claim.planItemKey}" found no committed work item; retrying creation`,
        },
      ]);
      return cleared === undefined ? { kind: "conflict" } : { kind: "advanced", plan: cleared };
    }

    return this.adoptIfApproved(
      plan,
      revision,
      claim.planItemKey,
      existing,
      `adopted existing ${existing.id} for "${claim.planItemKey}" after restart`,
    );
  }

  private async claimAndCreate(plan: Plan, revision: PlanRevision, planItemKey: string): Promise<StepResult> {
    const item = revision.items.find((entry) => entry.key === planItemKey);
    if (item === undefined) {
      return this.failClosed(plan, `approved revision has no item "${planItemKey}"`);
    }
    const correlationTag = canonicalCorrelationTag(plan.id, revision.revision, planItemKey);

    // Defensive: if a work item with this exact tag already exists, adopt it
    // instead of creating a second one — but only if it really is the approved
    // item (round 1, HIGH 3). This makes the step idempotent without making the
    // tag a credential.
    const alreadyThere = await this.findByCorrelationTag(plan.projectId, correlationTag);
    if (alreadyThere !== undefined) {
      return this.adoptIfApproved(
        plan,
        revision,
        planItemKey,
        alreadyThere,
        `adopted pre-existing ${alreadyThere.id} for "${planItemKey}"`,
      );
    }

    // CLAIM before the side effect (TASK-004's protocol): if a cancellation
    // committed first, this CAS loses and no work item is ever created.
    const claimed = await this.commit(
      plan,
      { ...plan, materializationClaim: { planItemKey, correlationTag, claimedAt: this.clock.now() } },
      [],
    );
    if (claimed === undefined) {
      return { kind: "conflict" };
    }

    const resolved = this.approvedDependencyIds(claimed, item);
    if (!resolved.ok) {
      return this.failClosed(claimed, resolved.reason);
    }
    const dependencies = resolved.value;

    const created = await this.factory.createWorkItem({
      projectId: claimed.projectId,
      title: item.title,
      type: item.type,
      priority: item.priority,
      // The correlation tag IS the planVersion: durably written by the accepted
      // createWorkItem in the same transaction that creates the item, which is
      // what makes crash reconciliation exact rather than heuristic.
      planVersion: correlationTag,
      dependencies,
      acceptanceCriteria: item.acceptanceCriteria.map((criterion) => ({
        text: criterion.text,
        verificationHint: criterion.verificationHint,
      })),
    });

    const fresh = await this.requirePlan(claimed.id);
    const { materializationClaim: _dropped, ...withoutClaim } = fresh;
    void _dropped;
    const committed = await this.commit(
      fresh,
      {
        ...withoutClaim,
        materialized: [
          ...fresh.materialized,
          { planItemKey, workItemId: created.id, correlationTag, materializedAt: this.clock.now(), readied: false },
        ],
      },
      [{ kind: "WORK_ITEM_MATERIALIZED", detail: `"${planItemKey}" -> ${created.id}` }],
    );
    if (committed === undefined) {
      // The work item is durable and tagged; the next pass adopts it by tag.
      return { kind: "conflict" };
    }
    this.log(`[plan ${plan.id}] materialized "${planItemKey}" as ${created.id}`);
    return { kind: "advanced", plan: committed };
  }

  /**
   * Walks one materialized item IDEA -> ANALYSIS -> PLAN_REVIEW -> READY,
   * recording the derived per-item PLAN_APPROVAL at the one status where that
   * gate is decidable. Every step is idempotent against live status, so a crash
   * anywhere in the walk resumes without repeating a completed step.
   */
  private async readyItem(plan: Plan, revision: PlanRevision, planItemKey: string): Promise<StepResult> {
    // Two concurrent drives may both try to walk the same item forward. The
    // loser's Factory CAS legitimately fails; that is a race to re-read, not an
    // error to propagate out of a resume() the caller asked for.
    try {
      return await this.readyItemStep(plan, revision, planItemKey);
    } catch (error) {
      if (error instanceof ConcurrencyError) {
        return { kind: "conflict" };
      }
      throw error;
    }
  }

  private async readyItemStep(plan: Plan, revision: PlanRevision, planItemKey: string): Promise<StepResult> {
    const mapping = plan.materialized.find((entry) => entry.planItemKey === planItemKey);
    if (mapping === undefined) {
      return this.failClosed(plan, `no materialized mapping for "${planItemKey}"`);
    }
    // The mapping must still describe the approved content — the WHOLE of it,
    // not just the tag (round 1, HIGH 1/HIGH 3). This is the step that creates
    // execution authority, so it re-proves the target here even though the
    // drive step already checked mapping integrity.
    const match = await this.matchesApprovedItem(plan, revision, planItemKey, mapping.workItemId);
    if (!match.ok) {
      return this.failClosed(plan, `refusing to ready "${planItemKey}": ${match.reason}`);
    }
    const workItem = await this.factory.getWorkItem(mapping.workItemId);

    const orchestrator = this.orchestratorActor();

    if (workItem.status === "IDEA") {
      await this.factory.advance(workItem.id, "ANALYSIS", orchestrator, `plan ${plan.id} materialization`);
      return { kind: "advanced", plan };
    }
    if (workItem.status === "ANALYSIS") {
      await this.factory.advance(workItem.id, "PLAN_REVIEW", orchestrator, `plan ${plan.id} materialization`);
      return { kind: "advanced", plan };
    }
    if (workItem.status === "PLAN_REVIEW") {
      const gate = await this.factory.gateStatus("PLAN_APPROVAL", this.factory.workItemSubject(workItem.id), {
        specRevision: workItem.specRevision,
      });
      if (!gate.satisfied) {
        if (plan.approvalId === undefined) {
          return this.failClosed(plan, "cannot derive a work item approval without a recorded plan approval");
        }
        // Only three identifiers travel: which plan, which human decision, and
        // which work item. What that decision covers, and what the work item is
        // required to contain, are re-derived inside FactoryService from the
        // durable plan through PlanBindingResolver — this service cannot widen
        // its own authority by describing the target favourably (round 1,
        // HIGH 1/HIGH 2).
        await this.factory.recordDerivedPlanApproval({
          workItemId: workItem.id,
          sourceApprovalId: plan.approvalId,
          planId: plan.id,
        });
      }
      await this.factory.advance(workItem.id, "READY", orchestrator, `plan ${plan.id} approved revision ${revision.revision}`);
      return { kind: "advanced", plan };
    }
    if (workItem.status === "READY" || workItem.status === "IMPLEMENTING" || workItem.status === "VERIFYING" || workItem.status === "REVIEW" || workItem.status === "WAITING_FOR_HUMAN" || workItem.status === "DONE") {
      const committed = await this.commit(
        plan,
        {
          ...plan,
          materialized: plan.materialized.map((entry) =>
            entry.planItemKey === planItemKey ? { ...entry, readied: true } : entry,
          ),
        },
        [{ kind: "WORK_ITEM_READIED", detail: `"${planItemKey}" (${workItem.id}) is ${workItem.status}` }],
      );
      return committed === undefined ? { kind: "conflict" } : { kind: "advanced", plan: committed };
    }

    // BLOCKED or CANCELLED: this item cannot proceed, and neither can anything
    // downstream of it.
    return this.blockPlan(
      plan,
      `work item ${workItem.id} for "${planItemKey}" is ${workItem.status}; planned execution cannot continue`,
      undefined,
      "BLOCKED",
    );
  }

  // =====================================================================
  // Execution / dispatch
  // =====================================================================

  /**
   * Prerequisite satisfaction is EXECUTION FINISHED, not RELEASED.
   *
   * `DONE` means a human granted release approval. `WAITING_FOR_HUMAN` means
   * the loop finished and an independent review passed — but only if that
   * authority still holds right now, which is why this asks the accepted
   * `resolveWaitingForHumanAuthority` resolver rather than reading the status
   * field. A stale or superseded WAITING_FOR_HUMAN satisfies nothing.
   */
  private async isExecutionFinished(workItemId: WorkItemId): Promise<boolean> {
    const item = await this.factory.getWorkItem(workItemId);
    if (item.status === "DONE") {
      return true;
    }
    if (item.status !== LOOP_PHASE_EXECUTION_FINISHED) {
      return false;
    }
    const authority = await this.factory.resolveWaitingForHumanAuthority(workItemId);
    return authority.ok;
  }

  private async stepExecute(plan: Plan, expectApprovedDigest?: string): Promise<StepResult> {
    const problem = await this.authorityProblem(plan, "act");
    if (problem !== undefined) {
      return this.failClosed(plan, `refusing to dispatch: ${problem}`);
    }
    const revision = this.approvedRevisionOf(plan);
    if (revision === undefined) {
      return this.failClosed(plan, "refusing to dispatch: the approved revision is missing");
    }
    const order = topologicalOrder(revision.items);
    if (!order.ok) {
      return this.failClosed(plan, `refusing to dispatch: ${order.reason}`);
    }

    if (plan.dispatchClaim !== undefined) {
      return this.reconcileDispatchClaim(plan);
    }

    const dispatchedKeys = new Set(plan.dispatches.map((entry) => entry.planItemKey));

    // Round 2: use the views `authorityProblem` already proved belong to this
    // plan's dispatches, rather than looking each loop id up again. Re-reading
    // by id is what allowed a missing loop to throw a raw adapter error from
    // the middle of a drive step; a proven view cannot.
    const resolved = await this.resolveDispatchViews(plan);
    if (!resolved.ok) {
      return this.failClosed(plan, `refusing to dispatch: dispatch record is not sound: ${resolved.reason}`);
    }

    // Any already-dispatched loop that ended badly stops the whole plan: its
    // dependents must not run on top of failed work.
    for (const dispatch of plan.dispatches) {
      const view = resolved.value.get(dispatch.planItemKey);
      if (view === undefined) {
        return this.failClosed(plan, `refusing to dispatch: no proven loop view for "${dispatch.planItemKey}"`);
      }
      if (LOOP_PHASES_BLOCKING.includes(view.phase)) {
        return this.blockPlan(
          plan,
          `work item ${dispatch.workItemId} for "${dispatch.planItemKey}" ended in loop phase ${view.phase}${
            view.failureReason === undefined ? "" : `: ${view.failureReason}`
          }`,
          undefined,
          "ITEM_TERMINAL",
        );
      }
    }

    for (const key of order.order) {
      if (dispatchedKeys.has(key)) {
        continue;
      }
      const mapping = plan.materialized.find((entry) => entry.planItemKey === key);
      if (mapping === undefined || !mapping.readied) {
        return this.failClosed(plan, `plan item "${key}" is not materialized and readied but dispatch was attempted`);
      }
      const item = revision.items.find((entry) => entry.key === key);
      if (item === undefined) {
        return this.failClosed(plan, `approved revision has no item "${key}"`);
      }

      // Every prerequisite must be execution-finished with live authority.
      let ready = true;
      for (const dependencyKey of item.dependsOn) {
        const dependency = plan.materialized.find((entry) => entry.planItemKey === dependencyKey);
        if (dependency === undefined) {
          return this.failClosed(plan, `dependency "${dependencyKey}" of "${key}" is not materialized`);
        }
        if (!(await this.isExecutionFinished(dependency.workItemId))) {
          ready = false;
          break;
        }
      }
      if (!ready) {
        continue;
      }
      return this.claimAndDispatch(
        plan,
        key,
        mapping.workItemId,
        item.spec,
        item.title,
        item.acceptanceCriteria,
        expectApprovedDigest,
      );
    }

    // Nothing new to dispatch — derive where the plan stands from authoritative
    // WorkItem state, never from "the agents said they were done".
    return this.deriveCompletion(plan, revision.items.length);
  }

  private async reconcileDispatchClaim(plan: Plan): Promise<StepResult> {
    const claim = plan.dispatchClaim;
    if (claim === undefined) {
      return { kind: "conflict" };
    }
    const { dispatchClaim: _dropped, ...withoutClaim } = plan;
    void _dropped;

    const existing = await this.dispatcher.find(claim.workItemId);
    if (existing === undefined) {
      const cleared = await this.commit(plan, { ...withoutClaim }, [
        { kind: "DISPATCHED", detail: `claim for "${claim.planItemKey}" found no started loop; retrying dispatch` },
      ]);
      return cleared === undefined ? { kind: "conflict" } : { kind: "advanced", plan: cleared };
    }

    const adopted = await this.commit(
      plan,
      {
        ...withoutClaim,
        dispatches: [
          ...plan.dispatches,
          {
            planItemKey: claim.planItemKey,
            workItemId: claim.workItemId,
            loopId: existing.loopId,
            dispatchedAt: this.clock.now(),
            adopted: true,
          },
        ],
      },
      [{ kind: "DISPATCHED", detail: `adopted existing loop ${existing.loopId} for "${claim.planItemKey}" after restart` }],
    );
    return adopted === undefined ? { kind: "conflict" } : { kind: "advanced", plan: adopted };
  }

  private async claimAndDispatch(
    plan: Plan,
    planItemKey: string,
    workItemId: WorkItemId,
    spec: string,
    title: string,
    acceptanceCriteria: readonly { readonly text: string; readonly verificationHint: string }[],
    expectApprovedDigest?: string,
  ): Promise<StepResult> {
    // Adopt before starting: combined with TASK-004's database-level
    // one-active-loop-per-work-item constraint, a duplicate loop cannot exist
    // even if this check and a concurrent start race.
    const existing = await this.dispatcher.find(workItemId);
    if (existing !== undefined) {
      const adopted = await this.commit(
        plan,
        {
          ...plan,
          dispatches: [
            ...plan.dispatches,
            { planItemKey, workItemId, loopId: existing.loopId, dispatchedAt: this.clock.now(), adopted: true },
          ],
        },
        [{ kind: "DISPATCHED", detail: `adopted existing loop ${existing.loopId} for "${planItemKey}"` }],
      );
      return adopted === undefined ? { kind: "conflict" } : { kind: "advanced", plan: adopted };
    }

    // CLAIM before the side effect: a cancellation that committed first wins
    // this CAS, and the loop is never started.
    const claimed = await this.commit(plan, { ...plan, dispatchClaim: { planItemKey, workItemId, claimedAt: this.clock.now() } }, []);
    if (claimed === undefined) {
      return { kind: "conflict" };
    }

    /**
     * THE LAST CHECK BEFORE A WORKER STARTS (TASK-015 round-3 finding 1).
     *
     * `drive()` checks the pin at the top of each step, and this method then
     * commits a claim and starts a worker -- so an approval replaced between
     * those two moments was launched anyway, and only the NEXT loop read
     * noticed. The reviewer measured it: two workers started, then the
     * mismatch threw.
     *
     * This is the THIRD place this window has appeared in this task: before
     * the child, then before `drive()`, now before `start()`. The lesson is
     * that every re-read is a new opportunity, so the check belongs at the
     * point of the side effect rather than anywhere upstream of it.
     *
     * Re-read from the repository rather than trusting `plan`, because
     * `plan` is exactly the copy that may have gone stale.
     */
    if (expectApprovedDigest !== undefined) {
      const atStart = await this.plans.findById(plan.id);
      if (atStart?.approvedDigest !== expectApprovedDigest) {
        throw new ValidationError(
          `plan ${plan.id} is no longer the approval that was authorized: expected digest ` +
            `${expectApprovedDigest}, found ${atStart?.approvedDigest ?? "none"}. Refusing to start a worker.`,
        );
      }
    }

    const instructions = buildTaskInstructions(title, spec, acceptanceCriteria);
    const view = await this.dispatcher.start({ workItemId, taskInstructions: instructions });

    const fresh = await this.requirePlan(claimed.id);
    const { dispatchClaim: _dropped, ...withoutClaim } = fresh;
    void _dropped;
    const committed = await this.commit(
      fresh,
      {
        ...withoutClaim,
        dispatches: [
          ...fresh.dispatches,
          { planItemKey, workItemId, loopId: view.loopId, dispatchedAt: this.clock.now(), adopted: false },
        ],
      },
      [{ kind: "DISPATCHED", detail: `"${planItemKey}" (${workItemId}) -> loop ${view.loopId} (${view.phase})` }],
    );
    if (committed === undefined) {
      // The loop is durable; the next pass adopts it via dispatcher.find.
      return { kind: "conflict" };
    }
    this.log(`[plan ${plan.id}] dispatched "${planItemKey}" (${workItemId}) to loop ${view.loopId}`);
    return { kind: "advanced", plan: committed };
  }

  /**
   * Plan completion is DERIVED from authoritative WorkItem state, never from
   * agent self-report, and keeps three things explicitly distinct:
   * execution finished (`WAITING_FOR_HUMAN` with live authority), release
   * approved (`DONE`), and published (not modelled here at all).
   */
  private async deriveCompletion(plan: Plan, expectedItemCount: number): Promise<StepResult> {
    if (plan.materialized.length < expectedItemCount || plan.dispatches.length < expectedItemCount) {
      // Something is still waiting on a prerequisite. Not progress, not an
      // error — the human (or a later resume) moves it along.
      return { kind: "halt", plan };
    }

    let allDone = true;
    let allFinished = true;
    for (const mapping of plan.materialized) {
      const item = await this.factory.getWorkItem(mapping.workItemId);
      if (item.status !== "DONE") {
        allDone = false;
      }
      if (!(await this.isExecutionFinished(mapping.workItemId))) {
        allFinished = false;
      }
    }

    if (allDone) {
      if (plan.phase === "COMPLETED") {
        return { kind: "halt", plan };
      }
      const completed = await this.commit(plan, { ...plan, phase: "COMPLETED", outcome: "COMPLETED" }, [
        {
          kind: "COMPLETED",
          detail: `all ${plan.materialized.length} work item(s) reached DONE; TASK-005 completion does not imply publish approval`,
        },
      ]);
      return completed === undefined ? { kind: "conflict" } : { kind: "halt", plan: completed };
    }

    if (allFinished && plan.phase !== "WAITING_FOR_HUMAN") {
      const waiting = await this.commit(plan, { ...plan, phase: "WAITING_FOR_HUMAN" }, [
        {
          kind: "ITEM_TERMINAL",
          detail: `all ${plan.materialized.length} work item(s) finished execution and await human release decisions`,
        },
      ]);
      return waiting === undefined ? { kind: "conflict" } : { kind: "halt", plan: waiting };
    }

    return { kind: "halt", plan };
  }

  // =====================================================================
  // Shared helpers
  // =====================================================================

  private orchestratorActor(): Actor {
    return { id: "agent:planner-orchestrator", kind: "AGENT", displayName: "Planner Orchestrator" };
  }

  private requireTrustedHuman(actor: Actor, authorization: TrustedHumanToken | undefined, operation: string): void {
    const problem = this.factory.verifyHumanAuthorization(actor, authorization);
    if (problem !== undefined) {
      throw new HumanIdentityError(`refusing to ${operation}: ${problem}`);
    }
  }

  private async requirePlan(planId: string): Promise<Plan> {
    const plan = await this.plans.findById(planId);
    if (plan === undefined) {
      throw new NotFoundError("Plan", planId);
    }
    return plan;
  }

  /** Stamps version, timestamp and append-only events; returns undefined on a lost CAS. */
  private async commit(plan: Plan, next: Plan, events: readonly EventDraft[]): Promise<Plan | undefined> {
    const at = this.clock.now();
    const appended = [...plan.events];
    for (const draft of events) {
      appended.push({ seq: appended.length + 1, kind: draft.kind, detail: bound(draft.detail), at });
    }
    const stamped: Plan = { ...next, version: plan.version + 1, events: appended, lastTransitionAt: at };
    // ONE place enforces "a planner lease exists exactly while PLANNING". Doing
    // it here rather than at each settle/cancel/block site is what makes the
    // invariant impossible to forget in a path added later.
    const candidate = stamped.phase === "PLANNING" ? stamped : stripPlannerAction(stamped);
    try {
      return await this.plans.compareAndSave(candidate, plan.version);
    } catch (error) {
      if (error instanceof ConcurrencyError) {
        return undefined;
      }
      throw error;
    }
  }

  private async blockPlan(
    plan: Plan,
    reason: string,
    exhaustionKind: Plan["exhaustionKind"],
    eventKind: PlanEventKind,
  ): Promise<StepResult> {
    const next: Plan = {
      ...plan,
      phase: "BLOCKED",
      outcome: "BLOCKED",
      failureReason: reason,
      ...(exhaustionKind === undefined ? {} : { exhaustionKind }),
    };
    const committed = await this.commit(plan, next, [{ kind: eventKind, detail: reason }]);
    if (committed === undefined) {
      return { kind: "conflict" };
    }
    this.log(`[plan ${plan.id}] BLOCKED: ${reason}`);
    return { kind: "halt", plan: committed };
  }

  /** Durable, fail-closed demotion when authority or execution state cannot be reconstructed. */
  private async failClosed(plan: Plan, reason: string): Promise<StepResult> {
    const committed = await this.commit(
      plan,
      { ...plan, phase: "RECOVERY_REQUIRED", outcome: "RECOVERY_REQUIRED", failureReason: reason },
      [{ kind: "RECOVERY_REQUIRED", detail: reason }],
    );
    if (committed === undefined) {
      return { kind: "conflict" };
    }
    this.log(`[plan ${plan.id}] RECOVERY_REQUIRED: ${reason}`);
    return { kind: "halt", plan: committed };
  }
}

function stripPlannerAction(plan: Plan): Plan {
  if (plan.plannerAction === undefined) {
    return plan;
  }
  const { plannerAction: _dropped, ...rest } = plan;
  void _dropped;
  return rest;
}

/** Bounded, whitespace-flattened audit text. Never a transcript, never a credential (C6/C8). */
function bound(detail: string): string {
  const flattened = detail.replace(/\s+/g, " ").trim();
  return flattened.length <= MAX_EVENT_DETAIL_LENGTH ? flattened : `${flattened.slice(0, MAX_EVENT_DETAIL_LENGTH - 1)}…`;
}

/** The most recent contract/validation rejection, so a retry can correct itself. */
function lastRejectionReason(plan: Plan): string | undefined {
  for (let index = plan.events.length - 1; index >= 0; index -= 1) {
    const event = plan.events[index];
    if (event === undefined) {
      continue;
    }
    if (event.kind === "PLANNER_OUTPUT_REJECTED") {
      return event.detail;
    }
    if (event.kind === "REVISION_GENERATED") {
      return undefined;
    }
  }
  return undefined;
}

/** The bounded spec text handed to the TASK-004 implementer for one planned item. */
export function buildTaskInstructions(
  title: string,
  spec: string,
  acceptanceCriteria: readonly { readonly text: string; readonly verificationHint: string }[],
): string {
  const criteria = acceptanceCriteria
    .map((criterion, index) => `${index + 1}. ${criterion.text} (verified by: ${criterion.verificationHint})`)
    .join("\n");
  return [`# ${title}`, "", "## Specification", spec, "", "## Acceptance criteria", criteria].join("\n");
}
