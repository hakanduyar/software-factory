/**
 * TASK-011 — EXECUTOR_ISOLATION.
 *
 * The gap TASK-006 could not close from inside itself (F5-FIN-3, F6-FIN-2): the
 * financial gate authorises a LAUNCH and cannot police what in-process executor
 * code does afterwards.
 *
 * These drive REAL child processes through the REAL adapter. A test that mocked
 * the spawn would be testing the mock — and the entire claim here is about what
 * happens in another process, which a mock cannot demonstrate.
 *
 * Offline: no provider is contacted, no model is invoked, no money can be spent.
 * The isolation under test is precisely what makes the last clause true.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  createIsolatedExecutor,
  ISOLATED_EXECUTOR_ENV_ALLOWLIST,
} from "../src/adapters/supervision/isolatedExecutor.js";
import {
  buildExecutorRequest,
  parseExecutorResponse,
  EXECUTOR_PROTOCOL_VERSION,
} from "../src/supervision/executorProtocol.js";
import type { RoadmapItem } from "../src/supervision/supervisorTypes.js";
import type { WorkExecutionInput } from "../src/supervision/supervisorPorts.js";

const created: string[] = [];
after(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true });
});

const REAL_CHILD = join(process.cwd(), "dist/src/cli/isolatedExecutorChild.js");

const ITEM: RoadmapItem = {
  key: "DETERMINISTIC_THING",
  title: "Run the deterministic step",
  dependsOn: [],
  status: "ELIGIBLE",
  workClass: "DETERMINISTIC",
  order: 1,
};

const INPUT: WorkExecutionInput = { item: ITEM, actionId: "DETERMINISTIC_THING:RUN_DETERMINISTIC_WORK:a1" };

/** Writes a throwaway child script and returns its path. */
function childScript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-exec-child-"));
  created.push(dir);
  const path = join(dir, "child.mjs");
  writeFileSync(path, body);
  return path;
}

// =====================================================================
// AC-1, AC-2 — another process, and an environment with no credentials
// =====================================================================

describe("TASK-011 AC-1/AC-2: the executor runs elsewhere, without credentials", () => {
  it("runs in a DIFFERENT process from the supervisor", async () => {
    const script = childScript(
      `import { readFileSync } from "node:fs";
       JSON.parse(readFileSync(process.argv[2], "utf8"));
       process.stdout.write(JSON.stringify({
         protocol: ${EXECUTOR_PROTOCOL_VERSION},
         outcome: { kind: "COMPLETED", detail: "pid " + process.pid },
       }));`,
    );
    const executor = createIsolatedExecutor({ childScript: script, timeoutMs: 30_000 });
    const outcome = await executor.execute(INPUT);

    assert.equal(outcome.kind, "COMPLETED");
    if (outcome.kind === "COMPLETED") {
      const reported = Number(outcome.detail.replace("pid ", ""));
      assert.ok(Number.isInteger(reported), `expected a pid, got ${outcome.detail}`);
      assert.notEqual(reported, process.pid, "the executor ran in the supervisor's own process");
    }
  });

  /**
   * The central claim of the task. A secret in the PARENT's environment must
   * not be visible to the child — asserted by having the child report its own
   * environment back, rather than by inspecting the allowlist, which would be
   * testing the list against itself.
   */
  it("does not forward a secret planted in the parent environment", async () => {
    const script = childScript(
      `import { readFileSync } from "node:fs";
       JSON.parse(readFileSync(process.argv[2], "utf8"));
       process.stdout.write(JSON.stringify({
         protocol: ${EXECUTOR_PROTOCOL_VERSION},
         outcome: { kind: "COMPLETED", detail: Object.keys(process.env).sort().join(",") },
       }));`,
    );
    const executor = createIsolatedExecutor({
      childScript: script,
      timeoutMs: 30_000,
      sourceEnv: {
        ...process.env,
        ANTHROPIC_API_KEY: "sk-ant-api03-PLANTED-SECRET-VALUE-000000000000",
        OPENAI_API_KEY: "sk-proj-PLANTED-SECRET-VALUE-000000000000",
        HOME: "/home/should-not-be-forwarded",
        CODEX_HOME: "/home/should-not-be-forwarded/.codex",
      },
    });
    const outcome = await executor.execute(INPUT);

    assert.equal(outcome.kind, "COMPLETED");
    if (outcome.kind === "COMPLETED") {
      const names = outcome.detail.split(",");
      for (const forbidden of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
        assert.ok(!names.includes(forbidden), `${forbidden} reached the child`);
      }
      // ...and the credential-store paths, which are what make billing possible.
      for (const forbidden of ["HOME", "CODEX_HOME"]) {
        assert.ok(!names.includes(forbidden), `${forbidden} reached the child, so a provider CLI could authenticate`);
      }
      assert.ok(names.includes("PATH"), "PATH is needed for the child to run at all");
    }
  });

  /**
   * The allowlist difference between a WORKER and an EXECUTOR is the isolation.
   * Pinned so a later tidy-up cannot merge the two lists and silently hand the
   * executor a credential store back.
   */
  it("keeps the executor allowlist free of credential-store paths", () => {
    for (const forbidden of ["HOME", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
      assert.ok(
        !ISOLATED_EXECUTOR_ENV_ALLOWLIST.includes(forbidden),
        `${forbidden} must not be in the isolated allowlist: it is how a provider CLI finds its credentials`,
      );
    }
  });
});

// =====================================================================
// AC-3 — the child is given only what it needs
// =====================================================================

describe("TASK-011 AC-3: a bounded request, and nothing else", () => {
  it("sends only the declared fields", () => {
    const request = buildExecutorRequest(INPUT) as unknown as Record<string, unknown>;
    assert.deepEqual(Object.keys(request).sort(), ["actionId", "item", "protocol"]);
  });

  /**
   * Constructed field by field rather than spread: a caller's extra property
   * must not ride across the boundary just because it was on the object.
   */
  it("does not forward an unexpected field the caller happened to carry", () => {
    const contaminated = {
      ...INPUT,
      databasePath: "/home/hakanduyar/.factory/supervisor.db",
      financialPolicy: { autonomousSpendAllowed: true, autonomousSpendLimit: 999 },
    } as unknown as WorkExecutionInput;
    const request = buildExecutorRequest(contaminated) as unknown as Record<string, unknown>;

    assert.ok(!("databasePath" in request), "the child was handed the database path");
    assert.ok(!("financialPolicy" in request), "the child was handed the financial policy");
  });
});

// =====================================================================
// AC-4, AC-5 — the child's output is untrusted, and grants nothing
// =====================================================================

describe("TASK-011 AC-4: a child's response is parsed, not believed", () => {
  const refusals: readonly (readonly [string, string])[] = [
    ["nothing at all", ""],
    ["not JSON", "this is not json"],
    ["a JSON array", "[]"],
    ["an object with no outcome", `{"protocol":${EXECUTOR_PROTOCOL_VERSION}}`],
    ["a wrong protocol version", `{"protocol":999,"outcome":{"kind":"COMPLETED","detail":"x"}}`],
    ["an unknown outcome kind", `{"protocol":${EXECUTOR_PROTOCOL_VERSION},"outcome":{"kind":"PROFIT"}}`],
    ["COMPLETED with no detail", `{"protocol":${EXECUTOR_PROTOCOL_VERSION},"outcome":{"kind":"COMPLETED"}}`],
    [
      "CHANGES_REQUIRED with non-string findings",
      `{"protocol":${EXECUTOR_PROTOCOL_VERSION},"outcome":{"kind":"CHANGES_REQUIRED","findings":[1,2]}}`,
    ],
  ];

  for (const [label, payload] of refusals) {
    it(`REFUSES ${label}`, () => {
      const parsed = parseExecutorResponse(payload);
      assert.equal(parsed.ok, false, `${label} was accepted`);
    });
  }

  it("accepts a well-formed COMPLETED", () => {
    const parsed = parseExecutorResponse(
      `{"protocol":${EXECUTOR_PROTOCOL_VERSION},"outcome":{"kind":"COMPLETED","detail":"done"}}`,
    );
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.outcome.kind, "COMPLETED");
  });

  /**
   * AC-5, and the reason the format is shaped this way: CHECKPOINT writes
   * durable state and HUMAN_REQUIRED hands the financial gate an action. Both
   * would let an untrusted process mint something the supervisor must own.
   */
  it("REFUSES outcomes that would let a child mint supervisor state", () => {
    for (const kind of ["CHECKPOINT", "HUMAN_REQUIRED"]) {
      const parsed = parseExecutorResponse(
        `{"protocol":${EXECUTOR_PROTOCOL_VERSION},"outcome":{"kind":"${kind}","detail":"x","action":{},"checkpoint":{}}}`,
      );
      assert.equal(parsed.ok, false, `${kind} was accepted from a child`);
      if (!parsed.ok) assert.match(parsed.reason, /may not report/);
    }
  });

  it("has no field through which a child could grant spending authority", () => {
    const parsed = parseExecutorResponse(
      `{"protocol":${EXECUTOR_PROTOCOL_VERSION},"outcome":{"kind":"COMPLETED","detail":"ok",` +
        `"autonomousSpendAllowed":true,"autonomousSpendLimit":9999,"billingMode":"INCLUDED_SUBSCRIPTION"}}`,
    );
    assert.equal(parsed.ok, true, "the extra fields should simply be ignored, not fail");
    if (parsed.ok) {
      const asRecord = parsed.outcome as unknown as Record<string, unknown>;
      assert.ok(!("autonomousSpendAllowed" in asRecord));
      assert.ok(!("autonomousSpendLimit" in asRecord));
      assert.ok(!("billingMode" in asRecord));
    }
  });
});

// =====================================================================
// AC-6, AC-7 — every abnormal path produces a definite outcome
// =====================================================================

describe("TASK-011 AC-6/AC-7: nothing hangs, nothing is assumed successful", () => {
  async function outcomeFor(body: string, timeoutMs = 5_000) {
    const executor = createIsolatedExecutor({ childScript: childScript(body), timeoutMs });
    return executor.execute(INPUT);
  }

  it("a child that CRASHES fails closed", async () => {
    const outcome = await outcomeFor(`throw new Error("boom");`);
    assert.equal(outcome.kind, "RESOURCE_FAILURE");
    if (outcome.kind === "RESOURCE_FAILURE") {
      assert.equal(outcome.process.terminationReason, "EXITED");
      assert.notEqual(outcome.process.exitCode, 0);
    }
  });

  it("a child that exits NON-ZERO fails closed", async () => {
    const outcome = await outcomeFor(`process.exit(3);`);
    assert.equal(outcome.kind, "RESOURCE_FAILURE");
    if (outcome.kind === "RESOURCE_FAILURE") assert.equal(outcome.process.exitCode, 3);
  });

  /** Exit 0 is not success: an empty response is still unusable. */
  it("a child that exits ZERO having written nothing fails closed", async () => {
    const outcome = await outcomeFor(`process.exit(0);`);
    assert.equal(outcome.kind, "RESOURCE_FAILURE");
    if (outcome.kind === "RESOURCE_FAILURE") {
      assert.match(outcome.process.stderr, /unusable response/);
    }
  });

  it("a child that writes GARBAGE fails closed", async () => {
    const outcome = await outcomeFor(`process.stdout.write("definitely not json"); process.exit(0);`);
    assert.equal(outcome.kind, "RESOURCE_FAILURE");
    if (outcome.kind === "RESOURCE_FAILURE") assert.match(outcome.process.stderr, /unusable response/);
  });

  it("a child that HANGS is timed out and reported as such", async () => {
    const started = Date.now();
    const outcome = await outcomeFor(`setInterval(() => {}, 1000);`, 1_500);
    const elapsed = Date.now() - started;

    assert.equal(outcome.kind, "RESOURCE_FAILURE");
    if (outcome.kind === "RESOURCE_FAILURE") {
      assert.equal(outcome.process.terminationReason, "TIMEOUT");
      assert.match(outcome.process.stderr, /timed out after 1500ms/);
    }
    assert.ok(elapsed < 10_000, `the timeout did not fire promptly: ${elapsed}ms`);
  });

  /**
   * AC-7 — a child that ignores SIGTERM must not outlive the wait. The parent
   * escalates to SIGKILL, so this returns rather than hanging on a child that
   * refuses to die politely.
   */
  it("a child that IGNORES SIGTERM is still terminated", async () => {
    const outcome = await outcomeFor(
      `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`,
      1_500,
    );
    assert.equal(outcome.kind, "RESOURCE_FAILURE");
    if (outcome.kind === "RESOURCE_FAILURE") assert.equal(outcome.process.terminationReason, "TIMEOUT");
  });

  /**
   * Written with `setInterval` rather than a `for (;;)` loop, deliberately.
   *
   * The tight synchronous version NEVER YIELDS, so node buffers the writes
   * inside the CHILD and not one byte reaches the parent — the run timed out
   * having exercised nothing, while appearing to test the overflow guard. A
   * flood only reaches the parent if the child returns to its event loop.
   */
  it("a child that FLOODS stdout is cut off rather than exhausting memory", async () => {
    const outcome = await outcomeFor(
      `const chunk = "x".repeat(100000);
       setInterval(() => { for (let i = 0; i < 20; i += 1) process.stdout.write(chunk); }, 1);`,
      20_000,
    );
    assert.equal(outcome.kind, "RESOURCE_FAILURE");
    if (outcome.kind === "RESOURCE_FAILURE") {
      assert.match(outcome.process.stderr, /exceeded/, "the flood must be cut off, not merely timed out");
      assert.equal(outcome.process.stdout, "", "the oversized response must not be carried forward");
    }
  });

  it("a child that cannot be SPAWNED fails closed", async () => {
    const executor = createIsolatedExecutor({
      childScript: "/nonexistent/child.mjs",
      timeoutMs: 5_000,
      nodePath: "/nonexistent/node-binary",
    });
    const outcome = await executor.execute(INPUT);
    assert.equal(outcome.kind, "RESOURCE_FAILURE");
    if (outcome.kind === "RESOURCE_FAILURE") assert.equal(outcome.process.terminationReason, "SPAWN_ERROR");
  });
});

// =====================================================================
// AC-8 — nothing secret survives the boundary
// =====================================================================

describe("TASK-011 AC-8: a child's output is redacted before it goes anywhere", () => {
  it("redacts a credential the child prints", async () => {
    const leak = "sk-ant-api03-CHILDLEAKCHILDLEAKCHILDLEAK00";
    const executor = createIsolatedExecutor({
      childScript: childScript(`process.stderr.write("provider said ${leak}"); process.exit(1);`),
      timeoutMs: 5_000,
    });
    const outcome = await executor.execute(INPUT);

    assert.equal(outcome.kind, "RESOURCE_FAILURE");
    if (outcome.kind === "RESOURCE_FAILURE") {
      assert.ok(!outcome.process.stderr.includes(leak), "a credential crossed the boundary unredacted");
    }
  });
});

// =====================================================================
// AC-9 — the honest limit, where an implementer reads it
// =====================================================================

describe("TASK-011 AC-9: no claim of a sandbox", () => {
  it("states that network egress is NOT blocked, and names what would close it", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/adapters/supervision/isolatedExecutor.ts", "utf8");

    assert.match(source, /NOT A NETWORK SANDBOX/, "the boundary must be stated plainly");
    assert.match(source, /sudo/, "the reason it cannot be closed autonomously must be named");
    assert.match(source, /billing capability/i, "what IS removed must be distinguished from what is not");

    /**
     * Asserted as CLAIMS, not as substrings.
     *
     * The first version forbade the phrase "is sandboxed" — and failed on this
     * file's own warning, "read this before claiming the executor is
     * sandboxed". A substring cannot tell a caution from a claim, so it
     * measured the wrong thing. These are sentences that would only appear if
     * someone had asserted the property that is false.
     */
    for (const overclaim of [
      /fully sandboxed/i,
      /egress is blocked/i,
      /cannot reach the network/i,
      /cannot open a socket/i,
      /network access is prevented/i,
    ]) {
      assert.ok(!overclaim.test(source), `the implementation claims something untrue: ${String(overclaim)}`);
    }
  });
});

// =====================================================================
// AC-12 — the notes that pointed here are updated, not deleted
// =====================================================================

describe("TASK-011 AC-12: the trust-boundary notes say what is now true", () => {
  /**
   * These notes are the project's memory of WHY a guard exists. Deleting one
   * when its task lands loses the reasoning; leaving it unchanged states
   * something false. Both are failures, so both are asserted against.
   */
  it("records what narrowed AND what remains, in both places that pointed here", async () => {
    const { readFileSync } = await import("node:fs");

    const financial = readFileSync("src/supervision/financialSafety.ts", "utf8");
    assert.match(financial, /NARROWED BY TASK-011/, "the note must say the gap narrowed");
    assert.match(financial, /What remains|residue/i, "...and must still state what it does not cover");
    assert.ok(
      !/EXECUTOR_ISOLATION`?'?s territory/.test(financial),
      "the note must no longer defer to this task as future work",
    );

    const service = readFileSync("src/supervision/supervisorService.ts", "utf8");
    assert.match(service, /NARROWED BY TASK-011/);
    assert.match(service, /STILL a claim/, "the residual claim must not be quietly dropped");
  });
});

// =====================================================================
// The real child, end to end
// =====================================================================

describe("TASK-011: the shipped child process", () => {
  it("refuses AI work, because it holds no credentials by design", async () => {
    const executor = createIsolatedExecutor({ childScript: REAL_CHILD, timeoutMs: 30_000 });
    const outcome = await executor.execute({
      ...INPUT,
      item: { ...ITEM, workClass: "NORMAL_IMPLEMENTATION" },
    });

    assert.equal(outcome.kind, "CHANGES_REQUIRED");
    if (outcome.kind === "CHANGES_REQUIRED") {
      assert.match(outcome.findings.join(" "), /no provider credentials/);
    }
  });

  /**
   * C3: nothing may report COMPLETED for work that was not performed. Wiring
   * real deterministic work is `EXECUTOR_WIRING`, which depends on this task.
   */
  it("does NOT report success for deterministic work nobody has wired yet", async () => {
    const executor = createIsolatedExecutor({ childScript: REAL_CHILD, timeoutMs: 30_000 });
    const outcome = await executor.execute(INPUT);

    assert.notEqual(outcome.kind, "COMPLETED", "it claimed work it did not do");
    assert.equal(outcome.kind, "CHANGES_REQUIRED");
    if (outcome.kind === "CHANGES_REQUIRED") {
      assert.match(outcome.findings.join(" "), /EXECUTOR_WIRING/);
    }
  });
});
