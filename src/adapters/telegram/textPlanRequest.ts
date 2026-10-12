/**
 * PHASE8-144 offline normalized Telegram text -> request-only plan mapping.
 *
 * Maps an already-normalized caller envelope onto `PlanningService.start` with
 * `requestOnly: true`. It does NOT authenticate Telegram, touch a network,
 * dedup by update id, or drive a plan. The actor is audit, not approval.
 */

import type { PlanningService, StartPlanInput } from "../../planning/planningService.js";
import type { PlanPhase } from "../../planning/planTypes.js";

export interface TextPlanAllowedTuple {
  readonly botId: number;
  readonly chatId: number;
  readonly senderId: number;
}

export type TextPlanRequestConfig = Omit<StartPlanInput, "intent" | "requestOnly"> & {
  readonly allowedTuples: readonly TextPlanAllowedTuple[];
};

export interface TextPlanRequestAdapterDeps {
  readonly planning: Pick<PlanningService, "start">;
  readonly config: TextPlanRequestConfig;
}

export interface TextPlanRequestResult {
  readonly planId: string;
  readonly phase: PlanPhase;
}

const MAX_TEXT_CODEPOINTS = 4000;
const MAX_DEPTH = 32;
const ENVELOPE_KEYS = ["botId", "updateId", "chatId", "senderId", "text"];

function invalid(): Error {
  return new Error("Invalid Telegram text plan request.");
}

function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Own enumerable data descriptors only; returns key -> value or null when unsafe. */
function readOwnData(value: unknown, exactKeys?: readonly string[]): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.some((k) => typeof k !== "string")) return null;
  if (exactKeys !== undefined) {
    if (keys.length !== exactKeys.length || !exactKeys.every((k) => keys.includes(k))) return null;
  }
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (d === undefined || !("value" in d) || d.enumerable !== true) return null;
    out[key] = d.value;
  }
  return out;
}

/** Deep-copies trusted plain JSON-like data, rejecting accessors/exotics/cycles. */
function snapshot(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) throw invalid();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid();
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw invalid();
    const keys = Reflect.ownKeys(value).filter((k) => k !== "length");
    if (keys.length !== value.length) throw invalid();
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (d === undefined || !("value" in d)) throw invalid();
      out.push(snapshot(d.value, depth + 1));
    }
    return out;
  }
  const data = readOwnData(value);
  if (data === null) throw invalid();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    Object.defineProperty(out, k, { value: snapshot(v, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function validTuple(botId: unknown, chatId: unknown, senderId: unknown): boolean {
  return isSafeInt(botId) && botId > 0 && isSafeInt(chatId) && chatId !== 0 && isSafeInt(senderId) && senderId > 0;
}

export function createTextPlanRequestAdapter(deps: TextPlanRequestAdapterDeps): {
  readonly submit: (input: unknown) => Promise<TextPlanRequestResult>;
} {
  const planning = deps.planning;
  const start = planning.start.bind(planning);

  const raw = snapshot(deps.config) as Record<string, unknown>;
  const rawTuples = raw["allowedTuples"];
  if (!Array.isArray(rawTuples)) throw invalid();
  const tuples: TextPlanAllowedTuple[] = rawTuples.map((t) => {
    const d = readOwnData(t, ["botId", "chatId", "senderId"]);
    if (d === null || !validTuple(d["botId"], d["chatId"], d["senderId"])) throw invalid();
    return { botId: d["botId"] as number, chatId: d["chatId"] as number, senderId: d["senderId"] as number };
  });
  const { allowedTuples: _omit, ...rest } = raw;
  void _omit;
  const bound = deepFreeze(rest);
  const allowed = deepFreeze(tuples);

  async function submit(input: unknown): Promise<TextPlanRequestResult> {
    const env = readOwnData(input, ENVELOPE_KEYS);
    if (env === null) throw invalid();
    const { botId, updateId, chatId, senderId, text } = env;
    if (!isSafeInt(updateId) || updateId < 0) throw invalid();
    if (!validTuple(botId, chatId, senderId)) throw invalid();
    if (typeof text !== "string" || text.trim() === "") throw invalid();
    if (Array.from(text).length > MAX_TEXT_CODEPOINTS) throw invalid();
    if (!allowed.some((t) => t.botId === botId && t.chatId === chatId && t.senderId === senderId)) {
      throw invalid();
    }
    const plan = await start({
      ...(snapshot(bound) as Omit<StartPlanInput, "intent" | "requestOnly">),
      intent: text,
      requestOnly: true,
    });
    return { planId: plan.id, phase: plan.phase };
  }

  return { submit };
}

export interface LinkedTextPlanRequestAdapterDeps {
  readonly planning: Pick<PlanningService, "requestLinked">;
  readonly config: TextPlanRequestConfig;
}

/**
 * Linked variant: forwards the normalized (botId, updateId, chatId, senderId)
 * tuple as trusted caller transport context to `PlanningService.requestLinked`.
 * It does NOT authenticate Telegram and grants no digest/token/state authority.
 * A terminal phase on replay is returned as-is.
 */
export function createLinkedTextPlanRequestAdapter(deps: LinkedTextPlanRequestAdapterDeps): {
  readonly submit: (input: unknown) => Promise<TextPlanRequestResult>;
} {
  const planning = deps.planning;
  if (typeof planning?.requestLinked !== "function") throw invalid();
  const requestLinked = planning.requestLinked.bind(planning);

  const raw = snapshot(deps.config) as Record<string, unknown>;
  for (const forbidden of ["requestOnly", "digest", "requestDigest"]) {
    if (Object.prototype.hasOwnProperty.call(raw, forbidden)) throw invalid();
  }
  const rawTuples = raw["allowedTuples"];
  if (!Array.isArray(rawTuples)) throw invalid();
  const tuples: TextPlanAllowedTuple[] = rawTuples.map((t) => {
    const d = readOwnData(t, ["botId", "chatId", "senderId"]);
    if (d === null || !validTuple(d["botId"], d["chatId"], d["senderId"])) throw invalid();
    return { botId: d["botId"] as number, chatId: d["chatId"] as number, senderId: d["senderId"] as number };
  });
  const { allowedTuples: _omit, ...rest } = raw;
  void _omit;
  const bound = deepFreeze(rest);
  const allowed = deepFreeze(tuples);

  async function submit(input: unknown): Promise<TextPlanRequestResult> {
    const env = readOwnData(input, ENVELOPE_KEYS);
    if (env === null) throw invalid();
    const { botId, updateId, chatId, senderId, text } = env;
    if (!isSafeInt(updateId) || updateId < 0) throw invalid();
    if (!validTuple(botId, chatId, senderId)) throw invalid();
    if (typeof text !== "string" || text.trim() === "") throw invalid();
    if (Array.from(text).length > MAX_TEXT_CODEPOINTS) throw invalid();
    if (!allowed.some((t) => t.botId === botId && t.chatId === chatId && t.senderId === senderId)) {
      throw invalid();
    }
    const plan = await requestLinked(
      {
        ...(snapshot(bound) as Omit<StartPlanInput, "intent" | "requestOnly">),
        intent: text,
      },
      {
        botId: botId as number,
        updateId,
        chatId: chatId as number,
        senderId: senderId as number,
      },
    );
    return { planId: plan.id, phase: plan.phase };
  }

  return { submit };
}
