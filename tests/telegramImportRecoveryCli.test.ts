import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createSqlitePlanRepository,
  upgradePlanSchemaV1ToV2,
} from '../src/adapters/planning/sqlitePlanRepository.js';
import { cleanupTempDbs, newSqliteFactory, tempDbPath } from './support/factoryFixtures.js';
import { TEST_PLANNER_CONFIG, testExecutionConfig } from './support/planFixtures.js';

after(cleanupTempDbs);

const MAIN = fileURLToPath(new URL('../src/cli/main.js', import.meta.url));
const LITERAL_TEXT = ' literal offline import ';
const LOCK_SUFFIX = '.sf-telegram-import.lock';
const GENERIC_LINE = 'Telegram import failed.';

// Test-owned child loader: forwards every fs call; throws once in fstatSync on the second owned wx lock FD.
const FAULT_LOADER = `
import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const realOpen = fs.openSync;
const realFstat = fs.fstatSync;
const ownedFds = new Set();
let ownedOpens = 0;
let thrown = false;
fs.openSync = function (...args) {
  const fd = Reflect.apply(realOpen, this, args);
  if (typeof args[0] === 'string' && args[0].endsWith(${JSON.stringify(LOCK_SUFFIX)}) && args[1] === 'wx') {
    ownedOpens += 1;
    if (ownedOpens === 2) ownedFds.add(fd);
  }
  return fd;
};
fs.fstatSync = function (...args) {
  if (!thrown && ownedFds.has(args[0])) {
    thrown = true;
    throw new Error('injected test fault');
  }
  return Reflect.apply(realFstat, this, args);
};
syncBuiltinESMExports();
`;

function childEnv(): NodeJS.ProcessEnv {
  const inherited = process.env.NODE_OPTIONS ?? '';
  return { ...process.env, NODE_OPTIONS: `${inherited} --disable-warning=ExperimentalWarning`.trim() };
}

function cli(updateFile: string, configFile: string, preload?: string) {
  const args = [
    ...(preload === undefined ? [] : ['--import', pathToFileURL(preload).href]),
    MAIN,
    'inbox',
    'telegram',
    'import',
    '--update',
    updateFile,
    '--config',
    configFile,
  ];
  return spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5000, env: childEnv() });
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

function lockFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(LOCK_SUFFIX));
}

async function setup(prefix: string) {
  const factoryPath = tempDbPath(prefix);
  const dir = dirname(factoryPath);
  const plansPath = join(dir, 'plans.db');
  const writer = newSqliteFactory(factoryPath);
  let projectId: string;
  try {
    projectId = (await writer.factory.createProject({ key: 'telegram-import-test', name: 'Telegram import fixture' })).id;
  } finally {
    writer.store.close();
  }
  createSqlitePlanRepository(plansPath).close();
  upgradePlanSchemaV1ToV2(plansPath);

  const updateFile = join(dir, 'update.json');
  const configFile = join(dir, 'config.json');
  writeFileSync(
    updateFile,
    JSON.stringify({
      update_id: 10,
      message: {
        message_id: 1,
        date: 1,
        from: { id: 333, is_bot: false },
        chat: { id: 222, type: 'private' },
        text: LITERAL_TEXT,
      },
    }),
  );
  writeFileSync(
    configFile,
    JSON.stringify({
      factoryDbPath: factoryPath,
      plansDbPath: plansPath,
      projectId,
      trustedBotId: 111,
      allowedTuples: [{ botId: 111, chatId: 222, senderId: 333 }],
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
    }),
  );
  return { factoryPath, dir, plansPath, updateFile, configFile };
}

test('real unmodified CLI child imports a valid update into one DRAFT plan with no provider execution', async () => {
  const { factoryPath, dir, plansPath, updateFile, configFile } = await setup('telegram-recovery-valid-');

  const child = cli(updateFile, configFile);

  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.signal, null);
  assert.equal(child.error, undefined);
  const lines = child.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const result = JSON.parse(lines[0] ?? '');
  assert.deepEqual(Object.keys(result).sort(), ['phase', 'planId']);
  assert.equal(result.phase, 'DRAFT');
  assert.equal(typeof result.planId, 'string');
  assert.ok(result.planId.trim().length > 0);
  for (const secret of [LITERAL_TEXT.trim(), configFile, factoryPath, plansPath]) {
    assert.ok(!child.stdout.includes(secret) && !child.stderr.includes(secret));
  }

  const repo = createSqlitePlanRepository(plansPath);
  try {
    const stored = await repo.findById(result.planId);
    assert.ok(stored);
    assert.equal(stored.phase, 'DRAFT');
    assert.equal(stored.totalPlannerRuns, 0);
    assert.equal(stored.dispatches.length, 0);
  } finally {
    repo.close();
  }
  assert.deepEqual(rawCounts(plansPath), { plans: 1, links: 1 });
  assert.deepEqual(lockFiles(dir), []);
});

test('real CLI child with injected fstat fault on the owned lock FD reports recovery, retains the unknown-identity lock and changes nothing', async () => {
  const { factoryPath, dir, plansPath, updateFile, configFile } = await setup('telegram-recovery-fault-');
  const loaderPath = join(dir, 'fault-loader.mjs');
  writeFileSync(loaderPath, FAULT_LOADER);

  const mainBefore = readFileSync(factoryPath);
  const plansBefore = readFileSync(plansPath);
  try {
    assert.deepEqual(rawCounts(plansPath), { plans: 0, links: 0 });

    const child = cli(updateFile, configFile, loaderPath);

    assert.equal(child.status, 1, child.stderr);
    assert.equal(child.signal, null);
    assert.equal(child.error, undefined);
    assert.equal(child.stdout, '');
    const lines = child.stderr.replace(/\r\n/g, '\n').trimEnd().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], GENERIC_LINE);
    assert.equal(lines[1], 'Recovery required: LOCK_OWNERSHIP_UNVERIFIED');
    for (const secret of [LITERAL_TEXT.trim(), configFile, factoryPath, plansPath, dir, 'injected test fault', 'at ']) {
      assert.ok(!child.stderr.includes(secret));
    }

    // Exactly the unknown-identity lock is retained; the previously captured lock is removed.
    assert.equal(lockFiles(dir).length, 1);
    assert.ok(mainBefore.equals(readFileSync(factoryPath)));
    assert.ok(plansBefore.equals(readFileSync(plansPath)));
    assert.deepEqual(rawCounts(plansPath), { plans: 0, links: 0 });
  } finally {
    // Test-owned disposal of the retained recovery lock in the fixture directory.
    for (const name of lockFiles(dir)) {
      const path = join(dir, name);
      if (existsSync(path)) unlinkSync(path);
    }
  }
});
