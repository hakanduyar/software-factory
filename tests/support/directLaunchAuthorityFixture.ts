import { DatabaseSync } from "node:sqlite";
import type {
  DirectLaunchAuthorityPort,
  DirectLaunchBinding,
  DirectLaunchReceipt,
} from "../../src/ports/worker.js";
import type { RunId, WorkItemId } from "../../src/domain/ids.js";

export type RawDirectLaunchTuple = {
  readonly ticketDigest: string;
  readonly registryPrincipalId: string;
  readonly workItemId: WorkItemId;
  readonly specRevision: number;
  readonly runId: RunId;
  readonly reservationId: string;
  readonly reservationVersion: number;
};

const FIELDS = [
  "ticketDigest",
  "registryPrincipalId",
  "workItemId",
  "specRevision",
  "runId",
  "reservationId",
  "reservationVersion",
] as const;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isFiniteNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

function validateTuple(tuple: RawDirectLaunchTuple): void {
  if (
    !isNonEmptyString(tuple.ticketDigest) ||
    !isNonEmptyString(tuple.registryPrincipalId) ||
    !isNonEmptyString(tuple.workItemId) ||
    !isNonEmptyString(tuple.runId) ||
    !isNonEmptyString(tuple.reservationId)
  ) {
    throw new Error("invalid tuple: all string fields must be nonempty");
  }
  if (
    !isFiniteNonNegativeInt(tuple.specRevision) ||
    !isFiniteNonNegativeInt(tuple.reservationVersion)
  ) {
    throw new Error("invalid tuple: revision fields must be finite nonnegative integers");
  }
}

/** Trusted test-only cast: validated tuple -> frozen, deep-copied binding. */
export function mintBinding(tuple: RawDirectLaunchTuple): DirectLaunchBinding {
  validateTuple(tuple);
  const copy = {
    ticketDigest: tuple.ticketDigest,
    registryPrincipalId: tuple.registryPrincipalId,
    workItemId: tuple.workItemId,
    specRevision: tuple.specRevision,
    runId: tuple.runId,
    reservationId: tuple.reservationId,
    reservationVersion: tuple.reservationVersion,
  } as unknown as DirectLaunchBinding;
  return Object.freeze(copy);
}

export function createDirectLaunchAuthorityFixture(
  databasePath: string,
): DirectLaunchAuthorityPort & {
  register(tuple: RawDirectLaunchTuple): DirectLaunchBinding;
  cancel(reservationId: string): void;
  close(): void;
} {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA busy_timeout = 2000;");
  db.exec(
    `CREATE TABLE IF NOT EXISTS direct_launch_bindings (
      reservationId TEXT PRIMARY KEY,
      ticketDigest TEXT NOT NULL,
      registryPrincipalId TEXT NOT NULL,
      workItemId TEXT NOT NULL,
      specRevision INTEGER NOT NULL,
      runId TEXT NOT NULL,
      reservationVersion INTEGER NOT NULL,
      state TEXT NOT NULL
    )`,
  );

  function register(tuple: RawDirectLaunchTuple): DirectLaunchBinding {
    validateTuple(tuple);
    const existing = db
      .prepare("SELECT * FROM direct_launch_bindings WHERE reservationId = ?")
      .get(tuple.reservationId) as Record<string, unknown> | undefined;
    if (existing) {
      const matches = FIELDS.every(
        (f) => existing[f] === (tuple as Record<string, unknown>)[f],
      );
      if (!matches) {
        throw new Error(
          `reservationId ${tuple.reservationId} already bound to a different tuple`,
        );
      }
      return mintBinding(tuple);
    }
    db.prepare(
      `INSERT INTO direct_launch_bindings
        (reservationId, ticketDigest, registryPrincipalId, workItemId, specRevision, runId, reservationVersion, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(
      tuple.reservationId,
      tuple.ticketDigest,
      tuple.registryPrincipalId,
      tuple.workItemId,
      tuple.specRevision,
      tuple.runId,
      tuple.reservationVersion,
    );
    return mintBinding(tuple);
  }

  async function checkReadiness(binding: DirectLaunchBinding): Promise<boolean> {
    const b = binding as unknown as RawDirectLaunchTuple;
    const row = db
      .prepare(
        `SELECT 1 FROM direct_launch_bindings
         WHERE reservationId = ? AND ticketDigest = ? AND registryPrincipalId = ?
           AND workItemId = ? AND specRevision = ? AND runId = ?
           AND reservationVersion = ? AND state = 'pending'`,
      )
      .get(
        b.reservationId,
        b.ticketDigest,
        b.registryPrincipalId,
        b.workItemId,
        b.specRevision,
        b.runId,
        b.reservationVersion,
      );
    return row !== undefined;
  }

  async function atomicConsumeLaunch(
    binding: DirectLaunchBinding,
  ): Promise<DirectLaunchReceipt> {
    const b = binding as unknown as RawDirectLaunchTuple;
    const result = db
      .prepare(
        `UPDATE direct_launch_bindings SET state = 'consumed'
         WHERE reservationId = ? AND ticketDigest = ? AND registryPrincipalId = ?
           AND workItemId = ? AND specRevision = ? AND runId = ?
           AND reservationVersion = ? AND state = 'pending'`,
      )
      .run(
        b.reservationId,
        b.ticketDigest,
        b.registryPrincipalId,
        b.workItemId,
        b.specRevision,
        b.runId,
        b.reservationVersion,
      );
    if (Number(result.changes) !== 1) {
      throw new Error(
        `atomicConsumeLaunch refused for reservation ${b.reservationId}: stale, mismatched, replayed, or cancelled`,
      );
    }
    const receipt = {
      binding: mintBinding(b),
      consumedAt: new Date().toISOString(),
    } as unknown as DirectLaunchReceipt;
    return Object.freeze(receipt);
  }

  function cancel(reservationId: string): void {
    const result = db
      .prepare(
        "UPDATE direct_launch_bindings SET state = 'cancelled' WHERE reservationId = ? AND state = 'pending'",
      )
      .run(reservationId);
    if (Number(result.changes) !== 1) {
      throw new Error(`cannot cancel reservation ${reservationId}: missing or not pending`);
    }
  }

  function close(): void {
    db.close();
  }

  return { register, checkReadiness, atomicConsumeLaunch, cancel, close };
}