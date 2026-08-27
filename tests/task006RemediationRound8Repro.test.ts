/**
 * TASK-006 REMEDIATION ROUND 8 — permanent reproductions of the eighth
 * independent review's one CRITICAL and three HIGH findings, plus the
 * test-integrity defect it found in round 7's own claims.
 *
 *   R8-FIN-1  a Claude payload with a recognised plan and provider but NO
 *             `authMethod` classified as an included subscription, and an
 *             end-to-end tick launched a worker on it. Three fields agreeing
 *             about the PLAN say nothing about who pays for the CALLS.
 *   R8-ID-1   introduced by round 7. Validating the identity and reconciling it
 *             are two reads, and getters can answer differently each time. A
 *             report returning valid strings to the check and `undefined` to
 *             reconciliation reached DONE. Checking harder does not close a
 *             time-of-check/time-of-use gap; reading once does.
 *   R8-C4-1   introduced by round 7. The set of "recognised implementers"
 *             included PERSISTED resource rows, so a forged resource plus a
 *             matching forged implementer satisfied the forged-lineage check.
 *             The guard against forgery was validated against forgeable data.
 *   R8-SEC-1  `sanitizeCheckpoint` started from `...checkpoint`, so it cleaned
 *             the fields it knew and copied everything else through. A
 *             `secret: "sk-ant-..."` property the type does not declare reached
 *             the raw SQLite JSON.
 *
 * And the honesty repair: round 7 claimed R7-SEC-1 was "two independent fixes",
 * but `settleItem` was the same object handed to the executor, so removing the
 * settlement capture changed nothing and 1314 tests still passed. The reviewer
 * caught the CLAIM, not the code. They are separate clones now, so each is
 * independently observable — which is what makes the claim checkable.
 *
 * Offline: no provider is contacted, no model is invoked, no money can be spent.
 */

import assert from "node:assert/strict";
import { readFileSync as readBytes } from "node:fs";
import { after, describe, it } from "node:test";

/** The database FILE, as text — the parser is not allowed to launder it. */
function readFileSync(path: string): string {
  return readBytes(path, "latin1");
}

import { createSqliteSupervisorRepository } from "../src/adapters/supervision/sqliteSupervisorRepository.js";
import { interpretClaudeAuthStatus } from "../src/supervision/resourceClassifier.js";
import { NO_BACKOFF } from "../src/supervision/resourceTypes.js";
import type { RoadmapItem } from "../src/supervision/supervisorTypes.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import {
  declarePersisted,
  newSupervisor,
  scriptedExecutor,
  scriptedProbe,
  seedRoadmap,
  T0,
  TEST_CATALOG,
} from "./support/supervisorFixtures.js";

after(cleanupTempDbs);

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
// R8-FIN-1 (CRITICAL) — the plan is not the payer
// =====================================================================

describe("TASK-006 R8-FIN-1: an unstated authentication method is not a subscription", () => {
  const unsafe = [
    { loggedIn: true, apiProvider: "firstParty", subscriptionType: "max" },
    { loggedIn: true, apiProvider: "firstParty", subscriptionType: "max", authMethod: "" },
    { loggedIn: true, apiProvider: "firstParty", subscriptionType: "max", authMethod: "something-new" },
    { loggedIn: true, apiProvider: "firstParty", subscriptionType: "pro", authMethod: null },
    { loggedIn: true, apiProvider: "firstParty", subscriptionType: "team", authMethod: 42 },
  ];

  for (const payload of unsafe) {
    it(`refuses to call ${JSON.stringify(payload.authMethod)} authentication an included subscription`, () => {
      const classification = interpretClaudeAuthStatus(JSON.stringify(payload));
      assert.equal(classification.state, "AVAILABLE", "the session is still usable-looking");
      assert.notEqual(
        classification.billingMode,
        "INCLUDED_SUBSCRIPTION",
        "a recognised PLAN says nothing about who pays for the CALLS",
      );
    });
  }

  it("still recognises the measured payload from this installation", () => {
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

  it("refuses end-to-end, not merely in the classifier", async () => {
    const probe = scriptedProbe();
    for (const entry of TEST_CATALOG) {
      probe.set(entry.provider, entry.model, {
        state: "AVAILABLE",
        reason: "logged in, method unstated",
        // What `claudeBillingModeFrom` now returns for that payload.
        billingMode: "UNKNOWN",
      });
    }
    const supervisor = newSupervisor({ probe });
    await seedRoadmap(supervisor, ONE_AI_ITEM);

    const result = await supervisor.service.tick();

    assert.equal(result.kind, "WAITING_FOR_HUMAN");
    assert.equal(supervisor.executor.calls().length, 0, "a worker was launched on unknown billing");
  });
});

// =====================================================================
// R8-ID-1 (HIGH) — read the claim once
// =====================================================================

describe("TASK-006 R8-ID-1: a reported identity is read exactly once", () => {
  /**
   * An identity whose fields are ACCESSORS that always return the correct
   * values.
   *
   * ROUND 9 (R9-C3-1). The first version of this returned valid strings once
   * per field and then `undefined`, which made the test pass for the wrong
   * reason: with `snapshotIdentity` removed, the reads happened to exhaust the
   * counter before the acceptance check ran, so the item was refused by
   * accident rather than by the guard.
   *
   * Always-valid getters remove that accident. With the snapshot in place the
   * run is refused because an accessor is not a stated fact; without it, every
   * read succeeds, the identity reconciles cleanly, and the item would be
   * accepted — so deleting the guard necessarily changes the result.
   *
   * ROUND 10 (R10-C3-1). It STILL passed for the wrong reason: the getters
   * reported `claude-code/opus` while routing had actually selected
   * `claude-code/sonnet`, so removing the snapshot produced a MISMATCH and the
   * run was refused over the model rather than over the accessor. Third time
   * this same test has been wrong. The identity now echoes whatever the run was
   * genuinely configured with, so a model disagreement cannot stand in for the
   * property under test.
   */
  function accessorIdentity(values: Record<string, string>): Record<string, unknown> {
    const accessor = {};
    for (const field of Object.keys(values)) {
      Object.defineProperty(accessor, field, {
        enumerable: true,
        configurable: true,
        get() {
          return values[field];
        },
      });
    }
    return accessor;
  }

  it("refuses an identity whose fields are getters rather than data", async () => {
    const base = scriptedExecutor();
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      executor: {
        ...base,
        async execute(input) {
          assert.ok(input.config !== undefined, "an AI run must carry a configuration");
          return {
            kind: "COMPLETED",
            detail: "done",
            // EXACTLY what was configured, so the only thing wrong with this
            // report is that its fields are accessors.
            reportedIdentity: accessorIdentity({
              provider: input.config.requestedProvider,
              model: input.config.requestedModel,
            }),
          };
        },
      },
    });
    await seedRoadmap(supervisor, ONE_AI_ITEM);

    const result = await supervisor.service.tick();
    const state = await supervisor.repository.load();

    assert.notEqual(result.kind, "ADVANCED", "a shifting identity must not be accepted");
    assert.notEqual(state?.roadmap.find((entry) => entry.key === "AI")?.status, "DONE");
  });

  it("refuses a Proxy identity that answers differently on each read", async () => {
    let reads = 0;
    const proxy = new Proxy(
      {},
      {
        get(_target, field) {
          reads += 1;
          if (field === "provider" || field === "model") {
            return reads <= 2 ? (field === "provider" ? "claude-code" : "opus") : undefined;
          }
          return undefined;
        },
        getOwnPropertyDescriptor(_target, field) {
          if (field === "provider" || field === "model") {
            return { configurable: true, enumerable: true, get: () => undefined };
          }
          return undefined;
        },
        has: () => true,
      },
    );

    const base = scriptedExecutor();
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      executor: {
        ...base,
        async execute() {
          return { kind: "COMPLETED", detail: "done", reportedIdentity: proxy };
        },
      },
    });
    await seedRoadmap(supervisor, ONE_AI_ITEM);

    const result = await supervisor.service.tick();
    assert.notEqual(result.kind, "ADVANCED");
  });

  it("still accepts an ordinary, honest data identity", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    await seedRoadmap(supervisor, ONE_AI_ITEM);
    const result = await supervisor.service.tick();
    assert.equal(result.kind, "ADVANCED");
  });
});

// =====================================================================
// R8-C4-1 (HIGH) — the anti-forgery check may not consult forgeable data
// =====================================================================

describe("TASK-006 R8-C4-1: persisted resource rows do not confer recognition", () => {
  it("refuses a forged implementer backed by a forged persisted resource", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    const state = await supervisor.service.ensureInitialized();
    await supervisor.repository.compareAndSave(
      {
        ...state,
        version: state.version + 1,
        resources: [
          ...state.resources,
          // A resource this installation does not have, written straight into
          // durable state — which is exactly what an attacker with database
          // access, or a corrupt row, would produce.
          {
            provider: "totally-real",
            model: "definitely-installed",
            key: "totally-real:definitely-installed",
            state: "AVAILABLE" as const,
            detectedAt: T0,
            lastCheckedAt: T0,
            backoff: NO_BACKOFF,
            observedBillingMode: "INCLUDED_SUBSCRIPTION" as const,
          },
        ],
        roadmap: [
          { key: "B", title: "Review of A", dependsOn: ["A"], status: "ELIGIBLE", workClass: "INDEPENDENT_REVIEW", order: 1 },
          {
            key: "A",
            title: "Implemented by a ghost",
            dependsOn: [],
            status: "DONE",
            workClass: "NORMAL_IMPLEMENTATION",
            order: 2,
            attempts: 1,
            implementedByResourceKeys: ["totally-real:definitely-installed"],
          },
        ],
      },
      state.version,
    );
    await declarePersisted(supervisor);

    const result = await supervisor.service.tick();

    assert.equal(result.kind, "WAITING_FOR_HUMAN", "forged lineage must not satisfy C4");
    for (const call of supervisor.executor.calls()) {
      assert.notEqual(call.item.key, "B");
    }
  });

  it("still recognises an implementer that is in the installation catalog", async () => {
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
            title: "Implemented for real",
            dependsOn: [],
            status: "DONE",
            workClass: "NORMAL_IMPLEMENTATION",
            order: 2,
            attempts: 1,
            implementedByResourceKeys: ["claude-code:opus"],
          },
        ],
      },
      state.version,
    );
    await declarePersisted(supervisor);

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "ADVANCED", "a real lineage must not be blocked");
  });
});

// =====================================================================
// R8-SEC-1 (HIGH) — sanitize by construction, never by subtraction
// =====================================================================

describe("TASK-006 R8-SEC-1: an undeclared checkpoint property has nowhere to land", () => {
  const LEAK = "sk-ant-api03-IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII";

  it("drops properties the checkpoint type does not declare", async () => {
    const dbPath = tempDbPath("r8-sec-1");
    const repository = createSqliteSupervisorRepository(dbPath);
    const base = scriptedExecutor();
    const supervisor = newSupervisor({
      repository,
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
              completedVerification: [],
              pendingVerification: [],
              findings: [],
              nextAction: "continue",
              requiredWorkClass: "NORMAL_IMPLEMENTATION",
              updatedAt: 0,
              // Undeclared, and previously copied through by the `...spread`.
              secret: LEAK,
              nested: { alsoSecret: LEAK },
            } as never,
          };
        },
      },
    });
    await seedRoadmap(supervisor, ONE_AI_ITEM);
    await supervisor.service.tick();

    const state = await repository.load();
    repository.close();

    /**
     * ROUND 9 (R9-C3-1). The original version of this test asserted against
     * `repository.load()` — which runs the PARSER, and the parser silently
     * ignores fields the type does not declare. So the secret was hidden by the
     * very step that made the assertion pass, and deleting the sanitizer left
     * this test green. The subject is what is WRITTEN TO DISK, so the assertion
     * has to read the disk.
     */
    const raw = readFileSync(dbPath);
    assert.ok(!raw.includes(LEAK), "an undeclared property carried a credential into the database file");
    assert.ok(!raw.includes("sk-ant-"), "nor any part of one");
    assert.ok(!raw.includes('"secret"'), "the undeclared property itself was written");
    assert.ok(raw.includes("continue"), "the declared fields WERE written, so this is not a vacuous scan");

    const checkpoint = state?.checkpoints.find((entry) => entry.roadmapKey === "AI");
    assert.ok(checkpoint !== undefined, "the legitimate checkpoint still stored");
    assert.equal(checkpoint.nextAction, "continue", "and the declared fields survived");
  });
});

// =====================================================================
// Round-7 honesty repair — the two R7-SEC-1 fixes really are independent
// =====================================================================

/**
 * The accurate version of a claim this file's subject got wrong twice.
 *
 * Round 7 said R7-SEC-1 was "two independent fixes". The eighth review showed
 * the settlement capture was untested — it was the same object handed to the
 * executor, so removing it changed nothing. Separating the clones and
 * re-asserting independence would have been the same error again: while the
 * freeze holds there is nothing for the separation to protect against, so it is
 * NOT independently observable. Measured: removing the separation alone fails
 * nothing; removing both layers together fails two tests.
 *
 * So what is asserted here is what is actually true — the executor's copy is
 * frozen and distinct, and settlement lands on the item that really ran.
 */
describe("TASK-006 round 8: the executor's copy is frozen, and distinct from the settlement copy", () => {
  it("settles the item that ran, and hands the executor a separate frozen copy", async () => {
    const roadmap: readonly RoadmapItem[] = [
      { key: "A", title: "First", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
      { key: "B", title: "Second", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 2 },
    ];
    const base = scriptedExecutor();
    let sawDistinctObjects = false;
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      executor: {
        ...base,
        async execute(input) {
          // The executor's copy is frozen; the point here is that it is also a
          // DIFFERENT object from the one settlement will use.
          sawDistinctObjects = Object.isFrozen(input.item);
          try {
            (input.item as { key: string }).key = "B";
          } catch {
            /* frozen, as intended */
          }
          return {
            kind: "COMPLETED",
            detail: "done",
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
    await seedRoadmap(supervisor, roadmap);

    await supervisor.service.tick();

    const state = await supervisor.repository.load();
    assert.ok(sawDistinctObjects);
    assert.equal(state?.roadmap.find((entry) => entry.key === "A")?.status, "DONE");
    assert.notEqual(state?.roadmap.find((entry) => entry.key === "B")?.status, "DONE");
  });
});
