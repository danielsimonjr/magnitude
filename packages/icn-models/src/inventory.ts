import { createHash } from "node:crypto"
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import { lstatSync } from "node:fs"
import {
  InventoryEntryId as InventoryEntryIdBrand,
  ComponentRole,
  ContentIdentity,
  InventoryError,
  modelLocationComponents,
  type ContentId,
  type InstalledCatalogAttribution,
  type InstalledModelPackage,
  type InstalledModelPackagesResponse,
  type InventoryEntryId,
  type InventoryModel,
  type InventoryProperties,
  type Integrity,
  type ModelAvailability,
  type ModelComponent,
  type ModelFile,
  type ModelFileRelationship,
  type ModelFileRole,
  type ModelOperation,
  type ModelPackage,
  type ModelPackageId,
  type ModelPackageInstallationOrigin,
  type ModelPackageSource,
  type ModelSource,
  type RecommendableModel,
  type ServableModelBundle,
} from "./_contracts-shim"
import { ModelCache, type ModelIndexKind } from "./cache"
import { blobKey } from "./download"
import { inspect } from "./gguf"
import { contentId, fingerprint, inventoryEntryId } from "./identity"
import {
  packageValidationFor,
  validatedPackageFromResolved,
  type ValidatedModelPackage,
} from "./package-service"
import { resolveComponents } from "./service-resolve"
import { ensureStoreLayout } from "./store-fs"
import { recoverMap } from "./file-cache"
import { hfRepoDir } from "./paths"

const MAX_SCAN_ENTRIES = 100_000
const MAX_SCAN_DEPTH = 8
export const BACKGROUND_RECONCILIATION_RETRY_DELAY_MS = 1_000

export interface CacheEvidence {
  content_id: string
  observation_key: string
  metadata_key: string
}

export interface CachedModelMetadata {
  name: string
  properties: InventoryProperties
  supported_parameters: string[]
}

export interface InstalledPackageRecord {
  installed: InstalledModelPackage
  model: InventoryModel
}

export interface InstalledPackageSnapshot {
  records: Map<InventoryEntryId, InstalledPackageRecord>
}

export const installedPackageSnapshotResponse = (
  snapshot: InstalledPackageSnapshot,
  revision: number,
  reconciliationComplete: boolean,
): InstalledModelPackagesResponse => {
  const packages = new Map<ModelPackageId, InstalledModelPackage>()
  for (const record of snapshot.records.values()) {
    const existing = packages.get(record.installed.package.id)
    if (
      existing !== undefined &&
      existing.origin === "hugging_face_cache" &&
      record.installed.origin === "magnitude"
    ) {
      packages.set(record.installed.package.id, record.installed)
    } else if (existing === undefined) {
      packages.set(record.installed.package.id, record.installed)
    }
  }
  return {
    revision,
    reconciliation_complete: reconciliationComplete,
    packages: [...packages.values()],
  }
}

export interface InventoryConfig {
  root: string
  cache_root: string
  hf_cache_dirs: string[]
  max_concurrent_downloads: number
  disk_reserve_bytes: number
  catalog_models: RecommendableModel[]
}

export const InventoryConfig = {
  defaultRoot(): string {
    const home = process.env.HOME
    if (home === undefined) {
      throw InventoryError.InvalidRequest({
        message: "cannot determine the user home directory for the model store",
      })
    }
    return join(home, ".magnitude/models")
  },

  defaultCacheRoot(): string {
    const home = process.env.HOME
    if (home === undefined) {
      throw InventoryError.InvalidRequest({
        message: "cannot determine the user home directory for the cache",
      })
    }
    return join(home, ".magnitude/cache")
  },

  withRoots(root: string, cacheRoot: string): InventoryConfig {
    if (!root.startsWith("/") || !cacheRoot.startsWith("/")) {
      throw InventoryError.InvalidRequest({
        message: "model store and cache roots must be absolute",
      })
    }
    return {
      root,
      cache_root: cacheRoot,
      hf_cache_dirs: [],
      max_concurrent_downloads: 2,
      disk_reserve_bytes: 2 * 1024 * 1024 * 1024,
      catalog_models: [],
    }
  },
}

export const now = (): number => Math.floor(Date.now() / 1000)

export const catalogTarget = (model: RecommendableModel): ModelPackage => {
  const bundle = model.configuration.bundle
  return bundle._tag === "Standalone" ? bundle.package : bundle.target
}

interface ArtifactCandidate {
  id: InventoryEntryId
  content_id: ContentId
  created: number
  ready_at: number
  source: ModelSource
  location: InventoryModel["location"]
  primary: string
  deletable: boolean
}

type DiscoveryCandidate = { readonly _tag: "Artifact"; candidate: ArtifactCandidate }

export interface InventoryScan {
  models: Map<InventoryEntryId, InventoryModel>
  observations: Map<InventoryEntryId, string>
  metadata_keys: Map<InventoryEntryId, string>
}

export class ManagedModelStore {
  readonly config: InventoryConfig
  readonly cache: ModelCache
  private readonly models = new Map<InventoryEntryId, InventoryModel>()
  private readonly cacheEvidence = new Map<InventoryEntryId, CacheEvidence>()
  private installedPackages: InstalledPackageSnapshot = { records: new Map() }
  private ensureGate: Promise<void> = Promise.resolve()
  private ensureGateRelease: (() => void) | undefined
  private ensureGeneration = 0
  private reconciliationRunning = false
  private reconciliationComplete = false

  private constructor(config: InventoryConfig, cache: ModelCache) {
    this.config = config
    this.cache = cache
  }

  static async open(config: InventoryConfig): Promise<ManagedModelStore> {
    validateConfig(config)
    await ensureStoreLayout(config.root)
    const cache = new ModelCache(config.cache_root)
    const manager = new ManagedModelStore(config, cache)
    return manager
  }

  /** Starts background installed-model reconciliation (call from process bootstrap). */
  startBackgroundReconciliation(): void {
    this.requestInstalledModelReconciliation()
  }

  requestInstalledModelReconciliation(): void {
    if (this.reconciliationRunning) return
    this.reconciliationRunning = true
    void (async () => {
      while (!this.reconciliationComplete) {
        try {
          await this.ensureInstalledModelInventory()
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, BACKGROUND_RECONCILIATION_RETRY_DELAY_MS))
        }
      }
      this.reconciliationRunning = false
    })()
  }

  root(): string {
    return this.config.root
  }

  async ensureModelInventory(): Promise<void> {
    await this.reconcileModelInventory()
  }

  async ensureInstalledModelInventory(): Promise<void> {
    await this.reconcileModelInventory()
  }

  private async reconcileModelInventory(): Promise<void> {
    const observedGeneration = this.ensureGeneration
    await this.acquireEnsureGate()
    try {
      if (this.ensureGeneration !== observedGeneration) {
        return
      }
      const liveModels = new Map(this.models)
      const scanResult = scan(this.config, this.cache, liveModels)
    const discovered = scanResult.models
    const nextEvidence = new Map<InventoryEntryId, CacheEvidence>()
    for (const model of discovered.values()) {
      if (!isCacheableModel(model)) continue
      const observationKey = scanResult.observations.get(model.id)
      const metadataKey = scanResult.metadata_keys.get(model.id)
      if (observationKey === undefined || metadataKey === undefined) {
        throw InventoryError.Internal({
          message: `ready model ${model.id} has incomplete discovery evidence`,
        })
      }
      nextEvidence.set(model.id, {
        content_id: model.content_id,
        observation_key: observationKey,
        metadata_key: metadataKey,
      })
    }
    const installedPackages = await this.buildInstalledPackageSnapshot(discovered)
    persistInventoryIndex(this.cache, discovered, nextEvidence, installedPackages)
    for (const [id, model] of discovered) {
      this.models.set(id, model)
    }
    this.cacheEvidence.clear()
    for (const [id, evidence] of nextEvidence) {
      this.cacheEvidence.set(id, evidence)
    }
    this.installedPackages = installedPackages
    this.ensureGeneration += 1
    this.reconciliationComplete = true
    } finally {
      this.releaseEnsureGate()
    }
  }

  private acquireEnsureGate(): Promise<void> {
    const previous = this.ensureGate
    let release: () => void = () => {}
    this.ensureGate = new Promise<void>((resolve) => {
      release = resolve
    })
    this.ensureGateRelease = release
    return previous
  }

  private releaseEnsureGate(): void {
    this.ensureGateRelease?.()
    this.ensureGateRelease = undefined
  }

  async list(): Promise<InventoryModel[]> {
    const models = [...this.models.values()]
    models.sort((left, right) => {
      const rank = (model: InventoryModel): number => {
        switch (model.availability._tag) {
          case "Available":
            return 0
          case "Downloading":
            return 1
          case "Interrupted":
            return 2
          default:
            return 3
        }
      }
      return (
        rank(left) - rank(right) ||
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
        left.id.localeCompare(right.id)
      )
    })
    return models
  }

  async listInstalled(): Promise<InstalledModelPackagesResponse> {
    return this.installedPackagesResponse()
  }

  installedPackagesResponse(): InstalledModelPackagesResponse {
    return installedPackageSnapshotResponse(
      this.installedPackages,
      this.ensureGeneration,
      this.reconciliationComplete,
    )
  }

  async registerActiveModel(path: string, displayName?: string): Promise<InventoryEntryId> {
    const canonical = realpathSync(path)
    if (!statSync(canonical).isFile()) {
      throw InventoryError.InvalidRequest({ message: `active model is not a regular file: ${path}` })
    }
    for (const model of this.models.values()) {
      const primary = modelPrimaryPath(this.config.root, model)
      if (primary === canonical) {
        return model.id
      }
    }
    const metadata = statSync(canonical)
    const component: ModelComponent = {
      path: basename(canonical),
      role: "Weights",
      size_bytes: metadata.size,
      content: ContentIdentity.FileIdentity(fileIdentity(canonical, metadata)),
      shard_index: undefined,
      relationship: undefined,
    }
    const content = contentId([component])
    const id = inventoryEntryId("active-file", canonical, content)
    const timestamp = now()
    const model = buildModel(
      id,
      content,
      timestamp,
      timestamp,
      { _tag: "Local", declared_by: "active_process" },
      {
        _tag: "File",
        path: canonical,
        component,
        integrity: { _tag: "Unverified", reason: "active_process" },
      },
      canonical,
      false,
      this.cache,
    )
    if (displayName !== undefined) {
      model.name = displayName
    }
    await this.completeAndPublishModel(model)
    return id
  }

  async completeAndPublishModel(model: InventoryModel): Promise<InventoryModel> {
    await this.acquireEnsureGate()
    const evidence = isCacheableModel(model)
      ? {
          content_id: model.content_id,
          observation_key: modelObservationKey(this.config.root, model),
          metadata_key: modelMetadataEvidenceForModel(model),
        }
      : undefined
    const models = new Map(this.models)
    models.set(model.id, model)
    if (evidence !== undefined) {
      this.cacheEvidence.set(model.id, evidence)
    } else {
      this.cacheEvidence.delete(model.id)
    }
    const installed = await this.buildInstalledPackageSnapshot(models)
    persistInventoryIndex(this.cache, models, this.cacheEvidence, installed)
    this.models.clear()
    for (const [id, value] of models) {
      this.models.set(id, value)
    }
    this.installedPackages = installed
    this.ensureGeneration += 1
    this.releaseEnsureGate()
    return model
  }

  async buildInstalledPackageSnapshot(
    models: Map<InventoryEntryId, InventoryModel>,
  ): Promise<InstalledPackageSnapshot> {
    const records = new Map<InventoryEntryId, InstalledPackageRecord>()
    for (const model of models.values()) {
      if (
        model.availability._tag !== "Available" &&
        model.availability._tag !== "InvalidArtifact" &&
        model.availability._tag !== "IncompatibleArtifact"
      ) {
        continue
      }
      const resolved = {
        model,
        components: resolveComponents(this.config.root, model),
      }
      const validated = await validatedPackageFromResolved(resolved)
      const installed: InstalledModelPackage = {
        path: installedPath(model, resolved),
        origin: installedOrigin(model),
        validation: validated.validation,
        catalog_attribution: notCatalogTarget(),
        package: validated.package,
      }
      records.set(model.id, { installed, model })
    }
    return { records }
  }

  installedPackageFromSnapshot(packageId: ModelPackageId): [ModelPackage, InventoryModel] {
    const matches = [...this.installedPackages.records.values()].filter(
      (record) => record.installed.package.id === packageId,
    )
    if (matches.length === 0) {
      throw InventoryError.NotFound({ id: packageId })
    }
    matches.sort((left, right) => {
      const leftScore = left.installed.origin === "hugging_face_cache" ? 1 : 0
      const rightScore = right.installed.origin === "hugging_face_cache" ? 1 : 0
      return leftScore - rightScore || left.model.id.localeCompare(right.model.id)
    })
    const record = matches[0]
    return [record.installed.package, record.model]
  }

  /** Test hook: direct access to in-memory inventory models. */
  getModels(): Map<InventoryEntryId, InventoryModel> {
    return this.models
  }

  /** Test hook: block reconciliation like the Rust ensure_gate lock. */
  async lockReconciliation(): Promise<() => void> {
    await this.acquireEnsureGate()
    return () => this.releaseEnsureGate()
  }
}

const notCatalogTarget = (): InstalledCatalogAttribution => ({ _tag: "NotCatalogTarget" })

const installedOrigin = (model: InventoryModel): ModelPackageInstallationOrigin => {
  switch (model.location._tag) {
    case "HuggingFaceCache":
      return "hugging_face_cache"
    default:
      return "magnitude"
  }
}

const installedPath = (model: InventoryModel, resolved: { components: readonly { path: string }[] }): string => {
  switch (model.location._tag) {
    case "Directory":
      return model.location.root
    case "File":
      return model.location.path
    case "HuggingFaceCache":
      return model.location.cache_root
    case "MagnitudeCache":
      return resolved.components[0]?.path !== undefined
        ? dirname(resolved.components[0].path)
        : ""
  }
}

export const buildModel = (
  id: InventoryEntryId,
  contentIdValue: ContentId,
  created: number,
  readyAt: number,
  source: ModelSource,
  location: InventoryModel["location"],
  primary: string,
  deletable: boolean,
  cache: ModelCache,
): InventoryModel => {
  const primaryName = basename(primary) || "local model"
  const metadataEvidence = modelMetadataEvidence(contentIdValue, primaryName)
  const cached = cache.readIndex<CachedModelMetadata>("InventoryMetadata", metadataEvidence)
  if (cached !== undefined) {
    return availableModel(id, contentIdValue, created, readyAt, source, location, cached, deletable)
  }
  try {
    const inspection = inspect(primary)
    const evidence = fingerprint(inspection.fingerprint_material)
    const inspected: CachedModelMetadata = {
      name: inspection.name ?? basename(primary, ".gguf") ?? "local model",
      properties: {
        _tag: "Inspected",
        architecture: inspection.architecture,
        quantization: inspection.quantization,
        quantization_name: inspection.quantization_name,
        parameter_count: inspection.parameter_count,
        active_parameter_count: inspection.active_parameter_count,
        training_context_length: inspection.training_context_length,
        nextn_predict_layers: inspection.nextn_predict_layers,
        tokenizer: inspection.tokenizer,
        modalities: inspection.modalities,
        base_models: inspection.base_models,
        evidence_fingerprint: evidence,
      },
      supported_parameters: [],
    }
    cache.writeIndex("InventoryMetadata", metadataEvidence, inspected)
    return availableModel(id, contentIdValue, created, readyAt, source, location, inspected, deletable)
  } catch (error) {
    const incompatible =
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      (error as { _tag: string })._tag === "UnsupportedVersion"
    return unavailableModel(
      id,
      contentIdValue,
      created,
      readyAt,
      source,
      location,
      primary,
      deletable,
      incompatible ? "unsupported_gguf_version" : "invalid_gguf",
      String(error),
      incompatible,
    )
  }
}

const availableModel = (
  id: InventoryEntryId,
  contentIdValue: ContentId,
  created: number,
  readyAt: number,
  source: ModelSource,
  location: InventoryModel["location"],
  inspected: CachedModelMetadata,
  deletable: boolean,
): InventoryModel => {
  const operations: ModelOperation[] = ["load", "unload"]
  if (deletable) operations.push("delete")
  return {
    id,
    content_id: contentIdValue,
    created,
    name: inspected.name,
    supported_parameters: inspected.supported_parameters,
    availability: { _tag: "Available", ready_at: readyAt },
    source,
    location,
    properties: inspected.properties,
    operations,
    updated_at: readyAt,
  }
}

const unavailableModel = (
  id: InventoryEntryId,
  contentIdValue: ContentId,
  created: number,
  detectedAt: number,
  source: ModelSource,
  location: InventoryModel["location"],
  primary: string,
  deletable: boolean,
  code: string,
  message: string,
  incompatible: boolean,
): InventoryModel => {
  const availability: ModelAvailability = incompatible
    ? { _tag: "IncompatibleArtifact", detected_at: detectedAt, code, message }
    : { _tag: "InvalidArtifact", detected_at: detectedAt, code, message }
  const operations: ModelOperation[] = deletable ? ["delete"] : []
  return {
    id,
    content_id: contentIdValue,
    created,
    name: basename(primary) || "local model",
    supported_parameters: [],
    availability,
    source,
    location,
    properties: { _tag: "Unavailable", reason: message },
    operations,
    updated_at: detectedAt,
  }
}

export const scan = (
  config: InventoryConfig,
  cache: ModelCache,
  liveModels: Map<InventoryEntryId, InventoryModel>,
): InventoryScan => {
  const discovered: DiscoveryCandidate[] = []
  scanManaged(config, discovered)
  const distinct = new Set<string>()
  for (const cacheDir of config.hf_cache_dirs) {
    let canonical = cacheDir
    try {
      canonical = realpathSync(cacheDir)
    } catch {
      // keep original
    }
    if (canonical !== join(config.root, "hub") && !distinct.has(canonical)) {
      distinct.add(canonical)
      scanHfCache(canonical, discovered)
    }
  }
  const [cachedModels] = loadInventoryIndex(cache)
  for (const [id, durable] of cachedModels) {
    const live = liveModels.get(id)
    if (live !== undefined && live.content_id === durable.content_id) {
      cachedModels.set(id, live)
    }
  }
  const seenPaths = new Set<string>()
  const models = new Map<InventoryEntryId, InventoryModel>()
  const observations = new Map<InventoryEntryId, string>()
  const metadataKeys = new Map<InventoryEntryId, string>()
  const stale: ArtifactCandidate[] = []
  for (const candidate of discovered) {
    const path = candidate.candidate.primary
    let canonical = path
    try {
      canonical = realpathSync(path)
    } catch {
      // keep
    }
    const distinctPath =
      candidate.candidate.location._tag === "MagnitudeCache"
        ? (seenPaths.has(canonical) ? false : (seenPaths.add(canonical), true))
        : seenPaths.add(canonical)
    if (!distinctPath) continue
    const artifact = candidate.candidate
    const observationKey = artifactObservationKey(config.root, artifact.source, artifact.location)
    const metadataKey = modelMetadataEvidence(artifact.content_id, basename(artifact.primary))
    observations.set(artifact.id, observationKey)
    metadataKeys.set(artifact.id, metadataKey)
    const reused = reuseMetadata(artifact, observationKey, metadataKey, cachedModels, loadEvidence(cache))
    if (reused !== undefined) {
      models.set(reused.id, reused)
    } else {
      stale.push(artifact)
    }
  }
  for (const candidate of stale) {
    const model = buildModel(
      candidate.id,
      candidate.content_id,
      candidate.created,
      candidate.ready_at,
      candidate.source,
      candidate.location,
      candidate.primary,
      candidate.deletable,
      cache,
    )
    models.set(model.id, model)
  }
  return { models, observations, metadata_keys: metadataKeys }
}

const loadEvidence = (cache: ModelCache): Map<InventoryEntryId, CacheEvidence> => {
  const inventory = cache.readInventory()
  if (inventory === undefined) return new Map()
  const recovered = recoverMap<CacheEvidence>(inventory.evidence, MAX_SCAN_ENTRIES)
  const evidence = new Map<InventoryEntryId, CacheEvidence>()
  for (const [key, value] of recovered) {
    evidence.set(InventoryEntryIdBrand.make(key), value)
  }
  return evidence
}

const scanManaged = (config: InventoryConfig, output: DiscoveryCandidate[]): void => {
  const managed = join(config.root, "hub")
  if (!statSync(managed, { throwIfNoEntry: false })?.isDirectory()) {
    return
  }
  let count = 0
  for (const repoEntry of readDirSorted(managed)) {
    const repository = parseHfRepoDir(repoEntry)
    if (repository === undefined) continue
    const repositoryRoot = join(managed, repoEntry)
    for (const snapshotEntry of readDirSorted(join(repositoryRoot, "snapshots"))) {
      const snapshotPath = join(repositoryRoot, "snapshots", snapshotEntry)
      const metadata = lstatSync(snapshotPath)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue
      count += 1
      if (count > MAX_SCAN_ENTRIES) {
        throw InventoryError.Io({ message: "managed model scan exceeded entry bound" })
      }
      appendDiscoveredGroups(repository, repositoryRoot, snapshotPath, snapshotEntry, output)
      for (const catalogModel of config.catalog_models) {
        for (const [package_] of catalogPackages(catalogModel)) {
          if (package_.source._tag !== "HuggingFace" || package_.source.repository !== repository) {
            continue
          }
          const components = componentsForCatalogPackage(package_)
          if (!catalogComponentsPresent(snapshotPath, repositoryRoot, components)) continue
          const primary = primaryPath(snapshotPath, components)
          if (primary === undefined) continue
          const content = contentId(components)
          const id = inventoryEntryId("magnitude-cache", snapshotPath, content)
          const timestamp = modifiedSeconds(snapshotPath) ?? now()
          output.push({
            _tag: "Artifact",
            candidate: {
              id,
              content_id: content,
              created: timestamp,
              ready_at: timestamp,
              source: {
                _tag: "HuggingFace",
                repository: package_.source.repository,
                requested_revision: package_.source.revision,
                commit: snapshotEntry,
                metadata: null,
              },
              location: {
                _tag: "MagnitudeCache",
                total_bytes: components.reduce((sum, item) => sum + item.size_bytes, 0),
                components,
                integrity: { _tag: "Verified", method: "catalog_content_identity" },
              },
              primary,
              deletable: true,
            },
          })
        }
      }
    }
  }
}

const catalogPackages = (
  model: RecommendableModel,
): Array<[ModelPackage, "target" | "dependency"]> => {
  const bundle = model.configuration.bundle
  const target: [ModelPackage, "target" | "dependency"] = [catalogTarget(model), "target"]
  if (bundle._tag === "SpeculativeDecoding" && bundle.draft_source._tag === "Separate") {
    return [target, [bundle.draft_source.draft, "dependency"]]
  }
  return [target]
}

const scanHfCache = (cache: string, output: DiscoveryCandidate[]): void => {
  if (!statSync(cache, { throwIfNoEntry: false })?.isDirectory()) return
  let count = 0
  for (const repoEntry of readDirSorted(cache)) {
    const repository = parseHfRepoDir(repoEntry)
    if (repository === undefined) continue
    const repoRoot = join(cache, repoEntry)
    let currentCommit: string | undefined
    try {
      currentCommit = readFileSync(join(repoRoot, "refs/main"), "utf8").trim() || undefined
    } catch {
      currentCommit = undefined
    }
    const snapshots = join(repoRoot, "snapshots")
    for (const snapshotEntry of readDirSorted(snapshots)) {
      count += 1
      if (count > MAX_SCAN_ENTRIES) {
        throw InventoryError.Io({ message: "Hugging Face cache scan exceeded entry bound" })
      }
      const snapshot = join(snapshots, snapshotEntry)
      for (const group of discoverGroups(snapshot, repoRoot)) {
        const components = componentsForGroup(snapshot, group)
        const primary = primaryPath(snapshot, components)
        if (primary === undefined) continue
        const content = contentId(components)
        const id = inventoryEntryId("hugging-face-cache", snapshot, content)
        const created = modifiedSeconds(snapshot) ?? now()
        output.push({
          _tag: "Artifact",
          candidate: {
            id,
            content_id: content,
            created,
            ready_at: created,
            source: {
              _tag: "HuggingFace",
              repository,
              requested_revision: currentCommit === snapshotEntry ? "main" : snapshotEntry,
              commit: snapshotEntry,
              metadata: null,
            },
            location: {
              _tag: "HuggingFaceCache",
              cache_root: snapshot,
              repository,
              commit: snapshotEntry,
              total_bytes: components.reduce((sum, item) => sum + item.size_bytes, 0),
              components,
              integrity: { _tag: "Unverified", reason: "external_cache" },
            },
            primary,
            deletable: false,
          },
        })
      }
    }
  }
}

export interface DiscoveredGroup {
  paths: string[]
  projectors: string[]
}

export const discoverGroups = (snapshot: string, repositoryRoot: string): DiscoveredGroup[] => {
  const ggufs = collectGguf(snapshot, repositoryRoot, 0)
  const standalone = ggufs.filter((path) => !isExecutionCompanion(path, basename(path)))
  const groups: DiscoveredGroup[] = []
  const shards = new Map<string, string[]>()
  for (const path of standalone) {
    const shard = splitShardName(path)
    if (shard !== undefined) {
      const key = join(dirname(path), shard.prefix)
      const existing = shards.get(key) ?? []
      existing.push(path)
      shards.set(key, existing)
    } else {
      groups.push({ paths: [path], projectors: [] })
    }
  }
  for (const paths of shards.values()) {
    groups.push({ paths, projectors: [] })
  }
  return groups
}

export const isExecutionCompanionName = (name: string): boolean => {
  const lower = name.toLowerCase()
  return (
    lower.includes("dflash") ||
    lower.includes("dspark") ||
    lower.includes("eagle3") ||
    lower.endsWith("-mtp.gguf") ||
    lower.includes("mtp-") ||
    lower.includes("mtp_")
  )
}

const isExecutionCompanion = (path: string, name: string): boolean => {
  if (isExecutionCompanionName(name)) return true
  try {
    const inspection = inspect(path)
    return inspection.execution_role === "Draft"
  } catch {
    return false
  }
}

export const splitShardName = (path: string): { prefix: string; index: number; total: number } | undefined => {
  const name = basename(path)
  const match = /^(.+)-(\d{5})-of-(\d{5})\.gguf$/i.exec(name)
  if (match === null) return undefined
  const index = Number(match[2])
  const total = Number(match[3])
  if (!Number.isFinite(index) || !Number.isFinite(total)) return undefined
  return { prefix: match[1], index, total }
}

export const parseHfRepoDir = (value: string): string | undefined => {
  if (!value.startsWith("models--")) return undefined
  const parts = value.slice("models--".length).split("--")
  if (parts.length < 2) return undefined
  return `${parts[0]}/${parts.slice(1).join("--")}`
}

const componentsForGroup = (snapshot: string, group: DiscoveredGroup): ModelComponent[] => {
  const components: ModelComponent[] = []
  for (const path of group.paths) {
    const metadata = statSync(path)
    const shard = splitShardName(path)
    components.push({
      path: relative(snapshot, path),
      role: shard !== undefined ? "Shard" : "Weights",
      size_bytes: metadata.size,
      content: contentIdentityForFile(path, metadata),
      shard_index: shard?.index,
      relationship: undefined,
    })
  }
  return components
}

const componentsForCatalogPackage = (package_: ModelPackage): ModelComponent[] => {
  const paths = new Map(package_.files.map((file) => [file.id, file.path]))
  return package_.files.map((file) => {
    const shard = package_.relationships.find(
      (relationship): relationship is Extract<ModelFileRelationship, { _tag: "Shard" }> =>
        relationship._tag === "Shard" && relationship.file_id === file.id,
    )
    const relationship = package_.relationships.find((relationship) => {
      switch (relationship._tag) {
        case "ProjectorFor":
          return relationship.projector_file_id === file.id
        case "MtpFor":
          return relationship.mtp_file_id === file.id
        case "DraftFor":
          return relationship.draft_file_id === file.id
        default:
          return false
      }
    })
    const mappedRelationship = relationship === undefined
      ? undefined
      : mapRelationship(relationship, paths, file.path)
    const role: ComponentRole =
      file.role === "weights"
        ? shard !== undefined
          ? "Shard"
          : "Weights"
        : file.role === "projector"
          ? "Projector"
          : file.role === "draft"
            ? "Draft"
            : file.role === "mtp"
              ? "Mtp"
              : "Auxiliary"
    return {
      path: file.path,
      role,
      size_bytes: file.size_bytes,
      content: ContentIdentity.Sha256(file.sha256),
      shard_index: shard?.index,
      relationship: mappedRelationship,
    }
  })
}

const mapRelationship = (
  relationship: ModelFileRelationship,
  paths: Map<ModelPackage["files"][number]["id"], string>,
  filePath: string,
): ModelComponent["relationship"] => {
  switch (relationship._tag) {
    case "ProjectorFor":
      return {
        _tag: "ProjectorFor",
        projector: filePath,
        model: paths.get(relationship.weights_file_id) ?? "",
      }
    case "MtpFor":
      return { _tag: "MtpFor", mtp: filePath, model: paths.get(relationship.weights_file_id) ?? "" }
    case "DraftFor":
      return {
        _tag: "DraftFor",
        draft: filePath,
        model: paths.get(relationship.weights_file_id) ?? "",
        method: relationship.method,
      }
    default:
      return undefined
  }
}

const catalogComponentsPresent = (
  snapshot: string,
  repositoryRoot: string,
  components: ModelComponent[],
): boolean => {
  let canonicalBlobs: string
  try {
    canonicalBlobs = realpathSync(join(repositoryRoot, "blobs"))
  } catch {
    return false
  }
  return components.every((component) => {
    const blob = join(repositoryRoot, "blobs", blobKey(component.content))
    let canonicalBlob: string
    try {
      canonicalBlob = realpathSync(blob)
    } catch {
      return false
    }
    if (!canonicalBlob.startsWith(canonicalBlobs)) return false
    const blobMetadata = statSync(blob)
    if (!blobMetadata.isFile() || blobMetadata.size !== component.size_bytes) return false
    const destination = join(snapshot, component.path)
    try {
      const destinationMetadata = statSync(destination)
      return (
        destinationMetadata.isFile() &&
        destinationMetadata.size === component.size_bytes &&
        realpathSync(destination) === canonicalBlob
      )
    } catch {
      return false
    }
  })
}

const appendDiscoveredGroups = (
  repository: string,
  repositoryRoot: string,
  snapshot: string,
  commit: string,
  output: DiscoveryCandidate[],
): void => {
  for (const group of discoverGroups(snapshot, repositoryRoot)) {
    const components = componentsForGroup(snapshot, group)
    const primary = primaryPath(snapshot, components)
    if (primary === undefined) continue
    const content = contentId(components)
    const id = inventoryEntryId("magnitude-cache", snapshot, content)
    const timestamp = modifiedSeconds(snapshot) ?? now()
    output.push({
      _tag: "Artifact",
      candidate: {
        id,
        content_id: content,
        created: timestamp,
        ready_at: timestamp,
        source: {
          _tag: "HuggingFace",
          repository,
          requested_revision: commit,
          commit,
          metadata: null,
        },
        location: {
          _tag: "MagnitudeCache",
          total_bytes: components.reduce((sum, item) => sum + item.size_bytes, 0),
          components,
          integrity: { _tag: "Unverified", reason: "filesystem_discovery" },
        },
        primary,
        deletable: true,
      },
    })
  }
}

const primaryPath = (snapshot: string, components: ModelComponent[]): string | undefined => {
  const weights = components
    .filter((component) => component.role === "Weights" || component.role === "Shard")
    .sort((left, right) => (left.shard_index ?? 0) - (right.shard_index ?? 0))
  if (weights.length === 0) return undefined
  return join(snapshot, weights[0].path)
}

const collectGguf = (directory: string, repositoryRoot: string, depth: number): string[] => {
  if (depth > MAX_SCAN_DEPTH) return []
  const entries = readDirSorted(directory)
  const paths: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry)
    const metadata = lstatSync(path)
    if (metadata.isSymbolicLink()) {
      let resolved = path
      try {
        resolved = realpathSync(path)
      } catch {
        continue
      }
      if (!resolved.startsWith(repositoryRoot)) continue
      if (resolved.toLowerCase().endsWith(".gguf")) paths.push(path)
      continue
    }
    if (metadata.isFile() && entry.toLowerCase().endsWith(".gguf")) {
      paths.push(path)
    } else if (metadata.isDirectory()) {
      paths.push(...collectGguf(path, repositoryRoot, depth + 1))
    }
  }
  return paths
}

const reuseMetadata = (
  candidate: ArtifactCandidate,
  observationKey: string,
  metadataKey: string,
  cachedModels: Map<InventoryEntryId, InventoryModel>,
  cachedEvidence: Map<InventoryEntryId, CacheEvidence>,
): InventoryModel | undefined => {
  const evidence = cachedEvidence.get(candidate.id)
  const cached = cachedModels.get(candidate.id)
  if (
    evidence === undefined ||
    cached === undefined ||
    evidence.content_id !== candidate.content_id ||
    evidence.observation_key !== observationKey ||
    evidence.metadata_key !== metadataKey
  ) {
    return undefined
  }
  const terminal =
    (cached.availability._tag === "Available" && cached.properties._tag === "Inspected") ||
    ((cached.availability._tag === "InvalidArtifact" ||
      cached.availability._tag === "IncompatibleArtifact") &&
      cached.properties._tag === "Unavailable")
  if (!terminal) return undefined
  const operations: ModelOperation[] =
    cached.availability._tag === "Available"
      ? candidate.deletable
        ? ["load", "unload", "delete"]
        : ["load", "unload"]
      : candidate.deletable
        ? ["delete"]
        : []
  return {
    ...cached,
    content_id: candidate.content_id,
    source: candidate.source,
    location: candidate.location,
    operations,
  }
}

const loadInventoryIndex = (
  cache: ModelCache,
): [Map<InventoryEntryId, InventoryModel>, Map<InventoryEntryId, CacheEvidence>, InstalledPackageSnapshot] => {
  const index = cache.readInventory()
  if (index === undefined) {
    return [new Map(), new Map(), { records: new Map() }]
  }
  const rawModels = recoverMap<InventoryModel>(index.models, MAX_SCAN_ENTRIES)
  const rawEvidence = recoverMap<CacheEvidence>(index.evidence, MAX_SCAN_ENTRIES)
  const installed =
    typeof index.installed === "object" && index.installed !== null
      ? (index.installed as InstalledPackageSnapshot)
      : { records: new Map() }
  const models = new Map<InventoryEntryId, InventoryModel>()
  for (const [rawId, model] of rawModels) {
    try {
      const id = InventoryEntryIdBrand.parse(rawId)
      if (model.id === id) {
        models.set(id, model)
      }
    } catch {
      // skip malformed ids
    }
  }
  const evidence = new Map<InventoryEntryId, CacheEvidence>()
  for (const [rawId, entry] of rawEvidence) {
    try {
      const id = InventoryEntryIdBrand.parse(rawId)
      if (models.has(id)) {
        evidence.set(id, entry)
      }
    } catch {
      // skip
    }
  }
  return [models, evidence, installed]
}

const persistInventoryIndex = (
  cache: ModelCache,
  models: Map<InventoryEntryId, InventoryModel>,
  evidence: Map<InventoryEntryId, CacheEvidence>,
  installed: InstalledPackageSnapshot,
): void => {
  cache.writeInventory({
    models: Object.fromEntries(models),
    evidence: Object.fromEntries(evidence),
    installed,
  })
}

const validateConfig = (config: InventoryConfig): void => {
  if (!config.root.startsWith("/")) {
    throw InventoryError.InvalidRequest({ message: "model store root must be absolute" })
  }
  if (!config.cache_root.startsWith("/")) {
    throw InventoryError.InvalidRequest({ message: "cache root must be absolute" })
  }
  if (config.max_concurrent_downloads === 0) {
    throw InventoryError.InvalidRequest({ message: "max_concurrent_downloads must be positive" })
  }
  for (const root of config.hf_cache_dirs) {
    if (!root.startsWith("/")) {
      throw InventoryError.InvalidRequest({
        message: `configured Hugging Face cache root must be absolute: ${root}`,
      })
    }
  }
}

const isCacheableModel = (model: InventoryModel): boolean => {
  switch (model.availability._tag) {
    case "Available":
      return model.properties._tag === "Inspected"
    case "InvalidArtifact":
    case "IncompatibleArtifact":
      return model.properties._tag === "Unavailable"
    default:
      return false
  }
}

const modelPrimaryPath = (root: string, model: InventoryModel): string | undefined => {
  const component = modelLocationComponents(model.location).find(
    (item) => item.role === "Weights" || item.role === "Shard",
  )
  if (component === undefined) return undefined
  let path: string
  if (model.location._tag === "MagnitudeCache" && model.source._tag === "HuggingFace") {
    path = join(
      root,
      "hub",
      hfRepoDir(model.source.repository),
      "snapshots",
      model.source.commit,
      component.path,
    )
  } else if (model.location._tag === "HuggingFaceCache") {
    path = join(model.location.cache_root, component.path)
  } else if (model.location._tag === "Directory") {
    path = join(model.location.root, component.path)
  } else if (model.location._tag === "File") {
    path = model.location.path
  } else {
    return undefined
  }
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

const modelObservationKey = (root: string, model: InventoryModel): string =>
  artifactObservationKey(root, model.source, model.location)

const artifactObservationKey = (
  root: string,
  source: ModelSource,
  location: InventoryModel["location"],
): string => {
  if (source._tag === "HuggingFace" && location._tag === "MagnitudeCache") {
    return `magnitude-cache:${source.repository}:${source.commit}:${contentId([...location.components]).toString()}`
  }
  if (location._tag === "HuggingFaceCache") {
    return `hugging-face-cache:${location.cache_root}:${contentId([...location.components]).toString()}`
  }
  if (location._tag === "Directory") {
    return `directory:${location.root}`
  }
  if (location._tag === "File") {
    return `file:${location.path}`
  }
  return `unknown:${root}`
}

const modelMetadataEvidence = (contentIdValue: ContentId, primaryName: string): string =>
  JSON.stringify([contentIdValue, primaryName])

const modelMetadataEvidenceForModel = (model: InventoryModel): string => {
  const primary = modelLocationComponents(model.location).find(
    (component) => component.role === "Weights" || component.role === "Shard",
  )
  const primaryName = primary !== undefined ? basename(primary.path) : "local model"
  return modelMetadataEvidence(model.content_id, primaryName)
}

const fileIdentity = (path: string, metadata: { mtimeMs: number; size: number }): string => {
  const digest = createHash("sha256")
  digest.update(`${path}:${metadata.mtimeMs}:${metadata.size}`)
  return digest.digest("hex")
}

const contentIdentityForFile = (path: string, metadata: { mtimeMs: number; size: number }): ContentIdentity =>
  ContentIdentity.FileIdentity(fileIdentity(path, metadata))

const modifiedSeconds = (path: string): number | undefined => {
  try {
    return Math.floor(statSync(path).mtimeMs / 1000)
  } catch {
    return undefined
  }
}

const readDirSorted = (path: string): string[] => {
  try {
    return readdirSync(path).sort()
  } catch {
    return []
  }
}
