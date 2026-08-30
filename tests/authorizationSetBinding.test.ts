/**
 * TASK-015: the authorised SET is exact, and it is checked against what the
 * plan says AT LAUNCH.
 *
 * Both cases here exist because mutation testing found them missing. Six of
 * eight TASK-015 mutations died against the tests written first; these two
 * survived:
 *
 *   L — `coveredBy` degraded to compare PROVIDER ONLY, and everything passed.
 *       No case had a role whose provider matched an authorised entry while its
 *       model differed, so "same provider is close enough" was indistinguishable
 *       from exact membership.
 *   F — the pre-launch re-read replaced by the stale in-memory plan, and
 *       everything passed. No case changed the plan between the declaration and
 *       the launch, so the whole point of re-reading was unobserved.
 *
 * A guard nothing can distinguish from its absence is not known to work.
 *
 * Offline: no provider, no model, no money.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPlanBackedExecutor, type PlanAdvancer } from "../src/supervision/planBackedExecutor.js";
import type { AuthorizedResource, WorkOutcome } from "../src/supervision/supervisorPorts.js";
import type { Plan } from "../src/planning/planTypes.js";
import type { RoadmapItem } from "../src/supervision/supervisorTypes.js";
import type { Timestamp } from "../src/domain/time.js";

const CLOCK = { now: (): Timestamp => 1756449600000 as Timestamp };

const ITEM: RoadmapItem = {
  key: "GITHUB_ORCHESTRATION",
  title: "GitHub orchestration",
  dependsOn: [],
  status: "ELIGIBLE",
  workClass: "NORMAL_IMPLEMENTATION",
  order: 6,
};

/** The set the supervisor authorised: exactly one provider/model, no effort. */
const AUTHORIZED: readonly AuthorizedResource[] = [
  { role: "implementer", provider: "claude-code", model: "opus", billingMode: "INCLUDED_SUBSCRIPTION" },
];

function planRunning(worker: { tool: string; model: string; effort?: string }): Plan {
  return {
    id: "plan-1",
    phase: "APPROVED",
    declaredConstraints: [`roadmap-key: ${ITEM.key}`],
    planner: worker,
    execution: {
      implementer: worker,
      reviewer: worker,
      verificationCommands: [],
      workspaceRoot: "/tmp/ws",
    },
  } as unknown as Plan;
}

function advancer(): PlanAdvancer & { readonly resumed: string[] } {
  const resumed: string[] = [];
  return {
    resumed,
    async resume(planId: string): Promise<Plan> {
      resumed.push(planId);
      return { ...planRunning({ tool: "claude-code", model: "opus" }), phase: "EXECUTING" } as Plan;
    },
  };
}

/**
 * Runs the executor against a lookup whose answer can CHANGE between calls.
 *
 * `reads` are returned in order and the last repeats, which is what lets a case
 * model a plan edited after its resources were declared and authorised.
 */
async function execute(reads: readonly Plan[]): Promise<{ outcome: WorkOutcome; resumed: string[] }> {
  const queue = [...reads];
  const planning = advancer();
  const executor = createPlanBackedExecutor({
    plans: {
      async findPlanForItem(): Promise<Plan> {
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next === undefined) throw new Error("the test supplied no plan");
        return next;
      },
    },
    planning,
    state: { async verifiedPhase() { return "APPROVED"; } },
    clock: CLOCK,
  });

  const outcome = await executor.execute({
    item: ITEM,
    actionId: "action-1",
    authorizedResources: AUTHORIZED,
  });
  return { outcome, resumed: planning.resumed };
}

describe("TASK-015: membership in the authorised set is exact", () => {
  it("permits the resource that is actually in the set", async () => {
    const { outcome, resumed } = await execute([planRunning({ tool: "claude-code", model: "opus" })]);

    assert.deepEqual(resumed, ["plan-1"], "an authorised resource was refused");
    assert.notEqual(outcome.kind, "HUMAN_REQUIRED");
  });

  /**
   * THE MUTATION L KILLER. Same provider, different model. A gate that cleared
   * `claude-code/opus` says nothing whatsoever about `claude-code/sonnet`, and a
   * provider is not a resource.
   */
  it("refuses a different model on an authorised provider", async () => {
    const { outcome, resumed } = await execute([planRunning({ tool: "claude-code", model: "sonnet" })]);

    assert.deepEqual(resumed, [], "an unauthorised model ran because its provider was authorised");
    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    assert.match(outcome.kind === "HUMAN_REQUIRED" ? outcome.detail : "", /sonnet/);
  });

  /**
   * Effort is part of the identity for a set exactly as it was for a single
   * record: `opus` at an effort nobody priced is not `opus`.
   */
  it("refuses an effort the set does not name", async () => {
    const { outcome, resumed } = await execute([
      planRunning({ tool: "claude-code", model: "opus", effort: "xhigh" }),
    ]);

    assert.deepEqual(resumed, [], "an unauthorised effort ran");
    assert.equal(outcome.kind, "HUMAN_REQUIRED");
  });
});

describe("TASK-015: the plan is re-read at the last point before launch", () => {
  /**
   * THE MUTATION F KILLER.
   *
   * The supervisor authorised the set from a declaration made against the FIRST
   * read. The plan is then edited — a re-plan, an operator change, anything with
   * write access — so the row now names a resource nobody gated. Authorising
   * what the plan used to say while the child runs what it says now is the same
   * defect as authorising X and running Y, reached by waiting.
   */
  it("refuses when the plan's resources changed after it was authorised", async () => {
    const { outcome, resumed } = await execute([
      // Declared and authorised against this.
      planRunning({ tool: "claude-code", model: "opus" }),
      // Edited before the launch to something outside the set.
      planRunning({ tool: "codex-cli", model: "gpt-5.6-luna" }),
    ]);

    assert.deepEqual(resumed, [], "the launch used a stale plan and ran an ungated resource");
    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    assert.match(outcome.kind === "HUMAN_REQUIRED" ? outcome.detail : "", /codex-cli/);
  });

  /**
   * THE CONTROL. A plan that changes into something still authorised must still
   * run — otherwise the guard above is satisfied by refusing every change, which
   * proves nothing about reading freshly.
   */
  it("still launches when the change stays inside the authorised set", async () => {
    const { outcome, resumed } = await execute([
      planRunning({ tool: "claude-code", model: "opus" }),
      // A different object, same authorised identity.
      planRunning({ tool: "claude-code", model: "opus" }),
    ]);

    assert.deepEqual(resumed, ["plan-1"], "a harmless change was treated as a violation");
    assert.notEqual(outcome.kind, "HUMAN_REQUIRED");
  });

  /**
   * And the BINDING is re-checked on the fresh read too: a plan re-pointed at a
   * different roadmap item after authorisation must not launch either.
   */
  it("refuses when the plan's roadmap declaration changed after it was authorised", async () => {
    const moved = {
      ...planRunning({ tool: "claude-code", model: "opus" }),
      declaredConstraints: ["roadmap-key: LOCAL_24_7_RUNTIME"],
    } as Plan;

    const { outcome, resumed } = await execute([planRunning({ tool: "claude-code", model: "opus" }), moved]);

    assert.deepEqual(resumed, [], "a plan re-pointed at another item still launched");
    assert.match(outcome.kind === "HUMAN_REQUIRED" ? outcome.detail : "", /LOCAL_24_7_RUNTIME/);
  });
});
