/**
 * TASK-006 REMEDIATION ROUND 10 — the four items the tenth review named as
 * must-fix-before-merge.
 *
 * Round 10 also ADJUDICATED the two open architectural boundaries, which is why
 * this is the last remediation round rather than another lap:
 *
 *   > "Deferring authenticated lineage provenance is legitimate for this
 *   >  scheduler-only merge, on the same architectural basis as
 *   >  EXECUTOR_ISOLATION."
 *
 * accepted because the shipped executor performs no autonomous work,
 * `EXECUTOR_WIRING` depends on both `EXECUTOR_ISOLATION` and `STATE_INTEGRITY`,
 * and the limitation is documented and pinned by a test.
 *
 *   R10-FIN-1  (CRITICAL) the PUBLIC minter took `billingMode` as a bare string,
 *              so any caller could assert that a metered resource was free. The
 *              supervisor's own path could not produce that — but a public API
 *              that lets a caller declare a resource free is a defect whoever
 *              currently calls it.
 *   R10-SEC-1  `describeTick` printed persisted `roadmapKey` and `actionId` raw.
 *              Identifiers felt like structure rather than content; that
 *              assumption is what made every earlier instance of this possible.
 *   R10-SEC-2  the top-level CLI error handler printed `Error.message` raw, and
 *              parse errors quote the offending persisted value back by design.
 *   R10-C3-1   the R8-ID getter test STILL passed for the wrong reason — the
 *              getters reported `opus` while routing had selected `sonnet`, so
 *              removing the snapshot produced a model MISMATCH and the refusal
 *              came from the wrong guard. Third time that one test was wrong.
 *
 * Offline: no provider is contacted, no model is invoked, no money can be spent.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { createSqliteSupervisorRepository } from "../src/adapters/supervision/sqliteSupervisorRepository.js";
import { runSuperviseTick } from "../src/cli/supervise.js";
import {
  evaluateFinancialSafety,
  launchAiWorkerAction,
  observeBilling,
  parseFinancialPolicy,
} from "../src/supervision/financialSafety.js";
import { DEFAULT_ROADMAP } from "../src/supervision/supervisorTypes.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import { launchWithObservedBilling, T0 } from "./support/supervisorFixtures.js";

after(cleanupTempDbs);

const DENY = parseFinancialPolicy({ autonomousSpendAllowed: false, autonomousSpendLimit: 0 });

// =====================================================================
// R10-FIN-1 (CRITICAL) — a billing mode cannot be asserted, only observed
// =====================================================================

describe("TASK-006 R10-FIN-1: the public minter cannot be told a resource is free", () => {
  it("treats a launch with NO observation as financial", () => {
    const action = launchAiWorkerAction({
      resourceKey: "metered-provider:metered-model",
      description: "run work",
    });
    const verdict = evaluateFinancialSafety(action, DENY);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.actionClass, "FINANCIAL_ACTION");
  });

  it("ignores a hand-built object shaped like an observation", () => {
    // The exploit, in its closest surviving form: fabricate the observation
    // rather than the string. It never went through `observeBilling`, so it is
    // not in the registry, so it is not an observation.
    const forged = {
      provider: "metered-provider",
      model: "metered-model",
      billingMode: "INCLUDED_SUBSCRIPTION" as const,
    };
    const action = launchAiWorkerAction({
      resourceKey: "metered-provider:metered-model",
      observation: forged,
      description: "run work",
    });
    const verdict = evaluateFinancialSafety(action, DENY);
    assert.equal(verdict.allowed, false, "an unregistered observation is no observation");
    assert.equal(verdict.actionClass, "FINANCIAL_ACTION");
  });

  it("ignores a real observation about a DIFFERENT resource", () => {
    // A genuine observation of a free resource, presented for a metered one.
    const elsewhere = observeBilling({
      provider: "claude-code",
      model: "opus",
      billingMode: "INCLUDED_SUBSCRIPTION",
    });
    const action = launchAiWorkerAction({
      resourceKey: "metered-provider:metered-model",
      observation: elsewhere,
      description: "run work",
    });
    assert.equal(evaluateFinancialSafety(action, DENY).allowed, false);
  });

  it("allows a launch whose observation matches the resource", () => {
    const observation = observeBilling({
      provider: "claude-code",
      model: "opus",
      billingMode: "INCLUDED_SUBSCRIPTION",
    });
    const action = launchAiWorkerAction({
      resourceKey: "claude-code:opus",
      observation,
      description: "run work",
    });
    const verdict = evaluateFinancialSafety(action, DENY);
    assert.equal(verdict.allowed, true, "an observed included subscription is still free");
    assert.equal(verdict.actionClass, "FREE_REMOTE_ACTION");
  });

  it("treats an observation of nothing as UNKNOWN, which is financial", () => {
    const observation = observeBilling({
      provider: "claude-code",
      model: "opus",
      billingMode: undefined,
    });
    const action = launchAiWorkerAction({
      resourceKey: "claude-code:opus",
      observation,
      description: "run work",
    });
    assert.equal(evaluateFinancialSafety(action, DENY).allowed, false);
  });

  it("still refuses a metered observation, however genuine", () => {
    for (const billingMode of ["USAGE_BILLED", "UNKNOWN"] as const) {
      const action = launchWithObservedBilling({
        resourceKey: "claude-code:opus",
        billingMode,
        description: "run work",
      });
      assert.equal(evaluateFinancialSafety(action, DENY).allowed, false, billingMode);
    }
  });
});

// =====================================================================
// R10-SEC-1 / R10-SEC-2 — the last two output paths
// =====================================================================

describe("TASK-006 R10-SEC-1: tick output redacts persisted identifiers too", () => {
  const LEAK = "sk-ant-api03-KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK";

  it("redacts a hostile roadmap key printed by `supervise tick`", async () => {
    const supervisorDbPath = tempDbPath("r10-sec-1");
    const repository = createSqliteSupervisorRepository(supervisorDbPath);
    await repository.create({
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [],
      roadmap: [
        {
          // An identifier is content too — that assumption is the whole finding.
          key: `BAD-${LEAK}`,
          title: "Hostile",
          dependsOn: [],
          status: "ELIGIBLE",
          workClass: "DETERMINISTIC",
          order: 1,
        },
      ],
      checkpoints: [],
      escalations: [],
      updatedAt: T0,
    });
    repository.close();

    const lines: string[] = [];
    await runSuperviseTick({ supervisorDbPath, log: (line) => lines.push(line) });

    assert.ok(lines.length > 0, "tick printed nothing, so this proves nothing");
    for (const line of lines) {
      assert.ok(!line.includes(LEAK), `tick printed a credential: ${line.slice(0, 140)}`);
      assert.ok(!line.includes("sk-ant-"), "tick printed a credential prefix");
    }
  });
});

describe("TASK-006 R10-SEC-2: the top-level CLI error boundary redacts too", () => {
  const LEAK = "sk-ant-api03-LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL";

  /**
   * Runs the REAL binary in a subprocess.
   *
   * The mutation run for this fix failed nothing, which was the useful result:
   * there was no test covering `main.ts`'s final `catch` at all, so the guard
   * could have been deleted silently. That handler is only reachable by an
   * uncaught throw escaping a command, which cannot be produced by calling an
   * exported function — so the test has to run the process.
   */
  it("prints no credential when a corrupt row makes the parser throw", async () => {
    const supervisorDbPath = tempDbPath("r10-sec-2");
    const repository = createSqliteSupervisorRepository(supervisorDbPath);
    await repository.create({
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [],
      roadmap: [],
      checkpoints: [],
      escalations: [],
      updatedAt: T0,
    });
    repository.close();

    // Corrupt the stored blob so parsing throws, quoting the bad value back.
    const db = new DatabaseSync(supervisorDbPath);
    const row = db.prepare("SELECT data FROM supervisor_state LIMIT 1").get() as
      | { data: string }
      | undefined;
    assert.ok(row !== undefined, "the seeded row exists");
    const corrupted = JSON.parse(row.data) as Record<string, unknown>;
    // The invalid value must BE the credential, because a parse error's job is
    // to quote the value it rejected — that is what makes it useful and what
    // makes it dangerous. An earlier version of this test put the credential in
    // a valid neighbouring field, so the error quoted something else and the
    // test passed with the redaction removed.
    corrupted["roadmap"] = [
      { key: "k", title: "t", dependsOn: [], status: `BAD-${LEAK}`, workClass: "DETERMINISTIC", order: 1 },
    ];
    db.prepare("UPDATE supervisor_state SET data = ?").run(JSON.stringify(corrupted));
    db.close();

    const result = spawnSync(
      process.execPath,
      ["dist/src/cli/main.js", "supervise", "status"],
      {
        encoding: "utf8",
        env: { ...process.env, FACTORY_SUPERVISOR_DB_PATH: supervisorDbPath },
      },
    );

    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.ok(output.trim().length > 0, "the CLI printed nothing, so this proves nothing");
    assert.ok(!output.includes(LEAK), `the error boundary printed a credential: ${output.slice(0, 200)}`);
    assert.ok(!output.includes("sk-ant-"), "nor a credential prefix");
  });
});

// =====================================================================
// The adjudicated boundaries stay wired shut
// =====================================================================

describe("TASK-006: both deferred boundaries block anything that executes work", () => {
  it("keeps EXECUTOR_ISOLATION and STATE_INTEGRITY ahead of EXECUTOR_WIRING", () => {
    const wiring = DEFAULT_ROADMAP.find((entry) => entry.key === "EXECUTOR_WIRING");
    assert.ok(wiring !== undefined);
    assert.ok(
      wiring.dependsOn.includes("EXECUTOR_ISOLATION"),
      "the executor capability boundary must gate wiring",
    );
    assert.ok(
      wiring.dependsOn.includes("STATE_INTEGRITY"),
      "the state/provenance boundary must gate wiring",
    );
    for (const key of ["EXECUTOR_ISOLATION", "STATE_INTEGRITY"]) {
      const gate = DEFAULT_ROADMAP.find((entry) => entry.key === key);
      assert.ok(gate !== undefined, `${key} is a tracked roadmap item`);
      assert.ok(gate.order < wiring.order, `${key} is ordered before wiring`);
    }
  });

  it("has a roadmap whose orders are unique, so selection is deterministic", () => {
    const orders = DEFAULT_ROADMAP.map((entry) => entry.order);
    assert.equal(new Set(orders).size, orders.length, `duplicate order values: ${orders.join(", ")}`);
  });

  it("has no dangling dependency in the shipped roadmap", () => {
    const keys = new Set(DEFAULT_ROADMAP.map((entry) => entry.key));
    for (const entry of DEFAULT_ROADMAP) {
      for (const dependency of entry.dependsOn) {
        assert.ok(keys.has(dependency), `${entry.key} depends on unknown ${dependency}`);
      }
    }
  });
});
