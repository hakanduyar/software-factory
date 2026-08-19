/**
 * Local WorkerRegistry keyed on Worker *object identity*.
 *
 * The map is a WeakMap from the Worker object to its principal. That is what
 * makes the Round-2 rename exploit impossible: the principal is looked up by
 * the object the caller actually hands to `runWorker`, so mutating
 * `worker.id` or `worker.capabilities` afterwards changes nothing the
 * Factory trusts. Re-registering the same object returns the principal it
 * already has rather than minting a second one.
 *
 * Principal ids are random and unguessable, so a caller cannot fabricate a
 * plausible `principalId` and have it collide with a registered worker.
 *
 * Known limit, documented rather than hidden: two *distinct* Worker objects
 * are two principals even if they share a closure, because in-process object
 * identity is the only trust anchor available without process isolation. A
 * later phase that runs workers out-of-process should bind principals to
 * that boundary instead.
 */

import { randomBytes } from "node:crypto";

import { WorkerIdentityError } from "../../domain/errors.js";
import type { WorkerPrincipal } from "../../domain/workerPrincipal.js";
import type { Clock } from "../../ports/clock.js";
import type { RegisterWorkerOptions, WorkerRegistry } from "../../ports/workerRegistry.js";
import type { Worker } from "../../ports/worker.js";

export function createLocalWorkerRegistry(clock: Clock): WorkerRegistry {
  const byObject = new WeakMap<Worker, WorkerPrincipal>();
  const byId = new Map<string, WorkerPrincipal>();

  return {
    register(worker: Worker, options: RegisterWorkerOptions = {}): WorkerPrincipal {
      const existing = byObject.get(worker);
      if (existing !== undefined) {
        return existing;
      }
      const principal: WorkerPrincipal = Object.freeze({
        principalId: `wp-${randomBytes(12).toString("hex")}`,
        declaredId: worker.id,
        roles: Object.freeze([...(options.roles ?? worker.capabilities.roles)]),
        registeredAt: clock.now(),
      });
      byObject.set(worker, principal);
      byId.set(principal.principalId, principal);
      return principal;
    },

    principalFor(worker: Worker): WorkerPrincipal {
      const principal = byObject.get(worker);
      if (principal === undefined) {
        throw new WorkerIdentityError(
          `worker "${worker.id}" is not registered; a run may only be executed by a worker with a registry-issued principal`,
        );
      }
      return principal;
    },

    findByPrincipalId(principalId: string): WorkerPrincipal | undefined {
      return byId.get(principalId);
    },
  };
}
