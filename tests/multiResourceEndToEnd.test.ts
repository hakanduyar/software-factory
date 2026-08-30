/**
 * TASK-015 round-2 remediation.
 *
 * The reviewer's fifth finding was that nothing connected a REAL
 * `SupervisorService`-produced authorised set to the REAL plan-backed
 * authorization check: the supervisor tests used a custom executor, and the
 * executor tests injected `authorizedResources` by hand. A mutation disabling
 * the whole set branch passed 20 tests.
 *
 * So the first case here is the complete chain — real supervisor, real
 * declaration, real plan in a real database, real authorization check — for the
 * C4 shape that this entire task exists to permit.
 *
 * Offline: the advancer is scripted. No provider, no model, no money.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { cleanupTempDbs } from "./support/factoryFixtures.js";
import { newSupervisor, scriptedProbe, seedRoadmap } from "./support/supervisorFixtures.js";
import { createSqlitePlanRepository } from "../src/adapters/planning/sqlitePlanRepository.js";
import { approvalDigestOfPlan, computePlanContentDigest } from "../src/planning/planDigest.js";
import { createPlanBackedExecutor, type PlanAdvancer } from "../src/supervision/planBackedExecutor.js";
import type { Plan, PlannedWorkItem, PlannerConfig } from "../src/planning/planTypes.js";
import type { RequiredResource, WorkExecutionInput, WorkOutcome } from "../src/supervision/supervisorPorts.js";
import type { ScriptedExecutor } from "./support/supervisorFixtures.js";
import type { RoadmapItem } from "../src/supervision/supervisorTypes.js";
import { systemClock } from "../src/ports/clock.js";

const created: string[] = [];
after(() => {
  for (const path of created) {
    rmSync(path, { recursive: true, force: true });
  }
  cleanupTempDbs();
});

const CATALOG = [
  { provider: "claude-code", model: "opus", billingMode: "INCLUDED_SUBSCRIPTION" as const },
  { provider: "claude-code", model: "sonnet", billingMode: "INCLUDED_SUBSCRIPTION" as const },
  { provider: "codex-cli", model: "gpt-5.6-luna", billingMode: "INCLUDED_SUBSCRIPTION" as const },
];

const ITEM: RoadmapItem = {
  key: "GITHUB_ORCHESTRATION",
  title: "GitHub orchestration",
  dependsOn: [],
  status: "PENDING",
  workClass: "NORMAL_IMPLEMENTATION",
  order: 1,
};

function healthyProbe() {
  const probe = scriptedProbe();
  for (const entry of CATALOG) {
    probe.set(entry.provider, entry.model, {
      state: "AVAILABLE",
      reason: "scripted",
      billingMode: "INCLUDED_SUBSCRIPTION",
    });
  }
  return probe;
}

/** A persistable plan whose three roles are three distinct models — the C4 shape. */
function c4Plan(overrides: { readonly reviewer?: PlannerConfig } = {}): Plan {
  const reviewer = overrides.reviewer ?? { tool: "codex-cli", model: "gpt-5.6-luna" };
  const item: PlannedWorkItem = {
    key: "WI-A",
    title: "Do the thing",
    type: "FEATURE",
    priority: "P2",
    spec: "Implement the thing.",
    acceptanceCriteria: [{ text: "It works", verificationHint: "npm test" }],
    dependsOn: [],
  };
  const contentDigest = computePlanContentDigest({
    revision: 1,
    summary: "Deliver it.",
    assumptions: [],
    constraints: [],
    risks: [],
    items: [item],
  });
  const base = {
    id: "plan-c4-1",
    projectId: "prj-0001",
    requestKey: "req-c4-1",
    version: 1,
    /**
     * A REAL approval, because the repository refuses anything less: an
     * APPROVED phase presupposes a recorded approval, and a fixture that
     * skipped it would fail to persist and the test would pass for the wrong
     * reason. Round-3 of TASK-014 taught the same lesson about the phase itself.
     */
    phase: "APPROVED",
    approvalId: "apr-c4-1",
    approvedRevision: 1,
    approvedAt: 0,
    intent: "Build the thing.",
    declaredConstraints: [`roadmap-key: ${ITEM.key}`],
    budget: { maxPlannerAttempts: 2, maxClarificationCycles: 2, maxTotalPlannerRuns: 6 },
    planner: { tool: "claude-code", model: "sonnet" },
    execution: {
      implementer: { tool: "claude-code", model: "opus" },
      reviewer,
      verificationCommands: [{ id: "check", executable: "node", argv: ["-e", "0"] }],
      workspaceRoot: "/tmp/ws",
    },
    revisions: [
      {
        revision: 1,
        summary: "Deliver it.",
        assumptions: [],
        constraints: [],
        risks: [],
        items: [item],
        contentDigest,
        plannerRunRef: "plan-c4-1:r1:planner:a1",
        generatedAt: 0,
      },
    ],
    openQuestions: [],
    answers: [],
    attemptsForCurrentRevision: 0,
    clarificationCycles: 0,
    totalPlannerRuns: 1,
    materialized: [],
    dispatches: [],
    cancelRequested: false,
    events: [{ seq: 1, kind: "REQUEST_CREATED", detail: "created", at: 0 }],
    startedBy: { id: "user:test", kind: "HUMAN", displayName: "Test Human" },
    startedAt: 0,
    lastTransitionAt: 0,
  } as Plan;

  // The approval digest is computed FROM the finished plan, exactly as the real
  // approval path computes it, so the persisted record is internally consistent
  // rather than merely well-shaped.
  const revision = base.revisions[0];
  if (revision === undefined) throw new Error("the fixture lost its revision");
  return { ...base, approvedDigest: approvalDigestOfPlan(base, revision) } as Plan;
}

/** The REAL plan-backed executor over a REAL plans database. */
async function realExecutor(plan: Plan) {
  const dir = mkdtempSync(join(tmpdir(), "sf-e2e-set-"));
  created.push(dir);
  const plans = createSqlitePlanRepository(join(dir, "plans.db"));
  await plans.create(plan);

  const resumed: string[] = [];
  const advancer: PlanAdvancer = {
    async resume(planId: string): Promise<Plan> {
      resumed.push(planId);
      return { ...plan, phase: "EXECUTING" } as Plan;
    },
  };

  const executor = createPlanBackedExecutor({
    plans: { async findPlanForItem() { return plans.findById(plan.id); } },
    planning: advancer,
    state: { async verifiedPhase() { return "APPROVED"; } },
    clock: systemClock,
  });

  return { executor, resumed, close: () => plans.close() };
}

describe("TASK-015 AC-6 end to end: a real supervisor set meets the real plan check", () => {
  /**
   * THE WHOLE POINT OF THIS TASK, with nothing hand-injected: the supervisor
   * asks the real executor what the plan needs, authorises each of the three
   * distinct models, and the executor then verifies the plan against that set
   * and launches.
   *
   * A mutation that disables the set branch makes this fail, because the
   * fallback compares the plan's roles against the single ROUTED record.
   */
  it("authorises a C4 plan's three models and lets the plan launch", async () => {
    const real = await realExecutor(c4Plan());
    try {
      const supervisor = newSupervisor({
        probe: healthyProbe(),
        executor: real.executor as unknown as ScriptedExecutor,
        resourceCatalog: CATALOG,
      });
      await seedRoadmap(supervisor, [ITEM]);

      const result = await supervisor.service.tick();

      assert.deepEqual(
        real.resumed,
        ["plan-c4-1"],
        `the C4 plan was not launched through the real chain: ${JSON.stringify(result)}`,
      );
    } finally {
      real.close();
    }
  });

  /**
   * THE CONTROL, and the reason the case above is not merely "everything runs":
   * a plan whose reviewer is a model this build cannot launch must be refused,
   * and refused BEFORE anything runs.
   */
  it("refuses a plan naming a model this build does not support", async () => {
    const real = await realExecutor(c4Plan({ reviewer: { tool: "claude-code", model: "ghost-model" } }));
    try {
      const supervisor = newSupervisor({
        probe: healthyProbe(),
        executor: real.executor as unknown as ScriptedExecutor,
        resourceCatalog: CATALOG,
      });
      await seedRoadmap(supervisor, [ITEM]);

      const result = await supervisor.service.tick();

      assert.equal(result.kind, "RECOVERY_REQUIRED");
      assert.deepEqual(real.resumed, [], "an unsupported model was launched");
    } finally {
      real.close();
    }
  });
});

/** A declaration the supervisor should refuse outright. */
function declaring(...declared: readonly RequiredResource[]): ScriptedExecutor {
  const inputs: WorkExecutionInput[] = [];
  return {
    calls: () => inputs,
    callsFor: (key: string) => inputs.filter((entry) => entry.item.key === key),
    async declareResources(): Promise<readonly RequiredResource[]> {
      return declared;
    },
    async execute(input: WorkExecutionInput): Promise<WorkOutcome> {
      inputs.push(input);
      return { kind: "CHANGES_REQUIRED", findings: ["scripted"] };
    },
  };
}

async function tickWith(executor: ScriptedExecutor) {
  const supervisor = newSupervisor({ probe: healthyProbe(), executor, resourceCatalog: CATALOG });
  await seedRoadmap(supervisor, [ITEM]);
  return supervisor.service.tick();
}

describe("TASK-015 round-2 finding 3: an ambiguous declaration is refused", () => {
  const OPUS = { provider: "claude-code", model: "opus" } as const;
  const LUNA = { provider: "codex-cli", model: "gpt-5.6-luna" } as const;

  /**
   * A MISSPELLED ROLE used to fall back to the routed resource, so lineage
   * named a resource that did not implement — and the reviewer drove the
   * consequence out: the real implementer was then free to review its own work.
   */
  it("refuses a role it does not recognise", async () => {
    /**
     * A VALID IMPLEMENTER IS PRESENT ON PURPOSE.
     *
     * The first version of this case declared only `implementor`, so with the
     * role check deleted it still failed the exactly-one-implementer rule and
     * the test passed for the wrong reason — a mutation removing the role check
     * survived it. Pairing a good implementer with a misspelled REVIEWER leaves
     * the count correct, so only the role check can produce a refusal.
     */
    const executor = declaring({ role: "implementer", ...OPUS }, { role: "reviewr" as never, ...LUNA });

    const result = await tickWith(executor);

    assert.equal(result.kind, "RECOVERY_REQUIRED");
    assert.match(
      result.kind === "RECOVERY_REQUIRED" ? result.reason : "",
      /is not one of/,
      "refused for some reason other than the unrecognised role",
    );
    assert.equal(executor.calls().length, 0, "work ran on an unrecognised role");
  });

  it("refuses a declaration with no implementer at all", async () => {
    const executor = declaring({ role: "reviewer", ...LUNA });

    const result = await tickWith(executor);

    assert.equal(result.kind, "RECOVERY_REQUIRED");
    assert.equal(executor.calls().length, 0);
  });

  /** Two implementers is ambiguity, and picking the first is how lineage lies. */
  it("refuses a declaration naming two implementers", async () => {
    const executor = declaring({ role: "implementer", ...OPUS }, { role: "implementer", ...LUNA });

    const result = await tickWith(executor);

    assert.equal(result.kind, "RECOVERY_REQUIRED");
    assert.equal(executor.calls().length, 0);
  });

  /** THE CONTROL: a well-formed declaration still runs. */
  it("permits a declaration naming exactly one implementer", async () => {
    const executor = declaring({ role: "implementer", ...OPUS }, { role: "reviewer", ...LUNA });

    const result = await tickWith(executor);

    assert.equal(result.kind, "ADVANCED", `a valid declaration was refused: ${JSON.stringify(result)}`);
    assert.equal(executor.calls().length, 1);
  });

  it("refuses a model this build cannot launch", async () => {
    const executor = declaring({ role: "implementer", provider: "claude-code", model: "ghost-model" });

    const result = await tickWith(executor);

    assert.equal(result.kind, "RECOVERY_REQUIRED");
    assert.equal(executor.calls().length, 0, "an unsupported model was launched");
  });
});
