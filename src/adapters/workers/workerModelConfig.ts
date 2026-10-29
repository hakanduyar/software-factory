/**
 * Model/effort configuration (TASK-003 item 12).
 *
 * Deliberately not a scoring/router/benchmark engine (docs/MODEL_ROUTING.md
 * describes that as later work) — just enough structure that "which model,
 * at what effort, for how long" is data supplied when an adapter is
 * constructed, not a literal baked into workflow code. Changing which
 * Claude/Codex model or effort a Factory run uses is a config change, never
 * a code change.
 */

export const WORKER_TOOLS = ["claude-code", "codex-cli", "ollama-cli", "gemini-cli", "opencode-cli"] as const;

export type WorkerTool = (typeof WORKER_TOOLS)[number];

export interface WorkerModelConfig {
  /** The CLI/tool identity — never conflated with the model it happens to run (C9). */
  readonly tool: WorkerTool;
  readonly model: string;
  /** Free-form reasoning/effort level. Whether the installed CLI can actually honour it is reported separately — see EffortApplication below. */
  readonly effort?: string;
  /**
   * Author (CLI worker) execution has no total deadline: absent or `null`
   * both mean "no total timer". A finite value is refused by `createCliWorker`
   * rather than silently launching a capped author.
   */
  readonly timeoutMs?: number | null;
}

/**
 * Whether a requested capability (currently: effort) was actually expressed
 * to the underlying CLI, or only recorded as a request. Adapters must be
 * honest here rather than silently dropping a field a real invocation never
 * applied — see src/adapters/workers/claudeCodeAdapter.ts for the concrete
 * case (no verified CLI flag on this build machine).
 */
export interface EffortApplication {
  readonly requested?: string;
  readonly applied: boolean;
  readonly reason?: string;
}

/**
 * Author-worker default: NO total execution deadline (human-selected policy).
 * Not a number — `null` is passed through to the ProcessRunner unchanged.
 */
export const DEFAULT_WORKER_TIMEOUT_MS: null = null;

/**
 * Normalises an optional author timeout: absence is `null`; explicit `null`
 * stays `null`. Deliberately not `??`-based fallback to a finite value.
 */
export function normalizeAuthorTimeoutMs(value: number | null | undefined): number | null {
  return value === undefined ? DEFAULT_WORKER_TIMEOUT_MS : value;
}
