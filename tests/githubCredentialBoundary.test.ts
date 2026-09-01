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
  createGhCliClient,
  createGitRepositoryReader,
} from "../src/adapters/github/ghCliClient.js";
import { publishCandidate } from "../src/github/publishCandidate.js";
import { runGithubPublish } from "../src/cli/github.js";
import { createSqliteSupervisorRepository } from "../src/adapters/supervision/sqliteSupervisorRepository.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import { withPublicationRecorded } from "../src/github/publicationProvenance.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/ports/processRunner.js";
import type { ReviewedCandidate } from "../src/github/candidateBinding.js";
import type { SupervisorState } from "../src/supervision/supervisorTypes.js";
import type { Timestamp } from "../src/domain/time.js";
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

/**
 * AC-6 END TO END (round-7 review, BLOCKING 5).
 *
 * The cases above exercise the redactors directly, which proves the redactors
 * work and NOT that anything actually calls them. This drives the REAL adapter
 * over a scripted `ProcessRunner` whose captured output carries a token-shaped
 * value, and follows that value outward through every place it could come to
 * rest: the thrown error, the publication outcome, the line the CLI would log,
 * and the durable provenance record.
 *
 * Offline: the scripted runner never launches anything.
 */
describe("TASK-016 AC-6: a token in captured process output reaches nothing durable", () => {
  const LEAK = "ghs_0123456789abcdefghijklmnopqrstuvwxyzAB";
  const HEAD = "1111111111111111111111111111111111111111";
  const BASE = "3333333333333333333333333333333333333333";
  const REPO = "hakanduyar/software-factory";

  const CANDIDATE: ReviewedCandidate = {
    roadmapKey: "GITHUB_ORCHESTRATION",
    headSha: HEAD,
    baseSha: BASE,
    baseRef: "main",
    headRef: "feat/executor-wiring",
  };

  function result(stdout: string, stderr: string, exitCode: number): ProcessResult {
    return {
      terminationReason: "EXITED",
      exitCode,
      signal: null,
      stdout,
      stderr,
      stdoutTruncated: false,
      stderrTruncated: false,
      startedAt: 0 as Timestamp,
      finishedAt: 1 as Timestamp,
      durationMs: 1,
    };
  }

  /**
   * Git answers normally so publication gets far enough to talk to GitHub;
   * `gh` then fails the way a real expired-credential failure does, with the
   * token echoed in its diagnostics.
   *
   * IT RECORDS WHAT IT WAS ASKED (round-9 review). The previous version
   * answered only `remote get-url`, so when `originTarget()` moved to
   * `ls-remote --get-url` the call fell through to the gh-failure branch,
   * publication refused at the origin guard, and the redaction assertions
   * passed without a token ever entering the system. A fixture that goes stale
   * silently is worse than no fixture: it reports a property nobody tested.
   */
  function runner(): ProcessRunner & { seen(): readonly string[] } {
    const seen: string[] = [];
    return {
      seen: () => seen,
      async run(request: ProcessRequest): Promise<ProcessResult> {
        const argv = request.argv.join(" ");
        // The EXECUTABLE is recorded, not just the argv: "did a gh process
        // run" is the actual question, and it cannot be answered by matching
        // subcommand spellings that move.
        seen.push(`${request.executable} ${argv}`);
        /**
         * Both spellings, because this fixture must not decide which one the
         * adapter is allowed to use. `originTarget` asks git to EXPAND the url
         * (`ls-remote --get-url`); the reachability assertion below is what
         * pins that it really got through, so answering both here costs
         * nothing and removes one way for this file to rot.
         */
        if (argv.includes("ls-remote --get-url") || argv.includes("remote get-url")) {
          return result(`https://github.com/${REPO}.git\n`, "", 0);
        }
        if (argv.includes("rev-parse") && argv.includes("HEAD")) {
          return result(`${HEAD}\n`, "", 0);
        }
        if (argv.includes("rev-parse")) {
          return result(`${BASE}\n`, "", 0);
        }
        if (argv.includes("status --porcelain")) {
          return result("", "", 0);
        }
        if (argv.includes("fetch") || argv.includes("merge-base")) {
          return result("", "", 0);
        }
        // Everything reaching GitHub fails, loudly, with the credential in it.
        return result(
          `{"error":"bad credentials, sent ${LEAK}"}`,
          `gh: authorization header was Bearer ${LEAK} and the request was rejected`,
          1,
        );
      },
    };
  }

  /**
   * Distinct sentinel paths so the two tools are TELLABLE APART in the record.
   * Nothing is launched — the runner is scripted — and `resolveExecutable`
   * requires only that an override be absolute.
   */
  const GH = "/usr/bin/sentinel-gh";
  const GIT = "/usr/bin/sentinel-git";

  function deps() {
    const processRunner = runner();
    const shared = { processRunner, cwd: "/tmp", repository: REPO };
    return {
      github: createGhCliClient({ ...shared, ghPath: GH, gitPath: GIT }),
      git: createGitRepositoryReader({ ...shared, ghPath: GH, gitPath: GIT }),
      expectedRepository: REPO,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      processRunner,
    };
  }

  /**
   * THE REACHABILITY ASSERTION every case below shares.
   *
   * A token can only be redacted if it entered, and it can only enter if a
   * `gh` command actually ran. Asserting this separately from the absence of
   * the token is the difference between "no token leaked" and "no token was
   * ever produced" — two statements that look identical in a passing test and
   * mean opposite things.
   */
  function assertReachedGitHub(seen: readonly string[]): void {
    const github = seen.filter((entry) => entry.startsWith(`${GH} `));
    assert.ok(
      github.length > 0,
      `publication never reached GitHub, so no token entered the system: ${seen.join(" | ")}`,
    );
  }

  function emptyState(): SupervisorState {
    return {
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [],
      roadmap: [],
      checkpoints: [],
      escalations: [],
      provenance: [],
      updatedAt: 1_000,
    };
  }

  /**
   * The value has to actually be in the captured output, or every assertion
   * below would pass against a test that plants nothing. This asserts the
   * PREMISE before asserting the property.
   */
  it("really does plant the token in what the process returns", async () => {
    const produced = await runner().run({
      executable: "/usr/bin/true",
      argv: ["repo", "view"],
      cwd: "/tmp",
      env: {},
      timeoutMs: 1_000,
      maxOutputBytes: 1_000,
    });

    assert.ok(produced.stderr.includes(LEAK), "the fixture does not contain the token it claims to");
    assert.ok(produced.stdout.includes(LEAK), "the fixture does not contain the token it claims to");
  });

  it("does not carry the token out of the adapter in a thrown error", async () => {
    const d = deps();

    await assert.rejects(
      () => d.github.repository(),
      (error: unknown) => {
        const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
        assert.ok(!text.includes(LEAK), "the adapter threw an error carrying a GitHub token");
        return true;
      },
    );
    assertReachedGitHub(d.processRunner.seen());
  });

  /**
   * The whole orchestration, not just the adapter. Whatever publication decides
   * — refusal, escalation or a thrown error — the token must not be anywhere in
   * what it produces.
   */
  it("does not carry the token out of publication, whatever the outcome", async () => {
    const d = deps();
    let text: string;
    try {
      text = JSON.stringify(await publishCandidate(d, CANDIDATE));
    } catch (error) {
      text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    }

    // Reachability FIRST: without it, "no token in the outcome" is also what a
    // publication that stopped before GitHub would report.
    assertReachedGitHub(d.processRunner.seen());
    assert.ok(!text.includes(LEAK), "a GitHub token reached the publication outcome");
  });

  /**
   * The origin guard must not be what ends this run — that was exactly the
   * stale-fixture failure. Asserted directly so the next call-site move fails
   * here rather than quietly disarming the cases above.
   */
  it("gets past the origin guard, so the credential path is genuinely exercised", async () => {
    const d = deps();

    const outcome = await publishCandidate(d, CANDIDATE).catch(() => undefined);

    const reason = outcome !== undefined && outcome.kind !== "PUBLISHED" ? outcome.reason : "";
    assert.ok(
      !/local origin/.test(reason),
      `publication stopped at the origin guard, so nothing downstream was tested: ${reason}`,
    );
    assertReachedGitHub(d.processRunner.seen());
  });

  /**
   * The line the CLI would print. `safe()` in the CLI is `boundedDiagnostic`,
   * so this models the log boundary with the same function the CLI uses.
   */
  it("does not carry the token into a logged line", async () => {
    const d = deps();
    let reason: string;
    try {
      const outcome = await publishCandidate(d, CANDIDATE);
      reason = outcome.kind === "PUBLISHED" ? "published" : outcome.reason;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }

    assertReachedGitHub(d.processRunner.seen());
    assert.ok(!boundedDiagnostic(reason).includes(LEAK), "a GitHub token reached a logged line");
  });

  /**
   * THE DURABLE DESTINATION, REACHED THE WAY THE SYSTEM REACHES IT (round-10
   * review).
   *
   * The case below this one injects the token directly and proves the CHAIN
   * redacts. That is a real property and it is not this one. This case starts
   * where a token actually starts — in what a child process printed — carries
   * the adapter's own derived text into the record, and asserts three things
   * that only mean something together:
   *
   *   1. a `gh` process really ran, so a token really entered;
   *   2. the recorded text really DERIVES from what that process printed, so
   *      the record is not merely some unrelated string that never had a token
   *      in it to begin with;
   *   3. the token is absent from the serialised state.
   *
   * Without (1) and (2), (3) is also what a pipeline that never ran would
   * report — which is exactly how the previous version passed.
   */
  it("does not carry a token from captured child output into the provenance chain", async () => {
    const d = deps();

    let derived = "";
    try {
      await d.github.repository();
    } catch (error) {
      derived = error instanceof Error ? error.message : String(error);
    }

    assertReachedGitHub(d.processRunner.seen());
    // (2): the text is genuinely downstream of the child's output. `gh` and the
    // non-zero exit both come from the scripted failure, not from this test.
    assert.match(
      derived,
      /exit 1/,
      `the recorded text does not derive from the child's output: ${derived}`,
    );

    const recorded = withPublicationRecorded(emptyState(), {
      roadmapKey: `GITHUB_ORCHESTRATION ${derived}`,
      pullRequest: {
        number: 7,
        state: "OPEN",
        headRef: CANDIDATE.headRef,
        headSha: HEAD,
        baseRef: "main",
        baseSha: BASE,
      },
      checks: { sha: HEAD, conclusion: "NO_CHECKS_CONFIGURED", total: 0 },
      recordedAt: 2_000,
    });

    assert.equal(recorded.ok, true, `the control failed to record: ${JSON.stringify(recorded)}`);
    if (!recorded.ok) return;
    assert.ok(
      !JSON.stringify(recorded.state).includes(LEAK),
      "a GitHub token captured from a child process was hashed into the provenance chain",
    );
  });

  /**
   * AND THE CHAIN REDACTS ON ITS OWN. Defence in depth, stated as its own case
   * rather than left to stand in for the end-to-end property above — which is
   * the mistake the round-10 review found. `appendProvenance` redacts before
   * hashing, so what is verified is what is stored, and neither carries the
   * secret even when a caller injects one directly.
   */
  it("redacts a token injected straight into the record, with no process involved", () => {
    const recorded = withPublicationRecorded(emptyState(), {
      roadmapKey: `GITHUB_ORCHESTRATION ${LEAK}`,
      pullRequest: {
        number: 7,
        state: "OPEN",
        headRef: CANDIDATE.headRef,
        headSha: HEAD,
        baseRef: "main",
        baseSha: BASE,
      },
      checks: { sha: HEAD, conclusion: "NO_CHECKS_CONFIGURED", total: 0 },
      recordedAt: 2_000,
    });

    assert.equal(recorded.ok, true, `the control failed to record: ${JSON.stringify(recorded)}`);
    if (!recorded.ok) return;
    assert.ok(
      !JSON.stringify(recorded.state).includes(LEAK),
      "a GitHub token was hashed into the provenance chain",
    );
  });
});

/**
 * AC-6 THROUGH THE COMMAND THAT SHIPS (round-11 review).
 *
 * The cases above exercise the adapter and the recorder. The round-11 reviewer
 * showed that was not enough: `safe()` could be made an identity function and
 * `withPublicationRecorded` could be bypassed inside `recordPublication`, and
 * every test stayed green — because nothing drove `runGithubPublish`, which is
 * the thing a person actually runs. Asserting the ingredients is not asserting
 * the dish.
 *
 * These cases drive the CLI entry point with an injected `ProcessRunner`, so
 * the real adapter, the real gate, the real `safe()` and the real durable
 * recorder all participate.
 */
describe("TASK-016 AC-6: the SHIPPED command leaks nothing", () => {
  const LEAK2 = "ghs_9876543210zyxwvutsrqponmlkjihgfedcbaZY";
  const HEAD2 = "1111111111111111111111111111111111111111";
  const BASE2 = "3333333333333333333333333333333333333333";
  const REPO2 = "hakanduyar/software-factory";
  const GH2 = "/usr/bin/sentinel-gh";
  const GIT2 = "/usr/bin/sentinel-git";

  function res(stdout: string, exitCode = 0): ProcessResult {
    return {
      terminationReason: "EXITED",
      exitCode,
      signal: null,
      stdout,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      startedAt: 0 as Timestamp,
      finishedAt: 1 as Timestamp,
      durationMs: 1,
    };
  }

  const args = {
    roadmapKey: "GITHUB_ORCHESTRATION",
    headSha: HEAD2,
    baseSha: BASE2,
    headRef: "feat/executor-wiring",
    baseRef: "main",
    repository: REPO2,
  };

  /** Git answers normally; `gh` answers whatever the case needs. */
  function cli(ghAnswers: (argv: string) => ProcessResult) {
    const seen: string[] = [];
    const processRunner: ProcessRunner = {
      async run(request: ProcessRequest): Promise<ProcessResult> {
        const argv = request.argv.join(" ");
        seen.push(`${request.executable} ${argv}`);
        if (request.executable === GIT2) {
          if (argv.includes("ls-remote --get-url")) return res(`https://github.com/${REPO2}.git\n`);
          if (argv.includes("rev-parse") && argv.includes("HEAD")) return res(`${HEAD2}\n`);
          if (argv.includes("rev-parse")) return res(`${BASE2}\n`);
          return res("");
        }
        return ghAnswers(argv);
      },
    };
    const lines: string[] = [];
    return {
      processRunner,
      seen: () => seen,
      lines: () => lines,
      log: (line: string): void => {
        lines.push(line);
      },
    };
  }

  function ranGitHub(seen: readonly string[]): boolean {
    return seen.some((entry) => entry.startsWith(`${GH2} `));
  }

  /**
   * THE LOG BOUNDARY, through the CLI's own `safe()`.
   *
   * A repository identity is untrusted remote text that publication QUOTES when
   * it disagrees with the expected one — so this is a real path from what a
   * child printed to what the command prints. `safe()` is the only thing
   * standing in it.
   */
  it("does not print a token that arrived in a remote repository identity", async () => {
    const c = cli((argv) =>
      argv.includes("api repos/")
        ? res(JSON.stringify({
            nameWithOwner: `someone-else/repo-${LEAK2}`,
            visibility: "PUBLIC",
            defaultBranch: "main",
            ownerType: "User",
          }))
        : res("", 1),
    );

    const code = await runGithubPublish(args, {
      log: c.log,
      cwd: "/tmp",
      now: () => 1_000,
      processRunner: c.processRunner,
      // Sentinels, so gh and git are tellable apart in the record and the test
      // never depends on what is installed on this machine.
      ghPath: GH2,
      gitPath: GIT2,
    });

    assert.equal(code, 1, "the mismatched repository was not refused");
    assert.ok(ranGitHub(c.seen()), `gh never ran: ${c.seen().join(" | ")}`);
    const printed = c.lines().join("\n");
    // NON-VACUITY: the printed text really is downstream of the child's output.
    assert.match(printed, /someone-else/, `the refusal does not quote the remote: ${printed}`);
    assert.ok(!printed.includes(LEAK2), `a token was printed by the shipped command: ${printed}`);
  });

  /**
   * THE DURABLE BOUNDARY, through the CLI's own `recordPublication`.
   *
   * Drives a real PUBLISHED outcome so the record is genuinely written, then
   * asserts BOTH that the entry exists — so bypassing the recorder fails — and
   * that the persisted state carries no token.
   */
  it("records the publication, and records no token, through the shipped path", async () => {
    const dbPath = tempDbPath("github-cli-");
    const seed = createSqliteSupervisorRepository(dbPath);
    try {
      await seed.create({
        version: 1,
        financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
        resources: [],
        // A provenance entry must name a roadmap item that EXISTS — a
        // state-integrity rule, and one worth knowing: it means arbitrary text
        // cannot enter the chain through the roadmap key in production either.
        roadmap: [{
          key: "GITHUB_ORCHESTRATION",
          title: "GitHub orchestration",
          dependsOn: [],
          status: "ACTIVE",
          workClass: "NORMAL_IMPLEMENTATION",
          order: 1,
        }],
        checkpoints: [],
        escalations: [],
        provenance: [],
        updatedAt: 1_000,
      } as never);
    } finally {
      seed.close();
    }

    const pr = JSON.stringify([{
      number: 7,
      state: "OPEN",
      // The token arrives the way remote text really arrives: inside a field
      // `gh` reports. Nothing validates a branch NAME to a shape, so this is
      // the most permissive carrier the remote actually has.
      headRefName: `${args.headRef}-${LEAK2}`,
      headRefOid: HEAD2,
      baseRefName: "main",
      baseRefOid: BASE2,
    }]);
    const c = cli((argv) => {
      if (argv.includes("api repos/") && argv.includes("nameWithOwner")) {
        return res(JSON.stringify({
          nameWithOwner: REPO2,
          visibility: "PUBLIC",
          defaultBranch: "main",
          ownerType: "User",
        }));
      }
      if (argv.includes("pr list")) return res(pr);
      // The branch already holds the candidate, which is what publication needs.
      if (argv.includes("rev-parse") || argv.includes("api repos") ) return res(`${HEAD2}\n`);
      return res("", 1);
    });

    const previous = process.env["FACTORY_SUPERVISOR_DB_PATH"];
    process.env["FACTORY_SUPERVISOR_DB_PATH"] = dbPath;
    let code: number;
    try {
      code = await runGithubPublish(
        args,
        { log: c.log, cwd: "/tmp", now: () => 2_000, processRunner: c.processRunner, ghPath: GH2, gitPath: GIT2 },
      );
    } finally {
      if (previous === undefined) delete process.env["FACTORY_SUPERVISOR_DB_PATH"];
      else process.env["FACTORY_SUPERVISOR_DB_PATH"] = previous;
    }

    assert.ok(ranGitHub(c.seen()), `gh never ran: ${c.seen().join(" | ")}`);
    assert.equal(code, 0, `publication did not succeed: ${c.lines().join(" | ")}`);

    const after = createSqliteSupervisorRepository(dbPath);
    try {
      const state = await after.load();
      assert.ok(state !== undefined, "the supervisor state vanished");
      // THE RECORD MUST EXIST. Bypassing `withPublicationRecorded` inside
      // `recordPublication` fails here, which is the round-11 reproduction.
      const published = (state?.provenance ?? []).filter((e) => e.kind === "PUBLISHED_AS");
      assert.equal(published.length, 1, "the publication was not recorded through the shipped path");
      assert.equal(published[0]?.resourceKey, HEAD2, "the record does not name the published commit");
      // AND IT MUST CARRY NO TOKEN.
      assert.ok(
        !JSON.stringify(state).includes(LEAK2),
        "a token reached durable state through the shipped command",
      );
    } finally {
      after.close();
    }
    assert.ok(!c.lines().join("\n").includes(LEAK2), "a token was printed while publishing");
    cleanupTempDbs();
  });
});
