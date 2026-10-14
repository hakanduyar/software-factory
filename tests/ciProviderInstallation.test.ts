/**
 * CI provider installation boundary.
 *
 * Exercises scripts/install-ci-provider.mjs against isolated temporary trees.
 * Refusal fixtures use sparse files of the pinned length, so each case starts from
 * an otherwise valid layout and the category asserted is the guard under test:
 * deleting that guard changes the category (usually to executable-hash) and fails
 * the case. Only the genuine-artifact block copies the real native binary, and
 * only into its own temporary root. No fixture executes any binary; the genuine
 * --version check belongs to the controller after a fresh npm ci.
 *
 * The helper is plain JavaScript and tsconfig has no allowJs, so it is loaded
 * through a computed dynamic import and typed here.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface InstallOptions {
  readonly repositoryRoot: string;
  readonly platform: string;
  readonly architecture: string;
  readonly glibcRuntimeVersion: string | undefined;
}

interface InstallResult {
  readonly status: 'installed' | 'already-installed' | 'unsupported';
  readonly supported: boolean;
  readonly mutated: boolean;
}

interface CiProviderConstants {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly binarySha256: string;
  readonly binaryBytes: number;
  readonly targetRelative: string;
  readonly linkRelative: string;
  readonly linkTarget: string;
}

interface HelperModule {
  readonly installCiProvider: (options: InstallOptions) => InstallResult;
  readonly CI_PROVIDER: CiProviderConstants;
}

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HELPER_PATH = join(REPO_ROOT, 'scripts', 'install-ci-provider.mjs');
const GENUINE_EXECUTABLE = join(REPO_ROOT, 'node_modules', '@anthropic-ai', 'claude-code-linux-x64', 'claude');

const helper = (await import(pathToFileURL(HELPER_PATH).href)) as HelperModule;

// Independent literals: the helper's own constants are asserted against these.
const PINNED_NAME = '@anthropic-ai/claude-code-linux-x64';
const PINNED_VERSION = '2.1.296';
const PINNED_SHA256 = '24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de';
const PINNED_BYTES = 257068216;
const PINNED_TARGET = 'node_modules/@anthropic-ai/claude-code-linux-x64/claude';
const PINNED_LINK = 'node_modules/.bin/claude';
const PINNED_LINK_TARGET = '../@anthropic-ai/claude-code-linux-x64/claude';

function hostGlibc(): string | undefined {
  const report = process.report;
  if (report === undefined) {
    return undefined;
  }
  (report as NodeJS.ProcessReport & { excludeNetwork: boolean }).excludeNetwork = true;
  const parsed = report.getReport() as { header?: { glibcVersionRuntime?: unknown } };
  const version = parsed.header?.glibcVersionRuntime;
  return typeof version === 'string' && version.length > 0 ? version : undefined;
}

const HOST_SUPPORTED = process.platform === 'linux' && process.arch === 'x64' && hostGlibc() !== undefined;

const temporaryRoots: string[] = [];

function makeTemporary(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'sf-ci-provider-')));
  temporaryRoots.push(path);
  return path;
}

after(() => {
  for (const path of temporaryRoots) {
    rmSync(path, { recursive: true, force: true });
  }
});

interface Fixture {
  readonly root: string;
  readonly nodeModules: string;
  readonly scope: string;
  readonly packageDirectory: string;
  readonly executable: string;
  readonly binDirectory: string;
  readonly destination: string;
}

function metadata(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: PINNED_NAME,
    version: PINNED_VERSION,
    os: ['linux'],
    cpu: ['x64'],
    libc: ['glibc'],
    ...overrides,
  });
}

function writeMetadata(fixture: Fixture, overrides: Record<string, unknown>): void {
  writeFileSync(join(fixture.packageDirectory, 'package.json'), metadata(overrides));
}

function buildFixture(bytes: 'sparse' | 'genuine'): Fixture {
  const root = makeTemporary();
  const nodeModules = join(root, 'node_modules');
  const scope = join(nodeModules, '@anthropic-ai');
  const packageDirectory = join(scope, 'claude-code-linux-x64');
  const executable = join(packageDirectory, 'claude');
  const binDirectory = join(nodeModules, '.bin');
  mkdirSync(packageDirectory, { recursive: true });
  mkdirSync(binDirectory);
  writeFileSync(join(packageDirectory, 'package.json'), metadata());
  if (bytes === 'sparse') {
    const descriptor = openSync(executable, 'w', 0o755);
    try {
      ftruncateSync(descriptor, PINNED_BYTES);
    } finally {
      closeSync(descriptor);
    }
  } else {
    copyFileSync(GENUINE_EXECUTABLE, executable, constants.COPYFILE_FICLONE);
  }
  chmodSync(executable, 0o755);
  return { root, nodeModules, scope, packageDirectory, executable, binDirectory, destination: join(binDirectory, 'claude') };
}

function supportedOptions(repositoryRoot: string): InstallOptions {
  return { repositoryRoot, platform: 'linux', architecture: 'x64', glibcRuntimeVersion: '2.35' };
}

/** Metadata-only listing: type, link target, mode, links, size, inode, mtime. File contents are never read. */
function snapshot(root: string): string[] {
  const lines: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const full = join(directory, name);
      const stat = lstatSync(full);
      const kind = stat.isSymbolicLink() ? `link:${readlinkSync(full)}` : stat.isDirectory() ? 'dir' : 'file';
      lines.push(
        `${relative(root, full)}|${kind}|${stat.mode.toString(8)}|${stat.nlink}|${stat.size}|${stat.ino}|${stat.mtimeMs}`,
      );
      if (stat.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(root);
  return lines;
}

function refusalOf(category: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, `ci-provider-install-refused: ${category}`);
    return true;
  };
}

function expectRefusal(root: string, category: string): void {
  const initial = snapshot(root);
  assert.throws(() => helper.installCiProvider(supportedOptions(root)), refusalOf(category));
  assert.deepEqual(snapshot(root), initial, 'a refusal must leave the tree unchanged');
}

describe('ciProviderInstallation: pinned constants and entry point', () => {
  it('pins the package, hash, length and paths independently of the helper', () => {
    assert.deepEqual(
      { ...helper.CI_PROVIDER },
      {
        packageName: PINNED_NAME,
        packageVersion: PINNED_VERSION,
        binarySha256: PINNED_SHA256,
        binaryBytes: PINNED_BYTES,
        targetRelative: PINNED_TARGET,
        linkRelative: PINNED_LINK,
        linkTarget: PINNED_LINK_TARGET,
      },
    );
  });

  it('the CLI accepts no arguments and refuses before touching anything', () => {
    const run = spawnSync(process.execPath, [HELPER_PATH, 'unexpected'], { encoding: 'utf8', env: {} });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'ci-provider-install-refused: arguments\n');
  });
});

interface UnsupportedRow {
  readonly name: string;
  readonly override: Partial<InstallOptions>;
}

const UNSUPPORTED_ROWS: readonly UnsupportedRow[] = [
  { name: 'platform darwin', override: { platform: 'darwin' } },
  { name: 'platform win32', override: { platform: 'win32' } },
  { name: 'architecture arm64', override: { architecture: 'arm64' } },
  { name: 'architecture ia32', override: { architecture: 'ia32' } },
  { name: 'musl (no glibc runtime version)', override: { glibcRuntimeVersion: undefined } },
  { name: 'empty glibc runtime version', override: { glibcRuntimeVersion: '' } },
];

describe('ciProviderInstallation: unsupported tuple', () => {
  for (const row of UNSUPPORTED_ROWS) {
    it(`reports unsupported and mutates nothing for ${row.name}`, () => {
      const fixture = buildFixture('sparse');
      const initial = snapshot(fixture.root);
      const result = helper.installCiProvider({ ...supportedOptions(fixture.root), ...row.override });
      assert.deepEqual({ ...result }, { status: 'unsupported', supported: false, mutated: false });
      assert.deepEqual(snapshot(fixture.root), initial);
    });
  }

  it('does not inspect the filesystem for an unsupported tuple', () => {
    const missing = join(makeTemporary(), 'missing');
    const result = helper.installCiProvider({ ...supportedOptions(missing), platform: 'darwin' });
    assert.deepEqual({ ...result }, { status: 'unsupported', supported: false, mutated: false });
    assert.equal(existsSync(missing), false);
  });
});

interface RefusalCase {
  readonly name: string;
  readonly category: string;
  readonly mutate: (fixture: Fixture) => void;
}

const OWNED_METADATA_PATH = 'package.json';

const REFUSALS: readonly RefusalCase[] = [
  // Package metadata
  {
    name: 'missing package metadata',
    category: 'metadata',
    mutate: (fixture) => rmSync(join(fixture.packageDirectory, OWNED_METADATA_PATH)),
  },
  {
    name: 'unparseable package metadata',
    category: 'metadata',
    mutate: (fixture) => writeFileSync(join(fixture.packageDirectory, OWNED_METADATA_PATH), '{'),
  },
  {
    name: 'symlinked package metadata',
    category: 'metadata',
    mutate: (fixture) => {
      const outside = join(makeTemporary(), 'package.json');
      writeFileSync(outside, metadata());
      rmSync(join(fixture.packageDirectory, OWNED_METADATA_PATH));
      symlinkSync(outside, join(fixture.packageDirectory, OWNED_METADATA_PATH));
    },
  },
  { name: 'wrong package name', category: 'metadata', mutate: (fixture) => writeMetadata(fixture, { name: '@anthropic-ai/claude-code' }) },
  { name: 'wrong package version', category: 'metadata', mutate: (fixture) => writeMetadata(fixture, { version: '2.1.295' }) },
  { name: 'wrong os', category: 'metadata', mutate: (fixture) => writeMetadata(fixture, { os: ['darwin'] }) },
  { name: 'wrong cpu', category: 'metadata', mutate: (fixture) => writeMetadata(fixture, { cpu: ['arm64'] }) },
  { name: 'missing cpu', category: 'metadata', mutate: (fixture) => writeMetadata(fixture, { cpu: undefined }) },
  { name: 'wrong libc', category: 'metadata', mutate: (fixture) => writeMetadata(fixture, { libc: ['musl'] }) },
  { name: 'missing libc', category: 'metadata', mutate: (fixture) => writeMetadata(fixture, { libc: undefined }) },

  // Containment: nothing may be a link or lead away from the owned installation
  {
    name: 'package directory replaced by a symlink',
    category: 'layout',
    mutate: (fixture) => {
      const moved = join(fixture.scope, 'moved-package');
      renameSync(fixture.packageDirectory, moved);
      symlinkSync(moved, fixture.packageDirectory, 'dir');
    },
  },
  {
    name: 'scope directory replaced by a symlink',
    category: 'layout',
    mutate: (fixture) => {
      const moved = join(fixture.nodeModules, 'moved-scope');
      renameSync(fixture.scope, moved);
      symlinkSync(moved, fixture.scope, 'dir');
    },
  },
  {
    name: 'node_modules replaced by a symlink',
    category: 'layout',
    mutate: (fixture) => {
      const moved = join(fixture.root, 'moved-modules');
      renameSync(fixture.nodeModules, moved);
      symlinkSync(moved, fixture.nodeModules, 'dir');
    },
  },
  {
    name: 'missing package directory',
    category: 'layout',
    mutate: (fixture) => rmSync(fixture.packageDirectory, { recursive: true }),
  },
  {
    name: 'package directory that is a regular file',
    category: 'layout',
    mutate: (fixture) => {
      rmSync(fixture.packageDirectory, { recursive: true });
      writeFileSync(fixture.packageDirectory, 'not a directory');
    },
  },

  // Executable authenticity
  { name: 'missing executable', category: 'executable', mutate: (fixture) => rmSync(fixture.executable) },
  {
    name: 'executable that is a directory',
    category: 'executable',
    mutate: (fixture) => {
      rmSync(fixture.executable);
      mkdirSync(fixture.executable);
    },
  },
  {
    name: 'symlinked executable',
    category: 'executable',
    mutate: (fixture) => {
      const outside = join(makeTemporary(), 'claude');
      writeFileSync(outside, 'outside');
      rmSync(fixture.executable);
      symlinkSync(outside, fixture.executable);
    },
  },
  { name: 'non-executable mode 0644', category: 'executable-mode', mutate: (fixture) => chmodSync(fixture.executable, 0o644) },
  { name: 'owner-not-executable mode 0655', category: 'executable-mode', mutate: (fixture) => chmodSync(fixture.executable, 0o655) },
  { name: 'setuid mode 4755', category: 'executable-mode', mutate: (fixture) => chmodSync(fixture.executable, 0o4755) },
  { name: 'group-writable mode 0775', category: 'executable-mode', mutate: (fixture) => chmodSync(fixture.executable, 0o775) },
  { name: 'owner-only mode 0700', category: 'executable-mode', mutate: (fixture) => chmodSync(fixture.executable, 0o700) },
  {
    name: 'native executable with a second hard link',
    category: 'executable-links',
    mutate: (fixture) => linkSync(fixture.executable, join(fixture.packageDirectory, 'alias')),
  },
  { name: 'executable one byte short', category: 'executable-size', mutate: (fixture) => truncateSync(fixture.executable, PINNED_BYTES - 1) },
  { name: 'executable one byte long', category: 'executable-size', mutate: (fixture) => truncateSync(fixture.executable, PINNED_BYTES + 1) },
  {
    name: 'right length but wrong bytes',
    category: 'executable-hash',
    mutate: (fixture) => { const descriptor = openSync(fixture.executable, 'r+'); try { const first = Buffer.alloc(1); readSync(descriptor, first, 0, 1, 0); writeSync(descriptor, Buffer.from([(first.readUInt8(0) ^ 0xff) & 0xff]), 0, 1, 0); } finally { closeSync(descriptor); } },
  },

  // Destination authority: the .bin directory
  {
    name: 'missing .bin directory',
    category: 'bin-directory',
    mutate: (fixture) => rmSync(fixture.binDirectory, { recursive: true }),
  },
  {
    name: '.bin directory replaced by a symlink',
    category: 'bin-directory',
    mutate: (fixture) => {
      const outside = makeTemporary();
      rmSync(fixture.binDirectory, { recursive: true });
      symlinkSync(outside, fixture.binDirectory, 'dir');
    },
  },
  {
    name: '.bin that is a regular file',
    category: 'bin-directory',
    mutate: (fixture) => {
      rmSync(fixture.binDirectory, { recursive: true });
      writeFileSync(fixture.binDirectory, 'not a directory');
    },
  },

  // Destination authority: an existing claude that is not the exact expected link
  { name: 'foreign regular file at the destination', category: 'destination', mutate: (fixture) => writeFileSync(fixture.destination, 'foreign') },
  { name: 'foreign directory at the destination', category: 'destination', mutate: (fixture) => mkdirSync(fixture.destination) },
  { name: 'symlink with a different relative target', category: 'destination', mutate: (fixture) => symlinkSync('../codex/codex', fixture.destination) },
  {
    name: 'symlink with an absolute target to the native file',
    category: 'destination',
    mutate: (fixture) => symlinkSync(fixture.executable, fixture.destination),
  },
  { name: 'dangling symlink', category: 'destination', mutate: (fixture) => symlinkSync('../missing/claude', fixture.destination) },
];

describe('ciProviderInstallation: refusals fail before any link is created', { skip: HOST_SUPPORTED ? false : 'needs linux x64 glibc and the installed native package' }, () => {
  for (const row of REFUSALS) {
    it(`refuses ${row.name} as ${row.category}`, () => {
      const fixture = buildFixture('genuine');
      try {
        row.mutate(fixture);
        expectRefusal(fixture.root, row.category);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }

  it('refuses a symlinked or noncanonical repository root without touching the tree', () => {
    const fixture = buildFixture('sparse');
    const linked = join(makeTemporary(), 'linked-root');
    symlinkSync(fixture.root, linked, 'dir');
    const initial = snapshot(fixture.root);
    for (const repositoryRoot of [linked, `${fixture.root}/`, `${fixture.root}/node_modules/..`]) {
      assert.throws(() => helper.installCiProvider(supportedOptions(repositoryRoot)), refusalOf('root'));
      assert.deepEqual(snapshot(fixture.root), initial, 'a refusal must leave the tree unchanged');
    }
  });

  it('refuses a relative or missing repository root', () => {
    for (const repositoryRoot of ['relative/root', join(makeTemporary(), 'missing')]) {
      assert.throws(() => helper.installCiProvider(supportedOptions(repositoryRoot)), refusalOf('root'));
    }
  });
});

describe(
  'ciProviderInstallation: genuine artifact copy',
  { skip: HOST_SUPPORTED ? false : 'needs linux x64 glibc and the installed native package' },
  () => {
    let fixture: Fixture;

    before(() => {
      assert.ok(existsSync(GENUINE_EXECUTABLE), 'genuine native package is not installed; npm ci must provide it');
      fixture = buildFixture('genuine');
    });

    it('creates only the relative symlink and leaves the native file untouched', () => {
      const nativeBefore = lstatSync(fixture.executable);
      const result = helper.installCiProvider(supportedOptions(fixture.root));
      assert.deepEqual({ ...result }, { status: 'installed', supported: true, mutated: true });

      assert.ok(lstatSync(fixture.destination).isSymbolicLink());
      assert.equal(readlinkSync(fixture.destination), PINNED_LINK_TARGET);
      assert.equal(realpathSync(fixture.destination), fixture.executable);

      const nativeAfter = lstatSync(fixture.executable);
      assert.equal(nativeAfter.ino, nativeBefore.ino);
      assert.equal(nativeAfter.mode, nativeBefore.mode);
      assert.equal(nativeAfter.mtimeMs, nativeBefore.mtimeMs);
      assert.equal(nativeAfter.nlink, 1);
      assert.equal(nativeAfter.size, PINNED_BYTES);
    });

    it('a second run reports already-installed and changes nothing', () => {
      const initial = snapshot(fixture.root);
      const result = helper.installCiProvider(supportedOptions(fixture.root));
      assert.deepEqual({ ...result }, { status: 'already-installed', supported: true, mutated: false });
      assert.deepEqual(snapshot(fixture.root), initial);
    });

    it('refuses a tampered native file even when the exact link already exists', () => {
      const descriptor = openSync(fixture.executable, 'r+');
      try {
        const first = Buffer.alloc(1);
        readSync(descriptor, first, 0, 1, 0);
        const flipped = Buffer.from([(first.readUInt8(0) ^ 0xff) & 0xff]);
        writeSync(descriptor, flipped, 0, 1, 0);
      } finally {
        closeSync(descriptor);
      }
      expectRefusal(fixture.root, 'executable-hash');
    });
  },
);
