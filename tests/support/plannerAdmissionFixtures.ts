/**
 * TEST-ONLY synthetic admission fixture for cliPlannerWorker admission tests
 * and the two legacy planner test helpers. Reuses the exact
 * createDirectHostAdmissionChannel/fake-authority structure from
 * concreteCliAggregateOutput.test.ts; the authority and channel built here
 * are explicitly NOT a live grant and must never be reused outside tests.
 */
import {
  createDirectHostAdmissionChannel,
  type DirectHostAdmissionHandle,
  type DirectHostAdmissionSurface,
  type DirectHostAuthorityPort,
  type DirectHostLaunchGrant,
  type DirectHostLaunchRequest,
} from "../../src/supervision/directWorkerAdmission.js";
import { computeTicketDigest, type WorkerTicket } from "../../src/supervision/workerContract.js";
import type { DirectLaunchBinding, DirectLaunchReceipt } from "../../src/ports/worker.js";
import type { PlannerRequest } from "../../src/planning/plannerWorker.js";
import type { CliPlannerAdmissionSource } from "../../src/adapters/planning/cliPlannerWorker.js";
import type { FactoryRole } from "../../src/domain/role.js";
import type { RunId, WorkItemId } from "../../src/domain/ids.js";

function makeTicket(model: string, effort: WorkerTicket["model"]["reasoningEffort"]): WorkerTicket {
  return {
    schemaVersion: "1.0.0",
    ticketId: "planner-ticket-1",
    objective: "produce a concrete synthetic plan",
    acceptanceCriteria: [{ id: "ac-1", version: "1.0.0", description: "plan is produced" }],
    scope: { owned: ["test/fixtures/planner-ticket-owned.txt"], forbidden: [], read: [], dependencies: [], validation: ["run planner fixture validation check"] },
    model: { eligibleModels: [model], reasoningEffort: effort, rationale: "test fixture" },
    budgets: { contextTokens: 1000, outputTokens: 500, elapsedSeconds: 60, maxAttempts: 1 },
    policy: { checkpoint: "checkpoint", stopConditions: ["done"], escalation: "human" },
    resultSchema: { requiredFields: ["schemaVersion", "ticketId"], maxResultBytes: 2048 },
  } as WorkerTicket;
}

function makeGrant(ticket: WorkerTicket, request: DirectHostLaunchRequest): DirectHostLaunchGrant {
  const ticketDigest = computeTicketDigest(ticket);
  const binding: DirectLaunchBinding = {
    ticketDigest,
    registryPrincipalId: request.registryPrincipalId,
    workItemId: request.workItemId,
    specRevision: request.specRevision,
    runId: request.runId,
    reservationId: "planner-res-1",
    reservationVersion: 1,
  } as unknown as DirectLaunchBinding;
  return {
    ticket,
    ticketDigest,
    binding,
    evidence: {
      ticketDigest: binding.ticketDigest,
      registryPrincipalId: binding.registryPrincipalId,
      workItemId: binding.workItemId,
      specRevision: binding.specRevision,
      runId: binding.runId,
      reservationId: binding.reservationId,
      reservationVersion: binding.reservationVersion,
      scope: ticket.scope,
      model: ticket.model,
      budgets: ticket.budgets,
      observedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T01:00:00.000Z",
      evidenceReference: "planner-evid-1",
      evidenceDigest: "digest",
      quota: {
        availableContextTokens: 1000,
        availableOutputTokens: 500,
        availableElapsedSeconds: 60,
        availableAttempts: 1,
        verified: true,
      },
      context: {
        supportedModels: ticket.model.eligibleModels,
        supportedReasoningEfforts: [ticket.model.reasoningEffort],
        verified: true,
      },
      confinement: { supportedScopeOwned: ["test/fixtures/planner-ticket-owned.txt"], supportedScopeForbidden: [], verified: true },
    },
  };
}

export interface SyntheticPlannerAdmissionOptions {
  readonly model: string;
  readonly effort?: WorkerTicket["model"]["reasoningEffort"];
}

export interface SyntheticPlannerAdmissionCalls {
  atomicConsumeLaunch: number;
}

/**
 * Builds a fresh, test-owned CliPlannerAdmissionSource whose prepareRequest
 * derives a DirectHostLaunchRequest from the actual PlannerRequest it is
 * given (planId/correlationTag/revision), bound to the supplied configured
 * model/effort. The backing authority is synthetic and explicitly not a live
 * grant.
 */
export function createSyntheticPlannerAdmissionSource(
  options: SyntheticPlannerAdmissionOptions,
): { readonly source: CliPlannerAdmissionSource; readonly calls: SyntheticPlannerAdmissionCalls } {
  const effort = options.effort ?? "low";
  const calls: SyntheticPlannerAdmissionCalls = { atomicConsumeLaunch: 0 };
  const authority: DirectHostAuthorityPort<DirectHostLaunchRequest, DirectHostLaunchGrant> = {
    async resolveAndReserve(request: DirectHostLaunchRequest) {
      return makeGrant(makeTicket(options.model, effort), request);
    },
    async revalidate() {
      // no-op: synthetic authority, not a live grant
    },
    async checkReadiness() {
      return true;
    },
    async atomicConsumeLaunch(binding: DirectLaunchBinding) {
      calls.atomicConsumeLaunch++;
      if (calls.atomicConsumeLaunch > 1) throw new Error("already consumed");
      return { binding, consumedAt: "2026-01-01T00:00:00.000Z" } as DirectLaunchReceipt;
    },
    async cancel() {
      // no-op: synthetic authority, not a live grant
    },
  };

  const channel = createDirectHostAdmissionChannel(authority, async (_binding, request) => request);

  const source: CliPlannerAdmissionSource = {
    channel,
    async prepareRequest(request: PlannerRequest): Promise<DirectHostLaunchRequest> {
      return {
        ticketReference: `planner-ticket-ref:${request.planId}` as DirectHostLaunchRequest["ticketReference"],
        registryPrincipalId: "planner-principal-1",
        workItemId: request.planId as unknown as DirectHostLaunchRequest["workItemId"],
        specRevision: request.revision,
        runId: request.correlationTag as unknown as DirectHostLaunchRequest["runId"],
        role: "PLANNER" as DirectHostLaunchRequest["role"],
        acceptanceCriteria: [] as unknown as DirectHostLaunchRequest["acceptanceCriteria"],
        dependencyWorkItemIds: [],
        scope: { owned: ["test/fixtures/planner-ticket-owned.txt"], forbidden: [], read: [], dependencies: [], validation: ["run planner fixture validation check"] },
        model: { eligibleModels: [options.model], reasoningEffort: effort, rationale: "test fixture" },
      };
    },
  };

  return { source, calls };
}

export interface SyntheticGenericWorkerAdmissionOptions {
  readonly model: string;
  readonly role: FactoryRole;
  readonly workItemId: WorkItemId;
  readonly runId: RunId;
  readonly effort?: WorkerTicket["model"]["reasoningEffort"];
}

/**
 * Builds a fresh, test-owned direct-admission channel plus an already-issued
 * handle for ONE generic (non-planner) cliWorker.execute call, bound to the
 * actual request's runId/workItemId/role/model — mirrors
 * concreteCliAggregateOutput.test.ts's real
 * createDirectHostAdmissionChannel/issue path. The backing authority is
 * synthetic and explicitly not a live grant; never reuse a PLANNER grant for
 * a generic-role call.
 */
export async function createSyntheticGenericWorkerAdmission(
  options: SyntheticGenericWorkerAdmissionOptions,
): Promise<{ readonly channel: DirectHostAdmissionSurface; readonly handle: DirectHostAdmissionHandle }> {
  const effort = options.effort ?? "low";
  const ticket = makeTicket(options.model, effort);
  const request: DirectHostLaunchRequest = {
    ticketReference: `generic-ticket-ref:${options.runId}` as DirectHostLaunchRequest["ticketReference"],
    registryPrincipalId: "generic-principal-1",
    workItemId: options.workItemId,
    specRevision: 1,
    runId: options.runId,
    role: options.role,
    acceptanceCriteria: [] as unknown as DirectHostLaunchRequest["acceptanceCriteria"],
    dependencyWorkItemIds: [],
    scope: ticket.scope,
    model: ticket.model,
  };

  const authority: DirectHostAuthorityPort<DirectHostLaunchRequest, DirectHostLaunchGrant> = {
    async resolveAndReserve(req: DirectHostLaunchRequest) {
      return makeGrant(ticket, req);
    },
    async revalidate() {
      // no-op: synthetic authority, not a live grant
    },
    async checkReadiness() {
      return true;
    },
    async atomicConsumeLaunch(binding: DirectLaunchBinding) {
      return { binding, consumedAt: "2026-01-01T00:00:00.000Z" } as DirectLaunchReceipt;
    },
    async cancel() {
      // no-op: synthetic authority, not a live grant
    },
  };

  const channel = createDirectHostAdmissionChannel(authority, async (_binding, issuedRequest) => issuedRequest);
  const handle = await channel.issue(request);
  return { channel, handle };
}
