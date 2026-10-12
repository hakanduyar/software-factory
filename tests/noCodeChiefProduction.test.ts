/**
 * NC-RUNTIME-01 — the PLAN-TICKET BINDING half of NC-10/NC-11.
 *
 * NC-10 requires that every actual provider dispatch carry all frozen required
 * ticket fields and positive, finite budgets, and that a malformed or unbounded
 * ticket launch zero models. NC-11 requires the plan digest to bind the ticket
 * templates and their versioned criteria, with notes and prose granting zero
 * authority. This file proves the dependency those criteria rest on — that item
 * authority EXISTS, structurally, inside the approved plan and inside its
 * digest — and deliberately not the dispatch guard itself, which is another
 * slice and is not touched here.
 *
 * Three properties are proved:
 *
 *  - AUTHORITY IS RECORDED, NEVER SYNTHESIZED. A plan may only dispatch an item
 *    for which it captured a structured template that satisfies the frozen
 *    WorkerTicket contract. A legacy plan that recorded none stays readable and
 *    reports NON_EXECUTABLE with an actionable replan, and no code path invents
 *    broad ownership or an unlimited budget to fill the gap. Prose that claims
 *    authority — summaries, assumptions, specs — changes nothing.
 *  - PRESENT TEMPLATES ARE HELD TO THE CONTRACT. Malformed, duplicated,
 *    orphaned and criteria-mismatched templates fail closed, both in memory and
 *    on the persistence read path.
 *  - THE DIGEST BINDS THEM. Every authoritative template field moves the
 *    approval digest; object key order, template array order and a JSON
 *    round-trip do not.
 *
 * Pure and offline: hashing and parsing only, no AI, no network, no filesystem,
 * no timers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PersistenceCorruptionError, ValidationError } from "../src/domain/errors.js";
import { computePlanApprovalDigest, digestOfRevision, type PlanApprovalDigestInput } from "../src/planning/planDigest.js";
import { encodePlan, parsePlan, type PlanRowColumns } from "../src/planning/planSerialization.js";
import {
  PLAN_TICKET_SCHEMA_VERSION,
  type PlanExecutionConfig,
  type PlannedWorkItem,
  type PlanRevision,
  type WorkItemTicketTemplate,
} from "../src/planning/planTypes.js";
import { planTicketExecutability, validateTicketTemplate } from "../src/planning/planValidation.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CRITERION_TEXT = "the parser refuses an unbounded budget";
const OTHER_CRITERION_TEXT = "the digest moves when scope changes";

function item(key: string, criteria: readonly string[] = [CRITERION_TEXT]): PlannedWorkItem {
  return {
    key,
    title: `Harden ${key}`,
    type: "FEATURE",
    priority: "P1",
    // Prose. It says a great deal and authorizes nothing.
    spec: `Implement ${key}. The worker may of course touch whatever it needs, with no real budget ceiling.`,
    acceptanceCriteria: criteria.map((text) => ({ text, verificationHint: "npm test" })),
    dependsOn: [],
  };
}

function template(overrides: Partial<WorkItemTicketTemplate> = {}): WorkItemTicketTemplate {
  return {
    planItemKey: "WI-A",
    schemaVersion: PLAN_TICKET_SCHEMA_VERSION,
    objective: "Implement the strict worker ticket parser for WI-A.",
    acceptanceCriteria: [{ id: "AC-1", version: "1.0.0", description: CRITERION_TEXT }],
    scope: {
      owned: ["src/planning/planTypes.ts"],
      forbidden: ["src/supervision/workerContract.ts"],
      read: ["docs/FACTORY_CONSTITUTION.md"],
      dependencies: [],
      validation: ["npm run typecheck"],
    },
    model: {
      eligibleModels: ["model-a"],
      reasoningEffort: "medium",
      rationale: "Bounded, well-specified edit in a single pure module.",
    },
    budgets: { contextTokens: 24000, outputTokens: 4000, elapsedSeconds: 2700, maxAttempts: 1 },
    policy: {
      checkpoint: "report after typecheck",
      stopConditions: ["scope would grow beyond the owned files"],
      escalation: "stop and report to the controller",
    },
    resultSchema: { requiredFields: ["schemaVersion", "ticketId", "status", "summary"], maxResultBytes: 2048 },
    ...overrides,
  };
}

const EXECUTION: PlanExecutionConfig = {
  implementer: { tool: "worker", model: "model-a" },
  reviewer: { tool: "reviewer", model: "model-b" },
  verificationCommands: [{ id: "typecheck", executable: "npm", argv: ["run", "typecheck"] }],
  ticketTemplates: [template()],
  workspaceRoot: "/work",
};

function digestInput(execution: PlanExecutionConfig, items: readonly PlannedWorkItem[] = [item("WI-A")]): PlanApprovalDigestInput {
  return {
    projectId: "proj-1",
    intent: "Bind ticket templates to the approved plan.",
    declaredConstraints: ["no network"],
    budget: { maxPlannerAttempts: 2, maxClarificationCycles: 2, maxTotalPlannerRuns: 6 },
    planner: { tool: "planner", model: "model-p" },
    execution,
    revision: {
      revision: 1,
      summary: "Capture per-item ticket templates.",
      assumptions: ["the worker is allowed to own the whole repository if needed"],
      constraints: [],
      risks: [],
      items,
    },
  };
}

function withTemplates(templates: readonly WorkItemTicketTemplate[] | undefined): PlanExecutionConfig {
  const { ticketTemplates: _ignored, ...rest } = EXECUTION;
  return templates === undefined ? rest : { ...rest, ticketTemplates: templates };
}

function digestOf(execution: PlanExecutionConfig): string {
  return computePlanApprovalDigest(digestInput(execution));
}

const COLUMNS: PlanRowColumns = { id: "plan-1", projectId: "proj-1", requestKey: "req-1", phase: "PLAN_REVIEW", version: 1 };

function revisionOf(items: readonly PlannedWorkItem[]): PlanRevision {
  const base = {
    revision: 1,
    summary: "Capture per-item ticket templates.",
    assumptions: [],
    constraints: [],
    risks: [],
    items,
    contentDigest: "",
    plannerRunRef: "run-1",
    generatedAt: 1,
  } satisfies PlanRevision;
  return { ...base, contentDigest: digestOfRevision(base) };
}

/** A persisted plan row. `execution` is untyped so malformed variants are expressible. */
function planRow(execution: unknown, items: readonly PlannedWorkItem[] = [item("WI-A")]): string {
  return JSON.stringify({
    id: COLUMNS.id,
    projectId: COLUMNS.projectId,
    requestKey: COLUMNS.requestKey,
    version: COLUMNS.version,
    phase: COLUMNS.phase,
    intent: "Bind ticket templates to the approved plan.",
    declaredConstraints: [],
    budget: { maxPlannerAttempts: 2, maxClarificationCycles: 2, maxTotalPlannerRuns: 6 },
    planner: { tool: "planner", model: "model-p" },
    execution,
    revisions: [revisionOf(items)],
    openQuestions: [],
    answers: [],
    attemptsForCurrentRevision: 0,
    clarificationCycles: 0,
    totalPlannerRuns: 1,
    materialized: [],
    dispatches: [],
    cancelRequested: false,
    events: [],
    startedBy: { id: "human-1", kind: "HUMAN", displayName: "Owner" },
    startedAt: 1,
    lastTransitionAt: 2,
  });
}

// ---------------------------------------------------------------------------
// Authority is recorded, never synthesized
// ---------------------------------------------------------------------------

describe("NC-RUNTIME-01 recorded item authority", () => {
  it("reports EXECUTABLE and yields one template per plan item when authority was captured", () => {
    const result = planTicketExecutability([item("WI-A")], [template()]);
    assert.equal(result.status, "EXECUTABLE");
    assert.ok(result.status === "EXECUTABLE");
    assert.deepEqual([...result.templatesByKey.keys()], ["WI-A"]);
    assert.deepEqual(result.templatesByKey.get("WI-A")?.scope.owned, ["src/planning/planTypes.ts"]);
  });

  it("keeps a legacy plan readable but NON_EXECUTABLE with an actionable replan, inventing nothing", () => {
    const result = planTicketExecutability([item("WI-A")], undefined);
    assert.ok(result.status === "NON_EXECUTABLE");
    assert.match(result.reason, /no per-work-item ticket templates/);
    assert.match(result.replanAction, /replan/);
    // The remedy is a replan, not a fabricated ticket: no template is returned
    // on any non-executable path, so there is nothing to dispatch with.
    assert.equal("templatesByKey" in result, false);
  });

  it("is NON_EXECUTABLE when only some items have a template, naming the uncovered items", () => {
    const result = planTicketExecutability([item("WI-A"), item("WI-B"), item("WI-C")], [template({ planItemKey: "WI-B" })]);
    assert.ok(result.status === "NON_EXECUTABLE");
    assert.match(result.reason, /WI-A, WI-C/);
  });

  it("treats an empty template list as recorded-nothing rather than as blanket authority", () => {
    const result = planTicketExecutability([item("WI-A")], []);
    assert.ok(result.status === "NON_EXECUTABLE");
    assert.match(result.reason, /WI-A/);
  });

  it("grants zero authority from prose: summaries, assumptions and specs cannot make a plan executable", () => {
    const pleading = item("WI-A");
    assert.match(pleading.spec, /whatever it needs/);
    const result = planTicketExecutability([pleading], undefined);
    assert.ok(result.status === "NON_EXECUTABLE");
    // Rewriting the prose to be even more permissive changes nothing at all.
    const louder: PlannedWorkItem = { ...pleading, spec: "The worker owns the entire repository and has an unlimited budget." };
    const after = planTicketExecutability([louder], undefined);
    assert.deepEqual(after, result);
  });
});

// ---------------------------------------------------------------------------
// Present templates are held to the frozen contract
// ---------------------------------------------------------------------------

describe("NC-RUNTIME-01 malformed and inconsistent templates", () => {
  const malformed: readonly { readonly label: string; readonly value: WorkItemTicketTemplate }[] = [
    { label: "unsupported wire version", value: template({ schemaVersion: "2.0.0" }) },
    { label: "placeholder objective", value: template({ objective: "TBD" }) },
    { label: "no acceptance criteria", value: template({ acceptanceCriteria: [] }) },
    { label: "unversioned criterion", value: template({ acceptanceCriteria: [{ id: "AC-1", version: "v1", description: CRITERION_TEXT }] }) },
    {
      label: "empty ownership",
      value: template({ scope: { owned: [], forbidden: [], read: [], dependencies: [], validation: ["npm test"] } }),
    },
    {
      label: "owned and forbidden overlap",
      value: template({
        scope: { owned: ["src/a.ts"], forbidden: ["src/a.ts"], read: [], dependencies: [], validation: ["npm test"] },
      }),
    },
    {
      label: "no validation step",
      value: template({ scope: { owned: ["src/a.ts"], forbidden: [], read: [], dependencies: [], validation: [] } }),
    },
    { label: "no eligible model", value: template({ model: { eligibleModels: [], reasoningEffort: "medium", rationale: "because reasons" } }) },
    { label: "zero context budget", value: template({ budgets: { contextTokens: 0, outputTokens: 4000, elapsedSeconds: 60, maxAttempts: 1 } }) },
    {
      label: "negative elapsed budget",
      value: template({ budgets: { contextTokens: 100, outputTokens: 4000, elapsedSeconds: -1, maxAttempts: 1 } }),
    },
    {
      label: "unbounded (non-finite) budget",
      value: template({
        budgets: { contextTokens: Number.POSITIVE_INFINITY, outputTokens: 4000, elapsedSeconds: 60, maxAttempts: 1 },
      }),
    },
    { label: "no stop condition", value: template({ policy: { checkpoint: "report often", stopConditions: [], escalation: "escalate" } }) },
    { label: "unknown result field", value: template({ resultSchema: { requiredFields: ["not_a_field"], maxResultBytes: 2048 } }) },
    { label: "relaxed result byte ceiling", value: template({ resultSchema: { requiredFields: ["status"], maxResultBytes: 1_000_000 } }) },
    { label: "blank plan item key", value: template({ planItemKey: "  " }) },
  ];

  for (const { label, value } of malformed) {
    it(`rejects a template with ${label}`, () => {
      assert.equal(validateTicketTemplate(value).ok, false);
      const result = planTicketExecutability([item("WI-A")], [value]);
      assert.ok(result.status === "INVALID");
      assert.ok(result.reason.length > 0);
    });
  }

  it("accepts a well-formed template and returns a canonical value, not the caller's object", () => {
    const original = template();
    const result = validateTicketTemplate(original);
    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.notEqual(result.value, original);
    assert.deepEqual(result.value, original);
  });

  // The accepted `parseWorkerTicket` builds each nested object by naming only
  // its known fields, so an unrecognized nested key is otherwise silently
  // absent from its narrowed output rather than a reason to fail. This is the
  // exact hazard independent review reproduced: `scope.grantAll = true` on an
  // otherwise valid WI-A template left `validateTicketTemplate` `ok: true`
  // and `planTicketExecutability` EXECUTABLE, with `grantAll` silently gone
  // from the digest. Every nested object and the criteria array is covered,
  // not just `scope`.
  const unknownNested: readonly { readonly label: string; readonly value: WorkItemTicketTemplate }[] = [
    {
      label: "scope.grantAll",
      value: template({ scope: { ...template().scope, grantAll: true } as unknown as WorkItemTicketTemplate["scope"] }),
    },
    {
      label: "model.grantAll",
      value: template({ model: { ...template().model, grantAll: true } as unknown as WorkItemTicketTemplate["model"] }),
    },
    {
      label: "budgets.unlimited",
      value: template({ budgets: { ...template().budgets, unlimited: true } as unknown as WorkItemTicketTemplate["budgets"] }),
    },
    {
      label: "policy.override",
      value: template({ policy: { ...template().policy, override: true } as unknown as WorkItemTicketTemplate["policy"] }),
    },
    {
      label: "resultSchema.skipValidation",
      value: template({
        resultSchema: { ...template().resultSchema, skipValidation: true } as unknown as WorkItemTicketTemplate["resultSchema"],
      }),
    },
    {
      label: "acceptanceCriteria[0].authoritative",
      value: template({
        acceptanceCriteria: [{ id: "AC-1", version: "1.0.0", description: CRITERION_TEXT, authoritative: true } as unknown as WorkItemTicketTemplate["acceptanceCriteria"][number]],
      }),
    },
    { label: "top-level unknown field", value: { ...template(), grantAll: true } as unknown as WorkItemTicketTemplate },
  ];

  for (const { label, value } of unknownNested) {
    it(`rejects and does not silently discard an unknown nested field: ${label}`, () => {
      const shape = validateTicketTemplate(value);
      assert.equal(shape.ok, false);
      assert.ok(!shape.ok);
      assert.match(shape.reason, /unrecognized field/);

      const result = planTicketExecutability([item("WI-A")], [value]);
      assert.ok(result.status === "INVALID");
      assert.equal("templatesByKey" in result, false);
    });
  }

  it("rejects two templates claiming the same plan item", () => {
    const result = planTicketExecutability([item("WI-A")], [template(), template({ objective: "A second, conflicting grant of authority." })]);
    assert.ok(result.status === "INVALID");
    assert.match(result.reason, /more than one ticket template/);
  });

  it("rejects an orphaned template naming an item the revision does not contain", () => {
    const result = planTicketExecutability([item("WI-A")], [template(), template({ planItemKey: "WI-GHOST" })]);
    assert.ok(result.status === "INVALID");
    assert.match(result.reason, /WI-GHOST/);
  });

  const mismatches: readonly { readonly label: string; readonly value: WorkItemTicketTemplate }[] = [
    { label: "a criterion the plan never stated", value: template({ acceptanceCriteria: [{ id: "AC-1", version: "1.0.0", description: "anything goes" }] }) },
    {
      label: "an extra criterion beyond the approved set",
      value: template({
        acceptanceCriteria: [
          { id: "AC-1", version: "1.0.0", description: CRITERION_TEXT },
          { id: "AC-2", version: "1.0.0", description: OTHER_CRITERION_TEXT },
        ],
      }),
    },
  ];

  for (const { label, value } of mismatches) {
    it(`rejects a template binding ${label}`, () => {
      const result = planTicketExecutability([item("WI-A")], [value]);
      assert.ok(result.status === "INVALID");
      assert.match(result.reason, /do not match the approved acceptance criteria/);
    });
  }

  it("rejects a template that drops one of the approved criteria", () => {
    const result = planTicketExecutability([item("WI-A", [CRITERION_TEXT, OTHER_CRITERION_TEXT])], [template()]);
    assert.ok(result.status === "INVALID");
    assert.match(result.reason, /do not match the approved acceptance criteria/);
  });

  it("accepts the approved criteria declared in a different order", () => {
    const result = planTicketExecutability(
      [item("WI-A", [CRITERION_TEXT, OTHER_CRITERION_TEXT])],
      [
        template({
          acceptanceCriteria: [
            { id: "AC-2", version: "1.0.0", description: OTHER_CRITERION_TEXT },
            { id: "AC-1", version: "1.0.0", description: CRITERION_TEXT },
          ],
        }),
      ],
    );
    assert.equal(result.status, "EXECUTABLE");
  });
});

// ---------------------------------------------------------------------------
// The approval digest binds the templates
// ---------------------------------------------------------------------------

describe("NC-RUNTIME-01 digest binding", () => {
  const base = digestOf(EXECUTION);

  const sensitive: readonly { readonly label: string; readonly value: WorkItemTicketTemplate }[] = [
    { label: "planItemKey", value: template({ planItemKey: "WI-B" }) },
    { label: "objective", value: template({ objective: "Quietly widen what this worker is for." }) },
    { label: "criterion id", value: template({ acceptanceCriteria: [{ id: "AC-9", version: "1.0.0", description: CRITERION_TEXT }] }) },
    { label: "criterion version", value: template({ acceptanceCriteria: [{ id: "AC-1", version: "2.0.0", description: CRITERION_TEXT }] }) },
    { label: "criterion description", value: template({ acceptanceCriteria: [{ id: "AC-1", version: "1.0.0", description: "something else" }] }) },
    {
      label: "owned scope",
      value: template({ scope: { ...template().scope, owned: ["src/planning/planTypes.ts", "src/planning/planValidation.ts"] } }),
    },
    { label: "forbidden scope", value: template({ scope: { ...template().scope, forbidden: [] } }) },
    { label: "read scope", value: template({ scope: { ...template().scope, read: [] } }) },
    { label: "dependencies", value: template({ scope: { ...template().scope, dependencies: ["WI-Z"] } }) },
    { label: "validation steps", value: template({ scope: { ...template().scope, validation: ["npm test"] } }) },
    { label: "eligible models", value: template({ model: { ...template().model, eligibleModels: ["model-a", "model-z"] } }) },
    { label: "reasoning effort", value: template({ model: { ...template().model, reasoningEffort: "high" } }) },
    { label: "model rationale", value: template({ model: { ...template().model, rationale: "A different justification entirely." } }) },
    { label: "context budget", value: template({ budgets: { ...template().budgets, contextTokens: 24001 } }) },
    { label: "output budget", value: template({ budgets: { ...template().budgets, outputTokens: 4001 } }) },
    { label: "elapsed budget", value: template({ budgets: { ...template().budgets, elapsedSeconds: 2701 } }) },
    { label: "attempt ceiling", value: template({ budgets: { ...template().budgets, maxAttempts: 2 } }) },
    { label: "checkpoint", value: template({ policy: { ...template().policy, checkpoint: "report at the very end" } }) },
    { label: "stop conditions", value: template({ policy: { ...template().policy, stopConditions: ["never stop"] } }) },
    { label: "escalation", value: template({ policy: { ...template().policy, escalation: "carry on regardless" } }) },
    { label: "required result fields", value: template({ resultSchema: { ...template().resultSchema, requiredFields: ["status"] } }) },
  ];

  for (const { label, value } of sensitive) {
    it(`changes the approval digest when ${label} changes`, () => {
      assert.notEqual(digestOf(withTemplates([value])), base);
    });
  }

  it("rejects, rather than digests, a template declaring an unsupported wire schemaVersion", () => {
    // "9.9.9" is not a digest-sensitivity case: the frozen WorkerTicket parser
    // fail-closed rejects any wire version other than the supported 1.0.0, so
    // this must throw instead of silently producing a different digest.
    assert.throws(
      () => digestOf(withTemplates([template({ schemaVersion: "9.9.9" })])),
      ValidationError,
    );
  });

  it("rejects, rather than digests, a template whose owned scope overlaps its own forbidden scope", () => {
    // The owned-scope sensitivity case above moves to a path that does not
    // overlap the fixture's forbidden list; overlap itself is a distinct,
    // fail-closed rejection, not a digest change.
    assert.throws(
      () =>
        digestOf(
          withTemplates([
            template({ scope: { ...template().scope, owned: ["src/planning/planTypes.ts", "src/supervision/workerContract.ts"] } }),
          ]),
        ),
      ValidationError,
    );
  });

  it("distinguishes a plan that records templates from a legacy plan that records none", () => {
    assert.notEqual(digestOf(withTemplates(undefined)), base);
    assert.notEqual(digestOf(withTemplates([])), base);
    assert.notEqual(digestOf(withTemplates([])), digestOf(withTemplates(undefined)));
  });

  it("changes when a second item's authority is added", () => {
    assert.notEqual(digestOf(withTemplates([template(), template({ planItemKey: "WI-B" })])), base);
  });

  it("is stable across template array order", () => {
    const a = template();
    const b = template({ planItemKey: "WI-B" });
    assert.equal(digestOf(withTemplates([a, b])), digestOf(withTemplates([b, a])));
  });

  it("is stable across object key order and a JSON round-trip", () => {
    const reordered: WorkItemTicketTemplate = {
      resultSchema: { maxResultBytes: 2048, requiredFields: ["schemaVersion", "ticketId", "status", "summary"] },
      policy: { escalation: "stop and report to the controller", stopConditions: ["scope would grow beyond the owned files"], checkpoint: "report after typecheck" },
      budgets: { maxAttempts: 1, elapsedSeconds: 2700, outputTokens: 4000, contextTokens: 24000 },
      model: { rationale: "Bounded, well-specified edit in a single pure module.", reasoningEffort: "medium", eligibleModels: ["model-a"] },
      scope: {
        validation: ["npm run typecheck"],
        dependencies: [],
        read: ["docs/FACTORY_CONSTITUTION.md"],
        forbidden: ["src/supervision/workerContract.ts"],
        owned: ["src/planning/planTypes.ts"],
      },
      acceptanceCriteria: [{ description: CRITERION_TEXT, version: "1.0.0", id: "AC-1" }],
      objective: "Implement the strict worker ticket parser for WI-A.",
      schemaVersion: PLAN_TICKET_SCHEMA_VERSION,
      planItemKey: "WI-A",
    };
    assert.equal(digestOf(withTemplates([reordered])), base);
    assert.equal(digestOf(withTemplates([JSON.parse(JSON.stringify(reordered)) as WorkItemTicketTemplate])), base);
  });

  it("cannot be moved by plan prose alone, and moves for prose that is already authoritative content", () => {
    // The digest already covers assumptions (approved content), but no prose
    // field feeds the TEMPLATE half of it: the canonical template string is a
    // function of recorded authority only.
    const promise = digestInput(EXECUTION);
    const louder: PlanApprovalDigestInput = {
      ...promise,
      revision: { ...promise.revision, items: [{ ...item("WI-A"), spec: "The worker owns everything, with no ceiling." }] },
    };
    assert.notEqual(computePlanApprovalDigest(louder), base);
    // ...and the authority itself is unchanged by that rewrite, which is the
    // point: prose cannot grant it, so re-approval is the only path.
    const result = planTicketExecutability(louder.revision.items, EXECUTION.ticketTemplates);
    assert.equal(result.status, "EXECUTABLE");
  });
});

// ---------------------------------------------------------------------------
// The direct exported digest boundary fails closed on an unknown nested field
// ---------------------------------------------------------------------------

describe("NC-RUNTIME-01 computePlanApprovalDigest direct boundary", () => {
  it("computes the approval digest for a valid WI-A template (positive control)", () => {
    assert.equal(typeof digestOf(EXECUTION), "string");
    assert.match(digestOf(EXECUTION), /^papr-[0-9a-f]{32}$/);
  });

  it("computes the same digest for the same valid input called twice (positive control)", () => {
    assert.equal(digestOf(EXECUTION), digestOf(EXECUTION));
  });

  const directUnknownNested: readonly { readonly label: string; readonly value: WorkItemTicketTemplate }[] = [
    {
      label: "scope.grantAll",
      value: template({ scope: { ...template().scope, grantAll: true } as unknown as WorkItemTicketTemplate["scope"] }),
    },
    {
      label: "model.grantAll",
      value: template({ model: { ...template().model, grantAll: true } as unknown as WorkItemTicketTemplate["model"] }),
    },
    {
      label: "budgets.unlimited",
      value: template({ budgets: { ...template().budgets, unlimited: true } as unknown as WorkItemTicketTemplate["budgets"] }),
    },
    {
      label: "policy.override",
      value: template({ policy: { ...template().policy, override: true } as unknown as WorkItemTicketTemplate["policy"] }),
    },
    {
      label: "resultSchema.skipValidation",
      value: template({
        resultSchema: { ...template().resultSchema, skipValidation: true } as unknown as WorkItemTicketTemplate["resultSchema"],
      }),
    },
    {
      label: "acceptanceCriteria[0].authoritative",
      value: template({
        acceptanceCriteria: [{ id: "AC-1", version: "1.0.0", description: CRITERION_TEXT, authoritative: true } as unknown as WorkItemTicketTemplate["acceptanceCriteria"][number]],
      }),
    },
    { label: "top-level unknown field", value: { ...template(), grantAll: true } as unknown as WorkItemTicketTemplate },
  ];

  for (const { label, value } of directUnknownNested) {
    it(`rejects, at computePlanApprovalDigest itself, a template smuggling an unknown nested field: ${label}`, () => {
      // It must throw rather than silently narrow the template and return the
      // SAME digest a valid WI-A template would produce — that is exactly the
      // gap independent review reproduced.
      assert.throws(() => computePlanApprovalDigest(digestInput(withTemplates([value]))), ValidationError);
    });
  }
});

// ---------------------------------------------------------------------------
// Persistence round trip
// ---------------------------------------------------------------------------

describe("NC-RUNTIME-01 plan serialization", () => {
  it("round-trips captured templates byte-identically and preserves the approval digest", () => {
    const plan = parsePlan(planRow(EXECUTION), COLUMNS);
    assert.deepEqual(plan.execution.ticketTemplates, EXECUTION.ticketTemplates);
    const reread = parsePlan(encodePlan(plan), COLUMNS);
    assert.deepEqual(reread.execution.ticketTemplates, EXECUTION.ticketTemplates);
    assert.equal(digestOf(reread.execution), digestOf(EXECUTION));
    assert.equal(planTicketExecutability(reread.revisions[0]!.items, reread.execution.ticketTemplates).status, "EXECUTABLE");
  });

  it("loads a legacy plan with no templates and reports it NON_EXECUTABLE", () => {
    const plan = parsePlan(planRow(withTemplates(undefined)), COLUMNS);
    assert.equal(plan.execution.ticketTemplates, undefined);
    const result = planTicketExecutability(plan.revisions[0]!.items, plan.execution.ticketTemplates);
    assert.ok(result.status === "NON_EXECUTABLE");
    assert.match(result.replanAction, /replan/);
  });

  it("fails closed on a persisted template that violates the frozen contract", () => {
    const rows: readonly unknown[] = [
      { ...template(), budgets: { contextTokens: 0, outputTokens: 4000, elapsedSeconds: 60, maxAttempts: 1 } },
      // JSON has no Infinity: an unbounded budget persists as null, and null is
      // not a positive finite number either.
      { ...template(), budgets: { contextTokens: null, outputTokens: 4000, elapsedSeconds: 60, maxAttempts: 1 } },
      { ...template(), scope: { ...template().scope, owned: [] } },
      { ...template(), schemaVersion: "2.0.0" },
      { ...template(), resultSchema: { requiredFields: ["status"], maxResultBytes: 1_000_000 } },
      // A smuggled ticketId is an unexpected field, not a silently ignored one.
      { ...template(), ticketId: "someone-elses-ticket" },
      "a prose ticket",
    ];
    for (const bad of rows) {
      assert.throws(
        () => parsePlan(planRow(withTemplates([bad as WorkItemTicketTemplate])), COLUMNS),
        PersistenceCorruptionError,
        `expected corruption for ${JSON.stringify(bad)}`,
      );
    }
  });

  it("fails closed on a persisted template smuggling an unknown nested field, rather than silently dropping it", () => {
    const rows: readonly unknown[] = [
      { ...template(), scope: { ...template().scope, grantAll: true } },
      { ...template(), model: { ...template().model, grantAll: true } },
      { ...template(), budgets: { ...template().budgets, unlimited: true } },
      { ...template(), policy: { ...template().policy, override: true } },
      { ...template(), resultSchema: { ...template().resultSchema, skipValidation: true } },
      { ...template(), acceptanceCriteria: [{ id: "AC-1", version: "1.0.0", description: CRITERION_TEXT, authoritative: true }] },
    ];
    for (const bad of rows) {
      assert.throws(
        () => parsePlan(planRow(withTemplates([bad as WorkItemTicketTemplate])), COLUMNS),
        PersistenceCorruptionError,
        `expected corruption for ${JSON.stringify(bad)}`,
      );
    }
  });

  it("fails closed on duplicate and orphaned persisted templates", () => {
    assert.throws(() => parsePlan(planRow(withTemplates([template(), template()])), COLUMNS), PersistenceCorruptionError);
    assert.throws(
      () => parsePlan(planRow(withTemplates([template(), template({ planItemKey: "WI-GHOST" })])), COLUMNS),
      /not part of revision 1/,
    );
  });

  it("still refuses a plan row whose verification commands are missing, unchanged by this slice", () => {
    assert.throws(() => parsePlan(planRow({ ...EXECUTION, verificationCommands: [] }), COLUMNS), PersistenceCorruptionError);
  });
});
