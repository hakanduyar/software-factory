import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';
import { normalizeTextUpdate } from '../src/adapters/telegram/textUpdateEnvelope.js';
import { createLinkedTextPlanRequestAdapter } from '../src/adapters/telegram/textPlanRequest.js';
import {
  createSqlitePlanRepository,
  upgradePlanSchemaV1ToV2,
  type SqlitePlanRepository,
} from '../src/adapters/planning/sqlitePlanRepository.js';
import type { PlannerOutcome, PlannerRequest, PlannerWorker } from '../src/planning/plannerWorker.js';
import { cleanupTempDbs, tempDbPath } from './support/factoryFixtures.js';
import {
  PLAN_SYSTEM,
  TEST_PLANNER_CONFIG,
  newPlanning,
  testExecutionConfig,
} from './support/planFixtures.js';

after(cleanupTempDbs);

const TRUSTED_BOT_ID = 111;
const LITERAL_TEXT = ' literal offline text ';

function validUpdate(): Record<string, any> {
  return {
    update_id: 10,
    message: {
      message_id: 1,
      date: 1700000000,
      from: { id: 333, is_bot: false, first_name: 'Synthetic' },
      chat: { id: 222, type: 'private' },
      text: LITERAL_TEXT,
    },
  };
}

const run = (update: unknown, botId = TRUSTED_BOT_ID) =>
  normalizeTextUpdate(typeof update === 'string' ? update : JSON.stringify(update), botId);

const EXPECTED_ENVELOPE = {
  kind: 'accepted',
  envelope: { botId: 111, updateId: 10, chatId: 222, senderId: 333, text: LITERAL_TEXT },
};
const INVALID = { kind: 'invalid', code: 'INVALID_UPDATE' };
const UNSUPPORTED = { kind: 'unsupported', code: 'UNSUPPORTED_UPDATE' };

test('valid private text update yields exact envelope with literal text', () => {
  assert.deepStrictEqual(run(validUpdate()), EXPECTED_ENVELOPE);
});

test('payload botId and harmless name/entity metadata never affect trusted identity or envelope', () => {
  const update = validUpdate();
  update.botId = 999;
  update.message.botId = 999;
  update.message.from.username = 'harmless_name';
  update.message.from.last_name = 'Name';
  update.message.entities = [{ type: 'bold', offset: 0, length: 3 }];
  assert.deepStrictEqual(run(update), EXPECTED_ENVELOPE);
});

test('malformed JSON is invalid', () => {
  assert.deepStrictEqual(run('{not json'), INVALID);
});

test('non-integer update_id is invalid', () => {
  const update = validUpdate();
  update.update_id = 10.5;
  assert.deepStrictEqual(run(update), INVALID);
});

test('edited_message instead of message is unsupported', () => {
  const update = validUpdate();
  update.edited_message = update.message;
  delete update.message;
  assert.deepStrictEqual(run(update), UNSUPPORTED);
});

test('non-private chat type is unsupported', () => {
  const update = validUpdate();
  update.message.chat.type = 'group';
  assert.deepStrictEqual(run(update), UNSUPPORTED);
});

test('caller mutation of an invalid result does not leak into the next invalid result', () => {
  const first = run('{not json');
  try {
    Reflect.set(first, 'kind', 'accepted');
  } catch {
    // frozen results may throw; isolation still holds
  }
  assert.deepStrictEqual(run('{not json'), INVALID);
});

test('caller mutation of an unsupported result does not leak into the next unsupported result', () => {
  const make = () => {
    const update = validUpdate();
    update.message.chat.type = 'group';
    return run(update);
  };
  const first = make();
  try {
    Reflect.set(first, 'kind', 'accepted');
  } catch {
    // frozen results may throw; isolation still holds
  }
  assert.deepStrictEqual(make(), UNSUPPORTED);
});

const RAW_LIMIT = 65536;
const UNSAFE = Number.MAX_SAFE_INTEGER + 1;

test('raw JSON cap is UTF-8 bytes: exact limit accepted, +1 byte and multibyte overflow invalid', () => {
  const base = Buffer.byteLength(JSON.stringify({ ...validUpdate(), pad: '' }), 'utf8');
  const at = JSON.stringify({ ...validUpdate(), pad: 'a'.repeat(RAW_LIMIT - base) });
  assert.equal(Buffer.byteLength(at, 'utf8'), RAW_LIMIT);
  assert.deepStrictEqual(run(at), EXPECTED_ENVELOPE);
  const over = JSON.stringify({ ...validUpdate(), pad: 'a'.repeat(RAW_LIMIT - base + 1) });
  assert.deepStrictEqual(run(over), INVALID);
  const multi = JSON.stringify({ ...validUpdate(), pad: 'é'.repeat(33000) });
  assert.ok(multi.length < RAW_LIMIT && Buffer.byteLength(multi, 'utf8') > RAW_LIMIT);
  assert.deepStrictEqual(run(multi), INVALID);
});

test('text limit is 4000 code points of literal text; blank and non-string text invalid', () => {
  const withText = (text: unknown) => {
    const update = validUpdate();
    update.message.text = text;
    return run(update);
  };
  const exact = '😀'.repeat(4000);
  assert.deepStrictEqual(withText(exact), {
    kind: 'accepted',
    envelope: { ...EXPECTED_ENVELOPE.envelope, text: exact },
  });
  assert.deepStrictEqual(withText('😀'.repeat(4001)), INVALID);
  for (const bad of ['', '   ', '\n\t', 123, null, true, ['a'], { a: 1 }]) {
    assert.deepStrictEqual(withText(bad), INVALID, JSON.stringify(bad));
  }
});

test('malformed scalar/null/array roots are invalid', () => {
  for (const raw of ['123', '"x"', 'null', '[]', 'true']) {
    assert.deepStrictEqual(run(raw), INVALID, raw);
  }
});

const INVALID_MUTATIONS: Array<[string, (u: Record<string, any>) => void]> = [
  ['update_id negative', (u) => { u.update_id = -1; }],
  ['update_id unsafe', (u) => { u.update_id = UNSAFE; }],
  ['update_id string', (u) => { u.update_id = '10'; }],
  ['update_id missing', (u) => { delete u.update_id; }],
  ['message null', (u) => { u.message = null; }],
  ['message string', (u) => { u.message = 'x'; }],
  ['message array', (u) => { u.message = []; }],
  ['chat missing', (u) => { delete u.message.chat; }],
  ['chat non-object', (u) => { u.message.chat = 'private'; }],
  ['from missing', (u) => { delete u.message.from; }],
  ['from non-object', (u) => { u.message.from = 5; }],
  ['message_id zero', (u) => { u.message.message_id = 0; }],
  ['message_id string', (u) => { u.message.message_id = '1'; }],
  ['message_id unsafe', (u) => { u.message.message_id = UNSAFE; }],
  ['date zero', (u) => { u.message.date = 0; }],
  ['date negative', (u) => { u.message.date = -5; }],
  ['date string', (u) => { u.message.date = '1700000000'; }],
  ['date unsafe', (u) => { u.message.date = UNSAFE; }],
  ['chat.id zero', (u) => { u.message.chat.id = 0; }],
  ['chat.id unsafe', (u) => { u.message.chat.id = UNSAFE; }],
  ['chat.id string', (u) => { u.message.chat.id = '222'; }],
  ['chat.type missing', (u) => { delete u.message.chat.type; }],
  ['chat.type non-string', (u) => { u.message.chat.type = 1; }],
  ['from.id zero', (u) => { u.message.from.id = 0; }],
  ['from.id negative', (u) => { u.message.from.id = -3; }],
  ['from.id unsafe', (u) => { u.message.from.id = UNSAFE; }],
  ['from.id string', (u) => { u.message.from.id = '333'; }],
  ['is_bot missing', (u) => { delete u.message.from.is_bot; }],
  ['is_bot string', (u) => { u.message.from.is_bot = 'false'; }],
];

test('required typed fields that are missing or wrong-typed are invalid', () => {
  for (const [name, mutate] of INVALID_MUTATIONS) {
    const update = validUpdate();
    mutate(update);
    assert.deepStrictEqual(run(update), INVALID, name);
  }
});

test('trusted bot id must be a positive safe integer', () => {
  for (const bad of [0, -1, UNSAFE, 1.5, '111', null] as unknown[]) {
    assert.deepStrictEqual(run(validUpdate(), bad as number), INVALID, String(bad));
  }
});

test('update_id zero is accepted at the lower bound', () => {
  const update = validUpdate();
  update.update_id = 0;
  assert.deepStrictEqual(run(update), {
    kind: 'accepted',
    envelope: { ...EXPECTED_ENVELOPE.envelope, updateId: 0 },
  });
});

const UNSUPPORTED_MUTATIONS: Array<[string, (u: Record<string, any>) => void]> = [
  ['message missing', (u) => { delete u.message; }],
  ['no text', (u) => { delete u.message.text; }],
  ['bot sender', (u) => { u.message.from.is_bot = true; }],
  ['sender_chat', (u) => { u.message.sender_chat = { id: -100, type: 'channel' }; }],
  ['business_connection_id', (u) => { u.message.business_connection_id = 'bc'; }],
  ['guest_query_id', (u) => { u.message.guest_query_id = 'gq'; }],
  ['business_message', (u) => { u.business_message = u.message; delete u.message; }],
  ['channel_post', (u) => { u.channel_post = u.message; delete u.message; }],
  ['guest_message', (u) => { u.guest_message = u.message; delete u.message; }],
];

test('ordinary non-text, bot, sender_chat, business, guest and channel updates are unsupported', () => {
  for (const [name, mutate] of UNSUPPORTED_MUTATIONS) {
    const update = validUpdate();
    mutate(update);
    assert.deepStrictEqual(run(update), UNSUPPORTED, name);
  }
});

function failIfCalledPlanner(): PlannerWorker & { calls(): number } {
  let calls = 0;
  return {
    id: 'fail-if-called',
    calls: () => calls,
    async plan(_request: PlannerRequest): Promise<PlannerOutcome> {
      calls += 1;
      throw new Error('planner must not be reached by a linked text plan request');
    },
  };
}

function rawCounts(path: string): { plans: number; links: number } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const plans = db.prepare('SELECT COUNT(*) AS n FROM plans').get() as { n: number };
    const links = db.prepare('SELECT COUNT(*) AS n FROM plan_request_links').get() as { n: number };
    return { plans: Number(plans.n), links: Number(links.n) };
  } finally {
    db.close();
  }
}

test('normalized envelope submits through the linked adapter over real SQLite, replays across reopen, and normalizer is not the allowlist', async () => {
  const path = tempDbPath('envelope-linked-');
  createSqlitePlanRepository(path).close();
  upgradePlanSchemaV1ToV2(path);

  const normalize = (update: unknown) =>
    normalizeTextUpdate(JSON.stringify(update), TRUSTED_BOT_ID);
  const planner = failIfCalledPlanner();
  let repo: SqlitePlanRepository | undefined = createSqlitePlanRepository(path);
  try {
    const first = await newPlanning({ plans: repo, planner });
    const config = {
      projectId: first.projectId,
      actor: PLAN_SYSTEM,
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
      allowedTuples: [{ botId: 111, chatId: 222, senderId: 333 }],
    };

    const normalized = normalize(validUpdate());
    assert.deepStrictEqual(normalized, EXPECTED_ENVELOPE);
    assert.equal(normalized.kind, 'accepted');
    if (normalized.kind !== 'accepted') return;

    const submitted = await createLinkedTextPlanRequestAdapter({ planning: first.service, config }).submit(
      normalized.envelope,
    );
    assert.equal(submitted.phase, 'DRAFT');
    const stored = await first.plans.findById(submitted.planId);
    assert.ok(stored);
    assert.equal(stored.phase, 'DRAFT');
    assert.equal(stored.intent, LITERAL_TEXT);
    const snapshot = structuredClone(stored);
    assert.equal((await first.plans.listByProject(first.projectId)).length, 1);
    assert.deepEqual(rawCounts(path), { plans: 1, links: 1 });
    assert.equal(planner.calls(), 0);
    assert.equal(first.dispatcher.startCount(), 0);

    // Restart: close, reopen, fresh services and adapter over the same store/config.
    repo.close();
    repo = createSqlitePlanRepository(path);
    const second = await newPlanning({ plans: repo, planner, store: first.store });
    assert.equal(second.projectId, first.projectId);
    const again = normalize(validUpdate());
    assert.equal(again.kind, 'accepted');
    if (again.kind !== 'accepted') return;
    const adapter = createLinkedTextPlanRequestAdapter({ planning: second.service, config });
    const replayed = await adapter.submit(again.envelope);
    assert.equal(replayed.planId, submitted.planId);
    assert.equal(replayed.phase, 'DRAFT');

    // The normalizer accepts any sender; only the adapter allowlist rejects.
    const foreign = validUpdate();
    foreign.message.from.id = 999;
    const foreignResult = normalize(foreign);
    assert.equal(foreignResult.kind, 'accepted');
    if (foreignResult.kind !== 'accepted') return;
    assert.equal(foreignResult.envelope.senderId, 999);
    await assert.rejects(adapter.submit(foreignResult.envelope), /Invalid Telegram text plan request/);

    assert.deepEqual(await second.plans.findById(submitted.planId), snapshot);
    assert.equal((await second.plans.listByProject(second.projectId)).length, 1);
    assert.deepEqual(rawCounts(path), { plans: 1, links: 1 });
    assert.equal(planner.calls(), 0);
    assert.equal(second.dispatcher.startCount(), 0);
  } finally {
    repo?.close();
  }
});
