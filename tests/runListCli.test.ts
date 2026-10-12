import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Run } from '../src/domain/run.js';
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

// The warning is disabled only for the owned child; application stderr is preserved.
function cli(args: readonly string[]) {
  const res = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    killSignal: 'SIGKILL',
  });
  assert.equal(res.error, undefined, `child failed or timed out: ${String(res.error)}`);
  return res;
}

function siblings(dbPath: string): string[] {
  const name = basename(dbPath);
  const nativeReadonlySidecars = [`${name}-wal`, `${name}-shm`];
  return readdirSync(dirname(dbPath))
    .filter((n) => n.startsWith(name) && !nativeReadonlySidecars.includes(n))
    .sort();
}

function expectedDto(run: Run): Record<string, unknown> {
  return {
    id: run.id,
    workItemId: run.workItemId,
    role: run.role,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
  };
}

interface Seeded {
  readonly itemId: string;
  readonly otherItemId: string;
  readonly emptyItemId: string;
  readonly runs: readonly [Run, Run];
  readonly otherRun: Run;
}

// Real writer, closed before any CLI child runs.
async function seedRuns(dbPath: string): Promise<Seeded> {
  const writer = newSqliteFactory(dbPath);
  try {
    const item = await seedWorkItem(writer.factory);
    const spec = {
      projectId: item.projectId,
      title: 'Second fixture work item',
      type: 'FEATURE' as const,
      planVersion: 'test-v1',
      acceptanceCriteria: [{ text: 'Behaviour C holds', verificationHint: 'npm test' }],
    };
    const other = await writer.factory.createWorkItem(spec);
    const empty = await writer.factory.createWorkItem({ ...spec, title: 'Item without runs' });
    await toImplementing(writer.factory, item.id);
    await toImplementing(writer.factory, other.id);
    const worker = registeredWorker(writer.factory, 'run-list-cli-test', ['IMPLEMENTER']);
    const start = async (workItemId: string, instructions: string) =>
      (await writer.factory.runWorker({ workItemId, role: 'IMPLEMENTER', worker, instructions })).run;
    const first = await start(item.id, 'fixture implementation one');
    const second = await start(item.id, 'fixture implementation two');
    const otherRun = await start(other.id, 'fixture implementation other');
    return { itemId: item.id, otherItemId: other.id, emptyItemId: empty.id, runs: [first, second], otherRun };
  } finally {
    writer.store.close();
  }
}

function assertGenericFailure(stderr: string, dbPath: string) {
  assert.ok(stderr.trim().length > 0, 'stderr should explain the failure');
  assert.ok(!stderr.includes(dbPath), 'stderr must not leak the db path');
  assert.ok(!/SELECT|FROM |sqlite_master|\n\s+at /i.test(stderr), 'no SQL or stack');
}

describe('sf run list CLI (real child process)', () => {
  it('lists exactly the work item runs as DTO-only JSON in creation order, read-only and repeatable', async () => {
    const dbPath = tempDbPath();
    const seeded = await seedRuns(dbPath);
    const before = readFileSync(dbPath);
    const files = siblings(dbPath);

    const args = ['run', 'list', '--work-item', seeded.itemId, '--db', dbPath, '--json'];
    const first = cli(args);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stderr, '');
    const lines = first.stdout.split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 1, 'exactly one JSON array line');
    const list = JSON.parse(lines[0] as string) as Record<string, unknown>[];
    assert.ok(Array.isArray(list));
    assert.equal(list.length, 2, 'other work item run must be excluded');
    for (const dto of list) {
      for (const k of REQUIRED) assert.ok(k in dto, `missing ${k}`);
      for (const k of Object.keys(dto)) assert.ok(ALLOWED.includes(k), `unexpected field ${k}`);
      assert.equal(typeof dto.startedAt, 'number');
      if ('finishedAt' in dto) assert.equal(typeof dto.finishedAt, 'number');
      assert.equal(dto.workItemId, seeded.itemId);
    }
    assert.deepEqual(list, seeded.runs.map(expectedDto));
    assert.ok(!list.some((d) => d.id === seeded.otherRun.id));

    const other = cli(['run', 'list', '--work-item', seeded.otherItemId, '--db', dbPath, '--json']);
    assert.equal(other.status, 0, other.stderr);
    assert.deepEqual(JSON.parse(other.stdout), [expectedDto(seeded.otherRun)]);

    const listed = list[1] as Record<string, unknown>;
    const status = cli(['run', 'status', String(listed.id), '--db', dbPath, '--json']);
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout), listed);

    const second = cli(args);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, first.stdout);

    assert.ok(readFileSync(dbPath).equals(before), 'db bytes must be unchanged');
    assert.deepEqual(siblings(dbPath), files);
  });

  it('returns [] with exit 0 for an unknown item or an item without runs', async () => {
    const dbPath = tempDbPath();
    const seeded = await seedRuns(dbPath);
    const before = readFileSync(dbPath);

    for (const id of ['no-such-item', seeded.emptyItemId]) {
      const res = cli(['run', 'list', '--work-item', id, '--db', dbPath, '--json']);
      assert.equal(res.status, 0, res.stderr);
      assert.deepEqual(JSON.parse(res.stdout), []);
      assert.equal(res.stdout.split('\n').filter((l) => l.length > 0).length, 1);
    }
    assert.ok(readFileSync(dbPath).equals(before), 'db bytes must be unchanged');
  });

  it('fails generically for a missing or corrupt db without creating or writing it', () => {
    const missing = tempDbPath();
    assert.ok(!existsSync(missing), 'fixture precondition: path absent');
    const res = cli(['run', 'list', '--work-item', 'any-id', '--db', missing, '--json']);
    assert.notEqual(res.status, 0);
    assert.equal(res.stdout.trim(), '');
    assertGenericFailure(res.stderr, missing);
    assert.ok(!existsSync(missing), 'missing db must not be created');

    const corrupt = tempDbPath();
    writeFileSync(corrupt, 'this is not a sqlite database, just text padding '.repeat(100));
    const before = readFileSync(corrupt);
    const files = siblings(corrupt);
    for (let i = 0; i < 2; i++) {
      const bad = cli(['run', 'list', '--work-item', 'any-id', '--db', corrupt, '--json']);
      assert.notEqual(bad.status, 0);
      assert.equal(bad.stdout.trim(), '');
      assertGenericFailure(bad.stderr, corrupt);
      assert.ok(readFileSync(corrupt).equals(before), 'corrupt db bytes must be unchanged');
    }
    assert.deepEqual(siblings(corrupt), files);
  });

  it('rejects duplicate, missing and unknown arguments with usage error before touching the db', () => {
    const missing = tempDbPath();
    assert.ok(!existsSync(missing));
    const cases: string[][] = [
      ['run', 'list', '--work-item', 'w1', '--work-item', 'w2', '--db', missing, '--json'],
      ['run', 'list', '--work-item', 'w1', '--db', missing, '--db', missing, '--json'],
      ['run', 'list', '--work-item', 'w1', '--db', missing, '--json', '--json'],
      ['run', 'list', '--db', missing, '--json'],
      ['run', 'list', '--work-item', '--db', missing, '--json'],
      ['run', 'list', '--work-item', 'w1', '--json'],
      ['run', 'list', '--work-item', 'w1', '--db', missing],
      ['run', 'list', '--work-item', 'w1', '--db', missing, '--json', '--extra'],
      ['run', 'list', 'w1', '--work-item', 'w1', '--db', missing, '--json'],
    ];
    for (const args of cases) {
      const res = cli(args);
      assert.equal(res.status, 2, `${args.join(' ')}: ${res.stderr}`);
      assert.equal(res.stdout.trim(), '');
      assert.ok(!existsSync(missing), `db created for: ${args.join(' ')}`);
    }
  });
});
