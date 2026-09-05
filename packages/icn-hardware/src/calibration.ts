import { Schema } from "effect"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { Option } from "effect"
import type { HardwareSnapshot } from "@magnitudedev/icn-contracts"
import { normalizedBackendName, probeCuda, probeMetal, probeVulkan } from "./probes.js"

/** Must match the pinned llama.cpp native calibration schema identity. */
export const FIT_CALIBRATION_METHOD = "llama.cpp-fit-calibration-v1"

export const HARDWARE_CALIBRATION_CACHE_METHOD = "icn-hardware-calibration-cache-v1"

export const HARDWARE_CALIBRATION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

export const HardwareCalibrationMetric = Schema.Struct({
  backend_type: Schema.Number.pipe(Schema.int()),
  backend: Schema.String,
  device_id: Schema.optional(Schema.String),
  tensor_type: Schema.Number.pipe(Schema.int()),
  routed: Schema.Boolean,
  bytes_per_second: Schema.Number,
  launch_microseconds: Schema.Number,
  relative_spread: Schema.Number,
  sample_count: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)),
  measured_microseconds: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)),
  stable: Schema.Boolean,
})
export type HardwareCalibrationMetric = typeof HardwareCalibrationMetric.Type

export const HardwareCalibration = Schema.Struct({
  method: Schema.String,
  metrics: Schema.Array(HardwareCalibrationMetric),
  elapsed_microseconds: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)),
})
export type HardwareCalibration = typeof HardwareCalibration.Type

export const HardwareCalibrationRecord = Schema.Struct({
  input_identity: Schema.String,
  measured_at_seconds: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  hardware_calibration: HardwareCalibration,
  hardware_calibration_identity: Schema.String,
})
export type HardwareCalibrationRecord = typeof HardwareCalibrationRecord.Type

export type CalibrationValidationFailure =
  | { readonly code: "unsupported_calibration_schema"; readonly message: string }
  | { readonly code: "invalid_calibration"; readonly message: string }

const metricIdentity = (metric: HardwareCalibrationMetric): string =>
  JSON.stringify([
    metric.backend_type,
    metric.backend,
    metric.device_id ?? null,
    metric.tensor_type,
    metric.routed,
  ])

export const validateCalibration = (
  calibration: HardwareCalibration,
): CalibrationValidationFailure | null => {
  if (calibration.method !== FIT_CALIBRATION_METHOD) {
    return {
      code: "unsupported_calibration_schema",
      message: "native calibration schema is not supported",
    }
  }
  if (calibration.metrics.length === 0) {
    return {
      code: "invalid_calibration",
      message: "native calibration contains no metrics",
    }
  }
  const identities = new Set<string>()
  for (const metric of calibration.metrics) {
    if (
      metric.backend.trim().length === 0 ||
      (metric.device_id !== undefined && metric.device_id.trim().length === 0) ||
      !Number.isFinite(metric.bytes_per_second) ||
      metric.bytes_per_second <= 0 ||
      !Number.isFinite(metric.launch_microseconds) ||
      metric.launch_microseconds < 0 ||
      !Number.isFinite(metric.relative_spread) ||
      metric.relative_spread < 0
    ) {
      return {
        code: "invalid_calibration",
        message: "native calibration contains an invalid identity or numeric value",
      }
    }
    const identity = metricIdentity(metric)
    if (identities.has(identity)) {
      return {
        code: "invalid_calibration",
        message: "native calibration contains duplicate operation metrics",
      }
    }
    identities.add(identity)
  }
  return null
}

export const hardwareCalibrationIsValid = (calibration: HardwareCalibration): boolean =>
  validateCalibration(calibration) === null

const coversBackendDevice = (
  calibration: HardwareCalibration,
  backend: string,
  deviceId: string | null,
): boolean =>
  [false, true].every((routed) =>
    calibration.metrics.some(
      (metric) =>
        normalizedBackendName(metric.backend) === backend &&
        (metric.device_id ?? null) === deviceId &&
        metric.routed === routed,
    ),
  )

export const hardwareCalibrationCoversSnapshot = (
  calibration: HardwareCalibration,
  snapshot: HardwareSnapshot,
): boolean =>
  snapshot.enabled_backends.every((backend) => {
    const normalized = normalizedBackendName(backend)
    const devices = snapshot.memory_domains
      .flatMap((domain) => domain.devices)
      .filter((device) => normalizedBackendName(device.backend) === normalized)
    if (devices.length === 0) {
      return coversBackendDevice(calibration, normalized, null)
    }
    return devices.every((device) =>
      coversBackendDevice(
        calibration,
        normalized,
        Option.getOrNull(device.physical_id),
      ),
    )
  })

export interface HardwareCalibrationInputIdentity {
  readonly cacheMethod: string
  readonly calibrationMethod: string
  readonly backendModuleAbi: string
  readonly snapshot: HardwareSnapshot
  readonly backendRuntime?: readonly [
    ReturnType<typeof probeCuda> | null,
    ReturnType<typeof probeVulkan> | null,
    ReturnType<typeof probeMetal> | null,
  ]
}

const stableSerialize = (value: unknown): string =>
  JSON.stringify(value, (_key, current) =>
    typeof current === "bigint" ? current.toString() : current,
  )

export const hardwareCalibrationInputIdentity = (
  input: HardwareCalibrationInputIdentity,
): string => {
  const enabledBackends = new Set(input.snapshot.enabled_backends.map(normalizedBackendName))
  const backendRuntime =
    input.backendRuntime ??
    ([
      enabledBackends.has("cuda") ? probeCuda() : null,
      enabledBackends.has("vulkan") ? probeVulkan() : null,
      enabledBackends.has("metal") ? probeMetal() : null,
    ] as const)
  const material = stableSerialize([
    input.cacheMethod,
    input.calibrationMethod,
    input.backendModuleAbi,
    input.snapshot.native_build,
    input.snapshot.enabled_backends,
    input.snapshot.platform,
    input.snapshot.architecture,
    Option.getOrNull(input.snapshot.system_product_name),
    Option.getOrNull(input.snapshot.cpu_model),
    input.snapshot.logical_cores,
    input.snapshot.topology_fingerprint,
    backendRuntime,
  ])
  const digest = bytesToHex(sha256(new TextEncoder().encode(material)))
  return `hardware_calibration_input_${digest}`
}

export const fixtureCpuHardwareCalibration = (): HardwareCalibration => ({
  method: FIT_CALIBRATION_METHOD,
  metrics: [false, true].map((routed) => ({
    backend_type: 0,
    backend: "CPU",
    tensor_type: 0,
    routed,
    bytes_per_second: 1_000_000_000,
    launch_microseconds: 1,
    relative_spread: 0,
    sample_count: 1,
    measured_microseconds: 1,
    stable: true,
  })),
  elapsed_microseconds: 1,
})
