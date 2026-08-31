/**
 * TASK-016 AC-6: GitHub credentials stay on the trusted orchestration boundary.
 *
 * `gh` keeps an OAuth token under `$HOME`, so "which processes get HOME" IS the
 * credential boundary. These cases pin both sides of it: the GitHub adapter is
 * allowed to reach its own credential store, and the TASK-011 isolated child is
 * not — and no token-shaped value survives into anything persisted or printed.
 *
 * Offline: no gh, no network, no credential is ever read.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import {
  GITHUB_CLI_ENV_ALLOWLIST,
  GITHUB_CLI_ENVIRONMENT_POLICY,
} from "../src/adapters/github/ghCliClient.js";
import { ISOLATED_EXECUTOR_ENV_ALLOWLIST } from "../src/adapters/supervision/isolatedExecutor.js";
import { buildWorkerEnvironment, redactSecrets } from "../src/adapters/workers/environmentPolicy.js";
import { boundedDiagnostic } from "../src/supervision/resourceClassifier.js";

/** Shaped like a real token so the redactor is exercised, but not one. */
const FAKE_TOKENS = [
  "gho_0123456789abcdefghijklmnopqrstuvwxyzAB",
  "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB",
  "ghs_0123456789abcdefghijklmnopqrstuvwxyzAB",
  "ghu_0123456789abcdefghijklmnopqrstuvwxyzAB",
  "ghr_0123456789abcdefghijklmnopqrstuvwxyzAB",
  "github_pat_0123456789abcdefghijklmnopqrstuvwxyz",
];

describe("TASK-016 AC-6: the isolated child cannot reach GitHub credentials", () => {
  /**
   * THE BOUNDARY, stated as a comparison. The GitHub adapter needs HOME so `gh`
   * finds its own store; the isolated child must never have it. If these two
   * lists were ever merged "for tidiness", this fails.
   */
  it("keeps HOME out of the isolated allowlist and in the GitHub one", () => {
    assert.ok(GITHUB_CLI_ENV_ALLOWLIST.includes("HOME"), "the gh adapter cannot find its own credential store");
    assert.ok(
      !ISOLATED_EXECUTOR_ENV_ALLOWLIST.includes("HOME"),
      "the isolated child was given HOME, which is where gh keeps its token",
    );
    assert.ok(
      !ISOLATED_EXECUTOR_ENV_ALLOWLIST.includes("XDG_CONFIG_HOME"),
      "the isolated child was given XDG_CONFIG_HOME, which also locates gh's config",
    );
  });

  /**
   * Every variable that could locate a GitHub credential must be absent from
   * the isolated child, whatever else changes about either list.
   */
  for (const variable of ["HOME", "XDG_CONFIG_HOME", "GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR"]) {
    it(`never gives the isolated child ${variable}`, () => {
      const built = buildWorkerEnvironment(
        { allowedVars: ISOLATED_EXECUTOR_ENV_ALLOWLIST },
        { HOME: "/home/somebody", XDG_CONFIG_HOME: "/home/somebody/.config", GH_TOKEN: FAKE_TOKENS[0]!, GITHUB_TOKEN: FAKE_TOKENS[1]!, GH_CONFIG_DIR: "/home/somebody/.config/gh", PATH: "/usr/bin" },
      );

      assert.equal(built[variable], undefined, `the isolated child received ${variable}`);
    });
  }

  /**
   * THE FACTORY NEVER CARRIES A TOKEN ITSELF. `gh` authenticates from its own
   * store; forwarding GH_TOKEN would put a credential into a process
   * environment that is visible in `ps` on a shared machine.
   */
  it("never forwards a token variable to the gh adapter either", () => {
    const built = buildWorkerEnvironment(GITHUB_CLI_ENVIRONMENT_POLICY, {
      HOME: "/home/somebody",
      PATH: "/usr/bin",
      GH_TOKEN: FAKE_TOKENS[0]!,
      GITHUB_TOKEN: FAKE_TOKENS[1]!,
    });

    assert.equal(built["GH_TOKEN"], undefined, "the adapter environment carried a token");
    assert.equal(built["GITHUB_TOKEN"], undefined, "the adapter environment carried a token");
    assert.equal(built["HOME"], "/home/somebody", "the adapter cannot find its own credential store");
  });

  /** An allowlist is names only, so the list itself can never leak a value. */
  it("contains no value-shaped entries", () => {
    for (const name of GITHUB_CLI_ENV_ALLOWLIST) {
      assert.equal(redactSecrets(name), name, `the allowlist entry ${name} looks like a secret`);
    }
  });
});

describe("TASK-016 AC-6: no GitHub token survives into anything persisted", () => {
  /**
   * EVERY GitHub prefix, not the two that happened to be covered. `ghs_`,
   * `ghu_` and `ghr_` were NOT redacted before this task — an installation
   * token is exactly what an integration hands back, and this repository is
   * public, so an unredacted one in durable state is a published one.
   */
  for (const token of FAKE_TOKENS) {
    it(`redacts ${token.slice(0, 4)}… before it can be persisted`, () => {
      const message = `gh failed: authorization header was ${token} and the request died`;

      const redacted = redactSecrets(message);

      assert.ok(!redacted.includes(token), `${token.slice(0, 4)}… survived redaction`);
      assert.match(redacted, /\[REDACTED\]/);
    });

    it(`redacts ${token.slice(0, 4)}… through boundedDiagnostic, the durable-state chokepoint`, () => {
      const bounded = boundedDiagnostic(`remote said: ${token}`);

      assert.ok(!bounded.includes(token), `${token.slice(0, 4)}… reached a durable diagnostic`);
    });
  }

  /**
   * The NEGATIVE control: ordinary text that merely starts with the same
   * letters must not be mangled. A redactor that eats everything is not
   * evidence that it caught anything.
   */
  it("leaves ordinary text alone", () => {
    for (const harmless of ["ghost", "ghp_short", "the ghs of christmas past", "github_patch"]) {
      assert.equal(redactSecrets(harmless), harmless, `${harmless} was redacted`);
    }
  });
});

/**
 * Scans CODE, not prose.
 *
 * The first version of these cases grepped the whole file and failed on the
 * adapter's own comments — which name `GH_TOKEN` and `--force` precisely to say
 * that neither is used. A test that cannot tell an explanation from a call is
 * asserting something other than what it claims, so comments are removed first
 * and the assertions then mean what they say.
 */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("TASK-016 AC-6: the adapter itself cannot be talked into leaking", () => {
  /**
   * Structural, and deliberately so: the surest way to know a token is not
   * written into an argument is that no code path builds one. `--with-token`
   * reads a credential from stdin; a `-H "Authorization: ..."` would put one in
   * argv, where it is visible in `ps`.
   */
  it("passes no credential on the command line or through stdin", () => {
    const source = codeOf("src/adapters/github/ghCliClient.ts");

    for (const forbidden of ["--with-token", "Authorization", "GH_TOKEN", "GITHUB_TOKEN", "auth login", "-H "]) {
      assert.ok(!source.includes(forbidden), `the adapter references ${forbidden}`);
    }
    assert.ok(!/\binput:\s/.test(source), "the adapter writes to a child's stdin");
  });

  /**
   * The comment-stripper must actually strip, or every case using it passes
   * vacuously. Both directions are checked: prose is removed, code is kept.
   */
  it("scans code rather than comments", () => {
    const source = codeOf("src/adapters/github/ghCliClient.ts");

    assert.ok(!source.includes("deliberately ABSENT"), "comments were not stripped, so these scans read prose");
    assert.ok(source.includes("GITHUB_CLI_ENV_ALLOWLIST"), "stripping removed code as well as comments");
  });

  /**
   * Captured output is redacted BEFORE it can become a message. The adapter
   * has exactly one place that turns process output into an error, and it must
   * go through the redactor.
   */
  it("redacts captured process output before it becomes a message", () => {
    const source = codeOf("src/adapters/github/ghCliClient.ts");

    assert.match(source, /redactSecrets\(boundedDiagnostic\(/, "the adapter does not redact captured output");
  });

  /**
   * F-7: a bare executable name resolves through PATH, and PATH is inherited —
   * so anything able to put a `gh` earlier on it would run with the Factory's
   * GitHub credentials.
   */
  it("resolves gh and git to absolute paths", () => {
    const source = codeOf("src/adapters/github/ghCliClient.ts");

    assert.match(source, /must be an absolute path/, "the adapter accepts a relative executable override");
    assert.match(source, /was not found as an absolute path on PATH/, "the adapter accepts a bare executable name");
  });

  /**
   * ADR-0002 never authorises a force push or a history rewrite, and the
   * safest enforcement is an API that cannot express one.
   */
  it("offers no force, delete or history-rewriting operation", () => {
    const source = codeOf("src/adapters/github/ghCliClient.ts");

    for (const forbidden of ["--force", "force-with-lease", "--delete", "push -f", "reset --hard"]) {
      assert.ok(!source.includes(forbidden), `the adapter can ${forbidden}`);
    }
  });
});
