/**
 * TASK-014 round-3 finding 3 (HIGH): a bindings file alone does not establish
 * that a plan has anything to do with a roadmap item.
 *
 * The reviewer bound a perfectly valid approved plan — whose own work item is
 * `WI-A` — under the unrelated roadmap key `LOCAL_24_7_RUNTIME`, and the
 * supervisor resumed it. One mistaken line in a JSON file was enough to execute
 * unrelated approved work.
 *
 * Offline: no provider, no model, no money.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkPlanBinding, declaredRoadmapKeys } from "../src/supervision/planBinding.js";
import { createPlanBackedExecutor, type PlanAdvancer } from "../src/supervision/planBackedExecutor.js";
import type { AiRunConfigRecord } from "../src/supervision/modelEnforcement.js";
import type { Plan } from "../src/planning/planTypes.js";
import type { RoadmapItem } from "../src/supervision/supervisorTypes.js";
import type { Timestamp } from "../src/domain/time.js";

const CLOCK = { now: (): Timestamp => 1756449600000 as Timestamp };

const ITEM: RoadmapItem = {
  key: "GITHUB_ORCHESTRATION",
  title: "GitHub Issues/Projects/PR orchestration (zero-cost tier only)",
  dependsOn: [],
  status: "ELIGIBLE",
  workClass: "NORMAL_IMPLEMENTATION",
  order: 6,
};

const WORKER = { tool: "claude-code", model: "opus" };

const AUTHORIZED: AiRunConfigRecord = {
  requestedProvider: "claude-code",
  requestedModel: "opus",
  effectiveProvider: "claude-code",
  effectiveModel: "opus",
  verification: "UNVERIFIED",
  argvEvidence: ["claude", "--model", "opus"],
  note: "scripted for tests",
};

function planDeclaring(constraints: readonly string[], phase: Plan["phase"] = "APPROVED"): Plan {
  return {
    id: "plan-1",
    phase,
    declaredConstraints: constraints,
    planner: WORKER,
    execution: {
      implementer: WORKER,
      reviewer: WORKER,
      verificationCommands: [],
      workspaceRoot: "/tmp/ws",
    },
  } as unknown as Plan;
}

/** Records every launch, so a test can assert there was none. */
function advancer(): PlanAdvancer & { readonly resumed: string[] } {
  const resumed: string[] = [];
  return {
    resumed,
    async resume(planId: string): Promise<Plan> {
      resumed.push(planId);
      return planDeclaring([`roadmap-key: ${ITEM.key}`], "EXECUTING");
    },
  };
}

async function execute(plan: Plan) {
  const planning = advancer();
  const executor = createPlanBackedExecutor({
    plans: { async findPlanForItem() { return plan; } },
    planning,
    state: { async verifiedPhase() { return plan.phase; } },
    clock: CLOCK,
  });
  const outcome = await executor.execute({ item: ITEM, actionId: "action-1", config: AUTHORIZED });
  return { outcome, resumed: planning.resumed };
}

describe("TASK-014: the plan must name the roadmap item it serves", () => {
  it("reads exactly the keys a plan declares", () => {
    assert.deepEqual(declaredRoadmapKeys(planDeclaring([])), []);
    assert.deepEqual(declaredRoadmapKeys(planDeclaring(["roadmap-key: A"])), ["A"]);
    // Case and surrounding space are an operator's typing, not a different key.
    assert.deepEqual(declaredRoadmapKeys(planDeclaring(["  Roadmap-Key:   A  "])), ["A"]);
    // Unrelated constraints are not roadmap declarations.
    assert.deepEqual(declaredRoadmapKeys(planDeclaring(["no network access", "roadmap-key: A"])), ["A"]);
  });

  /**
   * THE REVIEWER'S REPRODUCTION. A valid approved plan for one item, bound to
   * another, must not run.
   */
  it("refuses a plan that declares a different roadmap item", async () => {
    const { outcome, resumed } = await execute(planDeclaring(["roadmap-key: LOCAL_24_7_RUNTIME"]));

    assert.deepEqual(resumed, [], "approved work belonging to another roadmap item was executed");
    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    const detail = outcome.kind === "HUMAN_REQUIRED" ? outcome.detail : "";
    assert.match(detail, /LOCAL_24_7_RUNTIME/, "the refusal does not name what the plan declares");
    assert.match(detail, /GITHUB_ORCHESTRATION/, "the refusal does not name what it was bound to");
  });

  it("refuses a plan that declares no roadmap item at all", async () => {
    const { outcome, resumed } = await execute(planDeclaring([]));

    assert.deepEqual(resumed, [], "a plan with no roadmap identity was executed");
    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    assert.match(
      outcome.kind === "HUMAN_REQUIRED" ? outcome.detail : "",
      /declares no roadmap item/,
    );
  });

  /**
   * Two declarations are ambiguity, and ambiguity resolved by ordering is how a
   * plan ends up matching whichever item asks first.
   */
  it("refuses a plan that declares more than one roadmap item", async () => {
    const { outcome, resumed } = await execute(
      planDeclaring([`roadmap-key: ${ITEM.key}`, "roadmap-key: LOCAL_24_7_RUNTIME"]),
    );

    assert.deepEqual(resumed, []);
    assert.match(outcome.kind === "HUMAN_REQUIRED" ? outcome.detail : "", /declares 2 roadmap items/);
  });

  /**
   * THE CONTROL. The guard must ACCEPT a correctly declared plan, or it is
   * satisfied by refusing everything — which proves nothing about binding.
   */
  it("permits a plan that declares the item it is bound to", async () => {
    const { outcome, resumed } = await execute(planDeclaring([`roadmap-key: ${ITEM.key}`]));

    assert.deepEqual(resumed, ["plan-1"], "a correctly bound plan was refused");
    assert.notEqual(outcome.kind, "HUMAN_REQUIRED");
  });

  /**
   * The check runs before ANY outcome is derived, not only before a launch.
   * Reporting an unrelated plan's BLOCKED as this item's blocker would be a
   * false durable record even though nothing ran.
   */
  it("refuses to report an unrelated plan's state as this item's state", async () => {
    const blocked = {
      ...planDeclaring(["roadmap-key: LOCAL_24_7_RUNTIME"], "BLOCKED"),
      failureReason: "verifier failed for command test",
    } as Plan;

    const { outcome } = await execute(blocked);

    const detail = outcome.kind === "HUMAN_REQUIRED" ? outcome.detail : "";
    assert.doesNotMatch(
      detail,
      /verifier failed for command test/,
      "another item's failure was reported as this item's",
    );
    assert.match(detail, /LOCAL_24_7_RUNTIME/);
  });

  it("is a pure rule: the same inputs give the same verdict", () => {
    assert.equal(checkPlanBinding("A", planDeclaring(["roadmap-key: A"])).ok, true);
    assert.equal(checkPlanBinding("B", planDeclaring(["roadmap-key: A"])).ok, false);
  });
});
