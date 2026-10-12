/**
 * `sf run status <run-id> --db <existing-path> --json`
 *
 * Read-only view of one persisted Run. Opens the database only through the
 * native read-only ledger (never createSqliteStore, so nothing is created,
 * migrated or written) and prints a fixed DTO. Failures are generic by design:
 * they never echo the supplied path, SQL, stack traces or database errors.
 */

import { openReadonlyRunLedger } from "../adapters/sqlite/readonlyRunLedger.js";

const USAGE = "Usage: sf run status <run-id> --db <existing-path> --json";

interface ParsedArgs {
  readonly runId: string;
  readonly dbPath: string;
}

/** Exactly one non-blank id, one --db value, one --json; anything else is refused. */
function parseArgs(args: readonly string[]): ParsedArgs | undefined {
  let runId: string | undefined;
  let dbPath: string | undefined;
  let json = false;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) return undefined;
    if (token === "--json") {
      if (json) return undefined;
      json = true;
    } else if (token === "--db") {
      const value = args[i + 1];
      if (dbPath !== undefined || value === undefined || value.trim().length === 0 || value.startsWith("--")) {
        return undefined;
      }
      dbPath = value;
      i += 1;
    } else if (token.startsWith("--")) {
      return undefined;
    } else {
      if (runId !== undefined || token.trim().length === 0) return undefined;
      runId = token;
    }
  }

  return runId === undefined || dbPath === undefined || !json ? undefined : { runId, dbPath };
}

export async function runRunStatus(args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed === undefined) {
    console.error(USAGE);
    return 2;
  }

  let ledger: ReturnType<typeof openReadonlyRunLedger> | undefined;
  try {
    ledger = openReadonlyRunLedger(parsed.dbPath);
    const run = await ledger.runs.findById(parsed.runId as never);
    if (run === undefined) {
      console.error("run status unavailable: run not found");
      return 1;
    }
    const dto = {
      id: run.id,
      workItemId: run.workItemId,
      role: run.role,
      status: run.status,
      startedAt: Number(run.startedAt),
      ...(run.finishedAt === undefined ? {} : { finishedAt: Number(run.finishedAt) }),
    };
    console.log(JSON.stringify(dto));
    return 0;
  } catch {
    console.error("run status unavailable: could not read the run ledger");
    return 1;
  } finally {
    try {
      ledger?.close();
    } catch {
      // Closing must never replace the already-decided outcome or leak details.
    }
  }
}
