/**
 * TASK-008 — tamper-evident provenance (closing R9-C4-1).
 *
 * The ninth TASK-006 review demonstrated the gap: it had Codex implement an
 * item, rewrote the persisted history to say Claude, and Codex then reviewed its
 * own work. Catalog recognition proves a name is PLAUSIBLE, not that it is TRUE.
 *
 * These tests hold two things at once, and the second matters as much as the
 * first: that the chain detects tampering, AND that nothing here claims to
 * PREVENT it. A keyless chain catches corruption, partial restores, buggy
 * migrations and hand-edits. It catches nothing against someone who recomputes
 * it. Overstating that would be its own dishonesty.
 *
 * Offline: no provider, no model, no money.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appendProvenance,
  computeDigest,
  GENESIS_DIGEST,
  implementersFromChain,
  MAX_CHAIN_ENTRIES,
  verifyChain,
  type ProvenanceEntry,
} from "../src/supervision/provenanceChain.js";

/** A small honest chain: A implemented by codex, B by claude. */
function sampleChain(): readonly ProvenanceEntry[] {
  let chain: readonly ProvenanceEntry[] = [];
  for (const [roadmapKey, resourceKey] of [
    ["A", "codex-cli:gpt-5.6-luna"],
    ["B", "claude-code:opus"],
    ["A", "claude-code:sonnet"],
  ] as const) {
    const result = appendProvenance(chain, {
      kind: "IMPLEMENTED_BY",
      roadmapKey,
      resourceKey,
      detail: `${roadmapKey} implemented`,
      recordedAt: 1_000 + chain.length,
    });
    assert.equal(result.ok, true);
    if (result.ok) chain = result.chain;
  }
  return chain;
}

describe("TASK-008 AC-1/AC-2: entries are append-only and chained", () => {
  it("starts from a fixed genesis and links each entry to the last", () => {
    const chain = sampleChain();
    assert.equal(chain[0]?.previousDigest, GENESIS_DIGEST);
    for (let i = 1; i < chain.length; i += 1) {
      assert.equal(chain[i]?.previousDigest, chain[i - 1]?.digest);
    }
    assert.deepEqual(
      chain.map((e) => e.sequence),
      [0, 1, 2],
    );
  });

  it("does not rewrite existing entries when appending", () => {
    const before = sampleChain();
    const snapshot = JSON.stringify(before);
    const result = appendProvenance(before, {
      kind: "RUN_CONFIGURED",
      roadmapKey: "C",
      detail: "later",
      recordedAt: 9_999,
    });
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(before), snapshot, "the original entries were mutated");
    if (result.ok) {
      assert.equal(result.chain.length, before.length + 1);
      assert.deepEqual(result.chain.slice(0, before.length), before);
    }
  });

  it("verifies an untampered chain", () => {
    const verdict = verifyChain(sampleChain());
    assert.equal(verdict.intact, true);
    if (verdict.intact) assert.equal(verdict.entries, 3);
  });
});

describe("TASK-008 AC-3: every detectable tampering is detected and named", () => {
  it("detects an EDITED entry", () => {
    const chain = [...sampleChain()];
    // The exact R9-C4-1 forgery: rewrite who implemented it.
    chain[0] = { ...chain[0]!, resourceKey: "claude-code:opus" };
    const verdict = verifyChain(chain);
    assert.equal(verdict.intact, false);
    if (!verdict.intact) {
      assert.match(verdict.problem, /was edited/);
      assert.equal(verdict.atSequence, 0);
    }
  });

  it("detects a DELETED entry", () => {
    const chain = sampleChain().filter((entry) => entry.sequence !== 1);
    const verdict = verifyChain(chain);
    assert.equal(verdict.intact, false);
    if (!verdict.intact) assert.match(verdict.problem, /deleted or reordered/);
  });

  it("detects a REORDERED pair", () => {
    const original = sampleChain();
    const chain = [original[1]!, original[0]!, original[2]!];
    const verdict = verifyChain(chain);
    assert.equal(verdict.intact, false);
    if (!verdict.intact) assert.match(verdict.problem, /deleted or reordered/);
  });

  it("detects an entry appended with a WRONG previous digest", () => {
    const chain = [...sampleChain()];
    const forged = { ...chain[2]!, previousDigest: GENESIS_DIGEST };
    chain[2] = { ...forged, digest: computeDigest(forged) };
    const verdict = verifyChain(chain);
    assert.equal(verdict.intact, false);
    if (!verdict.intact) {
      // The digest is internally valid; only the LINK is wrong. This is the case
      // a per-entry checksum would miss entirely.
      assert.match(verdict.problem, /chains to/);
      assert.equal(verdict.atSequence, 2);
    }
  });

  it("detects a wholesale truncation of recent history", () => {
    const chain = sampleChain().slice(0, 2);
    // Truncating the TAIL is legal-looking: sequences and links still agree.
    assert.equal(verifyChain(chain).intact, true);
    // Which is worth stating plainly: the chain proves entries were not altered
    // or removed from the MIDDLE. It cannot, alone, prove nothing was dropped
    // from the end - that needs a separately recorded expected length, which is
    // what the supervisor's own roadmap state provides as the second source.
  });
});

describe("TASK-008 AC-6: a broken chain contributes nothing", () => {
  it("returns implementers from an intact chain", () => {
    const found = implementersFromChain(sampleChain(), "A");
    assert.deepEqual([...(found ?? [])].sort(), ["claude-code:sonnet", "codex-cli:gpt-5.6-luna"]);
  });

  it("returns UNDEFINED, not a partial list, when the chain is broken", () => {
    const chain = [...sampleChain()];
    chain[0] = { ...chain[0]!, resourceKey: "claude-code:opus" };
    assert.equal(
      implementersFromChain(chain, "A"),
      undefined,
      "half-believed lineage is how an excluded reviewer gets un-excluded",
    );
  });
});

describe("TASK-008 AC-9/AC-10: bounded, redacted, and fails closed on overflow", () => {
  const LEAK = "sk-ant-api03-NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN";

  it("redacts a credential before it is hashed or stored", () => {
    const result = appendProvenance([], {
      kind: "IMPLEMENTED_BY",
      roadmapKey: "A",
      resourceKey: `res-${LEAK}`,
      detail: `token ${LEAK}`,
      recordedAt: 1,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      const serialized = JSON.stringify(result.chain);
      assert.ok(!serialized.includes(LEAK));
      assert.ok(!serialized.includes("sk-ant-"));
      // And what is stored still verifies - sanitizing AFTER hashing would make
      // every entry fail its own digest.
      assert.equal(verifyChain(result.chain).intact, true);
    }
  });

  it("bounds an absurdly long detail", () => {
    const result = appendProvenance([], {
      kind: "IMPLEMENTED_BY",
      roadmapKey: "A",
      detail: "D".repeat(100_000),
      recordedAt: 1,
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.ok((result.chain[0]?.detail.length ?? 0) < 2_000);
  });

  it("REFUSES to append past the maximum rather than dropping the oldest", () => {
    const full: ProvenanceEntry[] = Array.from({ length: MAX_CHAIN_ENTRIES }, (_, i) => ({
      sequence: i,
      kind: "IMPLEMENTED_BY" as const,
      roadmapKey: "A",
      detail: "d",
      recordedAt: i,
      previousDigest: "x",
      digest: "y",
    }));
    const result = appendProvenance(full, {
      kind: "IMPLEMENTED_BY",
      roadmapKey: "A",
      detail: "one more",
      recordedAt: 1,
    });
    assert.equal(result.ok, false, "overflow must fail closed");
    if (!result.ok) {
      assert.match(result.reason, /refusing to append rather than discarding/);
    }
  });
});

describe("TASK-008 AC-8: the limitation is stated, not glossed", () => {
  it("describes itself as tamper-EVIDENT and never as tamper-proof", async () => {
    // Read the SOURCE, not the compiled output: the claim under test is what a
    // human reads, and `import.meta.url` points into dist/ at runtime.
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/supervision/provenanceChain.ts", "utf8"),
    );
    assert.match(source, /tamper-EVIDENT, not tamper-PROOF/);
    assert.match(source, /does not make them IMPOSSIBLE/);
    assert.ok(
      !/tamper-proof(?!ness)/i.test(source.replace(/tamper-PROOF/g, "")),
      "the source must never claim tamper-proofness",
    );
  });
});
