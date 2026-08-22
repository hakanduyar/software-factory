/**
 * `npm run demo:plan` — the TASK-005 durable planner, end to end, offline.
 *
 * No network and no AI provider: the planner is a scripted closure returning
 * canned contract-satisfying text, and the engineering loop it hands work to is
 * TASK-004's REAL `EngineeringLoopService` driven by TASK-004's own scripted
 * workers over a real temporary git workspace and a real deterministic
 * verification command. So the handoff being demonstrated is the genuine one —
 * only the two model calls are replaced.
 *
 * Five scenarios, matching docs/tasks/TASK-005-planner-task-generator.md §16:
 *   1. clear intent -> plan -> approval -> materialization -> TASK-004 loop
 *   2. genuine blocking ambiguity -> clarification -> revised plan -> execution
 *   3. dependency ordering: B does not start until A has really finished
 *   4. malformed planner output -> bounded retries -> fail closed
 *   5. crash mid-materialization -> restart -> reconciliation, no duplicates
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInMemoryStore } from "../adapters/memory/inMemoryStore.js";
import { createInMemoryLoopRepository } from "../adapters/orchestration/inMemoryLoopRepository.js";
import { createInMemoryPlanRepository } from "../adapters/planning/inMemoryPlanRepository.js";
import { createEngineeringLoopDispatcher } from "../adapters/planning/engineeringLoopDispatcher.js";
import { createNodeProcessRunner } from "../adapters/process/nodeProcessRunner.js";
import { createLocalHumanIdentityGate } from "../adapters/security/localHumanIdentityGate.js";
import { createLocalWorkerRegistry } from "../adapters/security/localWorkerRegistry.js";
import { createMockWorker } from "../adapters/workers/mockWorker.js";
import { resolveWorkspace } from "../adapters/workers/workspace.js";
import { FactoryService, type CreateWorkItemInput } from "../app/factoryService.js";
import { agent, human } from "../domain/actor.js";
import { createSequentialIdGenerator } from "../domain/ids.js";
import type { WorkItem } from "../domain/workItem.js";
import { EngineeringLoopService } from "../orchestration/engineeringLoopService.js";
import type { VerificationCommandConfig } from "../orchestration/loopTypes.js";
import {
  asLoopWorkerFactory,
  createScriptedImplementerWorker,
  createScriptedReviewerWorker,
} from "../orchestration/scriptedLoopWorkers.js";
import type { LoopDispatcher } from "../planning/loopDispatcher.js";
import { createPlanBindingResolver, PlanningService } from "../planning/planningService.js";
import type { PlanExecutionConfig, PlannerConfig, PlanStatusView } from "../planning/planTypes.js";
import { toPlanStatusView } from "../planning/planTypes.js";
import { createScriptedDispatcher, createScriptedPlannerWorker, renderPlannerResponse } from "../planning/scriptedPlannerWorkers.js";
import { createFixedClock } from "../ports/clock.js";

const DEMO_CREDENTIAL = "demo-plan-local-operator-secret";
const OPERATOR = human("user:demo-operator", "Demo Operator");
const ORCHESTRATOR = agent("agent:demo-orchestrator", "Demo Orchestrator");

const PASSING_COMMANDS: readonly VerificationCommandConfig[] = [
  { id: "trivial-check", executable: process.execPath, argv: ["-e", "process.exit(0)"] },
];

const DEMO_PLANNER: PlannerConfig = { tool: "scripted", model: "demo-planner" };

export interface PlanDemoOptions {
  readonly log?: (line: string) => void;
}

export interface PlanDemoResult {
  readonly scenario1: PlanStatusView;
  readonly scenario2: PlanStatusView;
  readonly scenario3: PlanStatusView;
  readonly scenario4: PlanStatusView;
  readonly scenario5: PlanStatusView;
  readonly transcript: readonly string[];
}

/**
 * Per-invocation, deliberately not module-level: a module-level array would
 * make two overlapping `runPlanDemo()` calls delete each other's workspaces in
 * their `finally` blocks. There is only one caller today, but a test that runs
 * the demo twice should not have to know that.
 */
function makeScratchWorkspace(scratchDirs: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-demo-plan-"));
  scratchDirs.push(dir);
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  return dir;
}

function executionConfig(workspaceRoot: string): PlanExecutionConfig {
  return {
    implementer: { tool: "scripted", model: "demo-implementer" },
    reviewer: { tool: "scripted", model: "demo-reviewer" },
    verificationCommands: PASSING_COMMANDS.map((command) => ({
      id: command.id,
      executable: command.executable,
      argv: [...command.argv],
    })),
    workspaceRoot,
    loopBudget: { maxIterations: 2 },
  };
}

interface DemoFactory {
  readonly factory: FactoryService;
  readonly plans: ReturnType<typeof createInMemoryPlanRepository>;
  readonly store: ReturnType<typeof createInMemoryStore>;
  readonly clock: ReturnType<typeof createFixedClock>;
}

function makeFactory(): DemoFactory {
  const clock = createFixedClock("2026-01-01T00:00:00.000Z");
  const store = createInMemoryStore();
  const plans = createInMemoryPlanRepository();
  const factory = new FactoryService({
    store,
    clock,
    ids: createSequentialIdGenerator(),
    identityGate: createLocalHumanIdentityGate({ credential: DEMO_CREDENTIAL, clock }),
    workerRegistry: createLocalWorkerRegistry(clock),
    // TASK-005: without this, a PLAN approval could not be bound to an exact
    // revision + content digest, and FactoryService refuses to record one.
    planBindingResolver: createPlanBindingResolver(plans),
  });
  return { factory, plans, store, clock };
}

/** The real TASK-004 loop, wired with scripted workers — the genuine handoff, offline. */
function makeRealDispatcher(factory: FactoryService, workspaceRoot: string, log: (line: string) => void): LoopDispatcher {
  const clock = createFixedClock("2026-01-01T00:00:00.000Z");
  const loops = createInMemoryLoopRepository();
  const service = new EngineeringLoopService({
    factory,
    loops,
    clock,
    ids: createSequentialIdGenerator(),
    processRunner: createNodeProcessRunner(),
    log,
    createImplementerWorker: asLoopWorkerFactory(createScriptedImplementerWorker()),
    createReviewerWorker: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["PASS"] })),
  });
  return createEngineeringLoopDispatcher({
    service,
    loops,
    actor: ORCHESTRATOR,
    implementer: { tool: "claude-code", model: "demo-implementer" },
    reviewer: { tool: "codex-cli", model: "demo-reviewer" },
    verificationCommands: PASSING_COMMANDS,
    workspace: resolveWorkspace(workspaceRoot),
    budget: { maxIterations: 2 },
  });
}

/**
 * Drives one work item to WAITING_FOR_HUMAN through the REAL Factory gates with
 * mock workers — an independent implementation run, a passing deterministic
 * verification, and a passing semantic review by a DIFFERENT principal (C4).
 * Used by scenario 3 to make a prerequisite genuinely finished, so the
 * dependency gate is proven against live authority rather than a flag.
 */
async function finishExecutionThroughFactory(factory: FactoryService, itemId: string, suffix: string): Promise<void> {
  await factory.advance(itemId, "IMPLEMENTING", ORCHESTRATOR);
  const implementer = createMockWorker({ id: `demo-impl-${suffix}`, roles: ["IMPLEMENTER"] });
  const verifier = createMockWorker({ id: `demo-verify-${suffix}`, roles: ["VERIFIER"] });
  const reviewer = createMockWorker({ id: `demo-review-${suffix}`, roles: ["REVIEWER"] });
  factory.registerWorker(implementer);
  factory.registerWorker(verifier);
  factory.registerWorker(reviewer);

  const implementation = await factory.runWorker({ workItemId: itemId, role: "IMPLEMENTER", worker: implementer, instructions: "implement" });
  await factory.advance(itemId, "VERIFYING", ORCHESTRATOR);
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
  await factory.advance(itemId, "REVIEW", ORCHESTRATOR);
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
  await factory.advance(itemId, "WAITING_FOR_HUMAN", ORCHESTRATOR);
  await factory.verifyAcceptanceCriteria({ workItemId: itemId, verifierRunId: verification.run.id });
}

/** A FactoryService that fails the Nth createWorkItem, simulating a crash mid-materialization. */
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

export async function runPlanDemo(options: PlanDemoOptions = {}): Promise<PlanDemoResult> {
  const scratchDirs: string[] = [];
  const transcript: string[] = [];
  const emit = (line: string): void => {
    transcript.push(line);
    options.log?.(line);
  };

  try {
    emit("== Software Factory durable planner demo (TASK-005) ==");
    emit("No network, no AI provider. Scripted planner, real Factory gates, real TASK-004 loop.");

    // ---------------------------------------------------------------
    // Scenario 1 — clear intent, straight through to a TASK-004 loop
    // ---------------------------------------------------------------
    emit("");
    emit("-- scenario 1: clear intent -> plan -> human approval -> work item -> TASK-004 loop --");
    const s1 = makeFactory();
    const s1Project = await s1.factory.createProject({ key: "PLANDEMO", name: "Plan Demo" });
    const s1Workspace = makeScratchWorkspace(scratchDirs);
    const s1Planner = createScriptedPlannerWorker({
      outputs: [
        renderPlannerResponse({
          summary: "Add a health endpoint that reports service status.",
          assumptions: ["JSON response shape follows the existing API convention (safe, reversible)"],
          items: [{ key: "WI-A", title: "Add /health endpoint", spec: "Expose GET /health returning {status:'ok'}." }],
        }),
      ],
    });
    const s1Service = new PlanningService({
      factory: s1.factory,
      plans: s1.plans,
      clock: s1.clock,
      ids: createSequentialIdGenerator(),
      planner: s1Planner,
      dispatcher: makeRealDispatcher(s1.factory, s1Workspace, emit),
      log: emit,
    });

    let plan1 = await s1Service.start({
      projectId: s1Project.id,
      actor: OPERATOR,
      intent: "Add a health endpoint so we can monitor the service.",
      planner: DEMO_PLANNER,
      execution: executionConfig(s1Workspace),
    });
    emit(`plan is ${plan1.phase} with ${plan1.revisions.at(-1)?.items.length ?? 0} proposed item(s); nothing has been built yet`);

    plan1 = await s1Service.approve(plan1.id, OPERATOR, s1.factory.authorizeHuman(OPERATOR, DEMO_CREDENTIAL));
    const scenario1 = toPlanStatusView(plan1);
    emit(
      `scenario 1 result: phase=${scenario1.phase} materialized=${scenario1.materializedCount} dispatched=${scenario1.dispatchedCount}`,
    );

    // ---------------------------------------------------------------
    // Scenario 2 — genuine blocking ambiguity
    // ---------------------------------------------------------------
    emit("");
    emit("-- scenario 2: blocking ambiguity -> clarification -> revised plan -> execution --");
    const s2 = makeFactory();
    const s2Project = await s2.factory.createProject({ key: "PLANDEMO", name: "Plan Demo" });
    const s2Workspace = makeScratchWorkspace(scratchDirs);
    const s2Planner = createScriptedPlannerWorker({
      outputs: [
        renderPlannerResponse({
          summary: "Cannot plan safely: the retention rule is genuinely ambiguous.",
          blockingQuestions: [
            { id: "q1", question: "Should expired records be deleted or archived?", why: "Deletion is irreversible; archiving is not. The choice changes acceptance criteria." },
          ],
        }),
        renderPlannerResponse({
          summary: "Archive expired records to cold storage after 90 days.",
          assumptions: ["Archive format matches the existing export schema (safe, reversible)"],
          items: [{ key: "WI-A", title: "Archive expired records", spec: "Move records older than 90 days to cold storage; never delete." }],
        }),
      ],
    });
    const s2Service = new PlanningService({
      factory: s2.factory,
      plans: s2.plans,
      clock: s2.clock,
      ids: createSequentialIdGenerator(),
      planner: s2Planner,
      dispatcher: makeRealDispatcher(s2.factory, s2Workspace, emit),
      log: emit,
    });

    let plan2 = await s2Service.start({
      projectId: s2Project.id,
      actor: OPERATOR,
      intent: "Clean up old records.",
      planner: DEMO_PLANNER,
      execution: executionConfig(s2Workspace),
    });
    emit(`plan is ${plan2.phase}: ${plan2.openQuestions.map((question) => question.question).join(" | ")}`);

    plan2 = await s2Service.answer(plan2.id, OPERATOR, s2.factory.authorizeHuman(OPERATOR, DEMO_CREDENTIAL), [
      { questionId: "q1", answer: "Archive them. Never delete." },
    ]);
    emit(`after the answer the plan is ${plan2.phase} at revision ${plan2.revisions.length}`);

    plan2 = await s2Service.approve(plan2.id, OPERATOR, s2.factory.authorizeHuman(OPERATOR, DEMO_CREDENTIAL));
    const scenario2 = toPlanStatusView(plan2);
    emit(`scenario 2 result: phase=${scenario2.phase} revision=${scenario2.revision} dispatched=${scenario2.dispatchedCount}`);

    // ---------------------------------------------------------------
    // Scenario 3 — dependency ordering
    // ---------------------------------------------------------------
    emit("");
    emit("-- scenario 3: dependency graph -> B waits until A has genuinely finished --");
    const s3 = makeFactory();
    const s3Project = await s3.factory.createProject({ key: "PLANDEMO", name: "Plan Demo" });
    const s3Dispatcher = createScriptedDispatcher({ log: emit });
    const s3Service = new PlanningService({
      factory: s3.factory,
      plans: s3.plans,
      clock: s3.clock,
      ids: createSequentialIdGenerator(),
      planner: createScriptedPlannerWorker({
        outputs: [
          renderPlannerResponse({
            summary: "Introduce the schema, then the API that depends on it.",
            items: [
              { key: "WI-A", title: "Add the schema", spec: "Create the records table." },
              { key: "WI-B", title: "Add the API", spec: "Expose the records API.", dependsOn: ["WI-A"] },
            ],
          }),
        ],
      }),
      dispatcher: s3Dispatcher,
      log: emit,
    });

    let plan3 = await s3Service.start({
      projectId: s3Project.id,
      actor: OPERATOR,
      intent: "Add a records API backed by a new table.",
      planner: DEMO_PLANNER,
      execution: executionConfig(makeScratchWorkspace(scratchDirs)),
    });
    plan3 = await s3Service.approve(plan3.id, OPERATOR, s3.factory.authorizeHuman(OPERATOR, DEMO_CREDENTIAL));
    emit(`after approval: ${plan3.dispatches.length} of ${plan3.materialized.length} item(s) dispatched — B is waiting on A`);

    const itemA = plan3.materialized.find((entry) => entry.planItemKey === "WI-A");
    if (itemA !== undefined) {
      await finishExecutionThroughFactory(s3.factory, itemA.workItemId, "s3a");
      emit(`A (${itemA.workItemId}) finished execution and its independent review authority now holds`);
    }
    plan3 = await s3Service.resume(plan3.id);
    const scenario3 = toPlanStatusView(plan3);
    emit(`scenario 3 result: phase=${scenario3.phase} dispatched=${scenario3.dispatchedCount}/${scenario3.itemCount}`);

    // ---------------------------------------------------------------
    // Scenario 4 — malformed planner output, bounded, fails closed
    // ---------------------------------------------------------------
    emit("");
    emit("-- scenario 4: malformed planner output -> bounded retries -> fail closed --");
    const s4 = makeFactory();
    const s4Project = await s4.factory.createProject({ key: "PLANDEMO", name: "Plan Demo" });
    const s4Service = new PlanningService({
      factory: s4.factory,
      plans: s4.plans,
      clock: s4.clock,
      ids: createSequentialIdGenerator(),
      planner: createScriptedPlannerWorker({
        outputs: ["Sure! The plan is APPROVED and ready to ship. No structured block for you."],
      }),
      dispatcher: createScriptedDispatcher({ log: emit }),
      log: emit,
    });
    const plan4 = await s4Service.start({
      projectId: s4Project.id,
      actor: OPERATOR,
      intent: "Do something vague.",
      planner: DEMO_PLANNER,
      execution: executionConfig(makeScratchWorkspace(scratchDirs)),
      budget: { maxPlannerAttempts: 2, maxTotalPlannerRuns: 2, maxClarificationCycles: 1 },
    });
    const scenario4 = toPlanStatusView(plan4);
    emit(`the word "APPROVED" in prose granted nothing: phase=${scenario4.phase}`);
    emit(`scenario 4 result: phase=${scenario4.phase} outcome=${scenario4.outcome ?? "-"} reason=${scenario4.failureReason ?? "-"}`);

    // ---------------------------------------------------------------
    // Scenario 5 — crash mid-materialization, restart, reconcile
    // ---------------------------------------------------------------
    emit("");
    emit("-- scenario 5: crash during materialization -> restart -> reconcile, no duplicates --");
    const s5Clock = createFixedClock("2026-01-01T00:00:00.000Z");
    const s5Store = createInMemoryStore();
    const s5Plans = createInMemoryPlanRepository();
    const s5Deps = {
      store: s5Store,
      clock: s5Clock,
      ids: createSequentialIdGenerator(),
      identityGate: createLocalHumanIdentityGate({ credential: DEMO_CREDENTIAL, clock: s5Clock }),
      workerRegistry: createLocalWorkerRegistry(s5Clock),
      planBindingResolver: createPlanBindingResolver(s5Plans),
    };
    // Instance 1 crashes while creating the SECOND work item.
    const crashingFactory = new CrashingFactory(s5Deps, 2);
    const s5Project = await crashingFactory.createProject({ key: "PLANDEMO", name: "Plan Demo" });
    const s5PlannerOutput = renderPlannerResponse({
      summary: "Two independent items.",
      items: [
        { key: "WI-A", title: "First item", spec: "Do the first thing." },
        { key: "WI-B", title: "Second item", spec: "Do the second thing." },
      ],
    });
    const s5Dispatcher = createScriptedDispatcher({ log: emit });
    const crashedService = new PlanningService({
      factory: crashingFactory,
      plans: s5Plans,
      clock: s5Clock,
      ids: createSequentialIdGenerator(),
      planner: createScriptedPlannerWorker({ outputs: [s5PlannerOutput] }),
      dispatcher: s5Dispatcher,
      log: emit,
    });

    const plan5Draft = await crashedService.start({
      projectId: s5Project.id,
      actor: OPERATOR,
      intent: "Do two independent things.",
      planner: DEMO_PLANNER,
      execution: executionConfig(makeScratchWorkspace(scratchDirs)),
    });
    try {
      await crashedService.approve(plan5Draft.id, OPERATOR, crashingFactory.authorizeHuman(OPERATOR, DEMO_CREDENTIAL));
    } catch (error) {
      emit(`instance 1 crashed as scripted: ${error instanceof Error ? error.message : String(error)}`);
    }
    const midCrash = await s5Plans.findById(plan5Draft.id);
    emit(
      `mid-crash state: ${midCrash?.materialized.length ?? 0} item(s) materialized, dangling claim=${
        midCrash?.materializationClaim?.planItemKey ?? "none"
      }`,
    );

    // Instance 2: a fresh process over the SAME durable state.
    const recoveredFactory = new FactoryService(s5Deps);
    const recoveredService = new PlanningService({
      factory: recoveredFactory,
      plans: s5Plans,
      clock: s5Clock,
      ids: createSequentialIdGenerator(),
      planner: createScriptedPlannerWorker({ outputs: [s5PlannerOutput] }),
      dispatcher: s5Dispatcher,
      log: emit,
    });
    const plan5 = await recoveredService.resume(plan5Draft.id);
    const scenario5 = toPlanStatusView(plan5);
    const projectItems = await recoveredFactory.listWorkItemsByProject(s5Project.id);
    const planTags = new Set(projectItems.map((item) => item.planVersion));
    emit(
      `after restart: ${scenario5.materializedCount} materialized, ${projectItems.length} work item(s) in the project, ${planTags.size} distinct plan tag(s) — no duplicates`,
    );
    emit(`scenario 5 result: phase=${scenario5.phase} dispatched=${scenario5.dispatchedCount} loops started=${s5Dispatcher.startCount()}`);

    // ---------------------------------------------------------------
    emit("");
    emit("== summary ==");
    emit(`scenario 1 (clear intent)            : ${scenario1.phase}`);
    emit(`scenario 2 (clarification cycle)     : ${scenario2.phase} at revision ${scenario2.revision}`);
    emit(`scenario 3 (dependency ordering)     : ${scenario3.phase}, ${scenario3.dispatchedCount}/${scenario3.itemCount} dispatched`);
    emit(`scenario 4 (malformed, fail closed)  : ${scenario4.phase}`);
    emit(`scenario 5 (crash + reconcile)       : ${scenario5.phase}, ${scenario5.materializedCount} materialized`);

    return { scenario1, scenario2, scenario3, scenario4, scenario5, transcript };
  } finally {
    while (scratchDirs.length > 0) {
      const dir = scratchDirs.pop();
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
}
