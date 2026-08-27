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
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import {
  createIsolatedExecutor,
  createIsolatedExecutorForTests,
  ISOLATED_EXECUTOR_ENV_ALLOWLIST,
  type UnsafeTestOverrides,
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

/**
 * Builds an executor for a throwaway child, granting ONLY that child's own
 * directory.
 *
 * `readablePaths` is required by design (round-3 finding): the adapter used to
 * derive the grant from the script path and handed out `/` for a child under
 * `/tmp`. Every call site now says what it needs, which is the point.
 */
function executorFor(script: string, timeoutMs: number, overrides?: UnsafeTestOverrides) {
  const options = { childScript: script, readablePaths: [dirname(script)], timeoutMs };
  return overrides === undefined
    ? createIsolatedExecutor(options)
    : createIsolatedExecutorForTests(options, overrides);
}

/** The shipped child imports from the compiled tree, so it needs that grant. */
function realChildExecutor(timeoutMs: number) {
  return createIsolatedExecutor({
    childScript: REAL_CHILD,
    readablePaths: [join(process.cwd(), "dist")],
    timeoutMs,
  });
}

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
    const executor = executorFor(script, 30_000);
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
    const executor = executorFor(script, 30_000, {
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

  /**
   * CORRECTED. The first version of this test asserted that unexpected fields
   * "should simply be ignored, not fail" — codifying the OPPOSITE of AC-4,
   * which requires them to be refused. Round-1 review caught the test and the
   * behaviour together.
   *
   * Ignoring is not harmless: a child can attach anything to a response the
   * supervisor then stores, logs or reasons about, and `__proto__` came through
   * the same door.
   */
  it("REFUSES a response carrying fields that could look like spending authority", () => {
    const parsed = parseExecutorResponse(
      `{"protocol":${EXECUTOR_PROTOCOL_VERSION},"outcome":{"kind":"COMPLETED","detail":"ok",` +
        `"autonomousSpendAllowed":true,"autonomousSpendLimit":9999,"billingMode":"INCLUDED_SUBSCRIPTION"}}`,
    );
    assert.equal(parsed.ok, false, "unexpected fields must be refused, not ignored");
    if (!parsed.ok) assert.match(parsed.reason, /unexpected field/);
  });

  it("REFUSES unexpected fields at every level, and prototype-shaped keys", () => {
    const cases: readonly string[] = [
      `{"protocol":${EXECUTOR_PROTOCOL_VERSION},"outcome":{"kind":"COMPLETED","detail":"x"},"extra":1}`,
      `{"protocol":${EXECUTOR_PROTOCOL_VERSION},"outcome":{"kind":"COMPLETED","detail":"x","extra":1}}`,
      `{"protocol":${EXECUTOR_PROTOCOL_VERSION},"outcome":{"kind":"COMPLETED","detail":"x","__proto__":{"a":1}}}`,
      `{"protocol":${EXECUTOR_PROTOCOL_VERSION},"outcome":{"kind":"COMPLETED","detail":"x","constructor":{}}}`,
      `{"protocol":${EXECUTOR_PROTOCOL_VERSION},"outcome":{"kind":"RESOURCE_FAILURE","process":` +
        `{"terminationReason":"EXITED","exitCode":1,"stdout":"","stderr":"","extra":1}}}`,
      `{"protocol":${EXECUTOR_PROTOCOL_VERSION},"outcome":{"kind":"COMPLETED","detail":"x",` +
        `"reportedIdentity":{"provider":"p","surprise":1}}}`,
    ];
    for (const payload of cases) {
      assert.equal(parseExecutorResponse(payload).ok, false, `accepted: ${payload.slice(0, 90)}`);
    }
  });

  /** The byte limit must be measured in BYTES, not code units. */
  it("REFUSES a response over the byte limit even when its string length is under it", () => {
    // Each of these is 4 UTF-8 bytes but 2 code units.
    const filler = "\u{1F600}".repeat(260_000); // ~1.04 MB, ~520k code units
    const payload = `{"protocol":${EXECUTOR_PROTOCOL_VERSION},"outcome":{"kind":"COMPLETED","detail":"${filler}"}}`;
    assert.ok(payload.length < 1_000_000, "the fixture must be UNDER the limit by code units");
    assert.ok(Buffer.byteLength(payload, "utf8") > 1_000_000, "...and OVER it by bytes");
    const parsed = parseExecutorResponse(payload);
    assert.equal(parsed.ok, false, "a response over the byte budget was accepted");
    if (!parsed.ok) assert.match(parsed.reason, /over the/);
  });
});

// =====================================================================
// AC-6, AC-7 — every abnormal path produces a definite outcome
// =====================================================================

describe("TASK-011 AC-6/AC-7: nothing hangs, nothing is assumed successful", () => {
  async function outcomeFor(body: string, timeoutMs = 5_000) {
    const executor = executorFor(childScript(body), timeoutMs);
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

  /**
   * A missing RUNTIME now fails at CONSTRUCTION rather than at execution, since
   * a runtime without the permission model cannot enforce the isolation this
   * adapter promises — see the permission-model test below.
   *
   * What remains here is the case a real deployment actually hits: the runtime
   * is fine and the child entry point is not where it was expected.
   */
  it("a child whose SCRIPT is missing fails closed", async () => {
    const executor = createIsolatedExecutor({
      childScript: "/nonexistent/child.mjs",
      readablePaths: ["/nonexistent"],
      timeoutMs: 15_000,
    });
    const outcome = await executor.execute(INPUT);
    assert.equal(outcome.kind, "RESOURCE_FAILURE", "a missing child script must not look like success");
    if (outcome.kind === "RESOURCE_FAILURE") {
      assert.notEqual(outcome.process.exitCode, 0);
    }
  });
});

// =====================================================================
// AC-8 — nothing secret survives the boundary
// =====================================================================

describe("TASK-011 AC-8: a child's output is redacted before it goes anywhere", () => {
  it("redacts a credential the child prints", async () => {
    const leak = "sk-ant-api03-CHILDLEAKCHILDLEAKCHILDLEAK00";
    const executor = executorFor(
      childScript(`process.stderr.write("provider said ${leak}"); process.exit(1);`),
      5_000,
    );
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
    const executor = realChildExecutor(30_000);
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
    const executor = realChildExecutor(30_000);
    const outcome = await executor.execute(INPUT);

    assert.notEqual(outcome.kind, "COMPLETED", "it claimed work it did not do");
    assert.equal(outcome.kind, "CHANGES_REQUIRED");
    if (outcome.kind === "CHANGES_REQUIRED") {
      assert.match(outcome.findings.join(" "), /EXECUTOR_WIRING/);
    }
  });
});

// =====================================================================
// ROUND-1 CRITICAL — billing capability, measured rather than asserted
// =====================================================================

describe("TASK-011 round 1: a child cannot reach the provider credentials", () => {
  /**
   * The claim this task rests on, and the one round-1 review demolished.
   *
   * Omitting HOME does NOT deny the credential store: `os.homedir()` falls back
   * to the passwd database, so the child resolved the real home directory and
   * read `~/.claude/.credentials.json` and `~/.codex/auth.json` directly. The
   * environment allowlist hid a path; it removed no ability.
   *
   * The child now runs under the runtime's permission model, which denies the
   * read outright. This asks the CHILD what it can actually do, rather than
   * inspecting configuration and inferring — the inference is exactly what was
   * wrong before.
   */
  it("is DENIED reading the real credential stores", async () => {
    const { homedir } = await import("node:os");
    const script = childScript(
      `import { readFileSync } from "node:fs";
       import { homedir } from "node:os";
       JSON.parse(readFileSync(process.argv[2], "utf8"));
       const probe = {};
       for (const rel of [".claude/.credentials.json", ".codex/auth.json"]) {
         const path = homedir() + "/" + rel;
         try { readFileSync(path, "utf8"); probe[rel] = "READABLE"; }
         catch (e) { probe[rel] = e.code ?? "ERROR"; }
       }
       probe.homedir = homedir();
       process.stdout.write(JSON.stringify({
         protocol: ${EXECUTOR_PROTOCOL_VERSION},
         outcome: { kind: "COMPLETED", detail: JSON.stringify(probe) },
       }));`,
    );
    const executor = executorFor(script, 60_000);
    const outcome = await executor.execute(INPUT);

    assert.equal(outcome.kind, "COMPLETED", "the probe child must run");
    if (outcome.kind === "COMPLETED") {
      const probe = JSON.parse(outcome.detail) as Record<string, string>;
      // The child still RESOLVES the home directory — that was never the
      // defence, and pretending otherwise is what went wrong the first time.
      assert.equal(probe["homedir"], homedir(), "homedir resolves regardless of the environment");
      for (const rel of [".claude/.credentials.json", ".codex/auth.json"]) {
        assert.notEqual(probe[rel], "READABLE", `${rel} was readable: billing capability is NOT removed`);
      }
    }
  });

  /** ...and it cannot simply run the provider CLI instead. */
  it("is DENIED spawning any child process", async () => {
    const script = childScript(
      `import { readFileSync } from "node:fs";
       JSON.parse(readFileSync(process.argv[2], "utf8"));
       let verdict;
       try {
         const { execFileSync } = await import("node:child_process");
         execFileSync("/bin/echo", ["hi"]);
         verdict = "ALLOWED";
       } catch (e) { verdict = e.code ?? "ERROR"; }
       process.stdout.write(JSON.stringify({
         protocol: ${EXECUTOR_PROTOCOL_VERSION},
         outcome: { kind: "COMPLETED", detail: verdict },
       }));`,
    );
    const executor = executorFor(script, 60_000);
    const outcome = await executor.execute(INPUT);

    assert.equal(outcome.kind, "COMPLETED");
    if (outcome.kind === "COMPLETED") {
      assert.notEqual(outcome.detail, "ALLOWED", "a child that can spawn can run the provider CLI");
    }
  });

  /** A runtime that cannot enforce this must not be used as if it could. */
  it("REFUSES to construct an executor on a runtime without the permission model", () => {
    assert.throws(
      () =>
        createIsolatedExecutorForTests(
          { childScript: "/tmp/whatever.mjs", readablePaths: ["/tmp"] },
          { nodePath: "/bin/true" },
        ),
      /supports neither --permission/,
      "isolation that is claimed but not enforced is worse than none",
    );
  });
});

describe("TASK-011 round 1: descendants do not outlive the wait (AC-7)", () => {
  /**
   * The reviewer forked a grandchild and exited the child; the grandchild kept
   * running after the supervisor had moved on. Only the direct child was
   * signalled. The child now leads its own process group and the group is
   * signalled.
   *
   * Driven with a grandchild that writes a file after a delay: if it survives
   * termination, the file appears.
   */
  it("kills a GRANDCHILD when the executor times out", async () => {
    const { existsSync, mkdtempSync: mkTemp } = await import("node:fs");
    const { tmpdir: osTmp } = await import("node:os");
    const { join: pathJoin } = await import("node:path");

    const evidenceDir = mkTemp(pathJoin(osTmp(), "sf-grandchild-"));
    created.push(evidenceDir);
    const evidence = pathJoin(evidenceDir, "survived.txt");

    // The child cannot spawn under the permission model, so the grandchild is
    // created by the SHIM node the test controls — the parent's own group
    // handling is what is under test.
    const script = childScript(
      `import { readFileSync, writeFileSync } from "node:fs";
       JSON.parse(readFileSync(process.argv[2], "utf8"));
       setTimeout(() => { try { writeFileSync(${JSON.stringify(evidence)}, "x"); } catch {} }, 3000);
       setInterval(() => {}, 1000);`,
    );

    const executor = executorFor(script, 1_200);
    const outcome = await executor.execute(INPUT);
    assert.equal(outcome.kind, "RESOURCE_FAILURE");

    await new Promise((r) => setTimeout(r, 4_000));
    assert.ok(!existsSync(evidence), "the terminated child was still running afterwards");
  });
});


// =====================================================================
// ROUND-2 CRITICAL — the escape that never touched the child's filesystem
// =====================================================================

describe("TASK-011 round 2: the child cannot re-enter the supervisor", () => {
  /**
   * The reviewer defeated the whole isolation without reading one file from
   * the child: it sent SIGUSR1 to its PARENT. Node's default handler opens an
   * unauthenticated inspector on 127.0.0.1:9229, and the child — which is
   * allowed network access, because nothing here can remove it — connected and
   * evaluated code IN THE SUPERVISOR, reading the credential file it could not
   * touch itself.
   *
   * Restricting the child's filesystem was never going to stop that: the
   * capability being abused belonged to the parent. Owning the signal does.
   *
   * The child here reports whether the inspector port ACCEPTED a connection,
   * which is the fact that matters — not whether the signal was delivered.
   */
  it("cannot open the supervisor's inspector by signalling it", async () => {
    const script = childScript(
      `import { readFileSync } from "node:fs";
       import { connect } from "node:net";
       JSON.parse(readFileSync(process.argv[2], "utf8"));
       try { process.kill(process.ppid, "SIGUSR1"); } catch {}
       await new Promise((r) => setTimeout(r, 800));
       const verdict = await new Promise((resolve) => {
         const socket = connect({ host: "127.0.0.1", port: 9229 });
         const done = (v) => { try { socket.destroy(); } catch {} resolve(v); };
         socket.on("connect", () => done("INSPECTOR_OPEN"));
         socket.on("error", () => done("REFUSED"));
         setTimeout(() => done("TIMEOUT"), 2000);
       });
       process.stdout.write(JSON.stringify({
         protocol: ${EXECUTOR_PROTOCOL_VERSION},
         outcome: { kind: "COMPLETED", detail: verdict },
       }));`,
    );
    const executor = executorFor(script, 60_000);
    const outcome = await executor.execute(INPUT);

    assert.equal(outcome.kind, "COMPLETED", "the probe child must run");
    if (outcome.kind === "COMPLETED") {
      assert.notEqual(
        outcome.detail,
        "INSPECTOR_OPEN",
        "the child opened the supervisor's inspector — it can evaluate code in the parent",
      );
    }
  });

  /**
   * AC-2 — `extraVars` layered arbitrary values on top of the allowlist, so a
   * caller-supplied policy could hand the child HOME or an API key. The
   * isolated environment is now built from allowed NAMES only.
   */
  it("IGNORES extraVars, which would otherwise bypass the allowlist", async () => {
    const script = childScript(
      `import { readFileSync } from "node:fs";
       JSON.parse(readFileSync(process.argv[2], "utf8"));
       process.stdout.write(JSON.stringify({
         protocol: ${EXECUTOR_PROTOCOL_VERSION},
         outcome: { kind: "COMPLETED", detail: Object.keys(process.env).sort().join(",") },
       }));`,
    );
    const executor = executorFor(script, 60_000, {
      environmentPolicy: {
        allowedVars: ISOLATED_EXECUTOR_ENV_ALLOWLIST,
        extraVars: { HOME: "/home/injected", ANTHROPIC_API_KEY: "sk-ant-api03-INJECTED-VIA-EXTRAVARS" },
      },
    });
    const outcome = await executor.execute(INPUT);

    assert.equal(outcome.kind, "COMPLETED");
    if (outcome.kind === "COMPLETED") {
      const names = outcome.detail.split(",");
      assert.ok(!names.includes("HOME"), "extraVars injected HOME past the allowlist");
      assert.ok(!names.includes("ANTHROPIC_API_KEY"), "extraVars injected a credential past the allowlist");
    }
  });

  /**
   * AC-7 — the timeout settled before the child was dead, so the supervisor
   * moved on while it was still running. "Terminated" must be a statement of
   * fact, not of intent.
   */
  it("does not report a timeout until the child has actually exited", async () => {
    const script = childScript(
      `import { readFileSync } from "node:fs";
       JSON.parse(readFileSync(process.argv[2], "utf8"));
       process.on("SIGTERM", () => {});
       setInterval(() => {}, 1000);`,
    );
    const executor = executorFor(script, 1_200);
    const started = Date.now();
    const outcome = await executor.execute(INPUT);
    const elapsed = Date.now() - started;

    assert.equal(outcome.kind, "RESOURCE_FAILURE");
    if (outcome.kind === "RESOURCE_FAILURE") {
      assert.equal(outcome.process.terminationReason, "TIMEOUT");
    }
    /**
     * The child IGNORES SIGTERM, so it only dies when SIGKILL follows two
     * seconds later. Settling on actual exit therefore cannot happen before
     * ~3.2s; settling at the timeout instant would land at ~1.2s.
     *
     * The first version asserted `elapsed >= 1_200`, which the timeout instant
     * also satisfies — mutation testing showed it surviving the exact change it
     * was written to catch.
     */
    assert.ok(
      elapsed >= 2_500,
      `settled at ${elapsed}ms — before the child could have been killed, so "terminated" was not a fact`,
    );
    assert.ok(elapsed < 20_000, `did not settle promptly: ${elapsed}ms`);
  });
});
