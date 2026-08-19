/**
 * The TASK-002 persistent demonstration.
 *
 * Unlike `sf demo` (fully in-memory, resets every run), this drives a real
 * SQLite-backed FactoryService and proves durability two ways in one CLI:
 *
 *   1. In-process: seeds a work item through to DONE, explicitly closes the
 *      store, opens a brand new store + FactoryService against the same
 *      file, and reads the result back through the reopened instance.
 *   2. Across OS processes: run `npm run demo:persistent` a second time.
 *      The database already has data, so this run skips seeding and simply
 *      reads back what a *previous, now-exited* process wrote — the
 *      strongest available proof of restart durability from a CLI.
 *
 * The database path defaults to `.factory-data/factory.db` under the
 * current working directory (gitignored — see README "Where data lives").
 * Override with `FACTORY_DB_PATH` or a CLI argument.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createSqliteStore } from "../adapters/sqlite/sqliteStore.js";
import { createLocalHumanIdentityGate } from "../adapters/security/localHumanIdentityGate.js";
import { createLocalWorkerRegistry } from "../adapters/security/localWorkerRegistry.js";
import { createMockWorker } from "../adapters/workers/mockWorker.js";
import { FactoryService } from "../app/factoryService.js";
import { agent, human } from "../domain/actor.js";
import { createSequentialIdGenerator } from "../domain/ids.js";
import { systemClock } from "../ports/clock.js";

const DEFAULT_DB_PATH = ".factory-data/factory.db";
/** Fixture-only credential, same posture as sf demo's: never a real secret (C6). */
const DEMO_HUMAN_CREDENTIAL = "demo-local-operator-secret";

export interface PersistentDemoOptions {
  readonly dbPath?: string;
  readonly log?: (line: string) => void;
}

export interface PersistentDemoResult {
  readonly dbPath: string;
  readonly seeded: boolean;
  readonly workItemId: string;
  readonly finalStatus: string;
  readonly runCount: number;
  readonly evidenceCount: number;
  readonly transcript: readonly string[];
}

function makeFactory(dbPath: string) {
  const store = createSqliteStore(dbPath);
  const factory = new FactoryService({
    store,
    clock: systemClock,
    ids: createSequentialIdGenerator(),
    identityGate: createLocalHumanIdentityGate({ credential: DEMO_HUMAN_CREDENTIAL, clock: systemClock }),
    workerRegistry: createLocalWorkerRegistry(systemClock),
  });
  return { store, factory };
}

async function seedWorkflow(
  factory: FactoryService,
  emit: (line: string) => void,
): Promise<{ workItemId: string }> {
  const hakan = human("user:hakan", "Hakan");
  const orchestrator = agent("agent:orchestrator", "Factory Orchestrator");
  const authorize = () => factory.authorizeHuman(hakan, DEMO_HUMAN_CREDENTIAL);

  const project = await factory.createProject({ key: "SF", name: "Software Factory" });
  const item = await factory.createWorkItem({
    projectId: project.id,
    title: "Persistent demo: durable release",
    type: "FEATURE",
    planVersion: "persistence-v1",
    acceptanceCriteria: [{ text: "State survives a restart", verificationHint: "npm run demo:persistent (run twice)" }],
  });
  emit(`seeded work item ${item.id} in project ${project.id}`);

  await factory.advance(item.id, "ANALYSIS", orchestrator);
  await factory.advance(item.id, "PLAN_REVIEW", orchestrator);
  await factory.recordApproval({
    gate: "PLAN_APPROVAL",
    subject: factory.workItemSubject(item.id),
    decision: "APPROVED",
    actor: hakan,
    authorization: authorize(),
  });
  await factory.advance(item.id, "READY", orchestrator);
  await factory.advance(item.id, "IMPLEMENTING", orchestrator);

  const implementer = createMockWorker({ id: "mock-implementer", roles: ["IMPLEMENTER"] });
  const verifier = createMockWorker({ id: "mock-verifier", roles: ["VERIFIER"] });
  const reviewer = createMockWorker({ id: "mock-reviewer", roles: ["REVIEWER"] });
  factory.registerWorker(implementer);
  factory.registerWorker(verifier);
  factory.registerWorker(reviewer);

  const implementation = await factory.runWorker({
    workItemId: item.id,
    role: "IMPLEMENTER",
    worker: implementer,
    instructions: "implement",
  });
  emit(`run ${implementation.run.id} SUCCEEDED`);
  await factory.advance(item.id, "VERIFYING", orchestrator);

  const verification = await factory.runWorker({
    workItemId: item.id,
    role: "VERIFIER",
    worker: verifier,
    instructions: "verify",
    againstRunId: implementation.run.id,
  });
  await factory.recordReview({
    workItemId: item.id,
    reviewedRunId: implementation.run.id,
    reviewerRunId: verification.run.id,
    kind: "DETERMINISTIC",
    verdict: "PASS",
  });
  await factory.advance(item.id, "REVIEW", orchestrator);

  const reviewRun = await factory.runWorker({
    workItemId: item.id,
    role: "REVIEWER",
    worker: reviewer,
    instructions: "review",
    againstRunId: implementation.run.id,
  });
  await factory.recordReview({
    workItemId: item.id,
    reviewedRunId: implementation.run.id,
    reviewerRunId: reviewRun.run.id,
    kind: "SEMANTIC",
    verdict: "PASS",
  });
  await factory.advance(item.id, "WAITING_FOR_HUMAN", orchestrator);
  await factory.verifyAcceptanceCriteria({ workItemId: item.id, verifierRunId: verification.run.id });

  await factory.recordApproval({
    gate: "RELEASE_APPROVAL",
    subject: factory.workItemSubject(item.id),
    decision: "APPROVED",
    actor: hakan,
    authorization: authorize(),
  });
  const done = await factory.advance(item.id, "DONE", orchestrator);
  emit(`work item ${item.id} reached ${done.status} (version ${done.version})`);

  return { workItemId: item.id };
}

export async function runPersistentDemo(options: PersistentDemoOptions = {}): Promise<PersistentDemoResult> {
  const transcript: string[] = [];
  const emit = (line: string): void => {
    transcript.push(line);
    options.log?.(line);
  };

  const dbPath = resolve(options.dbPath ?? process.env.FACTORY_DB_PATH ?? DEFAULT_DB_PATH);
  mkdirSync(dirname(dbPath), { recursive: true });
  emit(`== Software Factory persistent demo ==`);
  emit(`database: ${dbPath}`);

  const first = makeFactory(dbPath);
  const existingProjects = await first.store.projects.list();
  const seeded = existingProjects.length === 0;

  let workItemId: string;
  if (seeded) {
    emit("");
    emit("-- no existing data found: seeding a full lifecycle --");
    const result = await seedWorkflow(first.factory, emit);
    workItemId = result.workItemId;

    emit("");
    emit("-- proving in-process restart: closing this store and opening a new one --");
    first.store.close();

    const reopened = makeFactory(dbPath);
    const reread = await reopened.factory.getWorkItem(workItemId);
    emit(`reopened store sees work item ${reread.id} status=${reread.status} version=${reread.version}`);
    const runs = await reopened.factory.listRuns(workItemId);
    const evidence = await reopened.factory.listEvidence(workItemId);
    emit(`runs=${runs.length} evidence=${evidence.length}`);
    reopened.store.close();

    emit("");
    emit("Run `npm run demo:persistent` again (a new OS process) to see this");
    emit("same state read back without any re-seeding.");

    return {
      dbPath,
      seeded: true,
      workItemId,
      finalStatus: reread.status,
      runCount: runs.length,
      evidenceCount: evidence.length,
      transcript,
    };
  }

  emit("");
  emit("-- existing data found: reading back state from a previous process, no re-seeding --");
  const projects = existingProjects;
  const items = await first.store.workItems.listByProject(projects[0]!.id);
  const item = items[0]!;
  workItemId = item.id;
  const runs = await first.factory.listRuns(workItemId);
  const evidence = await first.factory.listEvidence(workItemId);
  emit(`work item ${item.id} status=${item.status} version=${item.version} history=${item.history.length} entries`);
  emit(`runs=${runs.length} evidence=${evidence.length}`);
  first.store.close();

  return {
    dbPath,
    seeded: false,
    workItemId,
    finalStatus: item.status,
    runCount: runs.length,
    evidenceCount: evidence.length,
    transcript,
  };
}
