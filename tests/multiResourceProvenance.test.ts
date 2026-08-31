/**
 * TASK-015 round-1 remediation: the four findings, reproduced.
 *
 * Finding 1 was the dangerous one and it was mine: provenance recorded the
 * ROUTED resource as the implementer. Independent review authorised planner
 * `claude-code/sonnet`, implementer `claude-code/opus` and reviewer
 * `codex-cli/gpt-5.6-luna`, and the durable record said
 * `IMPLEMENTED_BY claude-code:sonnet`. That does not merely lose evidence —
 * `excludedReviewerResources` reads this chain to stop an implementer reviewing
 * its own work, so the wrong name excludes an innocent resource AND leaves the
 * real implementer free to review itself. C4 became a coin toss.
 *
 * Offline: no provider, no model, no money.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { cleanupTempDbs } from "./support/factoryFixtures.js";
import { newSupervisor, scriptedProbe, seedRoadmap } from "./support/supervisorFixtures.js";
import type {
  RequiredResource,
  WorkExecutionInput,
  WorkOutcome,
} from "../src/supervision/supervisorPorts.js";
import type { ScriptedExecutor, ScriptedProbe } from "./support/supervisorFixtures.js";
import type { RoadmapItem } from "../src/supervision/supervisorTypes.js";

after(cleanupTempDbs);

const CATALOG = [
  { provider: "claude-code", model: "opus", billingMode: "INCLUDED_SUBSCRIPTION" as const },
  { provider: "claude-code", model: "sonnet", billingMode: "INCLUDED_SUBSCRIPTION" as const },
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

/** The C4 shape: three roles, three distinct models. */
const C4_ROLES: readonly RequiredResource[] = [
  { role: "planner", provider: "claude-code", model: "sonnet" },
  { role: "implementer", provider: "claude-code", model: "opus" },
  { role: "reviewer", provider: "codex-cli", model: "gpt-5.6-luna" },
];

function executorReporting(
  declared: readonly RequiredResource[],
  outcome: WorkOutcome,
): ScriptedExecutor {
  const inputs: WorkExecutionInput[] = [];
  return {
    calls: () => inputs,
    callsFor: (key: string) => inputs.filter((entry) => entry.item.key === key),
    async declareResources(): Promise<readonly RequiredResource[]> {
      return declared;
    },
    async execute(input: WorkExecutionInput): Promise<WorkOutcome> {
      inputs.push(input);
      return outcome;
    },
  };
}

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

async function runOnce(executor: ScriptedExecutor) {
  const supervisor = newSupervisor({ probe: healthyProbe(), executor, resourceCatalog: CATALOG });
  await seedRoadmap(supervisor, [ITEM]);
  const result = await supervisor.service.tick();
  const state = await supervisor.repository.load();
  return { result, state };
}

describe("TASK-015 finding 1: lineage names the resource that implemented", () => {
  it("records the IMPLEMENTER, not whichever resource the router happened to pick", async () => {
    const executor = executorReporting(C4_ROLES, { kind: "CHANGES_REQUIRED", findings: ["scripted"] });

    const { state } = await runOnce(executor);

    const entries = (state?.provenance ?? []).filter((entry) => entry.kind === "IMPLEMENTED_BY");
    assert.equal(entries.length, 1, "exactly one lineage entry is expected");
    assert.equal(
      entries[0]?.resourceKey,
      "claude-code:opus",
      "lineage names a resource that did not implement, so reviewer exclusion will bar the wrong one",
    );
  });

  /**
   * THE C4 CONSEQUENCE, asserted directly rather than inferred: the resource
   * that really implemented must be the one later excluded from reviewing.
   */
  it("puts the real implementer into the item's implementer history", async () => {
    const executor = executorReporting(C4_ROLES, { kind: "CHANGES_REQUIRED", findings: ["scripted"] });

    const { state } = await runOnce(executor);

    const item = (state?.roadmap ?? []).find((entry) => entry.key === ITEM.key);
    assert.ok(
      (item?.implementedByResourceKeys ?? []).includes("claude-code:opus"),
      `the real implementer is absent from lineage: ${JSON.stringify(item?.implementedByResourceKeys)}`,
    );
    assert.ok(
      !(item?.implementedByResourceKeys ?? []).includes("codex-cli:gpt-5.6-luna"),
      "the REVIEWER was recorded as an implementer, which would bar it from reviewing anything",
    );
  });

  /**
   * AC-5: the whole authorised set is reconstructable from the durable record.
   */
  it("records every authorised resource and its role", async () => {
    const executor = executorReporting(C4_ROLES, { kind: "CHANGES_REQUIRED", findings: ["scripted"] });

    const { state } = await runOnce(executor);

    const detail = (state?.provenance ?? []).find((entry) => entry.kind === "IMPLEMENTED_BY")?.detail ?? "";
    for (const expected of [
      "planner=claude-code/sonnet",
      "implementer=claude-code/opus",
      "reviewer=codex-cli/gpt-5.6-luna",
    ]) {
      assert.match(detail, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${expected} is not recorded`);
    }
  });

  /**
   * An action that declares nothing must keep recording the routed resource,
   * or the fix has changed the single-resource path it was not supposed to touch.
   */
  it("still records the routed resource when the work declares no roles", async () => {
    const inputs: WorkExecutionInput[] = [];
    const executor: ScriptedExecutor = {
      calls: () => inputs,
      callsFor: (key: string) => inputs.filter((entry) => entry.item.key === key),
      async execute(input: WorkExecutionInput): Promise<WorkOutcome> {
        inputs.push(input);
        return { kind: "CHANGES_REQUIRED", findings: ["scripted"] };
      },
    };

    const { state } = await runOnce(executor);

    const entries = (state?.provenance ?? []).filter((entry) => entry.kind === "IMPLEMENTED_BY");
    assert.equal(entries.length, 1);
    assert.ok(
      (entries[0]?.resourceKey ?? "").startsWith("claude-code:"),
      "the routed resource stopped being recorded for undeclared work",
    );
  });
});

describe("TASK-015 finding 2: identity is reconciled against the set", () => {
  /**
   * An executor that ran an authorised NON-ROUTED member reported the exact
   * truth and was refused as a mismatch — the old single-resource behaviour
   * surviving into a multi-resource world.
   */
  it("accepts a worker reporting an authorised non-routed member", async () => {
    const executor = executorReporting(C4_ROLES, {
      kind: "COMPLETED",
      detail: "done",
      reportedIdentity: { provider: "codex-cli", model: "gpt-5.6-luna" },
    });

    const { result } = await runOnce(executor);

    assert.notEqual(
      result.kind,
      "RECOVERY_REQUIRED",
      `an authorised member was refused as a mismatch: ${JSON.stringify(result)}`,
    );
  });

  /**
   * EFFORT IS PART OF MEMBERSHIP (round-2 finding 2).
   *
   * With `routed claude-code/sonnet` and `implementer claude-code/sonnet:high`
   * both authorised, a worker reporting `sonnet:high` matched the ROUTED entry —
   * which requested no effort — and was refused with "reported effort high but
   * none was requested". An authorised member, refused, because the lookup
   * compared only provider and model.
   */
  it("accepts a member that differs from the routed resource only by effort", async () => {
    /**
     * THE PLANNER SHARES THE PROVIDER AND MODEL AND NAMES NO EFFORT, ON PURPOSE.
     *
     * Without it this case was sibling-guarded: only one authorised entry had
     * this provider/model, so deleting the effort term from the lookup still
     * matched the same entry and the test stayed green. A second candidate that
     * differs ONLY by effort is what makes the effort comparison decide
     * anything — the reviewer demonstrated exactly this repair.
     */
    const executor = executorReporting(
      [
        { role: "planner", provider: "claude-code", model: "sonnet" },
        { role: "implementer", provider: "claude-code", model: "sonnet", effort: "high" },
        { role: "reviewer", provider: "codex-cli", model: "gpt-5.6-luna" },
      ],
      {
        kind: "COMPLETED",
        detail: "done",
        reportedIdentity: { provider: "claude-code", model: "sonnet", effort: "high" },
      },
    );

    const { result } = await runOnce(executor);

    assert.notEqual(
      result.kind,
      "RECOVERY_REQUIRED",
      `an authorised member was refused over effort: ${JSON.stringify(result)}`,
    );
  });

  /**
   * THE CONTROL. A report naming something OUTSIDE the set must still be
   * refused, or the fix is a bypass rather than a widening.
   */
  it("still refuses a worker reporting a resource nobody authorised", async () => {
    const executor = executorReporting(C4_ROLES, {
      kind: "COMPLETED",
      detail: "done",
      reportedIdentity: { provider: "rogue-provider", model: "ghost" },
    });

    const { result } = await runOnce(executor);

    assert.equal(
      result.kind,
      "RECOVERY_REQUIRED",
      `an unauthorised reported identity was accepted: ${JSON.stringify(result)}`,
    );
  });
});

describe("TASK-015: a reported identity on a CHECKPOINT is reconciled too", () => {
  /**
   * A CHECKPOINT CARRIES A REPORTED IDENTITY, and nothing covered that.
   *
   * An earlier version of this comment claimed the COMPLETED case above was
   * sibling-guarded by the completion-provenance guard, "found by mutation".
   * That was a MISDIAGNOSIS: the mutation only appeared to survive because my
   * own mutation harness had written half of a previous mutation back into the
   * source, having re-captured already-mutated text as the original. With the
   * harness corrected, the COMPLETED case kills that mutation exactly as its
   * name claims.
   *
   * These cases stay because a session rollover reports an identity too, and a
   * worker that checkpoints while claiming an unauthorised resource should be
   * refused for the same reason one that completes is. They are additional
   * coverage rather than a repair.
   */
  it("refuses a checkpointing worker that reports a resource nobody authorised", async () => {
    const executor = executorReporting(C4_ROLES, {
      kind: "CHECKPOINT",
      detail: "rolled over",
      checkpoint: {
        roadmapKey: ITEM.key,
        actionId: "action-1",
        iteration: 1,
        completedVerification: [],
        pendingVerification: [],
        findings: [],
        nextAction: "continue",
        requiredWorkClass: ITEM.workClass,
        updatedAt: 0 as never,
      },
      reportedIdentity: { provider: "rogue-provider", model: "ghost" },
    });

    const { result } = await runOnce(executor);

    assert.equal(
      result.kind,
      "RECOVERY_REQUIRED",
      `an unauthorised reported identity was accepted on a checkpoint: ${JSON.stringify(result)}`,
    );
  });

  /**
   * AND THE CONTROL: a checkpoint reporting an AUTHORISED member is not refused,
   * so the guard above is not satisfied by refusing every checkpoint.
   */
  it("accepts a checkpointing worker that reports an authorised member", async () => {
    const executor = executorReporting(C4_ROLES, {
      kind: "CHECKPOINT",
      detail: "rolled over",
      checkpoint: {
        roadmapKey: ITEM.key,
        actionId: "action-1",
        iteration: 1,
        completedVerification: [],
        pendingVerification: [],
        findings: [],
        nextAction: "continue",
        requiredWorkClass: ITEM.workClass,
        updatedAt: 0 as never,
      },
      reportedIdentity: { provider: "claude-code", model: "opus" },
    });

    const { result } = await runOnce(executor);

    assert.notEqual(
      result.kind,
      "RECOVERY_REQUIRED",
      `an authorised member was refused on a checkpoint: ${JSON.stringify(result)}`,
    );
  });
});

describe("TASK-015 finding 4: a probe that throws is a controlled refusal", () => {
  /**
   * The real CLI probe throws for a provider it has no zero-token probe for, and
   * `tick()` rethrows anything that is not a persistence error — so a declared
   * `rogue-provider` killed the tick instead of refusing the action.
   */
  it("refuses the action instead of killing the tick", async () => {
    /**
     * A CATALOGUED provider whose probe throws (round-7 note).
     *
     * The first version used `rogue-provider`, which declaration validation
     * rejects BEFORE anything is probed — so the probe catch was never reached
     * and deleting it left this file green. The throw has to come from a
     * resource that gets as far as being probed.
     */
    const executor = executorReporting(
      [
        { role: "implementer", provider: "claude-code", model: "opus" },
        { role: "reviewer", provider: "codex-cli", model: "gpt-5.6-luna" },
      ],
      { kind: "COMPLETED", detail: "should never happen" },
    );
    /**
     * A probe that THROWS for an unknown provider, which is what
     * `createCliResourceProbe` really does — it refuses to assume an unknown
     * provider is usable. The scripted fixture cannot express that, so this case
     * wraps it rather than widening the shared fixture for one test.
     */
    const healthy = healthyProbe();
    const probe: ScriptedProbe = {
      probeCount: (provider: string, model: string) => healthy.probeCount(provider, model),
      totalProbes: () => healthy.totalProbes(),
      set: (provider, model, classification) => healthy.set(provider, model, classification),
      async probe(provider: string, model: string) {
        if (provider === "codex-cli") {
          throw new Error(`probe transport failed for provider "${provider}"`);
        }
        return healthy.probe(provider, model);
      },
    };

    const supervisor = newSupervisor({ probe, executor, resourceCatalog: CATALOG });
    await seedRoadmap(supervisor, [ITEM]);

    const result = await supervisor.service.tick();

    assert.equal(result.kind, "RECOVERY_REQUIRED", "the tick did not refuse in a controlled way");
    assert.equal(executor.calls().length, 0, "work ran despite an unprobeable member");
    /**
     * AND THE REFUSAL NAMES THE UNPROBEABLE RESOURCE (round-11 finding 2). The
     * message named it all along; nothing asserted the name, so the reviewer's
     * name-removal mutation survived this suite — a refusal that is correct
     * for a reason the test does not pin.
     */
    assert.match(
      result.kind === "RECOVERY_REQUIRED" ? result.reason : "",
      /codex-cli:gpt-5\.6-luna/,
      "the refusal does not name the resource whose probe threw",
    );
  });
});

describe("TASK-015 round-11 finding 2: a worker resource failure names its resource", () => {
  /**
   * A routed worker failed with "provider CLI exited 1 with no recognised
   * failure signature", and that text reached the tick result, the persisted
   * roadmap detail and the resource diagnostic with the resource's key in NONE
   * of them. Three declared resources, one failure: WHICH CLI failed is the
   * fact an operator acts on, and it lived only in free text that does not
   * carry forward.
   */
  it("carries the failing resource's key into the result and the roadmap detail", async () => {
    const executor = executorReporting(
      [
        { role: "implementer", provider: "claude-code", model: "opus" },
        { role: "reviewer", provider: "codex-cli", model: "gpt-5.6-luna" },
      ],
      {
        // The reviewer's reproduction: an exit the classifier has no signature
        // for, which produces "provider CLI exited 1 with no recognised
        // failure signature" — previously with no resource key anywhere.
        kind: "RESOURCE_FAILURE",
        process: { terminationReason: "EXITED", exitCode: 1, stdout: "", stderr: "" },
      },
    );
    const supervisor = newSupervisor({ probe: healthyProbe(), executor, resourceCatalog: CATALOG });
    await seedRoadmap(supervisor, [ITEM]);

    const result = await supervisor.service.tick();

    assert.equal(result.kind, "WAITING_FOR_RESOURCE", `expected a resource wait: ${JSON.stringify(result)}`);
    // The implementer is the resource the run was launched as, so the failure
    // is ITS failure — the same identity `lastRunConfig` and lineage carry.
    assert.match(
      result.kind === "WAITING_FOR_RESOURCE" ? result.reason : "",
      /claude-code:opus/,
      "the failure does not name the resource that failed",
    );
    const after = await supervisor.repository.load();
    const item = (after?.roadmap ?? []).find((entry) => entry.key === ITEM.key);
    assert.match(
      item?.detail ?? "",
      /claude-code:opus/,
      "the persisted roadmap detail does not name the resource that failed",
    );
  });
});
