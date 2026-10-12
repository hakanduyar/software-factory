import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { startPersistedRunStatusServer } from '../src/adapters/http/persistedRunStatusServer.js';
import {
  cleanupTempDbs,
  newSqliteFactory,
  registeredWorker,
  seedWorkItem,
  tempDbPath,
  toImplementing,
} from './support/factoryFixtures.js';

after(cleanupTempDbs);

async function writeCanonicalRun() {
  const dbPath = tempDbPath();
  const writer = newSqliteFactory(dbPath);
  try {
    const item = await seedWorkItem(writer.factory);
    await toImplementing(writer.factory, item.id);
    const worker = registeredWorker(writer.factory, 'persisted-http-test', ['IMPLEMENTER']);
    const run = (
      await writer.factory.runWorker({
        workItemId: item.id,
        role: 'IMPLEMENTER',
        worker,
        instructions: 'fixture implementation',
      })
    ).run;
    return { dbPath, run };
  } finally {
    writer.store.close();
  }
}

const digest = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

function get(
  address: AddressInfo,
  path: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        path,
        method: 'GET',
        headers: { Host: `127.0.0.1:${address.port}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('serves the allowlisted DTO for a canonical persisted run, identically after close/reopen', async () => {
  const { dbPath, run } = await writeCanonicalRun();
  const before = digest(dbPath);
  const expected: Record<string, unknown> = {
    id: run.id,
    workItemId: run.workItemId,
    role: run.role,
    status: run.status,
    startedAt: run.startedAt,
  };
  if (run.finishedAt !== undefined) expected.finishedAt = run.finishedAt;

  const first = await startPersistedRunStatusServer({ dbPath, port: 0 });
  let firstBody: unknown;
  try {
    const res = await get(first.address, `/runs/${run.id}`);
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /application\/json/);
    assert.match(String(res.headers['cache-control']), /no-store/);
    firstBody = JSON.parse(res.body);
    assert.deepEqual(firstBody, expected);

    const missing = await get(first.address, '/runs/unknown-run-id');
    assert.equal(missing.status, 404);
  } finally {
    await Promise.all([first.close(), first.close()]);
  }

  const second = await startPersistedRunStatusServer({ dbPath, port: 0 });
  try {
    const res = await get(second.address, `/runs/${run.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), firstBody);
  } finally {
    await second.close();
  }

  assert.equal(digest(dbPath), before);
});

test('a missing database rejects startup and is not created', async () => {
  const dbPath = tempDbPath();
  assert.equal(existsSync(dbPath), false);
  await assert.rejects(startPersistedRunStatusServer({ dbPath, port: 0 }));
  assert.equal(existsSync(dbPath), false);
});

test('an occupied loopback port fails startup, releases resources and preserves the database', async () => {
  const { dbPath, run } = await writeCanonicalRun();
  const before = digest(dbPath);

  const blocker = http.createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', () => resolve());
  });
  try {
    const occupied = blocker.address() as AddressInfo;
    await assert.rejects(startPersistedRunStatusServer({ dbPath, port: occupied.port }));
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
  assert.equal(digest(dbPath), before);

  const service = await startPersistedRunStatusServer({ dbPath, port: 0 });
  try {
    const res = await get(service.address, `/runs/${run.id}`);
    assert.equal(res.status, 200);
  } finally {
    await service.close();
  }
  assert.equal(digest(dbPath), before);
});
