/**
 * Explicit workspace boundary (TASK-003 item 4).
 *
 * A `Workspace` is trusted configuration, supplied by whoever wires up a CLI
 * worker adapter (the `sf worker` CLI today; a future project registry
 * later) — never derived from `WorkerRequest.instructions` or any other
 * model-generated text. `src/ports/worker.ts`'s `WorkerRequest` has no `cwd`
 * field at all, so there is no path for a prompt to choose a process's
 * working directory.
 *
 * `resolveWorkspace` is the only way to obtain a `Workspace`: it resolves
 * the path to an absolute form and validates it before anything is allowed
 * to spawn inside it, so a typo'd or half-configured path fails loudly at
 * setup time rather than quietly misrouting a worker later.
 *
 * TASK-003 remediation round 1, MEDIUM finding (independent Codex review,
 * 2026-08-20): the original check only asked whether `<root>/.git` existed
 * on disk — a directory containing an empty `.git` file or directory (no
 * real repository behind it) passed. Repository membership is now verified
 * by actually asking Git (`git -C <path> rev-parse --show-toplevel`) via a
 * non-shell child process, not by checking for a filesystem marker.
 */

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";

import { ValidationError } from "../../domain/errors.js";

export interface Workspace {
  /** Absolute, resolved path — the actual working directory a worker process is launched in. */
  readonly root: string;
  /**
   * The real Git repository root `root` belongs to, as reported by Git
   * itself (`root` may equal this, or be a subdirectory of it — see
   * `ResolveWorkspaceOptions`). Equals `root` when `requireGitRepository`
   * is false. Recorded so the execution boundary is unambiguous even when a
   * configured workspace is a subdirectory of the approved repository.
   */
  readonly repositoryRoot: string;
}

export interface ResolveWorkspaceOptions {
  /** Refuse a workspace that is not verified, by Git itself, to be inside a git working tree. Default true. */
  readonly requireGitRepository?: boolean;
  /** Overridable for tests; defaults to `"git"` (resolved via PATH — never a shell). */
  readonly gitExecutable?: string;
}

const MAX_GIT_DIAGNOSTIC_CHARS = 300;

/** Flattens and bounds a git diagnostic before it can appear in a thrown message (never raw/unbounded stderr). */
function boundedDiagnostic(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_GIT_DIAGNOSTIC_CHARS ? `${oneLine.slice(0, MAX_GIT_DIAGNOSTIC_CHARS)}…` : oneLine;
}

interface GitProbeResult {
  readonly repositoryRoot?: string;
  readonly diagnostic?: string;
}

/**
 * Asks Git itself whether `candidate` is inside a real working tree, via a
 * non-shell child process — executable and argv are always separate,
 * `shell` is never set, and `candidate` is only ever passed as an argv
 * element / the child's `cwd`, never interpolated into a command string.
 * Bounded (10s timeout; diagnostic text capped) so a hung or chatty `git`
 * cannot hang or flood workspace resolution.
 */
function probeGitRepository(candidate: string, gitExecutable: string): GitProbeResult {
  const result = spawnSync(gitExecutable, ["-C", candidate, "rev-parse", "--show-toplevel"], {
    cwd: candidate,
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
  });

  if (result.error !== undefined) {
    return { diagnostic: boundedDiagnostic(result.error.message) };
  }
  if (result.status !== 0) {
    return { diagnostic: boundedDiagnostic(result.stderr.length > 0 ? result.stderr : `git exited with status ${String(result.status)}`) };
  }
  const printed = result.stdout.trim();
  if (printed.length === 0) {
    return { diagnostic: "git rev-parse --show-toplevel printed no output" };
  }
  return { repositoryRoot: resolve(printed) };
}

export function resolveWorkspace(path: string, options: ResolveWorkspaceOptions = {}): Workspace {
  const requireGitRepository = options.requireGitRepository ?? true;
  const gitExecutable = options.gitExecutable ?? "git";
  const root = resolve(path);

  let stat;
  try {
    stat = statSync(root);
  } catch {
    throw new ValidationError(`workspace path does not exist: ${root}`);
  }
  if (!stat.isDirectory()) {
    throw new ValidationError(`workspace path is not a directory: ${root}`);
  }

  if (!requireGitRepository) {
    return Object.freeze({ root, repositoryRoot: root });
  }

  const probe = probeGitRepository(root, gitExecutable);
  if (probe.repositoryRoot === undefined) {
    throw new ValidationError(
      `workspace is not inside a real git repository (verified via "git -C <path> rev-parse --show-toplevel", ` +
        `not merely a ".git" filesystem entry): ${root}` +
        (probe.diagnostic === undefined ? "" : ` — ${probe.diagnostic}`),
    );
  }

  return Object.freeze({ root, repositoryRoot: probe.repositoryRoot });
}
