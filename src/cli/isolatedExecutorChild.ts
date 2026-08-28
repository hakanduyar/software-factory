/**
 * The isolated executor child process (TASK-011).
 *
 * Reads one `ExecutorRequest` from the FILE named by `argv[2]`, does the work,
 * writes one response to stdout, exits.
 *
 * Not stdin, and the distinction is load-bearing rather than incidental:
 * TASK-004's unattended-execution invariant forbids any interactive-I/O
 * primitive in this tree, and reading standard input is the one that hangs
 * forever if a terminal is ever attached. This comment said "stdin" until
 * round-12 review caught it — a description that contradicts the code is a
 * small lie that makes the next reader distrust the rest. It holds no credential store, no database path and no
 * supervisor state — only what the request carries.
 *
 * ================================================================
 * WHY THIS ONLY DOES DETERMINISTIC WORK
 * ================================================================
 * Launching an AI worker needs the provider's credential store, which lives
 * under `HOME`/`CODEX_HOME` — exactly the variables the isolated environment
 * withholds. So this child CANNOT authenticate to a provider, and refuses AI
 * work rather than pretending to attempt it.
 *
 * That is the isolation working as designed, not a missing feature: AI launches
 * stay with the supervisor, behind the financial gate that authorises them. A
 * child that could launch a provider would have the billing capability this
 * whole task exists to remove.
 *
 * ================================================================
 * IT REPORTS FACTS, NEVER INSTRUCTIONS
 * ================================================================
 * Nothing written here tells the supervisor what to permit. `WorkOutcome`
 * describes what happened; the supervisor decides what follows, from durable
 * state it alone owns. A child may lie about an outcome; it cannot lie its way
 * into authority that is not expressible in this format (AC-5).
 */

import { readFileSync } from "node:fs";

import { EXECUTOR_PROTOCOL_VERSION } from "../supervision/executorProtocol.js";

/**
 * The request arrives as a FILE PATH in argv, never on stdin.
 *
 * TASK-004's unattended-execution invariant forbids interactive-I/O primitives
 * anywhere in this tree, and reading standard input is the one that hangs
 * forever when a terminal is attached — running this child by hand to debug it
 * would wait for a human who is not coming. A file read cannot block on a
 * person.
 *
 * The invariant's scan is a plain text search that cannot tell an explanation
 * from a call, so this comment deliberately does not spell the forbidden
 * expression. Crude is the right design there: a scanner clever enough to
 * exempt comments is clever enough to be fooled.
 */
function readRequest(): string {
  const path = process.argv[2];
  if (path === undefined || path.length === 0) {
    throw new Error("no request path was given; this child is spawned by the supervisor, not run directly");
  }
  return readFileSync(path, "utf8");
}

function respond(outcome: unknown): void {
  process.stdout.write(JSON.stringify({ protocol: EXECUTOR_PROTOCOL_VERSION, outcome }));
}

function main(): void {
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readRequest());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("request is not an object");
    }
    request = parsed as Record<string, unknown>;
  } catch (error) {
    // The parent is trusted, but a malformed request still means something is
    // wrong upstream — report it rather than guessing what was meant.
    respond({
      kind: "RESOURCE_FAILURE",
      process: {
        terminationReason: "EXITED",
        exitCode: 0,
        stdout: "",
        stderr: `unreadable request: ${error instanceof Error ? error.message : String(error)}`,
      },
    });
    return;
  }

  if (request["protocol"] !== EXECUTOR_PROTOCOL_VERSION) {
    respond({
      kind: "RESOURCE_FAILURE",
      process: {
        terminationReason: "EXITED",
        exitCode: 0,
        stdout: "",
        stderr: `child speaks protocol ${EXECUTOR_PROTOCOL_VERSION}, request claims ${JSON.stringify(request["protocol"])}`,
      },
    });
    return;
  }

  const item = request["item"];
  const workClass =
    typeof item === "object" && item !== null ? (item as Record<string, unknown>)["workClass"] : undefined;

  if (workClass !== "DETERMINISTIC") {
    respond({
      kind: "CHANGES_REQUIRED",
      findings: [
        `an isolated executor cannot perform ${String(workClass)} work: it holds no provider credentials by design, ` +
          "so an AI launch must stay with the supervisor behind the financial gate",
      ],
    });
    return;
  }

  /**
   * Deterministic work is not yet wired to anything real — that is
   * `EXECUTOR_WIRING`, which depends on this task and on STATE_INTEGRITY.
   * Reporting COMPLETED for work nobody performed would be precisely the
   * "an agent said it is done" failure the constitution forbids (C3), so this
   * says plainly that there is nothing wired yet.
   */
  respond({
    kind: "CHANGES_REQUIRED",
    findings: [
      "the isolated executor process is in place, but no deterministic work is wired to it yet; " +
        "that is EXECUTOR_WIRING, which depends on EXECUTOR_ISOLATION and STATE_INTEGRITY",
    ],
  });
}

try {
  main();
} catch (error: unknown) {
  // Never a silent death: the parent would only see exit 0 with no response,
  // which it treats as a failure anyway — but a reason is worth more than an
  // inference.
  process.stderr.write(`isolated executor child failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
