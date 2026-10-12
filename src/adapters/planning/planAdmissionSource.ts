/**
 * Plan-owned offline trusted admission composition (PHASE7-136).
 *
 * One module instance binds exactly ONE canonical planner action. It builds
 * the SAME direct-host admission channel the guarded planner worker is
 * constructed with, registers that worker with the trusted registry, and
 * projects the launch request only from the canonical Plan and the real
 * registry principal. Authorization, confinement, quota, model and budget
 * resolution stay entirely inside the existing channel and authority; this
 * module invents no issuer, capacity or grant and performs no Plan writes.
 */

import type { ProcessRunner } from '../../ports/processRunner.js';
import type { Worker } from '../../ports/worker.js';
import type { WorkerRegistry } from '../../ports/workerRegistry.js';
import type { WorkerPrincipal } from '../../domain/workerPrincipal.js';
import type { LoopWorkerConfig } from '../../orchestration/loopTypes.js';
import type { PlanRepository } from '../../planning/planRepository.js';
import type { PlannerRequest } from '../../planning/plannerWorker.js';
import type { Plan } from '../../planning/planTypes.js';
import { createDirectHostAdmissionChannel } from '../../supervision/directWorkerAdmission.js';
import type {
  DirectHostAdmissionSurface,
  DirectHostAuthorityPort,
  DirectHostLaunchRequest,
} from '../../supervision/directWorkerAdmission.js';
import type { Workspace } from '../workers/workspace.js';
import type { CliPlannerWorkerDeps } from './cliPlannerWorker.js';

export interface PlanAdmissionResolveInput {
  readonly plan: Plan;
  readonly request: PlannerRequest;
  readonly principal: WorkerPrincipal;
  readonly config: LoopWorkerConfig;
}

export interface PlanAdmissionDeps {
  readonly planRepository: PlanRepository;
  /** The expected immutable planner request this module is bound to. */
  readonly request: PlannerRequest;
  readonly expectedPlanVersion: number;
  readonly ownerId: string;
  readonly config: LoopWorkerConfig;
  readonly workspace: Workspace;
  readonly processRunner: ProcessRunner;
  readonly workerRegistry: WorkerRegistry;
  /** Trusted guarded-worker factory; same signature as CliPlannerWorkerDeps.createWorker. */
  readonly createGuardedWorker: NonNullable<CliPlannerWorkerDeps['createWorker']>;
  /** Genuine authority; resolves authorization/confinement/quota/model/budgets and consumes atomically. */
  readonly authority: DirectHostAuthorityPort;
  /** Trusted projection of the launch request from the canonical Plan and the real principal. */
  readonly resolveRequest: (input: PlanAdmissionResolveInput) => Promise<DirectHostLaunchRequest>;
}

function fail(message: string): never {
  throw new Error(`plan admission source: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as unknown as T;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = deepClone(value[key]);
    }
    return out as T;
  }
  if (typeof value === 'function') {
    fail('request data must not contain functions');
  }
  return value;
}

function deepFreeze<T>(value: T, seen: Set<unknown> = new Set()): T {
  if (!isRecord(value) || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Object.keys(value)) {
    deepFreeze(value[key], seen);
  }
  return Object.freeze(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) {
      return false;
    }
    return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

function snapshotStrings(value: object): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      out[key] = item;
    }
  }
  return Object.freeze(out);
}

function copyConfig(config: LoopWorkerConfig): LoopWorkerConfig {
  return Object.freeze({
    tool: config.tool,
    model: config.model,
    ...(config.effort === undefined ? {} : { effort: config.effort }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
  });
}

function configMatches(actual: LoopWorkerConfig, expected: LoopWorkerConfig): boolean {
  return (
    isRecord(actual) &&
    String(actual.tool) === String(expected.tool) &&
    actual.model === expected.model &&
    actual.effort === expected.effort &&
    actual.timeoutMs === expected.timeoutMs
  );
}

export function createPlanAdmissionSource(
  deps: PlanAdmissionDeps,
): Pick<CliPlannerWorkerDeps, 'admissionSource' | 'createWorker'> {
  if (!isRecord(deps)) {
    fail('deps are required');
  }

  // Capture everything once; later mutation of the caller's deps or request
  // objects must not rebind any of it.
  const planRepository = deps.planRepository;
  const rawRequest = deps.request;
  const expectedPlanVersion = deps.expectedPlanVersion;
  const ownerId = deps.ownerId;
  const rawConfig = deps.config;
  const workspace = deps.workspace;
  const processRunner = deps.processRunner;
  const workerRegistry = deps.workerRegistry;
  const createGuardedWorker = deps.createGuardedWorker;
  const authority = deps.authority;
  const resolveRequest = deps.resolveRequest;

  if (!isRecord(planRepository) || typeof planRepository.findById !== 'function') {
    fail('planRepository with findById is required');
  }
  if (!isRecord(rawRequest)) {
    fail('expected planner request is required');
  }
  if (!isNonEmptyString(rawRequest.planId) || !isNonEmptyString(rawRequest.correlationTag)) {
    fail('planner request must carry planId and correlationTag');
  }
  if (!isPositiveSafeInteger(rawRequest.revision) || !isPositiveSafeInteger(rawRequest.attempt)) {
    fail('planner request revision and attempt must be positive safe integers');
  }
  if (typeof expectedPlanVersion !== 'number' || !Number.isSafeInteger(expectedPlanVersion) || expectedPlanVersion < 0) {
    fail('expectedPlanVersion must be a non-negative safe integer');
  }
  if (!isNonEmptyString(ownerId)) {
    fail('ownerId is required');
  }
  if (!isRecord(rawConfig) || !isNonEmptyString(rawConfig.model) || !isNonEmptyString(String(rawConfig.tool))) {
    fail('worker config with tool and model is required');
  }
  if (!isRecord(workspace) || !isNonEmptyString(workspace.root)) {
    fail('workspace with a root path is required');
  }
  if (!isRecord(processRunner)) {
    fail('processRunner is required');
  }
  if (
    !isRecord(workerRegistry) ||
    typeof workerRegistry.register !== 'function' ||
    typeof workerRegistry.principalFor !== 'function'
  ) {
    fail('workerRegistry with register and principalFor is required');
  }
  if (typeof createGuardedWorker !== 'function') {
    fail('trusted guarded-worker factory is required');
  }
  if (!isRecord(authority)) {
    fail('direct-host authority is required');
  }
  if (typeof resolveRequest !== 'function') {
    fail('trusted resolveRequest callback is required');
  }

  const request: PlannerRequest = deepFreeze(deepClone(rawRequest));
  const config: LoopWorkerConfig = copyConfig(rawConfig);
  const workspacePaths = snapshotStrings(workspace);
  const capturedWorkspace: Workspace = deepFreeze(deepClone(workspace));
  const findById = planRepository.findById.bind(planRepository);
  const registerWorker = workerRegistry.register.bind(workerRegistry);
  const principalFor = workerRegistry.principalFor.bind(workerRegistry);

  let attempted = false;
  let prepared = false;
  let created = false;
  let retainedWorker: Worker | undefined;
  let retainedPrincipal: WorkerPrincipal | undefined;

  async function readCanonicalPlan(): Promise<Plan> {
    const plan = await findById(request.planId);
    if (plan === undefined || plan === null) {
      fail(`plan ${request.planId} not found`);
    }
    if (plan.id !== request.planId) {
      fail('canonical plan id does not match the bound planner request');
    }
    if (plan.version !== expectedPlanVersion) {
      fail(`canonical plan version ${String(plan.version)} does not match expected ${expectedPlanVersion}`);
    }
    if (String(plan.phase) !== 'PLANNING') {
      fail(`canonical plan phase is ${String(plan.phase)}, expected PLANNING`);
    }
    if (plan.cancelRequested !== false) {
      fail('canonical plan has a cancellation requested');
    }
    const action = plan.plannerAction;
    if (action === undefined || action === null) {
      fail('canonical plan has no planner action lease');
    }
    if (String(action.state) !== 'RUNNING') {
      fail(`planner action state is ${String(action.state)}, expected RUNNING`);
    }
    if (action.ownerId !== ownerId) {
      fail('planner action is owned by a different owner');
    }
    if (action.revision !== request.revision || action.attempt !== request.attempt) {
      fail('planner action revision or attempt does not match the bound planner request');
    }
    if (action.correlationTag !== request.correlationTag) {
      fail('planner action correlationTag does not match the bound planner request');
    }
    if (plan.intent !== request.intent) {
      fail('canonical plan intent does not match the bound planner request');
    }
    if (!deepEqual(plan.declaredConstraints, request.constraints)) {
      fail('canonical plan declared constraints do not match the bound planner request');
    }
    const planner = plan.planner;
    if (
      !isRecord(planner) ||
      String(planner.tool) !== String(config.tool) ||
      planner.model !== config.model ||
      planner.effort !== config.effort ||
      planner.timeoutMs !== config.timeoutMs
    ) {
      fail('canonical plan planner config does not match the bound worker config');
    }
    return plan;
  }

  async function projectRequest(plan: Plan, principal: WorkerPrincipal): Promise<DirectHostLaunchRequest> {
    const resolved = await resolveRequest({ plan, request, principal, config });
    if (!isRecord(resolved)) {
      fail('resolveRequest returned no launch request');
    }
    if (resolved.role !== 'PLANNER') {
      fail(`resolved request role must be PLANNER, got ${String(resolved.role)}`);
    }
    if (resolved.executionKind !== undefined && resolved.executionKind !== 'ai') {
      fail('resolved request must be an AI launch request');
    }
    if (String(resolved.workItemId) !== request.planId) {
      fail('resolved request workItemId must equal the planner request planId');
    }
    if (String(resolved.runId) !== request.correlationTag) {
      fail('resolved request runId must equal the planner request correlationTag');
    }
    if (resolved.specRevision !== request.revision) {
      fail('resolved request specRevision must equal the planner request revision');
    }
    if (resolved.registryPrincipalId !== principal.principalId) {
      fail('resolved request registryPrincipalId must equal the real registry principal');
    }
    const model = resolved.model;
    if (!isRecord(model) || !Array.isArray(model.eligibleModels) || !model.eligibleModels.includes(config.model)) {
      fail(`resolved request does not make configured model ${config.model} eligible`);
    }
    if (config.effort !== undefined && model.reasoningEffort !== config.effort) {
      fail('resolved request reasoningEffort does not match the configured effort');
    }
    return deepFreeze(resolved);
  }

  // The channel is constructed here, once, with the authority and a
  // readCurrentRequest that re-reads the canonical Plan on every call. It is
  // the same object the guarded worker is later built with. Construction
  // validates the authority and fails closed before any worker exists.
  const channel: DirectHostAdmissionSurface = createDirectHostAdmissionChannel(authority, async () => {
    const principal = retainedPrincipal;
    if (!prepared || principal === undefined || retainedWorker === undefined) {
      fail('current request requested before the guarded worker was prepared');
    }
    const plan = await readCanonicalPlan();
    return projectRequest(plan, principal);
  });

  async function prepareRequest(candidate: PlannerRequest): Promise<DirectHostLaunchRequest> {
    if (attempted) {
      fail('prepare is one-shot per module instance');
    }
    attempted = true;

    if (!deepEqual(candidate, request)) {
      fail('prepared planner request does not equal the bound planner request');
    }
    const plan = await readCanonicalPlan();

    const worker = createGuardedWorker(config, capturedWorkspace, processRunner, channel);
    if (!isRecord(worker) || typeof worker.execute !== 'function') {
      fail('trusted factory did not return a worker');
    }
    const principal = registerWorker(worker, { roles: ['PLANNER'], requiresDirectAdmission: true });
    if (!isRecord(principal) || !isNonEmptyString(principal.principalId)) {
      fail('registry returned no principal for the guarded worker');
    }
    if (principalFor(worker).principalId !== principal.principalId) {
      fail('registry principal does not resolve back to the registered worker');
    }
    const projection = await projectRequest(plan, principal);
    retainedWorker = worker;
    retainedPrincipal = principal;
    prepared = true;

    return projection;
  }

  function createWorker(
    candidateConfig: LoopWorkerConfig,
    candidateWorkspace: Workspace,
    candidateRunner: ProcessRunner,
    candidateChannel: DirectHostAdmissionSurface,
  ): Worker {
    if (created) {
      fail('worker creation is one-shot per module instance');
    }
    created = true;
    const worker = retainedWorker;
    const principal = retainedPrincipal;
    if (!prepared || worker === undefined || principal === undefined) {
      fail('worker requested before preparation retained a registered worker');
    }
    if (!configMatches(candidateConfig, config)) {
      fail('worker config does not match the bound config');
    }
    if (candidateWorkspace !== workspace || !deepEqual(snapshotStrings(candidateWorkspace), workspacePaths)) {
      fail('workspace identity or captured paths do not match');
    }
    if (candidateRunner !== processRunner) {
      fail('process runner identity does not match');
    }
    if (candidateChannel !== channel) {
      fail('admission channel is not the exact channel the worker was registered with');
    }
    if (principalFor(worker).principalId !== principal.principalId) {
      fail('retained worker no longer resolves to the retained registry principal');
    }
    return worker;
  }

  return {
    admissionSource: { channel, prepareRequest },
    createWorker,
  };
}
