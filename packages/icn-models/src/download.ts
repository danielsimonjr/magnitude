import { createHash } from "node:crypto"
import { closeSync, ftruncateSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { lstatSync } from "node:fs"
import { ContentIdentity, type DownloadFailure, type ModelComponent } from "./_contracts-shim"
import { ensureOwnedDirectory } from "./store-fs"
import { quarantineOwnedPathSync } from "./store-fs"

export const INTEGRITY_CHECKPOINT_INTERVAL = 256 * 1024 * 1024
const MAX_INTEGRITY_RECORD_BYTES = 4 * 1024

export interface DownloadComponentPaths {
  partial: string
  blob: string
  checkpoint: string
}

export interface DownloadIntegrityRecord {
  content: ContentIdentity
  expected_size: number
  completed_bytes: number
  sha256_state: string | null
}

export class DownloadIntegrity {
  private digest: ReturnType<typeof createHash> | null
  bytes = 0
  checkpointedBytes = 0

  private constructor(digest: ReturnType<typeof createHash> | null, bytes: number, checkpointedBytes: number) {
    this.digest = digest
    this.bytes = bytes
    this.checkpointedBytes = checkpointedBytes
  }

  static empty(component: ModelComponent): DownloadIntegrity {
    const digest = component.content._tag === "Sha256" ? createHash("sha256") : null
    return new DownloadIntegrity(digest, 0, 0)
  }

  static restore(
    component: ModelComponent,
    record: DownloadIntegrityRecord,
    partialBytes?: Uint8Array,
  ): DownloadIntegrity | undefined {
    if (
      !ContentIdentity.equals(record.content, component.content) ||
      record.expected_size !== component.size_bytes ||
      record.completed_bytes > component.size_bytes
    ) {
      return undefined
    }
    const digest = component.content._tag === "Sha256" ? createHash("sha256") : null
    if (digest !== null && partialBytes !== undefined && partialBytes.length === record.completed_bytes) {
      digest.update(partialBytes)
    } else if (record.completed_bytes > 0 && component.content._tag === "Sha256") {
      return undefined
    }
    return new DownloadIntegrity(digest, record.completed_bytes, record.completed_bytes)
  }

  update(bytes: Uint8Array): void {
    this.bytes += bytes.length
    this.digest?.update(bytes)
  }

  record(component: ModelComponent): DownloadIntegrityRecord {
    return {
      content: component.content,
      expected_size: component.size_bytes,
      completed_bytes: this.bytes,
      sha256_state: this.digest !== null && this.bytes === 0 ? "" : null,
    }
  }

  needsCheckpoint(): boolean {
    return this.bytes - this.checkpointedBytes >= INTEGRITY_CHECKPOINT_INTERVAL
  }

  markCheckpointed(): void {
    this.checkpointedBytes = this.bytes
  }

  verify(component: ModelComponent): DownloadError | undefined {
    if (this.bytes !== component.size_bytes) {
      return DownloadError.integrity(`unexpected size for ${component.path}`)
    }
    if (component.content._tag !== "Sha256") {
      return undefined
    }
    const actual = this.digest?.digest("hex")
    if (actual !== component.content.value) {
      return DownloadError.integrity(`SHA-256 mismatch for ${component.path}`, false, false)
    }
    return undefined
  }
}

export type DownloadErrorKind =
  | "Cancelled"
  | "InsufficientDiskSpace"
  | "SourceUnavailable"
  | "SourceAccessDenied"
  | "MissingSource"
  | "Network"
  | "Integrity"
  | "FileSystem"
  | "InvalidRequest"
  | "Internal"

export class DownloadError extends Error {
  readonly kind: DownloadErrorKind
  readonly retryable: boolean
  readonly resumable: boolean

  private constructor(
    kind: DownloadErrorKind,
    message: string,
    retryable: boolean,
    resumable: boolean,
  ) {
    super(message)
    this.kind = kind
    this.retryable = retryable
    this.resumable = resumable
  }

  static integrity(message: string, retryable = true, resumable = true): DownloadError {
    return new DownloadError("Integrity", message, retryable, resumable)
  }

  static filesystem(message: string): DownloadError {
    return new DownloadError("FileSystem", message, true, true)
  }

  static sourceUnavailable(message: string, retryable = true, resumable = false): DownloadError {
    return new DownloadError("SourceUnavailable", message, retryable, resumable)
  }

  toFailure(): DownloadFailure | undefined {
    switch (this.kind) {
      case "Cancelled":
        return undefined
      case "InsufficientDiskSpace":
        return undefined
      case "SourceUnavailable":
      case "SourceAccessDenied":
      case "MissingSource":
        return { _tag: "SourceUnavailable" }
      case "Network":
        return { _tag: "NetworkUnavailable" }
      case "Integrity":
        return { _tag: "CorruptDownload" }
      case "FileSystem":
        return { _tag: "LocalStorageFailure" }
      case "InvalidRequest":
      case "Internal":
        return { _tag: "Internal", message: this.message }
    }
  }
}

export const blobKey = (content: ContentIdentity): string => {
  switch (content._tag) {
    case "Sha256":
      return `lfs-sha256-${content.value}`
    case "Xet":
      return `xet-${content.value}`
    case "GitOid":
      return `git-oid-${content.value}`
    case "FileIdentity":
      return `file-${content.value}`
    case "Unknown":
      return "unknown"
  }
}

export const componentPaths = (blobs: string, contentKey: string): DownloadComponentPaths => ({
  blob: join(blobs, contentKey),
  partial: join(blobs, `${contentKey}.incomplete`),
  checkpoint: join(blobs, `${contentKey}.integrity`),
})

export const readIntegrityRecord = (path: string): DownloadIntegrityRecord | undefined => {
  try {
    const metadata = lstatSync(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_INTEGRITY_RECORD_BYTES) {
      return undefined
    }
    return JSON.parse(readFileSync(path, "utf8")) as DownloadIntegrityRecord
  } catch {
    return undefined
  }
}

export const atomicJson = async (path: string, value: unknown): Promise<void> => {
  const bytes = JSON.stringify(value, null, 2)
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temporary, bytes)
  renameSync(temporary, path)
  await syncParent(path)
}

const syncParent = async (path: string): Promise<void> => {
  const parent = dirname(path)
  if (parent.length === 0) return
  const fd = openSync(parent, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export const regularFileLen = (path: string): number | undefined => {
  try {
    const metadata = lstatSync(path)
    return metadata.isFile() && !metadata.isSymbolicLink() ? metadata.size : undefined
  } catch {
    return undefined
  }
}

export const discardComponentFiles = async (paths: DownloadComponentPaths): Promise<void> => {
  for (const path of [paths.partial, paths.blob, paths.checkpoint]) {
    try {
      const metadata = lstatSync(path)
      if (metadata.isFile() && !metadata.isSymbolicLink()) {
        rmSync(path)
      } else {
        await quarantine(path)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw DownloadError.filesystem(String(error))
      }
    }
  }
}

export const recoverPartial = async (
  paths: DownloadComponentPaths,
  component: ModelComponent,
): Promise<DownloadIntegrity> => {
  const partialLen = regularFileLen(paths.partial)
  const record = readIntegrityRecord(paths.checkpoint)
  if (partialLen === undefined || record === undefined) {
    if (partialLen !== undefined || exists(paths.checkpoint)) {
      await discardComponentFiles(paths)
    }
    return DownloadIntegrity.empty(component)
  }
  const partialBytes =
    partialLen > 0 ? readFileSync(paths.partial).subarray(0, record.completed_bytes) : undefined
  const restored = DownloadIntegrity.restore(component, record, partialBytes)
  if (restored === undefined || partialLen < restored.bytes) {
    await discardComponentFiles(paths)
    return DownloadIntegrity.empty(component)
  }
  if (partialLen > restored.bytes) {
    truncateFile(paths.partial, restored.bytes)
  }
  return restored
}

const exists = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

const truncateFile = (path: string, length: number): void => {
  const fd = openSync(path, "r+")
  try {
    ftruncateSync(fd, length)
  } finally {
    closeSync(fd)
  }
}

export const recoverCompletedBlob = async (
  paths: DownloadComponentPaths,
  component: ModelComponent,
): Promise<boolean> => {
  const blobLen = regularFileLen(paths.blob)
  if (blobLen !== component.size_bytes) {
    await discardComponentFiles(paths)
    return false
  }
  const record = readIntegrityRecord(paths.checkpoint)
  const partialBytes =
    blobLen !== undefined && blobLen > 0 ? readFileSync(paths.blob) : undefined
  const restored = record === undefined ? undefined : DownloadIntegrity.restore(component, record, partialBytes)
  if (
    restored !== undefined &&
    restored.bytes === component.size_bytes &&
    restored.verify(component) === undefined
  ) {
    return true
  }
  await discardComponentFiles(paths)
  return false
}

export interface ResolvedRemoteMetadata {
  size: number
  sha256: string | null
}

export const validateEquivalentFile = (
  repository: string,
  pinned: string,
  observed: string,
  expected: ModelComponent,
  metadata: ResolvedRemoteMetadata,
): DownloadError | undefined => {
  if (metadata.size !== expected.size_bytes) {
    return packageUnavailable(repository, pinned, observed, expected.path, "current main reports a different file size")
  }
  if (
    metadata.sha256 === null ||
    (expected.content._tag === "Sha256" &&
      metadata.sha256.toLowerCase() !== expected.content.value.toLowerCase())
  ) {
    return packageUnavailable(repository, pinned, observed, expected.path, "current main reports different file content")
  }
  return undefined
}

export const missingUpstreamContent = (error: DownloadError): boolean => error.kind === "MissingSource"

const packageUnavailable = (
  repository: string,
  pinned: string,
  observed: string,
  path: string,
  reason: string,
): DownloadError =>
  DownloadError.sourceUnavailable(
    `the publisher no longer provides the catalog package at ${path}: ${reason}`,
    true,
    false,
  )

export const publishPackageSnapshot = async (
  repoRoot: string,
  snapshot: string,
  commit: string,
  components: readonly ModelComponent[],
): Promise<void> => {
  const incomplete = join(repoRoot, ".incomplete")
  const snapshots = join(repoRoot, "snapshots")
  await ensureOwnedDirectory(incomplete)
  await ensureOwnedDirectory(snapshots)

  try {
    const metadata = lstatSync(snapshot)
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      for (const component of components) {
        await publishSnapshotLink(repoRoot, snapshot, component)
      }
      await syncDirectory(snapshot)
      return
    }
    await quarantine(snapshot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw DownloadError.filesystem(String(error))
    }
  }

  const stagedSnapshot = join(incomplete, `snapshot-${commit}`)
  await quarantine(stagedSnapshot)
  await ensureOwnedDirectory(stagedSnapshot)
  for (const component of components) {
    await publishSnapshotLink(repoRoot, stagedSnapshot, component)
  }
  renameSync(stagedSnapshot, snapshot)
  await syncParent(snapshot)
}

const publishSnapshotLink = async (
  repoRoot: string,
  snapshot: string,
  component: ModelComponent,
): Promise<void> => {
  const destination = join(snapshot, component.path)
  const parent = dirname(destination)
  if (parent !== snapshot) {
    const relativePath = relative(snapshot, parent)
    let current = snapshot
    for (const segment of relativePath.split("/").filter(Boolean)) {
      current = join(current, segment)
      await ensureOwnedDirectory(current)
    }
  }
  const blob = join(repoRoot, "blobs", blobKey(component.content))
  const blobMetadata = lstatSync(blob)
  if (!blobMetadata.isFile() || blobMetadata.isSymbolicLink()) {
    throw DownloadError.filesystem(`verified blob is not a regular file: ${blob}`)
  }
  try {
    lstatSync(destination)
    const existing = realpath(destination)
    const expected = realpath(blob)
    if (existing !== expected) {
      quarantineOwnedPathSync(destination)
      createSymlink(blob, destination)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      createSymlink(blob, destination)
    } else {
      throw DownloadError.filesystem(String(error))
    }
  }
}

const realpath = (path: string): string => {
  try {
    return require("node:fs").realpathSync(path)
  } catch {
    return path
  }
}

const createSymlink = (blob: string, destination: string): void => {
  if (process.platform === "win32") {
    require("node:fs").linkSync(blob, destination)
  } else {
    const rel = pathDiff(blob, dirname(destination))
    symlinkSync(rel, destination)
  }
}

const pathDiff = (path: string, base: string): string => relative(base, path)

const syncDirectory = async (path: string): Promise<void> => {
  const fd = openSync(path, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

const quarantine = async (path: string): Promise<void> => {
  try {
    lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return
    }
    throw DownloadError.filesystem(String(error))
  }
  const destination = `${path}.invalid-${process.pid}-${Date.now()}`
  renameSync(path, destination)
}
