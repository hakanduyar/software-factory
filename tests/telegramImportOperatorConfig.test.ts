import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTelegramImportOperatorConfig } from '../src/cli/telegramImportOperatorConfig.js';

const GENERIC = 'Telegram import failed.';

function base(): Record<string, unknown> {
  return {
    factoryDbPath: 'fake/factory.db',
    plansDbPath: 'fake/plans.db',
    trustedBotId: 11,
    projectId: 'project-x',
    allowedTuples: [{ botId: 11, chatId: 22, senderId: 33 }],
    planner: {},
    execution: {},
  };
}

function rejects(value: unknown): void {
  assert.throws(
    () => parseTelegramImportOperatorConfig(value),
    (err: unknown) => err instanceof Error && err.message === GENERIC,
  );
}

test('accepts minimal config without optional fields', () => {
  const out = parseTelegramImportOperatorConfig(base());
  assert.deepEqual(out, base());
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'budget'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'constraints'), false);
});

test('accepts full config, preserving literal strings and records', () => {
  const input = {
    ...base(),
    factoryDbPath: '  spaced path  ',
    projectId: ' p ',
    planner: { a: 1, nested: { b: [1, 2] } },
    execution: { mode: 'x' },
    budget: {},
    constraints: [' ', '', 'keep  me'],
    allowedTuples: [
      { botId: 1, chatId: -5, senderId: 2 },
      { botId: 1, chatId: -5, senderId: 2 },
      { botId: 9, chatId: 7, senderId: 3 },
    ],
    trustedBotId: 4,
  };
  const out = parseTelegramImportOperatorConfig(input);
  assert.deepEqual(out, input);
  assert.equal(out.factoryDbPath, '  spaced path  ');
  assert.equal(out.projectId, ' p ');
  assert.deepEqual(out.constraints, [' ', '', 'keep  me']);
  assert.notEqual(out.constraints, input.constraints);
  assert.equal(out.allowedTuples.length, 3);
});

test('accepts null-prototype top-level, tuple and nested records', () => {
  const top = Object.assign(Object.create(null), base());
  top.allowedTuples = [Object.assign(Object.create(null), { botId: 1, chatId: 2, senderId: 3 })];
  top.planner = Object.create(null);
  top.execution = Object.create(null);
  top.budget = Object.create(null);
  const out = parseTelegramImportOperatorConfig(top);
  assert.deepEqual(out.allowedTuples, [{ botId: 1, chatId: 2, senderId: 3 }]);
  assert.ok(out.budget);
});

test('rejects non-record top-level values', () => {
  for (const v of [undefined, null, 1, 'x', true, [], [base()], new Map(), new Date(), Object.create({})]) {
    rejects(v);
  }
  class C {}
  rejects(Object.assign(new C(), base()));
});

test('rejects unknown and missing keys', () => {
  rejects({ ...base(), extra: 1 });
  for (const key of Object.keys(base())) {
    const v = base();
    delete v[key];
    rejects(v);
  }
});

test('rejects invalid string fields', () => {
  for (const key of ['factoryDbPath', 'plansDbPath', 'projectId']) {
    for (const bad of ['', 1, null, undefined, {}, []]) {
      rejects({ ...base(), [key]: bad });
    }
  }
});

test('trustedBotId must be a positive safe integer', () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined]) {
    rejects({ ...base(), trustedBotId: bad });
  }
  const out = parseTelegramImportOperatorConfig({ ...base(), trustedBotId: Number.MAX_SAFE_INTEGER });
  assert.equal(out.trustedBotId, Number.MAX_SAFE_INTEGER);
});

test('tuple ids: bot/sender positive, chat signed nonzero, all safe integers', () => {
  const ok = (t: Record<string, unknown>) => {
    const first = parseTelegramImportOperatorConfig({ ...base(), allowedTuples: [t] }).allowedTuples[0];
    assert.ok(first);
    return first;
  };
  assert.deepEqual(ok({ botId: 1, chatId: -1, senderId: 1 }), { botId: 1, chatId: -1, senderId: 1 });
  assert.equal(ok({ botId: 1, chatId: Number.MIN_SAFE_INTEGER, senderId: 1 }).chatId, Number.MIN_SAFE_INTEGER);
  assert.equal(ok({ botId: 1, chatId: Number.MAX_SAFE_INTEGER, senderId: 1 }).chatId, Number.MAX_SAFE_INTEGER);

  const bad = [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined];
  for (const b of bad) {
    rejects({ ...base(), allowedTuples: [{ botId: b, chatId: 2, senderId: 3 }] });
    rejects({ ...base(), allowedTuples: [{ botId: 1, chatId: 2, senderId: b }] });
  }
  for (const b of [0, -0, 1.5, NaN, -Infinity, Number.MIN_SAFE_INTEGER - 1, '2', null, undefined]) {
    rejects({ ...base(), allowedTuples: [{ botId: 1, chatId: b, senderId: 3 }] });
  }
});

test('allowedTuples must be a nonempty array of exact-shape plain records', () => {
  for (const bad of [[], {}, null, undefined, 'x', 1]) {
    rejects({ ...base(), allowedTuples: bad });
  }
  const good = { botId: 1, chatId: 2, senderId: 3 };
  for (const bad of [null, 1, 'x', [], [good], { botId: 1, chatId: 2 }, { ...good, extra: 1 }, { botId: 1, chatId: 2, other: 3 }]) {
    rejects({ ...base(), allowedTuples: [bad] });
    rejects({ ...base(), allowedTuples: [good, bad] });
  }
});

test('tuples are not deduplicated and need not match trustedBotId', () => {
  const t = { botId: 99, chatId: 2, senderId: 3 };
  const out = parseTelegramImportOperatorConfig({ ...base(), trustedBotId: 5, allowedTuples: [t, { ...t }] });
  assert.equal(out.allowedTuples.length, 2);
  const first = out.allowedTuples[0];
  assert.ok(first);
  assert.equal(first.botId, 99);
});

test('planner, execution and budget must be plain records', () => {
  for (const key of ['planner', 'execution', 'budget']) {
    for (const bad of [null, undefined, 1, 'x', [], new Date(), new Map()]) {
      rejects({ ...base(), [key]: bad });
    }
  }
});

test('constraints must be an array of strings when present', () => {
  const out = parseTelegramImportOperatorConfig({ ...base(), constraints: [] });
  assert.deepEqual(out.constraints, []);
  for (const bad of [null, undefined, 'x', {}, 1, [1], ['a', 2], [null], [['a']]]) {
    rejects({ ...base(), constraints: bad });
  }
});

test('failure message is generic and omits input values', () => {
  const marker = 'inert-marker-value';
  try {
    parseTelegramImportOperatorConfig({ ...base(), projectId: '', extra: marker });
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof Error);
    assert.equal(err.message, GENERIC);
    assert.ok(!err.message.includes(marker));
  }
});
