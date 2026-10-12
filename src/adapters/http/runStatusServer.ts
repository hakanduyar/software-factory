import type * as http from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { RunRepository } from "../../ports/repositories.js";
import type { Run } from "../../domain/run.js";

interface RunStatusServerOptions {
  runs: Pick<RunRepository, "findById"> & Partial<Pick<RunRepository, "listByWorkItem">>;
}

interface RunStatusDto {
  id: string;
  workItemId: string;
  role: string;
  status: string;
  startedAt: Run["startedAt"];
  finishedAt?: Run["finishedAt"];
}

function toDto(run: Run): RunStatusDto {
  const dto: RunStatusDto = {
    id: run.id,
    workItemId: run.workItemId,
    role: run.role,
    status: run.status,
    startedAt: run.startedAt,
  };
  if (run.finishedAt !== undefined) {
    dto.finishedAt = run.finishedAt;
  }
  return dto;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

type ParseTargetResult =
  | { kind: "run"; id: string }
  | { kind: "workItemRuns"; id: string }
  | { kind: "invalid" }
  | { kind: "notFound" };

const DECODE_FAILED: unique symbol = Symbol("decodeFailed");

function decodeSegment(segment: string | undefined): string | typeof DECODE_FAILED | undefined {
  if (segment === undefined) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return DECODE_FAILED;
  }
  return decoded.length === 0 ? undefined : decoded;
}

function parseTarget(rawUrl: string | undefined): ParseTargetResult {
  if (rawUrl === undefined) {
    return { kind: "invalid" };
  }
  if (rawUrl.includes("://") || rawUrl.startsWith("//")) {
    return { kind: "invalid" };
  }
  if (!rawUrl.startsWith("/")) {
    return { kind: "invalid" };
  }
  const queryIndex = rawUrl.indexOf("?");
  const fragmentIndex = rawUrl.indexOf("#");
  if (queryIndex !== -1 || fragmentIndex !== -1) {
    return { kind: "invalid" };
  }
  const runMatch = /^\/runs\/([^/]+)$/.exec(rawUrl);
  const itemMatch = runMatch === null ? /^\/work-items\/([^/]+)\/runs$/.exec(rawUrl) : null;
  const match = runMatch ?? itemMatch;
  if (match === null) {
    return { kind: "notFound" };
  }
  const decoded = decodeSegment(match[1]);
  if (decoded === DECODE_FAILED) {
    return { kind: "invalid" };
  }
  if (decoded === undefined) {
    return { kind: "notFound" };
  }
  return { kind: runMatch !== null ? "run" : "workItemRuns", id: decoded };
}

function isAuthorizedHost(req: http.IncomingMessage, server: http.Server): boolean {
  const address = server.address();
  if (address === null || typeof address === "string") {
    return false;
  }
  const expected = `127.0.0.1:${(address as AddressInfo).port}`;
  const rawHeaders = req.rawHeaders;
  const hostValues: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    if (name !== undefined && name.toLowerCase() === "host") {
      const value = rawHeaders[i + 1];
      if (value !== undefined) {
        hostValues.push(value);
      }
    }
  }
  if (hostValues.length !== 1) {
    return false;
  }
  return hostValues[0] === expected;
}

export function createRunStatusServer(options: RunStatusServerOptions): http.Server {
  const { runs } = options;

  const server: http.Server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.headers["origin"] !== undefined) {
          sendError(res, 403, "Forbidden");
          return;
        }

        if (!isAuthorizedHost(req, server)) {
          sendError(res, 403, "Forbidden");
          return;
        }

        if (req.method !== "GET") {
          res.setHeader("Allow", "GET");
          sendError(res, 405, "Method Not Allowed");
          return;
        }

        const rawUrl = req.url;
        const hasMalformedPercent = rawUrl !== undefined && /%(?![0-9a-fA-F]{2})/.test(rawUrl);
        if (hasMalformedPercent) {
          sendError(res, 400, "Bad Request");
          return;
        }

        const parsed = parseTarget(rawUrl);
        if (parsed.kind === "invalid") {
          sendError(res, 400, "Bad Request");
          return;
        }
        if (parsed.kind === "notFound") {
          sendError(res, 404, "Not Found");
          return;
        }

        if (parsed.kind === "workItemRuns") {
          if (runs.listByWorkItem === undefined) {
            sendError(res, 404, "Not Found");
            return;
          }
          let listed: readonly Run[];
          try {
            listed = await runs.listByWorkItem(parsed.id);
          } catch {
            sendError(res, 500, "Internal Server Error");
            return;
          }
          sendJson(res, 200, listed.map(toDto));
          return;
        }

        let run: Run | undefined;
        try {
          run = await runs.findById(parsed.id);
        } catch {
          sendError(res, 500, "Internal Server Error");
          return;
        }

        if (run === undefined) {
          sendError(res, 404, "Not Found");
          return;
        }

        sendJson(res, 200, toDto(run));
      } catch {
        sendError(res, 500, "Internal Server Error");
      }
    })();
  });

  return server;
}

export function listenRunStatusServer(server: http.Server, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      reject(new Error("Invalid port"));
      return;
    }

    const onError = (err: Error): void => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
      reject(err);
    };

    const onListening = (): void => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
      const address = server.address();
      if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
        reject(new Error("Unexpected server address"));
        return;
      }
      resolve(address);
    };

    server.once("error", onError);
    server.once("listening", onListening);

    try {
      server.listen(port, "127.0.0.1");
    } catch (err) {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
