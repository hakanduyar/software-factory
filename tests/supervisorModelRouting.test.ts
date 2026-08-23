/**
 * Model/effort enforcement, routing and failure classification
 * (TASK-006 AC-8, AC-12, AC-13).
 *
 * Three claims are under test here, and each of them is a claim the Factory has
 * previously been wrong about in some form:
 *
 *  1. that a model and effort written in a prompt were the ones actually used;
 *  2. that a reviewer stays independent when resources get scarce;
 *  3. that a provider failure can be understood without asking a model.
 *
 * Nothing here contacts a provider. The argv assertions are against the pure
 * builders the accepted TASK-003 adapters use, with flags measured on this
 * machine.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  planAiRunConfig,
  reconcileReportedIdentity,
  SUPPORTED_CODEX_EFFORTS,
} from "../src/supervision/modelEnforcement.js";
import {
  DEFAULT_ROUTING_POLICY,
  requiresAi,
  selectResource,
  type RoutingPolicy,
} from "../src/supervision/modelRouting.js";
import {
  classifyResourceOutcome,
  FAILURE_SIGNATURES,
  interpretClaudeAuthStatus,
  interpretCodexDoctorJson,
} from "../src/supervision/resourceClassifier.js";
import { NO_BACKOFF, resourceKey, type ResourceRecord } from "../src/supervision/resourceTypes.js";

function record(provider: string, model: string, state: ResourceRecord["state"]): ResourceRecord {
  return {
    provider,
    model,
    key: resourceKey(provider, model),
    state,
    detectedAt: 0,
    lastCheckedAt: 0,
    backoff: NO_BACKOFF,
  };
}

function resources(...records: readonly ResourceRecord[]): ReadonlyMap<string, ResourceRecord> {
  return new Map(records.map((entry) => [entry.key, entry]));
}

// =====================================================================
// AC-12 — model and effort are real launcher configuration
// =====================================================================

describe("TASK-006 AC-12: requested model and effort reach the actual argv", () => {
  it("puts the measured Claude Code flags in the argv", () => {
    const planned = planAiRunConfig({ provider: "claude-code", model: "opus", effort: "xhigh", role: "IMPLEMENTER" });
    assert.equal(planned.ok, true);
    if (!planned.ok) return;

    const argv = planned.value.argvEvidence;
    assert.ok(argv.includes("--model"), "the measured --model flag is used");
    assert.equal(argv[argv.indexOf("--model") + 1], "opus");
    assert.ok(argv.includes("--effort"), "the measured --effort flag is used");
    assert.equal(argv[argv.indexOf("--effort") + 1], "xhigh");
  });

  it("puts the measured Codex flags in the argv", () => {
    const planned = planAiRunConfig({
      provider: "codex-cli",
      model: "gpt-5.6-luna",
      effort: "xhigh",
      role: "REVIEWER",
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) return;

    const argv = planned.value.argvEvidence.join(" ");
    assert.match(argv, /-m gpt-5\.6-luna/, "the measured -m flag carries the model");
    // Codex takes effort as a TOML config override, and the adapter quotes the
    // value — asserted exactly as the installed CLI actually receives it.
    assert.match(argv, /-c model_reasoning_effort="xhigh"/, "effort travels as the measured -c override");
    assert.match(argv, /--sandbox read-only/, "a reviewer gets the read-only sandbox");
  });

  it("never leaks the prompt into recorded argv evidence", () => {
    const planned = planAiRunConfig({ provider: "claude-code", model: "opus", role: "IMPLEMENTER" });
    assert.equal(planned.ok, true);
    if (!planned.ok) return;
    for (const entry of planned.value.argvEvidence) {
      assert.ok(!entry.includes("secret"), "argv evidence is safe to persist");
    }
    assert.ok(planned.value.argvEvidence.some((entry) => entry.includes("<prompt-redacted>")));
  });

  it("refuses an effort the installed CLI cannot apply, instead of silently downgrading", () => {
    const planned = planAiRunConfig({
      provider: "claude-code",
      model: "opus",
      effort: "ludicrous",
      role: "IMPLEMENTER",
    });
    assert.equal(planned.ok, false, "running at an unrequested effort is a substitution, not a fallback");
    if (!planned.ok) {
      assert.match(planned.reason, /cannot be applied/);
    }
  });

  it("refuses an unnamed model rather than falling back to a default", () => {
    const planned = planAiRunConfig({ provider: "claude-code", model: "   ", role: "IMPLEMENTER" });
    assert.equal(planned.ok, false);
  });

  it("records requested identity as UNVERIFIED rather than claiming verification", () => {
    const planned = planAiRunConfig({ provider: "claude-code", model: "opus", effort: "high", role: "IMPLEMENTER" });
    assert.equal(planned.ok, true);
    if (!planned.ok) return;

    assert.equal(planned.value.requestedModel, "opus");
    assert.equal(planned.value.requestedEffort, "high");
    // The honest part: the provider does not report its own identity back, so
    // this is not claimed as verified.
    assert.equal(planned.value.verification, "UNVERIFIED");
    assert.match(planned.value.note, /not claimed as verified/);
  });

  it("upgrades to VERIFIED_EFFECTIVE only when the provider reports a matching identity", () => {
    const planned = planAiRunConfig({ provider: "claude-code", model: "opus", effort: "high", role: "IMPLEMENTER" });
    assert.equal(planned.ok, true);
    if (!planned.ok) return;

    // Round 5 (F5-ID-1): PROVIDER is a dimension too. A worker echoing a
    // matching model while running on a different provider was previously
    // indistinguishable from one that did as it was told, so a report silent
    // about the provider leaves that dimension unverified rather than agreed.
    const partial = reconcileReportedIdentity(planned.value, { model: "opus", effort: "high" });
    assert.equal(partial.verification, "UNVERIFIED");

    const verified = reconcileReportedIdentity(planned.value, {
      provider: "claude-code",
      model: "opus",
      effort: "high",
    });
    assert.equal(verified.verification, "VERIFIED_EFFECTIVE");
  });

  it("fails closed as MISMATCH when the provider reports something else", () => {
    const planned = planAiRunConfig({ provider: "claude-code", model: "opus", role: "IMPLEMENTER" });
    assert.equal(planned.ok, true);
    if (!planned.ok) return;

    const mismatched = reconcileReportedIdentity(planned.value, { model: "haiku" });
    assert.equal(mismatched.verification, "MISMATCH");
    assert.equal(mismatched.effectiveModel, "haiku");
    assert.match(mismatched.note, /but "opus" was requested/);
  });
});

// =====================================================================
// AC-13 — reviewer independence survives resource pressure
// =====================================================================

describe("TASK-006 AC-13: an implementer never reviews its own work", () => {
  const both = resources(
    record("codex-cli", "gpt-5.6-luna", "AVAILABLE"),
    record("claude-code", "opus", "AVAILABLE"),
  );

  it("selects an independent reviewer when one is available", () => {
    const selected = selectResource(
      { workClass: "INDEPENDENT_REVIEW", role: "REVIEWER", excludeResourceKeys: ["claude-code:opus"] },
      DEFAULT_ROUTING_POLICY,
      both,
    );
    assert.equal(selected.ok, true);
    if (selected.ok) {
      assert.equal(selected.option.provider, "codex-cli", "the implementer's resource was excluded");
    }
  });

  it("WAITS rather than letting the implementer review itself", () => {
    // Only the implementer's own resource is up.
    const onlyImplementer = resources(
      record("claude-code", "opus", "AVAILABLE"),
      record("codex-cli", "gpt-5.6-luna", "USAGE_LIMIT_REACHED"),
    );
    const selected = selectResource(
      { workClass: "INDEPENDENT_REVIEW", role: "REVIEWER", excludeResourceKeys: ["claude-code:opus"] },
      DEFAULT_ROUTING_POLICY,
      onlyImplementer,
    );

    assert.equal(selected.ok, false, "C4 is not negotiable under resource pressure");
    if (!selected.ok) {
      assert.equal(selected.outcome, "WAITING_FOR_RESOURCE");
      assert.match(selected.reason, /reviewer independence/);
    }
  });

  it("refuses to downgrade below a work class's quality floor", () => {
    const onlyCheap = resources(record("claude-code", "sonnet", "AVAILABLE"));
    const selected = selectResource(
      { workClass: "ARCHITECTURE_SECURITY", role: "IMPLEMENTER" },
      DEFAULT_ROUTING_POLICY,
      onlyCheap,
    );
    assert.equal(selected.ok, false, "a cheaper model is a different answer, not a fallback");
    if (!selected.ok) {
      assert.equal(selected.outcome, "WAITING_FOR_RESOURCE");
    }
  });

  it("falls back within the floor when the preferred resource is down", () => {
    const preferredDown = resources(
      record("claude-code", "sonnet", "USAGE_LIMIT_REACHED"),
      record("codex-cli", "gpt-5.6-luna", "AVAILABLE"),
    );
    const selected = selectResource(
      { workClass: "NORMAL_IMPLEMENTATION", role: "IMPLEMENTER" },
      DEFAULT_ROUTING_POLICY,
      preferredDown,
    );
    assert.equal(selected.ok, true, "an equally-qualified alternative IS a legitimate fallback");
  });

  it("treats a resource with no record as unavailable, never as optimistically usable", () => {
    const selected = selectResource(
      { workClass: "NORMAL_IMPLEMENTATION", role: "IMPLEMENTER" },
      DEFAULT_ROUTING_POLICY,
      resources(),
    );
    assert.equal(selected.ok, false, "absence of evidence is not evidence of availability");
  });

  it("refuses a work class with no eligible resource at all, which waiting cannot fix", () => {
    const emptyPolicy: RoutingPolicy = {
      eligibleByWorkClass: { ...DEFAULT_ROUTING_POLICY.eligibleByWorkClass, DOCS: [] },
      minimumQualityTier: DEFAULT_ROUTING_POLICY.minimumQualityTier,
    };
    const selected = selectResource({ workClass: "DOCS", role: "IMPLEMENTER" }, emptyPolicy, resources());
    assert.equal(selected.ok, false);
    if (!selected.ok) {
      assert.equal(selected.outcome, "REFUSED", "no amount of waiting produces an eligible resource");
    }
  });

  it("knows deterministic work needs no provider at all", () => {
    assert.equal(requiresAi("DETERMINISTIC"), false);
    assert.equal(requiresAi("INDEPENDENT_REVIEW"), true);
  });
});

// =====================================================================
// AC-8 — classification is deterministic, model-free and fails closed
// =====================================================================

describe("TASK-006 AC-8: provider failures are classified without asking a model", () => {
  function outcome(overrides: Partial<Parameters<typeof classifyResourceOutcome>[0]["process"]>) {
    return classifyResourceOutcome({
      process: { terminationReason: "EXITED", exitCode: 0, stdout: "", stderr: "", ...overrides },
    });
  }

  it("reads success from the process, not from the text", () => {
    assert.equal(outcome({ exitCode: 0 }).state, "AVAILABLE");
  });

  it("classifies spawn failure and timeout as provider unavailability", () => {
    assert.equal(outcome({ terminationReason: "SPAWN_ERROR", exitCode: null }).state, "PROVIDER_UNAVAILABLE");
    assert.equal(outcome({ terminationReason: "TIMEOUT", exitCode: null }).state, "PROVIDER_UNAVAILABLE");
  });

  it("does not blame the provider for our own cancellation", () => {
    assert.equal(outcome({ terminationReason: "CANCELLED", exitCode: null }).state, "UNKNOWN_FAILURE");
  });

  it("FAILS CLOSED on an unrecognised failure rather than assuming availability", () => {
    const classified = outcome({ exitCode: 1, stderr: "something nobody has seen before" });
    assert.equal(classified.state, "UNKNOWN_FAILURE");
    assert.notEqual(classified.state, "AVAILABLE");
  });

  it("does NOT classify from a provisional, unobserved signature", () => {
    // A real rate-limit response was never observed here, so the plausible
    // pattern is inert. An unclassified failure gets bounded backoff, which is
    // the right treatment for a suspected transient limit anyway.
    const classified = outcome({ exitCode: 1, stderr: "Error: rate limit exceeded, try again later" });
    assert.equal(classified.state, "UNKNOWN_FAILURE", "provisional signatures must not classify");
  });

  it("does classify from that signature once a maintainer opts in", () => {
    const classified = classifyResourceOutcome({
      process: { terminationReason: "EXITED", exitCode: 1, stdout: "", stderr: "rate limit exceeded" },
      trustProvisionalSignatures: true,
    });
    assert.equal(classified.state, "RATE_LIMITED");
  });

  it("keeps every signature honestly labelled, and every unobserved one inert", () => {
    for (const signature of FAILURE_SIGNATURES) {
      assert.ok(signature.source.length > 0, `${signature.id} must record how it is known`);
      if (signature.evidence === "PROVISIONAL") {
        assert.match(signature.source, /not observed/, `${signature.id} must say it was not observed`);
      }
    }
    // Nothing currently ships as MEASURED: no provider failure response was
    // ever observed on this machine, and the auth signatures were downgraded
    // after review because only the SIGNED-IN outputs had been seen. Auth is
    // detected structurally instead — see the probe tests below.
    const measured = FAILURE_SIGNATURES.filter((signature) => signature.evidence === "MEASURED");
    assert.deepEqual(measured, [], "a signature may only be MEASURED once its response has genuinely been observed");
  });

  it("refuses a codex effort value this build cannot vouch for", () => {
    // F-9: the accepted adapter passes any token through as a TOML override, so
    // validation happens here, before it can reach argv and be reported applied.
    const bogus = planAiRunConfig({
      provider: "codex-cli",
      model: "gpt-5.6-luna",
      effort: "not-a-real-effort",
      role: "REVIEWER",
    });
    assert.equal(bogus.ok, false);
    if (!bogus.ok) {
      assert.match(bogus.reason, /not a supported codex reasoning effort/);
    }
    for (const effort of SUPPORTED_CODEX_EFFORTS) {
      const planned = planAiRunConfig({ provider: "codex-cli", model: "gpt-5.6-luna", effort, role: "REVIEWER" });
      assert.equal(planned.ok, true, `${effort} must remain usable`);
    }
  });

  it("never invents a retry time", () => {
    assert.equal(outcome({ exitCode: 1, stderr: "failed" }).retryAt, undefined);
  });
});

describe("TASK-006: zero-token probes are parsed structurally", () => {
  it("reads codex health from the auth.credentials check", () => {
    const ok = interpretCodexDoctorJson(
      JSON.stringify({ schemaVersion: 1, overallStatus: "ok", checks: { "auth.credentials": { status: "ok" } } }),
    );
    assert.equal(ok.state, "AVAILABLE");

    const bad = interpretCodexDoctorJson(
      JSON.stringify({ schemaVersion: 1, checks: { "auth.credentials": { status: "error" } } }),
    );
    assert.equal(bad.state, "AUTH_REQUIRED");
  });

  it("reads claude auth from the loggedIn field", () => {
    assert.equal(interpretClaudeAuthStatus(JSON.stringify({ loggedIn: true })).state, "AVAILABLE");
    assert.equal(interpretClaudeAuthStatus(JSON.stringify({ loggedIn: false })).state, "AUTH_REQUIRED");
  });

  it("fails closed on malformed or unexpected probe output", () => {
    for (const raw of ["not json", "[]", "{}", JSON.stringify({ loggedIn: "yes" })]) {
      assert.equal(interpretClaudeAuthStatus(raw).state, "UNKNOWN_FAILURE", `"${raw}" must not be trusted`);
    }
    for (const raw of ["not json", "[]", "{}", JSON.stringify({ checks: {} })]) {
      assert.equal(interpretCodexDoctorJson(raw).state, "UNKNOWN_FAILURE", `"${raw}" must not be trusted`);
    }
  });
});
