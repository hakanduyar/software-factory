/**
 * TASK-008 — STATE_INTEGRITY.
 *
 * The problem, from TASK-006 review round 9 (R9-C4-1): implementer lineage is a
 * recorded historical fact living in a mutable database row, so anything able to
 * write that database can rewrite who built what — and a reviewer that should
 * have been excluded proceeds.
 *
 * The answer here is deliberately NOT "make forgery impossible". It cannot be,
 * without a key this machine does not have. It is two independent layers that
 * each raise the cost and are honest about their ceiling:
 *
 *   - a SECOND record of the same events, hash-chained, so an edit to one record
 *     and not the other is visible; and
 *   - file permissions, which stop other local users and nothing else.
 *
 * Every test here drives the real supervisor and the real SQLite adapter. The
 * lesson of rounds 6, 8 and 10 was that mutating a guard's INPUT proves nothing
 * about the guard, so the tampering below is done to persisted state exactly as
 * an attacker with file access would.
 *
 * Offline: no provider is contacted, no model is invoked, no money can be spent.
 */

import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { after, describe, it } from "node:test";

import { createSqliteSupervisorRepository } from "../src/adapters/supervision/sqliteSupervisorRepository.js";
import { runSuperviseStatus } from "../src/cli/supervise.js";
import {
  appendProvenance,
  computeDigest,
  GENESIS_DIGEST,
  MAX_CHAIN_ENTRIES,
  verifyChain,
  type ProvenanceEntry,
} from "../src/supervision/provenanceChain.js";
import type { RoadmapItem } from "../src/supervision/supervisorTypes.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import { newSupervisor, scriptedProbe, TEST_CATALOG } from "./support/supervisorFixtures.js";

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

/** A chain naming `resource` as the implementer of item `A`. */
function chainFor(resource: string, recordedAt = 1_000): readonly ProvenanceEntry[] {
  const appended = appendProvenance([], {
    kind: "IMPLEMENTED_BY",
    roadmapKey: "A",
    resourceKey: resource,
    detail: "completed",
    recordedAt,
  });
  assert.equal(appended.ok, true);
  if (!appended.ok) throw new Error("unreachable");
  return appended.chain;
}

/**
 * A review of `B`, whose dependency `A` was implemented — with whatever lineage
 * the caller wants in the mutable row and whatever chain in durable state.
 */
async function reviewWith(input: {
  readonly item: Partial<RoadmapItem>;
  readonly provenance?: readonly ProvenanceEntry[];
}) {
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
          ...input.item,
        } as RoadmapItem,
      ],
      ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
    },
    state.version,
  );
  return { result: await supervisor.service.tick(), supervisor };
}

// =====================================================================
// AC-6 — the chain is a SECOND source, and disagreement fails closed
// =====================================================================

describe("TASK-008 AC-6: two records of lineage, and what happens when they differ", () => {
  it("allows the review when both records name the same implementer", async () => {
    const { result } = await reviewWith({
      item: { implementedByResourceKeys: ["claude-code:opus"] },
      provenance: chainFor("claude-code:opus"),
    });
    assert.equal(result.kind, "ADVANCED", "agreeing records must not block a review");
  });

  /**
   * The forgery R9-C4-1 demonstrated, now caught by the second record: the
   * mutable row is rewritten to name Claude, but the chain still says Codex did
   * the work. Editing one record and not the other is exactly what the chain is
   * for.
   */
  it("REFUSES when the chain contradicts the mutable row", async () => {
    const { result, supervisor } = await reviewWith({
      item: { implementedByResourceKeys: ["claude-code:opus"] },
      provenance: chainFor("codex-cli:gpt-5.6-luna"),
    });
    assert.equal(result.kind, "WAITING_FOR_HUMAN", "contradictory records must fail closed");
    for (const call of supervisor.executor.calls()) {
      assert.notEqual(call.item.key, "B", "no review may run on contradicted lineage");
    }
  });

  /**
   * Silence is not contradiction. A database written before this field existed
   * has no entries for work already done, and refusing every review on that
   * basis would strand the roadmap this was built to protect.
   */
  it("treats an EMPTY chain as no evidence rather than as disagreement", async () => {
    const { result } = await reviewWith({
      item: { implementedByResourceKeys: ["claude-code:opus"] },
      provenance: [],
    });
    assert.equal(result.kind, "ADVANCED", "an absent second record must not block a review");
  });

  /** A resource named only by the chain is still excluded from reviewing. */
  it("excludes an implementer the chain names even when the row omits it", async () => {
    const { result, supervisor } = await reviewWith({
      item: { implementedByResourceKeys: [] },
      provenance: chainFor("claude-code:opus"),
    });
    // The row and chain disagree (empty vs one entry), so this fails closed —
    // and the important half is that the review did NOT run on Claude.
    assert.equal(result.kind, "WAITING_FOR_HUMAN");
    for (const call of supervisor.executor.calls()) {
      assert.notEqual(call.item.key, "B");
    }
  });
});

// =====================================================================
// AC-5 — a broken chain fails closed for reviewer independence
// =====================================================================

describe("TASK-008 AC-5: unverifiable history stops a review, it does not proceed", () => {
  /** Each tamper is applied to a REAL chain, the way file access would. */
  const tampers: readonly (readonly [string, (chain: readonly ProvenanceEntry[]) => readonly ProvenanceEntry[]])[] = [
    [
      "an edited entry",
      (chain) => [{ ...chain[0]!, resourceKey: "codex-cli:gpt-5.6-luna" }],
    ],
    [
      "an entry appended with a wrong previous digest",
      (chain) => {
        const forged: ProvenanceEntry = {
          sequence: 1,
          kind: "IMPLEMENTED_BY",
          roadmapKey: "A",
          resourceKey: "codex-cli:gpt-5.6-luna",
          detail: "spliced",
          recordedAt: 2_000,
          previousDigest: GENESIS_DIGEST, // should chain to entry 0
          digest: "prov-whatever",
        };
        return [...chain, forged];
      },
    ],
  ];

  for (const [label, tamper] of tampers) {
    it(`REFUSES the review when durable state carries ${label}`, async () => {
      const { result, supervisor } = await reviewWith({
        item: { implementedByResourceKeys: ["claude-code:opus"] },
        provenance: tamper(chainFor("claude-code:opus")),
      });
      assert.equal(result.kind, "WAITING_FOR_HUMAN", `${label} must fail closed`);
      for (const call of supervisor.executor.calls()) {
        assert.notEqual(call.item.key, "B");
      }
    });
  }

  /**
   * A deleted entry, which is the tamper that matters most: removing the row
   * that names the implementer is how an excluded reviewer becomes eligible.
   */
  it("REFUSES when an entry has been deleted from the middle", async () => {
    let chain = chainFor("claude-code:opus", 1_000);
    const second = appendProvenance(chain, {
      kind: "IMPLEMENTED_BY",
      roadmapKey: "A",
      resourceKey: "codex-cli:gpt-5.6-luna",
      detail: "remediated",
      recordedAt: 2_000,
    });
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error("unreachable");
    chain = second.chain;
    assert.equal(verifyChain(chain).intact, true, "the fixture must be intact before tampering");

    // Delete the FIRST entry — the one naming Claude.
    const { result } = await reviewWith({
      item: { implementedByResourceKeys: ["claude-code:opus", "codex-cli:gpt-5.6-luna"] },
      provenance: [chain[1]!],
    });
    assert.equal(result.kind, "WAITING_FOR_HUMAN", "a deleted entry must fail closed");
  });
});

// =====================================================================
// AC-3 — each tamper is DETECTED and NAMED, deterministically (AC-4)
// =====================================================================

describe("TASK-008 AC-3/AC-4: verification names what is wrong, with no model involved", () => {
  const intact = (() => {
    let chain = chainFor("claude-code:opus", 1_000);
    for (const [resource, at] of [["codex-cli:gpt-5.6-luna", 2_000] as const, ["claude-code:opus", 3_000] as const]) {
      const next = appendProvenance(chain, {
        kind: "IMPLEMENTED_BY",
        roadmapKey: "A",
        resourceKey: resource,
        detail: "step",
        recordedAt: at,
      });
      assert.equal(next.ok, true);
      if (!next.ok) throw new Error("unreachable");
      chain = next.chain;
    }
    return chain;
  })();

  it("accepts an intact chain", () => {
    const verdict = verifyChain(intact);
    assert.equal(verdict.intact, true);
    if (verdict.intact) assert.equal(verdict.entries, 3);
  });

  it("names an EDITED entry by its sequence", () => {
    const edited = [...intact];
    edited[1] = { ...edited[1]!, detail: "changed after the fact" };
    const verdict = verifyChain(edited);
    assert.equal(verdict.intact, false);
    if (!verdict.intact) {
      assert.match(verdict.problem, /entry 1 was edited/);
      assert.equal(verdict.atSequence, 1);
    }
  });

  it("names a DELETED entry", () => {
    const verdict = verifyChain([intact[0]!, intact[2]!]);
    assert.equal(verdict.intact, false);
    if (!verdict.intact) assert.match(verdict.problem, /deleted or reordered/);
  });

  it("names a REORDERED pair", () => {
    const verdict = verifyChain([intact[1]!, intact[0]!, intact[2]!]);
    assert.equal(verdict.intact, false);
    if (!verdict.intact) assert.match(verdict.problem, /deleted or reordered/);
  });

  it("names an entry chained to the WRONG previous digest", () => {
    const spliced = [...intact];
    spliced[2] = { ...spliced[2]!, previousDigest: GENESIS_DIGEST };
    const verdict = verifyChain(spliced);
    assert.equal(verdict.intact, false);
    if (!verdict.intact) assert.match(verdict.problem, /chains to/);
  });

  /**
   * AC-4: deterministic and model-free. The same input gives the same verdict
   * every time, and the digest is a pure function of the entry's content.
   */
  it("is deterministic: the same chain verifies identically every time", () => {
    const first = verifyChain(intact);
    const second = verifyChain(intact);
    assert.deepEqual(first, second);
    const { digest: _ignored, ...content } = intact[1]!;
    void _ignored;
    assert.equal(computeDigest(content), computeDigest(content));
    assert.equal(computeDigest(content), intact[1]!.digest);
  });
});

// =====================================================================
// AC-10 — bounded, and overflow fails closed rather than forgetting
// =====================================================================

describe("TASK-008 AC-10: the chain is bounded and refuses rather than truncating", () => {
  it("refuses to append beyond the maximum instead of dropping the oldest", () => {
    // Constructed directly rather than by appending 10_000 times: what is being
    // tested is the refusal, not the loop.
    const full = Array.from({ length: MAX_CHAIN_ENTRIES }, (_unused, index) => ({
      sequence: index,
      kind: "IMPLEMENTED_BY" as const,
      roadmapKey: "A",
      detail: "filler",
      recordedAt: index,
      previousDigest: GENESIS_DIGEST,
      digest: "prov-filler",
    }));
    const result = appendProvenance(full, {
      kind: "IMPLEMENTED_BY",
      roadmapKey: "A",
      detail: "one too many",
      recordedAt: 1,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /maximum/);
      assert.match(result.reason, /discarding the oldest/);
    }
  });

  it("refuses to VERIFY an over-long chain rather than reading part of it", () => {
    const tooLong = Array.from({ length: MAX_CHAIN_ENTRIES + 1 }, (_unused, index) => ({
      sequence: index,
      kind: "IMPLEMENTED_BY" as const,
      roadmapKey: "A",
      detail: "filler",
      recordedAt: index,
      previousDigest: GENESIS_DIGEST,
      digest: "prov-filler",
    }));
    const verdict = verifyChain(tooLong);
    assert.equal(verdict.intact, false);
  });
});

// =====================================================================
// AC-7 — the database and its directory are not readable by other users
// =====================================================================

describe("TASK-008 AC-7: durable state is not world-readable", () => {
  it("creates the database and its directory owner-only", () => {
    const dbPath = tempDbPath("t8-perms");
    const repository = createSqliteSupervisorRepository(dbPath);
    try {
      const fileMode = statSync(dbPath).mode & 0o777;
      const dirMode = statSync(dirname(dbPath)).mode & 0o777;
      assert.equal(fileMode & 0o077, 0, `database is group/world accessible: ${fileMode.toString(8)}`);
      assert.equal(dirMode & 0o077, 0, `directory is group/world accessible: ${dirMode.toString(8)}`);
    } finally {
      repository.close();
    }
  });

  /**
   * Tightened on OPEN, not only at creation. A file created by an older build,
   * a restore, or a permissive umask would otherwise keep its original mode
   * forever — and "we set it correctly when we made it" says nothing about the
   * file actually in front of you.
   */
  it("tightens an ALREADY-LOOSE database when it is opened", async () => {
    const dbPath = tempDbPath("t8-loosen");
    const first = createSqliteSupervisorRepository(dbPath);
    first.close();

    const { chmodSync } = await import("node:fs");
    chmodSync(dbPath, 0o666);
    assert.notEqual(statSync(dbPath).mode & 0o077, 0, "the fixture must be loose before reopening");

    const second = createSqliteSupervisorRepository(dbPath);
    try {
      assert.equal(
        statSync(dbPath).mode & 0o077,
        0,
        "reopening must tighten a database that was left world-accessible",
      );
    } finally {
      second.close();
    }
  });
});

// =====================================================================
// AC-8 — the operator is told what this is, and what it is not
// =====================================================================

describe("TASK-008 AC-8: tamper-EVIDENT is stated where an operator reads it", () => {
  /** Seeds a real database whose chain is in the requested condition. */
  async function statusFor(provenance: readonly ProvenanceEntry[]): Promise<string> {
    const dbPath = tempDbPath("t8-status");
    const repository = createSqliteSupervisorRepository(dbPath);
    await repository.create({
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [],
      roadmap: [
        {
          key: "A",
          title: "Implemented",
          dependsOn: [],
          status: "DONE",
          workClass: "NORMAL_IMPLEMENTATION",
          order: 1,
        },
      ],
      checkpoints: [],
      escalations: [],
      provenance,
      updatedAt: 1_000,
    });
    repository.close();

    const lines: string[] = [];
    await runSuperviseStatus({ supervisorDbPath: dbPath, log: (line: string) => lines.push(line) });
    return lines.join("\n");
  }

  it("says so in `supervise status`, next to the verdict", async () => {
    const output = await statusFor(chainFor("claude-code:opus"));
    assert.match(output, /provenance\s*:/, "the chain must be reported at all");
    assert.match(output, /1 entries, chain intact/);
    assert.match(
      output,
      /tamper-evident, not tamper-proof/,
      "the distinction must be where an operator sees it, not only in a source comment",
    );
  });

  /**
   * And when it is broken, "intact" must not be what the operator reads. A
   * status line that looks the same either way is a status line nobody checks.
   */
  it("reports a BROKEN chain as broken, not merely as fewer entries", async () => {
    const tampered = chainFor("claude-code:opus").map((entry) => ({ ...entry, detail: "edited" }));
    const output = await statusFor(tampered);
    assert.match(output, /CHAIN BROKEN/);
    assert.ok(!/chain intact/.test(output), "a tampered chain must not read as intact");
    assert.match(output, /tamper-evident, not tamper-proof/);
  });

  it("states the same distinction in the module an implementer reads", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/supervision/provenanceChain.ts", "utf8");
    assert.match(source, /tamper-EVIDENT, not tamper-PROOF/);
    assert.match(source, /NO SECRET/, "the reason it cannot be tamper-proof must be stated");
  });
});

// =====================================================================
// AC-9 — nothing secret reaches the log
// =====================================================================

describe("TASK-008 AC-9: entries are bounded and redacted before they are hashed", () => {
  it("redacts a credential in the detail, and hashes the REDACTED text", () => {
    const appended = appendProvenance([], {
      kind: "IMPLEMENTED_BY",
      roadmapKey: "A",
      resourceKey: "claude-code:opus",
      detail: "token sk-proj-abcdefghijklmnopqrstuvwxyz0123 leaked into a detail",
      recordedAt: 1,
    });
    assert.equal(appended.ok, true);
    if (!appended.ok) throw new Error("unreachable");
    const entry = appended.chain[0]!;
    assert.ok(!entry.detail.includes("sk-proj-abcdefghijklmnopqrstuvwxyz0123"), "the credential must not be stored");

    // ...and the stored entry must still verify: redacting AFTER hashing would
    // make every entry fail its own digest.
    assert.equal(verifyChain(appended.chain).intact, true);
  });

  it("bounds an oversized detail", () => {
    const appended = appendProvenance([], {
      kind: "IMPLEMENTED_BY",
      roadmapKey: "A",
      detail: "A".repeat(20_000),
      recordedAt: 1,
    });
    assert.equal(appended.ok, true);
    if (!appended.ok) throw new Error("unreachable");
    assert.ok(appended.chain[0]!.detail.length < 20_000, "an unbounded string must not reach durable state");
  });
});
