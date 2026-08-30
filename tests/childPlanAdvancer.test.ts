/**
 * TASK-014 round-2 finding 2 (CRITICAL), first half: driving a plan happens in a
 * SEPARATE OS PROCESS.
 *
 * The first implementation handed the executor a live `PlanningService`, so
 * `SupervisorService -> PlanBackedExecutor -> PlanningService.resume() ->
 * EngineeringLoopDispatcher -> EngineeringLoopService -> real AI workers` all ran
 * inside the supervisor — the arrangement TASK-011 AC-1 and AC-11 exist to
 * remove. The isolation test passed anyway, because it asserted only that the
 * ISOLATED child was absent, which is not the same as proving what DOES run is
 * out of process.
 *
 * So these prove the positive: a real `ProcessRequest` is built, and the last
 * case runs a REAL child process against a REAL plans database end to end.
 *
 * Offline: the plan used by the end-to-end case is at PLAN_REVIEW, where
 * `PlanningService` halts and waits for a human. No worker is launched, no
 * provider is contacted, nothing is spent (AC-8).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  createChildPlanAdvancer,
  DEFAULT_PLAN_RESUME_TIMEOUT_MS,
} from "../src/adapters/supervision/childPlanAdvancer.js";
import { createNodeProcessRunner } from "../src/adapters/process/nodeProcessRunner.js";
import { createSqlitePlanRepository } from "../src/adapters/planning/sqlitePlanRepository.js";
import { computePlanContentDigest } from "../src/planning/planDigest.js";
import type { Plan, PlannedWorkItem } from "../src/planning/planTypes.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/ports/processRunner.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./support/tempWorkspace.js";
import type { Timestamp } from "../src/domain/time.js";

const created: string[] = [];
after(() => {
  for (const path of created) {
    rmSync(path, { recursive: true, force: true });
  }
  cleanupTempWorkspaces();
});

function exited(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    terminationReason: "EXITED",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    startedAt: 0 as Timestamp,
    finishedAt: 1 as Timestamp,
    durationMs: 1,
    ...overrides,
  };
}

/** Captures the request instead of running anything. */
function recordingRunner(result: ProcessResult = exited()): ProcessRunner & { readonly requests: ProcessRequest[] } {
  const requests: ProcessRequest[] = [];
  return {
    requests,
    async run(request: ProcessRequest): Promise<ProcessResult> {
      requests.push(request);
      return result;
    },
  };
}

function planFixture(overrides: Partial<Plan> = {}): Plan {
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
    id: "plan-child-1",
    projectId: "prj-0001",
    requestKey: "req-child-1",
    version: 1,
    phase: "PLAN_REVIEW",
    intent: "Build the thing.",
    declaredConstraints: [],
    budget: { maxPlannerAttempts: 2, maxClarificationCycles: 2, maxTotalPlannerRuns: 6 },
    planner: { tool: "claude-code", model: "opus" },
    execution: {
      implementer: { tool: "claude-code", model: "opus" },
      reviewer: { tool: "claude-code", model: "opus" },
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
        plannerRunRef: "plan-child-1:r1:planner:a1",
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
    ...overrides,
  } as Plan;
}

function reader(plan: Plan | undefined) {
  return { async findById(): Promise<Plan | undefined> { return plan; } };
}

describe("TASK-014: the plan is advanced by a child process", () => {
  it("runs `sf plan resume <plan-id>` with the plan id as an argument", async () => {
    const runner = recordingRunner();
    const advancer = createChildPlanAdvancer({
      processRunner: runner,
      plans: reader(planFixture()),
      cwd: "/repo",
      plansDbPath: "/data/plans.db",
      cliEntry: "/build/main.js",
      nodeExecutable: "/usr/bin/node",
      environmentSource: { PATH: "/usr/bin" },
    });

    await advancer.resume("plan-child-1");

    assert.equal(runner.requests.length, 1, "no child process was started");
    const request = runner.requests[0];
    assert.equal(request?.executable, "/usr/bin/node");
    assert.deepEqual(request?.argv, ["/build/main.js", "plan", "resume", "plan-child-1"]);
    assert.equal(request?.cwd, "/repo");
  });

  /**
   * The parent and the child MUST read the same database.
   *
   * Round-2 finding 1's second half: the lookup resolved a plans database and
   * the planning stack resolved its own, so a supervisor could report on a plan
   * in one database and advance a plan in another. The resolved path is handed
   * to the child rather than left to its defaults.
   */
  it("tells the child exactly which plans database the supervisor read", async () => {
    const runner = recordingRunner();
    const advancer = createChildPlanAdvancer({
      processRunner: runner,
      plans: reader(planFixture()),
      cwd: "/repo",
      plansDbPath: "/data/plans.db",
      cliEntry: "/build/main.js",
      environmentSource: { PATH: "/usr/bin", FACTORY_PLANS_DB_PATH: "/somewhere/else.db" },
    });

    await advancer.resume("plan-child-1");

    assert.equal(runner.requests[0]?.env["FACTORY_PLANS_DB_PATH"], "/data/plans.db");
  });

  /**
   * This child CAN authenticate — launching an AI worker needs exactly that, and
   * it is not the TASK-011 isolated child. What it still may not receive is
   * anything outside the worker allowlist, which is where an API key would be.
   */
  it("forwards the worker environment and nothing else", async () => {
    const runner = recordingRunner();
    const advancer = createChildPlanAdvancer({
      processRunner: runner,
      plans: reader(planFixture()),
      cwd: "/repo",
      plansDbPath: "/data/plans.db",
      cliEntry: "/build/main.js",
      environmentSource: {
        PATH: "/usr/bin",
        HOME: "/home/operator",
        ANTHROPIC_API_KEY: "sk-ant-planted-not-a-real-key",
        AWS_SECRET_ACCESS_KEY: "planted",
      },
    });

    await advancer.resume("plan-child-1");

    const env = runner.requests[0]?.env ?? {};
    assert.equal(env["HOME"], "/home/operator", "the child cannot find its credentials store");
    assert.equal(env["ANTHROPIC_API_KEY"], undefined, "an API key reached the child");
    assert.equal(env["AWS_SECRET_ACCESS_KEY"], undefined, "an unrelated secret reached the child");
  });

  it("uses the plan's own wall-clock budget when it declares one", async () => {
    const runner = recordingRunner();
    const advancer = createChildPlanAdvancer({
      processRunner: runner,
      plans: reader(
        planFixture({
          execution: {
            implementer: { tool: "claude-code", model: "opus" },
            reviewer: { tool: "claude-code", model: "opus" },
            verificationCommands: [],
            workspaceRoot: "/tmp/ws",
            loopBudget: { maxWallClockMs: 5_000 },
          },
        }),
      ),
      cwd: "/repo",
      plansDbPath: "/data/plans.db",
      cliEntry: "/build/main.js",
    });

    await advancer.resume("plan-child-1");

    assert.ok(
      (runner.requests[0]?.timeoutMs ?? 0) > 5_000,
      "the child was given less time than the plan's own budget",
    );
    assert.ok(
      (runner.requests[0]?.timeoutMs ?? 0) < DEFAULT_PLAN_RESUME_TIMEOUT_MS,
      "the plan's budget was ignored in favour of the default ceiling",
    );
  });

  /**
   * FAIL CLOSED. `PlanBackedExecutor` turns a throw here into a definite
   * `RESOURCE_FAILURE` (AC-9), so what must never happen is returning the plan
   * as it was: that reports "no progress" for a run whose real state is unknown.
   */
  it("throws when the child exits non-zero", async () => {
    const advancer = createChildPlanAdvancer({
      processRunner: recordingRunner(exited({ exitCode: 1, stderr: "workspace root does not exist" })),
      plans: reader(planFixture()),
      cwd: "/repo",
      plansDbPath: "/data/plans.db",
      cliEntry: "/build/main.js",
    });

    await assert.rejects(
      () => advancer.resume("plan-child-1"),
      /workspace root does not exist/,
    );
  });

  it("throws when the child is killed for running too long", async () => {
    const advancer = createChildPlanAdvancer({
      processRunner: recordingRunner(exited({ terminationReason: "TIMEOUT", exitCode: null })),
      plans: reader(planFixture()),
      cwd: "/repo",
      plansDbPath: "/data/plans.db",
      cliEntry: "/build/main.js",
    });

    await assert.rejects(() => advancer.resume("plan-child-1"), /TIMEOUT/);
  });

  /**
   * The child's OUTPUT decides nothing. A process that prints a completed status
   * and then exits 1 has failed, and no amount of reassuring text on stdout may
   * turn that into an advance — the same rule TASK-003 applies to every worker.
   */
  it("does not believe a successful-looking child that failed", async () => {
    const advancer = createChildPlanAdvancer({
      processRunner: recordingRunner(exited({ exitCode: 1, stdout: "phase         : COMPLETED" })),
      plans: reader(planFixture({ phase: "COMPLETED" })),
      cwd: "/repo",
      plansDbPath: "/data/plans.db",
      cliEntry: "/build/main.js",
    });

    await assert.rejects(() => advancer.resume("plan-child-1"), /exit 1/);
  });

  it("throws when the plan cannot be read back after a clean exit", async () => {
    const advancer = createChildPlanAdvancer({
      processRunner: recordingRunner(),
      plans: reader(undefined),
      cwd: "/repo",
      plansDbPath: "/data/plans.db",
      cliEntry: "/build/main.js",
    });

    await assert.rejects(() => advancer.resume("plan-child-1"), /no longer readable/);
  });

  /**
   * THE WHOLE CHAIN, FOR REAL.
   *
   * A real `ProcessRunner`, this build's real `dist/src/cli/main.js`, a real
   * SQLite plans database, and a real `PlanningService` inside the child. The
   * plan is at PLAN_REVIEW, so the child halts there and waits for a human: it
   * exercises the process boundary, the environment forwarding and the read-back
   * without launching a worker or spending anything.
   *
   * `npm test` builds before running tests, so `dist/` is this tree's output.
   */
  it("really advances a real plan in a real child process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-child-advancer-"));
    created.push(dir);

    const plansDbPath = join(dir, "plans.db");
    const plans = createSqlitePlanRepository(plansDbPath);
    try {
      /**
       * A workspace the child will accept: it resolves the plan's persisted
       * `workspaceRoot` before doing anything else, and demands a real git
       * repository verified with `git rev-parse` rather than a directory that
       * merely contains a `.git` entry. Both refusals are correct behaviour that
       * this test met on the way here, not obstacles to work around.
       */
      await plans.create(
        planFixture({
          execution: {
            implementer: { tool: "claude-code", model: "opus" },
            reviewer: { tool: "claude-code", model: "opus" },
            verificationCommands: [{ id: "check", executable: "node", argv: ["-e", "0"] }],
            workspaceRoot: createTempWorkspace("sf-child-advancer-ws-"),
          },
        }),
      );

      const advancer = createChildPlanAdvancer({
        processRunner: createNodeProcessRunner(),
        plans,
        cwd: process.cwd(),
        plansDbPath,
        cliEntry: join(process.cwd(), "dist/src/cli/main.js"),
        environmentSource: {
          ...process.env,
          FACTORY_DB_PATH: join(dir, "factory.db"),
          FACTORY_LOOPS_DB_PATH: join(dir, "loops.db"),
        },
        timeoutMs: 60_000,
      });

      const advanced = await advancer.resume("plan-child-1");

      assert.equal(advanced.id, "plan-child-1");
      assert.equal(
        advanced.phase,
        "PLAN_REVIEW",
        "the child moved a plan that was waiting for a human decision",
      );
    } finally {
      plans.close();
    }
  });
});
