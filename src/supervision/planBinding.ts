/**
 * IS THIS PLAN ACTUALLY FOR THIS ROADMAP ITEM? (round-3 finding 3, HIGH)
 *
 * `--roadmap-plans` is an operator-declared map of roadmap key to plan id, and
 * round-2 review judged that design sound: deriving the binding from plan intent
 * would invent a convention in the wrong layer, and a binding belongs beside the
 * approval, which C1 reserves to a person.
 *
 * Round-3 review then showed what the file alone does NOT establish. A perfectly
 * valid approved plan, whose own work item is `WI-A`, was bound under the
 * unrelated roadmap key `LOCAL_24_7_RUNTIME` — and the supervisor resumed it.
 * Nothing checked that the plan had anything to do with the item, because the
 * plan carried no roadmap identity at all. One mistaken line in a JSON file was
 * enough to execute unrelated approved work.
 *
 * SO THE DECLARATION IS TWO-SIDED. The operator's file says which plan serves an
 * item, and the PLAN must say which item it serves. Both are human-authored, and
 * a launch requires them to agree.
 *
 * WHY `declaredConstraints` AND NOT REVISION CONTENT. `declaredConstraints` is
 * the operator's own input at `sf plan start`, and `planTypes.ts` states the
 * rule it lives under: never rewritten by any model. Revision constraints are
 * PLANNER OUTPUT — they are covered by the approval digest, which is
 * cryptographically stronger, but they are written by an AI from the intent, so
 * a plan could acquire or lose its roadmap identity through a re-plan. An
 * identity a model can edit is not an identity.
 *
 * WHAT THIS DOES NOT ACHIEVE, stated plainly because the reviewer named three
 * things and this closes one and a half of them:
 *
 *   - The binding is now SEMANTIC: an unrelated plan is refused.
 *   - It is DURABLE in the plan record, which is append-only and versioned.
 *   - It is NOT bound to the approval itself. `declaredConstraints` is not part
 *     of the content digest an approval signs, so a party who can write the
 *     plans database can still edit it. That party can already edit the phase,
 *     which is why the phase is re-derived from Factory authority — but no such
 *     independent record exists for a roadmap key, and inventing one is a
 *     schema change beyond this task. Recorded as L-13.
 */

import type { Plan } from "../planning/planTypes.js";

/** The prefix a plan uses to name the roadmap item it serves. */
export const ROADMAP_KEY_DECLARATION = "roadmap-key:";

export type PlanBindingVerdict =
  | { readonly ok: true; readonly declaredKey: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The roadmap key this plan declares, if it declares exactly one.
 *
 * TWO DECLARATIONS ARE A REFUSAL, not a choice. A plan naming two roadmap items
 * would let whichever one is asked first appear to match, which is precisely the
 * ambiguity this check exists to remove.
 */
export function declaredRoadmapKeys(plan: Plan): readonly string[] {
  return plan.declaredConstraints
    .map((constraint) => constraint.trim())
    .filter((constraint) => constraint.toLowerCase().startsWith(ROADMAP_KEY_DECLARATION))
    .map((constraint) => constraint.slice(ROADMAP_KEY_DECLARATION.length).trim())
    .filter((key) => key.length > 0);
}

export function checkPlanBinding(roadmapKey: string, plan: Plan): PlanBindingVerdict {
  const declared = declaredRoadmapKeys(plan);

  if (declared.length === 0) {
    return {
      ok: false,
      reason:
        `plan ${plan.id} is bound to roadmap item ${roadmapKey} by the bindings file, but the plan itself ` +
        `declares no roadmap item. Add "${ROADMAP_KEY_DECLARATION} ${roadmapKey}" to the plan's constraints ` +
        `so the binding is declared on both sides, by a human, rather than asserted by one file`,
    };
  }
  if (declared.length > 1) {
    return {
      ok: false,
      reason: `plan ${plan.id} declares ${declared.length} roadmap items (${declared.join(", ")}); exactly one is required`,
    };
  }

  const [only] = declared;
  if (only !== roadmapKey) {
    return {
      ok: false,
      reason:
        `plan ${plan.id} declares that it serves roadmap item ${only}, but it is bound to ${roadmapKey}. ` +
        `Refusing: a mistaken line in the bindings file must not be able to run approved work belonging to ` +
        `a different item`,
    };
  }
  return { ok: true, declaredKey: only };
}
