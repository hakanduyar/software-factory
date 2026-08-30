/**
 * Shared TASK-005 planning fixtures. Deterministic clock and ids so assertions
 * are exact, and no real AI model is reachable from anything here.
 */

import { createInMemoryStore } from "../../src/adapters/memory/inMemoryStore.js";
import { createInMemoryPlanRepository } from "../../src/adapters/planning/inMemoryPlanRepository.js";
import { createLocalHumanIdentityGate } from "../../src/adapters/security/localHumanIdentityGate.js";
import { createLocalWorkerRegistry } from "../../src/adapters/security/localWorkerRegistry.js";
import { createMockWorker } from "../../src/adapters/workers/mockWorker.js";
import { FactoryService } from "../../src/app/factoryService.js";
import { agent, human, system } from "../../src/domain/actor.js";
import { createSequentialIdGenerator } from "../../src/domain/ids.js";
import type { PlanRepository } from "../../src/planning/planRepository.js";
import { createPlanBindingResolver, PlanningService } from "../../src/planning/planningService.js";
import type { PlanExecutionConfig, PlannerConfig, Plan } from "../../src/planning/planTypes.js";
import type { PlannerWorker } from "../../src/planning/plannerWorker.js";
import {
  createScriptedDispatcher,
  createScriptedPlannerWorker,
  renderPlannerResponse,
  type ScriptedDispatcher,
  type ScriptedPlanBody,
} from "../../src/planning/scriptedPlannerWorkers.js";
import { createFixedClock, type Clock } from "../../src/ports/clock.js";
import type { FactoryStore } from "../../src/ports/repositories.js";

export const PLAN_HUMAN = human("user:test", "Test Human");
export const PLAN_OTHER_HUMAN = human("user:other", "Other Human");
export const PLAN_AGENT = agent("agent:test", "Test Agent");
export const PLAN_SYSTEM = system("system:test", "Test System");

/** Fixture-only secret: never used outside this in-memory test gate. */
export const PLAN_CREDENTIAL = "plan-test-fixture-secret-1234";
export const PLAN_WRONG_CREDENTIAL = "plan-wrong-fixture-secret-999";

export const PLAN_FIXTURE_START = "2026-01-01T00:00:00.000Z";

export const TEST_PLANNER_CONFIG: PlannerConfig = { tool: "scripted", model: "test-planner" };

export function testExecutionConfig(workspaceRoot = "/tmp/sf-plan-test"): PlanExecutionConfig {
  return {
    implementer: { tool: "scripted", model: "test-implementer" },
    reviewer: { tool: "scripted", model: "test-reviewer" },
    verificationCommands: [{ id: "check", executable: "node", argv: ["-e", "process.exit(0)"] }],
    workspaceRoot,
    loopBudget: { maxIterations: 2 },
  };
}

export interface TestPlanning {
  readonly factory: FactoryService;
  readonly plans: PlanRepository;
  readonly store: FactoryStore;
  readonly clock: Clock;
  readonly dispatcher: ScriptedDispatcher;
  readonly service: PlanningService;
  readonly projectId: string;
}

export interface NewPlanningOptions {
  /** Raw planner outputs, one per successive call; the last repeats. */
  readonly plannerOutputs?: readonly string[];
  readonly plannerStatuses?: readonly ("SUCCEEDED" | "FAILED")[];
  /** Supply a fully custom planner instead of the scripted one. */
  readonly planner?: PlannerWorker;
  readonly dispatcher?: ScriptedDispatcher;
  readonly projectRules?: readonly string[];
  /** Reuse existing durable state (restart simulation). */
  readonly store?: FactoryStore;
  readonly plans?: PlanRepository;
  readonly clock?: Clock;
}

/**
 * A PlanningService wired to in-memory Factory + plan stores, a scripted
 * planner and a scripted loop dispatcher. Passing `store`/`plans` from a
 * previous instance is exactly the restart scenario TASK-005 must prove.
 */
export async function newPlanning(options: NewPlanningOptions = {}): Promise<TestPlanning> {
  const clock = options.clock ?? createFixedClock(PLAN_FIXTURE_START);
  const store = options.store ?? createInMemoryStore();
  const plans = options.plans ?? createInMemoryPlanRepository();
  const factory = new FactoryService({
    store,
    clock,
    ids: createSequentialIdGenerator(),
    identityGate: createLocalHumanIdentityGate({ credential: PLAN_CREDENTIAL, clock }),
    workerRegistry: createLocalWorkerRegistry(clock),
    planBindingResolver: createPlanBindingResolver(plans),
  });
  const dispatcher = options.dispatcher ?? createScriptedDispatcher();
  const planner =
    options.planner ??
    createScriptedPlannerWorker({
      outputs: options.plannerOutputs ?? [simplePlanResponse()],
      ...(options.plannerStatuses === undefined ? {} : { statuses: options.plannerStatuses }),
    });
  const service = new PlanningService({
    factory,
    plans,
    clock,
    ids: createSequentialIdGenerator(),
    planner,
    dispatcher,
    ...(options.projectRules === undefined ? {} : { projectRules: options.projectRules }),
  });

  const existing = await store.projects.list();
  const project = existing[0] ?? (await factory.createProject({ key: "TST", name: "Test Project" }));

  return { factory, plans, store, clock, dispatcher, service, projectId: project.id };
}

/** A valid single-item planner response. */
export function simplePlanResponse(overrides: Partial<ScriptedPlanBody> = {}): string {
  return renderPlannerResponse({
    summary: "Deliver the requested capability.",
    items: [{ key: "WI-A", title: "Do the thing", spec: "Implement the thing as described." }],
    ...overrides,
  });
}

/** A valid two-item response where WI-B depends on WI-A. */
export function dependentPlanResponse(): string {
  return renderPlannerResponse({
    summary: "Two items, ordered.",
    items: [
      { key: "WI-A", title: "First", spec: "Do the first thing." },
      { key: "WI-B", title: "Second", spec: "Do the second thing.", dependsOn: ["WI-A"] },
    ],
  });
}

/** A response that asks one genuine blocking question and proposes nothing. */
export function clarificationResponse(questionId = "q1"): string {
  return renderPlannerResponse({
    summary: "Cannot plan safely without one decision.",
    blockingQuestions: [{ id: questionId, question: "Delete or archive?", why: "Deletion is irreversible." }],
  });
}

export function authorizePlanHuman(factory: FactoryService, actor = PLAN_HUMAN) {
  return factory.authorizeHuman(actor, PLAN_CREDENTIAL);
}

/**
 * The worker configuration a plan is started with, when a test needs a
 * particular one.
 *
 * Added for TASK-014's authorization gate, which compares what a plan will RUN
 * against the single resource the supervisor authorized. The defaults name three
 * different models, which is the realistic shape and is exactly what that gate
 * refuses — so a test about the permitted case has to be able to say so.
 */
export interface PlanFixtureOverrides {
  readonly planner?: PlannerConfig;
  readonly execution?: PlanExecutionConfig;
  /**
   * The operator's own constraints, which since TASK-014 round-3 finding 3 are
   * where a plan declares WHICH ROADMAP ITEM it serves. A supervisor refuses to
   * act on a plan that does not name the item it was bound to.
   */
  readonly constraints?: readonly string[];
}

/** Starts a plan and returns it at PLAN_REVIEW. */
export async function planAtReview(
  context: TestPlanning,
  intent = "Build the thing.",
  overrides: PlanFixtureOverrides = {},
): Promise<Plan> {
  return context.service.start({
    projectId: context.projectId,
    actor: PLAN_HUMAN,
    intent,
    planner: overrides.planner ?? TEST_PLANNER_CONFIG,
    execution: overrides.execution ?? testExecutionConfig(),
    ...(overrides.constraints === undefined ? {} : { constraints: [...overrides.constraints] }),
  });
}

/** Starts and approves a plan, returning it after the drive that follows approval. */
export async function approvedPlan(
  context: TestPlanning,
  intent = "Build the thing.",
  overrides: PlanFixtureOverrides = {},
): Promise<Plan> {
  const plan = await planAtReview(context, intent, overrides);
  return context.service.approve(plan.id, PLAN_HUMAN, authorizePlanHuman(context.factory));
}

/**
 * Drives one materialized work item to WAITING_FOR_HUMAN through the REAL
 * Factory gates — independent implementation, passing deterministic
 * verification, and an independent passing semantic review (C4). This is what
 * makes a prerequisite genuinely "execution finished" with live authority,
 * rather than merely status-stamped.
 */
export async function finishWorkItem(factory: FactoryService, itemId: string, suffix: string): Promise<void> {
  const orchestrator = agent("agent:test-orchestrator", "Test Orchestrator");
  await factory.advance(itemId, "IMPLEMENTING", orchestrator);

  const implementer = createMockWorker({ id: `impl-${suffix}`, roles: ["IMPLEMENTER"] });
  const verifier = createMockWorker({ id: `verify-${suffix}`, roles: ["VERIFIER"] });
  const reviewer = createMockWorker({ id: `review-${suffix}`, roles: ["REVIEWER"] });
  factory.registerWorker(implementer);
  factory.registerWorker(verifier);
  factory.registerWorker(reviewer);

  const implementation = await factory.runWorker({ workItemId: itemId, role: "IMPLEMENTER", worker: implementer, instructions: "implement" });
  await factory.advance(itemId, "VERIFYING", orchestrator);
  const verification = await factory.runWorker({
    workItemId: itemId,
    role: "VERIFIER",
    worker: verifier,
    instructions: "verify",
    againstRunId: implementation.run.id,
  });
  await factory.recordReview({
    workItemId: itemId,
    reviewedRunId: implementation.run.id,
    reviewerRunId: verification.run.id,
    kind: "DETERMINISTIC",
    verdict: "PASS",
  });
  await factory.advance(itemId, "REVIEW", orchestrator);
  const review = await factory.runWorker({
    workItemId: itemId,
    role: "REVIEWER",
    worker: reviewer,
    instructions: "review",
    againstRunId: implementation.run.id,
  });
  await factory.recordReview({
    workItemId: itemId,
    reviewedRunId: implementation.run.id,
    reviewerRunId: review.run.id,
    kind: "SEMANTIC",
    verdict: "PASS",
  });
  await factory.advance(itemId, "WAITING_FOR_HUMAN", orchestrator);
  await factory.verifyAcceptanceCriteria({ workItemId: itemId, verifierRunId: verification.run.id });
}

export { renderPlannerResponse };
