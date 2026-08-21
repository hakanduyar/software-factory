import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createInMemoryLoopRepository } from "../src/adapters/orchestration/inMemoryLoopRepository.js";
import { human } from "../src/domain/actor.js";
import type { EngineeringLoop } from "../src/orchestration/loopTypes.js";

function fixtureLoop(overrides: Partial<EngineeringLoop> = {}): EngineeringLoop {
  return {
    id: "loop-test",
    workItemId: "wi-test",
    version: 1,
    phase: "READY",
    budget: { maxIterations: 3 },
    implementer: { tool: "claude-code", model: "m" },
    reviewer: { tool: "codex-cli", model: "m" },
    verificationCommands: [{ id: "c", executable: "node", argv: ["-e", "1"] }],
    workspaceRoot: "/tmp/does-not-matter",
    taskInstructions: "do the thing",
    iterations: [],
    totalRunCount: 0,
    cancelRequested: false,
    startedBy: human("user:test", "Test"),
    startedAt: 0,
    lastTransitionAt: 0,
    ...overrides,
  };
}

describe("createInMemoryLoopRepository", () => {
  it("creates and reads back a loop", async () => {
    const repo = createInMemoryLoopRepository();
    const loop = fixtureLoop();
    await repo.create(loop);
    const found = await repo.findById(loop.id);
    assert.equal(found?.id, loop.id);
    assert.equal(found?.phase, "READY");
  });

  it("refuses to create a second loop with the same id", async () => {
    const repo = createInMemoryLoopRepository();
    await repo.create(fixtureLoop());
    await assert.rejects(repo.create(fixtureLoop()), { code: "CONCURRENCY_CONFLICT" });
  });

  it("compareAndSave succeeds when the expected version matches and fails otherwise", async () => {
    const repo = createInMemoryLoopRepository();
    const loop = fixtureLoop();
    await repo.create(loop);

    const updated = await repo.compareAndSave({ ...loop, version: 2, phase: "IMPLEMENTING" }, 1);
    assert.equal(updated.phase, "IMPLEMENTING");

    await assert.rejects(repo.compareAndSave({ ...loop, version: 2, phase: "VERIFYING" }, 1), { code: "CONCURRENCY_CONFLICT" });
  });

  it("returns undefined for a missing loop", async () => {
    const repo = createInMemoryLoopRepository();
    assert.equal(await repo.findById("nope"), undefined);
  });

  it("lists only loops belonging to the given work item (multiple only when earlier ones are terminal)", async () => {
    const repo = createInMemoryLoopRepository();
    const terminal = {
      phase: "CANCELLED" as const,
      outcome: "CANCELLED" as const,
      cancelRequested: true,
    };
    await repo.create(fixtureLoop({ id: "loop-a", workItemId: "wi-a", ...terminal }));
    await repo.create(fixtureLoop({ id: "loop-b", workItemId: "wi-b" }));
    await repo.create(fixtureLoop({ id: "loop-c", workItemId: "wi-a" }));

    const forA = await repo.listByWorkItem("wi-a");
    assert.deepEqual(
      forA.map((loop) => loop.id).sort(),
      ["loop-a", "loop-c"],
    );
  });

  it("refuses a second ACTIVE loop for the same work item at the persistence level (PART E)", async () => {
    const repo = createInMemoryLoopRepository();
    await repo.create(fixtureLoop({ id: "loop-a", workItemId: "wi-a" }));
    await assert.rejects(repo.create(fixtureLoop({ id: "loop-b", workItemId: "wi-a" })), { code: "CONCURRENCY_CONFLICT" });
  });

  it("allows a new loop once every prior loop for the work item is terminal", async () => {
    const repo = createInMemoryLoopRepository();
    const loop = fixtureLoop({ id: "loop-a", workItemId: "wi-a" });
    await repo.create(loop);
    await repo.compareAndSave({ ...loop, version: 2, phase: "CANCELLED", outcome: "CANCELLED", cancelRequested: true }, 1);
    const second = await repo.create(fixtureLoop({ id: "loop-b", workItemId: "wi-a" }));
    assert.equal(second.id, "loop-b");
  });

  it("freezes stored loops so a caller cannot mutate durable state through a retained reference", async () => {
    const repo = createInMemoryLoopRepository();
    const loop = fixtureLoop();
    const created = await repo.create(loop);
    assert.throws(() => {
      (created as { phase: string }).phase = "TAMPERED";
    });
  });
});
