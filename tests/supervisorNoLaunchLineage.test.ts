/**
 * DEFECT-NO-LAUNCH-LINEAGE.
 *
 * The bug: `planBackedExecutor` can prove, before any launch, that a roadmap
 * item has no plan and therefore no worker will run — and settlement stamped
 * the resource that had merely been ROUTED for the action as this attempt's
 * `IMPLEMENTED_BY`/`lastRunConfig`, which then made that resource ineligible
 * to review its own work it never did, and let it be treated as eligible to
 * review OTHER work it never touched either.
 *
 * These tests drive the real `createPlanBackedExecutor` and the real
 * `SupervisorService.settle` — no provider, no model, no money (AC-8). The
 * forgery cases construct `WorkOutcome`s by hand, the way a compromised or
 * merely careless executor could, to prove the trust boundary
 * (`planBackedExecutor.ts`'s private mint/registry) rather than only its type.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { spawnSync } from "node:child_process";

import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import {
  declarePersisted,
  newSupervisor,
  scriptedExecutor,
  scriptedProbe,
  seedRoadmap,
  type ScriptedExecutor,
  type ScriptedProbe,
} from "./support/supervisorFixtures.js";
import {
  createPlanBackedExecutor,
  verifyNoLaunchEvidence,
  type PlanAdvancer,
  type RoadmapPlanLookup,
} from "../src/supervision/planBackedExecutor.js";
import { createSqliteSupervisorRepository } from "../src/adapters/supervision/sqliteSupervisorRepository.js";
import type { Plan } from "../src/planning/planTypes.js";
import type { WorkExecutionInput, WorkExecutor, WorkOutcome } from "../src/supervision/supervisorPorts.js";
import type { RoadmapItem } from "../src/supervision/supervisorTypes.js";
import type { Timestamp } from "../src/domain/time.js";

after(cleanupTempDbs);

const CLOCK = { now: (): Timestamp => 1756449600000 as Timestamp };

const CATALOG = [
  { provider: "claude-code", model: "opus", billingMode: "INCLUDED_SUBSCRIPTION" as const },
  { provider: "codex-cli", model: "gpt-5.6-luna", billingMode: "INCLUDED_SUBSCRIPTION" as const },
];

function healthyProbe(): ScriptedProbe {
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

const ITEM: RoadmapItem = {
  key: "LOCAL_24_7_RUNTIME",
  title: "Local 24/7 runtime",
  dependsOn: [],
  status: "PENDING",
  workClass: "NORMAL_IMPLEMENTATION",
  order: 1,
};

function noPlanLookup(): RoadmapPlanLookup {
  return { async findPlanForItem(): Promise<Plan | undefined> { return undefined; } };
}

function neverResumes(): PlanAdvancer {
  return {
    async resume(): Promise<Plan> {
      throw new Error("planning must never be driven for an item with no plan");
    },
  };
}

/**
 * Adapts a hand-built `WorkExecutor` to the fixtures' `ScriptedExecutor` shape
 * WITHOUT replacing `execute` in place.
 *
 * Round 6 (C6) makes `execute` a runtime-immutable own property of whatever
 * `createPlanBackedExecutor` returns, specifically so that
 * `scripted.execute = wrapper` (what this helper used to do) is rejected. That
 * is exactly the property under test here, so this helper must not route
 * around it. `calls()`/`callsFor()` therefore cannot observe genuine
 * executions any more — nothing in this file asserts on their contents, and
 * the object identity `SupervisorService` dispatches to must stay the exact
 * object `createPlanBackedExecutor` returned, or `verifyNoLaunchEvidence`
 * would (correctly) refuse every genuine no-launch outcome below for a reason
 * that has nothing to do with the defect under test.
 */
function asScripted(executor: WorkExecutor): ScriptedExecutor {
  const scripted = executor as WorkExecutor & ScriptedExecutor;
  scripted.calls = () => [];
  scripted.callsFor = () => [];
  return scripted;
}

// =====================================================================
// The trust boundary itself
// =====================================================================

describe("DEFECT-NO-LAUNCH-LINEAGE: planBackedExecutor's no-launch trust boundary", () => {
  /**
   * `planBackedExecutor.ts`'s mint function and registry are module-private
   * and never exported, so real evidence for these tests can only come from
   * driving the real executor's no-plan path directly — exactly what
   * production does — never from a raw exported mint call, because no such
   * call exists (round 3 removes the exported issuer entirely).
   */
  function realExecutor(): WorkExecutor {
    return createPlanBackedExecutor({ plans: noPlanLookup(), planning: neverResumes(), clock: CLOCK });
  }

  it("verifies a value it minted, for the action and the executor it was minted against", async () => {
    const executor = realExecutor();
    const outcome = await executor.execute({ item: ITEM, actionId: "A:LAUNCH_AI_WORKER:1" });
    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    assert.equal(verifyNoLaunchEvidence(outcome, "A:LAUNCH_AI_WORKER:1", executor), true);
  });

  it("refuses a genuine value replayed for a different action", async () => {
    const executor = realExecutor();
    const outcome = await executor.execute({ item: ITEM, actionId: "A:LAUNCH_AI_WORKER:1" });
    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    assert.equal(verifyNoLaunchEvidence(outcome, "A:LAUNCH_AI_WORKER:2", executor), false);
  });

  it("refuses a genuine value checked against a different executor instance (round 4)", async () => {
    // Round 4's exact gap: matching actionId alone is not enough. A second,
    // independently constructed executor — even the SAME trusted factory,
    // called with the SAME deps — must not be able to claim evidence it did
    // not itself mint.
    const minter = realExecutor();
    const bystander = realExecutor();
    const outcome = await minter.execute({ item: ITEM, actionId: "A:LAUNCH_AI_WORKER:1" });
    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    assert.equal(verifyNoLaunchEvidence(outcome, "A:LAUNCH_AI_WORKER:1", bystander), false);
    assert.equal(verifyNoLaunchEvidence(outcome, "A:LAUNCH_AI_WORKER:1", minter), true);
  });

  it("refuses undefined", () => {
    assert.equal(verifyNoLaunchEvidence(undefined, "A:LAUNCH_AI_WORKER:1", realExecutor()), false);
  });

  it("refuses a duck-typed outcome with identical fields that was never minted", () => {
    // Exactly what a JSON.parse of a child process's stdout would produce: the
    // right shape, the right actionId, and no membership in `minted` at all.
    const forged = {
      kind: "HUMAN_REQUIRED" as const,
      action: { kind: "AUTHOR_PLAN", description: "forged" },
      detail: "forged",
      noLaunchEvidence: { actionId: "A:LAUNCH_AI_WORKER:1", reason: "no plan exists" },
    };
    assert.equal(verifyNoLaunchEvidence(forged, "A:LAUNCH_AI_WORKER:1", realExecutor()), false);
  });

  // ===================================================================
  // Round-2 correction regression (Sol review finding 1)
  // ===================================================================

  it("finding 1: a minted object is runtime-frozen, so reassigning actionId cannot rebind it to another action", async () => {
    const executor = realExecutor();
    const outcome = await executor.execute({ item: ITEM, actionId: "old-action" });
    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    const evidence = outcome.kind === "HUMAN_REQUIRED" ? outcome.noLaunchEvidence : undefined;
    assert.ok(evidence !== undefined);
    assert.ok(Object.isFrozen(evidence), "minted evidence must be genuinely immutable, not merely `readonly` in types");

    // Exactly the round-2 exploit: mutate a genuine token's actionId in place,
    // then replay it for the new action.
    assert.throws(() => {
      (evidence as { actionId: string }).actionId = "new-action";
    });
    assert.equal(
      verifyNoLaunchEvidence(outcome, "new-action", executor),
      false,
      "a reassigned/replayed evidence object suppressed lineage for an action it was never minted for",
    );
    // The original binding survives the failed mutation attempt.
    assert.equal(verifyNoLaunchEvidence(outcome, "old-action", executor), true);
  });

  // ===================================================================
  // Round-3 correction (Sol FINAL review finding 2: public first-caller
  // issuance let an arbitrary WorkExecutor claim the boundary when
  // planBackedExecutor was not imported first)
  // ===================================================================

  it("round 3: planBackedExecutor.js exports no mint/issuance function at all, only the executor factory and the verifier", async () => {
    // Round 2's defect was a public `issueNoLaunchBoundary` that any caller
    // could import and call. There is no such export any more: the mint
    // function and its registry are lexically private to this module, so
    // there is nothing to race for regardless of import order.
    const module = await import("../src/supervision/planBackedExecutor.js");
    assert.deepEqual(Object.keys(module).sort(), ["createPlanBackedExecutor", "verifyNoLaunchEvidence"]);
  });

  it("round 3: a fresh process where an arbitrary WorkExecutor runs through the supported SupervisorService path — never importing planBackedExecutor.js itself — cannot forge working no-launch evidence", () => {
    /**
     * This is the FINAL review's exact counterexample: a hand-built
     * `WorkExecutor`, driven through `SupervisorService.tick()`, that never
     * imports `planBackedExecutor.js` and so cannot rely on "importing it
     * first" (round 2's exploit) or on any exported mint function (there is
     * none, proven by the previous test). The only thing it CAN do is
     * construct a duck-typed, even genuinely frozen, object of the right
     * shape — which `verifyNoLaunchEvidence`'s WeakSet membership check
     * refuses regardless, because it was never produced by this module's own
     * private mint.
     *
     * Run in a real child process (not merely a fresh `describe`/`it` in this
     * same process) so the result does not depend on anything this test file
     * happened to import earlier for its own, unrelated cases above.
     */
    const fixturesUrl = new URL("./support/supervisorFixtures.js", import.meta.url).href;
    const script = `
      import { newSupervisor, seedRoadmap, scriptedProbe } from ${JSON.stringify(fixturesUrl)};
      const CATALOG = [
        { provider: "claude-code", model: "opus", billingMode: "INCLUDED_SUBSCRIPTION" },
        { provider: "codex-cli", model: "gpt-5.6-luna", billingMode: "INCLUDED_SUBSCRIPTION" },
      ];
      const probe = scriptedProbe();
      for (const entry of CATALOG) {
        probe.set(entry.provider, entry.model, { state: "AVAILABLE", reason: "scripted", billingMode: "INCLUDED_SUBSCRIPTION" });
      }
      const ITEM = { key: "LOCAL_24_7_RUNTIME", title: "Local 24/7 runtime", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 };
      // No import of planBackedExecutor.js anywhere in this process, and no
      // exported mint function exists even if it wanted one: hand-building the
      // shape is the only forgery available to it.
      const executor = {
        async execute(input) {
          const forged = Object.freeze({ actionId: input.actionId, reason: "self-issued, no boundary observed" });
          return {
            kind: "HUMAN_REQUIRED",
            action: { kind: "REVIEW_PLAN", description: "uncertain worker result" },
            detail: "arbitrary executor claims no launch happened",
            noLaunchEvidence: forged,
          };
        },
      };
      const supervisor = newSupervisor({ probe, executor, resourceCatalog: CATALOG, roadmap: [ITEM] });
      await seedRoadmap(supervisor, [ITEM]);
      const result = await supervisor.service.tick();
      const state = await supervisor.repository.load();
      const item = state.roadmap.find((entry) => entry.key === ITEM.key);
      process.stdout.write(JSON.stringify({
        result: result.kind,
        implementedByResourceKey: item?.implementedByResourceKey ?? null,
        unlaunchedAttempts: item?.unlaunchedAttempts ?? 0,
        attempts: item?.attempts ?? 0,
      }));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
    assert.equal(child.status, 0, `fresh-process reproduction failed: ${child.stderr}`);
    const output = JSON.parse(child.stdout);
    assert.equal(output.result, "WAITING_FOR_HUMAN");
    assert.equal(output.attempts, 1);
    assert.notEqual(
      output.implementedByResourceKey,
      null,
      "an arbitrary executor's forged no-launch claim suppressed real implementation lineage in a fresh process",
    );
    assert.equal(
      output.unlaunchedAttempts,
      0,
      "a forged claim from outside the trusted boundary must not be counted as a proven non-launch",
    );
  });
});

// =====================================================================
// DEFECT-NO-LAUNCH-LINEAGE-C4: an arbitrary executor cannot borrow the
// boundary by constructing its own helper and forwarding the helper's
// genuine evidence for the SAME action.
// =====================================================================

describe("DEFECT-NO-LAUNCH-LINEAGE-C4: nested-helper forwarding cannot borrow the trust boundary", () => {
  /**
   * The exact remaining HIGH from round 3: `createPlanBackedExecutor` is
   * public and takes caller-controlled deps, so an arbitrary `WorkExecutor`
   * can build its OWN helper through it — with a `plans` lookup that always
   * says "no plan" — call the helper with the very input it was handed, and
   * forward the helper's genuine evidence as if it proved something about its
   * own, untrusted execution. The helper's nested call really did prove IT
   * never launched anything; that says nothing about the enclosing execution
   * `SupervisorService` is actually settling.
   */
  function attackExecutor(): WorkExecutor {
    return {
      async execute(input): Promise<WorkOutcome> {
        const helper = createPlanBackedExecutor({
          plans: noPlanLookup(),
          planning: neverResumes(),
          clock: CLOCK,
        });
        const proof = await helper.execute(input);
        const forwardedEvidence = proof.kind === "HUMAN_REQUIRED" ? proof.noLaunchEvidence : undefined;
        return {
          kind: "HUMAN_REQUIRED",
          action: { kind: "REVIEW_PLAN", description: "uncertain worker outcome" },
          detail: "arbitrary executor has no global non-launch proof",
          ...(forwardedEvidence === undefined ? {} : { noLaunchEvidence: forwardedEvidence }),
        };
      },
    };
  }

  it("forwarding a nested helper's genuine evidence for the same actionId fails closed", async () => {
    const executor = attackExecutor();
    const outcome = await executor.execute({ item: ITEM, actionId: "LOCAL_24_7_RUNTIME:LAUNCH_AI_WORKER:1" });
    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    const evidence = outcome.kind === "HUMAN_REQUIRED" ? outcome.noLaunchEvidence : undefined;
    assert.ok(evidence !== undefined, "the nested helper must have produced genuine evidence for this test to be meaningful");
    // Round 3 alone would pass this check (same actionId, genuinely minted,
    // frozen). Round 4 refuses it: the evidence was minted by the HELPER, not
    // by `executor`, the object that is actually being settled. Round 5
    // additionally refuses it because `outcome` itself is a NEW object this
    // module never minted (only the helper's own outcome carries that binding).
    assert.equal(verifyNoLaunchEvidence(outcome, "LOCAL_24_7_RUNTIME:LAUNCH_AI_WORKER:1", executor), false);
    // The helper itself, correctly, still verifies against its OWN identity.
    const helper = createPlanBackedExecutor({ plans: noPlanLookup(), planning: neverResumes(), clock: CLOCK });
    const helperOutcome = await helper.execute({ item: ITEM, actionId: "LOCAL_24_7_RUNTIME:LAUNCH_AI_WORKER:1" });
    assert.equal(verifyNoLaunchEvidence(helperOutcome, "LOCAL_24_7_RUNTIME:LAUNCH_AI_WORKER:1", helper), true);
  });

  it("the same forwarding attack fails closed through a real SupervisorService tick, with a healthy selected model", async () => {
    const executor = asScripted(attackExecutor());
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      executor,
      resourceCatalog: CATALOG,
      roadmap: [ITEM],
    });
    await seedRoadmap(supervisor, [ITEM]);

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "WAITING_FOR_HUMAN", JSON.stringify(result));

    const state = (await supervisor.repository.load())!;
    const item = state.roadmap.find((entry) => entry.key === ITEM.key);
    assert.equal(item?.attempts, 1);
    assert.equal(
      item?.unlaunchedAttempts ?? 0,
      0,
      "a nested helper's evidence, forwarded by an untrusted enclosing executor, must not count as a proven non-launch",
    );
    assert.notEqual(
      item?.implementedByResourceKey,
      undefined,
      "the forwarding attack suppressed the routed resource's implementation lineage",
    );
    assert.notEqual(item?.lastRunConfig, undefined, "the forwarding attack suppressed the run configuration record");
    const implementedByProvenance = state.provenance.filter(
      (entry) => entry.kind === "IMPLEMENTED_BY" && entry.roadmapKey === ITEM.key,
    );
    assert.equal(implementedByProvenance.length, 1, "the conservative path must still record IMPLEMENTED_BY");
  });

  it("the attack fails closed regardless of which module loads first, in a fresh process", () => {
    const fixturesUrl = new URL("./support/supervisorFixtures.js", import.meta.url).href;
    const executorUrl = new URL("../src/supervision/planBackedExecutor.js", import.meta.url).href;
    const run = (importFixturesFirst: boolean): { status: number | null; stdout: string; stderr: string } => {
      const imports = importFixturesFirst
        ? `import { newSupervisor, seedRoadmap, scriptedProbe } from ${JSON.stringify(fixturesUrl)};
      import { createPlanBackedExecutor } from ${JSON.stringify(executorUrl)};`
        : `import { createPlanBackedExecutor } from ${JSON.stringify(executorUrl)};
      import { newSupervisor, seedRoadmap, scriptedProbe } from ${JSON.stringify(fixturesUrl)};`;
      const script = `
      ${imports}
      const CATALOG = [
        { provider: "claude-code", model: "opus", billingMode: "INCLUDED_SUBSCRIPTION" },
        { provider: "codex-cli", model: "gpt-5.6-luna", billingMode: "INCLUDED_SUBSCRIPTION" },
      ];
      const probe = scriptedProbe();
      for (const entry of CATALOG) {
        probe.set(entry.provider, entry.model, { state: "AVAILABLE", reason: "scripted", billingMode: "INCLUDED_SUBSCRIPTION" });
      }
      const ITEM = { key: "LOCAL_24_7_RUNTIME", title: "Local 24/7 runtime", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 };
      // The attacker imports the real factory through the public API and
      // calls it from inside its own executor, exactly as production code
      // could reach it.
      const executor = {
        async execute(input) {
          const helper = createPlanBackedExecutor({
            plans: { async findPlanForItem() { return undefined; } },
            planning: { async resume() { throw new Error("unused"); } },
            clock: { now: () => 1756449600000 },
          });
          const proof = await helper.execute(input);
          return {
            kind: "HUMAN_REQUIRED",
            action: { kind: "REVIEW_PLAN", description: "uncertain worker outcome" },
            detail: "arbitrary executor has no global non-launch proof",
            noLaunchEvidence: proof.noLaunchEvidence,
          };
        },
      };
      const supervisor = newSupervisor({ probe, executor, resourceCatalog: CATALOG, roadmap: [ITEM] });
      await seedRoadmap(supervisor, [ITEM]);
      const result = await supervisor.service.tick();
      const state = await supervisor.repository.load();
      const item = state.roadmap.find((entry) => entry.key === ITEM.key);
      process.stdout.write(JSON.stringify({
        result: result.kind,
        implementedByResourceKey: item?.implementedByResourceKey ?? null,
        unlaunchedAttempts: item?.unlaunchedAttempts ?? 0,
        attempts: item?.attempts ?? 0,
      }));
    `;
      return spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
    };

    for (const importFixturesFirst of [true, false]) {
      const child = run(importFixturesFirst);
      assert.equal(
        child.status,
        0,
        `fresh-process reproduction failed (fixtures-first=${importFixturesFirst}): ${child.stderr}`,
      );
      const output = JSON.parse(child.stdout);
      assert.equal(output.result, "WAITING_FOR_HUMAN");
      assert.equal(output.attempts, 1);
      assert.notEqual(
        output.implementedByResourceKey,
        null,
        `import order (fixtures-first=${importFixturesFirst}) let the forwarding attack suppress real implementation lineage`,
      );
      assert.equal(
        output.unlaunchedAttempts,
        0,
        `import order (fixtures-first=${importFixturesFirst}) let a forwarded nested-helper claim count as a proven non-launch`,
      );
    }
  });
});

// =====================================================================
// DEFECT-NO-LAUNCH-LINEAGE-C6: `execute` is a runtime-immutable own property,
// so in-place replacement — repackaging OR transparent forwarding — is
// rejected before any uncertain work can borrow authority.
// =====================================================================

describe("DEFECT-NO-LAUNCH-LINEAGE-C6: execute cannot be replaced in place, transparently or otherwise", () => {
  /**
   * Independent review's exact measured HIGH against C5: binding evidence to
   * the exact `WorkOutcome` object closed REPACKAGING, but a wrapper that
   * forwarded the trusted call's own, unmodified result still verified — and
   * that let an outer, uncertain execution (the wrapper itself, which had
   * already run and incremented `uncertainCalls` before ever calling the
   * genuine boundary) borrow the trust boundary's authority. C5's own test
   * asserted that shape was correctly trusted; it was not, because the
   * EXECUTION SupervisorService actually invoked was the wrapper, not the
   * boundary, regardless of what the wrapper eventually returned.
   *
   * C6 does not try to tell repackaging and transparent-forwarding apart
   * after the fact — it removes the seam both need. `executor.execute` is a
   * runtime-immutable own property (`writable: false`), so
   * `executor.execute = <anything>` never takes effect: under strict mode
   * (ESM, always) it throws synchronously, before the assignment's right-hand
   * side wrapper can ever run for a real input.
   */
  function attemptReplace(executor: WorkExecutor): { readonly rejected: boolean; readonly uncertainCalls: () => number } {
    let uncertainCalls = 0;
    const wrapper = async (_input: WorkExecutionInput): Promise<WorkOutcome> => {
      uncertainCalls += 1;
      return {
        kind: "HUMAN_REQUIRED",
        action: { kind: "REVIEW_PLAN", description: "uncertain worker outcome" },
        detail: "in-place wrapper forwarded the genuine call's evidence",
      };
    };
    let rejected = false;
    try {
      (executor as { execute: WorkExecutor["execute"] }).execute = wrapper;
    } catch {
      rejected = true;
    }
    return { rejected, uncertainCalls: (): number => uncertainCalls };
  }

  it("assigning a replacement onto the exact executor object is rejected before any uncertain work runs", async () => {
    const executor = createPlanBackedExecutor({ plans: noPlanLookup(), planning: neverResumes(), clock: CLOCK });
    const genuine = executor.execute.bind(executor);
    const { rejected, uncertainCalls } = attemptReplace(executor);
    assert.equal(rejected, true, "execute must be a non-writable own property, so replacing it must throw");
    assert.equal(uncertainCalls(), 0, "a rejected assignment must never let the wrapper body run");

    // Reading and calling the property is unaffected: the unchanged, genuine
    // boundary still answers, and its evidence still verifies against this
    // exact executor object.
    const outcome = await executor.execute({ item: ITEM, actionId: "A:LAUNCH_AI_WORKER:1" });
    assert.equal(outcome.kind, "HUMAN_REQUIRED");
    assert.equal(verifyNoLaunchEvidence(outcome, "A:LAUNCH_AI_WORKER:1", executor), true);
    // `genuine`, captured before the rejected assignment, is the same function.
    const replay = await genuine({ item: ITEM, actionId: "A:LAUNCH_AI_WORKER:2" });
    assert.equal(verifyNoLaunchEvidence(replay, "A:LAUNCH_AI_WORKER:2", executor), true);
  });

  it("the rejected-replacement attack leaves a real SupervisorService tick following unchanged, genuine no-plan behaviour, with a healthy selected model", async () => {
    const executor = createPlanBackedExecutor({ plans: noPlanLookup(), planning: neverResumes(), clock: CLOCK });
    const { rejected, uncertainCalls } = attemptReplace(executor);
    assert.equal(rejected, true);

    const supervisor = newSupervisor({
      probe: healthyProbe(),
      executor: asScripted(executor),
      resourceCatalog: CATALOG,
      roadmap: [ITEM],
    });
    await seedRoadmap(supervisor, [ITEM]);

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "WAITING_FOR_HUMAN", JSON.stringify(result));
    assert.equal(uncertainCalls(), 0, "the rejected wrapper must never have been invoked by the real tick");

    const state = (await supervisor.repository.load())!;
    const item = state.roadmap.find((entry) => entry.key === ITEM.key);
    assert.equal(item?.attempts, 1);
    assert.equal(
      item?.unlaunchedAttempts,
      1,
      "the unchanged genuine boundary's proven non-launch must still be recorded, since no wrapper ever ran",
    );
    assert.equal(item?.implementedByResourceKey, undefined, "a rejected wrapper must not have produced any attribution");
    assert.equal(item?.lastRunConfig, undefined, "a rejected wrapper must not have produced a run configuration record");
    const implementedByProvenance = state.provenance.filter(
      (entry) => entry.kind === "IMPLEMENTED_BY" && entry.roadmapKey === ITEM.key,
    );
    assert.deepEqual(implementedByProvenance, [], "no IMPLEMENTED_BY record may exist when no wrapper ever ran");
  });

  it("the rejection holds regardless of which module loads first, and a prior unrelated genuine no-plan call confers no authority, in a fresh process", () => {
    const fixturesUrl = new URL("./support/supervisorFixtures.js", import.meta.url).href;
    const executorUrl = new URL("../src/supervision/planBackedExecutor.js", import.meta.url).href;
    const run = (
      importFixturesFirst: boolean,
      attack: "transparent" | "repackaged",
    ): { status: number | null; stdout: string; stderr: string } => {
      const imports = importFixturesFirst
        ? `import { newSupervisor, seedRoadmap, scriptedProbe } from ${JSON.stringify(fixturesUrl)};
      import { createPlanBackedExecutor } from ${JSON.stringify(executorUrl)};`
        : `import { createPlanBackedExecutor } from ${JSON.stringify(executorUrl)};
      import { newSupervisor, seedRoadmap, scriptedProbe } from ${JSON.stringify(fixturesUrl)};`;
      const script = `
      ${imports}
      const CATALOG = [
        { provider: "claude-code", model: "opus", billingMode: "INCLUDED_SUBSCRIPTION" },
        { provider: "codex-cli", model: "gpt-5.6-luna", billingMode: "INCLUDED_SUBSCRIPTION" },
      ];
      const probe = scriptedProbe();
      for (const entry of CATALOG) {
        probe.set(entry.provider, entry.model, { state: "AVAILABLE", reason: "scripted", billingMode: "INCLUDED_SUBSCRIPTION" });
      }
      const ITEM = { key: "LOCAL_24_7_RUNTIME", title: "Local 24/7 runtime", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 };
      const UNRELATED_ITEM = { key: "UNRELATED_ITEM", title: "Unrelated", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 2 };

      // A previous, entirely unrelated genuine no-plan call, on its own
      // executor instance and its own action, must confer no authority to
      // anything that runs afterwards — there is no shared, ambient "a
      // genuine no-plan happened somewhere" flag for an attacker to trip.
      const unrelatedExecutor = createPlanBackedExecutor({
        plans: { async findPlanForItem() { return undefined; } },
        planning: { async resume() { throw new Error("unused"); } },
        clock: { now: () => 1756449600000 },
      });
      await unrelatedExecutor.execute({ item: UNRELATED_ITEM, actionId: "UNRELATED_ITEM:LAUNCH_AI_WORKER:1" });

      // The attacker's target: the exact executor object that will be
      // registered as the supervisor's dispatched-to executor, obtained
      // through the public factory.
      const executor = createPlanBackedExecutor({
        plans: { async findPlanForItem() { return undefined; } },
        planning: { async resume() { throw new Error("unused"); } },
        clock: { now: () => 1756449600000 },
      });
      const originalExecute = executor.execute;
      const genuine = executor.execute.bind(executor);
      const attackVariant = ${JSON.stringify(attack)};
      let uncertainCalls = 0;
      let rejected = false;
      try {
        executor.execute = async (input) => {
          uncertainCalls += 1;
          const proof = await genuine(input);
          if (attackVariant === "transparent") return proof;
          const forwardedEvidence = proof.kind === "HUMAN_REQUIRED" ? proof.noLaunchEvidence : undefined;
          return {
            kind: "HUMAN_REQUIRED",
            action: { kind: "REVIEW_PLAN", description: "uncertain worker outcome" },
            detail: "in-place wrapper forwarded the genuine call's evidence",
            ...(forwardedEvidence === undefined ? {} : { noLaunchEvidence: forwardedEvidence }),
          };
        };
      } catch {
        rejected = true;
      }
      const methodUnchanged = executor.execute === originalExecute;
      const supervisor = newSupervisor({ probe, executor, resourceCatalog: CATALOG, roadmap: [ITEM] });
      await seedRoadmap(supervisor, [ITEM]);
      const result = await supervisor.service.tick();
      const state = await supervisor.repository.load();
      const item = state.roadmap.find((entry) => entry.key === ITEM.key);
      process.stdout.write(JSON.stringify({
        attack: attackVariant,
        result: result.kind,
        implementedByResourceKey: item?.implementedByResourceKey ?? null,
        unlaunchedAttempts: item?.unlaunchedAttempts ?? 0,
        attempts: item?.attempts ?? 0,
        uncertainCalls,
        rejected,
        methodUnchanged,
      }));
    `;
      return spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
    };

    for (const importFixturesFirst of [true, false]) {
      for (const attack of ["transparent", "repackaged"] as const) {
        const child = run(importFixturesFirst, attack);
        assert.equal(
          child.status,
          0,
          `fresh-process reproduction failed (fixtures-first=${importFixturesFirst}, attack=${attack}): ${child.stderr}`,
        );
        const output = JSON.parse(child.stdout);
        assert.equal(output.attack, attack);
        assert.equal(
          output.rejected,
          true,
          `import order (fixtures-first=${importFixturesFirst}, attack=${attack}) let a replacement be installed onto the public factory's executor`,
        );
        assert.equal(output.methodUnchanged, true, "the rejected replacement must leave the original execute method installed");
        assert.equal(output.uncertainCalls, 0, `import order (fixtures-first=${importFixturesFirst}) let the rejected wrapper run`);
        assert.equal(output.result, "WAITING_FOR_HUMAN");
        assert.equal(output.attempts, 1);
        assert.equal(
          output.implementedByResourceKey,
          null,
          `import order (fixtures-first=${importFixturesFirst}) attributed implementation to a no-op tick`,
        );
        assert.equal(
          output.unlaunchedAttempts,
          1,
          `import order (fixtures-first=${importFixturesFirst}) failed to record the unchanged genuine boundary's proven non-launch, or a prior unrelated genuine call conferred authority`,
        );
      }
    }
  });
});

// =====================================================================
// AC-1: the real plan-backed no-plan path through real settlement
// =====================================================================

describe("DEFECT-NO-LAUNCH-LINEAGE: the proven no-plan outcome", () => {
  it("reports HUMAN_REQUIRED without dispatching planning and without attributing implementation", async () => {
    const executor = createPlanBackedExecutor({
      plans: noPlanLookup(),
      planning: neverResumes(),
      clock: CLOCK,
    });
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      executor: asScripted(executor),
      resourceCatalog: CATALOG,
      roadmap: [ITEM],
    });
    await seedRoadmap(supervisor, [ITEM]);

    const result = await supervisor.service.tick();

    assert.equal(result.kind, "WAITING_FOR_HUMAN", JSON.stringify(result));

    const state = (await supervisor.repository.load())!;
    const item = state.roadmap.find((entry) => entry.key === ITEM.key);
    assert.equal(item?.status, "WAITING_FOR_HUMAN_REQUIRED");
    assert.equal(item?.implementedByResourceKey, undefined, "a resource that never launched was named as implementer");
    assert.deepEqual(item?.implementedByResourceKeys ?? [], []);
    assert.equal(item?.lastRunConfig, undefined, "a resource that never launched got a run configuration");
    assert.equal(item?.attempts, 1);
    assert.equal(item?.unlaunchedAttempts, 1, "the proven non-launch must be recorded, or a later tick will see a false gap");

    const implementedByProvenance = state.provenance.filter(
      (entry) => entry.kind === "IMPLEMENTED_BY" && entry.roadmapKey === ITEM.key,
    );
    assert.deepEqual(implementedByProvenance, [], "no IMPLEMENTED_BY record may exist for an attempt that never launched");
  });

  it("round-trips the same evidence through real SQLite persistence", async () => {
    const dbPath = tempDbPath("no-launch-lineage-");
    const repository = createSqliteSupervisorRepository(dbPath);
    const executor = createPlanBackedExecutor({ plans: noPlanLookup(), planning: neverResumes(), clock: CLOCK });
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      executor: asScripted(executor),
      resourceCatalog: CATALOG,
      roadmap: [ITEM],
      repository,
    });
    await seedRoadmap(supervisor, [ITEM]);

    await supervisor.service.tick();

    const reopened = createSqliteSupervisorRepository(dbPath);
    const reloaded = (await reopened.load())!;
    const item = reloaded.roadmap.find((entry) => entry.key === ITEM.key);
    assert.equal(item?.implementedByResourceKey, undefined);
    assert.equal(item?.lastRunConfig, undefined);
    assert.equal(item?.unlaunchedAttempts, 1);
    assert.equal(
      reloaded.provenance.filter((entry) => entry.kind === "IMPLEMENTED_BY" && entry.roadmapKey === ITEM.key).length,
      0,
    );
  });
});

// =====================================================================
// AC-2: genuine prior lineage survives a later proven non-launch
// =====================================================================

describe("DEFECT-NO-LAUNCH-LINEAGE: prior real lineage is never cleared", () => {
  it("keeps the resource that really implemented an item eligible for exclusion after a later no-launch attempt", async () => {
    // Attempt 1: a REAL run, which leaves the item ELIGIBLE (CHANGES_REQUIRED)
    // with genuine lineage. Attempt 2: the SAME item's action proves — via the
    // real trust boundary — that no worker launched. The first attempt's
    // lineage must survive untouched.
    //
    // C6 makes `execute` a runtime-immutable own property, so this can no
    // longer be built by overriding one executor's `.execute` in place across
    // attempts (round 4's forwarding concern about delegating to a SEPARATE
    // executor object does not apply here in the other direction: identity
    // only has to hold for the attempt that actually claims a no-launch
    // proof). Attempt 1 runs through an ordinary scripted executor — nothing
    // about a real CHANGES_REQUIRED run needs the plan-backed boundary at all.
    // Attempt 2 runs through a SECOND `SupervisorService`, freshly constructed
    // over the SAME durable repository (the same pattern every restart test in
    // this suite uses), whose executor is a plain `createPlanBackedExecutor`
    // instance — the object `verifyNoLaunchEvidence` checks identity against
    // is exactly the one that minted the evidence, with no `.execute`
    // reassignment anywhere.
    const attempt1Executor = scriptedExecutor({
      [ITEM.key]: [{ kind: "CHANGES_REQUIRED", findings: ["needs another pass"] }],
    });
    const first = newSupervisor({
      probe: healthyProbe(),
      executor: attempt1Executor,
      resourceCatalog: CATALOG,
      roadmap: [ITEM],
    });
    await seedRoadmap(first, [ITEM]);

    await first.service.tick(); // attempt 1: real run, CHANGES_REQUIRED
    const afterFirst = (await first.repository.load())!;
    const firstImplementer = afterFirst.roadmap.find((entry) => entry.key === ITEM.key)?.implementedByResourceKey;
    assert.ok(firstImplementer !== undefined, "the fixture needs a real first attempt to establish lineage");
    const firstImplementedByCount = afterFirst.provenance.filter(
      (entry) => entry.kind === "IMPLEMENTED_BY" && entry.roadmapKey === ITEM.key,
    ).length;
    assert.equal(firstImplementedByCount, 1);

    const noPlanExecutor = createPlanBackedExecutor({ plans: noPlanLookup(), planning: neverResumes(), clock: CLOCK });
    const second = newSupervisor({
      probe: healthyProbe(),
      executor: asScripted(noPlanExecutor),
      resourceCatalog: CATALOG,
      roadmap: [ITEM],
      repository: first.repository,
    });
    await declarePersisted(second);

    const result = await second.service.tick(); // attempt 2: proven no-launch
    assert.equal(result.kind, "WAITING_FOR_HUMAN", JSON.stringify(result));

    const afterSecond = (await second.repository.load())!;
    const item = afterSecond.roadmap.find((entry) => entry.key === ITEM.key);
    assert.equal(item?.implementedByResourceKey, firstImplementer, "the real implementer's record was cleared or replaced");
    assert.ok((item?.implementedByResourceKeys ?? []).includes(firstImplementer!), "the real implementer's history entry was lost");
    assert.equal(item?.attempts, 2);
    assert.equal(item?.unlaunchedAttempts, 1, "only the second, proven-unlaunched attempt should count");
    const implementedByCount = afterSecond.provenance.filter(
      (entry) => entry.kind === "IMPLEMENTED_BY" && entry.roadmapKey === ITEM.key,
    ).length;
    assert.equal(implementedByCount, 1, "a proven non-launch must not add a second IMPLEMENTED_BY record");
  });
});

// =====================================================================
// AC-4: forged/foreign no-launch claims cannot suppress real lineage
// =====================================================================

describe("DEFECT-NO-LAUNCH-LINEAGE: a claim alone proves nothing", () => {
  it("still records lineage when the outcome carries a hand-built object, never minted", async () => {
    const executor: WorkExecutor = {
      async execute(input): Promise<WorkOutcome> {
        return {
          kind: "HUMAN_REQUIRED",
          action: { kind: "AUTHOR_PLAN", description: `${input.item.key} needs an approved plan` },
          detail: "forged: claims no launch happened",
          // NOT produced by the real `NoLaunchBoundary`. Exactly the shape a
          // JSON-parsed child process message, or a hand-rolled test double,
          // could produce.
          noLaunchEvidence: { actionId: input.actionId, reason: "forged" },
        };
      },
    };
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      executor: asScripted(executor),
      resourceCatalog: CATALOG,
      roadmap: [ITEM],
    });
    await seedRoadmap(supervisor, [ITEM]);

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "WAITING_FOR_HUMAN");

    const state = (await supervisor.repository.load())!;
    const item = state.roadmap.find((entry) => entry.key === ITEM.key);
    assert.notEqual(item?.implementedByResourceKey, undefined, "a forged claim suppressed real lineage attribution");
    assert.notEqual(item?.lastRunConfig, undefined, "a forged claim suppressed the run configuration record");
  });

  it("still records lineage when genuine evidence is replayed for a different action (foreign action / stale evidence)", async () => {
    // A real `NoLaunchEvidence`, produced by the real trust boundary through
    // `createPlanBackedExecutor` — but bound to an actionId that is not the
    // one being settled. This is what a naive replay attack, or a stale
    // evidence object surviving a retry, looks like.
    const foreignExecutor = createPlanBackedExecutor({ plans: noPlanLookup(), planning: neverResumes(), clock: CLOCK });
    const foreignOutcome = await foreignExecutor.execute({ item: ITEM, actionId: "SOME_OTHER_ITEM:LAUNCH_AI_WORKER:1" });
    assert.equal(foreignOutcome.kind, "HUMAN_REQUIRED");
    const foreignEvidence = foreignOutcome.kind === "HUMAN_REQUIRED" ? foreignOutcome.noLaunchEvidence : undefined;
    assert.ok(foreignEvidence !== undefined);
    const executor: WorkExecutor = {
      async execute(input): Promise<WorkOutcome> {
        return {
          kind: "HUMAN_REQUIRED",
          action: { kind: "AUTHOR_PLAN", description: `${input.item.key} needs an approved plan` },
          detail: "replayed evidence from a different action",
          noLaunchEvidence: foreignEvidence,
        };
      },
    };
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      executor: asScripted(executor),
      resourceCatalog: CATALOG,
      roadmap: [ITEM],
    });
    await seedRoadmap(supervisor, [ITEM]);

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "WAITING_FOR_HUMAN");

    const state = (await supervisor.repository.load())!;
    const item = state.roadmap.find((entry) => entry.key === ITEM.key);
    assert.notEqual(item?.implementedByResourceKey, undefined, "foreign-action evidence suppressed real lineage attribution");
  });
});

// =====================================================================
// AC-3: a real worker ending HUMAN_REQUIRED is unaffected
// =====================================================================

describe("DEFECT-NO-LAUNCH-LINEAGE: real HUMAN_REQUIRED outcomes are unaffected", () => {
  it("still names the resource that ran when a real worker legitimately asks for a human", async () => {
    const executor = scriptedExecutor({
      [ITEM.key]: [
        {
          kind: "HUMAN_REQUIRED",
          action: { kind: "REVIEW_PLAN", description: "a real worker ran and needs a human decision" },
          detail: "real work happened; a human must decide",
        },
      ],
    });
    const supervisor = newSupervisor({ probe: healthyProbe(), executor, resourceCatalog: CATALOG, roadmap: [ITEM] });
    await seedRoadmap(supervisor, [ITEM]);

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "WAITING_FOR_HUMAN");

    const state = (await supervisor.repository.load())!;
    const item = state.roadmap.find((entry) => entry.key === ITEM.key);
    assert.notEqual(item?.implementedByResourceKey, undefined, "a real worker's HUMAN_REQUIRED lost its lineage");
    assert.equal(item?.unlaunchedAttempts ?? 0, 0, "a real worker's attempt must not be counted as unlaunched");
  });
});
