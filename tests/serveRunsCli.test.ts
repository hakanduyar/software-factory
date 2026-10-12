import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import {
  cleanupTempDbs,
  newSqliteFactory,
  registeredWorker,
  seedWorkItem,
  tempDbPath,
  toImplementing,
} from './support/factoryFixtures.js';

after(cleanupTempDbs);

const CHILD_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_CAPTURE = 64 * 1024;

const MODULE_URL = pathToFileURL(
  fileURLToPath(new URL('../src/cli/serveRuns.js', import.meta.url)),
).href;
const CHILD_CODE =
  `import { runServeRuns } from ${JSON.stringify(MODULE_URL)};\n` +
  `process.exitCode = await runServeRuns(process.argv.slice(1));\n`;

interface ServeChild {
  readonly proc: ChildProcessWithoutNullStreams;
  stdout(): string;
  stderr(): string;
  /** First complete stdout line, or undefined if the child exited without one. */
  firstLine(): Promise<string | undefined>;
  exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Cleanup only: forcibly stops a child that is still running. Never a graceful proof. */
  forceKill(): Promise<void>;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function spawnServe(args: readonly string[]): ServeChild {
  const proc = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', CHILD_CODE, '--', ...args],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let out = '';
  let err = '';
  let lineResolve: (line: string | undefined) => void = () => {};
  let lineSettled = false;
  const linePromise = new Promise<string | undefined>((resolve) => {
    lineResolve = resolve;
  });
  const settleLine = (line: string | undefined): void => {
    if (!lineSettled) {
      lineSettled = true;
      lineResolve(line);
    }
  };

  proc.stdin.on('error', () => {});
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    if (out.length < MAX_CAPTURE) out += chunk;
    const newline = out.indexOf('\n');
    if (newline >= 0) settleLine(out.slice(0, newline));
  });
  proc.stderr.on('data', (chunk: string) => {
    if (err.length < MAX_CAPTURE) err += chunk;
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      proc.once('error', reject);
      proc.once('close', (code, signal) => {
        settleLine(undefined);
        resolve({ code, signal });
      });
    },
  );
  exited.catch(() => {});

  return {
    proc,
    stdout: () => out,
    stderr: () => err,
    firstLine: () => linePromise,
    exited: () => exited,
    async forceKill() {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill();
      }
      await withTimeout(exited, 5_000, 'child termination').catch(() => {});
    },
  };
}

async function writeCanonicalRun() {
  const dbPath = tempDbPath();
  const writer = newSqliteFactory(dbPath);
  try {
    const item = await seedWorkItem(writer.factory);
    await toImplementing(writer.factory, item.id);
    const worker = registeredWorker(writer.factory, 'serve-cli-test', ['IMPLEMENTER']);
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

function expectedDto(run: {
  id: string;
  workItemId: string;
  role: string;
  status: string;
  startedAt: number;
  finishedAt?: number;
}): Record<string, unknown> {
  const dto: Record<string, unknown> = {
    id: run.id,
    workItemId: run.workItemId,
    role: run.role,
    status: run.status,
    startedAt: run.startedAt,
  };
  if (run.finishedAt !== undefined) dto.finishedAt = run.finishedAt;
  return dto;
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { Host: `127.0.0.1:${port}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** A fresh TCP connection to the port; resolves with the error code it was refused with. */
function connectionOutcome(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('connection attempt timeout'));
    }, REQUEST_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve('CONNECTED');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(error.code ?? 'ERROR');
    });
  });
}

function parseBoundLine(line: string | undefined): { address: string; port: number; family: string } {
  assert.notEqual(line, undefined, 'child must print a bound-address line');
  const parsed = JSON.parse(line as string) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ['address', 'family', 'port']);
  assert.equal(parsed.address, '127.0.0.1');
  assert.equal(parsed.family, 'IPv4');
  assert.ok(Number.isInteger(parsed.port) && (parsed.port as number) > 0 && (parsed.port as number) <= 65535);
  return parsed as { address: string; port: number; family: string };
}

function assertGenericStderr(stderr: string, dbPath: string): void {
  assert.ok(stderr.length > 0, 'a generic message is expected on stderr');
  assert.ok(!stderr.includes(dbPath), 'stderr must not leak the database path');
  assert.doesNotMatch(stderr, /sqlite|select |insert |EADDRINUSE|ENOENT|\n\s+at /i);
}

test('--shutdown-on-stdin-eof: serves persisted DTO, then stdin EOF closes gracefully with exit 0', async () => {
  const { dbPath, run } = await writeCanonicalRun();
  const before = readFileSync(dbPath);
  const child = spawnServe(['--db', dbPath, '--port', '0', '--shutdown-on-stdin-eof']);
  let port = 0;
  try {
    const bound = parseBoundLine(await withTimeout(child.firstLine(), CHILD_TIMEOUT_MS, 'bound line'));
    port = bound.port;

    const res = await get(port, `/runs/${run.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), expectedDto(run));

    child.proc.stdin.end();
    const result = await withTimeout(child.exited(), CHILD_TIMEOUT_MS, 'graceful exit');
    assert.equal(result.signal, null);
    assert.equal(result.code, 0);
  } finally {
    await child.forceKill();
  }

  assert.equal(child.stdout().split('\n').filter((l) => l.length > 0).length, 1);
  assert.ok(!child.stdout().includes(dbPath));
  assert.equal(child.stderr(), '');
  assert.equal(await connectionOutcome(port), 'ECONNREFUSED');
  assert.ok(readFileSync(dbPath).equals(before), 'main database bytes must be unchanged');
});

test('--shutdown-on-stdin-eof: EOF during startup still ends in one close, exit 0, no leftover listener', async () => {
  const { dbPath } = await writeCanonicalRun();
  const before = readFileSync(dbPath);
  const child = spawnServe(['--db', dbPath, '--port', '0', '--shutdown-on-stdin-eof']);
  try {
    child.proc.stdin.end();
    const result = await withTimeout(child.exited(), CHILD_TIMEOUT_MS, 'exit after early EOF');
    assert.equal(result.signal, null);
    assert.equal(result.code, 0);
  } finally {
    await child.forceKill();
  }

  const lines = child.stdout().split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  const bound = parseBoundLine(lines[0]);
  assert.equal(await connectionOutcome(bound.port), 'ECONNREFUSED');
  assert.equal(child.stderr(), '');
  assert.ok(readFileSync(dbPath).equals(before), 'main database bytes must be unchanged');
});

test('startup failure on an occupied loopback port exits 1 with generic stderr; missing DB is not created', async () => {
  const { dbPath } = await writeCanonicalRun();
  const before = readFileSync(dbPath);

  const blocker = net.createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', () => resolve());
  });
  try {
    const occupied = (blocker.address() as net.AddressInfo).port;
    const child = spawnServe(['--db', dbPath, '--port', String(occupied)]);
    try {
      const result = await withTimeout(child.exited(), CHILD_TIMEOUT_MS, 'occupied-port exit');
      assert.equal(result.code, 1);
    } finally {
      await child.forceKill();
    }
    assert.equal(child.stdout(), '');
    assertGenericStderr(child.stderr(), dbPath);
    assert.ok(readFileSync(dbPath).equals(before), 'main database bytes must be unchanged');

    const missing = `${tempDbPath()}.missing`;
    const second = spawnServe(['--db', missing, '--port', '0']);
    try {
      const result = await withTimeout(second.exited(), CHILD_TIMEOUT_MS, 'missing-db exit');
      assert.equal(result.code, 1);
    } finally {
      await second.forceKill();
    }
    assert.equal(second.stdout(), '');
    assertGenericStderr(second.stderr(), missing);
    assert.equal(existsSync(missing), false);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test('invalid arguments exit 2 with generic usage before any SQLite or listen work', async () => {
  const missing = `${tempDbPath()}.never-created`;
  const cases: readonly (readonly string[])[] = [
    ['--db', missing, '--port', '65536'],
    ['--db', missing, '--port', '0', '--host', '0.0.0.0'],
  ];
  for (const args of cases) {
    const child = spawnServe(args);
    try {
      const result = await withTimeout(child.exited(), CHILD_TIMEOUT_MS, 'usage exit');
      assert.equal(result.code, 2);
    } finally {
      await child.forceKill();
    }
    assert.equal(child.stdout(), '');
    assertGenericStderr(child.stderr(), missing);
    assert.equal(existsSync(missing), false);
  }
});

test('default (no flag): stdin EOF alone does not stop the server; it still serves GET', async () => {
  const { dbPath, run } = await writeCanonicalRun();
  const child = spawnServe(['--db', dbPath, '--port', '0']);
  try {
    const bound = parseBoundLine(await withTimeout(child.firstLine(), CHILD_TIMEOUT_MS, 'bound line'));
    child.proc.stdin.end();
    const res = await get(bound.port, `/runs/${run.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), expectedDto(run));
    assert.equal(child.proc.exitCode, null);
  } finally {
    // Forced termination is cleanup only; it proves nothing about graceful close.
    await child.forceKill();
  }
});
