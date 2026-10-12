/**
 * The trusted boundary that issues worker identities.
 *
 * `register` is the only way a WorkerPrincipal comes into existence, and
 * `principalFor` is the only way the Factory learns which principal a Worker
 * object belongs to. Nothing in the Worker contract (src/ports/worker.ts)
 * lets a worker reach this registry, so a worker cannot mint or impersonate
 * another principal.
 */

import type { FactoryRole } from "../domain/role.js";
import type { WorkerPrincipal } from "../domain/workerPrincipal.js";
import type { Worker } from "./worker.js";

export interface RegisterWorkerOptions {
  /**
   * Roles this worker is trusted to perform. Defaults to the worker's own
   * declared capabilities *at registration time*, captured immutably.
   */
  readonly roles?: readonly FactoryRole[];
  /**
   * Host-authoritative (caller-supplied at registration time) declaration
   * that this principal must satisfy the direct provider-admission ticket
   * gate before a protected direct run. Never derived from the Worker
   * object's own self-reported capabilities. D1-85: every NONMOCK worker
   * requires admission regardless of this flag's presence or value (false
   * or absent does not exempt it); only the identity-backed A80
   * `isTrustedMockWorker` predicate exempts a worker, and only because it is
   * a deterministic mock, never because of this option.
   */
  readonly requiresDirectAdmission?: boolean;
}

export interface WorkerRegistry {
  /** Idempotent per Worker object: re-registering returns the same principal. */
  register(worker: Worker, options?: RegisterWorkerOptions): WorkerPrincipal;
  /** Throws WorkerIdentityError if this Worker object was never registered. */
  principalFor(worker: Worker): WorkerPrincipal;
  findByPrincipalId(principalId: string): WorkerPrincipal | undefined;
}
