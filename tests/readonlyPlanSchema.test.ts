import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  assertReadonlyPlanSchemaV2,
  createSqlitePlanRepository,
  upgradePlanSchemaV1ToV2,
} from "../src/adapters/planning/sqlitePlanRepository.js";
import { SchemaIntegrityError, SchemaVersionError } from "../src/domain/errors.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";

after(cleanupTempDbs);

function v1Fixture(): string {
  const path = tempDbPath("readonly-plan-schema-");
  createSqlitePlanRepository(path).close();
  return path;
}

function v2Fixture(): string {
  const path = v1Fixture();
  upgradePlanSchemaV1ToV2(path);
  return path;
}

function storedVersion(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'plan_schema_version'").get() as { value: string };
    return row.value;
  } finally {
    db.close();
  }
}

function runAssertion(path: string): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assertReadonlyPlanSchemaV2(db);
  } finally {
    db.close();
  }
}

describe("assertReadonlyPlanSchemaV2", () => {
  it("accepts a valid v2 database through a read-only handle without changing its bytes", () => {
    const path = v2Fixture();
    const before = readFileSync(path);
    assert.doesNotThrow(() => runAssertion(path));
    assert.ok(before.equals(readFileSync(path)));
  });

  it("rejects a genuine v1 database with SchemaVersionError and leaves it unchanged", () => {
    const path = v1Fixture();
    const before = readFileSync(path);
    assert.equal(storedVersion(path), "1");
    assert.throws(() => runAssertion(path), SchemaVersionError);
    assert.ok(before.equals(readFileSync(path)));
    assert.equal(storedVersion(path), "1");
  });

  it("rejects a v2 database missing plan_request_links with SchemaIntegrityError and leaves it unchanged", () => {
    const path = v2Fixture();
    const mutator = new DatabaseSync(path);
    try {
      mutator.exec("DROP TABLE plan_request_links");
    } finally {
      mutator.close();
    }
    const before = readFileSync(path);
    assert.throws(() => runAssertion(path), SchemaIntegrityError);
    assert.ok(before.equals(readFileSync(path)));
  });
});
