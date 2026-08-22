/**
 * TASK-005 materialization and crash recovery.
 *
 * Covers AC-7 (materialization is exact, idempotent and crash-safe) and AC-11
 * (every crash boundary reconciles safely, and ambiguous state fails closed).
 *
 * The property under test throughout is that a crash can only ever leave the
 * plan in a state a later `resume()` can resolve WITHOUT creating a duplicate
 * work item — and that it resolves it by exact correlation-tag match against
 * authoritative Factory records, never by guessing from titles, order or
 * timestamps. The correlation tag is the created WorkItem's `planVersion`,
 * written by the accepted `createWorkItem` in the same transaction that creates
 * the item, so it is durable before anything depends on it.
 *
 * No real Claude/Codex model is invoked anywhere in this file.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createInMemoryStore } from "../src/adapters/memory/inMemoryStore.js";
import { createInMemoryPlanRepository } from "../src/adapters/planning/inMemoryPlanRepository.js";
import { createLocalHumanIdentityGate } from "../src/adapters/security/localHumanIdentityGate.js";
import { createLocalWorkerRegistry } from "../src/adapters/security/localWorkerRegistry.js";
import { FactoryService, type CreateWorkItemInput } from "../src/app/factoryService.js";
import { createSequentialIdGenerator } from "../src/domain/ids.js";
import type { WorkItem } from "../src/domain/workItem.js";
import { createPlanBindingResolver, PlanningService } from "../src/planning/planningService.js";
import { canonicalCorrelationTag, canonicalPlannerActionTag, type Plan } from "../src/planning/planTypes.js";
import { createScriptedDispatcher, createScriptedPlannerWorker, renderPlannerResponse } from "../src/planning/scriptedPlannerWorkers.js";
import { createFixedClock } from "../src/ports/clock.js";
import type { PlanRepository } from "../src/planning/planRepository.js";
import type { FactoryStore } from "../src/ports/repositories.js";
import {
  approvedPlan,
  authorizePlanHuman,
  clarificationResponse,
  newPlanning,
  planAtReview,
  PLAN_CREDENTIAL,
  PLAN_FIXTURE_START,
  PLAN_HUMAN,
  simplePlanResponse,
  TEST_PLANNER_CONFIG,
  testExecutionConfig,
} from "./support/planFixtures.js";

const TWO_ITEMS = renderPlannerResponse({
  summary: "Two independent items.",
  items: [
    { key: "WI-A", title: "First", spec: "Do the first thing.", acceptanceCriteria: [{ text: "A works", verificationHint: "npm test" }] },
    { key: "WI-B", title: "Second", spec: "Do the second thing.", acceptanceCriteria: [{ text: "B works", verificationHint: "npm test" }] },
  ],
});

/** A FactoryService that throws on the Nth createWorkItem — a process crash, mid-materialization. */
class CrashingFactory extends FactoryService {
  private calls = 0;
  private readonly failOnCall: number;

  constructor(deps: ConstructorParameters<typeof FactoryService>[0], failOnCall: number) {
    super(deps);
    this.failOnCall = failOnCall;
  }

  override async createWorkItem(input: CreateWorkItemInput): Promise<WorkItem> {
    this.calls += 1;
    if (this.calls === this.failOnCall) {
      throw new Error("simulated process crash during materialization");
    }
    return super.createWorkItem(input);
  }
}

interface Harness {
  readonly store: FactoryStore;
  readonly plans: PlanRepository;
  readonly deps: ConstructorParameters<typeof FactoryService>[0];
  readonly dispatcher: ReturnType<typeof createScriptedDispatcher>;
  readonly plannerOutput: string;
}

function newHarness(plannerOutput: string = TWO_ITEMS): Harness {
  const clock = createFixedClock(PLAN_FIXTURE_START);
  const store = createInMemoryStore();
  const plans = createInMemoryPlanRepository();
  const deps = {
    store,
    clock,
    ids: createSequentialIdGenerator(),
    identityGate: createLocalHumanIdentityGate({ credential: PLAN_CREDENTIAL, clock }),
    workerRegistry: createLocalWorkerRegistry(clock),
    planBindingResolver: createPlanBindingResolver(plans),
  };
  return { store, plans, deps, dispatcher: createScriptedDispatcher(), plannerOutput };
}

function serviceOver(harness: Harness, factory: FactoryService): PlanningService {
  return new PlanningService({
    factory,
    plans: harness.plans,
    clock: createFixedClock(PLAN_FIXTURE_START),
    ids: createSequentialIdGenerator(),
    planner: createScriptedPlannerWorker({ outputs: [harness.plannerOutput] }),
    dispatcher: harness.dispatcher,
  });
}

// =====================================================================
// AC-7 — materialization is exact
// =====================================================================

describe("TASK-005 AC-7: materialization creates exactly the approved work items", () => {
  it("creates one work item per approved plan item, with the approved content", async () => {
    const context = await newPlanning({ plannerOutputs: [TWO_ITEMS] });
    const plan = await approvedPlan(context);

    const items = await context.factory.listWorkItemsByProject(context.projectId);
    assert.equal(items.length, 2);
    assert.equal(plan.materialized.length, 2);

    const revision = plan.revisions.at(-1)!;
    for (const planned of revision.items) {
      const mapping = plan.materialized.find((entry) => entry.planItemKey === planned.key)!;
      const item = await context.factory.getWorkItem(mapping.workItemId);
      assert.equal(item.title, planned.title);
      assert.equal(item.type, planned.type);
      assert.equal(item.priority, planned.priority);
      // The correlation tag IS the planVersion — this is what crash recovery matches on.
      assert.equal(item.planVersion, canonicalCorrelationTag(plan.id, revision.revision, planned.key));

      const criteria = await context.factory.listCriteria(item.id);
      assert.equal(criteria.length, planned.acceptanceCriteria.length);
      assert.deepEqual(
        criteria.map((criterion) => criterion.text).sort(),
        planned.acceptanceCriteria.map((criterion) => criterion.text).sort(),
      );
    }
  });

  it("drives every materialized item to READY through the real gates", async () => {
    const context = await newPlanning({ plannerOutputs: [TWO_ITEMS] });
    const plan = await approvedPlan(context);

    for (const mapping of plan.materialized) {
      const item = await context.factory.getWorkItem(mapping.workItemId);
      // READY or beyond: the scripted dispatcher does not advance items itself.
      assert.ok(["READY", "IMPLEMENTING"].includes(item.status), `unexpected status ${item.status}`);
      assert.equal(mapping.readied, true);
    }
  });

  it("is idempotent: resuming an already-materialized plan creates nothing new", async () => {
    const context = await newPlanning({ plannerOutputs: [TWO_ITEMS] });
    const plan = await approvedPlan(context);
    const before = await context.factory.listWorkItemsByProject(context.projectId);
    const startsBefore = context.dispatcher.startCount();

    await context.service.resume(plan.id);
    await context.service.resume(plan.id);

    const after = await context.factory.listWorkItemsByProject(context.projectId);
    assert.equal(after.length, before.length, "no duplicate work items");
    assert.equal(context.dispatcher.startCount(), startsBefore, "no duplicate loops");
  });

  it("fails closed when a mapped work item's plan tag no longer matches the approved one", async () => {
    const context = await newPlanning({ plannerOutputs: [TWO_ITEMS] });
    const plan = await approvedPlan(context);

    // Rewrite one mapping to point at a work item whose planVersion is not the
    // approved correlation tag: that item is not this plan's item, whatever the
    // mapping claims.
    const current = (await context.plans.findById(plan.id))!;
    const tampered: Plan = {
      ...current,
      phase: "MATERIALIZING",
      materialized: current.materialized.map((entry, index) =>
        index === 0 ? { ...entry, readied: false, correlationTag: entry.correlationTag } : entry,
      ),
      version: current.version + 1,
    };
    await context.plans.compareAndSave(tampered, current.version);

    // Point the work item's tag somewhere else by mapping to the OTHER item.
    const swapped = (await context.plans.findById(plan.id))!;
    const crossed: Plan = {
      ...swapped,
      materialized: [
        { ...swapped.materialized[0]!, workItemId: swapped.materialized[1]!.workItemId, readied: false },
        swapped.materialized[1]!,
      ],
      version: swapped.version + 1,
    };
    await context.plans.compareAndSave(crossed, swapped.version);

    const resumed = await context.service.resume(plan.id);
    assert.equal(resumed.phase, "RECOVERY_REQUIRED");
    assert.match(resumed.failureReason ?? "", /planVersion/);
  });
});

// =====================================================================
// AC-11 — crash boundaries
// =====================================================================

describe("TASK-005 AC-11: every crash boundary reconciles without duplicating work", () => {
  it("boundary 1: intent persisted, planner never launched -> resume plans", async () => {
    const context = await newPlanning();
    const plan = await planAtReview(context);
    // Rewind to DRAFT with no revision, as if the process died right after start.
    const current = (await context.plans.findById(plan.id))!;
    const rewound: Plan = { ...current, phase: "DRAFT", revisions: [], attemptsForCurrentRevision: 0, version: current.version + 1 };
    await context.plans.compareAndSave(rewound, current.version);

    const resumed = await context.service.resume(plan.id);
    assert.equal(resumed.phase, "PLAN_REVIEW");
    assert.equal(resumed.revisions.length, 1);
  });

  /**
   * Remediation round 1, HIGH 5 split this boundary in two, because the old
   * single answer ("PLANNING is retryable") is what let a second real planner
   * run be launched. A crash is now two DIFFERENT states with two different
   * safe answers, distinguished by the durable lease.
   */
  async function crashedMidPlanning(state: "CLAIMED" | "RUNNING") {
    const context = await newPlanning();
    const plan = await planAtReview(context);
    const current = (await context.plans.findById(plan.id))!;
    const midFlight: Plan = {
      ...current,
      phase: "PLANNING",
      plannerAction: {
        revision: 1,
        attempt: 1,
        correlationTag: canonicalPlannerActionTag(current.id, 1, 1),
        ownerId: "planner-owner:a-process-that-is-gone",
        state,
        claimedAt: 0,
      },
      revisions: [],
      attemptsForCurrentRevision: 1,
      totalPlannerRuns: 1,
      version: current.version + 1,
    };
    await context.plans.compareAndSave(midFlight, current.version);
    return { context, resumed: await context.service.resume(plan.id) };
  }

  it("boundary 2: a planner action claimed but never launched is retried, audited, and budgeted", async () => {
    const { resumed } = await crashedMidPlanning("CLAIMED");

    assert.equal(resumed.phase, "PLAN_REVIEW");
    // CLAIMED proves nothing external happened, so retrying is safe — and the
    // retry is still explicitly recorded rather than silently absorbed.
    const audited = resumed.events.filter(
      (event) => event.kind === "PLANNER_RUN_FAILED" && /claimed but never launched/.test(event.detail),
    );
    assert.equal(audited.length, 1);
    assert.ok(resumed.totalPlannerRuns >= 2, "the retry charged the budget");
    assert.equal(resumed.plannerAction, undefined, "the settled lease was released");
  });

  it("boundary 3: a planner action left RUNNING by a lost owner fails closed instead of relaunching", async () => {
    const { context, resumed } = await crashedMidPlanning("RUNNING");

    assert.equal(resumed.phase, "RECOVERY_REQUIRED");
    assert.equal(resumed.outcome, "RECOVERY_REQUIRED");
    assert.match(resumed.failureReason!, /a second planner run must not be launched/);
    assert.equal(resumed.totalPlannerRuns, 1, "no second planner run was charged");
    assert.equal(resumed.revisions.length, 0, "no revision was manufactured");
    assert.deepEqual(await context.factory.listWorkItemsByProject(context.projectId), []);
  });

  it("boundary 4: clarification required -> resume halts and asks nobody twice", async () => {
    const context = await newPlanning({ plannerOutputs: [clarificationResponse()] });
    const plan = await planAtReview(context);
    assert.equal(plan.phase, "NEEDS_CLARIFICATION");

    const runsBefore = plan.totalPlannerRuns;
    const resumed = await context.service.resume(plan.id);

    assert.equal(resumed.phase, "NEEDS_CLARIFICATION");
    assert.equal(resumed.totalPlannerRuns, runsBefore, "resume did not re-run the planner");
    assert.equal(resumed.openQuestions.length, 1);
  });

  it("boundary 5: awaiting approval -> resume creates nothing", async () => {
    const context = await newPlanning();
    const plan = await planAtReview(context);

    const resumed = await context.service.resume(plan.id);

    assert.equal(resumed.phase, "PLAN_REVIEW");
    assert.deepEqual(await context.factory.listWorkItemsByProject(context.projectId), []);
  });

  it("boundary 6: approval recorded but materialization not started -> resume materializes", async () => {
    const context = await newPlanning({ plannerOutputs: [TWO_ITEMS] });
    const plan = await approvedPlan(context);

    // Rewind to APPROVED with nothing materialized.
    const current = (await context.plans.findById(plan.id))!;
    const rewound: Plan = { ...current, phase: "APPROVED", materialized: [], dispatches: [], version: current.version + 1 };
    await context.plans.compareAndSave(rewound, current.version);

    const resumed = await context.service.resume(plan.id);
    assert.equal(resumed.materialized.length, 2);
  });

  it("boundary 7: PARTIAL materialization -> restart completes it with no duplicates", async () => {
    const harness = newHarness();
    // Instance 1 crashes while creating the SECOND work item.
    const crashing = new CrashingFactory(harness.deps, 2);
    const project = await crashing.createProject({ key: "TST", name: "Test Project" });
    const crashedService = serviceOver(harness, crashing);

    const draft = await crashedService.start({
      projectId: project.id,
      actor: PLAN_HUMAN,
      intent: "Two things",
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
    });
    await assert.rejects(
      crashedService.approve(draft.id, PLAN_HUMAN, crashing.authorizeHuman(PLAN_HUMAN, PLAN_CREDENTIAL)),
      /simulated process crash/,
    );

    const midCrash = (await harness.plans.findById(draft.id))!;
    assert.equal(midCrash.materialized.length, 1, "exactly one item committed");
    assert.ok(midCrash.materializationClaim !== undefined, "a dangling claim marks the interrupted item");

    // Instance 2: a fresh process over the SAME durable state.
    const recovered = new FactoryService(harness.deps);
    const resumed = await serviceOver(harness, recovered).resume(draft.id);

    assert.equal(resumed.materialized.length, 2);
    assert.equal(resumed.materializationClaim, undefined, "the claim was resolved");
    const items = await recovered.listWorkItemsByProject(project.id);
    assert.equal(items.length, 2, "no duplicate work item was created");
    const tags = new Set(items.map((item) => item.planVersion));
    assert.equal(tags.size, 2, "each item carries a distinct canonical plan tag");
  });

  it("boundary 7b: a dangling claim whose work item DID commit is adopted, not recreated", async () => {
    const context = await newPlanning({ plannerOutputs: [TWO_ITEMS] });
    const plan = await approvedPlan(context);
    const revision = plan.revisions.at(-1)!;
    const victim = plan.materialized[0]!;

    // Simulate: the create committed, but the mapping write did not.
    const current = (await context.plans.findById(plan.id))!;
    const rewound: Plan = {
      ...current,
      phase: "MATERIALIZING",
      materialized: current.materialized.filter((entry) => entry.planItemKey !== victim.planItemKey),
      dispatches: [],
      materializationClaim: {
        planItemKey: victim.planItemKey,
        correlationTag: canonicalCorrelationTag(plan.id, revision.revision, victim.planItemKey),
        claimedAt: 0,
      },
      version: current.version + 1,
    };
    await context.plans.compareAndSave(rewound, current.version);
    const itemsBefore = (await context.factory.listWorkItemsByProject(context.projectId)).length;

    const resumed = await context.service.resume(plan.id);

    const mapping = resumed.materialized.find((entry) => entry.planItemKey === victim.planItemKey);
    assert.equal(mapping?.workItemId, victim.workItemId, "the existing item was adopted by tag");
    assert.equal((await context.factory.listWorkItemsByProject(context.projectId)).length, itemsBefore, "nothing new was created");
    assert.ok(resumed.events.some((event) => /adopted existing/.test(event.detail)));
  });

  it("boundary 8: materialized but not dispatched -> resume dispatches", async () => {
    const context = await newPlanning({ plannerOutputs: [simplePlanResponse()] });
    const plan = await approvedPlan(context);

    const current = (await context.plans.findById(plan.id))!;
    const rewound: Plan = { ...current, phase: "EXECUTING", dispatches: [], version: current.version + 1 };
    await context.plans.compareAndSave(rewound, current.version);

    const resumed = await context.service.resume(plan.id);
    assert.equal(resumed.dispatches.length, 1);
  });

  it("boundary 9: a loop already exists -> it is adopted, never duplicated", async () => {
    const context = await newPlanning({ plannerOutputs: [simplePlanResponse()] });
    const plan = await approvedPlan(context);
    const startsAfterFirstDispatch = context.dispatcher.startCount();
    assert.equal(startsAfterFirstDispatch, 1);

    // Forget the dispatch record, as if the process died after start() committed.
    const current = (await context.plans.findById(plan.id))!;
    const rewound: Plan = { ...current, phase: "EXECUTING", dispatches: [], version: current.version + 1 };
    await context.plans.compareAndSave(rewound, current.version);

    const resumed = await context.service.resume(plan.id);

    assert.equal(resumed.dispatches.length, 1);
    assert.equal(resumed.dispatches[0]!.adopted, true, "adopted the existing loop");
    assert.equal(context.dispatcher.startCount(), 1, "no second loop was started");
  });

  it("boundary 9b: a dangling dispatch claim with no started loop is cleared and retried", async () => {
    const context = await newPlanning({ plannerOutputs: [simplePlanResponse()] });
    const plan = await approvedPlan(context);
    const mapping = plan.materialized[0]!;

    // Rewind to a claim with no loop: the start() never happened.
    const current = (await context.plans.findById(plan.id))!;
    const rewound: Plan = {
      ...current,
      phase: "EXECUTING",
      dispatches: [],
      dispatchClaim: { planItemKey: mapping.planItemKey, workItemId: mapping.workItemId, claimedAt: 0 },
      version: current.version + 1,
    };
    await context.plans.compareAndSave(rewound, current.version);

    const resumed = await context.service.resume(plan.id);

    assert.equal(resumed.dispatchClaim, undefined);
    assert.equal(resumed.dispatches.length, 1);
  });

  it("boundary 12: all items terminal but the completion checkpoint is stale -> resume derives it", async () => {
    const context = await newPlanning({ plannerOutputs: [simplePlanResponse()] });
    const plan = await approvedPlan(context);
    const mapping = plan.materialized[0]!;

    // Take the item all the way to DONE behind the plan's back.
    const { finishWorkItem } = await import("./support/planFixtures.js");
    await finishWorkItem(context.factory, mapping.workItemId, "b12");
    await context.factory.recordApproval({
      gate: "RELEASE_APPROVAL",
      subject: context.factory.workItemSubject(mapping.workItemId),
      decision: "APPROVED",
      actor: PLAN_HUMAN,
      authorization: authorizePlanHuman(context.factory),
    });
    await context.factory.advance(mapping.workItemId, "DONE", PLAN_HUMAN, {
      authorization: authorizePlanHuman(context.factory),
    });

    const stale = await context.plans.findById(plan.id);
    assert.notEqual(stale?.phase, "COMPLETED", "the checkpoint is stale before resume");

    const resumed = await context.service.resume(plan.id);
    assert.equal(resumed.phase, "COMPLETED");
  });

  it("a restart with a brand-new service instance over the same state is a no-op", async () => {
    const harness = newHarness();
    const factory = new FactoryService(harness.deps);
    const project = await factory.createProject({ key: "TST", name: "Test Project" });
    const first = serviceOver(harness, factory);

    const draft = await first.start({
      projectId: project.id,
      actor: PLAN_HUMAN,
      intent: "Two things",
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
    });
    const approved = await first.approve(draft.id, PLAN_HUMAN, factory.authorizeHuman(PLAN_HUMAN, PLAN_CREDENTIAL));
    const itemsBefore = (await factory.listWorkItemsByProject(project.id)).length;
    const startsBefore = harness.dispatcher.startCount();

    const second = serviceOver(harness, new FactoryService(harness.deps));
    const resumed = await second.resume(approved.id);

    assert.equal(resumed.materialized.length, approved.materialized.length);
    assert.equal((await factory.listWorkItemsByProject(project.id)).length, itemsBefore);
    assert.equal(harness.dispatcher.startCount(), startsBefore);
  });
});
