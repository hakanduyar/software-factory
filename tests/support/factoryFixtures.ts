/**
 * Shared test fixtures. Deterministic clock and ids so assertions are exact.
 */

import { FactoryService } from "../../src/app/factoryService.js";
import { createInMemoryStore } from "../../src/adapters/memory/inMemoryStore.js";
import { createLocalHumanIdentityGate } from "../../src/adapters/security/localHumanIdentityGate.js";
import { createLocalWorkerRegistry } from "../../src/adapters/security/localWorkerRegistry.js";
import { createMockWorker } from "../../src/adapters/workers/mockWorker.js";
import { agent, human, system } from "../../src/domain/actor.js";
import { createSequentialIdGenerator } from "../../src/domain/ids.js";
import type { FactoryRole } from "../../src/domain/role.js";
import type { WorkItemStatus } from "../../src/domain/status.js";
import type { WorkItem } from "../../src/domain/workItem.js";
import { createFixedClock, type Clock } from "../../src/ports/clock.js";
import type { FactoryStore } from "../../src/ports/repositories.js";
import type { Worker } from "../../src/ports/worker.js";

export const HUMAN = human("user:test", "Test Human");
export const OTHER_HUMAN = human("user:other", "Other Human");
export const AGENT = agent("agent:test", "Test Agent");
export const SYSTEM = system("system:test", "Test System");

/** Fixture-only secret: never used outside this in-memory test gate. */
export const TEST_CREDENTIAL = "test-fixture-secret-1234";
export const WRONG_CREDENTIAL = "wrong-fixture-secret-999";

export const FIXTURE_START = "2026-01-01T00:00:00.000Z";
export const FIXTURE_START_MS = new Date(FIXTURE_START).getTime();

export interface TestFactory {
  readonly factory: FactoryService;
  readonly clock: Clock;
  readonly store: FactoryStore;
}

export function newFactory(): TestFactory {
  const clock = createFixedClock(FIXTURE_START);
  const store = createInMemoryStore();
  const factory = new FactoryService({
    store,
    clock,
    ids: createSequentialIdGenerator(),
    identityGate: createLocalHumanIdentityGate({ credential: TEST_CREDENTIAL, clock }),
    workerRegistry: createLocalWorkerRegistry(clock),
  });
  return { factory, clock, store };
}

/** A bare WorkItem in an arbitrary status, for pure workflow-table tests. */
export function workItemAt(status: WorkItemStatus, id = "wi-test", overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    projectId: "prj-test",
    title: "Fixture work item",
    type: "FEATURE",
    status,
    specRevision: 1,
    version: 1,
    priority: "P2",
    planVersion: "test-v1",
    dependencies: [],
    acceptanceCriteriaIds: [],
    runIds: [],
    history: [],
    createdAt: FIXTURE_START_MS,
    updatedAt: FIXTURE_START_MS,
    ...overrides,
  };
}

/** Creates a project + work item with two acceptance criteria. */
export async function seedWorkItem(factory: FactoryService): Promise<WorkItem> {
  const project = await factory.createProject({ key: "TST", name: "Test Project" });
  return factory.createWorkItem({
    projectId: project.id,
    title: "Fixture work item",
    type: "FEATURE",
    planVersion: "test-v1",
    acceptanceCriteria: [
      { text: "Behaviour A holds", verificationHint: "npm test" },
      { text: "Behaviour B holds", verificationHint: "npm run typecheck" },
    ],
  });
}

/** Grants a valid human authorization for `actor` using the fixture credential. */
export function authorize(factory: FactoryService, actor = HUMAN) {
  return factory.authorizeHuman(actor, TEST_CREDENTIAL);
}

/** Registers a fresh mock worker and returns it. */
export function registeredWorker(
  factory: FactoryService,
  id: string,
  roles: readonly FactoryRole[],
  extra: Parameters<typeof createMockWorker>[0] = {},
): Worker {
  const worker = createMockWorker({ id, roles, ...extra });
  factory.registerWorker(worker);
  return worker;
}

/** Drives a seeded work item to IMPLEMENTING through the real gates. */
export async function toImplementing(factory: FactoryService, itemId: string): Promise<void> {
  await factory.advance(itemId, "ANALYSIS", AGENT);
  await factory.advance(itemId, "PLAN_REVIEW", AGENT);
  await factory.recordApproval({
    gate: "PLAN_APPROVAL",
    subject: factory.workItemSubject(itemId),
    decision: "APPROVED",
    actor: HUMAN,
    authorization: authorize(factory),
  });
  await factory.advance(itemId, "READY", AGENT);
  await factory.advance(itemId, "IMPLEMENTING", AGENT);
}

export interface ReleaseFixture {
  readonly implementationRunId: string;
  readonly verifierRunId: string;
  readonly reviewerRunId: string;
}

/**
 * Drives a seeded work item all the way to WAITING_FOR_HUMAN with a complete,
 * verified, independently reviewed release candidate.
 */
export async function toWaitingForHuman(
  factory: FactoryService,
  itemId: string,
  ids: { implementer?: string; verifier?: string; reviewer?: string } = {},
): Promise<ReleaseFixture> {
  await toImplementing(factory, itemId);

  const implementer = registeredWorker(factory, ids.implementer ?? "worker-impl", ["IMPLEMENTER"]);
  const verifier = registeredWorker(factory, ids.verifier ?? "worker-verify", ["VERIFIER"]);
  const reviewer = registeredWorker(factory, ids.reviewer ?? "worker-review", ["REVIEWER"]);

  const implementation = await factory.runWorker({
    workItemId: itemId,
    role: "IMPLEMENTER",
    worker: implementer,
    instructions: "implement",
  });
  await factory.advance(itemId, "VERIFYING", AGENT);

  const verification = await factory.runWorker({
    workItemId: itemId,
    role: "VERIFIER",
    worker: verifier,
    instructions: "verify",
    againstRunId: implementation.run.id,
  });
  await factory.recordReview({
    workItemId: itemId,
    reviewedRunId: implementation.run.id,
    reviewerRunId: verification.run.id,
    kind: "DETERMINISTIC",
    verdict: "PASS",
  });
  await factory.advance(itemId, "REVIEW", AGENT);

  const review = await factory.runWorker({
    workItemId: itemId,
    role: "REVIEWER",
    worker: reviewer,
    instructions: "review",
    againstRunId: implementation.run.id,
  });
  await factory.recordReview({
    workItemId: itemId,
    reviewedRunId: implementation.run.id,
    reviewerRunId: review.run.id,
    kind: "SEMANTIC",
    verdict: "PASS",
  });
  await factory.advance(itemId, "WAITING_FOR_HUMAN", AGENT);
  await factory.verifyAcceptanceCriteria({ workItemId: itemId, verifierRunId: verification.run.id });

  return {
    implementationRunId: implementation.run.id,
    verifierRunId: verification.run.id,
    reviewerRunId: review.run.id,
  };
}
