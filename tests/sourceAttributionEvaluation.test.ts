/**
 * Source-attribution rubric: runs the real CLI against the tracked fixture and
 * temporary response files. Expectations are literal, not derived from checker output.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(ROOT, "scripts/evaluations/source-attribution.mjs");
const FIXTURE = join(ROOT, "fixtures/evaluations/source-attribution-v1.json");
const dir = mkdtempSync(join(tmpdir(), "sf-attr-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const H = {
  cur: sha("The calibration color is blue."),
  old: sha("The calibration color is red."),
  a: sha("The calibration direction is north."),
  b: sha("The calibration direction is south."),
};
type Cite = { sourceId: string; revision: number; contentSha256: string };
type Resp = { caseId: string; claimId: string; status: string; value: string | null; citations: Cite[] };
const c = (sourceId: string, revision: number, contentSha256: string): Cite => ({ sourceId, revision, contentSha256 });
const canonical = (): Resp[] => [
  { caseId: "known-answer", claimId: "calibration-color", status: "SUPPORTED", value: "blue", citations: [c("source-current", 2, H.cur)] },
  { caseId: "stale", claimId: "calibration-color-from-old", status: "UNKNOWN", value: null, citations: [c("source-old", 1, H.old)] },
  { caseId: "conflict", claimId: "calibration-direction", status: "UNKNOWN", value: null, citations: [c("direction-a", 1, H.a), c("direction-b", 1, H.b)] },
  { caseId: "unsupported", claimId: "deployment-authorized", status: "UNKNOWN", value: null, citations: [] },
];

let n = 0;
function run(body: unknown, fixture = FIXTURE): { code: number | null; out: any } {
  const p = join(dir, `r${n++}.json`);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  const r = spawnSync(process.execPath, [CLI, "--fixture", fixture, "--responses", p], { encoding: "utf8" });
  return { code: r.status, out: JSON.parse(r.stdout) };
}
const withCase = (id: string, patch: (r: Resp) => void): { responses: Resp[] } => {
  const rs = canonical();
  patch(rs.find((r) => r.caseId === id)!);
  return { responses: rs };
};
const resultOf = (out: any, id: string): any => out.cases.find((x: any) => x.caseId === id);

describe("fixture facts (independent of checker)", () => {
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
  it("pins exact sources, hashes, lineage and the four cases", () => {
    const byId = Object.fromEntries(fx.sources.map((s: any) => [s.sourceId, s]));
    assert.equal(byId["source-current"].content, "The calibration color is blue.");
    assert.equal(byId["source-current"].revision, 2);
    assert.equal(byId["source-old"].content, "The calibration color is red.");
    assert.equal(byId["source-old"].current, false);
    assert.deepEqual(byId["source-old"].supersededBy, { sourceId: "source-current", revision: 2 });
    assert.equal(byId["source-old"].lineageId, byId["source-current"].lineageId);
    assert.equal(byId["direction-a"].content, "The calibration direction is north.");
    assert.equal(byId["direction-b"].content, "The calibration direction is south.");
    for (const s of fx.sources) assert.equal(s.contentSha256, sha(s.content));
    assert.deepEqual(fx.cases.map((k: any) => [k.caseId, k.claimId, k.expected.status, k.expected.value, k.expected.citations.length]), [
      ["known-answer", "calibration-color", "SUPPORTED", "blue", 1],
      ["stale", "calibration-color-from-old", "UNKNOWN", null, 1],
      ["conflict", "calibration-direction", "UNKNOWN", null, 2],
      ["unsupported", "deployment-authorized", "UNKNOWN", null, 0],
    ]);
  });
});

describe("source-attribution CLI", () => {
  it("canonical responses PASS 4/4 with exit 0", () => {
    const { code, out } = run({ responses: canonical() });
    assert.equal(code, 0);
    assert.equal(out.rubric, "source-attribution");
    assert.equal(out.version, 1);
    assert.equal(out.total, 4);
    assert.equal(out.passed, 4);
    assert.equal(out.failed, 0);
    assert.ok(out.cases.every((k: any) => k.result === "PASS"));
    assert.ok(Array.isArray(out.limits) && out.limits.length > 0);
  });

  const failures: [string, string, (r: Resp) => void, string[]][] = [
    ["wrong known value", "known-answer", (r) => { r.value = "red"; }, ["VALUE_MISMATCH"]],
    ["stale answered SUPPORTED", "stale", (r) => { r.status = "SUPPORTED"; r.value = "red"; }, ["STATUS_MISMATCH", "VALUE_MISMATCH"]],
    ["stale substitutes current source", "stale", (r) => { r.citations = [c("source-current", 2, H.cur)]; }, ["CITATION_MISSING", "CITATION_UNEXPECTED"]],
    ["conflict omits one citation", "conflict", (r) => { r.citations = [c("direction-a", 1, H.a)]; }, ["CITATION_MISSING"]],
    ["conflict silently prefers north", "conflict", (r) => { r.status = "SUPPORTED"; r.value = "north"; r.citations = [c("direction-a", 1, H.a)]; }, ["CITATION_MISSING", "STATUS_MISMATCH", "VALUE_MISMATCH"]],
    ["unsupported invented claim", "unsupported", (r) => { r.status = "SUPPORTED"; r.value = "yes"; }, ["STATUS_MISMATCH", "VALUE_MISMATCH"]],
    ["unsupported with citation", "unsupported", (r) => { r.citations = [c("source-current", 2, H.cur)]; }, ["CITATION_UNEXPECTED"]],
    ["known wrong revision", "known-answer", (r) => { r.citations = [c("source-current", 1, H.cur)]; }, ["CITATION_REVISION_MISMATCH"]],
    ["known wrong hash", "known-answer", (r) => { r.citations = [c("source-current", 2, "0".repeat(64))]; }, ["CITATION_HASH_MISMATCH"]],
  ];
  for (const [name, id, patch, codes] of failures) {
    it(`FAIL (exit 1): ${name}; denominator stays 4`, () => {
      const { code, out } = run(withCase(id, patch));
      assert.equal(code, 1);
      assert.equal(out.total, 4);
      assert.equal(out.cases.length, 4);
      assert.equal(out.passed, 3);
      assert.equal(out.failed, 1);
      assert.equal(resultOf(out, id).result, "FAIL");
      assert.deepEqual(resultOf(out, id).reasonCodes, codes);
      assert.equal(out.cases.filter((k: any) => k.result === "PASS").length, 3);
    });
  }

  const malformed: [string, () => unknown, string][] = [
    ["not JSON", () => "{nope", "RESPONSES_NOT_JSON"],
    ["missing case", () => ({ responses: canonical().slice(0, 3) }), "RESPONSE_MISSING_CASE"],
    ["duplicate case", () => ({ responses: [...canonical(), canonical()[0]] }), "RESPONSE_DUPLICATE_CASE"],
    ["extra case", () => ({ responses: [...canonical(), { ...canonical()[0]!, caseId: "bonus" }] }), "RESPONSE_UNKNOWN_CASE"],
    ["claim mismatch", () => withCase("stale", (r) => { r.claimId = "other"; }), "RESPONSE_CLAIM_MISMATCH"],
    ["extra top-level key", () => ({ responses: canonical(), score: 1 }), "RESPONSES_SHAPE"],
    ["extra response key", () => withCase("stale", (r) => { (r as any).note = "x"; }), "RESPONSE_SHAPE"],
    ["bad status", () => withCase("stale", (r) => { r.status = "MAYBE"; }), "RESPONSE_STATUS_INVALID"],
    ["numeric value", () => withCase("stale", (r) => { (r as any).value = 3; }), "RESPONSE_VALUE_INVALID"],
    ["citations not array", () => withCase("stale", (r) => { (r as any).citations = "x"; }), "RESPONSE_CITATIONS_INVALID"],
    ["string revision", () => withCase("known-answer", (r) => { (r.citations[0] as any).revision = "2"; }), "RESPONSE_CITATION_SHAPE"],
    ["short hash", () => withCase("known-answer", (r) => { r.citations[0]!.contentSha256 = "abc"; }), "RESPONSE_CITATION_SHAPE"],
    ["unknown source", () => withCase("known-answer", (r) => { r.citations[0]!.sourceId = "ghost"; }), "RESPONSE_UNKNOWN_SOURCE"],
    ["duplicate citation", () => withCase("conflict", (r) => { r.citations = [r.citations[0]!, r.citations[0]!]; }), "RESPONSE_DUPLICATE_CITATION"],
  ];
  for (const [name, build, errorCode] of malformed) {
    it(`exit 2: ${name}`, () => {
      const { code, out } = run(build());
      assert.equal(code, 2);
      assert.equal(out.outcome, "MALFORMED");
      assert.equal(out.errorCode, errorCode);
      assert.equal(out.total, 4);
    });
  }

  it("exit 2 for a fixture whose source hash does not match its content", () => {
    const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
    fx.sources[0].contentSha256 = "f".repeat(64);
    const p = join(dir, "bad-fixture.json");
    writeFileSync(p, JSON.stringify(fx));
    const { code, out } = run({ responses: canonical() }, p);
    assert.equal(code, 2);
    assert.equal(out.errorCode, "FIXTURE_SOURCE_HASH_MISMATCH");
  });

  it("exit 2 for missing arguments and unreadable files", () => {
    const r = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.equal(JSON.parse(r.stdout).errorCode, "ARGS_INVALID");
    const r2 = spawnSync(process.execPath, [CLI, "--fixture", FIXTURE, "--responses", join(dir, "absent.json")], { encoding: "utf8" });
    assert.equal(r2.status, 2);
    assert.equal(JSON.parse(r2.stdout).errorCode, "RESPONSES_UNREADABLE");
  });
});
