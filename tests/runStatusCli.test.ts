import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  cleanupTempDbs,
  newSqliteFactory,
  registeredWorker,
  seedWorkItem,
  tempDbPath,
  toImplementing,
} from './support/factoryFixtures.js';

after(cleanupTempDbs);

const MAIN = fileURLToPath(new URL('../src/cli/main.js', import.meta.url));
const REQUIRED = ['id', 'workItemId', 'role', 'status', 'startedAt'];
const ALLOWED = [...REQUIRED, 'finishedAt'];

function cli(args: readonly string[]) {
  return spawnSync(process.execPath, [MAIN, ...args], { encoding: 'utf8', timeout: 5000 });
}

function siblings(dbPath: string): string[] {
  const name = basename(dbPath);
  const nativeReadonlySidecars = [`${name}-wal`, `${name}-shm`];
  return readdirSync(dirname(dbPath))
    .filter((n) => n.startsWith(name) && !nativeReadonlySidecars.includes(n))
    .sort();
}

async function seedRun(dbPath: string) {
  const writer = newSqliteFactory(dbPath);
  try {
    const item = await seedWorkItem(writer.factory);
    await toImplementing(writer.factory, item.id);
    const worker = registeredWorker(writer.factory, 'run-status-cli-test', ['IMPLEMENTER']);
    return (
      await writer.factory.runWorker({
        workItemId: item.id,
        role: 'IMPLEMENTER',
        worker,
        instructions: 'fixture implementation',
      })
    ).run;
  } finally {
    writer.store.close();
  }
}

function assertGenericFailure(stderr: string, dbPath: string) {
  assert.ok(stderr.trim().length > 0, 'stderr should explain the failure');
  assert.ok(!stderr.includes(dbPath), 'stderr must not leak the db path');
  assert.ok(!/SELECT|FROM |sqlite_master|\n\s+at /i.test(stderr.replace(/ExperimentalWarning[^\n]*/g, '')), 'no SQL or stack');
}

describe('sf run status CLI (real child process)', () => {
  it('prints the persisted run as a single DTO-only JSON line, read-only and repeatable', async () => {
    const dbPath = tempDbPath();
    const run = await seedRun(dbPath);
    const before = readFileSync(dbPath);
    const files = siblings(dbPath);

    const args = ['run', 'status', run.id, '--db', dbPath, '--json'];
    const first = cli(args);
    assert.equal(first.status, 0, first.stderr);
    const lines = first.stdout.split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 1);
    const firstLine: string | undefined = lines[0];
    assert.equal(typeof firstLine, 'string');
    const dto = JSON.parse(firstLine as string) as Record<string, unknown>;
    for (const k of REQUIRED) assert.ok(k in dto, `missing ${k}`);
    for (const k of Object.keys(dto)) assert.ok(ALLOWED.includes(k), `unexpected field ${k}`);
    assert.equal(dto.id, run.id);
    assert.equal(dto.workItemId, run.workItemId);
    assert.equal(typeof dto.startedAt, 'number');
    if ('finishedAt' in dto) assert.equal(typeof dto.finishedAt, 'number');
    assert.deepEqual(dto, {
      id: run.id,
      workItemId: run.workItemId,
      role: run.role,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    });

    const second = cli(args);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, first.stdout);

    assert.ok(readFileSync(dbPath).equals(before), 'db bytes must be unchanged');
    assert.deepEqual(siblings(dbPath), files);
  });

  it('fails generically for an unknown run id or a missing db without writing', async () => {
    const dbPath = tempDbPath();
    await seedRun(dbPath);
    const before = readFileSync(dbPath);

    const unknown = cli(['run', 'status', 'no-such-run', '--db', dbPath, '--json']);
    assert.notEqual(unknown.status, 0);
    assert.equal(unknown.stdout.trim(), '');
    assertGenericFailure(unknown.stderr, dbPath);
    assert.ok(readFileSync(dbPath).equals(before));

    const missing = tempDbPath();
    assert.ok(!existsSync(missing), 'fixture precondition: path absent');
    const res = cli(['run', 'status', 'any-id', '--db', missing, '--json']);
    assert.notEqual(res.status, 0);
    assert.equal(res.stdout.trim(), '');
    assertGenericFailure(res.stderr, missing);
    assert.ok(!existsSync(missing), 'missing db must not be created');
  });

  it('rejects invalid argument shapes with usage error before touching the db', () => {
    const missing = tempDbPath();
    assert.ok(!existsSync(missing));
    const cases: string[][] = [
      ['run', 'status', 'r1', '--db', missing, '--db', missing, '--json'],
      ['run', 'status', 'r1', '--db', missing],
      ['run', 'status', 'r1', '--db', missing, '--json', '--json'],
      ['run', 'status', 'r1', '--db', missing, '--json', '--extra'],
      ['run', 'status', 'r1', 'r2', '--db', missing, '--json'],
      ['run', 'status', '--db', missing, '--json'],
      ['run', 'bogus', 'r1', '--db', missing, '--json'],
    ];
    for (const args of cases) {
      const res = cli(args);
      assert.equal(res.status, 2, `${args.join(' ')}: ${res.stderr}`);
      assert.equal(res.stdout.trim(), '');
      assert.ok(!existsSync(missing), `db created for: ${args.join(' ')}`);
    }
  });
});
