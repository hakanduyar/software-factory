export interface TelegramImportOperatorConfig {
  factoryDbPath: string;
  plansDbPath: string;
  trustedBotId: number;
  projectId: string;
  allowedTuples: Array<{ botId: number; chatId: number; senderId: number }>;
  planner: Record<string, unknown>;
  execution: Record<string, unknown>;
  budget?: Record<string, unknown>;
  constraints?: string[];
}

export function parseTelegramImportOperatorConfig(value: unknown): TelegramImportOperatorConfig {
  const fail = (): never => {
    throw new Error('Telegram import failed.');
  };
  const isRecord = (v: unknown): v is Record<string, unknown> => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  };
  const str = (v: unknown): string => (typeof v === 'string' && v.length > 0 ? v : fail());
  const pos = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fail());
  const nonZero = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v !== 0 ? v : fail());
  const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : fail());

  if (!isRecord(value)) return fail();
  const required = ['factoryDbPath', 'plansDbPath', 'trustedBotId', 'projectId', 'allowedTuples', 'planner', 'execution'];
  const allowed = new Set([...required, 'budget', 'constraints']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail();
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) fail();

  const tuples = value.allowedTuples;
  if (!Array.isArray(tuples) || tuples.length === 0) return fail();
  const allowedTuples = tuples.map((t) => {
    const r = rec(t);
    const keys = Object.keys(r);
    if (keys.length !== 3 || !['botId', 'senderId', 'chatId'].every((k) => keys.includes(k))) fail();
    return { botId: pos(r.botId), chatId: nonZero(r.chatId), senderId: pos(r.senderId) };
  });

  const config: TelegramImportOperatorConfig = {
    factoryDbPath: str(value.factoryDbPath),
    plansDbPath: str(value.plansDbPath),
    trustedBotId: pos(value.trustedBotId),
    projectId: str(value.projectId),
    allowedTuples,
    planner: rec(value.planner),
    execution: rec(value.execution),
  };
  if (Object.prototype.hasOwnProperty.call(value, 'budget')) config.budget = rec(value.budget);
  if (Object.prototype.hasOwnProperty.call(value, 'constraints')) {
    const c = value.constraints;
    if (!Array.isArray(c) || !c.every((x) => typeof x === 'string')) return fail();
    config.constraints = [...(c as string[])];
  }
  return config;
}
