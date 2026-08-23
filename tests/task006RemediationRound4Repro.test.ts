/**
 * TASK-006 REMEDIATION ROUND 4 — permanent reproductions of the fourth
 * independent review's four CRITICAL and five HIGH findings.
 *
 * Rounds 1–3 kept arriving at one sentence: *a safety property that depends on
 * data the system itself can write is not a safety property.* Round 4 is that
 * sentence aimed at the parts nobody had thought of as "data":
 *
 *   F4-1  the ORDER of an exported array decided which class was more
 *         restrictive, and the array was mutable.
 *   F4-2  the authoritative billing facts for a model launch were a FIELD on the
 *         caller's own object. `launchAiWorkerAction` was the intended door;
 *         nothing made it the only one.
 *   F4-3  a persisted row with a fresh-looking timestamp was accepted as
 *         evidence that a resource was free, with no probe running at all.
 *   F4-4  `RUN_VERIFICATION_COMMAND` was free by fiat while naming no command,
 *         so `gcloud compute instances create` was "free verification".
 *   F4-5  the checkpoint sanitizer whitelisted fields and missed three.
 *   F4-6  reviewer independence walked one edge of the dependency graph.
 *   F4-7  the effort allowlist was mutable.
 *   F4-8  "verified" was reported for dimensions nothing had verified.
 *   F4-9  the launch configuration existed only for the duration of one call.
 *
 * Every test here failed against the pre-round-4 tree.
 *
 * Offline: no provider is contacted, no model is invoked, no money can be spent.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import {
  ACTION_CLASSES,
  evaluateFinancialSafety,
  mostRestrictive,
  parseFinancialPolicy,
  verificationCommandAction,
  ZERO_COST_COMMAND_IDS,
  type SupervisedAction,
} from "../src/supervision/financialSafety.js";
import {
  planAiRunConfig,
  reconcileReportedIdentity,
  SUPPORTED_CODEX_EFFORTS,
  type AiRunConfigRecord,
} from "../src/supervision/modelEnforcement.js";
import { interpretClaudeAuthStatus } from "../src/supervision/resourceClassifier.js";
import { NO_BACKOFF } from "../src/supervision/resourceTypes.js";
import type { RoadmapItem } from "../src/supervision/supervisorTypes.js";
import { cleanupTempDbs } from "./support/factoryFixtures.js";
import {
  launchWithObservedBilling,
  newSupervisor,
  scriptedExecutor,
  scriptedProbe,
  seedRoadmap,
  T0,
  TEST_CATALOG,
} from "./support/supervisorFixtures.js";

after(cleanupTempDbs);

const DENY = parseFinancialPolicy({ autonomousSpendAllowed: false, autonomousSpendLimit: 0 });

const ONE_AI_ITEM: readonly RoadmapItem[] = [
  { key: "AI", title: "Needs a model", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
];

function healthyProbe(billingMode: "INCLUDED_SUBSCRIPTION" | "USAGE_BILLED" = "INCLUDED_SUBSCRIPTION") {
  const probe = scriptedProbe();
  for (const entry of TEST_CATALOG) {
    probe.set(entry.provider, entry.model, { state: "AVAILABLE", reason: "scripted", billingMode });
  }
  return probe;
}

// =====================================================================
// F4-1 (CRITICAL) — the class ranking cannot be reordered
// =====================================================================

describe("TASK-006 F4-1: restriction ranking is immutable", () => {
  it("refuses to mutate ACTION_CLASSES", () => {
    assert.ok(Object.isFrozen(ACTION_CLASSES));
    assert.throws(() => {
      "use strict";
      (ACTION_CLASSES as unknown as string[]).splice(0, ACTION_CLASSES.length, "FINANCIAL_ACTION");
    });
    assert.throws(() => {
      "use strict";
      (ACTION_CLASSES as unknown as string[]).push("ANYTHING");
    });
  });

  it("keeps the correct verdict even if the exported order were reversed", () => {
    // The exploit as reported: reorder the array so FINANCIAL_ACTION ranks
    // lowest, then hand PROVISION_VPS a benign declaredClass. Ranking no longer
    // reads the array at all, so even a successful reorder changes nothing.
    try {
      (ACTION_CLASSES as unknown as string[]).reverse();
    } catch {
      /* frozen, as expected */
    }
    const verdict = evaluateFinancialSafety(
      { kind: "PROVISION_VPS", description: "charge a card", declaredClass: "FREE_LOCAL_ACTION" },
      DENY,
    );
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.actionClass, "FINANCIAL_ACTION");
  });

  it("ranks every pair of classes consistently", () => {
    const order = [
      "FREE_LOCAL_ACTION",
      "FREE_REMOTE_ACTION",
      "PUBLICATION_ACTION",
      "DESTRUCTIVE_ACTION",
      "HUMAN_CREDENTIAL_ACTION",
      "FINANCIAL_ACTION",
    ] as const;
    for (let i = 0; i < order.length; i += 1) {
      for (let j = 0; j < order.length; j += 1) {
        const expected = i >= j ? order[i]! : order[j]!;
        assert.equal(mostRestrictive(order[i]!, order[j]!), expected);
      }
    }
  });

  it("treats an unrecognised class as maximally restrictive", () => {
    const forged = "TOTALLY_FREE_TRUST_ME" as unknown as (typeof ACTION_CLASSES)[number];
    assert.equal(mostRestrictive(forged, "FREE_LOCAL_ACTION"), forged);
    const verdict = evaluateFinancialSafety(
      { kind: "READ_REPOSITORY", description: "read", declaredClass: forged },
      DENY,
    );
    assert.equal(verdict.allowed, false);
  });
});

// =====================================================================
// F4-2 (CRITICAL) — launch effects cannot be supplied by the caller
// =====================================================================

describe("TASK-006 F4-2: a caller cannot declare a model launch free", () => {
  const BENIGN = {
    costKnownZero: true,
    requiresPaymentMethod: false,
    canIncurUsageCharges: false,
    changesBillingConfiguration: false,
    requiresHumanCredential: false,
    makesPublic: false,
    irreversibleDataLoss: false,
    remote: true,
  } as const;

  for (const kind of ["LAUNCH_AI_WORKER", "LAUNCH_AI_REVIEWER"]) {
    it(`refuses a hand-built ${kind} carrying benign effects`, () => {
      const verdict = evaluateFinancialSafety(
        { kind, description: "metered API call", effects: BENIGN },
        DENY,
      );
      assert.equal(verdict.allowed, false, "a hand-built launch action must not be free");
      assert.equal(verdict.actionClass, "FINANCIAL_ACTION");
    });
  }

  it("refuses a COPY of a properly minted action", () => {
    // The subtle case: mint a legitimate free action, then spread it. The copy
    // is a different object, so it carries no mint — which is exactly the
    // property that makes the mint unforgeable.
    const minted = launchWithObservedBilling({
      resourceKey: "claude-code:opus",
      billingMode: "INCLUDED_SUBSCRIPTION",
      description: "work",
    });
    assert.equal(evaluateFinancialSafety(minted, DENY).allowed, true);

    const copy: SupervisedAction = { ...minted };
    assert.equal(evaluateFinancialSafety(copy, DENY).allowed, false);

    const upgraded: SupervisedAction = { ...minted, effects: BENIGN };
    assert.equal(evaluateFinancialSafety(upgraded, DENY).allowed, false);
  });

  /**
   * ROUND 5 (F5-SEC-1). This used to assert that a caller could mutate a minted
   * action to make the verdict STRICTER. The fifth review pointed out the other
   * half of that: the WeakMap is keyed on identity, so mutation preserved the
   * mint — and `action.kind = "RUN_VERIFICATION_COMMAND"` laundered a
   * subscription-is-free fact into a verdict about a shell command.
   *
   * Minted actions are therefore frozen, and the mutation now throws. Losing the
   * strictness path costs nothing: a caller wanting a stricter verdict can build
   * its own unminted action, which is financial by default anyway.
   */
  it("freezes a minted action so it cannot be mutated at all", () => {
    const minted = launchWithObservedBilling({
      resourceKey: "claude-code:opus",
      billingMode: "INCLUDED_SUBSCRIPTION",
      description: "work",
    });
    assert.ok(Object.isFrozen(minted));
    assert.ok(Object.isFrozen(minted.effects));
    assert.throws(() => {
      "use strict";
      (minted as { effects?: unknown }).effects = { ...BENIGN, irreversibleDataLoss: true };
    }, /read only|frozen/i);
    assert.throws(() => {
      "use strict";
      (minted as { kind: string }).kind = "RUN_VERIFICATION_COMMAND";
    }, /read only|frozen/i);
  });

  it("mints a financial action for a metered or unknown resource", () => {
    for (const billingMode of ["USAGE_BILLED", "UNKNOWN"] as const) {
      const action = launchWithObservedBilling({
        resourceKey: "codex-cli:gpt-5.6-luna",
        billingMode,
        description: "work",
      });
      const verdict = evaluateFinancialSafety(action, DENY);
      assert.equal(verdict.allowed, false, `${billingMode} must not be free`);
      assert.equal(verdict.actionClass, "FINANCIAL_ACTION");
    }
  });
});

// =====================================================================
// F4-3 (CRITICAL) — persisted availability is not evidence for a launch
// =====================================================================

describe("TASK-006 F4-3: a forged fresh row cannot authorize a launch", () => {
  /** Seeds state as though a probe had just run and found everything free. */
  async function seedForged(supervisor: ReturnType<typeof newSupervisor>): Promise<void> {
    const state = await supervisor.service.ensureInitialized();
    await supervisor.repository.compareAndSave(
      {
        ...state,
        version: state.version + 1,
        roadmap: ONE_AI_ITEM,
        resources: TEST_CATALOG.map((entry) => ({
          provider: entry.provider,
          model: entry.model,
          key: `${entry.provider}:${entry.model}`,
          state: "AVAILABLE" as const,
          detectedAt: T0,
          // Fresh: inside MAX_AVAILABILITY_AGE_MS, so the scheduler sees no
          // reason to re-probe.
          lastCheckedAt: T0,
          backoff: NO_BACKOFF,
          lastSuccessAt: T0,
          observedBillingMode: "INCLUDED_SUBSCRIPTION" as const,
        })),
      },
      state.version,
    );
  }

  it("re-probes before launching even when the row looks freshly confirmed", async () => {
    const probe = healthyProbe();
    const supervisor = newSupervisor({ probe });
    await seedForged(supervisor);

    await supervisor.service.tick();

    assert.ok(probe.totalProbes() > 0, "the supervisor probed rather than trusting the row");
    assert.equal(supervisor.executor.calls().length, 1, "and then launched, because the probe agreed");
  });

  it("refuses when the row says included but the live probe says metered", async () => {
    const probe = healthyProbe("USAGE_BILLED");
    const supervisor = newSupervisor({ probe });
    await seedForged(supervisor);

    const result = await supervisor.service.tick();

    assert.equal(result.kind, "WAITING_FOR_HUMAN");
    if (result.kind === "WAITING_FOR_HUMAN") {
      assert.equal(result.reason, "FINANCIAL_ACTION_REQUIRED");
    }
    assert.equal(supervisor.executor.calls().length, 0, "nothing ran on a metered resource");
  });

  it("waits when the row says available but the live probe says the limit is reached", async () => {
    const probe = scriptedProbe();
    for (const entry of TEST_CATALOG) {
      probe.set(entry.provider, entry.model, {
        state: "USAGE_LIMIT_REACHED",
        reason: "quota exhausted",
      });
    }
    const supervisor = newSupervisor({ probe });
    await seedForged(supervisor);

    const result = await supervisor.service.tick();

    assert.equal(result.kind, "WAITING_FOR_RESOURCE");
    assert.equal(supervisor.executor.calls().length, 0);
  });

  it("persists what the pre-launch probe observed", async () => {
    const probe = healthyProbe("USAGE_BILLED");
    const supervisor = newSupervisor({ probe });
    await seedForged(supervisor);

    await supervisor.service.tick();

    const state = await supervisor.repository.load();
    const observed = state?.resources.map((record) => record.observedBillingMode) ?? [];
    assert.ok(observed.length > 0);
    assert.ok(
      observed.some((mode) => mode === "USAGE_BILLED"),
      "the forged INCLUDED_SUBSCRIPTION was overwritten by what was actually observed",
    );
  });
});

// =====================================================================
// F4-4 (CRITICAL) — a concrete command is only free if it is allowlisted
// =====================================================================

describe("TASK-006 F4-4: an arbitrary command is not free verification", () => {
  /**
   * ROUND 5 NOTE. These originally exercised an EXECUTABLE allowlist, which the
   * fifth review took apart: `npm run charge`, `npx some-package`, `node
   * --import`, `sh -c "..."` and `git push` all passed it (F5-FIN-1). The unit
   * of authorization is now the whole command, named by identifier, so the
   * cases here are the identifiers rather than the binaries. The pre-round-4
   * defect — a bare `RUN_VERIFICATION_COMMAND` classified free while naming no
   * command — is still pinned below, which is what F4-4 was actually about.
   */
  const notAllowlisted = [
    "gcloud compute instances create",
    "NPM_RUN_CHARGE",
    "SH_DASH_C",
    "GIT_PUSH",
    "",
    "npm",
    "NPM_TEST ",
    "npm_test",
  ];

  for (const commandId of notAllowlisted) {
    it(`classifies ${JSON.stringify(commandId)} as financial`, () => {
      const action = verificationCommandAction({ commandId, description: "verification" });
      const verdict = evaluateFinancialSafety(action, DENY);
      assert.equal(verdict.allowed, false);
      assert.equal(verdict.actionClass, "FINANCIAL_ACTION");
    });
  }

  for (const commandId of ZERO_COST_COMMAND_IDS) {
    it(`allows the allowlisted ${commandId}`, () => {
      const action = verificationCommandAction({ commandId, description: "verification" });
      const verdict = evaluateFinancialSafety(action, DENY);
      assert.equal(verdict.allowed, true);
      assert.equal(verdict.actionClass, "FREE_LOCAL_ACTION");
    });
  }

  it("refuses an unminted RUN_VERIFICATION_COMMAND outright", () => {
    // The pre-round-4 shape: a bare kind with no command named at all.
    const verdict = evaluateFinancialSafety(
      { kind: "RUN_VERIFICATION_COMMAND", description: "npm test, honestly" },
      DENY,
    );
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.actionClass, "FINANCIAL_ACTION");
  });

  it("keeps the supervisor's own deterministic work free", () => {
    const verdict = evaluateFinancialSafety(
      { kind: "RUN_DETERMINISTIC_WORK", description: "invoke the trusted local executor" },
      DENY,
    );
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.actionClass, "FREE_LOCAL_ACTION");
  });
});

// =====================================================================
// F4-5 (HIGH) — every executor-supplied checkpoint field is sanitized
// =====================================================================

describe("TASK-006 F4-5: checkpoint identity fields are sanitized too", () => {
  const LEAK = "sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

  it("redacts projectId, workItemId and planId", async () => {
    const base = scriptedExecutor();
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      executor: {
        ...base,
        async execute(input) {
          return {
            kind: "CHECKPOINT",
            detail: "rolled over",
            checkpoint: {
              roadmapKey: "AI",
              actionId: input.actionId,
              iteration: 1,
              projectId: `prj-${LEAK}`,
              workItemId: `wi-${LEAK}`,
              planId: `plan-${LEAK}`,
              planRevision: 1,
              completedVerification: [],
              pendingVerification: [],
              findings: [],
              nextAction: "continue",
              requiredWorkClass: "NORMAL_IMPLEMENTATION",
              updatedAt: 0,
            },
          };
        },
      },
    });
    await seedRoadmap(supervisor, ONE_AI_ITEM);
    await supervisor.service.tick();

    const state = await supervisor.repository.load();
    const checkpoint = state?.checkpoints.find((entry) => entry.roadmapKey === "AI");
    assert.ok(checkpoint !== undefined, "a checkpoint was stored");
    for (const field of ["projectId", "workItemId", "planId"] as const) {
      const value = checkpoint[field];
      assert.ok(value !== undefined, `${field} survived`);
      assert.ok(!value.includes(LEAK), `${field} still contained a credential`);
    }
    assert.ok(!JSON.stringify(state).includes("sk-ant-"), "no credential anywhere in durable state");
  });
});

// =====================================================================
// F4-6 (HIGH) — reviewer independence covers the whole ancestry
// =====================================================================

describe("TASK-006 F4-6: a reviewer is excluded across the full lineage", () => {
  it("does not let the implementer of a grandparent review its descendant", async () => {
    // A (implemented by codex) <- B (implemented by claude) <- C reviews B.
    // With claude unavailable, the only remaining resource is codex — which
    // implemented A, work that B is built on. The review must WAIT rather than
    // be performed by a resource in its own lineage.
    const probe = scriptedProbe();
    probe.set("codex-cli", "gpt-5.6-luna", {
      state: "AVAILABLE",
      reason: "up",
      billingMode: "INCLUDED_SUBSCRIPTION",
    });
    for (const model of ["opus", "sonnet"]) {
      probe.set("claude-code", model, { state: "USAGE_LIMIT_REACHED", reason: "quota exhausted" });
    }
    const supervisor = newSupervisor({ probe });
    const state = await supervisor.service.ensureInitialized();
    await supervisor.repository.compareAndSave(
      {
        ...state,
        version: state.version + 1,
        roadmap: [
          {
            key: "A",
            title: "Ancestor",
            dependsOn: [],
            status: "DONE",
            workClass: "NORMAL_IMPLEMENTATION",
            order: 1,
            implementedByResourceKey: "codex-cli:gpt-5.6-luna",
          },
          {
            key: "B",
            title: "Middle",
            dependsOn: ["A"],
            status: "DONE",
            workClass: "NORMAL_IMPLEMENTATION",
            order: 2,
            implementedByResourceKey: "claude-code:opus",
          },
          {
            key: "C",
            title: "Review of B",
            dependsOn: ["B"],
            status: "PENDING",
            workClass: "INDEPENDENT_REVIEW",
            order: 3,
          },
        ],
      },
      state.version,
    );

    const result = await supervisor.service.tick();

    assert.notEqual(result.kind, "ADVANCED", "the review must not have run");
    for (const call of supervisor.executor.calls()) {
      assert.notEqual(call.item.key, "C", "C was reviewed by a resource in its own lineage");
    }
  });

  it("rejects a self-referential roadmap before any traversal runs", async () => {
    // The ancestry walk carries a visited set so it terminates on a cycle, but
    // that is defence in depth rather than the primary control: a cyclic roadmap
    // is refused at the persistence boundary, which is where a corrupt queue
    // should stop. This pins the behaviour that actually protects the traversal.
    const supervisor = newSupervisor({ probe: healthyProbe() });
    const state = await supervisor.service.ensureInitialized();

    await assert.rejects(
      () =>
        supervisor.repository.compareAndSave(
          {
            ...state,
            version: state.version + 1,
            roadmap: [
              {
                key: "X",
                title: "Self-referential",
                dependsOn: ["X"],
                status: "ELIGIBLE",
                workClass: "INDEPENDENT_REVIEW",
                order: 1,
                implementedByResourceKey: "claude-code:opus",
              },
            ],
          },
          state.version,
        ),
      /depends on itself/,
    );
    assert.equal(supervisor.executor.calls().length, 0, "and nothing ran");
  });
});

// =====================================================================
// F4-7 / F4-8 (HIGH) — effort allowlist and honest verification
// =====================================================================

describe("TASK-006 F4-7: the effort allowlist is immutable", () => {
  it("refuses to be extended", () => {
    assert.ok(Object.isFrozen(SUPPORTED_CODEX_EFFORTS));
    assert.throws(() => {
      "use strict";
      (SUPPORTED_CODEX_EFFORTS as unknown as string[]).push("forged-effort");
    });
    const result = planAiRunConfig({
      provider: "codex-cli",
      model: "gpt-5.6-luna",
      effort: "forged-effort",
      role: "REVIEWER",
    });
    assert.equal(result.ok, false);
  });

  it("refuses an unknown provider rather than throwing", () => {
    const result = planAiRunConfig({
      provider: "evil-cli" as unknown as "codex-cli",
      model: "anything",
      role: "REVIEWER",
    });
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.match(result.reason, /not a supported provider/);
    }
  });
});

describe("TASK-006 F4-8: verification is per-dimension and honest", () => {
  function record(overrides: Partial<AiRunConfigRecord> = {}): AiRunConfigRecord {
    return {
      requestedProvider: "claude-code",
      requestedModel: "opus",
      effectiveProvider: "claude-code",
      effectiveModel: "opus",
      verification: "UNVERIFIED",
      argvEvidence: ["claude"],
      note: "",
      ...overrides,
    };
  }

  it("stays UNVERIFIED when a requested effort was never reported", () => {
    const result = reconcileReportedIdentity(record({ requestedEffort: "high" }), { model: "opus" });
    assert.equal(result.verification, "UNVERIFIED");
    assert.match(result.note, /remains unverified/);
  });

  it("is a MISMATCH when an effort was reported but never requested", () => {
    const result = reconcileReportedIdentity(record(), { model: "opus", effort: "max" });
    assert.equal(result.verification, "MISMATCH");
  });

  it("is VERIFIED_EFFECTIVE only when every requested dimension was confirmed", () => {
    // Round 5 (F5-ID-1): provider counts as a dimension, so a full report needs
    // all three. `requestedProvider` is always set, which is why the earlier
    // model-only case below is now UNVERIFIED rather than verified.
    const all = reconcileReportedIdentity(record({ requestedEffort: "high" }), {
      provider: "claude-code",
      model: "opus",
      effort: "high",
    });
    assert.equal(all.verification, "VERIFIED_EFFECTIVE");

    const modelOnly = reconcileReportedIdentity(record(), { model: "opus" });
    assert.equal(modelOnly.verification, "UNVERIFIED");

    const providerAndModel = reconcileReportedIdentity(record(), {
      provider: "claude-code",
      model: "opus",
    });
    assert.equal(providerAndModel.verification, "VERIFIED_EFFECTIVE");
  });

  it("is a MISMATCH when the model differs", () => {
    const result = reconcileReportedIdentity(record(), { model: "haiku" });
    assert.equal(result.verification, "MISMATCH");
    assert.equal(result.effectiveModel, "haiku");
  });
});

// =====================================================================
// F4-9 (HIGH) — the launch configuration is durable and enforced
// =====================================================================

describe("TASK-006 F4-9: run configuration is recorded and contradictions fail closed", () => {
  it("records the configuration on the item after a completed run", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    await seedRoadmap(supervisor, ONE_AI_ITEM);

    await supervisor.service.tick();

    const state = await supervisor.repository.load();
    const item = state?.roadmap.find((entry) => entry.key === "AI");
    assert.ok(item?.lastRunConfig !== undefined, "the item records what it was run with");
    assert.ok(item.lastRunConfig.requestedModel.length > 0);
    assert.ok(item.lastRunConfig.argvEvidence.length > 0, "argv evidence survived");
  });

  it("refuses to mark an item DONE when the worker reports a different model", async () => {
    const base = scriptedExecutor();
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      executor: {
        ...base,
        async execute() {
          return {
            kind: "COMPLETED",
            detail: "all done",
            reportedIdentity: { model: "some-cheaper-model" },
          };
        },
      },
    });
    await seedRoadmap(supervisor, ONE_AI_ITEM);

    const result = await supervisor.service.tick();

    assert.equal(result.kind, "RECOVERY_REQUIRED");
    const state = await supervisor.repository.load();
    const item = state?.roadmap.find((entry) => entry.key === "AI");
    assert.notEqual(item?.status, "DONE", "a contradicted run must not be accepted as complete");
    assert.equal(item?.lastRunConfig?.verification, "MISMATCH", "and the contradiction is recorded");
  });

  it("accepts a run whose reported identity matches", async () => {
    const base = scriptedExecutor();
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      executor: {
        ...base,
        async execute(input) {
          return {
            kind: "COMPLETED",
            detail: "all done",
            ...(input.config === undefined
              ? {}
              : {
                  reportedIdentity: {
                    provider: input.config.requestedProvider,
                    model: input.config.requestedModel,
                  },
                }),
          };
        },
      },
    });
    await seedRoadmap(supervisor, ONE_AI_ITEM);

    const result = await supervisor.service.tick();

    assert.equal(result.kind, "ADVANCED");
    const state = await supervisor.repository.load();
    const item = state?.roadmap.find((entry) => entry.key === "AI");
    assert.equal(item?.status, "DONE");
    assert.equal(item?.lastRunConfig?.verification, "VERIFIED_EFFECTIVE");
  });
});

// =====================================================================
// Round-4 review note — contradictory auth evidence resolves pessimistically
// =====================================================================

describe("TASK-006 round 4: contradictory billing evidence is not resolved optimistically", () => {
  it("treats apiKey auth as metered even when other fields claim a subscription", () => {
    const classification = interpretClaudeAuthStatus(
      JSON.stringify({
        loggedIn: true,
        authMethod: "apiKey",
        apiProvider: "firstParty",
        subscriptionType: "max",
      }),
    );
    assert.equal(classification.state, "AVAILABLE");
    assert.equal(classification.billingMode, "USAGE_BILLED");
  });

  it("still reads the genuine measured payload as an included subscription", () => {
    const classification = interpretClaudeAuthStatus(
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        subscriptionType: "max",
      }),
    );
    assert.equal(classification.billingMode, "INCLUDED_SUBSCRIPTION");
  });
});

// =====================================================================
// Round-4 review note — a read command leaves nothing behind
// =====================================================================

describe("TASK-006 round 4: scheduled wake is cleared when nothing is pending", () => {
  it("does not advertise a stale wake time after resources recover", async () => {
    const probe = scriptedProbe();
    for (const entry of TEST_CATALOG) {
      probe.set(entry.provider, entry.model, { state: "USAGE_LIMIT_REACHED", reason: "quota exhausted" });
    }
    const supervisor = newSupervisor({ probe });
    await seedRoadmap(supervisor, ONE_AI_ITEM);

    await supervisor.service.tick();
    const waiting = await supervisor.repository.load();
    assert.ok(waiting?.nextWakeAt !== undefined, "a wake was scheduled while waiting");

    // Everything recovers; advance past the backoff so the retry is due.
    for (const entry of TEST_CATALOG) {
      probe.set(entry.provider, entry.model, {
        state: "AVAILABLE",
        reason: "recovered",
        billingMode: "INCLUDED_SUBSCRIPTION",
      });
    }
    supervisor.clock.advance(60 * 60 * 1000);
    await supervisor.service.tick();

    const recovered = await supervisor.repository.load();
    assert.equal(recovered?.nextWakeAt, undefined, "a stale wake time was left behind");
  });
});
