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
import { after, describe, it } from "node:test";

import { cleanupTempDbs } from "./support/factoryFixtures.js";
import { newSupervisor, scriptedProbe, seedRoadmap } from "./support/supervisorFixtures.js";
import { approvedPlan, newPlanning } from "./support/planFixtures.js";
import { createPlanBackedExecutor, type PlanAdvancer } from "../src/supervision/planBackedExecutor.js";
import type { Plan, PlannerConfig } from "../src/planning/planTypes.js";
import type { RequiredResource, WorkExecutionInput, WorkOutcome } from "../src/supervision/supervisorPorts.js";
import type { ScriptedExecutor } from "./support/supervisorFixtures.js";
import type { RoadmapItem } from "../src/supervision/supervisorTypes.js";
import { systemClock } from "../src/ports/clock.js";

after(cleanupTempDbs);

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

/**
 * A REAL approved plan, through the REAL approval gate (round-3 finding 5).
 *
 * The first version of this helper hand-built an approval-shaped row and paired
 * it with a `verifiedPhase` that answered "APPROVED" unconditionally — so it
 * exercised the set path but not Factory approval authority, which the reviewer
 * correctly called out as a weaker claim than the test's name implied.
 *
 * Everything here comes from the real planning fixtures instead: the approval is
 * minted by the gate that mints approvals, the digest is the one that gate
 * computed, and the executor's authority reader is the real
 * `PlanningService.status`, which runs `projectFailClosed` against the Factory's
 * own records.
 */
async function realExecutor(reviewer: PlannerConfig) {
  const context = await newPlanning();
  const plan = await approvedPlan(context, "Build the thing.", {
    constraints: [`roadmap-key: ${ITEM.key}`],
    planner: { tool: "claude-code", model: "sonnet" },
    execution: {
      implementer: { tool: "claude-code", model: "opus" },
      reviewer,
      verificationCommands: [{ id: "check", executable: "node", argv: ["-e", "process.exit(0)"] }],
      workspaceRoot: "/tmp/sf-plan-test",
      loopBudget: { maxIterations: 2 },
    },
  });

  const resumed: string[] = [];
  const advancer: PlanAdvancer = {
    async resume(planId: string): Promise<Plan> {
      resumed.push(planId);
      const current = await context.plans.findById(planId);
      if (current === undefined) throw new Error("the fixture plan vanished");
      return current;
    },
  };

  const executor = createPlanBackedExecutor({
    plans: { async findPlanForItem() { return context.plans.findById(plan.id); } },
    planning: advancer,
    // REAL authority: this is the projection that demotes a plan whose approval
    // can no longer be re-derived, not a constant.
    state: {
      async verifiedPhase(planId: string) {
        return (await context.service.status(planId)).phase;
      },
    },
    clock: systemClock,
  });

  return { executor, resumed, close: () => {} };
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
    const real = await realExecutor({ tool: "codex-cli", model: "gpt-5.6-luna" });
    try {
      const supervisor = newSupervisor({
        probe: healthyProbe(),
        executor: real.executor as unknown as ScriptedExecutor,
        resourceCatalog: CATALOG,
      });
      await seedRoadmap(supervisor, [ITEM]);

      const result = await supervisor.service.tick();

      assert.equal(
        real.resumed.length,
        1,
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
    const real = await realExecutor({ tool: "claude-code", model: "ghost-model" });
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
