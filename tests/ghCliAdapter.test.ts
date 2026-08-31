/**
 * TASK-016 round-1 HIGH 4 / CRITICAL 1: the adapter parses remote text
 * strictly, and derives the push target from the URL git will actually use.
 *
 * A remote response is UNTRUSTED INPUT. The failures these cases pin are the
 * ones where malformed input failed OPEN — a garbage webhook count read as
 * zero, a check response claiming successes it did not list — because those
 * are the directions that turn "we could not tell" into "it is fine".
 *
 * Offline: the adapter runs through a scripted `ProcessRunner`; no gh, no
 * network, no credential.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createGhCliClient, createGitPusher, githubTargetFromUrl } from "../src/adapters/github/ghCliClient.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/ports/processRunner.js";
import type { Timestamp } from "../src/domain/time.js";

const A = "1111111111111111111111111111111111111111";
const REPO = "hakanduyar/software-factory";

function result(stdout: string, exitCode = 0): ProcessResult {
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

/** Answers by matching the argv the adapter builds, so the argv is pinned too. */
function runner(responses: Record<string, string>): ProcessRunner & { seen(): readonly string[] } {
  const seen: string[] = [];
  return {
    seen: () => seen,
    async run(request: ProcessRequest): Promise<ProcessResult> {
      const key = request.argv.join(" ");
      seen.push(key);
      for (const [pattern, stdout] of Object.entries(responses)) {
        if (key.includes(pattern)) {
          return result(stdout);
        }
      }
      return result("", 1);
    },
  };
}

function client(responses: Record<string, string>, seenRunner = runner(responses)) {
  return {
    client: createGhCliClient({
      processRunner: seenRunner,
      cwd: "/tmp",
      repository: REPO,
      // Absolute, so the test never resolves anything through PATH.
      ghPath: "/usr/bin/true",
      gitPath: "/usr/bin/true",
    }),
    runner: seenRunner,
  };
}

describe("TASK-016 CRITICAL 1: the push target is derived from the push URL", () => {
  for (const [url, expected] of [
    ["https://github.com/hakanduyar/software-factory.git", "hakanduyar/software-factory"],
    ["https://github.com/hakanduyar/software-factory", "hakanduyar/software-factory"],
    ["git@github.com:hakanduyar/software-factory.git", "hakanduyar/software-factory"],
    ["ssh://git@github.com/hakanduyar/software-factory.git", "hakanduyar/software-factory"],
    ["https://token@github.com/hakanduyar/software-factory.git", "hakanduyar/software-factory"],
  ] as const) {
    it(`derives ${expected} from ${url}`, () => {
      assert.equal(githubTargetFromUrl(url), expected);
    });
  }

  /**
   * Anything that is not a GitHub repository URL yields `undefined`, which the
   * caller treats as a refusal. Guessing here would be inventing an identity.
   */
  for (const url of [
    "https://gitlab.com/someone/thing.git",
    "https://evil.example/github.com/owner/name.git",
    "https://github.com/only-one-segment",
    "",
    "not a url",
  ]) {
    it(`refuses to derive a target from ${JSON.stringify(url)}`, () => {
      assert.equal(githubTargetFromUrl(url), undefined);
    });
  }
});

describe("TASK-016 HIGH 4: malformed remote responses fail closed", () => {
  const repoJson = JSON.stringify({
    nameWithOwner: REPO,
    visibility: "PUBLIC",
    defaultBranch: "main",
    ownerType: "User",
  });

  /**
   * THE REPRODUCTION. `Number.parseInt("0trailing-garbage")` is 0, so a
   * malformed response became a confident "no webhooks" — the exact direction
   * that turns uncertainty into permission.
   */
  it("treats a non-numeric webhook count as unknown, not zero", async () => {
    const { client: gh } = client({
      [`repos/${REPO} --jq`]: repoJson,
      "hooks": "0trailing-garbage",
      "actions/workflows": "0",
    });

    const repository = await gh.repository();

    assert.equal(repository.repositoryWebhooks, undefined, "a malformed count was read as zero");
  });

  it("reads a well-formed count", async () => {
    const { client: gh } = client({
      [`repos/${REPO} --jq`]: repoJson,
      "hooks": "0",
      "actions/workflows": "2",
    });

    const repository = await gh.repository();

    assert.equal(repository.repositoryWebhooks, 0);
    assert.equal(repository.configuredWorkflows, 2, "the workflow count was not read");
  });

  it("reports the owner type, which decides whether org webhooks can exist", async () => {
    const { client: gh } = client({
      [`repos/${REPO} --jq`]: JSON.stringify({
        nameWithOwner: REPO,
        visibility: "PUBLIC",
        defaultBranch: "main",
        ownerType: "Organization",
      }),
      "hooks": "0",
      "actions/workflows": "0",
    });

    assert.equal((await gh.repository()).ownerType, "ORGANIZATION");
  });

  it("treats an unrecognised owner type as UNKNOWN", async () => {
    const { client: gh } = client({
      [`repos/${REPO} --jq`]: JSON.stringify({
        nameWithOwner: REPO,
        visibility: "PUBLIC",
        defaultBranch: "main",
        ownerType: "Mystery",
      }),
      "hooks": "0",
      "actions/workflows": "0",
    });

    assert.equal((await gh.repository()).ownerType, "UNKNOWN");
  });

  /**
   * THE SECOND REPRODUCTION. `every([])` is true, so `{total: 1,
   * conclusions: []}` was read as SUCCESS: a response claiming a check it did
   * not list became a pass.
   */
  it("refuses a check response whose count disagrees with its rows", async () => {
    const { client: gh } = client({
      "check-runs": JSON.stringify({ total: 1, conclusions: [], statuses: [] }),
    });

    const status = await gh.checkStatus(A);

    assert.notEqual(status.conclusion, "SUCCESS", "a response claiming unlisted checks was read as a pass");
    assert.equal(status.conclusion, "FAILURE");
  });

  it("reads a genuine success", async () => {
    const { client: gh } = client({
      "check-runs": JSON.stringify({
        total: 2,
        conclusions: ["success", "skipped"],
        statuses: ["completed", "completed"],
      }),
    });

    const status = await gh.checkStatus(A);

    assert.equal(status.conclusion, "SUCCESS");
    assert.equal(status.total, 2);
    assert.equal(status.sha, A, "the status is not bound to the commit it describes");
  });

  it("reports zero checks as its own distinct value", async () => {
    const { client: gh } = client({
      "check-runs": JSON.stringify({ total: 0, conclusions: [], statuses: [] }),
    });

    assert.equal((await gh.checkStatus(A)).conclusion, "NO_CHECKS_CONFIGURED");
  });

  it("reports an unfinished run as PENDING", async () => {
    const { client: gh } = client({
      "check-runs": JSON.stringify({
        total: 2,
        conclusions: ["success", null],
        statuses: ["completed", "in_progress"],
      }),
    });

    assert.equal((await gh.checkStatus(A)).conclusion, "PENDING");
  });

  it("refuses to ask about anything that is not a full commit id", async () => {
    const { client: gh } = client({ "check-runs": "{}" });

    await assert.rejects(() => gh.checkStatus("11662a1"), /40-character/);
  });

  /**
   * ROUND-2 REVIEW, HIGH 4. The agreement check sat AFTER the `total === 0`
   * branch, so a response claiming zero checks while listing one still
   * produced a confident NO_CHECKS_CONFIGURED — durable evidence that is
   * simply wrong. A response that disagrees with itself is unusable in EVERY
   * direction, so agreement is checked before anything is concluded.
   */
  it("refuses a zero count that disagrees with its listed rows", async () => {
    const { client: gh } = client({
      "check-runs": JSON.stringify({ total: 0, conclusions: ["success"], statuses: ["completed"] }),
    });

    const status = await gh.checkStatus(A);

    assert.notEqual(
      status.conclusion,
      "NO_CHECKS_CONFIGURED",
      "a contradictory response was recorded as 'there are no checks'",
    );
    assert.equal(status.conclusion, "FAILURE");
  });
});

describe("TASK-016 round-2 CRITICAL 1: the pusher writes to the observed URL", () => {
  /**
   * `origin` is an indirection git resolves AT PUSH TIME, so a named remote
   * could reach a destination other than the one the gate observed — through a
   * second `pushurl`, or a config change between the observation and the
   * write. Naming the URL removes the indirection, and the argv is where that
   * is either true or not.
   */
  it("passes the URL rather than a remote name to git push", async () => {
    const seen = runner({ push: "" });
    const pusher = createGitPusher({
      processRunner: seen,
      cwd: "/tmp",
      repository: REPO,
      ghPath: "/usr/bin/true",
      gitPath: "/usr/bin/true",
    });

    await pusher.pushFastForward({
      url: "https://github.com/hakanduyar/software-factory.git",
      branch: "feat/x",
      sha: A,
    });

    const pushArgv = seen.seen().find((entry) => entry.startsWith("push "));
    assert.ok(pushArgv !== undefined, "no push was attempted");
    assert.match(pushArgv, /https:\/\/github\.com\/hakanduyar\/software-factory\.git/);
    assert.ok(!pushArgv.includes("origin"), `the push went through a remote name: ${pushArgv}`);
  });

  it("refuses a push URL that is not a github.com https URL", async () => {
    const pusher = createGitPusher({
      processRunner: runner({}),
      cwd: "/tmp",
      repository: REPO,
      ghPath: "/usr/bin/true",
      gitPath: "/usr/bin/true",
    });

    await assert.rejects(
      () => pusher.pushFastForward({ url: "https://evil.example/x.git", branch: "b", sha: A }),
      /https github\.com URL/,
    );
  });
});
