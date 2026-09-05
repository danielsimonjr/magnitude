import { basename } from "node:path"
import {
  ComponentRelationship,
  ComponentRole,
  ContentIdentity,
  InventoryError,
  type ModelComponent,
  type ModelFile,
  type ModelFileId,
  type ModelFileRelationship,
  type ModelFileRole,
  type ModelPackage,
} from "./_contracts-shim"

const MAX_COMPONENTS = 128
const MAX_PATH_BYTES = 1_024
const MAX_REPOSITORY_BYTES = 256
const MAX_REVISION_BYTES = 256

export class ValidatedDownloadPackage {
  readonly repository: string
  readonly revision: string
  readonly components: ModelComponent[]

  private constructor(repository: string, revision: string, components: ModelComponent[]) {
    this.repository = repository
    this.revision = revision
    this.components = components
  }

  static new(package_: ModelPackage): ValidatedDownloadPackage {
    validateDownloadPackage(package_)
    const components = package_.files.map((file) => {
      const shardIndex = package_.relationships.find((relationship) => {
        if (relationship._tag === "Shard" && relationship.file_id === file.id) {
          return true
        }
        return false
      })
      const shard_index =
        shardIndex?._tag === "Shard" ? shardIndex.index : undefined
      const role: ComponentRole = (() => {
        switch (file.role) {
          case "weights":
            return shard_index !== undefined ? "Shard" : "Weights"
          case "projector":
            return "Projector"
          case "draft":
            return "Draft"
          case "mtp":
            return "Mtp"
          case "auxiliary":
            return "Auxiliary"
        }
      })()
      return {
        path: file.path,
        role,
        size_bytes: file.size_bytes,
        content: ContentIdentity.Sha256(file.sha256.toLowerCase()),
        shard_index,
        relationship: componentRelationship(package_, file),
      }
    })
    if (package_.source._tag !== "HuggingFace") {
      throw new Error("validated download packages have a Hugging Face source")
    }
    return new ValidatedDownloadPackage(
      package_.source.repository,
      package_.source.revision,
      components,
    )
  }

  repositoryRevision(): [string, string] {
    return [this.repository, this.revision]
  }

  getComponents(): readonly ModelComponent[] {
    return this.components
  }

  intoParts(): [string, string, ModelComponent[]] {
    return [this.repository, this.revision, this.components]
  }
}

const componentRelationship = (
  package_: ModelPackage,
  file: ModelFile,
): ComponentRelationship | undefined => {
  const pathFor = (id: ModelFileId): string => {
    const match = package_.files.find((candidate) => candidate.id === id)
    if (match === undefined) {
      throw new Error("validated package relationships reference existing files")
    }
    return match.path
  }
  for (const relationship of package_.relationships) {
    switch (relationship._tag) {
      case "ProjectorFor":
        if (relationship.projector_file_id === file.id) {
          return {
            _tag: "ProjectorFor",
            projector: file.path,
            model: pathFor(relationship.weights_file_id),
          }
        }
        break
      case "MtpFor":
        if (relationship.mtp_file_id === file.id) {
          return {
            _tag: "MtpFor",
            mtp: file.path,
            model: pathFor(relationship.weights_file_id),
          }
        }
        break
      case "DraftFor":
        if (relationship.draft_file_id === file.id) {
          return {
            _tag: "DraftFor",
            draft: file.path,
            model: pathFor(relationship.weights_file_id),
            method: relationship.method,
          }
        }
        break
      case "Shard":
        break
    }
  }
  return undefined
}

const validateDownloadPackage = (package_: ModelPackage): void => {
  if (package_.source._tag !== "HuggingFace") {
    throw InventoryError.Unsupported({
      message: "only exact Hugging Face packages can be downloaded",
    })
  }
  const { repository, revision } = package_.source
  validateRepository(repository)
  if (revision.length === 0 || revision.length > MAX_REVISION_BYTES || revision.includes("\0")) {
    throw InventoryError.InvalidRequest({
      message: "revision must be non-empty, bounded, and contain no NUL byte",
    })
  }
  if (package_.files.length === 0 || package_.files.length > MAX_COMPONENTS) {
    throw InventoryError.InvalidRequest({
      message: `package files must contain between 1 and ${MAX_COMPONENTS} entries`,
    })
  }

  const filesById = new Map<ModelFileId, ModelFile>()
  const paths = new Set<string>()
  for (const file of package_.files) {
    validateRelativePath(file.path)
    if (paths.has(file.path)) {
      throw InventoryError.InvalidRequest({
        message: `duplicate package file path: ${file.path}`,
      })
    }
    paths.add(file.path)
    if (filesById.has(file.id)) {
      throw InventoryError.InvalidRequest({
        message: `duplicate package file id: ${file.id}`,
      })
    }
    filesById.set(file.id, file)
    if (file.sha256.length !== 64 || !/^[0-9a-fA-F]+$/.test(file.sha256)) {
      throw InventoryError.InvalidRequest({
        message: `invalid SHA-256 for ${file.path}`,
      })
    }
  }
  if (!package_.files.some((file) => file.role === "weights")) {
    throw InventoryError.InvalidRequest({
      message: "package must contain at least one weights file",
    })
  }

  const shardIndices = new Set<number>()
  for (const relationship of package_.relationships) {
    switch (relationship._tag) {
      case "Shard": {
        requireRole(filesById, relationship.file_id, "weights", "shard")
        if (shardIndices.has(relationship.index)) {
          throw InventoryError.InvalidRequest({
            message: `duplicate shard index: ${relationship.index}`,
          })
        }
        shardIndices.add(relationship.index)
        break
      }
      case "ProjectorFor":
        requireRole(filesById, relationship.projector_file_id, "projector", "projector")
        requireRole(filesById, relationship.weights_file_id, "weights", "projector target")
        break
      case "MtpFor":
        requireRole(filesById, relationship.mtp_file_id, "mtp", "MTP")
        requireRole(filesById, relationship.weights_file_id, "weights", "MTP target")
        break
      case "DraftFor":
        requireRole(filesById, relationship.draft_file_id, "draft", "draft")
        requireRole(filesById, relationship.weights_file_id, "weights", "draft target")
        break
    }
  }
}

const requireRole = (
  files: Map<ModelFileId, ModelFile>,
  id: ModelFileId,
  role: ModelFileRole,
  relationship: string,
): void => {
  const file = files.get(id)
  if (file === undefined) {
    throw InventoryError.InvalidRequest({
      message: `${relationship} relationship references an unknown file`,
    })
  }
  if (file.role !== role) {
    throw InventoryError.InvalidRequest({
      message: `${relationship} relationship references a file with the wrong role`,
    })
  }
}

export const validateRelativePath = (path: string): void => {
  if (path.length === 0 || path.length > MAX_PATH_BYTES || path.includes("\0")) {
    throw InventoryError.InvalidRequest({
      message: "component path must be non-empty, bounded, and contain no NUL byte",
    })
  }
  const segments = path.split(/[/\\]/)
  for (const segment of segments) {
    if (segment === ".." || segment === "" && path.startsWith("/")) {
      throw InventoryError.InvalidRequest({ message: `unsafe component path: ${path}` })
    }
  }
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw InventoryError.InvalidRequest({ message: `unsafe component path: ${path}` })
  }
}

export const validateRepository = (repository: string): void => {
  if (
    repository.length === 0 ||
    repository.length > MAX_REPOSITORY_BYTES ||
    repository.includes("\0") ||
    repository.includes("\\")
  ) {
    throw InventoryError.InvalidRequest({ message: "invalid Hugging Face repository" })
  }
  const parts = repository.split("/")
  const owner = parts[0] ?? ""
  const name = parts[1] ?? ""
  if (
    owner.length === 0 ||
    name.length === 0 ||
    parts.length !== 2 ||
    owner === "." ||
    owner === ".." ||
    name === "." ||
    name === ".."
  ) {
    throw InventoryError.InvalidRequest({ message: "repository must be exactly owner/name" })
  }
}
