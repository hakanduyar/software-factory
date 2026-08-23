/**
 * TASK-009 remediation — the independent review's three findings.
 *
 *   CRITICAL  a blocker on an item holding a CLAIMED action was erased by the
 *             next tick's claim reconciliation, after which the item ran and
 *             reached DONE. "Safe to retry the ACTION" had been conflated with
 *             "the ITEM may still proceed".
 *   HIGH      an `sk-proj-…` credential passed through the shared redactor
 *             untouched and reached durable state. The `sk-[A-Za-z0-9]{20,}`
 *             rule stops at the first hyphen.
 *   HIGH      `sf supervise roadmap` never printed the escalation reason or
 *             detail, so the resume information was durable but invisible —
 *             and AC-10's claim that it was recoverable from that command was
 *             simply wrong.
 *
 * Offline: no provider, no model, no money.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { redactSecrets } from "../src/adapters/workers/environmentPolicy.js";
import { runSuperviseRoadmap } from "../src/cli/supervise.js";
import { createSqliteSupervisorRepository } from "../src/adapters/supervision/sqliteSupervisorRepository.js";
import { canonicalActionId, type RoadmapItem } from "../src/supervision/supervisorTypes.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import { newSupervisor, scriptedProbe, seedRoadmap, T0, TEST_CATALOG } from "./support/supervisorFixtures.js";

after(cleanupTempDbs);

function healthyProbe() {
  const probe = scriptedProbe();
  for (const entry of TEST_CATALOG) {
    probe.set(entry.provider, entry.model, {
      state: "AVAILABLE",
      reason: "scripted",
      billingMode: "INCLUDED_SUBSCRIPTION",
    });
  }
  return probe;
}

// =====================================================================
// CRITICAL — a blocker outranks claim reconciliation
// =====================================================================

describe("TASK-009 remediation: clearing a claim never clears a blocker", () => {
  const ITEM: readonly RoadmapItem[] = [
    { key: "A", title: "Work", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
  ];

  /** Seeds an ACTIVE item holding an unlaunched CLAIMED action, then blocks it. */
  async function blockedWithClaim() {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    const seeded = await supervisor.service.ensureInitialized();
    await supervisor.repository.compareAndSave(
      {
        ...seeded,
        version: seeded.version + 1,
        roadmap: [{ ...ITEM[0]!, status: "ACTIVE", attempts: 1 }],
        activeClaim: {
          actionId: canonicalActionId("A", "LAUNCH_AI_WORKER", 1),
          roadmapKey: "A",
          kind: "LAUNCH_AI_WORKER",
          state: "CLAIMED",
          ownerId: "supervisor:gone",
          attempt: 1,
          claimedAt: T0,
        },
      },
      seeded.version,
    );
    await supervisor.service.recordBlocker({
      roadmapKey: "A",
      reason: "PLATFORM_CAPABILITY_BLOCKED",
      humanActionRequired: "lift the boundary",
      detail: "d",
    });
    return supervisor;
  }

  it("keeps the item blocked across the tick that clears the claim", async () => {
    const supervisor = await blockedWithClaim();

    await supervisor.service.tick();

    const state = await supervisor.repository.load();
    const item = state?.roadmap.find((entry) => entry.key === "A");
    assert.equal(item?.status, "WAITING_FOR_HUMAN_REQUIRED", "the blocker was erased by claim reconciliation");
    assert.equal(state?.activeClaim, undefined, "the unlaunched claim is still cleared - that part was correct");
  });

  it("never runs the blocked item, however many ticks pass", async () => {
    const supervisor = await blockedWithClaim();

    for (let i = 0; i < 4; i += 1) {
      await supervisor.service.tick();
    }

    const state = await supervisor.repository.load();
    assert.notEqual(state?.roadmap.find((entry) => entry.key === "A")?.status, "DONE");
    assert.equal(supervisor.executor.calls().length, 0, "a blocked item was executed");
  });

  it("still promotes an ordinary interrupted item, which is the point of clearing a claim", async () => {
    // The fix must not break the behaviour it is narrowing: an item with no
    // blocker still becomes ELIGIBLE when its unlaunched claim is cleared.
    const supervisor = newSupervisor({ probe: healthyProbe() });
    const seeded = await supervisor.service.ensureInitialized();
    await supervisor.repository.compareAndSave(
      {
        ...seeded,
        version: seeded.version + 1,
        roadmap: [{ ...ITEM[0]!, status: "ACTIVE", attempts: 1 }],
        activeClaim: {
          actionId: canonicalActionId("A", "LAUNCH_AI_WORKER", 1),
          roadmapKey: "A",
          kind: "LAUNCH_AI_WORKER",
          state: "CLAIMED",
          ownerId: "supervisor:gone",
          attempt: 1,
          claimedAt: T0,
        },
      },
      seeded.version,
    );

    const result = await supervisor.service.tick();

    assert.equal(result.kind, "ADVANCED", "an unblocked interrupted item must still resume");
  });
});

// =====================================================================
// HIGH — the shared redactor missed a current credential format
// =====================================================================

describe("TASK-009 remediation: sk-proj credentials are redacted", () => {
  const FORMATS = [
    "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcXYZ",
    "sk-svcacct-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "sk-admin-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  ];

  for (const secret of FORMATS) {
    it(`redacts ${secret.slice(0, 12)}…`, () => {
      const redacted = redactSecrets(`before ${secret} after`);
      assert.ok(!redacted.includes(secret), "the credential survived the shared redactor");
      assert.match(redacted, /\[REDACTED\]/);
    });
  }

  it("keeps redacting the formats it already handled", () => {
    for (const secret of [
      "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "ghp_abcdefghijklmnopqrstuvwxyz012345",
      "AKIAIOSFODNN7EXAMPLE",
    ]) {
      assert.ok(!redactSecrets(secret).includes(secret), `${secret} regressed`);
    }
  });

  it("does not eat ordinary text that merely starts with sk-", () => {
    // A redactor that over-matches trains people to ignore it, which is its own
    // way of failing.
    assert.equal(redactSecrets("sk-short"), "sk-short");
    assert.equal(redactSecrets("sk-proj-tiny"), "sk-proj-tiny");
  });

  it("blocks the credential end to end, through a recorded blocker", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    await seedRoadmap(supervisor, [
      { key: "A", title: "Work", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ]);
    const secret = FORMATS[0]!;

    await supervisor.service.recordBlocker({
      roadmapKey: "A",
      reason: "PLATFORM_CAPABILITY_BLOCKED",
      humanActionRequired: `use ${secret}`,
      detail: `token ${secret}`,
    });

    const state = await supervisor.repository.load();
    assert.ok(!JSON.stringify(state).includes(secret), "a project key reached durable state");
  });
});

// =====================================================================
// HIGH — AC-10: the resume information must be VISIBLE, not merely stored
// =====================================================================

describe("TASK-009 remediation: `roadmap` shows the blocker reason and detail", () => {
  it("prints enough to resume without any conversation", async () => {
    const supervisorDbPath = tempDbPath("t9-roadmap");
    const repository = createSqliteSupervisorRepository(supervisorDbPath);
    await repository.create({
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [],
      roadmap: [
        {
          key: "LOCAL_24_7_RUNTIME",
          title: "Reliable restartable WSL2 runtime",
          dependsOn: [],
          status: "WAITING_FOR_HUMAN_REQUIRED",
          workClass: "ARCHITECTURE_SECURITY",
          order: 1,
          humanActionRequired: "Lift the platform classifier",
        },
      ],
      checkpoints: [],
      escalations: [
        {
          roadmapKey: "LOCAL_24_7_RUNTIME",
          reason: "PLATFORM_CAPABILITY_BLOCKED",
          humanActionRequired: "Lift the platform classifier",
          detail: "spec docs/tasks/TASK-007-local-24-7-runtime.md, branch feat/local-24-7-runtime, commit 9d8417e",
          raisedAt: T0,
          resolved: false,
        },
      ],
      updatedAt: T0,
    });
    repository.close();

    const lines: string[] = [];
    await runSuperviseRoadmap({ supervisorDbPath, log: (line) => lines.push(line) });
    const printed = lines.join("\n");

    assert.match(printed, /PLATFORM_CAPABILITY_BLOCKED/, "the reason must be visible");
    assert.match(printed, /TASK-007-local-24-7-runtime\.md/, "the spec path must be visible");
    assert.match(printed, /feat\/local-24-7-runtime/, "the branch must be visible");
    assert.match(printed, /9d8417e/, "the commit must be visible");
  });

  it("says nothing extra for an item with no open blocker", async () => {
    const supervisorDbPath = tempDbPath("t9-roadmap-clean");
    const repository = createSqliteSupervisorRepository(supervisorDbPath);
    await repository.create({
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [],
      roadmap: [
        { key: "A", title: "Ordinary", dependsOn: [], status: "PENDING", workClass: "DETERMINISTIC", order: 1 },
      ],
      checkpoints: [],
      escalations: [],
      updatedAt: T0,
    });
    repository.close();

    const lines: string[] = [];
    await runSuperviseRoadmap({ supervisorDbPath, log: (line) => lines.push(line) });

    assert.ok(!lines.join("\n").includes("reason:"), "an unblocked item must not sprout a blocker line");
  });
});
