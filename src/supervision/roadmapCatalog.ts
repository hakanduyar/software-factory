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
export const DEFINITION_FIELDS = ["key", "title", "workClass", "dependsOn", "order"] as const;

/**
 * `key` is in that list because TASK-012's frozen AC-1 puts it there, and a
 * frozen criterion is not something an implementer trims to what felt necessary
 * (round-10 HIGH).
 *
 * It is the field the lookup is BY, so on the reconciliation path the row and
 * the catalog agree about it trivially. That makes it the weakest of the five
 * and not the pointless one: it is what makes the returned item's identity
 * come from the catalog rather than from the row, which is the property AC-1
 * actually states. It is checked and rebuilt with its four siblings, under one
 * rule, rather than being the exception someone has to remember.
 */

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
      key: declared.key,
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
 * NO EMPTY-CHAIN EXEMPTION (round-9 CRITICAL).
 *
 * The first version skipped this check whenever the chain was empty, on the
 * reasoning that a database written before TASK-008 has no entries for work
 * already done. That reasoning is sound about a LEGACY database and useless as a
 * control, because the same condition is one DELETE away: the reviewer created a
 * state with an empty chain, a genesis anchor and forged `DONE` rows, and every
 * dependent ran. An exemption an attacker can satisfy is not an exemption, it is
 * the bypass with a justification attached.
 *
 * Every roadmap item this build ships starts PENDING, so a fresh installation
 * has nothing DONE and nothing to prove — the check costs it nothing. What it
 * does cost is a genuinely pre-TASK-008 database, which now needs a human
 * decision once before its dependents proceed. That is the correct price: an
 * unverifiable history is exactly the situation C1 reserves for a person, and
 * the alternative is handing the same escape to anyone who can write the file.
 *
 * The reviewer-exclusion path keeps its own separate allowance
 * (`chainIsLegacySilence`), which answers a different question — "who
 * implemented this ancestor" rather than "did anything run at all" — and was
 * adjudicated legitimate in that form by an earlier review.
 */
export function unprovenCompletion(input: {
  readonly roadmap: readonly RoadmapItem[];
  readonly implementedKeys: ReadonlySet<string>;
}): string | undefined {
  for (const item of input.roadmap) {
    if (!requiresAi(item.workClass)) continue;
    if (input.implementedKeys.has(item.key)) continue;

    if (item.status === "DONE") {
      return (
        `roadmap item ${JSON.stringify(item.key)} is marked DONE and its catalog class ${JSON.stringify(item.workClass)} ` +
        "requires AI work, but durable provenance holds no record of anything having run on it"
      );
    }

    /**
     * AN ITEM THAT RAN AND IS NOT DONE (round-11 review).
     *
     * `DONE` was the only trigger, so an item left ELIGIBLE by a
     * `CHANGES_REQUIRED` review was exempt — and deleting its lineage let the
     * same resource review it again. The reviewer demonstrated exactly that.
     *
     * `attempts` alone could not be the trigger, because it is incremented when
     * an action is CLAIMED, one commit before the launch. Now that
     * reconciliation records the attempts it PROVED never launched, the
     * difference is the number that reached a worker — and a worker that ran
     * leaves lineage.
     */
    const launched = (item.attempts ?? 0) - (item.unlaunchedAttempts ?? 0);
    if (launched > 0) {
      return (
        `roadmap item ${JSON.stringify(item.key)} has ${launched} attempt(s) that reached a worker and its catalog ` +
        `class ${JSON.stringify(item.workClass)} requires AI work, but durable provenance holds no record of ` +
        "anything having run on it"
      );
    }
  }
  return undefined;
}
