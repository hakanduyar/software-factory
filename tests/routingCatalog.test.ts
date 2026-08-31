/**
 * TASK-015 round-7: the two doors a persisted row could still open.
 *
 * Round 6 anchored the DECLARATION check in the code-level catalog. Round 7's
 * review showed the same smuggled row was still reachable by a different door —
 * ROUTING — and that a probe throwing during the scheduled refresh still killed
 * the tick, because the catch added in round 3 covers only the immediate
 * pre-launch probe.
 *
 * Offline: no provider, no model, no money.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { cleanupTempDbs } from "./support/factoryFixtures.js";
import { newSupervisor, scriptedProbe, seedRoadmap } from "./support/supervisorFixtures.js";
import type { ScriptedExecutor, ScriptedProbe } from "./support/supervisorFixtures.js";
import type { WorkExecutionInput, WorkOutcome } from "../src/supervision/supervisorPorts.js";
import type { RoadmapItem } from "../src/supervision/supervisorTypes.js";

after(cleanupTempDbs);

/**
 * This installation carries ONE resource, in code — and it is deliberately the
 * one the routing policy prefers LESS.
 *
 * The routing policy ranks claude-code/sonnet AHEAD of codex-cli/gpt-5.6-luna
 * for NORMAL_IMPLEMENTATION, so smuggling a sonnet row is a real attack:
 * without the catalog bound the router prefers the smuggled resource over the
 * configured one. A catalog whose entry the policy already prefers would make
 * the attack unobservable and this test vacuous.
 */
const CATALOG = [{ provider: "codex-cli", model: "gpt-5.6-luna", billingMode: "INCLUDED_SUBSCRIPTION" as const }];

const ITEM: RoadmapItem = {
  key: "GITHUB_ORCHESTRATION",
  title: "GitHub orchestration",
  dependsOn: [],
  status: "PENDING",
  workClass: "NORMAL_IMPLEMENTATION",
  order: 1,
};

function recording(): ScriptedExecutor & { ran(): boolean } {
  const inputs: WorkExecutionInput[] = [];
  return {
    calls: () => inputs,
    callsFor: (key: string) => inputs.filter((entry) => entry.item.key === key),
    ran: () => inputs.length > 0,
    async execute(input: WorkExecutionInput): Promise<WorkOutcome> {
      inputs.push(input);
      return { kind: "CHANGES_REQUIRED", findings: ["scripted"] };
    },
  };
}

/** Answers for everything, including resources this installation never declared. */
function permissiveProbe(): ScriptedProbe {
  const probe = scriptedProbe();
  for (const [provider, model] of [
    ["codex-cli", "gpt-5.6-luna"],
    ["claude-code", "sonnet"],
  ] as const) {
    probe.set(provider, model, {
      state: "AVAILABLE",
      reason: "scripted",
      billingMode: "INCLUDED_SUBSCRIPTION",
    });
  }
  return probe;
}

describe("TASK-015 round-7 finding 1: routing is bounded by the code catalog", () => {
  /**
   * THE REVIEWER'S REPRODUCTION, with NO declaration involved at all.
   *
   * Round 6 stopped a smuggled row being DECLARED. It did not stop the router
   * selecting one: `runItem` built its candidate map from `state.resources`, so
   * appending an AVAILABLE `claude-code/sonnet` row was enough to have it
   * routed and launched, ahead of the only resource this installation carries.
   * Since round 8 the guard is the reconciliation chokepoint at the top of the
   * tick; this test pins that chokepoint through the routing observable.
   */
  it("does not route a resource that exists only as a persisted row", async () => {
    const executor = recording();
    const supervisor = newSupervisor({
      probe: permissiveProbe(),
      executor,
      resourceCatalog: CATALOG,
    });
    await seedRoadmap(supervisor, [ITEM]);

    const state = await supervisor.repository.load();
    assert.ok(state !== undefined);
    const smuggled = {
      provider: "claude-code",
      model: "sonnet",
      key: "claude-code:sonnet",
      state: "AVAILABLE" as const,
      detectedAt: 0,
      lastCheckedAt: 0,
      backoff: { attempt: 0 },
      observedBillingMode: "INCLUDED_SUBSCRIPTION" as const,
    };
    await supervisor.repository.compareAndSave(
      { ...state, version: state.version + 1, resources: [...state.resources, smuggled as never] },
      state.version,
    );

    const result = await supervisor.service.tick();

    /**
     * The item may legitimately run on the CATALOGUED resource. What must never
     * happen is the smuggled one being chosen — so the assertion is about which
     * resource the action used, not merely about the outcome kind.
     */
    const used = executor.calls()[0]?.config;
    assert.notEqual(
      `${used?.effectiveProvider}/${used?.effectiveModel}`,
      "claude-code/sonnet",
      `a resource that exists only as a persisted row was routed and launched: ${JSON.stringify(result)}`,
    );
  });

  /**
   * THE CONTROL: the catalogued resource is still routable, so the bound is not
   * satisfied by refusing to route anything.
   */
  it("still routes the resource this installation does carry", async () => {
    const executor = recording();
    const supervisor = newSupervisor({
      probe: permissiveProbe(),
      executor,
      resourceCatalog: CATALOG,
    });
    await seedRoadmap(supervisor, [ITEM]);

    const result = await supervisor.service.tick();

    assert.equal(result.kind, "ADVANCED", `the catalogued resource was not routed: ${JSON.stringify(result)}`);
    assert.equal(executor.ran(), true);
  });
});

describe("TASK-015 round-8 finding 1: the catalog reconciles persisted rows", () => {
  /**
   * A STALE ROW MUST NOT PROMOTE WAITING WORK.
   *
   * Round 7 filtered ROUTING and left refresh and usability promotion reading
   * the rows directly, so an `AVAILABLE` row for a resource the catalog no
   * longer carries still counted as "something is usable" — it promoted a
   * waiting AI item, which then took the slot from an eligible deterministic
   * one. Reconciling once, at the top of the tick, is what makes every later
   * reader see configuration instead.
   */
  it("drops a persisted row for a resource the catalog no longer carries", async () => {
    const executor = recording();
    const supervisor = newSupervisor({ probe: permissiveProbe(), executor, resourceCatalog: CATALOG });
    await seedRoadmap(supervisor, [ITEM]);

    const state = await supervisor.repository.load();
    assert.ok(state !== undefined);
    await supervisor.repository.compareAndSave(
      {
        ...state,
        version: state.version + 1,
        resources: [
          ...state.resources,
          {
            provider: "claude-code",
            model: "sonnet",
            key: "claude-code:sonnet",
            state: "AVAILABLE" as const,
            detectedAt: 0,
            lastCheckedAt: 0,
            backoff: { attempt: 0 },
            observedBillingMode: "INCLUDED_SUBSCRIPTION" as const,
          } as never,
        ],
      },
      state.version,
    );

    await supervisor.service.tick();

    const after = await supervisor.repository.load();
    assert.ok(
      !(after?.resources ?? []).some((record) => record.key === "claude-code:sonnet"),
      "a row for an uncatalogued resource survived reconciliation",
    );
  });

  /**
   * RECONCILIATION RUNS BEFORE ANY EARLY RETURN CAN PUBLISH A WAKE (round-9
   * finding 1).
   *
   * The chokepoint sat after `reconcileClaim`, which returns early on a lost
   * RUNNING claim — and `publishWake` then computed the next wake from the raw
   * rows. The reviewer measured an uncatalogued `rogue:ghost` row supplying the
   * published wake time after exactly that early return, so a removed catalog
   * entry still controlled scheduling.
   */
  it("drops uncatalogued rows even on a tick that returns early", async () => {
    const executor = recording();
    const supervisor = newSupervisor({ probe: permissiveProbe(), executor, resourceCatalog: CATALOG });
    await seedRoadmap(supervisor, [ITEM]);

    const state = await supervisor.repository.load();
    assert.ok(state !== undefined);
    await supervisor.repository.compareAndSave(
      {
        ...state,
        version: state.version + 1,
        resources: [
          ...state.resources,
          {
            provider: "rogue",
            model: "ghost",
            key: "rogue:ghost",
            state: "USAGE_LIMIT_REACHED" as const,
            detectedAt: 0,
            lastCheckedAt: 0,
            retryAt: 1_800_000_005_000,
            backoff: { attempt: 3, delayMs: 60_000 },
          } as never,
        ],
        // A RUNNING claim owned by a process that no longer exists: the tick
        // must return early rather than act, which is the window the reviewer
        // used.
        activeClaim: {
          actionId: "a-lost",
          roadmapKey: ITEM.key,
          kind: "LAUNCH_AI_WORKER",
          state: "RUNNING" as const,
          ownerId: "a-previous-process",
          attempt: 1,
          claimedAt: 0,
        } as never,
      },
      state.version,
    );

    const result = await supervisor.service.tick();

    assert.notEqual(result.kind, "ADVANCED", "a lost RUNNING claim did not stop the tick");
    const after = await supervisor.repository.load();
    assert.ok(
      !(after?.resources ?? []).some((record) => record.key === "rogue:ghost"),
      "an uncatalogued row survived to control wake publication on an early-return tick",
    );
  });

  /**
   * AND A RESOURCE ADDED TO THE CATALOG IS SEEDED, or it could never be probed
   * or routed at all — the other half of the same disagreement.
   */
  it("seeds a row for a resource the catalog gained", async () => {
    const executor = recording();
    const supervisor = newSupervisor({ probe: permissiveProbe(), executor, resourceCatalog: CATALOG });
    await seedRoadmap(supervisor, [ITEM]);

    const state = await supervisor.repository.load();
    assert.ok(state !== undefined);
    // Someone removes the row for the resource this installation DOES carry.
    await supervisor.repository.compareAndSave(
      { ...state, version: state.version + 1, resources: [] },
      state.version,
    );

    /**
     * REACHABLE, NOT MERELY PRESENT (round-9). The evidence is INDIRECT and the
     * indirection is sound: this item's work class requires an AI resource and
     * the catalog holds exactly one, so ADVANCED entails that the gained
     * resource was seeded, probed by the refresh that follows reconciliation,
     * and routed. No `role: "routed"` entry is inspected here — a round-10
     * review note called an earlier framing of this comment overstated, and it
     * was.
     */
    const result = await supervisor.service.tick();
    assert.equal(result.kind, "ADVANCED", `the gained resource was never routed: ${JSON.stringify(result)}`);

    const after = await supervisor.repository.load();
    assert.ok(
      (after?.resources ?? []).some((record) => record.key === "codex-cli:gpt-5.6-luna"),
      "a catalogued resource with no row was never seeded",
    );
  });
});

describe("TASK-015 round-10 finding 1: a refused tick publishes no rogue schedule", () => {
  /**
   * The tamper-refusal paths return BEFORE reconciliation, deliberately —
   * writing to refused state is the hazard. But `publishWake` runs after every
   * outcome and committed a wake time supplied by an uncatalogued `rogue:ghost`
   * row inside the refused state, so a removed resource still controlled
   * scheduling. The wake authority now bounds its own input by the catalog.
   *
   * BOTH halves of the boundary are asserted: the rogue schedule must not be
   * published, and the rogue ROW must still be there — a reconciliation of
   * refused state would be its own defect, not a fix.
   */
  it("does not let a rogue row in refused state supply the published wake", async () => {
    const executor = recording();
    const supervisor = newSupervisor({ probe: permissiveProbe(), executor, resourceCatalog: CATALOG });
    await seedRoadmap(supervisor, [ITEM]);

    const state = await supervisor.repository.load();
    assert.ok(state !== undefined);
    await supervisor.repository.compareAndSave(
      {
        ...state,
        version: state.version + 1,
        // The tamper: a roadmap title the catalog does not declare.
        roadmap: state.roadmap.map((entry) =>
          entry.key === ITEM.key ? { ...entry, title: "tampered definition" } : entry,
        ),
        resources: [
          ...state.resources,
          {
            provider: "rogue",
            model: "ghost",
            key: "rogue:ghost",
            state: "USAGE_LIMIT_REACHED" as const,
            detectedAt: 0,
            lastCheckedAt: 0,
            retryAt: 1_800_000_005_000,
            backoff: { attempt: 3, delayMs: 60_000 },
          } as never,
        ],
      },
      state.version,
    );

    const result = await supervisor.service.tick();

    assert.notEqual(result.kind, "ADVANCED", "a tampered roadmap did not stop the tick");
    assert.equal(executor.ran(), false);
    const after = await supervisor.repository.load();
    assert.notEqual(
      after?.nextWakeAt,
      1_800_000_005_000,
      "the published wake was supplied by an uncatalogued row inside refused state",
    );
    assert.ok(
      (after?.resources ?? []).some((record) => record.key === "rogue:ghost"),
      "refused state was reconciled — the forensic boundary was crossed",
    );
  });
});

describe("TASK-015 round-7 finding 2: a refresh probe failure is controlled", () => {
  /**
   * Round 3 caught the throw on the IMMEDIATE pre-launch probe and left the
   * SCHEDULED refresh uncovered — the same defect in the sibling call site. A
   * transport failure there killed the whole tick with an uncaught error.
   */
  it("does not let a refresh probe throw kill the tick", async () => {
    const executor = recording();
    const healthy = permissiveProbe();
    const probe: ScriptedProbe = {
      probeCount: (p: string, m: string) => healthy.probeCount(p, m),
      totalProbes: () => healthy.totalProbes(),
      set: (p, m, c) => healthy.set(p, m, c),
      async probe(): Promise<never> {
        throw new Error("refresh transport failed");
      },
    };

    const supervisor = newSupervisor({ probe, executor, resourceCatalog: CATALOG });
    await seedRoadmap(supervisor, [ITEM]);

    // The tick must RETURN something, not reject.
    const result = await supervisor.service.tick();

    assert.ok(
      ["WAITING_FOR_RESOURCE", "IDLE", "RECOVERY_REQUIRED", "WAITING_FOR_HUMAN"].includes(result.kind),
      `an unexpected outcome for a failing probe: ${JSON.stringify(result)}`,
    );
    assert.equal(executor.ran(), false, "work ran on a resource that could not be probed");
  });
});
