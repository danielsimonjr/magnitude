/**
 * Filesystem-aware path confinement.
 *
 * Lexical checks (`path.resolve` + prefix compare) can be defeated by symlinks:
 * `<cwd>/link -> /etc` makes `<cwd>/link/passwd` look confined while the write
 * lands outside every allowed root. The helpers here resolve the *physical*
 * location of a write target before it is compared against the roots.
 *
 * This module is the single implementation shared by the roles policy gate
 * (`policy.ts`) and the agent's filesystem tools.
 */

import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

function tryRealpath(p: string): string | null {
  try {
    return realpathSync.native(p)
  } catch {
    return null
  }
}

/**
 * Resolve the physical path a write to `target` would land on.
 *
 * - The deepest existing ancestor is realpath'd (symlinked directories are
 *   followed) and the non-existent remainder is re-appended.
 * - If the leaf itself is a symlink, the link is followed (recursively via
 *   realpath when the destination exists, otherwise by resolving the link
 *   text against the realpath'd parent) so a dangling `link -> /outside/file`
 *   is treated as a write to `/outside/file`.
 *
 * `target` must be absolute. The result is always absolute.
 */
export function resolvePhysicalPath(target: string): string {
  if (!isAbsolute(target)) {
    throw new Error(`resolvePhysicalPath requires an absolute path, got: ${target}`)
  }
  return physical(resolve(target), 0)
}

const MAX_LINK_DEPTH = 40

function physical(p: string, depth: number): string {
  if (depth > MAX_LINK_DEPTH) {
    throw new Error(`Too many levels of symbolic links while resolving ${p}`)
  }

  // Exists (following any symlink chain)? realpath is authoritative.
  const real = tryRealpath(p)
  if (real !== null) return real

  // Does not exist. If it is a dangling symlink, follow the link text so the
  // write is attributed to where it would actually land.
  let isLink = false
  try {
    isLink = lstatSync(p).isSymbolicLink()
  } catch {
    isLink = false
  }
  if (isLink) {
    const linkText = readlinkSync(p)
    const parentReal = physical(dirname(p), depth + 1)
    const dest = isAbsolute(linkText) ? resolve(linkText) : resolve(parentReal, linkText)
    return physical(dest, depth + 1)
  }

  // Plain non-existent entry: resolve the parent physically and re-append.
  const parent = dirname(p)
  if (parent === p) return p
  return join(physical(parent, depth + 1), basename(p))
}

function isUnder(path: string, root: string): boolean {
  const r = root.endsWith(sep) ? root.slice(0, -1) : root
  return path === r || path.startsWith(r + sep)
}

/**
 * True when the physical location of `target` is within one of `roots`
 * (roots are themselves resolved to their physical location so a symlinked
 * root such as macOS `/tmp -> /private/tmp` still matches).
 *
 * `target` and every root must be absolute.
 */
export function isPhysicallyWithin(target: string, roots: readonly string[]): boolean {
  const physical = resolvePhysicalPath(target)
  return roots.some(root => isUnder(physical, resolvePhysicalPath(resolve(root))))
}

/**
 * True when `target` is lexically inside some root but its physical location
 * escapes every root — i.e. a symlink is being used to break confinement.
 */
export function escapesViaSymlink(target: string, roots: readonly string[]): boolean {
  const lexical = resolve(target)
  const lexicallyInside = roots.some(root => isUnder(lexical, resolve(root)))
  if (!lexicallyInside) return false
  return !isPhysicallyWithin(lexical, roots)
}

/**
 * True when the physical location of `target` is within one of `protectedPaths`.
 * Used to deny writes to host-trusted locations regardless of the allowed roots.
 */
export function touchesProtectedPath(target: string, protectedPaths: readonly string[]): boolean {
  const lexical = resolve(target)
  if (protectedPaths.some(p => isUnder(lexical, resolve(p)))) return true
  const physical = resolvePhysicalPath(lexical)
  return protectedPaths.some(p => isUnder(physical, resolvePhysicalPath(resolve(p))))
}
