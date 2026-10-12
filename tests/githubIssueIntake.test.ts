import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseGithubIssueArgs, runGithubIssue, type GithubIssueArgs } from "../src/cli/github.js";
import { redactSecrets } from "../src/adapters/workers/environmentPolicy.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/ports/processRunner.js";
import type { Timestamp } from "../src/domain/time.js";

const REPO = "octo/hello";
const ARGS: GithubIssueArgs = { repo: REPO, number: 7 };

function processResult(stdout: string, extra: Partial<ProcessResult> = {}): ProcessResult {
  return {
    terminationReason: "EXITED",
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    startedAt: 0 as Timestamp,
    finishedAt: 1 as Timestamp,
    durationMs: 1,
    ...extra,
  };
}

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 7,
    state: "open",
    title: "Fix it",
    body: "Details",
    html_url: `https://github.com/${REPO}/issues/7`,
    user: { login: "someone" },
    ...overrides,
  });
}

async function invoke(response: ProcessResult, args: GithubIssueArgs = ARGS) {
  const calls: ProcessRequest[] = [];
  const runner: ProcessRunner = {
    async run(request: ProcessRequest): Promise<ProcessResult> {
      calls.push(request);
      return response;
    },
  };
  const out: string[] = [];
  const err: string[] = [];
  const code = await runGithubIssue(args, {
    processRunner: runner,
    ghPath: "/usr/bin/gh",
    cwd: "/tmp",
    log: (line) => out.push(line),
    logError: (line) => err.push(line),
  });
  return { code, out, err, calls };
}

const EXPECTED = {
  kind: "github-issue",
  trust: "untrusted",
  access: "read-only",
  repository: REPO,
  number: 7,
  url: `https://github.com/${REPO}/issues/7`,
  state: "open",
  title: "Fix it",
  body: "Details",
};

describe("sf github issue argument parsing", () => {
  it("accepts exactly --repo owner/name and --number N", () => {
    assert.deepEqual(parseGithubIssueArgs(["--repo", REPO, "--number", "7"]), {
      ok: true,
      value: { repo: REPO, number: 7 },
    });
    assert.deepEqual(parseGithubIssueArgs(["--number", "12", "--repo", REPO]), {
      ok: true,
      value: { repo: REPO, number: 12 },
    });
  });

  const invalid: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["missing number", ["--repo", REPO]],
    ["missing repo", ["--number", "7"]],
    ["no arguments", []],
    ["duplicate repo", ["--repo", REPO, "--repo", REPO, "--number", "7"]],
    ["duplicate number", ["--repo", REPO, "--number", "7", "--number", "8"]],
    ["unknown flag", ["--repo", REPO, "--number", "7", "--write", "1"]],
    ["stray value", ["--repo", REPO, "--number", "7", "extra"]],
    ["equals form", ["--repo=octo/hello", "--number", "7"]],
    ["flag without value", ["--repo", REPO, "--number"]],
    ["flag as value", ["--repo", "--number", "7"]],
    ["zero", ["--repo", REPO, "--number", "0"]],
    ["negative", ["--repo", REPO, "--number", "-1"]],
    ["fraction", ["--repo", REPO, "--number", "1.5"]],
    ["leading zero", ["--repo", REPO, "--number", "07"]],
    ["non-numeric", ["--repo", REPO, "--number", "abc"]],
    ["unsafe integer", ["--repo", REPO, "--number", "9007199254740993"]],
    ["repo without owner", ["--repo", "hello", "--number", "7"]],
    ["repo with extra segment", ["--repo", "a/b/c", "--number", "7"]],
    ["repo traversal", ["--repo", "octo/..", "--number", "7"]],
  ];
  for (const [name, args] of invalid) {
    it(`rejects ${name}`, () => {
      assert.equal(parseGithubIssueArgs(args).ok, false);
    });
  }
});

describe("sf github issue through the real adapter", () => {
  it("issues exactly one read-only GET and prints one untrusted source", async () => {
    const { code, out, err, calls } = await invoke(processResult(payload()));
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.executable, "/usr/bin/gh");
    assert.deepEqual(calls[0]?.argv, ["api", "--method", "GET", `repos/${REPO}/issues/7`]);
    assert.equal(err.length, 0);
    assert.equal(out.length, 1);
    assert.deepEqual(JSON.parse(out[0] ?? ""), EXPECTED);
  });

  it("accepts a null body and a closed state", async () => {
    const { code, out } = await invoke(processResult(payload({ body: null, state: "closed" })));
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(out[0] ?? ""), { ...EXPECTED, body: null, state: "closed" });
  });

  it("normalizes a differently-cased canonical url to the requested repository", async () => {
    const { code, out } = await invoke(
      processResult(payload({ html_url: "https://github.com/Octo/Hello/issues/7" })),
    );
    assert.equal(code, 0);
    assert.equal((JSON.parse(out[0] ?? "") as { url: string }).url, EXPECTED.url);
  });

  it("makes zero external calls for an invalid repository or number", async () => {
    for (const args of [
      { repo: "not-a-slug", number: 7 },
      { repo: REPO, number: 0 },
      { repo: REPO, number: 1.5 },
    ]) {
      const { code, out, calls } = await invoke(processResult(payload()), args);
      assert.equal(code, 1);
      assert.equal(calls.length, 0);
      assert.equal(out.length, 0);
    }
  });

  const refusals: ReadonlyArray<readonly [string, ProcessResult]> = [
    ["a pull request payload", processResult(payload({ pull_request: { url: "x" } }))],
    ["a mismatched number", processResult(payload({ number: 8 }))],
    ["a string number", processResult(payload({ number: "7" }))],
    ["a mismatched url", processResult(payload({ html_url: "https://github.com/octo/other/issues/7" }))],
    ["a pull url", processResult(payload({ html_url: `https://github.com/${REPO}/pull/7` }))],
    ["an unknown state", processResult(payload({ state: "merged" }))],
    ["a non-string title", processResult(payload({ title: 5 }))],
    ["a missing title", processResult(payload({ title: undefined }))],
    ["a missing body", processResult(payload({ body: undefined }))],
    ["a numeric body", processResult(payload({ body: 5 }))],
    ["truncated output", processResult(payload(), { stdoutTruncated: true })],
    ["a non-zero exit", processResult("", { exitCode: 1, stderr: "gh: Not Found (HTTP 404)" })],
    ["a timeout", processResult("", { terminationReason: "TIMEOUT", exitCode: null })],
    ["non-JSON output", processResult("not json")],
    ["an array payload", processResult("[]")],
  ];
  for (const [name, response] of refusals) {
    it(`refuses ${name} without publishing a source`, async () => {
      const { code, out, err } = await invoke(response);
      assert.equal(code, 1);
      assert.equal(out.length, 0);
      assert.equal(err.length, 1);
    });
  }

  it("refuses secret-bearing text and never echoes the secret", async () => {
    const secret = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    assert.notEqual(redactSecrets(secret), secret, "detector precondition: redactSecrets must recognise this token");
    for (const overrides of [{ body: `token ${secret}` }, { title: secret }]) {
      const { code, out, err } = await invoke(processResult(payload(overrides)));
      assert.equal(code, 1);
      assert.equal(out.length, 0);
      assert.equal(err.join("\n").includes(secret), false);
    }
  });

  it("enforces the title bound in UTF-8 bytes without truncating", async () => {
    const exact = await invoke(processResult(payload({ title: "a".repeat(1024) })));
    assert.equal(exact.code, 0);
    const wide = await invoke(processResult(payload({ title: "\u00e9".repeat(512) })));
    assert.equal(wide.code, 0);
    const over = await invoke(processResult(payload({ title: "a".repeat(1025) })));
    assert.equal(over.code, 1);
    const overWide = await invoke(processResult(payload({ title: "\u00e9".repeat(513) })));
    assert.equal(overWide.code, 1);
    assert.equal(over.out.length + overWide.out.length, 0);
  });

  it("enforces the body bound in UTF-8 bytes without truncating", async () => {
    const exact = await invoke(processResult(payload({ body: "a".repeat(65536) })));
    assert.equal(exact.code, 0);
    const over = await invoke(processResult(payload({ body: "a".repeat(65537) })));
    assert.equal(over.code, 1);
    const overWide = await invoke(processResult(payload({ body: "\u00e9".repeat(32769) })));
    assert.equal(overWide.code, 1);
    assert.equal(over.out.length + overWide.out.length, 0);
  });
});

describe("sf github issue through the compiled main", () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-issue-"));
  const payloadPath = join(dir, "payload.json");
  writeFileSync(payloadPath, payload());
  const ghPath = join(dir, "gh");
  writeFileSync(
    ghPath,
    `#!/bin/sh
if [ "$#" -ne 4 ] || [ "$1 $2 $3 $4" != "api --method GET repos/${REPO}/issues/7" ]; then
  echo "unexpected argv" >&2
  exit 2
fi
cat '${payloadPath}'
`,
  );
  chmodSync(ghPath, 0o755);

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runMain(args: readonly string[]) {
    return spawnSync(process.execPath, [join(process.cwd(), "dist", "src", "cli", "main.js"), ...args], {
      encoding: "utf8",
      env: { PATH: `${dir}:${process.env["PATH"] ?? ""}`, HOME: dir },
      timeout: 30_000,
    });
  }

  it("dispatches `github issue` and prints one read-only source", () => {
    const child = runMain(["github", "issue", "--repo", REPO, "--number", "7"]);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout.trim()), EXPECTED);
  });

  it("refuses an invalid command line with exit 1 and no source", () => {
    const child = runMain(["github", "issue", "--repo", REPO]);
    assert.equal(child.status, 1);
    assert.equal(child.stdout.trim(), "");
  });
});
