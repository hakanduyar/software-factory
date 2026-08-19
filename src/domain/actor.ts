/**
 * Who performed an action.
 *
 * The distinction between HUMAN and AGENT is constitutionally load bearing:
 * C1 reserves protected decisions for humans and C5 forbids a run from
 * certifying its own output. Every gate check therefore inspects actor kind.
 */

export const ACTOR_KINDS = ["HUMAN", "AGENT", "SYSTEM"] as const;

export type ActorKind = (typeof ACTOR_KINDS)[number];

export interface Actor {
  readonly id: string;
  readonly kind: ActorKind;
  readonly displayName: string;
}

export function isHuman(actor: Actor): boolean {
  return actor.kind === "HUMAN";
}

export function human(id: string, displayName: string): Actor {
  return { id, kind: "HUMAN", displayName };
}

export function agent(id: string, displayName: string): Actor {
  return { id, kind: "AGENT", displayName };
}

export function system(id: string, displayName: string): Actor {
  return { id, kind: "SYSTEM", displayName };
}
