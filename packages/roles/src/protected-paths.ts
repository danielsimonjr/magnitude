import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Locations under `~/.magnitude` that the host process trusts and the agent must
 * never be able to write:
 *
 * - `bin/`        — `rg` is executed by the host (ripgrep resolve)
 * - `skills/`     — `SKILL.md` files are injected into future system prompts
 * - `auth.json`   — credentials
 * - `config.json` — host configuration
 * - `acn/`        — agent coordination network state
 */
export function magnitudeProtectedPaths(home: string = homedir()): string[] {
  const root = join(home, '.magnitude')
  return [
    join(root, 'bin'),
    join(root, 'skills'),
    join(root, 'auth.json'),
    join(root, 'config.json'),
    join(root, 'acn'),
  ]
}

/** Pattern for Magnitude-owned credential variables that must not reach agent shells. */
const MAGNITUDE_SECRET_ENV = /^(MAGNITUDE_API_KEY|EXA_API_KEY|MAGNITUDE_.*_(TOKEN|KEY))$/

/** Return a copy of `env` without Magnitude's own credentials. General user vars are kept. */
export function stripMagnitudeSecrets(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || MAGNITUDE_SECRET_ENV.test(key)) continue
    out[key] = value
  }
  return out
}
