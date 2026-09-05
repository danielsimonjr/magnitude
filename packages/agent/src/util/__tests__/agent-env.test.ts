import { describe, test, expect } from 'bun:test'
import { agentEnv } from '../agent-env'

describe('agentEnv', () => {
  test('strips Magnitude credentials but keeps user variables', () => {
    const saved = { ...process.env }
    try {
      process.env.MAGNITUDE_API_KEY = 'secret'
      process.env.EXA_API_KEY = 'secret'
      process.env.MAGNITUDE_ACN_TOKEN = 'secret'
      process.env.MAGNITUDE_FOO_KEY = 'secret'
      process.env.GH_TOKEN = 'user-token'
      process.env.MAGNITUDE_PROFILE = 'default'

      const env = agentEnv('/proj', '/scratch')
      expect(env.MAGNITUDE_API_KEY).toBeUndefined()
      expect(env.EXA_API_KEY).toBeUndefined()
      expect(env.MAGNITUDE_ACN_TOKEN).toBeUndefined()
      expect(env.MAGNITUDE_FOO_KEY).toBeUndefined()
      expect(env.GH_TOKEN).toBe('user-token')
      expect(env.MAGNITUDE_PROFILE).toBe('default')
      expect(env.PROJECT_ROOT).toBe('/proj')
      expect(env.M).toBe('/scratch')
      expect(env.NO_COLOR).toBe('1')
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  })
})
