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

import { createGhCliClient, githubTargetFromUrl } from "../src/adapters/github/ghCliClient.js";
import {
  authorizeRemoteWrite,
  createPullRequestAction,
  launchAiWorkerAction,
  observeBilling,
  parseFinancialPolicy,
} from "../src/supervision/financialSafety.js";
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

describe("TASK-016 round-6 finding 1: the REAL adapter refuses an unauthorized write", () => {
  /**
   * The round-6 tests in `publishCandidate.test.ts` run against a scripted
   * double that enforces this rule because I wrote it to. That proves the
   * DOUBLE refuses. `createGhCliClient` is the exported capability an attacker
   * or a careless caller would actually hold, so the guard has to be pinned
   * here — on the object that can really reach GitHub.
   */
  it("refuses a create with no authorization, without running gh", async () => {
    const { client: gh, runner: r } = client({});

    await assert.rejects(
      () => gh.createPullRequest(
        { headRef: "feat/x", baseRef: "main", title: "t", body: "b" },
        undefined as never,
      ),
      // The TARGET comparison catches this one, because `undefined` names no
      // repository. Asserted specifically so the case cannot silently start
      // passing because some other guard happened to fire.
      /names target "undefined" but this client writes to/,
      "the real adapter accepted an unauthorized write",
    );
    // The refusal must precede the subprocess: a write attempted and then
    // regretted is still a write.
    assert.deepEqual(r.seen(), [], "gh was invoked before the authorization was checked");
  });

  it("refuses a hand-built object shaped like an authorization", async () => {
    const { client: gh, runner: r } = client({});

    await assert.rejects(
      () => gh.createPullRequest(
        { headRef: "feat/x", baseRef: "main", title: "t", body: "b" },
        { kind: "CREATE_PULL_REQUEST", target: REPO },
      ),
      // Names the right target, so ONLY the provenance check can refuse it —
      // which is what makes this a test of the WeakSet rather than of the
      // target comparison above.
      /requires an authorization minted by authorizeRemoteWrite/,
      "a forged authorization reached the real adapter",
    );
    assert.deepEqual(r.seen(), []);
  });

  /**
   * An authorization minted for a DIFFERENT action is not proof about this
   * one. A locally-hosted worker IS mintable at zero cost, so this is a REAL
   * token — one the gate genuinely issued, carrying genuine WeakSet
   * provenance — presented at the wrong door. Testing forgery alone would
   * leave the kind comparison unpinned, and provenance without identity was
   * itself an earlier finding.
   */
  it("refuses an authorization minted for a different action kind", async () => {
    const minted = authorizeRemoteWrite(
      launchAiWorkerAction({
        resourceKey: "ollama:qwen2.5-coder:7b",
        observation: observeBilling({
          provider: "ollama",
          model: "qwen2.5-coder:7b",
          billingMode: "INCLUDED_SUBSCRIPTION",
        }),
        description: "a local worker, which the gate really does allow",
      }),
      parseFinancialPolicy({ autonomousSpendAllowed: false, autonomousSpendLimit: 0 }),
    );

    // Non-vacuity: if this ever stops minting, the case below would degrade
    // into the forgery test above without saying so.
    assert.equal(minted.ok, true, "the premise failed: no genuine token was minted to misuse");
    if (!minted.ok) return;
    const token = minted.authorization;
    const { client: gh, runner: r } = client({});

    await assert.rejects(
      () => gh.createPullRequest(
        { headRef: "feat/x", baseRef: "main", title: "t", body: "b" },
        token as never,
      ),
      // A genuine worker token names `ollama:...`, so the target guard reaches
      // it first. Both facts are true of it and the message states which one
      // was decisive.
      /names target .*ollama.*but this client writes to/,
      "an authorization minted elsewhere opened the write",
    );
    assert.deepEqual(r.seen(), []);
  });

  /**
   * THE TARGET COMES FROM THE CLIENT, NOT FROM THE TOKEN (round-7 HIGH 2).
   *
   * A genuine token minted for `ollama:qwen2.5-coder:7b` is presented to a
   * client that writes to `hakanduyar/software-factory`. If the adapter asked
   * the TOKEN where it may be spent, the comparison would succeed and only the
   * kind would refuse — so the message is asserted, not merely the rejection.
   */
  it("refuses a token whose target is not the repository this client writes to", async () => {
    const minted = authorizeRemoteWrite(
      launchAiWorkerAction({
        resourceKey: "ollama:qwen2.5-coder:7b",
        observation: observeBilling({
          provider: "ollama",
          model: "qwen2.5-coder:7b",
          billingMode: "INCLUDED_SUBSCRIPTION",
        }),
        description: "a local worker",
      }),
      parseFinancialPolicy({ autonomousSpendAllowed: false, autonomousSpendLimit: 0 }),
    );
    assert.equal(minted.ok, true, "the premise failed: no genuine token to present");
    if (!minted.ok) return;

    const { client: gh, runner: r } = client({});

    await assert.rejects(
      () => gh.createPullRequest(
        { headRef: "feat/x", baseRef: "main", title: "t", body: "b" },
        minted.authorization,
      ),
      /names target .*ollama.*but this client writes to hakanduyar\/software-factory/,
      "the adapter accepted the token's own idea of where it may be spent",
    );
    assert.deepEqual(r.seen(), []);
  });

  /**
   * THE KIND IS DEMANDED SPECIFICALLY, isolated from the target comparison.
   *
   * Every genuinely mintable token names a target like `ollama:model`, so the
   * target guard reaches all of them first and the KIND comparison never gets
   * to decide anything — which is exactly why replacing the literal
   * `"CREATE_PULL_REQUEST"` with the token's OWN kind survived mutation.
   *
   * So the client here is configured with a repository that EQUALS the token's
   * target. That is a nonsense repository name, and deliberately so: it is the
   * only arrangement in which the target matches and the kind is the sole
   * remaining question. (It is possible because the adapter does not validate
   * the shape of the repository it is constructed with — recorded rather than
   * changed, because the repository comes from a trusted CLI argument and
   * narrowing it belongs to whatever work owns that argument.)
   */
  it("demands the CREATE_PULL_REQUEST kind even when the target matches", async () => {
    const RESOURCE = "ollama:qwen2.5-coder:7b";
    const minted = authorizeRemoteWrite(
      launchAiWorkerAction({
        resourceKey: RESOURCE,
        observation: observeBilling({
          provider: "ollama",
          model: "qwen2.5-coder:7b",
          billingMode: "INCLUDED_SUBSCRIPTION",
        }),
        description: "a local worker",
      }),
      parseFinancialPolicy({ autonomousSpendAllowed: false, autonomousSpendLimit: 0 }),
    );
    assert.equal(minted.ok, true, "the premise failed: no genuine token to present");
    if (!minted.ok) return;

    const seenRunner = runner({});
    const gh = createGhCliClient({
      processRunner: seenRunner,
      cwd: "/tmp",
      // Matches the token's target, so ONLY the kind can refuse.
      repository: RESOURCE,
      ghPath: "/usr/bin/true",
      gitPath: "/usr/bin/true",
    });

    await assert.rejects(
      () => gh.createPullRequest(
        { headRef: "feat/x", baseRef: "main", title: "t", body: "b" },
        minted.authorization,
      ),
      /requires an authorization minted by authorizeRemoteWrite for CREATE_PULL_REQUEST/,
      "a token of another kind opened the write once its target matched",
    );
    assert.deepEqual(seenRunner.seen(), [], "gh ran before the kind was checked");
  });

  /**
   * THE CONTROL, and the one that matters most: the gate mints NOTHING for the
   * action publication would perform, so the refusal above is not merely a
   * missing-argument check. If this ever starts minting, the assertion below
   * fails and forces the question to be answered deliberately.
   */
  it("mints no authorization for a pull request against a real repository", () => {
    const minted = authorizeRemoteWrite(
      createPullRequestAction({ target: REPO, description: "publish" }),
      parseFinancialPolicy({ autonomousSpendAllowed: false, autonomousSpendLimit: 0 }),
    );

    assert.equal(minted.ok, false, "the gate minted a write authorization for a pull request");
  });
});

describe("TASK-016 AC-5 (amended): the adapter reports every pull request it is told about", () => {
  function entry(number: number, headSha: string, state = "OPEN") {
    return {
      number,
      state,
      headRefName: "feat/executor-wiring",
      headRefOid: headSha,
      baseRefName: "main",
      baseRefOid: "3333333333333333333333333333333333333333",
    };
  }

  /**
   * THE ADAPTER NO LONGER CHOOSES. It used to throw when more than one was open
   * and silently take `parsed[0]` when none were — arbitrary selection wearing
   * a different hat. Ambiguity is now a fact the adapter REPORTS and
   * `selectAdoptablePullRequest` refuses.
   */
  it("returns both pull requests when the remote reports two", async () => {
    const { client: gh } = client({
      "pr list": JSON.stringify([entry(7, A), entry(9, A)]),
    });

    const listed = await gh.listPullRequests("feat/executor-wiring");

    assert.equal(listed.length, 2, "the adapter narrowed an ambiguous listing to one");
    assert.deepEqual(listed.map((pr) => pr.number).sort((x, y) => x - y), [7, 9]);
  });

  /** Including when NONE are open, which is where `parsed[0]` used to be taken. */
  it("returns every closed pull request rather than picking one", async () => {
    const { client: gh } = client({
      "pr list": JSON.stringify([entry(7, A, "CLOSED"), entry(9, A, "MERGED")]),
    });

    const listed = await gh.listPullRequests("feat/executor-wiring");

    assert.equal(listed.length, 2, "a closed listing was narrowed to one");
  });

  it("returns an empty list when the remote reports none", async () => {
    const { client: gh } = client({ "pr list": "[]" });

    assert.deepEqual(await gh.listPullRequests("feat/executor-wiring"), []);
  });

  /**
   * A malformed entry THROWS rather than being skipped: dropping an unreadable
   * pull request is how a listing of two becomes an unambiguous listing of one.
   */
  it("refuses a listing containing an entry it cannot read", async () => {
    const { client: gh } = client({
      "pr list": JSON.stringify([entry(7, A), { number: "not-a-number" }]),
    });

    await assert.rejects(
      () => gh.listPullRequests("feat/executor-wiring"),
      /pull request number/,
      "an unreadable entry was silently dropped from the listing",
    );
  });
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

  /**
   * ROUND-4 SURVIVOR. Replacing the visibility parser with a constant `PUBLIC`
   * left 68 tests green: every fixture happened to BE public, so nothing could
   * tell a parser from a constant. A private fixture can.
   */
  it("reports a private repository as PRIVATE", async () => {
    const { client: gh } = client({
      [`repos/${REPO} --jq`]: JSON.stringify({
        nameWithOwner: REPO,
        visibility: "PRIVATE",
        defaultBranch: "main",
        ownerType: "User",
      }),
      "hooks": "0",
      "actions/workflows": "0",
    });

    assert.equal((await gh.repository()).visibility, "PRIVATE", "a private repository was parsed as public");
  });

  it("treats an unrecognised visibility as UNKNOWN", async () => {
    const { client: gh } = client({
      [`repos/${REPO} --jq`]: JSON.stringify({
        nameWithOwner: REPO,
        visibility: "INTERNAL",
        defaultBranch: "main",
        ownerType: "User",
      }),
      "hooks": "0",
      "actions/workflows": "0",
    });

    assert.equal((await gh.repository()).visibility, "UNKNOWN");
  });

  /**
   * ROUND-4 SURVIVOR. Hard-coding the returned sha to the fixture's own value
   * left all 26 adapter tests green, because every case asked about that same
   * sha. Asking about a DIFFERENT one is what distinguishes "bound" from
   * "constant".
   */
  it("binds the check status to the commit that was asked about", async () => {
    const other = "9999999999999999999999999999999999999999";
    const { client: gh } = client({
      "check-runs": JSON.stringify({ total: 1, conclusions: ["success"], statuses: ["completed"] }),
    });

    const status = await gh.checkStatus(other);

    assert.equal(status.sha, other, "the status reported a commit other than the one asked about");
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
