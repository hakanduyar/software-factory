/**
 * TASK-006 REMEDIATION ROUND 9 — permanent reproductions of the ninth
 * independent review's three HIGH findings.
 *
 * No CRITICAL, and the financial assessment came back clean: *"I found no path
 * through the supervisor gate that classified a chargeable action as free or
 * executed it autonomously."* That is the property the whole task exists to
 * hold, and it is the first round in which an adversarial reviewer failed to
 * find a way through it.
 *
 *   R9-SEC-1  the supervisor sanitizes what it WRITES; the CLI printed what it
 *             READS. Token-shaped text placed in a roadmap title, a resource
 *             diagnostic, an escalation, or the financial policy came straight
 *             back out of `status`, `resources` and `roadmap` — including
 *             through the policy PARSE ERROR, which quotes the bad value.
 *   R9-C4-1   a forged implementer history naming a REAL catalog resource is
 *             recognised, so recognition alone cannot establish lineage.
 *             Partially mitigated; the residue is a stated trust boundary.
 *   R9-C3-1   two round-8 regressions passed for the wrong reason — one asserted
 *             against parsed state (the parser drops undeclared fields, hiding
 *             the very secret under test) and one depended on read-ordering
 *             exhausting a counter. Both repaired in
 *             `task006RemediationRound8Repro.test.ts`.
 *
 * Offline: no provider is contacted, no model is invoked, no money can be spent.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createSqliteSupervisorRepository } from "../src/adapters/supervision/sqliteSupervisorRepository.js";
import {
  runSuperviseResources,
  runSuperviseRoadmap,
  runSuperviseStatus,
} from "../src/cli/supervise.js";
import { NO_BACKOFF } from "../src/supervision/resourceTypes.js";
import type { RoadmapItem } from "../src/supervision/supervisorTypes.js";
import {
  anchorFor,
  appendProvenance,
  type ProvenanceEntry,
} from "../src/supervision/provenanceChain.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import { declarePersisted, newSupervisor, scriptedProbe, T0, TEST_CATALOG } from "./support/supervisorFixtures.js";

after(cleanupTempDbs);

/**
 * A provenance chain naming `resource` as an implementer of `roadmapKey`.
 *
 * Needed since TASK-012 AC-6: a DONE item whose class requires AI, with nothing
 * in the chain saying anything ran on it, is now a forged completion and is
 * refused. These fixtures are about a LATER question — who may review it — so
 * they have to get past that one first, with the record a real run would have
 * left.
 */
function chainNaming(roadmapKey: string, resource: string): readonly ProvenanceEntry[] {
  const appended = appendProvenance([], {
    kind: "IMPLEMENTED_BY",
    roadmapKey,
    resourceKey: resource,
    detail: "completed",
    recordedAt: 1_000,
  });
  if (!appended.ok) throw new Error("fixture chain did not build");
  return appended.chain;
}

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
// R9-SEC-1 (HIGH) — a database is not a trusted input
// =====================================================================

describe("TASK-006 R9-SEC-1: the CLI redacts what it reads, not only what it writes", () => {
  const LEAK = "sk-ant-api03-JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ";
  const LONG = "A".repeat(20_000);

  /**
   * Writes a hostile database directly — no supervisor involved. That is the
   * point: the supervisor's own writes are already sanitized, so a test that
   * goes through it cannot reach this. A restored backup, an older build, or
   * anything with file access produces exactly this.
   */
  async function hostileDatabase(): Promise<string> {
    const dbPath = tempDbPath("r9-sec-1");
    const repository = createSqliteSupervisorRepository(dbPath);
    const seeded = await repository.create({
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [
        {
          provider: "claude-code",
          model: "opus",
          key: "claude-code:opus",
          state: "PROVIDER_UNAVAILABLE",
          detectedAt: T0,
          lastCheckedAt: T0,
          backoff: NO_BACKOFF,
          diagnostic: `provider said ${LEAK} and then ${LONG}`,
        },
      ],
      roadmap: [
        {
          key: "ITEM",
          title: `Innocuous title ${LEAK}`,
          dependsOn: [],
          status: "WAITING_FOR_HUMAN_REQUIRED",
          workClass: "NORMAL_IMPLEMENTATION",
          order: 1,
          humanActionRequired: `Do the thing with ${LEAK}`,
        },
      ],
      checkpoints: [],
      escalations: [
        {
          roadmapKey: "ITEM",
          reason: "HUMAN_DECISION_REQUIRED",
          humanActionRequired: `Approve using ${LEAK}`,
          detail: `because ${LEAK}`,
          raisedAt: T0,
          resolved: false,
        },
      ],
      provenance: [],
      updatedAt: T0,
    });
    void seeded;
    repository.close();
    return dbPath;
  }

  for (const [name, run] of [
    ["status", runSuperviseStatus],
    ["resources", runSuperviseResources],
    ["roadmap", runSuperviseRoadmap],
  ] as const) {
    it(`sf supervise ${name} prints no credential from a hostile database`, async () => {
      const supervisorDbPath = await hostileDatabase();
      const lines: string[] = [];
      await run({ supervisorDbPath, log: (line) => lines.push(line) });

      assert.ok(lines.length > 0, `${name} printed nothing, so this proves nothing`);
      for (const line of lines) {
        assert.ok(!line.includes(LEAK), `${name} printed a credential: ${line.slice(0, 120)}`);
        assert.ok(!line.includes("sk-ant-"), `${name} printed a credential prefix`);
        assert.ok(line.length < 5_000, `${name} printed a ${line.length}-character line`);
      }
    });
  }

  it("redacts a credential quoted back by the POLICY PARSE ERROR", async () => {
    // The subtlest instance: the policy is untrusted, so the reason string
    // includes the offending value — which is attacker-controlled by definition.
    const dbPath = tempDbPath("r9-sec-1-policy");
    const repository = createSqliteSupervisorRepository(dbPath);
    await repository.create({
      version: 1,
      financialPolicy: `not-an-object ${LEAK}`,
      resources: [],
      roadmap: [],
      checkpoints: [],
      escalations: [],
      provenance: [],
      updatedAt: T0,
    });
    repository.close();

    const lines: string[] = [];
    await runSuperviseStatus({ supervisorDbPath: dbPath, log: (line) => lines.push(line) });

    const printed = lines.join("\n");
    assert.match(printed, /policy untrusted/, "the untrusted policy is still reported");
    assert.ok(!printed.includes(LEAK), "the parse error quoted a credential back");
  });
});

// =====================================================================
// R9-C4-1 (HIGH) — recognition is not authentication
// =====================================================================

describe("TASK-006 R9-C4-1: forged lineage is cross-checked, and the residue is stated", () => {
  /**
   * `chain` is EXPLICIT per case since TASK-012 AC-6.
   *
   * A DONE AI ancestor with nothing in the chain is now refused outright, so a
   * case about who may REVIEW it has to seed the record a real run would have
   * left. The case that is specifically about having no other record must not
   * seed one — that is its entire premise — and it now asserts the refusal.
   */
  async function reviewWith(item: Partial<RoadmapItem>, chain: readonly ProvenanceEntry[] = []) {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    const state = await supervisor.service.ensureInitialized();
    await supervisor.repository.compareAndSave(
      {
        ...state,
        version: state.version + 1,
        roadmap: [
          { key: "B", title: "Review of A", dependsOn: ["A"], status: "ELIGIBLE", workClass: "INDEPENDENT_REVIEW", order: 1 },
          {
            key: "A",
            title: "Implemented",
            dependsOn: [],
            status: "DONE",
            workClass: "NORMAL_IMPLEMENTATION",
            order: 2,
            attempts: 1,
            ...item,
          } as RoadmapItem,
        ],
        provenance: chain,
        provenanceAnchor: anchorFor(chain),
      },
      state.version,
    );
    await declarePersisted(supervisor);
    return { result: await supervisor.service.tick(), supervisor };
  }

  it("refuses when the history contradicts the recorded run configuration", async () => {
    // The forgery the ninth review demonstrated: Codex did the work, the history
    // is rewritten to say Claude. `lastRunConfig` is written by a different path
    // at a different time, so the two now have to agree.
    const { result, supervisor } = await reviewWith(
      {
        implementedByResourceKeys: ["claude-code:opus"],
        lastRunConfig: {
          requestedProvider: "codex-cli",
        requestedModel: "gpt-5.6-luna",
        effectiveProvider: "codex-cli",
        effectiveModel: "gpt-5.6-luna",
        verification: "VERIFIED_EFFECTIVE",
        argvEvidence: ["codex"],
        note: "",
      },
    });

    assert.equal(result.kind, "WAITING_FOR_HUMAN", "contradictory lineage must fail closed");
    for (const call of supervisor.executor.calls()) {
      assert.notEqual(call.item.key, "B");
    }
  });

  it("allows a review when the history and the run configuration agree", async () => {
    const { result } = await reviewWith(
      {
        implementedByResourceKeys: ["claude-code:opus"],
        lastRunConfig: {
          requestedProvider: "claude-code",
          requestedModel: "opus",
          effectiveProvider: "claude-code",
          effectiveModel: "opus",
          verification: "VERIFIED_EFFECTIVE",
          argvEvidence: ["claude"],
          note: "",
        },
      },
      chainNaming("A", "claude-code:opus"),
    );
    assert.equal(result.kind, "ADVANCED", "consistent lineage must not be blocked");
  });

  /**
   * THE RESIDUE THIS TEST DOCUMENTED IS NOW CLOSED — which is exactly what it
   * asked to happen.
   *
   * It used to assert ADVANCED and carried the note: "if this now fails, the
   * residual lineage gap has closed — update the trust-boundary note and this
   * comment." TASK-012 AC-6 closed it: a DONE item whose catalog class requires
   * AI, with nothing in the chain saying anything ran on it, is refused rather
   * than believed. A forged history naming a real resource no longer passes on
   * the strength of nothing else having been recorded.
   *
   * WHAT REMAINS, and is not closeable here: the chain has no secret. An
   * attacker who rewrites the chain AND its anchor together, consistently, is
   * still undetected. That is the limit the module header states, and it is a
   * different and deeper thing than the gap this case used to hold open.
   */
  it("REFUSES a forgery that no other record corroborates (closed by STATE_INTEGRITY)", async () => {
    const { result, supervisor } = await reviewWith({
      implementedByResourceKeys: ["claude-code:opus"],
    });
    assert.equal(
      result.kind,
      "WAITING_FOR_HUMAN",
      "a forged history with nothing to corroborate it was believed",
    );
    for (const call of supervisor.executor.calls()) {
      assert.notEqual(call.item.key, "B", "no review may run on an uncorroborated history");
    }
  });

});
