import { Option } from "effect"
import {
  contentIdentity,
  type ComponentRole,
  type ContentIdentity,
  type HuggingFaceModelSearchResult,
  type HuggingFaceRepositorySnapshot,
  type InventoryError,
  type ModelPreviewSource,
} from "@magnitudedev/icn-contracts"
import { requireRequestedRevision } from "./hugging-face"

export interface PreparedPreviewHeader {
  path: string
  digest: string
}

export interface PreparedPreview {
  repository: string
  commit: string
  components: Array<{
    path: string
    role: ComponentRole
    size_bytes: number
    content: ContentIdentity
    shard_index?: number
  }>
  headers: PreparedPreviewHeader[]
  artifact_fingerprint: string
}

interface HubSibling {
  rfilename: string
  size?: number
  blobId?: string
  lfs?: { sha256: string; size: number }
}

interface HubSearchModel {
  id: string
  sha?: string
  lastModified?: string
  downloads?: number
  likes?: number
  gated?: unknown
  private?: boolean
  tags?: string[]
}

export interface HubModel extends HubSearchModel {
  cardData?: unknown
  siblings?: HubSibling[]
}

export const validRepository = (repository: string): boolean => {
  const slash = repository.indexOf("/")
  if (slash === -1) {
    return false
  }
  const owner = repository.slice(0, slash)
  const name = repository.slice(slash + 1)
  return validRepositoryPart(owner) && validRepositoryPart(name) && !name.includes("/")
}

export const validHubRevision = (revision: string): boolean =>
  revision.length > 0 &&
  revision.length <= 200 &&
  !revision.includes("?") &&
  !revision.includes("#") &&
  !revision.includes("\\") &&
  !revision.includes("\0") &&
  !revision.includes("..")

const validRepositoryPart = (part: string): boolean =>
  part.length > 0 && part !== "." && part !== ".." && !part.includes("\\") && part !== "../model"

export const immutableCommit = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (value.length < 40 || value.length > 64) {
    return undefined
  }
  return [...value].every((char) => /[0-9a-f]/i.test(char)) ? value : undefined
}

export const validateSnapshotRevision = (requested: string, commit: string): void => {
  if (immutableCommit(requested) !== undefined) {
    requireRequestedRevision(requested, commit)
  }
}

export const hubGated = (value: unknown | undefined): boolean =>
  value !== undefined && value !== false && value !== null

export const hubSearchModelToContract = (model: HubSearchModel): HuggingFaceModelSearchResult | undefined => {
  const commit = immutableCommit(model.sha)
  if (commit === undefined) {
    return undefined
  }
  return {
    repository: model.id,
    commit,
    last_modified: Option.fromNullable(model.lastModified),
    downloads: Option.fromNullable(model.downloads !== undefined ? BigInt(model.downloads) : undefined),
    likes: Option.fromNullable(model.likes !== undefined ? BigInt(model.likes) : undefined),
    gated: hubGated(model.gated),
    private: model.private ?? false,
    tags: model.tags ?? [],
  }
}

export const hubModelToSnapshot = (
  model: HubModel,
  requestedRepository: string,
  requestedRevision: string,
): HuggingFaceRepositorySnapshot => {
  const commit = immutableCommit(model.sha)
  if (commit === undefined) {
    throw new Error("Hugging Face repository did not resolve to an immutable commit")
  }
  validateSnapshotRevision(requestedRevision, commit)
  const ggufFiles = (model.siblings ?? [])
    .filter((sibling) => validGgufPath(sibling.rfilename))
    .map((sibling) => ({
      path: sibling.rfilename,
      size_bytes: BigInt(sibling.size ?? sibling.lfs?.size ?? 0),
      content: sibling.lfs
        ? contentIdentity.sha256(sibling.lfs.sha256)
        : contentIdentity.unknown(),
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
  if (ggufFiles.length === 0) {
    throw new Error(`${requestedRepository} does not contain GGUF artifacts`)
  }
  return {
    repository: model.id ?? requestedRepository,
    commit,
    last_modified: Option.fromNullable(model.lastModified),
    downloads: Option.fromNullable(model.downloads !== undefined ? BigInt(model.downloads) : undefined),
    likes: Option.fromNullable(model.likes !== undefined ? BigInt(model.likes) : undefined),
    gated: hubGated(model.gated),
    private: model.private ?? false,
    license: Option.none(),
    license_url: Option.none(),
    base_models: [],
    tags: model.tags ?? [],
    gguf_files: ggufFiles,
  }
}

export const validGgufPath = (path: string): boolean =>
  path.endsWith(".gguf") && !path.includes("..") && !path.startsWith("/")

export const selectRepositorySnapshotComponents = (
  files: ReadonlyArray<{ path: string; size_bytes: number; content: ContentIdentity }>,
  source: ModelPreviewSource,
): Array<{
  path: string
  role: ComponentRole
  size_bytes: number
  content: ContentIdentity
  shard_index?: number
}> => {
  const selected = files.filter((file) => {
    if (file.path === source.primary_gguf) {
      return true
    }
    const shardMatch = file.path.match(/-(\d{5})-of-(\d{5})\.gguf$/)
    const primaryShard = source.primary_gguf.match(/-(\d{5})-of-(\d{5})\.gguf$/)
    return shardMatch !== null && primaryShard !== null && shardMatch[2] === primaryShard[2]
  })
  return selected.map((file) => {
    const shardMatch = file.path.match(/-(\d{5})-of-(\d{5})\.gguf$/)
    return {
      path: file.path,
      role: shardMatch === null || file.path === source.primary_gguf ? "weights" : "shard",
      size_bytes: file.size_bytes,
      content: file.content,
      shard_index: shardMatch === null ? undefined : Number(shardMatch[1]),
    }
  })
}

export { refreshHuggingFaceRepository } from "./catalog-resolve"

export class ModelPreviewService {
  // Full preview orchestration depends on ManagedModelStore network paths; use hub helpers above in tests.
  constructor() {}
}

export type PreviewInventoryError = InventoryError
