/**
 * TASK-009 — durable blocker recording.
 *
 * The gap this closes was found in operation, not in review: `LOCAL_24_7_RUNTIME`
 * was correctly fail-closed in durable state, but the recorded REASON said it
 * needed an approved plan long after the plan existed. The true blocker — a
 * platform classifier refusing agent-written systemd persistence code — lived
 * only in a chat transcript.
 *
 * That is precisely the failure TASK-006 exists to eliminate. Durable state that
 * says the wrong thing about why work stopped is worse than durable state that
 * says nothing, because an operator will believe it.
 *
 * Offline: no provider, no model, no money.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { ESCALATION_REASONS, type RoadmapItem } from "../src/supervision/supervisorTypes.js";
import {
  encodeSupervisorState,
  parseSupervisorState,
} from "../src/supervision/supervisorSerialization.js";
import { cleanupTempDbs } from "./support/factoryFixtures.js";
import { parseBlockArgs } from "../src/cli/main.js";
import { newSupervisor, scriptedProbe, seedRoadmap, TEST_CATALOG } from "./support/supervisorFixtures.js";

after(cleanupTempDbs);

function healthyProbe() {
  const probe = scriptedProbe();
  for (const entry of TEST_CATALOG) {
    probe.set(entry.provider, entry.model, {
      state: "AVAILABLE",
      reason: "scripted",
      billingMode: "INCLUDED_SUBSCRIPTION",
    });
  }
  return probe;
}

const TWO_ITEMS: readonly RoadmapItem[] = [
  { key: "BLOCKED_ONE", title: "Needs a platform boundary lifted", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
  { key: "OTHER", title: "Ordinary work", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 2 },
];

describe("TASK-009 AC-1/AC-2: a blocker is durable and does not stop other work", () => {
  it("records the blocker and leaves the item unselectable", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    await seedRoadmap(supervisor, TWO_ITEMS);

    const result = await supervisor.service.recordBlocker({
      roadmapKey: "BLOCKED_ONE",
      reason: "PLATFORM_CAPABILITY_BLOCKED",
      humanActionRequired: "Lift the classifier restriction on systemd unit generation",
      detail: "spec docs/tasks/TASK-007-local-24-7-runtime.md, branch feat/local-24-7-runtime, commit 9d8417e",
    });
    assert.equal(result.ok, true);

    const state = await supervisor.repository.load();
    const item = state?.roadmap.find((entry) => entry.key === "BLOCKED_ONE");
    assert.equal(item?.status, "WAITING_FOR_HUMAN_REQUIRED", "the item must be fail-closed");
    assert.match(item?.humanActionRequired ?? "", /classifier/);

    const escalation = state?.escalations.find((entry) => entry.roadmapKey === "BLOCKED_ONE");
    assert.ok(escalation !== undefined, "a durable escalation was recorded");
    assert.equal(escalation.reason, "PLATFORM_CAPABILITY_BLOCKED");
    assert.match(escalation.detail, /9d8417e/, "enough information to resume without a conversation");
  });

  it("lets the supervisor continue with other eligible work", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    await seedRoadmap(supervisor, TWO_ITEMS);
    await supervisor.service.recordBlocker({
      roadmapKey: "BLOCKED_ONE",
      reason: "PLATFORM_CAPABILITY_BLOCKED",
      humanActionRequired: "lift it",
      detail: "d",
    });

    const tick = await supervisor.service.tick();

    assert.equal(tick.kind, "ADVANCED", "a blocked item must not stall the whole queue");
    if (tick.kind === "ADVANCED") {
      assert.equal(tick.roadmapKey, "OTHER");
    }
    for (const call of supervisor.executor.calls()) {
      assert.notEqual(call.item.key, "BLOCKED_ONE");
    }
  });
});

describe("TASK-009 AC-3: an unknown roadmap key is refused", () => {
  it("never invents an item", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    await seedRoadmap(supervisor, TWO_ITEMS);

    const result = await supervisor.service.recordBlocker({
      roadmapKey: "TYPO_KEY",
      reason: "PLATFORM_CAPABILITY_BLOCKED",
      humanActionRequired: "x",
      detail: "y",
    });

    assert.equal(result.ok, false);
    const state = await supervisor.repository.load();
    assert.equal(state?.roadmap.length, 2, "no ghost item was created");
    assert.equal(state?.escalations.length, 0);
  });
});

describe("TASK-009 AC-4: blocker text is bounded and redacted", () => {
  const LEAK = "sk-ant-api03-MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM";

  it("refuses to persist a credential smuggled through --detail", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    await seedRoadmap(supervisor, TWO_ITEMS);

    await supervisor.service.recordBlocker({
      roadmapKey: "BLOCKED_ONE",
      reason: "PLATFORM_CAPABILITY_BLOCKED",
      humanActionRequired: `use ${LEAK} to unblock`,
      detail: `token was ${LEAK}`,
    });

    const state = await supervisor.repository.load();
    const serialized = JSON.stringify(state);
    assert.ok(!serialized.includes(LEAK), "a credential reached durable state through a blocker");
    assert.ok(!serialized.includes("sk-ant-"), "nor any part of one");
  });

  it("bounds an absurdly long detail", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    await seedRoadmap(supervisor, TWO_ITEMS);

    await supervisor.service.recordBlocker({
      roadmapKey: "BLOCKED_ONE",
      reason: "PLATFORM_CAPABILITY_BLOCKED",
      humanActionRequired: "x",
      detail: "D".repeat(100_000),
    });

    const state = await supervisor.repository.load();
    const escalation = state?.escalations.find((entry) => entry.roadmapKey === "BLOCKED_ONE");
    assert.ok((escalation?.detail.length ?? 0) < 2_000, `detail was ${escalation?.detail.length} chars`);
  });
});

describe("TASK-009 AC-5: blocking supersedes rather than accumulating", () => {
  /**
   * This was a latent TASK-006 defect, not merely a TASK-009 requirement:
   * `escalate` appended unconditionally, so an item that escalates on every tick
   * — which is exactly what a permanently blocked item does — grew the
   * escalations array forever.
   */
  it("keeps exactly one open escalation per item across repeated blocks", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    await seedRoadmap(supervisor, TWO_ITEMS);

    for (let i = 0; i < 5; i += 1) {
      await supervisor.service.recordBlocker({
        roadmapKey: "BLOCKED_ONE",
        reason: "PLATFORM_CAPABILITY_BLOCKED",
        humanActionRequired: `attempt ${i}`,
        detail: `detail ${i}`,
      });
    }

    const state = await supervisor.repository.load();
    const open = (state?.escalations ?? []).filter((entry) => entry.roadmapKey === "BLOCKED_ONE");
    assert.equal(open.length, 1, `accumulated ${open.length} escalations`);
    assert.match(open[0]!.humanActionRequired, /attempt 4/, "the newest statement of the condition wins");
  });

  it("does not accumulate across repeated ticks of a permanently blocked queue", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    await seedRoadmap(supervisor, [
      // Deterministic work with no declared actions escalates every time.
      { key: "ALWAYS", title: "Undeclared", dependsOn: [], status: "PENDING", workClass: "DETERMINISTIC", order: 1 },
    ]);

    for (let i = 0; i < 4; i += 1) {
      await supervisor.service.tick();
    }

    const state = await supervisor.repository.load();
    assert.ok(
      (state?.escalations.length ?? 0) <= 1,
      `escalations grew to ${state?.escalations.length} across four ticks`,
    );
  });
});

describe("TASK-009 AC-7: the command can only ever restrict", () => {
  it("cannot mark an item DONE or clear an existing blocker", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    await seedRoadmap(supervisor, TWO_ITEMS);
    await supervisor.service.recordBlocker({
      roadmapKey: "BLOCKED_ONE",
      reason: "PLATFORM_CAPABILITY_BLOCKED",
      humanActionRequired: "lift it",
      detail: "d",
    });

    // Every reason routes to a fail-closed status; none of them frees an item.
    for (const reason of ESCALATION_REASONS) {
      await supervisor.service.recordBlocker({
        roadmapKey: "BLOCKED_ONE",
        reason,
        humanActionRequired: "still blocked",
        detail: "d",
      });
      const state = await supervisor.repository.load();
      const item = state?.roadmap.find((entry) => entry.key === "BLOCKED_ONE");
      assert.notEqual(item?.status, "DONE", `${reason} marked an item DONE`);
      assert.notEqual(item?.status, "ELIGIBLE", `${reason} freed a blocked item`);
    }
  });

  it("does not touch the financial policy", async () => {
    const supervisor = newSupervisor({ probe: healthyProbe() });
    await seedRoadmap(supervisor, TWO_ITEMS);
    const before = JSON.stringify((await supervisor.repository.load())?.financialPolicy);

    await supervisor.service.recordBlocker({
      roadmapKey: "BLOCKED_ONE",
      reason: "PLATFORM_CAPABILITY_BLOCKED",
      humanActionRequired: "x",
      detail: "y",
    });

    const after = JSON.stringify((await supervisor.repository.load())?.financialPolicy);
    assert.equal(after, before);
  });
});

describe("TASK-009 AC-8: the new reason round-trips and unknown reasons fail", () => {
  it("survives encode -> parse", () => {
    const state = {
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [],
      roadmap: [
        { key: "A", title: "t", dependsOn: [], status: "WAITING_FOR_HUMAN_REQUIRED", workClass: "DETERMINISTIC", order: 1, humanActionRequired: "lift it" },
      ],
      checkpoints: [],
      escalations: [
        {
          roadmapKey: "A",
          reason: "PLATFORM_CAPABILITY_BLOCKED",
          humanActionRequired: "lift it",
          detail: "branch feat/local-24-7-runtime commit 9d8417e",
          raisedAt: 1,
          resolved: false,
        },
      ],
      updatedAt: 1,
    };
    const parsed = parseSupervisorState(encodeSupervisorState(state as never), { version: 1 });
    assert.equal(parsed.escalations[0]?.reason, "PLATFORM_CAPABILITY_BLOCKED");
    assert.match(parsed.escalations[0]?.detail ?? "", /9d8417e/);
  });

  it("rejects an unrecognised reason", () => {
    const bad = {
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [],
      roadmap: [],
      checkpoints: [],
      escalations: [
        { roadmapKey: "A", reason: "TOTALLY_FINE", humanActionRequired: "x", detail: "y", raisedAt: 1, resolved: false },
      ],
      updatedAt: 1,
    };
    assert.throws(() => parseSupervisorState(JSON.stringify(bad), { version: 1 }));
  });
});

/**
 * The DOCUMENTED command line, which did not work.
 *
 * TASK-009 documents `sf supervise block <KEY> --reason <REASON> --detail <TEXT>`
 * and AC-4 names `--detail` by flag, but the dispatcher read positionally. So the
 * command a human copies out of the task file put `--reason` in the reason slot
 * and died with `unknown reason "--reason"`, having recorded nothing — and the
 * positional form silently defaulted `detail` to `""`, which then failed deep in
 * the durable-state validator with `field "detail" must be a non-empty string`.
 * An operator saw an internal complaint about a record they never knowingly
 * built.
 *
 * The independent reviewer found the first half; the empty-detail half turned up
 * on the way to reproducing it.
 */
describe("TASK-009: the documented `supervise block` command line", () => {
  it("accepts the documented flag form", () => {
    const parsed = parseBlockArgs([
      "LOCAL_24_7_RUNTIME",
      "--reason",
      "PLATFORM_CAPABILITY_BLOCKED",
      "--detail",
      "systemd unit generation refused by the platform safety classifier",
    ]);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.roadmapKey, "LOCAL_24_7_RUNTIME");
    assert.equal(parsed.value.reason, "PLATFORM_CAPABILITY_BLOCKED");
    assert.match(parsed.value.detail, /systemd unit generation refused/);
    // AC-1 requires an action to be recorded even though the documented line
    // carries no `--action`: a fixed per-reason default, not invented prose.
    assert.match(parsed.value.humanActionRequired, /refuses to do it/);
  });

  it("still accepts the older positional form", () => {
    const parsed = parseBlockArgs(["KEY", "AUTH_REQUIRED", "do the thing", "because"]);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.humanActionRequired, "do the thing");
    assert.equal(parsed.value.detail, "because");
  });

  it("lets an explicit --action override the per-reason default", () => {
    const parsed = parseBlockArgs(["KEY", "--reason", "AUTH_REQUIRED", "--detail", "d", "--action", "specific"]);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.humanActionRequired, "specific");
  });

  it("REFUSES a missing or blank detail, naming the flag rather than the validator", () => {
    for (const args of [
      ["KEY", "--reason", "AUTH_REQUIRED"],
      ["KEY", "--reason", "AUTH_REQUIRED", "--detail", "   "],
    ]) {
      const parsed = parseBlockArgs(args);
      assert.equal(parsed.ok, false, `expected refusal for ${JSON.stringify(args)}`);
      if (parsed.ok) return;
      assert.match(parsed.error, /detail is required \(--detail\)/);
    }
  });

  it("REFUSES an unknown option and a flag with no value", () => {
    const unknown = parseBlockArgs(["KEY", "--bogus", "x"]);
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.match(unknown.error, /unknown option "--bogus"/);

    const dangling = parseBlockArgs(["KEY", "--reason", "--detail", "d"]);
    assert.equal(dangling.ok, false);
    if (!dangling.ok) assert.match(dangling.error, /requires a value/);
  });

  it("REFUSES a missing roadmap key", () => {
    const parsed = parseBlockArgs(["--reason", "AUTH_REQUIRED", "--detail", "d"]);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.error, /roadmap key is required/);
  });

  /**
   * Every reason must have a default action, or the documented flag form breaks
   * for that reason alone — the sort of gap that only shows up in the one live
   * run that happens to use it.
   */
  it("has a default human action for EVERY escalation reason", () => {
    for (const reason of ESCALATION_REASONS) {
      const parsed = parseBlockArgs(["KEY", "--reason", reason, "--detail", "d"]);
      assert.equal(parsed.ok, true, `no default action for ${reason}`);
      if (!parsed.ok) continue;
      assert.ok(parsed.value.humanActionRequired.trim().length > 0, `empty default action for ${reason}`);
    }
  });
});
