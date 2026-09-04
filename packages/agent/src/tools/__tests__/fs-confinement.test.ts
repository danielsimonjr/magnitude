import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Effect, Layer } from 'effect'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { editTool, writeTool } from '../fs'
import { Fs, FsLive } from '../../services/fs'
import { WorkingDirectoryTag } from '../../execution/working-directory'

let base: string
let cwd: string
let scratchpad: string
let outside: string

beforeAll(() => {
  // Not under /tmp: /tmp is an allowed write location by design.
  base = realpathSync(mkdtempSync(join(homedir(), '.fs-confinement-test-')))
  cwd = join(base, 'project')
  scratchpad = join(base, 'scratch')
  outside = join(base, 'outside')
  mkdirSync(cwd)
  mkdirSync(scratchpad)
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'top secret')
  writeFileSync(join(cwd, 'inside.txt'), 'hello world')
  symlinkSync(outside, join(cwd, 'dir-link'))
  symlinkSync(join(outside, 'secret.txt'), join(cwd, 'file-link'))
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

const run = <A, E>(eff: Effect.Effect<A, E, Fs | WorkingDirectoryTag>) => {
  const layer = Layer.merge(FsLive, Layer.succeed(WorkingDirectoryTag, { cwd, scratchpadPath: scratchpad }))
  return Effect.runPromise(Effect.either(Effect.provide(eff, layer)))
}

function emitCtx() {
  const emissions: unknown[] = []
  const ctx = { emit: (e: unknown) => Effect.sync(() => { emissions.push(e) }) } as any
  return { ctx, emissions }
}

describe('write tool confinement', () => {
  test('writes inside cwd and scratchpad succeed', async () => {
    const { ctx } = emitCtx()
    const a = await run(writeTool.execute({ path: 'new.txt', content: 'x' }, ctx))
    const b = await run(writeTool.execute({ path: '$M/note.md', content: 'y' }, ctx))
    expect(a._tag).toBe('Right')
    expect(b._tag).toBe('Right')
    expect(readFileSync(join(cwd, 'new.txt'), 'utf8')).toBe('x')
    expect(readFileSync(join(scratchpad, 'note.md'), 'utf8')).toBe('y')
  })

  test('write through a symlinked directory escaping cwd is denied', async () => {
    const { ctx } = emitCtx()
    const r = await run(writeTool.execute({ path: 'dir-link/evil.txt', content: 'x' }, ctx))
    expect(r._tag).toBe('Left')
    expect(existsSync(join(outside, 'evil.txt'))).toBe(false)
  })

  test('write through a symlinked file escaping cwd is denied', async () => {
    const { ctx } = emitCtx()
    const r = await run(writeTool.execute({ path: 'file-link', content: 'overwritten' }, ctx))
    expect(r._tag).toBe('Left')
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('top secret')
  })
})

describe('edit tool confinement', () => {
  test('edit through symlink escaping cwd is denied', async () => {
    const { ctx } = emitCtx()
    const r = await run(editTool.execute({ path: 'file-link', old: 'top', new: 'not', replaceAll: false }, ctx))
    expect(r._tag).toBe('Left')
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('top secret')
  })

  test('onInput emits base content for confined paths', async () => {
    const { ctx, emissions } = emitCtx()
    const r = await run(editTool.stream!.onInput({ path: { value: 'inside.txt', isFinal: true } } as any, { emitted: false }, ctx))
    expect(r._tag).toBe('Right')
    expect(emissions).toHaveLength(1)
    expect((emissions[0] as any).baseContent).toBe('hello world')
  })

  test('onInput emits nothing for paths outside the allowed roots', async () => {
    for (const p of [join(outside, 'secret.txt'), 'file-link', 'dir-link/secret.txt', '../outside/secret.txt']) {
      const { ctx, emissions } = emitCtx()
      const r = await run(editTool.stream!.onInput({ path: { value: p, isFinal: true } } as any, { emitted: false }, ctx))
      expect(r._tag).toBe('Right')
      expect(emissions).toHaveLength(0)
    }
  })
})
