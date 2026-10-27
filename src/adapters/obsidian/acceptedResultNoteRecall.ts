/**
 * EXPLICIT, read-only recall of one already-persisted accepted result note.
 *
 * The caller supplies the FactoryService, the current request, a trusted
 * caller-owned absolute existing directory and the PR81 storage result as an
 * expected PIN. The pin is a claim to check, not an approval: the current
 * draft is rebuilt through buildAcceptedResultNoteDraft (DONE, exact current
 * snapshot, recorded RELEASE_APPROVAL, lineage, recheck), the file name is
 * derived independently from the draft's source identity, and the on-disk
 * bytes must equal the rebuilt draft bytes, the pinned SHA-256 and length.
 * Any mismatch refuses; no recalled note is returned. There are no writes,
 * searches or directory scans, and no arbitrary note text or path is accepted.
 *
 * Trust model is that of PR81: a trusted, single-writer, caller-owned
 * directory. This gives no protection against a hostile concurrent replacement
 * of the namespace, and the Factory reads are not atomic.
 *
 * The result is inert, attributed REFERENCE DATA. Its TypeScript shape is NOT
 * cryptographic authentication: prompt callers must obtain it from this
 * verifier; a cast or structurally-built object has no authority. This is not
 * full MEM03, remote ACK/sync, automatic worker wiring, or proof that any
 * model consumed the note.
 */

import { createHash } from "node:crypto";
import { constants as fsc } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import type { FactoryService } from "../../app/factoryService.js";
import { AcceptedResultNoteRefusal } from "./acceptedResultNote.js";
import {
  buildAcceptedResultNoteDraft,
  type AcceptedResultNoteRequest,
} from "./acceptedResultNoteConsumer.js";
import type { AcceptedResultNoteStorageResult } from "./acceptedResultNotePersistence.js";

export type AcceptedResultNoteRecallCode =
  | "INVALID_PIN"
  | "INVALID_DIRECTORY"
  | "INVALID_NOTE_FILE"
  | "NOTE_MISSING"
  | "NOTE_MISMATCH";

export class AcceptedResultNoteRecallRefusal extends AcceptedResultNoteRefusal {
  readonly code: AcceptedResultNoteRecallCode;
  constructor(code: AcceptedResultNoteRecallCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "AcceptedResultNoteRecallRefusal";
    this.code = code;
  }
}

export interface RecalledAcceptedResultNote {
  readonly inert: true;
  readonly kind: "ACCEPTED_RESULT_NOTE_REFERENCE";
  readonly body: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly path: string;
  readonly source: {
    readonly snapshotId: string;
    readonly workItemId: string;
    readonly specRevision: number;
    readonly implementationRunId: string;
  };
}

function fail(code: AcceptedResultNoteRecallCode, message: string): never {
  throw new AcceptedResultNoteRecallRefusal(code, message);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Same derivation as PR81 persistence (kept local; persistence is not refactored).
function fileNameFor(source: {
  snapshotId: string; workItemId: string; specRevision: number; implementationRunId: string;
}): string {
  const identity = JSON.stringify([
    source.snapshotId, source.workItemId, source.specRevision, source.implementationRunId,
  ]);
  return `${createHash("sha256").update(identity, "utf8").digest("hex")}.md`;
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
    if (error instanceof AcceptedResultNoteRecallRefusal) throw error;
    return fail("INVALID_DIRECTORY", `ownedDirectory is not usable: ${describe(error)}`);
  }
}

async function readLeaf(file: string, expectedLength: number): Promise<Buffer> {
  let st;
  try {
    st = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("NOTE_MISSING", "note file does not exist");
    return fail("INVALID_NOTE_FILE", `note file is not readable: ${describe(error)}`);
  }
  if (!st.isFile()) fail("INVALID_NOTE_FILE", "note path is not an ordinary file (symlink or other type)");
  try {
    const handle = await open(file, fsc.O_RDONLY | fsc.O_NOFOLLOW);
    try {
      const hst = await handle.stat();
      if (!hst.isFile()) fail("INVALID_NOTE_FILE", "note path is not an ordinary file");
      if (hst.size !== expectedLength) fail("NOTE_MISMATCH", "note byte length differs from the expected length");
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof AcceptedResultNoteRecallRefusal) throw error;
    return fail("INVALID_NOTE_FILE", `note file is not readable: ${describe(error)}`);
  }
}

export async function recallAcceptedResultNote(
  factory: FactoryService,
  request: AcceptedResultNoteRequest,
  ownedDirectory: string,
  expected: AcceptedResultNoteStorageResult,
): Promise<RecalledAcceptedResultNote> {
  if (typeof expected !== "object" || expected === null) fail("INVALID_PIN", "expected storage result is missing");

  const draft = await buildAcceptedResultNoteDraft(factory, request);
  const root = await resolveRoot(ownedDirectory);
  const file = path.join(root, fileNameFor(draft.source));
  const bytes = Buffer.from(draft.body, "utf8");
  const digest = sha256(bytes);

  if (expected.path !== file) fail("NOTE_MISMATCH", "pinned path differs from the derived note path");
  if (expected.sha256 !== digest) fail("NOTE_MISMATCH", "pinned SHA-256 differs from the current draft");
  if (expected.byteLength !== bytes.length) fail("NOTE_MISMATCH", "pinned byte length differs from the current draft");
  const pinned = expected.source;
  if (typeof pinned !== "object" || pinned === null) fail("INVALID_PIN", "pinned source identity is missing");
  for (const key of Object.keys(draft.source) as (keyof typeof draft.source)[]) {
    if (pinned[key] !== draft.source[key]) fail("NOTE_MISMATCH", `pinned source.${key} differs from the current draft`);
  }

  const actual = await readLeaf(file, bytes.length);
  if (actual.length !== bytes.length || sha256(actual) !== digest || !actual.equals(bytes)) {
    fail("NOTE_MISMATCH", "stored note bytes differ from the expected draft bytes");
  }

  return Object.freeze({
    inert: true as const,
    kind: "ACCEPTED_RESULT_NOTE_REFERENCE" as const,
    body: actual.toString("utf8"),
    sha256: digest,
    byteLength: actual.length,
    path: file,
    source: Object.freeze({
      snapshotId: draft.source.snapshotId,
      workItemId: draft.source.workItemId,
      specRevision: draft.source.specRevision,
      implementationRunId: draft.source.implementationRunId,
    }),
  });
}
