import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeTelegramImportJsonBytes } from '../src/cli/telegramImportJsonBytes.js';
import { parseTelegramImportOperatorConfig } from '../src/cli/telegramImportOperatorConfig.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const FAIL = { message: 'Telegram import failed.' };

test('decodes unicode object, scalars and null', () => {
  const text = '{"a":"çğ✓😀"}';
  const r = decodeTelegramImportJsonBytes(enc(text));
  assert.equal(r.raw, text);
  assert.deepEqual(r.value, { a: 'çğ✓😀' });
  assert.equal(decodeTelegramImportJsonBytes(enc('42')).value, 42);
  assert.equal(decodeTelegramImportJsonBytes(enc('"x"')).value, 'x');
  assert.equal(decodeTelegramImportJsonBytes(enc('true')).value, true);
  assert.equal(decodeTelegramImportJsonBytes(enc('null')).value, null);
  assert.equal(decodeTelegramImportJsonBytes(Buffer.from('[1]')).raw, '[1]');
});

test('size boundary: 65536 accepted, 65537 refused before decode', () => {
  const pad = (n: number): Uint8Array => enc(`"${'a'.repeat(n - 2)}"`);
  assert.equal(decodeTelegramImportJsonBytes(pad(65536)).raw.length, 65536);
  // invalid UTF-8 and invalid JSON both fail identically; oversize must also fail with the generic error
  assert.throws(() => decodeTelegramImportJsonBytes(pad(65537)), FAIL);
  assert.throws(() => decodeTelegramImportJsonBytes(new Uint8Array(65537).fill(0xff)), FAIL);
});

test('malformed UTF-8, invalid and empty JSON fail generically without leaking input', () => {
  for (const bad of [new Uint8Array([0x22, 0xc3, 0x28, 0x22]), enc('{"secret-token":'), enc(''), enc('nope')]) {
    assert.throws(
      () => decodeTelegramImportJsonBytes(bad),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.equal(e.message, 'Telegram import failed.');
        assert.equal(e.cause, undefined);
        return true;
      },
    );
  }
});

test('UTF-8 BOM is stripped by the decoder and JSON still parses', () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('{"a":1}')]);
  const r = decodeTelegramImportJsonBytes(bytes);
  assert.equal(r.raw, '{"a":1}');
  assert.deepEqual(r.value, { a: 1 });
});

test('respects view offset and length, and does not mutate input', () => {
  const backing = Buffer.from('xx{"a":1}yy');
  const view = backing.subarray(2, 9);
  const before = Buffer.from(backing);
  assert.deepEqual(decodeTelegramImportJsonBytes(view).value, { a: 1 });
  assert.deepEqual(backing, before);
  const u8 = new Uint8Array(backing.buffer, backing.byteOffset + 2, 7);
  assert.equal(decodeTelegramImportJsonBytes(u8).raw, '{"a":1}');
});

test('rejects non-Uint8Array runtime inputs', () => {
  for (const bad of ['{}', null, undefined, 1, {}, [123], new ArrayBuffer(2), new DataView(new ArrayBuffer(2))]) {
    assert.throws(() => decodeTelegramImportJsonBytes(bad as unknown as Uint8Array), FAIL);
  }
});

test('decoded value composes with the operator config parser; raw preserved', () => {
  const text = JSON.stringify({
    factoryDbPath: 'factory.db',
    plansDbPath: 'plans.db',
    trustedBotId: 1,
    projectId: 'synthetic',
    allowedTuples: [{ botId: 1, chatId: -2, senderId: 3 }],
    planner: {},
    execution: {},
  });
  const update = decodeTelegramImportJsonBytes(Buffer.from(text));
  assert.equal(update.raw, text);
  const config = parseTelegramImportOperatorConfig(update.value);
  assert.equal(config.projectId, 'synthetic');
  assert.deepEqual(config.allowedTuples, [{ botId: 1, chatId: -2, senderId: 3 }]);
});
