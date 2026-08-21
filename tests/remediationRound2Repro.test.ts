/**
 * TASK-004 remediation round 2 — permanent regression suite for the two
 * remaining HIGH findings of the independent Codex re-review (preserved
 * verbatim in AI-HANDOFF.md):
 *
 *   HIGH 1 — sqliteLoopRepository validated the active-loop partial unique
 *   index's name/uniqueness/partial-flag/columns but never its WHERE
 *   predicate, so a semantically wrong partial index could pass schema
 *   validation while permitting multiple active loops per WorkItem.
 *
 *   HIGH 2 — persisted action correlation metadata (actionId/correlationTag)
 *   was arbitrary trusted text (`ids.next("act")`), so a corrupted claim
 *   could be made to reference an older, unrelated terminal Factory Run;
 *   reconciliation would then adopt it and could reach WAITING_FOR_HUMAN
 *   through a lineage the current action never actually produced.
 *
 * PHASE 0 DISCIPLINE: every test here asserts the *correct* (post-fix)
 * behavior. To prove they actually reproduce the findings, this file was
 * first run against the pre-fix implementation (`git stash` of exactly the
 * three files the fix touches: sqliteLoopRepository.ts, loopSerialization.ts,
 * loopTypes.ts/engineeringLoopService.ts's canonical-identity change) and
 * confirmed failing — recorded in AI-HANDOFF.md's remediation round 2
 * section. These tests are permanent and must stay green from now on.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { createSqliteLoopRepository, validateActiveIndexPredicateSql } from "../src/adapters/orchestration/sqliteLoopRepository.js";
import { createInMemoryLoopRepository } from "../src/adapters/orchestration/inMemoryLoopRepository.js";
import { createNodeProcessRunner } from "../src/adapters/process/nodeProcessRunner.js";
import { resolveWorkspace } from "../src/adapters/workers/workspace.js";
import { human } from "../src/domain/actor.js";
import { createSequentialIdGenerator } from "../src/domain/ids.js";
import { EngineeringLoopService, type StartLoopInput } from "../src/orchestration/engineeringLoopService.js";
import type { LoopRepository } from "../src/orchestration/loopRepository.js";
import { canonicalActionId, correlationTag, type EngineeringLoop, type VerificationCommandConfig } from "../src/orchestration/loopTypes.js";
import { parseEngineeringLoop } from "../src/orchestration/loopSerialization.js";
import { asLoopWorkerFactory, createScriptedImplementerWorker, createScriptedReviewerWorker } from "../src/orchestration/scriptedLoopWorkers.js";
import { cleanupTempDbs, newFactory, seedWorkItem, tempDbPath, toReady, type TestFactory } from "./support/factoryFixtures.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./support/tempWorkspace.js";

after(() => {
  cleanupTempWorkspaces();
  cleanupTempDbs();
});

const ACTIVE_PHASES = ["READY", "IMPLEMENTING", "VERIFYING", "REVIEWING"] as const;

describe("remediation round 2 — HIGH 1: active-index WHERE predicate validation", () => {
  describe("validateActiveIndexPredicateSql (pure parser, PART 1 cases 1-7)", () => {
    it("1: accepts the exact correct predicate", () => {
      assert.doesNotThrow(() =>
        validateActiveIndexPredicateSql(
          "CREATE UNIQUE INDEX idx_engineering_loops_active ON engineering_loops(work_item_id)\n  WHERE phase IN ('READY', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING')",
          "idx_engineering_loops_active",
          ACTIVE_PHASES,
        ),
      );
    });

    it("2: accepts a harmless formatting variation (order, spacing, casing)", () => {
      assert.doesNotThrow(() =>
        validateActiveIndexPredicateSql(
          "CREATE UNIQUE INDEX idx ON t(work_item_id) where phase in ('REVIEWING','READY','VERIFYING','IMPLEMENTING')",
          "idx",
          ACTIVE_PHASES,
        ),
      );
    });

    it("3: rejects a missing WHERE clause entirely", () => {
      assert.throws(
        () => validateActiveIndexPredicateSql("CREATE UNIQUE INDEX idx ON t(work_item_id)", "idx", ACTIVE_PHASES),
        { code: "SCHEMA_INTEGRITY_VIOLATION" },
      );
    });

    it("4: rejects an inverted/wrong-shape predicate (NOT IN)", () => {
      assert.throws(
        () =>
          validateActiveIndexPredicateSql(
            "CREATE UNIQUE INDEX idx ON t(work_item_id) WHERE phase NOT IN ('DONE', 'CANCELLED')",
            "idx",
            ACTIVE_PHASES,
          ),
        { code: "SCHEMA_INTEGRITY_VIOLATION" },
      );
    });

    it("5: rejects a predicate omitting one required active phase (REVIEWING)", () => {
      assert.throws(
        () =>
          validateActiveIndexPredicateSql(
            "CREATE UNIQUE INDEX idx ON t(work_item_id) WHERE phase IN ('READY', 'IMPLEMENTING', 'VERIFYING')",
            "idx",
            ACTIVE_PHASES,
          ),
        { code: "SCHEMA_INTEGRITY_VIOLATION" },
      );
    });

    it("6: rejects a predicate that includes a terminal phase as if it were active", () => {
      assert.throws(
        () =>
          validateActiveIndexPredicateSql(
            "CREATE UNIQUE INDEX idx ON t(work_item_id) WHERE phase IN ('READY', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'WAITING_FOR_HUMAN')",
            "idx",
            ACTIVE_PHASES,
          ),
        { code: "SCHEMA_INTEGRITY_VIOLATION" },
      );
    });

    it("7: rejects an unrelated WHERE clause on a different column entirely", () => {
      assert.throws(
        () => validateActiveIndexPredicateSql("CREATE UNIQUE INDEX idx ON t(work_item_id) WHERE version > 0", "idx", ACTIVE_PHASES),
        { code: "SCHEMA_INTEGRITY_VIOLATION" },
      );
    });
  });

  describe("end to end: SQLite repository open (PART 12 INDEX A-D)", () => {
    function createMalformedLoopsDb(path: string, whereClause: string): void {
      const db = new DatabaseSync(path);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(`
        CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE engineering_loops (
          id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, phase TEXT NOT NULL,
          version INTEGER NOT NULL, data TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_engineering_loops_work_item_id ON engineering_loops(work_item_id);
      `);
      db.exec(`CREATE UNIQUE INDEX idx_engineering_loops_active ON engineering_loops(work_item_id) ${whereClause};`);
      db.prepare("INSERT INTO schema_meta (key, value) VALUES ('loop_schema_version', '2')").run();
      db.close();
    }

    it("A: same index name, correct unique/partial/columns, WRONG predicate — repository open is refused", () => {
      const dbPath = tempDbPath();
      // Structurally identical to the real index (unique, partial, over
      // work_item_id) but omits REVIEWING — PRAGMA index_list/index_info
      // alone cannot distinguish this from the real predicate.
      createMalformedLoopsDb(dbPath, "WHERE phase IN ('READY', 'IMPLEMENTING', 'VERIFYING')");
      assert.throws(() => createSqliteLoopRepository(dbPath), { code: "SCHEMA_INTEGRITY_VIOLATION" });
    });

    it("B/C: wrong active-phase set (inverted to exclude-terminal) — repository open is refused", () => {
      const dbPath = tempDbPath();
      createMalformedLoopsDb(dbPath, "WHERE phase NOT IN ('DONE', 'CANCELLED', 'WAITING_FOR_HUMAN', 'EXHAUSTED', 'FAILED', 'RECOVERY_REQUIRED')");
      assert.throws(() => createSqliteLoopRepository(dbPath), { code: "SCHEMA_INTEGRITY_VIOLATION" });
    });

    it("D: the real repository's own schema creation always produces a canonical, accepted index", () => {
      const dbPath = tempDbPath();
      const repo = createSqliteLoopRepository(dbPath);
      repo.close();
      // Reopening must also succeed — the canonical schema round-trips.
      const reopened = createSqliteLoopRepository(dbPath);
      reopened.close();
    });

    it("demonstrates the semantic harm directly: under the malformed predicate, SQLite itself permits two active rows for one work item", () => {
      const dbPath = tempDbPath();
      createMalformedLoopsDb(dbPath, "WHERE phase IN ('READY', 'IMPLEMENTING', 'VERIFYING')"); // REVIEWING omitted
      const db = new DatabaseSync(dbPath);
      const insert = db.prepare("INSERT INTO engineering_loops (id, work_item_id, phase, version, data) VALUES (?, ?, ?, ?, ?)");
      insert.run("loop-a", "wi-shared", "REVIEWING", 1, "{}");
      // A second "active" (REVIEWING) loop for the SAME work item — the real
      // predicate would make this a UNIQUE violation; the malformed one does
      // not, because REVIEWING falls outside its restricted set.
      assert.doesNotThrow(() => insert.run("loop-b", "wi-shared", "REVIEWING", 1, "{}"), "the malformed index fails to enforce uniqueness for REVIEWING");
      db.close();
      // And separately, the repository layer refuses to ever open this file.
      assert.throws(() => createSqliteLoopRepository(dbPath), { code: "SCHEMA_INTEGRITY_VIOLATION" });
    });
  });
});

const PASSING_COMMANDS: readonly VerificationCommandConfig[] = [
  { id: "trivial-pass", executable: process.execPath, argv: ["-e", "process.exit(0)"] },
];
const processRunner = createNodeProcessRunner({ killGraceMs: 100 });

function baseInput(workItemId: string, overrides: Partial<StartLoopInput> = {}): StartLoopInput {
  return {
    workItemId,
    actor: human("user:test", "Test Operator"),
    taskInstructions: "Implement the widget.",
    implementer: { tool: "claude-code", model: "test-model" },
    reviewer: { tool: "codex-cli", model: "test-model" },
    verificationCommands: PASSING_COMMANDS,
    workspace: resolveWorkspace(createTempWorkspace()),
    ...overrides,
  };
}

function makeService(fx: TestFactory, loops: LoopRepository): EngineeringLoopService {
  return new EngineeringLoopService({
    factory: fx.factory,
    loops,
    clock: fx.clock,
    ids: createSequentialIdGenerator(),
    processRunner,
    createImplementerWorker: asLoopWorkerFactory(createScriptedImplementerWorker()),
    createReviewerWorker: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["PASS"] })),
  });
}

/** A minimal, otherwise-valid loop row used as a base for hand-crafted corruption in the pure-parser tests below. */
function baseLoopJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "loop-x",
    workItemId: "wi-x",
    version: 1,
    phase: "READY",
    budget: { maxIterations: 3 },
    implementer: { tool: "claude-code", model: "m" },
    reviewer: { tool: "codex-cli", model: "m" },
    verificationCommands: [{ id: "c", executable: "node", argv: ["-e", "1"] }],
    workspaceRoot: "/tmp/x",
    taskInstructions: "do it",
    iterations: [],
    totalRunCount: 0,
    cancelRequested: false,
    startedBy: { id: "user:x", kind: "HUMAN", displayName: "X" },
    startedAt: 1000,
    lastTransitionAt: 2000,
    ...overrides,
  };
}

function expectRejected(row: Record<string, unknown>): void {
  assert.throws(() => parseEngineeringLoop(JSON.stringify(row), { id: "loop-x", workItemId: "wi-x", phase: row.phase as string, version: 1 }), {
    code: "PERSISTENCE_CORRUPTION",
  });
}

describe("remediation round 2 — HIGH 2: canonical action/correlation identity", () => {
  describe("pure loopSerialization validation", () => {
    it("E: rejects an arbitrary correlation tag even when actionId is canonical", () => {
      const actionId = canonicalActionId("loop-x", 1, "IMPLEMENT");
      expectRejected(
        baseLoopJson({
          phase: "IMPLEMENTING",
          iterations: [
            {
              iteration: 1,
              implementClaim: {
                actionId,
                kind: "IMPLEMENT",
                attempt: 1,
                ownerToken: "own-1",
                claimedAt: 1500,
                correlationTag: "totally-arbitrary-tag-not-derived-from-anything",
              },
            },
          ],
        }),
      );
    });

    it("F: rejects a mismatched canonical actionId (correlationTag recomputed to 'match' it is still rejected against the real canonical value)", () => {
      const forgedActionId = "loop-x:i1:IMPLEMENT-but-not-quite";
      expectRejected(
        baseLoopJson({
          phase: "IMPLEMENTING",
          iterations: [
            {
              iteration: 1,
              implementClaim: {
                actionId: forgedActionId,
                kind: "IMPLEMENT",
                attempt: 1,
                ownerToken: "own-1",
                claimedAt: 1500,
                correlationTag: correlationTag(forgedActionId, 1),
              },
            },
          ],
        }),
      );
    });

    it("I: an iteration-2 claim cannot reference iteration-1's action identity (prior-iteration adoption defense)", () => {
      const iter1ActionId = canonicalActionId("loop-x", 1, "IMPLEMENT");
      expectRejected(
        baseLoopJson({
          phase: "IMPLEMENTING",
          budget: { maxIterations: 3 },
          totalRunCount: 1, // matches iteration 1's one completed run — isolates the canonical-identity check as the only thing under test
          iterations: [
            {
              iteration: 1,
              implementClaim: {
                actionId: iter1ActionId,
                kind: "IMPLEMENT",
                attempt: 1,
                ownerToken: "own-1",
                claimedAt: 1500,
                correlationTag: correlationTag(iter1ActionId, 1),
              },
              implementerRunId: "run-old",
              implementerOutcome: "SUCCEEDED",
            },
            {
              iteration: 2,
              implementClaim: {
                // Forged: reuses iteration 1's canonical identity instead of iteration 2's.
                actionId: iter1ActionId,
                kind: "IMPLEMENT",
                attempt: 1,
                ownerToken: "own-2",
                claimedAt: 2500,
                correlationTag: correlationTag(iter1ActionId, 1),
              },
            },
          ],
        }),
      );
    });

    it("J: a claim embedding a foreign loop's id cannot be adopted by this loop", () => {
      const foreignActionId = canonicalActionId("loop-OTHER", 1, "IMPLEMENT");
      expectRejected(
        baseLoopJson({
          phase: "IMPLEMENTING",
          iterations: [
            {
              iteration: 1,
              implementClaim: {
                actionId: foreignActionId,
                kind: "IMPLEMENT",
                attempt: 1,
                ownerToken: "own-1",
                claimedAt: 1500,
                correlationTag: correlationTag(foreignActionId, 1),
              },
            },
          ],
        }),
      );
    });

    it("G/H: duplicate action identity / correlation tag across iterations is structurally impossible to construct without also failing canonical validation", () => {
      // Any row that tries to give iteration 2 the SAME actionId/correlationTag
      // as iteration 1 necessarily gives iteration 2 a non-canonical identity
      // for its own position (since canonicalActionId embeds the iteration
      // number) — so it is caught by the exact same per-claim check as F/I,
      // not by a separate duplicate-scan. Proven directly:
      const sharedActionId = canonicalActionId("loop-x", 1, "IMPLEMENT");
      const row = baseLoopJson({
        phase: "IMPLEMENTING",
        totalRunCount: 1, // matches iteration 1's one completed run — isolates the canonical-identity check as the only thing under test
        iterations: [
          {
            iteration: 1,
            implementClaim: {
              actionId: sharedActionId,
              kind: "IMPLEMENT",
              attempt: 1,
              ownerToken: "own-1",
              claimedAt: 1500,
              correlationTag: correlationTag(sharedActionId, 1),
            },
            implementerRunId: "run-old",
            implementerOutcome: "SUCCEEDED",
          },
          {
            iteration: 2,
            implementClaim: {
              actionId: sharedActionId, // duplicate of iteration 1's
              kind: "IMPLEMENT",
              attempt: 1,
              ownerToken: "own-2",
              claimedAt: 2500,
              correlationTag: correlationTag(sharedActionId, 1), // also duplicate
            },
          },
        ],
      });
      expectRejected(row);
    });

    it("PART 9: a takeover's bumped attempt cannot reconcile against the superseded attempt's tag", () => {
      const actionId = canonicalActionId("loop-x", 1, "IMPLEMENT");
      const attempt1Tag = correlationTag(actionId, 1);
      const attempt2Tag = correlationTag(actionId, 2);
      assert.notEqual(attempt1Tag, attempt2Tag, "different attempts of the same action must never share a correlation tag");
      // A row is valid with attempt=2 and the attempt-2 tag...
      assert.doesNotThrow(() =>
        parseEngineeringLoop(
          JSON.stringify(
            baseLoopJson({
              phase: "IMPLEMENTING",
              iterations: [
                {
                  iteration: 1,
                  implementClaim: { actionId, kind: "IMPLEMENT", attempt: 2, ownerToken: "own-2", claimedAt: 2500, correlationTag: attempt2Tag },
                },
              ],
            }),
          ),
          { id: "loop-x", workItemId: "wi-x", phase: "IMPLEMENTING", version: 1 },
        ),
      );
      // ...but not with attempt=2 declared while actually carrying attempt-1's tag.
      expectRejected(
        baseLoopJson({
          phase: "IMPLEMENTING",
          iterations: [
            {
              iteration: 1,
              implementClaim: { actionId, kind: "IMPLEMENT", attempt: 2, ownerToken: "own-2", claimedAt: 2500, correlationTag: attempt1Tag },
            },
          ],
        }),
      );
    });
  });

  describe("PART 7 — authoritative PASS defense: the reviewer's exact dangerous outcome, end to end", () => {
    it("a claim corrupted to reuse an older PASS-compatible lineage is rejected before any reconciliation, launch, or WAITING_FOR_HUMAN", async () => {
      const fx = newFactory();
      const item = await seedWorkItem(fx.factory);
      await toReady(fx.factory, item.id);
      const realLoops = createInMemoryLoopRepository();

      // Run iteration 1 to a genuine, real PASS at WAITING_FOR_HUMAN.
      const loop1 = await makeService(fx, realLoops).start(baseInput(item.id, { budget: { maxIterations: 3 } }));
      assert.equal(loop1.phase, "WAITING_FOR_HUMAN");
      const oldImplementerRunId = loop1.iterations[0]!.implementerRunId!;
      const runsBefore = await fx.factory.listRuns(item.id);
      assert.equal(runsBefore.length, 3, "sanity: implement + verify + review, all real");

      // Fresh work item + fresh loop, deliberately corrupted: a "current"
      // implement claim whose correlation tag is forged to be the EXACT
      // observed tag of iteration 1's OLD, already-PASSED run from the loop
      // above (a different loop entirely) — copied verbatim, the way a real
      // attacker would (declaredWorkerId is ordinary, non-secret Factory
      // data), not assumed to follow any particular scheme. This is what
      // makes the test meaningful both pre-fix (the tag was an opaque random
      // token) and post-fix (the tag is canonical) — either way, copying an
      // observed tag onto an unrelated claim must never be adoptable.
      const item2 = await seedWorkItem(fx.factory);
      await toReady(fx.factory, item2.id);
      const oldImplementerRun = runsBefore.find((run) => run.role === "IMPLEMENTER")!;
      const forgedTag = oldImplementerRun.declaredWorkerId;
      const corrupted: EngineeringLoop = {
        id: "loop-corrupted",
        workItemId: item2.id,
        version: 1,
        phase: "IMPLEMENTING",
        budget: { maxIterations: 3 },
        implementer: { tool: "claude-code", model: "test-model" },
        reviewer: { tool: "codex-cli", model: "test-model" },
        verificationCommands: PASSING_COMMANDS,
        workspaceRoot: resolveWorkspace(createTempWorkspace()).root,
        taskInstructions: "Implement the widget.",
        iterations: [
          {
            iteration: 1,
            implementClaim: {
              actionId: "forged-action-id-copied-from-an-observed-old-run",
              kind: "IMPLEMENT",
              attempt: 1,
              ownerToken: "own-attacker",
              claimedAt: 1500,
              correlationTag: forgedTag,
            },
            // Deliberately NOT setting implementerRunId directly (that path
            // is separately defended by engineeringLoopService's completed-
            // slot consistency check) — this reproduces the literal PART 0.B
            // recipe: a claim corrupted to *reconcile toward* an old Run.
          },
        ],
        totalRunCount: 0,
        cancelRequested: false,
        startedBy: human("user:attacker", "Attacker"),
        startedAt: 1000,
        lastTransitionAt: 1000,
      };

      // The row cannot even be created through the repository (create()
      // round-trips through the same parser via findById on next read in a
      // real adapter; for the in-memory adapter, which does not itself
      // parse, we still prove the SQLite adapter — the one actually used in
      // production — refuses this row outright).
      const dbPath = tempDbPath();
      const sqliteLoops = createSqliteLoopRepository(dbPath);
      try {
        await sqliteLoops.create(corrupted);
        await assert.rejects(makeService(fx, sqliteLoops).resume("loop-corrupted"), { code: "PERSISTENCE_CORRUPTION" });
      } finally {
        sqliteLoops.close();
      }

      // Zero new external side effects: no new verifier/reviewer run, no new
      // Review, WorkItem 2 never reached WAITING_FOR_HUMAN, and the original
      // loop's Runs remain exactly as they were.
      const runsForItem2 = await fx.factory.listRuns(item2.id);
      assert.equal(runsForItem2.length, 0, "zero worker launches must occur for the corrupted work item");
      assert.notEqual((await fx.factory.getWorkItem(item2.id)).status, "WAITING_FOR_HUMAN");
      const reviewsForItem2 = await fx.factory.listReviews(item2.id);
      assert.equal(reviewsForItem2.length, 0, "no Review may be recorded for the corrupted work item");
      assert.equal((await fx.factory.listRuns(item.id)).length, 3, "the original, legitimate loop's Runs are untouched");
      assert.equal(oldImplementerRunId.length > 0, true); // sanity reference retained, never adopted elsewhere
    });
  });
});
