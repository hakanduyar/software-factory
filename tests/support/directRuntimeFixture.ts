/**
 * Shared trusted-runtime fixture for D1-85/D1-86 direct admission proofs: a
 * test-owned retained authority implementing DirectHostAuthorityPort exactly,
 * plus a real FactoryService + real createCliWorker wired through the SAME
 * trusted host-constructed channel. No production D3 supplier is invented.
 */

import { FactoryService } from "../../src/app/factoryService.js";
import { createInMemoryStore } from "../../src/adapters/memory/inMemoryStore.js";
import { createLocalHumanIdentityGate } from "../../src/adapters/security/localHumanIdentityGate.js";
import { createLocalWorkerRegistry } from "../../src/adapters/security/localWorkerRegistry.js";
import { createCliWorker } from "../../src/adapters/workers/cliWorker.js";
import type { AcceptanceCriterion as DomainAcceptanceCriterion } from "../../src/domain/acceptanceCriterion.js";
import { createSequentialIdGenerator } from "../../src/domain/ids.js";
import type { WorkItemId, RunId } from "../../src/domain/ids.js";
import type { FactoryRole } from "../../src/domain/role.js";
import type { WorkerPrincipal } from "../../src/domain/workerPrincipal.js";
import { createFixedClock } from "../../src/ports/clock.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../../src/ports/processRunner.js";
import type { FactoryStore } from "../../src/ports/repositories.js";
import {
  createDirectHostAdmissionChannel,
  type DirectHostAdmissionSurface,
  type DirectHostAuthorityPort,
  type DirectHostLaunchGrant,
  type DirectHostLaunchRequest,
  type TrustedTicketReference,
} from "../../src/supervision/directWorkerAdmission.js";
import {
  type ApprovedPrestartPort,
  type ApprovedPrestartRecord,
  type PrestartAcceptanceCriterion,
  type PrestartTicketReference,
  type RetainedPrestartRecord,
} from "../../src/supervision/directWorkerPrestartAdmission.js";
import { computeTicketDigest, type WorkerTicket } from "../../src/supervision/workerContract.js";
import type { DirectLaunchBinding, DirectLaunchReceipt } from "../../src/ports/worker.js";
import { TEST_CREDENTIAL, FIXTURE_START } from "./factoryFixtures.js";

export const TICKET: WorkerTicket = {
  schemaVersion: "1.0.0",
  ticketId: "rt-ticket-1",
  objective: "runtime proof: implement the fixture work item fully",
  acceptanceCriteria: [{ id: "ac-1", version: "1.0.0", description: "work is done" }],
  scope: { owned: ["src/a.ts"], forbidden: [], read: [], dependencies: [], validation: ["npm test"] },
  model: { eligibleModels: ["model-a"], reasoningEffort: "low", rationale: "stable baseline" },
  budgets: { contextTokens: 1000, outputTokens: 500, elapsedSeconds: 60, maxAttempts: 1 },
  policy: { checkpoint: "checkpoint", stopConditions: ["done"], escalation: "human" },
  resultSchema: { requiredFields: ["schemaVersion", "ticketId"], maxResultBytes: 2048 },
};
const TICKET_DIGEST = computeTicketDigest(TICKET);
const TICKET_REFERENCE_VALUE = "trusted-ref-1";
export const TICKET_REFERENCE = TICKET_REFERENCE_VALUE as TrustedTicketReference;
/** Same underlying reference value as TICKET_REFERENCE: the Factory reuses input.directTicketReference for both the launch channel and the prestart lookup. */
export const PRESTART_TICKET_REFERENCE = TICKET_REFERENCE_VALUE as PrestartTicketReference;

/**
 * Test-owned retained trusted authority: a fixture-backed fake implementing
 * DirectHostAuthorityPort exactly, with a real Map retaining reservation
 * state across calls (so restart/replay-style at-most-once can be proven).
 * `resolveAndReserve` only ever returns a grant for the ONE registered
 * ticketReference; it never trusts request-echoed ticket content.
 */
export function makeRetainedAuthority() {
  const reservations = new Map<string, { binding: DirectLaunchBinding; state: "pending" | "consumed" | "cancelled" }>();
  const calls = { resolveAndReserve: 0, revalidate: 0, checkReadiness: 0, atomicConsumeLaunch: 0, cancel: 0 };
  let reservationCounter = 0;
  let readyOverride: boolean | undefined;

  function bindingFor(request: DirectHostLaunchRequest, reservationId: string, version: number): DirectLaunchBinding {
    return {
      ticketDigest: TICKET_DIGEST,
      registryPrincipalId: request.registryPrincipalId,
      workItemId: request.workItemId,
      specRevision: request.specRevision,
      runId: request.runId,
      reservationId,
      reservationVersion: version,
    } as unknown as DirectLaunchBinding;
  }

  const authority: DirectHostAuthorityPort = {
    async resolveAndReserve(request: DirectHostLaunchRequest): Promise<DirectHostLaunchGrant> {
      calls.resolveAndReserve++;
      if (request.ticketReference !== TICKET_REFERENCE) {
        throw new Error("unknown ticketReference: no trusted record");
      }
      reservationCounter++;
      const reservationId = `res-${reservationCounter}`;
      const binding = bindingFor(request, reservationId, 1);
      reservations.set(reservationId, { binding, state: "pending" });
      const evidence = {
        ticketDigest: TICKET_DIGEST,
        registryPrincipalId: request.registryPrincipalId,
        workItemId: request.workItemId,
        specRevision: request.specRevision,
        runId: request.runId,
        reservationId,
        reservationVersion: 1,
        scope: request.scope,
        model: request.model,
        budgets: TICKET.budgets,
        observedAt: FIXTURE_START,
        expiresAt: "2026-01-01T01:00:00.000Z",
        evidenceReference: "evid-rt-1",
        evidenceDigest: "digest-rt-1",
        quota: {
          availableContextTokens: 1000,
          availableOutputTokens: 500,
          availableElapsedSeconds: 60,
          availableAttempts: 1,
          verified: true,
        },
        context: { supportedModels: ["model-a"], supportedReasoningEfforts: ["low"], verified: true },
        confinement: { supportedScopeOwned: request.scope.owned, supportedScopeForbidden: request.scope.forbidden, verified: true },
      };
      return { ticket: TICKET, ticketDigest: TICKET_DIGEST, binding, evidence };
    },
    async revalidate(): Promise<void> {
      calls.revalidate++;
    },
    async checkReadiness(binding: DirectLaunchBinding): Promise<boolean> {
      calls.checkReadiness++;
      if (readyOverride !== undefined) {
        return readyOverride;
      }
      const b = binding as unknown as { reservationId: string };
      const entry = reservations.get(b.reservationId);
      return entry !== undefined && entry.state === "pending";
    },
    async atomicConsumeLaunch(binding: DirectLaunchBinding): Promise<DirectLaunchReceipt> {
      calls.atomicConsumeLaunch++;
      const b = binding as unknown as { reservationId: string };
      const entry = reservations.get(b.reservationId);
      if (entry === undefined || entry.state !== "pending") {
        throw new Error(`atomicConsumeLaunch refused for ${b.reservationId}: stale, consumed, or cancelled`);
      }
      entry.state = "consumed";
      return { binding, consumedAt: "2026-01-01T00:05:00.000Z" } as unknown as DirectLaunchReceipt;
    },
    async cancel(binding: DirectLaunchBinding): Promise<void> {
      calls.cancel++;
      const b = binding as unknown as { reservationId: string };
      const entry = reservations.get(b.reservationId);
      if (entry === undefined || entry.state !== "pending") {
        throw new Error(`cannot cancel ${b.reservationId}: missing or not pending`);
      }
      entry.state = "cancelled";
    },
  };

  return {
    authority,
    calls,
    reservations,
    setReady(value: boolean | undefined) {
      readyOverride = value;
    },
  };
}

/**
 * D1-93: test-owned retained ApprovedPrestartPort fixture. Independently
 * registers one immutable approved record per opaque reference BEFORE any
 * launch, keyed strictly by that reference — `resolveApprovedPrestart`
 * never sees anything the current caller asserts, only what was registered
 * here in advance. Approved facts never echo a later resolution request:
 * `registerApprovedPrestart` captures its own known item/spec/principal/
 * role/full criteria/dependencies/target plus the fixed TICKET scope/model/
 * budgets at registration time, and `resolveApprovedPrestart` simply looks
 * the reference up — it is never passed, and never reads, the current
 * request's own facts.
 */
export interface ApprovedPrestartRegistrationInput {
  readonly reference: PrestartTicketReference;
  readonly item: { readonly id: WorkItemId; readonly specRevision: number };
  readonly principal: WorkerPrincipal;
  readonly role: FactoryRole;
  readonly criteria: readonly DomainAcceptanceCriterion[];
  readonly dependencyWorkItemIds?: readonly WorkItemId[];
  readonly targetRunId?: RunId;
}

/** Independent deep snapshot so later mutation of the caller's input or shared fixture constants cannot rewrite an already-retained approval. */
function deepFreezeClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => deepFreezeClone(entry))) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      clone[key] = deepFreezeClone(entry);
    }
    return Object.freeze(clone) as unknown as T;
  }
  return value;
}

export function makeApprovedPrestartAuthority() {
  const records = new Map<string, RetainedPrestartRecord>();

  function registerApprovedPrestart(input: ApprovedPrestartRegistrationInput): PrestartTicketReference {
    const snapshotCriteria = deepFreezeClone(
      input.criteria,
    ) as readonly PrestartAcceptanceCriterion[];
    const snapshotDependencies = deepFreezeClone(input.dependencyWorkItemIds ?? []);
    const snapshotTicket = deepFreezeClone(TICKET);
    const approval: ApprovedPrestartRecord = Object.freeze({
      ticket: snapshotTicket,
      ticketDigest: TICKET_DIGEST,
      approvedPrincipalId: input.principal.principalId,
      approvedRole: input.role,
      approvedWorkItemId: input.item.id,
      approvedSpecRevision: input.item.specRevision,
      approvedAcceptanceCriteria: snapshotCriteria,
      approvedDependencyWorkItemIds: snapshotDependencies,
      ...(input.targetRunId === undefined ? {} : { approvedTargetRunId: input.targetRunId }),
      approvedScope: snapshotTicket.scope,
      approvedModel: snapshotTicket.model,
      approvedBudgets: snapshotTicket.budgets,
    });
    records.set(input.reference, Object.freeze({ disposition: "approved", approval }));
    return input.reference;
  }

  const port: ApprovedPrestartPort = {
    resolveApprovedPrestart(reference: PrestartTicketReference): RetainedPrestartRecord | undefined {
      return records.get(reference);
    },
  };

  return { port, registerApprovedPrestart };
}

/** Builds a real FactoryService wired to the retained authority's channel, plus a real CLI worker sharing it. */
export function buildRuntime(authority: DirectHostAuthorityPort, prestart = makeApprovedPrestartAuthority()) {
  const clock = createFixedClock(FIXTURE_START);
  const store = createInMemoryStore();
  const factory = new FactoryService({
    store,
    clock,
    ids: createSequentialIdGenerator(),
    identityGate: createLocalHumanIdentityGate({ credential: TEST_CREDENTIAL, clock }),
    workerRegistry: createLocalWorkerRegistry(clock),
    createDirectAdmissionChannel: (readCurrentRequest) =>
      createDirectHostAdmissionChannel(authority, readCurrentRequest),
    approvedPrestartPort: prestart.port,
  });
  const processRunner = makeFakeProcessRunner();
  const cliWorker = createCliWorker({
    id: "cli-direct-rt",
    tool: "claude-code",
    roles: ["IMPLEMENTER"],
    executable: "fake-cli",
    model: "model-a",
    timeoutMs: 1000,
    workspace: { root: "/tmp/ws", repositoryRoot: "/tmp/ws" },
    processRunner,
    environmentPolicy: { allowedVars: [] },
    buildInvocation: () => ({ argv: ["--run"], effortApplication: { applied: false } }),
    interpretOutput: () => ({}),
    ...(factory.sharedDirectAdmissionChannel !== undefined
      ? { directAdmissionChannel: factory.sharedDirectAdmissionChannel }
      : {}),
  });
  return { factory, store, processRunner, cliWorker, registerApprovedPrestart: prestart.registerApprovedPrestart };
}

/**
 * Test-only composition for a caller-supplied `FactoryStore` (e.g. SQLite):
 * identical fixed clock/ids/identity/registry/host channel hook as
 * `buildRuntime`, but the store itself is supplied rather than an in-memory
 * one, so SQLite durability proofs can share this exact trusted channel
 * wiring. No production D3 supplier is invented; the authority is still the
 * caller-owned retained fixture from `makeRetainedAuthority`.
 */
export function buildRuntimeWithStore(
  authority: DirectHostAuthorityPort,
  store: FactoryStore,
  prestart = makeApprovedPrestartAuthority(),
) {
  const clock = createFixedClock(FIXTURE_START);
  const factory = new FactoryService({
    store,
    clock,
    ids: createSequentialIdGenerator(),
    identityGate: createLocalHumanIdentityGate({ credential: TEST_CREDENTIAL, clock }),
    workerRegistry: createLocalWorkerRegistry(clock),
    createDirectAdmissionChannel: (readCurrentRequest) =>
      createDirectHostAdmissionChannel(authority, readCurrentRequest),
    approvedPrestartPort: prestart.port,
  });
  const channel: DirectHostAdmissionSurface | undefined = factory.sharedDirectAdmissionChannel;
  return { factory, store, channel, registerApprovedPrestart: prestart.registerApprovedPrestart };
}

export function makeFakeProcessRunner(): ProcessRunner & { readonly invocations: ProcessRequest[] } {
  const invocations: ProcessRequest[] = [];
  return {
    invocations,
    async run(request: ProcessRequest): Promise<ProcessResult> {
      invocations.push(request);
      return {
        terminationReason: "EXITED",
        exitCode: 0,
        signal: null,
        stdout: "ok",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        startedAt: FIXTURE_START as never,
        finishedAt: FIXTURE_START as never,
        durationMs: 1,
      };
    },
  };
}
