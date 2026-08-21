#!/usr/bin/env node
/**
 * Factory CLI — the bootstrap control plane interface (docs/ARCHITECTURE.md).
 *
 * Commands are intentionally few: TASK-001 only needs to demonstrate the core
 * workflow. Nothing here reads credentials or reaches the network.
 */

import { PROTECTED_GATES } from "../domain/approval.js";
import { WORK_ITEM_STATUSES } from "../domain/status.js";
import { TRANSITION_RULES, allowedTargets, gatedTransitions } from "../workflow/transitions.js";
import { runDemo } from "./demo.js";

const USAGE = `sf — Software Factory (bootstrap)

Usage:
  sf demo             Run the in-memory demo work item from IDEA to DONE
  sf demo:persistent  Run (or resume) the SQLite-backed persistent demo
  sf demo:loop        Run the deterministic autonomous-loop demo (TASK-004)
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
