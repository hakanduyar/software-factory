/**
 * Durable FactoryStore backed by local SQLite (`node:sqlite`, built into
 * Node — no ORM, no new npm dependency).
 *
 * Design, and why it differs in shape from the in-memory adapter while
 * preserving the exact same observable contract:
 *
 * - The in-memory adapter stages writes in a JS overlay and re-validates at
 *   commit because it has no transactional storage engine underneath it.
 *   SQLite already provides real, ACID transactions, so this adapter writes
 *   directly and lets `BEGIN` / `COMMIT` / `ROLLBACK` provide atomicity —
 *   simpler, and backed by a real engine rather than reimplemented.
 * - `node:sqlite`'s `DatabaseSync` is a single synchronous connection: two
 *   overlapping transactions on it is a SQLite error ("cannot start a
 *   transaction within a transaction"), and letting an unrelated write slip
 *   in between another transaction's BEGIN/COMMIT would silently attach that
 *   write to the wrong transaction — worse than not being atomic. A FIFO
 *   in-process mutex (`createMutex`) serializes every `transaction()` call,
 *   including the single-operation ones each top-level repository method
 *   opens (mirroring the in-memory adapter's `solo` helper), so only one
 *   logical unit of work ever touches the connection at a time.
 * - Optimistic concurrency and run-lifecycle terminality are enforced with
 *   real conditional `UPDATE ... WHERE version = ?` / `WHERE status =
 *   'RUNNING'` statements, checked via `changes`, rather than by comparing
 *   values read separately — the same "define eligibility to write in terms
 *   of the write itself" principle, expressed with SQL instead of a JS
 *   revalidation pass.
 * - Append-only tables rely on SQLite's own `PRIMARY KEY` uniqueness: an id
 *   reuse is a UNIQUE constraint violation, translated to
 *   `AppendOnlyViolationError`.
 * - Every row is validated on the way back out (src/adapters/sqlite/
 *   serialization.ts) rather than cast, and every entity is deep-frozen
 *   before being returned, matching the in-memory adapter's guarantee that
 *   nothing handed to a caller is mutable.
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { AcceptanceCriterion } from "../../domain/acceptanceCriterion.js";
import type { AcceptanceCriterionVerification } from "../../domain/acceptanceCriterionVerification.js";
import { sameSubject, type Approval, type SubjectRef } from "../../domain/approval.js";
import { AppendOnlyViolationError, ConcurrencyError, RunLifecycleError } from "../../domain/errors.js";
import { deepFreeze } from "../../domain/freeze.js";
import type { Evidence } from "../../domain/evidence.js";
import type { Project } from "../../domain/project.js";
import type { Review } from "../../domain/review.js";
import { isTerminalRunStatus, type Run } from "../../domain/run.js";
import type { WorkItem } from "../../domain/workItem.js";
import type { FactoryRepositories, FactoryStore, RunCompletion } from "../../ports/repositories.js";
import { captureCompletion, captureRun } from "../shared/runCapture.js";
import { ensureSchema } from "./schema.js";
import {
  encode,
  parseAcceptanceCriterion,
  parseApproval,
  parseEvidence,
  parseProject,
  parseReview,
  parseRun,
  parseVerification,
  parseWorkItem,
} from "./serialization.js";

export interface SqliteFactoryStore extends FactoryStore {
  /** Closes the underlying database connection. Safe to call once. */
  close(): void;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === "ERR_SQLITE_ERROR" &&
    /UNIQUE constraint failed/.test(error.message)
  );
}

/** FIFO async lock: only one queued callback runs at a time. */
function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  };
}

interface Statements {
  readonly projectUpsert: StatementSync;
  readonly projectFind: StatementSync;
  readonly projectList: StatementSync;
  readonly workItemInsert: StatementSync;
  readonly workItemCas: StatementSync;
  readonly workItemFind: StatementSync;
  readonly workItemByProject: StatementSync;
  readonly criteriaUpsert: StatementSync;
  readonly criteriaFind: StatementSync;
  readonly criteriaByWorkItem: StatementSync;
  readonly runInsert: StatementSync;
  readonly runComplete: StatementSync;
  readonly runFind: StatementSync;
  readonly runByWorkItem: StatementSync;
  readonly reviewInsert: StatementSync;
  readonly reviewFind: StatementSync;
  readonly reviewByWorkItem: StatementSync;
  readonly evidenceInsert: StatementSync;
  readonly evidenceFind: StatementSync;
  readonly evidenceByWorkItem: StatementSync;
  readonly verificationInsert: StatementSync;
  readonly verificationByWorkItem: StatementSync;
  readonly approvalInsert: StatementSync;
  readonly approvalFind: StatementSync;
  readonly approvalBySubject: StatementSync;
}

function prepareStatements(db: DatabaseSync): Statements {
  return {
    projectUpsert: db.prepare("INSERT INTO projects (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data"),
    projectFind: db.prepare("SELECT id, data FROM projects WHERE id = ?"),
    projectList: db.prepare("SELECT id, data FROM projects ORDER BY rowid ASC"),

    workItemInsert: db.prepare("INSERT INTO work_items (id, project_id, version, data) VALUES (?, ?, ?, ?)"),
    workItemCas: db.prepare("UPDATE work_items SET project_id = ?, version = ?, data = ? WHERE id = ? AND version = ?"),
    workItemFind: db.prepare("SELECT id, project_id, version, data FROM work_items WHERE id = ?"),
    workItemByProject: db.prepare("SELECT id, project_id, version, data FROM work_items WHERE project_id = ? ORDER BY rowid ASC"),

    criteriaUpsert: db.prepare(
      "INSERT INTO criteria (id, work_item_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, work_item_id = excluded.work_item_id",
    ),
    criteriaFind: db.prepare("SELECT id, work_item_id, data FROM criteria WHERE id = ?"),
    criteriaByWorkItem: db.prepare("SELECT id, work_item_id, data FROM criteria WHERE work_item_id = ? ORDER BY rowid ASC"),

    runInsert: db.prepare("INSERT INTO runs (id, work_item_id, status, data) VALUES (?, ?, ?, ?)"),
    runComplete: db.prepare("UPDATE runs SET status = ?, data = ? WHERE id = ? AND status = 'RUNNING'"),
    runFind: db.prepare("SELECT id, work_item_id, status, data FROM runs WHERE id = ?"),
    runByWorkItem: db.prepare("SELECT id, work_item_id, status, data FROM runs WHERE work_item_id = ? ORDER BY rowid ASC"),

    reviewInsert: db.prepare("INSERT INTO reviews (id, work_item_id, data) VALUES (?, ?, ?)"),
    reviewFind: db.prepare("SELECT id, work_item_id, data FROM reviews WHERE id = ?"),
    reviewByWorkItem: db.prepare("SELECT id, work_item_id, data FROM reviews WHERE work_item_id = ? ORDER BY rowid ASC"),

    evidenceInsert: db.prepare("INSERT INTO evidence (id, work_item_id, data) VALUES (?, ?, ?)"),
    evidenceFind: db.prepare("SELECT id, work_item_id, data FROM evidence WHERE id = ?"),
    evidenceByWorkItem: db.prepare("SELECT id, work_item_id, data FROM evidence WHERE work_item_id = ? ORDER BY rowid ASC"),

    verificationInsert: db.prepare("INSERT INTO verifications (id, work_item_id, data) VALUES (?, ?, ?)"),
    verificationByWorkItem: db.prepare("SELECT id, work_item_id, data FROM verifications WHERE work_item_id = ? ORDER BY rowid ASC"),

    approvalInsert: db.prepare("INSERT INTO approvals (id, subject_type, subject_id, data) VALUES (?, ?, ?, ?)"),
    approvalFind: db.prepare("SELECT id, subject_type, subject_id, data FROM approvals WHERE id = ?"),
    approvalBySubject: db.prepare("SELECT id, subject_type, subject_id, data FROM approvals WHERE subject_type = ? AND subject_id = ? ORDER BY rowid ASC"),
  };
}

interface ProjectRow {
  readonly id: string;
  readonly data: string;
}
interface WorkItemRow {
  readonly id: string;
  readonly project_id: string;
  readonly version: number;
  readonly data: string;
}
interface CriteriaRow {
  readonly id: string;
  readonly work_item_id: string;
  readonly data: string;
}
interface RunRow {
  readonly id: string;
  readonly work_item_id: string;
  readonly status: string;
  readonly data: string;
}
interface WorkItemLinkedRow {
  readonly id: string;
  readonly work_item_id: string;
  readonly data: string;
}
interface ApprovalRow {
  readonly id: string;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly data: string;
}

function buildRepositories(stmts: Statements): FactoryRepositories {
  return {
    projects: {
      async save(project: Project): Promise<Project> {
        const frozen = deepFreeze(project);
        stmts.projectUpsert.run(frozen.id, encode(frozen));
        return frozen;
      },
      async findById(id) {
        const row = stmts.projectFind.get(id) as ProjectRow | undefined;
        return row === undefined ? undefined : deepFreeze(parseProject(row.data, { id: row.id }));
      },
      async list() {
        const rows = stmts.projectList.all() as unknown as ProjectRow[];
        return rows.map((row) => deepFreeze(parseProject(row.data, { id: row.id })));
      },
    },

    workItems: {
      async create(item: WorkItem): Promise<WorkItem> {
        const frozen = deepFreeze(item);
        try {
          stmts.workItemInsert.run(frozen.id, frozen.projectId, frozen.version, encode(frozen));
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            throw new ConcurrencyError(`WorkItem ${frozen.id} already exists`);
          }
          throw error;
        }
        return frozen;
      },
      async compareAndSave(item: WorkItem, expectedVersion: number): Promise<WorkItem> {
        const frozen = deepFreeze(item);
        const result = stmts.workItemCas.run(frozen.projectId, frozen.version, encode(frozen), frozen.id, expectedVersion);
        if (Number(result.changes) === 0) {
          const currentRow = stmts.workItemFind.get(frozen.id) as WorkItemRow | undefined;
          const currentVersion =
            currentRow === undefined
              ? 0
              : parseWorkItem(currentRow.data, { id: currentRow.id, projectId: currentRow.project_id, version: currentRow.version })
                  .version;
          throw new ConcurrencyError(
            `WorkItem ${frozen.id} version conflict: expected current version ${expectedVersion}, found ${currentVersion}`,
          );
        }
        return frozen;
      },
      async findById(id) {
        const row = stmts.workItemFind.get(id) as WorkItemRow | undefined;
        return row === undefined
          ? undefined
          : deepFreeze(parseWorkItem(row.data, { id: row.id, projectId: row.project_id, version: row.version }));
      },
      async listByProject(projectId) {
        const rows = stmts.workItemByProject.all(projectId) as unknown as WorkItemRow[];
        return rows.map((row) => deepFreeze(parseWorkItem(row.data, { id: row.id, projectId: row.project_id, version: row.version })));
      },
    },

    criteria: {
      async save(criterion: AcceptanceCriterion) {
        const frozen = deepFreeze(criterion);
        stmts.criteriaUpsert.run(frozen.id, frozen.workItemId, encode(frozen));
        return frozen;
      },
      async findById(id) {
        const row = stmts.criteriaFind.get(id) as CriteriaRow | undefined;
        return row === undefined
          ? undefined
          : deepFreeze(parseAcceptanceCriterion(row.data, { id: row.id, workItemId: row.work_item_id }));
      },
      async listByWorkItem(workItemId) {
        const rows = stmts.criteriaByWorkItem.all(workItemId) as unknown as CriteriaRow[];
        return rows.map((row) => deepFreeze(parseAcceptanceCriterion(row.data, { id: row.id, workItemId: row.work_item_id })));
      },
    },

    runs: {
      async create(run: Run): Promise<Run> {
        const captured = captureRun(run);
        if ((captured.status as unknown) !== "RUNNING") {
          throw new RunLifecycleError(`a run must be created RUNNING, got ${JSON.stringify(captured.status)}`);
        }
        const frozen = deepFreeze(captured);
        try {
          stmts.runInsert.run(frozen.id, frozen.workItemId, frozen.status, encode(frozen));
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            throw new AppendOnlyViolationError(`record ${frozen.id} already exists and may not be overwritten`);
          }
          throw error;
        }
        return frozen;
      },
      async complete(id, completion: RunCompletion): Promise<Run> {
        const captured = captureCompletion(completion);
        const requested = captured.status as unknown;
        if (requested !== "SUCCEEDED" && requested !== "FAILED") {
          throw new RunLifecycleError(
            `a run may only be completed to SUCCEEDED or FAILED, got ${JSON.stringify(requested)}`,
          );
        }
        const currentRow = stmts.runFind.get(id) as RunRow | undefined;
        if (currentRow === undefined) {
          throw new RunLifecycleError(`run ${id} does not exist`);
        }
        const current = parseRun(currentRow.data, { id: currentRow.id, workItemId: currentRow.work_item_id, status: currentRow.status });
        if (isTerminalRunStatus(current.status)) {
          throw new RunLifecycleError(
            `run ${id} is already ${current.status}; a terminal run is immutable and may not be rewritten as ${captured.status}`,
          );
        }
        const completed: Run = {
          ...current,
          status: captured.status,
          summary: captured.summary,
          claimsAcceptanceMet: captured.claimsAcceptanceMet,
          evidenceIds: captured.evidenceIds,
          finishedAt: captured.finishedAt,
        };
        const frozen = deepFreeze(completed);
        const result = stmts.runComplete.run(frozen.status, encode(frozen), id);
        if (Number(result.changes) === 0) {
          throw new RunLifecycleError(
            `run ${id} is already terminal; a terminal run is immutable and may not be rewritten as ${frozen.status}`,
          );
        }
        return frozen;
      },
      async findById(id) {
        const row = stmts.runFind.get(id) as RunRow | undefined;
        return row === undefined
          ? undefined
          : deepFreeze(parseRun(row.data, { id: row.id, workItemId: row.work_item_id, status: row.status }));
      },
      async listByWorkItem(workItemId) {
        const rows = stmts.runByWorkItem.all(workItemId) as unknown as RunRow[];
        return rows.map((row) => deepFreeze(parseRun(row.data, { id: row.id, workItemId: row.work_item_id, status: row.status })));
      },
    },

    reviews: {
      async save(review: Review) {
        const frozen = deepFreeze(review);
        try {
          stmts.reviewInsert.run(frozen.id, frozen.workItemId, encode(frozen));
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            throw new AppendOnlyViolationError(`record ${frozen.id} already exists and may not be overwritten`);
          }
          throw error;
        }
        return frozen;
      },
      async findById(id) {
        const row = stmts.reviewFind.get(id) as WorkItemLinkedRow | undefined;
        return row === undefined ? undefined : deepFreeze(parseReview(row.data, { id: row.id, workItemId: row.work_item_id }));
      },
      async listByWorkItem(workItemId) {
        const rows = stmts.reviewByWorkItem.all(workItemId) as unknown as WorkItemLinkedRow[];
        return rows.map((row) => deepFreeze(parseReview(row.data, { id: row.id, workItemId: row.work_item_id })));
      },
    },

    evidence: {
      async save(evidence: Evidence) {
        const frozen = deepFreeze(evidence);
        try {
          stmts.evidenceInsert.run(frozen.id, frozen.workItemId, encode(frozen));
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            throw new AppendOnlyViolationError(`record ${frozen.id} already exists and may not be overwritten`);
          }
          throw error;
        }
        return frozen;
      },
      async findById(id) {
        const row = stmts.evidenceFind.get(id) as WorkItemLinkedRow | undefined;
        return row === undefined ? undefined : deepFreeze(parseEvidence(row.data, { id: row.id, workItemId: row.work_item_id }));
      },
      async listByWorkItem(workItemId) {
        const rows = stmts.evidenceByWorkItem.all(workItemId) as unknown as WorkItemLinkedRow[];
        return rows.map((row) => deepFreeze(parseEvidence(row.data, { id: row.id, workItemId: row.work_item_id })));
      },
    },

    verifications: {
      async save(verification: AcceptanceCriterionVerification) {
        const frozen = deepFreeze(verification);
        try {
          stmts.verificationInsert.run(frozen.id, frozen.workItemId, encode(frozen));
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            throw new AppendOnlyViolationError(`record ${frozen.id} already exists and may not be overwritten`);
          }
          throw error;
        }
        return frozen;
      },
      async listByWorkItem(workItemId) {
        const rows = stmts.verificationByWorkItem.all(workItemId) as unknown as WorkItemLinkedRow[];
        return rows.map((row) => deepFreeze(parseVerification(row.data, { id: row.id, workItemId: row.work_item_id })));
      },
    },

    approvals: {
      async save(approval: Approval) {
        const frozen = deepFreeze(approval);
        try {
          stmts.approvalInsert.run(frozen.id, frozen.subject.type, frozen.subject.id, encode(frozen));
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            throw new AppendOnlyViolationError(`record ${frozen.id} already exists and may not be overwritten`);
          }
          throw error;
        }
        return frozen;
      },
      async findById(id) {
        const row = stmts.approvalFind.get(id) as ApprovalRow | undefined;
        return row === undefined
          ? undefined
          : deepFreeze(parseApproval(row.data, { id: row.id, subjectType: row.subject_type, subjectId: row.subject_id }));
      },
      async listBySubject(subject: SubjectRef) {
        const rows = stmts.approvalBySubject.all(subject.type, subject.id) as unknown as ApprovalRow[];
        return rows
          .map((row) => deepFreeze(parseApproval(row.data, { id: row.id, subjectType: row.subject_type, subjectId: row.subject_id })))
          .filter((approval) => sameSubject(approval.subject, subject));
      },
    },
  };
}

export function createSqliteStore(path: string): SqliteFactoryStore {
  const db = new DatabaseSync(path);
  ensureSchema(db);
  const stmts = prepareStatements(db);
  const repos = buildRepositories(stmts);
  const withLock = createMutex();

  async function transaction<T>(work: (repositories: FactoryRepositories) => Promise<T>): Promise<T> {
    return withLock(async () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = await work(repos);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The original error is what matters; a failed rollback (e.g.
          // BEGIN itself never completed) is not worth masking it with.
        }
        throw error;
      }
    });
  }

  /** Every un-transacted call is its own single-operation unit of work. */
  const solo = <T>(work: (repositories: FactoryRepositories) => Promise<T>): Promise<T> => transaction(work);

  return {
    transaction,
    projects: {
      save: (project) => solo((r) => r.projects.save(project)),
      findById: (id) => solo((r) => r.projects.findById(id)),
      list: () => solo((r) => r.projects.list()),
    },
    workItems: {
      create: (item) => solo((r) => r.workItems.create(item)),
      compareAndSave: (item, expectedVersion) => solo((r) => r.workItems.compareAndSave(item, expectedVersion)),
      findById: (id) => solo((r) => r.workItems.findById(id)),
      listByProject: (projectId) => solo((r) => r.workItems.listByProject(projectId)),
    },
    criteria: {
      save: (criterion) => solo((r) => r.criteria.save(criterion)),
      findById: (id) => solo((r) => r.criteria.findById(id)),
      listByWorkItem: (workItemId) => solo((r) => r.criteria.listByWorkItem(workItemId)),
    },
    runs: {
      create: (run) => solo((r) => r.runs.create(run)),
      complete: (id, completion) => solo((r) => r.runs.complete(id, completion)),
      findById: (id) => solo((r) => r.runs.findById(id)),
      listByWorkItem: (workItemId) => solo((r) => r.runs.listByWorkItem(workItemId)),
    },
    reviews: {
      save: (review) => solo((r) => r.reviews.save(review)),
      findById: (id) => solo((r) => r.reviews.findById(id)),
      listByWorkItem: (workItemId) => solo((r) => r.reviews.listByWorkItem(workItemId)),
    },
    evidence: {
      save: (evidence) => solo((r) => r.evidence.save(evidence)),
      findById: (id) => solo((r) => r.evidence.findById(id)),
      listByWorkItem: (workItemId) => solo((r) => r.evidence.listByWorkItem(workItemId)),
    },
    verifications: {
      save: (verification) => solo((r) => r.verifications.save(verification)),
      listByWorkItem: (workItemId) => solo((r) => r.verifications.listByWorkItem(workItemId)),
    },
    approvals: {
      save: (approval) => solo((r) => r.approvals.save(approval)),
      findById: (id) => solo((r) => r.approvals.findById(id)),
      listBySubject: (subject) => solo((r) => r.approvals.listBySubject(subject)),
    },
    close(): void {
      db.close();
    },
  };
}
