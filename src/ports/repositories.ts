/**
 * Persistence ports.
 *
 * The domain talks to these interfaces only. The bootstrap implementation is
 * in-memory (src/adapters/memory); ADR-0001 expects a filesystem/SQLite and
 * later PostgreSQL adapter to replace it without touching domain code.
 *
 * Three contracts here exist because caller discipline proved insufficient in
 * review:
 *
 * 1. `RunRepository` has no general `save`. A run is `create`d RUNNING and
 *    `complete`d exactly once to a terminal status. Terminal records are
 *    immutable, so a FAILED implementation run cannot be rewritten as
 *    SUCCEEDED under the same id.
 *
 * 2. `WorkItemRepository` has no plain `save`: `create` is for a brand-new
 *    item and `compareAndSave` requires the caller's expected current
 *    `version`, failing with ConcurrencyError if the stored version moved on.
 *
 * 3. `FactoryStore.transaction` gives a unit of work. Everything staged
 *    inside commits together or not at all, so a successful run and its
 *    evidence can never become durable while attaching them to the work item
 *    loses a concurrency race. A future SQLite/PostgreSQL adapter implements
 *    this with a real transaction; the in-memory adapter implements it with a
 *    staged overlay validated at commit.
 */

import type { AcceptanceCriterion } from "../domain/acceptanceCriterion.js";
import type { AcceptanceCriterionVerification } from "../domain/acceptanceCriterionVerification.js";
import type { Approval, SubjectRef } from "../domain/approval.js";
import type { Evidence } from "../domain/evidence.js";
import type {
  AcceptanceCriterionId,
  ApprovalId,
  EvidenceId,
  ProjectId,
  ReviewId,
  RunId,
  WorkItemId,
} from "../domain/ids.js";
import type { Project } from "../domain/project.js";
import type { Review } from "../domain/review.js";
import type { Run } from "../domain/run.js";
import type { Timestamp } from "../domain/time.js";
import type { WorkItem } from "../domain/workItem.js";

export interface ProjectRepository {
  save(project: Project): Promise<Project>;
  findById(id: ProjectId): Promise<Project | undefined>;
  list(): Promise<readonly Project[]>;
}

export interface WorkItemRepository {
  /** Fails with ConcurrencyError if an item with this id already exists. */
  create(item: WorkItem): Promise<WorkItem>;
  /** Fails with ConcurrencyError if the stored version !== expectedVersion. */
  compareAndSave(item: WorkItem, expectedVersion: number): Promise<WorkItem>;
  findById(id: WorkItemId): Promise<WorkItem | undefined>;
  listByProject(projectId: ProjectId): Promise<readonly WorkItem[]>;
}

/** The terminal outcome of a run; the only mutation a Run ever accepts. */
export interface RunCompletion {
  readonly status: "SUCCEEDED" | "FAILED";
  readonly summary: string;
  readonly claimsAcceptanceMet: boolean;
  readonly evidenceIds: readonly EvidenceId[];
  readonly finishedAt: Timestamp;
}

export interface RunRepository {
  /** The run must be RUNNING and its id unused. */
  create(run: Run): Promise<Run>;
  /** Fails with RunLifecycleError unless the stored run exists and is RUNNING. */
  complete(id: RunId, completion: RunCompletion): Promise<Run>;
  findById(id: RunId): Promise<Run | undefined>;
  listByWorkItem(workItemId: WorkItemId): Promise<readonly Run[]>;
}

export interface AcceptanceCriterionRepository {
  save(criterion: AcceptanceCriterion): Promise<AcceptanceCriterion>;
  findById(id: AcceptanceCriterionId): Promise<AcceptanceCriterion | undefined>;
  listByWorkItem(workItemId: WorkItemId): Promise<readonly AcceptanceCriterion[]>;
}

export interface ReviewRepository {
  /** Append-only: fails with AppendOnlyViolationError if the id already exists. */
  save(review: Review): Promise<Review>;
  findById(id: ReviewId): Promise<Review | undefined>;
  listByWorkItem(workItemId: WorkItemId): Promise<readonly Review[]>;
}

export interface EvidenceRepository {
  /** Append-only: fails with AppendOnlyViolationError if the id already exists. */
  save(evidence: Evidence): Promise<Evidence>;
  findById(id: EvidenceId): Promise<Evidence | undefined>;
  listByWorkItem(workItemId: WorkItemId): Promise<readonly Evidence[]>;
}

export interface AcceptanceCriterionVerificationRepository {
  /** Append-only: fails with AppendOnlyViolationError if the id already exists. */
  save(verification: AcceptanceCriterionVerification): Promise<AcceptanceCriterionVerification>;
  listByWorkItem(workItemId: WorkItemId): Promise<readonly AcceptanceCriterionVerification[]>;
}

export interface ApprovalRepository {
  /** Append-only: fails with AppendOnlyViolationError if the id already exists. */
  save(approval: Approval): Promise<Approval>;
  findById(id: ApprovalId): Promise<Approval | undefined>;
  /** Newest last. The gate guard relies on this ordering. */
  listBySubject(subject: SubjectRef): Promise<readonly Approval[]>;
}

/** The repositories a unit of work exposes. */
export interface FactoryRepositories {
  readonly projects: ProjectRepository;
  readonly workItems: WorkItemRepository;
  readonly criteria: AcceptanceCriterionRepository;
  readonly runs: RunRepository;
  readonly reviews: ReviewRepository;
  readonly evidence: EvidenceRepository;
  readonly verifications: AcceptanceCriterionVerificationRepository;
  readonly approvals: ApprovalRepository;
}

export interface FactoryStore extends FactoryRepositories {
  /**
   * Runs `work` against a staged unit of work and commits it atomically.
   * If `work` throws, or if any staged write fails revalidation at commit
   * (append-only violation, CAS conflict, run-lifecycle violation), nothing
   * it staged becomes durable.
   */
  transaction<T>(work: (repositories: FactoryRepositories) => Promise<T>): Promise<T>;
}
