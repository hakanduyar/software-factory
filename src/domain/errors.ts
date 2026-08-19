/**
 * Domain errors. All failures a caller is expected to handle are typed, so a
 * refusal is never indistinguishable from a crash (acceptance criterion 5:
 * invalid transitions must fail deterministically).
 */

export class FactoryError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A requested status change is not in the transition table. */
export class InvalidTransitionError extends FactoryError {
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string, reason: string) {
    super(`Invalid transition ${from} -> ${to}: ${reason}`, "INVALID_TRANSITION");
    this.from = from;
    this.to = to;
  }
}

/** The transition exists but its protected gate has no granted human approval. */
export class ApprovalRequiredError extends FactoryError {
  readonly gate: string;
  readonly subjectId: string;

  constructor(gate: string, subjectId: string, reason: string) {
    super(`Gate ${gate} is not satisfied for ${subjectId}: ${reason}`, "APPROVAL_REQUIRED");
    this.gate = gate;
    this.subjectId = subjectId;
  }
}

/** Someone tried to record an approval that a human did not make. */
export class ApprovalIntegrityError extends FactoryError {
  constructor(message: string) {
    super(message, "APPROVAL_INTEGRITY");
  }
}

/** C4/C5: the implementer of a change cannot be its only semantic reviewer. */
export class ReviewIntegrityError extends FactoryError {
  constructor(message: string) {
    super(message, "REVIEW_INTEGRITY");
  }
}

export class NotFoundError extends FactoryError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, "NOT_FOUND");
  }
}

/**
 * The transition table allows this edge, but the real-world prerequisite for
 * it (a successful run, a passing review, a verified criterion) has not
 * happened. Distinct from InvalidTransitionError (the table itself refuses
 * the edge) and ApprovalRequiredError (a protected gate has no approval).
 */
export class PreconditionNotMetError extends FactoryError {
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string, reason: string) {
    super(`Cannot advance ${from} -> ${to}: ${reason}`, "PRECONDITION_NOT_MET");
    this.from = from;
    this.to = to;
  }
}

/**
 * A caller presented an Actor claiming to be HUMAN without a valid
 * TrustedHumanToken, or presented a token that does not verify (wrong
 * signature, wrong actor, expired). See src/ports/humanIdentityGate.ts.
 */
export class HumanIdentityError extends FactoryError {
  constructor(message: string) {
    super(message, "HUMAN_IDENTITY");
  }
}

/** A write raced another write and lost; the caller must re-read and retry. */
export class ConcurrencyError extends FactoryError {
  constructor(message: string) {
    super(message, "CONCURRENCY_CONFLICT");
  }
}

/** An attempt to overwrite an existing id in an append-only table (C8). */
export class AppendOnlyViolationError extends FactoryError {
  constructor(message: string) {
    super(message, "APPEND_ONLY_VIOLATION");
  }
}

/** Input failed a domain invariant (e.g. a work item with no acceptance criteria). */
export class ValidationError extends FactoryError {
  constructor(message: string) {
    super(message, "VALIDATION");
  }
}

/** A Worker object has no registry-issued principal, or a principal was forged. */
export class WorkerIdentityError extends FactoryError {
  constructor(message: string) {
    super(message, "WORKER_IDENTITY");
  }
}

/** A worker role started in a workflow state where that operation is not valid. */
export class OperationStateError extends FactoryError {
  constructor(message: string) {
    super(message, "INVALID_OPERATION_STATE");
  }
}

/** An operation that would change production state on a DONE/CANCELLED work item. */
export class TerminalWorkItemError extends FactoryError {
  constructor(message: string) {
    super(message, "TERMINAL_WORK_ITEM");
  }
}

/** An attempt to write a Run in a way its lifecycle forbids (terminal is terminal). */
export class RunLifecycleError extends FactoryError {
  constructor(message: string) {
    super(message, "RUN_LIFECYCLE");
  }
}

/** A worker's execute() threw instead of returning a WorkerOutcome. */
export class WorkerExecutionError extends FactoryError {
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message, "WORKER_EXECUTION_FAILED");
    this.cause = cause;
  }
}
