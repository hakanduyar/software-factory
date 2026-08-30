/**
 * TASK-014 — the plan-backed executor.
 *
 * Every case drives the REAL executor through scripted ports. No test launches
 * an AI CLI, opens a socket, or spends anything (AC-8): the whole point of the
 * `RoadmapPlanLookup` and `PlanAdvancer` ports is that this seam is testable
 * without any of that.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  createPlanBackedExecutor,
  type PlanAdvancer,
  type RoadmapPlanLookup,
} from "../src/supervision/planBackedExecutor.js";
import { createSqlitePlanRepository } from "../src/adapters/planning/sqlitePlanRepository.js";
import { computePlanContentDigest } from "../src/planning/planDigest.js";
import type { AiRunConfigRecord } from "../src/supervision/modelEnforcement.js";
import type { Plan, PlanPhase, PlannedWorkItem } from "../src/planning/planTypes.js";
import type { WorkExecutionInput } from "../src/supervision/supervisorPorts.js";
import type { RoadmapItem } from "../src/supervision/supervisorTypes.js";

import { runSuperviseTick } from "../src/cli/supervise.js";
import { parseSuperviseTickArgs } from "../src/cli/main.js";
import { approvedPlan, newPlanning } from "./support/planFixtures.js";
import type { Timestamp } from "../src/domain/time.js";

const created: string[] = [];
after(() => {
  for (const path of created) {
    rmSync(path, { recursive: true, force: true });
  }
});

const CLOCK = { now: (): Timestamp => 1756449600000 as Timestamp };

const ITEM: RoadmapItem = {
  key: "GITHUB_ORCHESTRATION",
  title: "GitHub Issues/Projects/PR orchestration (zero-cost tier only)",
  dependsOn: [],
  status: "ELIGIBLE",
  workClass: "NORMAL_IMPLEMENTATION",
  order: 6,
};

/**
 * ONE RESOURCE, DECLARED ON BOTH SIDES.
 *
 * Round-2 finding 2: the supervisor authorizes a single provider/model/effort
 * and the plan carries its own, and nothing compared them. Every fixture here
 * now states both, so a case about something else is not silently a case about
 * an unauthorized launch — and so the cases about the gate itself can vary one
 * side and watch the launch stop.
 */
export const AUTHORIZED_WORKER = { tool: "claude-code", model: "opus" } as const;

const AUTHORIZED: AiRunConfigRecord = {
  requestedProvider: "claude-code",
  requestedModel: "opus",
  effectiveProvider: "claude-code",
  effectiveModel: "opus",
  // What the supervisor really records at LAUNCH time: `VERIFIED_EFFECTIVE`
  // exists only after a worker reports back, so a fixture claiming it here
  // would be testing a state the gate never sees.
  verification: "UNVERIFIED",
  argvEvidence: ["claude", "--model", "opus"],
  note: "scripted for tests",
};

function planWith(phase: PlanPhase): Plan {
  return {
    id: "plan-1",
    phase,
    planner: AUTHORIZED_WORKER,
    execution: {
      implementer: AUTHORIZED_WORKER,
      reviewer: AUTHORIZED_WORKER,
      verificationCommands: [],
      workspaceRoot: "/tmp/ws",
    },
  } as unknown as Plan;
}

function input(overrides: Partial<WorkExecutionInput> = {}): WorkExecutionInput {
  return { item: ITEM, actionId: "action-1", config: AUTHORIZED, ...overrides } as WorkExecutionInput;
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


/**
 * A genuinely valid BLOCKED plan, with the loop's real failure reason on it.
 *
 * Shaped after tests/planHardening.test.ts's `validPlan` so the digests are
 * really computed rather than stubbed -- the SQLite repository refuses a plan
 * whose content digest does not match, so a hand-waved fixture would fail to
 * persist and the test would pass for the wrong reason.
 */
function blockedPlanFixture(): Plan {
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
  return {
    id: "plan-blocked-1",
    projectId: "prj-0001",
    requestKey: "req-blocked-1",
    version: 1,
    phase: "BLOCKED",
    failureReason: "verifier failed for command test",
    intent: "Build the thing.",
    declaredConstraints: [],
    budget: { maxPlannerAttempts: 2, maxClarificationCycles: 2, maxTotalPlannerRuns: 6 },
    planner: { tool: "scripted", model: "test" },
    execution: {
      implementer: { tool: "scripted", model: "impl" },
      reviewer: { tool: "scripted", model: "rev" },
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
        plannerRunRef: "plan-blocked-1:r1:planner:a1",
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
      const withReason = {
        ...planWith(phase),
        failureReason: "verifier failed for command test",
      } as Plan;
      const executor = createPlanBackedExecutor({
        plans: lookup(withReason),
        planning: advancer(withReason),
        clock: CLOCK,
      });

      const outcome = await executor.execute(input());

      assert.equal(outcome.kind, "HUMAN_REQUIRED", `${phase} was not escalated`);
      assert.match(
        outcome.kind === "HUMAN_REQUIRED" ? outcome.detail : "",
        new RegExp(phase),
        `${phase} was not named in the escalation`,
      );
      /**
       * AND THE LOOP'S REASON (round-2 survivor). Deleting `failureReason` from
       * the escalation left the whole focused file green, because this case
       * only ever checked the phase name. The reason is the part a human
       * actually needs -- "verifier failed for command test" -- and it is the
       * part that was being dropped.
       */
      assert.match(
        outcome.kind === "HUMAN_REQUIRED" ? outcome.detail : "",
        /verifier failed for command test/,
        `${phase} did not carry the loop's failure reason`,
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
  /**
   * BEHAVIOURAL, AND AT A CONFIGURATION WHERE A STUB CANNOT FOLLOW.
   *
   * Round-1 review compiled a mutation that constructed
   * `createPlanBackedExecutor`, DISCARDED it, and returned the old stub -- and
   * every test passed. The first repair made the test behavioural and it STILL
   * passed, because with no planning configured the real executor and the stub
   * produce the same answer: HUMAN_REQUIRED / AUTHOR_PLAN. No black-box test at
   * that configuration can tell them apart, so the test was not the problem.
   *
   * What was wrong was the wiring: finding a plan required the whole planning
   * stack. Now `--roadmap-plans` alone is enough to FIND a plan and report its
   * real state, so this drives `runSuperviseTick` against a plans database
   * holding a BLOCKED plan bound to a roadmap item. The real executor reports
   * that plan and its failure reason. A stub that answers AUTHOR_PLAN for
   * everything cannot.
   */
  it("reports a bound plan's real state, which a stub cannot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-supervise-ac1-"));
    created.push(dir);

    const plansDbPath = join(dir, "plans.db");
    const plans = createSqlitePlanRepository(plansDbPath);
    try {
      await plans.create(blockedPlanFixture());
    } finally {
      plans.close();
    }

    const bindingsPath = join(dir, "roadmap-plans.json");
    writeFileSync(bindingsPath, JSON.stringify({ LOCAL_24_7_RUNTIME: "plan-blocked-1" }));

    const lines: string[] = [];
    await runSuperviseTick({
      supervisorDbPath: join(dir, "supervisor.db"),
      plansDbPath,
      roadmapPlansPath: bindingsPath,
      log: (line) => lines.push(line),
    });

    const output = lines.join(String.fromCharCode(10));
    assert.match(
      output,
      /plan-blocked-1/,
      `the supervisor never reached the bound plan, so a stub would behave identically:${String.fromCharCode(10)}${output}`,
    );
  });

  /**
   * THE COMMAND AN OPERATOR TYPES (round-2 finding 1).
   *
   * The case above calls `runSuperviseTick` directly, and round-2 review pointed
   * out what that leaves unproven: `src/cli/main.ts` never parsed
   * `--roadmap-plans`, `--plans-db` or `--drive-plans`, so the shipped command
   * ignored all three and exited 0 — including with a bindings path that does
   * not exist. Every option was reachable from a test and from nowhere else.
   *
   * These drive the REAL BUILT CLI as a child process. `npm test` builds before
   * it runs tests, so `dist/` is this tree's own output rather than a leftover.
   */
  function runCli(args: readonly string[], env: Record<string, string>) {
    return spawnSync(process.execPath, ["dist/src/cli/main.js", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
  }

  it("fails when the shipped command is given a bindings file that does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-supervise-cli-"));
    created.push(dir);

    const result = runCli(
      ["supervise", "tick", "--roadmap-plans", join(dir, "does-not-exist.json")],
      { FACTORY_SUPERVISOR_DB_PATH: join(dir, "supervisor.db") },
    );

    assert.notEqual(
      result.status,
      0,
      `the CLI ignored --roadmap-plans and reported success:${String.fromCharCode(10)}${result.stdout}`,
    );
    assert.match(
      `${result.stdout}${result.stderr}`,
      /does-not-exist\.json|ENOENT/,
      "the CLI failed for some reason other than the bindings file it was given",
    );
  });

  /**
   * And the POSITIVE half, which is the one that cannot be satisfied by any
   * amount of failing early: the shipped command reaches a real bound plan and
   * prints its real state. A `main.ts` that drops the flags cannot.
   */
  it("reaches a bound plan through the shipped command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-supervise-cli-ok-"));
    created.push(dir);

    const plansDbPath = join(dir, "plans.db");
    const plans = createSqlitePlanRepository(plansDbPath);
    try {
      await plans.create(blockedPlanFixture());
    } finally {
      plans.close();
    }
    const bindingsPath = join(dir, "roadmap-plans.json");
    writeFileSync(bindingsPath, JSON.stringify({ LOCAL_24_7_RUNTIME: "plan-blocked-1" }));

    const result = runCli(
      ["supervise", "tick", "--roadmap-plans", bindingsPath, "--plans-db", plansDbPath],
      { FACTORY_SUPERVISOR_DB_PATH: join(dir, "supervisor.db") },
    );

    assert.match(
      `${result.stdout}${result.stderr}`,
      /plan-blocked-1/,
      `the shipped command never reached the bound plan:${String.fromCharCode(10)}${result.stdout}${result.stderr}`,
    );
  });

  it("refuses an unknown option rather than ignoring it", () => {
    assert.equal(parseSuperviseTickArgs(["--plan-config", "x"]).ok, false);
    assert.equal(parseSuperviseTickArgs(["extra"]).ok, false);
    assert.equal(parseSuperviseTickArgs(["--roadmap-plans"]).ok, false);
    // Driving with nothing to drive is a mistake worth naming, not a silent no-op.
    assert.equal(parseSuperviseTickArgs(["--drive-plans"]).ok, false);
  });

  it("maps every documented flag onto the option the supervisor reads", () => {
    const parsed = parseSuperviseTickArgs([
      "--roadmap-plans",
      "/tmp/bindings.json",
      "--plans-db",
      "/tmp/plans.db",
      "--drive-plans",
    ]);

    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok ? parsed.value : {}, {
      roadmapPlansPath: "/tmp/bindings.json",
      plansDbPath: "/tmp/plans.db",
      drivePlans: true,
    });
  });
});

/**
 * The operator's bindings file is INPUT, and round-2 review's binding
 * assessment listed what was not validated: unknown keys, whitespace ids and
 * resource limits. Each is refused by NAME, because the failure mode is an
 * operator who believes a plan is wired when it is not.
 */
describe("TASK-014: the roadmap-to-plan bindings file is validated", () => {
  function bindings(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "sf-bindings-"));
    created.push(dir);
    const path = join(dir, "roadmap-plans.json");
    writeFileSync(path, contents);
    return path;
  }

  async function tickWith(path: string): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "sf-bindings-db-"));
    created.push(dir);
    await runSuperviseTick({
      supervisorDbPath: join(dir, "supervisor.db"),
      roadmapPlansPath: path,
      log: () => {},
    });
  }

  it("refuses a roadmap key this installation does not declare", async () => {
    await assert.rejects(
      () => tickWith(bindings(JSON.stringify({ NOT_A_REAL_ITEM: "plan-1" }))),
      /not a roadmap key/,
      "a typo'd key bound nothing and said nothing",
    );
  });

  it("refuses a plan id that is only whitespace", async () => {
    await assert.rejects(
      () => tickWith(bindings(JSON.stringify({ LOCAL_24_7_RUNTIME: "   " }))),
      /non-empty plan id/,
    );
  });

  it("refuses a plan id with surrounding whitespace rather than trimming it", async () => {
    await assert.rejects(
      () => tickWith(bindings(JSON.stringify({ LOCAL_24_7_RUNTIME: " plan-1 " }))),
      /surrounding whitespace/,
      "the id was silently trimmed, so the file no longer says what the supervisor did",
    );
  });

  it("refuses more bindings than it will consider", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 101; i += 1) {
      many[`KEY_${i}`] = "plan-1";
    }
    await assert.rejects(() => tickWith(bindings(JSON.stringify(many))), /the limit is 100/);
  });

  it("refuses a file too large to parse safely", async () => {
    const huge = JSON.stringify({ LOCAL_24_7_RUNTIME: "x".repeat(70 * 1024) });
    await assert.rejects(() => tickWith(bindings(huge)), /the limit is 65536/);
  });
});

describe("TASK-014 AC-4: dispatch is idempotent through the REAL planning seam", () => {
  /**
   * THE INTEGRATION PROOF, replacing a structural argument.
   *
   * Round-1 review was right that counting `resume()` on a fake advancer proves
   * nothing about duplicate loops: it never touches `LoopDispatcher`, which is
   * where adoption-versus-start is actually decided. The structural claim -- the
   * executor cannot start a loop because `PlanAdvancer` has one method -- is
   * true and is still worth stating, but it is an argument about the seam rather
   * than evidence about the system.
   *
   * So this drives the REAL `PlanningService` against the scripted dispatcher,
   * which enforces the same one-loop-per-work-item rule TASK-004's database
   * enforces with a constraint, and counts `start()` across two executions of
   * the same roadmap item.
   */
  it("executes the same item twice and starts exactly one loop", async () => {
    const context = await newPlanning();
    /**
     * Started with ONE worker configuration throughout, because the
     * authorization gate refuses to launch a plan that would run anything the
     * supervisor did not authorize — and the default fixture names three
     * different models. That refusal is tested on its own in
     * planAuthorization.test.ts; here it would only hide the idempotence
     * question behind an unrelated stop.
     */
    const plan = await approvedPlan(context, "Build the thing.", {
      planner: AUTHORIZED_WORKER,
      execution: {
        implementer: AUTHORIZED_WORKER,
        reviewer: AUTHORIZED_WORKER,
        verificationCommands: [{ id: "check", executable: "node", argv: ["-e", "process.exit(0)"] }],
        workspaceRoot: "/tmp/sf-plan-test",
        loopBudget: { maxIterations: 2 },
      },
    });

    const executor = createPlanBackedExecutor({
      plans: { async findPlanForItem() { return context.plans.findById(plan.id); } },
      planning: context.service,
      clock: CLOCK,
    });

    const startsAfterApproval = context.dispatcher.startCount();
    const first = await executor.execute(input());
    const second = await executor.execute(input());

    /**
     * THE EXECUTOR MUST ACTUALLY HAVE DRIVEN SOMETHING.
     *
     * Without this the case is vacuous: `approvedPlan` already dispatches, so
     * "the count did not change" is equally true of an executor that did
     * nothing at all. Asserting it reached the plan is what makes the count
     * meaningful -- the fourth shape, caught in this test before review had to.
     */
    /**
     * THE EXECUTOR MUST HAVE ACTUALLY RESUMED (round-2 survivor).
     *
     * Replacing `planning.resume(plan.id)` with `const advanced = plan` compiled
     * and this case still passed, because "not HUMAN_REQUIRED" is equally true
     * of a no-op that reports the plan's existing phase. The plan is APPROVED
     * before the first execution and the scripted dispatcher moves it on, so a
     * genuine resume CHANGES what comes back; a no-op cannot.
     */
    const drove = await context.plans.findById(plan.id);
    assert.notEqual(
      drove?.phase,
      "APPROVED",
      "the plan is still APPROVED, so resume() did nothing and the start count proves nothing",
    );
    for (const [label, outcome] of [["first", first], ["second", second]] as const) {
      assert.notEqual(
        outcome.kind,
        "HUMAN_REQUIRED",
        `the ${label} execution never drove the approved plan, so the start count proves nothing`,
      );
    }

    assert.equal(
      context.dispatcher.startCount(),
      startsAfterApproval,
      "executing the same roadmap item twice started another loop",
    );
    assert.ok(
      context.dispatcher.startCount() <= 1,
      "more than one loop exists for a single work item",
    );
  });

  /**
   * And the seam still cannot express a start at all: `PlanAdvancer` has one
   * method. Kept alongside the integration proof rather than instead of it --
   * the structural fact explains WHY the count stays put.
   */
  it("exposes no way to start a loop", async () => {
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

  /**
   * The whole import SECTION, not line-by-line.
   *
   * Round-1 review hid `createIsolatedExecutor` in a MULTILINE import and the
   * line-based scanner missed it: only the first line of an import statement
   * starts with `import`, so a continuation line was invisible. Everything
   * before the first non-import top-level statement is examined instead.
   */
  function importSection(source: string): string {
    const marker = source.search(new RegExp("^(?:export|const|function|interface|type|class)", "m"));
    return marker === -1 ? source : source.slice(0, marker);
  }

  /**
   * The isolated child is denied credentials on purpose (L-3), so it performs
   * DETERMINISTIC work only. Routing an AI launch through it would either fail
   * or require restoring the capability TASK-011 exists to remove.
   */
  it("does not import the isolated executor", () => {
    assert.deepEqual(
      [importSection(EXECUTOR_SRC)].filter((section) => section.includes("isolatedExecutor")),
      [],
      "the plan-backed executor can reach the isolated child",
    );
  });

  it("does not import or spawn a child process", () => {
    assert.deepEqual(
      [importSection(EXECUTOR_SRC)].filter((section) => section.includes("child_process")),
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
      /not permitted to drive plans/,
    );
    assert.notEqual(outcome.kind, "COMPLETED");
  });
});
