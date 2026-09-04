import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { escapesViaSymlink, isPhysicallyWithin, resolvePhysicalPath, touchesProtectedPath } from '../path-confinement'

let base: string
let root: string
let outside: string

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'confine-')))
  root = join(base, 'root')
  outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  writeFileSync(join(root, 'ok.txt'), 'ok')
  symlinkSync(outside, join(root, 'dir-link'))
  symlinkSync(join(outside, 'secret.txt'), join(root, 'file-link'))
  symlinkSync(join(outside, 'does-not-exist.txt'), join(root, 'dangling-link'))
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('resolvePhysicalPath', () => {
  test('returns existing paths unchanged', () => {
    expect(resolvePhysicalPath(join(root, 'ok.txt'))).toBe(join(root, 'ok.txt'))
  })

  test('appends non-existent remainder to deepest existing ancestor', () => {
    expect(resolvePhysicalPath(join(root, 'new', 'deep', 'file.txt'))).toBe(join(root, 'new', 'deep', 'file.txt'))
  })

  test('follows symlinked directories', () => {
    expect(resolvePhysicalPath(join(root, 'dir-link', 'new.txt'))).toBe(join(outside, 'new.txt'))
  })

  test('follows symlinked files', () => {
    expect(resolvePhysicalPath(join(root, 'file-link'))).toBe(join(outside, 'secret.txt'))
  })

  test('follows dangling symlinks to their target location', () => {
    expect(resolvePhysicalPath(join(root, 'dangling-link'))).toBe(join(outside, 'does-not-exist.txt'))
  })
})

describe('isPhysicallyWithin / escapesViaSymlink', () => {
  test('plain paths inside root are within', () => {
    expect(isPhysicallyWithin(join(root, 'ok.txt'), [root])).toBe(true)
    expect(isPhysicallyWithin(join(root, 'a', 'b.txt'), [root])).toBe(true)
    expect(escapesViaSymlink(join(root, 'ok.txt'), [root])).toBe(false)
  })

  test('symlinked directory escaping root is denied', () => {
    const target = join(root, 'dir-link', 'evil.txt')
    expect(isPhysicallyWithin(target, [root])).toBe(false)
    expect(escapesViaSymlink(target, [root])).toBe(true)
  })

  test('symlinked file escaping root is denied', () => {
    expect(isPhysicallyWithin(join(root, 'file-link'), [root])).toBe(false)
    expect(escapesViaSymlink(join(root, 'file-link'), [root])).toBe(true)
  })

  test('dangling symlink escaping root is denied', () => {
    expect(isPhysicallyWithin(join(root, 'dangling-link'), [root])).toBe(false)
  })

  test('symlink pointing to another allowed root is fine', () => {
    expect(isPhysicallyWithin(join(root, 'dir-link', 'x.txt'), [root, outside])).toBe(true)
  })

  test('lexically-outside paths are not reported as symlink escapes', () => {
    expect(escapesViaSymlink(join(outside, 'secret.txt'), [root])).toBe(false)
  })
})

describe('touchesProtectedPath', () => {
  test('detects direct and symlinked writes into a protected path', () => {
    expect(touchesProtectedPath(join(outside, 'secret.txt'), [outside])).toBe(true)
    expect(touchesProtectedPath(join(root, 'dir-link', 'rg'), [outside])).toBe(true)
    expect(touchesProtectedPath(join(root, 'ok.txt'), [outside])).toBe(false)
  })
})
