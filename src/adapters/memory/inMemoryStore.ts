/**
 * In-memory FactoryStore with real atomic semantics.
 *
 * Bootstrap only: everything is lost on exit, which is what TASK-001 asks for
 * (persistence is Phase 2 / TASK-002). What matters here is that the
 * *semantics* a future SQLite/PostgreSQL adapter must provide are already
 * exercised and tested:
 *
 * - Writes inside `transaction` are staged in an overlay, never applied
 *   directly. At commit, every staged operation is re-validated against a
 *   working copy of the live tables in order, and only then swapped in.
 *   Commit is synchronous, so with JavaScript's single-threaded model no
 *   other operation can interleave inside it — the unit of work is genuinely
 *   all-or-nothing.
 * - Re-validation at commit (not merely at stage time) is what makes two
 *   concurrent `runWorker` calls safe: both stage a CAS against version V,
 *   the first commits and moves the live version to V+1, and the second's
 *   revalidation fails, discarding its run and evidence rather than leaving
 *   them durable but unattached.
 * - Every value is deep-frozen on the way in, so nothing stored can be
 *   mutated through a reference a caller kept. `deepFreeze` additionally
 *   refuses Date values, which is what keeps audit timestamps immutable.
 */

import type { AcceptanceCriterion } from "../../domain/acceptanceCriterion.js";
import type { AcceptanceCriterionVerification } from "../../domain/acceptanceCriterionVerification.js";
import { sameSubject, type Approval, type SubjectRef } from "../../domain/approval.js";
import {
  AppendOnlyViolationError,
  ConcurrencyError,
  RunLifecycleError,
} from "../../domain/errors.js";
import { deepFreeze } from "../../domain/freeze.js";
import type { Evidence } from "../../domain/evidence.js";
import type { Project } from "../../domain/project.js";
import type { Review } from "../../domain/review.js";
import { isTerminalRunStatus, type Run } from "../../domain/run.js";
import type { WorkItem } from "../../domain/workItem.js";
import type {
  FactoryRepositories,
  FactoryStore,
  RunCompletion,
} from "../../ports/repositories.js";
import { captureCompletion, captureRun } from "../shared/runCapture.js";

const TABLE_NAMES = [
  "projects",
  "workItems",
  "criteria",
  "runs",
  "reviews",
  "evidence",
  "verifications",
  "approvals",
] as const;

type TableName = (typeof TABLE_NAMES)[number];

type Row = { readonly id: string };

/** Reads a row as the commit-time working copy sees it. */
type Reader = (id: string) => Row | undefined;

interface StagedOp {
  readonly table: TableName;
  /** Throws if the write is not legal against `read`. Runs at stage time and again at commit. */
  validate(read: Reader): void;
  apply(rows: Map<string, Row>): void;
}

class MemoryDatabase {
  private readonly tables = new Map<TableName, Map<string, Row>>();

  constructor() {
    for (const name of TABLE_NAMES) {
      this.tables.set(name, new Map());
    }
  }

  table(name: TableName): Map<string, Row> {
    return this.tables.get(name)!;
  }
}

/**
 * One unit of work. Reads see the live tables plus this scope's own staged
 * writes; writes go only to the overlay until `commit`.
 */
class TransactionScope {
  private readonly overlay = new Map<TableName, Map<string, Row>>();
  private readonly ops: StagedOp[] = [];
  private committed = false;
  private readonly db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.db = db;
  }

  read(table: TableName, id: string): Row | undefined {
    const staged = this.overlay.get(table);
    if (staged?.has(id) === true) {
      return staged.get(id);
    }
    return this.db.table(table).get(id);
  }

  all(table: TableName): readonly Row[] {
    const merged = new Map(this.db.table(table));
    const staged = this.overlay.get(table);
    if (staged !== undefined) {
      for (const [id, row] of staged) {
        merged.set(id, row);
      }
    }
    return [...merged.values()];
  }

  stage(op: StagedOp): void {
    // Fail fast against what this scope can currently see...
    op.validate((id) => this.read(op.table, id));
    let staged = this.overlay.get(op.table);
    if (staged === undefined) {
      staged = new Map();
      this.overlay.set(op.table, staged);
    }
    op.apply(staged);
    this.ops.push(op);
  }

  /**
   * Applies every staged op to a working copy of the live tables, in order,
   * re-validating each against that working copy. Only if all succeed are the
   * live tables replaced. Fully synchronous: no interleaving is possible.
   */
  commit(): void {
    if (this.committed) {
      return;
    }
    const working = new Map<TableName, Map<string, Row>>();
    const workingTable = (name: TableName): Map<string, Row> => {
      let rows = working.get(name);
      if (rows === undefined) {
        rows = new Map(this.db.table(name));
        working.set(name, rows);
      }
      return rows;
    };

    for (const op of this.ops) {
      const rows = workingTable(op.table);
      op.validate((id) => rows.get(id));
      op.apply(rows);
    }

    for (const [name, rows] of working) {
      const live = this.db.table(name);
      live.clear();
      for (const [id, row] of rows) {
        live.set(id, row);
      }
    }
    this.committed = true;
  }
}

function appendOnlyOp<T extends Row>(table: TableName, entity: T): StagedOp {
  const frozen = deepFreeze(entity);
  return {
    table,
    validate(read) {
      if (read(entity.id) !== undefined) {
        throw new AppendOnlyViolationError(`record ${entity.id} already exists and may not be overwritten`);
      }
    },
    apply(rows) {
      rows.set(frozen.id, frozen);
    },
  };
}

function upsertOp<T extends Row>(table: TableName, entity: T): StagedOp {
  const frozen = deepFreeze(entity);
  return {
    table,
    validate() {},
    apply(rows) {
      rows.set(frozen.id, frozen);
    },
  };
}

function repositoriesFor(tx: TransactionScope): FactoryRepositories {
  return {
    projects: {
      async save(project: Project): Promise<Project> {
        tx.stage(upsertOp("projects", project));
        return project;
      },
      async findById(id) {
        return tx.read("projects", id) as Project | undefined;
      },
      async list() {
        return tx.all("projects") as readonly Project[];
      },
    },

    workItems: {
      async create(item: WorkItem): Promise<WorkItem> {
        tx.stage({
          table: "workItems",
          validate(read) {
            if (read(item.id) !== undefined) {
              throw new ConcurrencyError(`WorkItem ${item.id} already exists`);
            }
          },
          apply(rows) {
            rows.set(item.id, deepFreeze(item));
          },
        });
        return item;
      },
      async compareAndSave(item: WorkItem, expectedVersion: number): Promise<WorkItem> {
        tx.stage({
          table: "workItems",
          validate(read) {
            const current = read(item.id) as WorkItem | undefined;
            const currentVersion = current?.version ?? 0;
            if (currentVersion !== expectedVersion) {
              throw new ConcurrencyError(
                `WorkItem ${item.id} version conflict: expected current version ${expectedVersion}, found ${currentVersion}`,
              );
            }
          },
          apply(rows) {
            rows.set(item.id, deepFreeze(item));
          },
        });
        return item;
      },
      async findById(id) {
        return tx.read("workItems", id) as WorkItem | undefined;
      },
      async listByProject(projectId) {
        return (tx.all("workItems") as readonly WorkItem[]).filter((item) => item.projectId === projectId);
      },
    },

    runs: {
      async create(run: Run): Promise<Run> {
        // Capture BEFORE validating: every field is read exactly once, so a
        // getter cannot answer differently for validation and persistence.
        const captured = captureRun(run);
        if ((captured.status as unknown) !== "RUNNING") {
          throw new RunLifecycleError(`a run must be created RUNNING, got ${JSON.stringify(captured.status)}`);
        }
        tx.stage(appendOnlyOp("runs", captured));
        return captured;
      },
      async complete(id, completion: RunCompletion): Promise<Run> {
        // Capture every caller-supplied field exactly once, BEFORE any
        // validation. A Round-4 reviewer observation: fields were read more
        // than once, so a getter could answer "SUCCEEDED" to the validator
        // and something else to persistence. From here on, only `captured`
        // is consulted — the caller's object is never re-read.
        const captured = captureCompletion(completion);

        // Runtime validation of the captured value: TypeScript types stop at
        // the compile boundary. Only the two terminal statuses are
        // acceptable completion outcomes.
        const requested = captured.status as unknown;
        if (requested !== "SUCCEEDED" && requested !== "FAILED") {
          throw new RunLifecycleError(
            `a run may only be completed to SUCCEEDED or FAILED, got ${JSON.stringify(requested)}`,
          );
        }
        const current = tx.read("runs", id) as Run | undefined;
        if (current === undefined) {
          throw new RunLifecycleError(`run ${id} does not exist`);
        }
        if (isTerminalRunStatus(current.status)) {
          throw new RunLifecycleError(
            `run ${id} is already ${current.status}; a terminal run is immutable and may not be rewritten as ${captured.status}`,
          );
        }
        // Identity comes from the stored row; the completion contributes only
        // the captured completion fields.
        const completed: Run = {
          ...current,
          status: captured.status,
          summary: captured.summary,
          claimsAcceptanceMet: captured.claimsAcceptanceMet,
          evidenceIds: captured.evidenceIds,
          finishedAt: captured.finishedAt,
        };
        tx.stage({
          table: "runs",
          validate(read) {
            const stored = read(id) as Run | undefined;
            if (stored === undefined) {
              throw new RunLifecycleError(`run ${id} does not exist`);
            }
            if (isTerminalRunStatus(stored.status)) {
              throw new RunLifecycleError(
                `run ${id} is already ${stored.status}; a terminal run is immutable and may not be rewritten as ${captured.status}`,
              );
            }
          },
          apply(rows) {
            rows.set(id, deepFreeze(completed));
          },
        });
        return completed;
      },
      async findById(id) {
        return tx.read("runs", id) as Run | undefined;
      },
      async listByWorkItem(workItemId) {
        return (tx.all("runs") as readonly Run[]).filter((run) => run.workItemId === workItemId);
      },
    },

    criteria: {
      async save(criterion: AcceptanceCriterion) {
        tx.stage(upsertOp("criteria", criterion));
        return criterion;
      },
      async findById(id) {
        return tx.read("criteria", id) as AcceptanceCriterion | undefined;
      },
      async listByWorkItem(workItemId) {
        return (tx.all("criteria") as readonly AcceptanceCriterion[]).filter(
          (criterion) => criterion.workItemId === workItemId,
        );
      },
    },

    reviews: {
      async save(review: Review) {
        tx.stage(appendOnlyOp("reviews", review));
        return review;
      },
      async findById(id) {
        return tx.read("reviews", id) as Review | undefined;
      },
      async listByWorkItem(workItemId) {
        return (tx.all("reviews") as readonly Review[]).filter((review) => review.workItemId === workItemId);
      },
    },

    evidence: {
      async save(evidence: Evidence) {
        tx.stage(appendOnlyOp("evidence", evidence));
        return evidence;
      },
      async findById(id) {
        return tx.read("evidence", id) as Evidence | undefined;
      },
      async listByWorkItem(workItemId) {
        return (tx.all("evidence") as readonly Evidence[]).filter((entry) => entry.workItemId === workItemId);
      },
    },

    verifications: {
      async save(verification: AcceptanceCriterionVerification) {
        tx.stage(appendOnlyOp("verifications", verification));
        return verification;
      },
      async listByWorkItem(workItemId) {
        return (tx.all("verifications") as readonly AcceptanceCriterionVerification[]).filter(
          (verification) => verification.workItemId === workItemId,
        );
      },
    },

    approvals: {
      async save(approval: Approval) {
        tx.stage(appendOnlyOp("approvals", approval));
        return approval;
      },
      async findById(id) {
        return tx.read("approvals", id) as Approval | undefined;
      },
      async listBySubject(subject: SubjectRef) {
        return (tx.all("approvals") as readonly Approval[]).filter((approval) =>
          sameSubject(approval.subject, subject),
        );
      },
    },
  };
}

export function createInMemoryStore(): FactoryStore {
  const db = new MemoryDatabase();

  async function transaction<T>(work: (repositories: FactoryRepositories) => Promise<T>): Promise<T> {
    const tx = new TransactionScope(db);
    const result = await work(repositoriesFor(tx));
    // Only reached when `work` resolved: a throw propagates and the scope,
    // with everything it staged, is simply discarded.
    tx.commit();
    return result;
  }

  /** Every un-transacted call is its own single-operation unit of work. */
  const solo = <T>(work: (repositories: FactoryRepositories) => Promise<T>): Promise<T> => transaction(work);

  return {
    transaction,
    projects: {
      save: (project) => solo((repos) => repos.projects.save(project)),
      findById: (id) => solo((repos) => repos.projects.findById(id)),
      list: () => solo((repos) => repos.projects.list()),
    },
    workItems: {
      create: (item) => solo((repos) => repos.workItems.create(item)),
      compareAndSave: (item, expectedVersion) => solo((repos) => repos.workItems.compareAndSave(item, expectedVersion)),
      findById: (id) => solo((repos) => repos.workItems.findById(id)),
      listByProject: (projectId) => solo((repos) => repos.workItems.listByProject(projectId)),
    },
    criteria: {
      save: (criterion) => solo((repos) => repos.criteria.save(criterion)),
      findById: (id) => solo((repos) => repos.criteria.findById(id)),
      listByWorkItem: (workItemId) => solo((repos) => repos.criteria.listByWorkItem(workItemId)),
    },
    runs: {
      create: (run) => solo((repos) => repos.runs.create(run)),
      complete: (id, completion) => solo((repos) => repos.runs.complete(id, completion)),
      findById: (id) => solo((repos) => repos.runs.findById(id)),
      listByWorkItem: (workItemId) => solo((repos) => repos.runs.listByWorkItem(workItemId)),
    },
    reviews: {
      save: (review) => solo((repos) => repos.reviews.save(review)),
      findById: (id) => solo((repos) => repos.reviews.findById(id)),
      listByWorkItem: (workItemId) => solo((repos) => repos.reviews.listByWorkItem(workItemId)),
    },
    evidence: {
      save: (evidence) => solo((repos) => repos.evidence.save(evidence)),
      findById: (id) => solo((repos) => repos.evidence.findById(id)),
      listByWorkItem: (workItemId) => solo((repos) => repos.evidence.listByWorkItem(workItemId)),
    },
    verifications: {
      save: (verification) => solo((repos) => repos.verifications.save(verification)),
      listByWorkItem: (workItemId) => solo((repos) => repos.verifications.listByWorkItem(workItemId)),
    },
    approvals: {
      save: (approval) => solo((repos) => repos.approvals.save(approval)),
      findById: (id) => solo((repos) => repos.approvals.findById(id)),
      listBySubject: (subject) => solo((repos) => repos.approvals.listBySubject(subject)),
    },
  };
}
