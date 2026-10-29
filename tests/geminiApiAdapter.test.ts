/**
 * geminiApiAdapter.ts — injected recording transport only. No network, no real
 * key: the credential is an obviously fake value generated inside the test.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { createGeminiApiWorker, type GeminiApiHttpRequest, type GeminiApiHttpResponse, validateGeminiApiModel } from "../src/adapters/workers/geminiApiAdapter.js";
import { buildWorkerPrompt } from "../src/adapters/workers/promptTemplates.js";
import { ValidationError } from "../src/domain/errors.js";
import { FACTORY_ROLES } from "../src/domain/role.js";
import type { WorkerRequest } from "../src/ports/worker.js";

const MODEL = "synthetic-model-fixture";
const KEY = `fake-runtime-${randomBytes(8).toString("hex")}`;

function request(overrides: Partial<WorkerRequest> = {}): WorkerRequest {
  return {
    runId: "run-1",
    workItemId: "wi-1",
    role: "ANALYST",
    title: "Clarify thing",
    instructions: "Describe the intent.",
    acceptanceCriteria: [{ id: "ac-1", workItemId: "wi-1", text: "holds", verificationHint: "npm test" }],
    ...overrides,
  };
}

function okBody(extra: Record<string, unknown> = {}, parts: unknown[] = [{ text: "hello" }], finishReason: unknown = "STOP"): string {
  return JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason }], ...extra });
}

interface Harness {
  calls: GeminiApiHttpRequest[];
  credentialCalls: number;
  worker: ReturnType<typeof createGeminiApiWorker>;
}

function harness(respond: (r: GeminiApiHttpRequest) => Promise<GeminiApiHttpResponse> | GeminiApiHttpResponse, getCredential?: () => string | Promise<string>, model = MODEL): Harness {
  const h = { calls: [] as GeminiApiHttpRequest[], credentialCalls: 0 } as Harness;
  h.worker = createGeminiApiWorker({
    model,
    getCredential: () => {
      h.credentialCalls += 1;
      return getCredential === undefined ? KEY : getCredential();
    },
    transport: async (r) => {
      h.calls.push(r);
      return respond(r);
    },
  });
  return h;
}

const ok = (bodyText: string): GeminiApiHttpResponse => ({ status: 200, bodyText });

function usageMeta(outcome: { evidence: readonly { summary: string }[] }): { usageStatus: string; usage: Record<string, number | null>; [k: string]: unknown } {
  const s = outcome.evidence[0]!.summary;
  return JSON.parse(s.slice(s.indexOf("{")));
}

describe("construction", () => {
  it("declares exactly ANALYST, non-deterministic", () => {
    const h = harness(() => ok(okBody()));
    assert.deepEqual(h.worker.capabilities.roles, ["ANALYST"]);
    assert.equal(h.worker.capabilities.deterministic, false);
    assert.equal(h.calls.length + h.credentialCalls, 0);
  });

  it("refuses unsafe, missing and non-string models; no default", () => {
    for (const bad of ["", "a/b", "a?b=1", "https://x/y", "a b", "a\nb", "a\0b", "../x", "a:b", "-x", "%2e", "a..b", undefined, 5]) {
      assert.notEqual(validateGeminiApiModel(bad), undefined, String(bad));
      assert.throws(() => createGeminiApiWorker({ model: bad as never, getCredential: () => KEY, transport: async () => ok("{}") }), ValidationError);
    }
    assert.equal(validateGeminiApiModel("gemini-x.y_1"), undefined);
  });

  it("requires explicit credential callback and transport", () => {
    assert.throws(() => createGeminiApiWorker({ model: MODEL, transport: async () => ok("{}") } as never), ValidationError);
    assert.throws(() => createGeminiApiWorker({ model: MODEL, getCredential: () => KEY } as never), ValidationError);
  });
});

describe("request shape", () => {
  it("sends exactly one fixed-URL POST with header key, JSON body and the existing prompt", async () => {
    const h = harness(() => ok(okBody()));
    const req = request();
    await h.worker.execute(req);
    assert.equal(h.calls.length, 1);
    assert.equal(h.credentialCalls, 1);
    const c = h.calls[0]!;
    assert.equal(c.url, `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`);
    assert.equal(c.method, "POST");
    assert.deepEqual(c.headers, { "content-type": "application/json", "x-goog-api-key": KEY });
    const prompt = buildWorkerPrompt("ANALYST", {
      workItemTitle: req.title,
      instructions: req.instructions,
      workspaceRoot: "(none: text-only analysis; no workspace, files or tools are available)",
      acceptanceCriteria: req.acceptanceCriteria,
    });
    assert.deepEqual(JSON.parse(c.body), { contents: [{ role: "user", parts: [{ text: prompt }] }] });
    assert.ok(!c.url.includes(KEY) && !c.body.includes(KEY));
    assert.ok(!c.url.includes("?"));
  });

  it("forwards recalledNote only through the existing renderer", async () => {
    const h = harness(() => ok(okBody()));
    const note = { body: "earlier note", sha256: "abc", byteLength: 12, source: { snapshotId: "s", workItemId: "w", specRevision: 1, implementationRunId: "r" } };
    await h.worker.execute(request({ recalledNote: note }));
    assert.ok(JSON.parse(h.calls[0]!.body).contents[0].parts[0].text.includes("earlier note"));
  });

  it("does not mutate the caller request", async () => {
    const h = harness(() => ok(okBody()));
    const req = request();
    const before = structuredClone(req);
    Object.freeze(req);
    Object.freeze(req.acceptanceCriteria);
    await h.worker.execute(req);
    assert.deepEqual(req, before);
  });

  it("ignores process.env keys and endpoint-override options", async () => {
    const saved = { g: process.env.GEMINI_API_KEY, o: process.env.GOOGLE_API_KEY };
    const envSentinel = `env-sentinel-${randomBytes(4).toString("hex")}`;
    process.env.GEMINI_API_KEY = envSentinel;
    process.env.GOOGLE_API_KEY = envSentinel;
    try {
      const calls: GeminiApiHttpRequest[] = [];
      const worker = createGeminiApiWorker({
        model: MODEL,
        getCredential: () => KEY,
        transport: async (r: GeminiApiHttpRequest) => {
          calls.push(r);
          return ok(okBody());
        },
        endpoint: "https://evil.example/",
        baseUrl: "https://evil.example/",
        proxy: "http://evil.example",
        tools: [{}],
      } as never);
      const out = await worker.execute(request());
      assert.equal(calls[0]!.headers["x-goog-api-key"], KEY);
      assert.ok(calls[0]!.url.startsWith("https://generativelanguage.googleapis.com/v1beta/models/"));
      assert.ok(!JSON.stringify(calls).includes(envSentinel) && !JSON.stringify(out).includes(envSentinel));
      assert.ok(!("tools" in JSON.parse(calls[0]!.body)));
    } finally {
      if (saved.g === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved.g;
      if (saved.o === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = saved.o;
    }
  });
});

describe("zero-call refusals", () => {
  for (const role of FACTORY_ROLES.filter((r) => r !== "ANALYST")) {
    it(`rejects ${role} before credential or HTTP`, async () => {
      const h = harness(() => ok(okBody()));
      const out = await h.worker.execute(request({ role }));
      assert.equal(out.status, "FAILED");
      assert.equal(h.credentialCalls, 0);
      assert.equal(h.calls.length, 0);
    });
  }

  for (const [name, cred] of [
    ["empty", () => ""],
    ["non-string", () => 5 as never],
    ["control chars", () => "abc\r\nx-evil: 1"],
    ["throwing", () => {
      throw new Error(`boom ${KEY}`);
    }],
  ] as const) {
    it(`fails with no HTTP call when credential is ${name}`, async () => {
      const h = harness(() => ok(okBody()), cred);
      const out = await h.worker.execute(request());
      assert.equal(out.status, "FAILED");
      assert.equal(h.calls.length, 0);
      assert.ok(!JSON.stringify(out).includes(KEY));
    });
  }
});

describe("response interpretation", () => {
  it("succeeds on STOP and concatenates ordered text parts; acceptance never claimed", async () => {
    const h = harness(() => ok(okBody({}, [{ text: "one " }, { text: "two " }, { text: "three" }])));
    const out = await h.worker.execute(request());
    assert.equal(out.status, "SUCCEEDED");
    assert.equal(out.summary, "one two three");
    assert.equal(out.claimsAcceptanceMet, false);
    assert.equal(out.evidence.length, 1);
    assert.equal(out.evidence[0]!.kind, "NOTE");
    assert.equal(out.evidence[0]!.reference, "gemini-api:run:run-1");
    assert.equal(out.evidence[0]!.criterionId, undefined);
    assert.deepEqual(Object.keys(out).sort(), ["claimsAcceptanceMet", "evidence", "status", "summary"]);
  });

  const failing: [string, string][] = [
    ["blockReason", JSON.stringify({ promptFeedback: { blockReason: "SAFETY" }, candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }] })],
    ["blockReason only", JSON.stringify({ promptFeedback: { blockReason: "OTHER" } })],
    ["MAX_TOKENS", okBody({}, [{ text: "cut" }], "MAX_TOKENS")],
    ["SAFETY", okBody({}, [{ text: "x" }], "SAFETY")],
    ["RECITATION", okBody({}, [{ text: "x" }], "RECITATION")],
    ["missing finish", JSON.stringify({ candidates: [{ content: { parts: [{ text: "x" }] } }] })],
    ["unknown finish", okBody({}, [{ text: "x" }], "WEIRD")],
    ["no candidates", JSON.stringify({})],
    ["empty candidates", JSON.stringify({ candidates: [] })],
    ["multiple candidates", JSON.stringify({ candidates: [1, 2].map(() => ({ content: { parts: [{ text: "x" }] }, finishReason: "STOP" })) })],
    ["empty parts", okBody({}, [])],
    ["blank text", okBody({}, [{ text: "  \n" }])],
    ["functionCall part", okBody({}, [{ functionCall: { name: "f", args: {} } }])],
    ["mixed nontext part", okBody({}, [{ text: "a" }, { inlineData: { mimeType: "x", data: "y" } }])],
    ["text plus extra key", okBody({}, [{ text: "a", thought: true }])],
    ["non-string text", okBody({}, [{ text: 5 }])],
    ["parts not array", JSON.stringify({ candidates: [{ content: { parts: "x" }, finishReason: "STOP" }] })],
    ["not JSON", "<html>"],
    ["array body", "[]"],
    ["null body", "null"],
  ];
  for (const [name, bodyText] of failing) {
    it(`FAILED: ${name}`, async () => {
      const h = harness(() => ok(bodyText));
      const out = await h.worker.execute(request());
      assert.equal(out.status, "FAILED");
      assert.equal(out.claimsAcceptanceMet, false);
      assert.equal(h.calls.length, 1);
    });
  }

  it("keeps safe partial text in evidence for MAX_TOKENS without success or continuation", async () => {
    const h = harness(() => ok(okBody({}, [{ text: "partial" }], "MAX_TOKENS")));
    const out = await h.worker.execute(request());
    assert.equal(out.status, "FAILED");
    assert.ok(out.evidence[0]!.summary.includes("partial"));
    assert.equal(h.calls.length, 1);
  });

  it("treats a trivial blockReason as not blocked", async () => {
    const h = harness(() => ok(okBody({ promptFeedback: { blockReason: "BLOCK_REASON_UNSPECIFIED" } })));
    assert.equal((await h.worker.execute(request())).status, "SUCCEEDED");
  });
});

describe("HTTP and transport errors", () => {
  for (const status of [400, 401, 403, 404, 429, 500, 503, 199, 300]) {
    it(`HTTP ${status} fails once with no retry or leak`, async () => {
      const h = harness(() => ({ status, bodyText: `{"error":{"message":"bad key ${KEY}"}}` }));
      const out = await h.worker.execute(request());
      assert.equal(out.status, "FAILED");
      assert.equal(h.calls.length, 1);
      assert.ok(out.summary.includes(String(status)));
      assert.ok(!JSON.stringify(out).includes(KEY));
      assert.ok(!JSON.stringify(out).includes("bad key"));
    });
  }

  it("transport throw fails once, no retry, error text not echoed", async () => {
    const h = harness(() => {
      throw new Error(`socket reset with ${KEY}`);
    });
    const out = await h.worker.execute(request());
    assert.equal(out.status, "FAILED");
    assert.equal(h.calls.length, 1);
    assert.ok(!JSON.stringify(out).includes(KEY));
    assert.ok(!JSON.stringify(out).includes("socket reset"));
  });

  it("malformed transport response fails", async () => {
    for (const bad of [null, { status: "200", bodyText: "{}" }, { status: 200 }, { status: 200.5, bodyText: "{}" }]) {
      const h = harness(() => bad as never);
      assert.equal((await h.worker.execute(request())).status, "FAILED");
      assert.equal(h.calls.length, 1);
    }
  });
});

describe("usage metadata", () => {
  it("missing usage is UNKNOWN/null, never 0", async () => {
    const out = await harness(() => ok(okBody())).worker.execute(request());
    const m = usageMeta(out);
    assert.equal(m.usageStatus, "UNKNOWN");
    for (const v of Object.values(m.usage)) assert.equal(v, null);
  });

  it("valid counts are kept; zero is distinct from unknown; nothing summed", async () => {
    const out = await harness(() => ok(okBody({ usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 0 } }))).worker.execute(request());
    const m = usageMeta(out);
    assert.equal(m.usageStatus, "REPORTED");
    assert.equal(m.usage.promptTokenCount, 7);
    assert.equal(m.usage.candidatesTokenCount, 0);
    assert.equal(m.usage.totalTokenCount, null);
  });

  for (const bad of [-1, 1.5, "7", Number.MAX_SAFE_INTEGER + 2, null, {}]) {
    it(`malformed count ${JSON.stringify(bad)} is INVALID/null`, async () => {
      const out = await harness(() => ok(okBody({ usageMetadata: { promptTokenCount: bad, totalTokenCount: 3 } }))).worker.execute(request());
      assert.equal(out.status, "SUCCEEDED");
      const m = usageMeta(out);
      assert.equal(m.usageStatus, "INVALID");
      assert.equal(m.usage.promptTokenCount, null);
    });
  }

  it("non-object usageMetadata is INVALID", async () => {
    const m = usageMeta(await harness(() => ok(okBody({ usageMetadata: "x" }))).worker.execute(request()));
    assert.equal(m.usageStatus, "INVALID");
  });
});

describe("secret handling", () => {
  it("never leaks the runtime key or generic secrets through any serialized outcome", async () => {
    const generic = "ghp_" + "A".repeat(30);
    const echo = `echo ${KEY} and ${generic}`;
    const bodies = [
      okBody({ modelVersion: echo, responseId: echo, raw: KEY }, [{ text: echo }]),
      okBody({ modelVersion: echo }, [{ text: echo }], "MAX_TOKENS"),
      JSON.stringify({ promptFeedback: { blockReason: echo } }),
    ];
    for (const b of bodies) {
      const h = harness(() => ok(b));
      const out = await h.worker.execute(request({ instructions: `use ${KEY}`, runId: `run-${KEY}` }));
      const s = JSON.stringify(out);
      assert.ok(!s.includes(KEY), "key leaked");
      assert.ok(!s.includes(generic), "generic secret leaked");
    }
  });

  it("does not return the transport response object", async () => {
    const response = { status: 200, bodyText: okBody(), headers: { leak: KEY } };
    const out = await harness(() => response).worker.execute(request());
    assert.ok(!JSON.stringify(out).includes(KEY));
    assert.ok(!JSON.stringify(out).includes("headers"));
  });
});
