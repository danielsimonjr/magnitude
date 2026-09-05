import { Option, Schema } from "effect"
import { optional, Path, U32 } from "../schema/common.js"
import { DownloadFailure, DownloadStage, MemoryDomainId, MemoryTopology, type ResolvedModel } from "../inventory.js"
import { ModelId, ModelIdSchema } from "./ids.js"
import {
  AssessmentEnvironmentId,
  CatalogBaseId,
  CatalogInstallationOperationId,
  CatalogVariantId,
  ModelAssessmentId,
  ModelDownloadId,
  ModelFileId,
  ModelInstanceId,
  ModelPackageId,
  ModelReleaseDate,
} from "./ids.js"
import { SpeculativeMethod } from "./speculative.js"

export const ModelInstanceMemoryDomain = Schema.Struct({
  memoryDomainId: MemoryDomainId,
  modelBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  contextBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  computeBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  auxiliaryBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
})
export type ModelInstanceMemoryDomain = typeof ModelInstanceMemoryDomain.Type

export const ModelInstanceAllocation = Schema.Struct({
  contextWindowTokens: U32,
  parallelSequences: U32,
  physicalContextTokens: U32,
  memoryDomains: Schema.Array(ModelInstanceMemoryDomain),
})
export type ModelInstanceAllocation = typeof ModelInstanceAllocation.Type

export const ModelReleaseReason = Schema.Literal("user_stop", "idle_timeout", "replacement", "memory_pressure")
export type ModelReleaseReason = typeof ModelReleaseReason.Type

export const ModelLoadPlan = Schema.Struct({
  contextWindowTokens: U32,
  parallelSequences: U32,
  physicalContextTokens: U32,
  requiredSystemMemoryBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
})
export type ModelLoadPlan = typeof ModelLoadPlan.Type

export const ModelStoppingAllocationPlanned = Schema.Struct({
  _tag: Schema.Literal("Planned"),
  allocation: optional(ModelLoadPlan),
})
export const ModelStoppingAllocationResident = Schema.Struct({
  _tag: Schema.Literal("Resident"),
  allocation: ModelInstanceAllocation,
})
export const ModelStoppingAllocation = Schema.Union(
  ModelStoppingAllocationPlanned,
  ModelStoppingAllocationResident
)
export type ModelStoppingAllocation = typeof ModelStoppingAllocation.Type

export const ModelFailure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
})
export type ModelFailure = typeof ModelFailure.Type

export const ModelInstanceFailureOperation = Schema.Struct({
  _tag: Schema.Literal("Operation"),
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
})

export const ModelInstanceFailureLowMemory = Schema.Struct({
  _tag: Schema.Literal("LowMemory"),
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
  requiredSystemMemoryBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  allocationHeadroomBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  systemReserveBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  loadBoundaryBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  minimumAdditionalAvailableBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  parallelSequences: U32,
})

export const ModelInstanceFailure = Schema.Union(
  ModelInstanceFailureOperation,
  ModelInstanceFailureLowMemory
)
export type ModelInstanceFailure = typeof ModelInstanceFailure.Type

export const modelInstanceFailureFromModelFailure = (failure: ModelFailure): ModelInstanceFailure => ({
  _tag: "Operation",
  code: failure.code,
  message: failure.message,
  retryable: failure.retryable,
})

export const ModelLoadStage = Schema.Literal("queued", "resolving", "unloading", "loading", "verifying")
export type ModelLoadStage = typeof ModelLoadStage.Type

export const ModelInstanceLifecycleLoading = Schema.Struct({
  _tag: Schema.Literal("Loading"),
  stage: ModelLoadStage,
  progress: optional(Schema.Number),
  plannedAllocation: optional(ModelLoadPlan),
})

export const ModelInstanceLifecycleReady = Schema.Struct({
  _tag: Schema.Literal("Ready"),
  allocation: ModelInstanceAllocation,
})

export const ModelInstanceLifecycleStopping = Schema.Struct({
  _tag: Schema.Literal("Stopping"),
  reason: ModelReleaseReason,
  allocation: ModelStoppingAllocation,
})

export const ModelInstanceLifecycleStopped = Schema.Struct({
  _tag: Schema.Literal("Stopped"),
  reason: ModelReleaseReason,
})

export const ModelInstanceLifecycleFailed = Schema.Struct({
  _tag: Schema.Literal("Failed"),
  failure: ModelInstanceFailure,
})

export const ModelInstanceLifecycle = Schema.Union(
  ModelInstanceLifecycleLoading,
  ModelInstanceLifecycleReady,
  ModelInstanceLifecycleStopping,
  ModelInstanceLifecycleStopped,
  ModelInstanceLifecycleFailed
)
export type ModelInstanceLifecycle = typeof ModelInstanceLifecycle.Type

export const ModelInstance = Schema.Struct({
  id: ModelInstanceId,
  modelId: ModelIdSchema,
  lifecycle: ModelInstanceLifecycle,
})
export type ModelInstance = typeof ModelInstance.Type

export const ModelInstancesSnapshot = Schema.Struct({
  revision: Schema.BigIntFromSelf,
  instances: Schema.Array(ModelInstance),
})
export type ModelInstancesSnapshot = typeof ModelInstancesSnapshot.Type

export const ModelInstancesInvalidation = Schema.Struct({
  revision: Schema.BigIntFromSelf,
})
export type ModelInstancesInvalidation = typeof ModelInstancesInvalidation.Type

export const ModelFileRole = Schema.Literal("weights", "projector", "draft", "mtp", "auxiliary")
export type ModelFileRole = typeof ModelFileRole.Type

export const ModelFile = Schema.Struct({
  id: ModelFileId,
  path: Path,
  role: ModelFileRole,
  sizeBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  tensorStorageBytes: optional(Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))),
  sha256: Schema.String,
})
export type ModelFile = typeof ModelFile.Type

export const ModelPackageSourceHuggingFace = Schema.Struct({
  _tag: Schema.Literal("HuggingFace"),
  repository: Schema.String,
  revision: Schema.String,
})

export const ModelPackageSourceLocal = Schema.Struct({
  _tag: Schema.Literal("Local"),
  path: Path,
})

export const ModelPackageSource = Schema.Union(ModelPackageSourceHuggingFace, ModelPackageSourceLocal)
export type ModelPackageSource = typeof ModelPackageSource.Type

export const ModelFileRelationshipShard = Schema.Struct({
  _tag: Schema.Literal("Shard"),
  fileId: ModelFileId,
  index: U32,
  count: U32,
})

export const ModelFileRelationshipProjectorFor = Schema.Struct({
  _tag: Schema.Literal("ProjectorFor"),
  projectorFileId: ModelFileId,
  weightsFileId: ModelFileId,
})

export const ModelFileRelationshipMtpFor = Schema.Struct({
  _tag: Schema.Literal("MtpFor"),
  mtpFileId: ModelFileId,
  weightsFileId: ModelFileId,
})

export const ModelFileRelationshipDraftFor = Schema.Struct({
  _tag: Schema.Literal("DraftFor"),
  draftFileId: ModelFileId,
  weightsFileId: ModelFileId,
  method: SpeculativeMethod,
})

export const ModelFileRelationship = Schema.Union(
  ModelFileRelationshipShard,
  ModelFileRelationshipProjectorFor,
  ModelFileRelationshipMtpFor,
  ModelFileRelationshipDraftFor
)
export type ModelFileRelationship = typeof ModelFileRelationship.Type

export const ModelPackageProperties = Schema.Struct({
  format: Schema.String,
  quantization: Schema.String,
  quantizationName: Schema.String,
  architecture: Schema.String,
  maximumContextLength: optional(U32),
  intrinsicModelId: optional(Schema.String),
  intrinsicQualityId: optional(Schema.String),
})
export type ModelPackageProperties = typeof ModelPackageProperties.Type

export const ModelPackage = Schema.Struct({
  id: ModelPackageId,
  source: ModelPackageSource,
  files: Schema.Array(ModelFile),
  relationships: Schema.Array(ModelFileRelationship),
  properties: ModelPackageProperties,
})
export type ModelPackage = typeof ModelPackage.Type

export const PackageValidationPending = Schema.Struct({ _tag: Schema.Literal("Pending") })
export const PackageValidationValid = Schema.Struct({ _tag: Schema.Literal("Valid") })
export const PackageValidationInvalid = Schema.Struct({
  _tag: Schema.Literal("Invalid"),
  failure: ModelFailure,
})
export const PackageValidationUnsupported = Schema.Struct({
  _tag: Schema.Literal("Unsupported"),
  failure: ModelFailure,
})

export const PackageValidation = Schema.Union(
  PackageValidationPending,
  PackageValidationValid,
  PackageValidationInvalid,
  PackageValidationUnsupported
)
export type PackageValidation = typeof PackageValidation.Type

export const ModelPackageInstallationOrigin = Schema.Literal("Magnitude", "HuggingFaceCache")
export type ModelPackageInstallationOrigin = typeof ModelPackageInstallationOrigin.Type

export const CatalogPackageRole = Schema.Literal("Target", "Dependency")
export type CatalogPackageRole = typeof CatalogPackageRole.Type

export const CatalogPackageAffiliation = Schema.Struct({
  modelId: CatalogBaseId,
  variantId: CatalogVariantId,
  packageId: ModelPackageId,
  repository: Schema.String,
  role: CatalogPackageRole,
})
export type CatalogPackageAffiliation = typeof CatalogPackageAffiliation.Type

export const InstalledCatalogAttributionNotCatalogTarget = Schema.Struct({
  _tag: Schema.Literal("NotCatalogTarget"),
})

export const InstalledCatalogAttributionAttributed = Schema.Struct({
  _tag: Schema.Literal("Attributed"),
  modelId: CatalogBaseId,
  variantId: CatalogVariantId,
})

export const InstalledCatalogAttributionFailed = Schema.Struct({
  _tag: Schema.Literal("Failed"),
  failure: ModelFailure,
})

export const InstalledCatalogAttribution = Schema.Union(
  InstalledCatalogAttributionNotCatalogTarget,
  InstalledCatalogAttributionAttributed,
  InstalledCatalogAttributionFailed
)
export type InstalledCatalogAttribution = typeof InstalledCatalogAttribution.Type

export const InstalledModelPackage = Schema.Struct({
  package: ModelPackage,
  path: Path,
  origin: ModelPackageInstallationOrigin,
  validation: PackageValidation,
  catalogAttribution: InstalledCatalogAttribution,
})
export type InstalledModelPackage = typeof InstalledModelPackage.Type

export const InstalledModelPackagesResponse = Schema.Struct({
  revision: Schema.BigIntFromSelf,
  reconciliationComplete: Schema.Boolean,
  packages: Schema.Array(InstalledModelPackage),
})
export type InstalledModelPackagesResponse = typeof InstalledModelPackagesResponse.Type

export const RemoveInstalledModelPackageResponse = Schema.Struct({
  packageId: ModelPackageId,
  removed: Schema.Boolean,
  freedBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
})
export type RemoveInstalledModelPackageResponse = typeof RemoveInstalledModelPackageResponse.Type

export const ServableSpeculativeDraftEmbedded = Schema.Struct({ _tag: Schema.Literal("Embedded") })
export const ServableSpeculativeDraftSeparate = Schema.Struct({
  _tag: Schema.Literal("Separate"),
  draft: ModelPackage,
})

export const ServableSpeculativeDraftSource = Schema.Union(
  ServableSpeculativeDraftEmbedded,
  ServableSpeculativeDraftSeparate
)
export type ServableSpeculativeDraftSource = typeof ServableSpeculativeDraftSource.Type

export const ServableModelBundleStandalone = Schema.Struct({
  _tag: Schema.Literal("Standalone"),
  package: ModelPackage,
})

export const ServableModelBundleSpeculativeDecoding = Schema.Struct({
  _tag: Schema.Literal("SpeculativeDecoding"),
  target: ModelPackage,
  draftSource: ServableSpeculativeDraftSource,
  method: SpeculativeMethod,
})

export const ServableModelBundle = Schema.Union(
  ServableModelBundleStandalone,
  ServableModelBundleSpeculativeDecoding
)
export type ServableModelBundle = typeof ServableModelBundle.Type

export const ServingProfile = Schema.Struct({
  contextLength: U32,
})
export type ServingProfile = typeof ServingProfile.Type

export const ModelServingConfiguration = Schema.Struct({
  bundle: ServableModelBundle,
  profile: ServingProfile,
})
export type ModelServingConfiguration = typeof ModelServingConfiguration.Type

export const ModelReasoningCapabilities = Schema.Struct({
  supported: Schema.Boolean,
  efforts: Schema.Array(Schema.String),
  defaultEffort: optional(Schema.String),
})
export type ModelReasoningCapabilities = typeof ModelReasoningCapabilities.Type

export const ModelCapabilities = Schema.Struct({
  vision: Schema.Boolean,
  tools: Schema.Boolean,
  structuredOutput: Schema.Boolean,
  reasoning: ModelReasoningCapabilities,
})
export type ModelCapabilities = typeof ModelCapabilities.Type

export const ModelMetadata = Schema.Struct({
  format: Schema.String,
  architecture: Schema.String,
  quantization: Schema.String,
  quantizationName: Schema.String,
  storageBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  maximumContextLength: optional(U32),
})
export type ModelMetadata = typeof ModelMetadata.Type

export const ReadyModel = Schema.Struct({
  metadata: ModelMetadata,
  profile: ServingProfile,
  speculativeMethod: optional(SpeculativeMethod),
})
export type ReadyModel = typeof ReadyModel.Type

export const EffectiveModelReady = Schema.Struct({
  _tag: Schema.Literal("Ready"),
  model: ReadyModel,
})

export const EffectiveModelUnavailable = Schema.Struct({
  _tag: Schema.Literal("Unavailable"),
  failure: ModelFailure,
})

export const EffectiveModel = Schema.Union(EffectiveModelReady, EffectiveModelUnavailable)
export type EffectiveModel = typeof EffectiveModel.Type

export const ModelInstallationOwnership = Schema.Literal("Magnitude", "ExternalHuggingFace", "Mixed")
export type ModelInstallationOwnership = typeof ModelInstallationOwnership.Type

export const ModelInstallationResolved = Schema.Struct({
  _tag: Schema.Literal("Resolved"),
  installedBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  primaryPath: Path,
  ownership: ModelInstallationOwnership,
})

export const ModelInstallationUnresolved = Schema.Struct({
  _tag: Schema.Literal("Unresolved"),
  installedBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  ownership: ModelInstallationOwnership,
})

export const ModelInstallation = Schema.Union(ModelInstallationResolved, ModelInstallationUnresolved)
export type ModelInstallation = typeof ModelInstallation.Type

export const ResolvedModelInstallation = Schema.Struct({
  _tag: Schema.Literal("Resolved"),
  installedBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  primaryPath: Path,
  ownership: ModelInstallationOwnership,
})
export type ResolvedModelInstallation = typeof ResolvedModelInstallation.Type

export const ModelParameterizationDense = Schema.Struct({
  architecture: Schema.Literal("dense"),
  totalParameters: Schema.BigIntFromSelf,
})

export const ModelParameterizationMoe = Schema.Struct({
  architecture: Schema.Literal("mixtureOfExperts"),
  totalParameters: Schema.BigIntFromSelf,
  activeParameters: Schema.BigIntFromSelf,
})

export const ModelParameterization = Schema.Union(ModelParameterizationDense, ModelParameterizationMoe)
export type ModelParameterization = typeof ModelParameterization.Type

export const IntelligenceEstimateConfidence = Schema.Literal("high", "moderate", "low")
export type IntelligenceEstimateConfidence = typeof IntelligenceEstimateConfidence.Type

export const IntelligenceTarget = Schema.Literal("artificialAnalysisIntelligenceIndex")
export type IntelligenceTarget = typeof IntelligenceTarget.Type

export const IntelligenceProvenanceArtificialAnalysis = Schema.Struct({
  kind: Schema.Literal("artificialAnalysisIntelligenceIndex"),
  methodologyVersion: Schema.String,
  asOfDate: Schema.String,
  url: Schema.String,
})

export const IntelligenceProvenanceEstimate = Schema.Struct({
  kind: Schema.Literal("estimate"),
  target: IntelligenceTarget,
  methodologyVersion: Schema.String,
  asOfDate: Schema.String,
  confidence: IntelligenceEstimateConfidence,
  methodology: Schema.String,
  evidenceUrls: Schema.Array(Schema.String).pipe(Schema.minItems(1)),
})

export const IntelligenceProvenance = Schema.Union(
  IntelligenceProvenanceArtificialAnalysis,
  IntelligenceProvenanceEstimate
)
export type IntelligenceProvenance = typeof IntelligenceProvenance.Type

export const CatalogIntelligence = Schema.Struct({
  score: Schema.Number,
  provenance: IntelligenceProvenance,
})
export type CatalogIntelligence = typeof CatalogIntelligence.Type

export const RecommendableModel = Schema.Struct({
  modelId: CatalogBaseId,
  variantId: CatalogVariantId,
  configuration: ModelServingConfiguration,
  displayName: Schema.String,
  variantLabel: Schema.String,
  description: Schema.String,
  releaseDate: ModelReleaseDate,
  license: Schema.String,
  parameterization: ModelParameterization,
  intelligence: CatalogIntelligence,
  fidelityRank: U32,
  quantizationAware: Schema.Boolean,
})
export type RecommendableModel = typeof RecommendableModel.Type

export const CatalogDiagnostic = Schema.Struct({
  modelId: CatalogBaseId,
  variantId: CatalogVariantId,
  failure: ModelFailure,
})
export type CatalogDiagnostic = typeof CatalogDiagnostic.Type

export const CatalogModelUpdateCurrent = Schema.Struct({ _tag: Schema.Literal("Current") })
export const CatalogModelUpdateAvailable = Schema.Struct({
  _tag: Schema.Literal("Available"),
  requiredDownloadBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
})
export const CatalogModelUpdate = Schema.Union(CatalogModelUpdateCurrent, CatalogModelUpdateAvailable)
export type CatalogModelUpdate = typeof CatalogModelUpdate.Type

export const CatalogModelStateNotInstalled = Schema.Struct({ _tag: Schema.Literal("NotInstalled") })
export const CatalogModelStateInstalled = Schema.Struct({
  _tag: Schema.Literal("Installed"),
  effective: EffectiveModel,
  installation: ModelInstallation,
  updateState: CatalogModelUpdate,
})
export const CatalogModelState = Schema.Union(CatalogModelStateNotInstalled, CatalogModelStateInstalled)
export type CatalogModelState = typeof CatalogModelState.Type

export const CatalogModel = Schema.Struct({
  id: ModelIdSchema,
  desired: ReadyModel,
  displayName: Schema.String,
  variantLabel: Schema.String,
  description: Schema.String,
  releaseDate: ModelReleaseDate,
  license: Schema.String,
  sourceUrls: Schema.Array(Schema.String),
  parameterization: ModelParameterization,
  intelligence: CatalogIntelligence,
  fidelityRank: U32,
  quantizationAware: Schema.Boolean,
  localState: CatalogModelState,
})
export type CatalogModel = typeof CatalogModel.Type

export const CatalogModelsResponse = Schema.Struct({
  revision: Schema.BigIntFromSelf,
  reconciliationComplete: Schema.Boolean,
  models: Schema.Array(CatalogModel),
})
export type CatalogModelsResponse = typeof CatalogModelsResponse.Type

export const DiscoveredModelCatalogAttributionNotInCatalog = Schema.Struct({
  _tag: Schema.Literal("NotInCatalog"),
})
export const DiscoveredModelCatalogAttributionFailed = Schema.Struct({
  _tag: Schema.Literal("Failed"),
  failure: ModelFailure,
})
export const DiscoveredModelCatalogAttribution = Schema.Union(
  DiscoveredModelCatalogAttributionNotInCatalog,
  DiscoveredModelCatalogAttributionFailed
)
export type DiscoveredModelCatalogAttribution = typeof DiscoveredModelCatalogAttribution.Type

export const DiscoveredModelStateReady = Schema.Struct({
  _tag: Schema.Literal("Ready"),
  installation: ResolvedModelInstallation,
  model: ReadyModel,
  catalogAttribution: DiscoveredModelCatalogAttribution,
})

export const DiscoveredModelStateUnavailable = Schema.Struct({
  _tag: Schema.Literal("Unavailable"),
  installation: ResolvedModelInstallation,
  failure: ModelFailure,
})

export const DiscoveredModelState = Schema.Union(DiscoveredModelStateReady, DiscoveredModelStateUnavailable)
export type DiscoveredModelState = typeof DiscoveredModelState.Type

export const DiscoveredModel = Schema.Struct({
  id: ModelIdSchema,
  state: DiscoveredModelState,
})
export type DiscoveredModel = typeof DiscoveredModel.Type

export const DiscoveredModelsResponse = Schema.Struct({
  revision: Schema.BigIntFromSelf,
  reconciliationComplete: Schema.Boolean,
  models: Schema.Array(DiscoveredModel),
})
export type DiscoveredModelsResponse = typeof DiscoveredModelsResponse.Type

export const CatalogInstallationAdmissionCurrent = Schema.Struct({ _tag: Schema.Literal("Current") })
export const CatalogInstallationAdmissionAdmitted = Schema.Struct({
  _tag: Schema.Literal("Admitted"),
  operationId: CatalogInstallationOperationId,
})
export const CatalogInstallationAdmission = Schema.Union(
  CatalogInstallationAdmissionCurrent,
  CatalogInstallationAdmissionAdmitted
)
export type CatalogInstallationAdmission = typeof CatalogInstallationAdmission.Type

export const CatalogInstallationProgress = Schema.Struct({
  stage: DownloadStage,
  completedBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  totalBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  bytesPerSecond: optional(Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))),
})
export type CatalogInstallationProgress = typeof CatalogInstallationProgress.Type

export const CatalogInstallationOperationStatePending = Schema.Struct({
  _tag: Schema.Literal("Pending"),
  progress: CatalogInstallationProgress,
})
export const CatalogInstallationOperationStateRunning = Schema.Struct({
  _tag: Schema.Literal("Running"),
  progress: CatalogInstallationProgress,
})
export const CatalogInstallationOperationStateCompleted = Schema.Struct({ _tag: Schema.Literal("Completed") })
export const CatalogInstallationOperationStateFailed = Schema.Struct({
  _tag: Schema.Literal("Failed"),
  progress: CatalogInstallationProgress,
  failure: DownloadFailure,
  acknowledged: Schema.Boolean,
})
export const CatalogInstallationOperationStateCancelled = Schema.Struct({
  _tag: Schema.Literal("Cancelled"),
  progress: CatalogInstallationProgress,
})

export const CatalogInstallationOperationState = Schema.Union(
  CatalogInstallationOperationStatePending,
  CatalogInstallationOperationStateRunning,
  CatalogInstallationOperationStateCompleted,
  CatalogInstallationOperationStateFailed,
  CatalogInstallationOperationStateCancelled
)
export type CatalogInstallationOperationState = typeof CatalogInstallationOperationState.Type

export const CatalogInstallationOperation = Schema.Struct({
  operationId: CatalogInstallationOperationId,
  modelId: ModelIdSchema,
  state: CatalogInstallationOperationState,
})
export type CatalogInstallationOperation = typeof CatalogInstallationOperation.Type

export const CatalogInstallationsResponse = Schema.Struct({
  operations: Schema.Array(CatalogInstallationOperation),
})
export type CatalogInstallationsResponse = typeof CatalogInstallationsResponse.Type

export const CatalogInstallationRetentionReason = Schema.Literal("SharedMaterial", "ExternalOwnership")
export type CatalogInstallationRetentionReason = typeof CatalogInstallationRetentionReason.Type

export const CatalogInstallationRemovalRemoved = Schema.Struct({
  _tag: Schema.Literal("Removed"),
  reclaimedBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
})
export const CatalogInstallationRemovalRetained = Schema.Struct({
  _tag: Schema.Literal("Retained"),
  reason: CatalogInstallationRetentionReason,
})
export const CatalogInstallationRemoval = Schema.Union(
  CatalogInstallationRemovalRemoved,
  CatalogInstallationRemovalRetained
)
export type CatalogInstallationRemoval = typeof CatalogInstallationRemoval.Type

export const RecommendableModelCatalog = Schema.Struct({
  models: Schema.Array(RecommendableModel),
  diagnostics: Schema.Array(CatalogDiagnostic),
})
export type RecommendableModelCatalog = typeof RecommendableModelCatalog.Type

export const ModelPackageOperandInstalled = Schema.Struct({
  _tag: Schema.Literal("Installed"),
  packageId: ModelPackageId,
})
export const ModelPackageOperandSourceBacked = Schema.Struct({
  _tag: Schema.Literal("SourceBacked"),
  package: ModelPackage,
})
export const ModelPackageOperand = Schema.Union(ModelPackageOperandInstalled, ModelPackageOperandSourceBacked)
export type ModelPackageOperand = typeof ModelPackageOperand.Type

export const SpeculativeDraftSourceInputEmbedded = Schema.Struct({ _tag: Schema.Literal("Embedded") })
export const SpeculativeDraftSourceInputSeparate = Schema.Struct({
  _tag: Schema.Literal("Separate"),
  draft: ModelPackageOperand,
})
export const SpeculativeDraftSourceInput = Schema.Union(
  SpeculativeDraftSourceInputEmbedded,
  SpeculativeDraftSourceInputSeparate
)
export type SpeculativeDraftSourceInput = typeof SpeculativeDraftSourceInput.Type

export const ModelBundleInputStandalone = Schema.Struct({
  _tag: Schema.Literal("Standalone"),
  package: ModelPackageOperand,
})
export const ModelBundleInputSpeculativeDecoding = Schema.Struct({
  _tag: Schema.Literal("SpeculativeDecoding"),
  target: ModelPackageOperand,
  draftSource: SpeculativeDraftSourceInput,
  method: SpeculativeMethod,
})
export const ModelBundleInput = Schema.Union(ModelBundleInputStandalone, ModelBundleInputSpeculativeDecoding)
export type ModelBundleInput = typeof ModelBundleInput.Type

export const ModelAssessmentProfile = Schema.Struct({
  profile: ServingProfile,
  performanceContextTokens: Schema.Array(U32),
})
export type ModelAssessmentProfile = typeof ModelAssessmentProfile.Type

export const CatalogModelSelection = Schema.Literal("Desired", "Effective")
export type CatalogModelSelection = typeof CatalogModelSelection.Type

export const ModelAssessmentSubjectCatalog = Schema.Struct({
  _tag: Schema.Literal("Catalog"),
  modelId: ModelIdSchema,
  selection: CatalogModelSelection,
})
export const ModelAssessmentSubjectDiscovery = Schema.Struct({
  _tag: Schema.Literal("Discovery"),
  modelId: ModelIdSchema,
})
export const ModelAssessmentSubject = Schema.Union(
  ModelAssessmentSubjectCatalog,
  ModelAssessmentSubjectDiscovery
)
export type ModelAssessmentSubject = typeof ModelAssessmentSubject.Type

export const modelAssessmentSubjectModelId = (subject: ModelAssessmentSubject): ModelId => subject.modelId

export const MemoryAssessment = Schema.Struct({
  memoryDomainId: MemoryDomainId,
  capacityBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  requiredBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  compatibilityReserveBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  remainingBytes: Schema.Number.pipe(Schema.int()),
})
export type MemoryAssessment = typeof MemoryAssessment.Type

export const PerformanceConfidence = Schema.Literal("high", "moderate", "low")
export type PerformanceConfidence = typeof PerformanceConfidence.Type

export const PerformanceEvidence = Schema.Struct({
  contextTokens: U32,
  lowerTokensPerSecond: Schema.Number,
  estimatedTokensPerSecond: Schema.Number,
  upperTokensPerSecond: Schema.Number,
  confidence: PerformanceConfidence,
})
export type PerformanceEvidence = typeof PerformanceEvidence.Type

export const ModelAssessmentFits = Schema.Struct({
  _tag: Schema.Literal("Fits"),
  profile: ServingProfile,
  assessmentId: ModelAssessmentId,
  memory: Schema.Array(MemoryAssessment),
  performance: Schema.Array(PerformanceEvidence),
})

export const ModelAssessmentDoesNotFit = Schema.Struct({
  _tag: Schema.Literal("DoesNotFit"),
  profile: ServingProfile,
  assessmentId: ModelAssessmentId,
  memory: Schema.Array(MemoryAssessment),
  limitingResource: Schema.String,
  deficitBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
})

export const ModelAssessmentIncompatible = Schema.Struct({
  _tag: Schema.Literal("Incompatible"),
  profile: ServingProfile,
  failure: ModelFailure,
})

export const ModelAssessment = Schema.Union(
  ModelAssessmentFits,
  ModelAssessmentDoesNotFit,
  ModelAssessmentIncompatible
)
export type ModelAssessment = typeof ModelAssessment.Type

export const modelAssessmentIsValidFor = (assessment: ModelAssessment, topology: MemoryTopology): boolean => {
  if (assessment._tag === "Incompatible") return true
  const seen = new Set<MemoryDomainId>()
  for (const entry of assessment.memory) {
    const capacity = topology.capacity(entry.memoryDomainId)
    if (capacity === undefined) return false
    const remaining =
      BigInt(entry.capacityBytes) - BigInt(entry.compatibilityReserveBytes) - BigInt(entry.requiredBytes)
    const clamped = remaining < BigInt(Number.MIN_SAFE_INTEGER)
      ? Number.MIN_SAFE_INTEGER
      : remaining > BigInt(Number.MAX_SAFE_INTEGER)
        ? Number.MAX_SAFE_INTEGER
        : Number(remaining)
    if (seen.has(entry.memoryDomainId)) return false
    if (entry.capacityBytes !== Number(capacity) || entry.remainingBytes !== clamped) return false
    seen.add(entry.memoryDomainId)
  }
  return seen.has("system" as MemoryDomainId)
}

export const ModelAssessmentEntryStateAssessing = Schema.Struct({ _tag: Schema.Literal("Assessing") })
export const ModelAssessmentEntryStateAssessed = Schema.Struct({
  _tag: Schema.Literal("Assessed"),
  capabilities: ModelCapabilities,
  templateFingerprint: Schema.String,
  profiles: Schema.Array(ModelAssessment),
})
export const ModelAssessmentEntryStateDropped = Schema.Struct({ _tag: Schema.Literal("Dropped") })
export const ModelAssessmentEntryState = Schema.Union(
  ModelAssessmentEntryStateAssessing,
  ModelAssessmentEntryStateAssessed,
  ModelAssessmentEntryStateDropped
)
export type ModelAssessmentEntryState = typeof ModelAssessmentEntryState.Type

export const ModelAssessmentEntry = Schema.Struct({
  subject: ModelAssessmentSubject,
  state: ModelAssessmentEntryState,
})
export type ModelAssessmentEntry = typeof ModelAssessmentEntry.Type

export const ModelAssessmentDomainSnapshotPending = Schema.Struct({
  _tag: Schema.Literal("Pending"),
  sourceRevision: Schema.BigIntFromSelf,
})
export const ModelAssessmentDomainSnapshotAvailable = Schema.Struct({
  _tag: Schema.Literal("Available"),
  sourceRevision: Schema.BigIntFromSelf,
  entries: Schema.Array(ModelAssessmentEntry),
})
export const ModelAssessmentDomainSnapshotFailed = Schema.Struct({
  _tag: Schema.Literal("Failed"),
  sourceRevision: Schema.BigIntFromSelf,
  failure: ModelFailure,
})
export const ModelAssessmentDomainSnapshot = Schema.Union(
  ModelAssessmentDomainSnapshotPending,
  ModelAssessmentDomainSnapshotAvailable,
  ModelAssessmentDomainSnapshotFailed
)
export type ModelAssessmentDomainSnapshot = typeof ModelAssessmentDomainSnapshot.Type

export const ModelAssessmentPoolStatePreparing = Schema.Struct({ _tag: Schema.Literal("Preparing") })
export const ModelAssessmentPoolStateReady = Schema.Struct({
  _tag: Schema.Literal("Ready"),
  environmentId: AssessmentEnvironmentId,
  catalog: ModelAssessmentDomainSnapshot,
  discovered: ModelAssessmentDomainSnapshot,
})
export const ModelAssessmentPoolStateFailed = Schema.Struct({
  _tag: Schema.Literal("Failed"),
  failure: ModelFailure,
})
export const ModelAssessmentPoolState = Schema.Union(
  ModelAssessmentPoolStatePreparing,
  ModelAssessmentPoolStateReady,
  ModelAssessmentPoolStateFailed
)
export type ModelAssessmentPoolState = typeof ModelAssessmentPoolState.Type

export const ModelAssessmentsSnapshot = Schema.Struct({
  revision: Schema.BigIntFromSelf,
  state: ModelAssessmentPoolState,
})
export type ModelAssessmentsSnapshot = typeof ModelAssessmentsSnapshot.Type

export interface ModelAssessmentsInvalidation {
  readonly revision: bigint
}

export const StartModelDownloadRequest = Schema.Struct({
  bundle: ServableModelBundle,
})
export type StartModelDownloadRequest = typeof StartModelDownloadRequest.Type

export const ModelDownloadStatePending = Schema.Struct({
  _tag: Schema.Literal("Pending"),
  completedBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  totalBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
})
export const ModelDownloadStateDownloading = Schema.Struct({
  _tag: Schema.Literal("Downloading"),
  stage: DownloadStage,
  completedBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  totalBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  bytesPerSecond: optional(Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))),
})
export const ModelDownloadStateCompleted = Schema.Struct({ _tag: Schema.Literal("Completed") })
export const ModelDownloadStateFailed = Schema.Struct({
  _tag: Schema.Literal("Failed"),
  completedBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  totalBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  failure: DownloadFailure,
  acknowledged: Schema.Boolean,
})
export const ModelDownloadStateCancelled = Schema.Struct({
  _tag: Schema.Literal("Cancelled"),
  completedBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  totalBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
})

export const ModelDownloadState = Schema.Union(
  ModelDownloadStatePending,
  ModelDownloadStateDownloading,
  ModelDownloadStateCompleted,
  ModelDownloadStateFailed,
  ModelDownloadStateCancelled
)
export type ModelDownloadState = typeof ModelDownloadState.Type

export const ModelDownload = Schema.Struct({
  id: ModelDownloadId,
  bundle: ServableModelBundle,
  state: ModelDownloadState,
})
export type ModelDownload = typeof ModelDownload.Type

export const StartModelDownloadResponse = Schema.Struct({
  download: optional(ModelDownload),
})
export type StartModelDownloadResponse = typeof StartModelDownloadResponse.Type

export const ModelDownloadsResponse = Schema.Struct({
  downloads: Schema.Array(ModelDownload),
})
export type ModelDownloadsResponse = typeof ModelDownloadsResponse.Type

export class ResolvedServableModelBundle {
  constructor(
    readonly bundle: ServableModelBundle,
    readonly targetModel: ResolvedModel,
    readonly draftModel: ResolvedModel | null,
    private readonly resolutionGuards: readonly unknown[] = []
  ) {}

  static new(
    bundle: ServableModelBundle,
    targetModel: ResolvedModel,
    draftModel: ResolvedModel | null
  ): ResolvedServableModelBundle {
    return new ResolvedServableModelBundle(bundle, targetModel, draftModel)
  }

  retainResolutionGuard(guard: unknown): ResolvedServableModelBundle {
    return new ResolvedServableModelBundle(
      this.bundle,
      this.targetModel,
      this.draftModel,
      [...this.resolutionGuards, guard]
    )
  }
}

export interface ModelDomainInvalidation {
  readonly revision: bigint
}

export interface ModelDownloadsInvalidation {
  readonly revision: bigint
}

export interface InstalledModelPackages {
  listInstalled(): Promise<InstalledModelPackagesResponse | import("../inventory.js").InventoryError>
  resolveBundle(bundle: ModelBundleInput): Promise<ResolvedServableModelBundle | import("../inventory.js").InventoryError>
  removeInstalled(packageId: ModelPackageId): Promise<RemoveInstalledModelPackageResponse | import("../inventory.js").InventoryError>
}

export interface RecommendableModelCatalogProvider {
  catalog(): Promise<RecommendableModelCatalog | import("../inventory.js").InventoryError>
}

export interface CatalogModels {
  listCatalog(): Promise<CatalogModelsResponse | import("../inventory.js").InventoryError>
  installCatalogModel(modelId: ModelId): Promise<CatalogInstallationAdmission | import("../inventory.js").InventoryError>
  removeCatalogModelInstallation(modelId: ModelId): Promise<CatalogInstallationRemoval | import("../inventory.js").InventoryError>
  watchCatalog(): AsyncIterable<ModelDomainInvalidation>
}

export interface DiscoveredModels {
  listDiscovered(): Promise<DiscoveredModelsResponse | import("../inventory.js").InventoryError>
  refreshDiscovery(): Promise<DiscoveredModelsResponse | import("../inventory.js").InventoryError>
  watchDiscovery(): AsyncIterable<ModelDomainInvalidation>
}

export interface CatalogInstallations {
  listCatalogInstallations(): Promise<CatalogInstallationsResponse | import("../inventory.js").InventoryError>
  cancelCatalogInstallation(
    id: CatalogInstallationOperationId
  ): Promise<CatalogInstallationOperation | import("../inventory.js").InventoryError>
  acknowledgeCatalogInstallationFailure(
    id: CatalogInstallationOperationId
  ): Promise<CatalogInstallationOperation | import("../inventory.js").InventoryError>
}

export interface CatalogPackageRemover {
  removeCatalogPackages(packageIds: readonly ModelPackageId[]): Promise<number | import("../inventory.js").InventoryError>
}

export interface ModelAssessments {
  snapshot(): Promise<ModelAssessmentsSnapshot | import("../inventory.js").InventoryError>
  watch(): AsyncIterable<ModelAssessmentsInvalidation>
}

export interface ModelDownloads {
  start(request: StartModelDownloadRequest): Promise<StartModelDownloadResponse | import("../inventory.js").InventoryError>
  list(): Promise<ModelDownloadsResponse | import("../inventory.js").InventoryError>
  cancel(id: ModelDownloadId): Promise<ModelDownload | import("../inventory.js").InventoryError>
  acknowledgeFailure(id: ModelDownloadId): Promise<ModelDownload | import("../inventory.js").InventoryError>
  watch(): AsyncIterable<ModelDownloadsInvalidation>
}
