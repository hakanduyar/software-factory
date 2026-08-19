/**
 * TASK-002 Remediation Round 2: regression tests for the two HIGH findings
 * from independent review.
 *
 * 1. `ensureSchema` trusted an existing database from `schema_meta` alone; a
 *    database with a matching version marker but an incomplete/hand-edited
 *    table shape (e.g. an `evidence` table missing its `PRIMARY KEY`) was
 *    accepted, silently losing append-only protection.
 * 2. Deserialization checked JSON shape/enums but never cross-checked the
 *    indexed SQL columns (`work_items.version`, `runs.status`, ...) against
 *    the JSON payload, and did not validate every domain lifecycle invariant
 *    (e.g. a RUNNING run with `finishedAt` set, or a WorkItem with a negative
 *    `version`) — so a hand-edited or divergent row could reach
 *    `FactoryService` as a trusted value.
 *
 * Every test here manipulates a database file directly with a second,
 * unrelated `DatabaseSync` connection to simulate "this file was not written
 * exclusively by well-behaved code from this build," which is exactly the
 * threat model TASK-002 requirement 5 ("validate data loaded from
 * persistence") targets.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { createSqliteStore } from "../src/adapters/sqlite/sqliteStore.js";
import { cleanupTempDbs, tempDbPath, workItemAt } from "./support/factoryFixtures.js";

/** A fresh temp DB path, tracked for cleanup (Round-2 review, LOW finding). */
function freshDbPath(): string {
  return tempDbPath("factory-corrupt-");
}

after(cleanupTempDbs);

/** A full schema + row-count snapshot, used to prove "refusal did not mutate the database." */
function snapshot(dbPath: string): unknown {
  const db = new DatabaseSync(dbPath);
  try {
    const master = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
    const tableNames = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (row) => row.name,
    );
    const counts = Object.fromEntries(
      tableNames.map((name) => [name, (db.prepare(`SELECT count(*) AS c FROM ${name}`).get() as { c: number }).c]),
    );
    return { master, counts };
  } finally {
    db.close();
  }
}

describe("persistence corruption — schema integrity (finding 1)", () => {
  it("A: refuses a database whose schema_version matches but a table's actual shape is incomplete (no PRIMARY KEY)", () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();

    const raw = new DatabaseSync(dbPath);
    raw.exec("DROP TABLE evidence");
    // Same schema_version, but the append-only identity constraint is gone.
    raw.exec("CREATE TABLE evidence (id TEXT, work_item_id TEXT NOT NULL, data TEXT NOT NULL) STRICT");
    raw.close();

    assert.throws(() => createSqliteStore(dbPath), { code: "SCHEMA_INTEGRITY_VIOLATION" });
  });

  it("A: because opening the malformed database is refused outright, duplicate Evidence ids can never reach the append-only check to bypass it", () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();

    const raw = new DatabaseSync(dbPath);
    raw.exec("DROP TABLE evidence");
    raw.exec("CREATE TABLE evidence (id TEXT, work_item_id TEXT NOT NULL, data TEXT NOT NULL) STRICT");
    raw.close();

    assert.throws(() => createSqliteStore(dbPath));
    // No FactoryStore was ever constructed against the malformed table, so
    // there is no `repos.evidence.save` call site left to exploit.
  });

  it("A: refuses a database with a work_items table missing its version column", () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();

    const raw = new DatabaseSync(dbPath);
    raw.exec("DROP TABLE work_items");
    raw.exec("CREATE TABLE work_items (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL) STRICT");
    raw.close();

    assert.throws(() => createSqliteStore(dbPath), { code: "SCHEMA_INTEGRITY_VIOLATION" });
  });

  it("A: refuses a database with a runs table missing its status column", () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();

    const raw = new DatabaseSync(dbPath);
    raw.exec("DROP TABLE runs");
    raw.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, data TEXT NOT NULL) STRICT");
    raw.close();

    assert.throws(() => createSqliteStore(dbPath), { code: "SCHEMA_INTEGRITY_VIOLATION" });
  });

  it("A: refuses a database missing an index relied on by repository queries", () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();

    const raw = new DatabaseSync(dbPath);
    raw.exec("DROP INDEX idx_approvals_subject");
    raw.close();

    assert.throws(() => createSqliteStore(dbPath), { code: "SCHEMA_INTEGRITY_VIOLATION" });
  });

  it("B: an incompatible schema_version is refused without mutating the database's schema or contents", () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();

    const raw = new DatabaseSync(dbPath);
    raw.exec("UPDATE schema_meta SET value = '999' WHERE key = 'schema_version'");
    raw.close();

    const before = snapshot(dbPath);
    assert.throws(() => createSqliteStore(dbPath), { code: "SCHEMA_VERSION_MISMATCH" });
    const afterRefusal = snapshot(dbPath);
    assert.deepEqual(afterRefusal, before, "refusing an incompatible database must not change its schema or contents");
  });

  it("refuses a database that has Factory-named tables but no schema_meta version marker at all", () => {
    const dbPath = freshDbPath();
    const raw = new DatabaseSync(dbPath);
    raw.exec("CREATE TABLE work_items (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL) STRICT");
    raw.close();

    assert.throws(() => createSqliteStore(dbPath), { code: "SCHEMA_INTEGRITY_VIOLATION" });
  });

  it("still initializes a genuinely fresh, empty database file normally", () => {
    const dbPath = freshDbPath();
    const store = createSqliteStore(dbPath);
    store.close();
    // Reopening must succeed against the now-initialized database.
    createSqliteStore(dbPath).close();
  });
});

describe("persistence corruption — SQL/JSON cross-check (finding 2)", () => {
  it("C: work_items.version disagreeing with the JSON data.version is rejected, not silently trusted", async () => {
    const dbPath = freshDbPath();
    const store = createSqliteStore(dbPath);
    const item = workItemAt("IDEA", "wi-cross-check");
    await store.workItems.create(item);
    store.close();

    const raw = new DatabaseSync(dbPath);
    const row = raw.prepare("SELECT data FROM work_items WHERE id = ?").get("wi-cross-check") as { data: string };
    const parsed = JSON.parse(row.data) as Record<string, unknown>;
    parsed.version = -1;
    raw.prepare("UPDATE work_items SET version = 77, data = ? WHERE id = 'wi-cross-check'").run(JSON.stringify(parsed));
    raw.close();

    const reopened = createSqliteStore(dbPath);
    await assert.rejects(reopened.workItems.findById("wi-cross-check"), { code: "PERSISTENCE_CORRUPTION" });
  });

  it("C: runs.status disagreeing with the JSON data.status is rejected", async () => {
    const dbPath = freshDbPath();
    const raw = new DatabaseSync(dbPath);
    createSqliteStore(dbPath).close();
    raw.close();

    const seeded = createSqliteStore(dbPath);
    const item = workItemAt("IMPLEMENTING", "wi-run-cross-check");
    await seeded.workItems.create(item);
    await seeded.runs.create({
      id: "run-cross-check",
      workItemId: item.id,
      specRevision: 1,
      role: "IMPLEMENTER",
      workerPrincipalId: "wp-a",
      declaredWorkerId: "worker-a",
      status: "RUNNING",
      claimsAcceptanceMet: false,
      evidenceIds: [],
      startedAt: 1_800_000_000_000,
    });
    seeded.close();

    const raw2 = new DatabaseSync(dbPath);
    const row = raw2.prepare("SELECT data FROM runs WHERE id = ?").get("run-cross-check") as { data: string };
    const parsed = JSON.parse(row.data) as Record<string, unknown>;
    // SQL column still says RUNNING; JSON now claims a different status.
    parsed.status = "FAILED";
    parsed.finishedAt = 1_800_000_100_000;
    raw2.prepare("UPDATE runs SET data = ? WHERE id = 'run-cross-check'").run(JSON.stringify(parsed));
    raw2.close();

    const reopened = createSqliteStore(dbPath);
    await assert.rejects(reopened.runs.findById("run-cross-check"), { code: "PERSISTENCE_CORRUPTION" });
  });

  it("C: approvals.subject_id disagreeing with the JSON subject.id is rejected", async () => {
    const dbPath = freshDbPath();
    const store = createSqliteStore(dbPath);
    await store.approvals.save({
      id: "apr-cross-check",
      gate: "PUBLISH_APPROVAL",
      subject: { type: "WORK_ITEM", id: "wi-real" },
      decision: "APPROVED",
      decidedBy: { id: "user:test", kind: "HUMAN", displayName: "Test Human" },
      decidedAt: 1_800_000_000_000,
    });
    store.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec("UPDATE approvals SET subject_id = 'wi-someone-else' WHERE id = 'apr-cross-check'");
    raw.close();

    const reopened = createSqliteStore(dbPath);
    await assert.rejects(reopened.approvals.findById("apr-cross-check"), { code: "PERSISTENCE_CORRUPTION" });
  });
});

/** Inserts a row bypassing every repository check, to construct an invalid persisted record directly. */
function rawInsert(dbPath: string, table: string, columns: Record<string, unknown>): void {
  const db = new DatabaseSync(dbPath);
  const names = Object.keys(columns);
  const placeholders = names.map(() => "?").join(", ");
  db.prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${placeholders})`).run(...(Object.values(columns) as never[]));
  db.close();
}

describe("persistence corruption — invalid domain values after JSON parse (finding 2)", () => {
  it("D: WorkItem with a negative version is rejected", async () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();
    const item = { ...workItemAt("IDEA", "wi-neg-version"), version: -1 };
    rawInsert(dbPath, "work_items", { id: item.id, project_id: item.projectId, version: -1, data: JSON.stringify(item) });

    const store = createSqliteStore(dbPath);
    await assert.rejects(store.workItems.findById("wi-neg-version"), { code: "PERSISTENCE_CORRUPTION" });
  });

  it("D: WorkItem with a non-integer version is rejected", async () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();
    const item = { ...workItemAt("IDEA", "wi-frac-version"), version: 1.5 };
    // SQLite INTEGER-affinity column stores 1.5 as 1.5 is not representable;
    // craft via a raw connection so the column and JSON both carry the value.
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("INSERT INTO work_items (id, project_id, version, data) VALUES (?, ?, ?, ?)").run(
      item.id,
      item.projectId,
      1,
      JSON.stringify(item),
    );
    db.close();

    const store = createSqliteStore(dbPath);
    await assert.rejects(store.workItems.findById("wi-frac-version"), { code: "PERSISTENCE_CORRUPTION" });
  });

  it("D: WorkItem with an invalid status is rejected", async () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();
    const item = { ...workItemAt("IDEA", "wi-bad-status"), status: "NOT_A_STATUS" };
    rawInsert(dbPath, "work_items", { id: item.id, project_id: item.projectId, version: item.version, data: JSON.stringify(item) });

    const store = createSqliteStore(dbPath);
    await assert.rejects(store.workItems.findById("wi-bad-status"), { code: "PERSISTENCE_CORRUPTION" });
  });

  it("D: WorkItem missing a required field is rejected", async () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();
    const item = workItemAt("IDEA", "wi-missing-field") as unknown as Record<string, unknown>;
    delete item.title;
    rawInsert(dbPath, "work_items", {
      id: item.id as string,
      project_id: item.projectId as string,
      version: item.version as number,
      data: JSON.stringify(item),
    });

    const store = createSqliteStore(dbPath);
    await assert.rejects(store.workItems.findById("wi-missing-field"), { code: "PERSISTENCE_CORRUPTION" });
  });

  it("D: WorkItem with a malformed history entry is rejected", async () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();
    const item = {
      ...workItemAt("IDEA", "wi-bad-history"),
      history: [{ from: "IDEA", to: "NOT_A_STATUS", actorId: "a", at: 1 }],
    } as unknown as Record<string, unknown> & { id: string; projectId: string; version: number };
    rawInsert(dbPath, "work_items", { id: item.id, project_id: item.projectId, version: item.version, data: JSON.stringify(item) });

    const store = createSqliteStore(dbPath);
    await assert.rejects(store.workItems.findById("wi-bad-history"), { code: "PERSISTENCE_CORRUPTION" });
  });

  it("D: WorkItem with blockedFrom set while status is not BLOCKED is rejected", async () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();
    const item = { ...workItemAt("IDEA", "wi-bad-blocked"), blockedFrom: "ANALYSIS" };
    rawInsert(dbPath, "work_items", { id: item.id, project_id: item.projectId, version: item.version, data: JSON.stringify(item) });

    const store = createSqliteStore(dbPath);
    await assert.rejects(store.workItems.findById("wi-bad-blocked"), { code: "PERSISTENCE_CORRUPTION" });
  });

  function baseRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "run-d",
      workItemId: "wi-d",
      specRevision: 1,
      role: "IMPLEMENTER",
      workerPrincipalId: "wp-a",
      declaredWorkerId: "worker-a",
      status: "RUNNING",
      claimsAcceptanceMet: false,
      evidenceIds: [],
      startedAt: 1_800_000_000_000,
      ...overrides,
    };
  }

  it("D: Run RUNNING with finishedAt present is rejected", async () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();
    const run = baseRun({ id: "run-running-finished", finishedAt: 1_800_000_100_000 });
    rawInsert(dbPath, "runs", { id: run.id, work_item_id: run.workItemId, status: run.status, data: JSON.stringify(run) });

    const store = createSqliteStore(dbPath);
    await assert.rejects(store.runs.findById("run-running-finished"), { code: "PERSISTENCE_CORRUPTION" });
  });

  it("D: Run SUCCEEDED without finishedAt is rejected", async () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();
    const run = baseRun({ id: "run-succeeded-no-finish", status: "SUCCEEDED" });
    rawInsert(dbPath, "runs", { id: run.id, work_item_id: run.workItemId, status: run.status, data: JSON.stringify(run) });

    const store = createSqliteStore(dbPath);
    await assert.rejects(store.runs.findById("run-succeeded-no-finish"), { code: "PERSISTENCE_CORRUPTION" });
  });

  it("D: Run with an invalid role is rejected", async () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();
    const run = baseRun({ id: "run-bad-role", role: "NOT_A_ROLE" });
    rawInsert(dbPath, "runs", { id: run.id, work_item_id: run.workItemId, status: run.status, data: JSON.stringify(run) });

    const store = createSqliteStore(dbPath);
    await assert.rejects(store.runs.findById("run-bad-role"), { code: "PERSISTENCE_CORRUPTION" });
  });

  it("D: Run with a non-positive specRevision is rejected", async () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();
    const run = baseRun({ id: "run-bad-specrev", specRevision: 0 });
    rawInsert(dbPath, "runs", { id: run.id, work_item_id: run.workItemId, status: run.status, data: JSON.stringify(run) });

    const store = createSqliteStore(dbPath);
    await assert.rejects(store.runs.findById("run-bad-specrev"), { code: "PERSISTENCE_CORRUPTION" });
  });

  it("D: Run with a non-numeric startedAt is rejected", async () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();
    const run = baseRun({ id: "run-bad-started", startedAt: "not-a-number" });
    rawInsert(dbPath, "runs", { id: run.id, work_item_id: run.workItemId, status: run.status, data: JSON.stringify(run) });

    const store = createSqliteStore(dbPath);
    await assert.rejects(store.runs.findById("run-bad-started"), { code: "PERSISTENCE_CORRUPTION" });
  });

  it("D: Run missing workerPrincipalId is rejected", async () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();
    const run = baseRun({ id: "run-missing-principal" }) as Record<string, unknown>;
    delete run.workerPrincipalId;
    rawInsert(dbPath, "runs", { id: run.id, work_item_id: run.workItemId, status: run.status, data: JSON.stringify(run) });

    const store = createSqliteStore(dbPath);
    await assert.rejects(store.runs.findById("run-missing-principal"), { code: "PERSISTENCE_CORRUPTION" });
  });

  it("D: Approval with an invalid gate is rejected", async () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();
    const approval = {
      id: "apr-bad-gate",
      gate: "NOT_A_GATE",
      subject: { type: "WORK_ITEM", id: "wi-d" },
      decision: "APPROVED",
      decidedBy: { id: "user:test", kind: "HUMAN", displayName: "Test Human" },
      decidedAt: 1_800_000_000_000,
    };
    rawInsert(dbPath, "approvals", {
      id: approval.id,
      subject_type: approval.subject.type,
      subject_id: approval.subject.id,
      data: JSON.stringify(approval),
    });

    const store = createSqliteStore(dbPath);
    await assert.rejects(store.approvals.findById("apr-bad-gate"), { code: "PERSISTENCE_CORRUPTION" });
  });

  it("D: Review with an invalid verdict is rejected", async () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();
    const review = {
      id: "rev-bad-verdict",
      workItemId: "wi-d",
      specRevision: 1,
      reviewedRunId: "run-impl",
      reviewerRunId: "run-review",
      kind: "DETERMINISTIC",
      reviewerPrincipalId: "wp-b",
      implementerPrincipalId: "wp-a",
      verdict: "MAYBE",
      findings: [],
      createdAt: 1_800_000_000_000,
    };
    rawInsert(dbPath, "reviews", { id: review.id, work_item_id: review.workItemId, data: JSON.stringify(review) });

    const store = createSqliteStore(dbPath);
    await assert.rejects(store.reviews.findById("rev-bad-verdict"), { code: "PERSISTENCE_CORRUPTION" });
  });

  it("D: Evidence with an invalid kind is rejected", async () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();
    const evidence = {
      id: "ev-bad-kind",
      workItemId: "wi-d",
      kind: "NOT_A_KIND",
      summary: "s",
      reference: "mock://x",
      createdAt: 1_800_000_000_000,
    };
    rawInsert(dbPath, "evidence", { id: evidence.id, work_item_id: evidence.workItemId, data: JSON.stringify(evidence) });

    const store = createSqliteStore(dbPath);
    await assert.rejects(store.evidence.findById("ev-bad-kind"), { code: "PERSISTENCE_CORRUPTION" });
  });

  it("D: AcceptanceCriterionVerification with an invalid result is rejected", async () => {
    const dbPath = freshDbPath();
    createSqliteStore(dbPath).close();
    const verification = {
      id: "acv-bad-result",
      criterionId: "ac-1",
      workItemId: "wi-d",
      specRevision: 1,
      implementationRunId: "run-impl",
      result: "MAYBE",
      verifierPrincipalId: "wp-b",
      verifierRunId: "run-verify",
      verifiedAt: 1_800_000_000_000,
    };
    rawInsert(dbPath, "verifications", { id: verification.id, work_item_id: verification.workItemId, data: JSON.stringify(verification) });

    const store = createSqliteStore(dbPath);
    await assert.rejects(store.verifications.listByWorkItem("wi-d"), { code: "PERSISTENCE_CORRUPTION" });
  });
});
