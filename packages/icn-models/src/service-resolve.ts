import { realpathSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import {
  ComponentRole,
  InventoryError,
  modelLocationComponents,
  type InventoryModel,
  type ResolvedComponent,
} from "./_contracts-shim"
import { hfRepoDir } from "./paths"

const invalidSplitLayout = (role: ComponentRole): InventoryError =>
  InventoryError.ModelOperation({
    code: "invalid_split_layout",
    message: `the ${role} gguf shard layout is invalid`,
    retryable: false,
  })

export const resolveComponents = (root: string, model: InventoryModel): ResolvedComponent[] => {
  let base: string
  let containment: string
  if (model.location._tag === "MagnitudeCache" && model.source._tag === "HuggingFace") {
    const repositoryRoot = join(root, "hub", hfRepoDir(model.source.repository))
    base = join(repositoryRoot, "snapshots", model.source.commit)
    containment = repositoryRoot
  } else if (model.location._tag === "HuggingFaceCache") {
    base = model.location.cache_root
    containment = hfRepoRoot(model.location.cache_root)
  } else if (model.location._tag === "Directory") {
    base = model.location.root
    containment = model.location.root
  } else if (model.location._tag === "File") {
    base = dirname(model.location.path)
    containment = base
  } else {
    throw InventoryError.Internal({
      message: "model source and location are inconsistent",
    })
  }
  const canonicalContainment = realpathSync(containment)
  const resolved = modelLocationComponents(model.location).map((component) => {
    const path =
      model.location._tag === "File" ? model.location.path : join(base, component.path)
    const canonical = realpathSync(path)
    if (!canonical.startsWith(canonicalContainment)) {
      throw InventoryError.DeletionUnsafe({
        message: `model component escaped its source root: ${path}`,
      })
    }
    return {
      path,
      role: component.role,
      shard_index: component.shard_index,
      relationship: component.relationship,
    }
  })
  validateShardLayout(resolved)
  return resolved
}

const validateShardLayout = (components: readonly ResolvedComponent[]): void => {
  const groups: Array<[ComponentRole, string]> = []
  for (const component of components) {
    if (component.shard_index === undefined) continue
    const directory = dirname(component.path)
    if (!groups.some(([role, parent]) => role === component.role && parent === directory)) {
      groups.push([component.role, directory])
    }
  }
  for (const [role, directory] of groups) {
    const shards = components.filter(
      (component) =>
        component.role === role &&
        component.shard_index !== undefined &&
        dirname(component.path) === directory,
    )
    const count = shards.length
    if (count > Number.MAX_SAFE_INTEGER) {
      throw invalidSplitLayout(role)
    }
    const indices = new Set<number>()
    for (const component of shards) {
      const index = component.shard_index!
      const name = basename(component.path)
      const suffix = `-${String(index).padStart(5, "0")}-of-${String(count).padStart(5, "0")}.gguf`
      if (indices.has(index) || !name.endsWith(suffix)) {
        throw invalidSplitLayout(role)
      }
      indices.add(index)
    }
    for (let index = 1; index <= count; index++) {
      if (!indices.has(index)) {
        throw invalidSplitLayout(role)
      }
    }
  }
}

const hfRepoRoot = (snapshot: string): string => {
  const parts = snapshot.split("/")
  const snapshotsIndex = parts.lastIndexOf("snapshots")
  if (snapshotsIndex === -1) {
    throw InventoryError.Internal({ message: "Hugging Face cache snapshot has no snapshots parent" })
  }
  return parts.slice(0, snapshotsIndex).join("/")
}
