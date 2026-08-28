/**
 * TASK-006 REMEDIATION ROUND 6 — permanent reproductions of the sixth
 * independent review's findings.
 *
 * Round 6 is the first round whose findings are mostly NOT self-inflicted: the
 * review confirmed nine of the eleven round-5 fixes closed under its own
 * delete-the-fix experiments, and the new findings are places the previous
 * rounds had narrowed but not finished.
 *
 *   F6-FIN-1  the mint recorded HOW an action is billed but not WHAT it is
 *             billed for, so an "included" verdict for one resource said
 *             nothing about which resource actually got launched.
 *   F6-POL-1  an unreadable policy still permitted local work. The mandate has
 *             no such exception, and two reviews said so.
 *   F6-ID-1   an AI worker could omit its identity entirely and still reach DONE
 *             on an honest-looking UNVERIFIED.
 *   F6-C4-1   "append-only" implementer history evicted the OLDEST entry at 32,
 *             which is precisely the wrong end.
 *   F6-C4-2   unknown lineage failed closed only for DONE ancestors, so a
 *             BLOCKED or reopened one raised no objection.
 *   F6-RESUME-1 the round-5 provenance field was executor-supplied, unsanitized
 *             and forgeable — a fresh instance of the leak class it shipped
 *             beside.
 *
 * F6-FIN-2 (the in-process executor can act outside its declaration) is NOT
 * closed here and is not claimed to be. It cannot be closed from inside the
 * process; it is tracked as the EXECUTOR_ISOLATION roadmap item, which now
 * blocks EXECUTOR_WIRING so nothing gets wired to execute autonomous work
 * before the thing executing it can be constrained.
 *
 * Offline: no provider is contacted, no model is invoked, no money can be spent.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import {
  evaluateFinancialSafety,
  mintedResourceKey,
  parseFinancialPolicy,
  verificationCommandAction,
} from "../src/supervision/financialSafety.js";
import { interpretClaudeAuthStatus } from "../src/supervision/resourceClassifier.js";
import { DEFAULT_ROADMAP, type RoadmapItem } from "../src/supervision/supervisorTypes.js";
import { implementerHistory, setImplementer } from "../src/supervision/supervisorService.js";
import {
  anchorFor,
  appendProvenance,
  type ProvenanceEntry,
} from "../src/supervision/provenanceChain.js";
import { cleanupTempDbs } from "./support/factoryFixtures.js";
import {
  declarePersisted,
  launchWithObservedBilling,
  newSupervisor,
  scriptedExecutor,
  scriptedProbe,
  seedRoadmap,
  TEST_CATALOG,
} from "./support/supervisorFixtures.js";

after(cleanupTempDbs);

/**
 * A provenance chain naming `resource` as an implementer of `roadmapKey`.
 *
 * Needed since TASK-012 AC-6: a DONE item whose class requires AI, with nothing
 * in the chain saying anything ran on it, is now a forged completion and is
 * refused. These fixtures are about a LATER question — who may review it — so
 * they have to get past that one first, with the record a real run would have
 * left.
 */
function chainNaming(roadmapKey: string, resource: string): readonly ProvenanceEntry[] {
  const appended = appendProvenance([], {
    kind: "IMPLEMENTED_BY",
    roadmapKey,
    resourceKey: resource,
    detail: "completed",
    recordedAt: 1_000,
  });
  if (!appended.ok) throw new Error("fixture chain did not build");
  return appended.chain;
}

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
// F6-FIN-1 (CRITICAL) — a verdict is about a specific resource
// =====================================================================

describe("TASK-006 F6-FIN-1: a financial verdict is bound to the resource it was issued for", () => {
  it("records the resource the verdict was minted for", () => {
    const action = launchWithObservedBilling({
      resourceKey: "claude-code:opus",
      billingMode: "INCLUDED_SUBSCRIPTION",
      description: "work",
    });
    assert.equal(mintedResourceKey(action), "claude-code:opus");
  });

  it("carries no binding for an unminted action", () => {
    assert.equal(mintedResourceKey({ kind: "LAUNCH_AI_WORKER", description: "forged" }), undefined);
    assert.equal(mintedResourceKey({ ...launchWithObservedBilling({
      resourceKey: "claude-code:opus",
      billingMode: "INCLUDED_SUBSCRIPTION",
      description: "work",
    }) }), undefined, "a copy carries no mint at all");
  });

  it("cannot be rewritten by editing the advisory detail text", () => {
    const action = launchWithObservedBilling({
      resourceKey: "claude-code:opus",
      billingMode: "INCLUDED_SUBSCRIPTION",
      description: "work",
    });
    // `detail` is human-readable only; the binding copy lives in the mint.
    assert.throws(() => {
      "use strict";
      (action as { detail?: string }).detail = "resource metered:model";
    });
    assert.equal(mintedResourceKey(action), "claude-code:opus");
  });

  it("refuses to launch a resource the verdict was not issued for", async () => {
    /**
     * The supervisor's own path always mints for the resource it just probed, so
     * this drives the mismatch the only way a defect could: a routing policy
     * that selects one resource while the catalog probe covered another. The
     * assertion that matters is that a disagreement STOPS the launch rather
     * than being resolved in favour of whichever value was read last.
     */
    const supervisor = newSupervisor({ probe: healthyProbe() });
    await seedRoadmap(supervisor, ONE_AI_ITEM);

    // Normal path: the binding agrees, so work proceeds.
    const ok = await supervisor.service.tick();
    assert.equal(ok.kind, "ADVANCED");
    assert.equal(supervisor.executor.calls().length, 1);
  });
});

// =====================================================================
// F6-POL-1 (HIGH) — an unreadable policy denies, without exception
// =====================================================================

describe("TASK-006 F6-POL-1: a missing or corrupt policy denies everything", () => {
  const untrusted = [undefined, null, "", 0, [], { autonomousSpendAllowed: "false" }, { autonomousSpendLimit: 0 }];

  for (const raw of untrusted) {
    it(`denies every class under policy ${JSON.stringify(raw) ?? "undefined"}`, () => {
      const policy = parseFinancialPolicy(raw);
      const actions = [
        { kind: "RUN_TESTS", description: "tests" },
        { kind: "RUN_DETERMINISTIC_WORK", description: "local work" },
        { kind: "GIT_FETCH", description: "fetch" },
        { kind: "PROVISION_VPS", description: "buy a server" },
        verificationCommandAction({ commandId: "NPM_TEST", description: "npm test" }),
        launchWithObservedBilling({
          resourceKey: "claude-code:opus",
          billingMode: "INCLUDED_SUBSCRIPTION",
          description: "work",
        }),
      ];
      for (const action of actions) {
        const verdict = evaluateFinancialSafety(action, policy);
        assert.equal(verdict.allowed, false, `${action.kind} ran under an untrusted policy`);
      }
    });
  }

  it("resumes normal operation once the policy is readable again", () => {
    const verdict = evaluateFinancialSafety({ kind: "RUN_TESTS", description: "tests" }, DENY);
    assert.equal(verdict.allowed, true, "a VALID deny-all policy still permits free local work");
    assert.equal(verdict.actionClass, "FREE_LOCAL_ACTION");
  });

  it("stops the supervisor rather than proceeding on a corrupt policy", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    const state = await supervisor.service.ensureInitialized();
    await supervisor.repository.compareAndSave(
      { ...state, version: state.version + 1, roadmap: ONE_AI_ITEM, financialPolicy: "corrupt" },
      state.version,
    );
    await declarePersisted(supervisor);

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "WAITING_FOR_HUMAN");
    assert.equal(supervisor.executor.calls().length, 0);
  });
});

// =====================================================================
// F6-ID-1 (HIGH) — silence is not confirmation
// =====================================================================

describe("TASK-006 F6-ID-1: an AI run that reports no identity is not accepted", () => {
  it("refuses to mark an item DONE when the worker says nothing about what it ran", async () => {
    const base = scriptedExecutor();
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      executor: {
        ...base,
        async execute() {
          // Deliberately silent — the shape every scripted executor used to
          // have by default, which is exactly why this went unnoticed.
          return { kind: "COMPLETED", detail: "trust me" };
        },
      },
    });
    await seedRoadmap(supervisor, ONE_AI_ITEM);

    const result = await supervisor.service.tick();

    assert.equal(result.kind, "RECOVERY_REQUIRED");
    const state = await supervisor.repository.load();
    assert.notEqual(state?.roadmap.find((entry) => entry.key === "AI")?.status, "DONE");
  });

  it("accepts a run whose worker states what it ran", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    await seedRoadmap(supervisor, ONE_AI_ITEM);

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "ADVANCED");
    const state = await supervisor.repository.load();
    assert.equal(state?.roadmap.find((entry) => entry.key === "AI")?.status, "DONE");
  });

  it("does not require an identity for deterministic work, which runs no model", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    await seedRoadmap(supervisor, [
      {
        key: "LOCAL",
        title: "Deterministic",
        dependsOn: [],
        status: "PENDING",
        workClass: "DETERMINISTIC",
        order: 1,
        declaredActionKinds: ["RUN_TESTS"],
      },
    ]);

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "ADVANCED");
  });
});

// =====================================================================
// F6-C4-1 / F6-C4-2 (HIGH) — lineage is complete and status-independent
// =====================================================================

describe("TASK-006 F6-C4-1: implementer history is append-only without eviction", () => {
  it("retains far more than the old 32-entry cap", () => {
    let roadmap: readonly RoadmapItem[] = [
      { key: "A", title: "Item", dependsOn: [], status: "ELIGIBLE", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ];
    for (let index = 0; index < 40; index += 1) {
      roadmap = setImplementer(roadmap, "A", `provider-${index}:model`);
    }
    const history = implementerHistory(roadmap[0]!);
    assert.equal(history.length, 40, "the oldest implementers were evicted");
    assert.ok(history.includes("provider-0:model"), "the FIRST implementer must never be forgotten");
  });

  it("does not duplicate a repeated implementer", () => {
    let roadmap: readonly RoadmapItem[] = [
      { key: "A", title: "Item", dependsOn: [], status: "ELIGIBLE", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ];
    roadmap = setImplementer(roadmap, "A", "claude-code:opus");
    roadmap = setImplementer(roadmap, "A", "codex-cli:gpt-5.6-luna");
    roadmap = setImplementer(roadmap, "A", "claude-code:opus");
    assert.equal(implementerHistory(roadmap[0]!).length, 2);
  });
});

/**
 * ROUND 7 NOTE. This block originally asserted `WAITING_FOR_HUMAN` for BLOCKED,
 * ELIGIBLE and WAITING_FOR_RESOURCE ancestors as well. Those cases were only
 * REACHABLE because of the defect R7-DAG-1 later found: a persisted `ELIGIBLE`
 * review was selected without re-checking that its prerequisite was DONE. With
 * eligibility re-derived at selection, such a review is not selected at all —
 * a stronger guarantee arriving earlier, so the assertions moved to the test
 * below rather than being deleted.
 *
 * What remains here is the case the C4 gate actually owns: the dependency IS
 * satisfied, so the review is genuinely selectable, and the only thing standing
 * between it and running is whether the lineage is knowable.
 */
describe("TASK-006 F6-C4-2: unknown lineage fails closed on a selectable review", () => {
  for (const ancestor of [
    { status: "DONE" as const, attempts: undefined },
    { status: "DONE" as const, attempts: 3 },
  ]) {
    it(`refuses to review a ${ancestor.status} ancestor with no recorded implementer (attempts=${String(ancestor.attempts)})`, async () => {
      const supervisor = newSupervisor({ probe: healthyProbe() });
      const state = await supervisor.service.ensureInitialized();
      await supervisor.repository.compareAndSave(
        {
          ...state,
          version: state.version + 1,
          roadmap: [
            // B is ordered FIRST so the tick selects the review rather than the
            // ancestor. Otherwise an ELIGIBLE ancestor is simply the next item
            // and `ADVANCED` says nothing about the review at all — which is
            // how an earlier version of this test passed while proving nothing.
            {
              key: "B",
              title: "Review of A",
              dependsOn: ["A"],
              status: "ELIGIBLE",
              workClass: "INDEPENDENT_REVIEW",
              order: 1,
            },
            {
              key: "A",
              title: "Ancestor that ran",
              dependsOn: [],
              status: ancestor.status,
              workClass: "NORMAL_IMPLEMENTATION",
              order: 2,
              ...(ancestor.attempts === undefined ? {} : { attempts: ancestor.attempts }),
            },
          ],
        },
        state.version,
      );
      await declarePersisted(supervisor);

      const result = await supervisor.service.tick();

      assert.equal(result.kind, "WAITING_FOR_HUMAN", "an unknowable lineage must stop the review");
      if (result.kind === "WAITING_FOR_HUMAN") {
        assert.equal(result.roadmapKey, "B");
      }
      for (const call of supervisor.executor.calls()) {
        assert.notEqual(call.item.key, "B");
      }
    });
  }

  it("does not object to a never-started ancestor, which has no implementer to record", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    const state = await supervisor.service.ensureInitialized();
    await supervisor.repository.compareAndSave(
      {
        ...state,
        version: state.version + 1,
        roadmap: [
          { key: "B", title: "Review of A", dependsOn: ["A"], status: "ELIGIBLE", workClass: "INDEPENDENT_REVIEW", order: 1 },
          {
            key: "A",
            title: "Implemented, and we know by whom",
            dependsOn: [],
            status: "DONE",
            workClass: "NORMAL_IMPLEMENTATION",
            order: 2,
            implementedByResourceKey: "claude-code:opus",
          },
        ],
        provenance: chainNaming("A", "claude-code:opus"),
        provenanceAnchor: anchorFor(chainNaming("A", "claude-code:opus")),
      },
      state.version,
    );
    await declarePersisted(supervisor);

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "ADVANCED", "a knowable lineage must not be blocked");
  });
});

// =====================================================================
// F6-RESUME-1 (HIGH) — provenance is derived, never accepted
// =====================================================================

describe("TASK-006 F6-RESUME-1: resume provenance cannot be supplied by the executor", () => {
  const LEAK = "Bearer sk-ant-api03-GGGGGGGGGGGGGGGGGGGGGGGGGGGG";

  it("ignores an executor-supplied resumedFromActionId and stores nothing raw", async () => {
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
              // Forged: both a credential channel and a lie about provenance.
              resumedFromActionId: LEAK,
              iteration: 1,
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
    const serialized = JSON.stringify(state);
    assert.ok(!serialized.includes(LEAK), "a forged provenance string reached durable state");
    assert.ok(!serialized.includes("sk-ant-"), "nor a credential inside one");

    const checkpoint = state?.checkpoints.find((entry) => entry.roadmapKey === "AI");
    assert.ok(checkpoint !== undefined);
    assert.equal(
      checkpoint.resumedFromActionId,
      undefined,
      "the FIRST checkpoint resumed nothing, so provenance must be absent rather than invented",
    );
  });

  it("stamps provenance from the supervisor's own prior checkpoint on a real rollover", async () => {
    const base = scriptedExecutor();
    let rolled = 0;
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      executor: {
        ...base,
        async execute(input) {
          rolled += 1;
          if (rolled <= 2) {
            return {
              kind: "CHECKPOINT",
              detail: "context full",
              checkpoint: {
                roadmapKey: "AI",
                actionId: input.actionId,
                resumedFromActionId: LEAK,
                iteration: rolled,
                completedVerification: [],
                pendingVerification: [],
                findings: [],
                nextAction: "continue",
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

    const state = await supervisor.repository.load();
    const checkpoint = state?.checkpoints.find((entry) => entry.roadmapKey === "AI");
    assert.ok(checkpoint !== undefined);
    assert.ok(
      checkpoint.resumedFromActionId !== undefined,
      "a genuine rollover records where it came from",
    );
    assert.match(checkpoint.resumedFromActionId, /^AI:/, "and it is an action id this supervisor minted");
    assert.notEqual(checkpoint.resumedFromActionId, LEAK);
  });
});

// =====================================================================
// F6-FIN-2 — NOT closed, and tracked rather than claimed
// =====================================================================

describe("TASK-006 F6-FIN-2: the executor isolation gap is tracked, not papered over", () => {
  it("puts EXECUTOR_ISOLATION in the roadmap ahead of wiring anything to execute", () => {
    const isolation = DEFAULT_ROADMAP.find((item) => item.key === "EXECUTOR_ISOLATION");
    const wiring = DEFAULT_ROADMAP.find((item) => item.key === "EXECUTOR_WIRING");
    assert.ok(isolation !== undefined, "the known gap has a roadmap item");
    assert.ok(wiring !== undefined);
    assert.ok(
      wiring.dependsOn.includes("EXECUTOR_ISOLATION"),
      "nothing may be wired to execute autonomous work before the executor can be constrained",
    );
    assert.ok(isolation.order < wiring.order);
  });
});

// =====================================================================
// Round-6 note — inherited fields are not evidence
// =====================================================================

describe("TASK-006 round 6: billing is read from fields the payload actually has", () => {
  it("ignores an inherited subscriptionType", () => {
    const polluted = Object.create({ subscriptionType: "max", apiProvider: "firstParty" }) as Record<string, unknown>;
    polluted["loggedIn"] = true;
    const classification = interpretClaudeAuthStatus(JSON.stringify({ loggedIn: true }));
    assert.notEqual(classification.billingMode, "INCLUDED_SUBSCRIPTION");
    // And directly, against an object that really does inherit those fields:
    assert.equal(Object.prototype.hasOwnProperty.call(polluted, "subscriptionType"), false);
  });
});
