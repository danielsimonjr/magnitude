/**
 * Standard environment for spawning shell commands in the agent context.
 * Ensures $M and $PROJECT_ROOT are available to all spawned processes.
 *
 * The host env is passed through `sanitizeAgentEnv` (@magnitudedev/roles), which
 * strips Magnitude's own credentials and any variable whose name looks like a
 * secret (TOKEN, SECRET, PASSWORD, API_KEY, ...). Users can opt specific names
 * back in via MAGNITUDE_AGENT_ENV_PASSTHROUGH=NAME1,NAME2.
 */
import { buildAgentEnv } from '@magnitudedev/roles'

export function agentEnv(cwd: string, scratchpadPath: string): Record<string, string> {
  return buildAgentEnv(cwd, scratchpadPath, process.env)
}
