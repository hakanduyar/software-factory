/**
 * Gemini REST API worker (opt-in, explicit caller only, ANALYST only).
 *
 * Protocol (ai.google.dev/api/generate-content, ai.google.dev/api):
 * `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
 * with the key in the `x-goog-api-key` header and one `contents` entry holding
 * one user text part. Responses carry `promptFeedback`, `candidates` and
 * `usageMetadata`.
 *
 * ACTUAL-DISPATCH PREREQUISITE: this is source capability, not live
 * eligibility. Constructing the Worker, or injecting a transport, conveys no
 * billing, project, quota or free-tier authority: an API key inherits its
 * project's billing (ai.google.dev/gemini-api/docs/billing/). The caller must
 * separately verify the explicit project, model, free-tier standing, key and
 * consent, and must separately admit the transport that performs the real I/O.
 * This adapter makes no model, account or probe call and infers no free
 * availability from a model name or a returned modelVersion.
 *
 * Deliberately absent: default model, process.env/key discovery, endpoint or
 * proxy override, tools/function calling, safety-setting override, retries,
 * continuation, model fallback, and any output/turn/time ceiling.
 *
 * Output is informational only: claimsAcceptanceMet is always false and the
 * outcome has no vocabulary for status, approval or DONE.
 */

import { ValidationError } from "../../domain/errors.js";
import type { EvidenceDraft } from "../../domain/evidence.js";
import type { FactoryRole } from "../../domain/role.js";
import type { Worker, WorkerOutcome, WorkerRequest } from "../../ports/worker.js";
import { redactSecrets } from "./environmentPolicy.js";
import { buildWorkerPrompt } from "./promptTemplates.js";

export const GEMINI_API_ORIGIN = "https://generativelanguage.googleapis.com";

/** Minimal local transport boundary. The caller's transport owns all real I/O. */
export interface GeminiApiHttpRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface GeminiApiHttpResponse {
  readonly status: number;
  readonly bodyText: string;
}

export type GeminiApiTransport = (request: GeminiApiHttpRequest) => Promise<GeminiApiHttpResponse>;

export interface GeminiApiWorkerOptions {
  readonly id?: string;
  /** Required: no default model. */
  readonly model: string;
  /** Required. Invoked only while executing an admitted ANALYST request. */
  readonly getCredential: () => string | Promise<string>;
  /** Required. No default transport exists, so no external request happens by default. */
  readonly transport: GeminiApiTransport;
}

const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Returns a refusal reason, or undefined when the model identifier is acceptable. */
export function validateGeminiApiModel(model: unknown): string | undefined {
  if (typeof model !== "string" || model.length === 0) {
    return "a Gemini API model must be named explicitly as a nonempty string; there is no default";
  }
  if (!SAFE_MODEL.test(model) || model.includes("..")) {
    return "a Gemini API model must be one path segment of letters, digits, '.', '_' or '-' (no slash, query, URL or control characters)";
  }
  return undefined;
}

const USAGE_FIELDS = [
  "promptTokenCount",
  "candidatesTokenCount",
  "totalTokenCount",
  "cachedContentTokenCount",
  "thoughtsTokenCount",
] as const;

type UsageStatus = "REPORTED" | "UNKNOWN" | "INVALID";

interface UsageReport {
  readonly status: UsageStatus;
  readonly counts: Readonly<Record<(typeof USAGE_FIELDS)[number], number | null>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Missing usage is UNKNOWN (null), never 0; invalid counts are null and flagged, never repaired or summed. */
function interpretUsage(raw: unknown): UsageReport {
  const counts = Object.fromEntries(USAGE_FIELDS.map((f) => [f, null])) as Record<(typeof USAGE_FIELDS)[number], number | null>;
  if (raw === undefined || raw === null) {
    return { status: "UNKNOWN", counts };
  }
  if (!isRecord(raw)) {
    return { status: "INVALID", counts };
  }
  let valid = 0;
  let invalid = 0;
  for (const field of USAGE_FIELDS) {
    const v = raw[field];
    if (v === undefined) continue;
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) {
      counts[field] = v;
      valid += 1;
    } else {
      invalid += 1;
    }
  }
  if (invalid > 0) return { status: "INVALID", counts };
  return { status: valid > 0 ? "REPORTED" : "UNKNOWN", counts };
}

function httpFailureReason(status: number): string {
  if (status === 401 || status === 403) return "authentication or permission rejected";
  if (status === 429) return "rate or quota limited";
  if (status >= 500) return "server error";
  return "non-success response";
}

const NO_WORKSPACE = "(none: text-only analysis; no workspace, files or tools are available)";

export function createGeminiApiWorker(options: GeminiApiWorkerOptions): Worker {
  const modelProblem = validateGeminiApiModel(options?.model);
  if (modelProblem !== undefined) {
    throw new ValidationError(modelProblem);
  }
  if (typeof options.getCredential !== "function") {
    throw new ValidationError("a Gemini API worker requires an explicit credential callback; keys are never discovered");
  }
  if (typeof options.transport !== "function") {
    throw new ValidationError("a Gemini API worker requires an explicit injected HTTP transport; there is no default");
  }
  const model = options.model;
  const getCredential = options.getCredential;
  const transport = options.transport;
  const url = `${GEMINI_API_ORIGIN}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const roles: readonly FactoryRole[] = ["ANALYST"];

  async function execute(request: WorkerRequest): Promise<WorkerOutcome> {
    let key: string | undefined;
    const scrub = (text: string): string => {
      let t = text;
      if (key !== undefined) {
        t = t.split(key).join("[REDACTED]");
        const escaped = JSON.stringify(key).slice(1, -1);
        if (escaped !== key) t = t.split(escaped).join("[REDACTED]");
      }
      return redactSecrets(t);
    };
    const reference = (): string => scrub(`gemini-api:run:${String(request.runId)}`);
    const note = (summary: string, meta: Record<string, unknown>): EvidenceDraft => ({
      kind: "NOTE",
      summary: scrub(`${summary} ${scrub(JSON.stringify({ informational: true, ...meta }))}`),
      reference: reference(),
    });
    const fail = (reason: string, meta: Record<string, unknown> = {}): WorkerOutcome => {
      const safeReason = scrub(reason);
      return {
        status: "FAILED",
        summary: safeReason,
        evidence: [note(`Gemini API worker failed: ${safeReason}.`, meta)],
        claimsAcceptanceMet: false,
      };
    };

    if (request.role !== "ANALYST") {
      return fail("the Gemini API worker supports only the ANALYST role; no credential was read and no request was sent");
    }

    try {
      const credential = await getCredential();
      if (typeof credential !== "string" || credential.length === 0 || /[\u0000-\u001f\u007f]/.test(credential)) {
        return fail("no usable credential was supplied; no request was sent");
      }
      key = credential;
    } catch {
      return fail("the credential callback failed; no request was sent");
    }

    const prompt = buildWorkerPrompt("ANALYST", {
      workItemTitle: request.title,
      instructions: request.instructions,
      workspaceRoot: NO_WORKSPACE,
      acceptanceCriteria: request.acceptanceCriteria,
      ...(request.recalledNote === undefined ? {} : { recalledNote: request.recalledNote }),
    });

    let response: GeminiApiHttpResponse;
    try {
      response = await transport({
        url,
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
      });
    } catch {
      return fail("the HTTP transport failed; not retried");
    }

    if (!isRecord(response) || typeof response.status !== "number" || !Number.isInteger(response.status) || typeof response.bodyText !== "string") {
      return fail("the transport returned a malformed response; not retried");
    }
    const status = response.status;
    if (status < 200 || status > 299) {
      return fail(`HTTP ${status}: ${httpFailureReason(status)}; not retried`, { httpStatus: status });
    }

    let body: unknown;
    try {
      body = JSON.parse(response.bodyText);
    } catch {
      return fail("the response body was not valid JSON", { httpStatus: status });
    }
    if (!isRecord(body)) {
      return fail("the response body was not a JSON object", { httpStatus: status });
    }

    const usage = interpretUsage(body.usageMetadata);
    const str = (v: unknown): string | null => (typeof v === "string" ? scrub(v) : null);
    const meta: Record<string, unknown> = {
      httpStatus: status,
      usageStatus: usage.status,
      usage: usage.counts,
      modelVersion: str(body.modelVersion),
      responseId: str(body.responseId),
    };

    const feedback = body.promptFeedback;
    if (isRecord(feedback) && feedback.blockReason !== undefined && feedback.blockReason !== null && feedback.blockReason !== "" && feedback.blockReason !== "BLOCK_REASON_UNSPECIFIED") {
      return fail("the prompt was blocked by the provider", { ...meta, blockReason: str(feedback.blockReason) });
    }

    const candidates = body.candidates;
    if (!Array.isArray(candidates) || candidates.length !== 1 || !isRecord(candidates[0])) {
      return fail("the response did not contain exactly one candidate", meta);
    }
    const candidate = candidates[0];
    const finishReason = typeof candidate.finishReason === "string" ? candidate.finishReason : null;
    const content = candidate.content;
    const parts = isRecord(content) ? content.parts : undefined;
    let text: string | undefined;
    if (Array.isArray(parts) && parts.length > 0 && parts.every((p) => isRecord(p) && typeof p.text === "string" && Object.keys(p).length === 1)) {
      text = (parts as { text: string }[]).map((p) => p.text).join("");
    }
    const withFinish = { ...meta, finishReason: str(finishReason) };

    if (finishReason !== "STOP") {
      return fail(`the candidate did not terminate with STOP (finishReason ${finishReason === null ? "missing" : scrub(finishReason)}); no continuation was attempted`, {
        ...withFinish,
        ...(text === undefined ? {} : { partialText: scrub(text) }),
      });
    }
    if (text === undefined) {
      return fail("the candidate content was missing, empty or not text-only", withFinish);
    }
    if (text.trim().length === 0) {
      return fail("the candidate text was empty", withFinish);
    }

    const safeText = scrub(text);
    return {
      status: "SUCCEEDED",
      summary: safeText,
      evidence: [note("Gemini API response (informational, not acceptance proof).", withFinish)],
      claimsAcceptanceMet: false,
    };
  }

  return {
    id: options.id ?? "gemini-api",
    capabilities: { roles, deterministic: false },
    execute,
  };
}
