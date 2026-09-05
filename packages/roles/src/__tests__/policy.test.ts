import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Effect } from 'effect'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ToolCallId } from '@magnitudedev/ai'
import { denyWritesOutside, denyWritesToProtectedPaths } from '../policy'
import { magnitudeProtectedPaths } from '../protected-paths'
import { createRoles } from '../roles/index'

let base: string
let cwd: string
let scratchpad: string
let fakeHome: string

beforeAll(() => {
  // Not under /tmp: the shell-classifier allowlists /tmp for writes, which would mask denials.
  base = realpathSync(mkdtempSync(join(homedir(), '.roles-policy-test-')))
  cwd = join(base, 'project')
  scratchpad = join(base, 'scratch')
  fakeHome = join(base, 'home')
  mkdirSync(cwd)
  mkdirSync(scratchpad)
  mkdirSync(join(fakeHome, '.magnitude', 'bin'), { recursive: true })
  mkdirSync(join(fakeHome, '.magnitude', 'skills'), { recursive: true })
  symlinkSync(join(fakeHome, '.magnitude', 'bin'), join(cwd, 'bin-link'))
  symlinkSync(join(base, 'elsewhere'), join(cwd, 'out-link'))
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

function ctx(toolKey: string, path: string, overrides: Record<string, unknown> = {}) {
  return {
    toolCallId: 'call-1' as ToolCallId,
    toolName: toolKey,
    toolKey,
    input: { path },
    policyContext: { cwd, scratchpadPath: scratchpad, ...overrides },
  }
}

const run = <A>(eff: Effect.Effect<A>) => Effect.runPromise(eff)

describe('denyWritesOutside', () => {
  const rule = denyWritesOutside(c => [c.cwd, c.scratchpadPath])

  test('allows writes inside cwd and scratchpad', async () => {
    expect(await run(rule(ctx('fileWrite', 'src/a.ts')))).toBeNull()
    expect(await run(rule(ctx('fileEdit', '$M/notes.md')))).toBeNull()
  })

  test('denies lexical escape', async () => {
    const d = await run(rule(ctx('fileWrite', '../elsewhere/x.txt')))
    expect(d?._tag).toBe('Deny')
  })

  test('denies symlink escape from cwd', async () => {
    const d = await run(rule(ctx('fileWrite', 'out-link/x.txt')))
    expect(d?._tag).toBe('Deny')
  })

  test('abstains when cwd safeguards are disabled', async () => {
    expect(await run(rule(ctx('fileWrite', 'out-link/x.txt', { disableCwdSafeguards: true })))).toBeNull()
  })
})

describe('denyWritesToProtectedPaths', () => {
  const rule = denyWritesToProtectedPaths(() => magnitudeProtectedPaths(fakeHome))

  test('denies direct writes to ~/.magnitude/bin, skills, auth.json, config.json, acn', async () => {
    for (const rel of ['bin/rg', 'skills/evil/SKILL.md', 'auth.json', 'config.json', 'acn/state.json']) {
      const d = await run(rule(ctx('fileWrite', join(fakeHome, '.magnitude', rel))))
      expect(d?._tag).toBe('Deny')
    }
  })

  test('denies symlinked writes into a protected path even when lexically inside cwd', async () => {
    const d = await run(rule(ctx('fileEdit', 'bin-link/rg')))
    expect(d?._tag).toBe('Deny')
  })

  test('applies even when cwd safeguards are disabled', async () => {
    const d = await run(rule(ctx('fileWrite', join(fakeHome, '.magnitude', 'bin', 'rg'), { disableCwdSafeguards: true })))
    expect(d?._tag).toBe('Deny')
  })

  test('abstains for other paths and non-file tools', async () => {
    expect(await run(rule(ctx('fileWrite', 'src/a.ts')))).toBeNull()
    expect(await run(rule(ctx('fileWrite', join(fakeHome, '.magnitude', 'sessions', 's1', 'x.txt'))))).toBeNull()
    expect(await run(rule(ctx('shell', join(fakeHome, '.magnitude', 'bin', 'rg'))))).toBeNull()
  })
})

describe('role policies', () => {
  test('every role denies writes under ~/.magnitude that are not the scratchpad', async () => {
    const home = process.env.HOME ?? ''
    for (const role of Object.values(createRoles())) {
      let decision: { _tag: string } | null = null
      for (const rule of role.policy) {
        decision = await run(rule(ctx('fileWrite', join(home, '.magnitude', 'skills', 'x', 'SKILL.md'))))
        if (decision !== null) break
      }
      expect(decision?._tag).toBe('Deny')
    }
  })
})
