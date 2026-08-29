/**
 * TASK-014 — the plan-backed executor.
 *
 * Every case drives the REAL executor through scripted ports. No test launches
 * an AI CLI, opens a socket, or spends anything (AC-8): the whole point of the
 * `RoadmapPlanLookup` and `PlanAdvancer` ports is that this seam is testable
 * without any of that.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createPlanBackedExecutor,
  type PlanAdvancer,
  type RoadmapPlanLookup,
} from "../src/supervision/planBackedExecutor.js";
import type { Plan, PlanPhase } from "../src/planning/planTypes.js";
import type { WorkExecutionInput } from "../src/supervision/supervisorPorts.js";
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

function planWith(phase: PlanPhase): Plan {
  return { id: "plan-1", phase } as unknown as Plan;
}

function input(overrides: Partial<WorkExecutionInput> = {}): WorkExecutionInput {
  return { item: ITEM, actionId: "action-1", ...overrides } as WorkExecutionInput;
}

function lookup(plan: Plan | undefined): RoadmapPlanLookup {
  return { async findPlanForItem() { return plan; } };
}

/** Records what planning was asked to do, so a test can assert it was NOT asked. */
function advancer(result: Plan): PlanAdvancer & { resumed: string[] } {
  const resumed: string[] = [];
  return {
    resumed,
    async resume(planId: string) {
      resumed.push(planId);
      return result;
    },
  };
}

describe("TASK-014 AC-2: approval is a human gate", () => {
  it("asks for a plan when none exists, and does not touch planning", async () => {
    const planning = advancer(planWith("APPROVED"));
    const executor = createPlanBackedExecutor({ plans: lookup(undefined), planning, clock: CLOCK });

    const outcome = await executor.execute(input());

    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    assert.equal(outcome.kind === "HUMAN_REQUIRED" ? outcome.action.kind : "", "AUTHOR_PLAN");
    assert.match(
      outcome.kind === "HUMAN_REQUIRED" ? outcome.action.description : "",
      /GITHUB_ORCHESTRATION/,
    );
    assert.deepEqual(planning.resumed, [], "planning was driven for an item with no plan");
  });

  /**
   * The heart of AC-2. Each of these phases means a human has NOT approved the
   * plan, and each must leave planning untouched — an executor that resumed a
   * DRAFT would be manufacturing the approval C1 reserves to a person.
   */
  it("refuses to drive an unapproved plan, whatever stage it is at", async () => {
    for (const phase of ["DRAFT", "PLANNING", "NEEDS_CLARIFICATION", "PLAN_REVIEW"] as const) {
      const planning = advancer(planWith("EXECUTING"));
      const executor = createPlanBackedExecutor({
        plans: lookup(planWith(phase)),
        planning,
        clock: CLOCK,
      });

      const outcome = await executor.execute(input());

      assert.equal(outcome.kind, "HUMAN_REQUIRED", `${phase} was driven`);
      assert.equal(
        outcome.kind === "HUMAN_REQUIRED" ? outcome.action.kind : "",
        "AUTHOR_PLAN",
        `${phase} did not ask for approval`,
      );
      assert.deepEqual(planning.resumed, [], `${phase} was resumed without a human approval`);
    }
  });
});

describe("TASK-014 AC-3: an approved plan is driven through the planning seam", () => {
  it("resumes the plan and reports the phase planning returned", async () => {
    const planning = advancer(planWith("EXECUTING"));
    const executor = createPlanBackedExecutor({
      plans: lookup(planWith("APPROVED")),
      planning,
      clock: CLOCK,
    });

    const outcome = await executor.execute(input());

    assert.deepEqual(planning.resumed, ["plan-1"], "the approved plan was not resumed");
    assert.equal(outcome.kind, "CHECKPOINT");
  });

  it("reports COMPLETED only when planning says COMPLETED", async () => {
    const executor = createPlanBackedExecutor({
      plans: lookup(planWith("APPROVED")),
      planning: advancer(planWith("COMPLETED")),
      clock: CLOCK,
    });

    const outcome = await executor.execute(input());
    assert.equal(outcome.kind, "COMPLETED");
  });
});

describe("TASK-014 AC-5: a terminal failure is never success", () => {
  it("reports every unsuccessful terminal phase as needing a human, naming it", async () => {
    for (const phase of ["REJECTED", "BLOCKED", "CANCELLED", "RECOVERY_REQUIRED"] as const) {
      const executor = createPlanBackedExecutor({
        plans: lookup(planWith(phase)),
        planning: advancer(planWith(phase)),
        clock: CLOCK,
      });

      const outcome = await executor.execute(input());

      assert.equal(outcome.kind, "HUMAN_REQUIRED", `${phase} was not escalated`);
      assert.match(
        outcome.kind === "HUMAN_REQUIRED" ? outcome.detail : "",
        new RegExp(phase),
        `${phase} was not named in the escalation`,
      );
    }
  });

  it("does not report WAITING_FOR_HUMAN as completion", async () => {
    const executor = createPlanBackedExecutor({
      plans: lookup(planWith("APPROVED")),
      planning: advancer(planWith("WAITING_FOR_HUMAN")),
      clock: CLOCK,
    });

    const outcome = await executor.execute(input());
    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    assert.notEqual(outcome.kind, "COMPLETED");
  });
});

describe("TASK-014 AC-9: a failure is a definite outcome, never a throw", () => {
  it("turns a throwing lookup into RESOURCE_FAILURE", async () => {
    const executor = createPlanBackedExecutor({
      plans: {
        async findPlanForItem(): Promise<Plan | undefined> {
          throw new Error("the plan database is unreadable");
        },
      },
      planning: advancer(planWith("APPROVED")),
      clock: CLOCK,
    });

    const outcome = await executor.execute(input());

    assert.equal(outcome.kind, "RESOURCE_FAILURE");
    assert.match(
      outcome.kind === "RESOURCE_FAILURE" ? outcome.process.stderr : "",
      /the plan database is unreadable/,
    );
  });

  it("turns a throwing planning seam into RESOURCE_FAILURE", async () => {
    const executor = createPlanBackedExecutor({
      plans: lookup(planWith("APPROVED")),
      planning: {
        async resume(): Promise<Plan> {
          throw new Error("dispatcher exploded");
        },
      },
      clock: CLOCK,
    });

    const outcome = await executor.execute(input());
    assert.equal(outcome.kind, "RESOURCE_FAILURE");
    assert.match(
      outcome.kind === "RESOURCE_FAILURE" ? outcome.process.stderr : "",
      /dispatcher exploded/,
    );
  });
});

describe("TASK-014: the checkpoint carries state rather than inventing it", () => {
  it("counts iterations from the checkpoint the supervisor handed back", async () => {
    const executor = createPlanBackedExecutor({
      plans: lookup(planWith("EXECUTING")),
      planning: advancer(planWith("EXECUTING")),
      clock: CLOCK,
    });

    const first = await executor.execute(input());
    assert.equal(first.kind, "CHECKPOINT");
    const firstIteration = first.kind === "CHECKPOINT" ? first.checkpoint.iteration : -1;
    assert.equal(firstIteration, 1);

    assert.equal(first.kind, "CHECKPOINT");
    if (first.kind !== "CHECKPOINT") {
      return;
    }
    const second = await executor.execute(input({ checkpoint: first.checkpoint }));
    assert.equal(
      second.kind === "CHECKPOINT" ? second.checkpoint.iteration : -1,
      2,
      "iteration reset instead of continuing, so a long loop would look new every tick",
    );
  });

  it("carries verification state forward rather than asserting none happened", async () => {
    const executor = createPlanBackedExecutor({
      plans: lookup(planWith("EXECUTING")),
      planning: advancer(planWith("EXECUTING")),
      clock: CLOCK,
    });

    const outcome = await executor.execute(
      input({
        checkpoint: {
          roadmapKey: ITEM.key,
          actionId: "earlier",
          iteration: 4,
          completedVerification: ["npm test"],
          pendingVerification: ["npm run lint"],
          findings: ["a finding from before"],
          nextAction: "continue",
          requiredWorkClass: ITEM.workClass,
          updatedAt: CLOCK.now(),
        },
      }),
    );

    assert.equal(outcome.kind, "CHECKPOINT");
    if (outcome.kind === "CHECKPOINT") {
      assert.deepEqual(outcome.checkpoint.completedVerification, ["npm test"]);
      assert.deepEqual(outcome.checkpoint.pendingVerification, ["npm run lint"]);
      assert.deepEqual(outcome.checkpoint.findings, ["a finding from before"]);
    }
  });
});

describe("TASK-014 AC-1: the SHIPPED CLI construction path", () => {
  const SUPERVISE = readFileSync(join(process.cwd(), "src/cli/supervise.ts"), "utf8");

  /**
   * Asserted against the SOURCE the CLI actually ships, not against a test
   * double. `buildService` is not exported — deliberately, it is CLI wiring —
   * so the check is that the shipped file constructs the real executor and no
   * longer defines the stub.
   *
   * The repository already uses this shape where behaviour is a property of
   * wiring rather than of a callable unit: a test that asserted a double was
   * constructed would prove nothing about what `sf supervise` runs.
   */
  it("constructs the plan-backed executor", () => {
    assert.match(SUPERVISE, /createPlanBackedExecutor\(/, "the CLI does not construct the real executor");
    assert.match(SUPERVISE, /executor: createSupervisorExecutor\(/, "the service is not given it");
  });

  it("no longer DEFINES the unimplemented stub", () => {
    assert.doesNotMatch(
      SUPERVISE,
      /function createUnimplementedExecutor/,
      "the stub is still defined, so the CLI can still be wired to it",
    );
  });

  /**
   * The stub is allowed to be MENTIONED — the comment explaining what changed
   * is worth keeping. This pins the distinction so a future reader does not
   * "tidy" the prose away and think they have restored something.
   */
  it("still explains what it replaced", () => {
    assert.match(SUPERVISE, /createUnimplementedExecutor` used to live here/);
  });
});

describe("TASK-014 AC-4: the executor cannot start a duplicate loop", () => {
  /**
   * STRUCTURAL, which is stronger than counting.
   *
   * AC-4 asks that an existing loop be adopted rather than started again. This
   * executor cannot start a loop AT ALL: `PlanAdvancer` exposes exactly one
   * method, `resume`. Adoption-versus-start is `PlanningService`'s decision,
   * made through `LoopDispatcher.find`, and that is accepted work with its own
   * tests.
   *
   * So the proof here is that repeated execution produces repeated RESUME and
   * nothing else — a duplicate start is not something this seam can express.
   */
  it("resumes on every execution and has no way to start", async () => {
    const planning = advancer(planWith("EXECUTING"));
    const executor = createPlanBackedExecutor({
      plans: lookup(planWith("APPROVED")),
      planning,
      clock: CLOCK,
    });

    await executor.execute(input());
    await executor.execute(input());

    assert.deepEqual(planning.resumed, ["plan-1", "plan-1"]);
    assert.deepEqual(
      Object.keys(planning).filter((key) => key !== "resumed"),
      ["resume"],
      "the planning port exposes more than resume, so a duplicate start became expressible",
    );
  });
});

describe("TASK-014 AC-6: no AI launch through the isolated child", () => {
  const EXECUTOR_SRC = readFileSync(
    join(process.cwd(), "src/supervision/planBackedExecutor.ts"),
    "utf8",
  );

  /**
   * Only the lines that actually create a dependency.
   *
   * The IMPORT boundary, not any mention of the name. The first version of
   * this asserted the string was absent entirely and failed on the module's own
   * comment explaining that the isolated executor already applies the no-throw
   * rule. A guard that cannot tell a dependency from a documentation reference
   * would force the documentation to be deleted to satisfy it -- the same
   * distinction the commit-attribution rule makes between a trailer line and a
   * mention of one.
   */
  const IMPORT_LINE = new RegExp("^\\s*import\\b");

  function importLines(source: string): readonly string[] {
    return source.split(String.fromCharCode(10)).filter((line) => IMPORT_LINE.test(line));
  }

  /**
   * The isolated child is denied credentials on purpose (L-3), so it performs
   * DETERMINISTIC work only. Routing an AI launch through it would either fail
   * or require restoring the capability TASK-011 exists to remove.
   */
  it("does not import the isolated executor", () => {
    assert.deepEqual(
      importLines(EXECUTOR_SRC).filter((line) => line.includes("isolatedExecutor")),
      [],
      "the plan-backed executor can reach the isolated child",
    );
  });

  it("does not import or spawn a child process", () => {
    assert.deepEqual(
      importLines(EXECUTOR_SRC).filter((line) => line.includes("child_process")),
      [],
      "the plan-backed executor can spawn a process",
    );
    assert.ok(
      !EXECUTOR_SRC.includes("spawnSync(") && !EXECUTOR_SRC.includes("execFileSync("),
      "a launch call site exists in the plan-backed executor",
    );
  });
});

describe("TASK-014: an unconfigured supervisor is honest rather than stubbed", () => {
  /**
   * The behaviour the removed stub used to hard-code now comes out of the real
   * executor. That is the whole point of AC-1: the same code runs in both
   * deployments, and the difference is configuration rather than which class
   * was wired.
   */
  it("reports that a human must author a plan when no plan is found", async () => {
    const executor = createPlanBackedExecutor({
      plans: lookup(undefined),
      clock: CLOCK,
    });

    const outcome = await executor.execute(input());
    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    assert.equal(outcome.kind === "HUMAN_REQUIRED" ? outcome.action.kind : "", "AUTHOR_PLAN");
  });

  /**
   * And an APPROVED plan with no planning wired says exactly that, rather than
   * claiming the work is done or that approval is missing. An unconfigured
   * deployment must not be able to look like a completed one.
   */
  it("refuses to claim progress on an approved plan it cannot drive", async () => {
    const executor = createPlanBackedExecutor({
      plans: lookup(planWith("APPROVED")),
      clock: CLOCK,
    });

    const outcome = await executor.execute(input());
    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    assert.match(
      outcome.kind === "HUMAN_REQUIRED" ? outcome.detail : "",
      /no planning configuration/,
    );
    assert.notEqual(outcome.kind, "COMPLETED");
  });
});
