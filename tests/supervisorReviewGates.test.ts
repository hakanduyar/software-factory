import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInMemorySupervisorRepository } from "../src/adapters/supervision/inMemorySupervisorRepository.js";
import { createSequentialIdGenerator } from "../src/domain/ids.js";
import { anchorFor } from "../src/supervision/provenanceChain.js";
import { DEFAULT_ROUTING_POLICY } from "../src/supervision/modelRouting.js";
import { SupervisorService } from "../src/supervision/supervisorService.js";
import type { ReviewRequest, RoadmapItem, SupervisorState } from "../src/supervision/supervisorTypes.js";
import type { Classification } from "../src/supervision/resourceClassifier.js";
import { scriptedProbe, TEST_CATALOG } from "./support/supervisorFixtures.js";

const NOW = 10_000;
const item: RoadmapItem = {
  key: "A", title: "Review target", dependsOn: [], status: "ACTIVE",
  workClass: "NORMAL_IMPLEMENTATION", order: 1,
};
const request: ReviewRequest = {
  roadmapKey: "A", attempt: 1, requestedAt: NOW,
  provider: "codex-cli", model: "gpt-5.6-luna", effort: "xhigh",
  candidate: { commit: "abc1234", tree: "def5678", fingerprint: "0123456789ab" },
};

async function scenario(options: {
  classification?: Classification;
  request?: Partial<ReviewRequest>;
  item?: RoadmapItem;
  resource?: SupervisorState["resources"][number];
} = {}) {
  const repository = createInMemorySupervisorRepository();
  const selected = options.item ?? item;
  await repository.create({
    version: 1,
    financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
    resources: options.resource === undefined ? [] : [options.resource],
    roadmap: [selected], checkpoints: [], escalations: [],
    provenance: [], provenanceAnchor: anchorFor([]),
    reviewRequests: [{ ...request, ...options.request }],
    updatedAt: NOW,
  });
  const probe = scriptedProbe();
  if (options.classification !== undefined) probe.set("codex-cli", "gpt-5.6-luna", options.classification);
  let launches = 0;
  const service = new SupervisorService({
    repository, probe, executor: { execute: async () => ({ kind: "COMPLETED", detail: "unused" }) },
    clock: { now: () => NOW }, ids: createSequentialIdGenerator(),
    routingPolicy: DEFAULT_ROUTING_POLICY, resourceCatalog: TEST_CATALOG,
    roadmapCatalog: [item],
    liveness: { check: () => "ALIVE" },
    activityLease: (at) => ({ pid: 12345, processStartedAt: 100, machine: "test", boot: "test", claimedAt: at }),
    reviewLauncher: {
      async launch() { launches += 1; return { ok: true, detail: "stub only" }; },
      acknowledgement() { return undefined; },
      // Nothing has finished in these gate scenarios, and a stub that claimed
      // otherwise would model a world that cannot exist.
      completion() { return { kind: "NONE" }; },
    },
  });
  const result = await service.tick();
  const state = await repository.load();
  assert.ok(state);
  return { result, state, probes: probe.totalProbes(), launches };
}

describe("SF-R2 review launch safety", () => {
  it("launches a qualified subscription reviewer only after a fresh probe and durable claim", async () => {
    const run = await scenario();
    assert.equal(run.launches, 1);
    assert.ok(run.probes >= 1);
    assert.equal(run.state.activities?.find((activity) => activity.review !== undefined)?.state, "CLAIMED");
    assert.equal(run.state.resources.find((resource) => resource.key === "codex-cli:gpt-5.6-luna")?.observedBillingMode, "INCLUDED_SUBSCRIPTION");
  });

  it("refuses metered billing before any review record or launch", async () => {
    const run = await scenario({ classification: {
      state: "AVAILABLE", reason: "metered", billingMode: "USAGE_BILLED",
    } });
    assert.equal(run.launches, 0);
    assert.equal(run.state.activities?.some((activity) => activity.review !== undefined) ?? false, false);
    assert.ok(run.state.escalations.some((entry) => entry.reason === "FINANCIAL_ACTION_REQUIRED"));
  });

  it("requires a human for missing credentials before launch", async () => {
    const run = await scenario({ classification: { state: "AUTH_REQUIRED", reason: "login needed" } });
    assert.equal(run.launches, 0);
    assert.equal(run.state.resources.find((resource) => resource.key === "codex-cli:gpt-5.6-luna")?.state, "AUTH_REQUIRED");
    assert.ok(run.state.escalations.some((entry) => entry.reason === "HUMAN_CREDENTIAL_REQUIRED"));
  });

  it("honors durable quota backoff without probing or launching early", async () => {
    const run = await scenario({ resource: {
      provider: "codex-cli", model: "gpt-5.6-luna", key: "codex-cli:gpt-5.6-luna",
      state: "USAGE_LIMIT_REACHED", detectedAt: NOW - 1_000, lastCheckedAt: NOW - 1_000,
      retryAt: NOW + 300_000, backoff: { attempt: 1, delayMs: 300_000 },
      diagnostic: "quota reached",
    } });
    assert.equal(run.launches, 0);
    assert.equal(run.probes, 0);
    assert.equal(run.state.roadmap[0]?.status, "WAITING_FOR_RESOURCE");
  });

  it("rejects an unqualified effort before a probe or review record", async () => {
    const run = await scenario({ request: { effort: "low" } });
    assert.equal(run.launches, 0);
    assert.equal(run.probes, 0);
    assert.equal(run.state.activities?.some((activity) => activity.review !== undefined) ?? false, false);
  });

  it("rejects a resource that implemented the candidate", async () => {
    const run = await scenario({ item: { ...item, implementedByResourceKey: "codex-cli:gpt-5.6-luna" } });
    assert.equal(run.launches, 0);
    assert.equal(run.probes, 0);
    assert.equal(run.state.activities?.some((activity) => activity.review !== undefined) ?? false, false);
  });

  it("does not bypass an existing human restriction", async () => {
    const run = await scenario({ item: { ...item, status: "WAITING_FOR_HUMAN_REQUIRED", humanActionRequired: "Approve the plan" } });
    assert.equal(run.launches, 0);
    assert.equal(run.probes, 0);
    assert.equal(run.state.roadmap[0]?.status, "WAITING_FOR_HUMAN_REQUIRED");
  });

  it("records a controlled refusal for a malformed resource identity", async () => {
    const run = await scenario({ request: { provider: "codex:rogue" } });
    assert.equal(run.launches, 0);
    assert.equal(run.probes, 0);
    assert.ok(run.state.escalations.some((entry) => entry.reason === "RECOVERY_REQUIRED"));
  });
});
