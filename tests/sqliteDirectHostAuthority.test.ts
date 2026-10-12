// PHASE7-98 retained SQLite host supplier — genuine-approval fixture.
//
// Nothing here fakes approval, the store, the registry or the loop. One
// composition builds a real FactoryService + PlanningService over ONE shared
// createLocalWorkerRegistry and ONE in-memory FactoryStore, drives a real
// HUMAN PLAN_APPROVAL through PlanningService.approve (recorded revision +
// content digest + materialization), and the authority under test reads that
// approval back through the ACTUAL PlanningService.verifiedApprovedExecutionSnapshot.
//
// The RUNNING run a reservation attaches is a real Factory-owned run created
// by FactoryService.runWorker with a genuine trusted mock Worker (the only
// identity exception the registry recognizes, so no admission flag is spoofed
// and the frozen Worker object is never mutated). Timing is controlled by a
// TEST-OWNED delegating FactoryStore that wraps only the public `transaction`
// entry point: once armed for a work item, it holds the Factory's PHASE 3
// finalization BEFORE entering the backing transaction, so the committed
// RUNNING row and item.runIds attachment are live and readable while NO
// backing transaction lock is held. The barrier is claimed once, is always
// released in a finally with a bounded await, and unexpected run failures
// propagate.
//
// The capability callback is SYNTHETIC: an offline adapter-wiring proof only.
// It is never real provider quota, eligibility or production authority.
//
// Durability uses a real temporary SQLite FILE: the DatabaseSync is closed and
// reopened, and a FRESH authority instance over the reopened file proves the
// consumed tombstone survives while a persisted id alone grants nothing.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createInMemoryStore } from "../src/adapters/memory/inMemoryStore.js";
import { createInMemoryLoopRepository } from "../src/adapters/orchestration/inMemoryLoopRepository.js";
import { createInMemoryPlanRepository } from "../src/adapters/planning/inMemoryPlanRepository.js";
import { createLocalHumanIdentityGate } from "../src/adapters/security/localHumanIdentityGate.js";
import { createLocalWorkerRegistry } from "../src/adapters/security/localWorkerRegistry.js";
import { createMockWorker } from "../src/adapters/workers/mockWorker.js";
import {
  SqliteDirectHostAuthority,
  type ApprovedPrestartFacts,
  type BoundWorkerAction,
  type SqliteDirectHostAuthorityDeps,
} from "../src/adapters/supervision/sqliteDirectHostAuthority.js";
import { FactoryService } from "../src/app/factoryService.js";
import { agent } from "../src/domain/actor.js";
import { createSequentialIdGenerator } from "../src/domain/ids.js";
import type { RunId, WorkItemId } from "../src/domain/ids.js";
import type { FactoryRole } from "../src/domain/role.js";
import type { Clock } from "../src/ports/clock.js";
import type { DirectLaunchBinding } from "../src/ports/worker.js";
import type { Worker } from "../src/ports/worker.js";
import type { EngineeringLoop } from "../src/orchestration/loopTypes.js";
import { canonicalActionId, correlationTag, openIteration } from "../src/orchestration/loopTypes.js";
import { PlanningService, createPlanBindingResolver } from "../src/planning/planningService.js";
import type { PlanExecutionConfig, WorkItemTicketTemplate } from "../src/planning/planTypes.js";
import { createScriptedDispatcher, createScriptedPlannerWorker } from "../src/planning/scriptedPlannerWorkers.js";
import { DirectAdmissionRefusedError } from "../src/supervision/directWorkerAdmission.js";
import type { WorkerTicket } from "../src/supervision/workerContract.js";
import {
  PLAN_CREDENTIAL,
  PLAN_HUMAN,
  TEST_PLANNER_CONFIG,
  authorizePlanHuman,
  defaultPlannerCriterionText,
  simplePlanResponse,
  validTicketTemplate,
} from "./support/planFixtures.js";

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

const WORKSPACE_ROOT = "/tmp/sf-phase7-98";
const IMPLEMENT_TOOL = "codex-cli" as const;
const REVIEW_TOOL = "claude-code" as const;
const IMPLEMENT_MODEL = "impl-model";
const REVIEW_MODEL = "review-model";
const CRITERION_TEXT = defaultPlannerCriterionText("Do the thing");

function countingClock(startMs = 1_700_000_000_000): Clock {
  let now = startMs;
  return { now: () => (now += 1_000) };
}

/** The approved template, with the per-slot model/effort the host also binds. */
function ticketTemplate(): WorkItemTicketTemplate {
  const base = validTicketTemplate("WI-A", CRITERION_TEXT);
  return {
    ...base,
    scope: { ...base.scope, owned: ["src/thing.ts"] },
    model: {
      eligibleModels: [IMPLEMENT_MODEL, REVIEW_MODEL],
      reasoningEffort: "medium",
      rationale: "Scoped single-module change needs cross-file reasoning.",
    },
  };
}

function executionConfig(): PlanExecutionConfig {
  return {
    implementer: { tool: IMPLEMENT_TOOL, model: IMPLEMENT_MODEL, effort: "medium" },
    reviewer: { tool: REVIEW_TOOL, model: REVIEW_MODEL, effort: "medium" },
    verificationCommands: [{ id: "check", executable: "node", argv: ["-e", "process.exit(0)"] }],
    workspaceRoot: WORKSPACE_ROOT,
    loopBudget: { maxIterations: 2 },
    ticketTemplates: [ticketTemplate()],
  };
}

/** Bounded: a rejected race partner so no await here can hang a test run. */
function deadline<T>(work: Promise<T>, label: string, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
  });
  return Promise.race([work, expiry]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }) as Promise<T>;
}

type BarrierStore = ReturnType<typeof createInMemoryStore>;

/** What the barrier must genuinely observe before it claims a transaction. */
interface BarrierArming {
  readonly workItemId: WorkItemId;
  readonly registryPrincipalId: string;
  readonly role: FactoryRole;
  readonly declaredWorkerId: string;
}

/**
 * A TEST-OWNED delegating FactoryStore. It forwards every repository and every
 * `transaction` call to ONE shared real backing store, and the only thing it
 * adds is timing.
 *
 * The claim is decided by OBSERVED REAL STATE, never by counting transactions
 * or call order: while armed, each incoming transaction first reads the backing
 * `runs.listByWorkItem` for the armed work item and claims only once a run is
 * genuinely attached, still RUNNING, and matches the armed registry principal
 * identity, role and declared worker id audit label. Nothing is fabricated,
 * mutated or flagged here — the row must already be exactly that.
 *
 * Because the wait happens outside `backing.transaction`, no backing
 * transaction lock is ever held across it.
 */
function barrierStore(backing: BarrierStore) {
  let armed: BarrierArming | undefined;
  let gate: Promise<void> | undefined;
  let release: (() => void) | undefined;
  let claimed: (() => void) | undefined;
  let claimFailed: ((error: Error) => void) | undefined;
  const claimedPromise = new Promise<void>((resolve, reject) => {
    claimed = resolve;
    claimFailed = reject;
  });
  // The claim promise is only awaited through `waitForClaim`; keep an
  // unobserved rejection from ever surfacing as an unhandled rejection.
  claimedPromise.catch(() => {});

  /** The armed identity's live RUNNING run, or undefined if not yet present. */
  async function observeArmedRunningRun(arming: BarrierArming): Promise<boolean> {
    const runs = await backing.runs.listByWorkItem(arming.workItemId);
    return runs.some(
      (run) =>
        run.status === "RUNNING" &&
        run.role === arming.role &&
        run.workerPrincipalId === arming.registryPrincipalId &&
        run.declaredWorkerId === arming.declaredWorkerId,
    );
  }

  const store: BarrierStore = {
    ...backing,
    async transaction(work) {
      const arming = armed;
      if (arming !== undefined && gate === undefined) {
        // Claim once, and only against genuine observed state: the armed
        // identity's real RUNNING row is already committed and attached, so
        // holding here (before the backing transaction is entered) leaves it
        // live and readable by the authority under test.
        let observed: boolean;
        try {
          observed = await observeArmedRunningRun(arming);
        } catch (error) {
          // A failed observation must not silently become a pass-through.
          armed = undefined;
          claimFailed?.(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
        if (observed) {
          gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          // Disarm BEFORE awaiting, so the genuine approval/store reads the
          // test performs while the gate is held are not themselves held.
          armed = undefined;
          claimed?.();
          await gate;
        }
      }
      return backing.transaction(work);
    },
  };

  return {
    store,
    /** Arms the barrier against one real work item / registry principal identity. */
    arm(arming: BarrierArming): void {
      armed = arming;
    },
    /** Bounded: resolves once the held finalization transaction is claimed. */
    async waitForClaim(): Promise<void> {
      await deadline(claimedPromise, "the Factory to reach run finalization");
    },
    release(): void {
      armed = undefined;
      release?.();
    },
  };
}

interface Composition {
  readonly factory: FactoryService;
  readonly planning: PlanningService;
  readonly store: ReturnType<typeof createInMemoryStore>;
  readonly barrier: ReturnType<typeof barrierStore>;
  /** The SAME real plan repository the Factory and PlanningService already use. */
  readonly plans: ReturnType<typeof createInMemoryPlanRepository>;
  readonly loops: ReturnType<typeof createInMemoryLoopRepository>;
  readonly registry: ReturnType<typeof createLocalWorkerRegistry>;
  readonly clock: Clock;
}

/**
 * Real Factory + PlanningService over ONE registry/clock and ONE real backing
 * store. The Factory writes through the delegating barrier view of that same
 * store; the authority under test reads the backing store directly.
 */
function compose(): Composition {
  const clock = countingClock();
  const backing = createInMemoryStore();
  const barrier = barrierStore(backing);
  const store = barrier.store;
  const plans = createInMemoryPlanRepository();
  const loops = createInMemoryLoopRepository();
  const registry = createLocalWorkerRegistry(clock);
  const factory = new FactoryService({
    store,
    clock,
    ids: createSequentialIdGenerator(),
    identityGate: createLocalHumanIdentityGate({ credential: PLAN_CREDENTIAL, clock }),
    workerRegistry: registry,
    planBindingResolver: createPlanBindingResolver(plans),
  });
  const planning = new PlanningService({
    factory,
    plans,
    clock,
    ids: createSequentialIdGenerator(),
    planner: createScriptedPlannerWorker({ outputs: [simplePlanResponse()] }),
    dispatcher: createScriptedDispatcher(),
  });
  return { factory, planning, store: backing, barrier, plans, loops, registry, clock };
}

interface ApprovedFixture extends Composition {
  readonly planId: string;
  readonly workItemId: WorkItemId;
  readonly loopId: string;
}

/**
 * Drives a REAL plan to a genuine recorded HUMAN PLAN_APPROVAL and real
 * materialization, then registers the live loop the authority reads. The
 * approval is produced by PlanningService.approve with a trusted token minted
 * by the identity gate — never a caller-asserted APPROVED flag.
 */
async function approvedFixture(loopId = "loop-98", execution?: PlanExecutionConfig): Promise<ApprovedFixture> {
  const composition = compose();
  const { factory, planning, loops } = composition;
  const project = await factory.createProject({ key: "P98", name: "Phase7-98" });
  const started = await planning.start({
    projectId: project.id,
    actor: PLAN_HUMAN,
    intent: "Build the thing.",
    planner: TEST_PLANNER_CONFIG,
    execution: execution ?? executionConfig(),
  });
  await planning.approve(started.id, PLAN_HUMAN, authorizePlanHuman(factory));

  // Genuine, verified approval facts — the same read the authority performs.
  const snapshot = await planning.verifiedApprovedExecutionSnapshot(started.id);
  const mapping = snapshot.materialized[0];
  assert.ok(mapping !== undefined, "the approved plan materialized its item");
  const workItemId = mapping.workItemId;

  const loop: EngineeringLoop = {
    id: loopId,
    workItemId,
    version: 1,
    phase: "IMPLEMENTING",
    budget: { maxIterations: 2 },
    implementer: { tool: IMPLEMENT_TOOL, model: IMPLEMENT_MODEL, effort: "medium" },
    reviewer: { tool: REVIEW_TOOL, model: REVIEW_MODEL, effort: "medium" },
    verificationCommands: execution?.verificationCommands ?? [],
    workspaceRoot: WORKSPACE_ROOT,
    taskInstructions: "do the thing",
    iterations: [withClaims(openIteration(1), loopId, 1, { implement: true })],
    totalRunCount: 0,
    cancelRequested: false,
    startedBy: PLAN_HUMAN,
    startedAt: 0,
    lastTransitionAt: 0,
  };
  await loops.create(loop);

  return { ...composition, planId: started.id, workItemId, loopId };
}

/** Canonical claims for one iteration, exactly as loopTypes derives them. */
function withClaims(
  record: ReturnType<typeof openIteration>,
  loopId: string,
  iteration: number,
  which: { implement?: boolean; review?: boolean },
) {
  const claimFor = (kind: "IMPLEMENT" | "REVIEW") => {
    const actionId = canonicalActionId(loopId, iteration, kind);
    return {
      actionId,
      kind,
      attempt: 1,
      ownerToken: `owner-${kind}`,
      claimedAt: 0,
      correlationTag: correlationTag(actionId, 1),
    } as const;
  };
  return {
    ...record,
    ...(which.implement === true ? { implementClaim: claimFor("IMPLEMENT") } : {}),
    ...(which.review === true ? { reviewClaim: claimFor("REVIEW") } : {}),
  };
}

/** The canonical worker id a claimed action's run must declare. */
function claimWorkerId(loopId: string, iteration: number, kind: "IMPLEMENT" | "REVIEW"): string {
  return correlationTag(canonicalActionId(loopId, iteration, kind), 1);
}

/**
 * SYNTHETIC capability evidence, derived strictly from the authority's own
 * ticket/binding. Adapter-wiring proof only: never real provider quota,
 * eligibility, or production launch authority.
 */
function syntheticCapability(clock: Clock) {
  return async (request: {
    readonly ticket: WorkerTicket;
    readonly ticketDigest: string;
    readonly binding: DirectLaunchBinding;
  }): Promise<unknown> => {
    const { ticket, binding } = request;
    const observed = new Date(clock.now()).toISOString();
    return {
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
      observedAt: observed,
      expiresAt: new Date(Date.parse(observed) + 120_000).toISOString(),
      evidenceReference: "synthetic://phase7-98/evidence",
      evidenceDigest: `synthetic-${binding.reservationId}`,
      quota: {
        availableContextTokens: ticket.budgets.contextTokens,
        availableOutputTokens: ticket.budgets.outputTokens,
        availableElapsedSeconds: ticket.budgets.elapsedSeconds,
        availableAttempts: ticket.budgets.maxAttempts,
        verified: true,
      },
      context: {
        supportedModels: ticket.model.eligibleModels,
        supportedReasoningEfforts: [ticket.model.reasoningEffort],
        verified: true,
      },
      confinement: {
        supportedScopeOwned: ticket.scope.owned,
        supportedScopeForbidden: ticket.scope.forbidden,
        verified: true,
      },
    };
  };
}

function boundImplement(worker: Worker): BoundWorkerAction {
  return {
    worker,
    slot: "IMPLEMENT",
    config: { tool: IMPLEMENT_TOOL, model: IMPLEMENT_MODEL, effort: "medium" },
    workspaceRoot: WORKSPACE_ROOT,
  };
}

function boundReview(worker: Worker): BoundWorkerAction {
  return {
    worker,
    slot: "REVIEW",
    config: { tool: REVIEW_TOOL, model: REVIEW_MODEL, effort: "medium" },
    workspaceRoot: WORKSPACE_ROOT,
  };
}

function buildAuthority(
  fixture: ApprovedFixture,
  db: DatabaseSync,
  boundWorkers: readonly BoundWorkerAction[],
  overrides: Partial<Pick<SqliteDirectHostAuthorityDeps, "capability" | "authorityId">> = {},
): SqliteDirectHostAuthority {
  return new SqliteDirectHostAuthority({
    planning: fixture.planning,
    store: fixture.store,
    loops: fixture.loops,
    registry: fixture.registry,
    db,
    clock: fixture.clock,
    capability: overrides.capability ?? syntheticCapability(fixture.clock),
    boundWorkers,
    authorityId: overrides.authorityId ?? "authority-A",
  });
}

async function withTempDb(body: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sf-phase7-98-"));
  try {
    await body(join(dir, "host-authority.sqlite"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Starts a real Factory IMPLEMENTER run with a genuine trusted mock Worker and
 * holds the Factory's PHASE 3 finalization on the test-owned store barrier, so
 * a reservation can attach the genuine Factory-owned run while it is still
 * RUNNING. The barrier is always released and the run always awaited by the
 * caller's finally; an unexpected run failure propagates from `settle`.
 */
async function runningImplementerRun(
  fixture: ApprovedFixture,
  worker: Worker,
): Promise<{ readonly runId: RunId; readonly settle: () => Promise<void> }> {
  const orchestrator = agent("agent:test-orchestrator", "Test Orchestrator");
  await fixture.factory.advance(fixture.workItemId, "IMPLEMENTING", orchestrator);
  // Armed with the REAL registry principal for this worker plus the role and
  // the declared-worker-id audit label the Factory will record on the run, so
  // the barrier claims on observed state rather than on a transaction count.
  fixture.barrier.arm({
    workItemId: fixture.workItemId,
    registryPrincipalId: fixture.registry.principalFor(worker).principalId,
    role: "IMPLEMENTER",
    declaredWorkerId: worker.id,
  });
  const pending = fixture.factory.runWorker({
    workItemId: fixture.workItemId,
    role: "IMPLEMENTER",
    worker,
    instructions: "implement",
  });
  const settle = async (): Promise<void> => {
    fixture.barrier.release();
    // Bounded, and never swallowed: the run must have genuinely finalized.
    await deadline(pending, "the held implementer run to finalize");
  };
  // The claim lands only after the Factory committed the RUNNING row and the
  // item.runIds attachment, and only the worker's own execute() precedes it.
  // Any failure from here on must still release the barrier and bound-settle
  // the pending run, so no promise is left hanging or unobserved.
  try {
    await fixture.barrier.waitForClaim();
    const item = await fixture.factory.getWorkItem(fixture.workItemId);
    const runId = item.runIds.at(-1);
    if (runId === undefined) {
      throw new Error("the Factory did not attach a RUNNING run to the work item");
    }
    const run = await fixture.store.runs.findById(runId);
    if (run?.status !== "RUNNING") {
      throw new Error(`expected a live RUNNING run, observed ${String(run?.status)}`);
    }
    return { runId, settle };
  } catch (error) {
    // The run's own unexpected failure is never reported as success: if
    // settling surfaces a different error, the original cause is kept.
    await settle().catch(() => {});
    throw error;
  }
}

function reserveRequest(facts: ApprovedPrestartFacts, runId: RunId) {
  return {
    ticketReference: facts.reservationId,
    registryPrincipalId: facts.registryPrincipalId,
    workItemId: facts.workItemId,
    specRevision: facts.specRevision,
    runId,
  };
}

// ---------------------------------------------------------------------------
// Valid IMPLEMENT preparation: strict, frozen, runless prestart facts
// ---------------------------------------------------------------------------

test("PHASE7-98 supplier: prepares a strict runless IMPLEMENT binding from the genuine approved snapshot", async () => {
  const fixture = await approvedFixture();
  const implementer = createMockWorker({
    id: claimWorkerId(fixture.loopId, 1, "IMPLEMENT"),
    roles: ["IMPLEMENTER"],
  });
  const principal = fixture.registry.register(implementer, { roles: ["IMPLEMENTER"] });
  const db = new DatabaseSync(":memory:");
  try {
    const authority = buildAuthority(fixture, db, [boundImplement(implementer)]);
    const facts = await authority.prepare({
      planId: fixture.planId,
      loopId: fixture.loopId,
      iteration: 1,
      slot: "IMPLEMENT",
      worker: implementer,
    });

    assert.equal(facts.state, "PREPARED");
    assert.equal(facts.role, "IMPLEMENTER");
    assert.equal(facts.workItemId, fixture.workItemId);
    assert.equal(facts.registryPrincipalId, principal.principalId);
    // Runless by construction: no run is pre-authorized at preparation.
    assert.equal(facts.runId, undefined);
    assert.equal(facts.targetRunId, undefined);
    assert.ok(facts.boundConfig !== undefined);
    assert.equal(facts.boundConfig.tool, IMPLEMENT_TOOL);
    assert.equal(facts.boundConfig.model, IMPLEMENT_MODEL);
    assert.equal(facts.claimActionId, canonicalActionId(fixture.loopId, 1, "IMPLEMENT"));
    assert.ok(Object.isFrozen(facts));

    // The authority's own retained approved record carries the approved
    // template's rationale/budgets, not anything a caller supplied.
    const retained = authority.resolveApprovedPrestart(facts.reservationId);
    assert.equal(retained?.disposition, "approved");
    assert.ok(retained !== undefined && retained.disposition === "approved");
    const approval = retained.approval;
    assert.ok(approval.executionKind === undefined || approval.executionKind === "ai");
    assert.equal(approval.approvedModel.rationale, ticketTemplate().model.rationale);
    assert.deepEqual(approval.approvedBudgets, ticketTemplate().budgets);
    assert.equal(approval.approvedPrincipalId, principal.principalId);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Valid REVIEW target: same-iteration successful implementation, independent
// principal; and the same-principal refusal.
// ---------------------------------------------------------------------------

test("PHASE7-98 supplier: REVIEW binds the same-iteration successful implementer run with an independent principal, and refuses the same principal", async () => {
  const fixture = await approvedFixture();
  const implementerId = claimWorkerId(fixture.loopId, 1, "IMPLEMENT");
  // Legitimately registered for BOTH roles: the later same-principal REVIEW
  // attempt must therefore fail on reviewer independence, not on a missing
  // REVIEWER role.
  const implementer = createMockWorker({ id: implementerId, roles: ["IMPLEMENTER", "REVIEWER"] });
  fixture.registry.register(implementer, { roles: ["IMPLEMENTER", "REVIEWER"] });

  const orchestrator = agent("agent:test-orchestrator", "Test Orchestrator");
  await fixture.factory.advance(fixture.workItemId, "IMPLEMENTING", orchestrator);
  const implementation = await fixture.factory.runWorker({
    workItemId: fixture.workItemId,
    role: "IMPLEMENTER",
    worker: implementer,
    instructions: "implement",
  });
  assert.equal(implementation.run.status, "SUCCEEDED");
  await fixture.factory.advance(fixture.workItemId, "VERIFYING", orchestrator);

  // VERIFYING is not a formality: an ACTUAL verifier run against exactly this
  // implementation run is what makes the later REVIEW advance legitimate. This
  // is a genuine registered trusted mock Worker executed by the real Factory —
  // it is NOT a host VERIFY slot mapping, and the unmapped-VERIFY refusal
  // covered by its own case below stays untouched.
  const verifier = createMockWorker({ id: "verify-98-review-target", roles: ["VERIFIER"] });
  fixture.registry.register(verifier, { roles: ["VERIFIER"] });
  const verification = await fixture.factory.runWorker({
    workItemId: fixture.workItemId,
    role: "VERIFIER",
    worker: verifier,
    instructions: "verify",
    againstRunId: implementation.run.id,
  });
  assert.equal(verification.run.status, "SUCCEEDED");
  assert.equal(verification.run.targetRunId, implementation.run.id);

  await fixture.factory.recordReview({
    workItemId: fixture.workItemId,
    reviewedRunId: implementation.run.id,
    reviewerRunId: verification.run.id,
    kind: "DETERMINISTIC",
    verdict: "PASS",
  });

  await fixture.factory.advance(fixture.workItemId, "REVIEW", orchestrator);

  // The live loop now records that exact implementer run plus a REVIEW claim.
  const loop = await fixture.loops.findById(fixture.loopId);
  assert.ok(loop !== undefined);
  await fixture.loops.compareAndSave(
    {
      ...loop,
      version: loop.version + 1,
      phase: "REVIEWING",
      iterations: [
        {
          ...withClaims(openIteration(1), fixture.loopId, 1, { implement: true, review: true }),
          implementerRunId: implementation.run.id,
          implementerOutcome: "SUCCEEDED",
        },
      ],
    },
    loop.version,
  );

  const reviewer = createMockWorker({ id: claimWorkerId(fixture.loopId, 1, "REVIEW"), roles: ["REVIEWER"] });
  fixture.factory.registerWorker(reviewer);
  const db = new DatabaseSync(":memory:");
  try {
    const authority = buildAuthority(fixture, db, [boundReview(reviewer), boundReview(implementer)]);
    const facts = await authority.prepare({
      planId: fixture.planId,
      loopId: fixture.loopId,
      iteration: 1,
      slot: "REVIEW",
      worker: reviewer,
    });
    assert.equal(facts.role, "REVIEWER");
    assert.equal(facts.targetRunId, implementation.run.id);
    assert.equal(facts.registryPrincipalId, fixture.registry.principalFor(reviewer).principalId);

    // Same principal as the implementation under review: refused, and the
    // refusal is the independence one, not an unrelated config problem.
    await assert.rejects(
      () =>
        authority.prepare({
          planId: fixture.planId,
          loopId: fixture.loopId,
          iteration: 1,
          slot: "REVIEW",
          worker: implementer,
        }),
      (error: unknown) =>
        error instanceof DirectAdmissionRefusedError && /independent of the implementer/.test(error.reason),
    );
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// VERIFY has no approved model configuration anywhere: refused, never invented
// ---------------------------------------------------------------------------

test("PHASE7-102 deterministic VERIFY lifecycle: genuine reserve, full-tuple cancel refusal, one concurrent consume, reopen replay refusal, and valid cancellation", async () => {
  const commands = [
    { id: "check-one", executable: process.execPath, argv: ["-e", "process.exit(0)"], cwd: "." },
  ];
  const boundCommands = commands.map((command) => ({
    executable: command.executable,
    argv: command.argv,
    cwd: command.cwd,
  }));
  const budgets = { elapsedSeconds: 20, outputBytes: 4096, maxAttempts: 1 };
  const executionPolicy = { rationale: "One bounded offline check validates the approved implementation." };
  const execution: PlanExecutionConfig = {
    ...executionConfig(),
    verificationCommands: commands,
    verificationExecutionPolicy: { budgets, executionPolicy },
  };
  const orchestrator = agent("agent:test-orchestrator", "Test Orchestrator");

  for (const mode of ["consume", "cancel"] as const) {
    await withTempDb(async (path) => {
      const fixture = await approvedFixture(`loop-102-${mode}`, execution);
      const { factory, store, loops, registry, planId, workItemId, loopId } = fixture;

      // Genuine successful same-iteration IMPLEMENTER, then genuine VERIFYING.
      const implementer = createMockWorker({ id: claimWorkerId(loopId, 1, "IMPLEMENT"), roles: ["IMPLEMENTER"] });
      registry.register(implementer, { roles: ["IMPLEMENTER"] });
      await factory.advance(workItemId, "IMPLEMENTING", orchestrator);
      const implementation = await factory.runWorker({
        workItemId,
        role: "IMPLEMENTER",
        worker: implementer,
        instructions: "implement",
      });
      assert.equal(implementation.run.status, "SUCCEEDED");
      await factory.advance(workItemId, "VERIFYING", orchestrator);

      const actionId = canonicalActionId(loopId, 1, "VERIFY");
      const verifier = createMockWorker({ id: correlationTag(actionId, 1), roles: ["VERIFIER"] });
      registry.register(verifier, { roles: ["VERIFIER"] });

      const loopBefore = await loops.findById(loopId);
      assert.ok(loopBefore !== undefined);
      const iterationBefore = loopBefore.iterations[0];
      assert.ok(iterationBefore !== undefined);
      await loops.compareAndSave(
        {
          ...loopBefore,
          version: loopBefore.version + 1,
          phase: "VERIFYING",
          iterations: [
            {
              ...iterationBefore,
              implementerRunId: implementation.run.id,
              implementerOutcome: "SUCCEEDED",
              verifyClaim: {
                actionId,
                kind: "VERIFY",
                attempt: 1,
                ownerToken: "owner-VERIFY",
                claimedAt: 0,
                correlationTag: correlationTag(actionId, 1),
              },
            },
          ],
        },
        loopBefore.version,
      );

      let db = new DatabaseSync(path);
      try {
        const makeAuthority = (database: DatabaseSync, authorityId: string) =>
          new SqliteDirectHostAuthority({
            planning: fixture.planning,
            store: fixture.store,
            loops: fixture.loops,
            registry: fixture.registry,
            db: database,
            clock: fixture.clock,
            capability: syntheticCapability(fixture.clock),
            deterministicCapability: async (request) => {
              const observedAt = fixture.clock.now() - 1000;
              return {
                executionKind: "deterministic-execution",
                ...request.binding,
                scope: request.ticket.scope,
                commands: request.ticket.commands,
                workspace: request.ticket.workspace,
                budgets: request.ticket.budgets,
                executionPolicy: request.ticket.executionPolicy,
                evidenceReference: "evidence-ref-102",
                evidenceDigest: "evidence-digest-102",
                observedAt: new Date(observedAt).toISOString(),
                expiresAt: new Date(observedAt + 120000).toISOString(),
                confinement: {
                  supportedScopeOwned: request.ticket.scope.owned,
                  supportedScopeForbidden: request.ticket.scope.forbidden,
                  verified: true,
                },
                process: {
                  resolvedWorkspace: WORKSPACE_ROOT,
                  resolvedExecutables: request.ticket.commands.map((command) => command.executable),
                  enforceableElapsedSeconds: 30,
                  enforceableOutputBytes: 65536,
                  enforceableAttempts: 2,
                  verified: true,
                },
              };
            },
            boundWorkers: [
              {
                executionKind: "deterministic-execution",
                worker: verifier,
                slot: "VERIFY",
                commands: boundCommands,
                workspaceRoot: WORKSPACE_ROOT,
                budgets,
                executionPolicy,
              },
            ],
            authorityId,
          });

        const authority = makeAuthority(db, "authority-A");
        const facts = await authority.prepare({
          planId,
          loopId,
          iteration: 1,
          slot: "VERIFY",
          worker: verifier,
        });
        assert.equal(facts.executionKind, "deterministic-execution");
        assert.equal(facts.role, "VERIFIER");
        assert.equal(facts.targetRunId, implementation.run.id);
        assert.equal(facts.runId, undefined);
        assert.equal(facts.state, "PREPARED");
        const preparedRuns = await factory.listRuns(workItemId);
        assert.equal(preparedRuns.filter((run) => run.role === "VERIFIER").length, 0);
        const stateOf = () =>
          (
            db.prepare("SELECT state FROM host_reservations WHERE reservation_id = ?").get(facts.reservationId) as
              | { state: string }
              | undefined
          )?.state;

        // A genuine Factory-owned VERIFIER run, held RUNNING by the existing barrier.
        fixture.barrier.arm({
          workItemId,
          registryPrincipalId: registry.principalFor(verifier).principalId,
          role: "VERIFIER",
          declaredWorkerId: verifier.id,
        });
        const pending = factory.runWorker({
          workItemId,
          role: "VERIFIER",
          worker: verifier,
          instructions: "verify",
          againstRunId: implementation.run.id,
        });
        try {
          await fixture.barrier.waitForClaim();
          const item = await factory.getWorkItem(workItemId);
          const runId = item.runIds.at(-1);
          assert.ok(runId !== undefined);
          const row = await store.runs.findById(runId);
          assert.ok(row !== undefined);
          assert.equal(row.status, "RUNNING");
          assert.equal(row.role, "VERIFIER");
          assert.equal(row.targetRunId, implementation.run.id);

          // The genuine Factory-owned RUNNING row is validated by resolveAndReserve, which
          // atomically attaches it to the supplier row. The loop's verificationRunId slot
          // stays runless until that reservation attaches the observed run.

          const grant = await authority.resolveAndReserve({
            ...reserveRequest(facts, runId),
            ticketReference: facts.reservationId as unknown as import("../src/supervision/directWorkerAdmission.js").TrustedTicketReference,
            executionKind: "deterministic-execution" as const,
            role: "VERIFIER" as const,
            acceptanceCriteria: await store.criteria.listByWorkItem(workItemId),
            dependencyWorkItemIds: item.dependencies,
            scope: ticketTemplate().scope,
            commands: boundCommands,
            workspace: WORKSPACE_ROOT,
            budgets,
            executionPolicy,
          });
          assert.equal(grant.executionKind, "deterministic-execution");
          const binding = grant.binding;
          assert.equal(stateOf(), "RESERVED");

          // Full-tuple modification and a foreign authority cannot cancel the RESERVED row.
          const modified = [
            { ...binding, runId: implementation.run.id },
            { ...binding, registryPrincipalId: `${binding.registryPrincipalId}-other` },
            { ...binding, specRevision: binding.specRevision + 1 },
            { ...binding, reservationVersion: binding.reservationVersion + 1 },
          ];
          for (const tampered of modified) {
            await assert.rejects(authority.cancel(tampered), DirectAdmissionRefusedError);
            assert.equal(stateOf(), "RESERVED");
          }
          const foreign = makeAuthority(db, "authority-B");
          await assert.rejects(foreign.cancel(binding), DirectAdmissionRefusedError);
          assert.equal(stateOf(), "RESERVED");

          if (mode === "cancel") {
            await authority.cancel(binding);
            assert.equal(stateOf(), "CANCELLED");
            await assert.rejects(authority.atomicConsumeLaunch(binding), DirectAdmissionRefusedError);
            assert.equal(stateOf(), "CANCELLED");
          } else {
            const settled = await Promise.allSettled([
              authority.atomicConsumeLaunch(binding),
              authority.atomicConsumeLaunch(binding),
            ]);
            const receipts = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
            assert.equal(receipts.length, 1);
            assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
            const [receipt] = receipts;
            assert.ok(receipt !== undefined);
            assert.deepEqual(receipt.binding, binding);
            assert.equal(receipt.binding.reservationVersion, binding.reservationVersion);
            assert.equal(stateOf(), "CONSUMED");

            // The consumed tombstone survives a real close/reopen and a fresh authority.
            db.close();
            db = new DatabaseSync(path);
            const reopened = makeAuthority(db, "authority-A");
            await assert.rejects(reopened.atomicConsumeLaunch(binding), DirectAdmissionRefusedError);
            await assert.rejects(reopened.cancel(binding), DirectAdmissionRefusedError);
            assert.equal(stateOf(), "CONSUMED");
          }
        } finally {
          fixture.barrier.release();
          await deadline(pending, "verifier finalization");
        }
      } finally {
        db.close();
      }
    });
  }
});

test("PHASE7-98 supplier: an unmapped VERIFY slot is refused at construction and at preparation", async () => {
  const fixture = await approvedFixture();
  const verifier = createMockWorker({ id: "verify-98", roles: ["VERIFIER"] });
  fixture.factory.registerWorker(verifier);
  const db = new DatabaseSync(":memory:");
  try {
    // A host-composed VERIFY binding has no approved model configuration.
    assert.throws(
      () =>
        buildAuthority(fixture, db, [
          {
            worker: verifier,
            slot: "VERIFY" as unknown as BoundWorkerAction["slot"],
            config: { tool: IMPLEMENT_TOOL, model: IMPLEMENT_MODEL, effort: "medium" },
            workspaceRoot: WORKSPACE_ROOT,
          },
        ]),
      (error: unknown) =>
        error instanceof DirectAdmissionRefusedError && /no approved model configuration/.test(error.reason),
    );

    // And a VERIFY preparation against a legitimately composed authority is
    // refused by the only slot->role map there is.
    const implementer = createMockWorker({ id: claimWorkerId(fixture.loopId, 1, "IMPLEMENT"), roles: ["IMPLEMENTER"] });
    fixture.factory.registerWorker(implementer);
    const authority = buildAuthority(fixture, db, [boundImplement(implementer)]);
    await assert.rejects(
      () =>
        authority.prepare({
          planId: fixture.planId,
          loopId: fixture.loopId,
          iteration: 1,
          slot: "VERIFY" as unknown as "IMPLEMENT",
          worker: implementer,
        }),
      (error: unknown) =>
        error instanceof DirectAdmissionRefusedError &&
        error.reason === "this Worker object is host-bound to the IMPLEMENT slot and may not be rebound to VERIFY",
    );
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Current-authority drift: each negative starts from a genuine valid baseline
// and reaches the intended authority failure.
// ---------------------------------------------------------------------------

test("PHASE7-98 supplier: a baseline-valid reservation refuses once the genuine approval stops verifying", async () => {
  const fixture = await approvedFixture();
  const implementer = createMockWorker({
    id: claimWorkerId(fixture.loopId, 1, "IMPLEMENT"),
    roles: ["IMPLEMENTER"],
  });
  fixture.registry.register(implementer, { roles: ["IMPLEMENTER"] });
  const db = new DatabaseSync(":memory:");
  try {
    const authority = buildAuthority(fixture, db, [boundImplement(implementer)]);
    const baseline = await authority.prepare({
      planId: fixture.planId,
      loopId: fixture.loopId,
      iteration: 1,
      slot: "IMPLEMENT",
      worker: implementer,
    });

    const running = await runningImplementerRun(fixture, implementer);
    try {
      // Baseline: this exact binding is genuinely reservable right now, and is
      // left RESERVED on purpose — cancelling it first would retire the row and
      // let a state refusal mask the approval revalidation under test.
      const grant = await authority.resolveAndReserve(reserveRequest(baseline, running.runId));
      assert.equal(grant.binding.runId, running.runId);

      // The approval is now withdrawn by a LATER REAL HUMAN REJECTION, not by
      // cancellation: `planning.cancel` records cancellation intent and does
      // NOT revoke an already-earned HUMAN approval, so it cannot drive the
      // approval revalidation under test.
      //
      // So the SAME genuine approved plan is read back through the real plan
      // repository the Factory and PlanningService already share, and CAS'd to
      // the PLAN_REVIEW phase `reject` requires — keeping its earned approval,
      // its generated revision, its approval digest and its execution
      // configuration exactly as approved, and cancelRequested false. Nothing
      // about the approval itself is fabricated or re-stored.
      const approved = await fixture.plans.findById(fixture.planId);
      assert.ok(approved !== undefined, "the genuine approved plan is readable");
      assert.equal(approved.cancelRequested, false);
      await fixture.plans.compareAndSave(
        { ...approved, version: approved.version + 1, phase: "PLAN_REVIEW" },
        approved.version,
      );

      // A REAL trusted-human rejection through the actual PlanningService: the
      // human decision recorded last is REJECTED, so the plan no longer carries
      // a currently verified approval.
      await fixture.planning.reject(fixture.planId, PLAN_HUMAN, authorizePlanHuman(fixture.factory));

      // The authority's own genuine read agrees: the approval no longer verifies.
      await assert.rejects(
        () => fixture.planning.verifiedApprovedExecutionSnapshot(fixture.planId),
        (error: unknown) => error instanceof Error,
      );

      // Revalidating the still-live grant is refused for the approval reason
      // specifically, not for some unrelated drift or state problem.
      await assert.rejects(
        () => authority.revalidate(grant, reserveRequest(baseline, running.runId)),
        (error: unknown) => error instanceof Error && /no currently verified approval/.test(error.message),
      );
      // And a fresh preparation at the SAME valid current iteration 1 is
      // refused for that same approval reason.
      await assert.rejects(
        () =>
          authority.prepare({
            planId: fixture.planId,
            loopId: fixture.loopId,
            iteration: 1,
            slot: "IMPLEMENT",
            worker: implementer,
          }),
        (error: unknown) => error instanceof Error && /no currently verified approval/.test(error.message),
      );

      // The authority's OWN unconsumed reservation remains cancellable, so the
      // row is never stranded by the approval it can no longer prove.
      await authority.cancel(grant.binding);
    } finally {
      await running.settle();
    }
  } finally {
    db.close();
  }
});

test("PHASE7-98 supplier: a reservation refuses a run the Factory does not own for this binding", async () => {
  const fixture = await approvedFixture();
  const implementer = createMockWorker({
    id: claimWorkerId(fixture.loopId, 1, "IMPLEMENT"),
    roles: ["IMPLEMENTER"],
  });
  fixture.registry.register(implementer, { roles: ["IMPLEMENTER"] });
  const db = new DatabaseSync(":memory:");
  try {
    const authority = buildAuthority(fixture, db, [boundImplement(implementer)]);
    const facts = await authority.prepare({
      planId: fixture.planId,
      loopId: fixture.loopId,
      iteration: 1,
      slot: "IMPLEMENT",
      worker: implementer,
    });
    // No run exists on the item yet: a named id is not a Factory-owned run.
    await assert.rejects(
      () => authority.resolveAndReserve(reserveRequest(facts, "run-not-owned" as RunId)),
      (error: unknown) =>
        error instanceof DirectAdmissionRefusedError && /not recorded on work item/.test(error.reason),
    );
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Durable reserve/consume: at-most-once, real SQLite FILE close + reopen
// ---------------------------------------------------------------------------

test("PHASE7-98 supplier: consume is at-most-once and its tombstone survives a real SQLite close and reopen, while a persisted id alone grants nothing", async () => {
  await withTempDb(async (dbPath) => {
    const fixture = await approvedFixture();
    const implementer = createMockWorker({
      id: claimWorkerId(fixture.loopId, 1, "IMPLEMENT"),
      roles: ["IMPLEMENTER"],
    });
    fixture.registry.register(implementer, { roles: ["IMPLEMENTER"] });

    let db = new DatabaseSync(dbPath);
    let reservationId: string;
    let consumedBinding: DirectLaunchBinding;
    try {
      const authority = buildAuthority(fixture, db, [boundImplement(implementer)]);
      const facts = await authority.prepare({
        planId: fixture.planId,
        loopId: fixture.loopId,
        iteration: 1,
        slot: "IMPLEMENT",
        worker: implementer,
      });
      reservationId = facts.reservationId;

      const running = await runningImplementerRun(fixture, implementer);
      try {
        const grant = await authority.resolveAndReserve(reserveRequest(facts, running.runId));
        const receipt = await authority.atomicConsumeLaunch(grant.binding);
        consumedBinding = grant.binding;
        assert.equal(receipt.binding.reservationId, reservationId);
        assert.equal(receipt.binding.runId, running.runId);

        // At-most-once within the same instance.
        await assert.rejects(() => authority.atomicConsumeLaunch(grant.binding));
        // A consumed row is no longer an eligible prepared record.
        assert.equal(authority.lookup(reservationId), undefined);
        assert.equal(authority.resolveApprovedPrestart(reservationId), undefined);
      } finally {
        await running.settle();
      }
    } finally {
      db.close();
    }

    // REOPEN the same durable file with a FRESH authority instance and a
    // FRESH Worker-object composition under the same authority identity.
    db = new DatabaseSync(dbPath);
    try {
      const reopenedWorker = createMockWorker({
        id: claimWorkerId(fixture.loopId, 1, "IMPLEMENT"),
        roles: ["IMPLEMENTER"],
      });
      fixture.registry.register(reopenedWorker, { roles: ["IMPLEMENTER"] });
      const reopened = buildAuthority(fixture, db, [boundImplement(reopenedWorker)]);

      // The consumed tombstone survived: the row is not grantable, and the
      // persisted id alone rebinds no Worker-object authority.
      assert.equal(reopened.lookup(reservationId), undefined);
      await assert.rejects(() => reopened.atomicConsumeLaunch(consumedBinding));
      await assert.rejects(
        () => reopened.cancel(consumedBinding),
        (error: unknown) => error instanceof DirectAdmissionRefusedError && /CONSUMED/.test(error.reason),
      );
      // Re-preparing the SAME coordinates is refused: a persisted row is a
      // record, never reusable authority.
      await assert.rejects(
        () =>
          reopened.prepare({
            planId: fixture.planId,
            loopId: fixture.loopId,
            iteration: 1,
            slot: "IMPLEMENT",
            worker: reopenedWorker,
          }),
        (error: unknown) => error instanceof DirectAdmissionRefusedError && /already prepared/.test(error.reason),
      );
    } finally {
      db.close();
    }
  });
});

test("PHASE7-98 supplier: concurrent reserve attempts on one prepared row yield exactly one grant", async () => {
  const fixture = await approvedFixture();
  const implementer = createMockWorker({
    id: claimWorkerId(fixture.loopId, 1, "IMPLEMENT"),
    roles: ["IMPLEMENTER"],
  });
  fixture.registry.register(implementer, { roles: ["IMPLEMENTER"] });
  const db = new DatabaseSync(":memory:");
  try {
    const authority = buildAuthority(fixture, db, [boundImplement(implementer)]);
    const facts = await authority.prepare({
      planId: fixture.planId,
      loopId: fixture.loopId,
      iteration: 1,
      slot: "IMPLEMENT",
      worker: implementer,
    });

    const running = await runningImplementerRun(fixture, implementer);
    try {
      const request = reserveRequest(facts, running.runId);
      const results = await Promise.allSettled([
        authority.resolveAndReserve(request),
        authority.resolveAndReserve(request),
      ]);
      assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
      assert.equal(results.filter((entry) => entry.status === "rejected").length, 1);

      // The SOLE fulfilled grant is now consumed twice in parallel: the CAS
      // admits exactly one launch, and the losing attempt is refused rather
      // than quietly producing a second receipt for the same binding.
      const granted = results.find((entry) => entry.status === "fulfilled");
      assert.ok(granted !== undefined && granted.status === "fulfilled");
      const binding = granted.value.binding;
      const consumes = await Promise.allSettled([
        authority.atomicConsumeLaunch(binding),
        authority.atomicConsumeLaunch(binding),
      ]);
      const receipts = consumes.filter((entry) => entry.status === "fulfilled");
      assert.equal(receipts.length, 1);
      assert.equal(consumes.filter((entry) => entry.status === "rejected").length, 1);

      // The one receipt is for exactly the granted binding tuple AND the
      // version that call consumed, never a re-read row.
      const receipt = receipts[0];
      assert.ok(receipt !== undefined && receipt.status === "fulfilled");
      assert.deepEqual(receipt.value.binding, binding);
      assert.equal(receipt.value.binding.reservationVersion, binding.reservationVersion);

      // The consumed tombstone is in place: no eligible record remains, and
      // the row is neither re-consumable nor cancellable.
      assert.equal(authority.lookup(facts.reservationId), undefined);
      assert.equal(authority.resolveApprovedPrestart(facts.reservationId), undefined);
      await assert.rejects(
        () => authority.atomicConsumeLaunch(binding),
        (error: unknown) => error instanceof DirectAdmissionRefusedError && /CONSUMED/.test(error.reason),
      );
    } finally {
      await running.settle();
    }
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Distinct canonical owned-scope overlap across DIFFERENT reservations
// ---------------------------------------------------------------------------

test("PHASE7-98 supplier: a different reservation of a different authority is refused for overlapping canonical owned scope", async () => {
  await withTempDb(async (dbPath) => {
    const fixture = await approvedFixture();
    const db = new DatabaseSync(dbPath);
    try {
      const implementer = createMockWorker({
        id: claimWorkerId(fixture.loopId, 1, "IMPLEMENT"),
        roles: ["IMPLEMENTER"],
      });
      fixture.registry.register(implementer, { roles: ["IMPLEMENTER"] });
      const first = buildAuthority(fixture, db, [boundImplement(implementer)], {
        authorityId: "authority-A",
      });
      const facts = await first.prepare({
        planId: fixture.planId,
        loopId: fixture.loopId,
        iteration: 1,
        slot: "IMPLEMENT",
        worker: implementer,
      });
      assert.equal(facts.state, "PREPARED");

      // A genuinely DIFFERENT reservation. The loop repository forbids two
      // active loops on the same work item, so the second loop cannot live in
      // the first fixture's repository: it comes from its OWN second genuine
      // approvedFixture, with its own real Factory, PlanningService, store,
      // registry and loop repository, at distinct loop coordinates.
      //
      // Only the SQLite reservation database is shared — which is exactly the
      // scope-overlap surface under test: both approved tickets canonicalize
      // their owned scope under the same workspace root and owned path.
      const otherFixture = await approvedFixture("loop-98-b");
      const other = createMockWorker({
        id: claimWorkerId(otherFixture.loopId, 1, "IMPLEMENT"),
        roles: ["IMPLEMENTER"],
      });
      otherFixture.registry.register(other, { roles: ["IMPLEMENTER"] });
      const second = buildAuthority(otherFixture, db, [boundImplement(other)], {
        authorityId: "authority-B",
      });

      await assert.rejects(
        () =>
          second.prepare({
            planId: otherFixture.planId,
            loopId: otherFixture.loopId,
            iteration: 1,
            slot: "IMPLEMENT",
            worker: other,
          }),
        (error: unknown) =>
          error instanceof DirectAdmissionRefusedError && /overlaps an existing active reservation/.test(error.reason),
      );

      // The original reservation is untouched by the refused conflict.
      assert.equal(first.lookup(facts.reservationId)?.state, "PREPARED");
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Cancellation is FULL-tuple and own-authority only: neither a modified
// binding nor a foreign authority over the SAME database may retire a row.
// ---------------------------------------------------------------------------

test("PHASE7-98 supplier: only the owning authority's exact full binding tuple may cancel a live reservation", async () => {
  await withTempDb(async (dbPath) => {
    const fixture = await approvedFixture();
    const implementer = createMockWorker({
      id: claimWorkerId(fixture.loopId, 1, "IMPLEMENT"),
      roles: ["IMPLEMENTER"],
    });
    fixture.registry.register(implementer, { roles: ["IMPLEMENTER"] });
    const db = new DatabaseSync(dbPath);
    try {
      const authority = buildAuthority(fixture, db, [boundImplement(implementer)], {
        authorityId: "authority-A",
      });
      const facts = await authority.prepare({
        planId: fixture.planId,
        loopId: fixture.loopId,
        iteration: 1,
        slot: "IMPLEMENT",
        worker: implementer,
      });

      const running = await runningImplementerRun(fixture, implementer);
      try {
        // Baseline: a genuinely valid own grant over the real Factory-owned
        // RUNNING run, left RESERVED so every refusal below is the intended
        // ownership/tuple one and not a state refusal.
        const grant = await authority.resolveAndReserve(reserveRequest(facts, running.runId));
        assert.equal(grant.binding.runId, running.runId);

        // A MODIFIED tuple cannot cancel: each field is part of the identity
        // the cancel path proves, not decoration around the reservation id.
        for (const [label, binding] of [
          ["run", { ...grant.binding, runId: "run-elsewhere" as RunId }],
          ["principal", { ...grant.binding, registryPrincipalId: "principal-elsewhere" }],
          ["spec", { ...grant.binding, specRevision: grant.binding.specRevision + 1 }],
          ["version", { ...grant.binding, reservationVersion: grant.binding.reservationVersion + 1 }],
        ] as const) {
          await assert.rejects(
            () => authority.cancel(binding),
            (error: unknown) =>
              error instanceof DirectAdmissionRefusedError &&
              /foreign or retargeted reservation/.test(error.reason),
            `a modified ${label} must not cancel`,
          );
        }

        // A FOREIGN authority over the very SAME database cannot cancel it
        // either: the row is scoped to its owning authority identity.
        const foreign = buildAuthority(fixture, db, [boundImplement(implementer)], {
          authorityId: "authority-B",
        });
        await assert.rejects(
          () => foreign.cancel(grant.binding),
          (error: unknown) =>
            error instanceof DirectAdmissionRefusedError && /unknown to this host authority/.test(error.reason),
        );

        // After all of those refusals the own grant is still live, current and
        // usable — nothing above degraded it.
        // `lookup` deliberately exposes only ELIGIBLE (prepared) records, so a
        // live RESERVED row is absent there and must be proven where it
        // actually lives: the persisted reservation row itself.
        const liveRow = db
          .prepare("SELECT state FROM host_reservations WHERE reservation_id = ? AND authority_id = ?")
          .get(facts.reservationId, "authority-A") as { state?: unknown } | undefined;
        assert.equal(typeof liveRow?.state === "string" ? liveRow.state : undefined, "RESERVED");
        assert.equal(authority.lookup(facts.reservationId), undefined);
        assert.equal(await authority.checkReadiness(grant.binding), true);
        await authority.revalidate(grant, reserveRequest(facts, running.runId));

        // And the owner's own exact tuple does retire it, once.
        await authority.cancel(grant.binding);
        assert.equal(authority.lookup(facts.reservationId), undefined);
        await assert.rejects(
          () => authority.atomicConsumeLaunch(grant.binding),
          (error: unknown) => error instanceof DirectAdmissionRefusedError && /CANCELLED/.test(error.reason),
        );
      } finally {
        await running.settle();
      }
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Unknown/malformed capability evidence: refused, and an acquired-but-
// unconsumed OWN row is released rather than stranded.
//
// The capability callback here is SYNTHETIC throughout — an offline
// adapter-wiring proof. It asserts no real provider quota, eligibility or
// grant, and the switched-in variants assert nothing at all.
// ---------------------------------------------------------------------------

test("PHASE7-98 supplier: unknown or malformed capability evidence is refused and releases this authority's own unconsumed row", async () => {
  for (const [label, broken] of [
    ["unknown", async () => undefined],
    ["malformed", async () => ({ evidenceReference: "synthetic://phase7-98/evidence" })],
    ["throwing", async () => {
      throw new Error("capability probe unavailable");
    }],
  ] as const) {
    const fixture = await approvedFixture();
    const implementer = createMockWorker({
      id: claimWorkerId(fixture.loopId, 1, "IMPLEMENT"),
      roles: ["IMPLEMENTER"],
    });
    fixture.registry.register(implementer, { roles: ["IMPLEMENTER"] });
    const db = new DatabaseSync(":memory:");
    try {
      // The callback starts SYNTHETIC-valid so the baseline below is genuine,
      // then switches to the broken variant before reserve/consume.
      let capability = syntheticCapability(fixture.clock);
      const authority = buildAuthority(fixture, db, [boundImplement(implementer)], {
        capability: (request) => capability(request),
      });
      const facts = await authority.prepare({
        planId: fixture.planId,
        loopId: fixture.loopId,
        iteration: 1,
        slot: "IMPLEMENT",
        worker: implementer,
      });

      const running = await runningImplementerRun(fixture, implementer);
      try {
        // Synthetic-valid baseline on the CURRENT iteration-1 facts: this
        // binding reserves and reports ready, so the refusal below is
        // attributable to the capability evidence alone.
        const baselineGrant = await authority.resolveAndReserve(reserveRequest(facts, running.runId));
        assert.equal(await authority.checkReadiness(baselineGrant.binding), true);
        // Cancelled, NOT consumed: a consumed row's owned scope would still be
        // retired, but cancelling leaves no active scope overlap.
        await authority.cancel(baselineGrant.binding);

        // A SECOND trusted authority identity, prepared from the SAME current
        // approved item/iteration/Worker/config and the SAME genuine RUNNING
        // run, so the only thing that differs at reserve time is the
        // capability evidence — never the loop iteration, principal or run.
        //
        // It gets its OWN fresh reservation database: the cancelled baseline
        // row above is a durable tombstone that still globally owns
        // UNIQUE(loop, iteration, slot), so re-preparing those same current
        // coordinates in the SAME database is refused as already-prepared
        // BEFORE any capability probe is ever reached. The tombstone's
        // semantics are kept intact — no row is deleted and no schema changed.
        const secondDb = new DatabaseSync(":memory:");
        try {
          const secondAuthority = buildAuthority(fixture, secondDb, [boundImplement(implementer)], {
            capability: (request) => capability(request),
            authorityId: "authority-B",
          });
          const secondFacts = await secondAuthority.prepare({
            planId: fixture.planId,
            loopId: fixture.loopId,
            iteration: 1,
            slot: "IMPLEMENT",
            worker: implementer,
          });

          // Switched to broken ONLY here: everything above ran synthetic-valid.
          capability = broken as typeof capability;

          // Reserve genuinely ACQUIRES the row, then fails capability validation.
          await assert.rejects(
            () => secondAuthority.resolveAndReserve(reserveRequest(secondFacts, running.runId)),
            (error: unknown) => error instanceof Error,
            `${label} capability evidence must be refused`,
          );

          // The acquired-but-unconsumed OWN row was RELEASED by cancelling it:
          // `releaseOwnReservation` intentionally CANCELS rather than restoring
          // PREPARED, so the durable proof is the persisted CANCELLED row plus
          // the absence of any eligible record.
          const releasedRow = secondDb
            .prepare("SELECT state, run_id FROM host_reservations WHERE reservation_id = ? AND authority_id = ?")
            .get(secondFacts.reservationId, "authority-B") as { state?: unknown; run_id?: unknown } | undefined;
          assert.equal(
            typeof releasedRow?.state === "string" ? releasedRow.state : undefined,
            "CANCELLED",
            `${label}: the acquired own row must be released, not stranded RESERVED`,
          );
          assert.equal(
            secondAuthority.lookup(secondFacts.reservationId),
            undefined,
            `${label}: no eligible record remains`,
          );

          // And the release is final: restoring valid synthetic evidence does
          // NOT re-grant a retired row.
          capability = syntheticCapability(fixture.clock);
          await assert.rejects(
            () => secondAuthority.resolveAndReserve(reserveRequest(secondFacts, running.runId)),
            (error: unknown) => error instanceof DirectAdmissionRefusedError && /CANCELLED/.test(error.reason),
            `${label}: a released row must not be re-granted`,
          );
        } finally {
          secondDb.close();
        }
      } finally {
        await running.settle();
      }
    } finally {
      db.close();
    }
  }
});
