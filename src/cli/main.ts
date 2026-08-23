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
  sf supervise tick   Run ONE bounded autonomous-completion pass and exit (TASK-006).
                      Designed for a systemd timer/cron: between ticks no process
                      runs, so waiting for a provider costs nothing.
  sf supervise status     Show supervisor state, spending policy and open escalations
  sf supervise resources  Show per-resource availability, retry times and backoff
  sf supervise roadmap    Show the durable roadmap queue and what it is waiting on
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
                  ? await runPlanResume(planId, { log })
                  : await runPlanCancel(planId, { log });
        return view.phase === "BLOCKED" || view.phase === "RECOVERY_REQUIRED" ? 1 : 0;
      }
      console.error(`Usage: sf plan <start|status|answer|approve|reject|resume|cancel>`);
      return 1;
    }
    case "supervise": {
      const sub = argv[1];
      const { runSuperviseTick, runSuperviseStatus, runSuperviseResources, runSuperviseRoadmap } = await import(
        "./supervise.js"
      );
      const log = (line: string): void => console.log(line);

      if (sub === "tick") {
        const result = await runSuperviseTick({ log });
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
      console.error(`Usage: sf supervise <tick|status|resources|roadmap>`);
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
