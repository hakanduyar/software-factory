/**
 * TASK-015 round-3 findings 2 and 3: attacks on the control path rather than
 * mutations of it.
 *
 * The reviewer's point was that these were not mutation survivors — no guard was
 * missing a test — they were inputs nobody had tried. A validator that produces
 * a TypeError, a validator that reads a value twice and can be told two
 * different things, and a re-read that falls back to the copy it was supposed to
 * replace.
 *
 * Offline: no provider, no model, no money.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { cleanupTempDbs } from "./support/factoryFixtures.js";
import { newSupervisor, scriptedProbe, seedRoadmap } from "./support/supervisorFixtures.js";
import { createPlanBackedExecutor, type PlanAdvancer } from "../src/supervision/planBackedExecutor.js";
import type { AuthorizedResource, RequiredResource, WorkExecutionInput, WorkOutcome } from "../src/supervision/supervisorPorts.js";
import type { ScriptedExecutor } from "./support/supervisorFixtures.js";
import type { Plan } from "../src/planning/planTypes.js";
import type { RoadmapItem } from "../src/supervision/supervisorTypes.js";
import type { Timestamp } from "../src/domain/time.js";

after(cleanupTempDbs);

const CLOCK = { now: (): Timestamp => 1756449600000 as Timestamp };

const CATALOG = [
  { provider: "claude-code", model: "opus", billingMode: "INCLUDED_SUBSCRIPTION" as const },
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

function declaringRaw(declared: readonly unknown[]): ScriptedExecutor {
  const inputs: WorkExecutionInput[] = [];
  return {
    calls: () => inputs,
    callsFor: (key: string) => inputs.filter((entry) => entry.item.key === key),
    async declareResources(): Promise<readonly RequiredResource[]> {
      return declared as readonly RequiredResource[];
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

describe("TASK-015 round-3 finding 3: a declaration is validated as inert data", () => {
  /**
   * `modelEnforcement` refuses an effort it cannot vouch for when it builds a run
   * configuration; the set path skipped that, so `not-a-real-effort` reached a
   * launch. A capability that is weaker than the path it widens is not a
   * capability.
   */
  it("refuses an effort this build cannot vouch for", async () => {
    const executor = declaringRaw([
      { role: "implementer", provider: "claude-code", model: "opus", effort: "not-a-real-effort" },
    ]);

    const result = await tickWith(executor);

    assert.equal(result.kind, "RECOVERY_REQUIRED");
    assert.match(result.kind === "RECOVERY_REQUIRED" ? result.reason : "", /effort/);
    assert.equal(executor.calls().length, 0, "an unvouched effort was launched");
  });

  /**
   * `__proto__` resolved through the index to `Object.prototype`, and the next
   * line threw `models.includes is not a function` — an uncontrolled TypeError
   * out of the function whose whole job is controlled refusals.
   */
  it("refuses an inherited property masquerading as a provider", async () => {
    const executor = declaringRaw([{ role: "implementer", provider: "__proto__", model: "opus" }]);

    const result = await tickWith(executor);

    assert.equal(result.kind, "RECOVERY_REQUIRED", "a prototype lookup escaped as an uncontrolled failure");
    assert.match(result.kind === "RECOVERY_REQUIRED" ? result.reason : "", /provider/);
    assert.equal(executor.calls().length, 0);
  });

  it("refuses a constructor-shaped provider name too", async () => {
    const executor = declaringRaw([{ role: "implementer", provider: "constructor", model: "opus" }]);

    const result = await tickWith(executor);

    assert.equal(result.kind, "RECOVERY_REQUIRED");
    assert.equal(executor.calls().length, 0);
  });

  /**
   * THE TIME-OF-CHECK ATTACK ON THE DECLARATION ITSELF.
   *
   * A getter answered `opus` to the validator and `ghost-model` to everything
   * after it, and the action advanced on the ghost model. The declaration is now
   * copied into inert data ONCE, so validation and use read the same bytes.
   */
  it("refuses a declaration whose values change between reads", async () => {
    let reads = 0;
    const shifty = {
      role: "implementer",
      provider: "claude-code",
      get model(): string {
        reads += 1;
        // Truthful exactly once, which is all a check-then-use needs.
        return reads <= 1 ? "opus" : "ghost-model";
      },
    };
    const executor = declaringRaw([shifty]);

    const result = await tickWith(executor);

    /**
     * Either outcome is acceptable and both are safe: the snapshot may capture
     * `opus` (and then `opus` is genuinely what was authorised AND used) or
     * `ghost-model` (refused). What must NEVER happen is validating one value
     * and authorising the other.
     */
    if (result.kind === "RECOVERY_REQUIRED") {
      assert.equal(executor.calls().length, 0);
      return;
    }
    const authorized = executor.calls()[0]?.authorizedResources ?? [];
    const implementer = authorized.find((entry: AuthorizedResource) => entry.role === "implementer");
    assert.equal(
      implementer?.model,
      "opus",
      "the value that was validated is not the value that was authorised",
    );
  });
});

describe("TASK-015 round-3 finding 2: a missing re-read is a refusal", () => {
  /**
   * `?? plan` authorised the STALE copy whenever the fresh read came back
   * empty. The whole point of re-reading is that the earlier copy stopped being
   * evidence.
   */
  it("refuses when the plan cannot be re-read immediately before launch", async () => {
    const first = {
      id: "plan-1",
      phase: "APPROVED",
      declaredConstraints: [`roadmap-key: ${ITEM.key}`],
      approvedDigest: "digest-1",
      planner: { tool: "claude-code", model: "opus" },
      execution: {
        implementer: { tool: "claude-code", model: "opus" },
        reviewer: { tool: "claude-code", model: "opus" },
        verificationCommands: [],
        workspaceRoot: "/tmp/ws",
      },
    } as unknown as Plan;

    let reads = 0;
    const resumed: string[] = [];
    const planning: PlanAdvancer = {
      async resume(planId: string): Promise<Plan> {
        resumed.push(planId);
        return first;
      },
    };

    const executor = createPlanBackedExecutor({
      plans: {
        async findPlanForItem(): Promise<Plan | undefined> {
          reads += 1;
          // Present for the first read, gone for the pre-launch re-read.
          return reads === 1 ? first : undefined;
        },
      },
      planning,
      state: { async verifiedPhase() { return "APPROVED"; } },
      clock: CLOCK,
    });

    const outcome = await executor.execute({
      item: ITEM,
      actionId: "action-1",
      authorizedResources: [
        { role: "implementer", provider: "claude-code", model: "opus", billingMode: "INCLUDED_SUBSCRIPTION" },
      ],
    });

    assert.deepEqual(resumed, [], "a stale plan was launched because the re-read came back empty");
    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    assert.match(
      outcome.kind === "HUMAN_REQUIRED" ? outcome.detail : "",
      /could not be re-read/,
    );
  });
});
