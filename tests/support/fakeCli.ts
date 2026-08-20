/**
 * Locates the fake CLI fixture scripts (tests/fixtures/fake-clis/*.mjs) and
 * builds a `{ executable, argv }` pair that runs one under the current Node
 * binary. Fixtures are plain Node scripts, not compiled by tsc, so they are
 * resolved relative to the repo root (`process.cwd()`, which `npm test`
 * always runs from) rather than relative to this file's compiled location.
 */

import { resolve } from "node:path";

export function fakeCliPath(name: string): string {
  return resolve(process.cwd(), "tests/fixtures/fake-clis", name);
}

export function fakeCliInvocation(name: string, argv: readonly string[] = []): { executable: string; argv: string[] } {
  return { executable: process.execPath, argv: [fakeCliPath(name), ...argv] };
}
