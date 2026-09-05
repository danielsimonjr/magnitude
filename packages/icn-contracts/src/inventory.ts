import { Option, Schema } from "effect"
import { optional, Path, PositiveInt, U32, JsonValue } from "./schema/common.js"
import { SpeculativeMethod } from "./models/speculative.js"

export const MemoryDomainId = Schema.String.pipe(Schema.brand("MemoryDomainId"))
export type MemoryDomainId = typeof MemoryDomainId.Type

export const memoryDomainId = (value: string): MemoryDomainId => value as MemoryDomainId
export const systemMemoryDomainId = (): MemoryDomainId => memoryDomainId("system")

export const memoryDomainIdAsStr = (id: MemoryDomainId): string => id
export const memoryDomainIdIsSystem = (id: MemoryDomainId): boolean => id === "system"

export const HardwareDeviceId = Schema.String.pipe(Schema.brand("HardwareDeviceId"))
export type HardwareDeviceId = typeof HardwareDeviceId.Type
export const hardwareDeviceId = (value: string): HardwareDeviceId => value as HardwareDeviceId

export const InventoryEntryId = Schema.String.pipe(Schema.brand("InventoryEntryId"))
export type InventoryEntryId = typeof InventoryEntryId.Type

export const ContentId = Schema.String.pipe(Schema.brand("ContentId"))
export type ContentId = typeof ContentId.Type

const DIGEST_LENGTH = 64
const HEX = /^[0-9a-f]+$/

export type InventoryError =
  | { readonly _tag: "InvalidId"; readonly value: string }
  | { readonly _tag: "InvalidRequest"; readonly message: string }
  | { readonly _tag: "NotFound"; readonly message: string }
  | { readonly _tag: "NotReady"; readonly message: string }
  | { readonly _tag: "Busy"; readonly message: string }
  | { readonly _tag: "Loaded"; readonly message: string }
  | { readonly _tag: "DeletionUnsafe"; readonly message: string }
  | { readonly _tag: "Unsupported"; readonly message: string }
  | { readonly _tag: "Io"; readonly message: string }
  | { readonly _tag: "Upstream"; readonly message: string }
  | { readonly _tag: "Integrity"; readonly message: string }
  | { readonly _tag: "ConcurrentMutation"; readonly message: string }
  | { readonly _tag: "ModelOperation"; readonly code: string; readonly message: string; readonly retryable: boolean }
  | { readonly _tag: "Internal"; readonly message: string }

const validatePrefixedDigest = (value: string, prefix: string): InventoryError | null => {
  if (!value.startsWith(prefix)) {
    return { _tag: "InvalidId", value }
  }
  const digest = value.slice(prefix.length)
  if (digest.length !== DIGEST_LENGTH || !HEX.test(digest)) {
    return { _tag: "InvalidId", value }
  }
  return null
}

export const parseInventoryEntryId = (value: string): InventoryEntryId | InventoryError => {
  const error = validatePrefixedDigest(value, "mdl_")
  return error ?? (value as InventoryEntryId)
}

export const parseContentId = (value: string): ContentId | InventoryError => {
  const error = validatePrefixedDigest(value, "content_")
  return error ?? (value as ContentId)
}

export const ComponentRole = Schema.Literal(
  "weights",
  "shard",
  "projector",
  "auxiliary",
  "draft",
  "mtp"
)
export type ComponentRole = typeof ComponentRole.Type

export const ContentIdentitySha256 = Schema.Struct({
  type: Schema.Literal("sha256"),
  value: Schema.String,
})
export const ContentIdentityGitOid = Schema.Struct({
  type: Schema.Literal("git_oid"),
  value: Schema.String,
})
export const ContentIdentityXet = Schema.Struct({
  type: Schema.Literal("xet"),
  value: Schema.String,
})
export const ContentIdentityFileIdentity = Schema.Struct({
  type: Schema.Literal("file_identity"),
  value: Schema.String,
})
export const ContentIdentityUnknown = Schema.Struct({ type: Schema.Literal("unknown") })

export const ContentIdentity = Schema.Union(
  ContentIdentitySha256,
  ContentIdentityGitOid,
  ContentIdentityXet,
  ContentIdentityFileIdentity,
  ContentIdentityUnknown
)
export type ContentIdentity = typeof ContentIdentity.Type

export const ComponentRelationshipProjectorFor = Schema.Struct({
  type: Schema.Literal("projector_for"),
  projector: Path,
  model: Path,
})

export const ComponentRelationshipDraftFor = Schema.Struct({
  type: Schema.Literal("draft_for"),
  draft: Path,
  model: Path,
  method: SpeculativeMethod,
})

export const ComponentRelationshipMtpFor = Schema.Struct({
  type: Schema.Literal("mtp_for"),
  mtp: Path,
  model: Path,
})

export const ComponentRelationship = Schema.Union(
  ComponentRelationshipProjectorFor,
  ComponentRelationshipDraftFor,
  ComponentRelationshipMtpFor
)
export type ComponentRelationship = typeof ComponentRelationship.Type

export const ModelComponent = Schema.Struct({
  path: Path,
  role: ComponentRole,
  size_bytes: Schema.BigIntFromSelf,
  content: ContentIdentity,
  shard_index: optional(U32),
  relationship: optional(ComponentRelationship),
})
export type ModelComponent = typeof ModelComponent.Type

export const IntegrityVerified = Schema.Struct({
  type: Schema.Literal("verified"),
  method: Schema.String,
})

export const IntegrityUnverified = Schema.Struct({
  type: Schema.Literal("unverified"),
  reason: Schema.String,
})

export const Integrity = Schema.Union(IntegrityVerified, IntegrityUnverified)
export type Integrity = typeof Integrity.Type

export const LocalDeclaration = Schema.Literal("configuration", "discovery", "active_process")
export type LocalDeclaration = typeof LocalDeclaration.Type

export const HubMetadata = Schema.Struct({
  access: optional(Schema.String),
  author: optional(Schema.String),
  license: optional(Schema.String),
  pipeline_tag: optional(Schema.String),
  library_name: optional(Schema.String),
  tags: Schema.Array(Schema.String),
  downloads: optional(Schema.BigIntFromSelf),
  likes: optional(Schema.BigIntFromSelf),
  last_modified: optional(Schema.String),
})
export type HubMetadata = typeof HubMetadata.Type

export const defaultHubMetadata = (): HubMetadata => ({
  access: Option.none(),
  author: Option.none(),
  license: Option.none(),
  pipeline_tag: Option.none(),
  library_name: Option.none(),
  tags: [],
  downloads: Option.none(),
  likes: Option.none(),
  last_modified: Option.none(),
})

export const ModelSourceHuggingFace = Schema.Struct({
  type: Schema.Literal("hugging_face"),
  repository: Schema.String,
  requested_revision: Schema.String,
  commit: Schema.String,
  metadata: optional(HubMetadata),
})

export const ModelSourceLocal = Schema.Struct({
  type: Schema.Literal("local"),
  declared_by: LocalDeclaration,
})

export const ModelSource = Schema.Union(ModelSourceHuggingFace, ModelSourceLocal)
export type ModelSource = typeof ModelSource.Type

export const ModelLocationMagnitudeCache = Schema.Struct({
  type: Schema.Literal("magnitude_cache"),
  components: Schema.Array(ModelComponent),
  total_bytes: Schema.BigIntFromSelf,
  integrity: Integrity,
})

export const ModelLocationHuggingFaceCache = Schema.Struct({
  type: Schema.Literal("hugging_face_cache"),
  cache_root: Path,
  repository: Schema.String,
  commit: Schema.String,
  components: Schema.Array(ModelComponent),
  total_bytes: Schema.BigIntFromSelf,
  integrity: Integrity,
})

export const ModelLocationDirectory = Schema.Struct({
  type: Schema.Literal("directory"),
  source_id: Schema.String,
  root: Path,
  components: Schema.Array(ModelComponent),
  total_bytes: Schema.BigIntFromSelf,
  integrity: Integrity,
})

export const ModelLocationFile = Schema.Struct({
  type: Schema.Literal("file"),
  path: Path,
  component: ModelComponent,
  integrity: Integrity,
})

export const ModelLocation = Schema.Union(
  ModelLocationMagnitudeCache,
  ModelLocationHuggingFaceCache,
  ModelLocationDirectory,
  ModelLocationFile
)
export type ModelLocation = typeof ModelLocation.Type

export const modelLocationComponents = (location: ModelLocation): readonly ModelComponent[] => {
  switch (location.type) {
    case "magnitude_cache":
    case "hugging_face_cache":
    case "directory":
      return location.components
    case "file":
      return [location.component]
  }
}

export const DownloadStage = Schema.Literal(
  "queued",
  "resolving",
  "checking_space",
  "downloading",
  "verifying",
  "publishing"
)
export type DownloadStage = typeof DownloadStage.Type

export const DownloadFailureInterrupted = Schema.Struct({ _tag: Schema.Literal("Interrupted") })
export const DownloadFailureInsufficientDiskSpace = Schema.Struct({
  _tag: Schema.Literal("InsufficientDiskSpace"),
  requiredBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  availableBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
})
export const DownloadFailureSourceUnavailable = Schema.Struct({ _tag: Schema.Literal("SourceUnavailable") })
export const DownloadFailureNetworkUnavailable = Schema.Struct({ _tag: Schema.Literal("NetworkUnavailable") })
export const DownloadFailureLocalStorageFailure = Schema.Struct({ _tag: Schema.Literal("LocalStorageFailure") })
export const DownloadFailureCorruptDownload = Schema.Struct({ _tag: Schema.Literal("CorruptDownload") })
export const DownloadFailureInternal = Schema.Struct({
  _tag: Schema.Literal("Internal"),
  message: Schema.String,
})

export const DownloadFailure = Schema.Union(
  DownloadFailureInterrupted,
  DownloadFailureInsufficientDiskSpace,
  DownloadFailureSourceUnavailable,
  DownloadFailureNetworkUnavailable,
  DownloadFailureLocalStorageFailure,
  DownloadFailureCorruptDownload,
  DownloadFailureInternal
)
export type DownloadFailure = typeof DownloadFailure.Type

export const ModelAvailabilityDownloading = Schema.Struct({
  type: Schema.Literal("downloading"),
  operation_id: Schema.String,
  stage: DownloadStage,
  completed_bytes: Schema.BigIntFromSelf,
  total_bytes: Schema.BigIntFromSelf,
  current_component: optional(Path),
  started_at: Schema.BigIntFromSelf,
  updated_at: Schema.BigIntFromSelf,
})

export const ModelAvailabilityInterrupted = Schema.Struct({
  type: Schema.Literal("interrupted"),
  completed_bytes: Schema.BigIntFromSelf,
  total_bytes: Schema.BigIntFromSelf,
  resumable: Schema.Boolean,
  failure: DownloadFailure,
  updated_at: Schema.BigIntFromSelf,
})

export const ModelAvailabilityAvailable = Schema.Struct({
  type: Schema.Literal("available"),
  ready_at: Schema.BigIntFromSelf,
})

export const ModelAvailabilityInvalidArtifact = Schema.Struct({
  type: Schema.Literal("invalid_artifact"),
  detected_at: Schema.BigIntFromSelf,
  code: Schema.String,
  message: Schema.String,
})

export const ModelAvailabilityIncompatibleArtifact = Schema.Struct({
  type: Schema.Literal("incompatible_artifact"),
  detected_at: Schema.BigIntFromSelf,
  code: Schema.String,
  message: Schema.String,
})

export const ModelAvailability = Schema.Union(
  ModelAvailabilityDownloading,
  ModelAvailabilityInterrupted,
  ModelAvailabilityAvailable,
  ModelAvailabilityInvalidArtifact,
  ModelAvailabilityIncompatibleArtifact
)
export type ModelAvailability = typeof ModelAvailability.Type

export const CapabilitySupportSupported = Schema.Struct({
  type: Schema.Literal("supported"),
  parallel: optional(Schema.Boolean),
})

export const CapabilitySupportUnsupported = Schema.Struct({ type: Schema.Literal("unsupported") })

export const CapabilitySupport = Schema.Union(CapabilitySupportSupported, CapabilitySupportUnsupported)
export type CapabilitySupport = typeof CapabilitySupport.Type

export const CapabilityEvidenceNativeTemplate = Schema.Struct({
  type: Schema.Literal("native_template"),
  fingerprint: Schema.String,
})

export const CapabilityEvidenceBoundedTemplateProbe = Schema.Struct({
  type: Schema.Literal("bounded_template_probe"),
  fingerprint: Schema.String,
})

export const CapabilityEvidenceDeclaredMetadata = Schema.Struct({
  type: Schema.Literal("declared_metadata"),
  source: Schema.String,
})

export const CapabilityEvidence = Schema.Union(
  CapabilityEvidenceNativeTemplate,
  CapabilityEvidenceBoundedTemplateProbe,
  CapabilityEvidenceDeclaredMetadata
)
export type CapabilityEvidence = typeof CapabilityEvidence.Type

export const ReasoningVisibility = Schema.Literal("hidden", "preserved", "configurable")
export type ReasoningVisibility = typeof ReasoningVisibility.Type

export const ReasoningControlToggle = Schema.Struct({
  type: Schema.Literal("toggle"),
  default: Schema.Boolean,
})

export const ReasoningControlEffort = Schema.Struct({
  type: Schema.Literal("effort"),
  levels: Schema.Array(Schema.String),
  default: optional(Schema.String),
})

export const ReasoningControlBudget = Schema.Struct({
  type: Schema.Literal("budget"),
  min_tokens: U32,
  max_tokens: U32,
  default_tokens: U32,
})

export const ReasoningControlEffortAndBudget = Schema.Struct({
  type: Schema.Literal("effort_and_budget"),
  levels: Schema.Array(Schema.String),
  default_effort: optional(Schema.String),
  min_tokens: U32,
  max_tokens: U32,
})

export const ReasoningControlDomain = Schema.Union(
  ReasoningControlToggle,
  ReasoningControlEffort,
  ReasoningControlBudget,
  ReasoningControlEffortAndBudget
)
export type ReasoningControlDomain = typeof ReasoningControlDomain.Type

export const ReasoningCapabilityUnsupported = Schema.Struct({
  type: Schema.Literal("unsupported"),
  evidence: CapabilityEvidence,
})

export const ReasoningCapabilitySupported = Schema.Struct({
  type: Schema.Literal("supported"),
  control: ReasoningControlDomain,
  visibility: ReasoningVisibility,
  delimiters: Schema.Union(
    Schema.Struct({ type: Schema.Literal("unavailable") }),
    Schema.Struct({ type: Schema.Literal("known"), start: Schema.String, end: Schema.String })
  ),
  evidence: CapabilityEvidence,
})

export const ReasoningCapability = Schema.Union(ReasoningCapabilityUnsupported, ReasoningCapabilitySupported)
export type ReasoningCapability = typeof ReasoningCapability.Type

export const NormalizedReasoningEffort = Schema.String.pipe(Schema.brand("NormalizedReasoningEffort"))
export type NormalizedReasoningEffort = typeof NormalizedReasoningEffort.Type

export const parseNormalizedReasoningEffort = (value: string): NormalizedReasoningEffort | null => {
  const normalized = (() => {
    switch (value) {
      case "off":
      case "no_think":
      case "disabled":
        return "none"
      case "extra_high":
      case "extra-high":
      case "very_high":
        return "xhigh"
      case "none":
      case "minimal":
      case "low":
      case "medium":
      case "high":
      case "xhigh":
      case "max":
      case "adaptive":
        return value
      default:
        return null
    }
  })()
  return normalized === null ? null : (normalized as NormalizedReasoningEffort)
}

export const AutomaticReasoningBudgetDisabled = Schema.Struct({ type: Schema.Literal("disabled") })
export const AutomaticReasoningBudgetFixedTokens = Schema.Struct({
  type: Schema.Literal("fixed_tokens"),
  tokens: U32,
})
export const AutomaticReasoningBudget = Schema.Union(
  AutomaticReasoningBudgetDisabled,
  AutomaticReasoningBudgetFixedTokens
)
export type AutomaticReasoningBudget = typeof AutomaticReasoningBudget.Type

export const NativeReasoningControls = Schema.Struct({
  enable_thinking: optional(Schema.Boolean),
  template_args: Schema.Record({ key: Schema.String, value: JsonValue }),
})
export type NativeReasoningControls = typeof NativeReasoningControls.Type

export const ReasoningEffortMapping = Schema.Struct({
  effort: NormalizedReasoningEffort,
  controls: NativeReasoningControls,
  automatic_budget: AutomaticReasoningBudget,
})
export type ReasoningEffortMapping = typeof ReasoningEffortMapping.Type

export const ReasoningProfile = Schema.Struct({
  default_effort: optional(NormalizedReasoningEffort),
  mappings: Schema.Array(ReasoningEffortMapping),
  template_fingerprint: Schema.String,
})
export type ReasoningProfile = typeof ReasoningProfile.Type

export const reasoningProfileMapping = (
  profile: ReasoningProfile,
  effort: NormalizedReasoningEffort
): ReasoningEffortMapping | undefined =>
  profile.mappings.find((mapping) => mapping.effort === effort)

export const InventoryPropertiesPending = Schema.Struct({ type: Schema.Literal("pending") })
export const InventoryPropertiesUnavailable = Schema.Struct({
  type: Schema.Literal("unavailable"),
  reason: Schema.String,
})
export const InventoryPropertiesInspected = Schema.Struct({
  type: Schema.Literal("inspected"),
  architecture: optional(Schema.String),
  quantization: optional(Schema.String),
  quantization_name: optional(Schema.String),
  parameter_count: optional(Schema.BigIntFromSelf),
  active_parameter_count: optional(Schema.BigIntFromSelf),
  training_context_length: optional(U32),
  nextn_predict_layers: optional(U32),
  tokenizer: optional(Schema.String),
  modalities: Schema.Array(Schema.String),
  base_models: Schema.Array(Schema.String),
  evidence_fingerprint: Schema.String,
})

export const InventoryProperties = Schema.Union(
  InventoryPropertiesPending,
  InventoryPropertiesUnavailable,
  InventoryPropertiesInspected
)
export type InventoryProperties = typeof InventoryProperties.Type

export const GenerationPerformanceConfidence = Schema.Literal("high", "moderate", "low")
export type GenerationPerformanceConfidence = typeof GenerationPerformanceConfidence.Type

export const GenerationPerformanceAssessment = Schema.Struct({
  confidence: GenerationPerformanceConfidence,
  workload: Schema.String,
  always_active_weight_bytes: Schema.BigIntFromSelf,
  routed_expert_weight_bytes: Schema.BigIntFromSelf,
  expert_count: U32,
  expert_used_count: U32,
  cross_memory_domain_placement: Schema.Boolean,
  context_tokens: U32,
  kv_bytes_read_per_token: Schema.BigIntFromSelf,
  lower_tokens_per_second: Schema.Number,
  expected_tokens_per_second: Schema.Number,
  upper_tokens_per_second: Schema.Number,
})
export type GenerationPerformanceAssessment = typeof GenerationPerformanceAssessment.Type

export const HardwareProfile = Schema.Struct({
  context_length: U32,
  acceleration: Schema.String,
  device: Schema.String,
})
export type HardwareProfile = typeof HardwareProfile.Type

export const HardwareMemoryDomainAssessment = Schema.Struct({
  memory_domain: MemoryDomainId,
  model_bytes: Schema.BigIntFromSelf,
  context_bytes: Schema.BigIntFromSelf,
  compute_bytes: Schema.BigIntFromSelf,
  auxiliary_bytes: Schema.BigIntFromSelf,
  required_bytes: Schema.BigIntFromSelf,
  usable_capacity_bytes: Schema.BigIntFromSelf,
  margin_bytes: Schema.BigIntFromSelf,
})
export type HardwareMemoryDomainAssessment = typeof HardwareMemoryDomainAssessment.Type

export const HardwareDeviceMemoryAssessment = Schema.Struct({
  device_id: HardwareDeviceId,
  device: Schema.String,
  kind: Schema.Literal("recommended_working_set"),
  model_bytes: Schema.BigIntFromSelf,
  context_bytes: Schema.BigIntFromSelf,
  compute_bytes: Schema.BigIntFromSelf,
  auxiliary_bytes: Schema.BigIntFromSelf,
  required_bytes: Schema.BigIntFromSelf,
  usable_capacity_bytes: Schema.BigIntFromSelf,
  margin_bytes: Schema.BigIntFromSelf,
})
export type HardwareDeviceMemoryAssessment = typeof HardwareDeviceMemoryAssessment.Type

export const HardwareMemory = Schema.Struct({
  required_bytes: Schema.BigIntFromSelf,
  usable_capacity_bytes: Schema.BigIntFromSelf,
  headroom_bytes: Schema.BigIntFromSelf,
  domains: Schema.Array(HardwareMemoryDomainAssessment),
  device_constraints: Schema.Array(HardwareDeviceMemoryAssessment),
})
export type HardwareMemory = typeof HardwareMemory.Type

export const HardwareDeficit = Schema.Struct({
  required_bytes: Schema.BigIntFromSelf,
  usable_capacity_bytes: Schema.BigIntFromSelf,
  deficit_bytes: Schema.BigIntFromSelf,
  domains: Schema.Array(HardwareMemoryDomainAssessment),
  device_constraints: Schema.Array(HardwareDeviceMemoryAssessment),
})
export type HardwareDeficit = typeof HardwareDeficit.Type

export const HardwareRecommendation = Schema.Literal("recommended", "constrained")
export type HardwareRecommendation = typeof HardwareRecommendation.Type

export const HardwareAssessmentNotAssessed = Schema.Struct({
  type: Schema.Literal("not_assessed"),
  reason: Schema.String,
})

export const HardwareAssessmentFits = Schema.Struct({
  type: Schema.Literal("fits"),
  profile: HardwareProfile,
  memory: HardwareMemory,
  recommendation: HardwareRecommendation,
})

export const HardwareAssessmentDoesNotFit = Schema.Struct({
  type: Schema.Literal("does_not_fit"),
  profile: HardwareProfile,
  memory: HardwareDeficit,
  limiting_resource: Schema.String,
  alternative: optional(HardwareProfile),
})

export const HardwareAssessmentInvalidArtifact = Schema.Struct({
  type: Schema.Literal("invalid_artifact"),
  code: Schema.String,
  message: Schema.String,
})

export const HardwareAssessmentIncompatibleArtifact = Schema.Struct({
  type: Schema.Literal("incompatible_artifact"),
  code: Schema.String,
  message: Schema.String,
})

export const HardwareAssessment = Schema.Union(
  HardwareAssessmentNotAssessed,
  HardwareAssessmentFits,
  HardwareAssessmentDoesNotFit,
  HardwareAssessmentInvalidArtifact,
  HardwareAssessmentIncompatibleArtifact
)
export type HardwareAssessment = typeof HardwareAssessment.Type

export const ModelExecutionAssessmentExecutable = Schema.Struct({
  status: Schema.Literal("executable"),
  hardware: HardwareAssessment,
  performance: Schema.Array(GenerationPerformanceAssessment),
})

export const ModelExecutionAssessmentNotExecutable = Schema.Struct({
  status: Schema.Literal("not_executable"),
  hardware: HardwareAssessment,
})

export const ModelExecutionAssessment = Schema.Union(
  ModelExecutionAssessmentExecutable,
  ModelExecutionAssessmentNotExecutable
)
export type ModelExecutionAssessment = typeof ModelExecutionAssessment.Type

export const modelExecutionAssessmentHardware = (assessment: ModelExecutionAssessment): HardwareAssessment =>
  assessment.hardware

export const HardwareMemoryDomainKind = Schema.Literal("system", "physical_device", "unified_memory")
export type HardwareMemoryDomainKind = typeof HardwareMemoryDomainKind.Type

export const HardwareDeviceKind = Schema.Literal("cpu", "gpu", "integrated_gpu", "accelerator", "unknown")
export type HardwareDeviceKind = typeof HardwareDeviceKind.Type

export const HardwareDeviceMemoryLimitKind = Schema.Literal("recommended_working_set")
export type HardwareDeviceMemoryLimitKind = typeof HardwareDeviceMemoryLimitKind.Type

export const HardwareDeviceMemoryLimit = Schema.Struct({
  kind: HardwareDeviceMemoryLimitKind,
  total_bytes: Schema.BigIntFromSelf,
  stable_bytes: Schema.BigIntFromSelf,
  current_free_bytes: optional(Schema.BigIntFromSelf),
})
export type HardwareDeviceMemoryLimit = typeof HardwareDeviceMemoryLimit.Type

export const HardwareDevice = Schema.Struct({
  id: HardwareDeviceId,
  native_index: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  backend: Schema.String,
  physical_id: optional(Schema.String),
  name: Schema.String,
  description: Schema.String,
  kind: HardwareDeviceKind,
  memory_limit: optional(HardwareDeviceMemoryLimit),
})
export type HardwareDevice = typeof HardwareDevice.Type

export const HardwareSystemMemory = Schema.Struct({
  physical_capacity_bytes: Schema.BigIntFromSelf,
  physical_available_bytes: Schema.BigIntFromSelf,
  allocation_capacity_bytes: Schema.BigIntFromSelf,
  allocation_headroom_bytes: Schema.BigIntFromSelf,
  assess_reserve_bytes: Schema.BigIntFromSelf,
  abort_reserve_bytes: Schema.BigIntFromSelf,
})
export type HardwareSystemMemory = typeof HardwareSystemMemory.Type

export const HardwareMemoryDomain = Schema.Struct({
  id: MemoryDomainId,
  kind: HardwareMemoryDomainKind,
  total_capacity_bytes: Schema.BigIntFromSelf,
  stable_capacity_bytes: Schema.BigIntFromSelf,
  current_free_bytes: optional(Schema.BigIntFromSelf),
  shares_system_memory: Schema.Boolean,
  devices: Schema.Array(HardwareDevice),
})
export type HardwareMemoryDomain = typeof HardwareMemoryDomain.Type

export const HardwareSnapshot = Schema.Struct({
  captured_at: Schema.BigIntFromSelf,
  platform: Schema.String,
  architecture: Schema.String,
  system_product_name: optional(Schema.String),
  cpu_model: optional(Schema.String),
  logical_cores: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  system_memory: HardwareSystemMemory,
  native_build: Schema.String,
  enabled_backends: Schema.Array(Schema.String),
  topology_fingerprint: Schema.String,
  memory_domains: Schema.Array(HardwareMemoryDomain),
})
export type HardwareSnapshot = typeof HardwareSnapshot.Type

export interface MemoryBreakdown {
  model_bytes: bigint
  context_bytes: bigint
  compute_bytes: bigint
  auxiliary_bytes: bigint
}

export const memoryBreakdown = (
  modelBytes: bigint,
  contextBytes: bigint,
  computeBytes: bigint,
  auxiliaryBytes: bigint
): MemoryBreakdown => ({
  model_bytes: modelBytes,
  context_bytes: contextBytes,
  compute_bytes: computeBytes,
  auxiliary_bytes: auxiliaryBytes,
})

export const defaultMemoryBreakdown = (): MemoryBreakdown => memoryBreakdown(0n, 0n, 0n, 0n)

export const memoryBreakdownWithoutModel = (breakdown: MemoryBreakdown): MemoryBreakdown => ({
  ...breakdown,
  model_bytes: 0n,
})

export const memoryBreakdownSaturatingAdd = (left: MemoryBreakdown, right: MemoryBreakdown): MemoryBreakdown => ({
  model_bytes: left.model_bytes + right.model_bytes,
  context_bytes: left.context_bytes + right.context_bytes,
  compute_bytes: left.compute_bytes + right.compute_bytes,
  auxiliary_bytes: left.auxiliary_bytes + right.auxiliary_bytes,
})

export const memoryBreakdownTotalBytes = (breakdown: MemoryBreakdown): bigint =>
  breakdown.model_bytes + breakdown.context_bytes + breakdown.compute_bytes + breakdown.auxiliary_bytes

export type MemoryChargeOwner = "target" | "speculative_draft" | "projector" | "resident_runtime"

export type MemoryLocation =
  | { readonly type: "host" }
  | { readonly type: "native_device"; readonly locator: NativeDeviceLocator }

export interface MemoryCharge {
  readonly owner: MemoryChargeOwner
  readonly location: MemoryLocation
  readonly memory: MemoryBreakdown
}

export const memoryCharge = (
  owner: MemoryChargeOwner,
  location: MemoryLocation,
  memory: MemoryBreakdown
): MemoryCharge => ({ owner, location, memory })

export interface MemoryAccountingError {
  readonly owner: MemoryChargeOwner
  readonly location: MemoryLocation
}

export interface MemoryDomainAccounting {
  readonly id: MemoryDomainId
  readonly usable_capacity_bytes: bigint
  readonly memory: MemoryBreakdown
}

export interface MemoryDeviceAccounting {
  readonly device_id: HardwareDeviceId
  readonly name: string
  readonly kind: HardwareDeviceMemoryLimitKind
  readonly usable_capacity_bytes: bigint
  readonly memory: MemoryBreakdown
}

export interface MemoryAccounting {
  readonly domains: readonly MemoryDomainAccounting[]
  readonly device_constraints: readonly MemoryDeviceAccounting[]
}

export class NativeDeviceIdentity {
  constructor(
    readonly backend: string,
    readonly physicalId: string | null,
    readonly nativeIndex: number
  ) {}

  static new(backend: string, physicalId: string | null | undefined, nativeIndex: number): NativeDeviceIdentity {
    return new NativeDeviceIdentity(canonicalBackend(backend.trim()), physicalId ?? null, nativeIndex)
  }
}

export class NativeDeviceLocator {
  private constructor(
    readonly backend: string | null,
    readonly physicalId: string | null,
    readonly nativeIndex: number
  ) {}

  static exact(backend: string, physicalId: string | null | undefined, nativeIndex: number): NativeDeviceLocator {
    const trimmed = backend.trim()
    if (trimmed.length === 0) {
      throw new Error("an exact native device locator requires a backend")
    }
    const physical = physicalId ?? null
    if (physical !== null && physical.trim().length === 0) {
      throw new Error("an exact native device locator cannot contain a blank physical identity")
    }
    return new NativeDeviceLocator(canonicalBackend(trimmed), physical, nativeIndex)
  }

  static observed(backend: string, physicalId: string | null | undefined, nativeIndex: number): NativeDeviceLocator {
    const trimmed = backend.trim()
    const physical =
      physicalId !== undefined && physicalId !== null && physicalId.trim().length > 0 ? physicalId : null
    return new NativeDeviceLocator(trimmed.length > 0 ? canonicalBackend(trimmed) : null, physical, nativeIndex)
  }

  static byIndex(nativeIndex: number): NativeDeviceLocator {
    return new NativeDeviceLocator(null, null, nativeIndex)
  }

  matches(identity: NativeDeviceIdentity): boolean {
    if (this.nativeIndex !== identity.nativeIndex) return false
    if (this.backend !== null && this.backend !== identity.backend) return false
    if (this.physicalId !== null) {
      return identity.physicalId !== null && this.physicalId === identity.physicalId
    }
    return true
  }
}

export interface MemoryTopologyDevice {
  readonly id: HardwareDeviceId
  readonly memoryDomain: MemoryDomainId
  readonly identity: NativeDeviceIdentity
  readonly name: string
  readonly memoryLimit: HardwareDeviceMemoryLimit | null
}

interface MemoryDomainCapacity {
  total_bytes: bigint
  stable_bytes: bigint
}

export class MemoryTopology {
  private readonly capacities: Map<MemoryDomainId, MemoryDomainCapacity>
  private readonly devices: Map<HardwareDeviceId, MemoryTopologyDevice>

  private constructor(
    capacities: Map<MemoryDomainId, MemoryDomainCapacity>,
    devices: Map<HardwareDeviceId, MemoryTopologyDevice>
  ) {
    this.capacities = capacities
    this.devices = devices
  }

  static fromSnapshot(snapshot: HardwareSnapshot): MemoryTopology | null {
    return MemoryTopology.fromDomains(snapshot.memory_domains)
  }

  static fromDomains(domains: readonly HardwareMemoryDomain[]): MemoryTopology | null {
    const capacities = new Map<MemoryDomainId, MemoryDomainCapacity>()
    const devices = new Map<HardwareDeviceId, MemoryTopologyDevice>()
    const nativeIndices = new Set<number>()

    for (const domain of domains) {
      const kindMatchesIdentity = memoryDomainIdIsSystem(domain.id)
        ? domain.kind === "system" || domain.kind === "unified_memory"
        : domain.kind === "physical_device"
      if (
        domain.id.length === 0 ||
        memoryDomainIdIsSystem(domain.id) !== domain.shares_system_memory ||
        !kindMatchesIdentity ||
        domain.stable_capacity_bytes > domain.total_capacity_bytes
      ) {
        return null
      }
      if (capacities.has(domain.id)) return null
      capacities.set(domain.id, {
        total_bytes: domain.total_capacity_bytes,
        stable_bytes: domain.stable_capacity_bytes,
      })

      for (const device of domain.devices) {
        if (
          device.id.length === 0 ||
          device.backend.trim().length === 0 ||
          (device.physical_id !== undefined &&
            Option.isSome(device.physical_id) &&
            Option.getOrThrow(device.physical_id).trim().length === 0) ||
          nativeIndices.has(device.native_index)
        ) {
          return null
        }
        const limit = device.memory_limit
        if (
          limit !== undefined &&
          Option.isSome(limit) &&
          Option.getOrThrow(limit).stable_bytes > Option.getOrThrow(limit).total_bytes
        ) {
          return null
        }
        const binding: MemoryTopologyDevice = {
          id: device.id,
          memoryDomain: domain.id,
          identity: NativeDeviceIdentity.new(
            device.backend,
            Option.getOrNull(device.physical_id),
            device.native_index
          ),
          name: device.name,
          memoryLimit: Option.getOrNull(device.memory_limit),
        }
        if (devices.has(device.id)) return null
        devices.set(device.id, binding)
        nativeIndices.add(device.native_index)
      }
    }

    if (!capacities.has(systemMemoryDomainId())) return null
    return new MemoryTopology(capacities, devices)
  }

  capacity(domain: MemoryDomainId): bigint | undefined {
    return this.capacities.get(domain)?.total_bytes
  }

  stableCapacity(domain: MemoryDomainId): bigint | undefined {
    return this.capacities.get(domain)?.stable_bytes
  }

  aggregateStableCapacity(): bigint {
    let total = 0n
    for (const capacity of this.capacities.values()) {
      total += capacity.stable_bytes
    }
    return total
  }

  systemDomain(): MemoryDomainId {
    for (const domain of this.capacities.keys()) {
      if (memoryDomainIdIsSystem(domain)) return domain
    }
    throw new Error("validated topology always has a system domain")
  }

  resolve(location: MemoryLocation): { memoryDomain: MemoryDomainId; device: MemoryTopologyDevice | null } | null {
    if (location.type === "host") {
      return { memoryDomain: this.systemDomain(), device: null }
    }
    const device = [...this.devices.values()].find(
      (candidate) => candidate.identity.nativeIndex === location.locator.nativeIndex
    )
    if (device === undefined || !location.locator.matches(device.identity)) return null
    return { memoryDomain: device.memoryDomain, device }
  }

  validatesHardwareAssessment(assessment: HardwareAssessment): boolean {
    switch (assessment.type) {
      case "fits": {
        const memory = assessment.memory
        return (
          this.validatesHardwareDomains(memory.domains) &&
          this.validatesDeviceConstraints(memory.device_constraints) &&
          memory.required_bytes === sumRequiredBytes(memory.domains) &&
          memory.usable_capacity_bytes === sumUsableCapacityBytes(memory.domains) &&
          memory.headroom_bytes === memory.usable_capacity_bytes - memory.required_bytes
        )
      }
      case "does_not_fit": {
        const memory = assessment.memory
        const deficits = [
          ...memory.domains.map((domain) =>
            domain.required_bytes > domain.usable_capacity_bytes
              ? domain.required_bytes - domain.usable_capacity_bytes
              : 0n
          ),
          ...memory.device_constraints.map((constraint) =>
            constraint.required_bytes > constraint.usable_capacity_bytes
              ? constraint.required_bytes - constraint.usable_capacity_bytes
              : 0n
          ),
        ]
        const maxDeficit = deficits.reduce((max, value) => (value > max ? value : max), 0n)
        return (
          this.validatesHardwareDomains(memory.domains) &&
          this.validatesDeviceConstraints(memory.device_constraints) &&
          memory.required_bytes === sumRequiredBytes(memory.domains) &&
          memory.usable_capacity_bytes === sumUsableCapacityBytes(memory.domains) &&
          memory.deficit_bytes === maxDeficit
        )
      }
      case "invalid_artifact":
      case "incompatible_artifact":
        return true
      default:
        return false
    }
  }

  private validatesHardwareDomains(domains: readonly HardwareMemoryDomainAssessment[]): boolean {
    const seen = new Map<MemoryDomainId, true>()
    for (const domain of domains) {
      const capacity = this.capacities.get(domain.memory_domain)
      if (capacity === undefined) return false
      const expectedRequired =
        domain.model_bytes + domain.context_bytes + domain.compute_bytes + domain.auxiliary_bytes
      const expectedMargin = domain.usable_capacity_bytes - domain.required_bytes
      if (
        seen.has(domain.memory_domain) ||
        domain.usable_capacity_bytes !== capacity.stable_bytes ||
        domain.required_bytes !== expectedRequired ||
        domain.margin_bytes !== expectedMargin
      ) {
        return false
      }
      seen.set(domain.memory_domain, true)
    }
    return seen.has(systemMemoryDomainId())
  }

  private validatesDeviceConstraints(constraints: readonly HardwareDeviceMemoryAssessment[]): boolean {
    const seen = new Set<HardwareDeviceId>()
    return constraints.every((constraint) => {
      const device = this.devices.get(constraint.device_id)
      if (device === undefined || device.memoryLimit === null) return false
      const limit = device.memoryLimit
      if (seen.has(constraint.device_id)) return false
      seen.add(constraint.device_id)
      const expectedRequired =
        constraint.model_bytes +
        constraint.context_bytes +
        constraint.compute_bytes +
        constraint.auxiliary_bytes
      const expectedMargin = constraint.usable_capacity_bytes - constraint.required_bytes
      return (
        constraint.kind === limit.kind &&
        constraint.usable_capacity_bytes === limit.stable_bytes &&
        constraint.required_bytes === expectedRequired &&
        constraint.margin_bytes === expectedMargin
      )
    })
  }
}

export class MemoryAccountant {
  private readonly topology: MemoryTopology
  private readonly domains = new Map<MemoryDomainId, MemoryDomainAccounting>()
  private readonly deviceConstraints = new Map<HardwareDeviceId, MemoryDeviceAccounting>()

  constructor(topology: MemoryTopology) {
    this.topology = topology
    const system = topology.systemDomain()
    const usable = topology.stableCapacity(system)
    if (usable === undefined) throw new Error("validated topology always has a stable system capacity")
    this.domains.set(system, {
      id: system,
      usable_capacity_bytes: usable,
      memory: defaultMemoryBreakdown(),
    })
  }

  record(charge: MemoryCharge): MemoryAccountingError | null {
    const resolved = this.topology.resolve(charge.location)
    if (resolved === null) {
      return { owner: charge.owner, location: charge.location }
    }
    const usable = this.topology.stableCapacity(resolved.memoryDomain)
    if (usable === undefined) throw new Error("resolved domain always has a stable capacity")
    const existing = this.domains.get(resolved.memoryDomain) ?? {
      id: resolved.memoryDomain,
      usable_capacity_bytes: usable,
      memory: defaultMemoryBreakdown(),
    }
    const updated: MemoryDomainAccounting = {
      ...existing,
      memory: memoryBreakdownSaturatingAdd(existing.memory, charge.memory),
    }
    this.domains.set(resolved.memoryDomain, updated)

    if (resolved.device !== null && resolved.device.memoryLimit !== null) {
      const limit = resolved.device.memoryLimit
      const deviceExisting = this.deviceConstraints.get(resolved.device.id) ?? {
        device_id: resolved.device.id,
        name: resolved.device.name,
        kind: limit.kind,
        usable_capacity_bytes: limit.stable_bytes,
        memory: defaultMemoryBreakdown(),
      }
      const updatedDevice: MemoryDeviceAccounting = {
        ...deviceExisting,
        memory: memoryBreakdownSaturatingAdd(deviceExisting.memory, charge.memory),
      }
      this.deviceConstraints.set(resolved.device.id, updatedDevice)
    }
    return null
  }

  finish(): MemoryAccounting {
    return {
      domains: [...this.domains.values()],
      device_constraints: [...this.deviceConstraints.values()],
    }
  }
}

const sumRequiredBytes = (domains: readonly HardwareMemoryDomainAssessment[]): bigint =>
  domains.reduce((total, domain) => total + domain.required_bytes, 0n)

const sumUsableCapacityBytes = (domains: readonly HardwareMemoryDomainAssessment[]): bigint =>
  domains.reduce((total, domain) => total + domain.usable_capacity_bytes, 0n)

const canonicalBackend = (backend: string): string => {
  const lower = backend.toLowerCase()
  return lower === "metal" || lower === "mtl" ? "metal" : backend
}

export const ModelPreviewComponentRoleProjector = Schema.Struct({ type: Schema.Literal("projector") })
export const ModelPreviewComponentRoleDraft = Schema.Struct({
  type: Schema.Literal("draft"),
  method: SpeculativeMethod,
})
export const ModelPreviewComponentRoleMtp = Schema.Struct({ type: Schema.Literal("mtp") })

export const ModelPreviewComponentRole = Schema.Union(
  ModelPreviewComponentRoleProjector,
  ModelPreviewComponentRoleDraft,
  ModelPreviewComponentRoleMtp
)
export type ModelPreviewComponentRole = typeof ModelPreviewComponentRole.Type

export const modelPreviewComponentRole = (role: ModelPreviewComponentRole): ComponentRole => {
  switch (role.type) {
    case "projector":
      return "projector"
    case "draft":
      return "draft"
    case "mtp":
      return "mtp"
  }
}

export const ModelPreviewComponentSource = Schema.Struct({
  path: Path,
  role: ModelPreviewComponentRole,
})
export type ModelPreviewComponentSource = typeof ModelPreviewComponentSource.Type

export const ModelPreviewSource = Schema.Struct({
  repository: Schema.String,
  revision: Schema.String,
  primary_gguf: Path,
  additional_components: Schema.Array(ModelPreviewComponentSource),
})
export type ModelPreviewSource = typeof ModelPreviewSource.Type

export const ModelPreviewProfile = Schema.Struct({
  id: Schema.String,
  context_length: U32,
  parallel_sequences: U32,
  performance_context_tokens: Schema.Array(U32),
})
export type ModelPreviewProfile = typeof ModelPreviewProfile.Type

export const ModelPreviewRequest = Schema.Struct({
  source: ModelPreviewSource,
  profiles: Schema.Array(ModelPreviewProfile),
})
export type ModelPreviewRequest = typeof ModelPreviewRequest.Type

export const ModelPreviewAssessment = Schema.Struct({
  profile_id: Schema.String,
  artifact_fingerprint: Schema.String,
  hardware_topology: Schema.String,
  execution: ModelExecutionAssessment,
})
export type ModelPreviewAssessment = typeof ModelPreviewAssessment.Type

export const ModelPreview = Schema.Struct({
  repository: Schema.String,
  commit: Schema.String,
  components: Schema.Array(ModelComponent),
  properties: InventoryProperties,
  assessments: Schema.Array(ModelPreviewAssessment),
})
export type ModelPreview = typeof ModelPreview.Type

export const HuggingFaceModelSearchRequest = Schema.Struct({
  query: Schema.String,
  limit: U32,
})
export type HuggingFaceModelSearchRequest = typeof HuggingFaceModelSearchRequest.Type

export const HuggingFaceModelSearchResult = Schema.Struct({
  repository: Schema.String,
  commit: Schema.String,
  last_modified: optional(Schema.String),
  downloads: optional(Schema.BigIntFromSelf),
  likes: optional(Schema.BigIntFromSelf),
  gated: Schema.Boolean,
  private: Schema.Boolean,
  tags: Schema.Array(Schema.String),
})
export type HuggingFaceModelSearchResult = typeof HuggingFaceModelSearchResult.Type

export const HuggingFaceModelSearchResults = Schema.Struct({
  models: Schema.Array(HuggingFaceModelSearchResult),
})
export type HuggingFaceModelSearchResults = typeof HuggingFaceModelSearchResults.Type

export const HuggingFaceRepositoryRequest = Schema.Struct({
  repository: Schema.String,
  revision: Schema.String,
})
export type HuggingFaceRepositoryRequest = typeof HuggingFaceRepositoryRequest.Type

export const HuggingFaceRepositoryFile = Schema.Struct({
  path: Path,
  size_bytes: Schema.BigIntFromSelf,
  content: ContentIdentity,
})
export type HuggingFaceRepositoryFile = typeof HuggingFaceRepositoryFile.Type

export const HuggingFaceRepositorySnapshot = Schema.Struct({
  repository: Schema.String,
  commit: Schema.String,
  last_modified: optional(Schema.String),
  downloads: optional(Schema.BigIntFromSelf),
  likes: optional(Schema.BigIntFromSelf),
  gated: Schema.Boolean,
  private: Schema.Boolean,
  license: optional(Schema.String),
  license_url: optional(Schema.String),
  base_models: Schema.Array(Schema.String),
  tags: Schema.Array(Schema.String),
  gguf_files: Schema.Array(HuggingFaceRepositoryFile),
})
export type HuggingFaceRepositorySnapshot = typeof HuggingFaceRepositorySnapshot.Type

export const ModelOperation = Schema.Literal("load", "unload", "delete")
export type ModelOperation = typeof ModelOperation.Type

export const DownloadFileProgress = Schema.Struct({
  path: Path,
  completed_bytes: Schema.BigIntFromSelf,
  total_bytes: Schema.BigIntFromSelf,
})
export type DownloadFileProgress = typeof DownloadFileProgress.Type

export const InventoryModel = Schema.Struct({
  id: InventoryEntryId,
  content_id: ContentId,
  created: Schema.BigIntFromSelf,
  name: Schema.String,
  supported_parameters: Schema.Array(Schema.String),
  availability: ModelAvailability,
  source: ModelSource,
  location: ModelLocation,
  properties: InventoryProperties,
  operations: Schema.Array(ModelOperation),
  updated_at: Schema.BigIntFromSelf,
})
export type InventoryModel = typeof InventoryModel.Type

export interface ResolvedComponent {
  readonly path: string
  readonly role: ComponentRole
  readonly shard_index: number | undefined
  readonly relationship: ComponentRelationship | undefined
}

export interface ResolvedModel {
  readonly model: InventoryModel
  readonly components: readonly ResolvedComponent[]
}

export const ModelDownloadEventResolving = Schema.Struct({
  type: Schema.Literal("resolving"),
  operation_id: Schema.String,
  repository: Schema.String,
  revision: Schema.String,
})

export const ModelDownloadEventCheckingSpace = Schema.Struct({
  type: Schema.Literal("checking_space"),
  operation_id: Schema.String,
  model_id: InventoryEntryId,
  required_bytes: Schema.BigIntFromSelf,
  available_bytes: Schema.BigIntFromSelf,
  completed_bytes: Schema.BigIntFromSelf,
  total_bytes: Schema.BigIntFromSelf,
})

export const ModelDownloadEventProgress = Schema.Struct({
  type: Schema.Literal("progress"),
  operation_id: Schema.String,
  model_id: InventoryEntryId,
  stage: DownloadStage,
  completed_bytes: Schema.BigIntFromSelf,
  total_bytes: Schema.BigIntFromSelf,
  file: DownloadFileProgress,
  bytes_per_second: optional(Schema.Number),
  resumed_from_bytes: Schema.BigIntFromSelf,
})

export const ModelDownloadEventReady = Schema.Struct({
  type: Schema.Literal("ready"),
  operation_id: Schema.String,
  model: InventoryModel,
})

export const ModelDownloadEventCancelled = Schema.Struct({
  type: Schema.Literal("cancelled"),
  operation_id: Schema.String,
  model_id: optional(InventoryEntryId),
  completed_bytes: Schema.BigIntFromSelf,
  total_bytes: Schema.BigIntFromSelf,
})

export const ModelDownloadEventFailed = Schema.Struct({
  type: Schema.Literal("failed"),
  operation_id: Schema.String,
  model_id: optional(InventoryEntryId),
  error: DownloadFailure,
  completed_bytes: Schema.BigIntFromSelf,
  total_bytes: Schema.BigIntFromSelf,
  resumable: Schema.Boolean,
})

export const ModelDownloadEvent = Schema.Union(
  ModelDownloadEventResolving,
  ModelDownloadEventCheckingSpace,
  ModelDownloadEventProgress,
  ModelDownloadEventReady,
  ModelDownloadEventCancelled,
  ModelDownloadEventFailed
)
export type ModelDownloadEvent = typeof ModelDownloadEvent.Type

export const DeletePlan = Schema.Struct({
  model_id: InventoryEntryId,
  supported: Schema.Boolean,
  reason: optional(Schema.String),
  reclaimable_bytes: Schema.BigIntFromSelf,
  retained_shared_bytes: Schema.BigIntFromSelf,
  paths: Schema.Array(Path),
})
export type DeletePlan = typeof DeletePlan.Type

export const DeletedModel = Schema.Struct({
  id: InventoryEntryId,
  deleted: Schema.Boolean,
  freed_bytes: Schema.BigIntFromSelf,
  retained_shared_bytes: Schema.BigIntFromSelf,
  plan: DeletePlan,
})
export type DeletedModel = typeof DeletedModel.Type

export interface ModelInventory {
  list(): Promise<InventoryModel[] | InventoryError>
  get(id: InventoryEntryId): Promise<InventoryModel | InventoryError>
  planDelete(id: InventoryEntryId): Promise<DeletePlan | InventoryError>
  delete(id: InventoryEntryId): Promise<DeletedModel | InventoryError>
  resolveReady(id: InventoryEntryId): Promise<ResolvedModel | InventoryError>
}

export interface HardwareProvider {
  snapshot(): Promise<HardwareSnapshot | InventoryError>
}

export interface ResolvedModelAssessor extends HardwareProvider {
  executionCacheKey(
    profile: ModelPreviewProfile | null,
    snapshot: HardwareSnapshot
  ): string | InventoryError
  assessProfile(
    model: ResolvedModel,
    profile: ModelPreviewProfile | null
  ): Promise<HardwareAssessment | InventoryError>
  assessProfiles(
    model: ResolvedModel,
    profiles: readonly ModelPreviewProfile[]
  ): Promise<readonly HardwareAssessment[] | InventoryError>
  assessExecutionProfiles(
    model: ResolvedModel,
    profiles: readonly ModelPreviewProfile[]
  ): Promise<readonly ModelExecutionAssessment[] | InventoryError>
}

export interface ModelPreviewer {
  preview(request: ModelPreviewRequest): Promise<ModelPreview | InventoryError>
}

export interface HuggingFaceModelCatalog {
  search(request: HuggingFaceModelSearchRequest): Promise<HuggingFaceModelSearchResults | InventoryError>
  resolve(request: HuggingFaceRepositoryRequest): Promise<HuggingFaceRepositorySnapshot | InventoryError>
}
