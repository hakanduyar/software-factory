/**
 * `sf memory persist-accepted` — explicit, trusted-operator CLI over the
 * delivered accepted-result note persistence and recall helpers.
 *
 * It holds no authority. Acceptance comes solely from the existing helpers
 * (DONE state, current release snapshot, recorded RELEASE_APPROVAL, lineage).
 * It does not approve, dispatch, select memory, sync remotely or change any
 * work item, run, status or approval. `createSqliteStore` may initialise the
 * schema, so the database file is not guaranteed byte-identical; this command
 * performs no DOMAIN write or transition.
 *
 * Decision/lesson are caller-supplied inert note text. A local CREATED/EXISTING
 * plus verified readback is not a remote ACK, task acceptance, full MEM03 or a
 * claim that any model consumed the note. Trust model of the owned directory
 * is unchanged (trusted, single writer). Read the printed "outcome:" line,
 * never the exit code alone.
 */

import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";

import { persistAcceptedResultNote } from "../adapters/obsidian/acceptedResultNotePersistence.js";
import { recallAcceptedResultNote } from "../adapters/obsidian/acceptedResultNoteRecall.js";
import type { AcceptedResultNoteRequest } from "../adapters/obsidian/acceptedResultNoteConsumer.js";
import { createSqliteStore } from "../adapters/sqlite/sqliteStore.js";
import { createLocalHumanIdentityGate } from "../adapters/security/localHumanIdentityGate.js";
import { createLocalWorkerRegistry } from "../adapters/security/localWorkerRegistry.js";
import { FactoryService } from "../app/factoryService.js";
import { createRandomIdGenerator } from "../domain/ids.js";
import { systemClock } from "../ports/clock.js";
import { boundedDiagnostic } from "../supervision/resourceClassifier.js";

/** Fixture-scale credential, same posture as `sf loop`: never a real secret (C6). Never used to authorize anyone. */
const CLI_CREDENTIAL = "sf-memory-persist-accepted-local-operator-secret";
const CONTROL_RX = /[\u0000-\u001f\u007f]/;
const ID_RX = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_TEXT = 16 * 1024;

export const PERSIST_ACCEPTED_USAGE =
  "Usage: sf memory persist-accepted --factory-db <abs-path> --work-item <id> --snapshot <id> " +
  "--decision <text> --lesson <text> --owned-directory <abs-path>";

export const PERSIST_ACCEPTED_HELP = `${PERSIST_ACCEPTED_USAGE}

Writes one local note for an ALREADY-ACCEPTED Factory result into an
operator-owned directory, then verifies it by reading it back through the
delivered recall helper. Every flag is required and may appear once.
Acceptance is decided only by the existing checks (DONE, current release
snapshot, recorded RELEASE_APPROVAL, lineage); this command approves nothing,
dispatches nothing and changes no work item, run or status. --decision and
--lesson are inert note text, never instructions. --factory-db must be an
existing ordinary file (never created); --owned-directory must be an existing
trusted single-writer directory. A local CREATED/EXISTING with verified
readback is not a remote ACK, task acceptance or proof a model used the note.
Exit 0 means local write and readback both succeeded; read the "outcome:" line.`;

const FLAGS = ["--factory-db", "--work-item", "--snapshot", "--decision", "--lesson", "--owned-directory"] as const;
type Flag = (typeof FLAGS)[number];

export interface PersistAcceptedArgs {
  readonly factoryDb: string;
  readonly workItemId: string;
  readonly snapshotId: string;
  readonly decision: string;
  readonly lesson: string;
  readonly ownedDirectory: string;
}

function absolutePath(v: string): boolean {
  return v.length > 0 && v.length <= 4096 && isAbsolute(v) && !CONTROL_RX.test(v);
}

export function parsePersistAcceptedArgs(
  args: readonly string[],
): { readonly ok: true; readonly value: PersistAcceptedArgs } | { readonly ok: false; readonly error: string } {
  const seen = new Map<Flag, string>();
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    if (!(FLAGS as readonly string[]).includes(token)) {
      return { ok: false, error: `unexpected argument ${JSON.stringify(boundedDiagnostic(token).slice(0, 64))}` };
    }
    const flag = token as Flag;
    if (seen.has(flag)) return { ok: false, error: `duplicate option ${flag}` };
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) return { ok: false, error: `option ${flag} requires a value` };
    seen.set(flag, value);
    i += 1;
  }
  for (const flag of FLAGS) {
    if (!seen.has(flag)) return { ok: false, error: `${flag} is required` };
  }
  const get = (f: Flag): string => seen.get(f) as string;
  for (const f of ["--factory-db", "--owned-directory"] as const) {
    if (!absolutePath(get(f))) return { ok: false, error: `${f} must be an absolute path` };
  }
  if (!ID_RX.test(get("--work-item"))) return { ok: false, error: "--work-item is not a valid id" };
  if (!ID_RX.test(get("--snapshot"))) return { ok: false, error: "--snapshot is not a valid id" };
  for (const f of ["--decision", "--lesson"] as const) {
    const v = get(f);
    if (v.trim() === "" || v.length > MAX_TEXT) return { ok: false, error: `${f} must be non-empty text of at most ${MAX_TEXT} characters` };
  }
  return {
    ok: true,
    value: {
      factoryDb: get("--factory-db"),
      workItemId: get("--work-item"),
      snapshotId: get("--snapshot"),
      decision: get("--decision"),
      lesson: get("--lesson"),
      ownedDirectory: get("--owned-directory"),
    },
  };
}

export interface PersistAcceptedOptions {
  readonly log?: (line: string) => void;
  readonly error?: (line: string) => void;
}

function publicCode(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" && /^[A-Z_]{1,40}$/.test(c) ? c : "REFUSED";
}

/** Exit codes: 0 local write and readback verified; 1 precheck refused; 2 refused by the acceptance/persistence checks; 3 note durably written but readback refused. */
export async function runPersistAccepted(
  args: PersistAcceptedArgs,
  options: PersistAcceptedOptions = {},
): Promise<number> {
  const log = options.log ?? ((): void => {});
  const error = options.error ?? ((): void => {});

  try {
    if (!lstatSync(args.factoryDb).isFile()) {
      error("outcome: PRECHECK_REFUSED — --factory-db is not an ordinary file");
      return 1;
    }
  } catch {
    error("outcome: PRECHECK_REFUSED — --factory-db does not exist");
    return 1;
  }

  const request: AcceptedResultNoteRequest = {
    workItemId: args.workItemId,
    expectedSnapshotId: args.snapshotId,
    decision: args.decision,
    lesson: args.lesson,
  };

  let stored: Awaited<ReturnType<typeof persistAcceptedResultNote>> | undefined;
  const store = createSqliteStore(args.factoryDb);
  try {
    const factory = new FactoryService({
      store,
      clock: systemClock,
      ids: createRandomIdGenerator(),
      identityGate: createLocalHumanIdentityGate({ credential: CLI_CREDENTIAL, clock: systemClock }),
      workerRegistry: createLocalWorkerRegistry(systemClock),
    });
    try {
      stored = await persistAcceptedResultNote(factory, request, args.ownedDirectory);
      const note = await recallAcceptedResultNote(factory, request, args.ownedDirectory, stored);
      log(
        `outcome: ${stored.status} (local write and readback verified; not a remote ACK or task acceptance)\n` +
          `path: ${note.path}\nsha256: ${note.sha256}\nbyteLength: ${note.byteLength}\n` +
          `source: snapshotId=${note.source.snapshotId} workItemId=${note.source.workItemId} ` +
          `specRevision=${note.source.specRevision} implementationRunId=${note.source.implementationRunId}\n` +
          `reference: ${note.kind} inert=${note.inert}`,
      );
      return 0;
    } catch (e) {
      const summary = boundedDiagnostic(e instanceof Error ? e.message : "refused");
      if (stored === undefined) {
        error(`outcome: REFUSED code=${publicCode(e)} — ${summary}`);
        return 2;
      }
      error(
        `outcome: RECALL_REFUSED code=${publicCode(e)} — ${summary}\n` +
          `partial boundary: the note was durably ${stored.status === "CREATED" ? "created" : "found existing"} at ${stored.path} ` +
          "and was left in place; it is NOT verified. Nothing was deleted or overwritten.",
      );
      return 3;
    }
  } finally {
    store.close();
  }
}
