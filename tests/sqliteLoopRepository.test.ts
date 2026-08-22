import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createSqliteLoopRepository } from "../src/adapters/orchestration/sqliteLoopRepository.js";
import { human } from "../src/domain/actor.js";
import { canonicalActionId, correlationTag, type EngineeringLoop, type LoopIterationRecord } from "../src/orchestration/loopTypes.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";

after(cleanupTempDbs);

/**
 * A protocol-coherent completed implementer iteration (claims are mandatory
 * upstream of run ids — see loopSerialization.ts). The claim's actionId/
 * correlationTag must be the exact canonical value for (loopId, iteration,
 * IMPLEMENT) — remediation round 2 rejects anything else.
 */
function completedIteration(loopId: string, n: number): LoopIterationRecord {
  const actionId = canonicalActionId(loopId, n, "IMPLEMENT");
  return {
    iteration: n,
    implementClaim: {
      actionId,
      kind: "IMPLEMENT",
      attempt: 1,
      ownerToken: "own-0001",
      claimedAt: 1500,
      correlationTag: correlationTag(actionId, 1),
    },
    implementerRunId: `run-000${n}`,
    implementerOutcome: "SUCCEEDED",
  };
}

function fixtureLoop(overrides: Partial<EngineeringLoop> = {}): EngineeringLoop {
  const id = overrides.id ?? "loop-test";
  return {
    id,
    workItemId: "wi-test",
    version: 1,
    phase: "IMPLEMENTING",
    budget: { maxIterations: 3 },
    implementer: { tool: "claude-code", model: "m" },
    reviewer: { tool: "codex-cli", model: "m" },
    verificationCommands: [{ id: "c", executable: "node", argv: ["-e", "1"] }],
    workspaceRoot: "/tmp/does-not-matter",
    taskInstructions: "do the thing",
    iterations: [completedIteration(id, 1)],
    totalRunCount: 1,
    cancelRequested: false,
    startedBy: human("user:test", "Test"),
    startedAt: 1000,
    lastTransitionAt: 2000,
    ...overrides,
  };
}

const TERMINAL_CANCELLED = {
  phase: "CANCELLED" as const,
  outcome: "CANCELLED" as const,
  cancelRequested: true,
};

describe("createSqliteLoopRepository", () => {
  it("creates and reads back a loop, including nested iteration/claim records", async () => {
    const repo = createSqliteLoopRepository(tempDbPath());
    try {
      const loop = fixtureLoop();
      await repo.create(loop);
      const found = await repo.findById(loop.id);
      assert.equal(found?.phase, "IMPLEMENTING");
      assert.equal(found?.iterations[0]?.implementerRunId, "run-0001");
      assert.equal(found?.iterations[0]?.implementClaim?.correlationTag, "sf-loop:loop-test:i1:IMPLEMENT:a1", "no double-embedded loopId");
      assert.equal(found?.startedBy.displayName, "Test");
    } finally {
      repo.close();
    }
  });

  it("refuses a duplicate id", async () => {
    const repo = createSqliteLoopRepository(tempDbPath());
    try {
      await repo.create(fixtureLoop());
      await assert.rejects(repo.create(fixtureLoop()), { code: "CONCURRENCY_CONFLICT" });
    } finally {
      repo.close();
    }
  });

  it("refuses a second ACTIVE loop for the same work item via the partial unique index (PART E)", async () => {
    const repo = createSqliteLoopRepository(tempDbPath());
    try {
      await repo.create(fixtureLoop({ id: "loop-a" }));
      await assert.rejects(repo.create(fixtureLoop({ id: "loop-b" })), {
        code: "CONCURRENCY_CONFLICT",
        message: /active EngineeringLoop already exists/,
      });
    } finally {
      repo.close();
    }
  });

  it("allows a new loop once the prior loop for the work item is terminal", async () => {
    const repo = createSqliteLoopRepository(tempDbPath());
    try {
      const loop = fixtureLoop({ id: "loop-a" });
      await repo.create(loop);
      await repo.compareAndSave({ ...loop, version: 2, ...TERMINAL_CANCELLED }, 1);
      const second = await repo.create(fixtureLoop({ id: "loop-b" }));
      assert.equal(second.id, "loop-b");
    } finally {
      repo.close();
    }
  });

  it("compareAndSave enforces the expected version via a real conditional UPDATE", async () => {
    const repo = createSqliteLoopRepository(tempDbPath());
    try {
      const loop = fixtureLoop();
      await repo.create(loop);
      await repo.compareAndSave({ ...loop, version: 2, phase: "VERIFYING" }, 1);
      await repo
        .compareAndSave({ ...loop, version: 2, phase: "IMPLEMENTING" }, 1)
        .then(
          () => assert.fail("stale CAS must not win"),
          (error: unknown) => assert.equal((error as { code?: string }).code, "CONCURRENCY_CONFLICT"),
        );

      const current = await repo.findById(loop.id);
      assert.equal(current?.phase, "VERIFYING");
      assert.equal(current?.version, 2);
    } finally {
      repo.close();
    }
  });

  it("survives close and reopen against the same file", async () => {
    const dbPath = tempDbPath();
    const first = createSqliteLoopRepository(dbPath);
    const loop = fixtureLoop({
      budget: { maxIterations: 1 },
      phase: "EXHAUSTED",
      outcome: "EXHAUSTED",
      failureReason: "budget exhausted",
      exhaustionKind: "ITERATIONS",
    });
    await first.create(loop);
    first.close();

    const reopened = createSqliteLoopRepository(dbPath);
    try {
      const found = await reopened.findById(loop.id);
      assert.equal(found?.phase, "EXHAUSTED");
      assert.equal(found?.outcome, "EXHAUSTED");
      assert.equal(found?.failureReason, "budget exhausted");
      assert.equal(found?.exhaustionKind, "ITERATIONS");
    } finally {
      reopened.close();
    }
  });

  it("lists only loops for the given work item, in insertion order", async () => {
    const repo = createSqliteLoopRepository(tempDbPath());
    try {
      await repo.create(fixtureLoop({ id: "loop-a", workItemId: "wi-a", ...TERMINAL_CANCELLED }));
      await repo.create(fixtureLoop({ id: "loop-b", workItemId: "wi-other" }));
      await repo.create(fixtureLoop({ id: "loop-c", workItemId: "wi-a" }));

      const forA = await repo.listByWorkItem("wi-a");
      assert.deepEqual(
        forA.map((loop) => loop.id),
        ["loop-a", "loop-c"],
      );
    } finally {
      repo.close();
    }
  });

  it("refuses to open a loops database whose version marker matches but whose uniqueness index was dropped (PART H)", async () => {
    const dbPath = tempDbPath();
    const seed = createSqliteLoopRepository(dbPath);
    seed.close();

    const db = new DatabaseSync(dbPath);
    db.exec("DROP INDEX idx_engineering_loops_active");
    db.close();

    assert.throws(() => createSqliteLoopRepository(dbPath), { code: "SCHEMA_INTEGRITY_VIOLATION" });
  });

  it("refuses to open a non-empty database that is not a loops database at all", async () => {
    const dbPath = tempDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY) STRICT");
    db.close();

    assert.throws(() => createSqliteLoopRepository(dbPath), { code: "SCHEMA_INTEGRITY_VIOLATION" });
  });
});
