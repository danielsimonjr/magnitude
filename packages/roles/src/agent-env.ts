/**
 * Agent shell environment sanitization.
 *
 * Every shell the agent runs (the `shell` tool, policy path-expansion, ACN
 * skill shells) inherits from the host `process.env`. The host commonly has
 * credentials loaded — Magnitude's own keys, and whatever the user exported
 * for other tools (GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, ...). A model-driven
 * shell must not be able to read or exfiltrate any of those, so the policy is:
 *
 * 1. Drop the explicit Magnitude credential names (`MAGNITUDE_SECRET_ENV`).
 * 2. Drop any variable whose NAME contains a secret-like word as a `_`-delimited
 *    segment, case-insensitively (`SECRET_ENV_NAME`): SECRET, PASSWORD, PASSWD,
 *    PRIVATE_KEY, ACCESS_KEY, API_KEY, APIKEY, AUTH_TOKEN, TOKEN, CREDENTIAL(S).
 *    Segment matching means `GITHUB_TOKEN` and `GH_TOKEN` are stripped while
 *    `TOKENIZERS_PARALLELISM` (no `_` boundary after TOKEN) is kept.
 * 3. Never drop the baseline shell variables (`ALWAYS_KEEP_ENV`) or `npm_config_*`.
 * 4. Names listed, comma-separated, in `MAGNITUDE_AGENT_ENV_PASSTHROUGH` are
 *    kept even if they match rule 1 or 2 — the user's explicit opt-in.
 *    The passthrough variable itself is not forwarded.
 */

/** Explicit Magnitude-owned credential variables that must never reach agent shells. */
export const MAGNITUDE_SECRET_ENV = /^(MAGNITUDE_API_KEY|EXA_API_KEY|MAGNITUDE_.*_(TOKEN|KEY))$/

/** Secret-like name segments, matched case-insensitively at `_` boundaries. */
export const SECRET_ENV_NAME =
  /(^|_)(SECRET|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|API_KEY|APIKEY|AUTH_TOKEN|TOKEN|CREDENTIALS?)(_|$)/i

/** Baseline variables a shell needs; never stripped regardless of name. */
export const ALWAYS_KEEP_ENV: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'SHELL', 'LANG', 'TERM', 'USER', 'TMPDIR',
])

/** Variable holding the comma-separated user allowlist. */
export const AGENT_ENV_PASSTHROUGH_VAR = 'MAGNITUDE_AGENT_ENV_PASSTHROUGH'

/** Parse the passthrough allowlist from an env map. Exact (case-sensitive) names. */
export function parseAgentEnvPassthrough(env: Record<string, string | undefined>): ReadonlySet<string> {
  const raw = env[AGENT_ENV_PASSTHROUGH_VAR] ?? ''
  return new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))
}

/** True if a variable with this name must be withheld from agent shells (before passthrough). */
export function isSecretEnvName(name: string): boolean {
  if (ALWAYS_KEEP_ENV.has(name) || name.startsWith('npm_config_')) return false
  return MAGNITUDE_SECRET_ENV.test(name) || SECRET_ENV_NAME.test(name)
}

/**
 * Return a copy of `env` safe to hand to an agent-run shell: undefined values,
 * secret-like variables (see module docs) and the passthrough list itself are
 * removed; everything else is kept.
 */
export function sanitizeAgentEnv(env: Record<string, string | undefined>): Record<string, string> {
  const passthrough = parseAgentEnvPassthrough(env)
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (key === AGENT_ENV_PASSTHROUGH_VAR) continue
    if (isSecretEnvName(key) && !passthrough.has(key)) continue
    out[key] = value
  }
  return out
}

/** @deprecated Use `sanitizeAgentEnv`. Kept as an alias for one release. */
export const stripMagnitudeSecrets = sanitizeAgentEnv

/**
 * Build the standard environment for spawning a shell in the agent context:
 * sanitized host env plus `NO_COLOR`, `PROJECT_ROOT` and `M` (scratchpad).
 */
export function buildAgentEnv(
  cwd: string,
  scratchpadPath: string,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return {
    ...sanitizeAgentEnv(env),
    NO_COLOR: '1',
    PROJECT_ROOT: cwd,
    M: scratchpadPath,
  }
}
