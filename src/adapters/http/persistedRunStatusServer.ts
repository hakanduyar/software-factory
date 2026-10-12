/**
 * Composition of the read-only SQLite Run ledger with the loopback run status
 * server. The caller supplies the database path and port; nothing starts on
 * import. Only `address` and `close` are exposed — never the ledger or server.
 */

import type { AddressInfo } from "node:net";

import { openReadonlyRunLedger } from "../sqlite/readonlyRunLedger.js";
import { createRunStatusServer, listenRunStatusServer } from "./runStatusServer.js";

export async function startPersistedRunStatusServer(options: {
  dbPath: string;
  port: number;
}): Promise<{ address: AddressInfo; close(): Promise<void> }> {
  const ledger = openReadonlyRunLedger(options.dbPath);
  let server: ReturnType<typeof createRunStatusServer> | undefined;

  let address: AddressInfo;
  try {
    server = createRunStatusServer({ runs: ledger.runs });
    address = await listenRunStatusServer(server, options.port);
  } catch (error) {
    // Startup failed: close a live listener first (awaited), then always the
    // ledger. A cleanup failure must not mask the genuine startup error.
    if (server?.listening === true) {
      try {
        await new Promise<void>((resolve, reject) => {
          server!.close((err) => (err === undefined ? resolve() : reject(err)));
          server!.closeIdleConnections();
        });
      } catch {
        // ignore: original error is reported
      }
    }
    try {
      ledger.close();
    } catch {
      // ignore: original error is reported
    }
    throw error;
  }
  const startedServer = server;

  let closing: Promise<void> | undefined;

  const closeOnce = async (): Promise<void> => {
    try {
      await new Promise<void>((resolve, reject) => {
        startedServer.close((err) => (err === undefined ? resolve() : reject(err)));
        startedServer.closeIdleConnections();
      });
    } finally {
      ledger.close();
    }
  };

  return {
    address,
    close(): Promise<void> {
      closing ??= closeOnce();
      return closing;
    },
  };
}
