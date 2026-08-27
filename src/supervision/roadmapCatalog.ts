/**
 * TASK-012 — ROADMAP_STRUCTURAL_INTEGRITY.
 *
 * ================================================================
 * THE DISTINCTION THIS FILE EXISTS FOR
 * ================================================================
 * A roadmap item carries two kinds of field, and TASK-008 inherited a design
 * that persisted them in the same mutable row:
 *
 *   - DEFINITION — `key`, `title`, `workClass`, `dependsOn`, `order`. These are
 *     decisions recorded in source. They do not change because work progressed.
 *   - PROGRESS — `status`, `attempts`, `implementedByResourceKey(s)`,
 *     `lastRunConfig`, `detail`, `humanActionRequired`. These are facts about
 *     what has happened, and they belong in durable state.
 *
 * Persisting the definition next to the progress made the definition editable,
 * and TASK-008's independent review demonstrated two consequences that lineage
 * protection cannot reach, because they attack the item's identity rather than
 * its history:
 *
 *   1. Rewriting a persisted `workClass` from `INDEPENDENT_REVIEW` to
 *      `DETERMINISTIC` made the supervisor skip independent review entirely.
 *      The item ran and reached DONE, accepted without review.
 *   2. Persisting an `INDEPENDENT_REVIEW` item as `DONE` with no review having
 *      happened made its dependents eligible, because dependency truth was
 *      derived from `status === "DONE"` in the same rewritable row.
 *
 * This is the rule TASK-006 already applies to `ResourceRecord.key` and
 * `SupervisorActionClaim.actionId`: a derived value is RECOMPUTED on read, never
 * trusted from the row.
 *
 * ================================================================
 * THE HONEST LIMIT (AC-8)
 * ================================================================
 * This moves the DEFINITION out of reach of a database writer.
 *
 * It does NOT make the database trustworthy. Progress fields remain mutable and remain part of
 * the trusted computing base, exactly as TASK-008 says: anyone who can write the
 * database can still set `attempts`, edit a diagnostic, or claim an item is
 * ELIGIBLE. What they can no longer do is change what an item IS — and in
 * particular they cannot make a review item stop being one.
 *
 * A residue worth naming rather than hiding: `declaredActionKinds` is a
 * definition field by the same argument, and is not enforced here because
 * TASK-012's criteria were frozen around the five fields the demonstrated
 * bypasses used. Widening a frozen scope mid-implementation is the thing C2
 * forbids, so it is recorded in docs/KNOWN-LIMITATIONS.md instead.
 */

import { requiresAi, WORK_CLASSES } from "./modelRouting.js";
import type { RoadmapItem } from "./supervisorTypes.js";

/**
 * The fields a persisted row may NOT decide.
 *
 * Written as a list rather than as four comparisons, because four comparisons
 * are four places to forget one — the omission that produced the `src`-was-not-
 * checked CRITICAL in the verifier, and the `provider`-was-not-a-dimension
 * finding before that.
 */
export const DEFINITION_FIELDS = ["title", "workClass", "dependsOn", "order"] as const;

export type CatalogVerdict =
  | { readonly ok: true; readonly roadmap: readonly RoadmapItem[] }
  | { readonly ok: false; readonly problem: string };

function sameDefinition(field: (typeof DEFINITION_FIELDS)[number], a: RoadmapItem, b: RoadmapItem): boolean {
  if (field === "dependsOn") {
    return a.dependsOn.length === b.dependsOn.length && a.dependsOn.every((key, index) => key === b.dependsOn[index]);
  }
  return a[field] === b[field];
}

/**
 * Rebuilds the roadmap so that every DEFINITION field comes from the catalog.
 *
 * BOTH halves are deliberate. Disagreement fails closed (AC-2) AND the returned
 * item takes its definition from the catalog (AC-1). Silent correction alone
 * would be wrong on its own: it hides tampering exactly as effectively as
 * accepting it.
 *
 * HONESTLY UNOBSERVABLE, and said so rather than implied by a green test: a
 * mutation that returns the ROW instead survives the suite, because the refusal
 * above means the two can never differ on a path that returns `ok`. The rebuild
 * is defence in depth against a future reordering that consults the roadmap
 * before the check, which is not the same claim as a tested guarantee — and it
 * is a claim worth stating in a file whose whole subject is not trusting the
 * row.
 */
export function reconcileRoadmapWithCatalog(
  persisted: readonly RoadmapItem[],
  catalog: readonly RoadmapItem[],
): CatalogVerdict {
  const byKey = new Map<string, RoadmapItem>();
  for (const entry of catalog) {
    if (byKey.has(entry.key)) {
      return { ok: false, problem: `the roadmap catalog declares ${JSON.stringify(entry.key)} twice` };
    }
    if (!(WORK_CLASSES as readonly string[]).includes(entry.workClass)) {
      return {
        ok: false,
        problem: `the roadmap catalog gives ${JSON.stringify(entry.key)} an unknown workClass ${JSON.stringify(entry.workClass)}`,
      };
    }
    byKey.set(entry.key, entry);
  }

  const reconciled: RoadmapItem[] = [];
  const seen = new Set<string>();
  for (const row of persisted) {
    const declared = byKey.get(row.key);
    if (declared === undefined) {
      /**
       * AC-3. An item this installation does not recognise is not an item it
       * should execute. Correcting it is impossible — there is nothing to
       * correct it TO — and running it means running work whose definition
       * came from the database.
       */
      return {
        ok: false,
        problem:
          `persisted roadmap item ${JSON.stringify(row.key)} is not in this installation's catalog; ` +
          `known keys: ${[...byKey.keys()].join(", ")}`,
      };
    }
    seen.add(row.key);
    const disagreement = DEFINITION_FIELDS.find((field) => !sameDefinition(field, row, declared));
    if (disagreement !== undefined) {
      return {
        ok: false,
        problem:
          `persisted roadmap item ${JSON.stringify(row.key)} disagrees with the catalog on ${JSON.stringify(disagreement)}: ` +
          `persisted ${JSON.stringify(row[disagreement])}, catalog ${JSON.stringify(declared[disagreement])}`,
      };
    }
    reconciled.push({
      ...row,
      title: declared.title,
      workClass: declared.workClass,
      dependsOn: [...declared.dependsOn],
      order: declared.order,
    });
  }

  // A catalog entry with no persisted row is an ORDINARY UPGRADE: a newer build
  // declares work this installation has not seen. Refusing it would strand
  // every existing database on the day the roadmap grows.
  for (const entry of catalog) {
    if (!seen.has(entry.key)) reconciled.push({ ...entry, dependsOn: [...entry.dependsOn] });
  }
  return { ok: true, roadmap: reconciled };
}

/**
 * A DONE item whose catalog class needs AI, with nothing in the chain saying
 * anything ran on it (AC-6).
 *
 * Dependency truth is derived from `status === "DONE"`, so writing DONE into a
 * row is how an unreviewed item satisfies its dependents. The chain is the
 * second record, and the two disagreeing is exactly the signal it exists for.
 *
 * `legacySilence` is passed in rather than recomputed here because it is a fact
 * about the whole state: a database written before TASK-008 has no entries for
 * work already done, and refusing every such installation would strand the
 * roadmap this protects. That residue is recorded in docs/KNOWN-LIMITATIONS.md.
 */
export function unprovenCompletion(input: {
  readonly roadmap: readonly RoadmapItem[];
  readonly implementedKeys: ReadonlySet<string>;
  readonly legacySilence: boolean;
}): string | undefined {
  if (input.legacySilence) {
    return undefined;
  }
  for (const item of input.roadmap) {
    if (item.status !== "DONE" || !requiresAi(item.workClass)) continue;
    if (input.implementedKeys.has(item.key)) continue;
    return (
      `roadmap item ${JSON.stringify(item.key)} is marked DONE and its catalog class ${JSON.stringify(item.workClass)} ` +
      "requires AI work, but durable provenance holds no record of anything having run on it"
    );
  }
  return undefined;
}
