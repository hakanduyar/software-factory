/**
 * TASK-018 PART A — the versioned catalog upgrade, as pure logic.
 *
 * The decision to upgrade, refuse, or do nothing is separable from the
 * transaction that writes it, and is tested here without a database so that
 * every refusal can be driven directly. The transactional and crash properties
 * (AC-5 transactionality, AC-6) are proven against real SQLite and real killed
 * processes elsewhere; a pure test cannot prove them and does not claim to.
 *
 * EVERY REFUSAL CASE IS PAIRED WITH A POSITIVE CONTROL. A mechanism that
 * refused everything would satisfy the first half of all of them, and that is
 * the shape of failure this repository has produced most often.
 *
 * Offline: no provider is contacted, no model is invoked, no money can be spent.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  CATALOG_UPGRADE_STEPS,
  CATALOG_V1,
  PRE_UPGRADE_CATALOG_VERSION,
  ROADMAP_CATALOG_VERSION,
  planCatalogUpgrade,
  type CatalogUpgradeStep,
} from "../src/supervision/catalogUpgrade.js";
import { reconcileRoadmapWithCatalog } from "../src/supervision/roadmapCatalog.js";
import { DEFAULT_ROADMAP, type RoadmapItem } from "../src/supervision/supervisorTypes.js";

/** A database seeded from v1 and never touched since. */
function seededAtV1(): readonly RoadmapItem[] {
  return CATALOG_V1.map((entry) => ({ ...entry, dependsOn: [...entry.dependsOn] }));
}

function refusalOf(verdict: ReturnType<typeof planCatalogUpgrade>): string {
  assert.equal(verdict.kind, "REFUSE", `expected a refusal, got ${verdict.kind}`);
  if (verdict.kind !== "REFUSE") throw new Error("unreachable");
  return verdict.problem;
}

function upgradedBy(verdict: ReturnType<typeof planCatalogUpgrade>): readonly RoadmapItem[] {
  assert.equal(verdict.kind, "UPGRADE", `expected an upgrade, got ${verdict.kind}`);
  if (verdict.kind !== "UPGRADE") throw new Error("unreachable");
  return verdict.roadmap;
}

/** Two toy versions, so the walk can be driven without inventing real history. */
const TOY_V1: readonly RoadmapItem[] = [
  { key: "A", title: "A", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
  { key: "B", title: "B", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 2 },
];
const TOY_V2: readonly RoadmapItem[] = [
  { key: "A", title: "A", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
  { key: "B", title: "B", dependsOn: ["A"], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 2 },
];
const TOY_STEP: CatalogUpgradeStep = { from: 1, to: 2, fromCatalog: TOY_V1, toCatalog: TOY_V2 };

// =====================================================================
// The historical record itself
// =====================================================================

describe("TASK-018 AC-1: the v1 catalog is a frozen historical record", () => {
  /**
   * PINNED BY DIGEST, not by a field-by-field comparison against
   * `DEFAULT_ROADMAP` — which is the thing it is supposed to differ from.
   *
   * The value was generated from `DEFAULT_ROADMAP` at commit `e633179`, before
   * any TASK-018 change to it. If this fails, either the snapshot was edited or
   * it was regenerated from a catalog that had already moved; both mean the
   * upgrade is comparing databases against a past that never existed.
   */
  it("has the digest taken at the moment it was snapshotted", () => {
    const canonical = CATALOG_V1.map((item) => ({
      key: item.key,
      title: item.title,
      dependsOn: [...item.dependsOn],
      status: item.status,
      workClass: item.workClass,
      order: item.order,
    }));
    assert.equal(
      createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex"),
      "a881540c09e430b8ede719f73311bcac10e78da04d3b2f8c7429a28053647d10",
      "the v1 catalog snapshot has changed; it is history and must not be edited",
    );
  });

  it("declares every key exactly once", () => {
    const keys = CATALOG_V1.map((item) => item.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  it("starts nothing as DONE, so an upgrade cannot introduce completed work", () => {
    for (const item of CATALOG_V1) {
      assert.equal(item.status, "PENDING", `${item.key} ships non-PENDING`);
    }
    for (const item of DEFAULT_ROADMAP) {
      assert.equal(item.status, "PENDING", `${item.key} ships non-PENDING`);
    }
  });
});

// =====================================================================
// AC-3 — only between recognised versions, by declared steps
// =====================================================================

describe("TASK-018 AC-3: migration runs only between recognised versions", () => {
  it("UPGRADES a database at the version a declared step starts from", () => {
    // The positive control for every refusal below.
    const verdict = planCatalogUpgrade({ recordedVersion: 1, persisted: [...TOY_V1], buildVersion: 2, steps: [TOY_STEP] });
    assert.equal(verdict.kind, "UPGRADE");
  });

  it("treats an ABSENT version record as v1 and nothing else", () => {
    const absent = planCatalogUpgrade({ persisted: seededAtV1() });
    assert.equal(absent.kind, "UPGRADE");
    if (absent.kind !== "UPGRADE") throw new Error("unreachable");
    assert.equal(absent.from, PRE_UPGRADE_CATALOG_VERSION);
    assert.equal(absent.to, ROADMAP_CATALOG_VERSION);
  });

  it("REFUSES a version no declared step leads forward from", () => {
    const problem = refusalOf(
      planCatalogUpgrade({ recordedVersion: 7, persisted: [...TOY_V1], buildVersion: 9, steps: [TOY_STEP] }),
    );
    assert.match(problem, /no declared roadmap catalog upgrade step leads forward from version 7/);
  });

  it("REFUSES a recorded version NEWER than this build, and never downgrades", () => {
    const problem = refusalOf(
      planCatalogUpgrade({ recordedVersion: 5, persisted: [...TOY_V1], buildVersion: 2, steps: [TOY_STEP] }),
    );
    assert.match(problem, /newer than this build's 2/);
    assert.match(problem, /never downgraded/);
  });

  it("REFUSES a GAP in the declared chain rather than bridging it", () => {
    // 1->2 is declared; 2->3 is not, and the build wants 3.
    const problem = refusalOf(
      planCatalogUpgrade({ recordedVersion: 1, persisted: [...TOY_V1], buildVersion: 3, steps: [TOY_STEP] }),
    );
    assert.match(problem, /no declared roadmap catalog upgrade step leads forward from version 2/);
    assert.match(problem, /reached from 1/);
  });

  it("REFUSES a step that does not advance the version", () => {
    const stuck: CatalogUpgradeStep = { from: 1, to: 1, fromCatalog: TOY_V1, toCatalog: TOY_V2 };
    const problem = refusalOf(
      planCatalogUpgrade({ recordedVersion: 1, persisted: [...TOY_V1], buildVersion: 2, steps: [stuck] }),
    );
    assert.match(problem, /does not advance the version/);
  });

  it("REFUSES a step that overshoots the build's version", () => {
    const over: CatalogUpgradeStep = { from: 1, to: 9, fromCatalog: TOY_V1, toCatalog: TOY_V2 };
    const problem = refusalOf(
      planCatalogUpgrade({ recordedVersion: 1, persisted: [...TOY_V1], buildVersion: 2, steps: [over] }),
    );
    assert.match(problem, /overshoots this build's version 2/);
  });

  it("REFUSES a recorded version that is not a positive integer", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const problem = refusalOf(planCatalogUpgrade({ recordedVersion: bad, persisted: [...TOY_V1], buildVersion: 2, steps: [TOY_STEP] }));
      assert.match(problem, /is not a positive integer/, `accepted ${bad}`);
    }
  });
});

// =====================================================================
// AC-4 — unexpected divergence refuses
// =====================================================================

describe("TASK-018 AC-4: unexpected divergence refuses the whole upgrade", () => {
  it("REFUSES a hand-edited definition, naming the field and both values", () => {
    const tampered = seededAtV1().map((item) =>
      item.key === "MEASURED_MODEL_ROUTER" ? { ...item, workClass: "DETERMINISTIC" as const } : item,
    );
    const problem = refusalOf(planCatalogUpgrade({ recordedVersion: 1, persisted: tampered }));
    assert.match(problem, /"MEASURED_MODEL_ROUTER"/);
    assert.match(problem, /"workClass"/);
    assert.match(problem, /DETERMINISTIC/);
    assert.match(problem, /HIGH_RISK_IMPLEMENTATION/);
  });

  it("REFUSES on EVERY definition field, not just the one an attacker used", () => {
    const edits: Record<string, unknown> = {
      title: "Renamed",
      workClass: "DETERMINISTIC",
      dependsOn: ["LOCAL_24_7_RUNTIME"],
      order: 99,
    };
    for (const [field, value] of Object.entries(edits)) {
      const tampered = seededAtV1().map((item) =>
        item.key === "CONTROL_ROOM" ? ({ ...item, [field]: value } as RoadmapItem) : item,
      );
      const problem = refusalOf(planCatalogUpgrade({ recordedVersion: 1, persisted: tampered }));
      assert.match(problem, new RegExp(field), `a rewritten ${field} was accepted`);
    }
  });

  it("REFUSES a key version 1 never declared", () => {
    const extra: RoadmapItem = {
      key: "INVENTED",
      title: "Invented",
      dependsOn: [],
      status: "PENDING",
      workClass: "NORMAL_IMPLEMENTATION",
      order: 99,
    };
    const problem = refusalOf(planCatalogUpgrade({ recordedVersion: 1, persisted: [...seededAtV1(), extra] }));
    assert.match(problem, /"INVENTED" is not declared by catalog version 1/);
  });

  it("REFUSES a duplicated persisted key", () => {
    const rows = seededAtV1();
    const problem = refusalOf(planCatalogUpgrade({ recordedVersion: 1, persisted: [...rows, rows[0]!] }));
    assert.match(problem, /the persisted roadmap declares "LOCAL_24_7_RUNTIME" twice/);
  });

  it("REFUSES a step whose target would DROP a persisted item, discarding its progress", () => {
    const shrinking: CatalogUpgradeStep = { from: 1, to: 2, fromCatalog: TOY_V1, toCatalog: [TOY_V2[0]!] };
    const problem = refusalOf(
      planCatalogUpgrade({ recordedVersion: 1, persisted: [...TOY_V1], buildVersion: 2, steps: [shrinking] }),
    );
    assert.match(problem, /would drop persisted roadmap item "B"/);
    assert.match(problem, /discard its recorded progress/);
  });

  it("does NOT refuse a database merely missing a row the FROM catalog declares", () => {
    // The positive control for the two "not declared" cases above: an
    // installation that never saw a key is an ordinary append, not tampering.
    const missing = seededAtV1().filter((item) => item.key !== "CONTROL_ROOM");
    const verdict = planCatalogUpgrade({ recordedVersion: 1, persisted: missing });
    assert.equal(verdict.kind, "UPGRADE");
    assert.ok(upgradedBy(verdict).some((item) => item.key === "CONTROL_ROOM"));
  });
});

// =====================================================================
// AC-5 — deterministic and idempotent (transactionality is proven elsewhere)
// =====================================================================

describe("TASK-018 AC-5: deterministic and idempotent", () => {
  it("produces byte-identical output twice from the same input", () => {
    const once = JSON.stringify(upgradedBy(planCatalogUpgrade({ recordedVersion: 1, persisted: seededAtV1() })));
    const twice = JSON.stringify(upgradedBy(planCatalogUpgrade({ recordedVersion: 1, persisted: seededAtV1() })));
    assert.equal(once, twice);
  });

  it("is a NO-OP at the build's own version, and says so rather than rewriting", () => {
    const verdict = planCatalogUpgrade({ recordedVersion: ROADMAP_CATALOG_VERSION, persisted: [...DEFAULT_ROADMAP] });
    assert.equal(verdict.kind, "ALREADY_CURRENT");
    if (verdict.kind !== "ALREADY_CURRENT") throw new Error("unreachable");
    assert.equal(verdict.version, ROADMAP_CATALOG_VERSION);
  });

  it("re-planning the UPGRADED roadmap is already current, so a retry writes nothing", () => {
    const upgraded = upgradedBy(planCatalogUpgrade({ recordedVersion: 1, persisted: seededAtV1() }));
    const again = planCatalogUpgrade({ recordedVersion: ROADMAP_CATALOG_VERSION, persisted: upgraded });
    assert.equal(again.kind, "ALREADY_CURRENT");
  });

  it("the upgraded roadmap is what reconciliation would accept, so the next tick does not refuse", () => {
    const upgraded = upgradedBy(planCatalogUpgrade({ recordedVersion: 1, persisted: seededAtV1() }));
    const verdict = reconcileRoadmapWithCatalog(upgraded, DEFAULT_ROADMAP);
    assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.problem);
  });
});

// =====================================================================
// AC-7 / AC-8 — progress survives, authority is not created
// =====================================================================

describe("TASK-018 AC-7/AC-8: the upgrade restores knowledge, never authority", () => {
  /** A database with real progress on it: done work, attempts, lineage. */
  function withProgress(): readonly RoadmapItem[] {
    return seededAtV1().map((item) => {
      if (item.key === "CLEAN_ROOM_CI") {
        return {
          ...item,
          status: "DONE" as const,
          attempts: 24,
          unlaunchedAttempts: 1,
          implementedByResourceKeys: ["claude-code:opus"],
          detail: "accepted on round 24",
        };
      }
      if (item.key === "MEASURED_MODEL_ROUTER") {
        return { ...item, attempts: 3, detail: "blocked", humanActionRequired: "owner must choose a benchmark set" };
      }
      return item;
    });
  }

  it("carries every PROGRESS field across untouched", () => {
    const before = withProgress();
    const after = upgradedBy(planCatalogUpgrade({ recordedVersion: 1, persisted: before }));
    for (const original of before) {
      const upgraded = after.find((item) => item.key === original.key);
      assert.ok(upgraded, `${original.key} disappeared`);
      assert.equal(upgraded.status, original.status, `${original.key} status changed`);
      assert.equal(upgraded.attempts, original.attempts, `${original.key} attempts changed`);
      assert.equal(upgraded.unlaunchedAttempts, original.unlaunchedAttempts);
      assert.deepEqual(upgraded.implementedByResourceKeys, original.implementedByResourceKeys);
      assert.equal(upgraded.detail, original.detail);
      assert.equal(upgraded.humanActionRequired, original.humanActionRequired);
    }
  });

  it("changes NO item's status, including the one it rewrites the definition of", () => {
    const before = withProgress();
    const after = upgradedBy(planCatalogUpgrade({ recordedVersion: 1, persisted: before }));
    const router = after.find((item) => item.key === "MEASURED_MODEL_ROUTER");
    assert.ok(router);
    assert.equal(router.status, "PENDING");
    assert.notDeepEqual(router.dependsOn, ["EXECUTOR_WIRING"], "the definition was supposed to change");
  });

  it("introduces the new item as PENDING, never as DONE", () => {
    const after = upgradedBy(planCatalogUpgrade({ recordedVersion: 1, persisted: withProgress() }));
    const added = after.find((item) => item.key === "DURABLE_ORCHESTRATION");
    assert.ok(added, "the new item was not added");
    assert.equal(added.status, "PENDING");
    assert.equal(added.attempts, undefined);
    assert.equal(added.implementedByResourceKeys, undefined);
  });

  it("names the from-version, the to-version and the steps, for the audit record", () => {
    const verdict = planCatalogUpgrade({ recordedVersion: 1, persisted: seededAtV1() });
    assert.equal(verdict.kind, "UPGRADE");
    if (verdict.kind !== "UPGRADE") throw new Error("unreachable");
    assert.match(verdict.detail, /roadmap catalog upgraded 1 -> 2/);
    assert.match(verdict.detail, /steps: 1->2/);
  });
});

// =====================================================================
// The declared steps this build actually ships
// =====================================================================

describe("TASK-018: the declared steps form one unbroken chain to this build", () => {
  it("starts at the pre-upgrade version and ends at this build's", () => {
    assert.ok(CATALOG_UPGRADE_STEPS.length >= 1);
    assert.equal(CATALOG_UPGRADE_STEPS[0]!.from, PRE_UPGRADE_CATALOG_VERSION);
    assert.equal(CATALOG_UPGRADE_STEPS.at(-1)!.to, ROADMAP_CATALOG_VERSION);
  });

  it("has no gap and no repeated starting point", () => {
    const froms = new Set<number>();
    let expected = PRE_UPGRADE_CATALOG_VERSION;
    for (const step of CATALOG_UPGRADE_STEPS) {
      assert.equal(step.from, expected, "a declared step does not follow the previous one");
      assert.equal(froms.has(step.from), false, `two steps start from version ${step.from}`);
      froms.add(step.from);
      expected = step.to;
    }
    assert.equal(expected, ROADMAP_CATALOG_VERSION);
  });

  it("upgrades a real v1 database all the way to this build without refusing", () => {
    const verdict = planCatalogUpgrade({ recordedVersion: PRE_UPGRADE_CATALOG_VERSION, persisted: seededAtV1() });
    assert.equal(verdict.kind, "UPGRADE", verdict.kind === "REFUSE" ? verdict.problem : "");
  });
});
