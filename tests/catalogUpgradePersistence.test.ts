/**
 * TASK-018 PART A, against a REAL database and REAL killed processes.
 *
 * `catalogUpgrade.test.ts` proves the decision. This file proves the two things
 * a pure test structurally cannot: that the rows and the recorded version move
 * in ONE transaction (AC-5), and that a process killed in the middle leaves the
 * database wholly at one version or wholly at the other (AC-6).
 *
 * The upgrade is driven through `SupervisorService.tick()` rather than by
 * calling the planner and the repository in the order production happens to use
 * them. A test that re-implements its caller proves the test can do it, which is
 * a defect this repository has found more than once.
 *
 * Offline: no provider is contacted, no model is invoked, no money can be spent.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import {
  createSqliteSupervisorRepository,
  type SqliteSupervisorRepository,
} from "../src/adapters/supervision/sqliteSupervisorRepository.js";
import { CATALOG_UPGRADE_STEPS, CATALOG_V1, ROADMAP_CATALOG_VERSION } from "../src/supervision/catalogUpgrade.js";
import { anchorFor, appendProvenance, verifyAgainstAnchor, type ProvenanceEntry } from "../src/supervision/provenanceChain.js";
import { recomputeEligibility, SupervisorService } from "../src/supervision/supervisorService.js";
import { DEFAULT_ROADMAP, type RoadmapItem, type SupervisorState } from "../src/supervision/supervisorTypes.js";
import { createSequentialIdGenerator } from "../src/domain/ids.js";
import { DEFAULT_ROUTING_POLICY } from "../src/supervision/modelRouting.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import { manualClock, scriptedExecutor, scriptedProbe, TEST_CATALOG } from "./support/supervisorFixtures.js";

const CATALOG_VERSION_KEY = "roadmap_catalog_version";
const scratch = mkdtempSync(join(tmpdir(), "sf-t018-"));

after(() => {
  cleanupTempDbs();
});

function healthyProbe() {
  const probe = scriptedProbe();
  for (const entry of TEST_CATALOG) {
    probe.set(entry.provider, entry.model, { state: "AVAILABLE", reason: "scripted", billingMode: "INCLUDED_SUBSCRIPTION" });
  }
  return probe;
}

/** The supervisor this build actually ships: real catalog, real declared steps. */
function realSupervisor(repository: SqliteSupervisorRepository): SupervisorService {
  const clock = manualClock();
  return new SupervisorService({
    repository,
    roadmapCatalog: [...DEFAULT_ROADMAP],
    catalogUpgradeSteps: CATALOG_UPGRADE_STEPS,
    catalogVersion: ROADMAP_CATALOG_VERSION,
    probe: healthyProbe(),
    executor: scriptedExecutor(),
    clock: { now: () => clock.now() },
    ids: createSequentialIdGenerator(),
    routingPolicy: DEFAULT_ROUTING_POLICY,
    resourceCatalog: TEST_CATALOG,
    log: () => {},
  });
}

interface StateRow {
  readonly version: number;
  readonly data: string;
}

function withRawDb<T>(path: string, body: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return body(db);
  } finally {
    db.close();
  }
}

function readVersionRow(path: string): string | undefined {
  return withRawDb(path, (db) => {
    const row = db.prepare("SELECT value FROM supervisor_meta WHERE key = ?").get(CATALOG_VERSION_KEY) as
      | { readonly value: string }
      | undefined;
    return row?.value;
  });
}

function readStateRow(path: string): StateRow {
  return withRawDb(
    path,
    (db) => db.prepare("SELECT version, data FROM supervisor_state WHERE id = 'supervisor'").get() as unknown as StateRow,
  );
}

function readRoadmap(path: string): readonly RoadmapItem[] {
  return (JSON.parse(readStateRow(path).data) as { readonly roadmap: readonly RoadmapItem[] }).roadmap;
}

function routerDependsOn(roadmap: readonly RoadmapItem[]): readonly string[] {
  const router = roadmap.find((item) => item.key === "MEASURED_MODEL_ROUTER");
  assert.ok(router, "the router is missing from the roadmap");
  return [...router.dependsOn];
}

/**
 * A database exactly as a pre-TASK-018 build left one: rows at the v1 catalog,
 * and NO version record at all.
 *
 * Built by writing a real state through the real repository and then deleting
 * the meta row, rather than by hand-crafting JSON — the shape has to be one the
 * production writer actually produces, or the upgrade is being tested against a
 * file nothing ever wrote.
 */
async function seedV1Database(options: { readonly progress?: boolean } = {}): Promise<string> {
  const path = tempDbPath();
  const repository = createSqliteSupervisorRepository(path);

  let roadmap: readonly RoadmapItem[] = CATALOG_V1.map((item) => ({ ...item, dependsOn: [...item.dependsOn] }));
  let provenance: readonly ProvenanceEntry[] = [];

  if (options.progress === true) {
    roadmap = roadmap.map((item) =>
      item.key === "CLEAN_ROOM_CI"
        ? {
            ...item,
            status: "DONE" as const,
            attempts: 24,
            unlaunchedAttempts: 1,
            implementedByResourceKeys: ["claude-code:opus"],
            detail: "accepted on round 24",
          }
        : item,
    );
    const appended = appendProvenance([], {
      kind: "IMPLEMENTED_BY",
      roadmapKey: "CLEAN_ROOM_CI",
      resourceKey: "claude-code:opus",
      detail: "completed",
      recordedAt: 1_000,
    });
    assert.equal(appended.ok, true);
    if (!appended.ok) throw new Error("unreachable");
    provenance = appended.chain;
  }

  const state: SupervisorState = {
    version: 1,
    financialPolicy: { autonomousSpendLimit: 0 },
    resources: [],
    roadmap,
    checkpoints: [],
    escalations: [],
    provenance,
    provenanceAnchor: anchorFor(provenance),
    updatedAt: 1_000,
  };

  try {
    await repository.create(state);
  } finally {
    repository.close();
  }

  // ...and now it is a database from BEFORE the version record existed.
  withRawDb(path, (db) => db.prepare("DELETE FROM supervisor_meta WHERE key = ?").run(CATALOG_VERSION_KEY));
  assert.equal(readVersionRow(path), undefined, "the fixture still records a version");
  return path;
}

// =====================================================================
// AC-1 — the version is recorded, and its absence means exactly one thing
// =====================================================================

describe("TASK-018 AC-1: the recorded catalog version", () => {
  it("a database created by this build records THIS build's version", async () => {
    const path = tempDbPath();
    const repository = createSqliteSupervisorRepository(path);
    try {
      await repository.create({
        version: 1,
        financialPolicy: {},
        resources: [],
        roadmap: [...DEFAULT_ROADMAP],
        checkpoints: [],
        escalations: [],
        provenance: [],
        provenanceAnchor: anchorFor([]),
        updatedAt: 1_000,
      });
      assert.equal(await repository.readCatalogVersion(), ROADMAP_CATALOG_VERSION);
      assert.equal(readVersionRow(path), String(ROADMAP_CATALOG_VERSION));
    } finally {
      repository.close();
    }
  });

  it("a database from before this task reads as NO RECORD", async () => {
    const path = await seedV1Database();
    const repository = createSqliteSupervisorRepository(path);
    try {
      assert.equal(await repository.readCatalogVersion(), undefined);
    } finally {
      repository.close();
    }
  });

  it("REFUSES a version record that is not a positive integer, rather than reading it as absent", async () => {
    // Absence means v1. Nonsense means STOP: reading it as absence would let
    // anyone who can write one byte re-run the upgrade against rows it no
    // longer describes.
    for (const nonsense of ["abc", "0", "-2", "1.5", ""]) {
      const path = await seedV1Database();
      withRawDb(path, (db) =>
        db
          .prepare(
            "INSERT INTO supervisor_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          )
          .run(CATALOG_VERSION_KEY, nonsense),
      );

      const repository = createSqliteSupervisorRepository(path);
      try {
        await assert.rejects(
          async () => repository.readCatalogVersion(),
          (error: Error) => {
            assert.match(error.message, /is not a positive integer/);
            return true;
          },
          `accepted ${JSON.stringify(nonsense)}`,
        );
      } finally {
        repository.close();
      }
    }
  });
});

// =====================================================================
// The upgrade, end to end, through the supervisor that ships
// =====================================================================

describe("TASK-018 AC-5/AC-7/AC-9: a v1 database upgraded through a real tick", () => {
  it("moves the rows AND the version record, preserves progress, and records why", async () => {
    const path = await seedV1Database({ progress: true });
    const before = readRoadmap(path);
    const repository = createSqliteSupervisorRepository(path);
    try {
      await realSupervisor(repository).tick();

      // AC-1/AC-5: the record moved with the rows.
      assert.equal(readVersionRow(path), String(ROADMAP_CATALOG_VERSION));
      assert.equal(await repository.readCatalogVersion(), ROADMAP_CATALOG_VERSION);

      const after = readRoadmap(path);

      // AC-9: the definition change actually landed.
      assert.deepEqual(routerDependsOn(after), ["EXECUTOR_WIRING", "DURABLE_ORCHESTRATION"]);
      assert.ok(after.some((item) => item.key === "DURABLE_ORCHESTRATION"));

      // AC-7: the completed item's progress survived, field by field.
      const done = after.find((item) => item.key === "CLEAN_ROOM_CI");
      assert.ok(done);
      assert.equal(done.status, "DONE");
      assert.equal(done.attempts, 24);
      assert.equal(done.unlaunchedAttempts, 1);
      assert.deepEqual(done.implementedByResourceKeys, ["claude-code:opus"]);
      assert.equal(done.detail, "accepted on round 24");

      // AC-8: no DONE item's status moved. `tick` may legitimately promote
      // PENDING to ELIGIBLE, which is dependency-driven and not the upgrade.
      for (const original of before) {
        if (original.status !== "DONE") continue;
        assert.equal(after.find((item) => item.key === original.key)?.status, "DONE");
      }

      // AC-7: the chain still verifies, and the upgrade appended its own record.
      const state = await repository.load();
      assert.ok(state);
      assert.equal(verifyAgainstAnchor(state.provenance, state.provenanceAnchor).intact, true);
      const audit = state.provenance.filter((entry) => entry.kind === "CATALOG_UPGRADED");
      assert.equal(audit.length, 1, "the upgrade left no audit record");
      assert.match(audit[0]!.detail, /roadmap catalog upgraded 1 -> 2/);
      assert.match(audit[0]!.detail, /steps: 1->2/);
      assert.equal(audit[0]!.resourceKey, undefined, "an upgrade must not name an implementer");

      // The entry that was there before is still there, unedited.
      assert.equal(state.provenance.filter((entry) => entry.kind === "IMPLEMENTED_BY").length, 1);
      assert.equal(state.provenance[0]?.kind, "IMPLEMENTED_BY");
    } finally {
      repository.close();
    }
  });

  it("is IDEMPOTENT: a second tick upgrades nothing and appends no second record", async () => {
    const path = await seedV1Database({ progress: true });
    let afterFirst: readonly RoadmapItem[] = [];

    const first = createSqliteSupervisorRepository(path);
    try {
      await realSupervisor(first).tick();
      afterFirst = readRoadmap(path);
    } finally {
      first.close();
    }

    const second = createSqliteSupervisorRepository(path);
    try {
      await realSupervisor(second).tick();
      const state = await second.load();
      assert.ok(state);
      assert.equal(state.provenance.filter((entry) => entry.kind === "CATALOG_UPGRADED").length, 1, "the upgrade ran twice");
      assert.equal(readVersionRow(path), String(ROADMAP_CATALOG_VERSION));
      assert.deepEqual(
        readRoadmap(path).map((item) => [item.key, item.order, [...item.dependsOn]]),
        afterFirst.map((item) => [item.key, item.order, [...item.dependsOn]]),
      );
    } finally {
      second.close();
    }
  });

  it("REFUSES a tampered v1 database, and leaves it exactly as it found it", async () => {
    const path = await seedV1Database();
    withRawDb(path, (db) => {
      const row = db.prepare("SELECT data FROM supervisor_state WHERE id = 'supervisor'").get() as { readonly data: string };
      const parsed = JSON.parse(row.data) as { roadmap: RoadmapItem[] };
      parsed.roadmap = parsed.roadmap.map((item) =>
        item.key === "MEASURED_MODEL_ROUTER" ? { ...item, workClass: "DETERMINISTIC" } : item,
      );
      db.prepare("UPDATE supervisor_state SET data = ? WHERE id = 'supervisor'").run(JSON.stringify(parsed));
    });
    const snapshot = readStateRow(path);

    const repository = createSqliteSupervisorRepository(path);
    try {
      const result = await realSupervisor(repository).tick();
      assert.equal(result.kind, "WAITING_FOR_HUMAN");
      const reported = JSON.stringify(result);
      assert.match(reported, /disagrees with catalog version 1/);
      assert.match(reported, /workClass/);
    } finally {
      repository.close();
    }

    // AC-4: nothing was written.
    assert.deepEqual(readStateRow(path), snapshot, "a refused upgrade changed the database");
    assert.equal(readVersionRow(path), undefined, "a refused upgrade recorded a version");
  });
});

// =====================================================================
// AC-5 — the two writes are ONE transaction
// =====================================================================

describe("TASK-018 AC-5: the rows and the version record move together or not at all", () => {
  /**
   * Makes the SECOND of the adapter's two statements fail, deterministically,
   * without putting a test-only hook in production code.
   *
   * A trigger that aborts any insert into `supervisor_meta` is a fault the
   * database itself raises, exactly where the version record is written — after
   * the state row has already been updated inside the transaction. If those two
   * statements are not one transaction, the state row keeps its new value and
   * the database is left half-upgraded, which is the state AC-5 exists to make
   * impossible.
   */
  it("a failure writing the version record rolls the rows back too", async () => {
    const path = await seedV1Database({ progress: true });
    const before = readStateRow(path);

    withRawDb(path, (db) =>
      db.exec(
        "CREATE TRIGGER refuse_meta BEFORE INSERT ON supervisor_meta BEGIN SELECT RAISE(ABORT, 'meta write refused'); END;",
      ),
    );

    const repository = createSqliteSupervisorRepository(path);
    try {
      const result = await realSupervisor(repository).tick();
      // The tick must not report success over a write that did not happen.
      assert.notEqual(result.kind, "EXECUTED", "a failed upgrade was reported as progress");
    } catch (error) {
      assert.match(String(error), /meta write refused/);
    } finally {
      repository.close();
    }

    withRawDb(path, (db) => db.exec("DROP TRIGGER refuse_meta"));

    assert.deepEqual(readStateRow(path), before, "the row moved while the version record did not");
    assert.equal(readVersionRow(path), undefined, "a version was recorded by a failed upgrade");

    // ...and the database is still upgradable afterwards, so the rollback left
    // it usable rather than merely unchanged.
    const retry = createSqliteSupervisorRepository(path);
    try {
      await realSupervisor(retry).tick();
      assert.equal(readVersionRow(path), String(ROADMAP_CATALOG_VERSION));
      assert.deepEqual(routerDependsOn(readRoadmap(path)), ["EXECUTOR_WIRING", "DURABLE_ORCHESTRATION"]);
    } finally {
      retry.close();
    }
  });
});

// =====================================================================
// AC-9 — the dependency is real
// =====================================================================

describe("TASK-018 AC-9: MEASURED_MODEL_ROUTER waits for DURABLE_ORCHESTRATION", () => {
  /** Everything the router depends on EXCEPT durable orchestration, done. */
  function withPrerequisitesDone(durableStatus: RoadmapItem["status"]): readonly RoadmapItem[] {
    return DEFAULT_ROADMAP.map((item) => {
      if (item.key === "DURABLE_ORCHESTRATION") return { ...item, status: durableStatus };
      if (item.key === "MEASURED_MODEL_ROUTER") return item;
      return { ...item, status: "DONE" as const };
    });
  }

  it("is NOT eligible while durable orchestration is not DONE", () => {
    const roadmap = recomputeEligibility(withPrerequisitesDone("PENDING"));
    const router = roadmap.find((item) => item.key === "MEASURED_MODEL_ROUTER");
    assert.ok(router);
    assert.equal(router.status, "PENDING", "the router became eligible without durable orchestration");

    /**
     * `recomputeEligibility` withholds a status rather than returning a message,
     * so "the refusal names the dependency" is asserted where the naming
     * actually lives: the unmet edge, which must be this one and only this one.
     */
    const done = new Set(roadmap.filter((item) => item.status === "DONE").map((item) => item.key));
    assert.deepEqual(
      router.dependsOn.filter((key) => !done.has(key)),
      ["DURABLE_ORCHESTRATION"],
      "something other than durable orchestration is holding the router back",
    );
  });

  it("BECOMES eligible once durable orchestration is DONE — the positive control", () => {
    const roadmap = recomputeEligibility(withPrerequisitesDone("DONE"));
    assert.equal(roadmap.find((item) => item.key === "MEASURED_MODEL_ROUTER")?.status, "ELIGIBLE");
  });
});

// =====================================================================
// AC-6 — a killed process leaves one whole state or the other
// =====================================================================

describe("TASK-018 AC-6: a process killed mid-upgrade leaves no half-applied database", () => {
  /**
   * The bytes PRODUCTION writes for this upgrade, captured by performing it on
   * a copy.
   *
   * The child below replays exactly these. Hand-writing an approximation of the
   * upgraded row would test a payload nothing ever produces — and the first
   * draft of this file did precisely that, writing the router's new edge while
   * omitting the new item, so "the next start recovers" passed against a state
   * the adapter cannot create.
   */
  async function productionBytes(source: string): Promise<{ readonly row: StateRow; readonly version: string }> {
    const copy = `${source}.upgraded`;
    copyFileSync(source, copy);
    const repository = createSqliteSupervisorRepository(copy);
    try {
      await realSupervisor(repository).tick();
    } finally {
      repository.close();
    }
    const version = readVersionRow(copy);
    assert.equal(version, String(ROADMAP_CATALOG_VERSION));
    return { row: readStateRow(copy), version: version! };
  }

  /**
   * A child that opens the database, runs the adapter's two-statement
   * transaction with production's own bytes, and is SIGKILLed at a chosen
   * point. SIGKILL cannot be caught, so nothing gets to tidy up — which is the
   * point: what is under test is what SQLite guarantees, not what a handler
   * does.
   */
  function killDuringUpgrade(path: string, payload: { row: StateRow; version: string }, when: "before-commit" | "after-commit"): void {
    const script = join(scratch, `kill-${when}-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(
      script,
      [
        `import { DatabaseSync } from "node:sqlite";`,
        `const db = new DatabaseSync(${JSON.stringify(path)});`,
        `db.exec("BEGIN IMMEDIATE");`,
        `db.prepare("UPDATE supervisor_state SET version = ?, data = ? WHERE id = 'supervisor'").run(${payload.row.version}, ${JSON.stringify(payload.row.data)});`,
        `db.prepare("INSERT INTO supervisor_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(${JSON.stringify(CATALOG_VERSION_KEY)}, ${JSON.stringify(payload.version)});`,
        when === "after-commit" ? `db.exec("COMMIT");` : `// killed with the transaction still open`,
        `process.kill(process.pid, "SIGKILL");`,
        "",
      ].join("\n"),
      "utf8",
    );
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(result.signal, "SIGKILL", `the child was not killed: ${result.stderr}`);
  }

  it("killed BEFORE the commit, the database is wholly at the old version", async () => {
    const path = await seedV1Database({ progress: true });
    const payload = await productionBytes(path);
    const before = readStateRow(path);

    killDuringUpgrade(path, payload, "before-commit");

    assert.equal(readVersionRow(path), undefined, "an uncommitted transaction recorded a version");
    assert.deepEqual(readStateRow(path), before, "uncommitted row changes survived");
  });

  it("killed AFTER the commit, the database is wholly at the new version", async () => {
    const path = await seedV1Database({ progress: true });
    const payload = await productionBytes(path);

    killDuringUpgrade(path, payload, "after-commit");

    assert.equal(readVersionRow(path), String(ROADMAP_CATALOG_VERSION), "the committed version record was lost");
    assert.deepEqual(routerDependsOn(readRoadmap(path)), ["EXECUTOR_WIRING", "DURABLE_ORCHESTRATION"]);
  });

  it("after either kill, the next start reaches the target version exactly once", async () => {
    for (const when of ["before-commit", "after-commit"] as const) {
      const path = await seedV1Database({ progress: true });
      const payload = await productionBytes(path);
      killDuringUpgrade(path, payload, when);

      const repository = createSqliteSupervisorRepository(path);
      try {
        await realSupervisor(repository).tick();

        assert.equal(readVersionRow(path), String(ROADMAP_CATALOG_VERSION), `after a ${when} kill`);
        const state = await repository.load();
        assert.ok(state);
        assert.equal(verifyAgainstAnchor(state.provenance, state.provenanceAnchor).intact, true, `after a ${when} kill`);
        assert.deepEqual(routerDependsOn(state.roadmap), ["EXECUTOR_WIRING", "DURABLE_ORCHESTRATION"]);

        // EXACTLY ONCE: a resumed upgrade that re-applied would append a second
        // audit record, and a kill is not a licence to record the same event
        // twice.
        assert.equal(
          state.provenance.filter((entry) => entry.kind === "CATALOG_UPGRADED").length,
          1,
          `after a ${when} kill the upgrade was recorded more than once`,
        );
        // And the completed work is still complete.
        assert.equal(state.roadmap.find((item) => item.key === "CLEAN_ROOM_CI")?.status, "DONE");
      } finally {
        repository.close();
      }
    }
  });
});
