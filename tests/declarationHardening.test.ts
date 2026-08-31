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
    /**
     * THE BAD EFFORT IS ON THE REVIEWER, DELIBERATELY — the eighth
     * sibling-guarded test, found by my own hardened harness rather than by
     * review. With the bad effort on the IMPLEMENTER, deleting the unified
     * validator's effort check changed nothing observable: the
     * implementer-config builder calls `planAiRunConfig` again for the
     * implementer specifically, and refused there. Only planner and reviewer
     * efforts have NO second validator, so only they can pin this one.
     */
    const executor = declaringRaw([
      { role: "implementer", provider: "claude-code", model: "opus" },
      { role: "reviewer", provider: "codex-cli", model: "gpt-5.6-luna", effort: "not-a-real-effort" },
    ]);

    const result = await tickWith(executor);

    assert.equal(result.kind, "RECOVERY_REQUIRED");
    assert.match(result.kind === "RECOVERY_REQUIRED" ? result.reason : "", /effort/);
    assert.equal(executor.calls().length, 0, "an unvouched effort was launched");
  });

  /**
   * AND THE PLANNER, for the same reason as the reviewer above: only the
   * implementer has a sibling revalidator (the implementer-config builder), so
   * planner and reviewer are the two roles whose efforts ONLY the unified
   * validator can refuse — each needs its own case or a bypass scoped to one of
   * them survives.
   */
  it("refuses an unvouched effort on the planner too", async () => {
    const executor = declaringRaw([
      { role: "planner", provider: "claude-code", model: "opus", effort: "not-a-real-effort" },
      { role: "implementer", provider: "claude-code", model: "opus" },
      { role: "reviewer", provider: "codex-cli", model: "gpt-5.6-luna" },
    ]);

    const result = await tickWith(executor);

    assert.equal(result.kind, "RECOVERY_REQUIRED");
    assert.match(result.kind === "RECOVERY_REQUIRED" ? result.reason : "", /effort/);
    assert.equal(executor.calls().length, 0, "an unvouched planner effort was launched");
  });

  /**
   * THE CONTROL THE PREVIOUS VALIDATOR FAILED (round-9 finding 2). `max` is a
   * documented Claude effort and `planAiRunConfig` accepts it — but the old
   * parallel validator applied the CODEX effort list to every provider, so a
   * valid `claude-code/opus:max` declaration was refused. One validator now
   * answers "can this build launch it" for both routed and declared resources.
   */
  it("accepts a declared claude effort the installed CLI documents (max)", async () => {
    const executor = declaringRaw([
      { role: "implementer", provider: "claude-code", model: "opus", effort: "max" },
      { role: "reviewer", provider: "codex-cli", model: "gpt-5.6-luna" },
    ]);

    const result = await tickWith(executor);

    assert.equal(result.kind, "ADVANCED", `a valid claude max effort was refused: ${JSON.stringify(result)}`);
    assert.equal(executor.calls().length, 1);
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

describe("TASK-015 round-5 finding 4: declarations enter through the catalog", () => {
  /**
   * `claude-code/sonnet` is a model this BUILD supports, and it is not in this
   * installation's catalog. It was probed, gated, authorised and launched
   * anyway, with no resource record for it in durable state — so it had no
   * availability history, no backoff ladder and no observed billing, and "the
   * same path the routed resource takes" was never true of it.
   *
   * TASK-015's frozen OUT OF SCOPE says resources enter through the existing
   * catalog. A declaration was quietly a second door.
   */
  it("refuses a declared resource this installation does not carry", async () => {
    const executor = declaringRaw([
      { role: "implementer", provider: "claude-code", model: "opus" },
      { role: "reviewer", provider: "claude-code", model: "sonnet" },
    ]);

    const result = await tickWith(executor);

    assert.equal(result.kind, "RECOVERY_REQUIRED");
    assert.match(
      result.kind === "RECOVERY_REQUIRED" ? result.reason : "",
      /resource catalog/,
      "refused for some reason other than the missing catalog entry",
    );
    assert.equal(executor.calls().length, 0, "an uncatalogued resource was launched");
  });

  /**
   * THE ROW IS NOT THE CATALOG (round-6 finding 1).
   *
   * The previous case only proved a resource absent from BOTH code and durable
   * state is refused, so a mutation reading `state.resources` instead of
   * `deps.resourceCatalog` survived it. The reviewer's reproduction is the one
   * that matters: append a valid-looking resource ROW and declare it.
   *
   * Durable state is writable by anything with database access. Configuration
   * in code is not.
   */
  it("refuses a resource that exists only as a persisted row", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe(), executor: declaringRaw([]), resourceCatalog: CATALOG });
    await seedRoadmap(supervisor, [ITEM]);

    // Someone adds a resource to durable state that this installation's code
    // does not carry.
    const state = await supervisor.repository.load();
    assert.ok(state !== undefined);
    const smuggled = {
      provider: "claude-code",
      model: "sonnet",
      key: "claude-code:sonnet",
      state: "AVAILABLE" as const,
      detectedAt: 0 as never,
      lastCheckedAt: 0 as never,
      backoff: { attempt: 0 },
      observedBillingMode: "INCLUDED_SUBSCRIPTION" as const,
    };
    await supervisor.repository.compareAndSave(
      { ...state, version: state.version + 1, resources: [...state.resources, smuggled as never] },
      state.version,
    );

    const executor = declaringRaw([
      { role: "implementer", provider: "claude-code", model: "opus" },
      { role: "reviewer", provider: "claude-code", model: "sonnet" },
    ]);
    const withExecutor = newSupervisor({
      probe: healthyProbe(),
      executor,
      resourceCatalog: CATALOG,
      repository: supervisor.repository,
    });
    withExecutor.catalog.splice(0, withExecutor.catalog.length, { ...ITEM });

    const result = await withExecutor.service.tick();

    assert.equal(result.kind, "RECOVERY_REQUIRED", `a smuggled resource row was accepted: ${JSON.stringify(result)}`);
    assert.equal(executor.calls().length, 0, "work ran on a resource that exists only as a row");
  });

  /**
   * THE CONTROL: a declaration entirely inside the catalog still runs, so the
   * guard is not satisfied by refusing everything.
   */
  it("permits a declaration whose resources are all catalogued", async () => {
    const executor = declaringRaw([
      { role: "implementer", provider: "claude-code", model: "opus" },
      { role: "reviewer", provider: "codex-cli", model: "gpt-5.6-luna" },
    ]);

    const result = await tickWith(executor);

    assert.equal(result.kind, "ADVANCED", `a catalogued declaration was refused: ${JSON.stringify(result)}`);
    assert.equal(executor.calls().length, 1);
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
