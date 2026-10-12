export interface NormalizedTextEnvelope {
  readonly botId: number;
  readonly updateId: number;
  readonly chatId: number;
  readonly senderId: number;
  readonly text: string;
}

export type NormalizeTextUpdateResult =
  | { readonly kind: "accepted"; readonly envelope: NormalizedTextEnvelope }
  | { readonly kind: "unsupported"; readonly code: "UNSUPPORTED_UPDATE" }
  | { readonly kind: "invalid"; readonly code: "INVALID_UPDATE" };

const MAX_RAW_BYTES = 65536;
const MAX_TEXT_CODEPOINTS = 4000;

const INVALID: NormalizeTextUpdateResult = Object.freeze({ kind: "invalid", code: "INVALID_UPDATE" } as const);
const UNSUPPORTED: NormalizeTextUpdateResult = Object.freeze({ kind: "unsupported", code: "UNSUPPORTED_UPDATE" } as const);

const UNSUPPORTED_UPDATE_KEYS = [
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "business_connection",
  "business_message",
  "edited_business_message",
  "deleted_business_messages",
  "guest_message",
  "guest_query"
];

const UNSUPPORTED_MESSAGE_KEYS = [
  "sender_chat",
  "sender_business_bot",
  "business_connection_id",
  "guest_query_id",
  "guest_bot_caller_user",
  "guest_bot_caller_chat"
];

type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function field(record: PlainRecord, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function present(record: PlainRecord, key: string): boolean {
  return field(record, key) !== undefined;
}

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function normalizeTextUpdate(rawJson: string, trustedBotId: number): NormalizeTextUpdateResult {
  if (typeof rawJson !== "string" || !isPositiveSafeInt(trustedBotId)) {
    return INVALID;
  }
  if (Buffer.byteLength(rawJson, "utf8") > MAX_RAW_BYTES) {
    return INVALID;
  }

  let update: unknown;
  try {
    update = JSON.parse(rawJson);
  } catch {
    return INVALID;
  }
  if (!isPlainRecord(update)) {
    return INVALID;
  }

  const updateId = field(update, "update_id");
  if (typeof updateId !== "number" || !Number.isSafeInteger(updateId) || updateId < 0) {
    return INVALID;
  }

  if (UNSUPPORTED_UPDATE_KEYS.some((key) => present(update as PlainRecord, key))) {
    return UNSUPPORTED;
  }
  const message = field(update, "message");
  if (message === undefined) {
    return UNSUPPORTED;
  }
  if (!isPlainRecord(message)) {
    return INVALID;
  }

  if (UNSUPPORTED_MESSAGE_KEYS.some((key) => present(message, key))) {
    return UNSUPPORTED;
  }
  if (!isPositiveSafeInt(field(message, "message_id")) || !isPositiveSafeInt(field(message, "date"))) {
    return INVALID;
  }

  const chat = field(message, "chat");
  const from = field(message, "from");
  if (!isPlainRecord(chat) || !isPlainRecord(from)) {
    return INVALID;
  }
  const chatType = field(chat, "type");
  const isBot = field(from, "is_bot");
  if (typeof chatType !== "string" || typeof isBot !== "boolean") {
    return INVALID;
  }
  if (chatType !== "private" || isBot) {
    return UNSUPPORTED;
  }

  const chatId = field(chat, "id");
  const senderId = field(from, "id");
  if (!isPositiveSafeInt(chatId) || !isPositiveSafeInt(senderId)) {
    return INVALID;
  }

  const text = field(message, "text");
  if (text === undefined) {
    return UNSUPPORTED;
  }
  if (typeof text !== "string" || text.trim().length === 0) {
    return INVALID;
  }
  let codepoints = 0;
  for (const _ of text) {
    codepoints += 1;
    if (codepoints > MAX_TEXT_CODEPOINTS) {
      return INVALID;
    }
  }

  return {
    kind: "accepted",
    envelope: { botId: trustedBotId, updateId, chatId, senderId, text }
  };
}
