/**
 * geminiApiHttpTransport.ts — injected fake fetch only. No network, no real key.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { createGeminiApiWorker, GEMINI_API_ORIGIN } from "../src/adapters/workers/geminiApiAdapter.js";
import type { GeminiApiHttpRequest } from "../src/adapters/workers/geminiApiAdapter.js";
import { createGeminiApiHttpTransport } from "../src/adapters/workers/geminiApiHttpTransport.js";
import type { GeminiApiFetch, GeminiApiFetchInit, GeminiApiFetchResponse } from "../src/adapters/workers/geminiApiHttpTransport.js";
import { buildWorkerPrompt } from "../src/adapters/workers/promptTemplates.js";
import type { WorkerRequest } from "../src/ports/worker.js";

const MODEL = "synthetic-model-fixture";
const KEY = `fake-runtime-${randomBytes(8).toString("hex")}`;
const URL_OK = `${GEMINI_API_ORIGIN}/v1beta/models/${MODEL}:generateContent`;

interface Call {
  url: string;
  init: GeminiApiFetchInit;
}

function fakeFetch(respond: (c: Call) => Promise<GeminiApiFetchResponse> | GeminiApiFetchResponse): { calls: Call[]; fetch: GeminiApiFetch } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return respond(call);
    },
  };
}

const reply = (status: number, text: string, type?: string): GeminiApiFetchResponse => ({
  status,
  ...(type === undefined ? {} : { type }),
  text: async () => text,
});

function validRequest(overrides: Partial<GeminiApiHttpRequest> = {}): GeminiApiHttpRequest {
  return {
    url: URL_OK,
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify({ contents: [] }),
    ...overrides,
  };
}

function workerRequest(): WorkerRequest {
  return {
    runId: "run-1",
    workItemId: "wi-1",
    role: "ANALYST",
    title: "Clarify thing",
    instructions: "Describe the intent.",
    acceptanceCriteria: [{ id: "ac-1", workItemId: "wi-1", text: "holds", verificationHint: "npm test" }],
  };
}

function makeWorker(fetch: GeminiApiFetch) {
  return createGeminiApiWorker({ model: MODEL, getCredential: () => KEY, transport: createGeminiApiHttpTransport({ fetch }) });
}

describe("worker -> http transport -> fake fetch", () => {
  it("sends the exact URL/header/body and yields an informational outcome", async () => {
    const f = fakeFetch(() =>
      reply(200, JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP" }] })),
    );
    const outcome = await makeWorker(f.fetch).execute(workerRequest());
    assert.equal(f.calls.length, 1);
    const call = f.calls[0]!;
    assert.equal(call.url, URL_OK);
    assert.equal(call.init.method, "POST");
    assert.deepEqual(call.init.headers, { "content-type": "application/json", "x-goog-api-key": KEY });
    const prompt = buildWorkerPrompt("ANALYST", {
      workItemTitle: "Clarify thing",
      instructions: "Describe the intent.",
      workspaceRoot: "(none: text-only analysis; no workspace, files or tools are available)",
      acceptanceCriteria: workerRequest().acceptanceCriteria,
    });
    assert.equal(call.init.body, JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }));
    assert.equal(outcome.status, "SUCCEEDED");
    assert.equal(outcome.claimsAcceptanceMet, false);
  });

  it("construction performs no fetch", () => {
    const f = fakeFetch(() => reply(200, "{}"));
    makeWorker(f.fetch);
    assert.equal(f.calls.length, 0);
  });
});

describe("request validation precedes fetch", () => {
  const bad: [string, Partial<GeminiApiHttpRequest>][] = [
    ["foreign origin", { url: `https://example.com/v1beta/models/${MODEL}:generateContent` }],
    ["http scheme", { url: `http://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent` }],
    ["userinfo", { url: `https://user:pw@generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent` }],
    ["port override", { url: `https://generativelanguage.googleapis.com:444/v1beta/models/${MODEL}:generateContent` }],
    ["query", { url: `${URL_OK}?key=abc` }],
    ["fragment", { url: `${URL_OK}#x` }],
    ["encoded slash", { url: `${GEMINI_API_ORIGIN}/v1beta/models/a%2Fb:generateContent` }],
    ["encoded char", { url: `${GEMINI_API_ORIGIN}/v1beta/models/%6dodel:generateContent` }],
    ["dot segment", { url: `${GEMINI_API_ORIGIN}/v1beta/models/../models/${MODEL}:generateContent` }],
    ["double slash", { url: `${GEMINI_API_ORIGIN}/v1beta//models/${MODEL}:generateContent` }],
    ["uppercase host", { url: `https://GENERATIVELANGUAGE.googleapis.com/v1beta/models/${MODEL}:generateContent` }],
    ["trailing dot host", { url: `https://generativelanguage.googleapis.com./v1beta/models/${MODEL}:generateContent` }],
    ["other method", { method: "GET" as never }],
    ["extra header", { headers: { "content-type": "application/json", "x-goog-api-key": KEY, authorization: "x" } }],
    ["missing key header", { headers: { "content-type": "application/json" } }],
    ["wrong content-type", { headers: { "content-type": "text/plain", "x-goog-api-key": KEY } }],
    ["uppercase header name", { headers: { "Content-Type": "application/json", "x-goog-api-key": KEY } }],
    ["control char credential", { headers: { "content-type": "application/json", "x-goog-api-key": `${KEY}\nX: y` } }],
    ["empty credential", { headers: { "content-type": "application/json", "x-goog-api-key": "" } }],
  ];
  for (const [name, overrides] of bad) {
    it(`refuses ${name} before fetch without leaking the credential`, async () => {
      const f = fakeFetch(() => reply(200, "{}"));
      const transport = createGeminiApiHttpTransport({ fetch: f.fetch });
      await assert.rejects(transport(validRequest(overrides)), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(KEY));
        return true;
      });
      assert.equal(f.calls.length, 0);
    });
  }
});

describe("redirects and failures", () => {
  it("does not follow redirects: manual policy, one request, fixed error", async () => {
    for (const [status, type] of [[301, undefined], [302, undefined], [307, undefined], [308, undefined], [0, "opaqueredirect"]] as const) {
      const f = fakeFetch(() => reply(status, `Location: https://evil.example/?${KEY}`, type));
      const transport = createGeminiApiHttpTransport({ fetch: f.fetch });
      await assert.rejects(transport(validRequest()), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(KEY));
        assert.ok(!error.message.includes("evil.example"));
        return true;
      });
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0]!.init.redirect, "manual");
    }
  });

  it("network and read failures do not leak the credential or raw error", async () => {
    const sentinel = `raw-${KEY}`;
    const netFail = fakeFetch(() => {
      throw new Error(sentinel);
    });
    const readFail = fakeFetch(() => ({
      status: 200,
      text: async () => {
        throw new Error(sentinel);
      },
    }));
    for (const f of [netFail, readFail]) {
      const transport = createGeminiApiHttpTransport({ fetch: f.fetch });
      await assert.rejects(transport(validRequest()), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(KEY));
        assert.ok(!error.message.includes("raw-"));
        return true;
      });
      assert.equal(f.calls.length, 1);
    }
  });

  it("returns actual non-redirect HTTP errors once; worker reports failure without retry", async () => {
    const f = fakeFetch(() => reply(429, "quota"));
    const direct = await createGeminiApiHttpTransport({ fetch: f.fetch })(validRequest());
    assert.deepEqual(direct, { status: 429, bodyText: "quota" });
    assert.equal(f.calls.length, 1);

    const g = fakeFetch(() => reply(503, "down"));
    const outcome = await makeWorker(g.fetch).execute(workerRequest());
    assert.equal(g.calls.length, 1);
    assert.equal(outcome.status, "FAILED");
    assert.equal(outcome.claimsAcceptanceMet, false);
    assert.match(outcome.summary, /HTTP 503/);
    assert.match(outcome.evidence[0]!.summary, /"httpStatus":503/);
  });
});
