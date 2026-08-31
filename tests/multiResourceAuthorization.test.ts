/**
 * TASK-015 — MULTI_RESOURCE_AUTHORIZATION.
 *
 * The supervisor authorised one resource per action while a plan declares
 * three, so a plan whose reviewer differs from its implementer — the shape C4
 * REQUIRES for critical work — could never run. Widening authorisation to a SET
 * must not become a way to run something ungated, so every case here checks both
 * directions: the C4 shape now runs, and anything outside the set still does not.
 *
 * Offline: no provider, no model, no money.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { cleanupTempDbs } from "./support/factoryFixtures.js";
import { newSupervisor, scriptedProbe, seedRoadmap } from "./support/supervisorFixtures.js";
import type {
  AuthorizedResource,
  RequiredResource,
  WorkExecutionInput,
  WorkOutcome,
} from "../src/supervision/supervisorPorts.js";
import type { ScriptedExecutor } from "./support/supervisorFixtures.js";
import type { RoadmapItem } from "../src/supervision/supervisorTypes.js";

after(cleanupTempDbs);

const IMPLEMENTER = { role: "implementer", provider: "claude-code", model: "opus" } as const;
const REVIEWER = { role: "reviewer", provider: "codex-cli", model: "gpt-5.6-luna" } as const;
const PLANNER = { role: "planner", provider: "claude-code", model: "sonnet" } as const;

/** The routed resource the supervisor picks for NORMAL_IMPLEMENTATION. */
const CATALOG = [
  { provider: "claude-code", model: "opus", billingMode: "INCLUDED_SUBSCRIPTION" as const },
  { provider: "claude-code", model: "sonnet", billingMode: "INCLUDED_SUBSCRIPTION" as const },
  { provider: "claude-code", model: "haiku", billingMode: "INCLUDED_SUBSCRIPTION" as const },
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

/**
 * Records exactly what it was authorised to launch.
 *
 * `declare` is a function rather than a list so a case can make the declaration
 * itself fail — an executor that cannot say what it needs must not thereby be
 * allowed to launch with nothing authorised.
 */
function recordingExecutor(
  declare: () => Promise<readonly RequiredResource[]>,
): ScriptedExecutor & { authorized(): readonly AuthorizedResource[]; ran(): boolean } {
  const inputs: WorkExecutionInput[] = [];
  return {
    calls: () => inputs,
    callsFor: (roadmapKey: string) => inputs.filter((entry) => entry.item.key === roadmapKey),
    authorized: () => inputs[0]?.authorizedResources ?? [],
    ran: () => inputs.length > 0,
    declareResources: declare,
    async execute(input: WorkExecutionInput): Promise<WorkOutcome> {
      inputs.push(input);
      return { kind: "CHANGES_REQUIRED", findings: ["scripted"] };
    },
  };
}

/** The ordinary case: a fixed declaration that succeeds. */
function declaring(...declared: readonly RequiredResource[]) {
  return recordingExecutor(async () => declared);
}

function probeWith(overrides: Record<string, { state: "AVAILABLE" | "USAGE_LIMIT_REACHED"; billingMode?: "INCLUDED_SUBSCRIPTION" | "USAGE_BILLED" | "UNKNOWN" }> = {}) {
  const probe = scriptedProbe();
  for (const entry of CATALOG) {
    const key = `${entry.provider}:${entry.model}`;
    const override = overrides[key];
    probe.set(entry.provider, entry.model, {
      state: override?.state ?? "AVAILABLE",
      reason: "scripted",
      billingMode: override?.billingMode ?? "INCLUDED_SUBSCRIPTION",
    });
  }
  return probe;
}

async function tickWith(
  executor: ScriptedExecutor,
  probeOverrides: Parameters<typeof probeWith>[0] = {},
) {
  const supervisor = newSupervisor({
    probe: probeWith(probeOverrides),
    executor,
    resourceCatalog: CATALOG,
  });
  await seedRoadmap(supervisor, [ITEM]);
  return supervisor.service.tick();
}

describe("TASK-015 AC-1/AC-2: the supervisor authorises the set the work declares", () => {
  /**
   * CASE A — one resource for every role. It is probed and gated once, and the
   * plan runs.
   */
  it("authorises a single shared resource once and runs", async () => {
    const executor = declaring(
      { ...IMPLEMENTER },
      { role: "reviewer", provider: "claude-code", model: "opus" },
      { role: "planner", provider: "claude-code", model: "opus" },
    );

    const result = await tickWith(executor);

    assert.equal(result.kind, "ADVANCED", `expected the item to run, got ${result.kind}`);
    assert.equal(executor.ran(), true);
    /**
     * The DECLARED roles share one identity. Since round 8 nothing is routed
     * for work that declares its own resources, so `routed` can no longer
     * appear in this set — the filter below is retained only so the assertion
     * stays meaningful if that ever regresses.
     */
    const declaredIdentities = new Set(
      executor
        .authorized()
        .filter((entry) => entry.role !== "routed")
        .map((entry) => `${entry.provider}/${entry.model}`),
    );
    assert.deepEqual([...declaredIdentities], ["claude-code/opus"], "the shared resource was split");
  });

  /**
   * CASE B and H — THE POINT OF THIS TASK. Three distinct resources, reviewer
   * independent of implementer, all authorised, work runs.
   */
  it("runs a C4-shaped plan whose reviewer is a different model from its implementer", async () => {
    const executor = declaring(PLANNER, IMPLEMENTER, REVIEWER);

    const result = await tickWith(executor);

    assert.equal(result.kind, "ADVANCED", `the C4 shape was refused: ${JSON.stringify(result)}`);
    const authorized = executor.authorized();
    for (const role of ["planner", "implementer", "reviewer"]) {
      assert.ok(
        authorized.some((entry) => entry.role === role),
        `${role} is missing from the authorised set`,
      );
    }
    // Reviewer independence survives: the two are still different resources.
    const implementer = authorized.find((entry) => entry.role === "implementer");
    const reviewer = authorized.find((entry) => entry.role === "reviewer");
    assert.notEqual(
      `${implementer?.provider}/${implementer?.model}`,
      `${reviewer?.provider}/${reviewer?.model}`,
      "the reviewer was collapsed onto the implementer's resource",
    );
  });

  /**
   * CASE G — duplicates are one resource to gate and two facts to record.
   */
  it("deduplicates identical identities for probing but keeps both roles", async () => {
    const executor = declaring(
      { role: "implementer", provider: "claude-code", model: "opus" },
      { role: "reviewer", provider: "claude-code", model: "opus" },
    );

    await tickWith(executor);

    const authorized = executor.authorized();
    const roles = authorized.filter((entry) => entry.role !== "routed").map((entry) => entry.role);
    assert.deepEqual(roles.sort(), ["implementer", "reviewer"], "a role was lost to deduplication");
  });

  /**
   * CASE D — one member unavailable stops everything. No partial authorisation.
   */
  it("stops the whole action when one declared resource is unavailable", async () => {
    const executor = declaring(IMPLEMENTER, REVIEWER);

    const result = await tickWith(executor, { "codex-cli:gpt-5.6-luna": { state: "USAGE_LIMIT_REACHED" } });

    assert.equal(result.kind, "WAITING_FOR_RESOURCE");
    assert.equal(executor.ran(), false, "work ran despite an unavailable member");
  });

  /**
   * CASE C and AC-4 — one member that would BILL stops everything, even though
   * every other member is free. This is `AUTONOMOUS_SPEND_LIMIT = 0` surviving
   * the widening.
   */
  it("stops the whole action when one declared resource would bill", async () => {
    const executor = declaring(IMPLEMENTER, REVIEWER);

    const result = await tickWith(executor, {
      "codex-cli:gpt-5.6-luna": { state: "AVAILABLE", billingMode: "USAGE_BILLED" },
    });

    assert.equal(result.kind, "WAITING_FOR_HUMAN", `a billable member was allowed: ${JSON.stringify(result)}`);
    assert.equal(executor.ran(), false, "work ran with a billable resource in the set");
  });

  /**
   * ONE CONTROL PER ROLE (round-6 finding 2).
   *
   * AC-1 says removing the gate for ANY named resource must fail a test. Every
   * billable case above put the offending resource on the REVIEWER, so bypassing
   * the gate for the planner or the implementer passed 16/16 -- the guard was
   * real and only one third of it was pinned.
   *
   * Each role gets a case where IT is the billable one and the others are free,
   * so a bypass for exactly that role has somewhere to fail.
   */
  for (const role of ["planner", "implementer", "reviewer"] as const) {
    it(`stops the whole action when the ${role} would bill`, async () => {
      /**
       * The planner uses `haiku` DELIBERATELY. With `sonnet` it collided with
       * whatever the router itself picks, and the routed resource is gated
       * separately -- so bypassing the DECLARED planner gate changed nothing
       * observable and the mutation survived. A model the router does not select
       * leaves only the declared gate able to refuse it.
       */
      const executor = declaring(
        { role: "planner", provider: "claude-code", model: "haiku" },
        { role: "implementer", provider: "claude-code", model: "opus" },
        { role: "reviewer", provider: "codex-cli", model: "gpt-5.6-luna" },
      );
      const billable =
        role === "planner"
          ? "claude-code:haiku"
          : role === "implementer"
            ? "claude-code:opus"
            : "codex-cli:gpt-5.6-luna";

      const result = await tickWith(executor, {
        [billable.replace(":", ":")]: { state: "AVAILABLE", billingMode: "USAGE_BILLED" },
      });

      assert.equal(
        result.kind,
        "WAITING_FOR_HUMAN",
        `a billable ${role} was allowed through: ${JSON.stringify(result)}`,
      );
      assert.equal(executor.ran(), false, `work ran with a billable ${role}`);
    });

    it(`stops the whole action when the ${role} is unavailable`, async () => {
      const executor = declaring(
        { role: "planner", provider: "claude-code", model: "haiku" },
        { role: "implementer", provider: "claude-code", model: "opus" },
        { role: "reviewer", provider: "codex-cli", model: "gpt-5.6-luna" },
      );
      const missing =
        role === "planner"
          ? "claude-code:haiku"
          : role === "implementer"
            ? "claude-code:opus"
            : "codex-cli:gpt-5.6-luna";

      const result = await tickWith(executor, { [missing]: { state: "USAGE_LIMIT_REACHED" } });

      assert.equal(result.kind, "WAITING_FOR_RESOURCE", `an unavailable ${role} was allowed through`);
      assert.equal(executor.ran(), false, `work ran with an unavailable ${role}`);
    });
  }

  it("stops when a declared resource's billing mode is simply unknown", async () => {
    const executor = declaring(IMPLEMENTER, REVIEWER);

    const result = await tickWith(executor, {
      "codex-cli:gpt-5.6-luna": { state: "AVAILABLE", billingMode: "UNKNOWN" },
    });

    assert.equal(result.kind, "WAITING_FOR_HUMAN");
    assert.equal(executor.ran(), false, "an unknown billing mode was treated as free");
  });

  /**
   * NOTHING IS ROUTED FOR WORK THAT DECLARES ITS OWN RESOURCES (round-8
   * finding 2).
   *
   * The declaration used to be fetched AFTER the routed resource was selected,
   * probed and gated — so an action whose declared planner, implementer and
   * reviewer were all free was refused because the ROUTED resource, which it
   * would never launch, was USAGE_BILLED. AC-2 says the supervisor authorises
   * exactly the declared set, and a resource outside that set cannot be allowed
   * to veto the work.
   */
  it("runs a declared plan even when the unused routed resource would bill", async () => {
    const executor = declaring(
      { role: "planner", provider: "claude-code", model: "haiku" },
      { role: "implementer", provider: "claude-code", model: "opus" },
      { role: "reviewer", provider: "codex-cli", model: "gpt-5.6-luna" },
    );

    // Every DECLARED resource is free; the one the router would have chosen is
    // not. Nothing declared names sonnet.
    const probe = probeWith({ "claude-code:sonnet": { state: "AVAILABLE", billingMode: "USAGE_BILLED" } });
    const supervisor = newSupervisor({ probe, executor, resourceCatalog: CATALOG });
    await seedRoadmap(supervisor, [ITEM]);

    const result = await supervisor.service.tick();

    assert.equal(
      result.kind,
      "ADVANCED",
      `an unused routed resource blocked a fully-free declaration: ${JSON.stringify(result)}`,
    );
    assert.equal(executor.ran(), true);
    assert.ok(
      !executor.authorized().some((entry) => entry.model === "sonnet"),
      "the unused routed resource was authorised anyway",
    );
    /**
     * EXACTLY ONE PROBE (round-9 finding 3). An earlier comment here said a
     * probe count could not distinguish anything, and that was half right: a
     * count of ZERO cannot, because the scheduled refresh legitimately probes
     * every catalogued resource once. A count of EXACTLY ONE can — the routing
     * path's pre-launch confirmation (F4-3) would add a SECOND probe of the
     * resource it selects. The reviewer proved the outcome alone was not
     * enough: with routing restored by a single compiled edit, the routed
     * resource was probed but never gated, the declared implementer's action
     * still won, and this test passed while its named guard was gone.
     */
    assert.equal(
      probe.probeCount("claude-code", "sonnet"),
      1,
      "the unused routed resource was probed a second time, so routing ran for declared work",
    );
  });

  /**
   * THE CONTROL. Work that declares NOTHING still routes, still gates the routed
   * resource, and is still refused when that resource would bill — the path this
   * change was not supposed to touch.
   */
  it("still refuses undeclared work whose routed resource would bill", async () => {
    const inputs: WorkExecutionInput[] = [];
    const executor: ScriptedExecutor = {
      calls: () => inputs,
      callsFor: (key: string) => inputs.filter((entry) => entry.item.key === key),
      async execute(input: WorkExecutionInput): Promise<WorkOutcome> {
        inputs.push(input);
        return { kind: "CHANGES_REQUIRED", findings: ["scripted"] };
      },
    };

    const result = await tickWith(executor, {
      "claude-code:sonnet": { state: "AVAILABLE", billingMode: "USAGE_BILLED" },
      "claude-code:opus": { state: "AVAILABLE", billingMode: "USAGE_BILLED" },
      "claude-code:haiku": { state: "AVAILABLE", billingMode: "USAGE_BILLED" },
      "codex-cli:gpt-5.6-luna": { state: "AVAILABLE", billingMode: "USAGE_BILLED" },
    });

    assert.equal(result.kind, "WAITING_FOR_HUMAN", `undeclared work ran on a billable resource`);
    assert.equal(inputs.length, 0);
  });

  /**
   * An executor that cannot say what it needs does not thereby get to launch
   * with nothing authorised.
   */
  it("refuses when the executor cannot state what it will launch", async () => {
    const executor = recordingExecutor(async () => {
      throw new Error("the plans database is unreadable");
    });

    const result = await tickWith(executor);

    assert.equal(result.kind, "RECOVERY_REQUIRED");
    assert.equal(executor.ran(), false, "work ran after the declaration failed");
  });

  /**
   * AC-2's other half: an executor that declares NOTHING gets exactly today's
   * behaviour. The widening must not change the single-resource path.
   */
  it("leaves an executor that declares nothing exactly as it was", async () => {
    const inputs: WorkExecutionInput[] = [];
    const executor: ScriptedExecutor = {
      calls: () => inputs,
      callsFor: (roadmapKey: string) => inputs.filter((entry) => entry.item.key === roadmapKey),
      async execute(input: WorkExecutionInput): Promise<WorkOutcome> {
        inputs.push(input);
        return { kind: "CHANGES_REQUIRED", findings: ["scripted"] };
      },
    };

    const result = await tickWith(executor);

    assert.equal(result.kind, "ADVANCED");
    const roles = (inputs[0]?.authorizedResources ?? []).map((entry) => entry.role);
    assert.deepEqual(roles, ["routed"], "an executor that declared nothing got more than the routed resource");
  });
});
