/**
 * Operator lifecycle for `sf serve runs`. Nothing runs on import; the future
 * `main.ts` hook calls `runServeRuns`. The listener is always loopback, via the
 * accepted persisted run status composition. Output is one JSON line with the
 * bound address; errors are generic so no path, input or raw error leaks.
 *
 * Stop sources: SIGINT, SIGTERM (POSIX / console Ctrl+C) and, only when
 * `--shutdown-on-stdin-eof` is given, end of stdin. A stop requested before
 * startup finishes is latched and honoured once the server is up.
 */

import { startPersistedRunStatusServer } from "../adapters/http/persistedRunStatusServer.js";

const USAGE =
  "usage: sf serve runs --db <path> --port <0..65535> [--shutdown-on-stdin-eof]\n";

type ServeRunsArgs = { dbPath: string; port: number; shutdownOnStdinEof: boolean };

function parseArgs(args: readonly string[]): ServeRunsArgs | undefined {
  let dbPath: string | undefined;
  let port: number | undefined;
  let shutdownOnStdinEof = false;
  const isFlag = (value: string | undefined): boolean =>
    value === "--db" || value === "--port" || value === "--shutdown-on-stdin-eof";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--db") {
      const value = args[++i];
      if (dbPath !== undefined || value === undefined || isFlag(value)) return undefined;
      if (value.trim() === "") return undefined;
      dbPath = value;
    } else if (arg === "--port") {
      const value = args[++i];
      if (port !== undefined || value === undefined || !/^\d{1,5}$/.test(value)) {
        return undefined;
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) return undefined;
      port = parsed;
    } else if (arg === "--shutdown-on-stdin-eof") {
      if (shutdownOnStdinEof) return undefined;
      shutdownOnStdinEof = true;
    } else {
      return undefined;
    }
  }
  if (dbPath === undefined || port === undefined) return undefined;
  return { dbPath, port, shutdownOnStdinEof };
}

export async function runServeRuns(args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }

  // Frozen before startup so an early stop is latched, never lost.
  let requestStop!: () => void;
  const stopRequested = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  const onStop = (): void => requestStop();

  const signals = ["SIGINT", "SIGTERM"] as const;
  const stdin = process.stdin;
  let stdinAttached = false;

  try {
    for (const signal of signals) process.on(signal, onStop);
    if (parsed.shutdownOnStdinEof) {
      stdin.on("end", onStop);
      stdin.on("close", onStop);
      stdin.on("error", onStop);
      stdinAttached = true;
      stdin.resume();
    }

    let server: Awaited<ReturnType<typeof startPersistedRunStatusServer>>;
    try {
      server = await startPersistedRunStatusServer({
        dbPath: parsed.dbPath,
        port: parsed.port,
      });
    } catch {
      process.stderr.write("serve runs: failed to start\n");
      return 1;
    }

    // Printed even when a stop is already latched so a supervisor can observe
    // the address before the clean shutdown.
    process.stdout.write(
      `${JSON.stringify({
        address: server.address.address,
        port: server.address.port,
        family: server.address.family,
      })}\n`,
    );

    await stopRequested;
    try {
      await server.close();
    } catch {
      process.stderr.write("serve runs: failed to close cleanly\n");
      return 1;
    }
    return 0;
  } finally {
    for (const signal of signals) process.removeListener(signal, onStop);
    if (stdinAttached) {
      stdin.removeListener("end", onStop);
      stdin.removeListener("close", onStop);
      stdin.removeListener("error", onStop);
      stdin.pause();
    }
  }
}
