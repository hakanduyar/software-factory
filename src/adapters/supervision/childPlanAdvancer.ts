/**
 * Driving a plan happens in a SEPARATE OS PROCESS (TASK-014 round-2 finding 2,
 * CRITICAL — first half).
 *
 * ================================================================
 * THE GAP THIS CLOSES
 * ================================================================
 * The first implementation handed `PlanBackedExecutor` a live `PlanningService`,
 * so the real execution path was:
 *
 *   SupervisorService -> PlanBackedExecutor -> PlanningService.resume()
 *     -> EngineeringLoopDispatcher -> EngineeringLoopService -> real AI workers
 *
 * every frame of it inside the supervisor's own process. TASK-011 AC-1 says the
 * supervisor does not call executor code as an in-process function on the path
 * that performs work, and AC-11 says the in-process path is not left available
 * as a silent fallback for real work. That wiring was both.
 *
 * The isolation test passed anyway, because it asserted only that the ISOLATED
 * child executor was absent. Proving one path is not taken is not proving the
 * path that IS taken is isolated — the review made that distinction, and it is
 * the reason this file exists rather than another assertion.
 *
 * ================================================================
 * WHY `sf plan resume`, AND NOT A CHILD OF OUR OWN DESIGN
 * ================================================================
 * `sf plan resume <plan-id>` already IS the out-of-process form of exactly this
 * operation: it opens the plan, builds the planner worker and loop dispatcher
 * FROM THE PLAN'S OWN PERSISTED CONFIGURATION, and calls `PlanningService`,
 * which dispatches through `LoopDispatcher` (TASK-014 AC-3). Reusing it means
 * the supervisor drives a plan through the same code a human does.
 *
 * It also closes a defect the in-process wiring had beyond the isolation one.
 * `openPlanningForSupervisor` built the stack from an operator-supplied
 * `--plan-config` FILE, while every `sf plan` command except `start` builds it
 * from the plan's persisted `execution` — so the supervisor could have resumed a
 * plan with verification commands, a workspace and worker models the approval
 * never covered. The child cannot: it has no config file to be given.
 *
 * ================================================================
 * THIS CHILD IS NOT THE TASK-011 ISOLATED CHILD
 * ================================================================
 * Read this before concluding isolation was weakened. There are two children and
 * they exist for opposite reasons:
 *
 *   - The TASK-011 isolated child does DETERMINISTIC work and is denied
 *     credentials and the ability to spawn a provider CLI, so it cannot bill.
 *     TASK-014's boundary "no AI launch inside the isolated child" is about that
 *     one, and nothing here routes anything through it.
 *   - THIS child launches AI workers, so it must be able to authenticate, and it
 *     receives `DEFAULT_WORKER_ENVIRONMENT_POLICY` — the allowlist that forwards
 *     `HOME` and `CODEX_HOME` precisely so a provider CLI finds its own
 *     credentials. That is the same environment every authorised worker in this
 *     repository already runs with.
 *
 * The protection here is not "the child cannot spend". It is that the child is
 * launched ONLY after the supervisor's financial gate authorised a resource AND
 * `checkPlanAuthorization` proved the plan will run that exact resource. What
 * isolation buys is that the supervisor's own process no longer contains the
 * code that performs the work.
 *
 * The database paths ARE handed to this child, unlike the isolated one
 * (TASK-011 AC-3). The difference is deliberate and load-bearing: this child's
 * whole job is to advance a plan in the SAME databases the supervisor read it
 * from, and letting it resolve its own defaults is how a parent and child end up
 * disagreeing about which plan they are talking about.
 */

import { fileURLToPath } from "node:url";

import {
  buildWorkerEnvironment,
  redactSecrets,
  DEFAULT_WORKER_ENV_ALLOWLIST,
} from "../workers/environmentPolicy.js";
import { boundedDiagnostic } from "../../supervision/resourceClassifier.js";
import { PLAN_PHASES, type Plan, type PlanPhase } from "../../planning/planTypes.js";
import type { PlanAdvancer, PlanStateReader } from "../../supervision/planBackedExecutor.js";
import type { ProcessRunner } from "../../ports/processRunner.js";

/**
 * How long a single `sf plan resume` may run before it is terminated.
 *
 * An engineering-loop iteration implements, verifies and reviews, so this is
 * generous by design — but it is a CEILING, not a schedule. A plan that declares
 * its own wall-clock budget gets that budget plus a margin for start-up and
 * shutdown, because the plan's own limit is the one an operator approved.
 */
export const DEFAULT_PLAN_RESUME_TIMEOUT_MS = 30 * 60_000;

/** Margin over a plan's declared wall-clock budget, for process start/stop. */
const BUDGET_MARGIN_MS = 60_000;

/** Enough of the child's output to diagnose a failure; never treated as data. */
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;

/** The narrow read this adapter needs, so tests need no database. */
export interface PlanReader {
  findById(planId: string): Promise<Plan | undefined>;
}

export interface ChildPlanAdvancerDeps {
  readonly processRunner: ProcessRunner;
  /** Re-read after the child exits: the plan's own row is the result. */
  readonly plans: PlanReader;
  /** Explicit, never implicit — the same rule `ProcessRequest` already enforces. */
  readonly cwd: string;
  /**
   * The plans database the SUPERVISOR read the plan from, already resolved. The
   * child is told this exact path so parent and child cannot resolve different
   * defaults and advance different databases.
   */
  readonly plansDbPath: string;
  /** Compiled `sf` entry point. Defaults to this build's own `cli/main.js`. */
  readonly cliEntry?: string;
  readonly nodeExecutable?: string;
  readonly environmentSource?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly log?: (line: string) => void;
}

function defaultCliEntry(): string {
  // src/adapters/supervision/ -> src/cli/main.js, and the same relative step in
  // `dist/`. Derived from this module's own location so a relocated or copied
  // build still launches ITS OWN CLI rather than one found on a path.
  return fileURLToPath(new URL("../../cli/main.js", import.meta.url));
}

function timeoutFor(plan: Plan | undefined, configured: number | undefined): number {
  if (configured !== undefined) {
    return configured;
  }
  const budget = plan?.execution.loopBudget?.maxWallClockMs;
  return budget === undefined ? DEFAULT_PLAN_RESUME_TIMEOUT_MS : budget + BUDGET_MARGIN_MS;
}

/**
 * Forwards the factory database locations the child needs, and ONLY those.
 *
 * `FACTORY_PLANS_DB_PATH` is always set, from the resolved path the supervisor
 * itself used. The other two are forwarded only when the parent has them, so an
 * unset variable stays unset and the child falls back to the same default the
 * parent would have — rather than to a path this function invented.
 */
function factoryPaths(plansDbPath: string, source: NodeJS.ProcessEnv): Record<string, string> {
  const paths: Record<string, string> = { FACTORY_PLANS_DB_PATH: plansDbPath };
  for (const name of ["FACTORY_DB_PATH", "FACTORY_LOOPS_DB_PATH"] as const) {
    const value = source[name];
    if (value !== undefined) {
      paths[name] = value;
    }
  }
  return paths;
}

/**
 * A `PlanAdvancer` that advances the plan in a child process.
 *
 * FAILS CLOSED BY THROWING. `PlanBackedExecutor` already turns a throw from this
 * seam into a definite `RESOURCE_FAILURE` outcome (TASK-014 AC-9), so a child
 * that crashes, times out, exits non-zero or leaves the plan unreadable produces
 * a recorded failure rather than a hang or an assumed success. What it must
 * never do is return the plan it was ASKED about when it cannot show the child
 * succeeded — that would report "no progress" for a run whose real state is
 * unknown.
 */
export function createChildPlanAdvancer(deps: ChildPlanAdvancerDeps): PlanAdvancer {
  const log = deps.log ?? ((): void => {});
  const source = deps.environmentSource ?? process.env;
  const cliEntry = deps.cliEntry ?? defaultCliEntry();
  const nodeExecutable = deps.nodeExecutable ?? process.execPath;

  return {
    async resume(planId: string, expectApprovedDigest?: string): Promise<Plan> {
      const before = await deps.plans.findById(planId);
      const timeoutMs = timeoutFor(before, deps.timeoutMs);

      log(`launching a child process: sf plan resume ${planId} (timeout ${timeoutMs}ms)`);
      const result = await deps.processRunner.run({
        executable: nodeExecutable,
        // No shell, no concatenation, and the plan id is an ARGUMENT rather than
        // part of a command string — `ProcessRequest` has no `shell` option for
        // exactly this reason.
        // The digest travels WITH the request, so the child cannot act on a plan
        // whose approval changed after the supervisor cleared it (finding 3).
        argv: [
          cliEntry,
          "plan",
          "resume",
          planId,
          ...(expectApprovedDigest === undefined ? [] : ["--expect-approved-digest", expectApprovedDigest]),
        ],
        cwd: deps.cwd,
        env: buildWorkerEnvironment(
          {
            allowedVars: DEFAULT_WORKER_ENV_ALLOWLIST,
            extraVars: factoryPaths(deps.plansDbPath, source),
          },
          source,
        ),
        timeoutMs,
        maxOutputBytes: MAX_CHILD_OUTPUT_BYTES,
      });

      if (result.terminationReason !== "EXITED" || result.exitCode !== 0) {
        /**
         * The child's output is UNTRUSTED and only ever a diagnostic: bounded,
         * then redacted, then put in a message. It never decides anything —
         * `terminationReason` and `exitCode` do, and no amount of reassuring
         * text on stdout can turn a non-zero exit into a success.
         */
        const detail = redactSecrets(boundedDiagnostic(result.stderr.length > 0 ? result.stderr : result.stdout));
        throw new Error(
          `sf plan resume ${planId} failed in its child process (${result.terminationReason}, exit ${
            result.exitCode === null ? "none" : result.exitCode
          })${detail.length === 0 ? "" : `: ${detail}`}`,
        );
      }

      const advanced = await deps.plans.findById(planId);
      if (advanced === undefined) {
        throw new Error(
          `sf plan resume ${planId} exited 0 but the plan is no longer readable from ${deps.plansDbPath}`,
        );
      }
      return advanced;
    },
  };
}

/** How long an authority-checked read may take. It launches no worker. */
export const DEFAULT_PLAN_STATUS_TIMEOUT_MS = 120_000;

/**
 * The one line of `sf plan status` this reader believes, parsed strictly.
 *
 * The child's output is UNTRUSTED DATA (TASK-011 AC-4): exactly one `phase`
 * line must be present and its value must be a declared `PlanPhase`. Zero
 * lines, two lines, or an unrecognised word all FAIL rather than degrade — a
 * reader that guesses when the format changes is a reader that will one day
 * report a phase nobody produced.
 */
export function parseStatusPhase(stdout: string): PlanPhase | undefined {
  const matches = [...stdout.matchAll(/^phase\s*:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  if (matches.length !== 1) {
    return undefined;
  }
  const [phase] = matches;
  return (PLAN_PHASES as readonly string[]).includes(phase ?? "") ? (phase as PlanPhase) : undefined;
}

/**
 * THE PERSISTED PHASE IS NOT AUTHORITY (round-3 finding 1, HIGH).
 *
 * The executor read `plan.phase` straight from the plans database and acted on
 * it. Independent review persisted a structurally valid row with a fabricated
 * `approvalId`, no matching Factory approval, and `phase: COMPLETED` — and the
 * supervisor reported the roadmap item COMPLETED without consulting approval
 * authority at all. That is the repository's own rule, broken in the one branch
 * that reports success.
 *
 * FIVE phases assert approval, not one: APPROVED, MATERIALIZING, EXECUTING,
 * WAITING_FOR_HUMAN and COMPLETED. `PlanningService.status()` already answers
 * this correctly — it runs `projectFailClosed`, which demotes any of them to
 * RECOVERY_REQUIRED when the approval cannot be re-derived from the Factory's
 * own records. The supervisor cannot call it in-process (TASK-011 AC-1), so it
 * asks the same question the same way it drives a plan: out of process.
 *
 * `sf plan status` LAUNCHES NO WORKER and spends nothing. It opens databases and
 * projects. So this read is wired unconditionally — a supervisor without
 * `--drive-plans` must still never certify a completion it cannot verify.
 */
export function createChildPlanStateReader(deps: ChildPlanAdvancerDeps): PlanStateReader {
  const source = deps.environmentSource ?? process.env;
  const cliEntry = deps.cliEntry ?? defaultCliEntry();
  const nodeExecutable = deps.nodeExecutable ?? process.execPath;

  return {
    async verifiedPhase(planId: string): Promise<PlanPhase> {
      const result = await deps.processRunner.run({
        executable: nodeExecutable,
        argv: [cliEntry, "plan", "status", planId],
        cwd: deps.cwd,
        env: buildWorkerEnvironment(
          {
            allowedVars: DEFAULT_WORKER_ENV_ALLOWLIST,
            extraVars: factoryPaths(deps.plansDbPath, source),
          },
          source,
        ),
        timeoutMs: deps.timeoutMs ?? DEFAULT_PLAN_STATUS_TIMEOUT_MS,
        maxOutputBytes: MAX_CHILD_OUTPUT_BYTES,
      });

      /**
       * THE EXIT CODE IS NOT THE SIGNAL HERE, and that is a property of the
       * command rather than a concession. `sf plan status` exits 1 to say the
       * phase is BLOCKED or RECOVERY_REQUIRED — which is exactly the answer this
       * reader exists to obtain. Treating that as a failure would convert the
       * demotion into a resource error and hide it.
       *
       * What is NOT tolerated is a child that never produced a phase: a crash, a
       * timeout, a spawn failure or unparseable output all throw.
       */
      if (result.terminationReason !== "EXITED") {
        const detail = redactSecrets(boundedDiagnostic(result.stderr));
        throw new Error(`sf plan status ${planId} did not complete (${result.terminationReason}): ${detail}`);
      }
      const phase = parseStatusPhase(result.stdout);
      if (phase === undefined) {
        const detail = redactSecrets(boundedDiagnostic(result.stderr.length > 0 ? result.stderr : result.stdout));
        throw new Error(
          `sf plan status ${planId} produced no readable phase (exit ${
            result.exitCode === null ? "none" : result.exitCode
          }): ${detail}`,
        );
      }
      return phase;
    },
  };
}
