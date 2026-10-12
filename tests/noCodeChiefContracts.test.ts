import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeDeterministicExecutionTicketDigest,
  computeTicketDigest,
  parseDeterministicExecutionTicket,
  parseExecutionTicket,
  parseWorkerResult,
  parseWorkerTicket,
  DETERMINISTIC_EXECUTION_KIND,
  DETERMINISTIC_TICKET_SCHEMA_VERSION,
  MAX_RESULT_BYTES,
  type DeterministicExecutionTicket,
  type WorkerTicket,
} from "../src/supervision/workerContract.js";

function baseTicket(): WorkerTicket {
  return {
    schemaVersion: "1.0.0",
    ticketId: "CLAUDE-RUNTIME-22",
    objective: "Implement the frozen worker ticket and result contract module.",
    acceptanceCriteria: [
      {
        id: "AC-1",
        version: "1.0.0",
        description: "Ticket parser validates all authoritative fields.",
      },
    ],
    scope: {
      owned: ["src/supervision/workerContract.ts", "tests/noCodeChiefContracts.test.ts"],
      forbidden: ["src/index.ts"],
      read: ["AGENTS.md", "docs/FACTORY_CONSTITUTION.md"],
      dependencies: [],
      validation: ["npm test -- workerContract"],
    },
    model: {
      eligibleModels: ["claude-sonnet-5"],
      reasoningEffort: "medium",
      rationale: "Deterministic parsing logic requires no external tool calls.",
    },
    budgets: {
      contextTokens: 10000,
      outputTokens: 4000,
      elapsedSeconds: 900,
      maxAttempts: 3,
    },
    policy: {
      checkpoint: "Report after ticket and result parser are implemented.",
      stopConditions: ["scope violation detected"],
      escalation: "Escalate to the owner if criteria cannot be met.",
    },
    resultSchema: {
      requiredFields: ["schemaVersion", "ticketId", "status", "summary", "changedPaths", "evidence"],
      maxResultBytes: 2048,
    },
  };
}

// A syntactically canonical manifest fingerprint: "sha256:" + 64 lowercase hex.
const VALID_FINGERPRINT = `sha256:${"ab12cd34".repeat(8)}`;

function baseResultObject(ticket: WorkerTicket) {
  return {
    schemaVersion: ticket.schemaVersion,
    ticketId: ticket.ticketId,
    status: "success" as const,
    summary: "Implemented the contract module and tests.",
    changedPaths: ["src/supervision/workerContract.ts", "tests/noCodeChiefContracts.test.ts"],
    commandsRun: [{ command: "npm test -- workerContract", outcome: "passed" as const }],
    validationResults: [{ check: "npm test -- workerContract", outcome: "passed" as const }],
    fingerprint: VALID_FINGERPRINT,
    checkpointRef: "artifacts/checkpoint-1.json",
    blockers: [],
    recommendedNextAction: "Merge after review.",
    evidence: ["type-checked locally"],
  };
}

function padAsciiToByteLength(obj: Record<string, unknown>, targetBytes: number): string {
  let padding = "";
  for (;;) {
    const json = JSON.stringify({ ...obj, summary: `${obj.summary}${padding}` });
    const len = Buffer.byteLength(json, "utf8");
    if (len === targetBytes) return json;
    if (len > targetBytes) throw new Error(`overshot target ${targetBytes}, got ${len}`);
    padding += "a";
  }
}

function padMultibyteToByteLength(obj: Record<string, unknown>, targetBytes: number): string {
  let padding = "";
  for (;;) {
    const json = JSON.stringify({ ...obj, summary: `${obj.summary}${padding}` });
    const len = Buffer.byteLength(json, "utf8");
    if (len === targetBytes) return json;
    if (len > targetBytes) throw new Error(`overshot target ${targetBytes}, got ${len}`);
    // 'é' is 2 UTF-8 bytes; when only 1 byte remains, close the gap with a
    // single ASCII byte first so a 2-byte step never overshoots the target.
    padding += targetBytes - len === 1 ? "a" : "é";
  }
}

const NON_POSITIVE_FINITE_BUDGET_CASES: readonly (readonly [string, number])[] = [
  ["contextTokens", 0],
  ["contextTokens", -1],
  ["contextTokens", Infinity],
  ["outputTokens", 0],
  ["elapsedSeconds", 0],
  ["elapsedSeconds", -5],
  ["maxAttempts", 0],
  ["maxAttempts", 1.5],
];

describe("parseWorkerTicket", () => {
  it("accepts a well-formed ticket", () => {
    const result = parseWorkerTicket(baseTicket());
    assert.equal(result.ok, true);
  });

  it("rejects a non-object input", () => {
    const result = parseWorkerTicket("not a ticket");
    assert.equal(result.ok, false);
  });

  it("rejects a vague or placeholder objective", () => {
    const ticket = { ...baseTicket(), objective: "TBD" };
    const result = parseWorkerTicket(ticket);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.startsWith("objective:")));
    }
  });

  it("rejects acceptance criteria without a version", () => {
    const ticket = baseTicket();
    const malformed = {
      ...ticket,
      acceptanceCriteria: [{ id: "AC-1", version: "not-semver", description: "Valid description." }],
    };
    const result = parseWorkerTicket(malformed);
    assert.equal(result.ok, false);
  });

  it("rejects duplicate acceptance criteria ids", () => {
    const ticket = baseTicket();
    const malformed = {
      ...ticket,
      acceptanceCriteria: [
        { id: "AC-1", version: "1.0.0", description: "First criterion." },
        { id: "AC-1", version: "1.0.1", description: "Duplicate id criterion." },
      ],
    };
    const result = parseWorkerTicket(malformed);
    assert.equal(result.ok, false);
  });

  it("rejects scope where owned overlaps forbidden", () => {
    const ticket = baseTicket();
    const malformed = {
      ...ticket,
      scope: { ...ticket.scope, owned: ["src/index.ts"], forbidden: ["src/index.ts"] },
    };
    const result = parseWorkerTicket(malformed);
    assert.equal(result.ok, false);
  });

  it("rejects scope where read overlaps forbidden", () => {
    const ticket = baseTicket();
    const malformed = {
      ...ticket,
      scope: { ...ticket.scope, read: ["src/index.ts"], forbidden: ["src/index.ts"] },
    };
    const result = parseWorkerTicket(malformed);
    assert.equal(result.ok, false);
  });

  it("rejects an empty owned scope", () => {
    const ticket = baseTicket();
    const malformed = { ...ticket, scope: { ...ticket.scope, owned: [] } };
    const result = parseWorkerTicket(malformed);
    assert.equal(result.ok, false);
  });

  it("rejects an empty validation scope", () => {
    const ticket = baseTicket();
    const malformed = { ...ticket, scope: { ...ticket.scope, validation: [] } };
    const result = parseWorkerTicket(malformed);
    assert.equal(result.ok, false);
  });

  it("rejects a reasoning effort outside the enum", () => {
    const ticket = baseTicket();
    const malformed = { ...ticket, model: { ...ticket.model, reasoningEffort: "extreme" } };
    const result = parseWorkerTicket(malformed);
    assert.equal(result.ok, false);
  });

  for (const [field, value] of NON_POSITIVE_FINITE_BUDGET_CASES) {
    it(`rejects a non-positive-finite budget: ${field}=${value}`, () => {
      const ticket = baseTicket();
      const malformed = { ...ticket, budgets: { ...ticket.budgets, [field]: value } };
      const result = parseWorkerTicket(malformed);
      assert.equal(result.ok, false);
    });
  }

  it("rejects missing checkpoint/stop/escalation policy fields", () => {
    const ticket = baseTicket();
    const malformed = { ...ticket, policy: { ...ticket.policy, stopConditions: [] } };
    const result = parseWorkerTicket(malformed);
    assert.equal(result.ok, false);
  });

  it("rejects an unknown required result field", () => {
    const ticket = baseTicket();
    const malformed = {
      ...ticket,
      resultSchema: { ...ticket.resultSchema, requiredFields: ["schemaVersion", "somethingElse"] },
    };
    const result = parseWorkerTicket(malformed);
    assert.equal(result.ok, false);
  });

  it("rejects a maxResultBytes that does not equal the frozen constant", () => {
    const ticket = baseTicket();
    const malformed = { ...ticket, resultSchema: { ...ticket.resultSchema, maxResultBytes: 4096 } };
    const result = parseWorkerTicket(malformed);
    assert.equal(result.ok, false);
  });

  it("rejects an unsupported ticket schemaVersion", () => {
    const ticket = { ...baseTicket(), schemaVersion: "9.9.9" };
    const result = parseWorkerTicket(ticket);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.startsWith("schemaVersion:")));
    }
  });
});

describe("computeTicketDigest", () => {
  it("is stable across object key reordering", () => {
    const ticket = baseTicket();
    const reordered: WorkerTicket = {
      resultSchema: ticket.resultSchema,
      policy: ticket.policy,
      budgets: ticket.budgets,
      model: ticket.model,
      scope: {
        validation: ticket.scope.validation,
        dependencies: ticket.scope.dependencies,
        read: ticket.scope.read,
        forbidden: ticket.scope.forbidden,
        owned: ticket.scope.owned,
      },
      acceptanceCriteria: ticket.acceptanceCriteria,
      objective: ticket.objective,
      ticketId: ticket.ticketId,
      schemaVersion: ticket.schemaVersion,
    };
    assert.equal(computeTicketDigest(ticket), computeTicketDigest(reordered));
  });

  it("changes when the objective changes", () => {
    const ticket = baseTicket();
    const changed = { ...ticket, objective: `${ticket.objective} Extended scope.` };
    assert.notEqual(computeTicketDigest(ticket), computeTicketDigest(changed));
  });

  it("changes when a scope field changes", () => {
    const ticket = baseTicket();
    const changed: WorkerTicket = {
      ...ticket,
      scope: { ...ticket.scope, read: [...ticket.scope.read, "docs/ARCHITECTURE.md"] },
    };
    assert.notEqual(computeTicketDigest(ticket), computeTicketDigest(changed));
  });

  it("changes when a budget value changes", () => {
    const ticket = baseTicket();
    const changed: WorkerTicket = { ...ticket, budgets: { ...ticket.budgets, maxAttempts: 4 } };
    assert.notEqual(computeTicketDigest(ticket), computeTicketDigest(changed));
  });

  it("changes when the model rationale changes", () => {
    const ticket = baseTicket();
    const changed: WorkerTicket = {
      ...ticket,
      model: { ...ticket.model, rationale: `${ticket.model.rationale} Updated.` },
    };
    assert.notEqual(computeTicketDigest(ticket), computeTicketDigest(changed));
  });

  it("produces a 64-character lowercase hex sha-256 digest", () => {
    const digest = computeTicketDigest(baseTicket());
    assert.match(digest, /^[0-9a-f]{64}$/);
  });
});

describe("parseWorkerResult", () => {
  const ticket = baseTicket();

  it("accepts a well-formed result matching the ticket's required fields", () => {
    const json = JSON.stringify(baseResultObject(ticket));
    const result = parseWorkerResult(json, ticket);
    assert.equal(result.ok, true);
  });

  it("rejects a result whose ticketId does not match the ticket", () => {
    const obj = { ...baseResultObject(ticket), ticketId: "OTHER-TICKET" };
    const result = parseWorkerResult(JSON.stringify(obj), ticket);
    assert.equal(result.ok, false);
  });

  it("rejects a status outside the enum", () => {
    const obj = { ...baseResultObject(ticket), status: "maybe" };
    const result = parseWorkerResult(JSON.stringify(obj), ticket);
    assert.equal(result.ok, false);
  });

  it("rejects a result missing a required field", () => {
    const obj: Record<string, unknown> = baseResultObject(ticket);
    delete obj.evidence;
    const result = parseWorkerResult(JSON.stringify(obj), ticket);
    assert.equal(result.ok, false);
  });

  it("rejects a result with an unexpected extra field", () => {
    const obj = { ...baseResultObject(ticket), extra: "not allowed" };
    const result = parseWorkerResult(JSON.stringify(obj), ticket);
    assert.equal(result.ok, false);
  });

  it("rejects an empty string", () => {
    const result = parseWorkerResult("", ticket);
    assert.equal(result.ok, false);
  });

  it("rejects a top-level JSON array", () => {
    const result = parseWorkerResult("[1,2,3]", ticket);
    assert.equal(result.ok, false);
  });

  it("rejects a top-level JSON primitive", () => {
    const result = parseWorkerResult('"just a string"', ticket);
    assert.equal(result.ok, false);
  });

  it("rejects malformed JSON", () => {
    const result = parseWorkerResult("{schemaVersion: '1.0.0'}", ticket);
    assert.equal(result.ok, false);
  });

  it("rejects trailing content after a valid JSON object", () => {
    const json = `${JSON.stringify(baseResultObject(ticket))}\n{}`;
    const result = parseWorkerResult(json, ticket);
    assert.equal(result.ok, false);
  });

  it("rejects two concatenated JSON objects", () => {
    const single = JSON.stringify(baseResultObject(ticket));
    const result = parseWorkerResult(`${single}${single}`, ticket);
    assert.equal(result.ok, false);
  });

  it("rejects duplicate keys at the top level", () => {
    const raw = '{"schemaVersion":"1.0.0","schemaVersion":"1.0.0","ticketId":"CLAUDE-RUNTIME-22","status":"success","summary":"x","changedPaths":[],"evidence":[]}';
    const result = parseWorkerResult(raw, ticket);
    assert.equal(result.ok, false);
  });

  it("rejects duplicate keys inside a nested value", () => {
    const raw =
      '{"schemaVersion":"1.0.0","ticketId":"CLAUDE-RUNTIME-22","status":"success","summary":"x","changedPaths":[],"evidence":["a","a"],"nested":{"k":1,"k":2}}';
    const result = parseWorkerResult(raw, ticket);
    assert.equal(result.ok, false);
  });

  it("rejects ambiguous non-standard JSON tokens (NaN)", () => {
    const raw =
      '{"schemaVersion":"1.0.0","ticketId":"CLAUDE-RUNTIME-22","status":"success","summary":NaN,"changedPaths":[],"evidence":[]}';
    const result = parseWorkerResult(raw, ticket);
    assert.equal(result.ok, false);
  });

  it("rejects single-quoted keys/strings", () => {
    const raw = "{'schemaVersion':'1.0.0'}";
    const result = parseWorkerResult(raw, ticket);
    assert.equal(result.ok, false);
  });

  it("rejects trailing commas", () => {
    const raw =
      '{"schemaVersion":"1.0.0","ticketId":"CLAUDE-RUNTIME-22","status":"success","summary":"x","changedPaths":[],"evidence":[],}';
    const result = parseWorkerResult(raw, ticket);
    assert.equal(result.ok, false);
  });

  it("rejects a leading-zero number as JSON (unambiguous grammar rejection)", () => {
    const raw =
      '{"schemaVersion":"1.0.0","ticketId":"CLAUDE-RUNTIME-22","status":"success","summary":"x","changedPaths":[],"evidence":[],"n":01}';
    const result = parseWorkerResult(raw, ticket);
    assert.equal(result.ok, false);
  });

  it("rejects an incomplete result even when the ticket's requiredFields is a weak subset", () => {
    const weakTicket: WorkerTicket = {
      ...ticket,
      resultSchema: { ...ticket.resultSchema, requiredFields: ["schemaVersion", "ticketId"] },
    };
    const obj: Record<string, unknown> = baseResultObject(weakTicket);
    delete obj.commandsRun;
    delete obj.checkpointRef;
    const result = parseWorkerResult(JSON.stringify(obj), weakTicket);
    assert.equal(result.ok, false);
  });

  it("rejects a result whose schemaVersion is an unsupported value", () => {
    const obj = { ...baseResultObject(ticket), schemaVersion: "9.9.9" };
    const result = parseWorkerResult(JSON.stringify(obj), { ...ticket, schemaVersion: "9.9.9" } as WorkerTicket);
    assert.equal(result.ok, false);
  });

  it("rejects a literal __proto__ key in the result JSON", () => {
    const raw =
      '{"schemaVersion":"1.0.0","ticketId":"CLAUDE-RUNTIME-22","status":"success","summary":"x","changedPaths":[],"commandsRun":[],"validationResults":[],"fingerprint":"f","checkpointRef":"c","blockers":[],"recommendedNextAction":"n","evidence":[],"__proto__":{"polluted":true}}';
    const result = parseWorkerResult(raw, ticket);
    assert.equal(result.ok, false);
  });

  it("rejects an escaped __proto__ key in the result JSON", () => {
    const raw =
      '{"schemaVersion":"1.0.0","ticketId":"CLAUDE-RUNTIME-22","status":"success","summary":"x","changedPaths":[],"commandsRun":[],"validationResults":[],"fingerprint":"f","checkpointRef":"c","blockers":[],"recommendedNextAction":"n","evidence":[],"\\u005f\\u005fproto\\u005f\\u005f":{"polluted":true}}';
    const result = parseWorkerResult(raw, ticket);
    assert.equal(result.ok, false);
  });

  it("rejects a blank evidence reference", () => {
    const obj = { ...baseResultObject(ticket), evidence: ["   "] };
    const result = parseWorkerResult(JSON.stringify(obj), ticket);
    assert.equal(result.ok, false);
  });

  it("rejects an evidence reference containing a path traversal segment", () => {
    const obj = { ...baseResultObject(ticket), evidence: ["../secrets.txt"] };
    const result = parseWorkerResult(JSON.stringify(obj), ticket);
    assert.equal(result.ok, false);
  });

  describe("command and validation outcomes", () => {
    it("accepts explicit empty commandsRun and validationResults lists", () => {
      const obj = { ...baseResultObject(ticket), commandsRun: [], validationResults: [] };
      const result = parseWorkerResult(JSON.stringify(obj), ticket);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.deepEqual(result.value.commandsRun, []);
        assert.deepEqual(result.value.validationResults, []);
      }
    });

    for (const outcome of ["passed", "failed", "not_run"] as const) {
      it(`accepts and preserves the "${outcome}" outcome on both lists`, () => {
        const obj = {
          ...baseResultObject(ticket),
          commandsRun: [{ command: "npm test", outcome }],
          validationResults: [{ check: "typecheck", outcome }],
        };
        const result = parseWorkerResult(JSON.stringify(obj), ticket);
        assert.equal(result.ok, true);
        if (result.ok) {
          assert.deepEqual(result.value.commandsRun, [{ command: "npm test", outcome }]);
          assert.deepEqual(result.value.validationResults, [{ check: "typecheck", outcome }]);
        }
      });
    }

    it("accepts a failed command alongside a success status without inferring anything", () => {
      const obj = {
        ...baseResultObject(ticket),
        commandsRun: [
          { command: "npm test", outcome: "failed" as const },
          { command: "npm run lint", outcome: "not_run" as const },
        ],
      };
      const result = parseWorkerResult(JSON.stringify(obj), ticket);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.value.commandsRun[0]?.outcome, "failed");
        assert.equal(result.value.commandsRun[1]?.outcome, "not_run");
      }
    });

    it("rejects prose commandsRun entries", () => {
      const obj = { ...baseResultObject(ticket), commandsRun: ["ran tests"] };
      const result = parseWorkerResult(JSON.stringify(obj), ticket);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.errors.some((e) => e.startsWith("result.commandsRun")));
      }
    });

    it("rejects prose validationResults entries", () => {
      const obj = { ...baseResultObject(ticket), validationResults: ["all good"] };
      const result = parseWorkerResult(JSON.stringify(obj), ticket);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.errors.some((e) => e.startsWith("result.validationResults")));
      }
    });

    it("rejects a commandsRun entry with no outcome", () => {
      const obj = { ...baseResultObject(ticket), commandsRun: [{ command: "npm test" }] };
      const result = parseWorkerResult(JSON.stringify(obj), ticket);
      assert.equal(result.ok, false);
    });

    it("rejects a validationResults entry with no outcome", () => {
      const obj = { ...baseResultObject(ticket), validationResults: [{ check: "typecheck" }] };
      const result = parseWorkerResult(JSON.stringify(obj), ticket);
      assert.equal(result.ok, false);
    });

    it("rejects a blank outcome", () => {
      const obj = {
        ...baseResultObject(ticket),
        commandsRun: [{ command: "npm test", outcome: "" }],
      };
      const result = parseWorkerResult(JSON.stringify(obj), ticket);
      assert.equal(result.ok, false);
    });

    it("rejects a whitespace-only outcome", () => {
      const obj = {
        ...baseResultObject(ticket),
        validationResults: [{ check: "typecheck", outcome: "  " }],
      };
      const result = parseWorkerResult(JSON.stringify(obj), ticket);
      assert.equal(result.ok, false);
    });

    for (const outcome of ["unknown", "success", "pass", "PASSED", "skipped"]) {
      it(`rejects the unknown outcome "${outcome}"`, () => {
        const obj = {
          ...baseResultObject(ticket),
          commandsRun: [{ command: "npm test", outcome }],
        };
        const result = parseWorkerResult(JSON.stringify(obj), ticket);
        assert.equal(result.ok, false);
      });
    }

    it("rejects a blank command label", () => {
      const obj = {
        ...baseResultObject(ticket),
        commandsRun: [{ command: "   ", outcome: "passed" as const }],
      };
      const result = parseWorkerResult(JSON.stringify(obj), ticket);
      assert.equal(result.ok, false);
    });

    it("rejects a blank check label", () => {
      const obj = {
        ...baseResultObject(ticket),
        validationResults: [{ check: "", outcome: "passed" as const }],
      };
      const result = parseWorkerResult(JSON.stringify(obj), ticket);
      assert.equal(result.ok, false);
    });

    it("rejects an entry carrying an extra field", () => {
      const obj = {
        ...baseResultObject(ticket),
        commandsRun: [{ command: "npm test", outcome: "passed" as const, notes: "looked fine" }],
      };
      const result = parseWorkerResult(JSON.stringify(obj), ticket);
      assert.equal(result.ok, false);
    });

    it("rejects a non-object entry", () => {
      const obj = { ...baseResultObject(ticket), validationResults: [null] };
      const result = parseWorkerResult(JSON.stringify(obj), ticket);
      assert.equal(result.ok, false);
    });

    it("rejects a non-array commandsRun", () => {
      const obj = { ...baseResultObject(ticket), commandsRun: { command: "npm test" } };
      const result = parseWorkerResult(JSON.stringify(obj), ticket);
      assert.equal(result.ok, false);
    });
  });

  describe("fingerprint syntax", () => {
    it("accepts the canonical sha256 fingerprint", () => {
      const obj = { ...baseResultObject(ticket), fingerprint: `sha256:${"0123456789abcdef".repeat(4)}` };
      const result = parseWorkerResult(JSON.stringify(obj), ticket);
      assert.equal(result.ok, true);
    });

    const INVALID_FINGERPRINTS: readonly (readonly [string, string])[] = [
      ["opaque token", "x"],
      ["legacy short digest", "sha256:deadbeef"],
      ["missing prefix", "ab12cd34".repeat(8)],
      ["wrong algorithm", `sha1:${"ab12cd34".repeat(8)}`],
      ["uppercase hex", `sha256:${"AB12CD34".repeat(8)}`],
      ["63 hex digits", `sha256:${"a".repeat(63)}`],
      ["65 hex digits", `sha256:${"a".repeat(65)}`],
      ["non-hex digits", `sha256:${"z".repeat(64)}`],
      ["trailing whitespace", `sha256:${"ab12cd34".repeat(8)} `],
      ["blank", "   "],
    ];

    for (const [label, fingerprint] of INVALID_FINGERPRINTS) {
      it(`rejects a fingerprint that is a ${label}`, () => {
        const obj = { ...baseResultObject(ticket), fingerprint };
        const result = parseWorkerResult(JSON.stringify(obj), ticket);
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.ok(result.errors.some((e) => e.startsWith("result.fingerprint:")));
        }
      });
    }
  });

  describe("safe local references (NC-03 fail closed)", () => {
    it("accepts an explicit empty changedPaths list", () => {
      const obj = { ...baseResultObject(ticket), changedPaths: [] };
      const result = parseWorkerResult(JSON.stringify(obj), ticket);
      assert.equal(result.ok, true);
    });

    it("accepts nested relative changed paths", () => {
      const obj = { ...baseResultObject(ticket), changedPaths: ["src/a/b.ts", "docs/tasks/x.md"] };
      const result = parseWorkerResult(JSON.stringify(obj), ticket);
      assert.equal(result.ok, true);
    });

    const UNSAFE_REFS: readonly (readonly [string, string])[] = [
      ["empty", ""],
      ["whitespace-only", "   "],
      ["untrimmed", " src/a.ts"],
      ["posix absolute", "/etc/passwd"],
      ["windows drive absolute", "C:\\secrets\\key.pem"],
      ["drive relative", "C:secrets"],
      ["unc", "\\\\host\\share\\file"],
      ["parent traversal", "../secret"],
      ["nested traversal", "src/../../secret"],
      ["backslash traversal", "src\\..\\..\\secret"],
      ["doubled separator", "src//a.ts"],
      ["trailing separator", "src/a/"],
      ["blank segment", "src/ /a.ts"],
      ["control character", "src/a\u0001.ts"],
    ];

    for (const [label, ref] of UNSAFE_REFS) {
      it(`rejects a changedPaths entry that is ${label}`, () => {
        const obj = { ...baseResultObject(ticket), changedPaths: [ref] };
        const result = parseWorkerResult(JSON.stringify(obj), ticket);
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.ok(result.errors.some((e) => e.startsWith("result.changedPaths:")));
        }
      });

      it(`rejects a checkpointRef that is ${label}`, () => {
        const obj = { ...baseResultObject(ticket), checkpointRef: ref };
        const result = parseWorkerResult(JSON.stringify(obj), ticket);
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.ok(result.errors.some((e) => e.startsWith("result.checkpointRef:")));
        }
      });
    }

    it("rejects a non-string changedPaths entry", () => {
      const obj = { ...baseResultObject(ticket), changedPaths: [42] };
      const result = parseWorkerResult(JSON.stringify(obj), ticket);
      assert.equal(result.ok, false);
    });

    it("rejects a non-string checkpointRef", () => {
      const obj = { ...baseResultObject(ticket), checkpointRef: 42 };
      const result = parseWorkerResult(JSON.stringify(obj), ticket);
      assert.equal(result.ok, false);
    });
  });

  it("rejects a whitespace-only summary", () => {
    const obj = { ...baseResultObject(ticket), summary: "   " };
    const result = parseWorkerResult(JSON.stringify(obj), ticket);
    assert.equal(result.ok, false);
  });

  it("rejects a whitespace-only recommendedNextAction", () => {
    const obj = { ...baseResultObject(ticket), recommendedNextAction: "  " };
    const result = parseWorkerResult(JSON.stringify(obj), ticket);
    assert.equal(result.ok, false);
  });

  describe("byte-length boundary (UTF-8, <= 2048 bytes)", () => {
    it("accepts a payload of exactly 2048 ASCII bytes", () => {
      const json = padAsciiToByteLength(baseResultObject(ticket), MAX_RESULT_BYTES);
      assert.equal(Buffer.byteLength(json, "utf8"), 2048);
      const result = parseWorkerResult(json, ticket);
      assert.equal(result.ok, true);
    });

    it("rejects a payload of exactly 2049 ASCII bytes", () => {
      const json = padAsciiToByteLength(baseResultObject(ticket), MAX_RESULT_BYTES + 1);
      assert.equal(Buffer.byteLength(json, "utf8"), 2049);
      const result = parseWorkerResult(json, ticket);
      assert.equal(result.ok, false);
    });

    it("accepts a payload of exactly 2048 bytes containing multibyte characters", () => {
      const json = padMultibyteToByteLength(baseResultObject(ticket), MAX_RESULT_BYTES);
      assert.equal(Buffer.byteLength(json, "utf8"), 2048);
      const result = parseWorkerResult(json, ticket);
      assert.equal(result.ok, true);
    });

    it("rejects a payload of exactly 2049 bytes crossing a multibyte character boundary", () => {
      const at2048 = padMultibyteToByteLength(baseResultObject(ticket), MAX_RESULT_BYTES);
      const obj = JSON.parse(at2048) as Record<string, unknown>;
      const over = JSON.stringify({ ...obj, summary: `${obj.summary as string}a` });
      assert.equal(Buffer.byteLength(over, "utf8"), 2049);
      const result = parseWorkerResult(over, ticket);
      assert.equal(result.ok, false);
    });
  });
});

function baseDeterministicTicket(): DeterministicExecutionTicket {
  return {
    schemaVersion: DETERMINISTIC_TICKET_SCHEMA_VERSION,
    kind: DETERMINISTIC_EXECUTION_KIND,
    ticketId: "DETERMINISTIC-RUNTIME-1",
    objective: "Run the frozen lint and test command sequence deterministically.",
    acceptanceCriteria: [
      {
        id: "AC-1",
        version: "1.0.0",
        description: "Deterministic ticket parser validates all authoritative fields.",
      },
    ],
    scope: {
      owned: ["src/supervision/workerContract.ts"],
      forbidden: ["src/index.ts"],
      read: ["AGENTS.md"],
      dependencies: [],
      validation: ["npm test -- workerContract"],
    },
    commands: [
      { executable: "npm", argv: ["run", "lint"], cwd: "." },
      { executable: "npm", argv: ["test", "--", "workerContract"], cwd: "." },
    ],
    workspace: "source-01-workbench",
    budgets: {
      elapsedSeconds: 900,
      outputBytes: 65536,
      maxAttempts: 3,
    },
    executionPolicy: {
      rationale: "Fixed command sequence requires no model selection.",
    },
    policy: {
      checkpoint: "Report after lint and test complete.",
      stopConditions: ["scope violation detected"],
      escalation: "Escalate to the owner if criteria cannot be met.",
    },
    resultSchema: {
      requiredFields: ["schemaVersion", "ticketId", "status", "summary", "changedPaths", "evidence"],
      maxResultBytes: 2048,
    },
  };
}

function stripTicketIdentity(
  value: DeterministicExecutionTicket,
): Omit<DeterministicExecutionTicket, "schemaVersion" | "kind"> {
  return {
    ticketId: value.ticketId,
    objective: value.objective,
    acceptanceCriteria: value.acceptanceCriteria,
    scope: value.scope,
    commands: value.commands,
    workspace: value.workspace,
    budgets: value.budgets,
    executionPolicy: value.executionPolicy,
    policy: value.policy,
    resultSchema: value.resultSchema,
  };
}

describe("parseDeterministicExecutionTicket", () => {
  it("accepts a well-formed deterministic ticket", () => {
    const result = parseDeterministicExecutionTicket(baseDeterministicTicket());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value.commands, baseDeterministicTicket().commands);
    }
  });

  it("rejects a non-object input", () => {
    const result = parseDeterministicExecutionTicket("not a ticket");
    assert.equal(result.ok, false);
  });

  it("rejects an unsupported schemaVersion", () => {
    const ticket = { ...baseDeterministicTicket(), schemaVersion: "9.9.9" };
    const result = parseDeterministicExecutionTicket(ticket);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.startsWith("schemaVersion:")));
    }
  });

  it("rejects a mismatched kind discriminator", () => {
    const ticket = { ...baseDeterministicTicket(), kind: "ai" };
    const result = parseDeterministicExecutionTicket(ticket);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.startsWith("kind:")));
    }
  });

  it("rejects an unsupported top-level field", () => {
    const ticket = { ...baseDeterministicTicket(), provider: "anthropic" };
    const result = parseDeterministicExecutionTicket(ticket);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.includes("provider")));
    }
  });

  it("rejects a model field mixed into a deterministic ticket", () => {
    const ticket = {
      ...baseDeterministicTicket(),
      model: { eligibleModels: ["claude-sonnet-5"], reasoningEffort: "medium", rationale: "x".repeat(10) },
    };
    const result = parseDeterministicExecutionTicket(ticket);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.includes("model")));
    }
  });

  it("rejects token-budget fields mixed into executionPolicy", () => {
    const base = baseDeterministicTicket();
    const ticket = {
      ...base,
      executionPolicy: { ...base.executionPolicy, contextTokens: 1000 },
    };
    const result = parseDeterministicExecutionTicket(ticket);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.includes("contextTokens")));
    }
  });

  it("rejects a non-empty executionPolicy rationale under 10 characters", () => {
    const base = baseDeterministicTicket();
    const ticket = { ...base, executionPolicy: { rationale: "short" } };
    const result = parseDeterministicExecutionTicket(ticket);
    assert.equal(result.ok, false);
  });

  it("rejects an empty commands array", () => {
    const ticket = { ...baseDeterministicTicket(), commands: [] };
    const result = parseDeterministicExecutionTicket(ticket);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.startsWith("commands:")));
    }
  });

  it("rejects a blank command executable", () => {
    const base = baseDeterministicTicket();
    const ticket = { ...base, commands: [{ ...base.commands[0], executable: "   " }] };
    const result = parseDeterministicExecutionTicket(ticket);
    assert.equal(result.ok, false);
  });

  it("rejects a non-string-array argv", () => {
    const base = baseDeterministicTicket();
    const ticket = { ...base, commands: [{ ...base.commands[0], argv: ["run", 42] }] };
    const result = parseDeterministicExecutionTicket(ticket);
    assert.equal(result.ok, false);
  });

  it("rejects a non-string cwd", () => {
    const base = baseDeterministicTicket();
    const ticket = { ...base, commands: [{ ...base.commands[0], cwd: 7 }] };
    const result = parseDeterministicExecutionTicket(ticket);
    assert.equal(result.ok, false);
  });

  it("rejects a whitespace-only cwd", () => {
    const base = baseDeterministicTicket();
    const ticket = { ...base, commands: [{ ...base.commands[0], cwd: "   " }] };
    const result = parseDeterministicExecutionTicket(ticket);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.startsWith("commands[0].cwd:")));
    }
  });

  it("preserves original significant cwd text on an otherwise valid ticket", () => {
    const base = baseDeterministicTicket();
    const ticket = { ...base, commands: [{ ...base.commands[0], cwd: "./nested/dir" }, base.commands[1]] };
    const result = parseDeterministicExecutionTicket(ticket);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.commands[0]?.cwd, "./nested/dir");
    }
  });

  it("rejects an unexpected field on a command entry", () => {
    const base = baseDeterministicTicket();
    const ticket = {
      ...base,
      commands: [{ ...base.commands[0], shell: true }],
    };
    const result = parseDeterministicExecutionTicket(ticket);
    assert.equal(result.ok, false);
  });

  it("rejects a blank workspace", () => {
    const ticket = { ...baseDeterministicTicket(), workspace: "   " };
    const result = parseDeterministicExecutionTicket(ticket);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.startsWith("workspace:")));
    }
  });

  const NON_POSITIVE_FINITE_DETERMINISTIC_BUDGET_CASES: readonly (readonly [string, number])[] = [
    ["elapsedSeconds", 0],
    ["elapsedSeconds", -5],
    ["elapsedSeconds", Infinity],
    ["outputBytes", 0],
    ["outputBytes", 1.5],
    ["maxAttempts", 0],
    ["maxAttempts", -1],
  ];

  for (const [field, value] of NON_POSITIVE_FINITE_DETERMINISTIC_BUDGET_CASES) {
    it(`rejects a non-positive-finite deterministic budget: ${field}=${value}`, () => {
      const base = baseDeterministicTicket();
      const ticket = { ...base, budgets: { ...base.budgets, [field]: value } };
      const result = parseDeterministicExecutionTicket(ticket);
      assert.equal(result.ok, false);
    });
  }

  it("rejects a non-integer outputBytes", () => {
    const base = baseDeterministicTicket();
    const ticket = { ...base, budgets: { ...base.budgets, outputBytes: 10.5 } };
    const result = parseDeterministicExecutionTicket(ticket);
    assert.equal(result.ok, false);
  });

  it("accepts a valid baseline deterministic budgets object", () => {
    const base = baseDeterministicTicket();
    const result = parseDeterministicExecutionTicket(base);
    assert.equal(result.ok, true);
  });

  for (const extraField of ["contextTokens", "outputTokens", "provider"]) {
    it(`rejects a deterministic budgets object carrying an unknown field: ${extraField}`, () => {
      const base = baseDeterministicTicket();
      const ticket = { ...base, budgets: { ...base.budgets, [extraField]: 1000 } };
      const result = parseDeterministicExecutionTicket(ticket);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.errors.some((e) => e.startsWith("budgets:") && e.includes(extraField)));
      }
    });
  }

  it("rejects an existing objective/acceptance/scope/policy/resultSchema violation through the shared validators", () => {
    const ticket = { ...baseDeterministicTicket(), objective: "TBD" };
    const result = parseDeterministicExecutionTicket(ticket);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.startsWith("objective:")));
    }
  });
});

describe("parseExecutionTicket", () => {
  it("delegates AI-kind input to the unchanged legacy parser and accepts it", () => {
    const result = parseExecutionTicket({ kind: "ai", ticket: baseTicket() });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.kind, "ai");
    }
  });

  it("delegates AI-kind input to the unchanged legacy parser and rejects invalid input identically", () => {
    const direct = parseWorkerTicket({ ...baseTicket(), objective: "TBD" });
    const viaUnion = parseExecutionTicket({ kind: "ai", ticket: { ...baseTicket(), objective: "TBD" } });
    assert.equal(direct.ok, false);
    assert.equal(viaUnion.ok, false);
  });

  it("accepts a valid deterministic ticket through the typed union entrypoint", () => {
    const result = parseExecutionTicket({
      kind: DETERMINISTIC_EXECUTION_KIND,
      ticket: baseDeterministicTicket(),
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.kind, DETERMINISTIC_EXECUTION_KIND);
    }
  });

  it("rejects a deterministic-kind input with a malformed command through the typed union entrypoint", () => {
    const base = baseDeterministicTicket();
    const malformed = { ...base, commands: [{ ...base.commands[0], executable: "" }] };
    const result = parseExecutionTicket({ kind: DETERMINISTIC_EXECUTION_KIND, ticket: malformed });
    assert.equal(result.ok, false);
  });

  it("rejects a null wrapper", () => {
    const result = parseExecutionTicket(null);
    assert.equal(result.ok, false);
  });

  it("rejects an unknown wrapper kind with an otherwise valid ticket", () => {
    const result = parseExecutionTicket({ kind: "unknown-kind", ticket: baseTicket() });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.startsWith("wrapper.kind:")));
    }
  });

  it("rejects an extra wrapper key alongside an otherwise valid ticket", () => {
    const result = parseExecutionTicket({ kind: "ai", ticket: baseTicket(), extra: "nope" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.startsWith("wrapper:") && e.includes("extra")));
    }
  });

  it("rejects a legacy WorkerTicket/v1 parser call with a deterministic schemaVersion", () => {
    const deterministicLookingInput = {
      ...stripTicketIdentity(baseDeterministicTicket()),
      schemaVersion: DETERMINISTIC_TICKET_SCHEMA_VERSION,
    };
    const result = parseWorkerTicket(deterministicLookingInput);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.startsWith("schemaVersion:")));
    }
  });
});

describe("computeDeterministicExecutionTicketDigest", () => {
  it("is stable across object key reordering", () => {
    const ticket = baseDeterministicTicket();
    const reordered: DeterministicExecutionTicket = {
      resultSchema: ticket.resultSchema,
      policy: ticket.policy,
      executionPolicy: ticket.executionPolicy,
      budgets: ticket.budgets,
      workspace: ticket.workspace,
      commands: ticket.commands,
      scope: {
        validation: ticket.scope.validation,
        dependencies: ticket.scope.dependencies,
        read: ticket.scope.read,
        forbidden: ticket.scope.forbidden,
        owned: ticket.scope.owned,
      },
      acceptanceCriteria: ticket.acceptanceCriteria,
      objective: ticket.objective,
      ticketId: ticket.ticketId,
      kind: ticket.kind,
      schemaVersion: ticket.schemaVersion,
    };
    assert.equal(
      computeDeterministicExecutionTicketDigest(ticket),
      computeDeterministicExecutionTicketDigest(reordered),
    );
  });

  it("produces a 64-character lowercase hex sha-256 digest", () => {
    const digest = computeDeterministicExecutionTicketDigest(baseDeterministicTicket());
    assert.match(digest, /^[0-9a-f]{64}$/);
  });

  it("changes when command order is swapped", () => {
    const ticket = baseDeterministicTicket();
    const swapped: DeterministicExecutionTicket = {
      ...ticket,
      commands: [ticket.commands[1]!, ticket.commands[0]!],
    };
    assert.notEqual(
      computeDeterministicExecutionTicketDigest(ticket),
      computeDeterministicExecutionTicketDigest(swapped),
    );
  });

  it("changes when a command's argv changes", () => {
    const ticket = baseDeterministicTicket();
    const changed: DeterministicExecutionTicket = {
      ...ticket,
      commands: [
        { ...ticket.commands[0]!, argv: [...ticket.commands[0]!.argv, "--fix"] },
        ticket.commands[1]!,
      ],
    };
    assert.notEqual(
      computeDeterministicExecutionTicketDigest(ticket),
      computeDeterministicExecutionTicketDigest(changed),
    );
  });

  it("changes when the workspace changes", () => {
    const ticket = baseDeterministicTicket();
    const changed: DeterministicExecutionTicket = { ...ticket, workspace: "other-workbench" };
    assert.notEqual(
      computeDeterministicExecutionTicketDigest(ticket),
      computeDeterministicExecutionTicketDigest(changed),
    );
  });

  it("changes when a budget bound changes", () => {
    const ticket = baseDeterministicTicket();
    const changed: DeterministicExecutionTicket = {
      ...ticket,
      budgets: { ...ticket.budgets, maxAttempts: ticket.budgets.maxAttempts + 1 },
    };
    assert.notEqual(
      computeDeterministicExecutionTicketDigest(ticket),
      computeDeterministicExecutionTicketDigest(changed),
    );
  });
});
