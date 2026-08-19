/**
 * Trusted worker identity (C4, C5).
 *
 * A `Worker`'s own `id`, `capabilities.roles` and any other self-described
 * field are DATA supplied by the adapter, not authority. In Round-2 review a
 * single Worker object implemented a work item, then reassigned its own `id`
 * and roles and successfully recorded a passing semantic review of its own
 * run — reviewer independence was only a comparison of two caller-controlled
 * strings.
 *
 * A `WorkerPrincipal` is different: it is minted only by a WorkerRegistry
 * (src/ports/workerRegistry.ts), it is bound to the identity of the Worker
 * *object* rather than to anything the worker says about itself, and it never
 * changes for that object. Reviewer independence compares `principalId`, so
 * renaming, re-roling or aliasing a worker cannot make it independent from
 * itself.
 */

import type { FactoryRole } from "./role.js";
import type { Timestamp } from "./time.js";

export interface WorkerPrincipal {
  /** Registry-issued and immutable. Never taken from Worker.id. */
  readonly principalId: string;
  /** The worker's self-reported id at registration time — audit data only. */
  readonly declaredId: string;
  /** Roles captured at registration; later mutation of the worker is ignored. */
  readonly roles: readonly FactoryRole[];
  readonly registeredAt: Timestamp;
}

export function principalSupportsRole(principal: WorkerPrincipal, role: FactoryRole): boolean {
  return principal.roles.includes(role);
}
