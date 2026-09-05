import { Option } from "effect"
import {
  contentIdentity,
  InventoryError,
  type ComponentRole,
  type ContentIdentity,
  type HuggingFaceModelSearchRequest,
  type HuggingFaceModelSearchResult,
  type HuggingFaceModelSearchResults,
  type HuggingFaceRepositoryRequest,
  type HuggingFaceRepositorySnapshot,
  type InventoryError as InventoryErrorType,
  type ModelPreviewSource,
} from "@magnitudedev/icn-contracts"
import {
  DEFAULT_HF_ENDPOINT,
  MAX_HUB_SEARCH_QUERY_BYTES,
  MAX_HUB_SEARCH_RESULTS,
  hubSearchUrl,
  requireRequestedRevision,
  revisionMetadataUrl,
} from "./hugging-face"

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

interface HubModel extends HubSearchModel {
  cardData?: unknown
  siblings?: HubSibling[]
}

export type FetchLike = typeof globalThis.fetch

export interface HuggingFaceHubOptions {
  readonly endpoint?: string
  readonly fetch?: FetchLike
  readonly token?: string
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

const hubAuthHeaders = (token: string | undefined): Record<string, string> => {
  if (token === undefined || token.length === 0) {
    return { Accept: "application/json" }
  }
  return { Accept: "application/json", Authorization: `Bearer ${token}` }
}

const validateSearchRequest = (request: HuggingFaceModelSearchRequest): void => {
  const query = request.query.trim()
  if (
    query.length === 0 ||
    query.length > MAX_HUB_SEARCH_QUERY_BYTES ||
    request.limit === 0 ||
    request.limit > MAX_HUB_SEARCH_RESULTS
  ) {
    throw InventoryError.InvalidRequest({
      message: `Hugging Face search requires a non-empty query of at most ${MAX_HUB_SEARCH_QUERY_BYTES} bytes and a limit between 1 and ${MAX_HUB_SEARCH_RESULTS}`,
    })
  }
}

const validateRepositoryRequest = (request: HuggingFaceRepositoryRequest): void => {
  if (!validRepository(request.repository)) {
    throw InventoryError.InvalidRequest({
      message: "Hugging Face repository id is invalid",
    })
  }
  if (!validHubRevision(request.revision)) {
    throw InventoryError.InvalidRequest({
      message: "Hugging Face revision contains unsupported characters",
    })
  }
}

/** Search live Hugging Face GGUF models. Inject `fetch` in tests to avoid network. */
export const searchHuggingFaceModels = async (
  request: HuggingFaceModelSearchRequest,
  options: HuggingFaceHubOptions = {},
): Promise<HuggingFaceModelSearchResults> => {
  validateSearchRequest(request)
  const endpoint = options.endpoint ?? DEFAULT_HF_ENDPOINT
  const fetchFn = options.fetch ?? globalThis.fetch
  const token = options.token ?? process.env.HF_TOKEN
  const url = hubSearchUrl(endpoint, request.query.trim(), request.limit)
  const response = await fetchFn(url, { headers: hubAuthHeaders(token) })
  if (!response.ok) {
    throw InventoryError.Upstream({
      message: `Hugging Face search returned HTTP ${response.status}`,
    })
  }
  const metadata = (await response.json()) as HubSearchModel[]
  if (!Array.isArray(metadata)) {
    throw InventoryError.Upstream({ message: "Hugging Face search returned a non-array payload" })
  }
  return {
    models: metadata.flatMap((model) => {
      const mapped = hubSearchModelToContract(model)
      return mapped === undefined ? [] : [mapped]
    }),
  }
}

/** Resolve an immutable repository snapshot. Inject `fetch` in tests to avoid network. */
export const resolveHuggingFaceRepository = async (
  request: HuggingFaceRepositoryRequest,
  options: HuggingFaceHubOptions = {},
): Promise<HuggingFaceRepositorySnapshot> => {
  validateRepositoryRequest(request)
  const endpoint = options.endpoint ?? DEFAULT_HF_ENDPOINT
  const fetchFn = options.fetch ?? globalThis.fetch
  const token = options.token ?? process.env.HF_TOKEN
  const url = `${revisionMetadataUrl(endpoint, request.repository, request.revision)}?blobs=true`
  const response = await fetchFn(url, { headers: hubAuthHeaders(token) })
  if (!response.ok) {
    throw InventoryError.Upstream({
      message: `Hugging Face resolve returned HTTP ${response.status}`,
    })
  }
  const model = (await response.json()) as HubModel
  try {
    return hubModelToSnapshot(model, request.repository, request.revision)
  } catch (error) {
    throw InventoryError.Upstream({
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Network-backed repository refresh is deferred; callers should inject a snapshot provider in tests. */
export const refreshHuggingFaceRepository = async (): Promise<never> => {
  throw new Error(
    "refreshHuggingFaceRepository requires network integration — inject a snapshot provider in tests",
  )
}

export class ModelPreviewService {
  constructor(private readonly options: HuggingFaceHubOptions = {}) {}

  search(request: HuggingFaceModelSearchRequest): Promise<HuggingFaceModelSearchResults> {
    return searchHuggingFaceModels(request, this.options)
  }

  resolve(request: HuggingFaceRepositoryRequest): Promise<HuggingFaceRepositorySnapshot> {
    return resolveHuggingFaceRepository(request, this.options)
  }
}

export type PreviewInventoryError = InventoryErrorType
