/**
 * TASK-006 REMEDIATION ROUND 3 — permanent reproductions of the third
 * independent review's findings.
 *
 * (Rounds 1 and 2 — the F-* and N-* findings — live together in
 * `task006RemediationRound1Repro.test.ts`.)
 *
 * Round 3 is the same lesson arriving from four directions at once:
 *
 *   NEW-FIN-1  billing mode was DECLARED in configuration, so declaring a
 *              pay-as-you-go resource "included" made spending look free.
 *   NEW-FIN-2  the action-effects registry was a mutable object, so anything
 *              running in-process could rewrite what "destructive" means.
 *   NEW-SEC-1  a checkpoint's text comes from an EXECUTOR, and it was written
 *              to durable state unbounded and unredacted.
 *   NEW-MODEL-1 any model string at all was accepted and recorded as merely
 *              UNVERIFIED, so a typo or an injected identifier reached argv.
 *
 * Each is the recurring theme again: A SAFETY PROPERTY THAT DEPENDS ON DATA THE
 * SYSTEM ITSELF CAN WRITE IS NOT A SAFETY PROPERTY. Configuration, an
 * in-process object graph, executor output and a caller-supplied string are all
 * "data the system can write". The answers are, in order: derive it from an
 * observation, freeze it, sanitize it at the boundary, and allowlist it.
 *
 * Offline: no provider is contacted, no model is invoked, no money can be
 * spent, nothing is published.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createSqliteSupervisorRepository } from "../src/adapters/supervision/sqliteSupervisorRepository.js";
import {
  BILLING_MODES,
  evaluateFinancialSafety,
  KNOWN_ACTION_EFFECTS,
  parseFinancialPolicy,
  verificationCommandAction,
} from "../src/supervision/financialSafety.js";
import { planAiRunConfig, SUPPORTED_MODELS } from "../src/supervision/modelEnforcement.js";
import { interpretClaudeAuthStatus, interpretCodexDoctorJson } from "../src/supervision/resourceClassifier.js";
import type { RoadmapItem, SessionCheckpoint } from "../src/supervision/supervisorTypes.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import {
  launchWithObservedBilling,
  newSupervisor,
  scriptedExecutor,
  scriptedProbe,
  seedRoadmap,
  TEST_CATALOG,
} from "./support/supervisorFixtures.js";

after(cleanupTempDbs);

const ONE_ITEM: readonly RoadmapItem[] = [
  { key: "AI", title: "Needs a model", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
];

/** Every catalogued resource healthy, reporting the given billing mode (or none). */
function probeReporting(billingMode?: (typeof BILLING_MODES)[number]): ReturnType<typeof scriptedProbe> {
  const probe = scriptedProbe();
  for (const entry of TEST_CATALOG) {
    probe.set(entry.provider, entry.model, {
      state: "AVAILABLE",
      reason: "scripted",
      ...(billingMode === undefined ? {} : { billingMode }),
    });
  }
  return probe;
}

// =====================================================================
// NEW-FIN-1 (CRITICAL) — billing mode is OBSERVED, never declared
// =====================================================================

describe("TASK-006 NEW-FIN-1: configuration cannot declare a metered resource free", () => {
  it("refuses when the catalog says included but the provider says usage-billed", async () => {
    // The exploit, exactly: the catalog is the most trusted-looking thing in
    // the wiring, and before the fix it decided. Now the provider decides.
    const supervisor = newSupervisor({
      probe: probeReporting("USAGE_BILLED"),
      resourceCatalog: TEST_CATALOG, // every entry declares INCLUDED_SUBSCRIPTION
    });
    await seedRoadmap(supervisor, ONE_ITEM);

    const result = await supervisor.service.tick();

    assert.equal(result.kind, "WAITING_FOR_HUMAN");
    if (result.kind === "WAITING_FOR_HUMAN") {
      assert.equal(result.reason, "FINANCIAL_ACTION_REQUIRED");
    }
    assert.equal(supervisor.executor.calls().length, 0, "a usage-billed model was never launched");
  });

  it("allows work only when the provider itself reports an included subscription", async () => {
    const supervisor = newSupervisor({ probe: probeReporting("INCLUDED_SUBSCRIPTION") });
    await seedRoadmap(supervisor, ONE_ITEM);

    const result = await supervisor.service.tick();

    assert.equal(result.kind, "ADVANCED");
    assert.equal(supervisor.executor.calls().length, 1);
  });

  it("refuses when the provider reports nothing about billing", async () => {
    const supervisor = newSupervisor({ probe: probeReporting(undefined) });
    await seedRoadmap(supervisor, ONE_ITEM);

    const result = await supervisor.service.tick();

    assert.equal(result.kind, "WAITING_FOR_HUMAN");
    assert.equal(supervisor.executor.calls().length, 0);
  });

  it("derives the observed mode from the REAL probe interpreters", () => {
    // The two zero-token commands this installation actually runs. Their
    // measured healthy output must be what produces INCLUDED_SUBSCRIPTION —
    // otherwise the gate above would refuse every real run.
    const codex = interpretCodexDoctorJson(
      JSON.stringify({
        checks: {
          "auth.credentials": {
            status: "ok",
            details: { "stored auth mode": "chatgpt", "stored API key": "false" },
          },
        },
      }),
    );
    assert.equal(codex.state, "AVAILABLE");
    assert.equal(codex.billingMode, "INCLUDED_SUBSCRIPTION");

    // Measured verbatim from `claude auth status` on this installation
    // (2.1.238), minus the account identifiers, which are not needed and do not
    // belong in a fixture (C6).
    const claude = interpretClaudeAuthStatus(
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        subscriptionType: "max",
      }),
    );
    assert.equal(claude.state, "AVAILABLE");
    assert.equal(claude.billingMode, "INCLUDED_SUBSCRIPTION");
  });

  it("stays UNKNOWN when a subscription is claimed without a first-party provider", () => {
    // Not pedantry: `subscriptionType` alone does not say WHO is billing. An
    // unrecognised combination is unknown, and unknown is financial.
    const claude = interpretClaudeAuthStatus(
      JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
    );
    assert.equal(claude.state, "AVAILABLE");
    assert.equal(claude.billingMode, "UNKNOWN");
  });

  it("reports API-key auth as usage-billed, because it is", () => {
    // An API key is metered. The same CLI, authenticated differently, is a
    // different financial proposition — and the probe must say so.
    const codex = interpretCodexDoctorJson(
      JSON.stringify({
        checks: {
          "auth.credentials": {
            status: "ok",
            details: { "stored auth mode": "apikey", "stored API key": "true" },
          },
        },
      }),
    );
    assert.equal(codex.billingMode, "USAGE_BILLED");

    const claude = interpretClaudeAuthStatus(
      JSON.stringify({ loggedIn: true, authMethod: "apiKey", apiProvider: "anthropic" }),
    );
    assert.equal(claude.billingMode, "USAGE_BILLED");
  });

  it("keeps the observed mode across a real close and reopen", async () => {
    // The regression that the restart test caught: `observedBillingMode` was
    // added to the domain type and not to the SQLite parser, so a supervisor
    // that had probed its providers forgot it the moment it restarted, and
    // every AI action after a restart silently became financial.
    const dbPath = tempDbPath("supervisor-billing-roundtrip");

    const first = createSqliteSupervisorRepository(dbPath);
    const a = newSupervisor({ repository: first, probe: probeReporting("INCLUDED_SUBSCRIPTION") });
    await seedRoadmap(a, ONE_ITEM);
    await a.service.tick();
    const beforeClose = await first.load();
    first.close();

    assert.ok(beforeClose !== undefined);
    assert.ok(
      beforeClose.resources.every((r) => r.observedBillingMode === "INCLUDED_SUBSCRIPTION"),
      "the first process observed the billing mode",
    );

    const second = createSqliteSupervisorRepository(dbPath);
    const reloaded = await second.load();
    second.close();

    assert.ok(reloaded !== undefined);
    assert.deepEqual(
      reloaded.resources.map((r) => r.observedBillingMode),
      beforeClose.resources.map((r) => r.observedBillingMode),
      "restart must not erase what the provider reported",
    );
  });
});

// =====================================================================
// NEW-FIN-2 (CRITICAL) — the effects registry is immutable
// =====================================================================

describe("TASK-006 NEW-FIN-2: the action-effects registry cannot be rewritten at runtime", () => {
  it("refuses to add a new action kind", () => {
    const registry = KNOWN_ACTION_EFFECTS as unknown as Record<string, unknown>;
    assert.throws(
      () => {
        "use strict";
        registry["BUY_EVERYTHING"] = { costKnownZero: true };
      },
      /extensible|read only|frozen/i,
    );
    assert.equal(KNOWN_ACTION_EFFECTS["BUY_EVERYTHING"], undefined);
  });

  it("refuses to redefine what an existing action kind costs", () => {
    const entry = KNOWN_ACTION_EFFECTS["PROVISION_VPS"];
    assert.ok(entry !== undefined, "the fixture kind must exist");
    assert.ok(Object.isFrozen(entry), "each entry is frozen, not just the outer object");
    assert.throws(
      () => {
        "use strict";
        (entry as unknown as Record<string, unknown>)["requiresPaymentMethod"] = false;
      },
      /read only|frozen/i,
    );
    assert.equal(entry.requiresPaymentMethod, true);
    assert.equal(entry.canIncurUsageCharges, true);
  });

  it("still refuses the action after an attempted rewrite", () => {
    // Even if a future engine made the write silently no-op instead of throw,
    // the OUTCOME is what matters.
    try {
      (KNOWN_ACTION_EFFECTS as unknown as Record<string, unknown>)["PROVISION_VPS"] = { costKnownZero: true };
    } catch {
      /* expected in strict mode */
    }
    const verdict = evaluateFinancialSafety(
      { kind: "PROVISION_VPS", description: "rent a server" },
      parseFinancialPolicy({ autonomousSpendAllowed: false, autonomousSpendLimit: 0 }),
    );
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.actionClass, "FINANCIAL_ACTION");
  });

  it("freezes every entry, not merely the ones this test names", () => {
    for (const [kind, effects] of Object.entries(KNOWN_ACTION_EFFECTS)) {
      assert.ok(Object.isFrozen(effects), `${kind} effects are not frozen`);
    }
    assert.ok(Object.isFrozen(KNOWN_ACTION_EFFECTS));
  });
});

// =====================================================================
// NEW-SEC-1 (HIGH) — executor-supplied checkpoint text is sanitized
// =====================================================================

describe("TASK-006 NEW-SEC-1: a checkpoint from an executor is redacted and bounded", () => {
  const LEAK = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  function poisoned(actionId: string): SessionCheckpoint {
    return {
      roadmapKey: "AI",
      actionId,
      iteration: 1,
      completedVerification: Array.from({ length: 5_000 }, (_, i) => `step ${i} token=${LEAK}`),
      pendingVerification: [`Bearer ${"A".repeat(40)}`],
      findings: [`api_key: ${LEAK}`],
      nextAction: `continue with ${LEAK}`,
      requiredWorkClass: "NORMAL_IMPLEMENTATION",
      branch: `feat/${LEAK}`,
      baseCommit: `abc ${LEAK}`,
      updatedAt: 0,
    };
  }

  /** An executor that always rolls the session over with a poisoned checkpoint. */
  function checkpointingSupervisor(
    checkpointFor: (actionId: string) => SessionCheckpoint,
  ): { supervisor: ReturnType<typeof newSupervisor>; lines: readonly string[] } {
    const base = scriptedExecutor();
    const lines: string[] = [];
    const supervisor = newSupervisor({
      probe: probeReporting("INCLUDED_SUBSCRIPTION"),
      executor: {
        ...base,
        async execute(input) {
          return {
            kind: "CHECKPOINT",
            checkpoint: checkpointFor(input.actionId),
            detail: `rolled over ${LEAK}`,
          };
        },
      },
      log: (line) => lines.push(line),
    });
    return { supervisor, lines };
  }

  it("never writes a credential a worker handed back into durable state or the log", async () => {
    const { supervisor, lines } = checkpointingSupervisor(poisoned);
    await seedRoadmap(supervisor, ONE_ITEM);
    await supervisor.service.tick();

    const state = await supervisor.repository.load();
    assert.ok(state !== undefined);
    const serialized = JSON.stringify(state);
    assert.ok(!serialized.includes(LEAK), "a credential reached durable supervisor state");
    assert.ok(!serialized.includes("sk-ant-"), "a credential prefix reached durable supervisor state");
    assert.ok(serialized.includes("[REDACTED]"), "the redaction actually fired");

    // N-3: a log is just durable state with a different filename.
    assert.ok(lines.length > 0, "the supervisor logged something to check");
    for (const line of lines) {
      assert.ok(!line.includes(LEAK), `a credential reached the log: ${line}`);
    }
  });

  it("bounds how much an executor can push into durable state", async () => {
    const { supervisor } = checkpointingSupervisor(poisoned);
    await seedRoadmap(supervisor, ONE_ITEM);
    await supervisor.service.tick();

    const state = await supervisor.repository.load();
    const checkpoint = state?.checkpoints.find((entry) => entry.roadmapKey === "AI");
    assert.ok(checkpoint !== undefined, "a checkpoint was stored");
    assert.ok(
      checkpoint.completedVerification.length <= 50,
      `5000 executor-supplied entries were stored as ${checkpoint.completedVerification.length}`,
    );
    for (const entry of checkpoint.completedVerification) {
      assert.ok(!entry.includes(LEAK));
    }
    assert.ok(!checkpoint.nextAction.includes(LEAK));
    assert.ok(!(checkpoint.branch ?? "").includes(LEAK));
    assert.ok(!(checkpoint.baseCommit ?? "").includes(LEAK));
  });

  it("keeps the supervisor's own identity fields intact while sanitizing text", async () => {
    // A hostile executor claiming a different action's identity.
    const { supervisor } = checkpointingSupervisor(() => ({
      ...poisoned("SOMETHING_ELSE:LAUNCH_AI_WORKER:a9"),
      roadmapKey: "AI",
    }));
    await seedRoadmap(supervisor, ONE_ITEM);
    await supervisor.service.tick();

    const state = await supervisor.repository.load();
    const checkpoint = state?.checkpoints.find((entry) => entry.roadmapKey === "AI");
    assert.ok(checkpoint !== undefined);
    // Whatever the executor claimed, the stored action identity is the one the
    // supervisor itself minted for this attempt.
    assert.match(checkpoint.actionId, /^AI:/);
  });
});

// =====================================================================
// NEW-MODEL-1 (HIGH) — an unrecognised model is refused, not launched
// =====================================================================

describe("TASK-006 NEW-MODEL-1: only allowlisted models reach argv", () => {
  const rejected = [
    "opus-4",
    "gpt-4o",
    "claude-3-5-sonnet",
    " opus",
    "opus ",
    "OPUS",
    "opus; rm -rf /",
    "$(whoami)",
    "--dangerously-skip-permissions",
  ];

  for (const model of rejected) {
    it(`refuses claude-code model ${JSON.stringify(model)}`, () => {
      const result = planAiRunConfig({ provider: "claude-code", model, role: "IMPLEMENTER" });
      assert.equal(result.ok, false);
      if (result.ok === false) {
        assert.match(result.reason, /not a supported/);
      }
    });
  }

  it("refuses a Claude model name on the Codex provider and vice versa", () => {
    const a = planAiRunConfig({ provider: "codex-cli", model: "opus", role: "REVIEWER" });
    const b = planAiRunConfig({ provider: "claude-code", model: "gpt-5.6-luna", role: "REVIEWER" });
    assert.equal(a.ok, false);
    assert.equal(b.ok, false);
  });

  it("accepts every allowlisted model, so the list is not vacuously safe", () => {
    for (const [provider, models] of Object.entries(SUPPORTED_MODELS)) {
      assert.ok(models.length > 0, `${provider} has no supported models`);
      for (const model of models) {
        const result = planAiRunConfig({
          provider: provider as "claude-code" | "codex-cli",
          model,
          role: "IMPLEMENTER",
        });
        assert.equal(result.ok, true, `${provider}/${model} should be launchable`);
        if (result.ok === true) {
          assert.ok(result.value.argvEvidence.includes(model), "the model reaches argv");
        }
      }
    }
  });

  it("never records an unsupported model as merely UNVERIFIED", () => {
    // The precise defect: `UNVERIFIED` is an honest label for "the provider did
    // not echo this back", and it was being used as a licence to launch
    // anything. There must be no result at all for an unknown model.
    const result = planAiRunConfig({ provider: "claude-code", model: "totally-made-up", role: "IMPLEMENTER" });
    assert.equal(result.ok, false);
  });

  it("is frozen, so nothing in-process can extend the allowlist", () => {
    assert.ok(Object.isFrozen(SUPPORTED_MODELS));
    for (const models of Object.values(SUPPORTED_MODELS)) {
      assert.ok(Object.isFrozen(models));
    }
    assert.throws(() => {
      "use strict";
      (SUPPORTED_MODELS as unknown as Record<string, unknown>)["evil-cli"] = ["anything"];
    });
  });
});

// =====================================================================
// Untrusted policy hardening — an unreadable policy denies everything
// =====================================================================

/**
 * ROUND 6 (F6-POL-1). This block originally asserted that purely LOCAL work
 * still ran under an unreadable policy, on the reasoning that refusing to run
 * the test suite because a policy row is corrupt is brittleness rather than
 * safety.
 *
 * Two consecutive independent reviews read that as not satisfying the mandate,
 * which states the rule without an exception: *"Missing/corrupt/unreadable
 * policy: DENY. Do not default to allow."* The argument for the exception was
 * not worthless, but it was an argument for a different rule than the one that
 * was given — so the exception is gone and the assertions are inverted.
 *
 * Diagnosis is unaffected in practice: a human at a terminal runs `npm test`
 * directly, and the read-only CLI commands never reach this gate. What stops is
 * AUTONOMOUS execution, which is what the rule is about.
 */
describe("TASK-006 round 3: an untrusted policy denies everything", () => {
  const untrusted = [undefined, null, "", 0, [], { autonomousSpendAllowed: "false" }, { autonomousSpendLimit: 0 }];

  for (const raw of untrusted) {
    it(`denies AI work under policy ${JSON.stringify(raw) ?? "undefined"}`, () => {
      const policy = parseFinancialPolicy(raw);
      const verdict = evaluateFinancialSafety(
        launchWithObservedBilling({
          resourceKey: "claude-code:opus",
          billingMode: "INCLUDED_SUBSCRIPTION",
          description: "work",
        }),
        policy,
      );
      assert.equal(verdict.allowed, false);
    });

    it(`denies even purely local work under policy ${JSON.stringify(raw) ?? "undefined"}`, () => {
      const verdict = evaluateFinancialSafety(
        { kind: "RUN_DETERMINISTIC_WORK", description: "run the deterministic executor" },
        parseFinancialPolicy(raw),
      );
      assert.equal(verdict.allowed, false, "an unreadable policy denies, without exception");
      if (!verdict.allowed) {
        assert.match(verdict.reason, /could not be trusted/);
      }
    });

    it(`denies a minted zero-cost command under policy ${JSON.stringify(raw) ?? "undefined"}`, () => {
      // Even the narrowest, most provably-free thing the Factory can do.
      const verdict = evaluateFinancialSafety(
        verificationCommandAction({ commandId: "NPM_TEST", description: "npm test" }),
        parseFinancialPolicy(raw),
      );
      assert.equal(verdict.allowed, false);
    });
  }
});
