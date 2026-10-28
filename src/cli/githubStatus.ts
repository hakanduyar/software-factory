/**
 * `sf github sync-status` — operator CLI over the delivered
 * `syncWorkItemStatus` consumer, driven by REAL Factory records.
 *
 * What this is NOT. It holds no authority: the operator who types the command
 * is already authorized for the exact repo/issue/marker they supply, exactly as
 * the consumer's own contract requires. It never infers an issue, creates one,
 * locks an assignee, or mints/grants a human approval, and it changes no work
 * item, run, claim or approval. `createSqliteStore` initialises the schema, so
 * the database file is not guaranteed byte-identical; this command performs no
 * DOMAIN write or transition. It is not called by the supervisor or any loop.
 *
 * The printed status is a PROJECTION of records read moments ago, not runtime
 * authority. Domain state may change between reads: the item/run identity and
 * status are re-read once immediately before launch and any drift fails; this
 * is a bounded recheck, not an atomic multi-read snapshot.
 *
 * DONE is refused: it needs authenticated acceptance/delivery references that
 * no existing Factory record supplies, and raw caller references would only
 * pretend to authority.
 */

import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import { createSqliteStore } from "../adapters/sqlite/sqliteStore.js";
import { createNodeProcessRunner } from "../adapters/process/nodeProcessRunner.js";
import { syncWorkItemStatus } from "../adapters/github/workItemStatusSync.js";
import type { StatusSyncOutcome } from "../adapters/github/workItemStatusSync.js";
import { createLocalHumanIdentityGate } from "../adapters/security/localHumanIdentityGate.js";
import { createLocalWorkerRegistry } from "../adapters/security/localWorkerRegistry.js";
import { FactoryService } from "../app/factoryService.js";
import { createRandomIdGenerator } from "../domain/ids.js";
import { systemClock } from "../ports/clock.js";
import type { ProcessRunner } from "../ports/processRunner.js";
import { boundedDiagnostic } from "../supervision/resourceClassifier.js";

/** Fixture-scale credential, same posture as `sf loop`: never a real secret (C6). Never used to authorize anyone. */
const CLI_CREDENTIAL = "sf-github-status-local-operator-secret";
const MAX_CHECKPOINT_BYTES = 1024 * 1024;
const MAX_ISSUE = 2_147_483_647;
const CONTROL_RX = /[\u0000-\u001f\u007f]/;

export const SYNC_STATUS_USAGE =
  "Usage: sf github sync-status --factory-db <abs-path> --work-item <id> --run-id <id> " +
  "--checkpoint <abs-path> --repo <owner/name> --issue <n> --marker <marker> " +
  "--state-dir <abs-path> --pwsh <abs-path> --repository-root <abs-path>";

export const SYNC_STATUS_HELP = `${SYNC_STATUS_USAGE}

Publishes the PROJECTED status of a real work item and an explicitly named run
through the delivered durable sync. Every flag is required and may appear once.
The repo/issue/marker mapping is supplied by an already-authorized operator;
nothing is inferred or created. Supported statuses: VERIFYING, REVIEW, BLOCKED.
DONE is refused (no authenticated acceptance/delivery integration exists yet);
other statuses report NOT_PUBLISHABLE and launch no process. --factory-db must
be an existing ordinary file; --repository-root is the trusted checkout holding
the fixed entrypoint. Exit 0 means DELIVERED or NOT_PUBLISHABLE; read the
printed "outcome:" line, never the exit code alone.`;

const FLAGS = [
  "--factory-db",
  "--work-item",
  "--run-id",
  "--checkpoint",
  "--repo",
  "--issue",
  "--marker",
  "--state-dir",
  "--pwsh",
  "--repository-root",
] as const;
type Flag = (typeof FLAGS)[number];

export interface GithubSyncStatusArgs {
  readonly factoryDb: string;
  readonly workItemId: string;
  readonly runId: string;
  readonly checkpointPath: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly stableMarker: string;
  readonly stateDir: string;
  readonly pwshPath: string;
  readonly repositoryRoot: string;
}

const ID_RX = /^[A-Za-z0-9._:-]{1,128}$/;
const REPO_RX = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const MARKER_RX = /^[A-Za-z0-9._-]{1,128}$/;

function absolutePath(v: string): boolean {
  return v.length > 0 && v.length <= 4096 && isAbsolute(v) && !CONTROL_RX.test(v);
}

export function parseGithubSyncStatusArgs(
  args: readonly string[],
): { readonly ok: true; readonly value: GithubSyncStatusArgs } | { readonly ok: false; readonly error: string } {
  const seen = new Map<Flag, string>();
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    if (!(FLAGS as readonly string[]).includes(token)) {
      return { ok: false, error: `unexpected argument ${JSON.stringify(token)}` };
    }
    const flag = token as Flag;
    if (seen.has(flag)) return { ok: false, error: `duplicate option ${flag}` };
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, error: `option ${flag} requires a value` };
    }
    seen.set(flag, value);
    i += 1;
  }
  for (const flag of FLAGS) {
    if (!seen.has(flag)) return { ok: false, error: `${flag} is required` };
  }
  const get = (f: Flag): string => seen.get(f) as string;

  for (const f of ["--factory-db", "--checkpoint", "--state-dir", "--pwsh", "--repository-root"] as const) {
    if (!absolutePath(get(f))) return { ok: false, error: `${f} must be an absolute path` };
  }
  if (!ID_RX.test(get("--work-item"))) return { ok: false, error: "--work-item is not a valid id" };
  if (!ID_RX.test(get("--run-id"))) return { ok: false, error: "--run-id is not a valid id" };
  if (!REPO_RX.test(get("--repo"))) return { ok: false, error: "--repo must be owner/name" };
  if (!MARKER_RX.test(get("--marker"))) return { ok: false, error: "--marker is not a valid marker" };
  const issueText = get("--issue");
  const issueNumber = Number(issueText);
  if (!/^[1-9][0-9]{0,9}$/.test(issueText) || issueNumber > MAX_ISSUE) {
    return { ok: false, error: "--issue must be a positive integer" };
  }
  return {
    ok: true,
    value: {
      factoryDb: get("--factory-db"),
      workItemId: get("--work-item"),
      runId: get("--run-id"),
      checkpointPath: get("--checkpoint"),
      repo: get("--repo"),
      issueNumber,
      stableMarker: get("--marker"),
      stateDir: get("--state-dir"),
      pwshPath: get("--pwsh"),
      repositoryRoot: get("--repository-root"),
    },
  };
}

export interface GithubSyncStatusOptions {
  readonly log?: (line: string) => void;
  readonly error?: (line: string) => void;
  /** Test seam only; main.ts never passes it. Defaults to the existing NodeProcessRunner. */
  readonly processRunner?: ProcessRunner;
  readonly env?: NodeJS.ProcessEnv;
}

interface Snapshot {
  readonly status: string;
  readonly specRevision: number;
  readonly runStatus: string;
}

/** Exit codes: 0 DELIVERED/NOT_PUBLISHABLE; 1 refusal before launch; 2 PENDING; 3 LOCKED; 4 STALE; 5 durable REFUSED; 6 transport/process failure; 7 projection/request refused. */
export async function runGithubSyncStatus(
  args: GithubSyncStatusArgs,
  options: GithubSyncStatusOptions = {},
): Promise<number> {
  const log = options.log ?? ((): void => {});
  const error = options.error ?? ((): void => {});
  const refuse = (message: string): number => {
    error(`outcome: PRECHECK_REFUSED — ${boundedDiagnostic(message)}`);
    return 1;
  };

  // Never create a database: it must already be an ordinary file.
  try {
    if (!lstatSync(args.factoryDb).isFile()) return refuse("--factory-db is not an ordinary file");
  } catch {
    return refuse("--factory-db does not exist");
  }

  let checkpointTaskId: unknown;
  try {
    const stat = lstatSync(args.checkpointPath);
    if (!stat.isFile() || stat.size > MAX_CHECKPOINT_BYTES) return refuse("--checkpoint is not a bounded ordinary file");
    const doc = JSON.parse(readFileSync(args.checkpointPath, "utf8")) as { currentActiveWork?: { id?: unknown } };
    checkpointTaskId = doc?.currentActiveWork?.id;
  } catch {
    return refuse("--checkpoint is missing or not readable JSON");
  }

  let snapshot: { item: Awaited<ReturnType<FactoryService["getWorkItem"]>> } | undefined;
  let precheckError: string | undefined;
  const store = createSqliteStore(args.factoryDb);
  try {
    const factory = new FactoryService({
      store,
      clock: systemClock,
      ids: createRandomIdGenerator(),
      identityGate: createLocalHumanIdentityGate({ credential: CLI_CREDENTIAL, clock: systemClock }),
      workerRegistry: createLocalWorkerRegistry(systemClock),
    });
    const read = async (): Promise<Snapshot & { id: string }> => {
      let item;
      try {
        item = await factory.getWorkItem(args.workItemId);
      } catch {
        throw new Error("work item not found");
      }
      const run = (await factory.listRuns(item.id)).find((r) => r.id === args.runId);
      if (run === undefined || run.workItemId !== item.id) throw new Error("run does not belong to the work item");
      if (!item.runIds.includes(run.id)) throw new Error("run is not associated with the work item");
      if (run.specRevision !== item.specRevision) throw new Error("run is stale for the current spec revision");
      snapshot = { item };
      return { id: item.id, status: item.status, specRevision: item.specRevision, runStatus: run.status };
    };
    const first = await read();
    if (checkpointTaskId !== first.id) throw new Error("checkpoint currentActiveWork.id does not match the work item");
    const second = await read();
    if (second.id !== first.id || second.status !== first.status || second.specRevision !== first.specRevision || second.runStatus !== first.runStatus) {
      throw new Error("work item or run changed during the pre-launch recheck");
    }
  } catch (e) {
    precheckError = e instanceof Error ? e.message : "read failed";
  } finally {
    store.close();
  }
  if (precheckError !== undefined || snapshot === undefined) return refuse(precheckError ?? "read failed");
  const item = (snapshot as { item: { id: string; status: string; specRevision: number } }).item;

  if (item.status === "DONE") {
    error(
      "outcome: DONE_REFUSED — publishing DONE needs authenticated acceptance and delivery evidence; " +
        "that integration does not exist yet and caller-supplied references would carry no authority. Nothing was launched.",
    );
    return 1;
  }

  const outcome = await syncWorkItemStatus(
    {
      projectionInput: { taskId: item.id, status: item.status, specRevision: item.specRevision, runId: args.runId },
      checkpointPath: args.checkpointPath,
      mapping: { taskId: item.id, repo: args.repo, issueNumber: args.issueNumber, stableMarker: args.stableMarker },
      stateDir: args.stateDir,
    },
    {
      processRunner: options.processRunner ?? createNodeProcessRunner(),
      pwshPath: args.pwshPath,
      repositoryRoot: args.repositoryRoot,
      cwd: args.repositoryRoot,
      ...(options.env === undefined ? {} : { env: options.env }),
    },
  );
  return report(outcome, log, error);
}

function report(outcome: StatusSyncOutcome, log: (l: string) => void, error: (l: string) => void): number {
  switch (outcome.kind) {
    case "PROJECTION_REFUSED":
      error(`outcome: PROJECTION_REFUSED code=${outcome.code} (no process launched)`);
      return 7;
    case "REQUEST_INVALID":
      error(`outcome: REQUEST_INVALID code=${outcome.code} (no process launched)`);
      return 7;
    case "NOT_PUBLISHABLE":
      log(`outcome: NOT_PUBLISHABLE status=${outcome.status} (no process launched; nothing delivered)`);
      return 0;
    case "PROCESS_FAILURE":
      error(
        `outcome: PROCESS_FAILURE reason=${outcome.reason} exitCode=${outcome.exitCode ?? "none"} ` +
          `(delivery state unknown)${outcome.diagnostic.length > 0 ? ` diagnostic=${JSON.stringify(outcome.diagnostic)}` : ""}`,
      );
      return 6;
    case "SYNC_RESULT": {
      const r = outcome.result;
      const line =
        `outcome: ${r.status} code=${r.code} attempt=${r.attempt} replay=${r.replay} ` +
        `publicStatus=${outcome.publicStatus} nextAction=${outcome.nextAction} (projection, not authority)`;
      if (r.status === "DELIVERED") {
        log(line);
        return 0;
      }
      error(line);
      return r.status === "PENDING" ? 2 : r.status === "LOCKED" ? 3 : r.status === "STALE" ? 4 : 5;
    }
  }
}
