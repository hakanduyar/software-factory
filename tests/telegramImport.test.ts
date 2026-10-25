import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTelegramImportArgv } from '../src/cli/telegramImport.js';

test('Telegram import arguments accept both flag orders and preserve literal paths', () => {
  const expected = { updatePath: ' update file.json ', configPath: 'C:/config file.json' };
  for (const argv of [
    ['--update', expected.updatePath, '--config', expected.configPath],
    ['--config', expected.configPath, '--update', expected.updatePath],
  ]) {
    const original = [...argv];
    assert.deepEqual(parseTelegramImportArgv(Object.freeze(argv)), expected);
    assert.deepEqual(argv, original);
  }
});

test('Telegram import arguments reject missing, extra, duplicate and unknown flags', () => {
  const cases = [
    [], ['--update', 'a'], ['--update', 'a', '--config'],
    ['--update', 'a', '--config', 'b', '--extra', 'c'],
    ['--update', 'a', '--update', 'b'], ['--config', 'a', '--config', 'b'],
    ['--unknown', 'a', '--config', 'b'], ['--UPDATE', 'a', '--config', 'b'],
    ['--update=a', '--config=b'], ['a', '--update', 'b', '--config'],
    ['--update', '', '--config', 'b'], ['--update', 'a', '--config', ' \t\n'],
  ];
  for (const argv of cases) {
    assert.throws(() => parseTelegramImportArgv(argv), { message: 'Telegram import failed.' });
  }
});

test('Telegram import arguments fail closed for malformed runtime inputs without leaking values', () => {
  const sentinel = 'private-path-sentinel';
  for (const value of [null, {}, 'abcd', [7, sentinel, '--config', 'b'],
    ['--update', 7, '--config', sentinel], ['--update', sentinel, '--config', null]]) {
    assert.throws(() => parseTelegramImportArgv(value as unknown as readonly string[]),
      { name: 'Error', message: 'Telegram import failed.' });
  }
});
