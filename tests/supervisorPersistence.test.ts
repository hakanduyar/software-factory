/**
 * Durable supervisor persistence (TASK-006 AC-7, AC-10, AC-16).
 *
 * The production adapter, against a real SQLite file — not a substitute.
 * TASK-005 remediation round 3 is the reason: an in-memory stand-in that
 * behaves differently from production is exactly how a production-only defect
 * survives a green suite. So the restart scenario here closes and reopens a
 * real database and continues the work.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import {
  createSqliteSupervisorRepository,
  SUPERVISOR_SCHEMA_VERSION,
} from "../src/adapters/supervision/sqliteSupervisorRepository.js";
import { ConcurrencyError, PersistenceCorruptionError, SchemaVersionError } from "../src/domain/errors.js";
import { BACKOFF_LADDER_MS, NO_BACKOFF } from "../src/supervision/resourceTypes.js";
import {
  encodeSupervisorState,
  parseSupervisorState,
} from "../src/supervision/supervisorSerialization.js";
import type { SupervisorState } from "../src/supervision/supervisorTypes.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import {
  manualClock,
  newSupervisor,
  scriptedExecutor,
  scriptedProbe,
  seedRoadmap,
  TEST_CATALOG,
  TWO_ITEM_ROADMAP,
} from "./support/supervisorFixtures.js";
import { DatabaseSync } from "node:sqlite";

after(cleanupTempDbs);

/** A minimal but complete, valid state to mutate in corruption tests. */
function validState(overrides: Partial<SupervisorState> = {}): SupervisorState {
  return {
    version: 3,
    financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
    resources: [
      {
        provider: "claude-code",
        model: "opus",
        key: "claude-code:opus",
        state: "AVAILABLE",
        detectedAt: 100,
        lastCheckedAt: 100,
        backoff: NO_BACKOFF,
        lastSuccessAt: 100,
      },
    ],
    roadmap: [
      { key: "A", title: "First", dependsOn: [], status: "ELIGIBLE", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
      { key: "B", title: "Second", dependsOn: ["A"], status: "PENDING", workClass: "DOCS", order: 2 },
    ],
    checkpoints: [],
    escalations: [],
    updatedAt: 100,
    ...overrides,
  };
}

function roundTrip(state: SupervisorState): SupervisorState {
  return parseSupervisorState(encodeSupervisorState(state), { version: state.version });
}

// =====================================================================
// Round-trip and strict parsing
// =====================================================================

describe("TASK-006 AC-7: supervisor state round-trips and corruption fails closed", () => {
  it("preserves every field through encode -> parse", () => {
    const state = validState({
      checkpoints: [
        {
          roadmapKey: "A",
          actionId: "A:LAUNCH_AI_WORKER:a1",
          iteration: 2,
          completedVerification: ["typecheck"],
          pendingVerification: ["npm test"],
          findings: ["implementer:claude-code:opus"],
          nextAction: "finish verification",
          requiredWorkClass: "NORMAL_IMPLEMENTATION",
          branch: "feat/x",
          baseCommit: "abc1234",
          updatedAt: 120,
        },
      ],
      activeClaim: {
        actionId: "A:LAUNCH_AI_WORKER:a1",
        roadmapKey: "A",
        kind: "LAUNCH_AI_WORKER",
        resourceKey: "claude-code:opus",
        state: "RUNNING",
        ownerId: "supervisor:1",
        attempt: 1,
        claimedAt: 110,
      },
      nextWakeAt: 999,
      escalations: [
        {
          roadmapKey: "B",
          reason: "FINANCIAL_ACTION_REQUIRED",
          humanActionRequired: "buy the VPS yourself",
          detail: "a server is needed",
          raisedAt: 130,
          resolved: false,
        },
      ],
    });
    assert.deepEqual(roundTrip(state), state);
  });

  it("recomputes the derived resource key rather than trusting it", () => {
    const tampered = validState({
      resources: [{ ...validState().resources[0]!, key: "claude-code:something-else" }],
    });
    assert.throws(() => roundTrip(tampered), /is not the canonical/);
  });

  it("recomputes the derived action id rather than trusting it", () => {
    const tampered = validState({
      activeClaim: {
        actionId: "A:LAUNCH_AI_WORKER:a99",
        roadmapKey: "A",
        kind: "LAUNCH_AI_WORKER",
        state: "CLAIMED",
        ownerId: "supervisor:1",
        attempt: 1,
        claimedAt: 1,
      },
    });
    assert.throws(() => roundTrip(tampered), /is not the canonical/);
  });

  it("refuses a scheduled retry on a state no timer can clear", () => {
    const tampered = validState({
      resources: [{ ...validState().resources[0]!, state: "AUTH_REQUIRED", retryAt: 5000 }],
    });
    assert.throws(() => roundTrip(tampered), /human-only and may not carry a scheduled retry/);
  });

  it("refuses a backoff beyond the ladder cap, or an incoherent one", () => {
    const cap = BACKOFF_LADDER_MS[BACKOFF_LADDER_MS.length - 1]!;
    assert.throws(
      () => roundTrip(validState({ resources: [{ ...validState().resources[0]!, backoff: { attempt: 1, delayMs: cap * 10 } }] })),
      /exceeds the ladder cap/,
    );
    assert.throws(
      () => roundTrip(validState({ resources: [{ ...validState().resources[0]!, backoff: { attempt: 0, delayMs: 5000 } }] })),
      /attempt 0 must carry delayMs 0/,
    );
  });

  it("refuses a roadmap with a dangling dependency or a cycle", () => {
    assert.throws(
      () => roundTrip(validState({ roadmap: [{ key: "A", title: "x", dependsOn: ["GHOST"], status: "PENDING", workClass: "DOCS", order: 1 }] })),
      /depends on unknown/,
    );
    assert.throws(
      () =>
        roundTrip(
          validState({
            roadmap: [
              { key: "A", title: "x", dependsOn: ["B"], status: "PENDING", workClass: "DOCS", order: 1 },
              { key: "B", title: "y", dependsOn: ["A"], status: "PENDING", workClass: "DOCS", order: 2 },
            ],
          }),
        ),
      /dependency cycle/,
    );
  });

  it("refuses dangling checkpoint, escalation and claim references", () => {
    const base = validState();
    assert.throws(
      () =>
        roundTrip({
          ...base,
          checkpoints: [
            {
              roadmapKey: "GHOST",
              actionId: "GHOST:X:a1",
              iteration: 1,
              completedVerification: [],
              pendingVerification: [],
              findings: [],
              nextAction: "x",
              requiredWorkClass: "DOCS",
              updatedAt: 1,
            },
          ],
        }),
      /checkpoint references unknown roadmap item/,
    );
    assert.throws(
      () =>
        roundTrip({
          ...base,
          escalations: [
            { roadmapKey: "GHOST", reason: "AUTH_REQUIRED", humanActionRequired: "x", detail: "y", raisedAt: 1, resolved: false },
          ],
        }),
      /escalation references unknown roadmap item/,
    );
  });

  it("requires a human action to be recorded whenever a human is being waited on", () => {
    const tampered = validState({
      roadmap: [
        { key: "A", title: "First", dependsOn: [], status: "WAITING_FOR_HUMAN_REQUIRED", workClass: "DOCS", order: 1 },
      ],
    });
    assert.throws(() => roundTrip(tampered), /presupposes a recorded humanActionRequired/);
  });

  it("refuses a payload whose version disagrees with the row column", () => {
    assert.throws(
      () => parseSupervisorState(encodeSupervisorState(validState()), { version: 99 }),
      /does not match the row version/,
    );
  });

  it("refuses a state with no financialPolicy field at all", () => {
    const { financialPolicy: _dropped, ...withoutPolicy } = validState();
    void _dropped;
    assert.throws(
      () => parseSupervisorState(JSON.stringify(withoutPolicy), { version: 3 }),
      /no financialPolicy field is stored/,
    );
  });

  it("carries an INVALID financial policy through rather than failing to load", () => {
    // Deliberate: the value is judged at use, where it DENIES. A state that
    // cannot load could not even report why it was refusing.
    const state = roundTrip(validState({ financialPolicy: { autonomousSpendAllowed: "yes" } }));
    assert.deepEqual(state.financialPolicy, { autonomousSpendAllowed: "yes" });
  });
});

// =====================================================================
// The real SQLite adapter
// =====================================================================

describe("TASK-006: the production SQLite repository", () => {
  it("creates, reads back and compare-and-saves", async () => {
    const repository = createSqliteSupervisorRepository(tempDbPath("supervisor-"));
    try {
      assert.equal(await repository.load(), undefined);
      const state = validState({ version: 1 });
      await repository.create(state);

      const loaded = await repository.load();
      assert.deepEqual(loaded, state);

      await repository.compareAndSave({ ...state, version: 2, updatedAt: 200 }, 1);
      assert.equal((await repository.load())?.version, 2);
    } finally {
      repository.close();
    }
  });

  it("refuses a stale compare-and-save", async () => {
    const repository = createSqliteSupervisorRepository(tempDbPath("supervisor-"));
    try {
      await repository.create(validState({ version: 1 }));
      await repository.compareAndSave({ ...validState({ version: 2 }) }, 1);
      await assert.rejects(() => repository.compareAndSave({ ...validState({ version: 2 }) }, 1), ConcurrencyError);
    } finally {
      repository.close();
    }
  });

  it("refuses a database written by another schema version", () => {
    const dbPath = tempDbPath("supervisor-");
    createSqliteSupervisorRepository(dbPath).close();

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE supervisor_meta SET value = ? WHERE key = 'schema_version'").run(
      String(SUPERVISOR_SCHEMA_VERSION + 1),
    );
    db.close();

    assert.throws(() => createSqliteSupervisorRepository(dbPath), SchemaVersionError);
  });

  it("refuses a corrupted row at READ time", async () => {
    const dbPath = tempDbPath("supervisor-");
    const repository = createSqliteSupervisorRepository(dbPath);
    await repository.create(validState({ version: 1 }));
    repository.close();

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE supervisor_state SET data = ? WHERE id = 'supervisor'").run('{"version":1}');
    db.close();

    const reopened = createSqliteSupervisorRepository(dbPath);
    try {
      await assert.rejects(() => reopened.load(), PersistenceCorruptionError);
    } finally {
      reopened.close();
    }
  });

  it("survives a real close/reopen and continues the roadmap", async () => {
    const dbPath = tempDbPath("supervisor-");
    const clock = manualClock();
    const executor = scriptedExecutor();

    const first = createSqliteSupervisorRepository(dbPath);
    const supervisorA = newSupervisor({ repository: first, clock, executor });
    await seedRoadmap(supervisorA, TWO_ITEM_ROADMAP);
    const advanced = await supervisorA.service.tick();
    assert.equal(advanced.kind, "ADVANCED");
    first.close();

    // A brand-new process over the same file: no shared memory, no transcript.
    const reopened = createSqliteSupervisorRepository(dbPath);
    try {
      const supervisorB = newSupervisor({
        repository: reopened,
        clock,
        executor,
        ownerId: "supervisor:second-process",
      });
      const state = await reopened.load();
      assert.equal(state?.roadmap.find((item) => item.key === "A")?.status, "DONE", "the first item stayed DONE");

      const next = await supervisorB.service.tick();
      assert.equal(next.kind, "ADVANCED");
      if (next.kind === "ADVANCED") {
        assert.equal(next.roadmapKey, "B", "the next item continued in a fresh process");
      }
    } finally {
      reopened.close();
    }
  });

  it("keeps a resource cooling down across a real restart", async () => {
    const dbPath = tempDbPath("supervisor-");
    const clock = manualClock();
    const probe = scriptedProbe();
    for (const entry of TEST_CATALOG) {
      probe.set(entry.provider, entry.model, { state: "PROVIDER_UNAVAILABLE", reason: "scripted outage" });
    }

    const first = createSqliteSupervisorRepository(dbPath);
    const supervisorA = newSupervisor({ repository: first, clock, probe });
    await seedRoadmap(supervisorA, TWO_ITEM_ROADMAP);
    await supervisorA.service.tick();
    const beforeRestart = (await first.load())!;
    const cooling = beforeRestart.resources.find((record) => record.backoff.attempt > 0)!;
    first.close();

    const reopened = createSqliteSupervisorRepository(dbPath);
    try {
      const state = (await reopened.load())!;
      const after = state.resources.find((record) => record.key === cooling.key)!;
      assert.equal(after.backoff.attempt, cooling.backoff.attempt, "the ladder position is durable");
      assert.equal(after.retryAt, cooling.retryAt, "and so is the scheduled retry time");
      assert.ok(state.nextWakeAt !== undefined, "the next wake time is published for a timer to use");
    } finally {
      reopened.close();
    }
  });
});
