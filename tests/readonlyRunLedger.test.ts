import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { openReadonlyRunLedger } from "../src/adapters/sqlite/readonlyRunLedger.js";
import { SCHEMA_VERSION } from "../src/adapters/sqlite/schema.js";
import {
  cleanupTempDbs,
  newSqliteFactory,
  registeredWorker,
  seedWorkItem,
  tempDbPath,
  toImplementing,
} from "./support/factoryFixtures.js";

after(cleanupTempDbs);

/** Persists one canonical run through the real writer, then closes the writer. */
async function persistCanonicalRun(dbPath: string) {
  const writer = newSqliteFactory(dbPath);
  try {
    const item = await seedWorkItem(writer.factory);
    await toImplementing(writer.factory, item.id);
    const worker = registeredWorker(writer.factory, "readonly-test-worker", ["IMPLEMENTER"]);
    const result = await writer.factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker,
      instructions: "fixture implementation",
    });
    return result.run;
  } finally {
    writer.store.close();
  }
}

function snapshot(path: string): Buffer {
  return readFileSync(path);
}

function assertBytesEqual(actual: Buffer, expected: Buffer, message: string): void {
  assert.ok(actual.equals(expected), message);
}

test("read-only ledger returns the canonical persisted run without mutating the database", async () => {
  const dbPath = tempDbPath("readonly-canonical");
  const run = await persistCanonicalRun(dbPath);
  const before = snapshot(dbPath);

  const first = openReadonlyRunLedger(dbPath);
  try {
    const found = await first.runs.findById(run.id);
    assert.deepStrictEqual(found, run);
    assert.equal(await first.runs.findById("run-does-not-exist"), undefined);

    assert.ok(found);
    assert.ok(Object.isFrozen(found));
    assert.ok(Object.isFrozen(found.evidenceIds));
    assert.throws(() => {
      (found as { id: string }).id = "tampered";
    }, TypeError);
    assert.throws(() => {
      (found.evidenceIds as string[]).push("tampered");
    }, TypeError);
    assert.deepStrictEqual(await first.runs.findById(run.id), run);
  } finally {
    first.close();
  }

  const second = openReadonlyRunLedger(dbPath);
  try {
    assert.deepStrictEqual(await second.runs.findById(run.id), run);
  } finally {
    second.close();
  }

  assertBytesEqual(snapshot(dbPath), before, "read-only access must not change database bytes");
});

test("read-only ledger refuses missing, empty, non-factory and unsupported-version databases unchanged", async () => {
  const missing = tempDbPath("readonly-missing");
  assert.equal(existsSync(missing), false);
  assert.throws(() => openReadonlyRunLedger(missing));
  assert.equal(existsSync(missing), false, "refused open must not create the file");

  const empty = tempDbPath("readonly-empty");
  writeFileSync(empty, "");

  const foreign = tempDbPath("readonly-foreign");
  const foreignDb = new DatabaseSync(foreign);
  try {
    foreignDb.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY, note TEXT)");
  } finally {
    foreignDb.close();
  }

  const unsupported = tempDbPath("readonly-version");
  await persistCanonicalRun(unsupported);
  const mutator = new DatabaseSync(unsupported);
  try {
    mutator
      .prepare("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'")
      .run(String(SCHEMA_VERSION + 1));
  } finally {
    mutator.close();
  }

  for (const path of [empty, foreign, unsupported]) {
    const baseline = snapshot(path);
    assert.throws(() => openReadonlyRunLedger(path), `expected refusal for ${path}`);
    assertBytesEqual(snapshot(path), baseline, `refused open must not modify ${path}`);
  }
});

test("read-only ledger rejects a run whose stored JSON identity disagrees with its row id", async () => {
  const dbPath = tempDbPath("readonly-corrupt");
  const run = await persistCanonicalRun(dbPath);

  const mutator = new DatabaseSync(dbPath);
  try {
    const row = mutator.prepare("SELECT rowid AS rid, data FROM runs WHERE id = ?").get(run.id) as
      | { rid: number; data: string }
      | undefined;
    assert.ok(row, "fixture run row must exist");
    const parsed = JSON.parse(row.data) as { id: string };
    assert.equal(parsed.id, run.id);
    parsed.id = "foreign-json-id";
    mutator.prepare("UPDATE runs SET data = ? WHERE id = ?").run(JSON.stringify(parsed), run.id);
  } finally {
    mutator.close();
  }

  const before = snapshot(dbPath);
  const reader = openReadonlyRunLedger(dbPath);
  try {
    await assert.rejects(async () => reader.runs.findById(run.id));
  } finally {
    reader.close();
  }
  assertBytesEqual(snapshot(dbPath), before, "rejected read must not change database bytes");
});
