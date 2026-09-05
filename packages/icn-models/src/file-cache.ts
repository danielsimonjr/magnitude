import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { chmodSync, lstatSync } from "node:fs"

let temporarySequence = 0

const isUnix = process.platform !== "win32"

const createPrivateDirectories = (path: string): boolean => {
  try {
    mkdirSync(path, { recursive: true })
    if (isUnix) {
      chmodSync(path, 0o700)
    }
    return true
  } catch {
    return false
  }
}

const writePrivateFile = (path: string, bytes: Uint8Array): boolean => {
  try {
    const fd = openSync(path, "wx", isUnix ? 0o600 : undefined)
    try {
      writeFileSync(fd, bytes)
      return true
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

const temporaryPath = (parent: string, path: string): string => {
  const name = path.split("/").pop() ?? "cache"
  const sequence = temporarySequence++
  return join(parent, `.${name}.tmp-${process.pid}-${sequence}`)
}

/** Reads a bounded regular file. Every filesystem and size failure is a cache miss. */
export const readBytes = (path: string, maximumBytes: number): Uint8Array | undefined => {
  try {
    const metadata = lstatSync(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
      return undefined
    }
    const bytes = readFileSync(path)
    if (bytes.length > maximumBytes) {
      return undefined
    }
    return bytes
  } catch {
    return undefined
  }
}

/** Reads and decodes one bounded JSON recovery unit. */
export const readJson = <T>(path: string, maximumBytes: number): T | undefined => {
  const bytes = readBytes(path, maximumBytes)
  if (bytes === undefined) {
    return undefined
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T
  } catch {
    return undefined
  }
}

/** Reads a bounded JSON object. */
export const readObject = (path: string, maximumBytes: number): Record<string, unknown> | undefined => {
  const value = readJson<unknown>(path, maximumBytes)
  if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

export const recoverSection = <T>(object: Record<string, unknown>, key: string): T | undefined => {
  const value = object[key]
  delete object[key]
  if (value === undefined) {
    return undefined
  }
  return value as T
}

export const recoverMap = <T>(
  value: unknown,
  maximumEntries: number,
): Map<string, T> => {
  const result = new Map<string, T>()
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return result
  }
  const entries = Object.entries(value as Record<string, unknown>).slice(0, maximumEntries)
  for (const [key, entry] of entries) {
    if (entry !== undefined) {
      result.set(key, entry as T)
    }
  }
  return result
}

export const recoverArray = <T>(value: unknown, maximumEntries: number): T[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value.slice(0, maximumEntries).filter((entry): entry is T => entry !== undefined)
}

const tryLockExclusive = (lockPath: string): number | undefined => {
  try {
    const metadata = lstatSync(lockPath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return undefined
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return undefined
    }
  }

  try {
    const fd = openSync(lockPath, "a+", isUnix ? 0o600 : undefined)
    if (isUnix) {
      const { flock } = require("node:fs") as { flock?: (fd: number, op: number) => void }
      if (typeof flock === "function") {
        flock(fd, 2 /* LOCK_EX */)
        return fd
      }
    }
    return fd
  } catch {
    return undefined
  }
}

const unlock = (fd: number): void => {
  try {
    if (isUnix) {
      const { flock } = require("node:fs") as { flock?: (fd: number, op: number) => void }
      if (typeof flock === "function") {
        flock(fd, 8 /* LOCK_UN */)
      }
    }
  } finally {
    closeSync(fd)
  }
}

/** Publishes bounded bytes as a complete replacement. Failure is intentionally invisible. */
export const writeBytesAtomic = (
  path: string,
  lockPath: string,
  bytes: Uint8Array,
  maximumBytes: number,
): void => {
  if (bytes.length > maximumBytes) {
    return
  }
  const parent = dirname(path)
  const lockParent = dirname(lockPath)
  if (parent.length === 0 || lockParent.length === 0) {
    return
  }
  if (!createPrivateDirectories(parent) || !createPrivateDirectories(lockParent)) {
    return
  }
  const fd = tryLockExclusive(lockPath)
  if (fd === undefined) {
    return
  }
  const temporary = temporaryPath(parent, path)
  const persisted = writePrivateFile(temporary, bytes) && (() => {
    try {
      renameSync(temporary, path)
      return true
    } catch {
      return false
    }
  })()
  if (!persisted) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // ignore
    }
  }
  unlock(fd)
}

/** Publishes a complete JSON replacement atomically when possible. */
export const writeJsonAtomic = <T>(
  path: string,
  lockPath: string,
  value: T,
  maximumBytes: number,
): void => {
  let bytes: Uint8Array
  try {
    const encoded = new TextEncoder().encode(JSON.stringify(value, null, 2))
    if (encoded.length > maximumBytes) {
      return
    }
    bytes = encoded
  } catch {
    return
  }
  writeBytesAtomic(path, lockPath, bytes, maximumBytes)
}
