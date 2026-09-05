import { describe, test, expect } from 'bun:test'
import { agentEnv } from '../agent-env'

function withEnv(vars: Record<string, string>, fn: () => void) {
  const saved = { ...process.env }
  try {
    Object.assign(process.env, vars)
    fn()
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  }
}

describe('agentEnv', () => {
  test('strips Magnitude and secret-like credentials but keeps ordinary variables', () => {
    withEnv({
      MAGNITUDE_API_KEY: 'secret',
      EXA_API_KEY: 'secret',
      MAGNITUDE_ACN_TOKEN: 'secret',
      MAGNITUDE_FOO_KEY: 'secret',
      GH_TOKEN: 'secret',
      GITHUB_TOKEN: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
      TOKENIZERS_PARALLELISM: 'false',
      MAGNITUDE_PROFILE: 'default',
    }, () => {
      const env = agentEnv('/proj', '/scratch')
      expect(env.MAGNITUDE_API_KEY).toBeUndefined()
      expect(env.EXA_API_KEY).toBeUndefined()
      expect(env.MAGNITUDE_ACN_TOKEN).toBeUndefined()
      expect(env.MAGNITUDE_FOO_KEY).toBeUndefined()
      expect(env.GH_TOKEN).toBeUndefined()
      expect(env.GITHUB_TOKEN).toBeUndefined()
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
      expect(env.TOKENIZERS_PARALLELISM).toBe('false')
      expect(env.MAGNITUDE_PROFILE).toBe('default')
      expect(env.PATH).toBe(process.env.PATH ?? '')
      expect(env.PROJECT_ROOT).toBe('/proj')
      expect(env.M).toBe('/scratch')
      expect(env.NO_COLOR).toBe('1')
    })
  })

  test('honors MAGNITUDE_AGENT_ENV_PASSTHROUGH', () => {
    withEnv({ MAGNITUDE_AGENT_ENV_PASSTHROUGH: 'GH_TOKEN', GH_TOKEN: 'user-token', GITHUB_TOKEN: 'x' }, () => {
      const env = agentEnv('/proj', '/scratch')
      expect(env.GH_TOKEN).toBe('user-token')
      expect(env.GITHUB_TOKEN).toBeUndefined()
      expect(env.MAGNITUDE_AGENT_ENV_PASSTHROUGH).toBeUndefined()
    })
  })
})
