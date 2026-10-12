import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { createRunStatusServer, listenRunStatusServer } from '../src/adapters/http/runStatusServer.js';
import { startPersistedRunStatusServer } from '../src/adapters/http/persistedRunStatusServer.js';
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

const REQUEST_TIMEOUT_MS = 5000;
const REQUIRED = ['id', 'workItemId', 'role', 'status', 'startedAt'];
const ALLOWED = [...REQUIRED, 'finishedAt'];

interface Response {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

function send(
  port: number,
  method: string,
  path: string,
  headers: http.OutgoingHttpHeaders | string[] = { Host: `127.0.0.1:${port}` },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
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
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`request timed out: ${method} ${path}`)));
    req.on('error', reject);
    req.end();
  });
}

const get = (port: number, path: string) => send(port, 'GET', path);

// Common envelope for every captured response, success or refusal.
function assertCommon(res: Response, label: string): void {
  assert.match(String(res.headers['content-type']), /application\/json/, label);
  assert.match(String(res.headers['cache-control']), /no-store/, label);
  assert.equal(res.headers['access-control-allow-origin'], undefined, label);
  assert.doesNotThrow(() => JSON.parse(res.body), label);
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

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

// Real writer, closed before any server reads the file.
async function seedRuns(dbPath: string) {
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
    const worker = registeredWorker(writer.factory, 'run-discovery-http-test', ['IMPLEMENTER']);
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

test('lists a persisted work item runs as ordered DTO-only JSON over real HTTP, read-only', async () => {
  const dbPath = tempDbPath();
  const seeded = await seedRuns(dbPath);
  const before = digest(dbPath);

  const service = await startPersistedRunStatusServer({ dbPath, port: 0 });
  try {
    const port = service.address.port;
    const res = await get(port, `/work-items/${encodeURIComponent(seeded.itemId)}/runs`);
    assert.equal(res.status, 200);
    assertCommon(res, 'list');
    const list = JSON.parse(res.body) as Record<string, unknown>[];
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

    const other = await get(port, `/work-items/${encodeURIComponent(seeded.otherItemId)}/runs`);
    assert.equal(other.status, 200);
    assert.deepEqual(JSON.parse(other.body), [expectedDto(seeded.otherRun)]);

    // Existing single-run route is unchanged and yields the same DTO as the list.
    const listed = list[1] as Record<string, unknown>;
    const single = await get(port, `/runs/${String(listed.id)}`);
    assert.equal(single.status, 200);
    assertCommon(single, 'single');
    assert.deepEqual(JSON.parse(single.body), listed);

    for (const id of ['no-such-item', seeded.emptyItemId]) {
      const empty = await get(port, `/work-items/${encodeURIComponent(id)}/runs`);
      assert.equal(empty.status, 200);
      assertCommon(empty, `empty ${id}`);
      assert.deepEqual(JSON.parse(empty.body), []);
    }
  } finally {
    await service.close();
  }
  assert.equal(digest(dbPath), before, 'main db bytes must be unchanged');
});

test('a find-only repository keeps GET /runs working and answers the list route 404; a throwing list is a generic 500', async () => {
  const dbPath = tempDbPath();
  const seeded = await seedRuns(dbPath);
  const run = seeded.runs[0];
  assert.ok(run);
  const findById = async (id: string): Promise<Run | undefined> => (id === run.id ? run : undefined);
  const listPath = `/work-items/${encodeURIComponent(seeded.itemId)}/runs`;

  const legacy = createRunStatusServer({ runs: { findById } });
  const legacyAddress = await listenRunStatusServer(legacy, 0);
  try {
    const single = await get(legacyAddress.port, `/runs/${run.id}`);
    assert.equal(single.status, 200);
    assert.deepEqual(JSON.parse(single.body), expectedDto(run));
    const list = await get(legacyAddress.port, listPath);
    assert.equal(list.status, 404);
    assertCommon(list, 'legacy list');
  } finally {
    await closeServer(legacy);
  }

  const failing = createRunStatusServer({
    runs: {
      findById,
      listByWorkItem: async () => {
        throw new Error('private-list-sentinel');
      },
    },
  });
  const failingAddress = await listenRunStatusServer(failing, 0);
  try {
    const res = await get(failingAddress.port, listPath);
    assert.equal(res.status, 500);
    assertCommon(res, 'failing list');
    assert.equal(res.body.includes('private-list-sentinel'), false);
    assert.equal(res.body.toLowerCase().includes('stack'), false);
    assert.equal(res.body.includes(seeded.itemId), false);
  } finally {
    await closeServer(failing);
  }
});

test('the list route refuses bad origin, host, method and target before any repository read', async () => {
  const listCalls: string[] = [];
  const server = createRunStatusServer({
    runs: {
      findById: async () => undefined,
      listByWorkItem: async (workItemId: string) => {
        listCalls.push(workItemId);
        return [] as Run[];
      },
    },
  });
  const address: AddressInfo = await listenRunStatusServer(server, 0);
  const port = address.port;
  const host = `127.0.0.1:${port}`;
  const path = '/work-items/w1/runs';
  try {
    const refusals: [string, Response, number][] = [
      ['foreign host', await send(port, 'GET', path, { Host: `127.0.0.1:${port + 1}` }), 403],
      ['origin', await send(port, 'GET', path, { Host: host, Origin: 'https://example.invalid' }), 403],
      ['empty origin', await send(port, 'GET', path, { Host: host, Origin: '' }), 403],
      ['duplicate host', await send(port, 'GET', path, ['Host', host, 'Host', host]), 403],
      ['POST', await send(port, 'POST', path, { Host: host }), 405],
      ['malformed percent', await get(port, '/work-items/%zz/runs'), 400],
      ['invalid utf8', await get(port, '/work-items/%FF/runs'), 400],
      ['query', await get(port, `${path}?x=1`), 400],
      ['fragment', await get(port, `${path}#x`), 400],
      ['absolute form', await get(port, `http://${host}${path}`), 400],
      ['trailing slash', await get(port, `${path}/`), 404],
      ['extra segment', await get(port, `${path}/extra`), 404],
      ['empty segment', await get(port, '/work-items//runs'), 404],
      ['missing runs segment', await get(port, '/work-items/w1'), 404],
    ];
    for (const [label, res, status] of refusals) {
      assert.equal(res.status, status, label);
      assertCommon(res, label);
      assert.equal(res.body.includes('w1'), false, `${label}: body must not echo the id`);
    }
    assert.equal(refusals[4]?.[1].headers['allow'], 'GET');
    assert.deepEqual(listCalls, [], 'no repository list read for any refused request');

    const ok = await get(port, path);
    assert.equal(ok.status, 200);
    assertCommon(ok, 'accepted');
    assert.deepEqual(JSON.parse(ok.body), []);
    assert.deepEqual(listCalls, ['w1']);

    // A legitimate id that happens to be spelled "invalid" is accepted, literal or percent-encoded.
    for (const invalidPath of ['/work-items/invalid/runs', '/work-items/%69nvalid/runs']) {
      const res = await get(port, invalidPath);
      assert.equal(res.status, 200, invalidPath);
      assertCommon(res, `accepted ${invalidPath}`);
      assert.deepEqual(JSON.parse(res.body), []);
    }
    assert.deepEqual(listCalls, ['w1', 'invalid', 'invalid']);
  } finally {
    await closeServer(server);
  }
});
