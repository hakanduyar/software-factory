import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
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

function cli(updateFile: string, configFile: string) {
  return spawnSync(
    process.execPath,
    [MAIN, 'inbox', 'telegram', 'import', '--update', updateFile, '--config', configFile],
    { encoding: 'utf8', timeout: 5000 },
  );
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

test('real CLI child imports one offline Telegram update into one DRAFT plan and replays it identically', async () => {
  const factoryPath = tempDbPath('telegram-import-cli-');
  const dir = dirname(factoryPath);
  const plansPath = join(dir, 'plans.db');

  // Setup only: seed a current Factory DB with one project and an explicitly upgraded v2 plans DB.
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

  const assertCleanChild = (child: ReturnType<typeof cli>): { planId: string; phase: string } => {
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.signal, null);
    assert.equal(child.error, undefined);
    const lines = child.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    const firstLine: string | undefined = lines[0];
    assert.notEqual(firstLine, undefined);
    if (firstLine === undefined) throw new Error('missing import stdout line');
    const result = JSON.parse(firstLine);
    assert.deepEqual(Object.keys(result).sort(), ['phase', 'planId']);
    assert.equal(result.phase, 'DRAFT');
    for (const secret of [LITERAL_TEXT.trim(), configFile, factoryPath, plansPath]) {
      assert.ok(!child.stdout.includes(secret) && !child.stderr.includes(secret));
    }
    assert.deepEqual(lockFiles(dir), []);
    return result;
  };

  const first = assertCleanChild(cli(updateFile, configFile));

  const readPlan = async (planId: string) => {
    const repo = createSqlitePlanRepository(plansPath);
    try {
      return await repo.findById(planId);
    } finally {
      repo.close();
    }
  };
  const stored = await readPlan(first.planId);
  assert.ok(stored);
  assert.equal(stored.projectId, projectId);
  assert.equal(stored.intent, LITERAL_TEXT);
  assert.equal(stored.phase, 'DRAFT');
  // No model/provider execution: the production CLI composes denial-only planner/dispatcher.
  assert.equal(stored.totalPlannerRuns, 0);
  assert.equal(stored.materialized.length, 0);
  assert.equal(stored.dispatches.length, 0);
  assert.deepEqual(rawCounts(plansPath), { plans: 1, links: 1 });
  const snapshot = structuredClone(stored);

  const second = assertCleanChild(cli(updateFile, configFile));
  assert.deepEqual(second, first);
  assert.deepEqual(rawCounts(plansPath), { plans: 1, links: 1 });
  assert.deepEqual(await readPlan(first.planId), snapshot);
});

type RefusalCase = 'invalid update JSON' | 'unauthorized sender 444' | 'missing config path' | 'preexisting owned lock';

for (const scenario of [
  'invalid update JSON',
  'unauthorized sender 444',
  'missing config path',
  'preexisting owned lock',
] as RefusalCase[]) {
  test(`real CLI child refuses fail-closed: ${scenario}`, async () => {
    const factoryPath = tempDbPath('telegram-import-refuse-');
    const dir = dirname(factoryPath);
    const plansPath = join(dir, 'plans.db');

    // Baseline: current Factory DB + v2 plans DB, no plans/links; all writer handles closed before the CLI runs.
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
    const senderId = scenario === 'unauthorized sender 444' ? 444 : 333;
    writeFileSync(
      updateFile,
      scenario === 'invalid update JSON'
        ? '{ not json'
        : JSON.stringify({
            update_id: 10,
            message: {
              message_id: 1,
              date: 1,
              from: { id: senderId, is_bot: false },
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

    const lockPath = factoryPath + LOCK_SUFFIX;
    const lockBytes = Buffer.from('test-owned-lock');
    const owned = scenario === 'preexisting owned lock';
    const missingConfig = join(dir, 'absent-config.json');
    if (owned) writeFileSync(lockPath, lockBytes);

    try {
      assert.deepEqual(rawCounts(plansPath), { plans: 0, links: 0 });
      const mainBefore = readFileSync(factoryPath);
      const plansBefore = readFileSync(plansPath);

      const child = cli(updateFile, scenario === 'missing config path' ? missingConfig : configFile);

      assert.notEqual(child.status, 0);
      assert.equal(child.signal, null);
      assert.equal(child.error, undefined);
      assert.equal(child.stdout, '');
      assert.equal(child.stderr.replace(/\r\n/g, '\n'), 'Telegram import failed.\n');
      assert.deepEqual(rawCounts(plansPath), { plans: 0, links: 0 });
      assert.ok(mainBefore.equals(readFileSync(factoryPath)));
      assert.ok(plansBefore.equals(readFileSync(plansPath)));
      if (scenario === 'missing config path') assert.equal(existsSync(missingConfig), false);
      if (owned) {
        assert.ok(readFileSync(lockPath).equals(lockBytes));
        assert.deepEqual(lockFiles(dir), [lockPath.slice(dir.length + 1)]);
      } else {
        assert.deepEqual(lockFiles(dir), []);
      }
    } finally {
      if (owned && existsSync(lockPath)) unlinkSync(lockPath);
    }
  });
}

type PlansSlotCase = 'missing plans DB path' | 'empty plans DB file' | 'valid v1 plans DB without upgrade' | 'foreign SQLite DB';

for (const scenario of [
  'missing plans DB path',
  'empty plans DB file',
  'valid v1 plans DB without upgrade',
  'foreign SQLite DB',
] as PlansSlotCase[]) {
  test(`real CLI child refuses fail-closed on plans schema: ${scenario}`, async () => {
    const factoryPath = tempDbPath('telegram-import-schema-');
    const dir = dirname(factoryPath);
    const plansPath = join(dir, 'plans.db');

    // Valid Factory DB/project; writer handle closed before the CLI runs.
    const writer = newSqliteFactory(factoryPath);
    let projectId: string;
    try {
      projectId = (await writer.factory.createProject({ key: 'telegram-import-test', name: 'Telegram import fixture' })).id;
    } finally {
      writer.store.close();
    }

    // Plans slot: one invalid case, never upgraded.
    if (scenario === 'empty plans DB file') {
      writeFileSync(plansPath, Buffer.alloc(0));
    } else if (scenario === 'valid v1 plans DB without upgrade') {
      createSqlitePlanRepository(plansPath).close();
    } else if (scenario === 'foreign SQLite DB') {
      const foreign = new DatabaseSync(plansPath);
      try {
        foreign.exec('CREATE TABLE unrelated(id INTEGER)');
      } finally {
        foreign.close();
      }
    }

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

    const missing = scenario === 'missing plans DB path';
    const mainBefore = readFileSync(factoryPath);
    const plansBefore = missing ? undefined : readFileSync(plansPath);

    const child = cli(updateFile, configFile);

    assert.notEqual(child.status, 0);
    assert.equal(child.signal, null);
    assert.equal(child.error, undefined);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr.replace(/\r\n/g, '\n'), 'Telegram import failed.\n');
    assert.ok(mainBefore.equals(readFileSync(factoryPath)));
    if (plansBefore === undefined) assert.equal(existsSync(plansPath), false);
    else assert.ok(plansBefore.equals(readFileSync(plansPath)));
    assert.deepEqual(lockFiles(dir), []);
  });
}
