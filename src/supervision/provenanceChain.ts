/**
 * Tamper-EVIDENT provenance for implementer lineage (TASK-008, closing R9-C4-1).
 *
 * ================================================================
 * WHAT THIS IS, AND — more importantly — WHAT IT IS NOT
 * ================================================================
 * This is a hash chain with NO SECRET. It makes edits to recorded history
 * DETECTABLE. It does not make them IMPOSSIBLE, and it does not detect an
 * attacker who recomputes the chain after editing it, because with no key there
 * is nothing they cannot recompute.
 *
 * It is tamper-EVIDENT, not tamper-PROOF. Anything in this codebase that claims
 * otherwise is wrong (AC-8), and a test asserts that distinction is stated where
 * an operator will actually read it.
 *
 * Why bother, then? Because the realistic failure here is not a determined
 * attacker with a hash implementation. It is a corrupted row, a partial restore
 * from a backup, a buggy future migration, a hand-edit by someone "just fixing
 * one field" — and against every one of those, a chain that stops verifying is
 * the difference between noticing and not noticing. C4 then fails closed rather
 * than proceeding on history nobody can vouch for.
 *
 * The contrast worth keeping in view: spending authority has no equivalent
 * weakness, because F-1 made it impossible to EXPRESS in data. No row can grant
 * it, so no row has to be trusted. Lineage cannot be built that way — "who ran
 * this last week" is irreducibly a record, and a record is only ever as good as
 * its protection.
 */

import { createHash } from "node:crypto";

import { boundedDiagnostic } from "./resourceClassifier.js";

/** The fixed root every chain starts from. Not a secret; it is published here. */
export const GENESIS_DIGEST = "prov-genesis";

/**
 * Bound on chain length (AC-10).
 *
 * Overflow FAILS CLOSED rather than truncating. Truncation would discard the
 * OLDEST entries — precisely the provenance an attacker most wants gone, and
 * precisely the mistake F6-C4-1 made when "append-only" history evicted from the
 * wrong end.
 */
export const MAX_CHAIN_ENTRIES = 10_000;

/**
 * `PUBLISHED_AS` was added by TASK-016: which commit of a roadmap item reached
 * the remote, and what CI said about that exact commit. It belongs in this
 * chain rather than in a second store because it is the same class of fact the
 * chain already holds — what actually happened to an item — and because a
 * publication record that could be edited without breaking a digest would be
 * worth less than no record at all.
 */
export const PROVENANCE_KINDS = ["IMPLEMENTED_BY", "RUN_CONFIGURED", "BLOCKED", "PUBLISHED_AS"] as const;
export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];

export interface ProvenanceEntry {
  readonly sequence: number;
  readonly kind: ProvenanceKind;
  readonly roadmapKey: string;
  /** The resource this entry is about, when the event names one. */
  readonly resourceKey?: string;
  readonly detail: string;
  readonly recordedAt: number;
  /** Digest of the PREVIOUS entry, chaining this one to everything before it. */
  readonly previousDigest: string;
  /** Digest over this entry's own content plus `previousDigest`. */
  readonly digest: string;
}

/**
 * The canonical serialization a digest is computed over.
 *
 * Explicit field order, explicit separator, no JSON. `JSON.stringify` does not
 * guarantee key order across engines or object construction paths, and a digest
 * whose input can be reordered is a digest that disagrees with itself for
 * reasons unrelated to tampering — which trains everyone to ignore it.
 */
function canonical(entry: Omit<ProvenanceEntry, "digest">): string {
  /**
   * LENGTH-PREFIXED, not separator-joined (round-1 review finding).
   *
   * The first version joined fields with a NUL. A separator only works if it
   * cannot occur INSIDE a field, and nothing guaranteed that: the reviewer
   * moved a NUL into `resourceKey`, took the same bytes back out of `detail`,
   * and produced a DIFFERENT entry with an IDENTICAL digest. A hash whose
   * input boundaries are attacker-controlled is not a hash of the entry.
   *
   * Prefixing each field with its byte length makes the boundaries explicit,
   * so no field content can be mistaken for structure — the reason netstrings
   * exist. Escaping would also work, but it has to be exactly right in both
   * directions forever; this cannot be got subtly wrong.
   */
  /**
   * ABSENT is not EMPTY (round-2 finding). `entry.resourceKey ?? ""` gave an
   * entry with no resource and an entry with an empty one the SAME digest, so
   * one could be rewritten as the other and the chain still verified. The
   * presence flag makes the distinction part of what is hashed.
   */
  const fields = [
    String(entry.sequence),
    entry.kind,
    entry.roadmapKey,
    entry.resourceKey === undefined ? "\u0000absent" : `\u0000present${entry.resourceKey}`,
    entry.detail,
    String(entry.recordedAt),
    entry.previousDigest,
  ];
  return fields.map((field) => `${Buffer.byteLength(field, "utf8")}:${field}`).join("");
}

export function computeDigest(entry: Omit<ProvenanceEntry, "digest">): string {
  return `prov-${createHash("sha256").update(canonical(entry), "utf8").digest("hex")}`;
}

export type AppendResult =
  | { readonly ok: true; readonly chain: readonly ProvenanceEntry[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Appends one event. Existing entries are never rewritten (AC-1).
 *
 * `detail` and `resourceKey` are bounded and redacted before they are hashed, so
 * what is verified is exactly what is stored — sanitizing afterwards would make
 * every entry fail its own digest.
 */
/**
 * Refuses a string that cannot survive UTF-8 unchanged (round-2 finding).
 *
 * A lone surrogate is replaced by U+FFFD when encoded, so a string containing
 * one hashes identically to the string that already had the replacement
 * character — two different values, one digest. Node exposes the test directly.
 */
export function isHashable(value: string): boolean {
  // Written out rather than using `String.prototype.isWellFormed`, which needs
  // an ES2024 lib target this project does not otherwise require. Raising the
  // whole target for one predicate would be a far larger change than the
  // predicate itself.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false; // a high surrogate with no low surrogate after it
      }
      index += 1; // a valid pair, consumed
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false; // a low surrogate with no high surrogate before it
    }
  }
  return true;
}

export function appendProvenance(
  chain: readonly ProvenanceEntry[],
  event: {
    readonly kind: ProvenanceKind;
    readonly roadmapKey: string;
    readonly resourceKey?: string;
    readonly detail: string;
    readonly recordedAt: number;
  },
): AppendResult {
  if (chain.length >= MAX_CHAIN_ENTRIES) {
    return {
      ok: false,
      reason: `provenance chain is at its maximum of ${MAX_CHAIN_ENTRIES} entries; refusing to append rather than discarding the oldest history`,
    };
  }
  for (const [field, value] of [
    ["roadmapKey", event.roadmapKey],
    ["detail", event.detail],
    ["resourceKey", event.resourceKey ?? ""],
  ] as const) {
    if (!isHashable(value)) {
      return {
        ok: false,
        reason: `provenance ${field} is not well-formed UTF-16; it would hash identically to a different string`,
      };
    }
  }
  const last = chain.at(-1);
  const withoutDigest: Omit<ProvenanceEntry, "digest"> = {
    sequence: (last?.sequence ?? -1) + 1,
    kind: event.kind,
    roadmapKey: boundedDiagnostic(event.roadmapKey),
    ...(event.resourceKey === undefined ? {} : { resourceKey: boundedDiagnostic(event.resourceKey) }),
    detail: boundedDiagnostic(event.detail),
    recordedAt: event.recordedAt,
    previousDigest: last?.digest ?? GENESIS_DIGEST,
  };
  return {
    ok: true,
    chain: [...chain, { ...withoutDigest, digest: computeDigest(withoutDigest) }],
  };
}

export type ChainVerdict =
  | { readonly intact: true; readonly entries: number }
  | { readonly intact: false; readonly problem: string; readonly atSequence?: number };

/**
 * Verifies the whole chain (AC-2, AC-3, AC-4).
 *
 * Deterministic and model-free: no AI is consulted about whether history is
 * intact. Each detectable failure is NAMED, because "the chain is broken" sends
 * an operator hunting while "entry 7's digest does not match its content"
 * points at the row.
 */
export function verifyChain(chain: readonly ProvenanceEntry[]): ChainVerdict {
  if (chain.length > MAX_CHAIN_ENTRIES) {
    return { intact: false, problem: `chain exceeds the maximum of ${MAX_CHAIN_ENTRIES} entries` };
  }
  let expectedPrevious = GENESIS_DIGEST;
  for (let index = 0; index < chain.length; index += 1) {
    const entry = chain[index]!;

    if (entry.sequence !== index) {
      // Catches deletion and reordering: sequence numbers are positional, so a
      // removed or swapped entry shows up here even if every digest is valid on
      // its own terms.
      return {
        intact: false,
        problem: `entry at position ${index} claims sequence ${entry.sequence}; an entry was deleted or reordered`,
        atSequence: entry.sequence,
      };
    }
    if (entry.previousDigest !== expectedPrevious) {
      return {
        intact: false,
        problem: `entry ${entry.sequence} chains to ${entry.previousDigest} but the previous entry hashes to ${expectedPrevious}`,
        atSequence: entry.sequence,
      };
    }
    const { digest: _stored, ...content } = entry;
    void _stored;
    const recomputed = computeDigest(content);
    if (recomputed !== entry.digest) {
      return {
        intact: false,
        problem: `entry ${entry.sequence} was edited: its content hashes to ${recomputed}, not the stored ${entry.digest}`,
        atSequence: entry.sequence,
      };
    }
    expectedPrevious = entry.digest;
  }
  return { intact: true, entries: chain.length };
}

/**
 * Every resource the chain says has implemented an item — the SECOND source
 * (AC-6).
 *
 * Returns nothing when the chain does not verify. That is deliberate: a broken
 * chain must not contribute half-believed lineage to a C4 decision, because
 * partial evidence read as complete evidence is how an excluded reviewer gets
 * un-excluded.
 */
export function implementersFromChain(
  chain: readonly ProvenanceEntry[],
  roadmapKey: string,
): readonly string[] | undefined {
  return implementersByRoadmapKey(chain)?.get(roadmapKey) ?? (verifyChain(chain).intact ? [] : undefined);
}

/**
 * The same answer for EVERY item, from ONE verification (AC-10).
 *
 * Asking `implementersFromChain` per ancestor re-verified the whole chain each
 * time, which made a linear check quadratic in the number of ancestors and
 * quietly contradicted the linearity this task claims. Callers walking a
 * lineage should verify once and read many times.
 *
 * Returns `undefined` — not an empty map — when the chain does not verify. A
 * caller that cannot tell "no implementers recorded" from "the record is
 * unreadable" will eventually treat the second as the first, which is how an
 * excluded reviewer becomes eligible.
 */
export function implementersByRoadmapKey(
  chain: readonly ProvenanceEntry[],
): ReadonlyMap<string, readonly string[]> | undefined {
  if (!verifyChain(chain).intact) {
    return undefined;
  }
  const byKey = new Map<string, Set<string>>();
  for (const entry of chain) {
    if (entry.kind !== "IMPLEMENTED_BY" || entry.resourceKey === undefined) {
      continue;
    }
    // NOTE: an IMPLEMENTED_BY with no resourceKey is NOT silence — see
    // `keysWithUnknownImplementer`, which the caller must also consult.
    const found = byKey.get(entry.roadmapKey) ?? new Set<string>();
    found.add(entry.resourceKey);
    byKey.set(entry.roadmapKey, found);
  }
  return new Map([...byKey].map(([key, resources]) => [key, [...resources]]));
}


/**
 * Items the chain says were implemented by SOMEONE IT DOES NOT NAME.
 *
 * Round-3 CRITICAL: `implementersByRoadmapKey` silently discarded an
 * `IMPLEMENTED_BY` entry with no `resourceKey`, so a chain recording that work
 * happened — without saying who did it — read as though nothing had happened
 * at all. A review then advanced and launched the very resource that may have
 * done it.
 *
 * An unknown implementer is MORE dangerous than a missing record, not less:
 * the chain is asserting that someone did the work. That has to fail closed.
 */
export function keysWithUnknownImplementer(chain: readonly ProvenanceEntry[]): ReadonlySet<string> {
  const unknown = new Set<string>();
  for (const entry of chain) {
    if (entry.kind === "IMPLEMENTED_BY" && entry.resourceKey === undefined) {
      unknown.add(entry.roadmapKey);
    }
  }
  return unknown;
}


/**
 * The anchor a chain SHOULD have, given its contents.
 *
 * Kept next to `verifyChain` so the two cannot drift: whatever the chain is,
 * this is what an honest record of it looks like.
 */
export function anchorFor(chain: readonly ProvenanceEntry[]): { length: number; headDigest: string } {
  return { length: chain.length, headDigest: chain.at(-1)?.digest ?? GENESIS_DIGEST };
}

/**
 * Detects TAIL TRUNCATION, which `verifyChain` structurally cannot (AC-3).
 *
 * A valid prefix of a valid chain is a valid chain — that is what a hash chain
 * is. Round-5 review cut the tail and deleted the matching row so that neither
 * record mentioned the removed work, and nothing objected.
 *
 * Comparing against a separately recorded length and head closes it for anyone
 * who does not update BOTH. It is not a trust anchor and is not claimed as one:
 * an attacker who rewrites the chain and the anchor together is still
 * undetected, exactly as the module header says.
 */
export function verifyAgainstAnchor(
  chain: readonly ProvenanceEntry[],
  anchor: { readonly length: number; readonly headDigest: string } | undefined,
): ChainVerdict {
  const structural = verifyChain(chain);
  if (!structural.intact) {
    return structural;
  }
  if (anchor === undefined) {
    /**
     * AN ABSENT ANCHOR IS A DELETION (round-9 CRITICAL).
     *
     * This returned the structural verdict when no anchor was recorded, which
     * made the anchor OPTIONAL from an attacker's point of view: the reviewer
     * truncated the chain, deleted the matching row history, deleted the
     * anchor, and the tail implementer went on to review its own work. No
     * digest had to be recomputed — the record that would have objected was
     * simply removed.
     *
     * A guard that can be switched off by deleting it is not a guard. An anchor
     * is now written with every chain, so a non-empty chain WITHOUT one is a
     * contradiction and says so. An empty chain with no anchor stays legitimate:
     * that is a database with no history, which is the pre-TASK-008 case this
     * has always allowed.
     */
    return chain.length === 0
      ? structural
      : {
          intact: false,
          problem:
            `the chain has ${chain.length} entries but no anchor was recorded; an anchor is written with every ` +
            "chain, so its absence means the record of how long the chain should be was removed",
        };
  }
  const expected = anchorFor(chain);
  if (expected.length !== anchor.length) {
    return {
      intact: false,
      problem: `the chain has ${expected.length} entries but was recorded as having ${anchor.length}; entries were removed from the end`,
    };
  }
  if (expected.headDigest !== anchor.headDigest) {
    return {
      intact: false,
      problem: `the chain ends at ${expected.headDigest} but was recorded as ending at ${anchor.headDigest}`,
    };
  }
  return structural;
}
