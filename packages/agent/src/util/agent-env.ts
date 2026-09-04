/**
 * Standard environment for spawning shell commands in the agent context.
 * Ensures $M and $PROJECT_ROOT are available to all spawned processes.
 *
 * Magnitude's own credentials (MAGNITUDE_API_KEY, EXA_API_KEY, MAGNITUDE_*_TOKEN,
 * MAGNITUDE_*_KEY) are stripped so agent-run shells cannot read or exfiltrate them.
 * General user variables (e.g. GH_TOKEN) are intentionally preserved.
 */
import { stripMagnitudeSecrets } from '@magnitudedev/roles'

export function agentEnv(cwd: string, scratchpadPath: string): Record<string, string> {
  return {
    ...stripMagnitudeSecrets(process.env),
    NO_COLOR: '1',
    PROJECT_ROOT: cwd,
    M: scratchpadPath,
  }
}
