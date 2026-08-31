#!/usr/bin/env node
/**
 * Factory CLI — the bootstrap control plane interface (docs/ARCHITECTURE.md).
 *
 * Commands are intentionally few: TASK-001 only needs to demonstrate the core
 * workflow. Nothing here reads credentials or reaches the network.
 */

import { PROTECTED_GATES } from "../domain/approval.js";
import { boundedDiagnostic } from "../supervision/resourceClassifier.js";
import { WORK_ITEM_STATUSES } from "../domain/status.js";
import { TRANSITION_RULES, allowedTargets, gatedTransitions } from "../workflow/transitions.js";
import { runDemo } from "./demo.js";

const USAGE = `sf — Software Factory (bootstrap)

Usage:
  sf demo             Run the in-memory demo work item from IDEA to DONE
  sf demo:persistent  Run (or resume) the SQLite-backed persistent demo
  sf demo:loop        Run the deterministic autonomous-loop demo (TASK-004)
  sf demo:plan        Run the deterministic durable-planner demo (TASK-005)
  sf transitions      Print the workflow transition table and protected gates
  sf worker doctor    Report whether the claude/codex CLIs are found, and their version
  sf worker smoke claude|codex
                      Real, controlled, non-interactive smoke test of one installed
                      CLI worker in a throwaway scratch workspace (burns real usage)
  sf loop start <work-item-id> --config <path>
                      Start the autonomous engineering loop (TASK-004) for an
                      already-approved (READY) work item
  sf loop status <loop-id>   Show loop phase/iteration/budget (no secrets/transcripts)
  sf loop resume <loop-id>   Resume a loop after a crash/restart
  sf loop cancel <loop-id>   Durably cancel an active loop
  sf plan start <project-id> --intent <path> [--config <path>]
                      Plan a natural-language goal into a reviewable, durable plan (TASK-005)
  sf plan status <plan-id>   Show plan phase/revision/progress (read-only, no secrets)
  sf plan answer <plan-id> --answers <path>
                      Answer the plan's blocking clarification questions
  sf plan approve <plan-id>  Approve the current plan revision (trusted human)
  sf plan reject <plan-id> [--note <text>]
                      Reject the current plan revision (trusted human)
  sf plan resume <plan-id>   Resume planning/materialization/dispatch after a restart
  sf plan cancel <plan-id>   Durably cancel a plan (trusted human)
  sf supervise tick [--roadmap-plans <path>] [--plans-db <path>] [--drive-plans]
                      Run ONE bounded autonomous-completion pass and exit (TASK-006).
                      Designed for a systemd timer/cron: between ticks no process
                      runs, so waiting for a provider costs nothing.
                      --roadmap-plans  JSON map of roadmapKey -> approved plan id,
                                       declared by a human. Lets the tick FIND the
                                       plan serving an item and report its state.
                      --plans-db       Where the plans database lives.
                      --drive-plans    Also LAUNCH an approved plan, by running
                                       sf plan resume in a child process. Off by
                                       default: launching spends.
  sf supervise status     Show supervisor state, spending policy and open escalations
  sf supervise resources  Show per-resource availability, retry times and backoff
  sf supervise roadmap    Show the durable roadmap queue and what it is waiting on
  sf github publish --roadmap-key <KEY> --head <SHA> --base <SHA>
                    --head-ref <BRANCH> --base-ref <BRANCH>
                    --repo <owner/name> --remote-url <URL>
                      Publish a reviewed candidate as a pull request (TASK-016).
                      Idempotent; the push is gated on observed zero liability.
  sf github readiness ... [--reviewed]
                      Report whether that candidate is bound to remote state and
                      CI evidence well enough to integrate. Integrates nothing.
  sf help             Show this message
`;

function printTransitions(): void {
  console.log("Statuses:");
  console.log(`  ${WORK_ITEM_STATUSES.join(", ")}`);
  console.log("");
  console.log("Protected gates:");
  console.log(`  ${PROTECTED_GATES.join(", ")}`);
  console.log("");
  console.log(`Transitions (${TRANSITION_RULES.length} declared; anything not listed is refused):`);
  for (const rule of TRANSITION_RULES) {
    const flags: string[] = [];
    if (rule.requiredGate !== undefined) {
      flags.push(`gate=${rule.requiredGate}`);
    }
    if (rule.requiresHumanAuthorization === true) {
      flags.push("human-authorized");
    }
    if (rule.precondition !== undefined) {
      flags.push("requires-evidence");
    }
    const suffix = flags.length > 0 ? `  [${flags.join(", ")}]` : "";
    console.log(`  ${rule.from.padEnd(18)} -> ${rule.to.padEnd(18)}${suffix}`);
  }
  console.log("");
  console.log("Gated transitions:");
  for (const rule of gatedTransitions()) {
    console.log(`  ${rule.from} -> ${rule.to} requires ${rule.requiredGate}`);
  }
  console.log("");
  console.log("From IMPLEMENTING you may only go to:");
  console.log(`  ${allowedTargets("IMPLEMENTING").join(", ")}`);
}

/**
 * The human action recorded when `--action` is not supplied.
 *
 * TASK-009's documented command line carries `--reason` and `--detail` only,
 * while AC-1 requires a human-readable action to be recorded. A fixed table per
 * reason satisfies both without inventing per-call prose: the text is
 * deterministic, reviewable here, and identical for every caller. `--action`
 * remains available when the operator knows something more specific.
 */
const DEFAULT_HUMAN_ACTION: Readonly<Record<string, string>> = Object.freeze({
  FINANCIAL_ACTION_REQUIRED: "A human must personally authorise and perform this transaction; the Factory has no spending authority.",
  HUMAN_CREDENTIAL_REQUIRED: "A human must supply the credential directly; it cannot be handled by the Factory.",
  PUBLICATION_APPROVAL_REQUIRED: "A human must approve publication before this can proceed.",
  DESTRUCTIVE_APPROVAL_REQUIRED: "A human must approve this destructive operation before it can proceed.",
  AUTH_REQUIRED: "A human must complete authentication before this can proceed.",
  HUMAN_DECISION_REQUIRED: "A human must make this judgement; the work itself is free and safe, but the decision is reserved.",
  PLATFORM_CAPABILITY_BLOCKED: "A human must perform this step manually: the available tooling refuses to do it, and the refusal is a correct default that must not be evaded.",
  RECOVERY_REQUIRED: "A human must inspect and repair the recorded state before work resumes.",
});

interface BlockArgs {
  readonly roadmapKey: string;
  readonly reason: string;
  readonly humanActionRequired: string;
  readonly detail: string;
}

/**
 * Accepts the documented flag form and the older positional form.
 *
 * Fails with a message naming the problem rather than letting a missing value
 * reach the durable-state validator, which previously reported
 * `field "detail" must be a non-empty string, got ""` — an internal complaint
 * about a record the operator never knowingly built.
 */
export function parseBlockArgs(
  args: readonly string[],
): { readonly ok: true; readonly value: BlockArgs } | { readonly ok: false; readonly error: string } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const known = new Set(["--reason", "--action", "--detail"]);

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) continue;
    if (token.startsWith("--")) {
      if (!known.has(token)) {
        return { ok: false, error: `unknown option ${JSON.stringify(token)}` };
      }
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, error: `option ${JSON.stringify(token)} requires a value` };
      }
      flags.set(token, value);
      i += 1;
      continue;
    }
    positional.push(token);
  }

  const roadmapKey = positional[0];
  if (roadmapKey === undefined) {
    return { ok: false, error: "a roadmap key is required" };
  }
  const reason = flags.get("--reason") ?? positional[1];
  if (reason === undefined) {
    return { ok: false, error: "a reason is required (--reason)" };
  }
  const detail = flags.get("--detail") ?? positional[3];
  if (detail === undefined || detail.trim().length === 0) {
    return { ok: false, error: "a non-empty detail is required (--detail)" };
  }
  const humanActionRequired =
    flags.get("--action") ?? positional[2] ?? DEFAULT_HUMAN_ACTION[reason];
  if (humanActionRequired === undefined || humanActionRequired.trim().length === 0) {
    // Only reachable for a reason with no default, which is itself a bug worth
    // saying out loud rather than papering over with a generic sentence.
    return { ok: false, error: `no default human action for reason ${JSON.stringify(reason)}; pass --action` };
  }
  return { ok: true, value: { roadmapKey, reason, humanActionRequired, detail } };
}

/**
 * What `sf supervise tick` accepts (TASK-014 round-2 finding 1).
 *
 * The options existed on `SuperviseCliOptions` and the shipped CLI never parsed
 * them, so `sf supervise tick --roadmap-plans <path>` ran a supervisor that
 * could find no plan and exited 0 — including with a path that does not exist.
 * The AC-1 test called `runSuperviseTick` directly and so proved nothing about
 * the command an operator actually types.
 *
 * Exported, and parsed by a function rather than by `argv.indexOf` at the call
 * site, so the mapping from flags to options is something a test can hold.
 */
export interface SuperviseTickArgs {
  readonly roadmapPlansPath?: string;
  readonly plansDbPath?: string;
  readonly drivePlans?: boolean;
}

export function parseSuperviseTickArgs(
  args: readonly string[],
): { readonly ok: true; readonly value: SuperviseTickArgs } | { readonly ok: false; readonly error: string } {
  const valued = new Map<string, string>();
  let drivePlans = false;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) continue;
    if (token === "--drive-plans") {
      drivePlans = true;
      continue;
    }
    if (token !== "--roadmap-plans" && token !== "--plans-db") {
      // Unknown flags and stray positionals both REFUSED. A tick that silently
      // ignores an argument is how the defect above stayed invisible: the
      // operator sees a successful run and concludes the option took effect.
      return { ok: false, error: `unexpected argument ${JSON.stringify(token)}` };
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, error: `option ${JSON.stringify(token)} requires a value` };
    }
    valued.set(token, value);
    i += 1;
  }

  const roadmapPlansPath = valued.get("--roadmap-plans");
  const plansDbPath = valued.get("--plans-db");
  if (drivePlans && roadmapPlansPath === undefined) {
    return { ok: false, error: "--drive-plans also needs --roadmap-plans: there is no plan to drive without a binding" };
  }
  return {
    ok: true,
    value: {
      ...(roadmapPlansPath === undefined ? {} : { roadmapPlansPath }),
      ...(plansDbPath === undefined ? {} : { plansDbPath }),
      ...(drivePlans ? { drivePlans: true } : {}),
    },
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? "help";

  switch (command) {
    case "demo":
      await runDemo({ log: (line) => console.log(line) });
      return 0;
    case "demo:persistent": {
      // Lazy-loaded: this is the only command that touches node:sqlite, so
      // plain `sf demo`/`sf transitions` never trigger its experimental
      // warning or pay its module-load cost.
      const { runPersistentDemo } = await import("./persistentDemo.js");
      await runPersistentDemo({ log: (line) => console.log(line) });
      return 0;
    }
    case "demo:loop": {
      const { runLoopDemo } = await import("./demoLoop.js");
      await runLoopDemo({ log: (line) => console.log(line) });
      return 0;
    }
    case "demo:plan": {
      const { runPlanDemo } = await import("./demoPlan.js");
      await runPlanDemo({ log: (line) => console.log(line) });
      return 0;
    }
    case "transitions":
      printTransitions();
      return 0;
    case "worker": {
      const sub = argv[1];
      if (sub === "doctor") {
        const { runWorkerDoctor } = await import("./workerDoctor.js");
        await runWorkerDoctor({ log: (line) => console.log(line) });
        return 0;
      }
      if (sub === "smoke") {
        const tool = argv[2];
        if (tool !== "claude" && tool !== "codex") {
          console.error(`Usage: sf worker smoke <claude|codex>`);
          return 1;
        }
        const { runWorkerSmoke } = await import("./workerSmoke.js");
        const result = await runWorkerSmoke(tool, { log: (line) => console.log(line) });
        return result.run.status === "SUCCEEDED" ? 0 : 1;
      }
      console.error(`Usage: sf worker <doctor|smoke>`);
      return 1;
    }
    case "loop": {
      const sub = argv[1];
      const { runLoopStart, runLoopStatus, runLoopResume, runLoopCancel } = await import("./loop.js");
      const log = (line: string): void => console.log(line);
      if (sub === "start") {
        const workItemId = argv[2];
        const configFlagIndex = argv.indexOf("--config");
        const configPath = configFlagIndex === -1 ? undefined : argv[configFlagIndex + 1];
        if (workItemId === undefined || configPath === undefined) {
          console.error("Usage: sf loop start <work-item-id> --config <path>");
          return 1;
        }
        const view = await runLoopStart(workItemId, configPath, { log });
        return view.humanActionRequired && view.outcome !== "WAITING_FOR_HUMAN" ? 1 : 0;
      }
      if (sub === "status" || sub === "resume" || sub === "cancel") {
        const loopId = argv[2];
        if (loopId === undefined) {
          console.error(`Usage: sf loop ${sub} <loop-id>`);
          return 1;
        }
        const view =
          sub === "status" ? await runLoopStatus(loopId, { log }) : sub === "resume" ? await runLoopResume(loopId, { log }) : await runLoopCancel(loopId, { log });
        return view.outcome === "FAILED" || view.outcome === "EXHAUSTED" ? 1 : 0;
      }
      console.error(`Usage: sf loop <start|status|resume|cancel>`);
      return 1;
    }
    case "plan": {
      const sub = argv[1];
      const { runPlanStart, runPlanStatus, runPlanAnswer, runPlanApprove, runPlanReject, runPlanResume, runPlanCancel } =
        await import("./plan.js");
      const log = (line: string): void => console.log(line);
      const flag = (name: string): string | undefined => {
        const index = argv.indexOf(name);
        return index === -1 ? undefined : argv[index + 1];
      };

      if (sub === "start") {
        const projectId = argv[2];
        const intentPath = flag("--intent");
        if (projectId === undefined || intentPath === undefined) {
          console.error("Usage: sf plan start <project-id> --intent <path> [--config <path>]");
          return 1;
        }
        const view = await runPlanStart(projectId, intentPath, flag("--config"), { log });
        return view.phase === "BLOCKED" || view.phase === "RECOVERY_REQUIRED" ? 1 : 0;
      }
      if (sub === "answer") {
        const planId = argv[2];
        const answersPath = flag("--answers");
        if (planId === undefined || answersPath === undefined) {
          console.error("Usage: sf plan answer <plan-id> --answers <path>");
          return 1;
        }
        const view = await runPlanAnswer(planId, answersPath, { log });
        return view.phase === "BLOCKED" || view.phase === "RECOVERY_REQUIRED" ? 1 : 0;
      }
      if (sub === "status" || sub === "approve" || sub === "reject" || sub === "resume" || sub === "cancel") {
        const planId = argv[2];
        if (planId === undefined) {
          console.error(`Usage: sf plan ${sub} <plan-id>`);
          return 1;
        }
        const view =
          sub === "status"
            ? await runPlanStatus(planId, { log })
            : sub === "approve"
              ? await runPlanApprove(planId, { log })
              : sub === "reject"
                ? await runPlanReject(planId, flag("--note"), { log })
                : sub === "resume"
                  ? await runPlanResume(planId, {
                      log,
                      // Lets an unattended caller pin WHICH approval it cleared,
                      // so a revision approved in between cannot be resumed in
                      // its place (TASK-015 finding 3). Humans pass nothing.
                      ...(flag("--expect-approved-digest") === undefined
                        ? {}
                        : { expectApprovedDigest: flag("--expect-approved-digest") as string }),
                    })
                  : await runPlanCancel(planId, { log });
        return view.phase === "BLOCKED" || view.phase === "RECOVERY_REQUIRED" ? 1 : 0;
      }
      console.error(`Usage: sf plan <start|status|answer|approve|reject|resume|cancel>`);
      return 1;
    }
    case "supervise": {
      const sub = argv[1];
      const {
        runSuperviseTick,
        runSuperviseStatus,
        runSuperviseResources,
        runSuperviseRoadmap,
        runSuperviseBlock,
      } = await import("./supervise.js");
      const log = (line: string): void => console.log(line);

      if (sub === "tick") {
        const parsed = parseSuperviseTickArgs(argv.slice(2));
        if (!parsed.ok) {
          console.error(parsed.error);
          console.error(
            `Usage: sf supervise tick [--roadmap-plans <path>] [--plans-db <path>] [--drive-plans]`,
          );
          return 1;
        }
        const result = await runSuperviseTick({ log, ...parsed.value });
        // A resource shortage or a human-only boundary is an expected outcome,
        // not a failure; only unrecoverable state is a non-zero exit.
        return result.kind === "RECOVERY_REQUIRED" ? 1 : 0;
      }
      if (sub === "status") {
        await runSuperviseStatus({ log });
        return 0;
      }
      if (sub === "resources") {
        await runSuperviseResources({ log });
        return 0;
      }
      if (sub === "roadmap") {
        await runSuperviseRoadmap({ log });
        return 0;
      }
      if (sub === "block") {
        /**
         * `sf supervise block <ROADMAP_KEY> --reason <REASON> --detail <TEXT>`
         *
         * That is the syntax TASK-009 documents and that AC-4 names by flag, and
         * it did not work: the parser read positionally, so `--reason` landed in
         * the reason slot and the command died with `unknown reason "--reason"`
         * having written nothing. The positional form is still accepted, because
         * existing callers use it, but the DOCUMENTED form is the one a human
         * types from the task file.
         */
        const parsed = parseBlockArgs(argv.slice(2));
        if (!parsed.ok) {
          console.error(parsed.error);
          console.error(`Usage: sf supervise block <ROADMAP_KEY> --reason <REASON> --detail <TEXT> [--action <TEXT>]`);
          return 1;
        }
        return runSuperviseBlock({ ...parsed.value, log });
      }
      console.error(`Usage: sf supervise <tick|status|resources|roadmap|block>`);
      return 1;
    }
    case "github": {
      const sub = argv[1];
      const { parseGithubPublishArgs, runGithubPublish, runGithubReadiness } = await import("./github.js");
      const log = (line: string): void => console.log(line);
      const usage =
        "Usage: sf github <publish|readiness> --roadmap-key <KEY> --head <SHA> --base <SHA> " +
        "--head-ref <BRANCH> --base-ref <BRANCH> --repo <owner/name> --remote-url <URL> [--reviewed]";

      if (sub === "publish" || sub === "readiness") {
        /**
         * `--reviewed` is stripped before parsing rather than added to the
         * shared parser: it is meaningful only to `readiness`, and a flag that
         * silently does nothing on `publish` would be a lie about what the
         * command consulted.
         */
        const rest = argv.slice(2).filter((token) => token !== "--reviewed");
        const reviewAccepted = argv.slice(2).includes("--reviewed");
        if (sub === "publish" && reviewAccepted) {
          console.error("--reviewed is only meaningful for `sf github readiness`");
          return 1;
        }
        const parsed = parseGithubPublishArgs(rest);
        if (!parsed.ok) {
          console.error(parsed.error);
          console.error(usage);
          return 1;
        }
        return sub === "publish"
          ? await runGithubPublish(parsed.value, { log })
          : await runGithubReadiness({ ...parsed.value, reviewAccepted }, { log });
      }
      console.error(usage);
      return 1;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command: ${command}`);
      console.error(USAGE);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    /**
     * R10-SEC-2: the LAST unguarded output path.
     *
     * A parse failure quotes the offending value back — that is what makes the
     * message useful — and the offending value comes from a database that may
     * have been edited, restored, or written by an older build. So the final
     * error boundary gets the same bounded redaction as every other place text
     * leaves this process. An error handler is the one place it is easiest to
     * forget and worst to get wrong, because it runs precisely when something
     * has already gone strange.
     */
    console.error(boundedDiagnostic(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
