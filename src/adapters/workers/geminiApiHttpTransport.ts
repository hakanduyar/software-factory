/**
 * Explicit Gemini API HTTP transport (caller-constructed only).
 *
 * Source capability, not live eligibility: constructing this transport conveys
 * no billing, project, quota or free-tier authority and infers none from a
 * successful response. Import and construction perform no I/O and read no
 * process.env. The real global fetch is used only when the caller constructs
 * this transport and invokes it; tests inject a fetch.
 *
 * Deliberately absent: retries, fallback, redirect following, output/time caps,
 * credential discovery, endpoint override.
 */

import { GEMINI_API_ORIGIN, validateGeminiApiModel } from "./geminiApiAdapter.js";
import type { GeminiApiHttpRequest, GeminiApiHttpResponse, GeminiApiTransport } from "./geminiApiAdapter.js";

export interface GeminiApiFetchInit {
  readonly method: "POST";
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly redirect: "manual";
}

export interface GeminiApiFetchResponse {
  readonly status: number;
  readonly type?: string;
  text(): Promise<string>;
}

export type GeminiApiFetch = (url: string, init: GeminiApiFetchInit) => Promise<GeminiApiFetchResponse>;

export interface GeminiApiHttpTransportOptions {
  /** Optional injected fetch for offline checks. Default: the global fetch, resolved only at call time. */
  readonly fetch?: GeminiApiFetch;
}

const PREFIX = `${GEMINI_API_ORIGIN}/v1beta/models/`;
const SUFFIX = ":generateContent";
const ALLOWED_HEADERS = ["content-type", "x-goog-api-key"];

/** Returns a fixed refusal reason (never echoing input), or undefined when acceptable. */
function refuse(request: unknown): string | undefined {
  if (typeof request !== "object" || request === null) return "malformed request";
  const r = request as Partial<GeminiApiHttpRequest>;
  if (r.method !== "POST") return "method must be POST";
  const url = r.url;
  if (typeof url !== "string" || !url.startsWith(PREFIX) || !url.endsWith(SUFFIX) || url.length <= PREFIX.length + SUFFIX.length) {
    return "URL is not the canonical Gemini generateContent endpoint";
  }
  if (validateGeminiApiModel(url.slice(PREFIX.length, url.length - SUFFIX.length)) !== undefined) {
    return "URL model segment is not canonical";
  }
  if (typeof r.body !== "string") return "body must be a string";
  const headers = r.headers;
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return "headers are malformed";
  const names = Object.keys(headers);
  if (names.length !== ALLOWED_HEADERS.length || !ALLOWED_HEADERS.every((h) => names.includes(h))) {
    return "headers must be exactly content-type and x-goog-api-key";
  }
  if (headers["content-type"] !== "application/json") return "content-type must be application/json";
  const key = headers["x-goog-api-key"];
  if (typeof key !== "string" || key.length === 0 || /[\u0000-\u001f\u007f]/.test(key)) {
    return "credential header value is unusable";
  }
  return undefined;
}

export function createGeminiApiHttpTransport(options: GeminiApiHttpTransportOptions = {}): GeminiApiTransport {
  const injected = options.fetch;
  return async (request: GeminiApiHttpRequest): Promise<GeminiApiHttpResponse> => {
    const problem = refuse(request);
    if (problem !== undefined) {
      throw new Error(`Gemini API request refused before sending: ${problem}`);
    }
    const fetchFn: GeminiApiFetch | undefined =
      injected ?? (typeof globalThis.fetch === "function" ? (globalThis.fetch as unknown as GeminiApiFetch) : undefined);
    if (fetchFn === undefined) {
      throw new Error("Gemini API transport: no fetch implementation is available");
    }
    let status: number;
    let bodyText: string;
    try {
      const response = await fetchFn(request.url, {
        method: "POST",
        headers: { "content-type": request.headers["content-type"]!, "x-goog-api-key": request.headers["x-goog-api-key"]! },
        body: request.body,
        redirect: "manual",
      });
      status = response.status;
      if (response.type === "opaqueredirect" || (status >= 300 && status <= 399)) {
        throw new Error("redirect");
      }
      bodyText = await response.text();
    } catch (error) {
      if (error instanceof Error && error.message === "redirect") {
        throw new Error("Gemini API transport: redirect responses are refused and not followed");
      }
      throw new Error("Gemini API transport: network or read failure");
    }
    return { status, bodyText };
  };
}
