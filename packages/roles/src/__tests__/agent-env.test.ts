import { describe, test, expect } from 'bun:test'
import { sanitizeAgentEnv, buildAgentEnv, isSecretEnvName } from '../agent-env'

describe('isSecretEnvName', () => {
  test('matches secret-like segments case-insensitively', () => {
    for (const n of [
      'GITHUB_TOKEN', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID',
      'OPENAI_API_KEY', 'ANTHROPIC_APIKEY', 'DB_PASSWORD', 'passwd', 'SSH_PRIVATE_KEY',
      'NPM_AUTH_TOKEN', 'TOKEN', 'secret', 'GOOGLE_CREDENTIALS', 'AZURE_CREDENTIAL_FILE',
      'my_secret_value', 'MAGNITUDE_API_KEY', 'EXA_API_KEY', 'MAGNITUDE_ACN_TOKEN', 'MAGNITUDE_FOO_KEY',
    ]) expect(isSecretEnvName(n), n).toBe(true)
  })

  test('does not match segment-embedded words or baseline vars', () => {
    for (const n of [
      'TOKENIZERS_PARALLELISM', 'TOKENIZER', 'SECRETARY', 'PASSWORDLESS_LOGIN', 'MYTOKEN',
      'PATH', 'HOME', 'SHELL', 'LANG', 'TERM', 'USER', 'TMPDIR',
      'npm_config_token', 'npm_config_registry', 'MAGNITUDE_MODEL', 'MAGNITUDE_PROFILE', 'EDITOR',
    ]) expect(isSecretEnvName(n), n).toBe(false)
  })
})

describe('sanitizeAgentEnv', () => {
  test('strips secrets, keeps everything else, drops undefined', () => {
    const env = sanitizeAgentEnv({
      GITHUB_TOKEN: 'x', GH_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'x', OPENAI_API_KEY: 'x',
      MAGNITUDE_API_KEY: 'x', EXA_API_KEY: 'x', MAGNITUDE_ACN_TOKEN: 'x', MAGNITUDE_SOMETHING_KEY: 'x',
      TOKENIZERS_PARALLELISM: 'false', PATH: '/bin', HOME: '/home/u', MAGNITUDE_MODEL: 'keep',
      npm_config_token: 'keep', UNDEFINED_ONE: undefined,
    })
    expect(env).toEqual({
      TOKENIZERS_PARALLELISM: 'false', PATH: '/bin', HOME: '/home/u', MAGNITUDE_MODEL: 'keep',
      npm_config_token: 'keep',
    })
  })

  test('honors MAGNITUDE_AGENT_ENV_PASSTHROUGH and does not forward it', () => {
    const env = sanitizeAgentEnv({
      MAGNITUDE_AGENT_ENV_PASSTHROUGH: 'GH_TOKEN, NPM_TOKEN,,',
      GH_TOKEN: 'keep', NPM_TOKEN: 'keep', GITHUB_TOKEN: 'strip', MAGNITUDE_API_KEY: 'strip',
    })
    expect(env).toEqual({ GH_TOKEN: 'keep', NPM_TOKEN: 'keep' })
  })

  test('passthrough is exact-name (case-sensitive)', () => {
    const env = sanitizeAgentEnv({ MAGNITUDE_AGENT_ENV_PASSTHROUGH: 'gh_token', GH_TOKEN: 'strip' })
    expect(env).toEqual({})
  })
})

describe('buildAgentEnv', () => {
  test('adds NO_COLOR, PROJECT_ROOT and M on top of the sanitized env', () => {
    const env = buildAgentEnv('/proj', '/scratch', { PATH: '/bin', GH_TOKEN: 'x' })
    expect(env).toEqual({ PATH: '/bin', NO_COLOR: '1', PROJECT_ROOT: '/proj', M: '/scratch' })
  })
})
