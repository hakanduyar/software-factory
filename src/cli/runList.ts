/**
 * `sf run list --work-item <id> --db <existing-path> --json`
 *
 * Read-only listing of the persisted Runs of one work item. Opens the database
 * only through the native read-only ledger (never createSqliteStore, so nothing
 * is created, migrated or written) and prints ONE JSON array of fixed DTOs in
 * canonical (insertion) order. An unknown work item and a work item with no
 * Runs both print `[]`: the listing does not prove the work item exists.
 * Failures are generic by design: they never echo the supplied path, SQL, stack
 * traces or database errors.
 */

import { openReadonlyRunLedger } from "../adapters/sqlite/readonlyRunLedger.js";

const USAGE = "Usage: sf run list --work-item <id> --db <existing-path> --json";

interface ParsedArgs {
  readonly workItemId: string;
  readonly dbPath: string;
}

/** Exactly one non-blank --work-item, one --db, one --json; anything else is refused. */
function parseArgs(args: readonly string[]): ParsedArgs | undefined {
  let workItemId: string | undefined;
  let dbPath: string | undefined;
  let json = false;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) return undefined;
    if (token === "--json") {
      if (json) return undefined;
      json = true;
    } else if (token === "--db" || token === "--work-item") {
      const value = args[i + 1];
      const current = token === "--db" ? dbPath : workItemId;
      if (current !== undefined || value === undefined || value.trim().length === 0 || value.startsWith("--")) {
        return undefined;
      }
      if (token === "--db") dbPath = value;
      else workItemId = value;
      i += 1;
    } else {
      return undefined;
    }
  }

  return workItemId === undefined || dbPath === undefined || !json ? undefined : { workItemId, dbPath };
}

export async function runRunList(args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed === undefined) {
    console.error(USAGE);
    return 2;
  }

  let ledger: ReturnType<typeof openReadonlyRunLedger> | undefined;
  try {
    ledger = openReadonlyRunLedger(parsed.dbPath);
    const runs = await ledger.runs.listByWorkItem(parsed.workItemId as never);
    const dtos = runs.map((run) => ({
      id: run.id,
      workItemId: run.workItemId,
      role: run.role,
      status: run.status,
      startedAt: Number(run.startedAt),
      ...(run.finishedAt === undefined ? {} : { finishedAt: Number(run.finishedAt) }),
    }));
    console.log(JSON.stringify(dtos));
    return 0;
  } catch {
    console.error("run list unavailable: could not read the run ledger");
    return 1;
  } finally {
    try {
      ledger?.close();
    } catch {
      // Closing must never replace the already-decided outcome or leak details.
    }
  }
}
