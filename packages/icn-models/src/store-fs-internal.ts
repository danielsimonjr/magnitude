import { mkdirSync, renameSync } from "node:fs"
import { lstatSync } from "node:fs"
import type { InventoryError } from "./_contracts-shim"

export interface OwnedDirectoryDeps {
  quarantine: (path: string) => void
  restrict: (path: string) => void
  ioError: (error: unknown) => InventoryError
}

export const ensureOwnedDirectorySync = (path: string, deps: OwnedDirectoryDeps): void => {
  try {
    const metadata = lstatSync(path)
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      return
    }
    deps.quarantine(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw deps.ioError(error)
    }
  }
  mkdirSync(path, { recursive: true })
  deps.restrict(path)
}
