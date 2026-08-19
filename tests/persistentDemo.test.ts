/**
 * Headless coverage of `sf demo:persistent` (acceptance criterion 7): a
 * first run seeds and reaches DONE; a second run against the same database
 * path reads back the state without re-seeding.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { runPersistentDemo } from "../src/cli/persistentDemo.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";

describe("persistent demo", () => {
  after(cleanupTempDbs);

  it("seeds on first run and reads back unchanged on a second run against the same file", async () => {
    const dbPath = tempDbPath("persistent-demo-");

    const first = await runPersistentDemo({ dbPath });
    assert.equal(first.seeded, true);
    assert.equal(first.finalStatus, "DONE");
    assert.ok(first.runCount > 0);
    assert.ok(first.evidenceCount > 0);

    const second = await runPersistentDemo({ dbPath });
    assert.equal(second.seeded, false, "the second run must not re-seed");
    assert.equal(second.workItemId, first.workItemId);
    assert.equal(second.finalStatus, "DONE");
    assert.equal(second.runCount, first.runCount);
    assert.equal(second.evidenceCount, first.evidenceCount);
  });
});
