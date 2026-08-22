/**
 * TASK-005 REMEDIATION ROUND 3 — the production persistence composition.
 *
 * The third independent review found that `ApprovalContext` had gained four
 * TASK-005 authority fields while the SQLite Factory serializer kept an older
 * three-field whitelist. A PLAN approval recorded WITH a content digest came
 * back WITHOUT one, so `gateGuard` correctly refused it and every durable
 * SQLite-backed plan was permanently stuck at approval. The real
 * `sf plan approve` path was dead while all 928 tests passed.
 *
 * The reason it passed 928 tests is the point of this file. Three findings in a
 * row have now come from the same gap: the suite exercised a SUBSTITUTE (an
 * in-memory Factory store, a fresh dispatcher, a pooled output channel) while
 * production used a different composition. So this suite is deliberately not a
 * unit test of the fix — `approvalContextRoundTrip.test.ts` is that. This is an
 * integration test of THE COMPOSITION `sf plan` ACTUALLY BUILDS:
 *
 *     real SQLite Factory store
 *   + real SQLite Plan repository
 *   + real FactoryService (real HumanIdentityGate, real PlanBindingResolver)
 *   + real PlanningService
 *   + trusted-human approval
 *   + materialization, derived approval, dispatch
 *   + close, reopen, continue
 *
 * Only the two AI seams are scripted — the planner and the TASK-004 loop — so
 * no model is ever invoked. Everything that persists authority is real.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createSqlitePlanRepository, type SqlitePlanRepository } from "../src/adapters/planning/sqlitePlanRepository.js";
import { createLocalHumanIdentityGate } from "../src/adapters/security/localHumanIdentityGate.js";
import { createLocalWorkerRegistry } from "../src/adapters/security/localWorkerRegistry.js";
import { createSqliteStore, type SqliteFactoryStore } from "../src/adapters/sqlite/sqliteStore.js";
import { FactoryService } from "../src/app/factoryService.js";
import { planSubject, workItemSubject } from "../src/domain/approval.js";
import { createSequentialIdGenerator } from "../src/domain/ids.js";
import { createPlanBindingResolver, PlanningService } from "../src/planning/planningService.js";
import {
  createScriptedDispatcher,
  createScriptedPlannerWorker,
  type ScriptedDispatcher,
} from "../src/planning/scriptedPlannerWorkers.js";
import { createFixedClock } from "../src/ports/clock.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import {
  PLAN_CREDENTIAL,
  PLAN_HUMAN,
  TEST_PLANNER_CONFIG,
  simplePlanResponse,
  testExecutionConfig,
} from "./support/planFixtures.js";

after(cleanupTempDbs);

interface ProductionStack {
  readonly store: SqliteFactoryStore;
  readonly plans: SqlitePlanRepository;
  readonly factory: FactoryService;
  readonly service: PlanningService;
  readonly dispatcher: ScriptedDispatcher;
  close(): void;
}

/**
 * Mirrors `src/cli/plan.ts`'s own wiring. If that file's composition changes,
 * this is the test that should be updated with it — deliberately, and with the
 * question "does the real path still round-trip authority?" asked again.
 */
function openProductionStack(factoryDb: string, plansDb: string, dispatcher?: ScriptedDispatcher): ProductionStack {
  const clock = createFixedClock("2026-01-01T00:00:00.000Z");
  const store = createSqliteStore(factoryDb);
  const plans = createSqlitePlanRepository(plansDb);
  const factory = new FactoryService({
    store,
    clock,
    ids: createSequentialIdGenerator(),
    identityGate: createLocalHumanIdentityGate({ credential: PLAN_CREDENTIAL, clock }),
    workerRegistry: createLocalWorkerRegistry(clock),
    planBindingResolver: createPlanBindingResolver(plans),
  });
  const loops = dispatcher ?? createScriptedDispatcher();
  const service = new PlanningService({
    factory,
    plans,
    clock,
    ids: createSequentialIdGenerator(),
    planner: createScriptedPlannerWorker({ outputs: [simplePlanResponse()] }),
    dispatcher: loops,
  });
  return {
    store,
    plans,
    factory,
    service,
    dispatcher: loops,
    close: () => {
      store.close();
      plans.close();
    },
  };
}

function trustedHuman(factory: FactoryService) {
  return factory.authorizeHuman(PLAN_HUMAN, PLAN_CREDENTIAL);
}

describe("ROUND 3: a durable SQLite-backed plan survives approval and restart", () => {
  it("keeps the plan gate satisfied immediately after a real approval", async () => {
    const stack = openProductionStack(tempDbPath("r3-gate-f-"), tempDbPath("r3-gate-p-"));
    try {
      const project = await stack.factory.createProject({ key: "TST", name: "Test Project" });
      const plan = await stack.service.start({
        projectId: project.id,
        actor: PLAN_HUMAN,
        intent: "Build the thing.",
        planner: TEST_PLANNER_CONFIG,
        execution: testExecutionConfig(),
      });
      assert.equal(plan.phase, "PLAN_REVIEW");

      const approved = await stack.service.approve(plan.id, PLAN_HUMAN, trustedHuman(stack.factory));

      // Read the approval BACK through SQLite: the binding must still be there.
      const stored = (await stack.factory.listApprovals(planSubject(plan.id))).at(-1)!;
      assert.equal(stored.context?.planContentDigest, approved.approvedDigest);
      assert.equal(stored.context?.specRevision, approved.approvedRevision);

      const gate = await stack.factory.gateStatus("PLAN_APPROVAL", planSubject(plan.id), {
        specRevision: approved.approvedRevision!,
        planContentDigest: approved.approvedDigest!,
      });
      assert.equal(gate.satisfied, true, gate.reason);
    } finally {
      stack.close();
    }
  });

  it("drives approve -> materialize -> derived approval -> dispatch across a restart", async () => {
    const factoryDb = tempDbPath("r3-full-f-");
    const plansDb = tempDbPath("r3-full-p-");
    const dispatcher = createScriptedDispatcher();

    // ---- process 1: plan and approve, then stop. ----
    const first = openProductionStack(factoryDb, plansDb, dispatcher);
    let planId: string;
    let approvedDigest: string;
    let approvedRevision: number;
    try {
      const project = await first.factory.createProject({ key: "TST", name: "Test Project" });
      const plan = await first.service.start({
        projectId: project.id,
        actor: PLAN_HUMAN,
        intent: "Build the thing.",
        planner: TEST_PLANNER_CONFIG,
        execution: testExecutionConfig(),
      });
      const approved = await first.service.approve(plan.id, PLAN_HUMAN, trustedHuman(first.factory));

      planId = plan.id;
      approvedDigest = approved.approvedDigest!;
      approvedRevision = approved.approvedRevision!;

      // The drive that follows approval already materialized and dispatched.
      assert.equal(approved.phase, "EXECUTING", approved.failureReason ?? "");
      assert.equal(approved.materialized.length, 1);
      assert.equal(approved.dispatches.length, 1);
    } finally {
      first.close();
    }

    // ---- process 2: reopen the same files and continue, with no re-approval. ----
    const second = openProductionStack(factoryDb, plansDb, dispatcher);
    try {
      const gate = await second.factory.gateStatus("PLAN_APPROVAL", planSubject(planId), {
        specRevision: approvedRevision,
        planContentDigest: approvedDigest,
      });
      assert.equal(gate.satisfied, true, `after reopen: ${gate.reason}`);

      const seen = await second.service.status(planId);
      assert.equal(seen.phase, "EXECUTING", seen.failureReason ?? "");

      const resumed = await second.service.resume(planId);
      assert.equal(resumed.phase, "EXECUTING", resumed.failureReason ?? "");

      // The derived per-work-item approval must have survived SQLite too, or
      // the work item could never have reached READY.
      const workItemId = resumed.materialized[0]!.workItemId;
      const item = await second.factory.getWorkItem(workItemId);
      assert.ok(
        ["READY", "IMPLEMENTING", "VERIFYING", "REVIEW", "WAITING_FOR_HUMAN"].includes(item.status),
        `work item is ${item.status}`,
      );

      const derived = (await second.factory.listApprovals(workItemSubject(workItemId))).at(-1)!;
      assert.equal(derived.gate, "PLAN_APPROVAL");
      assert.equal(derived.decision, "APPROVED");
      assert.equal(derived.decidedBy.id, PLAN_HUMAN.id, "still attributed to the real human");
      assert.equal(derived.context?.planId, planId, "planId survived SQLite");
      assert.equal(derived.context?.planRevision, approvedRevision, "planRevision survived SQLite");
      assert.ok(derived.context?.derivedFromApprovalId, "derivedFromApprovalId survived SQLite");

      const itemGate = await second.factory.gateStatus("PLAN_APPROVAL", workItemSubject(workItemId), {
        specRevision: item.specRevision,
      });
      assert.equal(itemGate.satisfied, true, itemGate.reason);

      // No duplicate approval was created by the restart.
      const planApprovals = await second.factory.listApprovals(planSubject(planId));
      assert.equal(planApprovals.length, 1, "restart did not re-approve");
      const itemApprovals = await second.factory.listApprovals(workItemSubject(workItemId));
      assert.equal(itemApprovals.length, 1, "restart did not re-derive");

      // And exactly one loop was ever dispatched.
      assert.equal(second.dispatcher.startCount(), 1);
    } finally {
      second.close();
    }
  });

  it("does not let a rejected plan become authoritative through persistence", async () => {
    const factoryDb = tempDbPath("r3-reject-f-");
    const plansDb = tempDbPath("r3-reject-p-");

    const first = openProductionStack(factoryDb, plansDb);
    let planId: string;
    try {
      const project = await first.factory.createProject({ key: "TST", name: "Test Project" });
      const plan = await first.service.start({
        projectId: project.id,
        actor: PLAN_HUMAN,
        intent: "Build the thing.",
        planner: TEST_PLANNER_CONFIG,
        execution: testExecutionConfig(),
      });
      planId = plan.id;
      const rejected = await first.service.reject(plan.id, PLAN_HUMAN, trustedHuman(first.factory));
      assert.equal(rejected.phase, "REJECTED");
    } finally {
      first.close();
    }

    const second = openProductionStack(factoryDb, plansDb);
    try {
      const gate = await second.factory.gateStatus("PLAN_APPROVAL", planSubject(planId));
      assert.equal(gate.satisfied, false, "a rejection is still a rejection after reopen");
      const seen = await second.service.status(planId);
      assert.equal(seen.phase, "REJECTED");
      assert.deepEqual(await second.factory.listWorkItemsByProject(seen.projectId), [], "nothing was created");
    } finally {
      second.close();
    }
  });

  it("does not let a superseded approval survive a content change across restart", async () => {
    const factoryDb = tempDbPath("r3-stale-f-");
    const plansDb = tempDbPath("r3-stale-p-");

    const first = openProductionStack(factoryDb, plansDb);
    let planId: string;
    try {
      const project = await first.factory.createProject({ key: "TST", name: "Test Project" });
      const plan = await first.service.start({
        projectId: project.id,
        actor: PLAN_HUMAN,
        intent: "Build the thing.",
        planner: TEST_PLANNER_CONFIG,
        execution: testExecutionConfig(),
      });
      planId = plan.id;
      const approved = await first.service.approve(plan.id, PLAN_HUMAN, trustedHuman(first.factory));

      // Move the approved work to another project, durably.
      const current = (await first.plans.findById(planId))!;
      await first.plans.compareAndSave(
        { ...current, version: current.version + 1, projectId: "prj-somewhere-else" },
        current.version,
      );
      assert.ok(approved.approvedDigest);
    } finally {
      first.close();
    }

    const second = openProductionStack(factoryDb, plansDb);
    try {
      // The plan row itself no longer loads: the approval digest covers the
      // project, so this is corruption, not a merely stale approval.
      await assert.rejects(() => second.service.status(planId), /approvedDigest|does not match/);
    } finally {
      second.close();
    }
  });
});
