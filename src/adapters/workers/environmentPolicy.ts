/**
 * Explicit environment allowlist + best-effort output redaction
 * (TASK-003 item 3 / Factory Constitution C6).
 *
 * `process.env` is never forwarded wholesale to a worker child process. Only
 * the variables a locally-authenticated CLI genuinely needs to find itself,
 * find its own config/credential store, and behave predictably are
 * forwarded — never an API key, token, or other secret. Claude Code and
 * Codex CLI both manage their own authentication under `$HOME` (Codex also
 * honours `$CODEX_HOME`), so forwarding `HOME`/`CODEX_HOME` lets each tool
 * use its *own* already-authenticated local credential store rather than
 * the Factory ever touching a credential itself.
 */

/**
 * Names only — never values — so this list itself can never leak a secret.
 * Deliberately excludes every provider API-key/token/secret variable name
 * (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY, CODEX_ACCESS_TOKEN): a worker
 * authenticates through its own local CLI credential store, not through
 * anything the Factory injects.
 */
export const DEFAULT_WORKER_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  // Codex CLI's own config/auth root (defaults to $HOME/.codex when unset).
  "CODEX_HOME",
];

export interface EnvironmentPolicy {
  readonly allowedVars: readonly string[];
  /** Static overrides layered on top of the allowlisted values. Never put a secret here. */
  readonly extraVars?: Readonly<Record<string, string>>;
}

export const DEFAULT_WORKER_ENVIRONMENT_POLICY: EnvironmentPolicy = Object.freeze({
  allowedVars: DEFAULT_WORKER_ENV_ALLOWLIST,
});

/**
 * Builds the exact environment map a worker child process will receive.
 * Anything not named in `policy.allowedVars` (and not present in `source`)
 * is simply absent — there is no separate "denylist" because the allowlist
 * is already default-deny.
 */
export function buildWorkerEnvironment(
  policy: EnvironmentPolicy,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of policy.allowedVars) {
    const value = source[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return { ...env, ...(policy.extraVars ?? {}) };
}

/**
 * Defense-in-depth, not a substitute for the allowlist above: patterns that
 * look like a leaked credential are masked before captured process output
 * ever becomes Evidence, in case a misbehaving tool echoes one back (e.g. a
 * misconfigured MCP server error message).
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer\s+[A-Za-z0-9._-]{10,}/g,
  /(api[_-]?key|token|secret)\s*[:=]\s*\S+/gi,
];

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}
