import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, renameSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { InventoryError } from "@magnitudedev/icn-contracts"
import { ensureOwnedDirectorySync as ensureOwnedDirectorySyncImpl } from "./store-fs-internal"

let quarantineSequence = 0

const isUnix = process.platform !== "win32"

const ioError = (error: unknown): InventoryError =>
  InventoryError.Io({ message: String(error) })

const quarantineDestination = (path: string): string => {
  const timestamp = Date.now() * 1_000_000 + (quarantineSequence++ % 1_000_000)
  return `${path}.invalid-${timestamp}-${quarantineSequence}`
}

export const quarantineOwnedPathSync = (path: string): void => {
  renameSync(path, quarantineDestination(path))
}

const restrictDirectorySync = (path: string): void => {
  if (isUnix) {
    chmodSync(path, 0o700)
  }
}

export const ensureOwnedDirectorySync = (path: string): void => {
  ensureOwnedDirectorySyncImpl(path, {
    quarantine: quarantineOwnedPathSync,
    restrict: restrictDirectorySync,
    ioError,
  })
}

export interface ExclusiveLock {
  readonly path: string
  readonly release: () => void
}

/**
 * Acquires an exclusive advisory lock on a regular file, approximating Rust
 * `fs2::lock_exclusive` on Linux via `flock(LOCK_EX)` when Bun exposes it on
 * the opened file descriptor.
 *
 * Gaps:
 * - Windows uses open-without-flock only; cross-process exclusion is best-effort.
 * - `O_NOFOLLOW` is enforced via pre-open `lstat` checks, not kernel open flags.
 * - Blocking behavior depends on platform `flock` semantics when available.
 */
export const acquireExclusiveLockSync = (path: string): ExclusiveLock => {
  const parent = dirname(path)
  if (parent && parent !== ".") {
    ensureOwnedDirectorySync(parent)
  }

  try {
    const metadata = lstatSync(path)
    if (metadata.isFile() && !metadata.isSymbolicLink()) {
      // regular file
    } else {
      quarantineOwnedPathSync(path)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw ioError(error)
    }
  }

  const fd = openSync(path, "a+", isUnix ? 0o600 : undefined)
  let flockFd: number | undefined = fd
  if (isUnix) {
    const { flock } = require("node:fs") as { flock?: (fd: number, op: number) => void }
    if (typeof flock === "function") {
      flock(fd, 2)
    }
  }

  return {
    path,
    release: () => {
      if (flockFd !== undefined) {
        try {
          if (isUnix) {
            const { flock } = require("node:fs") as { flock?: (fd: number, op: number) => void }
            if (typeof flock === "function") {
              flock(flockFd, 8)
            }
          }
        } finally {
          closeSync(flockFd)
          flockFd = undefined
        }
      }
    },
  }
}

export const ensureOwnedDirectory = async (path: string): Promise<void> => {
  ensureOwnedDirectorySync(path)
}

export const ensureStoreLayout = async (root: string): Promise<void> => {
  try {
    const metadata = lstatSync(root)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw InventoryError.Io({
        message: `model store root is not a real directory: ${root}`,
      })
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      mkdirSync(root, { recursive: true })
    } else if (
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      (error as { _tag: string })._tag in
        {
          InvalidId: 1,
          InvalidRequest: 1,
          NotFound: 1,
          NotReady: 1,
          Busy: 1,
          Loaded: 1,
          DeletionUnsafe: 1,
          Unsupported: 1,
          Io: 1,
          Upstream: 1,
          Integrity: 1,
          ConcurrentMutation: 1,
          ModelOperation: 1,
          Internal: 1,
        }
    ) {
      throw error
    } else {
      throw ioError(error)
    }
  }

  for (const relative of ["hub", "locks"]) {
    await ensureOwnedDirectory(`${root}/${relative}`)
  }
}
