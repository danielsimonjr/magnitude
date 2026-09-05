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
