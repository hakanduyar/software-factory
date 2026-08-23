/**
 * TASK-006 REMEDIATION ROUND 5 — permanent reproductions of the fifth
 * independent review's four CRITICAL and seven HIGH findings.
 *
 * Two of the four CRITICALs were defects the ROUND-4 REMEDIATION INTRODUCED.
 * That is now the pattern rather than the exception — round 1's fix for F-2
 * produced N-1, round 3's fix for NEW-FIN-1 produced a serialization bug — and
 * it is worth stating plainly rather than burying, because the lesson is not
 * "try harder". It is that a fix which moves an invariant to a new place needs
 * the same adversarial attention the original place got, and the only reliable
 * way to get it is another reviewer.
 *
 *   F5-SEC-1  the mint bound effects to an object but not to the object's KIND,
 *             so `action.kind = "RUN_VERIFICATION_COMMAND"` on a legitimately
 *             minted worker action laundered "this model is on a subscription"
 *             into a verdict about a shell command.
 *   F5-FIN-1  the allowlist named EXECUTABLES, which cannot constrain what they
 *             do: `npm run charge`, `npx anything`, `node --import`, `sh -c`
 *             and `git push` all passed. `sh` on an allowlist is not a command,
 *             it is permission to run any command.
 *   F5-FIN-2  `subscriptionType: "free"` classified as an INCLUDED_SUBSCRIPTION,
 *             which is the exact case the mandate names.
 *   F5-FIN-3  deterministic work could decline to declare its actions and was
 *             therefore never asked about them.
 *   F5-ID-1   an effort-only report was ignored, and provider was not a
 *             dimension at all.
 *   F5-ID-2   provider-reported strings were persisted raw.
 *   F5-SEC-2  the pre-launch probe's reason reached the CLI unbounded.
 *   F5-C4-1   a missing implementer excluded nobody; a rerun erased history.
 *   F5-RESUME-1 the checkpoint's documented action-identity guarantee was not
 *             enforced and could not be, as written.
 *   F5-FIN-4  GIT_PUSH and remote probes were claimed free on no evidence.
 *
 * Offline: no provider is contacted, no model is invoked, no money can be spent.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import {
  evaluateFinancialSafety,
  parseFinancialPolicy,
  verificationCommandAction,
  zeroCostCommandArgv,
  ZERO_COST_COMMAND_IDS,
} from "../src/supervision/financialSafety.js";
import { reconcileReportedIdentity, type AiRunConfigRecord } from "../src/supervision/modelEnforcement.js";
import { interpretClaudeAuthStatus } from "../src/supervision/resourceClassifier.js";
import { implementerHistory, setImplementer } from "../src/supervision/supervisorService.js";
import type { RoadmapItem } from "../src/supervision/supervisorTypes.js";
import { cleanupTempDbs } from "./support/factoryFixtures.js";
import {
  launchWithObservedBilling,
  newSupervisor,
  scriptedExecutor,
  scriptedProbe,
  seedRoadmap,
  TEST_CATALOG,
} from "./support/supervisorFixtures.js";

after(cleanupTempDbs);

const DENY = parseFinancialPolicy({ autonomousSpendAllowed: false, autonomousSpendLimit: 0 });

const ONE_AI_ITEM: readonly RoadmapItem[] = [
  { key: "AI", title: "Needs a model", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
];

function healthyProbe() {
  const probe = scriptedProbe();
  for (const entry of TEST_CATALOG) {
    probe.set(entry.provider, entry.model, {
      state: "AVAILABLE",
      reason: "scripted",
      billingMode: "INCLUDED_SUBSCRIPTION",
    });
  }
  return probe;
}

// =====================================================================
// F5-SEC-1 (CRITICAL) — the mint is bound to the kind, not just the object
// =====================================================================

/**
 * HONESTY NOTE, from running the delete-the-fix experiment on this file's own
 * subject. The remediation added TWO mechanisms: the minted action is frozen,
 * and the mint records the kind it was minted for. Removing the kind check
 * alone changes nothing observable — because the freeze means the only way to
 * present a different kind is to COPY the action, and a copy is a different
 * object with no mint entry at all.
 *
 * So these tests prove the OUTCOME (a laundered mint is refused) rather than
 * which of the two mechanisms did the refusing. The kind binding is kept as
 * defence against a future refactor that drops the freeze — stated here rather
 * than dressed up as an independently verified control.
 */
describe("TASK-006 F5-SEC-1: a mint cannot be laundered into another kind", () => {
  it("refuses a minted worker action whose kind was changed", () => {
    const action = launchWithObservedBilling({
      resourceKey: "claude-code:opus",
      billingMode: "INCLUDED_SUBSCRIPTION",
      description: "included",
    });
    assert.equal(evaluateFinancialSafety(action, DENY).allowed, true, "the genuine action is free");

    // The exploit as reported. Freezing makes the assignment throw; the
    // kind-bound mint makes it fail even if a future path avoids the freeze.
    const mutated = { ...action, kind: "RUN_VERIFICATION_COMMAND" };
    const verdict = evaluateFinancialSafety(mutated, DENY);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.actionClass, "FINANCIAL_ACTION");
  });

  it("refuses the inverse laundering too", () => {
    const command = verificationCommandAction({ commandId: "NPM_TEST", description: "verify" });
    assert.equal(evaluateFinancialSafety(command, DENY).allowed, true);

    const mutated = { ...command, kind: "LAUNCH_AI_WORKER" };
    assert.equal(evaluateFinancialSafety(mutated, DENY).allowed, false);
  });

  it("throws rather than silently mutating, in strict mode", () => {
    const action = launchWithObservedBilling({
      resourceKey: "claude-code:opus",
      billingMode: "INCLUDED_SUBSCRIPTION",
      description: "included",
    });
    assert.throws(() => {
      "use strict";
      (action as { kind: string }).kind = "RUN_VERIFICATION_COMMAND";
    });
    assert.equal(action.kind, "LAUNCH_AI_WORKER");
  });
});

// =====================================================================
// F5-FIN-1 (CRITICAL) — whole commands, not executables
// =====================================================================

describe("TASK-006 F5-FIN-1: an executable allowlist cannot constrain what it runs", () => {
  /** Everything the fifth review got past the round-4 executable allowlist. */
  const escapes = [
    "npm run charge",
    "npx some-chargeable-package",
    "node --import /tmp/chargeable.mjs",
    'sh -c "curl https://billing.example/charge"',
    'bash -c "gcloud compute instances create paid-vm"',
    "git push origin main",
    "/tmp/attacker/node -e safe",
  ];

  for (const attempt of escapes) {
    it(`refuses ${JSON.stringify(attempt)}`, () => {
      const verdict = evaluateFinancialSafety(
        verificationCommandAction({ commandId: attempt, description: "verification" }),
        DENY,
      );
      assert.equal(verdict.allowed, false);
      assert.equal(verdict.actionClass, "FINANCIAL_ACTION");
    });
  }

  it("resolves each allowlisted identifier to a fixed argv the caller cannot choose", () => {
    for (const id of ZERO_COST_COMMAND_IDS) {
      const argv = zeroCostCommandArgv(id);
      assert.ok(argv !== undefined && argv.length > 0, `${id} resolves to an argv`);
      assert.ok(Object.isFrozen(argv), `${id} argv is frozen`);
    }
  });

  it("contains no shell, interpreter-eval or package runner", () => {
    // `sh` on an allowlist is not a command; it is permission to run any
    // command. Same for `node -e` and `npx <arbitrary package>`.
    for (const id of ZERO_COST_COMMAND_IDS) {
      const argv = zeroCostCommandArgv(id) ?? [];
      const head = argv[0] ?? "";
      assert.ok(!["sh", "bash", "zsh", "cmd", "powershell", "npx"].includes(head), `${id} runs ${head}`);
      assert.ok(!argv.includes("-e"), `${id} evaluates arbitrary code`);
      assert.ok(!argv.includes("--import"), `${id} imports arbitrary code`);
      assert.ok(!argv.includes("push"), `${id} performs a remote write`);
    }
  });

  it("cannot be extended at runtime", () => {
    assert.throws(() => {
      "use strict";
      (ZERO_COST_COMMAND_IDS as unknown as string[]).push("ANYTHING");
    });
  });
});

// =====================================================================
// F5-FIN-2 (CRITICAL) — a free tier is not an included subscription
// =====================================================================

describe("TASK-006 F5-FIN-2: 'free' is not evidence that something is free", () => {
  for (const subscriptionType of ["free", "trial", "unknown", "", "expired", "none"]) {
    it(`refuses to treat subscriptionType ${JSON.stringify(subscriptionType)} as included`, () => {
      const classification = interpretClaudeAuthStatus(
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          subscriptionType,
        }),
      );
      assert.notEqual(
        classification.billingMode,
        "INCLUDED_SUBSCRIPTION",
        "the mandate names this case: free tier does not automatically mean free",
      );
    });
  }

  it("still recognises the measured paid plan", () => {
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

  it("refuses an unbilled resource end to end, not merely in the classifier", async () => {
    const probe = scriptedProbe();
    for (const entry of TEST_CATALOG) {
      probe.set(entry.provider, entry.model, {
        state: "AVAILABLE",
        reason: "on the free tier",
        billingMode: "UNKNOWN",
      });
    }
    const supervisor = newSupervisor({ probe });
    await seedRoadmap(supervisor, ONE_AI_ITEM);

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "WAITING_FOR_HUMAN");
    assert.equal(supervisor.executor.calls().length, 0);
  });
});

// =====================================================================
// F5-FIN-3 (CRITICAL) — deterministic work must declare what it will do
// =====================================================================

describe("TASK-006 F5-FIN-3: work that declares nothing is not asked nothing", () => {
  it("refuses to launch deterministic work with no declared action kinds", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    await seedRoadmap(supervisor, [
      { key: "LOCAL", title: "Undeclared", dependsOn: [], status: "PENDING", workClass: "DETERMINISTIC", order: 1 },
    ]);

    const result = await supervisor.service.tick();

    assert.equal(result.kind, "WAITING_FOR_HUMAN");
    if (result.kind === "WAITING_FOR_HUMAN") {
      assert.match(result.humanActionRequired, /declaredActionKinds/);
    }
    assert.equal(supervisor.executor.calls().length, 0, "the executor was never launched");
  });

  it("runs deterministic work that declares free local actions", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    await seedRoadmap(supervisor, [
      {
        key: "LOCAL",
        title: "Declared",
        dependsOn: [],
        status: "PENDING",
        workClass: "DETERMINISTIC",
        order: 1,
        declaredActionKinds: ["RUN_TESTS", "RUN_BUILD"],
      },
    ]);

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "ADVANCED");
    assert.equal(supervisor.executor.calls().length, 1);
  });

  it("still refuses when a declared kind is financial", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    await seedRoadmap(supervisor, [
      {
        key: "LOCAL",
        title: "Declares a purchase",
        dependsOn: [],
        status: "PENDING",
        workClass: "DETERMINISTIC",
        order: 1,
        declaredActionKinds: ["RUN_TESTS", "PROVISION_VPS"],
      },
    ]);

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "WAITING_FOR_HUMAN");
    if (result.kind === "WAITING_FOR_HUMAN") {
      assert.equal(result.reason, "FINANCIAL_ACTION_REQUIRED");
    }
    assert.equal(supervisor.executor.calls().length, 0);
  });
});

// =====================================================================
// F5-ID-1 / F5-ID-2 (HIGH) — every dimension, and nothing raw
// =====================================================================

describe("TASK-006 F5-ID-1: every reported dimension is reconciled", () => {
  function record(overrides: Partial<AiRunConfigRecord> = {}): AiRunConfigRecord {
    return {
      requestedProvider: "claude-code",
      requestedModel: "opus",
      requestedEffort: "high",
      effectiveProvider: "claude-code",
      effectiveModel: "opus",
      effectiveEffort: "high",
      verification: "UNVERIFIED",
      argvEvidence: ["claude"],
      note: "",
      ...overrides,
    };
  }

  it("catches an effort-only contradiction", () => {
    // The exact repro: a run configured high, a worker reporting low, and no
    // model in the report at all. The old code returned early and said nothing.
    const result = reconcileReportedIdentity(record(), { effort: "low" });
    assert.equal(result.verification, "MISMATCH");
  });

  it("catches a provider swap even when the model matches", () => {
    const result = reconcileReportedIdentity(record(), { provider: "codex-cli", model: "opus", effort: "high" });
    assert.equal(result.verification, "MISMATCH");
    assert.match(result.note, /provider/);
  });

  it("refuses to mark an item DONE on an effort-only contradiction", async () => {
    const base = scriptedExecutor();
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      executor: {
        ...base,
        async execute() {
          return { kind: "COMPLETED", detail: "done", reportedIdentity: { effort: "low" } };
        },
      },
    });
    await seedRoadmap(supervisor, ONE_AI_ITEM);

    const result = await supervisor.service.tick();
    const state = await supervisor.repository.load();
    const item = state?.roadmap.find((entry) => entry.key === "AI");

    // Either the run was configured with an effort and this contradicts it, or
    // no effort was requested and reporting one is itself a divergence. Both are
    // MISMATCH, and neither may be accepted as DONE.
    assert.equal(result.kind, "RECOVERY_REQUIRED");
    assert.notEqual(item?.status, "DONE");
  });
});

describe("TASK-006 F5-ID-2: a provider-reported string never lands raw", () => {
  const LEAK = "sk-ant-api03-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

  it("redacts a credential smuggled through a reported model name", async () => {
    const base = scriptedExecutor();
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      executor: {
        ...base,
        async execute() {
          return { kind: "COMPLETED", detail: "done", reportedIdentity: { model: LEAK } };
        },
      },
    });
    await seedRoadmap(supervisor, ONE_AI_ITEM);
    await supervisor.service.tick();

    const state = await supervisor.repository.load();
    const serialized = JSON.stringify(state);
    assert.ok(!serialized.includes(LEAK), "a credential reached durable state through effectiveModel");
    assert.ok(!serialized.includes("sk-ant-"), "nor any part of one");
  });

  it("bounds an absurdly long reported identity", () => {
    const result = reconcileReportedIdentity(
      {
        requestedProvider: "claude-code",
        requestedModel: "opus",
        effectiveProvider: "claude-code",
        effectiveModel: "opus",
        verification: "UNVERIFIED",
        argvEvidence: [],
        note: "",
      },
      { model: "x".repeat(100_000) },
    );
    assert.ok(result.effectiveModel.length < 200, `effectiveModel was ${result.effectiveModel.length} chars`);
  });
});

// =====================================================================
// F5-SEC-2 (HIGH) — the tick result is sanitized like everything else
// =====================================================================

describe("TASK-006 F5-SEC-2: provider text never reaches the CLI unbounded", () => {
  const LEAK = "sk-ant-api03-FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";

  it("redacts a credential in a pre-launch probe failure reason", async () => {
    const probe = scriptedProbe();
    // Healthy for the whole scheduled refresh — one probe per catalogued
    // resource — and poisoned only for the extra PRE-LAUNCH confirmation the
    // F4-3 fix added. That ordering matters: an earlier version of this test
    // poisoned the refresh instead, so routing failed before the pre-launch path
    // ran at all and the test passed without ever exercising the leak.
    const refreshProbes = TEST_CATALOG.length;
    let calls = 0;
    const wrapped = {
      ...probe,
      async probe(provider: string, model: string) {
        void provider;
        void model;
        calls += 1;
        if (calls <= refreshProbes) {
          return { state: "AVAILABLE" as const, reason: "ok", billingMode: "INCLUDED_SUBSCRIPTION" as const };
        }
        return {
          state: "PROVIDER_UNAVAILABLE" as const,
          reason: `provider returned ${LEAK} and failed`,
        };
      },
    };
    const lines: string[] = [];
    const supervisor = newSupervisor({ probe: wrapped, log: (line) => lines.push(line) });
    await seedRoadmap(supervisor, ONE_AI_ITEM);

    const result = await supervisor.service.tick();

    assert.equal(result.kind, "WAITING_FOR_RESOURCE", "the pre-launch confirmation path must have run");
    const printed = JSON.stringify(result);
    assert.ok(!printed.includes(LEAK), `a credential reached the tick result: ${printed}`);
    for (const line of lines) {
      assert.ok(!line.includes(LEAK), `a credential reached the log: ${line}`);
    }
    const state = await supervisor.repository.load();
    assert.ok(!JSON.stringify(state).includes(LEAK), "nor durable state");
  });
});

// =====================================================================
// F5-C4-1 (HIGH) — unknown lineage fails closed; history is append-only
// =====================================================================

describe("TASK-006 F5-C4-1: reviewer independence fails closed on unknown lineage", () => {
  it("refuses to review a dependency whose implementer was never recorded", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    const state = await supervisor.service.ensureInitialized();
    await supervisor.repository.compareAndSave(
      {
        ...state,
        version: state.version + 1,
        roadmap: [
          // DONE AI work with NO implementer recorded — an older row, a rerun, a
          // hand edit. Absence of a record is not evidence there was nobody.
          { key: "A", title: "Ancestor", dependsOn: [], status: "DONE", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
          { key: "B", title: "Review of A", dependsOn: ["A"], status: "PENDING", workClass: "INDEPENDENT_REVIEW", order: 2 },
        ],
      },
      state.version,
    );

    const result = await supervisor.service.tick();

    assert.equal(result.kind, "WAITING_FOR_HUMAN");
    if (result.kind === "WAITING_FOR_HUMAN") {
      assert.match(result.humanActionRequired, /implemented/i);
    }
    assert.equal(supervisor.executor.calls().length, 0, "no review ran against an unknown implementer");
  });

  it("keeps every implementer, so a rerun does not erase the first one", () => {
    let roadmap: readonly RoadmapItem[] = [
      { key: "A", title: "Item", dependsOn: [], status: "ELIGIBLE", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ];
    roadmap = setImplementer(roadmap, "A", "claude-code:opus");
    roadmap = setImplementer(roadmap, "A", "codex-cli:gpt-5.6-luna");

    const item = roadmap[0]!;
    const history = implementerHistory(item);
    assert.ok(history.includes("claude-code:opus"), "the first implementer was erased by the rerun");
    assert.ok(history.includes("codex-cli:gpt-5.6-luna"));
    assert.equal(item.implementedByResourceKey, "codex-cli:gpt-5.6-luna", "the scalar is the most recent");
  });

  it("excludes a resource that implemented an earlier attempt of the reviewed item", async () => {
    const probe = scriptedProbe();
    probe.set("codex-cli", "gpt-5.6-luna", {
      state: "AVAILABLE",
      reason: "up",
      billingMode: "INCLUDED_SUBSCRIPTION",
    });
    for (const model of ["opus", "sonnet"]) {
      probe.set("claude-code", model, { state: "USAGE_LIMIT_REACHED", reason: "exhausted" });
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
            title: "Implemented twice",
            dependsOn: [],
            status: "DONE",
            workClass: "NORMAL_IMPLEMENTATION",
            order: 1,
            // Most recent is Claude, but Codex implemented an earlier attempt.
            implementedByResourceKey: "claude-code:opus",
            implementedByResourceKeys: ["claude-code:opus", "codex-cli:gpt-5.6-luna"],
          },
          { key: "B", title: "Review of A", dependsOn: ["A"], status: "PENDING", workClass: "INDEPENDENT_REVIEW", order: 2 },
        ],
      },
      state.version,
    );

    const result = await supervisor.service.tick();

    assert.notEqual(result.kind, "ADVANCED", "Codex implemented an earlier attempt and must not review it");
    for (const call of supervisor.executor.calls()) {
      assert.notEqual(call.item.key, "B");
    }
  });
});

// =====================================================================
// F5-RESUME-1 (HIGH) — the checkpoint says what is actually true
// =====================================================================

describe("TASK-006 F5-RESUME-1: a resumed checkpoint is rebound to the running action", () => {
  it("hands the executor a checkpoint carrying the CURRENT action id", async () => {
    const base = scriptedExecutor();
    const seen: { actionId: string; checkpointActionId?: string; resumedFrom?: string }[] = [];
    let rolled = false;
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      executor: {
        ...base,
        async execute(input) {
          seen.push({
            actionId: input.actionId,
            ...(input.checkpoint === undefined
              ? {}
              : {
                  checkpointActionId: input.checkpoint.actionId,
                  ...(input.checkpoint.resumedFromActionId === undefined
                    ? {}
                    : { resumedFrom: input.checkpoint.resumedFromActionId }),
                }),
          });
          if (!rolled) {
            rolled = true;
            return {
              kind: "CHECKPOINT",
              detail: "context full",
              checkpoint: {
                roadmapKey: "AI",
                actionId: input.actionId,
                iteration: 1,
                completedVerification: ["typecheck"],
                pendingVerification: ["npm test"],
                findings: [],
                nextAction: "finish verification",
                requiredWorkClass: "NORMAL_IMPLEMENTATION",
                updatedAt: 0,
              },
            };
          }
          return { kind: "COMPLETED", detail: "done" };
        },
      },
    });
    await seedRoadmap(supervisor, ONE_AI_ITEM);

    await supervisor.service.tick();
    await supervisor.service.tick();

    assert.equal(seen.length, 2, "the item was resumed");
    const resume = seen[1]!;
    assert.equal(
      resume.checkpointActionId,
      resume.actionId,
      "the checkpoint must name the action that is actually running",
    );
    assert.notEqual(resume.actionId, seen[0]!.actionId, "and it IS a new attempt");
    assert.equal(resume.resumedFrom, seen[0]!.actionId, "with the chain kept for audit");
  });
});

// =====================================================================
// F5-FIN-4 (HIGH) — no free claim without evidence
// =====================================================================

describe("TASK-006 F5-FIN-4: remote writes are not assumed free", () => {
  it("treats a push and a remote probe as financial", () => {
    for (const kind of ["GIT_PUSH", "PROBE_RESOURCE_REMOTE"]) {
      const verdict = evaluateFinancialSafety({ kind, description: "remote" }, DENY);
      assert.equal(verdict.allowed, false, `${kind} was claimed free without evidence`);
      assert.equal(verdict.actionClass, "FINANCIAL_ACTION");
    }
  });

  it("keeps a read-only fetch free", () => {
    const verdict = evaluateFinancialSafety({ kind: "GIT_FETCH", description: "fetch" }, DENY);
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.actionClass, "FREE_REMOTE_ACTION");
  });
});
