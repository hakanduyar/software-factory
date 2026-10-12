/**
 * Provider-neutral worker contract (C9).
 *
 * Nothing here names Claude, Codex, Gemini, OpenCode or Ollama. An adapter
 * wraps whatever tool it likes as long as it satisfies this interface.
 *
 * Deliberate omission: a WorkerOutcome carries no WorkItemStatus and no
 * approval. A worker can report what it did and claim its criteria are met,
 * but it has no vocabulary for moving a work item or opening a gate.
 */

import type { AcceptanceCriterion } from "../domain/acceptanceCriterion.js";
import type { EvidenceDraft } from "../domain/evidence.js";
import type { RunId, WorkItemId } from "../domain/ids.js";
import type { FactoryRole } from "../domain/role.js";

/**
 * Provider-neutral handle carried on a WorkerRequest for a protected direct
 * run (see src/supervision/directWorkerAdmission.ts). `revalidate` re-checks
 * the SAME admitted binding against live state immediately before an
 * adapter's ProcessRunner invocation, so authority that changed between
 * FactoryService's Phase 1 admission and Phase 2 spawn is caught before any
 * process launches. Rejection throws; it never silently downgrades to an
 * unrestricted launch.
 */
export interface DirectAdmissionHandle {
  readonly ticketDigest: string;
  revalidate(): Promise<void>;
}

/**
 * D1-85: opaque carrier for the trusted-host-issued admission handle
 * (src/supervision/directWorkerAdmission.ts DirectHostAdmissionHandle).
 * Deliberately typed `unknown` here — worker.ts must not import the handle's
 * branded type and create a cycle with the module that already imports
 * DirectLaunchBinding/Receipt from here. A worker never constructs or
 * inspects this value; it only passes it back to the SAME constructor-
 * injected DirectHostAdmissionSurface via Worker-port-external wiring. This
 * is the only opaque-handle carrier; no caller-constructible revalidate
 * closure or consumer object on WorkerRequest grants launch authority.
 */
export type OpaqueDirectAdmissionHandle = unknown;

export interface WorkerRequest {
  readonly runId: RunId;
  readonly workItemId: WorkItemId;
  readonly role: FactoryRole;
  readonly title: string;
  readonly instructions: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly directAdmission?: DirectAdmissionHandle;
  /** D1-85 mandatory same-channel path: the opaque handle issued by FactoryService's injected channel; consumed only via the identical channel injected into the adapter. */
  readonly directAdmissionHandle?: OpaqueDirectAdmissionHandle;
}

export interface WorkerOutcome {
  readonly status: "SUCCEEDED" | "FAILED";
  readonly summary: string;
  readonly evidence: readonly EvidenceDraft[];
  /**
   * The worker's own claim. Recorded as audit data (C8) and explicitly not
   * treated as proof of acceptance (C3) or as an approval (C1).
   */
  readonly claimsAcceptanceMet: boolean;
}

export interface WorkerCapabilities {
  readonly roles: readonly FactoryRole[];
  /** True when the same request always produces the same outcome. */
  readonly deterministic: boolean;
}

export interface Worker {
  readonly id: string;
  readonly capabilities: WorkerCapabilities;
  execute(request: WorkerRequest): Promise<WorkerOutcome>;
}

export function supportsRole(worker: Worker, role: FactoryRole): boolean {
  return worker.capabilities.roles.includes(role);
}

/**
 * Module-private unique-symbol brand keys (C9 D1). Not exported, so
 * arbitrary caller object literals cannot structurally satisfy either
 * opaque type below. This is a compile-time distinction only; it
 * establishes no runtime trust by itself. Runtime trust is the
 * responsibility of the future authority implementation's retained
 * durable backing, not of this type definition. A trusted host
 * constructor-injected implementation is the only intended issuer of
 * values carrying these brands.
 */
declare const bindingBrand: unique symbol;
declare const receiptBrand: unique symbol;

/**
 * Immutable tuple identifying exactly one authorized direct launch attempt.
 * Every field is required; no field may be loosened to optional in a later
 * revision without a new contract increment. Opaque via a module-private
 * unique-symbol brand; only a trusted host-injected implementation issues
 * real values.
 */
export interface DirectLaunchBinding {
  readonly [bindingBrand]: true;
  readonly ticketDigest: string;
  readonly registryPrincipalId: string;
  readonly workItemId: WorkItemId;
  readonly specRevision: number;
  readonly runId: RunId;
  readonly reservationId: string;
  readonly reservationVersion: number;
}

/**
 * Opaque proof that a specific DirectLaunchBinding was consumed exactly
 * once by the authority implementation backing atomicConsumeLaunch. A
 * receipt carries the exact bound tuple identity (never a bare
 * `approved: boolean`), so any future ProcessRunner seam can verify the
 * receipt corresponds to the binding it holds. Opaque via a module-private
 * unique-symbol brand, distinct from DirectLaunchBinding's brand.
 */
export interface DirectLaunchReceipt {
  readonly [receiptBrand]: true;
  readonly binding: DirectLaunchBinding;
  readonly consumedAt: string;
}

/**
 * Provider-neutral, host-injected authority port (C9 D1). This interface
 * is intended to be constructed only by a trusted host; no production
 * store, supplier, or wiring is defined or authorized here.
 *
 * Invariant (the ONE invariant this contract establishes): for any given
 * DirectLaunchBinding tuple, atomicConsumeLaunch returns a successful
 * DirectLaunchReceipt bound to that identical tuple at most once -- including
 * across authority reconstruction or process restart, provided the
 * implementation retains durable backing. An already-consumed, missing,
 * mismatched, or stale binding MUST cause atomicConsumeLaunch to refuse
 * (reject/throw) rather than return any receipt, permissive or otherwise.
 *
 * checkReadiness (or any equivalently named read-only operation) must never
 * consume or grant a provider launch; it is strictly informational.
 *
 * A successful receipt is required at the future ProcessRunner seam before
 * a provider process may be spawned. Because consumption may conservatively
 * occur before spawn, a crash between consumption and spawn may cause a
 * legitimate retry to be denied; this contract does NOT guarantee
 * exactly-once process completion, only exactly-once receipt issuance per
 * binding tuple. Retained persistent backing needed to prove this invariant
 * (e.g. in a later test-owned fake-authority fixture) is explicitly allowed
 * in a future increment, but no such backing, store, or fixture is defined
 * or implemented here.
 */
export interface DirectLaunchAuthorityPort {
  checkReadiness(binding: DirectLaunchBinding): Promise<boolean>;
  atomicConsumeLaunch(
    binding: DirectLaunchBinding,
  ): Promise<DirectLaunchReceipt>;
}
