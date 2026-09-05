import { Option } from "effect"
import {
  InventoryError,
  catalogBaseId,
  catalogVariantId,
  modelReleaseDate,
  type CatalogDiagnostic,
  type HuggingFaceRepositoryRequest,
  type HuggingFaceRepositorySnapshot,
  type InventoryProperties,
  type ModelPackage,
  type RecommendableModel,
  type RecommendableModelCatalog,
  type ServableModelBundle,
  type SpeculativeMethod,
} from "@magnitudedev/icn-contracts"
import {
  catalogSource,
  isFirstShard,
  isLaterShard,
  isProjectorPath,
  modelCatalogLock,
  recommendableModelBundleKey,
  resolveProjectorPath,
  type CatalogModelDeclaration,
  type CatalogSource,
  type CatalogVariant,
  type ModelCatalogLock,
  type ModelCatalogLockEntry,
} from "./catalog"
import {
  hubModelToSnapshot,
  hubSearchModelToContract,
  validHubRevision,
  validRepository,
  type HubModel,
} from "./preview"
import { revisionMetadataUrl } from "./hugging-face"
import type { ModelCache } from "./cache"

const DEFAULT_ENDPOINT = "https://huggingface.co"
const MAX_HUB_METADATA_BYTES = 8 * 1024 * 1024
const HUB_REQUEST_ATTEMPTS = 3
const HUB_RETRY_BASE_DELAY_MS = 200

export interface HubRepositoryHttpClient {
  fetchRepositoryMetadata(
    repository: string,
    revision: string,
    etag?: string,
  ): Promise<
    | { readonly _tag: "NotModified" }
    | { readonly _tag: "Modified"; readonly model: HubModel; readonly etag?: string }
  >
  searchModels?(query: string, limit: number): Promise<HubModel[]>
}

export interface HubRepositoryHttpOptions {
  endpoint?: string
  fetch?: typeof globalThis.fetch
  token?: string
}

/** Options accepted by server-facing HF search/resolve helpers. */
export type HuggingFaceHubOptions = HubRepositoryHttpOptions

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const retryableHubStatus = (status: number): boolean => status === 429 || status >= 500

export const createHubRepositoryHttpClient = (
  options: HubRepositoryHttpOptions = {},
): HubRepositoryHttpClient => {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT
  const fetchFn = options.fetch ?? globalThis.fetch
  const token = options.token ?? process.env.HF_TOKEN

  return {
    async fetchRepositoryMetadata(repository, revision, etag) {
      const url = `${revisionMetadataUrl(endpoint, repository, revision)}?blobs=true`
      let lastFailure: string | undefined
      for (let attempt = 0; attempt < HUB_REQUEST_ATTEMPTS; attempt += 1) {
        const headers: Record<string, string> = { Accept: "application/json" }
        if (token !== undefined && token.length > 0) {
          headers.Authorization = `Bearer ${token}`
        }
        if (etag !== undefined) {
          headers["If-None-Match"] = etag
        }
        let response: Response
        try {
          response = await fetchFn(url, { headers })
        } catch (error) {
          lastFailure = error instanceof Error ? error.message : String(error)
          if (attempt + 1 >= HUB_REQUEST_ATTEMPTS) {
            throw InventoryError.Upstream({ message: lastFailure })
          }
          await delay(HUB_RETRY_BASE_DELAY_MS * (attempt + 1))
          continue
        }
        if (response.status === 304) {
          return { _tag: "NotModified" }
        }
        if (retryableHubStatus(response.status) && attempt + 1 < HUB_REQUEST_ATTEMPTS) {
          lastFailure = `HTTP ${response.status}`
          await delay(HUB_RETRY_BASE_DELAY_MS * (attempt + 1))
          continue
        }
        if (!response.ok) {
          throw InventoryError.Upstream({
            message: `Hugging Face metadata returned HTTP ${response.status}`,
          })
        }
        const buffer = new Uint8Array(await response.arrayBuffer())
        if (buffer.byteLength > MAX_HUB_METADATA_BYTES) {
          throw InventoryError.Upstream({ message: "Hugging Face metadata exceeded size bound" })
        }
        const model = JSON.parse(new TextDecoder().decode(buffer)) as HubModel
        return { _tag: "Modified", model, etag: response.headers.get("etag") ?? undefined }
      }
      throw InventoryError.Upstream({ message: lastFailure ?? "Hugging Face request failed" })
    },

    async searchModels(query, limit) {
      const base = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint
      const url = new URL(`${base}/api/models`)
      url.searchParams.set("search", query)
      url.searchParams.set("filter", "gguf")
      url.searchParams.set("sort", "downloads")
      url.searchParams.set("direction", "-1")
      url.searchParams.set("limit", String(limit))
      for (const expand of ["sha", "lastModified", "downloads", "likes", "tags", "private", "gated"]) {
        url.searchParams.append("expand", expand)
      }
      const headers: Record<string, string> = { Accept: "application/json" }
      if (token !== undefined && token.length > 0) {
        headers.Authorization = `Bearer ${token}`
      }
      const response = await fetchFn(url.toString(), { headers })
      if (!response.ok) {
        throw InventoryError.Upstream({
          message: `Hugging Face search returned HTTP ${response.status}`,
        })
      }
      return (await response.json()) as HubModel[]
    },
  }
}

export const validateRepositoryRequest = (request: HuggingFaceRepositoryRequest): void => {
  if (!validRepository(request.repository)) {
    throw InventoryError.InvalidRequest({
      message: "Hugging Face repository must use owner/repository form",
    })
  }
  if (!validHubRevision(request.revision)) {
    throw InventoryError.InvalidRequest({
      message: "Hugging Face revision contains unsupported characters",
    })
  }
}

export const repositoryCacheKey = (
  endpoint: string,
  request: HuggingFaceRepositoryRequest,
): string => `${endpoint}:${request.repository}@${request.revision}`

interface CachedHuggingFaceRepositorySnapshot {
  captured_at: number
  etag?: string
  snapshot: HuggingFaceRepositorySnapshot
}

export interface RefreshHuggingFaceRepositoryDeps {
  http: HubRepositoryHttpClient
  endpoint?: string
  cache?: ModelCache
}

export const refreshHuggingFaceRepository = async (
  deps: RefreshHuggingFaceRepositoryDeps,
  request: HuggingFaceRepositoryRequest,
): Promise<HuggingFaceRepositorySnapshot> => {
  validateRepositoryRequest(request)
  const endpoint = deps.endpoint ?? DEFAULT_ENDPOINT
  const cacheKey = repositoryCacheKey(endpoint, request)
  const cached = deps.cache?.readIndex<CachedHuggingFaceRepositorySnapshot>(
    "HuggingFaceRepositorySnapshot",
    cacheKey,
  )
  const fetched = await deps.http.fetchRepositoryMetadata(
    request.repository,
    request.revision,
    cached?.etag,
  )
  let snapshot: HuggingFaceRepositorySnapshot
  let etag: string | undefined
  if (fetched._tag === "NotModified") {
    if (cached === undefined) {
      throw InventoryError.Upstream({
        message: "Hugging Face returned not modified without cached metadata",
      })
    }
    snapshot = cached.snapshot
    etag = cached.etag
  } else {
    snapshot = hubModelToSnapshot(fetched.model, request.repository, request.revision)
    etag = fetched.etag
  }
  deps.cache?.writeIndex("HuggingFaceRepositorySnapshot", cacheKey, {
    captured_at: Math.floor(Date.now() / 1000),
    etag,
    snapshot,
  } satisfies CachedHuggingFaceRepositorySnapshot)
  return snapshot
}

const isHubRepositoryHttpClient = (
  value: unknown,
): value is HubRepositoryHttpClient =>
  typeof value === "object" &&
  value !== null &&
  "fetchRepositoryMetadata" in value &&
  typeof (value as HubRepositoryHttpClient).fetchRepositoryMetadata === "function"

const resolveHubHttpClient = (
  options: HuggingFaceHubOptions | HubRepositoryHttpClient = {},
): HubRepositoryHttpClient =>
  isHubRepositoryHttpClient(options) ? options : createHubRepositoryHttpClient(options)

/** Convenience wrappers used by icn-server routes and injectable tests. */
export const resolveHuggingFaceRepository = async (
  request: HuggingFaceRepositoryRequest,
  options: HuggingFaceHubOptions | Partial<RefreshHuggingFaceRepositoryDeps> = {},
): Promise<HuggingFaceRepositorySnapshot> => {
  if (isHubRepositoryHttpClient(options)) {
    return refreshHuggingFaceRepository({ http: options }, request)
  }
  const deps = options as HuggingFaceHubOptions & Partial<RefreshHuggingFaceRepositoryDeps>
  return refreshHuggingFaceRepository(
    {
      http: deps.http ?? createHubRepositoryHttpClient(deps),
      endpoint: deps.endpoint,
      cache: deps.cache,
    },
    request,
  )
}

export const searchHuggingFaceModels = async (
  request: { query: string; limit: number },
  options: HuggingFaceHubOptions | HubRepositoryHttpClient = {},
): Promise<{ models: NonNullable<ReturnType<typeof hubSearchModelToContract>>[] }> => {
  const query = request.query.trim()
  if (query.length === 0 || request.limit <= 0) {
    throw InventoryError.InvalidRequest({
      message: "Hugging Face search requires a non-empty query and positive limit",
    })
  }
  const http = resolveHubHttpClient(options)
  if (http.searchModels === undefined) {
    throw InventoryError.Unsupported({ message: "Hub HTTP client does not support search" })
  }
  const raw = await http.searchModels(query, request.limit)
  return {
    models: raw.flatMap((model) => {
      const mapped = hubSearchModelToContract(model)
      return mapped === undefined ? [] : [mapped]
    }),
  }
}

export const advanceModelCatalogLock = async (
  refresh: (
    request: HuggingFaceRepositoryRequest,
  ) => Promise<HuggingFaceRepositorySnapshot>,
  source: CatalogSource = catalogSource(),
): Promise<ModelCatalogLock> => {
  const entries = await Promise.all(
    source.models.map(async (declaration) => {
      const target = await refresh({ repository: declaration.repository, revision: "main" })
      let speculativeDraft: string | undefined
      const draftRepository =
        declaration.speculativeDecoding?.draft.type === "file"
          ? (declaration.speculativeDecoding.draft.repository ?? declaration.repository)
          : undefined
      if (draftRepository !== undefined) {
        speculativeDraft =
          draftRepository === declaration.repository
            ? target.commit
            : (await refresh({ repository: draftRepository, revision: "main" })).commit
      }
      const entry: ModelCatalogLockEntry = {
        target: target.commit,
        ...(speculativeDraft !== undefined ? { speculativeDraft } : {}),
      }
      return [declaration.id, entry] as const
    }),
  )
  return Object.fromEntries(entries)
}

export const resolvePrimaryGgufFromSnapshot = (
  declaration: CatalogModelDeclaration,
  variant: CatalogVariant,
  snapshot: HuggingFaceRepositorySnapshot,
): string => {
  const selector = variant.format.toLowerCase()
  const matches = snapshot.gguf_files.filter((file) => {
    const path = file.path.toLowerCase()
    const basename = path.split("/").pop() ?? path
    return (
      path.includes(selector) &&
      !isProjectorPath(file.path) &&
      !basename.includes("imatrix") &&
      (!isLaterShard(basename) || isFirstShard(basename))
    )
  })
  if (matches.length !== 1) {
    throw InventoryError.Integrity({
      message: `${declaration.repository} format ${variant.format} resolved to ${matches.length} primary files`,
    })
  }
  return matches[0]!.path
}

const speculativeMethod = (method: "mtp" | "dflash" | "dspark"): SpeculativeMethod => {
  switch (method) {
    case "mtp":
      return { _tag: "Mtp" }
    case "dflash":
      return { _tag: "DFlash" }
    case "dspark":
      return { _tag: "DSpark" }
  }
}

export const recommendableModelFromPackages = (
  declaration: CatalogModelDeclaration,
  variant: CatalogVariant,
  target: ModelPackage,
  draft: ModelPackage | undefined,
  properties: InventoryProperties,
): RecommendableModel => {
  const hasDraft = draft !== undefined
  let bundle: ServableModelBundle
  if (declaration.speculativeDecoding === undefined) {
    bundle = { _tag: "Standalone", package: target }
  } else {
    let draftSource:
      | { readonly _tag: "Embedded" }
      | { readonly _tag: "Separate"; readonly draft: ModelPackage }
    if (declaration.speculativeDecoding.draft.type === "embedded") {
      if (properties.type !== "inspected") {
        throw InventoryError.Integrity({
          message: `${declaration.id} cannot verify its embedded speculative draft`,
        })
      }
      const nextn = Option.getOrElse(properties.nextn_predict_layers, () => 0)
      if (nextn === 0) {
        throw InventoryError.Integrity({
          message: `${declaration.id} declares an embedded speculative draft but its target GGUF has no NextN layers`,
        })
      }
      draftSource = { _tag: "Embedded" }
    } else if (draft === undefined) {
      throw InventoryError.Integrity({
        message: `${declaration.id} has no resolved speculative draft`,
      })
    } else {
      draftSource = { _tag: "Separate", draft }
    }
    bundle = {
      _tag: "SpeculativeDecoding",
      target,
      draftSource,
      method: speculativeMethod(declaration.speculativeDecoding.method),
    }
  }
  if (declaration.speculativeDecoding === undefined && hasDraft) {
    throw InventoryError.Integrity({
      message: `${declaration.id} resolved an undeclared speculative draft`,
    })
  }
  const modelId = catalogBaseId(declaration.id)
  const variantId = catalogVariantId(variant.variantId)
  if (typeof modelId !== "string" || typeof variantId !== "string") {
    throw InventoryError.Integrity({ message: `invalid catalog identity for ${declaration.id}` })
  }
  return {
    modelId,
    variantId,
    configuration: {
      bundle,
      profile: { contextLength: declaration.contextLength },
    },
    displayName: declaration.displayName,
    variantLabel: variant.variantLabel,
    description: declaration.description,
    releaseDate: modelReleaseDate(declaration.releaseDate) as RecommendableModel["releaseDate"],
    license: declaration.license,
    parameterization: declaration.parameterization,
    intelligence: declaration.intelligence,
    fidelityRank: variant.fidelityRank,
    quantizationAware: variant.quantizationAware,
  }
}

export interface ResolvedCatalogVariantPackages {
  target: ModelPackage
  draft?: ModelPackage
  properties: InventoryProperties
}

export interface GeneratedReleaseCatalog {
  catalog: RecommendableModelCatalog
  plannerInputs: Map<string, ResolvedCatalogVariantPackages>
}

export interface ResolvingRecommendableCatalogDeps {
  refreshRepository: (
    request: HuggingFaceRepositoryRequest,
  ) => Promise<HuggingFaceRepositorySnapshot>
  resolvePackages: (
    declaration: CatalogModelDeclaration,
    variant: CatalogVariant,
    snapshots: ReadonlyMap<string, HuggingFaceRepositorySnapshot>,
  ) => Promise<ResolvedCatalogVariantPackages>
}

export class ResolvingRecommendableCatalog {
  constructor(private readonly deps: ResolvingRecommendableCatalogDeps) {}

  async resolveReleaseCatalog(
    progress: (label: string, completed: number, total: number) => void = () => undefined,
    lock: ModelCatalogLock = modelCatalogLock(),
    source: CatalogSource = catalogSource(),
  ): Promise<GeneratedReleaseCatalog> {
    const repositories = new Map<string, string>()
    for (const declaration of source.models) {
      const entry = lock[declaration.id]
      if (entry === undefined) {
        throw InventoryError.Integrity({
          message: `model catalog lock is missing ${declaration.id}`,
        })
      }
      insertLockedRepository(repositories, declaration.repository, entry.target)
      if (declaration.speculativeDecoding?.draft.type === "file") {
        const repository =
          declaration.speculativeDecoding.draft.repository ?? declaration.repository
        if (entry.speculativeDraft === undefined) {
          throw InventoryError.Integrity({
            message: `model catalog lock is missing ${declaration.id} speculative draft`,
          })
        }
        insertLockedRepository(repositories, repository, entry.speculativeDraft)
      } else if (entry.speculativeDraft !== undefined) {
        throw InventoryError.Integrity({
          message: `model catalog lock unexpectedly includes ${declaration.id} embedded speculative draft`,
        })
      }
    }

    const repositoryEntries = [...repositories.entries()]
    let repositoryCompleted = 0
    const settled = await Promise.all(
      repositoryEntries.map(async ([repository, revision]) => {
        try {
          const snapshot = await this.deps.refreshRepository({ repository, revision })
          return { repository, snapshot, error: undefined as string | undefined }
        } catch (error) {
          return {
            repository,
            snapshot: undefined,
            error: error instanceof Error ? error.message : String(error),
          }
        } finally {
          repositoryCompleted += 1
          progress("Resolved catalog repositories", repositoryCompleted, repositoryEntries.length)
        }
      }),
    )

    const resolvedSnapshots = new Map<string, HuggingFaceRepositorySnapshot>()
    const snapshotFailures = new Map<string, string>()
    for (const entry of settled) {
      if (entry.snapshot !== undefined) {
        resolvedSnapshots.set(entry.repository, entry.snapshot)
      } else {
        snapshotFailures.set(
          entry.repository,
          entry.error ?? `repository ${entry.repository} was not resolved`,
        )
      }
    }

    const models: RecommendableModel[] = []
    const diagnostics: CatalogDiagnostic[] = []
    const plannerInputs = new Map<string, ResolvedCatalogVariantPackages>()
    let modelCompleted = 0
    for (const declaration of source.models) {
      for (const variant of declaration.variants) {
        const missingRepository = [declaration.repository]
          .concat(
            declaration.speculativeDecoding?.draft.type === "file"
              ? [declaration.speculativeDecoding.draft.repository ?? declaration.repository]
              : [],
          )
          .find((repository) => !resolvedSnapshots.has(repository))
        try {
          if (missingRepository !== undefined) {
            throw InventoryError.Io({
              message:
                snapshotFailures.get(missingRepository) ??
                `repository ${missingRepository} was not resolved`,
            })
          }
          const packages = await this.deps.resolvePackages(
            declaration,
            variant,
            resolvedSnapshots,
          )
          resolvePrimaryGgufFromSnapshot(
            declaration,
            variant,
            resolvedSnapshots.get(declaration.repository)!,
          )
          resolveProjectorPath(declaration, resolvedSnapshots.get(declaration.repository)!)
          const model = recommendableModelFromPackages(
            declaration,
            variant,
            packages.target,
            packages.draft,
            packages.properties,
          )
          plannerInputs.set(recommendableModelBundleKey(model).value, packages)
          models.push(model)
        } catch (error) {
          const modelId = catalogBaseId(declaration.id)
          const variantId = catalogVariantId(variant.variantId)
          if (typeof modelId === "string" && typeof variantId === "string") {
            diagnostics.push({
              modelId,
              variantId,
              failure: {
                code: "catalog_resolution_failed",
                message: error instanceof Error ? error.message : String(error),
                retryable: true,
              },
            })
          }
        }
      }
      modelCompleted += 1
      progress("Prepared catalog models", modelCompleted, source.models.length)
    }

    return { catalog: { models, diagnostics }, plannerInputs }
  }

  async catalog(): Promise<RecommendableModelCatalog> {
    return (await this.resolveReleaseCatalog()).catalog
  }
}

const insertLockedRepository = (
  repositories: Map<string, string>,
  repository: string,
  revision: string,
): void => {
  const existing = repositories.get(repository)
  if (existing !== undefined && existing !== revision) {
    throw InventoryError.Integrity({
      message: `catalog lock pins ${repository} to conflicting revisions`,
    })
  }
  repositories.set(repository, revision)
}
