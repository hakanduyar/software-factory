/**
 * Application service: the use cases the CLI (and later the HTTP API,
 * Control Room or Telegram inbox) call.
 *
 * It owns no workflow rules of its own — those live in WorkflowService and
 * the transition table's preconditions. Its job is to wire repositories,
 * runs, reviews and evidence together, and to enforce the integrity rules
 * that need more than the transition table to check:
 *
 *   - a protected human decision requires a HUMAN actor AND a TrustedHumanToken
 *     minted by the HumanIdentityGate (C1/C5);
 *   - a WORK_ITEM approval may only be recorded at the status where that gate
 *     is meaningful, and is stamped by this service with what was actually
 *     current — the caller cannot pre-record one or influence the binding;
 *   - a run's identity is the registry-issued WorkerPrincipal, never the
 *     worker's self-reported id, so reviewer independence (C4) survives a
 *     worker renaming itself;
 *   - a worker's thrown exception still leaves a FAILED run on record;
 *   - acceptance criteria are verified from a successful VERIFIER run's own
 *     recorded evidence, bound to the implementation run it examined (C3);
 *   - every multi-record write happens inside one unit of work, so a
 *     concurrency conflict can never leave accepted work half-durable.
 */

import type { AcceptanceCriterion } from "../domain/acceptanceCriterion.js";
import type { AcceptanceCriterionVerification } from "../domain/acceptanceCriterionVerification.js";
import type { Actor } from "../domain/actor.js";
import {
  GATE_DECISION_STATUS,
  workItemSubject,
  type Approval,
  type ApprovalContext,
  type ApprovalDecision,
  type ProtectedGate,
  type SubjectRef,
} from "../domain/approval.js";
import {
  ApprovalIntegrityError,
  HumanIdentityError,
  NotFoundError,
  ReviewIntegrityError,
  TerminalWorkItemError,
  ValidationError,
  WorkerExecutionError,
} from "../domain/errors.js";
import type { Evidence } from "../domain/evidence.js";
import type { ReleaseSnapshot } from "../domain/executionSnapshot.js";
import type { TrustedHumanToken } from "../domain/humanIdentity.js";
import type { IdGenerator, ProjectId, RunId, WorkItemId } from "../domain/ids.js";
import type { Project } from "../domain/project.js";
import type { Review, ReviewKind, ReviewVerdict } from "../domain/review.js";
import type { FactoryRole } from "../domain/role.js";
import type { Run } from "../domain/run.js";
import { isTerminal, type WorkItemStatus } from "../domain/status.js";
import { principalSupportsRole } from "../domain/workerPrincipal.js";
import type { Priority, WorkItem, WorkItemType } from "../domain/workItem.js";
import type { Clock } from "../ports/clock.js";
import type { HumanIdentityGate } from "../ports/humanIdentityGate.js";
import type { FactoryRepositories, FactoryStore } from "../ports/repositories.js";
import type { Worker, WorkerOutcome } from "../ports/worker.js";
import type { WorkerRegistry } from "../ports/workerRegistry.js";
import { evaluateGate, requireGate, type GateBinding, type GateStatus } from "../workflow/gateGuard.js";
import { resolveCurrentImplementation, resolveReleaseSnapshot } from "../workflow/releaseSnapshotResolver.js";
import { assertRoleStartable } from "../workflow/rolePolicy.js";
import { WorkflowService, type TransitionCheck } from "../workflow/workflowService.js";

export interface FactoryServiceDeps {
  readonly store: FactoryStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly identityGate: HumanIdentityGate;
  readonly workerRegistry: WorkerRegistry;
}

export interface CreateProjectInput {
  readonly key: string;
  readonly name: string;
}

export interface CreateWorkItemInput {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly type: WorkItemType;
  readonly priority?: Priority;
  readonly planVersion: string;
  readonly assignedRole?: FactoryRole;
  readonly dependencies?: readonly WorkItemId[];
  /** Must be non-empty: a work item with nothing to verify can never be meaningfully DONE (C2/C3). */
  readonly acceptanceCriteria: readonly { text: string; verificationHint: string }[];
}

export interface RunWorkerInput {
  readonly workItemId: WorkItemId;
  readonly role: FactoryRole;
  readonly worker: Worker;
  readonly instructions: string;
  /** Required for VERIFIER/REVIEWER runs: the implementation run under examination. */
  readonly againstRunId?: RunId;
}

export interface VerifyAcceptanceCriteriaInput {
  readonly workItemId: WorkItemId;
  readonly verifierRunId: RunId;
}

export interface RecordReviewInput {
  readonly workItemId: WorkItemId;
  /** The IMPLEMENTER run being reviewed. */
  readonly reviewedRunId: RunId;
  /** The run that performed this review; both principals are derived from these runs. */
  readonly reviewerRunId: RunId;
  readonly kind: ReviewKind;
  readonly verdict: ReviewVerdict;
  readonly findings?: readonly string[];
}

export interface RecordApprovalInput {
  readonly gate: ProtectedGate;
  readonly subject: SubjectRef;
  readonly decision: ApprovalDecision;
  readonly actor: Actor;
  /** Minted by FactoryService.authorizeHuman; proves the actor is really the human it claims. */
  readonly authorization: TrustedHumanToken;
  readonly note?: string;
}

export interface AdvanceOptions {
  readonly reason?: string;
  /** Required for protected human transitions such as cancellation. */
  readonly authorization?: TrustedHumanToken;
}

export class FactoryService {
  private readonly store: FactoryStore;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly identityGate: HumanIdentityGate;
  private readonly workerRegistry: WorkerRegistry;
  readonly workflow: WorkflowService;

  constructor(deps: FactoryServiceDeps) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.identityGate = deps.identityGate;
    this.workerRegistry = deps.workerRegistry;
    this.workflow = this.workflowFor(deps.store);
  }

  /** A WorkflowService reading through one specific repository set (live store or a transaction). */
  private workflowFor(repositories: FactoryRepositories): WorkflowService {
    return new WorkflowService(
      {
        approvals: repositories.approvals,
        runs: repositories.runs,
        reviews: repositories.reviews,
        criteria: repositories.criteria,
        verifications: repositories.verifications,
        identityGate: this.identityGate,
      },
      this.clock,
    );
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    return this.store.projects.save({
      id: this.ids.next("prj"),
      key: input.key,
      name: input.name,
      createdAt: this.clock.now(),
    });
  }

  async createWorkItem(input: CreateWorkItemInput): Promise<WorkItem> {
    if (input.acceptanceCriteria.length === 0) {
      throw new ValidationError(
        "a WorkItem must declare at least one acceptance criterion (C2/C3): nothing to verify means it can never be honestly DONE",
      );
    }

    return this.store.transaction(async (repos) => {
      const project = await repos.projects.findById(input.projectId);
      if (project === undefined) {
        throw new NotFoundError("Project", input.projectId);
      }

      const id = this.ids.next("wi");
      const criteria: AcceptanceCriterion[] = [];
      for (const draft of input.acceptanceCriteria) {
        criteria.push(
          await repos.criteria.save({
            id: this.ids.next("ac"),
            workItemId: id,
            text: draft.text,
            verificationHint: draft.verificationHint,
          }),
        );
      }

      const at = this.clock.now();
      return repos.workItems.create({
        id,
        projectId: input.projectId,
        title: input.title,
        type: input.type,
        status: "IDEA",
        specRevision: 1,
        version: 1,
        priority: input.priority ?? "P2",
        planVersion: input.planVersion,
        dependencies: input.dependencies ?? [],
        acceptanceCriteriaIds: criteria.map((criterion) => criterion.id),
        ...(input.assignedRole === undefined ? {} : { assignedRole: input.assignedRole }),
        runIds: [],
        history: [],
        createdAt: at,
        updatedAt: at,
      });
    });
  }

  async getWorkItem(id: WorkItemId): Promise<WorkItem> {
    const item = await this.store.workItems.findById(id);
    if (item === undefined) {
      throw new NotFoundError("WorkItem", id);
    }
    return item;
  }

  /**
   * THE terminal-work-item policy (single definition, not scattered checks):
   * once a work item is DONE or CANCELLED, no operation that creates or
   * changes production workflow state — runs, evidence, reviews, criterion
   * verifications, attachment — is allowed. Reading and reporting remain
   * free. Status transitions need no extra check here: terminal statuses
   * have no outgoing edges in the transition table.
   */
  private async requireOperableWorkItem(
    repositories: Pick<FactoryRepositories, "workItems">,
    id: WorkItemId,
    operation: string,
  ): Promise<WorkItem> {
    const item = await repositories.workItems.findById(id);
    if (item === undefined) {
      throw new NotFoundError("WorkItem", id);
    }
    if (isTerminal(item.status)) {
      throw new TerminalWorkItemError(
        `${operation} is not allowed: WorkItem ${id} is ${item.status}, which is terminal — a completed item's record is closed (C7/C8)`,
      );
    }
    return item;
  }

  /** Non-throwing pre-check, mirrors WorkflowService.check. */
  async checkTransition(
    id: WorkItemId,
    to: WorkItemStatus,
    actor: Actor,
    options: AdvanceOptions = {},
  ): Promise<TransitionCheck> {
    return this.workflow.check(await this.getWorkItem(id), to, actor, options);
  }

  /**
   * Advances a work item's status. The gate check and the write happen inside
   * one unit of work, so a racing writer cannot slip between them; the loser
   * gets ConcurrencyError with nothing persisted.
   */
  async advance(
    id: WorkItemId,
    to: WorkItemStatus,
    actor: Actor,
    options: AdvanceOptions | string = {},
  ): Promise<WorkItem> {
    const opts: AdvanceOptions = typeof options === "string" ? { reason: options } : options;
    return this.store.transaction(async (repos) => {
      const item = await repos.workItems.findById(id);
      if (item === undefined) {
        throw new NotFoundError("WorkItem", id);
      }
      const next = await this.workflowFor(repos).transition(item, to, actor, opts);
      return repos.workItems.compareAndSave(next, item.version);
    });
  }

  /**
   * The only way to obtain a TrustedHumanToken. Throws HumanIdentityError if
   * `actor.kind !== "HUMAN"` or `credential` does not match the configured
   * local secret. A worker never receives this method or the credential (see
   * src/ports/worker.ts), so it cannot mint a token for itself.
   */
  authorizeHuman(actor: Actor, credential: string): TrustedHumanToken {
    return this.identityGate.authorize(actor, credential);
  }

  /** Registers a Worker and returns its immutable, registry-issued principal. */
  registerWorker(worker: Worker, roles?: readonly FactoryRole[]) {
    return this.workerRegistry.register(worker, roles === undefined ? {} : { roles });
  }

  /**
   * Records a human decision at a protected gate.
   *
   * Refuses a non-HUMAN actor, refuses any actor without a token that
   * verifies for it, and — for a work item gate — refuses to record the
   * decision unless the item is actually at the status where that gate is
   * decided. That last check is what makes pre-recording impossible: there is
   * no moment at IDEA when a PLAN_APPROVAL or RELEASE_APPROVAL can be created
   * at all.
   *
   * The binding (`specRevision` for a plan, release `snapshotId` for a
   * release) is read from live state here and stamped into the approval, so a
   * caller cannot make an approval look current for something it never saw.
   */
  async recordApproval(input: RecordApprovalInput): Promise<Approval> {
    if (input.actor.kind !== "HUMAN") {
      throw new ApprovalIntegrityError(
        `Actor ${input.actor.id} of kind ${input.actor.kind} may not decide gate ${input.gate}; approvals require a HUMAN actor`,
      );
    }
    if (!this.identityGate.verify(input.authorization, input.actor)) {
      throw new HumanIdentityError(
        `authorization token is invalid, expired, or was not issued to actor ${input.actor.id}; refusing to record ${input.gate}`,
      );
    }

    return this.store.transaction(async (repos) => {
      let context: ApprovalContext | undefined;

      if (input.subject.type === "WORK_ITEM") {
        const item = await repos.workItems.findById(input.subject.id);
        if (item === undefined) {
          throw new NotFoundError("WorkItem", input.subject.id);
        }

        const requiredStatus = GATE_DECISION_STATUS[input.gate];
        if (requiredStatus !== undefined && item.status !== requiredStatus) {
          throw new ValidationError(
            `${input.gate} may only be decided while the work item is at ${requiredStatus}; it is currently ${item.status}`,
          );
        }

        context = { statusWhenDecided: item.status, specRevision: item.specRevision };

        if (input.gate === "RELEASE_APPROVAL") {
          const snapshot = await resolveReleaseSnapshot(item, repos);
          if (!snapshot.ok) {
            throw new ValidationError(
              `RELEASE_APPROVAL requires a complete release snapshot to approve, but none exists: ${snapshot.reason}`,
            );
          }
          context = { ...context, snapshotId: snapshot.value.id };
        }
      }

      return repos.approvals.save({
        id: this.ids.next("apr"),
        gate: input.gate,
        subject: input.subject,
        decision: input.decision,
        decidedBy: input.actor,
        ...(context === undefined ? {} : { context }),
        ...(input.note === undefined ? {} : { note: input.note }),
        decidedAt: this.clock.now(),
      });
    });
  }

  async gateStatus(gate: ProtectedGate, subject: SubjectRef, expected: GateBinding = {}): Promise<GateStatus> {
    return evaluateGate(this.store.approvals, gate, subject, expected);
  }

  /**
   * Guard for protected operations that are not workflow transitions, i.e.
   * PUBLISH_APPROVAL and CONSTITUTION_CHANGE.
   */
  async assertGateSatisfied(gate: ProtectedGate, subject: SubjectRef, expected: GateBinding = {}): Promise<Approval> {
    return requireGate(this.store.approvals, gate, subject, expected);
  }

  /** The current release candidate, if the work item has one. */
  async releaseSnapshot(workItemId: WorkItemId): Promise<ReleaseSnapshot | undefined> {
    const item = await this.getWorkItem(workItemId);
    const resolved = await resolveReleaseSnapshot(item, this.store);
    return resolved.ok ? resolved.value : undefined;
  }

  /**
   * Executes one worker run in three phases (remediation of the Round-5
   * CRITICAL race, where the worker executed before any durable record of
   * the attempt existed and the old generation stayed releasable mid-flight):
   *
   * PHASE 1 — START, atomic: validate the item is operable, that the role
   * may start in the current workflow state (src/workflow/rolePolicy.ts) and
   * that the target run exists, then create the Run as RUNNING and attach it
   * to the work item under CAS, committing before any external call. From
   * this commit on, the RUNNING attempt is the lineage head: the release
   * snapshot is unresolvable and DONE/RELEASE_APPROVAL are refused. If this
   * transaction fails, Worker.execute() is never invoked and nothing is
   * durable.
   *
   * PHASE 2 — EXECUTE, outside any transaction: the external worker runs.
   * Success, returned failure and thrown exception all proceed to PHASE 3.
   *
   * PHASE 3 — FINALIZE, atomic: persist evidence and complete that exact
   * run (the repository refuses unless it is still RUNNING). This phase
   * touches only the run and evidence tables — never the work item — so a
   * concurrent item change cannot orphan the audit record: an authorized
   * execution's true outcome is always recorded, even if a human cancelled
   * the item mid-flight (completing the audit record of already-authorized
   * work is not new production state).
   *
   * Serialization with release: either DONE commits first (PHASE 1's CAS
   * fails, no execution), or PHASE 1 commits first (the RUNNING head makes
   * DONE unreleasable). There is no interleaving where both succeed.
   *
   * Note what this never does: change the work item's status.
   */
  async runWorker(input: RunWorkerInput): Promise<{ run: Run; evidence: readonly Evidence[] }> {
    // Trusted identity: whatever the worker says about itself is ignored.
    const principal = this.workerRegistry.principalFor(input.worker);
    if (!principalSupportsRole(principal, input.role)) {
      throw new NotFoundError("Worker capable of role", `${principal.principalId}:${input.role}`);
    }
    if ((input.role === "VERIFIER" || input.role === "REVIEWER") && input.againstRunId === undefined) {
      throw new ValidationError(`a ${input.role} run must name the implementation run it examines (againstRunId)`);
    }

    const runId = this.ids.next("run");

    // PHASE 1 — durable, authoritative start.
    const started = await this.store.transaction(async (repos) => {
      const item = await this.requireOperableWorkItem(repos, input.workItemId, "runWorker");
      assertRoleStartable(input.role, item.status);

      if (input.againstRunId !== undefined) {
        const target = await repos.runs.findById(input.againstRunId);
        if (target === undefined || target.workItemId !== item.id) {
          throw new NotFoundError("Target run for work item", `${input.againstRunId}@${item.id}`);
        }
      }

      const criteria = await repos.criteria.listByWorkItem(item.id);
      const pending: Run = {
        id: runId,
        workItemId: item.id,
        specRevision: item.specRevision,
        role: input.role,
        workerPrincipalId: principal.principalId,
        declaredWorkerId: input.worker.id,
        status: "RUNNING",
        ...(input.againstRunId === undefined ? {} : { targetRunId: input.againstRunId }),
        claimsAcceptanceMet: false,
        evidenceIds: [],
        startedAt: this.clock.now(),
      };
      await repos.runs.create(pending);
      await repos.workItems.compareAndSave(
        { ...item, runIds: [...item.runIds, runId], version: item.version + 1, updatedAt: this.clock.now() },
        item.version,
      );
      return { item, criteria };
    });

    // PHASE 2 — external execution, no transaction held open.
    let outcome: WorkerOutcome | undefined;
    let thrown: unknown;
    try {
      outcome = await input.worker.execute({
        runId,
        workItemId: started.item.id,
        role: input.role,
        title: started.item.title,
        instructions: input.instructions,
        acceptanceCriteria: started.criteria,
      });
    } catch (error) {
      thrown = error;
    }

    const failureSummary =
      thrown === undefined
        ? undefined
        : `worker ${input.worker.id} threw while performing role ${input.role}: ${
            thrown instanceof Error ? thrown.message : String(thrown)
          }`;

    // PHASE 3 — finalize the exact run created in PHASE 1.
    const committed = await this.store.transaction(async (repos) => {
      const drafts =
        failureSummary === undefined
          ? (outcome?.evidence ?? [])
          : [
              {
                kind: "NOTE" as const,
                summary: failureSummary,
                reference: `mock://error/${runId}`,
              },
            ];

      const evidence: Evidence[] = [];
      for (const draft of drafts) {
        evidence.push(
          await repos.evidence.save({
            ...draft,
            id: this.ids.next("ev"),
            workItemId: started.item.id,
            runId,
            createdAt: this.clock.now(),
          }),
        );
      }

      const run = await repos.runs.complete(runId, {
        status: failureSummary === undefined ? (outcome?.status ?? "FAILED") : "FAILED",
        summary: failureSummary ?? outcome?.summary ?? "",
        claimsAcceptanceMet: failureSummary === undefined && (outcome?.claimsAcceptanceMet ?? false),
        evidenceIds: evidence.map((entry) => entry.id),
        finishedAt: this.clock.now(),
      });

      return { run, evidence };
    });

    if (failureSummary !== undefined) {
      throw new WorkerExecutionError(failureSummary, thrown);
    }
    return committed;
  }

  /**
   * Records a review.
   *
   * Both principals are read from the two Runs involved, never from the
   * caller. C4 compares registry-issued principal ids, so a worker cannot
   * become independent of itself by changing its declared id or role.
   */
  async recordReview(input: RecordReviewInput): Promise<Review> {
    return this.store.transaction(async (repos) => {
      const item = await this.requireOperableWorkItem(repos, input.workItemId, "recordReview");

      const reviewedRun = await repos.runs.findById(input.reviewedRunId);
      if (reviewedRun === undefined || reviewedRun.workItemId !== input.workItemId) {
        throw new NotFoundError("Run for work item", `${input.reviewedRunId}@${input.workItemId}`);
      }

      const reviewerRun = await repos.runs.findById(input.reviewerRunId);
      if (reviewerRun === undefined || reviewerRun.workItemId !== input.workItemId) {
        throw new NotFoundError("Reviewer run for work item", `${input.reviewerRunId}@${input.workItemId}`);
      }
      if (reviewerRun.status !== "SUCCEEDED") {
        throw new ValidationError(`reviewer run ${reviewerRun.id} did not succeed; cannot record a review from it`);
      }
      if (reviewerRun.targetRunId !== reviewedRun.id) {
        throw new ValidationError(
          `reviewer run ${reviewerRun.id} examined ${String(reviewerRun.targetRunId)}, not the run being reviewed (${reviewedRun.id})`,
        );
      }
      if (input.kind === "SEMANTIC" && reviewerRun.role !== "REVIEWER") {
        throw new ValidationError(`a SEMANTIC review must be backed by a REVIEWER-role run, got ${reviewerRun.role}`);
      }
      if (input.kind === "SEMANTIC" && reviewerRun.workerPrincipalId === reviewedRun.workerPrincipalId) {
        throw new ReviewIntegrityError(
          `reviewer run ${reviewerRun.id} was executed by the same worker principal as the implementation run ${reviewedRun.id}; a worker may not be the sole semantic reviewer of its own work (C4)`,
        );
      }

      return repos.reviews.save({
        id: this.ids.next("rev"),
        workItemId: input.workItemId,
        specRevision: item.specRevision,
        reviewedRunId: input.reviewedRunId,
        reviewerRunId: input.reviewerRunId,
        kind: input.kind,
        reviewerPrincipalId: reviewerRun.workerPrincipalId,
        implementerPrincipalId: reviewedRun.workerPrincipalId,
        verdict: input.verdict,
        findings: input.findings ?? [],
        createdAt: this.clock.now(),
      });
    });
  }

  /**
   * Creates one AcceptanceCriterionVerification per acceptance criterion,
   * derived from a successful VERIFIER run's own recorded Evidence — never
   * from the worker's `claimsAcceptanceMet` flag — and bound to the exact
   * implementation run that verifier examined.
   */
  async verifyAcceptanceCriteria(
    input: VerifyAcceptanceCriteriaInput,
  ): Promise<readonly AcceptanceCriterionVerification[]> {
    return this.store.transaction(async (repos) => {
      const item = await this.requireOperableWorkItem(repos, input.workItemId, "verifyAcceptanceCriteria");

      const run = await repos.runs.findById(input.verifierRunId);
      if (run === undefined || run.workItemId !== input.workItemId) {
        throw new NotFoundError("Run for work item", `${input.verifierRunId}@${input.workItemId}`);
      }
      if (run.role !== "VERIFIER") {
        throw new ValidationError(`run ${run.id} is not a VERIFIER run`);
      }
      if (run.status !== "SUCCEEDED") {
        throw new ValidationError(`run ${run.id} did not succeed; cannot verify acceptance criteria from it`);
      }
      if (run.specRevision !== item.specRevision) {
        throw new ValidationError(`run ${run.id} is stale for current spec revision ${item.specRevision}`);
      }

      const implementation = await resolveCurrentImplementation(item, repos);
      if (!implementation.ok) {
        throw new ValidationError(implementation.reason);
      }
      if (run.targetRunId !== implementation.value.id) {
        throw new ValidationError(
          `verifier run ${run.id} examined ${String(run.targetRunId)}, which is not the current implementation run ${implementation.value.id}`,
        );
      }

      const criteria = await repos.criteria.listByWorkItem(item.id);
      const runEvidence = (await repos.evidence.listByWorkItem(item.id)).filter(
        (evidence) => evidence.runId === run.id,
      );

      const records: AcceptanceCriterionVerification[] = [];
      for (const criterion of criteria) {
        const proof = runEvidence.find((evidence) => evidence.criterionId === criterion.id);
        records.push(
          await repos.verifications.save({
            id: this.ids.next("acv"),
            criterionId: criterion.id,
            workItemId: item.id,
            specRevision: item.specRevision,
            implementationRunId: implementation.value.id,
            result: proof === undefined ? "FAILED" : "PASSED",
            verifierPrincipalId: run.workerPrincipalId,
            verifierRunId: run.id,
            ...(proof === undefined ? {} : { evidenceId: proof.id }),
            verifiedAt: this.clock.now(),
          }),
        );
      }
      return records;
    });
  }

  async listEvidence(workItemId: WorkItemId): Promise<readonly Evidence[]> {
    return this.store.evidence.listByWorkItem(workItemId);
  }

  async listRuns(workItemId: WorkItemId): Promise<readonly Run[]> {
    return this.store.runs.listByWorkItem(workItemId);
  }

  /**
   * Read-only, like listRuns/listEvidence. Added in TASK-004 remediation
   * round 1: crash reconciliation must recover an already-recorded Review
   * from authoritative Factory state (matched by its reviewerRunId) instead
   * of recording a duplicate; no public read for reviews existed before.
   */
  async listReviews(workItemId: WorkItemId): Promise<readonly Review[]> {
    return this.store.reviews.listByWorkItem(workItemId);
  }

  async listCriteria(workItemId: WorkItemId): Promise<readonly AcceptanceCriterion[]> {
    return this.store.criteria.listByWorkItem(workItemId);
  }

  async listVerifications(workItemId: WorkItemId): Promise<readonly AcceptanceCriterionVerification[]> {
    return this.store.verifications.listByWorkItem(workItemId);
  }

  workItemSubject(id: WorkItemId): SubjectRef {
    return workItemSubject(id);
  }
}
