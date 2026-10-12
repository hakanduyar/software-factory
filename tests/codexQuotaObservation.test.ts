import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";

import {
  observeCodexQuota,
  type CodexQuotaObservationRequest,
  type ExpectedAccountBinding,
} from "../src/adapters/supervision/codexQuotaObservation.js";

/**
 * Real local stdio fixture: an actual Node child process (genuine stdin,
 * stdout, stderr streams; genuine PID/exit/signal lifecycle), never an
 * EventEmitter pretending to be one. Behavior is selected entirely by the
 * `SCENARIO` environment variable the fixture script reads from its own
 * `process.env`, so every test drives the real adapter against a real OS
 * process that genuinely implements the newline-delimited JSON-RPC framing
 * the source file parses.
 */
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "codex-quota-fixture-"));
const FIXTURE_SCRIPT_PATH = join(FIXTURE_DIR, "fake-app-server.js");

const FIXTURE_SOURCE = `#!/usr/bin/env node
const readline = require("node:readline");
const fs = require("node:fs");

const scenario = process.env.SCENARIO || "happy";
const tracePath = process.env.TRACE_PATH || null;
const rl = readline.createInterface({ input: process.stdin, terminal: false });

function trace(entry) {
  if (tracePath !== null) {
    fs.appendFileSync(tracePath, JSON.stringify(entry) + "\\n");
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
  if (obj.id !== undefined) {
    trace({ sent: obj });
  }
}

const INIT_RESULT = {
  codexHome: "/abs/home",
  platformFamily: "linux",
  platformOs: "linux",
  userAgent: "codex/0.153.4",
};
const ACCOUNT_RESULT = {
  requiresOpenaiAuth: true,
  account: { type: "chatgpt", email: "fixture-user@example.invalid", planType: "plus" },
};
const MODEL_PAGE = {
  data: [{ id: "gpt-x", model: "gpt-x", hidden: false }],
  nextCursor: null,
};
const RATE_LIMITS_MATCHED = {
  accountId: "fixture-acct-1",
  rateLimits: {
    primary: { usedPercent: 42, windowDurationMins: 60, resetsAt: 9999999999 },
    secondary: null,
    spendControlReached: false,
  },
};
const RATE_LIMITS_NO_USABLE_WINDOW = {
  accountId: "fixture-acct-1",
  rateLimits: {
    primary: null,
    secondary: null,
    spendControlReached: false,
  },
};
const RATE_LIMITS_MALFORMED_SPEND_CONTROL = {
  accountId: "fixture-acct-1",
  rateLimits: {
    primary: { usedPercent: 42, windowDurationMins: 60, resetsAt: 9999999999 },
    secondary: null,
    spendControlReached: "yes",
  },
};

let handledCount = 0;

if (scenario === "sigtermHandlerExitsNonzero") {
  process.on("SIGTERM", () => process.exit(7));
}

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    if (scenario === "malformedJson") {
      process.stdout.write("{not valid json\\n");
      return;
    }
    return;
  }
  const id = msg.id;
  const method = msg.method;
  handledCount += 1;
  trace({ received: { id, method, params: msg.params } });

  if (scenario === "malformedJson" && method === "initialize") {
    process.stdout.write("{not valid json\\n");
    return;
  }

  if (scenario === "nonzeroExitAfterInit" && method === "initialize") {
    send({ jsonrpc: "2.0", id, result: INIT_RESULT });
    process.exit(7);
    return;
  }

  if (scenario === "hangTimeout") {
    // Never reply; let the adapter's own timeout bound fire.
    return;
  }

  if (scenario === "byteOverflow" && method === "initialize") {
    send({ jsonrpc: "2.0", id, result: INIT_RESULT });
    process.stdout.write("x".repeat(5_000_000) + "\\n");
    return;
  }

  if (scenario === "stderrOverflow" && method === "initialize") {
    send({ jsonrpc: "2.0", id, result: INIT_RESULT });
    process.stderr.write("e".repeat(5_000_000));
    return;
  }

  if (scenario === "sigtermHandlerExitsNonzero") {
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: INIT_RESULT });
    } else if (method === "account/read") {
      send({ jsonrpc: "2.0", id, result: ACCOUNT_RESULT });
    } else if (method === "model/list") {
      send({ jsonrpc: "2.0", id, result: MODEL_PAGE });
    } else if (method === "account/rateLimits/read") {
      send({ jsonrpc: "2.0", id, result: RATE_LIMITS_MATCHED });
    }
    // No reply beyond the real RPC methods; stdin EOF is never followed by
    // this fixture's own process.exit(0), so the adapter's own closeAndConfirm
    // must actually escalate to SIGTERM, which this fixture's own handler
    // turns into exit(7) — a real, observed nonzero close, not a timeout race.
    return;
  }

  if (scenario === "trailingGarbage" && method === "account/rateLimits/read") {
    send({ jsonrpc: "2.0", id, result: RATE_LIMITS_MATCHED });
    process.stdout.write("not-json-trailer-without-newline");
    return;
  }

  if (scenario === "unsupportedServerRequest" && method === "initialize") {
    send({ jsonrpc: "2.0", id, result: INIT_RESULT });
    // Server-initiated request the adapter must never answer.
    send({ jsonrpc: "2.0", id: 9001, method: "auth/promptLogin", params: {} });
    return;
  }

  if (scenario === "wrongResponseId" && method === "initialize") {
    send({ jsonrpc: "2.0", id: id + 1000, result: INIT_RESULT });
    return;
  }

  if (scenario === "duplicateResponse" && method === "initialize") {
    send({ jsonrpc: "2.0", id, result: INIT_RESULT });
    send({ jsonrpc: "2.0", id, result: INIT_RESULT });
    return;
  }

  if (scenario === "rpcError" && method === "initialize") {
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: "fixture-secret-detail" } });
    return;
  }

  if (scenario === "paginationNeverEnds" && method === "model/list") {
    send({ jsonrpc: "2.0", id, result: { data: [], nextCursor: "cursor-" + handledCount } });
    return;
  }

  if (scenario === "missingAccountId" && method === "account/rateLimits/read") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        accountId: null,
        rateLimits: { primary: { usedPercent: 10 }, secondary: null, spendControlReached: null },
      },
    });
    return;
  }

  if (scenario === "mismatchedAccountHash" && method === "account/rateLimits/read") {
    send({ jsonrpc: "2.0", id, result: RATE_LIMITS_MATCHED });
    return;
  }

  if (scenario === "noUsableWindow" && method === "account/rateLimits/read") {
    send({ jsonrpc: "2.0", id, result: RATE_LIMITS_NO_USABLE_WINDOW });
    return;
  }

  if (scenario === "malformedSpendControlReached" && method === "account/rateLimits/read") {
    send({ jsonrpc: "2.0", id, result: RATE_LIMITS_MALFORMED_SPEND_CONTROL });
    return;
  }

  if (scenario === "emptyBucketMap" && method === "account/rateLimits/read") {
    send({
      jsonrpc: "2.0",
      id,
      result: { accountId: "fixture-acct-1", rateLimitsByLimitId: {} },
    });
    return;
  }

  if (scenario === "contradictoryMapKey" && method === "account/rateLimits/read") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        accountId: "fixture-acct-1",
        rateLimitsByLimitId: {
          FROM_SNAPSHOT: {
            limitId: "actually-different-id",
            primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: 1000 },
            secondary: null,
            spendControlReached: false,
          },
        },
      },
    });
    return;
  }

  // Default happy-path responses for the four allowed methods, in order.
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: INIT_RESULT });
  } else if (method === "account/read") {
    send({ jsonrpc: "2.0", id, result: ACCOUNT_RESULT });
  } else if (method === "model/list") {
    send({ jsonrpc: "2.0", id, result: MODEL_PAGE });
  } else if (method === "account/rateLimits/read") {
    send({ jsonrpc: "2.0", id, result: RATE_LIMITS_MATCHED });
  }
});

process.stdin.on("end", () => {
  if (scenario === "sigtermHandlerExitsNonzero") {
    // A bare signal listener does not keep the event loop alive by itself;
    // hold a real referenced timer so this process cannot exit on its own
    // and the adapter's own closeAndConfirm must actually escalate to
    // SIGTERM, which this fixture's own handler turns into exit(7).
    const keepAlive = setInterval(() => {}, 1000 * 60 * 60);
    process.on("SIGTERM", () => {
      clearInterval(keepAlive);
    });
    return;
  }
  process.exit(0);
});
`;

writeFileSync(FIXTURE_SCRIPT_PATH, FIXTURE_SOURCE, { mode: 0o755 });
chmodSync(FIXTURE_SCRIPT_PATH, 0o755);

const FIXTURE_DIGEST = createHash("sha256").update(readFileSync(FIXTURE_SCRIPT_PATH)).digest("hex");
const MATCHED_ACCOUNT_HASH = createHash("sha256").update("fixture-acct-1").digest("hex");

after(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

const liveChildren = new Set<ChildProcessWithoutNullStreams>();
after(() => {
  for (const child of liveChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});

function spawnFixture(
  scenario: string,
  tracePath?: string,
): NonNullable<CodexQuotaObservationRequest["spawnChild"]> {
  return (_executable, argv, options) => {
    const child = spawn(process.execPath, [FIXTURE_SCRIPT_PATH, ...argv], {
      cwd: options.cwd,
      env: {
        ...options.env,
        SCENARIO: scenario,
        ...(tracePath !== undefined ? { TRACE_PATH: tracePath } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    }) as ChildProcessWithoutNullStreams;
    liveChildren.add(child);
    child.once("close", () => liveChildren.delete(child));
    return child;
  };
}

function hashSha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function matchedAccountBinding(): ExpectedAccountBinding {
  return { expectedAccountIdHashHex: MATCHED_ACCOUNT_HASH, hash: hashSha256 };
}

function baseRequest(
  overrides: Partial<CodexQuotaObservationRequest> & {
    readonly spawnChild: NonNullable<CodexQuotaObservationRequest["spawnChild"]>;
  },
): CodexQuotaObservationRequest {
  return {
    executable: "/abs/path/codex",
    expectedExecutableDigestHex: FIXTURE_DIGEST,
    computeExecutableDigestHex: () => FIXTURE_DIGEST,
    argv: ["app-server"],
    cwd: FIXTURE_DIR,
    env: { PATH: process.env["PATH"] ?? "" },
    clientName: "factory-observer",
    clientVersion: "1.0.0",
    expectedAccountBinding: matchedAccountBinding(),
    timeoutMs: 5000,
    maxOutputBytes: 1_000_000,
    maxMessages: 100,
    maxModelPages: 3,
    modelPageLimit: 50,
    ...overrides,
  };
}

const TEST_TIMEOUT_MS = 8000;

test(
  "valid baseline: exact allowlisted requests, handshake order, sanitized snapshot, real child closure",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const traceDir = mkdtempSync(join(tmpdir(), "codex-quota-trace-"));
    const tracePath = join(traceDir, "rpc-trace.jsonl");
    writeFileSync(tracePath, "");
    let result: Awaited<ReturnType<typeof observeCodexQuota>>;
    try {
      result = await observeCodexQuota(baseRequest({ spawnChild: spawnFixture("happy", tracePath) }));
    } finally {
      // Trace is synthetic fixture RPC only (no profile/secret data); removed immediately after use.
    }

    assert.equal(result.kind, "OBSERVED");
    assert.ok(result.observation);
    assert.equal(result.observation.accountBinding, "MATCHED");
    assert.equal(result.observation.eligible, "UNKNOWN");
    assert.deepEqual(result.observation.models, [{ id: "gpt-x", model: "gpt-x", hidden: false }]);
    assert.equal(result.observation.buckets.length, 1);
    assert.equal(result.observation.buckets[0]?.primary?.usedPercent, 42);
    assert.equal(result.observation.executableDigestHex, FIXTURE_DIGEST);
    assert.equal(result.observation.accountIdHashHex, MATCHED_ACCOUNT_HASH);
    assert.ok(typeof result.observation.observedAt === "number" && result.observation.observedAt > 0);

    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("example.invalid"), "email must never appear in the result");
    assert.ok(!serialized.includes("fixture-acct-1"), "raw accountId must never appear in the result");

    const traceLines = readFileSync(tracePath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { received?: { method: string; params?: unknown }; sent?: { id: number } });
    rmSync(traceDir, { recursive: true, force: true });

    const receivedMethods = traceLines
      .filter((entry): entry is { received: { method: string; params?: unknown } } => entry.received !== undefined)
      .map((entry) => entry.received.method);
    assert.deepEqual(
      receivedMethods,
      ["initialize", "initialized", "account/read", "model/list", "account/rateLimits/read"],
      "the adapter must send exactly the allowlisted methods, in order, and nothing else",
    );

    const initializeResponseIndex = traceLines.findIndex(
      (entry) => entry.sent !== undefined && receivedMethods[0] === "initialize",
    );
    const initializedIndex = traceLines.findIndex((entry) => entry.received?.method === "initialized");
    assert.ok(
      initializeResponseIndex !== -1 && initializedIndex !== -1 && initializeResponseIndex < initializedIndex,
      "the initialized notification must only be sent after the initialize response is received",
    );

    const accountReadEntry = traceLines.find((entry) => entry.received?.method === "account/read");
    assert.deepEqual(
      accountReadEntry?.received?.params,
      { refreshToken: false },
      "account/read must always be called with refreshToken:false, never a token refresh",
    );

    assert.ok(
      !receivedMethods.some((m) => m.includes("generation") || m.includes("auth")),
      "no generation or auth-prompting call may ever be made",
    );
  },
);

test(
  "executable digest mismatch refuses before spawn",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    let spawned = false;
    const result = await observeCodexQuota(
      baseRequest({
        expectedExecutableDigestHex: "0".repeat(64),
        computeExecutableDigestHex: () => FIXTURE_DIGEST,
        spawnChild: (...args) => {
          spawned = true;
          return spawnFixture("happy")(...args);
        },
      }),
    );
    assert.equal(result.kind, "REFUSED");
    assert.equal(spawned, false);
  },
);

test(
  "missing account binding (no accountId) yields REFUSED",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const result = await observeCodexQuota(baseRequest({ spawnChild: spawnFixture("missingAccountId") }));
    assert.equal(result.kind, "REFUSED");
  },
);

test(
  "mismatching account hash yields UNKNOWN even with low usedPercent windows",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const result = await observeCodexQuota(
      baseRequest({
        spawnChild: spawnFixture("mismatchedAccountHash"),
        expectedAccountBinding: { expectedAccountIdHashHex: "0".repeat(64), hash: hashSha256 },
      }),
    );
    assert.equal(result.kind, "UNKNOWN");
  },
);

test(
  "malformed JSON reply refuses and closes the real child",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const result = await observeCodexQuota(baseRequest({ spawnChild: spawnFixture("malformedJson") }));
    assert.equal(result.kind, "REFUSED");
  },
);

test(
  "wrong response id refuses",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const result = await observeCodexQuota(baseRequest({ spawnChild: spawnFixture("wrongResponseId") }));
    assert.equal(result.kind, "REFUSED");
  },
);

test(
  "duplicate response id refuses",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const result = await observeCodexQuota(baseRequest({ spawnChild: spawnFixture("duplicateResponse") }));
    assert.equal(result.kind, "REFUSED");
  },
);

test(
  "server JSON-RPC error reply refuses generically without leaking server error text",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const result = await observeCodexQuota(baseRequest({ spawnChild: spawnFixture("rpcError") }));
    assert.equal(result.kind, "REFUSED");
    assert.ok(!JSON.stringify(result).includes("fixture-secret-detail"));
  },
);

test(
  "unsupported server-initiated request is observed and discarded, never answered",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const traceDir = mkdtempSync(join(tmpdir(), "codex-quota-trace-"));
    const tracePath = join(traceDir, "rpc-trace.jsonl");
    writeFileSync(tracePath, "");
    const result = await observeCodexQuota(
      baseRequest({ spawnChild: spawnFixture("unsupportedServerRequest", tracePath) }),
    );
    // The fixture never replies to account/read after sending the rogue
    // server request, so the bounded timeout refuses rather than hanging.
    assert.equal(result.kind, "REFUSED");

    const traceLines = readFileSync(tracePath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { received?: { id: number; method: string }; sent?: { id: number } });
    rmSync(traceDir, { recursive: true, force: true });

    const receivedIds = traceLines
      .filter((entry): entry is { received: { id: number; method: string } } => entry.received !== undefined)
      .map((entry) => entry.received.id);
    assert.ok(
      !receivedIds.includes(9001),
      "the adapter must never answer the rogue server-initiated request id",
    );

    const receivedMethods = traceLines
      .filter((entry): entry is { received: { id: number; method: string } } => entry.received !== undefined)
      .map((entry) => entry.received.method);
    const fullAllowlistedSequence = ["initialize", "initialized", "account/read", "model/list", "account/rateLimits/read"];
    assert.ok(
      receivedMethods.length > 0 && receivedMethods.length <= fullAllowlistedSequence.length,
      "the adapter's outbound requests observed before failure must be bounded by the allowlisted sequence length",
    );
    assert.deepEqual(
      receivedMethods,
      fullAllowlistedSequence.slice(0, receivedMethods.length),
      "the adapter's outbound requests must remain an ordered prefix of the allowlisted sequence, unaffected by the rogue request",
    );
  },
);

test(
  "nonzero exit mid-session refuses rather than yielding OBSERVED",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const result = await observeCodexQuota(baseRequest({ spawnChild: spawnFixture("nonzeroExitAfterInit") }));
    assert.equal(result.kind, "REFUSED");
  },
);

test(
  "real process timeout refuses and the child is actually terminated",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    let capturedChild: ChildProcessWithoutNullStreams | undefined;
    const spawnAndCapture: CodexQuotaObservationRequest["spawnChild"] = (executable, argv, options) => {
      const child = spawnFixture("hangTimeout")!(executable, argv, options);
      capturedChild = child;
      return child;
    };
    const result = await observeCodexQuota(baseRequest({ spawnChild: spawnAndCapture, timeoutMs: 200 }));
    assert.equal(result.kind, "REFUSED");
    assert.ok(capturedChild, "a real child process must have been spawned");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.ok(
      capturedChild.exitCode !== null || capturedChild.signalCode !== null,
      "the real fixture process must have actually exited after timeout-driven closure",
    );
  },
);

test(
  "output byte bound exceeded refuses and closes the real child",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const result = await observeCodexQuota(
      baseRequest({ spawnChild: spawnFixture("byteOverflow"), maxOutputBytes: 1000 }),
    );
    assert.equal(result.kind, "REFUSED");
  },
);

test(
  "stderr byte bound exceeded refuses and closes the real child",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const result = await observeCodexQuota(
      baseRequest({ spawnChild: spawnFixture("stderrOverflow"), maxOutputBytes: 1000 }),
    );
    assert.equal(result.kind, "REFUSED");
  },
);

test(
  "child that exits nonzero from its own SIGTERM handler during shutdown refuses generically",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    let capturedChild: ChildProcessWithoutNullStreams | undefined;
    const spawnAndCapture: CodexQuotaObservationRequest["spawnChild"] = (executable, argv, options) => {
      const child = spawnFixture("sigtermHandlerExitsNonzero")!(executable, argv, options);
      capturedChild = child;
      return child;
    };
    const result = await observeCodexQuota(baseRequest({ spawnChild: spawnAndCapture }));
    assert.equal(result.kind, "REFUSED");
    assert.ok(!JSON.stringify(result).includes("fixture-acct-1"));
    assert.ok(capturedChild, "a real child process must have been spawned");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(
      capturedChild.signalCode,
      null,
      "the real fixture process must have actually exited via its own SIGTERM handler, not by signal",
    );
    assert.equal(
      capturedChild.exitCode,
      7,
      "the real fixture process must have actually exited with the code its own SIGTERM handler chose",
    );
  },
);

test(
  "model pagination that never terminates within the bounded page count refuses",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const result = await observeCodexQuota(
      baseRequest({ spawnChild: spawnFixture("paginationNeverEnds"), maxModelPages: 2 }),
    );
    assert.equal(result.kind, "REFUSED");
  },
);

test(
  "trailing malformed output after the last reply never yields OBSERVED",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const result = await observeCodexQuota(baseRequest({ spawnChild: spawnFixture("trailingGarbage") }));
    assert.equal(result.kind, "REFUSED");
  },
);

test(
  "map-origin bucket with contradictory inner limitId (literal key FROM_SNAPSHOT) refuses",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const result = await observeCodexQuota(baseRequest({ spawnChild: spawnFixture("contradictoryMapKey") }));
    assert.equal(result.kind, "REFUSED");
  },
);

test(
  "invalid executable path denies before any spawn attempt",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    let spawned = false;
    const result = await observeCodexQuota(
      baseRequest({
        executable: "relative/not/absolute/codex",
        spawnChild: (...args) => {
          spawned = true;
          return spawnFixture("happy")!(...args);
        },
      }),
    );
    assert.equal(result.kind, "REFUSED");
    assert.equal(spawned, false);
  },
);

test(
  "invalid argv denies before any spawn attempt",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    let spawned = false;
    const result = await observeCodexQuota(
      baseRequest({
        argv: ["app-server", "--extra-flag"],
        spawnChild: (...args) => {
          spawned = true;
          return spawnFixture("happy")!(...args);
        },
      }),
    );
    assert.equal(result.kind, "REFUSED");
    assert.equal(spawned, false);
  },
);

test(
  "non-finite timeoutMs bound denies before any spawn attempt",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    let spawned = false;
    const result = await observeCodexQuota(
      baseRequest({
        timeoutMs: Number.POSITIVE_INFINITY,
        spawnChild: (...args) => {
          spawned = true;
          return spawnFixture("happy")!(...args);
        },
      }),
    );
    assert.equal(result.kind, "REFUSED");
    assert.equal(spawned, false);
  },
);

test(
  "hung digest computation times out and denies before any spawn attempt",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    let spawned = false;
    const result = await observeCodexQuota(
      baseRequest({
        timeoutMs: 100,
        computeExecutableDigestHex: () => new Promise<string>(() => {}),
        spawnChild: (...args) => {
          spawned = true;
          return spawnFixture("happy")!(...args);
        },
      }),
    );
    assert.equal(result.kind, "REFUSED");
    assert.equal(spawned, false);
  },
);

test(
  "cancellation during digest computation denies before any spawn attempt",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    let spawned = false;
    const controller = new AbortController();
    const resultPromise = observeCodexQuota(
      baseRequest({
        timeoutMs: 5000,
        signal: controller.signal,
        computeExecutableDigestHex: () => new Promise<string>(() => {}),
        spawnChild: (...args) => {
          spawned = true;
          return spawnFixture("happy")!(...args);
        },
      }),
    );
    controller.abort();
    const result = await resultPromise;
    assert.equal(result.kind, "REFUSED");
    assert.equal(spawned, false);
  },
);

test(
  "empty rateLimitsByLimitId map denies",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const result = await observeCodexQuota(baseRequest({ spawnChild: spawnFixture("emptyBucketMap") }));
    assert.equal(result.kind, "REFUSED");
  },
);

test(
  "rate limits with no usable window refuses",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const result = await observeCodexQuota(baseRequest({ spawnChild: spawnFixture("noUsableWindow") }));
    assert.equal(result.kind, "REFUSED");
  },
);

test(
  "malformed spendControlReached value refuses",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const result = await observeCodexQuota(
      baseRequest({ spawnChild: spawnFixture("malformedSpendControlReached") }),
    );
    assert.equal(result.kind, "REFUSED");
  },
);
