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
 * WHICH TESTS USE WHICH REPOSITORY — stated because round-1 review caught this
 * file claiming more than it delivered, and UPDATED in round 16 because the
 * statement went stale: the four tamper modes, the anchor-deletion case and the
 * reviewer-independence cases that need durable state now all drive REAL SQLite.
 * What remains in-memory is the service-level branch the deserializer refuses to
 * produce, and it says so in its own name. The AC-1 append-only cases and the AC-7
 * permission cases drive the REAL SQLite adapter, because that is where those
 * behaviours live. The reviewer-independence cases use `newSupervisor`, whose
 * default repository is IN-MEMORY: the decision under test there is in the
 * service, and the persisted round-trip is covered by
 * `supervisorStateRoundTrip.test.ts` and `supervisorPersistence.test.ts`.
 *
 * The lesson of rounds 6, 8 and 10 was that mutating a guard's INPUT proves
 * nothing about the guard, so the tampering below is done to state exactly as
 * something with write access would.
 *
 * Offline: no provider is contacted, no model is invoked, no money can be spent.
 */

import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { after, describe, it } from "node:test";

import {
  assertRestricted,
  createSqliteSupervisorRepository,
} from "../src/adapters/supervision/sqliteSupervisorRepository.js";
import { runSuperviseRoadmap, runSuperviseStatus } from "../src/cli/supervise.js";
import {
  anchorFor,
  appendProvenance,
  computeDigest,
  GENESIS_DIGEST,
  MAX_CHAIN_ENTRIES,
  verifyAgainstAnchor,
  verifyChain,
  type ProvenanceEntry,
} from "../src/supervision/provenanceChain.js";
import { appendImplementerProvenance } from "../src/supervision/supervisorService.js";
import { parseSupervisorState } from "../src/supervision/supervisorSerialization.js";
import type { WorkOutcome } from "../src/supervision/supervisorPorts.js";
import { DEFAULT_ROADMAP, type RoadmapItem } from "../src/supervision/supervisorTypes.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import {
  newSupervisor,
  scriptedExecutor,
  scriptedProbe,
  seedRoadmap,
  TEST_CATALOG,
} from "./support/supervisorFixtures.js";

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

/**
 * A minimal, otherwise-valid persisted state carrying exactly `entries`.
 *
 * Built as raw JSON rather than through the repository, because these cases are
 * about what the PARSER accepts from a row it did not write — a restore, an
 * older build, or anything with file access.
 */
function stateWith(entries: readonly unknown[]): unknown {
  return {
    version: 1,
    financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
    resources: [],
    roadmap: [
      { key: "A", title: "Implemented", dependsOn: [], status: "DONE", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ],
    checkpoints: [],
    escalations: [],
    provenance: entries,
    updatedAt: 1_000,
  };
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
  /**
   * The ancestor's work class, DECLARED as well as persisted.
   *
   * `workClass` is a definition field, so setting it through `input.item` alone
   * is tampering and TASK-012 refuses it — correctly. A case that wants a
   * genuinely deterministic ancestor has to say so in the catalog too.
   */
  readonly ancestorWorkClass?: RoadmapItem["workClass"];
}) {
  /**
   * The DEFINITION is declared in the catalog (TASK-012); the PROGRESS is
   * persisted.
   *
   * `input.item` is applied only to the persisted row, deliberately: a case that
   * overrides a definition field through it is TAMPERING, and must fail closed
   * rather than quietly redefining what the item is.
   */
  const ancestorWorkClass = input.ancestorWorkClass ?? "NORMAL_IMPLEMENTATION";
  const definitions: readonly RoadmapItem[] = [
    { key: "B", title: "Review of A", dependsOn: ["A"], status: "PENDING", workClass: "INDEPENDENT_REVIEW", order: 1 },
    { key: "A", title: "Implemented", dependsOn: [], status: "PENDING", workClass: ancestorWorkClass, order: 2 },
  ];
  const supervisor = newSupervisor({ probe: healthyProbe(), roadmap: definitions });
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
          workClass: ancestorWorkClass,
          order: 2,
          attempts: 1,
          ...input.item,
        } as RoadmapItem,
      ],
      /**
       * The anchor is ALWAYS recorded (round-9 CRITICAL).
       *
       * It used to be opt-in, which mirrored production — and that was the
       * defect: an optional anchor is one an attacker deletes. Production now
       * writes one with every chain, so a fixture without one is a state that
       * can no longer exist, and the `anchor` flag has nothing left to select.
       */
      ...(input.provenance === undefined
        ? {}
        : { provenance: input.provenance, provenanceAnchor: anchorFor(input.provenance) }),
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
   * Silence is not contradiction — for the EXCLUSION cross-check, which is the
   * question this describe block is about: given an ancestor, who must not
   * review it.
   *
   * NARROWED IN ROUND 9. The ancestor here is DETERMINISTIC, because an empty
   * chain under a DONE *AI* ancestor is no longer silence at all: TASK-012 AC-6
   * now reads it as a forged completion and refuses before this check is
   * reached. That is a deliberate change and it is asserted directly in
   * `tests/roadmapStructuralIntegrity.test.ts`; what survives here is the
   * narrower claim, that an absent second record is not by itself a
   * DISAGREEMENT.
   */
  it("treats an EMPTY chain as no evidence rather than as disagreement", async () => {
    const { result } = await reviewWith({
      ancestorWorkClass: "DETERMINISTIC",
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
  /**
   * DISCLOSED: this fixture uses repeated fake digests, so the chain is already
   * invalid. Round-3 review called it vacuous against the maximum guard, and it
   * is — `verifyChain` would refuse it for a different reason. It is kept only
   * because `appendProvenance` never verifies its input, so the LENGTH refusal
   * is genuinely what fires here. The guard is proven properly by
   * "REFUSES a VALID chain that is one entry too long", which builds a real one.
   */
  it("refuses to append beyond the maximum instead of dropping the oldest", () => {
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
      provenanceAnchor: anchorFor(provenance),
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
  /**
   * Tampered by writing the ROW DIRECTLY, because the repository now refuses to
   * persist a chain that does not verify — which is the correct behaviour and
   * makes `create()` the wrong way to build this fixture. An attacker with file
   * access does exactly this: edits the stored JSON, bypassing every write-path
   * guard. That is the case `supervise status` has to survive.
   */
  it("reports a BROKEN chain as broken, not merely as fewer entries", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const dbPath = tempDbPath("t8-status-broken");
    const repository = createSqliteSupervisorRepository(dbPath);
    const seeded = await repository.create({
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [],
      roadmap: [
        { key: "A", title: "Implemented", dependsOn: [], status: "DONE", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
      ],
      checkpoints: [],
      escalations: [],
      provenance: chainFor("claude-code:opus"),
      provenanceAnchor: anchorFor(chainFor("claude-code:opus")),
      updatedAt: 1_000,
    });
    repository.close();

    const db = new DatabaseSync(dbPath);
    const tamperedState = {
      ...seeded,
      provenance: seeded.provenance.map((entry) => ({ ...entry, detail: "edited after the fact" })),
    };
    db.prepare("UPDATE supervisor_state SET data = ? WHERE id = ?").run(
      JSON.stringify(tamperedState),
      "supervisor",
    );
    db.close();

    const lines: string[] = [];
    await runSuperviseStatus({ supervisorDbPath: dbPath, log: (line: string) => lines.push(line) });
    const output = lines.join("\n");
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

// =====================================================================
// ROUND-1 REMEDIATION — every finding, driven the way the reviewer drove it
// =====================================================================

describe("TASK-008 round 1: the six blocking findings", () => {
  /**
   * AC-2 — the reviewer moved a NUL into `resourceKey` and took the same bytes
   * out of `detail`, producing a DIFFERENT entry with an IDENTICAL digest. A
   * separator only works if it cannot occur inside a field.
   */
  it("gives different digests to entries that differ only in field boundaries", () => {
    const base = {
      sequence: 0,
      kind: "IMPLEMENTED_BY" as const,
      roadmapKey: "A",
      recordedAt: 1,
      previousDigest: GENESIS_DIGEST,
    };
    const shifted = computeDigest({ ...base, resourceKey: "claude-code:opus\u0000done", detail: "tail" });
    const original = computeDigest({ ...base, resourceKey: "claude-code:opus", detail: "done\u0000tail" });
    assert.notEqual(shifted, original, "field boundaries must not be forgeable by moving a separator");
  });

  it("gives different digests when a field merely gains the length-prefix shape", () => {
    const base = {
      sequence: 0,
      kind: "IMPLEMENTED_BY" as const,
      roadmapKey: "A",
      recordedAt: 1,
      previousDigest: GENESIS_DIGEST,
    };
    assert.notEqual(
      computeDigest({ ...base, detail: "4:abcd" }),
      computeDigest({ ...base, detail: "abcd" }),
      "content that looks like the encoding must not collide with the encoding",
    );
  });

  /**
   * AC-6 — the three bypasses. Each leaves a POPULATED, verifying chain that
   * says nothing about the item under review, which the first version treated
   * as silence.
   */
  it("REFUSES when the chain is populated but has no entry for this item", async () => {
    const { result, supervisor } = await reviewWith({
      item: { implementedByResourceKeys: ["claude-code:opus"] },
      // a valid chain, entirely about a DIFFERENT roadmap key
      provenance: (() => {
        const appended = appendProvenance([], {
          kind: "IMPLEMENTED_BY",
          roadmapKey: "B",
          resourceKey: "claude-code:opus",
          detail: "elsewhere",
          recordedAt: 1_000,
        });
        assert.equal(appended.ok, true);
        if (!appended.ok) throw new Error("unreachable");
        return appended.chain;
      })(),
    });
    assert.equal(result.kind, "WAITING_FOR_HUMAN", "a populated chain missing this item is a disagreement");
    for (const call of supervisor.executor.calls()) {
      assert.notEqual(call.item.key, "B");
    }
  });

  it("REFUSES when the chain holds only non-implementation events", async () => {
    const appended = appendProvenance([], {
      kind: "RUN_CONFIGURED",
      roadmapKey: "A",
      resourceKey: "claude-code:opus",
      detail: "configured",
      recordedAt: 1_000,
    });
    assert.equal(appended.ok, true);
    if (!appended.ok) throw new Error("unreachable");

    const { result } = await reviewWith({
      item: { implementedByResourceKeys: ["claude-code:opus"] },
      provenance: appended.chain,
    });
    assert.equal(result.kind, "WAITING_FOR_HUMAN", "RUN_CONFIGURED is not an implementation record");
  });

  /**
   * Tail deletion. `verifyChain` alone cannot see it — a truncated chain is a
   * valid chain — so it is caught by the row/chain cross-check instead: the row
   * still names an implementer the chain no longer mentions.
   */
  it("REFUSES a TAIL-TRUNCATED chain, which verifies on its own terms", async () => {
    let chain = chainFor("codex-cli:gpt-5.6-luna", 1_000);
    const second = appendProvenance(chain, {
      kind: "IMPLEMENTED_BY",
      roadmapKey: "A",
      resourceKey: "claude-code:opus",
      detail: "remediated",
      recordedAt: 2_000,
    });
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error("unreachable");
    chain = second.chain;

    // Truncating the tail leaves a chain that verifies perfectly.
    const truncated = chain.slice(0, 1);
    assert.equal(verifyChain(truncated).intact, true, "the fixture must verify, or it proves nothing");

    const { result } = await reviewWith({
      item: { implementedByResourceKeys: ["codex-cli:gpt-5.6-luna", "claude-code:opus"] },
      provenance: truncated,
    });
    assert.equal(result.kind, "WAITING_FOR_HUMAN", "tail deletion must not be cheaper than editing");
  });

  /**
   * ...and the empty-chain allowance still holds for the EXCLUSION question,
   * narrowed in round 9 to an ancestor whose class needs no AI. An empty chain
   * under a DONE AI ancestor is now refused outright — see
   * `tests/roadmapStructuralIntegrity.test.ts`.
   */
  it("still ACCEPTS an entirely empty chain as genuine silence", async () => {
    const { result } = await reviewWith({
      ancestorWorkClass: "DETERMINISTIC",
      item: { implementedByResourceKeys: ["claude-code:opus"] },
      provenance: [],
    });
    assert.equal(result.kind, "ADVANCED");
  });
});

describe("TASK-008 round 1: durable state enforces append-only (AC-1)", () => {
  async function repoWithOneEntry() {
    const dbPath = tempDbPath("t8-append");
    const repository = createSqliteSupervisorRepository(dbPath);
    const seeded = await repository.create({
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [],
      roadmap: [
        { key: "A", title: "Implemented", dependsOn: [], status: "DONE", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
      ],
      checkpoints: [],
      escalations: [],
      provenance: chainFor("claude-code:opus"),
      provenanceAnchor: anchorFor(chainFor("claude-code:opus")),
      updatedAt: 1_000,
    });
    return { repository, seeded };
  }

  it("REFUSES a write that deletes provenance", async () => {
    const { repository, seeded } = await repoWithOneEntry();
    try {
      await assert.rejects(
        repository.compareAndSave({ ...seeded, version: 2, provenance: [] }, 1),
        /provenance shrank/,
      );
    } finally {
      repository.close();
    }
  });

  /**
   * Two shapes of rewrite, refused for two different reasons — both correct,
   * and worth separating so a future change cannot lose one behind the other.
   */
  it("REFUSES a write whose entry keeps its digest but changes its content", async () => {
    const { repository, seeded } = await repoWithOneEntry();
    try {
      // Digest UNCHANGED, content edited: the prefix comparison sees matching
      // digests, so only recomputation catches this. It was the round-2 escape.
      const rewritten = seeded.provenance.map((entry) => ({ ...entry, detail: "edited after the fact" }));
      await assert.rejects(
        repository.compareAndSave({ ...seeded, version: 2, provenance: rewritten }, 1),
        /does not verify/,
      );
    } finally {
      repository.close();
    }
  });

  it("REFUSES a write whose entry carries a forged digest", async () => {
    const { repository, seeded } = await repoWithOneEntry();
    try {
      const forged = seeded.provenance.map((entry) => ({ ...entry, digest: "prov-forged" }));
      await assert.rejects(
        repository.compareAndSave({ ...seeded, version: 2, provenance: forged }, 1),
        /is not a digest|was rewritten|does not verify/,
      );
    } finally {
      repository.close();
    }
  });

  it("PERMITS a write that appends", async () => {
    const { repository, seeded } = await repoWithOneEntry();
    try {
      const appended = appendProvenance(seeded.provenance, {
        kind: "IMPLEMENTED_BY",
        roadmapKey: "A",
        resourceKey: "codex-cli:gpt-5.6-luna",
        detail: "later",
        recordedAt: 2_000,
      });
      assert.equal(appended.ok, true);
      if (!appended.ok) throw new Error("unreachable");
      const saved = await repository.compareAndSave(
        // An append updates BOTH records, exactly as `withLineage` does in
        // production: the anchor is part of the write, not a separate step.
        { ...seeded, version: 2, provenance: appended.chain, provenanceAnchor: anchorFor(appended.chain) },
        1,
      );
      assert.equal(saved.provenance.length, 2, "appending must still be allowed");
    } finally {
      repository.close();
    }
  });
});

describe("TASK-008 round 1: overflow and persistence limits fail closed", () => {
  /** AC-10 — the service-level append silently kept the old chain. */
  it("THROWS rather than completing an item with only half its records written", () => {
    const full = Array.from({ length: MAX_CHAIN_ENTRIES }, (_unused, index) => ({
      sequence: index,
      kind: "IMPLEMENTED_BY" as const,
      roadmapKey: "A",
      detail: "filler",
      recordedAt: index,
      previousDigest: GENESIS_DIGEST,
      digest: "prov-filler",
    }));
    assert.throws(
      () => appendImplementerProvenance(full, "A", "claude-code:opus", 1, "completed"),
      /Refusing to complete the item with only half its records written/,
    );
  });

  /** AC-9 — the parser accepted an unbounded and a secret-bearing detail. */
  it("REFUSES a persisted entry whose detail is unbounded", () => {
    const entry = { ...chainFor("claude-code:opus")[0]!, detail: "A".repeat(20_000) };
    assert.throws(
      () => parseSupervisorState(JSON.stringify(stateWith([entry])), { version: 1 }),
      /over the 4096 limit/,
    );
  });

  it("REFUSES a persisted entry carrying credential-shaped text", () => {
    const entry = {
      ...chainFor("claude-code:opus")[0]!,
      detail: "token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA leaked",
    };
    assert.throws(
      () => parseSupervisorState(JSON.stringify(stateWith([entry])), { version: 1 }),
      /credential-shaped text/,
    );
  });
});

describe("TASK-008 round 1: the maximum is enforced against a REAL chain", () => {
  /**
   * The round-1 reviewer showed my over-length fixture was built from fake
   * digests, so it was already invalid and `verifyChain` refused it for the
   * wrong reason — removing the maximum changed nothing and the guard looked
   * load-bearing when it was not. This builds a genuinely valid over-length
   * chain, which is slower and is the only thing that proves the clause.
   */
  it("REFUSES a VALID chain that is one entry too long", () => {
    let chain: readonly ProvenanceEntry[] = [];
    for (let index = 0; index < MAX_CHAIN_ENTRIES; index += 1) {
      const appended = appendProvenance(chain, {
        kind: "IMPLEMENTED_BY",
        roadmapKey: "A",
        resourceKey: "claude-code:opus",
        detail: "filler",
        recordedAt: index,
      });
      if (!appended.ok) throw new Error(`fixture failed at ${index}: ${appended.reason}`);
      chain = appended.chain;
    }
    assert.equal(verifyChain(chain).intact, true, "the fixture must be VALID at the maximum");

    // One more, built by hand so the append refusal is not what is under test.
    const last = chain[chain.length - 1]!;
    const extra: Omit<ProvenanceEntry, "digest"> = {
      sequence: chain.length,
      kind: "IMPLEMENTED_BY",
      roadmapKey: "A",
      resourceKey: "claude-code:opus",
      detail: "one too many",
      recordedAt: chain.length,
      previousDigest: last.digest,
    };
    const overlong = [...chain, { ...extra, digest: computeDigest(extra) }];

    const verdict = verifyChain(overlong);
    assert.equal(verdict.intact, false, "a valid but over-length chain must still be refused");
    if (!verdict.intact) assert.match(verdict.problem, /exceeds the maximum/);
  });
});

describe("TASK-008 round 1: a permission failure is REPORTED, not swallowed (AC-7)", () => {
  /**
   * The first version swallowed every `chmod` failure and carried on, so a
   * database that could NOT be tightened was indistinguishable from one that
   * had been. A control whose failure is silent is not a control.
   *
   * Driven against the verification directly, because the only way to make
   * `chmod` genuinely fail on this machine is to own the file as someone else
   * — which a test cannot arrange without root. What CAN be arranged, and is
   * what actually matters, is a file that is group/world accessible when the
   * check runs.
   */
  it("REFUSES a database file that is still group/world accessible", async () => {
    const { chmodSync, writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "t8-perm-"));
    const file = join(dir, "loose.db");
    writeFileSync(file, "");
    chmodSync(file, 0o666);

    assert.throws(
      () => assertRestricted(file, 0o600),
      /group\/world accessible/,
      "a world-readable database must be refused, not used",
    );
  });

  it("ACCEPTS a file that is owner-only", async () => {
    const { chmodSync, writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "t8-perm-ok-"));
    const file = join(dir, "tight.db");
    writeFileSync(file, "");
    chmodSync(file, 0o600);

    assert.doesNotThrow(() => assertRestricted(file, 0o600), "a correctly restricted file must be accepted");
  });
});


// =====================================================================
// ROUND-2 REMEDIATION — the CRITICAL and four HIGHs
// =====================================================================

describe("TASK-008 round 2: the reviewed item's own implementer is excluded", () => {
  /**
   * THE CRITICAL. The chain cross-check skipped `key === item.key`, so a chain
   * entry naming who implemented the item UNDER REVIEW was ignored entirely.
   * With the mutable row left empty, the reviewer had codex implement B and
   * then review B — the exact failure C4 exists to prevent.
   */
  it("REFUSES to let the chain-named implementer of B review B", async () => {
    /**
     * The fixture must make B the ONLY disagreement.
     *
     * My first version left the dependency A disagreeing too, so the run
     * stopped for THAT reason and the test passed whether or not B was
     * examined — mutation testing showed it surviving the exact regression it
     * was written for. Here A's row and chain agree, so anything that stops
     * the review can only be about B.
     */
    let chain: readonly ProvenanceEntry[] = [];
    for (const [roadmapKey, resourceKey] of [
      ["A", "claude-code:opus"],
      ["B", "codex-cli:gpt-5.6-luna"],
    ] as const) {
      const appended = appendProvenance(chain, {
        kind: "IMPLEMENTED_BY",
        roadmapKey,
        resourceKey,
        detail: "implemented",
        recordedAt: 1_000,
      });
      assert.equal(appended.ok, true);
      if (!appended.ok) throw new Error("unreachable");
      chain = appended.chain;
    }

    const { result, supervisor } = await reviewWith({
      // A agrees with the chain; B's row says nothing while the chain says
      // codex built it.
      item: { implementedByResourceKeys: ["claude-code:opus"] },
      provenance: chain,
    });

    assert.equal(
      result.kind,
      "WAITING_FOR_HUMAN",
      "a chain naming who built the REVIEWED item must be read, not skipped",
    );
    for (const call of supervisor.executor.calls()) {
      assert.notEqual(call.item.key, "B", "the reviewed item ran despite contradicted lineage");
    }
  });

  /** ...and with both records agreeing about B, the review still proceeds. */
  it("still ADVANCES when the chain and row agree about the reviewed item", async () => {
    let chain: readonly ProvenanceEntry[] = [];
    for (const [roadmapKey, resourceKey] of [["A", "claude-code:opus"]] as const) {
      const appended = appendProvenance(chain, {
        kind: "IMPLEMENTED_BY",
        roadmapKey,
        resourceKey,
        detail: "implemented",
        recordedAt: 1_000,
      });
      assert.equal(appended.ok, true);
      if (!appended.ok) throw new Error("unreachable");
      chain = appended.chain;
    }

    const { result } = await reviewWith({
      item: { implementedByResourceKeys: ["claude-code:opus"] },
      provenance: chain,
    });
    assert.equal(result.kind, "ADVANCED", "agreeing records must not block the review");
  });
});

describe("TASK-008 round 2: the digest distinguishes what it must", () => {
  const base = {
    sequence: 0,
    kind: "IMPLEMENTED_BY" as const,
    roadmapKey: "A",
    detail: "d",
    recordedAt: 1,
    previousDigest: GENESIS_DIGEST,
  };

  /** ABSENT and EMPTY were canonicalised identically through `?? ""`. */
  it("gives different digests to an absent and an empty resourceKey", () => {
    const absent = computeDigest(base);
    const empty = computeDigest({ ...base, resourceKey: "" });
    assert.notEqual(absent, empty, "absent and empty must not be interchangeable");
  });

  /**
   * A lone surrogate becomes U+FFFD when encoded as UTF-8, so it would hash
   * identically to a string that already contained the replacement character.
   * Such an entry is refused rather than hashed.
   */
  it("REFUSES to append a string that cannot survive UTF-8 unchanged", () => {
    const result = appendProvenance([], {
      kind: "IMPLEMENTED_BY",
      roadmapKey: "A",
      resourceKey: "claude-code:opus",
      detail: `lone surrogate: ${String.fromCharCode(0xd800)}`,
      recordedAt: 1,
    });
    assert.equal(result.ok, false, "a non-well-formed string was hashed");
    if (!result.ok) assert.match(result.reason, /well-formed/);
  });

  it("still accepts ordinary multibyte text", () => {
    const result = appendProvenance([], {
      kind: "IMPLEMENTED_BY",
      roadmapKey: "A",
      resourceKey: "claude-code:opus",
      detail: "ünïcödé ✅ 日本語 🎉",
      recordedAt: 1,
    });
    assert.equal(result.ok, true, "legitimate unicode must not be refused");
  });
});

describe("TASK-008 round 2: a digest field must be a digest", () => {
  /** A credential round-tripped through `digest`, which was a plain string. */
  it("REFUSES a persisted entry whose digest carries credential-shaped text", () => {
    const entry = {
      ...chainFor("claude-code:opus")[0]!,
      digest: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };
    assert.throws(
      () => parseSupervisorState(JSON.stringify(stateWith([entry])), { version: 1 }),
      /is not a digest/,
    );
  });

  it("REFUSES a previousDigest that is not a digest", () => {
    const entry = { ...chainFor("claude-code:opus")[0]!, previousDigest: "whatever" };
    assert.throws(
      () => parseSupervisorState(JSON.stringify(stateWith([entry])), { version: 1 }),
      /is not a digest/,
    );
  });

  it("ACCEPTS the published genesis digest", () => {
    const chain = chainFor("claude-code:opus");
    assert.equal(chain[0]!.previousDigest, GENESIS_DIGEST);
    assert.doesNotThrow(() => parseSupervisorState(JSON.stringify(stateWith([...chain])), { version: 1 }));
  });
});

describe("TASK-008 round 2: the repository verifies what it persists", () => {
  const validState = (provenance: readonly ProvenanceEntry[]) => ({
    version: 1,
    financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
    resources: [],
    roadmap: [
      { key: "A", title: "Implemented", dependsOn: [], status: "DONE" as const, workClass: "NORMAL_IMPLEMENTATION" as const, order: 1 },
    ],
    checkpoints: [],
    escalations: [],
    provenance,
    provenanceAnchor: anchorFor(provenance),
    updatedAt: 1_000,
  });

  /** `create()` accepted an outright forged chain and persisted it. */
  it("REFUSES to CREATE state whose chain does not verify", async () => {
    const dbPath = tempDbPath("t8-create-broken");
    const repository = createSqliteSupervisorRepository(dbPath);
    try {
      const broken = chainFor("claude-code:opus").map((entry) => ({ ...entry, detail: "edited" }));
      await assert.rejects(repository.create(validState(broken)), /does not verify/);
    } finally {
      repository.close();
    }
  });

  /**
   * A valid 10,001-entry chain was persisted, and only rejected later by a
   * reader. The maximum belongs at the boundary where data becomes durable.
   */
  it("REFUSES to persist a chain over the maximum, rather than leaving it for a reader", async () => {
    let chain: readonly ProvenanceEntry[] = [];
    for (let index = 0; index < MAX_CHAIN_ENTRIES; index += 1) {
      const appended = appendProvenance(chain, {
        kind: "IMPLEMENTED_BY",
        roadmapKey: "A",
        resourceKey: "claude-code:opus",
        detail: "filler",
        recordedAt: index,
      });
      if (!appended.ok) throw new Error(`fixture failed at ${index}`);
      chain = appended.chain;
    }
    const last = chain[chain.length - 1]!;
    const extra: Omit<ProvenanceEntry, "digest"> = {
      sequence: chain.length,
      kind: "IMPLEMENTED_BY",
      roadmapKey: "A",
      resourceKey: "claude-code:opus",
      detail: "one too many",
      recordedAt: chain.length,
      previousDigest: last.digest,
    };
    const overlong = [...chain, { ...extra, digest: computeDigest(extra) }];

    const dbPath = tempDbPath("t8-create-overlong");
    const repository = createSqliteSupervisorRepository(dbPath);
    try {
      await assert.rejects(repository.create(validState(overlong)), /does not verify|exceeds the maximum/);
    } finally {
      repository.close();
    }
  });
});


// =====================================================================
// ROUND-3 REMEDIATION — two CRITICALs and four HIGHs
// =====================================================================

describe("TASK-008 round 3: the chain is read whatever the row now claims", () => {
  /**
   * CRITICAL. `workClass` lives in the MUTABLE row, and the chain loop used it
   * to decide whether to consult the IMMUTABLE record. Relabelling the
   * dependency `DETERMINISTIC` skipped its chain entry entirely, and the
   * resource that built it reviewed it.
   */
  it("REFUSES when the row relabels an implemented item as DETERMINISTIC", async () => {
    const appended = appendProvenance([], {
      kind: "IMPLEMENTED_BY",
      roadmapKey: "A",
      resourceKey: "codex-cli:gpt-5.6-luna",
      detail: "implemented",
      recordedAt: 1_000,
    });
    assert.equal(appended.ok, true);
    if (!appended.ok) throw new Error("unreachable");

    const { result, supervisor } = await reviewWith({
      /**
       * DECLARED deterministic, not forged deterministic (round-15 finding).
       *
       * `workClass` used to be set through `item`, which lands only on the
       * persisted row — so TASK-012 saw a row disagreeing with the catalog and
       * refused before this guard ran. The assertion is `WAITING_FOR_HUMAN`
       * either way, so the case stayed green while proving nothing.
       *
       * The property under test survives the correction and is the interesting
       * one: recognition must not be GATED on the class. With the catalog
       * agreeing the item is deterministic, the guard is genuinely reached.
       */
      ancestorWorkClass: "DETERMINISTIC",
      // The row claims A had no implementer at all; the chain says otherwise.
      item: { implementedByResourceKeys: [] },
      provenance: appended.chain,
    });

    assert.equal(result.kind, "WAITING_FOR_HUMAN", "a relabelled row hid the chain entry");
    for (const call of supervisor.executor.calls()) {
      assert.notEqual(call.item.key, "B", "the chain-named implementer reviewed the work");
    }
  });

  /**
   * CRITICAL. An `IMPLEMENTED_BY` with no `resourceKey` was DISCARDED, so a
   * chain asserting that work happened — without saying who did it — read as
   * though nothing had happened. Unknown identity is worse than no record.
   */
  it("REFUSES an IMPLEMENTED_BY entry that names no resource", async () => {
    /**
     * The fixture must make the UNNAMED entry the only signal.
     *
     * My first version left the row with no implementer, so the existing
     * row-based rule flagged it as ambiguous anyway and the test passed with or
     * without the fix — mutation testing showed it surviving. Here the row and
     * the chain AGREE about claude, and an additional entry says work happened
     * without saying who did it. Nothing else can produce the refusal.
     */
    let chain: readonly ProvenanceEntry[] = [];
    const named = appendProvenance(chain, {
      kind: "IMPLEMENTED_BY",
      roadmapKey: "A",
      resourceKey: "claude-code:opus",
      detail: "implemented",
      recordedAt: 1_000,
    });
    assert.equal(named.ok, true);
    if (!named.ok) throw new Error("unreachable");
    chain = named.chain;

    const unnamed = appendProvenance(chain, {
      kind: "IMPLEMENTED_BY",
      roadmapKey: "A",
      detail: "someone else also worked on this",
      recordedAt: 2_000,
    });
    assert.equal(unnamed.ok, true);
    if (!unnamed.ok) throw new Error("unreachable");
    chain = unnamed.chain;
    assert.equal(chain[1]!.resourceKey, undefined, "the fixture must have an entry with no resourceKey");

    const { result } = await reviewWith({
      // Row and chain agree about claude, so the ordinary rules are satisfied.
      item: {
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
      provenance: chain,
    });
    assert.equal(result.kind, "WAITING_FOR_HUMAN", "an unnamed implementer must fail closed");
  });
});

describe("TASK-008 round 3: what is stored is what was verified", () => {
  const stateWithChain = (provenance: readonly ProvenanceEntry[]) => ({
    version: 1,
    financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
    resources: [],
    roadmap: [
      { key: "A", title: "Implemented", dependsOn: [], status: "DONE" as const, workClass: "NORMAL_IMPLEMENTATION" as const, order: 1 },
    ],
    checkpoints: [],
    escalations: [],
    provenance,
    provenanceAnchor: anchorFor(provenance),
    updatedAt: 1_000,
  });

  /**
   * The repository verified the in-memory OBJECT. An entry whose `toJSON`
   * returned different content passed every guard and landed in SQLite as a
   * chain that does not verify.
   */
  it("REFUSES an entry whose serialized form differs from its object", async () => {
    const chain = chainFor("claude-code:opus");
    const treacherous = chain.map((entry) => ({
      ...entry,
      toJSON() {
        return { ...entry, detail: "edited only in the bytes" };
      },
    })) as unknown as readonly ProvenanceEntry[];

    const dbPath = tempDbPath("t8-tojson");
    const repository = createSqliteSupervisorRepository(dbPath);
    try {
      await assert.rejects(repository.create(stateWithChain(treacherous)), /does not verify/);
    } finally {
      repository.close();
    }
  });

  /**
   * An unknown property was dropped by the PARSER — after the row had already
   * been written with it. The credential was in the file either way.
   */
  it("does not PERSIST an unknown property, even though the parser ignores it", async () => {
    const { readFileSync } = await import("node:fs");
    const leak = "sk-ant-api03-UNKNOWNPROPERTYLEAKLEAKLEAK00";
    const chain = chainFor("claude-code:opus").map((entry) => ({ ...entry, unexpectedSecret: leak }));

    const dbPath = tempDbPath("t8-unknown-prop");
    const repository = createSqliteSupervisorRepository(dbPath);
    try {
      await repository.create(stateWithChain(chain as unknown as readonly ProvenanceEntry[]));
    } finally {
      repository.close();
    }

    const raw = readFileSync(dbPath);
    assert.ok(!raw.includes(leak), "the credential reached the database file");
  });
});

describe("TASK-008 round 3: append-only is pinned by content, not only by digest", () => {
  /**
   * The reviewer's blind spot: disabling the digest/sequence comparison left
   * the suite green, because a REHASHED rewrite still verifies as a chain. Only
   * the prefix comparison can catch it.
   */
  it("REFUSES a rewrite that was rehashed so the chain still verifies", async () => {
    const dbPath = tempDbPath("t8-rehashed");
    const repository = createSqliteSupervisorRepository(dbPath);
    try {
      const seeded = await repository.create({
        version: 1,
        financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
        resources: [],
        roadmap: [
          { key: "A", title: "Implemented", dependsOn: [], status: "DONE", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
        ],
        checkpoints: [],
        escalations: [],
        provenance: chainFor("claude-code:opus"),
        provenanceAnchor: anchorFor(chainFor("claude-code:opus")),
        updatedAt: 1_000,
      });

      // Rebuild the chain from scratch with DIFFERENT content: internally
      // consistent, verifies perfectly, and is not the history that was stored.
      const rehashed = chainFor("codex-cli:gpt-5.6-luna");
      assert.equal(verifyChain(rehashed).intact, true, "the forgery must itself verify");

      await assert.rejects(
        repository.compareAndSave({ ...seeded, version: 2, provenance: rehashed }, 1),
        /was rewritten/,
      );
    } finally {
      repository.close();
    }
  });
});

describe("TASK-008 round 3: a lone surrogate cannot be persisted either", () => {
  it("REFUSES a stored entry containing a lone surrogate", () => {
    const entry = {
      ...chainFor("claude-code:opus")[0]!,
      detail: `x${String.fromCharCode(0xd800)}y`,
    };
    assert.throws(
      () => parseSupervisorState(JSON.stringify(stateWith([entry])), { version: 1 }),
      /not well-formed/,
    );
  });
});


// =====================================================================
// ROUND-4 — recognition, and a broken chain found on disk
// =====================================================================

describe("TASK-008 round 4: an unrecognised identity is not lineage", () => {
  /**
   * THE CRITICAL. Catalog recognition was applied only to ANCESTORS, so the
   * reviewed item's row and chain could agree on a resource that is not in the
   * code-level catalog at all. That fake identity was dutifully excluded — and
   * the real implementer, named nowhere, stayed eligible. The reviewer had
   * Codex review its own work through exactly that gap.
   */
  it("REFUSES when the reviewed item names an implementer no catalog knows", async () => {
    const appended = appendProvenance([], {
      kind: "IMPLEMENTED_BY",
      roadmapKey: "B",
      resourceKey: "not-a-catalog-resource",
      detail: "implemented",
      recordedAt: 1_000,
    });
    assert.equal(appended.ok, true);
    if (!appended.ok) throw new Error("unreachable");

    /**
     * DECLARED, or the catalog refuses first (round-15 finding). Persisting
     * custom items against the default catalog made TASK-012 refuse for an
     * unknown roadmap item, before the identity check this case is about.
     */
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      roadmap: [
        { key: "B", title: "Review of A", dependsOn: ["A"], status: "PENDING", workClass: "INDEPENDENT_REVIEW", order: 1 },
        { key: "A", title: "Implemented", dependsOn: [], status: "PENDING", workClass: "DETERMINISTIC", order: 2, declaredActionKinds: ["RUN_TESTS"] },
      ],
    });
    const state = await supervisor.service.ensureInitialized();
    await supervisor.repository.compareAndSave(
      {
        ...state,
        version: state.version + 1,
        roadmap: [
          {
            key: "B",
            title: "Review of A",
            dependsOn: ["A"],
            status: "ELIGIBLE",
            workClass: "INDEPENDENT_REVIEW",
            order: 1,
            attempts: 1,
            implementedByResourceKeys: ["not-a-catalog-resource"],
          } as RoadmapItem,
          { key: "A", title: "Done", dependsOn: [], status: "DONE", workClass: "DETERMINISTIC", order: 2 },
        ],
        provenance: appended.chain,
        provenanceAnchor: anchorFor(appended.chain),
      },
      state.version,
    );

    const result = await supervisor.service.tick();
    assert.equal(
      result.kind,
      "WAITING_FOR_HUMAN",
      "an implementer this installation cannot recognise must fail closed",
    );
    for (const call of supervisor.executor.calls()) {
      assert.notEqual(call.item.key, "B", "the review ran on unrecognisable lineage");
    }
  });
});

describe("TASK-008 round 4: a broken chain on disk is a DECISION, not a crash", () => {
  /**
   * The repository refuses to persist a chain that does not verify — correctly.
   * The consequence the reviewer found: the tick's ordinary housekeeping write
   * then threw `SchemaIntegrityError`, so a tampered database produced a stack
   * trace, zero executor calls and NO recorded escalation.
   *
   * Fail-closed has to mean the supervisor decided to stop, not that it fell
   * over on the way to deciding.
   *
   * Tampered by writing the ROW DIRECTLY, which is how it happens.
   */
  it("returns WAITING_FOR_HUMAN instead of throwing", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const dbPath = tempDbPath("t8-broken-ondisk");

    const repository = createSqliteSupervisorRepository(dbPath);
    const seeded = await repository.create({
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [],
      roadmap: [
        { key: "A", title: "Implemented", dependsOn: [], status: "DONE", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
      ],
      checkpoints: [],
      escalations: [],
      provenance: chainFor("claude-code:opus"),
      provenanceAnchor: anchorFor(chainFor("claude-code:opus")),
      updatedAt: 1_000,
    });
    repository.close();

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE supervisor_state SET data = ? WHERE id = ?").run(
      JSON.stringify({
        ...seeded,
        provenance: seeded.provenance.map((entry) => ({ ...entry, detail: "edited on disk" })),
      }),
      "supervisor",
    );
    db.close();

    const reopened = createSqliteSupervisorRepository(dbPath);
    const supervisor = newSupervisor({
      /**
       * DECLARED, or the catalog refuses first (round-14 lesson).
       *
       * These fixtures persist a single item `A` and used to build the
       * supervisor on the DEFAULT catalog, so TASK-012 refused the state at
       * catalog reconciliation and the tick never reached the guard the case is
       * about. The assertion is `WAITING_FOR_HUMAN` either way, so the case
       * stayed green while proving nothing — the same false-green the reviewer
       * found twice elsewhere, in fixtures I wrote.
       */
      roadmap: [
        { key: "A", title: "Implemented", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
      ],
      probe: healthyProbe(),
      repository: reopened,
    });
    try {
      const result = await supervisor.service.tick();
      assert.equal(result.kind, "WAITING_FOR_HUMAN", "a tampered chain must produce a decision");
      if (result.kind === "WAITING_FOR_HUMAN") {
        assert.match(result.humanActionRequired, /provenance/i);
      }
      assert.equal(supervisor.executor.calls().length, 0, "nothing may run on unverifiable history");
    } finally {
      reopened.close();
    }
  });
});


// =====================================================================
// ROUND-5 — mutable edges, and truncation the chain cannot see
// =====================================================================

describe("TASK-008 round 5: a dependency edit cannot hide lineage", () => {
  /**
   * CRITICAL. The traversal walked `dependsOn` from the MUTABLE roadmap, so
   * editing `B.dependsOn` to `[]` meant the chain entry naming who implemented
   * `A` was never consulted. The chain stayed perfectly valid and was simply
   * never asked — mutable data deciding whether immutable data is read, for
   * the third time in this task.
   */
  it("REFUSES even when the reviewed item's dependency edge has been deleted", async () => {
    const appended = appendProvenance([], {
      kind: "IMPLEMENTED_BY",
      roadmapKey: "A",
      resourceKey: "codex-cli:gpt-5.6-luna",
      detail: "implemented",
      recordedAt: 1_000,
    });
    assert.equal(appended.ok, true);
    if (!appended.ok) throw new Error("unreachable");

    /**
     * The catalog DECLARES this roadmap (round-13 finding).
     *
     * It used to run on the default catalog while persisting custom items `A`
     * and `B`, so TASK-012 refused the state at catalog reconciliation and the
     * tick never reached the traversal this case is about. The test asserted
     * nothing about the result, so it stayed green while proving nothing —
     * deleting the chain-key traversal left the whole suite passing.
     *
     * `dependsOn: []` on B is the TAMPER, so the catalog declares the honest
     * edge and only the persisted row drops it.
     */
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      roadmap: [
        { key: "B", title: "Review", dependsOn: ["A"], status: "PENDING", workClass: "INDEPENDENT_REVIEW", order: 1 },
        { key: "A", title: "Implemented", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 2 },
      ],
    });
    const state = await supervisor.service.ensureInitialized();
    await supervisor.repository.compareAndSave(
      {
        ...state,
        version: state.version + 1,
        roadmap: [
          // B no longer depends on A — the edge the traversal relied on is gone.
          { key: "B", title: "Review", dependsOn: [], status: "ELIGIBLE", workClass: "INDEPENDENT_REVIEW", order: 1 },
          { key: "A", title: "Implemented", dependsOn: [], status: "DONE", workClass: "NORMAL_IMPLEMENTATION", order: 2, attempts: 1, implementedByResourceKeys: ["codex-cli:gpt-5.6-luna"] } as RoadmapItem,
        ],
        provenance: appended.chain,
        provenanceAnchor: anchorFor(appended.chain),
      },
      state.version,
    );

    /**
     * ASSERTS THE OUTCOME, which this case used not to (round-13 finding).
     *
     * It ran the tick, iterated the executor calls, and discarded the result. If
     * the tick refused for an unrelated reason — as it did, because the catalog
     * did not declare these items — the loop was empty and the case passed
     * having exercised nothing.
     */
    /**
     * WHICH GUARD CATCHES THIS NOW, measured rather than assumed.
     *
     * When this was written the chain-key traversal was the answer. TASK-012
     * moved the answer earlier: `dependsOn` is a DEFINITION field, so a
     * persisted row that disagrees with the catalog is refused before the
     * exclusion walk runs at all. A mutation removing the traversal leaves this
     * case green, and the honest response is to say so here and to test the
     * traversal where it is still the only thing standing — the case below.
     *
     * The property this case asserts is unchanged and still worth pinning: a
     * deleted edge does not get a review past the gate.
     */
    const result = await supervisor.service.tick();
    assert.equal(result.kind, "WAITING_FOR_HUMAN", "a deleted edge let the review proceed");
    if (result.kind === "WAITING_FOR_HUMAN") {
      assert.match(result.humanActionRequired, /dependsOn/, "the refusal must name the edited field");
    }
    for (const call of supervisor.executor.calls()) {
      assert.notEqual(call.item.key, "B", "the review ran on lineage the traversal never consulted");
    }
  });
});

describe("TASK-008 round 5: tail truncation is detected by an anchor", () => {
  /**
   * CRITICAL. A valid PREFIX of a valid chain is a valid chain — that is what a
   * hash chain is, and `verifyChain` structurally cannot see truncation. The
   * reviewer cut the tail and deleted the matching row so neither record
   * mentioned the removed work.
   *
   * The length and head are recorded separately, so truncating now requires
   * editing the anchor too. NOT a trust anchor: someone who updates both is
   * still undetected, exactly as the module says.
   */
  it("REFUSES a chain whose tail was cut, leaving a valid prefix", () => {
    let chain: readonly ProvenanceEntry[] = [];
    for (const resource of ["claude-code:opus", "codex-cli:gpt-5.6-luna"]) {
      const appended = appendProvenance(chain, {
        kind: "IMPLEMENTED_BY",
        roadmapKey: "A",
        resourceKey: resource,
        detail: "implemented",
        recordedAt: chain.length + 1,
      });
      assert.equal(appended.ok, true);
      if (!appended.ok) throw new Error("unreachable");
      chain = appended.chain;
    }
    const anchor = anchorFor(chain);
    const truncated = chain.slice(0, 1);

    // The prefix verifies perfectly on its own terms — that is the problem.
    assert.equal(verifyChain(truncated).intact, true, "the fixture must verify structurally");

    const verdict = verifyAgainstAnchor(truncated, anchor);
    assert.equal(verdict.intact, false, "tail truncation went undetected");
    if (!verdict.intact) assert.match(verdict.problem, /removed from the end/);
  });

  it("ACCEPTS a chain that matches its anchor", () => {
    const chain = chainFor("claude-code:opus");
    assert.equal(verifyAgainstAnchor(chain, anchorFor(chain)).intact, true);
  });

  /**
   * INVERTED IN ROUND 9, and worth stating why rather than quietly editing.
   *
   * This asserted that an absent anchor is silence, so that a database written
   * before anchors existed would still load. The reviewer then used exactly that
   * allowance: truncate the chain, delete the matching row history, DELETE THE
   * ANCHOR, and the tail implementer reviewed its own work. No digest had to be
   * recomputed — the record that would have objected was simply removed.
   *
   * An optional guard is one an attacker turns off. Production writes an anchor
   * with every chain now, so a non-empty chain without one is a contradiction.
   */
  it("REFUSES a non-empty chain with no anchor recorded", () => {
    const chain = chainFor("claude-code:opus");
    const verdict = verifyAgainstAnchor(chain, undefined);
    assert.equal(verdict.intact, false, "deleting the anchor switched the truncation check off");
    if (!verdict.intact) assert.match(verdict.problem, /no anchor was recorded/);
  });

  /** An EMPTY chain with no anchor is still a database with no history. */
  it("ACCEPTS an empty chain with no anchor recorded", () => {
    assert.equal(verifyAgainstAnchor([], undefined).intact, true);
  });
});


// =====================================================================
// ROUND-6 — deletion must not decide whether the anchor is consulted
// =====================================================================

describe("TASK-008 round 6: an empty chain does not escape its own anchor", () => {
  /**
   * CRITICAL. The empty-chain allowance existed so a database written before
   * provenance existed would still load. But it was checked BEFORE the anchor,
   * so deleting the whole chain — while leaving an anchor saying it had two
   * entries — read as a legacy database with no history at all.
   *
   * The anchor exists precisely to make deletion visible. Letting the deletion
   * decide whether the anchor is consulted inverts it.
   */
  it("REFUSES an empty chain when the anchor says entries existed", async () => {
    const chain = chainFor("claude-code:opus");
    const anchor = anchorFor(chain);

    const supervisor = newSupervisor({ probe: healthyProbe() });
    const state = await supervisor.service.ensureInitialized();
    await supervisor.repository.compareAndSave(
      {
        ...state,
        version: state.version + 1,
        roadmap: [
          { key: "B", title: "Review of A", dependsOn: ["A"], status: "ELIGIBLE", workClass: "INDEPENDENT_REVIEW", order: 1 },
          { key: "A", title: "Implemented", dependsOn: [], status: "DONE", workClass: "NORMAL_IMPLEMENTATION", order: 2, attempts: 1, implementedByResourceKeys: ["claude-code:opus"] } as RoadmapItem,
        ],
        // The chain is GONE; the anchor still says it had one entry.
        provenance: [],
        provenanceAnchor: anchor,
      },
      state.version,
    );

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "WAITING_FOR_HUMAN", "a deleted chain read as legacy silence");
    assert.equal(supervisor.executor.calls().length, 0, "nothing may run on deleted history");
  });

  /**
   * ...and a genuinely legacy database still works — NARROWED IN ROUND 9.
   *
   * "No chain, no anchor" is still not tampering. What changed is that it is no
   * longer a free pass for a DONE item whose class needs AI: the reviewer built
   * exactly that state, with forged completions, and watched the dependents run.
   * TASK-012 AC-6 now refuses it, and the pair below says both halves out loud
   * rather than leaving the second to be discovered.
   */
  it("still ACCEPTS a database with neither chain nor anchor", async () => {
    const { result } = await reviewWith({
      ancestorWorkClass: "DETERMINISTIC",
      item: { implementedByResourceKeys: ["claude-code:opus"] },
      provenance: [],
    });
    assert.equal(result.kind, "ADVANCED", "a genuinely legacy database must still advance");
  });

  it("REFUSES the same database when the DONE ancestor needed AI", async () => {
    const { result, supervisor } = await reviewWith({
      item: { implementedByResourceKeys: ["claude-code:opus"] },
      provenance: [],
    });
    assert.equal(result.kind, "WAITING_FOR_HUMAN", "an empty chain excused a DONE AI ancestor");
    assert.equal(supervisor.executor.calls().length, 0);
  });
});

describe("TASK-008 round 6: the chain's names are recognised too", () => {
  /**
   * CRITICAL. Catalog recognition lived inside the row-based branch, gated on
   * the MUTABLE `workClass`. Relabelling an item `DETERMINISTIC` skipped it,
   * and the chain cross-check never asked whether a name was recognisable at
   * all — so two records agreeing on `not-a-catalog-resource` satisfied
   * everything while the real implementer stayed eligible.
   *
   * Agreement between two rewritable records is not recognition.
   */
  it("REFUSES a chain naming a resource no catalog knows, whatever the row says", async () => {
    const appended = appendProvenance([], {
      kind: "IMPLEMENTED_BY",
      roadmapKey: "A",
      resourceKey: "not-a-catalog-resource",
      detail: "implemented",
      recordedAt: 1_000,
    });
    assert.equal(appended.ok, true);
    if (!appended.ok) throw new Error("unreachable");

    const { result, supervisor } = await reviewWith({
      /**
       * DECLARED deterministic, not forged deterministic (round-15 finding).
       *
       * `workClass` used to be set through `item`, which lands only on the
       * persisted row — so TASK-012 saw a row disagreeing with the catalog and
       * refused before this guard ran. The assertion is `WAITING_FOR_HUMAN`
       * either way, so the case stayed green while proving nothing.
       *
       * The property under test survives the correction and is the interesting
       * one: recognition must not be GATED on the class. With the catalog
       * agreeing the item is deterministic, the guard is genuinely reached.
       */
      ancestorWorkClass: "DETERMINISTIC",
      item: { implementedByResourceKeys: ["not-a-catalog-resource"] },
      provenance: appended.chain,
    });

    assert.equal(result.kind, "WAITING_FOR_HUMAN", "an unrecognisable chain identity was accepted");
    for (const call of supervisor.executor.calls()) {
      assert.notEqual(call.item.key, "B", "a review ran on lineage nobody can recognise");
    }
  });
});


// =====================================================================
// ROUND-7 — an anchor's head is half its claim
// =====================================================================

describe("TASK-008 round 7: a zero-length anchor still asserts something", () => {
  /**
   * CRITICAL. The early return checked only the anchor's LENGTH, so an anchor
   * claiming zero entries but a NON-GENESIS head — a contradiction on its face
   * — skipped verification entirely.
   */
  it("REFUSES an empty chain whose anchor names a head it cannot have", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    const state = await supervisor.service.ensureInitialized();
    await supervisor.repository.compareAndSave(
      {
        ...state,
        version: state.version + 1,
        /**
         * The dependency is DETERMINISTIC with no implementers, so none of the
         * row-based or chain-based rules can object. The self-contradictory
         * anchor is the ONLY thing left that could refuse.
         *
         * My first fixture gave A an implementer, so the row/chain
         * disagreement refused it and the test passed with or without the
         * anchor check — mutation testing showed it surviving.
         */
        roadmap: [
          { key: "B", title: "Review of A", dependsOn: ["A"], status: "ELIGIBLE", workClass: "INDEPENDENT_REVIEW", order: 1 },
          { key: "A", title: "Prepared", dependsOn: [], status: "DONE", workClass: "DETERMINISTIC", order: 2 },
        ],
        provenance: [],
        provenanceAnchor: { length: 0, headDigest: chainFor("claude-code:opus")[0]!.digest },
      },
      state.version,
    );

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "WAITING_FOR_HUMAN", "a self-contradictory anchor was accepted");
    assert.equal(supervisor.executor.calls().length, 0);
  });

  /** A genuinely empty state — zero length, genesis head — still advances. */
  it("ACCEPTS an empty chain whose anchor is consistent with being empty", async () => {
    const { result } = await reviewWith({
      ancestorWorkClass: "DETERMINISTIC",
      item: { implementedByResourceKeys: ["claude-code:opus"] },
      provenance: [],
    });
    assert.equal(result.kind, "ADVANCED");
  });
});

describe("TASK-008 round 7: what actually ran is read whatever the row claims", () => {
  /**
   * CRITICAL. The `lastRunConfig` cross-check lived inside the branch gated on
   * the MUTABLE work class, so relabelling an ancestor `DETERMINISTIC` skipped
   * it — and an item whose row and chain named Claude while its run
   * configuration named Codex was reviewed by Codex.
   *
   * A record of what ran does not stop being a record because a mutable field
   * was edited.
   */
  it("REFUSES when the run configuration names a resource neither record does", async () => {
    const appended = appendProvenance([], {
      kind: "IMPLEMENTED_BY",
      roadmapKey: "A",
      resourceKey: "claude-code:opus",
      detail: "implemented",
      recordedAt: 1_000,
    });
    assert.equal(appended.ok, true);
    if (!appended.ok) throw new Error("unreachable");

    const { result, supervisor } = await reviewWith({
      /**
       * DECLARED deterministic, not forged deterministic (round-15 finding).
       *
       * `workClass` used to be set through `item`, which lands only on the
       * persisted row — so TASK-012 saw a row disagreeing with the catalog and
       * refused before this guard ran. The assertion is `WAITING_FOR_HUMAN`
       * either way, so the case stayed green while proving nothing.
       *
       * The property under test survives the correction and is the interesting
       * one: recognition must not be GATED on the class. With the catalog
       * agreeing the item is deterministic, the guard is genuinely reached.
       */
      ancestorWorkClass: "DETERMINISTIC",
      item: {
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
      },
      provenance: appended.chain,
    });

    assert.equal(result.kind, "WAITING_FOR_HUMAN", "a relabelled row hid the run-configuration evidence");
    for (const call of supervisor.executor.calls()) {
      if (call.item.key !== "B" || call.config === undefined) continue;
      assert.notEqual(
        `${call.config.effectiveProvider}:${call.config.effectiveModel}`,
        "codex-cli:gpt-5.6-luna",
        "the resource that actually ran was chosen as the reviewer",
      );
    }
  });
});

// =====================================================================
// ROUND-8 — a run is a run, and a corrupt record is an answer
// =====================================================================

describe("TASK-008 round 8: lineage on every path a worker can take", () => {
  /**
   * CRITICAL. `COMPLETED` and `CHANGES_REQUIRED` recorded who ran; `CHECKPOINT`
   * and `RESOURCE_FAILURE` recorded nothing at all.
   *
   * The reviewer reproduced the consequence against real SQLite: A runs on
   * `codex-cli:gpt-5.6-luna` and checkpoints, A later completes on
   * `claude-code:sonnet`, and the persisted provenance names only the second.
   * The first worker — which had a session, and may have changed the workspace
   * — was then free to review B.
   *
   * Lineage is about who RAN. Whether the run finished is a different question
   * and has never been the criterion.
   */
  async function chainKeysAfter(outcome: WorkOutcome): Promise<{
    readonly entries: readonly ProvenanceEntry[];
    readonly implementers: readonly string[];
  }> {
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      executor: scriptedExecutor({ A: [outcome] }),
    });
    await seedRoadmap(supervisor, [
      { key: "A", title: "First item", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ]);
    await supervisor.service.tick();
    const state = await supervisor.repository.load();
    assert.ok(state !== undefined);
    const item = state.roadmap.find((entry) => entry.key === "A");
    assert.ok(item !== undefined);
    return {
      entries: state.provenance.filter((entry) => entry.roadmapKey === "A"),
      implementers: item.implementedByResourceKeys ?? [],
    };
  }

  it("records who ran when the session ROLLS OVER", async () => {
    const { entries, implementers } = await chainKeysAfter({
      kind: "CHECKPOINT",
      detail: "context exhausted",
      checkpoint: {
        roadmapKey: "A",
        actionId: "ignored",
        requiredWorkClass: "NORMAL_IMPLEMENTATION",
        iteration: 1,
        nextAction: "resume",
        findings: [],
        completedVerification: [],
        pendingVerification: [],
        updatedAt: 1,
      },
    });
    const implemented = entries.filter((entry) => entry.kind === "IMPLEMENTED_BY");
    assert.ok(implemented.length > 0, "a worker checkpointed and the chain does not know it ran");
    assert.ok(implementers.length > 0, "the row does not know it ran either");
  });

  it("records who ran when the provider FAILS", async () => {
    const { entries, implementers } = await chainKeysAfter({
      kind: "RESOURCE_FAILURE",
      process: { terminationReason: "EXITED", exitCode: 1, stdout: "", stderr: "quota exhausted" },
    });
    const implemented = entries.filter((entry) => entry.kind === "IMPLEMENTED_BY");
    assert.ok(implemented.length > 0, "a worker ran, failed, and the chain does not know it ran");
    assert.ok(implementers.length > 0, "the row does not know it ran either");
  });

  /**
   * The consequence, which is the only reason the record matters: a resource
   * that only ever CHECKPOINTED on A must still be excluded from reviewing B.
   */
  it("excludes a worker whose only run on A was a checkpoint", async () => {
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      executor: scriptedExecutor({
        // CHECKPOINT then COMPLETED: the fixture repeats its LAST outcome, so a
        // one-entry script means A never finishes and B is never selected.
        A: [
          {
            kind: "CHECKPOINT",
            detail: "context exhausted",
            checkpoint: {
              roadmapKey: "A",
              actionId: "ignored",
              requiredWorkClass: "NORMAL_IMPLEMENTATION",
              iteration: 1,
              nextAction: "resume",
              findings: [],
              completedVerification: [],
              pendingVerification: [],
              updatedAt: 1,
            },
          },
          { kind: "COMPLETED", detail: "finished after the rollover" },
        ],
      }),
    });
    await seedRoadmap(supervisor, [
      { key: "A", title: "First item", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
      { key: "B", title: "Review of A", dependsOn: ["A"], status: "PENDING", workClass: "INDEPENDENT_REVIEW", order: 2 },
    ]);

    await supervisor.service.tick(); // A checkpoints
    const afterCheckpoint = await supervisor.repository.load();
    assert.ok(afterCheckpoint !== undefined);
    const checkpointed = (afterCheckpoint.roadmap.find((entry) => entry.key === "A")?.implementedByResourceKeys ?? [])[0];
    assert.ok(checkpointed !== undefined, "nothing was recorded, so this proves nothing about exclusion");

    await supervisor.service.tick(); // A completes
    await supervisor.service.tick(); // B is reviewed

    /**
     * B MUST ACTUALLY HAVE RUN (round-13 finding).
     *
     * `scriptedExecutor` repeats its last outcome, so scripting only a
     * CHECKPOINT meant A never completed and B was never selected. The loop
     * below then had nothing to iterate and passed vacuously — the exact shape
     * of "not refused" being mistaken for "did the right thing".
     */
    const reviewCalls = supervisor.executor.callsFor("B");
    assert.ok(reviewCalls.length > 0, "B was never reviewed, so this proves nothing about who reviewed it");

    const reviewCall = reviewCalls[0];
    if (reviewCall !== undefined) {
      const usedForReview = `${reviewCall.config?.effectiveProvider ?? ""}:${reviewCall.config?.effectiveModel ?? ""}`;
      assert.notEqual(
        usedForReview,
        checkpointed,
        "the worker that checkpointed on A reviewed the item that depends on A",
      );
    }
  });
});

describe("TASK-008 round 8: the wake time cannot overrule the verdict", () => {
  /**
   * HIGH. `tick()` decided `WAITING_FOR_HUMAN` on a tampered chain and then
   * always called `publishWake()`, which tried to WRITE — and the repository
   * correctly refuses to persist an unverifiable chain, so the refusal was
   * rethrown and the decision never reached the caller.
   *
   * The round-4 case missed this only because its fixture left `nextWakeAt`
   * unset, so the wake computed to the same value and nothing was written. A
   * stale one is what a real supervisor has after any waiting tick.
   */
  it("returns the decision even when the wake time is stale", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const dbPath = tempDbPath("t8-stale-wake");

    const repository = createSqliteSupervisorRepository(dbPath);
    const seeded = await repository.create({
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [],
      roadmap: [
        { key: "A", title: "Implemented", dependsOn: [], status: "DONE", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
      ],
      checkpoints: [],
      escalations: [],
      provenance: chainFor("claude-code:opus"),
      provenanceAnchor: anchorFor(chainFor("claude-code:opus")),
      updatedAt: 1_000,
    });
    repository.close();

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE supervisor_state SET data = ? WHERE id = ?").run(
      JSON.stringify({
        ...seeded,
        // A wake time no recomputation will agree with, so the advisory write
        // is definitely attempted.
        nextWakeAt: 999_999_999,
        provenance: seeded.provenance.map((entry) => ({ ...entry, detail: "edited on disk" })),
      }),
      "supervisor",
    );
    db.close();

    const reopened = createSqliteSupervisorRepository(dbPath);
    const supervisor = newSupervisor({
      /**
       * DECLARED, or the catalog refuses first (round-14 lesson).
       *
       * These fixtures persist a single item `A` and used to build the
       * supervisor on the DEFAULT catalog, so TASK-012 refused the state at
       * catalog reconciliation and the tick never reached the guard the case is
       * about. The assertion is `WAITING_FOR_HUMAN` either way, so the case
       * stayed green while proving nothing — the same false-green the reviewer
       * found twice elsewhere, in fixtures I wrote.
       */
      roadmap: [
        { key: "A", title: "Implemented", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
      ],
      probe: healthyProbe(),
      repository: reopened,
    });
    try {
      const result = await supervisor.service.tick();
      assert.equal(result.kind, "WAITING_FOR_HUMAN", "the advisory wake write buried the verdict");
      assert.equal(supervisor.executor.calls().length, 0);
    } finally {
      reopened.close();
    }
  });
});

describe("TASK-008 round 8: state that will not PARSE is a decision too", () => {
  /**
   * HIGH. AC-5 held for tampering the deserializer would accept. Writing
   * `prov-forged` into a digest fails earlier than that — in parsing — and the
   * supervisor died with `PersistenceCorruptionError` before deciding anything.
   *
   * A crash and a refusal are not the same event: one is a fault to debug, the
   * other is a verdict with an instruction attached.
   */
  it("returns WAITING_FOR_HUMAN when the persisted digest is malformed", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const dbPath = tempDbPath("t8-unparseable");

    const repository = createSqliteSupervisorRepository(dbPath);
    const seeded = await repository.create({
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [],
      roadmap: [
        { key: "A", title: "Implemented", dependsOn: [], status: "DONE", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
      ],
      checkpoints: [],
      escalations: [],
      provenance: chainFor("claude-code:opus"),
      provenanceAnchor: anchorFor(chainFor("claude-code:opus")),
      updatedAt: 1_000,
    });
    repository.close();

    const db = new DatabaseSync(dbPath);
    const forged = seeded.provenance.map((entry, index) =>
      index === 0 ? { ...entry, digest: "prov-forged" } : entry,
    );
    db.prepare("UPDATE supervisor_state SET data = ? WHERE id = ?").run(
      JSON.stringify({ ...seeded, provenance: forged }),
      "supervisor",
    );
    db.close();

    const reopened = createSqliteSupervisorRepository(dbPath);
    const supervisor = newSupervisor({
      /**
       * DECLARED, or the catalog refuses first (round-14 lesson).
       *
       * These fixtures persist a single item `A` and used to build the
       * supervisor on the DEFAULT catalog, so TASK-012 refused the state at
       * catalog reconciliation and the tick never reached the guard the case is
       * about. The assertion is `WAITING_FOR_HUMAN` either way, so the case
       * stayed green while proving nothing — the same false-green the reviewer
       * found twice elsewhere, in fixtures I wrote.
       */
      roadmap: [
        { key: "A", title: "Implemented", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
      ],
      probe: healthyProbe(),
      repository: reopened,
    });
    try {
      const result = await supervisor.service.tick();
      assert.equal(result.kind, "WAITING_FOR_HUMAN", "an unparseable record must produce a decision");
      if (result.kind === "WAITING_FOR_HUMAN") {
        assert.match(result.humanActionRequired, /could not|no longer parses/i);
      }
      assert.equal(supervisor.executor.calls().length, 0);
    } finally {
      reopened.close();
    }
  });

  /**
   * DELIBERATELY NARROW. A refusal to WRITE must keep propagating, or the
   * conversion above would mask `runTick`'s own pre-write guard — the mistake
   * this project keeps finding in other places.
   */
  it("does not convert a refusal to WRITE into a decision", async () => {
    const source = readFileSync("src/supervision/supervisorService.ts", "utf8");
    assert.match(source, /Only failures to READ are converted/);
    assert.ok(
      !/catch \(error\) \{[^}]*instanceof SchemaIntegrityError[^}]*\}\s*await this\.publishWake/s.test(source),
      "tick() must not swallow a write refusal",
    );
  });
});

describe("TASK-008 round 8: status asks the anchor", () => {
  /**
   * HIGH. `verifyChain` asks whether every link still hashes to its successor,
   * and tail TRUNCATION leaves that perfectly true. The reviewer removed the
   * second of two entries from real SQLite and status reported
   * "1 entries, chain intact".
   *
   * The anchor is the only record that knows how long the chain was. The
   * existing status tests passed for the wrong reason: they edit CONTENT, which
   * breaks the links, so they never needed the anchor at all.
   */
  it("reports a TRUNCATED chain as broken", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const dbPath = tempDbPath("t8-truncated-status");

    const full = chainFor("claude-code:opus");
    const extended = appendImplementerProvenance(full, "A", "codex-cli:gpt-5.6-luna", 2_000, "second run");
    assert.ok(extended.length >= 2, "the fixture needs at least two entries to truncate one");

    const repository = createSqliteSupervisorRepository(dbPath);
    const seeded = await repository.create({
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [],
      roadmap: [
        { key: "A", title: "Implemented", dependsOn: [], status: "DONE", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
      ],
      checkpoints: [],
      escalations: [],
      provenance: extended,
      provenanceAnchor: anchorFor(extended),
      updatedAt: 1_000,
    });
    repository.close();

    const truncated = seeded.provenance.slice(0, -1);
    assert.equal(verifyChain(truncated).intact, true, "truncation must leave the LINKS intact, or this proves nothing");

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE supervisor_state SET data = ? WHERE id = ?").run(
      JSON.stringify({ ...seeded, provenance: truncated }),
      "supervisor",
    );
    db.close();

    const lines: string[] = [];
    await runSuperviseStatus({ supervisorDbPath: dbPath, log: (line: string) => lines.push(line) });
    const output = lines.join("\n");
    assert.match(output, /CHAIN BROKEN/, "a truncated chain read as intact");
    assert.match(output, /tamper-evident, not tamper-proof/);
  });
});

// =====================================================================
// ROUND-9 — one place records lineage, and the public read path reconciles
// =====================================================================

describe("TASK-008 round 9: every path a worker can leave by records that it ran", () => {
  /**
   * HIGH. Round 8 fixed `CHECKPOINT` and `RESOURCE_FAILURE`; round 9 found
   * `HUMAN_REQUIRED`, the unverified-`COMPLETED` refusal and the
   * mismatched-identity refusal still recording nothing, and `lastRunConfig`
   * missing from the two paths round 8 had just fixed.
   *
   * That is one defect, not five: lineage was written inside each outcome
   * branch, so every branch was a fresh chance to forget. It is recorded once
   * now, before the branches, on the only fact that decides it — a worker ran.
   */
  async function afterOutcome(outcome: WorkOutcome) {
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      executor: scriptedExecutor({ A: [outcome] }),
    });
    await seedRoadmap(supervisor, [
      { key: "A", title: "First item", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ]);
    await supervisor.service.tick();
    const state = (await supervisor.repository.load())!;
    const item = state.roadmap.find((entry) => entry.key === "A")!;
    return {
      provenance: state.provenance.filter((entry) => entry.kind === "IMPLEMENTED_BY" && entry.roadmapKey === "A"),
      implementers: item.implementedByResourceKeys ?? [],
      runConfig: item.lastRunConfig,
      anchor: state.provenanceAnchor,
    };
  }

  const CASES: readonly (readonly [string, WorkOutcome])[] = [
    ["a human is required", { kind: "HUMAN_REQUIRED", action: { kind: "RUN_TESTS", description: "run the suite" }, detail: "needs a person" }],
    ["review returned changes", { kind: "CHANGES_REQUIRED", findings: ["fix it"] }],
    ["the provider failed", { kind: "RESOURCE_FAILURE", process: { terminationReason: "EXITED", exitCode: 1, stdout: "", stderr: "quota" } }],
    ["it completed without saying what ran", { kind: "COMPLETED", detail: "done", reportedIdentity: {} }],
  ];

  for (const [label, outcome] of CASES) {
    it(`records the implementer and the run configuration when ${label}`, async () => {
      const after = await afterOutcome(outcome);
      assert.ok(after.provenance.length > 0, "the chain does not know a worker ran");
      assert.ok(after.implementers.length > 0, "the row does not know a worker ran");
      assert.notEqual(after.runConfig, undefined, "the authorized configuration was not recorded");
      assert.deepEqual(
        after.anchor,
        { length: after.anchor?.length ?? -1, headDigest: after.anchor?.headDigest ?? "" },
        "an anchor must accompany the chain it describes",
      );
      assert.equal(after.anchor?.length, after.provenance.length, "the anchor disagrees with the chain it was written beside");
    });
  }

  /** A worker that reports a DIFFERENT model still ran, so it is still recorded. */
  it("records the implementer when the reported identity contradicts the request", async () => {
    const after = await afterOutcome({
      kind: "COMPLETED",
      detail: "done",
      reportedIdentity: { provider: "some-other-provider", model: "some-other-model" },
    });
    assert.ok(after.provenance.length > 0, "a contradicted run left no trace of having happened");
    assert.ok(after.implementers.length > 0);
  });
});

describe("TASK-008 round 9: the roadmap command does not repeat a forgery", () => {
  /**
   * HIGH. `sf supervise roadmap` read `state.roadmap` and printed it, so a
   * forged title and order came straight back out of the tool an operator uses
   * to check the roadmap: "999. LOCAL_24_7_RUNTIME  FORGED DATABASE TITLE".
   *
   * The tick refuses such a database, which is the important half. A public read
   * path that presents the row as the definition undoes the point of having a
   * catalog at all.
   */
  it("reports the disagreement instead of printing the persisted title", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const dbPath = tempDbPath("t8-forged-roadmap");

    const repository = createSqliteSupervisorRepository(dbPath);
    const seeded = await repository.create({
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [],
      roadmap: DEFAULT_ROADMAP.map((item) => ({ ...item, dependsOn: [...item.dependsOn] })),
      checkpoints: [],
      escalations: [],
      provenance: [],
      updatedAt: 1_000,
    });
    repository.close();

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE supervisor_state SET data = ? WHERE id = ?").run(
      JSON.stringify({
        ...seeded,
        roadmap: seeded.roadmap.map((item) =>
          item.key === "LOCAL_24_7_RUNTIME" ? { ...item, title: "FORGED DATABASE TITLE", order: 999 } : item,
        ),
      }),
      "supervisor",
    );
    db.close();

    const lines: string[] = [];
    await runSuperviseRoadmap({ supervisorDbPath: dbPath, log: (line: string) => lines.push(line) });
    const output = lines.join("\n");

    assert.match(output, /DISAGREES WITH THIS INSTALLATION'S CATALOG/, "the forgery was printed as fact");
    assert.match(output, /"title"/, "the disagreeing field must be named");

    /**
     * The LISTING is what must not repeat the forgery.
     *
     * The diagnostic above quotes the persisted value deliberately — an operator
     * needs to see what the database claims in order to recognise it. What would
     * be wrong is presenting that value as the item's title, on the line an
     * operator reads as the roadmap.
     */
    const listed = lines.filter((line) => /^\s*\d+\.\s+LOCAL_24_7_RUNTIME/.test(line));
    assert.equal(listed.length, 1, "the item must still be listed exactly once");
    assert.ok(!(listed[0] ?? "").includes("FORGED DATABASE TITLE"), "the forged title was listed as the title");
    assert.match(listed[0] ?? "", /Reliable restartable WSL2 runtime/, "the catalog's own title must be listed");
    assert.ok(!(listed[0] ?? "").startsWith("999"), "the forged order was used for display");
  });

  /** NEGATIVE CONTROL: an untampered database prints normally. */
  it("prints an untampered roadmap without complaint", async () => {
    const dbPath = tempDbPath("t8-clean-roadmap");
    const repository = createSqliteSupervisorRepository(dbPath);
    await repository.create({
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [],
      roadmap: DEFAULT_ROADMAP.map((item) => ({ ...item, dependsOn: [...item.dependsOn] })),
      checkpoints: [],
      escalations: [],
      provenance: [],
      updatedAt: 1_000,
    });
    repository.close();

    const lines: string[] = [];
    await runSuperviseRoadmap({ supervisorDbPath: dbPath, log: (line: string) => lines.push(line) });
    const output = lines.join("\n");
    assert.ok(!output.includes("DISAGREES"), "a legitimate roadmap was reported as forged");
    assert.match(output, /LOCAL_24_7_RUNTIME/);
  });
});

describe("TASK-008 round 9: deleting the anchor is not a way out", () => {
  /**
   * THE REVIEWER'S REPRODUCTION, end to end.
   *
   * A valid chain recorded two runs of `A` — first Codex, then Claude. Direct
   * SQLite tampering removed the second provenance entry, removed Claude from
   * the row's history, removed `lastRunConfig`, and REMOVED THE ANCHOR. The next
   * tick advanced and handed the review of `B` to `claude-code:opus` — the
   * deleted tail implementer, reviewing work it had done.
   *
   * No digest had to be recomputed. The record that would have objected was
   * simply deleted, because an absent anchor was read as silence.
   */
  it("REFUSES a chain whose tail and anchor were deleted together", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const dbPath = tempDbPath("t8-anchor-deleted");

    const first = chainNamingBoth();
    const repository = createSqliteSupervisorRepository(dbPath);
    const seeded = await repository.create({
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [],
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
          implementedByResourceKeys: ["codex-cli:gpt-5.6-luna", "claude-code:opus"],
        } as RoadmapItem,
      ],
      checkpoints: [],
      escalations: [],
      provenance: first,
      provenanceAnchor: anchorFor(first),
      updatedAt: 1_000,
    });
    repository.close();
    assert.equal(seeded.provenance.length, 2, "the fixture needs two runs to delete one");

    const db = new DatabaseSync(dbPath);
    const { provenanceAnchor: _deleted, ...withoutAnchor } = seeded;
    void _deleted;
    db.prepare("UPDATE supervisor_state SET data = ? WHERE id = ?").run(
      JSON.stringify({
        ...withoutAnchor,
        // The tail entry, the row's memory of Claude, and the anchor — all gone.
        provenance: seeded.provenance.slice(0, 1),
        roadmap: seeded.roadmap.map((item) =>
          item.key === "A"
            ? { ...item, implementedByResourceKeys: ["codex-cli:gpt-5.6-luna"], lastRunConfig: undefined }
            : item,
        ),
      }),
      "supervisor",
    );
    db.close();

    const reopened = createSqliteSupervisorRepository(dbPath);
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      repository: reopened,
      roadmap: [
        { key: "B", title: "Review of A", dependsOn: ["A"], status: "PENDING", workClass: "INDEPENDENT_REVIEW", order: 1 },
        { key: "A", title: "Implemented", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 2 },
      ],
    });
    try {
      const result = await supervisor.service.tick();
      assert.equal(result.kind, "WAITING_FOR_HUMAN", "deleting the anchor let the tail implementer review its own work");
      for (const call of supervisor.executor.calls()) {
        assert.notEqual(call.item.key, "B", "the review ran on a chain that had been cut");
      }
    } finally {
      reopened.close();
    }
  });
});

/** Two recorded runs of `A`: Codex first, then Claude. */
function chainNamingBoth(): readonly ProvenanceEntry[] {
  const one = chainFor("codex-cli:gpt-5.6-luna");
  return appendImplementerProvenance(one, "A", "claude-code:opus", 2_000, "completed");
}

describe("TASK-011 round 9: a worker that handed over mid-item is still excluded", () => {
  /**
   * THE REVIEWER'S REPRODUCTION, driven exactly as it was reported.
   *
   * R1 runs item A and CHECKPOINTS. R1 becomes unavailable. R2 resumes A and
   * COMPLETES it. R1 becomes available again — and reviewed A's dependent,
   * because the append-only history contained only the resource that FINISHED.
   * `lastRunConfig` could not repair it either: it had been overwritten with R2.
   *
   * The defect was never in the executor adapter; it was in which supervisor
   * paths recorded lineage. It is fixed by recording once, before the outcome
   * branches, which is why this case lives beside the rest of that work.
   */
  it("does not let the checkpointing resource review the dependent", async () => {
    const R1 = { provider: "claude-code", model: "sonnet" };
    const R2 = { provider: "codex-cli", model: "gpt-5.6-luna" };
    const probe = scriptedProbe();
    const available = (entry: { provider: string; model: string }) =>
      probe.set(entry.provider, entry.model, {
        state: "AVAILABLE",
        reason: "scripted",
        billingMode: "INCLUDED_SUBSCRIPTION",
      });
    const unavailable = (entry: { provider: string; model: string }) =>
      probe.set(entry.provider, entry.model, { state: "PROVIDER_UNAVAILABLE", reason: "scripted outage" });

    // Only R1 can run at first, so the checkpoint is definitely R1's.
    available(R1);
    unavailable(R2);
    probe.set("claude-code", "opus", { state: "PROVIDER_UNAVAILABLE", reason: "scripted outage" });

    const supervisor = newSupervisor({
      probe,
      executor: scriptedExecutor({
        // CHECKPOINT then COMPLETED: the fixture repeats its LAST outcome, so a
        // one-entry script means A never finishes and B is never selected.
        A: [
          {
            kind: "CHECKPOINT",
            detail: "context exhausted",
            checkpoint: {
              roadmapKey: "A",
              actionId: "ignored",
              requiredWorkClass: "NORMAL_IMPLEMENTATION",
              iteration: 1,
              nextAction: "resume",
              findings: [],
              completedVerification: [],
              pendingVerification: [],
              updatedAt: 1,
            },
          },
          { kind: "COMPLETED", detail: "finished after the rollover" },
        ],
      }),
    });
    await seedRoadmap(supervisor, [
      { key: "A", title: "First item", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
      { key: "B", title: "Review of A", dependsOn: ["A"], status: "PENDING", workClass: "INDEPENDENT_REVIEW", order: 2 },
    ]);

    await supervisor.service.tick(); // A checkpoints on R1
    const checkpointed = supervisor.executor.callsFor("A").at(-1);
    assert.ok(checkpointed !== undefined, "A must have run once");
    const r1Key = `${R1.provider}:${R1.model}`;
    assert.equal(
      `${checkpointed.config?.effectiveProvider ?? ""}:${checkpointed.config?.effectiveModel ?? ""}`,
      r1Key,
      "the fixture must put the checkpoint on R1, or it proves nothing",
    );

    // R1 goes away; R2 resumes and finishes.
    unavailable(R1);
    available(R2);
    await supervisor.service.tick();

    // R1 comes back, and must NOT be handed the review of A's dependent.
    available(R1);
    await supervisor.service.tick();

    for (const call of supervisor.executor.callsFor("B")) {
      const used = `${call.config?.effectiveProvider ?? ""}:${call.config?.effectiveModel ?? ""}`;
      assert.notEqual(used, r1Key, "the resource that checkpointed A reviewed the item that depends on A");
    }

    const state = (await supervisor.repository.load())!;
    const history = state.roadmap.find((item) => item.key === "A")?.implementedByResourceKeys ?? [];
    assert.ok(history.includes(r1Key), "the history forgot the resource that handed over");
  });
});

describe("TASK-011 round 11: an item that RAN and lost its records", () => {
  /**
   * THE REVIEWER'S REPRODUCTION, and the correction of my own answer to it.
   *
   * `B` is an independent review of `A`. It runs, returns CHANGES_REQUIRED and
   * stays ELIGIBLE. Deleting its implementer history, its `lastRunConfig`, the
   * chain and the anchor let the SAME resource review it again.
   *
   * I had argued this was the keyless floor — that what remains is
   * indistinguishable from a database where the work never happened. It is not:
   * `attempts` survives. My objection to using it was that `attempts` is
   * incremented when an action is CLAIMED, one commit before the launch, so a
   * supervisor killed in that window would leave it set with no lineage and be
   * refused forever.
   *
   * The reviewer's answer was better than the objection: claim reconciliation
   * ALREADY proves the launch never happened, so it can record that. Attempts
   * that reached a worker are `attempts - unlaunchedAttempts`, and a worker that
   * ran leaves lineage. The negative control below is the half that makes this
   * safe rather than merely strict.
   */
  it("REFUSES to review an item whose launched attempt lost its lineage", async () => {
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      executor: scriptedExecutor({ B: [{ kind: "CHANGES_REQUIRED", findings: ["needs work"] }] }),
      roadmap: [
        { key: "A", title: "Ancestor", dependsOn: [], status: "PENDING", workClass: "DETERMINISTIC", order: 1, declaredActionKinds: ["RUN_TESTS"] },
        { key: "B", title: "Review of A", dependsOn: ["A"], status: "PENDING", workClass: "INDEPENDENT_REVIEW", order: 2 },
      ],
    });
    await seedRoadmap(supervisor, supervisor.catalog);

    await supervisor.service.tick(); // A
    await supervisor.service.tick(); // B reviews, returns CHANGES_REQUIRED

    const ran = (await supervisor.repository.load())!;
    const reviewed = ran.roadmap.find((item) => item.key === "B");
    assert.equal(reviewed?.status, "ELIGIBLE", "the fixture needs B left ELIGIBLE by a review");
    assert.ok((reviewed?.attempts ?? 0) > 0, "the fixture needs B to have actually run");
    const usedForReview = (reviewed?.implementedByResourceKeys ?? [])[0];
    assert.ok(usedForReview !== undefined, "the fixture needs lineage before it is deleted");

    // The four deletions from the reviewer's reproduction, and nothing else.
    const { provenanceAnchor: _gone, ...withoutAnchor } = ran;
    void _gone;
    await supervisor.repository.compareAndSave(
      {
        ...withoutAnchor,
        version: ran.version + 1,
        provenance: [],
        roadmap: ran.roadmap.map((item) => {
          if (item.key !== "B") return item;
          const { implementedByResourceKeys: _a, implementedByResourceKey: _b, lastRunConfig: _c, ...rest } = item;
          void _a;
          void _b;
          void _c;
          return rest;
        }),
      },
      ran.version,
    );

    const result = await supervisor.service.tick();
    assert.equal(result.kind, "WAITING_FOR_HUMAN", "deleting the records let the same reviewer run again");
    if (result.kind === "WAITING_FOR_HUMAN") {
      assert.match(result.humanActionRequired, /reached a worker/);
    }
  });

  /**
   * THE NEGATIVE CONTROL, and the reason this is not simply "refuse anything
   * with attempts".
   *
   * A claim that was CLAIMED and never launched is an ordinary crash. It leaves
   * `attempts` set and no lineage — and it must still resume, because nothing
   * ran. Without this the guard above would strand an item on any supervisor
   * death in a one-commit window.
   */
  it("still resumes an item whose claimed attempt never launched", async () => {
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      roadmap: [
        { key: "A", title: "Work", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
      ],
    });
    await seedRoadmap(supervisor, supervisor.catalog);
    const seeded = (await supervisor.repository.load())!;
    await supervisor.repository.compareAndSave(
      {
        ...seeded,
        version: seeded.version + 1,
        roadmap: seeded.roadmap.map((item) => ({ ...item, status: "ACTIVE" as const, attempts: 1 })),
        activeClaim: {
          actionId: "A:LAUNCH_AI_WORKER:a1",
          roadmapKey: "A",
          kind: "LAUNCH_AI_WORKER",
          state: "CLAIMED",
          ownerId: "supervisor:crashed",
          attempt: 1,
          claimedAt: 0,
        },
      },
      seeded.version,
    );

    /**
     * ASSERTS THE RESUME, not merely the absence of a refusal (round-12 note).
     *
     * `notEqual(WAITING_FOR_HUMAN)` was satisfied by `WAITING_FOR_RESOURCE` too,
     * so removing the resource refresh left this green while the item never
     * reached an executor at all. "Not refused" is not "resumed".
     */
    const result = await supervisor.service.tick();
    assert.notEqual(result.kind, "WAITING_FOR_HUMAN", "an ordinary crash before launch stranded the item");

    const after = (await supervisor.repository.load())!;
    const item = after.roadmap.find((entry) => entry.key === "A");
    assert.equal(item?.unlaunchedAttempts, 1, "reconciliation must record the attempt it proved never launched");

    // The claim is cleared on this tick; the NEXT one is where it runs.
    await supervisor.service.tick();
    assert.ok(
      supervisor.executor.callsFor("A").length > 0,
      "the item was never refused and never resumed either — it simply stopped",
    );
  });

  /** The PARTIAL deletion is still caught by the anchor, as before. */
  it("still catches a deletion that forgets the anchor", () => {
    const ran = chainFor("claude-code:opus");
    const verdict = verifyAgainstAnchor([], anchorFor(ran));
    assert.equal(verdict.intact, false, "a chain deleted under a surviving anchor must be visible");
  });
});

describe("TASK-008 round 13: the chain names an item the roadmap no longer has", () => {
  /**
   * WHAT THE CHAIN-KEY TRAVERSAL IS STILL THE ONLY ANSWER TO.
   *
   * Round-13 review showed the dependency-edit case no longer reaches it —
   * TASK-012 refuses an edited `dependsOn` before the walk runs. That left the
   * traversal untested, and a mutation removing it passed the whole suite.
   *
   * Its remaining job is the case the roadmap cannot describe: the chain records
   * work on a key that is NOT in the roadmap any more — removed, renamed, or
   * simply never declared here. `visited` is built from catalog edges, so it can
   * never contain that key, and only the chain's own list of keys can. The
   * implementer of that work must still be excluded, because the work still
   * happened.
   *
   * SERVICE-LEVEL DEFENCE IN DEPTH, and said plainly because round-14 review
   * measured what this test can and cannot claim. Through the DURABLE path this
   * state is unreachable: `parseSupervisorState` refuses a chain entry naming a
   * roadmap item that does not exist, with "provenance entry 0 references
   * unknown roadmap item". So a real SQLite database can never present it, and
   * this test drives the in-memory repository to reach the service branch at
   * all.
   *
   * That makes it a guard against a state the DESERIALIZER already refuses —
   * worth keeping, since the two refusals are independent and a future
   * relaxation of either should not silently open the other, and worth labelling
   * honestly rather than presenting as a durable-path regression. Recorded in
   * docs/KNOWN-LIMITATIONS.md L-8 with the other guards of this kind.
   */
  it("excludes the implementer of a chain entry whose roadmap item is gone (in-memory; see L-8)", async () => {
    const ONLY = "claude-code:opus";
    const probe = scriptedProbe();
    probe.set("claude-code", "opus", {
      state: "AVAILABLE",
      reason: "scripted",
      billingMode: "INCLUDED_SUBSCRIPTION",
    });
    for (const entry of TEST_CATALOG) {
      if (`${entry.provider}:${entry.model}` === ONLY) continue;
      probe.set(entry.provider, entry.model, { state: "PROVIDER_UNAVAILABLE", reason: "scripted outage" });
    }

    const supervisor = newSupervisor({
      probe,
      roadmap: [
        { key: "A", title: "Ancestor", dependsOn: [], status: "PENDING", workClass: "DETERMINISTIC", order: 1, declaredActionKinds: ["RUN_TESTS"] },
        { key: "B", title: "Review of A", dependsOn: ["A"], status: "PENDING", workClass: "INDEPENDENT_REVIEW", order: 2 },
      ],
    });
    await seedRoadmap(supervisor, supervisor.catalog);

    // The chain records work by the only routable resource on an item this
    // roadmap does not contain.
    const gone = appendProvenance([], {
      kind: "IMPLEMENTED_BY",
      roadmapKey: "REMOVED_ITEM",
      resourceKey: ONLY,
      detail: "implemented before the item was renamed",
      recordedAt: 1_000,
    });
    assert.equal(gone.ok, true);
    if (!gone.ok) throw new Error("unreachable");

    const state = (await supervisor.repository.load())!;
    await supervisor.repository.compareAndSave(
      {
        ...state,
        version: state.version + 1,
        roadmap: state.roadmap.map((item) =>
          item.key === "A" ? { ...item, status: "DONE" as const } : { ...item, status: "ELIGIBLE" as const },
        ),
        provenance: gone.chain,
        provenanceAnchor: anchorFor(gone.chain),
      },
      state.version,
    );

    await supervisor.service.tick();

    for (const call of supervisor.executor.callsFor("B")) {
      const used = `${call.config?.effectiveProvider ?? ""}:${call.config?.effectiveModel ?? ""}`;
      assert.notEqual(used, ONLY, "the implementer named only by the chain reviewed dependent work");
    }
  });
});

// =====================================================================
// ROUND-15 — the frozen verification plans, taken literally
// =====================================================================

/**
 * A real database holding a two-entry chain for `A`, and a review `B` that
 * depends on it. Returned open so a caller can tamper with the row directly.
 */
async function realDatabaseWithChain(label: string) {
  const dbPath = tempDbPath(label);
  /**
   * BOTH runs by the SAME resource, so a reviewer remains (round-16 finding).
   *
   * The routing policy allows exactly two resources to perform
   * `INDEPENDENT_REVIEW`, and the fixture had `A` implemented by both — so C4
   * correctly excluded every possible reviewer and the clean control stopped at
   * WAITING_FOR_RESOURCE. It then "passed" only because it asserted the result
   * was not a human refusal.
   *
   * Two entries are still needed for the delete and reorder modes; nothing
   * requires them to name different resources.
   */
  const first = chainFor("codex-cli:gpt-5.6-luna");
  const chain = appendImplementerProvenance(first, "A", "codex-cli:gpt-5.6-luna", 2_000, "completed again");

  const repository = createSqliteSupervisorRepository(dbPath);
  const seeded = await repository.create({
    version: 1,
    financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
    /**
     * Seeded, or nothing can advance and the clean control proves nothing.
     * `claude-code:sonnet` is the third reviewer: the other two implemented `A`
     * and are correctly excluded from reviewing it.
     */
    resources: TEST_CATALOG.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      key: `${entry.provider}:${entry.model}`,
      state: "UNKNOWN_FAILURE" as const,
      detectedAt: 1_000,
      lastCheckedAt: 0,
      backoff: { attempt: 0, delayMs: 0 },
      diagnostic: "never probed",
    })),
    roadmap: [
      { key: "A", title: "Implemented", dependsOn: [], status: "DONE", workClass: "NORMAL_IMPLEMENTATION", order: 1, attempts: 1, implementedByResourceKeys: ["codex-cli:gpt-5.6-luna"] } as RoadmapItem,
      { key: "B", title: "Review of A", dependsOn: ["A"], status: "ELIGIBLE", workClass: "INDEPENDENT_REVIEW", order: 2 },
    ],
    checkpoints: [],
    escalations: [],
    provenance: chain,
    provenanceAnchor: anchorFor(chain),
    updatedAt: 1_000,
  });
  repository.close();
  return { dbPath, seeded };
}

/** Writes `state` straight into the row, the way anything with file access would. */
async function writeRowDirectly(dbPath: string, state: unknown): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE supervisor_state SET data = ? WHERE id = ?").run(JSON.stringify(state), "supervisor");
  db.close();
}

/** The catalog those fixtures declare, so TASK-012 is not what refuses. */
const REAL_DB_CATALOG: readonly RoadmapItem[] = [
  { key: "A", title: "Implemented", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
  { key: "B", title: "Review of A", dependsOn: ["A"], status: "PENDING", workClass: "INDEPENDENT_REVIEW", order: 2 },
];

describe("TASK-008: the four tamper modes, every one through real SQLite", () => {
  /**
   * THE FROZEN VERIFICATION PLAN, TAKEN LITERALLY.
   *
   * It asks for "chain tampering driven by mutating a real persisted log: edit,
   * delete, reorder, append-with-wrong-digest — each must be detected and
   * named", and for "fail-closed behaviour driven end-to-end through the
   * supervisor, not only at the unit level".
   *
   * Round-15 review found that only some of those ran against SQLite; the rest
   * used the in-memory repository or passed arrays straight to `verifyChain`. A
   * unit test of the verifier is not the same claim as a database that has been
   * edited underneath a running supervisor, and the plan asked for the second.
   */
  const TAMPERS: readonly (readonly [string, (chain: readonly ProvenanceEntry[]) => readonly unknown[]])[] = [
    ["edit", (chain) => chain.map((entry, index) => (index === 0 ? { ...entry, detail: "edited on disk" } : entry))],
    ["delete", (chain) => chain.slice(1)],
    ["reorder", (chain) => [chain[1], chain[0]]],
    [
      "append-with-wrong-digest",
      /**
       * A GENUINE APPEND (round-16 finding).
       *
       * This copied the last entry unchanged — same `sequence`, same `digest` —
       * so the refusal came from the sequence guard ("an entry was deleted or
       * reordered"), and the broad regex below accepted it. The case named one
       * guard and exercised another.
       *
       * A real append continues the sequence and hashes itself honestly; the
       * ONLY thing wrong is the predecessor it claims. That is the mode the
       * frozen plan asks for, and nothing else can produce that refusal.
       */
      (chain) => {
        const last = chain[chain.length - 1]!;
        const forged = {
          sequence: last.sequence + 1,
          kind: "IMPLEMENTED_BY" as const,
          roadmapKey: "A",
          resourceKey: "claude-code:opus",
          detail: "appended onto a predecessor that is not the head",
          recordedAt: 3_000,
          // The head's digest is what this SHOULD be. It is not.
          previousDigest: chain[0]!.digest,
        };
        return [...chain, { ...forged, digest: computeDigest(forged) }];
      },
    ],
  ];

  for (const [mode, tamper] of TAMPERS) {
    it(`DETECTS and NAMES a ${mode} of the persisted log, through the supervisor`, async () => {
      const { dbPath, seeded } = await realDatabaseWithChain(`t8-sqlite-${mode}`);
      await writeRowDirectly(dbPath, { ...seeded, provenance: tamper(seeded.provenance) });

      const reopened = createSqliteSupervisorRepository(dbPath);
      const supervisor = newSupervisor({
        probe: healthyProbe(),
        repository: reopened,
        roadmap: REAL_DB_CATALOG,
      });
      try {
        const result = await supervisor.service.tick();
        assert.equal(result.kind, "WAITING_FOR_HUMAN", `a ${mode} of the durable log was not detected`);
        if (result.kind === "WAITING_FOR_HUMAN") {
          // NAMED, not merely refused: the operator has to know what is wrong.
          assert.match(
            result.humanActionRequired,
            /provenance|chain|parses/i,
            `the refusal for a ${mode} does not say it is about the log`,
          );
          /**
           * ...and named SPECIFICALLY where a mode has its own signature. A
           * regex broad enough to accept every refusal accepts the wrong one
           * too, which is how the append case came to be exercising the
           * sequence guard.
           */
          if (mode === "append-with-wrong-digest") {
            assert.match(
              result.humanActionRequired,
              /previous|predecessor/i,
              "the append refusal does not name the predecessor it disagrees about",
            );
          }
          if (mode === "delete" || mode === "reorder") {
            assert.match(result.humanActionRequired, /deleted or reordered|sequence/i);
          }
        }
        assert.equal(supervisor.executor.calls().length, 0, "work ran on a tampered log");
      } finally {
        reopened.close();
      }
    });
  }

  /**
   * NEGATIVE CONTROL — and it has to ADVANCE, not merely fail to refuse
   * (round-16 finding).
   *
   * It asserted `notEqual(WAITING_FOR_HUMAN)`, which `WAITING_FOR_RESOURCE`
   * satisfies. The fixture seeded no resources, so the tick stopped with "no
   * eligible resource for INDEPENDENT_REVIEW" and the control passed having
   * demonstrated nothing about tampering.
   *
   * That is the same "not refused is not succeeded" mistake I fixed in the
   * TASK-012 control two rounds ago, made again here. The fixture now seeds
   * resources and the control asserts the review actually RAN.
   */
  it("still advances on an untampered real database", async () => {
    const { dbPath } = await realDatabaseWithChain("t8-sqlite-clean");
    const reopened = createSqliteSupervisorRepository(dbPath);
    const supervisor = newSupervisor({
      probe: healthyProbe(),
      repository: reopened,
      roadmap: REAL_DB_CATALOG,
    });
    try {
      const result = await supervisor.service.tick();
      assert.equal(result.kind, "ADVANCED", "an untampered database did not advance");
      assert.ok(
        supervisor.executor.calls().length > 0,
        "nothing reached the executor, so this control proves nothing about tampering",
      );
    } finally {
      reopened.close();
    }
  });
});
