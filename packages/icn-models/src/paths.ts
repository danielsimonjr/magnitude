import { join, posix, win32 } from "node:path"

/**
 * True for POSIX (`/…`) and Windows (`C:\…`, `\\server\share`) absolute paths.
 * Host-platform `path.isAbsolute` alone rejects Windows roots when unit tests
 * run on Linux, and the ICN inventory must accept the host OS form.
 */
export const isAbsoluteFsPath = (value: string): boolean =>
  posix.isAbsolute(value) || win32.isAbsolute(value)

export const hfRepoDir = (repository: string): string =>
  `models--${repository.replaceAll("/", "--")}`

export const repositoryLockPath = (root: string, repository: string): string =>
  join(root, "locks", `repo--${repository.replaceAll("/", "--")}.lock`)
