/**
 * LOCAL persistence of an already-accepted result note into a trusted,
 * caller-owned directory.
 *
 * The draft is always rebuilt through buildAcceptedResultNoteDraft, so the
 * DONE state, release snapshot, recorded RELEASE_APPROVAL, review/evidence
 * lineage and the consumer recheck are unchanged. This module adds no
 * acceptance, approval, status, dispatch, ledger, manifest or outbox.
 *
 * Trust model: `ownedDirectory` is a TRUSTED, CALLER-OWNED, ABSOLUTE, EXISTING,
 * ordinary directory with a SINGLE writer. This is NOT protection against an
 * adversary concurrently replacing the directory or its entries between
 * checks, and the Factory reads performed by the consumer are not atomic.
 * The file name is derived only from the draft's source snapshot identity, so
 * a changed decision/lesson for the same snapshot maps to the same file and
 * is reported as a CONFLICT instead of being overwritten.
 *
 * CREATED means only: the exact bytes were read back from the local file.
 * It is not a remote ACK, task completion, full MEM03, remote sync or a cost
 * saving.
 */

import { createHash } from "node:crypto";
import { constants as fsc } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import type { FactoryService } from "../../app/factoryService.js";
import { AcceptedResultNoteRefusal, type AcceptedResultNoteDraft } from "./acceptedResultNote.js";
import {
  buildAcceptedResultNoteDraft,
  type AcceptedResultNoteRequest,
} from "./acceptedResultNoteConsumer.js";

export type AcceptedResultNotePersistenceCode =
  | "INVALID_DIRECTORY"
  | "INVALID_DESTINATION"
  | "CONFLICT"
  | "IO_FAILURE"
  | "READBACK_MISMATCH";

export class AcceptedResultNotePersistenceRefusal extends AcceptedResultNoteRefusal {
  readonly code: AcceptedResultNotePersistenceCode;
  constructor(code: AcceptedResultNotePersistenceCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "AcceptedResultNotePersistenceRefusal";
    this.code = code;
  }
}

export interface AcceptedResultNoteStorageResult {
  readonly status: "CREATED" | "EXISTING";
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly source: AcceptedResultNoteDraft["source"];
}

function fail(code: AcceptedResultNotePersistenceCode, message: string): never {
  throw new AcceptedResultNotePersistenceRefusal(code, message);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function resolveRoot(ownedDirectory: string): Promise<string> {
  if (typeof ownedDirectory !== "string" || !path.isAbsolute(ownedDirectory)) {
    fail("INVALID_DIRECTORY", "ownedDirectory must be an absolute path");
  }
  try {
    const st = await lstat(ownedDirectory);
    if (st.isSymbolicLink()) fail("INVALID_DIRECTORY", "ownedDirectory must not be a symlink");
    if (!st.isDirectory()) fail("INVALID_DIRECTORY", "ownedDirectory is not a directory");
    return await realpath(ownedDirectory);
  } catch (error) {
    if (error instanceof AcceptedResultNotePersistenceRefusal) throw error;
    return fail("INVALID_DIRECTORY", `ownedDirectory is not usable: ${describe(error)}`);
  }
}

function fileNameFor(source: AcceptedResultNoteDraft["source"]): string {
  const identity = JSON.stringify([
    source.snapshotId, source.workItemId, source.specRevision, source.implementationRunId,
  ]);
  return `${createHash("sha256").update(identity, "utf8").digest("hex")}.md`;
}

/** Reads an existing ordinary file without following a final symlink. */
async function readOrdinary(file: string): Promise<Buffer> {
  const st = await lstat(file);
  if (!st.isFile()) fail("INVALID_DESTINATION", "destination exists but is not an ordinary file");
  const handle = await open(file, fsc.O_RDONLY | fsc.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) {
      fail("INVALID_DESTINATION", "destination exists but is not an ordinary file");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function persistAcceptedResultNote(
  factory: FactoryService,
  request: AcceptedResultNoteRequest,
  ownedDirectory: string,
): Promise<AcceptedResultNoteStorageResult> {
  const draft = await buildAcceptedResultNoteDraft(factory, request);
  const root = await resolveRoot(ownedDirectory);
  const file = path.join(root, fileNameFor(draft.source));
  const expected = Buffer.from(draft.body, "utf8");
  const digest = sha256(expected);

  const result = (status: "CREATED" | "EXISTING"): AcceptedResultNoteStorageResult =>
    Object.freeze({
      status, path: file, sha256: digest, byteLength: expected.length, source: draft.source,
    });

  let created = false;
  try {
    const handle = await open(file, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
    created = true;
    try {
      await handle.writeFile(expected);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!created && (error as NodeJS.ErrnoException).code === "EEXIST") {
      let actual: Buffer;
      try {
        actual = await readOrdinary(file);
      } catch (readError) {
        if (readError instanceof AcceptedResultNotePersistenceRefusal) throw readError;
        return fail("INVALID_DESTINATION", `existing destination is not readable: ${describe(readError)}`);
      }
      if (!actual.equals(expected)) {
        fail("CONFLICT", "destination exists with different content; it was left untouched");
      }
      return result("EXISTING");
    }
    return fail("IO_FAILURE", `could not write note (any partial file is left in place): ${describe(error)}`);
  }

  let actual: Buffer;
  try {
    actual = await readOrdinary(file);
  } catch (error) {
    if (error instanceof AcceptedResultNotePersistenceRefusal) throw error;
    return fail("IO_FAILURE", `could not read note back: ${describe(error)}`);
  }
  if (actual.length !== expected.length || sha256(actual) !== digest || !actual.equals(expected)) {
    fail("READBACK_MISMATCH", "bytes read back differ from the bytes written; file left in place");
  }
  return result("CREATED");
}
