/**
 * TASK-014 round-2 finding 2 (CRITICAL), second half: the resource a financial
 * gate authorized must be the resource that can actually execute.
 *
 * The supervisor routes an item to ONE provider/model/effort, probes it, gates
 * it and records it as provenance. The PLAN carries its own persisted planner,
 * implementer and reviewer, and the engineering loop launches those. Nothing
 * compared them, so the gate could decide about `claude-code/opus` while
 * `codex-cli` ran, and the evidence would name the resource that did not run.
 *
 * Every case here varies ONE side and asserts the launch STOPS — `resumed` stays
 * empty. A refusal that still resumed would be a message, not a gate.
 *
 * Offline: no provider, no model, no money.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkPlanAuthorization, declaredPlanResources } from "../src/supervision/planAuthorization.js";
import { createPlanBackedExecutor, type PlanAdvancer } from "../src/supervision/planBackedExecutor.js";
import type { AiRunConfigRecord } from "../src/supervision/modelEnforcement.js";
import type { Plan, PlannerConfig } from "../src/planning/planTypes.js";
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

const AUTHORIZED_WORKER: PlannerConfig = { tool: "claude-code", model: "opus" };

function authorization(overrides: Partial<AiRunConfigRecord> = {}): AiRunConfigRecord {
  return {
    requestedProvider: "claude-code",
    requestedModel: "opus",
    effectiveProvider: "claude-code",
    effectiveModel: "opus",
    verification: "UNVERIFIED",
    argvEvidence: ["claude", "--model", "opus"],
    note: "scripted for tests",
    ...overrides,
  };
}

interface Roles {
  readonly planner?: PlannerConfig;
  readonly implementer?: PlannerConfig;
  readonly reviewer?: PlannerConfig;
}

function approvedPlanWith(roles: Roles = {}): Plan {
  return {
    id: "plan-1",
    phase: "APPROVED",
    planner: roles.planner ?? AUTHORIZED_WORKER,
    execution: {
      implementer: roles.implementer ?? AUTHORIZED_WORKER,
      reviewer: roles.reviewer ?? AUTHORIZED_WORKER,
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
      return { ...approvedPlanWith(), phase: "EXECUTING" } as Plan;
    },
  };
}

async function execute(plan: Plan, config: AiRunConfigRecord | undefined) {
  const planning = advancer();
  const executor = createPlanBackedExecutor({
    plans: { async findPlanForItem() { return plan; } },
    planning,
    clock: CLOCK,
  });
  const outcome = await executor.execute({
    item: ITEM,
    actionId: "action-1",
    ...(config === undefined ? {} : { config }),
  });
  return { outcome, resumed: planning.resumed };
}

describe("TASK-014: the authorized resource is the resource that can run", () => {
  it("counts the planner, the implementer and the reviewer", () => {
    assert.deepEqual(
      declaredPlanResources(
        approvedPlanWith({
          planner: { tool: "codex-cli", model: "gpt-5.6-luna" },
          implementer: { tool: "claude-code", model: "opus" },
          reviewer: { tool: "claude-code", model: "sonnet", effort: "high" },
        }),
      ),
      [
        { role: "planner", tool: "codex-cli", model: "gpt-5.6-luna" },
        { role: "implementer", tool: "claude-code", model: "opus" },
        { role: "reviewer", tool: "claude-code", model: "sonnet", effort: "high" },
      ],
    );
  });

  it("permits a plan whose every role is the authorized resource", async () => {
    const { outcome, resumed } = await execute(approvedPlanWith(), authorization());

    assert.deepEqual(resumed, ["plan-1"], "an exactly-matching plan was refused");
    assert.notEqual(outcome.kind, "HUMAN_REQUIRED");
  });

  /**
   * ONE ROLE AT A TIME. Each case leaves the other two matching, so it fails if
   * and only if THAT role is checked — removing any single role from
   * `declaredPlanResources` leaves exactly one of these green and the others
   * failing, rather than a single case that could pass for any reason.
   */
  for (const [role, differing] of [
    ["planner", { planner: { tool: "codex-cli", model: "gpt-5.6-luna" } }],
    ["implementer", { implementer: { tool: "codex-cli", model: "gpt-5.6-luna" } }],
    ["reviewer", { reviewer: { tool: "codex-cli", model: "gpt-5.6-luna" } }],
  ] as const) {
    it(`refuses to launch when the plan's ${role} is a different provider`, async () => {
      const { outcome, resumed } = await execute(approvedPlanWith(differing), authorization());

      assert.deepEqual(resumed, [], `the ${role} ran on a provider nothing authorized`);
      assert.equal(outcome.kind, "HUMAN_REQUIRED");
      const detail = outcome.kind === "HUMAN_REQUIRED" ? outcome.detail : "";
      assert.match(detail, new RegExp(role), "the refusal does not say which role disagrees");
      // BOTH SIDES, because a human reading this has to know what to change.
      assert.match(detail, /codex-cli/, "the refusal does not name what the plan would run");
      assert.match(detail, /claude-code/, "the refusal does not name what was authorized");
    });
  }

  it("refuses a different model on the same provider", async () => {
    const { outcome, resumed } = await execute(
      approvedPlanWith({ implementer: { tool: "claude-code", model: "sonnet" } }),
      authorization(),
    );

    assert.deepEqual(resumed, [], "a model nothing authorized was launched");
    assert.match(outcome.kind === "HUMAN_REQUIRED" ? outcome.detail : "", /sonnet/);
  });

  /**
   * EFFORT IS PART OF THE IDENTITY, and the supervisor already treats it that
   * way: `reconcileReportedIdentity` records a MISMATCH when a run reports an
   * effort other than the one requested. A gate that ignored effort here would
   * authorize `opus` and permit `opus` at a setting nobody priced.
   */
  it("refuses an effort the authorization did not name", async () => {
    const { outcome, resumed } = await execute(
      approvedPlanWith({ implementer: { tool: "claude-code", model: "opus", effort: "xhigh" } }),
      authorization(),
    );

    assert.deepEqual(resumed, [], "an unauthorized effort was launched");
    assert.match(outcome.kind === "HUMAN_REQUIRED" ? outcome.detail : "", /effort/);
  });

  it("refuses when the authorization names an effort the plan does not", async () => {
    const { outcome, resumed } = await execute(
      approvedPlanWith(),
      authorization({ effectiveEffort: "high" }),
    );

    assert.deepEqual(resumed, [], "a plan taking the provider default ran under an authorization for high");
    assert.equal(outcome.kind, "HUMAN_REQUIRED");
  });

  /**
   * Both sides silent is the ONE equivalence: same provider, same model, neither
   * naming an effort, so both take the same provider default. Asserted so the
   * strictness above is a decision rather than an accident.
   */
  it("permits a plan and an authorization that both take the provider default", async () => {
    const { resumed } = await execute(approvedPlanWith(), authorization());
    assert.deepEqual(resumed, ["plan-1"]);
  });

  /**
   * DETERMINISTIC work carries no `config` at all: nothing was routed, nothing
   * was probed for its billing mode, nothing went through the financial gate.
   * Driving a plan launches AI workers regardless, which is exactly the launch
   * AUTONOMOUS_SPEND_LIMIT = 0 depends on never happening unexamined.
   */
  it("refuses to launch when no AI resource was authorized at all", async () => {
    const { outcome, resumed } = await execute(approvedPlanWith(), undefined);

    assert.deepEqual(resumed, [], "AI workers were launched with no authorization whatsoever");
    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    assert.match(
      outcome.kind === "HUMAN_REQUIRED" ? outcome.detail : "",
      /authorized no AI resource/,
    );
  });

  it("refuses an authorization that is itself recorded as a mismatch", async () => {
    const { outcome, resumed } = await execute(
      approvedPlanWith(),
      authorization({ verification: "MISMATCH", note: "reported model differs" }),
    );

    assert.deepEqual(resumed, [], "a launch proceeded under an authorization known to be contradicted");
    assert.equal(outcome.kind, "HUMAN_REQUIRED");
  });

  /**
   * THE REFUSAL IS NOT A FAILURE, and the distinction matters operationally: a
   * `RESOURCE_FAILURE` would make the supervisor back off the provider and retry
   * on a schedule, as though the provider were unwell. Nothing is wrong with the
   * provider. A human has to reconcile two configurations.
   */
  it("reports a configuration disagreement as needing a human, not as a resource failure", async () => {
    const { outcome } = await execute(
      approvedPlanWith({ reviewer: { tool: "codex-cli", model: "gpt-5.6-luna" } }),
      authorization(),
    );

    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    assert.equal(
      outcome.kind === "HUMAN_REQUIRED" ? outcome.action.kind : "",
      "RECONCILE_PLAN_AUTHORIZATION",
    );
  });

  /**
   * THE LIMITATION THIS LEAVES, asserted rather than only written down
   * (docs/KNOWN-LIMITATIONS.md L-12).
   *
   * The supervisor authorizes one resource per action and a plan declares three,
   * so the ordinary shape — a reviewer that is a different model from the
   * implementer, which C4 requires for critical work — cannot be driven by this
   * supervisor at all. That is a real gap in what TASK-014 delivers, and a test
   * that says so is how it stops being a surprise to the next reader.
   */
  it("cannot yet drive a plan that reviews with a different model than it implements", () => {
    const verdict = checkPlanAuthorization(
      approvedPlanWith({
        implementer: { tool: "claude-code", model: "opus" },
        reviewer: { tool: "codex-cli", model: "gpt-5.6-luna" },
      }),
      authorization(),
    );

    assert.equal(verdict.ok, false, "L-12 has been closed; update the limitation record");
  });
});
