import { Schema } from "effect"
import { optional, PositiveInt } from "../schema/common.js"

export const CudaEligibilityUsable = Schema.Struct({
  state: Schema.Literal("usable"),
  driverApi: Schema.Number.pipe(Schema.int()),
  architectures: Schema.Array(Schema.String),
  driverLibrary: Schema.String,
})

export const CudaEligibilityAbsent = Schema.Struct({
  state: Schema.Literal("absent"),
  diagnostic: Schema.String,
})

export const CudaEligibilityFailed = Schema.Struct({
  state: Schema.Literal("failed"),
  diagnostic: Schema.String,
})

export const CudaEligibility = Schema.Union(
  CudaEligibilityUsable,
  CudaEligibilityAbsent,
  CudaEligibilityFailed
)
export type CudaEligibility = typeof CudaEligibility.Type

export const VulkanEligibilityUsable = Schema.Struct({
  state: Schema.Literal("usable"),
  loaderApi: Schema.Number.pipe(Schema.int()),
})

export const VulkanEligibilityAbsent = Schema.Struct({
  state: Schema.Literal("absent"),
  diagnostic: Schema.String,
})

export const VulkanEligibilityFailed = Schema.Struct({
  state: Schema.Literal("failed"),
  diagnostic: Schema.String,
})

export const VulkanEligibility = Schema.Union(
  VulkanEligibilityUsable,
  VulkanEligibilityAbsent,
  VulkanEligibilityFailed
)
export type VulkanEligibility = typeof VulkanEligibility.Type

export const MetalEligibilityUsable = Schema.Struct({
  state: Schema.Literal("usable"),
})

export const MetalEligibilityAbsent = Schema.Struct({
  state: Schema.Literal("absent"),
  diagnostic: Schema.String,
})

export const MetalEligibility = Schema.Union(MetalEligibilityUsable, MetalEligibilityAbsent)
export type MetalEligibility = typeof MetalEligibility.Type

export const BackendEligibilityReport = Schema.Struct({
  schemaVersion: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1), Schema.lessThanOrEqualTo(1)),
  cuda: CudaEligibility,
  vulkan: VulkanEligibility,
  metal: MetalEligibility,
})
export type BackendEligibilityReport = typeof BackendEligibilityReport.Type

export const IcnBinaryIdentity = Schema.Struct({
  version: Schema.String.pipe(Schema.minLength(1)),
  apiVersion: PositiveInt,
  nativeBuild: Schema.String.pipe(Schema.minLength(1)),
  backendModuleAbi: Schema.String.pipe(Schema.minLength(1)),
  capabilities: Schema.Array(Schema.String.pipe(Schema.minLength(1))),
  target: Schema.String.pipe(Schema.minLength(1)),
  profile: Schema.String.pipe(Schema.minLength(1)),
  rustc: Schema.String.pipe(Schema.minLength(1)),
  backends: Schema.Array(Schema.String.pipe(Schema.minLength(1))),
})
export type IcnBinaryIdentity = typeof IcnBinaryIdentity.Type

export const IcnStartupRecordType = Schema.Literal("icn_ready")
export type IcnStartupRecordType = typeof IcnStartupRecordType.Type

export const IcnStartupRecord = Schema.Struct({
  type: IcnStartupRecordType,
  protocolVersion: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1), Schema.lessThanOrEqualTo(1)),
  origin: Schema.String.pipe(Schema.minLength(1)),
  instanceId: Schema.String.pipe(Schema.minLength(1)),
  pid: PositiveInt,
  apiVersion: PositiveInt,
  nativeBuild: Schema.String.pipe(Schema.minLength(1)),
})
export type IcnStartupRecord = typeof IcnStartupRecord.Type

export const IcnStartupProgressRecordType = Schema.Literal("preparing_backend")
export type IcnStartupProgressRecordType = typeof IcnStartupProgressRecordType.Type

export const IcnStartupBackendCpu = Schema.Struct({
  type: Schema.Literal("cpu"),
  hardwareLabel: Schema.String,
})

export const IcnStartupBackendMetal = Schema.Struct({
  type: Schema.Literal("metal"),
  hardwareLabel: Schema.String,
})

export const IcnStartupBackendCuda = Schema.Struct({
  type: Schema.Literal("cuda"),
  hardwareLabel: Schema.String,
})

export const IcnStartupBackendVulkan = Schema.Struct({
  type: Schema.Literal("vulkan"),
  hardwareLabel: Schema.String,
})

export const IcnStartupBackend = Schema.Union(
  IcnStartupBackendCpu,
  IcnStartupBackendMetal,
  IcnStartupBackendCuda,
  IcnStartupBackendVulkan
)
export type IcnStartupBackend = typeof IcnStartupBackend.Type

export const IcnStartupProgressRecord = Schema.Struct({
  type: IcnStartupProgressRecordType,
  backend: IcnStartupBackend,
})
export type IcnStartupProgressRecord = typeof IcnStartupProgressRecord.Type

export const IcnInstallationBackend = Schema.Literal("cpu", "metal", "cuda", "vulkan")
export type IcnInstallationBackend = typeof IcnInstallationBackend.Type

export const installationBackendName = (backend: IcnInstallationBackend): string => backend

export const IcnInstallationDeclaration = Schema.Struct({
  schemaVersion: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1), Schema.lessThanOrEqualTo(1)),
  backend: IcnInstallationBackend,
  nativeBuild: Schema.String.pipe(Schema.minLength(1)),
  backendModuleAbi: Schema.String.pipe(Schema.minLength(1)),
})
export type IcnInstallationDeclaration = typeof IcnInstallationDeclaration.Type
