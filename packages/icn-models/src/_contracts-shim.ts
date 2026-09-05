/**
 * Minimal stand-in for `@magnitudedev/icn-contracts` types used by icn-models.
 *
 * Replace imports from this module with `@magnitudedev/icn-contracts` once the
 * contracts package lands in wave 2. Keep serde field names (snake_case) aligned
 * with inference/crates/icn-contracts.
 */

import { Schema } from "effect"

// --- Branded IDs ---
export type InventoryEntryId = string & { readonly _tag: "InventoryEntryId" }
export type ContentId = string & { readonly _tag: "ContentId" }
export type ModelPackageId = string & { readonly _tag: "ModelPackageId" }
export type ModelFileId = string & { readonly _tag: "ModelFileId" }
export type ModelDownloadId = string & { readonly _tag: "ModelDownloadId" }
export type ModelAssessmentId = string & { readonly _tag: "ModelAssessmentId" }
export type MemoryDomainId = string & { readonly _tag: "MemoryDomainId" }

export const InventoryEntryId = {
  parse(value: string): InventoryEntryId {
    if (!value.startsWith("mdl_")) {
      throw inventoryError.invalidId(value)
    }
    return value as InventoryEntryId
  },
  make(value: string): InventoryEntryId {
    return value as InventoryEntryId
  },
}

export const ContentId = {
  parse(value: string): ContentId {
    if (!value.startsWith("content_")) {
      throw inventoryError.invalidId(value)
    }
    return value as ContentId
  },
  make(value: string): ContentId {
    return value as ContentId
  },
}

export const ModelPackageId = (value: string): ModelPackageId => value as ModelPackageId
export const ModelFileId = (value: string): ModelFileId => value as ModelFileId
export const ModelDownloadId = (value: string): ModelDownloadId => value as ModelDownloadId
export const ModelAssessmentId = (value: string): ModelAssessmentId => value as ModelAssessmentId

export const MemoryDomainId = {
  system(): MemoryDomainId {
    return "memory_domain_system" as MemoryDomainId
  },
}

// --- Errors ---

export type InventoryError =
  | { readonly _tag: "InvalidId"; value: string }
  | { readonly _tag: "InvalidRequest"; message: string }
  | { readonly _tag: "NotFound"; id: string }
  | { readonly _tag: "NotReady"; id: string }
  | { readonly _tag: "Busy"; id: string }
  | { readonly _tag: "Loaded"; id: string }
  | { readonly _tag: "DeletionUnsafe"; message: string }
  | { readonly _tag: "Unsupported"; message: string }
  | { readonly _tag: "Io"; message: string }
  | { readonly _tag: "Upstream"; message: string }
  | { readonly _tag: "Integrity"; message: string }
  | { readonly _tag: "ConcurrentMutation"; message: string }
  | { readonly _tag: "ModelOperation"; code: string; message: string; retryable: boolean }
  | { readonly _tag: "Internal"; message: string }

export const inventoryError = {
  invalidId: (value: string): InventoryError => ({ _tag: "InvalidId", value }),
  invalidRequest: (message: string): InventoryError => ({ _tag: "InvalidRequest", message }),
  notFound: (id: string): InventoryError => ({ _tag: "NotFound", id }),
  notReady: (id: string): InventoryError => ({ _tag: "NotReady", id }),
  busy: (id: string): InventoryError => ({ _tag: "Busy", id }),
  loaded: (id: string): InventoryError => ({ _tag: "Loaded", id }),
  deletionUnsafe: (message: string): InventoryError => ({ _tag: "DeletionUnsafe", message }),
  unsupported: (message: string): InventoryError => ({ _tag: "Unsupported", message }),
  io: (message: string): InventoryError => ({ _tag: "Io", message }),
  upstream: (message: string): InventoryError => ({ _tag: "Upstream", message }),
  integrity: (message: string): InventoryError => ({ _tag: "Integrity", message }),
  concurrentMutation: (message: string): InventoryError => ({ _tag: "ConcurrentMutation", message }),
  modelOperation: (code: string, message: string, retryable: boolean): InventoryError => ({
    _tag: "ModelOperation",
    code,
    message,
    retryable,
  }),
  internal: (message: string): InventoryError => ({ _tag: "Internal", message }),
}

/** Compatibility factories matching the eventual icn-contracts surface. */
export const InventoryError = {
  InvalidRequest: (input: { message: string }): InventoryError =>
    inventoryError.invalidRequest(input.message),
  NotFound: (input: { id: string }): InventoryError => inventoryError.notFound(input.id),
  NotReady: (input: { id: string }): InventoryError => inventoryError.notReady(input.id),
  Busy: (input: { id: string }): InventoryError => inventoryError.busy(input.id),
  Loaded: (input: { id: string }): InventoryError => inventoryError.loaded(input.id),
  DeletionUnsafe: (input: { message: string }): InventoryError =>
    inventoryError.deletionUnsafe(input.message),
  Unsupported: (input: { message: string }): InventoryError =>
    inventoryError.unsupported(input.message),
  Io: (input: { message: string }): InventoryError => inventoryError.io(input.message),
  Upstream: (input: { message: string }): InventoryError => inventoryError.upstream(input.message),
  Integrity: (input: { message: string }): InventoryError => inventoryError.integrity(input.message),
  ConcurrentMutation: (input: { message: string }): InventoryError =>
    inventoryError.concurrentMutation(input.message),
  ModelOperation: (input: { code: string; message: string; retryable: boolean }): InventoryError =>
    inventoryError.modelOperation(input.code, input.message, input.retryable),
  Internal: (input: { message: string }): InventoryError => inventoryError.internal(input.message),
}

export const inventoryErrorMessage = (error: InventoryError): string => {
  switch (error._tag) {
    case "InvalidId":
      return `invalid model id: ${error.value}`
    case "InvalidRequest":
      return `invalid model request: ${error.message}`
    case "NotFound":
      return `model not found: ${error.id}`
    case "NotReady":
      return `model is not ready: ${error.id}`
    case "Busy":
      return `model is busy: ${error.id}`
    case "Loaded":
      return `model is loaded: ${error.id}`
    case "DeletionUnsafe":
      return `deletion is unsafe: ${error.message}`
    case "Unsupported":
      return `model source does not support this operation: ${error.message}`
    case "Io":
      return `inventory I/O failed: ${error.message}`
    case "Upstream":
      return `upstream model service failed: ${error.message}`
    case "Integrity":
      return `model integrity check failed: ${error.message}`
    case "ConcurrentMutation":
      return `model artifacts changed during inspection: ${error.message}`
    case "ModelOperation":
      return error.message
    case "Internal":
      return `internal inventory failure: ${error.message}`
  }
}

// --- Content identity ---

export type ContentIdentity =
  | { readonly _tag: "Sha256"; value: string }
  | { readonly _tag: "GitOid"; value: string }
  | { readonly _tag: "Xet"; value: string }
  | { readonly _tag: "FileIdentity"; value: string }
  | { readonly _tag: "Unknown" }

export const ContentIdentity = {
  Sha256: (value: string): ContentIdentity => ({ _tag: "Sha256", value }),
  GitOid: (value: string): ContentIdentity => ({ _tag: "GitOid", value }),
  Xet: (value: string): ContentIdentity => ({ _tag: "Xet", value }),
  FileIdentity: (value: string): ContentIdentity => ({ _tag: "FileIdentity", value }),
  Unknown: (): ContentIdentity => ({ _tag: "Unknown" }),
  equals(a: ContentIdentity, b: ContentIdentity): boolean {
    if (a._tag !== b._tag) return false
    if (a._tag === "Unknown") return true
    return a.value === (b as { value: string }).value
  },
}

// --- Component roles ---

export type ComponentRole =
  | "Weights"
  | "Shard"
  | "Projector"
  | "Draft"
  | "Mtp"
  | "Auxiliary"

export type ComponentRelationship =
  | { readonly _tag: "ProjectorFor"; projector: string; model: string }
  | { readonly _tag: "MtpFor"; mtp: string; model: string }
  | { readonly _tag: "DraftFor"; draft: string; model: string; method: SpeculativeMethod }

export type SpeculativeMethod = "mtp" | "dflash" | "dspark"

export interface ModelComponent {
  path: string
  role: ComponentRole
  size_bytes: number
  content: ContentIdentity
  shard_index?: number
  relationship?: ComponentRelationship
}

// --- Integrity ---

export type Integrity =
  | { readonly _tag: "Verified"; method: string }
  | { readonly _tag: "Unverified"; reason: string }

// --- Model source / location ---

export type LocalDeclaration = "discovery" | "active_process"

export type ModelSource =
  | {
      readonly _tag: "HuggingFace"
      repository: string
      requested_revision: string
      commit: string
      metadata: unknown | null
    }
  | { readonly _tag: "Local"; declared_by: LocalDeclaration }

export type ModelLocation =
  | {
      readonly _tag: "MagnitudeCache"
      components: readonly ModelComponent[]
      total_bytes: number
      integrity: Integrity
    }
  | {
      readonly _tag: "HuggingFaceCache"
      cache_root: string
      repository: string
      commit: string
      total_bytes: number
      components: readonly ModelComponent[]
      integrity: Integrity
    }
  | {
      readonly _tag: "Directory"
      source_id: string
      root: string
      components: readonly ModelComponent[]
      total_bytes: number
      integrity: Integrity
    }
  | {
      readonly _tag: "File"
      path: string
      component: ModelComponent
      integrity: Integrity
    }

export const modelLocationComponents = (location: ModelLocation): readonly ModelComponent[] => {
  switch (location._tag) {
    case "MagnitudeCache":
    case "HuggingFaceCache":
    case "Directory":
      return location.components
    case "File":
      return [location.component]
  }
}

// --- Availability / properties ---

export type DownloadStage =
  | "queued"
  | "checking_space"
  | "resolving"
  | "downloading"
  | "verifying"

export type DownloadFailure =
  | { readonly _tag: "InsufficientDiskSpace"; required_bytes: number; available_bytes: number }
  | { readonly _tag: "SourceUnavailable" }
  | { readonly _tag: "NetworkUnavailable" }
  | { readonly _tag: "CorruptDownload" }
  | { readonly _tag: "LocalStorageFailure" }
  | { readonly _tag: "Internal"; message: string }
  | { readonly _tag: "Interrupted" }

export type ModelAvailability =
  | { readonly _tag: "Available"; ready_at: number }
  | {
      readonly _tag: "Downloading"
      operation_id: string
      stage: DownloadStage
      completed_bytes: number
      total_bytes: number
      current_component: string | null
      started_at: number
      updated_at: number
    }
  | {
      readonly _tag: "Interrupted"
      completed_bytes: number
      total_bytes: number
      resumable: boolean
      failure: DownloadFailure
      updated_at: number
    }
  | { readonly _tag: "InvalidArtifact"; detected_at: number; code: string; message: string }
  | { readonly _tag: "IncompatibleArtifact"; detected_at: number; code: string; message: string }

export type InventoryProperties =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Unavailable"; reason: string }
  | {
      readonly _tag: "Inspected"
      architecture: string | null
      quantization: string | null
      quantization_name: string | null
      parameter_count: number | null
      active_parameter_count: number | null
      training_context_length: number | null
      nextn_predict_layers: number | null
      tokenizer: string | null
      modalities: readonly string[]
      base_models: readonly string[]
      evidence_fingerprint: string
    }

export type ModelOperation = "load" | "unload" | "delete"

export interface InventoryModel {
  id: InventoryEntryId
  content_id: ContentId
  created: number
  name: string
  supported_parameters: readonly string[]
  availability: ModelAvailability
  source: ModelSource
  location: ModelLocation
  properties: InventoryProperties
  operations: readonly ModelOperation[]
  updated_at: number
}

export interface ResolvedComponent {
  path: string
  role: ComponentRole
  shard_index?: number
  relationship?: ComponentRelationship
}

export interface ResolvedModel {
  model: InventoryModel
  components: readonly ResolvedComponent[]
}

// --- Package wire types ---

export type ModelFileRole = "weights" | "projector" | "draft" | "mtp" | "auxiliary"

export interface ModelFile {
  id: ModelFileId
  path: string
  role: ModelFileRole
  size_bytes: number
  tensor_storage_bytes: number | null
  sha256: string
}

export type ModelPackageSource =
  | { readonly _tag: "HuggingFace"; repository: string; revision: string }
  | { readonly _tag: "Local"; path: string }

export type ModelFileRelationship =
  | { readonly _tag: "Shard"; file_id: ModelFileId; index: number; count: number }
  | { readonly _tag: "ProjectorFor"; projector_file_id: ModelFileId; weights_file_id: ModelFileId }
  | { readonly _tag: "MtpFor"; mtp_file_id: ModelFileId; weights_file_id: ModelFileId }
  | {
      readonly _tag: "DraftFor"
      draft_file_id: ModelFileId
      weights_file_id: ModelFileId
      method: SpeculativeMethod
    }

export interface ModelPackageProperties {
  format: string
  quantization: string
  quantization_name: string
  architecture: string
  maximum_context_length: number | null
  intrinsic_model_id: string | null
  intrinsic_quality_id: string | null
}

export interface ModelPackage {
  id: ModelPackageId
  source: ModelPackageSource
  files: readonly ModelFile[]
  relationships: readonly ModelFileRelationship[]
  properties: ModelPackageProperties
}

export type PackageValidation =
  | { readonly _tag: "Valid" }
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Unsupported"; failure: ModelFailure }
  | { readonly _tag: "Invalid"; failure: ModelFailure }

export interface ModelFailure {
  code: string
  message: string
  retryable: boolean
}

export type ModelPackageInstallationOrigin = "magnitude" | "hugging_face_cache"

export type InstalledCatalogAttribution =
  | { readonly _tag: "NotCatalogTarget" }
  | { readonly _tag: "Attributed"; model_id: string; variant_id: string }
  | { readonly _tag: "Failed"; failure: ModelFailure }

export interface InstalledModelPackage {
  path: string
  origin: ModelPackageInstallationOrigin
  validation: PackageValidation
  catalog_attribution: InstalledCatalogAttribution
  package: ModelPackage
}

export interface InstalledModelPackagesResponse {
  revision: number
  reconciliation_complete: boolean
  packages: readonly InstalledModelPackage[]
}

// --- Download events ---

export type ModelDownloadEvent =
  | { readonly _tag: "Resolving"; operation_id: string; repository: string; revision: string }
  | {
      readonly _tag: "CheckingSpace"
      operation_id: string
      model_id: InventoryEntryId
      required_bytes: number
      available_bytes: number
      completed_bytes: number
      total_bytes: number
    }
  | {
      readonly _tag: "Progress"
      operation_id: string
      model_id: InventoryEntryId
      stage: DownloadStage
      completed_bytes: number
      total_bytes: number
      file: { path: string; completed_bytes: number; total_bytes: number }
      bytes_per_second: number | null
      resumed_from_bytes: number
    }
  | { readonly _tag: "Ready"; operation_id: string; model: InventoryModel }
  | {
      readonly _tag: "Cancelled"
      operation_id: string
      model_id: InventoryEntryId | null
      completed_bytes: number
      total_bytes: number
    }
  | {
      readonly _tag: "Failed"
      operation_id: string
      model_id: InventoryEntryId | null
      error: DownloadFailure
      completed_bytes: number
      total_bytes: number
      resumable: boolean
    }

export type DownloadEventStream = AsyncIterable<ModelDownloadEvent>

// --- Assessment cache ---

export interface ServingProfile {
  context_length: number
}

export interface TemplateCapabilities {
  string_content: boolean
  typed_content: boolean
  tools: boolean
  tool_calls: boolean
  parallel_tool_calls: boolean
  system_role: boolean
  preserve_reasoning: boolean
  object_arguments: boolean
  enable_thinking: boolean
}

export interface ModelReasoningCapabilities {
  supported: boolean
  efforts: readonly string[]
  default_effort: string | null
}

export interface ModelCapabilities {
  vision: boolean
  tools: boolean
  structured_output: boolean
  reasoning: ModelReasoningCapabilities
}

export interface ReasoningProfile {
  default_effort: string | null
  mappings: readonly unknown[]
  template_fingerprint: string
}

export type SpeculativeDecodingSelection =
  | { readonly _tag: "Disabled"; reason: string }
  | { readonly _tag: "Enabled"; method: SpeculativeMethod }

export interface MemoryAssessment {
  memory_domain_id: MemoryDomainId
  capacity_bytes: number
  required_bytes: number
  compatibility_reserve_bytes: number
  remaining_bytes: number
}

export interface PerformanceEvidence {
  context_tokens: number
  lower_tokens_per_second: number
  estimated_tokens_per_second: number
  upper_tokens_per_second: number
  confidence: "low" | "medium" | "high"
}

export interface CachedModelAssessment {
  capabilities: ModelCapabilities
  template_capabilities: TemplateCapabilities
  reasoning: ReasoningProfile
  template_fingerprint: string
  speculative: SpeculativeDecodingSelection
  profile: ModelAssessment
}

export type ModelAssessment =
  | {
      readonly _tag: "Fits"
      profile: ServingProfile
      assessment_id: ModelAssessmentId
      memory: readonly MemoryAssessment[]
      performance: readonly PerformanceEvidence[]
    }
  | {
      readonly _tag: "DoesNotFit"
      profile: ServingProfile
      assessment_id: ModelAssessmentId
      memory: readonly MemoryAssessment[]
      limiting_resource: string
      deficit_bytes: number
    }

export interface HardwareMemoryDomain {
  id: MemoryDomainId
  kind: "system" | "unified_memory"
  total_capacity_bytes: number
  stable_capacity_bytes: number
  current_free_bytes: number | null
  shares_system_memory: boolean
  devices: readonly unknown[]
}

export interface HardwareSystemMemory {
  physical_capacity_bytes: number
  physical_available_bytes: number
  allocation_capacity_bytes: number
  allocation_headroom_bytes: number
  assess_reserve_bytes: number
  abort_reserve_bytes: number
}

export interface HardwareSnapshot {
  captured_at: number
  platform: string
  architecture: string
  system_product_name: string | null
  cpu_model: string | null
  logical_cores: number
  system_memory: HardwareSystemMemory
  native_build: string
  enabled_backends: readonly string[]
  topology_fingerprint: string
  memory_domains: readonly HardwareMemoryDomain[]
}

export class MemoryTopology {
  readonly capacityBytes: number

  private constructor(capacityBytes: number) {
    this.capacityBytes = capacityBytes
  }

  static fromSnapshot(snapshot: HardwareSnapshot): MemoryTopology {
    return new MemoryTopology(snapshot.system_memory.physical_capacity_bytes)
  }

  isValidFor(_profile: ModelAssessment): boolean {
    return true
  }

  validatesHardwareAssessment(_assessment: HardwareAssessment): boolean {
    return true
  }
}

export type HardwareAssessment =
  | { readonly _tag: "Fits" }
  | { readonly _tag: "DoesNotFit" }
  | { readonly _tag: "InvalidArtifact" }
  | { readonly _tag: "IncompatibleArtifact" }

export interface ModelExecutionAssessment {
  hardware: () => HardwareAssessment
}

// --- Bundle types (package identity) ---

export type ServableModelBundle =
  | { readonly _tag: "Standalone"; package: ModelPackage }
  | {
      readonly _tag: "SpeculativeDecoding"
      target: ModelPackage
      draft_source: SpeculativeDraftSource
      method: SpeculativeMethod
    }

export type SpeculativeDraftSource =
  | { readonly _tag: "Embedded" }
  | { readonly _tag: "Separate"; draft: ModelPackage }

export type SpeculativeDraftSourceInput =
  | { readonly _tag: "Embedded" }
  | { readonly _tag: "Separate"; draft: ModelPackageOperand }

export type ModelPackageOperand =
  | { readonly _tag: "Installed"; package_id: ModelPackageId }
  | { readonly _tag: "SourceBacked"; package: ModelPackage }

export type ModelBundleInput =
  | { readonly _tag: "Standalone"; package: ModelPackageOperand }
  | {
      readonly _tag: "SpeculativeDecoding"
      target: ModelPackageOperand
      draft_source: SpeculativeDraftSourceInput
      method: SpeculativeMethod
    }

export interface ResolvedServableModelBundle {
  bundle: ServableModelBundle
  target: ResolvedModel
  draft: ResolvedModel | null
}

// --- Download service API ---

export type ModelDownloadState =
  | { readonly _tag: "Pending"; completed_bytes: number; total_bytes: number }
  | {
      readonly _tag: "Downloading"
      stage: DownloadStage
      completed_bytes: number
      total_bytes: number
      bytes_per_second: number | null
    }
  | { readonly _tag: "Completed" }
  | {
      readonly _tag: "Failed"
      completed_bytes: number
      total_bytes: number
      failure: DownloadFailure
      acknowledged: boolean
    }
  | { readonly _tag: "Cancelled"; completed_bytes: number; total_bytes: number }

export interface ModelDownload {
  id: ModelDownloadId
  bundle: ServableModelBundle
  state: ModelDownloadState
}

export interface ModelDownloadsResponse {
  downloads: readonly ModelDownload[]
}

export interface ModelDownloadsInvalidation {
  revision: number
}

export interface StartModelDownloadRequest {
  bundle: ServableModelBundle
}

export interface StartModelDownloadResponse {
  download: ModelDownload | null
}

export interface RemoveInstalledModelPackageResponse {
  package_id: ModelPackageId
  removed: boolean
  freed_bytes: number
}

export type CatalogPackageRole = "Target" | "Dependency"

export type CatalogInstallationOperationId = string & {
  readonly _tag: "CatalogInstallationOperationId"
}

export type ModelId = string & { readonly _tag: "ModelId" }

export type CatalogBaseId = string & { readonly _tag: "CatalogBaseId" }

export type CatalogVariantId = string & { readonly _tag: "CatalogVariantId" }

export type HuggingFaceRepositoryId = string & { readonly _tag: "HuggingFaceRepositoryId" }

export type HuggingFaceArtifactSelector = string & { readonly _tag: "HuggingFaceArtifactSelector" }

export type ParsedModelId =
  | { readonly _tag: "Catalog"; base_id: CatalogBaseId; variant_id: CatalogVariantId }
  | {
      readonly _tag: "HuggingFace"
      repository_id: HuggingFaceRepositoryId
      artifact_selector: HuggingFaceArtifactSelector
    }

export class ModelIdError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ModelIdError"
  }
}

const validateNormalizedComponent = (value: string, label: string): void => {
  if (value.length === 0) {
    throw new ModelIdError(`${label} must not be empty`)
  }
  if (value === "." || value === "..") {
    throw new ModelIdError(`${label} must not be a traversal component`)
  }
  if (value.includes("\\")) {
    throw new ModelIdError(`${label} must not contain a backslash`)
  }
  for (const char of value) {
    const code = char.codePointAt(0)!
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      throw new ModelIdError(`${label} must not contain control characters`)
    }
  }
}

export const CatalogBaseId = {
  new(value: string): CatalogBaseId {
    validateNormalizedComponent(value, "catalog base")
    if (value === "hf" || value.includes(":") || value.includes("/")) {
      throw new ModelIdError("catalog base must be one non-hf identity component")
    }
    return value as CatalogBaseId
  },
  asStr(value: CatalogBaseId): string {
    return value
  },
}

export const CatalogVariantId = {
  new(value: string): CatalogVariantId {
    const components = value.split(":")
    const format = components[0] ?? ""
    const quality = components[1] ?? ""
    if (components.length !== 2) {
      throw new ModelIdError("catalog variant must have format and quality components")
    }
    validateNormalizedComponent(format, "catalog variant format")
    validateNormalizedComponent(quality, "catalog variant quality")
    if (format.includes("/") || quality.includes("/")) {
      throw new ModelIdError("catalog variant components must not contain slashes")
    }
    return value as CatalogVariantId
  },
  asStr(value: CatalogVariantId): string {
    return value
  },
}

export const HuggingFaceRepositoryId = {
  new(value: string): HuggingFaceRepositoryId {
    const components = value.split("/")
    const owner = components[0] ?? ""
    const repository = components[1] ?? ""
    if (components.length !== 2) {
      throw new ModelIdError("repository must have exactly owner and repository components")
    }
    validateNormalizedComponent(owner, "owner")
    validateNormalizedComponent(repository, "repository")
    return value as HuggingFaceRepositoryId
  },
  asStr(value: HuggingFaceRepositoryId): string {
    return value
  },
}

export const HuggingFaceArtifactSelector = {
  new(value: string): HuggingFaceArtifactSelector {
    if (value.startsWith("/")) {
      throw new ModelIdError("artifact selector must be repository-relative")
    }
    if (value.includes("\\")) {
      throw new ModelIdError("artifact selector must not contain a backslash")
    }
    if (!value.toLowerCase().endsWith(".gguf")) {
      throw new ModelIdError("artifact selector must identify a GGUF file")
    }
    if (value.split("/").some((component) => component.length === 0)) {
      throw new ModelIdError("artifact selector must not contain empty components")
    }
    for (const component of value.split("/")) {
      validateNormalizedComponent(component, "artifact selector component")
    }
    return value as HuggingFaceArtifactSelector
  },
  asStr(value: HuggingFaceArtifactSelector): string {
    return value
  },
}

const parseModelId = (value: string): ParsedModelId => {
  if (value.startsWith("hf:")) {
    const remainder = value.slice("hf:".length)
    const slashIndex = remainder.indexOf("/")
    const secondSlash = remainder.indexOf("/", slashIndex + 1)
    if (slashIndex === -1 || secondSlash === -1) {
      throw new ModelIdError("invalid model ID")
    }
    const owner = remainder.slice(0, slashIndex)
    const repoEnd = remainder.indexOf("/", slashIndex + 1)
    const repository = remainder.slice(slashIndex + 1, repoEnd)
    const selector = remainder.slice(repoEnd + 1)
    return {
      _tag: "HuggingFace",
      repository_id: HuggingFaceRepositoryId.new(`${owner}/${repository}`),
      artifact_selector: HuggingFaceArtifactSelector.new(selector),
    }
  }
  const colonIndex = value.indexOf(":")
  if (colonIndex === -1) {
    throw new ModelIdError("invalid model ID")
  }
  return {
    _tag: "Catalog",
    base_id: CatalogBaseId.new(value.slice(0, colonIndex)),
    variant_id: CatalogVariantId.new(value.slice(colonIndex + 1)),
  }
}

export const ModelId = {
  catalog(baseId: CatalogBaseId, variantId: CatalogVariantId): ModelId {
    return `${baseId}:${variantId}` as ModelId
  },
  huggingFace(
    repositoryId: HuggingFaceRepositoryId,
    artifactSelector: HuggingFaceArtifactSelector,
  ): ModelId {
    return `hf:${repositoryId}/${artifactSelector}` as ModelId
  },
  parse(value: string): ModelId {
    parseModelId(value)
    return value as ModelId
  },
  parsed(value: ModelId): ParsedModelId {
    return parseModelId(value)
  },
  asStr(value: ModelId): string {
    return value
  },
}

export class ModelReleaseDate {
  readonly value: string

  private constructor(value: string) {
    this.value = value
  }

  static new(value: string): ModelReleaseDate {
    if (!ModelReleaseDate.isValidIsoDate(value)) {
      throw new Error(`invalid model release date ${JSON.stringify(value)}; expected YYYY-MM-DD`)
    }
    return new ModelReleaseDate(value)
  }

  asStr(): string {
    return this.value
  }

  private static isValidIsoDate(value: string): boolean {
    if (value.length !== 10 || value[4] !== "-" || value[7] !== "-") {
      return false
    }
    for (let index = 0; index < value.length; index += 1) {
      if (index === 4 || index === 7) continue
      if (value[index]! < "0" || value[index]! > "9") return false
    }
    const year = Number(value.slice(0, 4))
    const month = Number(value.slice(5, 7))
    const day = Number(value.slice(8, 10))
    if (year === 0) return false
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const daysInMonth =
      month === 1 || month === 3 || month === 5 || month === 7 || month === 8 || month === 10 || month === 12
        ? 31
        : month === 4 || month === 6 || month === 9 || month === 11
          ? 30
          : month === 2
            ? leapYear
              ? 29
              : 28
            : 0
    return day > 0 && day <= daysInMonth
  }
}

export type ModelParameterization =
  | { readonly architecture: "dense"; totalParameters: number }
  | {
      readonly architecture: "mixtureOfExperts"
      totalParameters: number
      activeParameters: number
    }

export type IntelligenceEstimateConfidence = "high" | "moderate" | "low"

export type IntelligenceTarget = "artificialAnalysisIntelligenceIndex"

export type IntelligenceProvenance =
  | {
      readonly kind: "artificialAnalysisIntelligenceIndex"
      methodologyVersion: string
      asOfDate: string
      url: string
    }
  | {
      readonly kind: "estimate"
      target: IntelligenceTarget
      methodologyVersion: string
      asOfDate: string
      confidence: IntelligenceEstimateConfidence
      methodology: string
      evidenceUrls: readonly string[]
    }

export interface CatalogIntelligence {
  score: number
  provenance: IntelligenceProvenance
}

export interface ModelServingConfiguration {
  bundle: ServableModelBundle
  profile: ServingProfile
}

export interface ModelMetadata {
  format: string
  architecture: string
  quantization: string
  quantization_name: string
  storage_bytes: number
  maximum_context_length?: number
}

export interface ReadyModel {
  metadata: ModelMetadata
  profile: ServingProfile
  speculative_method?: SpeculativeMethod
}

export type EffectiveModel =
  | { readonly _tag: "Ready"; model: ReadyModel }
  | { readonly _tag: "Unavailable"; failure: ModelFailure }

export type ModelInstallationOwnership = "Magnitude" | "ExternalHuggingFace" | "Mixed"

export type ModelInstallation =
  | {
      readonly _tag: "Resolved"
      installed_bytes: number
      primary_path: string
      ownership: ModelInstallationOwnership
    }
  | {
      readonly _tag: "Unresolved"
      installed_bytes: number
      ownership: ModelInstallationOwnership
    }

export type ResolvedModelInstallation =
  | {
      readonly _tag: "Resolved"
      installed_bytes: number
      primary_path: string
      ownership: ModelInstallationOwnership
    }

export interface RecommendableModel {
  model_id: CatalogBaseId
  variant_id: CatalogVariantId
  configuration: ModelServingConfiguration
  display_name: string
  variant_label: string
  description: string
  release_date: ModelReleaseDate
  license: string
  parameterization: ModelParameterization
  intelligence: CatalogIntelligence
  fidelity_rank: number
  quantization_aware: boolean
}

export interface CatalogDiagnostic {
  model_id: CatalogBaseId
  variant_id: CatalogVariantId
  failure: ModelFailure
}

export interface RecommendableModelCatalog {
  models: readonly RecommendableModel[]
  diagnostics: readonly CatalogDiagnostic[]
}

export type CatalogModelUpdate =
  | { readonly _tag: "Current" }
  | { readonly _tag: "Available"; required_download_bytes: number }

export type CatalogModelState =
  | { readonly _tag: "NotInstalled" }
  | {
      readonly _tag: "Installed"
      effective: EffectiveModel
      installation: ModelInstallation
      update_state: CatalogModelUpdate
    }

export interface CatalogModel {
  id: ModelId
  desired: ReadyModel
  display_name: string
  variant_label: string
  description: string
  release_date: ModelReleaseDate
  license: string
  source_urls: readonly string[]
  parameterization: ModelParameterization
  intelligence: CatalogIntelligence
  fidelity_rank: number
  quantization_aware: boolean
  local_state: CatalogModelState
}

export interface CatalogModelsResponse {
  revision: number
  reconciliation_complete: boolean
  models: readonly CatalogModel[]
}

export interface CatalogPackageAffiliation {
  model_id: CatalogBaseId
  variant_id: CatalogVariantId
  package_id: ModelPackageId
  repository: string
  role: CatalogPackageRole
}

export type DiscoveredModelCatalogAttribution =
  | { readonly _tag: "NotInCatalog" }
  | { readonly _tag: "Failed"; failure: ModelFailure }

export type DiscoveredModelState =
  | {
      readonly _tag: "Ready"
      installation: ResolvedModelInstallation
      model: ReadyModel
      catalog_attribution: DiscoveredModelCatalogAttribution
    }
  | {
      readonly _tag: "Unavailable"
      installation: ResolvedModelInstallation
      failure: ModelFailure
    }

export interface DiscoveredModel {
  id: ModelId
  state: DiscoveredModelState
}

export interface DiscoveredModelsResponse {
  revision: number
  reconciliation_complete: boolean
  models: readonly DiscoveredModel[]
}

export type CatalogInstallationAdmission =
  | { readonly _tag: "Current" }
  | { readonly _tag: "Admitted"; operation_id: CatalogInstallationOperationId }

export interface CatalogInstallationProgress {
  stage: DownloadStage
  completed_bytes: number
  total_bytes: number
  bytes_per_second?: number
}

export type CatalogInstallationOperationState =
  | { readonly _tag: "Pending"; progress: CatalogInstallationProgress }
  | { readonly _tag: "Running"; progress: CatalogInstallationProgress }
  | { readonly _tag: "Completed" }
  | {
      readonly _tag: "Failed"
      progress: CatalogInstallationProgress
      failure: DownloadFailure
      acknowledged: boolean
    }
  | { readonly _tag: "Cancelled"; progress: CatalogInstallationProgress }

export interface CatalogInstallationOperation {
  operation_id: CatalogInstallationOperationId
  model_id: ModelId
  state: CatalogInstallationOperationState
}

export interface CatalogInstallationsResponse {
  operations: readonly CatalogInstallationOperation[]
}

export type CatalogInstallationRetentionReason = "SharedMaterial" | "ExternalOwnership"

export type CatalogInstallationRemoval =
  | { readonly _tag: "Removed"; reclaimed_bytes: number }
  | { readonly _tag: "Retained"; reason: CatalogInstallationRetentionReason }

export type CatalogModelSelection = "Desired" | "Effective"

export type ModelAssessmentSubject =
  | { readonly _tag: "Catalog"; model_id: ModelId; selection: CatalogModelSelection }
  | { readonly _tag: "Discovery"; model_id: ModelId }

export interface ModelDomainInvalidation {
  revision: number
}

export interface HuggingFaceRepositoryRequest {
  repository: string
  revision: string
}

export interface HuggingFaceRepositoryFile {
  path: string
  size_bytes: number
  content: ContentIdentity
}

export interface HuggingFaceRepositorySnapshot {
  repository: string
  commit: string
  last_modified: string | null
  downloads: number | null
  likes: number | null
  gated: boolean
  private: boolean
  license: string | null
  license_url: string | null
  base_models: readonly string[]
  tags: readonly string[]
  gguf_files: readonly HuggingFaceRepositoryFile[]
}

export interface HuggingFaceModelSearchResult {
  repository: string
  commit: string
  last_modified: string | null
  downloads: number | null
  likes: number | null
  gated: boolean
  private: boolean
  tags: readonly string[]
}

export interface HuggingFaceModelSearchResults {
  models: readonly HuggingFaceModelSearchResult[]
}

export interface HuggingFaceModelSearchRequest {
  query: string
  limit: number
}

export type ModelPreviewComponentRole = "Weights" | "Projector" | "Draft" | "Mtp" | "Auxiliary"

export interface ModelPreviewComponentSource {
  path: string
  role: ModelPreviewComponentRole
}

export interface ModelPreviewSource {
  repository: string
  revision: string
  primary_gguf: string
  additional_components: readonly ModelPreviewComponentSource[]
}

export interface ModelPreviewProfile {
  id: string
  context_length: number
  parallel_sequences: number
  performance_context_tokens: readonly number[]
}

export interface ModelPreviewRequest {
  source: ModelPreviewSource
  profiles: readonly ModelPreviewProfile[]
}

export interface ModelPreviewAssessment {
  profile_id: string
  artifact_fingerprint: string
  hardware_topology: string
  execution: CachedModelAssessment
}

export interface ModelPreview {
  repository: string
  commit: string
  components: readonly ModelComponent[]
  properties: InventoryProperties
  assessments: readonly ModelPreviewAssessment[]
}

export interface CatalogPackageRemover {
  removeCatalogPackages(packageIds: readonly ModelPackageId[]): Promise<number>
}

// Re-export Schema helper type for optional fields in future contract schemas.
export { Schema }
