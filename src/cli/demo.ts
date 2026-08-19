/**
 * The TASK-001 demonstration flow.
 *
 * Walks one fake work item from IDEA to DONE using deterministic mock
 * workers, and along the way deliberately attempts every bypass the three
 * review rounds found, so the CLI output is itself a regression check:
 *
 *   1.  BLOCKED -> READY, bypassing PLAN_REVIEW/PLAN_APPROVAL
 *   2.  PLAN_APPROVAL pre-recorded while the item is still IDEA
 *   3.  PLAN_REVIEW -> READY with no plan approval
 *   4.  cancellation by a caller-made { kind: "HUMAN" } with no token
 *   5.  IMPLEMENTING -> VERIFYING with no recorded implementation run
 *   6.  IMPLEMENTING -> DONE (skipping verification, review and the gate)
 *   7.  VERIFYING -> REVIEW with no passing deterministic verification
 *   8.  a semantic review by the same worker principal under a new name
 *   9.  RELEASE_APPROVAL pre-recorded before a release snapshot exists
 *   10. WAITING_FOR_HUMAN -> DONE before criteria are verified, then again
 *       with a complete snapshot but no release approval
 *   11. an AGENT recording its own release approval
 *   12. a forged HUMAN token recording a release approval
 *   13. rewriting a terminal FAILED run as SUCCEEDED
 *   14. DONE using artifacts from a superseded implementation
 *
 * Written as a library function returning a structured result so the test
 * suite runs the same flow the CLI prints.
 */

import { agent, human } from "../domain/actor.js";
import { FactoryError } from "../domain/errors.js";
import { createSequentialIdGenerator } from "../domain/ids.js";
import type { TrustedHumanToken } from "../domain/humanIdentity.js";
import type { WorkItemStatus } from "../domain/status.js";
import { FactoryService } from "../app/factoryService.js";
import { createInMemoryStore } from "../adapters/memory/inMemoryStore.js";
import { createMockWorker } from "../adapters/workers/mockWorker.js";
import { createLocalHumanIdentityGate } from "../adapters/security/localHumanIdentityGate.js";
import { createLocalWorkerRegistry } from "../adapters/security/localWorkerRegistry.js";
import { createFixedClock } from "../ports/clock.js";

/**
 * Fixture credential for this self-contained demo only — the "human" in this
 * script is defined to be whoever can read this constant, which for a demo
 * is fine. A real deployment must supply a real secret via environment/
 * secret store, never a literal in source (C6).
 */
const DEMO_HUMAN_CREDENTIAL = "demo-local-operator-secret";

export interface RefusalRecord {
  readonly attempt: string;
  readonly code: string;
  readonly message: string;
}

export interface DemoResult {
  readonly finalStatus: WorkItemStatus;
  readonly statusPath: readonly WorkItemStatus[];
  readonly refusals: readonly RefusalRecord[];
  readonly evidenceCount: number;
  readonly runCount: number;
  readonly transcript: readonly string[];
}

export interface DemoOptions {
  /** Called for every transcript line; defaults to collecting silently. */
  readonly log?: (line: string) => void;
}

export async function runDemo(options: DemoOptions = {}): Promise<DemoResult> {
  const transcript: string[] = [];
  const emit = (line: string): void => {
    transcript.push(line);
    options.log?.(line);
  };

  const refusals: RefusalRecord[] = [];
  /** Runs an action that MUST be refused; records the typed error. */
  const expectRefusal = async (attempt: string, action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
      emit(`  !! NOT REFUSED: ${attempt} — this is a defect`);
      throw new Error(`Expected refusal for: ${attempt}`);
    } catch (error) {
      if (!(error instanceof FactoryError)) {
        throw error;
      }
      refusals.push({ attempt, code: error.code, message: error.message });
      emit(`  refused [${error.code}] ${attempt}`);
      emit(`      ${error.message}`);
    }
  };

  const clock = createFixedClock("2026-01-01T09:00:00.000Z");
  const store = createInMemoryStore();
  const factory = new FactoryService({
    store,
    clock,
    ids: createSequentialIdGenerator(),
    identityGate: createLocalHumanIdentityGate({ credential: DEMO_HUMAN_CREDENTIAL, clock }),
    workerRegistry: createLocalWorkerRegistry(clock),
  });

  const hakan = human("user:hakan", "Hakan");
  const planner = agent("agent:planner", "Planner Agent");
  const orchestrator = agent("agent:orchestrator", "Factory Orchestrator");
  const authorize = (): TrustedHumanToken => factory.authorizeHuman(hakan, DEMO_HUMAN_CREDENTIAL);

  // One worker object that will later try to pass itself off as someone else.
  const implementer = createMockWorker({ id: "mock-implementer", roles: ["IMPLEMENTER", "REVIEWER"] });
  const verifier = createMockWorker({ id: "mock-verifier", roles: ["VERIFIER"] });
  const reviewer = createMockWorker({ id: "mock-reviewer", roles: ["REVIEWER"] });
  const secondImplementer = createMockWorker({ id: "mock-implementer-2", roles: ["IMPLEMENTER"] });

  for (const worker of [implementer, verifier, reviewer, secondImplementer]) {
    factory.registerWorker(worker);
  }

  emit("== Software Factory demo ==");
  emit("No network, no AI provider, no GitHub. In-memory store, deterministic mock workers.");
  emit("");

  const project = await factory.createProject({ key: "SF", name: "Software Factory" });
  emit(`project ${project.id} ${project.key} — ${project.name}`);

  const item = await factory.createWorkItem({
    projectId: project.id,
    title: "Demo: weekly AI review feature",
    type: "FEATURE",
    priority: "P1",
    planVersion: "bootstrap-v1",
    assignedRole: "IMPLEMENTER",
    acceptanceCriteria: [
      { text: "Feature is covered by unit tests", verificationHint: "npm test" },
      { text: "Typecheck passes", verificationHint: "npm run typecheck" },
    ],
  });
  emit(`work item ${item.id} "${item.title}" status=${item.status} specRevision=${item.specRevision}`);
  emit("");

  const statusPath: WorkItemStatus[] = [item.status];
  const advance = async (to: WorkItemStatus, actor = orchestrator, reason?: string): Promise<void> => {
    const updated = await factory.advance(item.id, to, actor, reason === undefined ? {} : { reason });
    statusPath.push(updated.status);
    emit(`  ${updated.history.at(-1)?.from} -> ${updated.status}  by ${actor.displayName}`);
  };

  emit("-- planning, and a blocking pause --");
  await expectRefusal("PLAN_APPROVAL pre-recorded while the item is still IDEA", () =>
    factory.recordApproval({
      gate: "PLAN_APPROVAL",
      subject: factory.workItemSubject(item.id),
      decision: "APPROVED",
      actor: hakan,
      authorization: authorize(),
    }),
  );
  await expectRefusal("cancellation by a caller-made HUMAN actor with no trusted token", () =>
    factory.advance(item.id, "CANCELLED", hakan),
  );

  await advance("ANALYSIS", planner);
  await advance("BLOCKED", planner);
  await expectRefusal("BLOCKED -> READY, bypassing PLAN_REVIEW/PLAN_APPROVAL", () =>
    factory.advance(item.id, "READY", orchestrator),
  );
  await advance("ANALYSIS", orchestrator);
  await advance("PLAN_REVIEW", planner);

  emit("");
  emit("-- gate 1: PLAN_APPROVAL --");
  await expectRefusal("PLAN_REVIEW -> READY with no plan approval", () =>
    factory.advance(item.id, "READY", orchestrator),
  );
  await factory.recordApproval({
    gate: "PLAN_APPROVAL",
    subject: factory.workItemSubject(item.id),
    decision: "APPROVED",
    actor: hakan,
    authorization: authorize(),
    note: "Scope agreed in conversation",
  });
  emit(`  PLAN_APPROVAL granted by ${hakan.displayName} at PLAN_REVIEW`);
  await advance("READY", orchestrator);

  emit("");
  emit("-- implementation --");
  await advance("IMPLEMENTING", orchestrator);
  await expectRefusal("IMPLEMENTING -> VERIFYING with no recorded implementation run", () =>
    factory.advance(item.id, "VERIFYING", orchestrator),
  );
  const implementation = await factory.runWorker({
    workItemId: item.id,
    role: "IMPLEMENTER",
    worker: implementer,
    instructions: "Implement the demo feature",
  });
  emit(`  run ${implementation.run.id} (${implementation.run.declaredWorkerId}) ${implementation.run.status}`);
  emit(`  worker claims acceptance met: ${implementation.run.claimsAcceptanceMet}`);
  emit(`  evidence recorded: ${implementation.evidence.length}`);

  await expectRefusal("IMPLEMENTING -> DONE, skipping verification and review", () =>
    factory.advance(item.id, "DONE", orchestrator),
  );

  emit("");
  emit("-- verification --");
  await advance("VERIFYING", orchestrator);
  await expectRefusal("VERIFYING -> REVIEW with no passing deterministic verification", () =>
    factory.advance(item.id, "REVIEW", orchestrator),
  );
  const verification = await factory.runWorker({
    workItemId: item.id,
    role: "VERIFIER",
    worker: verifier,
    instructions: "Run deterministic checks",
    againstRunId: implementation.run.id,
  });
  emit(`  run ${verification.run.id} (${verification.run.declaredWorkerId}) ${verification.run.status}`);
  await factory.recordReview({
    workItemId: item.id,
    reviewedRunId: implementation.run.id,
    reviewerRunId: verification.run.id,
    kind: "DETERMINISTIC",
    verdict: "PASS",
  });
  emit("  deterministic review PASS");

  emit("");
  emit("-- independent review (C4) --");
  await advance("REVIEW", orchestrator);

  // The same worker object renames itself and claims a reviewer role. Its
  // registry-issued principal does not change, so C4 still refuses.
  (implementer as { id: string }).id = "totally-different-reviewer";
  const disguisedRun = await factory.runWorker({
    workItemId: item.id,
    role: "REVIEWER",
    worker: implementer,
    instructions: "Review your own implementation under a new name",
    againstRunId: implementation.run.id,
  });
  await expectRefusal("a semantic review by the implementing worker principal under a new name", () =>
    factory.recordReview({
      workItemId: item.id,
      reviewedRunId: implementation.run.id,
      reviewerRunId: disguisedRun.run.id,
      kind: "SEMANTIC",
      verdict: "PASS",
    }),
  );

  const reviewRun = await factory.runWorker({
    workItemId: item.id,
    role: "REVIEWER",
    worker: reviewer,
    instructions: "Review the implementation against acceptance criteria",
    againstRunId: implementation.run.id,
  });
  await factory.recordReview({
    workItemId: item.id,
    reviewedRunId: implementation.run.id,
    reviewerRunId: reviewRun.run.id,
    kind: "SEMANTIC",
    verdict: "PASS",
    findings: ["No blocking issues found in the mock review"],
  });
  emit(`  run ${reviewRun.run.id} (${reviewRun.run.declaredWorkerId}) semantic review PASS`);

  emit("");
  emit("-- gate 2: RELEASE_APPROVAL --");
  await expectRefusal("RELEASE_APPROVAL pre-recorded before the item reaches WAITING_FOR_HUMAN", () =>
    factory.recordApproval({
      gate: "RELEASE_APPROVAL",
      subject: factory.workItemSubject(item.id),
      decision: "APPROVED",
      actor: hakan,
      authorization: authorize(),
    }),
  );

  await advance("WAITING_FOR_HUMAN", orchestrator);
  await expectRefusal("WAITING_FOR_HUMAN -> DONE before acceptance criteria are verified", () =>
    factory.advance(item.id, "DONE", orchestrator),
  );

  const verifications = await factory.verifyAcceptanceCriteria({
    workItemId: item.id,
    verifierRunId: verification.run.id,
  });
  emit(
    `  acceptance criteria verified: ${verifications.filter((entry) => entry.result === "PASSED").length}/${verifications.length} PASSED`,
  );
  const snapshot = await factory.releaseSnapshot(item.id);
  emit(`  release snapshot: ${snapshot?.id ?? "none"}`);

  await expectRefusal("WAITING_FOR_HUMAN -> DONE with a complete snapshot but no release approval", () =>
    factory.advance(item.id, "DONE", orchestrator),
  );

  const forgedToken: TrustedHumanToken = {
    actorId: hakan.id,
    issuedAt: clock.now(),
    nonce: "forged-nonce",
    signature: "0".repeat(64),
  };
  await expectRefusal("an AGENT recording its own RELEASE_APPROVAL", () =>
    factory.recordApproval({
      gate: "RELEASE_APPROVAL",
      subject: factory.workItemSubject(item.id),
      decision: "APPROVED",
      actor: orchestrator,
      authorization: forgedToken,
    }),
  );
  await expectRefusal("a forged HUMAN token recording a release approval", () =>
    factory.recordApproval({
      gate: "RELEASE_APPROVAL",
      subject: factory.workItemSubject(item.id),
      decision: "APPROVED",
      actor: hakan,
      authorization: forgedToken,
    }),
  );

  await expectRefusal("rewriting the terminal FAILED/SUCCEEDED run record", () =>
    store.runs.complete(implementation.run.id, {
      status: "SUCCEEDED",
      summary: "tampered",
      claimsAcceptanceMet: true,
      evidenceIds: [],
      finishedAt: clock.now(),
    }),
  );

  await factory.recordApproval({
    gate: "RELEASE_APPROVAL",
    subject: factory.workItemSubject(item.id),
    decision: "APPROVED",
    actor: hakan,
    authorization: authorize(),
    note: "Reviewed evidence, accepted",
  });
  emit(`  RELEASE_APPROVAL granted by ${hakan.displayName}, bound to ${snapshot?.id ?? "none"}`);

  emit("");
  emit("-- a new implementation invalidates the approved snapshot --");
  const supersedingRun = await factory.runWorker({
    workItemId: item.id,
    role: "IMPLEMENTER",
    worker: secondImplementer,
    instructions: "Sneak in a change after approval",
  });
  emit(`  run ${supersedingRun.run.id} (${supersedingRun.run.declaredWorkerId}) ${supersedingRun.run.status}`);
  await expectRefusal("DONE using artifacts from the superseded implementation", () =>
    factory.advance(item.id, "DONE", orchestrator),
  );
  emit("  the release approval no longer matches the current implementation");

  emit("");
  emit("-- rework, re-verify, re-review, re-approve --");
  await advance("IMPLEMENTING", orchestrator, "superseded implementation must be re-proven");
  await advance("VERIFYING", orchestrator);
  const verification2 = await factory.runWorker({
    workItemId: item.id,
    role: "VERIFIER",
    worker: verifier,
    instructions: "Verify the new implementation",
    againstRunId: supersedingRun.run.id,
  });
  await factory.recordReview({
    workItemId: item.id,
    reviewedRunId: supersedingRun.run.id,
    reviewerRunId: verification2.run.id,
    kind: "DETERMINISTIC",
    verdict: "PASS",
  });
  await advance("REVIEW", orchestrator);
  const reviewRun2 = await factory.runWorker({
    workItemId: item.id,
    role: "REVIEWER",
    worker: reviewer,
    instructions: "Review the new implementation",
    againstRunId: supersedingRun.run.id,
  });
  await factory.recordReview({
    workItemId: item.id,
    reviewedRunId: supersedingRun.run.id,
    reviewerRunId: reviewRun2.run.id,
    kind: "SEMANTIC",
    verdict: "PASS",
  });
  await advance("WAITING_FOR_HUMAN", orchestrator);
  await factory.verifyAcceptanceCriteria({ workItemId: item.id, verifierRunId: verification2.run.id });
  const snapshot2 = await factory.releaseSnapshot(item.id);
  emit(`  new release snapshot: ${snapshot2?.id ?? "none"}`);
  await factory.recordApproval({
    gate: "RELEASE_APPROVAL",
    subject: factory.workItemSubject(item.id),
    decision: "APPROVED",
    actor: hakan,
    authorization: authorize(),
    note: "Re-reviewed the new implementation",
  });
  emit(`  RELEASE_APPROVAL re-granted by ${hakan.displayName}`);
  await advance("DONE", orchestrator);

  emit("");
  emit("-- other protected gates --");
  for (const gate of ["PUBLISH_APPROVAL", "CONSTITUTION_CHANGE"] as const) {
    const status = await factory.gateStatus(gate, factory.workItemSubject(item.id));
    emit(`  ${gate}: satisfied=${status.satisfied} (${status.reason})`);
  }

  const final = await factory.getWorkItem(item.id);
  const evidence = await factory.listEvidence(item.id);
  const runs = await factory.listRuns(item.id);

  emit("");
  emit("== summary ==");
  emit(`final status : ${final.status}`);
  emit(`specRevision : ${final.specRevision}`);
  emit(`path         : ${statusPath.join(" -> ")}`);
  emit(`runs         : ${runs.length}`);
  emit(`evidence     : ${evidence.length}`);
  emit(`refusals     : ${refusals.length}`);

  return {
    finalStatus: final.status,
    statusPath,
    refusals,
    evidenceCount: evidence.length,
    runCount: runs.length,
    transcript,
  };
}
