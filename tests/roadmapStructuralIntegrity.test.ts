/**
 * TASK-012 — ROADMAP_STRUCTURAL_INTEGRITY.
 *
 * TASK-008's independent review demonstrated two bypasses that lineage
 * protection cannot reach, because they attack the item's DEFINITION rather
 * than its history:
 *
 *   - relabelling a persisted `workClass` from `INDEPENDENT_REVIEW` to
 *     `DETERMINISTIC` made the supervisor skip independent review entirely, and
 *     the item ran and reached DONE; and
 *   - persisting an `INDEPENDENT_REVIEW` item as `DONE` with no review having
 *     happened made its dependents eligible.
 *
 * Both are reproduced here exactly as the reviewer drove them — through
 * persisted state, which is what "anything that can write the database" means —
 * and each is paired with a NEGATIVE CONTROL, because a guard that refuses
 * everything would satisfy the first half of every one of these.
 *
 * Offline: no provider is contacted, no model is invoked, no money can be spent.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  DEFINITION_FIELDS,
  reconcileRoadmapWithCatalog,
  unprovenCompletion,
} from "../src/supervision/roadmapCatalog.js";
import { appendProvenance, anchorFor, type ProvenanceEntry } from "../src/supervision/provenanceChain.js";
import { DEFAULT_ROADMAP, type RoadmapItem } from "../src/supervision/supervisorTypes.js";
import {
  declarePersisted,
  newSupervisor,
  scriptedProbe,
  seedRoadmap,
  TEST_CATALOG,
  tamperRoadmap,
} from "./support/supervisorFixtures.js";

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

/** A implemented, B an independent review of A. The shape both bypasses use. */
const CATALOG: readonly RoadmapItem[] = [
  { key: "A", title: "Implemented", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
  { key: "B", title: "Review of A", dependsOn: ["A"], status: "PENDING", workClass: "INDEPENDENT_REVIEW", order: 2 },
];

function chainNaming(roadmapKey: string, resource: string): readonly ProvenanceEntry[] {
  const appended = appendProvenance([], {
    kind: "IMPLEMENTED_BY",
    roadmapKey,
    resourceKey: resource,
    detail: "completed",
    recordedAt: 1_000,
  });
  assert.equal(appended.ok, true);
  if (!appended.ok) throw new Error("unreachable");
  return appended.chain;
}

// =====================================================================
// AC-5 — workClass cannot be used to skip independent review
// =====================================================================

describe("TASK-012 AC-5: a relabelled workClass does not change what an item is", () => {
  /**
   * THE FIRST BYPASS. `B` is an `INDEPENDENT_REVIEW` item; rewriting the
   * persisted row to say `DETERMINISTIC` made the supervisor run it as ordinary
   * deterministic work — the reviewer observed `ADVANCED` with the action id
   * `B:RUN_DETERMINISTIC_WORK:a1` — and it reached DONE, accepted without any
   * independent review having happened.
   */
  it("REFUSES a persisted item whose workClass disagrees with the catalog", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe(), roadmap: CATALOG });
    await seedRoadmap(supervisor, CATALOG);
    await tamperRoadmap(supervisor, [
      { ...CATALOG[0]!, status: "DONE", implementedByResourceKeys: ["claude-code:opus"] } as RoadmapItem,
      { ...CATALOG[1]!, status: "ELIGIBLE", workClass: "DETERMINISTIC" },
    ]);

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "WAITING_FOR_HUMAN", "a relabelled review item ran as deterministic work");
    if (result.kind === "WAITING_FOR_HUMAN") {
      assert.match(result.humanActionRequired, /disagrees with the catalog on "workClass"/);
      assert.match(result.humanActionRequired, /"B"/);
    }
    assert.equal(supervisor.executor.calls().length, 0, "nothing may run on a roadmap that redefines itself");
  });

  /** NEGATIVE CONTROL: the same roadmap, undisturbed, still advances. */
  it("still advances a roadmap that matches its catalog", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe(), roadmap: CATALOG });
    await seedRoadmap(supervisor, CATALOG);
    const result = await supervisor.service.tick();
    assert.equal(result.kind, "ADVANCED", "a legitimate roadmap was refused");
  });
});

// =====================================================================
// AC-6 — a DONE with nothing behind it does not satisfy dependents
// =====================================================================

describe("TASK-012 AC-6: a forged completion does not make dependents eligible", () => {
  /**
   * THE SECOND BYPASS. Dependency truth is derived from `status === "DONE"` in
   * the same rewritable row, so writing DONE onto an unreviewed
   * `INDEPENDENT_REVIEW` item let `C` proceed as though the review had happened.
   *
   * The chain here is NON-EMPTY and anchored, which matters: an entirely empty
   * chain is legacy silence and is deliberately still accepted (see below).
   */
  it("REFUSES a DONE AI item that provenance knows nothing about", async () => {
    const catalog: readonly RoadmapItem[] = [
      ...CATALOG,
      {
        key: "C",
        title: "Depends on the review",
        dependsOn: ["B"],
        status: "PENDING",
        workClass: "DETERMINISTIC",
        order: 3,
        // Declared, so that C can genuinely RUN. Without this the supervisor
        // refuses deterministic work that declares nothing — and the case would
        // pass for that reason instead of the one it names.
        declaredActionKinds: ["RUN_TESTS"],
      },
    ];
    const supervisor = newSupervisor({ probe: healthyProbe(), roadmap: catalog });
    await seedRoadmap(supervisor, catalog);

    const chain = chainNaming("A", "claude-code:opus");
    const state = (await supervisor.repository.load())!;
    await supervisor.repository.compareAndSave(
      {
        ...state,
        version: state.version + 1,
        roadmap: [
          { ...catalog[0]!, status: "DONE", implementedByResourceKeys: ["claude-code:opus"] } as RoadmapItem,
          { ...catalog[1]!, status: "DONE" },
          { ...catalog[2]!, status: "ELIGIBLE" },
        ],
        provenance: chain,
        provenanceAnchor: anchorFor(chain),
      },
      state.version,
    );

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "WAITING_FOR_HUMAN", "an unreviewed item marked DONE satisfied its dependent");
    if (result.kind === "WAITING_FOR_HUMAN") {
      assert.match(result.humanActionRequired, /"B"/);
      assert.match(result.humanActionRequired, /no record of anything having run/);
    }
    assert.equal(supervisor.executor.calls().length, 0);
  });

  /**
   * THE EXEMPTION IS GONE (round-9 CRITICAL).
   *
   * An empty chain used to skip this check entirely, on the reasoning that a
   * pre-TASK-008 database has no entries for work already done. Sound about a
   * legacy database, useless as a control: the same condition is one DELETE
   * away, and the reviewer built a state with an empty chain, a genesis anchor
   * and forged `DONE` rows, and watched every dependent run.
   */
  it("REFUSES a DONE AI item even when the chain is entirely empty", () => {
    const problem = unprovenCompletion({
      roadmap: [{ ...CATALOG[1]!, status: "DONE" }],
      implementedKeys: new Set<string>(),
    });
    assert.notEqual(problem, undefined, "an empty chain excused a forged completion");
    assert.match(problem ?? "", /no record of anything having run/);
  });

  /** DETERMINISTIC work needs no AI, so nothing is expected to have run on it. */
  it("does not object to a DONE DETERMINISTIC item with no provenance", () => {
    assert.equal(
      unprovenCompletion({
        roadmap: [
          { key: "D", title: "Deterministic", dependsOn: [], status: "DONE", workClass: "DETERMINISTIC", order: 1 },
        ],
        implementedKeys: new Set<string>(),
      }),
      undefined,
    );
  });

  /**
   * NEGATIVE CONTROL, and the reason the check costs a fresh installation
   * nothing: every catalog item ships PENDING, so a new database has nothing
   * DONE and nothing to prove.
   */
  it("says nothing about a roadmap where nothing is DONE", () => {
    assert.equal(unprovenCompletion({ roadmap: CATALOG, implementedKeys: new Set<string>() }), undefined);
  });

  /** THE REVIEWER'S REPRODUCTION, driven end to end through real state. */
  it("REFUSES to advance a dependent of a forged DONE review, on a genesis chain", async () => {
    const catalog: readonly RoadmapItem[] = [
      ...CATALOG,
      {
        key: "C",
        title: "Depends on the review",
        dependsOn: ["B"],
        status: "PENDING",
        workClass: "DETERMINISTIC",
        order: 3,
        // Declared, so that C can genuinely RUN. Without this the supervisor
        // refuses deterministic work that declares nothing — and the case would
        // pass for that reason instead of the one it names.
        declaredActionKinds: ["RUN_TESTS"],
      },
    ];
    const supervisor = newSupervisor({ probe: healthyProbe(), roadmap: catalog });
    await seedRoadmap(supervisor, catalog);

    // Empty provenance, genesis anchor — exactly what a NEW database looks like.
    const state = (await supervisor.repository.load())!;
    await supervisor.repository.compareAndSave(
      {
        ...state,
        version: state.version + 1,
        roadmap: [
          { ...catalog[0]!, status: "DONE" },
          { ...catalog[1]!, status: "DONE" },
          { ...catalog[2]!, status: "ELIGIBLE" },
        ],
        provenance: [],
        provenanceAnchor: anchorFor([]),
      },
      state.version,
    );

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "WAITING_FOR_HUMAN", "a genesis chain excused two forged completions");
    assert.equal(supervisor.executor.calls().length, 0, "the dependent ran on unproven work");
  });
});

// =====================================================================
// AC-3 / AC-7 / AC-2 — the rest of the definition
// =====================================================================

describe("TASK-012 AC-3: an unrecognised item is not an item this installation runs", () => {
  it("REFUSES a persisted key the catalog does not declare", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe(), roadmap: CATALOG });
    await seedRoadmap(supervisor, CATALOG);
    await tamperRoadmap(supervisor, [
      ...CATALOG,
      { key: "SMUGGLED", title: "Not in the catalog", dependsOn: [], status: "ELIGIBLE", workClass: "DETERMINISTIC", order: 0 },
    ]);

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "WAITING_FOR_HUMAN", "an item nobody declared was executed");
    if (result.kind === "WAITING_FOR_HUMAN") {
      // The MESSAGE, not merely the refusal: something else refusing for an
      // unrelated reason would otherwise let this pass while the guard was gone.
      assert.match(result.humanActionRequired, /is not in this installation's catalog/);
      assert.match(result.humanActionRequired, /SMUGGLED/);
    }
    assert.equal(supervisor.executor.calls().length, 0);
  });

  /** The same rule, driven directly, so nothing else can answer for it. */
  it("returns a problem naming the undeclared key", () => {
    const verdict = reconcileRoadmapWithCatalog(
      [
        ...CATALOG,
        { key: "SMUGGLED", title: "x", dependsOn: [], status: "ELIGIBLE", workClass: "DETERMINISTIC", order: 0 },
      ],
      CATALOG,
    );
    assert.equal(verdict.ok, false, "an undeclared key was accepted");
    if (!verdict.ok) {
      assert.match(verdict.problem, /SMUGGLED/);
      assert.match(verdict.problem, /is not in this installation's catalog/);
    }
  });
});

describe("TASK-012 AC-7: dependency edges come from the catalog", () => {
  it("REFUSES a persisted item whose dependsOn was edited", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe(), roadmap: CATALOG });
    await seedRoadmap(supervisor, CATALOG);
    // Deleting the edge is how a dependent becomes eligible without its
    // dependency being done. Editing it is detected before it can decide.
    await tamperRoadmap(supervisor, [CATALOG[0]!, { ...CATALOG[1]!, dependsOn: [] }]);

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "WAITING_FOR_HUMAN", "a deleted dependency edge decided eligibility");
    if (result.kind === "WAITING_FOR_HUMAN") {
      assert.match(result.humanActionRequired, /disagrees with the catalog on "dependsOn"/);
    }
  });
});

describe("TASK-012 AC-1/AC-2: every definition field, detected and named", () => {
  /**
   * THE TEST OWNS THIS LIST (round-9 HIGH).
   *
   * It used to iterate the implementation's own `DEFINITION_FIELDS`, so deleting
   * a field from the production guard deleted its test with it: the reviewer
   * removed `"title"` and the suite ran 18/18 green instead of failing. A test
   * that derives its expectations from the code under test cannot detect that
   * code shrinking.
   *
   * The literal below is the specification. The assertion after it pins the two
   * together, so ADDING a field without a case here fails too.
   */
  const EXPECTED_DEFINITION_FIELDS = ["title", "workClass", "dependsOn", "order"] as const;

  it("checks exactly the fields this suite covers", () => {
    assert.deepEqual(
      [...DEFINITION_FIELDS].sort(),
      [...EXPECTED_DEFINITION_FIELDS].sort(),
      "the implementation's definition fields and this suite's cases have drifted apart",
    );
  });

  for (const field of EXPECTED_DEFINITION_FIELDS) {
    it(`detects a persisted ${field} that disagrees with the catalog`, () => {
      const edits: Record<string, unknown> = {
        title: "Renamed",
        workClass: "DETERMINISTIC",
        dependsOn: ["A", "A"],
        order: 99,
      };
      const verdict = reconcileRoadmapWithCatalog(
        [CATALOG[0]!, { ...CATALOG[1]!, [field]: edits[field] } as RoadmapItem],
        CATALOG,
      );
      assert.equal(verdict.ok, false, `a rewritten ${field} was accepted`);
      if (!verdict.ok) {
        assert.match(verdict.problem, new RegExp(field));
        assert.match(verdict.problem, /"B"/);
      }
    });
  }

  /**
   * AC-1, stated as what can actually be observed.
   *
   * "The returned item takes its definition from the catalog" is unobservable
   * on its own: any row that DIFFERS is refused, so on every path that returns
   * `ok` the two agree by construction. A mutation returning the row survives
   * the suite, and the source says so rather than implying otherwise.
   *
   * What IS observable, and is the property AC-1 exists for: PROGRESS survives
   * reconciliation untouched, and no disagreeing definition ever reaches a
   * caller at all.
   */
  it("keeps progress from the row and never returns a disagreeing definition", () => {
    const kept = reconcileRoadmapWithCatalog(
      [{ ...CATALOG[0]!, status: "DONE", attempts: 4, implementedByResourceKeys: ["claude-code:opus"] } as RoadmapItem],
      [CATALOG[0]!],
    );
    assert.equal(kept.ok, true);
    if (kept.ok) {
      const item = kept.roadmap[0]!;
      assert.equal(item.status, "DONE", "the progress was discarded");
      assert.equal(item.attempts, 4);
      assert.deepEqual(item.implementedByResourceKeys, ["claude-code:opus"]);
    }

    for (const field of EXPECTED_DEFINITION_FIELDS) {
      const edited = reconcileRoadmapWithCatalog(
        [{ ...CATALOG[0]!, [field]: field === "order" ? 42 : "changed" } as RoadmapItem],
        [CATALOG[0]!],
      );
      assert.equal(edited.ok, false, `a rewritten ${field} reached a caller`);
    }
  });

  /** An UPGRADE is ordinary: a newer catalog declares work this database lacks. */
  it("appends a catalog entry the database has never seen", () => {
    const verdict = reconcileRoadmapWithCatalog([CATALOG[0]!], CATALOG);
    assert.equal(verdict.ok, true);
    if (verdict.ok) {
      assert.deepEqual(
        verdict.roadmap.map((item) => item.key),
        ["A", "B"],
      );
    }
  });
});

// =====================================================================
// AC-4 / AC-8 / AC-9
// =====================================================================

describe("TASK-012 AC-4: the catalog is injectable, and defaults to the real one", () => {
  it("seeds a fresh installation from the injected catalog", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe(), roadmap: CATALOG });
    const state = await supervisor.service.ensureInitialized();
    assert.deepEqual(
      state.roadmap.map((item) => item.key),
      ["A", "B"],
    );
  });

  it("uses DEFAULT_ROADMAP when nothing is injected", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    const state = await supervisor.service.ensureInitialized();
    assert.deepEqual(
      state.roadmap.map((item) => item.key),
      DEFAULT_ROADMAP.map((item) => item.key),
    );
  });

  /** A persisted roadmap that simply IS the catalog is untouched. */
  it("leaves a matching roadmap alone", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe(), roadmap: CATALOG });
    await seedRoadmap(supervisor, CATALOG);
    await declarePersisted(supervisor);
    const before = (await supervisor.repository.load())!;
    await supervisor.service.tick();
    const after = (await supervisor.repository.load())!;
    assert.deepEqual(
      after.roadmap.map((item) => `${item.key}:${item.workClass}:${item.dependsOn.join("+")}`),
      before.roadmap.map((item) => `${item.key}:${item.workClass}:${item.dependsOn.join("+")}`),
    );
  });
});

describe("TASK-012 AC-8: the honest limit is where an implementer reads it", () => {
  it("states that the database is still not trustworthy", () => {
    const source = readFileSync("src/supervision/roadmapCatalog.ts", "utf8");
    assert.match(source, /does NOT make the database trustworthy/i);
    assert.match(source, /trusted computing base/i);
    assert.match(source, /declaredActionKinds/, "the residue must be named, not omitted");
  });
});

describe("TASK-012 AC-9: nothing else changed", () => {
  it("keeps EXECUTOR_WIRING dependent on both prerequisites", () => {
    const wiring = DEFAULT_ROADMAP.find((item) => item.key === "EXECUTOR_WIRING");
    assert.ok(wiring !== undefined, "EXECUTOR_WIRING must still be in the roadmap");
    assert.ok(wiring.dependsOn.includes("STATE_INTEGRITY"));
    assert.ok(wiring.dependsOn.includes("EXECUTOR_ISOLATION"));
  });
});
