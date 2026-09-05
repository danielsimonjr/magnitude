import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { Option } from "effect"
import {
  InventoryError,
  modelLocationComponents,
  type CatalogPackageRemover,
  type DeletePlan,
  type DeletedModel,
  type InventoryEntryId,
  type InventoryModel,
  type ModelPackageId,
  type RemoveInstalledModelPackageResponse,
} from "@magnitudedev/icn-contracts"
import { hfRepoDir } from "./paths"
import type { ManagedModelStore } from "./inventory"

const ioError = (error: unknown): never => {
  throw InventoryError.Io({
    message: error instanceof Error ? error.message : String(error),
  })
}

const ensureDeletableStatus = (model: InventoryModel): void => {
  if (model.availability.type === "downloading") {
    throw InventoryError.Busy({ id: model.id })
  }
}

const collectOtherSnapshotBlobs = (
  path: string,
  blobsRoot: string,
  excludedLinks: ReadonlySet<string>,
  output: Set<string>,
): void => {
  if (!existsSync(path)) return
  let entries
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch (error) {
    ioError(error)
  }
  for (const entry of entries!) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      collectOtherSnapshotBlobs(child, blobsRoot, excludedLinks, output)
      continue
    }
    if (excludedLinks.has(child) || (!entry.isSymbolicLink() && !entry.isFile())) continue
    let canonical: string
    try {
      canonical = realpathSync(child)
    } catch (error) {
      ioError(error)
    }
    if (!canonical!.startsWith(blobsRoot)) {
      throw InventoryError.DeletionUnsafe({
        message: `snapshot entry does not resolve to repository blobs: ${child}`,
      })
    }
    output.add(canonical!)
  }
}

const otherSnapshotBlobReferences = (
  repoRoot: string,
  excludedLinks: ReadonlySet<string>,
): Set<string> => {
  const output = new Set<string>()
  collectOtherSnapshotBlobs(join(repoRoot, "snapshots"), join(repoRoot, "blobs"), excludedLinks, output)
  return output
}

const removeEmptyParents = (start: string, stopAt: string): void => {
  let current = start
  while (current !== stopAt && current.startsWith(stopAt)) {
    try {
      if (readdirSync(current).length > 0) return
      rmSync(current, { recursive: true, force: true })
    } catch {
      return
    }
    current = dirname(current)
  }
}

const planManagedDelete = (root: string, model: InventoryModel): DeletePlan => {
  if (model.source.type !== "hugging_face") {
    throw InventoryError.Internal({ message: "managed location is missing Hugging Face identity" })
  }
  const components = modelLocationComponents(model.location)
  const repoRoot = join(root, "hub", hfRepoDir(model.source.repository))
  const snapshot = join(repoRoot, "snapshots", model.source.commit)
  const links = new Set(components.map((component) => join(snapshot, component.path)))
  const referenced = otherSnapshotBlobReferences(repoRoot, links)
  let reclaimable = 0n
  let retained = 0n
  const paths: string[] = []
  for (const component of components) {
    const link = join(snapshot, component.path)
    let blob: string
    try {
      blob = realpathSync(link)
    } catch (error) {
      ioError(error)
    }
    paths.push(link)
    if (referenced.has(blob!)) retained += component.size_bytes
    else {
      reclaimable += component.size_bytes
      paths.push(blob!)
    }
  }
  return {
    model_id: model.id,
    supported: true,
    reason: Option.none(),
    reclaimable_bytes: reclaimable,
    retained_shared_bytes: retained,
    paths,
  }
}

const deleteManaged = (root: string, model: InventoryModel): bigint => {
  if (model.source.type !== "hugging_face") {
    throw InventoryError.Internal({ message: "managed location is missing Hugging Face identity" })
  }
  const components = modelLocationComponents(model.location)
  const repoRoot = join(root, "hub", hfRepoDir(model.source.repository))
  const snapshot = join(repoRoot, "snapshots", model.source.commit)
  const links = new Set(components.map((component) => join(snapshot, component.path)))
  const referenced = otherSnapshotBlobReferences(repoRoot, links)
  let freed = 0n
  for (const component of components) {
    const link = join(snapshot, component.path)
    let blob: string
    try {
      blob = realpathSync(link)
    } catch (error) {
      ioError(error)
    }
    try {
      unlinkSync(link)
    } catch {
      // already gone
    }
    if (!referenced.has(blob!)) {
      try {
        const size = BigInt(lstatSync(blob!).size)
        unlinkSync(blob!)
        freed += size
      } catch {
        // already gone
      }
    }
  }
  removeEmptyParents(snapshot, join(repoRoot, "snapshots"))
  return freed
}

const hfRepoRootFromSnapshot = (snapshot: string): string => {
  let canonical: string
  try {
    canonical = realpathSync(snapshot)
  } catch (error) {
    ioError(error)
  }
  const snapshots = dirname(canonical!)
  if (snapshots.split(/[/\\]/).pop() !== "snapshots") {
    throw InventoryError.DeletionUnsafe({
      message: "recognized Hugging Face snapshot is not under snapshots/",
    })
  }
  return dirname(snapshots)
}

const collectSnapshotBlobs = (snapshot: string, repoRoot: string): Set<string> => {
  const blobs = new Set<string>()
  const walk = (path: string): void => {
    if (!existsSync(path)) return
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) {
        walk(child)
        continue
      }
      try {
        const canonical = realpathSync(child)
        if (canonical.startsWith(join(repoRoot, "blobs"))) blobs.add(canonical)
      } catch {
        // ignore broken links
      }
    }
  }
  walk(snapshot)
  return blobs
}

const hfBlobReferenceSets = (repoRoot: string, snapshot: string) => {
  const target = collectSnapshotBlobs(snapshot, repoRoot)
  const remaining = new Set<string>()
  const snapshotsRoot = join(repoRoot, "snapshots")
  if (existsSync(snapshotsRoot)) {
    for (const entry of readdirSync(snapshotsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const other = join(snapshotsRoot, entry.name)
      try {
        if (realpathSync(other) === realpathSync(snapshot)) continue
      } catch {
        continue
      }
      for (const blob of collectSnapshotBlobs(other, repoRoot)) remaining.add(blob)
    }
  }
  return { target, remaining }
}

const removeRefsToCommit = (refsRoot: string, commit: string): void => {
  if (!existsSync(refsRoot)) return
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) {
        walk(child)
        continue
      }
      try {
        if (readFileSync(child, "utf8").trim() === commit) unlinkSync(child)
      } catch {
        // ignore
      }
    }
  }
  walk(refsRoot)
}

const planHfCacheDelete = (model: InventoryModel, snapshot: string): DeletePlan => {
  const repoRoot = hfRepoRootFromSnapshot(snapshot)
  const { target, remaining } = hfBlobReferenceSets(repoRoot, snapshot)
  let reclaimable = 0n
  let retained = 0n
  const paths = [snapshot]
  for (const blob of target) {
    let size = 0n
    try {
      size = BigInt(lstatSync(blob).size)
    } catch {
      size = 0n
    }
    if (remaining.has(blob)) retained += size
    else {
      reclaimable += size
      paths.push(blob)
    }
  }
  return {
    model_id: model.id,
    supported: true,
    reason: Option.none(),
    reclaimable_bytes: reclaimable,
    retained_shared_bytes: retained,
    paths,
  }
}

const deleteHfCache = (_model: InventoryModel, snapshot: string): bigint => {
  const repoRoot = hfRepoRootFromSnapshot(snapshot)
  const commit = snapshot.split(/[/\\]/).pop()
  if (commit === undefined || commit.length === 0) {
    throw InventoryError.DeletionUnsafe({ message: "snapshot has no commit name" })
  }
  removeRefsToCommit(join(repoRoot, "refs"), commit)
  const { target, remaining } = hfBlobReferenceSets(repoRoot, snapshot)
  rmSync(snapshot, { recursive: true, force: true })
  let freed = 0n
  for (const blob of target) {
    if (remaining.has(blob)) continue
    try {
      const size = BigInt(lstatSync(blob).size)
      unlinkSync(blob)
      freed += size
    } catch {
      // already gone
    }
  }
  try {
    const snapshots = join(repoRoot, "snapshots")
    if (existsSync(snapshots) && readdirSync(snapshots).length === 0) {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  } catch {
    // best effort
  }
  return freed
}

export const planDeleteForModel = (root: string, model: InventoryModel): DeletePlan => {
  ensureDeletableStatus(model)
  switch (model.location.type) {
    case "magnitude_cache":
      return planManagedDelete(root, model)
    case "hugging_face_cache":
      return planHfCacheDelete(model, model.location.cache_root)
    case "directory":
    case "file":
      return {
        model_id: model.id,
        supported: false,
        reason: Option.some("configured directories and ad-hoc files are read-only"),
        reclaimable_bytes: 0n,
        retained_shared_bytes: 0n,
        paths: [],
      }
  }
}

export const deleteModelArtifacts = (root: string, model: InventoryModel): bigint => {
  switch (model.location.type) {
    case "magnitude_cache":
      return deleteManaged(root, model)
    case "hugging_face_cache":
      return deleteHfCache(model, model.location.cache_root)
    case "directory":
    case "file":
      throw InventoryError.Unsupported({
        message: "configured directories and ad-hoc files are read-only",
      })
  }
}

export const createManagedStoreCatalogPackageRemover = (
  store: ManagedModelStore,
): CatalogPackageRemover => ({
  async removeCatalogPackages(packageIds) {
    let reclaimedBytes = 0
    for (const packageId of packageIds) {
      const result = await store.removeInstalled(packageId)
      reclaimedBytes += Number(result.freedBytes)
    }
    return reclaimedBytes
  },
})

export type { DeletePlan, DeletedModel, RemoveInstalledModelPackageResponse, InventoryEntryId, ModelPackageId }
