/**
 * Task usage note export: runs the real offline script against temporary,
 * test-owned fixtures only. Expectations are literal. No existing vault,
 * provider or database is touched; cleanup removes only the temp root this
 * file created.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(ROOT, "scripts/obsidian/export-task-usage-notes.mjs");
const dir = mkdtempSync(join(tmpdir(), "sf-usage-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const sha = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const h = (c: string): string => c.repeat(64);
const TICKET = h("a");
let n = 0;

function rec(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    payloadSha256: h("1"), effort: "low", runId: "RUN_A", startAcknowledged: false, attempt: 1,
    terminalReason: "NATURAL_EXIT", monetaryCost: "UNKNOWN", ticketSha256: TICKET, exitCode: 0,
    sdkReportedOutputTokens: 23679, terminalRef: { locator: "terminal.json", sha256: h("2") },
    evidenceGroup: "group-a", model: "claude-sonnet-5-5", contribution: "plain label",
    requestFileSha256: h("3"), capturedCanonicalRequestSha256: h("4"), ...over,
  };
}
const doc = (runs: unknown[], schema = "SanitizedAcceptedWorkAttributionInputs/v1") => ({ schema, nativeRuns: runs });

function outDir(): string {
  const p = join(dir, `out${n++}`);
  mkdirSync(p);
  return p;
}
function inputFile(body: unknown): { path: string; sha: string } {
  const p = join(dir, `in${n++}.json`);
  const bytes = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  writeFileSync(p, bytes);
  return { path: p, sha: sha(bytes) };
}
function run(input: { path: string; sha: string }, owned: string, over: { runId?: string; attempt?: string; ticket?: string; sha?: string } = {}) {
  return runArgs([
    "--input", input.path, "--input-sha256", over.sha ?? input.sha, "--run-id", over.runId ?? "RUN_A",
    "--attempt", over.attempt ?? "1", "--ticket-sha256", over.ticket ?? TICKET, "--owned-directory", owned,
  ]);
}
function runArgs(args: string[]): { code: number | null; out: any } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { code: r.status, out: JSON.parse(r.stdout) };
}
const NOTE_ID = sha(JSON.stringify(["RUN_A", 1, TICKET]));

describe("usage rendering", () => {
  it("exports known usage distinct from unknown billing/cost and reads back exact bytes", () => {
    const o = outDir();
    const r = run(inputFile(doc([rec()])), o);
    assert.equal(r.code, 0);
    assert.equal(r.out.status, "CREATED");
    assert.ok(r.out.path.endsWith(`${NOTE_ID}.md`));
    const bytes = readFileSync(r.out.path);
    assert.equal(r.out.sha256, sha(bytes));
    assert.equal(r.out.bytes, bytes.length);
    assert.deepEqual(readdirSync(o), [`${NOTE_ID}.md`]);
    const text = bytes.toString("utf8");
    assert.match(text, /- SDK-reported output tokens: 23679\n/);
    assert.match(text, /- Billed tokens: UNKNOWN/);
    assert.match(text, /- Monetary cost: UNKNOWN\n/);
    assert.match(text, new RegExp(`- Input SHA-256: ${sha(JSON.stringify(doc([rec()])))}`));
    assert.match(text, new RegExp(`- Terminal reference SHA-256: ${h("2")}`));
    assert.match(text, /- Terminal reason: NATURAL_EXIT\n/);
    assert.ok(!text.startsWith("---"));
  });

  it("prints observed zero as 0 and null as UNKNOWN, retaining DEADLINE history", () => {
    const zero = run(inputFile(doc([rec({ sdkReportedOutputTokens: 0 })])), outDir());
    assert.match(readFileSync(zero.out.path, "utf8"), /- SDK-reported output tokens: 0\n/);
    const failed = run(
      inputFile(doc([rec({ sdkReportedOutputTokens: null, terminalReason: "DEADLINE", exitCode: -1, startAcknowledged: true })])),
      outDir(),
    );
    const text = readFileSync(failed.out.path, "utf8");
    assert.match(text, /- SDK-reported output tokens: UNKNOWN\n/);
    assert.match(text, /- Terminal reason: DEADLINE\n/);
    assert.match(text, /- Exit code: -1\n/);
    assert.match(text, /- Start acknowledged: true\n/);
  });

  it("renders untrusted strings inert", () => {
    const evil = "<script>x</script>\n---\n[l](http://e.example/x) `c` # h ![i](u)";
    const r = run(inputFile(doc([rec({ contribution: evil, model: "m|<b>" })])), outDir());
    const text = readFileSync(r.out.path, "utf8");
    const lines = text.split("\n");
    const contributionPrefix = "- Historical contribution label (caller-supplied inert text from the pinned input): ";
    const modelPrefix = "- Model: ";
    const contributionLines = lines.filter((l) => l.startsWith(contributionPrefix));
    const modelLines = lines.filter((l) => l.startsWith(modelPrefix));
    assert.equal(contributionLines.length, 1);
    assert.equal(modelLines.length, 1);
    // Trusted fixed note structure stays valid: legitimate static headings are present, no frontmatter, no bare rule lines.
    assert.ok(text.includes("\n## Selected native run identity"));
    assert.ok(!text.startsWith("---"));
    assert.ok(!lines.includes("---"));
    // Untrusted field values only: letters (including "http") may remain; active markup/URL/frontmatter/header syntax must not.
    const contributionLine = contributionLines[0];
    const modelLine = modelLines[0];
    assert.equal(typeof contributionLine, "string");
    assert.equal(typeof modelLine, "string");
    if (typeof contributionLine !== "string" || typeof modelLine !== "string") {
      throw new Error("expected exactly one contribution line and one model line");
    }
    const fieldValues = [contributionLine.slice(contributionPrefix.length), modelLine.slice(modelPrefix.length)];
    for (const value of fieldValues) {
      for (const bad of ["<", ">", "[", "]", "`", "|", "://", "![", "\n", "\n---", "\n#"]) assert.ok(!value.includes(bad), bad);
      assert.ok(!value.startsWith("#") && !value.startsWith("---"));
    }
    const evilEncoded =
      "&#x3C;script&#x3E;x&#x3C;&#x2F;script&#x3E;&#xA;---&#xA;&#x5B;l&#x5D;(http&#x3A;&#x2F;&#x2F;e&#x2E;example&#x2F;x) " +
      "&#x60;c&#x60; &#x23; h &#x21;&#x5B;i&#x5D;(u)";
    assert.ok(text.includes(`- Historical contribution label (caller-supplied inert text from the pinned input): ${evilEncoded}\n`));
    assert.ok(text.includes("- Model: m&#x7C;&#x3C;b&#x3E;\n"));
  });
});

describe("selection", () => {
  it("collapses exact duplicates and ignores other identities", () => {
    const other = rec({ runId: "RUN_B" });
    const r = run(inputFile(doc([rec(), other, rec()])), outDir());
    assert.equal(r.out.status, "CREATED");
  });

  it("refuses conflicting records for the same identity before writing", () => {
    const o = outDir();
    const r = run(inputFile(doc([rec(), rec({ sdkReportedOutputTokens: 5 })])), o);
    assert.equal(r.out.code, "SELECTOR_CONFLICT");
    assert.deepEqual(readdirSync(o), []);
  });

  it("refuses bad pin, schema, shape and missing selector before writing", () => {
    const o = outDir();
    const good = inputFile(doc([rec()]));
    const cases: Array<[any, string]> = [
      [run(good, o, { sha: h("9") }), "INPUT_HASH_MISMATCH"],
      [run(inputFile(doc([rec()], "Other/v1")), o), "INPUT_SCHEMA"],
      [run(inputFile(doc([rec({ monetaryCost: 3 })])), o), "INPUT_RUN_SHAPE"],
      [run(inputFile(doc([rec({ sdkReportedOutputTokens: -1 })])), o), "INPUT_RUN_SHAPE"],
      [run(inputFile("not json"), o), "INPUT_NOT_JSON"],
      [run(good, o, { attempt: "2" }), "SELECTOR_NOT_FOUND"],
      [run(good, o, { ticket: h("b") }), "SELECTOR_NOT_FOUND"],
      [run(good, o, { runId: "RUN_Z" }), "SELECTOR_NOT_FOUND"],
    ];
    for (const [r, code] of cases) {
      assert.equal(r.out.code, code);
      assert.equal(r.code, 2);
    }
    assert.deepEqual(readdirSync(o), []);
  });

  it("refuses malformed arguments", () => {
    const good = inputFile(doc([rec()]));
    const o = outDir();
    const base = ["--input", good.path, "--input-sha256", good.sha, "--run-id", "RUN_A", "--attempt", "1", "--ticket-sha256", TICKET, "--owned-directory", o];
    assert.equal(runArgs(base.slice(0, 10)).out.code, "ARGS_INVALID");
    assert.equal(runArgs([...base.slice(0, 10), "--attempt", "1"]).out.code, "ARGS_INVALID");
    assert.equal(runArgs(base.map((a) => (a === "1" ? "0" : a))).out.code, "ARGS_INVALID");
    assert.equal(runArgs(base.map((a) => (a === good.path ? "relative.json" : a))).out.code, "ARGS_INVALID");
  });
});

describe("persistence", () => {
  it("reports EXISTING for identical bytes and CONFLICT for changed same-identity content", () => {
    const o = outDir();
    const first = run(inputFile(doc([rec()])), o);
    assert.equal(first.out.status, "CREATED");
    const again = run(inputFile(doc([rec()])), o);
    assert.equal(again.out.status, "EXISTING");
    assert.equal(again.out.sha256, first.out.sha256);
    const before = readFileSync(first.out.path);
    const changed = run(inputFile(doc([rec({ contribution: "different" })])), o);
    assert.equal(changed.out.code, "CONFLICT");
    assert.equal(changed.code, 1);
    assert.deepEqual(readFileSync(first.out.path), before);
  });

  it("refuses invalid owned directories", () => {
    const input = inputFile(doc([rec()]));
    const file = join(dir, `file${n++}`);
    writeFileSync(file, "x");
    // Literal dotted path: built by concatenation so it is NOT normalized before the CLI sees it.
    const dotted = `${dir}${sep}a${sep}..`;
    assert.ok(isAbsolute(dotted));
    assert.notEqual(normalize(dotted), dotted);
    const guard = outDir();
    for (const bad of [join(dir, "missing"), file, "relative", dotted]) {
      const r = run(input, bad);
      assert.equal(r.out.code, "INVALID_DIRECTORY", bad);
      assert.equal(r.code, 2);
    }
    assert.deepEqual(readdirSync(guard), []);
    assert.deepEqual(readdirSync(dir).filter((x) => x.endsWith(".md")), []);
  });

  it("refuses a directory link as the owned directory without touching its target", () => {
    const input = inputFile(doc([rec()]));
    const target = outDir();
    const link = join(dir, `link${n++}`);
    // Windows junction vs Unix directory symbolic link; any creation error fails the test.
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(realpathSync(link), realpathSync(target));
    const r = run(input, link);
    assert.equal(r.out.code, "INVALID_DIRECTORY");
    assert.equal(r.code, 2);
    assert.deepEqual(readdirSync(target), []);
  });

  it("refuses non-ordinary destinations without touching them", () => {
    const input = inputFile(doc([rec()]));
    const asDir = outDir();
    mkdirSync(join(asDir, `${NOTE_ID}.md`));
    assert.equal(run(input, asDir).out.code, "INVALID_DESTINATION");
    assert.deepEqual(readdirSync(join(asDir, `${NOTE_ID}.md`)), []);
  });

  it("refuses a file symbolic link destination without touching its target", (t) => {
    const input = inputFile(doc([rec()]));
    const asLink = outDir();
    const secret = join(dir, `secret${n++}`);
    writeFileSync(secret, "keep");
    const dest = join(asLink, `${NOTE_ID}.md`);
    try {
      symlinkSync(secret, dest, "file");
    } catch (e) {
      // Only an unprivileged Windows host (typed EPERM) may skip, and it is reported as a skip.
      if (process.platform === "win32" && (e as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("file symlink creation requires privilege on this Windows host (EPERM)");
        return;
      }
      throw e;
    }
    assert.ok(lstatSync(dest).isSymbolicLink());
    assert.equal(realpathSync(dest), realpathSync(secret));
    const r = run(input, asLink);
    assert.equal(r.out.code, "INVALID_DESTINATION");
    assert.equal(r.code, 2);
    assert.equal(readFileSync(secret, "utf8"), "keep");
  });
});
