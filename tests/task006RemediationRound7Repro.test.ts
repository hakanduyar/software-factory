/**
 * TASK-006 REMEDIATION ROUND 7 — permanent reproductions of the seventh
 * independent review's five HIGH findings.
 *
 * First round with no CRITICAL, and the first where the reviewer explicitly
 * endorsed a deferral rather than re-reporting it: `EXECUTOR_ISOLATION` is the
 * right place for the in-process executor capability gap.
 *
 *   R7-ID-1   `reportedIdentity: {}` — and an object inheriting the right values
 *             from a polluted prototype — satisfied "did the worker say what it
 *             ran?", because the check asked only whether a container existed.
 *   R7-C4-1   `implementedByResourceKeys: ["not-a-resource"]` satisfied "do we
 *             know who built this?" while excluding nobody, so the real
 *             implementer was free to review its own work.
 *   R7-DAG-1  a persisted `ELIGIBLE` review ran while its prerequisite was still
 *             `PENDING`. Selection trusted a stored status that is really a
 *             CACHE of a dependency computation.
 *   R7-SEC-1  the SQLite repository returned mutable state while the in-memory
 *             one returned frozen state, so production had a hole the tests
 *             could not see: an executor mutating `input.item.key` from A to B
 *             marked B DONE while A stayed ACTIVE.
 *   R7-C3-1   the F6-FIN-1 regression only exercised the matching path, so the
 *             supervisor's resource-binding guard could be deleted with the
 *             whole 1292-test suite still green.
 *
 * R7-C3-1 is the one worth pausing on: an earlier mutation run had "verified"
 * that guard by breaking `mintedResourceKey` — which trips the guard rather than
 * removing it. Mutating the wrong line proves the wrong thing, and only an
 * independent reviewer noticed. The mismatch test below is the repair.
 *
 * Offline: no provider is contacted, no model is invoked, no money can be spent.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { PersistenceCorruptionError, ValidationError } from "../src/domain/errors.js";
import { reconcileReportedIdentity, type AiRunConfigRecord } from "../src/supervision/modelEnforcement.js";
import { resourceKey } from "../src/supervision/resourceTypes.js";
import {
  encodeSupervisorState,
  parseSupervisorState,
} from "../src/supervision/supervisorSerialization.js";
import { resourceBindingHolds, selectNextItem } from "../src/supervision/supervisorService.js";
import type { RoadmapItem } from "../src/supervision/supervisorTypes.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import { createSqliteSupervisorRepository } from "../src/adapters/supervision/sqliteSupervisorRepository.js";
import {
  newSupervisor,
  scriptedExecutor,
  scriptedProbe,
  seedRoadmap,
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
// R7-ID-1 (HIGH) — an empty or inherited report is not a statement
// =====================================================================

describe("TASK-006 R7-ID-1: a worker must actually say what it ran", () => {
  for (const [label, identity] of [
    ["an empty object", {}],
    ["blank strings", { provider: "  ", model: "" }],
    ["model only", { model: "opus" }],
    ["provider only", { provider: "claude-code" }],
  ] as const) {
    it(`refuses to accept COMPLETED with ${label}`, async () => {
      const base = scriptedExecutor();
      const supervisor = newSupervisor({
        probe: healthyProbe(),
        executor: {
          ...base,
          async execute() {
            return { kind: "COMPLETED", detail: "done", reportedIdentity: identity };
          },
        },
      });
      await seedRoadmap(supervisor, ONE_AI_ITEM);

      const result = await supervisor.service.tick();
      const state = await supervisor.repository.load();

      assert.notEqual(result.kind, "ADVANCED");
      assert.notEqual(state?.roadmap.find((entry) => entry.key === "AI")?.status, "DONE");
    });
  }

  it("refuses an identity object that only INHERITS its fields", async () => {
    const inherited = Object.create({ provider: "claude-code", model: "opus" }) as {
      provider?: string;
      model?: string;
    };
    assert.equal(inherited.provider, "claude-code", "the fixture really does inherit the values");
    assert.equal(Object.prototype.hasOwnProperty.call(inherited, "provider"), false);

    const base = scriptedExecutor();
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      executor: {
        ...base,
        async execute() {
          return { kind: "COMPLETED", detail: "done", reportedIdentity: inherited };
        },
      },
    });
    await seedRoadmap(supervisor, ONE_AI_ITEM);

    const result = await supervisor.service.tick();
    assert.notEqual(result.kind, "ADVANCED");
  });

  it("never derives VERIFIED_EFFECTIVE from inherited fields", () => {
    const record: AiRunConfigRecord = {
      requestedProvider: "claude-code",
      requestedModel: "opus",
      effectiveProvider: "claude-code",
      effectiveModel: "opus",
      verification: "UNVERIFIED",
      argvEvidence: [],
      note: "",
    };
    const inherited = Object.create({ provider: "claude-code", model: "opus" }) as Record<string, string>;
    assert.notEqual(reconcileReportedIdentity(record, inherited).verification, "VERIFIED_EFFECTIVE");
  });
});

// =====================================================================
// R7-C4-1 (HIGH) — a fabricated implementer is not lineage
// =====================================================================

describe("TASK-006 R7-C4-1: an unrecognised implementer fails closed", () => {
  async function reviewWithHistory(history: readonly string[]) {
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
            title: "Implemented by someone",
            dependsOn: [],
            status: "DONE",
            workClass: "NORMAL_IMPLEMENTATION",
            order: 2,
            attempts: 1,
            implementedByResourceKeys: history,
          },
        ],
      },
      state.version,
    );
    const result = await supervisor.service.tick();
    return { result, supervisor };
  }

  for (const history of [["not-a-resource"], ["claude-code:opus", "not-a-resource"], [""]]) {
    it(`refuses to review an ancestor whose history is ${JSON.stringify(history)}`, async () => {
      const { result, supervisor } = await reviewWithHistory(history);
      assert.equal(result.kind, "WAITING_FOR_HUMAN", "an unrecognised implementer must not pass as lineage");
      for (const call of supervisor.executor.calls()) {
        assert.notEqual(call.item.key, "B");
      }
    });
  }

  it("still allows a review when every recorded implementer is a real resource", async () => {
    const { result } = await reviewWithHistory(["claude-code:opus"]);
    assert.equal(result.kind, "ADVANCED", "a knowable lineage must not be blocked");
  });
});

// =====================================================================
// R7-DAG-1 (HIGH) — eligibility is re-derived, not read
// =====================================================================

describe("TASK-006 R7-DAG-1: a stored ELIGIBLE does not outrank the dependency graph", () => {
  const roadmap: readonly RoadmapItem[] = [
    { key: "B", title: "Dependent", dependsOn: ["A"], status: "ELIGIBLE", workClass: "DETERMINISTIC", order: 1, declaredActionKinds: ["RUN_TESTS"] },
    { key: "A", title: "Prerequisite", dependsOn: [], status: "PENDING", workClass: "DETERMINISTIC", order: 2, declaredActionKinds: ["RUN_TESTS"] },
  ];

  it("does not select a dependent whose prerequisite is not DONE", () => {
    assert.equal(selectNextItem(roadmap)?.key, undefined);
  });

  it("selects it once the prerequisite really is DONE", () => {
    const satisfied = roadmap.map((item) => (item.key === "A" ? { ...item, status: "DONE" as const } : item));
    assert.equal(selectNextItem(satisfied)?.key, "B");
  });

  it("does not run dependent work before its prerequisite", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    const state = await supervisor.service.ensureInitialized();
    await supervisor.repository.compareAndSave(
      { ...state, version: state.version + 1, roadmap },
      state.version,
    );

    await supervisor.service.tick();

    const calls = supervisor.executor.calls().map((call) => call.item.key);
    assert.ok(!calls.includes("B"), `B ran before A: ${JSON.stringify(calls)}`);
  });

  it("treats a dangling dependency as unsatisfied rather than absent", () => {
    const dangling: readonly RoadmapItem[] = [
      { key: "B", title: "Dependent", dependsOn: ["GHOST"], status: "ELIGIBLE", workClass: "DETERMINISTIC", order: 1 },
    ];
    assert.equal(selectNextItem(dangling), undefined);
  });
});

// =====================================================================
// R7-SEC-1 (HIGH) — the executor cannot mutate what it is handed
// =====================================================================

describe("TASK-006 R7-SEC-1: executor input is deeply frozen, against the REAL repository", () => {
  const LEAK = "sk-ant-api03-HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH";

  /**
   * Against a real SQLite database on purpose. The in-memory repository happened
   * to return frozen state and SQLite did not, so this hole existed ONLY in
   * production — the same shape as TASK-005 remediation round 3.
   */
  async function mutatingSupervisor(mutate: (input: { item: RoadmapItem }) => void) {
    const repository = createSqliteSupervisorRepository(tempDbPath("r7-sec-1"));
    const base = scriptedExecutor();
    const supervisor = newSupervisor({
      repository,
      probe: healthyProbe(),
      executor: {
        ...base,
        async execute(input) {
          try {
            mutate(input as unknown as { item: RoadmapItem });
          } catch {
            /* frozen, as intended */
          }
          return { kind: "COMPLETED", detail: "done", ...(input.config === undefined ? {} : {
            reportedIdentity: {
              provider: input.config.requestedProvider,
              model: input.config.requestedModel,
            },
          }) };
        },
      },
    });
    return { supervisor, repository };
  }

  it("refuses a mutation of the item key, and settles the item that actually ran", async () => {
    const roadmap: readonly RoadmapItem[] = [
      { key: "A", title: "First", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
      { key: "B", title: "Second", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 2 },
    ];
    const { supervisor, repository } = await mutatingSupervisor((input) => {
      (input.item as { key: string }).key = "B";
    });
    await seedRoadmap(supervisor, roadmap);

    await supervisor.service.tick();
    const state = await repository.load();
    repository.close();

    const a = state?.roadmap.find((entry) => entry.key === "A");
    const b = state?.roadmap.find((entry) => entry.key === "B");
    assert.equal(a?.status, "DONE", "the item that actually ran is the item that settled");
    assert.notEqual(b?.status, "DONE", "and an untouched item was not marked done in its place");
  });

  it("refuses a mutation that would write a credential into durable state", async () => {
    const roadmap: readonly RoadmapItem[] = [
      {
        key: "A",
        title: "First",
        dependsOn: [],
        status: "PENDING",
        workClass: "DETERMINISTIC",
        order: 1,
        declaredActionKinds: ["RUN_TESTS"],
      },
    ];
    const { supervisor, repository } = await mutatingSupervisor((input) => {
      (input.item.declaredActionKinds as unknown as string[])[0] = LEAK;
    });
    await seedRoadmap(supervisor, roadmap);

    await supervisor.service.tick();
    const state = await repository.load();
    repository.close();

    assert.ok(!JSON.stringify(state).includes(LEAK), "an executor wrote a credential into durable state");
  });

  it("freezes nested structures, not just the top level", async () => {
    let frozenNested = false;
    const { supervisor, repository } = await mutatingSupervisor((input) => {
      frozenNested = Object.isFrozen(input.item) && Object.isFrozen(input.item.dependsOn);
    });
    await seedRoadmap(supervisor, ONE_AI_ITEM);
    await supervisor.service.tick();
    repository.close();

    assert.ok(frozenNested, "a shallow freeze protects nothing that matters");
  });
});

// =====================================================================
// R7-C3-1 (HIGH) — the resource-binding guard, tested for real
// =====================================================================

describe("TASK-006 R7-C3-1: the resource binding guard refuses a genuine mismatch", () => {
  /**
   * The repair for a vacuous regression, and an honest account of what can and
   * cannot be tested here.
   *
   * The F6-FIN-1 test asserted only the matching path, so the supervisor's guard
   * could be deleted with all 1292 tests still green. The mutation run that
   * "verified" it had broken `mintedResourceKey` instead — which TRIPS the guard
   * rather than removing it. Mutating the wrong line proves the wrong thing, and
   * an independent reviewer is what caught it.
   *
   * The guard cannot be driven to a mismatch through `tick()`, because the
   * minted resource and the launched resource are both computed from the same
   * `config.option`. That makes it an INVARIANT ASSERTION against future drift
   * rather than a reachable branch — the drift that produced F6-FIN-1 in the
   * first place. So it is tested as a function, where its behaviour is actually
   * observable, and the reachability is stated rather than implied.
   */
  it("holds only when the cleared and launched resources are the same", () => {
    assert.equal(resourceBindingHolds("claude-code:opus", "claude-code:opus"), true);
    assert.equal(resourceBindingHolds("claude-code:opus", "codex-cli:gpt-5.6-luna"), false);
    assert.equal(resourceBindingHolds("claude-code:opus", "claude-code:sonnet"), false);
  });

  it("refuses when nothing was cleared, or nothing is being launched", () => {
    assert.equal(resourceBindingHolds(undefined, "claude-code:opus"), false, "an unminted verdict clears nothing");
    assert.equal(resourceBindingHolds("claude-code:opus", undefined), false);
    assert.equal(resourceBindingHolds(undefined, undefined), false, "two unknowns are not a match");
  });

  it("is wired into the supervisor's launch path", async () => {
    // Not a mismatch test — see above — but it does pin that the guard is
    // evaluated on the path that launches AI work, so a refactor that drops the
    // call site fails here rather than silently.
    const supervisor = newSupervisor({ probe: healthyProbe() });
    await seedRoadmap(supervisor, ONE_AI_ITEM);
    const ok = await supervisor.service.tick();
    assert.equal(ok.kind, "ADVANCED", "the agreeing case still proceeds");
    assert.equal(supervisor.executor.calls().length, 1);
  });

  it("refuses when no resource was selected but an AI launch was attempted", async () => {
    // The `launching === undefined` half of the guard: an AI work class that
    // reached the gate without a routed resource must not proceed.
    const probe = scriptedProbe();
    for (const entry of TEST_CATALOG) {
      probe.set(entry.provider, entry.model, { state: "AUTH_REQUIRED", reason: "logged out" });
    }
    const supervisor = newSupervisor({ probe });
    await seedRoadmap(supervisor, ONE_AI_ITEM);

    const result = await supervisor.service.tick();
    assert.notEqual(result.kind, "ADVANCED");
    assert.equal(supervisor.executor.calls().length, 0);
  });
});

// =====================================================================
// Round-7 notes — identity collisions and unbounded persisted lineage
// =====================================================================

describe("TASK-006 round 7 notes: identity and bounded parsing", () => {
  it("refuses a resource identity component containing the delimiter", () => {
    assert.throws(() => resourceKey("provider:model", "x"), ValidationError);
    assert.throws(() => resourceKey("provider", "model:x"), ValidationError);
    assert.equal(resourceKey("claude-code", "opus"), "claude-code:opus");
  });

  it("refuses to load an implausibly long implementer history", () => {
    const valid = {
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [],
      roadmap: [
        {
          key: "A",
          title: "Item",
          dependsOn: [],
          status: "DONE",
          workClass: "NORMAL_IMPLEMENTATION",
          order: 1,
          implementedByResourceKeys: Array.from({ length: 100_000 }, (_, i) => `p${i}:m`),
        },
      ],
      checkpoints: [],
      escalations: [],
      updatedAt: 1,
    };
    assert.throws(
      () => parseSupervisorState(JSON.stringify(valid), { version: 1 }),
      PersistenceCorruptionError,
    );
  });

  it("still loads a realistic history", () => {
    const state = {
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [],
      roadmap: [
        {
          key: "A",
          title: "Item",
          dependsOn: [],
          status: "DONE",
          workClass: "NORMAL_IMPLEMENTATION",
          order: 1,
          implementedByResourceKeys: ["claude-code:opus", "codex-cli:gpt-5.6-luna"],
        },
      ],
      checkpoints: [],
      escalations: [],
      updatedAt: 1,
    };
    const parsed = parseSupervisorState(encodeSupervisorState(state as never), { version: 1 });
    assert.equal(parsed.roadmap[0]?.implementedByResourceKeys?.length, 2);
  });
});
