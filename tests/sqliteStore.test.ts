/**
 * Runs the shared store contract (tests/support/storeContract.ts) against
 * both adapters to prove they satisfy the same behavioral guarantees
 * (TASK-002 acceptance criterion 5). In-memory tests are included here too
 * so a single file shows the parity at a glance; the full in-memory test
 * suite (approvals/workflowService/etc.) already exercises the in-memory
 * adapter far beyond this contract.
 */

import { describe } from "node:test";

import { createInMemoryStore } from "../src/adapters/memory/inMemoryStore.js";
import { createSqliteStore } from "../src/adapters/sqlite/sqliteStore.js";
import { runStoreContractTests } from "./support/storeContract.js";

describe("store contract — in-memory adapter", () => {
  runStoreContractTests(() => createInMemoryStore());
});

describe("store contract — SQLite adapter (:memory:)", () => {
  runStoreContractTests(() => createSqliteStore(":memory:"));
});
