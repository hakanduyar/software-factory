/**
 * Optimistic concurrency (WorkItem.version) protects against lost updates —
 * remediation of "add entity version/revision or compare-and-swap semantics
 * so concurrent transitions cannot silently overwrite status/history/runIds/
 * audit state".
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createInMemoryStore } from "../src/adapters/memory/inMemoryStore.js";
import { ConcurrencyError } from "../src/domain/errors.js";
import { AGENT, newFactory, seedWorkItem, workItemAt } from "./support/factoryFixtures.js";

describe("optimistic concurrency (repository layer)", () => {
  it("rejects compareAndSave when the stored version has moved on", async () => {
    const store = createInMemoryStore();
    const item = workItemAt("IDEA", "wi-1");
    await store.workItems.create(item);

    const firstWriter = { ...item, status: "ANALYSIS" as const, version: item.version + 1 };
    await store.workItems.compareAndSave(firstWriter, item.version);

    // A second writer that read the item before the first one committed
    // must not be able to silently overwrite that committed change.
    const secondWriterStale = { ...item, status: "BLOCKED" as const, version: item.version + 1 };
    await assert.rejects(store.workItems.compareAndSave(secondWriterStale, item.version), ConcurrencyError);

    const stored = await store.workItems.findById(item.id);
    assert.equal(stored?.status, "ANALYSIS", "the first writer's change must survive intact");
  });

  it("rejects create for an id that already exists (no silent replace)", async () => {
    const store = createInMemoryStore();
    const item = workItemAt("IDEA", "wi-1");
    await store.workItems.create(item);
    await assert.rejects(store.workItems.create(workItemAt("IDEA", "wi-1")), ConcurrencyError);
  });
});

describe("concurrent advance() calls (FactoryService layer)", () => {
  it("lets exactly one of two racing transitions win; the loser gets ConcurrencyError instead of a lost update", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await factory.advance(item.id, "ANALYSIS", AGENT);

    // Both callers read the item at the same version and race to commit two
    // different, individually valid transitions from ANALYSIS.
    const results = await Promise.allSettled([
      factory.advance(item.id, "PLAN_REVIEW", AGENT),
      factory.advance(item.id, "BLOCKED", AGENT),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    assert.equal(fulfilled.length, 1, "exactly one racing transition should win");
    assert.equal(rejected.length, 1, "the other should be rejected, not silently dropped or merged");
    assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof ConcurrencyError);

    const final = await factory.getWorkItem(item.id);
    assert.ok(final.status === "PLAN_REVIEW" || final.status === "BLOCKED");
    // history has exactly the winning transition appended once — never both,
    // never neither, never duplicated.
    assert.equal(final.history.length, 2);
  });
});
