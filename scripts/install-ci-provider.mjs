/**
 * CI provider installation boundary (postinstall).
 *
 * Links node_modules/.bin/claude to the pinned native Claude Code executable that
 * npm installed as an optional dependency. Nothing is downloaded, executed or
 * copied: the helper validates the installed artifact and creates exactly one
 * relative symlink. It never unlinks, replaces, chmods or rewrites anything.
 *
 * Package name, version, SHA-256, byte length and target path are module-private
 * constants; callers cannot override them. Importing this module has no side
 * effects. The CLI runs only when this file is the process entry point, accepts
 * no arguments, and reads no environment input.
 *
 * Order: confinement, metadata, executable stat, .bin directory, destination
 * classification, then the content hash. A mismatching hash therefore refuses even
 * when the exact link already exists, and every refusal happens before any
 * filesystem mutation.
 *
 * Errors are bounded category strings; they never carry paths, environment
 * values or file content.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIX = 'ci-provider-install-refused';
const PACKAGE_NAME = '@anthropic-ai/claude-code-linux-x64';
const PACKAGE_VERSION = '2.1.296';
const BINARY_SHA256 = '24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de';
const BINARY_BYTES = 257068216;
const TARGET_RELATIVE = 'node_modules/@anthropic-ai/claude-code-linux-x64/claude';
const LINK_RELATIVE = 'node_modules/.bin/claude';
const LINK_TARGET = '../@anthropic-ai/claude-code-linux-x64/claude';
const SCOPE_DIRECTORY = '@anthropic-ai';
const PACKAGE_DIRECTORY = 'claude-code-linux-x64';
const EXECUTABLE_NAME = 'claude';
const READ_CHUNK_BYTES = 1 << 20;
const MAX_METADATA_BYTES = 1 << 20;

/** Read-only view of the pinned constants, for boundary fixtures to assert against. */
export const CI_PROVIDER = Object.freeze({
  packageName: PACKAGE_NAME,
  packageVersion: PACKAGE_VERSION,
  binarySha256: BINARY_SHA256,
  binaryBytes: BINARY_BYTES,
  targetRelative: TARGET_RELATIVE,
  linkRelative: LINK_RELATIVE,
  linkTarget: LINK_TARGET,
});

const UNSUPPORTED = Object.freeze({ status: 'unsupported', supported: false, mutated: false });

class Refusal extends Error {
  constructor(category) {
    super(`${PREFIX}: ${category}`);
    this.name = 'Refusal';
    this.category = category;
  }
}

function outcome(status, mutated) {
  return Object.freeze({ status, supported: true, mutated });
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error !== null && typeof error === 'object' && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return null;
    }
    throw error;
  }
}

function requireRealDirectory(path, category) {
  const stat = lstatOrNull(path);
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Refusal(category);
  }
}

function onlyEntry(value, entry) {
  return Array.isArray(value) && value.length === 1 && value[0] === entry;
}

/** package.json of the native package: name, version, os, cpu and libc, all mandatory. */
function checkMetadata(packageDirectory) {
  const path = join(packageDirectory, 'package.json');
  const stat = lstatOrNull(path);
  if (stat === null || stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_METADATA_BYTES) {
    throw new Refusal('metadata');
  }
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Refusal('metadata');
  }
  if (metadata === null || typeof metadata !== 'object') {
    throw new Refusal('metadata');
  }
  if (
    metadata.name !== PACKAGE_NAME ||
    metadata.version !== PACKAGE_VERSION ||
    !onlyEntry(metadata.os, 'linux') ||
    !onlyEntry(metadata.cpu, 'x64')
  ) {
    throw new Refusal('metadata');
  }
  // libc is mandatory: exactly one entry, glibc.
  if (!onlyEntry(metadata.libc, 'glibc')) {
    throw new Refusal('metadata');
  }
}

/** Cheap executable checks that run before the hash: type, mode, links, size. */
function checkExecutableStat(executable) {
  const stat = lstatOrNull(executable);
  if (stat === null || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Refusal('executable');
  }
  const mode = stat.mode & 0o7777;
  // Literal 0755 only: no special bits and no other mode.
  if (mode !== 0o755) {
    throw new Refusal('executable-mode');
  }
  if (stat.nlink !== 1) {
    throw new Refusal('executable-links');
  }
  if (stat.size !== BINARY_BYTES) {
    throw new Refusal('executable-size');
  }
  return stat;
}

/** Streams the executable through SHA-256 on a no-follow descriptor bound to the lstat identity. */
function sha256OfExecutable(executable, expected) {
  let descriptor;
  try {
    descriptor = openSync(executable, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Refusal('executable');
  }
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new Refusal('executable');
    }
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const read = readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) {
        break;
      }
      total += read;
      if (total > BINARY_BYTES) {
        throw new Refusal('executable-size');
      }
      hash.update(chunk.subarray(0, read));
    }
    if (total !== BINARY_BYTES) {
      throw new Refusal('executable-size');
    }
    const closing = fstatSync(descriptor);
    if (
      closing.ino !== opened.ino ||
      closing.size !== opened.size ||
      closing.nlink !== opened.nlink ||
      closing.mode !== opened.mode ||
      closing.mtimeMs !== opened.mtimeMs
    ) {
      throw new Refusal('executable');
    }
    return hash.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}

/** true: exact expected symlink already present. false: absent. Anything else refuses. */
function classifyDestination(destination, executable) {
  const existing = lstatOrNull(destination);
  if (existing === null) {
    return false;
  }
  let exact = false;
  try {
    exact =
      existing.isSymbolicLink() &&
      readlinkSync(destination) === LINK_TARGET &&
      realpathSync(destination) === executable;
  } catch {
    exact = false;
  }
  if (!exact) {
    throw new Refusal('destination');
  }
  return true;
}

function createLink(destination) {
  try {
    symlinkSync(LINK_TARGET, destination);
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'EEXIST') {
      throw new Refusal('destination-race');
    }
    throw error;
  }
  const created = lstatSync(destination);
  if (!created.isSymbolicLink() || readlinkSync(destination) !== LINK_TARGET) {
    throw new Refusal('destination-race');
  }
}

function install(repositoryRoot) {
  if (typeof repositoryRoot !== 'string' || !isAbsolute(repositoryRoot)) {
    throw new Refusal('root');
  }
  let root;
  try {
    root = realpathSync(repositoryRoot);
    // The input must already be its own canonical, unlinked spelling; it is never normalized into authority.
    if (root !== repositoryRoot) {
      throw new Refusal('root');
    }
  } catch {
    throw new Refusal('root');
  }
  requireRealDirectory(root, 'root');

  const nodeModules = join(root, 'node_modules');
  const packageDirectory = join(nodeModules, SCOPE_DIRECTORY, PACKAGE_DIRECTORY);
  requireRealDirectory(nodeModules, 'layout');
  requireRealDirectory(join(nodeModules, SCOPE_DIRECTORY), 'layout');
  requireRealDirectory(packageDirectory, 'layout');

  checkMetadata(packageDirectory);
  const executable = join(packageDirectory, EXECUTABLE_NAME);
  const executableStat = checkExecutableStat(executable);

  const binDirectory = join(nodeModules, '.bin');
  requireRealDirectory(binDirectory, 'bin-directory');
  const destination = join(binDirectory, EXECUTABLE_NAME);
  const alreadyLinked = classifyDestination(destination, executable);

  if (sha256OfExecutable(executable, executableStat) !== BINARY_SHA256) {
    throw new Refusal('executable-hash');
  }
  if (alreadyLinked) {
    return outcome('already-installed', false);
  }
  createLink(destination);
  return outcome('installed', true);
}

/**
 * Installs node_modules/.bin/claude for the pinned supported tuple (linux, x64, glibc).
 * Any other tuple returns `unsupported` with no filesystem access at all.
 * Synchronous. Throws a bounded `ci-provider-install-refused: <category>` error on refusal.
 */
export function installCiProvider(options) {
  const { repositoryRoot, platform, architecture, glibcRuntimeVersion } = options ?? {};
  if (
    platform !== 'linux' ||
    architecture !== 'x64' ||
    typeof glibcRuntimeVersion !== 'string' ||
    glibcRuntimeVersion.length === 0
  ) {
    return UNSUPPORTED;
  }
  try {
    return install(repositoryRoot);
  } catch (error) {
    if (error instanceof Refusal) {
      throw error;
    }
    throw new Refusal('filesystem');
  }
}

function detectGlibcRuntimeVersion() {
  try {
    process.report.excludeNetwork = true;
    const version = process.report.getReport().header.glibcVersionRuntime;
    return typeof version === 'string' && version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

function isEntryPoint() {
  const entry = process.argv[1];
  if (typeof entry !== 'string') {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function main() {
  if (process.argv.length > 2) {
    throw new Refusal('arguments');
  }
  const repositoryRoot = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '..');
  const result = installCiProvider({
    repositoryRoot,
    platform: process.platform,
    architecture: process.arch,
    glibcRuntimeVersion: detectGlibcRuntimeVersion(),
  });
  process.stdout.write(`ci-provider: ${result.status}\n`);
}

if (isEntryPoint()) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Refusal ? error.message : `${PREFIX}: unexpected`}\n`);
    process.exitCode = 1;
  }
}
