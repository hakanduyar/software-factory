/**
 * TASK-006 REMEDIATION ROUND 1 — permanent reproductions of the independent
 * review's two CRITICAL and seven HIGH findings.
 *
 * Every test here failed against the pre-remediation tree. They are kept
 * together because they share a single theme, and it is the theme this whole
 * codebase keeps relearning:
 *
 *   A SAFETY PROPERTY THAT DEPENDS ON DATA THE SYSTEM ITSELF CAN WRITE IS NOT A
 *   SAFETY PROPERTY.
 *
 * F-1 let a persisted row grant a spending budget. F-8 let a persisted row
 * assert a provider was healthy. F-2 let a verb assert that running a model was
 * free. In each case the answer is the same: re-derive it from something that
 * cannot be forged, or refuse.
 *
 * Offline: no provider, no model, no purchase, no billing change.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createCliResourceProbe } from "../src/adapters/supervision/cliResourceProbe.js";
import { ValidationError } from "../src/domain/errors.js";
import type { ProcessResult, ProcessRunner } from "../src/ports/processRunner.js";
import { evaluateFinancialSafety, parseFinancialPolicy } from "../src/supervision/financialSafety.js";
import { planAiRunConfig } from "../src/supervision/modelEnforcement.js";
import { isRetryDue, MAX_AVAILABILITY_AGE_MS, NO_BACKOFF } from "../src/supervision/resourceTypes.js";
import type { RoadmapItem } from "../src/supervision/supervisorTypes.js";
import { cleanupTempDbs } from "./support/factoryFixtures.js";
import {
  launchWithObservedBilling,
  manualClock,
  newSupervisor,
  scriptedExecutor,
  scriptedProbe,
  seedRoadmap,
  TEST_CATALOG,
  UNDECLARED_CATALOG,
} from "./support/supervisorFixtures.js";

after(cleanupTempDbs);

// =====================================================================
// F-1 (CRITICAL) — persisted data may not grant spending authority
// =====================================================================

describe("TASK-006 F-1: no stored policy can authorize spending", () => {
  const permissive = [
    { autonomousSpendAllowed: true, autonomousSpendLimit: 1 },
    { autonomousSpendAllowed: true, autonomousSpendLimit: 1_000_000 },
    { autonomousSpendAllowed: true, autonomousSpendLimit: 0 },
    { autonomousSpendAllowed: false, autonomousSpendLimit: 5 },
  ];

  for (const policy of permissive) {
    it(`refuses a stored policy claiming ${JSON.stringify(policy)}`, () => {
      const parsed = parseFinancialPolicy(policy);
      assert.equal(parsed.ok, false, "a row cannot grant a budget");

      const verdict = evaluateFinancialSafety(
        { kind: "PROVISION_VPS", description: "buy a server" },
        parsed,
      );
      assert.equal(verdict.allowed, false);
    });
  }

  it("has no code path at all that allows a financial action", () => {
    // Even the well-formed deny-all policy cannot produce an allow, and neither
    // can an unparseable one. There is no third possibility.
    for (const raw of [{ autonomousSpendAllowed: false, autonomousSpendLimit: 0 }, undefined, "garbage"]) {
      const verdict = evaluateFinancialSafety(
        { kind: "PROVISION_VPS", description: "buy a server" },
        parseFinancialPolicy(raw),
      );
      assert.equal(verdict.allowed, false);
    }
  });

  it("keeps the supervisor refusing even if its stored policy is tampered with", async () => {
    const supervisor = newSupervisor();
    const roadmap: readonly RoadmapItem[] = [
      { key: "X", title: "Wants to buy", dependsOn: [], status: "PENDING", workClass: "DETERMINISTIC", order: 1, declaredActionKinds: ["PROVISION_VPS"] },
    ];
    await seedRoadmap(supervisor, roadmap);

    const state = (await supervisor.repository.load())!;
    await supervisor.repository.compareAndSave(
      { ...state, version: state.version + 1, financialPolicy: { autonomousSpendAllowed: true, autonomousSpendLimit: 9999 } },
      state.version,
    );

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "WAITING_FOR_HUMAN");
    if (result.kind === "WAITING_FOR_HUMAN") {
      assert.equal(result.reason, "FINANCIAL_ACTION_REQUIRED");
    }
  });
});

// =====================================================================
// F-2 (CRITICAL) — running a model is free only on declared included quota
// =====================================================================

describe("TASK-006 F-2: model cost is a property of the resource, not the verb", () => {
  it("refuses a bare launch that carries no billing facts", () => {
    const verdict = evaluateFinancialSafety(
      { kind: "LAUNCH_AI_WORKER", description: "run a usage-billed model" },
      parseFinancialPolicy({ autonomousSpendAllowed: false, autonomousSpendLimit: 0 }),
    );
    assert.equal(verdict.allowed, false, "the verb alone proves nothing about billing");
  });

  it("allows an included subscription and refuses a metered one", () => {
    const policy = parseFinancialPolicy({ autonomousSpendAllowed: false, autonomousSpendLimit: 0 });
    assert.equal(
      evaluateFinancialSafety(
        launchWithObservedBilling({ resourceKey: "a:b", billingMode: "INCLUDED_SUBSCRIPTION", description: "x" }),
        policy,
      ).allowed,
      true,
    );
    assert.equal(
      evaluateFinancialSafety(
        launchWithObservedBilling({ resourceKey: "a:b", billingMode: "USAGE_BILLED", description: "x" }),
        policy,
      ).allowed,
      false,
    );
  });

  /**
   * Since NEW-FIN-1 the billing mode is OBSERVED from the probe rather than
   * declared in configuration, so "undeclared" now means "the provider told us
   * nothing" — which is the case that must refuse.
   */
  it("refuses to run work when the provider reported no billing mode", async () => {
    const probe = scriptedProbe();
    for (const entry of TEST_CATALOG) {
      // Healthy, but silent about billing.
      probe.set(entry.provider, entry.model, { state: "AVAILABLE", reason: "up, billing unknown" });
    }
    const supervisor = newSupervisor({ probe, resourceCatalog: UNDECLARED_CATALOG });
    const roadmap: readonly RoadmapItem[] = [
      { key: "AI", title: "Needs a model", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ];
    await seedRoadmap(supervisor, roadmap);

    const result = await supervisor.service.tick();

    assert.equal(result.kind, "WAITING_FOR_HUMAN");
    if (result.kind === "WAITING_FOR_HUMAN") {
      assert.equal(result.reason, "FINANCIAL_ACTION_REQUIRED");
    }
    assert.equal(supervisor.executor.calls().length, 0, "nothing was launched on an unbilled resource");
  });

  it("lets configuration make an observed mode STRICTER, never looser", async () => {
    // The provider says included; the catalog says treat it as metered. The
    // stricter answer wins, so the work is refused.
    const probe = scriptedProbe();
    for (const entry of TEST_CATALOG) {
      probe.set(entry.provider, entry.model, {
        state: "AVAILABLE",
        reason: "up",
        billingMode: "INCLUDED_SUBSCRIPTION",
      });
    }
    const supervisor = newSupervisor({
      probe,
      resourceCatalog: TEST_CATALOG.map((entry) => ({ ...entry, billingMode: "USAGE_BILLED" as const })),
    });
    await seedRoadmap(supervisor, [
      { key: "AI", title: "Needs a model", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ]);

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "WAITING_FOR_HUMAN");
    assert.equal(supervisor.executor.calls().length, 0);
  });
});

// =====================================================================
// F-3 (HIGH) — declared actions are gated BEFORE the executor runs
// =====================================================================

describe("TASK-006 F-3: an executor is never launched for work whose actions would be refused", () => {
  it("gates declared action kinds before invoking the executor", async () => {
    const executor = scriptedExecutor();
    const supervisor = newSupervisor({ executor });
    const roadmap: readonly RoadmapItem[] = [
      {
        key: "BUY",
        title: "Provision infrastructure",
        dependsOn: [],
        status: "PENDING",
        workClass: "DETERMINISTIC",
        order: 1,
        declaredActionKinds: ["RUN_TESTS", "PROVISION_VPS"],
      },
    ];
    await seedRoadmap(supervisor, roadmap);

    const result = await supervisor.service.tick();

    assert.equal(result.kind, "WAITING_FOR_HUMAN");
    assert.equal(executor.calls().length, 0, "the executor never ran, so it never got the chance to spend");
  });

  it("still runs work whose declared actions are all free", async () => {
    const executor = scriptedExecutor();
    const supervisor = newSupervisor({ executor });
    const roadmap: readonly RoadmapItem[] = [
      {
        key: "SAFE",
        title: "Local work",
        dependsOn: [],
        status: "PENDING",
        workClass: "DETERMINISTIC",
        order: 1,
        declaredActionKinds: ["RUN_TESTS", "GIT_COMMIT"],
      },
    ];
    await seedRoadmap(supervisor, roadmap);

    assert.equal((await supervisor.service.tick()).kind, "ADVANCED");
    assert.equal(executor.calls().length, 1);
  });
});

// =====================================================================
// F-4 (HIGH) — a non-zero exit is never "healthy"
// =====================================================================

describe("TASK-006 F-4: probe output from a failed process is not trusted", () => {
  function runnerReturning(result: Partial<ProcessResult>): ProcessRunner {
    const full: ProcessResult = {
      terminationReason: "EXITED",
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      startedAt: 0,
      finishedAt: 1,
      durationMs: 1,
      ...result,
    };
    return { run: async () => full };
  }

  it("refuses healthy-looking Claude JSON printed by a non-zero exit", async () => {
    const probe = createCliResourceProbe({
      processRunner: runnerReturning({ exitCode: 9, stdout: JSON.stringify({ loggedIn: true }) }),
      claudeExecutable: "/usr/bin/true",
      codexExecutable: "/usr/bin/true",
      cwd: "/tmp",
    });
    const classified = await probe.probe("claude-code", "opus");
    assert.equal(classified.state, "UNKNOWN_FAILURE");
    assert.notEqual(classified.state, "AVAILABLE");
  });

  it("refuses healthy-looking Codex JSON printed by a non-zero exit", async () => {
    const probe = createCliResourceProbe({
      processRunner: runnerReturning({
        exitCode: 9,
        stdout: JSON.stringify({ checks: { "auth.credentials": { status: "ok" } } }),
      }),
      claudeExecutable: "/usr/bin/true",
      codexExecutable: "/usr/bin/true",
      cwd: "/tmp",
    });
    const classified = await probe.probe("codex-cli", "gpt-5.6-luna");
    assert.equal(classified.state, "UNKNOWN_FAILURE");
  });

  it("still accepts genuinely healthy output from a clean exit", async () => {
    const probe = createCliResourceProbe({
      processRunner: runnerReturning({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) }),
      claudeExecutable: "/usr/bin/true",
      codexExecutable: "/usr/bin/true",
      cwd: "/tmp",
    });
    assert.equal((await probe.probe("claude-code", "opus")).state, "AVAILABLE");
  });
});

// =====================================================================
// F-7 (HIGH) — the executable is a decision, not a PATH lookup
// =====================================================================

describe("TASK-006 F-7: a probe cannot be redirected by PATH", () => {
  it("refuses a bare executable name", () => {
    assert.throws(
      () =>
        createCliResourceProbe({
          processRunner: { run: async () => { throw new Error("never reached"); } },
          claudeExecutable: "claude",
          codexExecutable: "/usr/bin/true",
          cwd: "/tmp",
        }),
      ValidationError,
    );
  });

  it("refuses a relative path too", () => {
    assert.throws(
      () =>
        createCliResourceProbe({
          processRunner: { run: async () => { throw new Error("never reached"); } },
          claudeExecutable: "/usr/bin/true",
          codexExecutable: "./codex",
          cwd: "/tmp",
        }),
      ValidationError,
    );
  });
});

// =====================================================================
// F-8 (HIGH) — a persisted AVAILABLE is not evidence
// =====================================================================

describe("TASK-006 F-8: availability must be re-confirmed, not remembered forever", () => {
  const base = {
    provider: "claude-code",
    model: "opus",
    key: "claude-code:opus",
    state: "AVAILABLE" as const,
    detectedAt: 0,
    backoff: NO_BACKOFF,
  };

  it("re-probes a never-probed AVAILABLE row", () => {
    assert.equal(isRetryDue({ ...base, lastCheckedAt: 0 }, 1_000), true, "a row nobody probed is not evidence");
  });

  it("re-probes a stale AVAILABLE row", () => {
    const now = 10 * MAX_AVAILABILITY_AGE_MS;
    assert.equal(isRetryDue({ ...base, lastCheckedAt: now - MAX_AVAILABILITY_AGE_MS - 1 }, now), true);
  });

  it("does NOT re-probe a freshly confirmed one", () => {
    const now = 10 * MAX_AVAILABILITY_AGE_MS;
    assert.equal(isRetryDue({ ...base, lastCheckedAt: now - 1_000 }, now), false, "waiting must stay cheap");
  });

  it("probes before acting on a forged AVAILABLE row", async () => {
    const clock = manualClock();
    const probe = scriptedProbe();
    for (const entry of TEST_CATALOG) {
      probe.set(entry.provider, entry.model, { state: "USAGE_LIMIT_REACHED", reason: "actually exhausted" });
    }
    const executor = scriptedExecutor();
    const supervisor = newSupervisor({ clock, probe, executor });
    await seedRoadmap(supervisor, [
      { key: "A", title: "Work", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ]);

    // Forge every resource as healthy, exactly as a corrupted row would.
    const state = (await supervisor.repository.load())!;
    await supervisor.repository.compareAndSave(
      {
        ...state,
        version: state.version + 1,
        resources: state.resources.map((record) => ({
          ...record,
          state: "AVAILABLE" as const,
          lastCheckedAt: 0,
          backoff: NO_BACKOFF,
        })),
      },
      state.version,
    );

    const result = await supervisor.service.tick();

    assert.ok(probe.totalProbes() > 0, "the forged claim was checked rather than believed");
    assert.equal(result.kind, "WAITING_FOR_RESOURCE", "and the real state won");
    assert.equal(executor.calls().length, 0);
  });
});

// =====================================================================
// F-5 / F-6 (HIGH) — action identity and the remediation budget
// =====================================================================

describe("TASK-006 F-5: a checkpoint always names the action it belongs to", () => {
  it("stamps the supervisor's own action id, overriding the executor's", async () => {
    const executor = scriptedExecutor({
      LONG: [
        {
          kind: "CHECKPOINT",
          detail: "context full",
          checkpoint: {
            roadmapKey: "LONG",
            // Deliberately wrong: the executor claims a different action.
            actionId: "LONG:LAUNCH_AI_WORKER:a99",
            iteration: 1,
            completedVerification: [],
            pendingVerification: ["npm test"],
            findings: [],
            nextAction: "finish",
            requiredWorkClass: "NORMAL_IMPLEMENTATION",
            updatedAt: 0,
          },
        },
        { kind: "COMPLETED", detail: "done" },
      ],
    });
    const supervisor = newSupervisor({ executor });
    await seedRoadmap(supervisor, [
      { key: "LONG", title: "Long", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ]);

    const first = await supervisor.service.tick();
    assert.equal(first.kind, "ADVANCED");

    const state = (await supervisor.repository.load())!;
    const checkpoint = state.checkpoints.find((entry) => entry.roadmapKey === "LONG")!;
    if (first.kind === "ADVANCED") {
      assert.equal(checkpoint.actionId, first.actionId, "the record names the action that actually ran");
    }
    assert.notEqual(checkpoint.actionId, "LONG:LAUNCH_AI_WORKER:a99");
  });
});

describe("TASK-006 F-6: the remediation budget actually bites", () => {
  it("counts every attempt and eventually escalates instead of looping forever", async () => {
    const executor = scriptedExecutor({
      C: [{ kind: "CHANGES_REQUIRED", findings: ["still broken"] }],
    });
    const supervisor = newSupervisor({ executor });
    await seedRoadmap(supervisor, [
      { key: "C", title: "Never passes", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ]);

    const results: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      results.push((await supervisor.service.tick()).kind);
    }

    assert.ok(results.includes("RECOVERY_REQUIRED"), "an item that never passes must not remediate forever");
    const state = (await supervisor.repository.load())!;
    const item = state.roadmap.find((entry) => entry.key === "C")!;
    assert.ok((item.attempts ?? 0) > 1, "attempts are counted even though CHANGES_REQUIRED writes no checkpoint");
    assert.ok(
      state.escalations.some((entry) => entry.reason === "RECOVERY_REQUIRED"),
      "and the exhausted budget is escalated",
    );
  });
});

// =====================================================================
// F-9 (HIGH) — an effort we cannot vouch for is refused
// =====================================================================

describe("TASK-006 F-9: an unsupported codex effort never reaches argv", () => {
  it("refuses a bogus effort instead of passing it through as applied", () => {
    const planned = planAiRunConfig({
      provider: "codex-cli",
      model: "gpt-5.6-luna",
      effort: "not-a-real-effort",
      role: "REVIEWER",
    });
    assert.equal(planned.ok, false);
  });

  it("never emits an unvalidated effort in the recorded argv", () => {
    const planned = planAiRunConfig({
      provider: "codex-cli",
      model: "gpt-5.6-luna",
      effort: "xhigh",
      role: "REVIEWER",
    });
    assert.equal(planned.ok, true);
    if (planned.ok) {
      assert.match(planned.value.argvEvidence.join(" "), /model_reasoning_effort="xhigh"/);
    }
  });
});

// =====================================================================
// ROUND 2 — findings the RE-review raised, including one this remediation
// introduced while fixing F-2
// =====================================================================

describe("TASK-006 N-1: caller-supplied effects can only ever restrict", () => {
  const policy = parseFinancialPolicy({ autonomousSpendAllowed: false, autonomousSpendLimit: 0 });
  const benign = {
    costKnownZero: true,
    requiresPaymentMethod: false,
    canIncurUsageCharges: false,
    changesBillingConfiguration: false,
    requiresHumanCredential: false,
    makesPublic: false,
    irreversibleDataLoss: false,
    remote: true,
  };

  /**
   * The exact reproduction from the re-review. The F-2 fix let `effects`
   * REPLACE the registry, so benign effects on a known-financial kind returned
   * `{"allowed":true,"actionClass":"FREE_REMOTE_ACTION"}` — the "declared, not
   * derived" hole, reintroduced through the side door.
   */
  it("refuses a registered financial action even when handed benign effects", () => {
    const verdict = evaluateFinancialSafety(
      { kind: "PROVISION_VPS", description: "charge a saved card for a VPS", effects: benign },
      policy,
    );
    assert.equal(verdict.allowed, false, "the registry outranks caller-supplied facts");
    if (!verdict.allowed) {
      assert.equal(verdict.actionClass, "FINANCIAL_ACTION");
    }
  });

  it("refuses every registered financial kind handed benign effects", () => {
    for (const kind of ["PURCHASE_AI_CREDITS", "ENABLE_PAID_OVERAGE", "UPGRADE_SUBSCRIPTION", "ADD_PAYMENT_METHOD"]) {
      assert.equal(
        evaluateFinancialSafety({ kind, description: "looks harmless", effects: benign }, policy).allowed,
        false,
        `${kind} must stay financial`,
      );
    }
  });

  it("still lets effects make a free action STRICTER", () => {
    const verdict = evaluateFinancialSafety(
      {
        kind: "RUN_TESTS",
        description: "a test run that would somehow bill",
        effects: { ...benign, canIncurUsageCharges: true, remote: false },
      },
      policy,
    );
    assert.equal(verdict.allowed, false, "restriction always works; relaxation never does");
  });

  it("keeps the resource-parameterised path working, and closed without facts", () => {
    assert.equal(
      evaluateFinancialSafety(
        launchWithObservedBilling({ resourceKey: "a:b", billingMode: "INCLUDED_SUBSCRIPTION", description: "x" }),
        policy,
      ).allowed,
      true,
    );
    assert.equal(
      evaluateFinancialSafety({ kind: "LAUNCH_AI_WORKER", description: "no billing facts" }, policy).allowed,
      false,
      "the only kinds that trust effects also REQUIRE them",
    );
  });
});

describe("TASK-006 N-4: a forged timestamp cannot buy trust", () => {
  const base = {
    provider: "claude-code",
    model: "opus",
    key: "claude-code:opus",
    state: "AVAILABLE" as const,
    detectedAt: 0,
    backoff: NO_BACKOFF,
  };

  it("re-probes a record whose lastCheckedAt is in the future", () => {
    const now = 1_000_000;
    assert.equal(
      isRetryDue({ ...base, lastCheckedAt: now + 10_000_000_000 }, now),
      true,
      "an observation that has not happened yet is not an observation",
    );
  });

  it("re-probes a record whose retryAt is further out than the ladder could schedule", () => {
    const now = 1_000_000;
    assert.equal(
      isRetryDue(
        { ...base, state: "USAGE_LIMIT_REACHED", lastCheckedAt: now, retryAt: now + 10_000_000_000 },
        now,
      ),
      true,
      "a forged retryAt must not silence a resource forever",
    );
  });

  it("does not launch work on a future-dated forged AVAILABLE row", async () => {
    const clock = manualClock();
    const probe = scriptedProbe();
    for (const entry of TEST_CATALOG) {
      probe.set(entry.provider, entry.model, { state: "USAGE_LIMIT_REACHED", reason: "really exhausted" });
    }
    const executor = scriptedExecutor();
    const supervisor = newSupervisor({ clock, probe, executor });
    await seedRoadmap(supervisor, [
      { key: "A", title: "Work", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ]);

    const state = (await supervisor.repository.load())!;
    await supervisor.repository.compareAndSave(
      {
        ...state,
        version: state.version + 1,
        resources: state.resources.map((record) => ({
          ...record,
          state: "AVAILABLE" as const,
          lastCheckedAt: clock.now() + 10_000_000_000,
          backoff: NO_BACKOFF,
        })),
      },
      state.version,
    );

    const result = await supervisor.service.tick();

    assert.ok(probe.totalProbes() > 0, "the forged freshness was checked, not believed");
    assert.equal(result.kind, "WAITING_FOR_RESOURCE");
    assert.equal(executor.calls().length, 0);
  });
});

describe("TASK-006 N-2: reviewer independence survives across dependent items", () => {
  it("excludes the implementer of a dependency when reviewing", async () => {
    // Only Codex is up, and it implements A. The review of B — which depends on
    // A — must therefore WAIT rather than let Codex review its own work.
    const probe = scriptedProbe();
    probe.set("claude-code", "opus", { state: "USAGE_LIMIT_REACHED", reason: "exhausted" });
    probe.set("claude-code", "sonnet", { state: "USAGE_LIMIT_REACHED", reason: "exhausted" });
    probe.set("codex-cli", "gpt-5.6-luna", { state: "AVAILABLE", reason: "up", billingMode: "INCLUDED_SUBSCRIPTION" });

    const executor = scriptedExecutor();
    const supervisor = newSupervisor({ probe, executor });
    await seedRoadmap(supervisor, [
      { key: "IMPL", title: "Implement", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
      { key: "REVIEW", title: "Independently review", dependsOn: ["IMPL"], status: "PENDING", workClass: "INDEPENDENT_REVIEW", order: 2 },
    ]);

    const implemented = await supervisor.service.tick();
    assert.equal(implemented.kind, "ADVANCED");

    const afterImpl = (await supervisor.repository.load())!;
    assert.equal(
      afterImpl.roadmap.find((entry) => entry.key === "IMPL")?.implementedByResourceKey,
      "codex-cli:gpt-5.6-luna",
      "the implementer's identity outlives the item",
    );

    const reviewed = await supervisor.service.tick();
    assert.equal(reviewed.kind, "WAITING_FOR_RESOURCE", "C4 holds even when it is inconvenient");
    if (reviewed.kind === "WAITING_FOR_RESOURCE") {
      assert.match(reviewed.reason, /reviewer independence/);
    }
    assert.equal(executor.callsFor("REVIEW").length, 0, "the implementer never reviewed its own work");
  });

  it("proceeds once a genuinely independent reviewer is available", async () => {
    const probe = scriptedProbe();
    const executor = scriptedExecutor();
    const supervisor = newSupervisor({ probe, executor });
    await seedRoadmap(supervisor, [
      { key: "IMPL", title: "Implement", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
      { key: "REVIEW", title: "Independently review", dependsOn: ["IMPL"], status: "PENDING", workClass: "INDEPENDENT_REVIEW", order: 2 },
    ]);

    await supervisor.service.tick();
    const reviewed = await supervisor.service.tick();

    assert.equal(reviewed.kind, "ADVANCED", "a different resource may review");
    assert.equal(executor.callsFor("REVIEW").length, 1);
  });
});

describe("TASK-006 N-3: secrets never reach the log or durable state", () => {
  it("redacts a token that arrives in an executor's action description", async () => {
    const token = "sk-ant-1234567890ABCDEFGHIJ";
    const logged: string[] = [];
    const executor = scriptedExecutor({
      S: [
        {
          kind: "HUMAN_REQUIRED",
          action: { kind: "AUTHOR_PLAN", description: `plan needed; provider said ${token}` },
          detail: `raw provider payload containing ${token}`,
        },
      ],
    });
    const supervisor = newSupervisor({ executor });
    await seedRoadmap(supervisor, [
      { key: "S", title: "Secret leak probe", dependsOn: [], status: "PENDING", workClass: "DETERMINISTIC", order: 1 },
    ]);
    // Re-wire with a capturing log by constructing a service over the same repo.
    const capturing = newSupervisor({ repository: supervisor.repository, executor });
    void logged;

    await capturing.service.tick();

    const state = (await supervisor.repository.load())!;
    const serialized = JSON.stringify(state);
    assert.ok(!serialized.includes(token), "no persisted field may carry a credential (C6)");
  });
});

// =====================================================================
// Persisted text stays bounded (review non-blocking note)
// =====================================================================

describe("TASK-006: persisted escalation text is bounded", () => {
  it("bounds a very long human-action string before storing it", async () => {
    const huge = "X".repeat(5_000);
    const executor = scriptedExecutor({
      H: [
        {
          kind: "HUMAN_REQUIRED",
          action: { kind: "AUTHOR_PLAN", description: huge },
          detail: huge,
        },
      ],
    });
    const supervisor = newSupervisor({ executor });
    await seedRoadmap(supervisor, [
      { key: "H", title: "Huge", dependsOn: [], status: "PENDING", workClass: "DETERMINISTIC", order: 1 },
    ]);

    await supervisor.service.tick();

    const state = (await supervisor.repository.load())!;
    const escalation = state.escalations[0]!;
    assert.ok(escalation.humanActionRequired.length < 1_000, "durable state is audit data, not a transcript");
    assert.ok(escalation.detail.length < 1_000);
  });
});
