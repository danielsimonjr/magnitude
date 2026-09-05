import { Option } from "effect"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import {
  hardwareDeviceId,
  memoryDomainId,
  memoryDomainIdIsSystem,
  systemMemoryDomainId,
  type HardwareDevice,
  type HardwareDeviceKind,
  type HardwareMemoryDomain,
  type HardwareMemoryDomainKind,
  type HardwareSnapshot,
  type HardwareSystemMemory,
  type MemoryDomainId,
} from "@magnitudedev/icn-contracts"
import { NativeDeviceIdentity } from "@magnitudedev/icn-contracts"
import {
  defaultCapacityPolicy,
  reserveForDomain,
  type CapacityPolicy,
} from "./capacity.js"
import { cpus, freemem, totalmem } from "node:os"
import {
  normalizeSystemMemory,
  systemMemoryThresholds,
  type SystemMemoryObservation,
} from "./memory.js"

export interface DiscoveredDevice {
  readonly nativeIndex: number
  readonly backend: string
  readonly physicalId: string | null
  readonly name: string
  readonly description: string
  readonly kind: HardwareDeviceKind
  readonly totalBytes: bigint
  readonly freeBytes: bigint | null
}

export interface HardwareEnvironment {
  readonly nativeBuild: string
  readonly enabledBackends: readonly string[]
  readonly platform: string
  readonly architecture: string
  readonly systemProductName: string | null
  readonly logicalCores: number
  readonly systemMemory: HardwareSystemMemory
}

const saturatingSubtract = (left: bigint, right: bigint): bigint =>
  left > right ? left - right : 0n

const deviceOrder = (left: DiscoveredDevice, right: DiscoveredDevice): number => {
  const leftPhysical = left.physicalId ?? ""
  const rightPhysical = right.physicalId ?? ""
  const physical = leftPhysical.localeCompare(rightPhysical)
  if (physical !== 0) return physical
  const backend = left.backend.toLowerCase().localeCompare(right.backend.toLowerCase())
  if (backend !== 0) return backend
  if (left.nativeIndex !== right.nativeIndex) return left.nativeIndex - right.nativeIndex
  return left.name.toLowerCase().localeCompare(right.name.toLowerCase())
}

const dedicatedPhysicalKey = (identity: NativeDeviceIdentity): string =>
  identity.physicalId !== null
    ? `physical:${identity.physicalId}`
    : `backend:${identity.backend}:${identity.nativeIndex}`

const dedicatedMemoryDomainId = (physicalKey: string, ordinal: number): MemoryDomainId => {
  const identity = `${physicalKey}\0${ordinal}`
  const digest = bytesToHex(sha256(new TextEncoder().encode(identity)))
  return memoryDomainId(`device-${digest}`)
}

const nativeDeviceId = (identity: NativeDeviceIdentity): HardwareDevice["id"] => {
  const material = `${identity.backend}\0${identity.physicalId ?? ""}\0${identity.nativeIndex}`
  const digest = bytesToHex(sha256(new TextEncoder().encode(material)))
  return hardwareDeviceId(`native-${digest}`)
}

const publicDevice = (
  device: DiscoveredDevice,
  appleUnified: boolean,
  policy: CapacityPolicy,
): HardwareDevice => {
  const identity = NativeDeviceIdentity.new(device.backend, device.physicalId, device.nativeIndex)
  return {
    id: nativeDeviceId(identity),
    native_index: device.nativeIndex,
    backend: device.backend,
    physical_id: device.physicalId === null ? Option.none() : Option.some(device.physicalId),
    name: device.name,
    description: device.description,
    kind: device.kind,
    memory_limit:
      appleUnified && device.kind !== "cpu" && device.totalBytes > 0n
        ? Option.some({
            kind: "recommended_working_set" as const,
            total_bytes: device.totalBytes,
            stable_bytes: saturatingSubtract(
              device.totalBytes,
              BigInt(reserveForDomain(policy, systemMemoryDomainId())),
            ),
            current_free_bytes:
              device.freeBytes === null ? Option.none() : Option.some(device.freeBytes),
          })
        : Option.none(),
  }
}

const topologyFingerprintMaterial = (domains: readonly HardwareMemoryDomain[]) =>
  domains.map((domain) => ({
    id: domain.id,
    kind: domain.kind,
    total_capacity_bytes: domain.total_capacity_bytes,
    stable_capacity_bytes: domain.stable_capacity_bytes,
    shares_system_memory: domain.shares_system_memory,
    devices: domain.devices.map((device) => ({
      id: device.id,
      native_index: device.native_index,
      backend: device.backend,
      physical_id: Option.getOrNull(device.physical_id),
      kind: device.kind,
      memory_limit:
        device.memory_limit === undefined
          ? null
          : Option.match(device.memory_limit, {
              onNone: () => null,
              onSome: (limit) => ({
                kind: limit.kind,
                total_bytes: limit.total_bytes,
                stable_bytes: limit.stable_bytes,
              }),
            }),
    })),
  }))

const stableSerialize = (value: unknown): string =>
  JSON.stringify(value, (_key, current) =>
    typeof current === "bigint" ? current.toString() : current,
  )

export const topologyFingerprint = (domains: readonly HardwareMemoryDomain[]): string => {
  const material = stableSerialize(topologyFingerprintMaterial(domains))
  return bytesToHex(sha256(new TextEncoder().encode(material)))
}

export const hardwareSnapshotFromDevices = (
  devices: readonly DiscoveredDevice[],
  policy: CapacityPolicy,
  environment: HardwareEnvironment,
): HardwareSnapshot => {
  const unifiedPlatform =
    environment.platform === "darwin" && environment.architecture === "arm64"
  const shared: DiscoveredDevice[] = []
  const dedicated = new Map<string, Map<string, DiscoveredDevice[]>>()

  for (const device of devices) {
    if (
      unifiedPlatform ||
      device.kind === "cpu" ||
      device.kind === "integrated_gpu" ||
      device.kind === "accelerator"
    ) {
      shared.push(device)
    } else {
      const identity = NativeDeviceIdentity.new(
        device.backend,
        device.physicalId,
        device.nativeIndex,
      )
      const physicalKey = dedicatedPhysicalKey(identity)
      const backends = dedicated.get(physicalKey) ?? new Map<string, DiscoveredDevice[]>()
      const views = backends.get(identity.backend) ?? []
      views.push(device)
      backends.set(identity.backend, views)
      dedicated.set(physicalKey, backends)
    }
  }

  shared.sort(deviceOrder)
  for (const backends of dedicated.values()) {
    for (const views of backends.values()) {
      views.sort(deviceOrder)
    }
  }

  const domains: HardwareMemoryDomain[] = []
  if (shared.length > 0 || environment.systemMemory.physical_capacity_bytes > 0n) {
    const backendTotal = shared.reduce(
      (max, device) => (device.totalBytes > max ? device.totalBytes : max),
      0n,
    )
    const total =
      environment.systemMemory.physical_capacity_bytes > 0n
        ? environment.systemMemory.physical_capacity_bytes
        : backendTotal
    const unified =
      unifiedPlatform || shared.some((device) => device.kind === "integrated_gpu")
    const kind: HardwareMemoryDomainKind = unified ? "unified_memory" : "system"
    domains.push({
      id: systemMemoryDomainId(),
      kind,
      total_capacity_bytes: total,
      stable_capacity_bytes: saturatingSubtract(
        total,
        BigInt(reserveForDomain(policy, systemMemoryDomainId())),
      ),
      current_free_bytes: Option.some(environment.systemMemory.physical_available_bytes),
      shares_system_memory: true,
      devices: shared.map((device) => publicDevice(device, unifiedPlatform, policy)),
    })
  }

  for (const [physicalKey, backends] of dedicated) {
    const occurrences = Math.max(...[...backends.values()].map((views) => views.length), 0)
    for (let ordinal = 0; ordinal < occurrences; ordinal += 1) {
      const views = [...backends.values()]
        .map((devicesForBackend) => devicesForBackend[ordinal])
        .filter((device): device is DiscoveredDevice => device !== undefined)
      const total = views.reduce(
        (max, device) => (device.totalBytes > max ? device.totalBytes : max),
        0n,
      )
      if (total === 0n) continue
      const free = views.reduce<bigint | null>((max, device) => {
        if (device.freeBytes === null) return max
        if (max === null || device.freeBytes > max) return device.freeBytes
        return max
      }, null)
      domains.push({
        id: dedicatedMemoryDomainId(physicalKey, ordinal),
        kind: "physical_device",
        total_capacity_bytes: total,
        stable_capacity_bytes: saturatingSubtract(
          total,
          BigInt(policy.reserveBytesPerDomain),
        ),
        current_free_bytes: free === null ? Option.none() : Option.some(free),
        shares_system_memory: false,
        devices: views.map((device) => publicDevice(device, false, policy)),
      })
    }
  }

  const enabledBackends = [...new Set(environment.enabledBackends)].sort()
  const cpuModel = domains
    .flatMap((domain) => domain.devices)
    .find((device) => device.kind === "cpu")?.description

  return {
    captured_at: BigInt(Math.floor(Date.now() / 1000)),
    platform: environment.platform,
    architecture: environment.architecture,
    system_product_name:
      environment.systemProductName === null
        ? Option.none()
        : Option.some(environment.systemProductName),
    cpu_model: cpuModel === undefined ? Option.none() : Option.some(cpuModel),
    logical_cores: environment.logicalCores,
    system_memory: environment.systemMemory,
    native_build: environment.nativeBuild,
    enabled_backends: enabledBackends,
    topology_fingerprint: topologyFingerprint(domains),
    memory_domains: domains,
  }
}

export const withCapacityPolicy = (
  snapshot: HardwareSnapshot,
  policy: CapacityPolicy,
): HardwareSnapshot => {
  const memoryDomains = snapshot.memory_domains.map((domain) => ({
    ...domain,
    stable_capacity_bytes: saturatingSubtract(
      domain.total_capacity_bytes,
      BigInt(reserveForDomain(policy, domain.id)),
    ),
    devices: domain.devices.map((device) => {
      if (Option.isNone(device.memory_limit)) {
        return device
      }
      const limit = Option.getOrThrow(device.memory_limit)
      return {
        ...device,
        memory_limit: Option.some({
          ...limit,
          stable_bytes: saturatingSubtract(
            limit.total_bytes,
            BigInt(reserveForDomain(policy, domain.id)),
          ),
        }),
      }
    }),
  }))
  return {
    ...snapshot,
    memory_domains: memoryDomains,
    topology_fingerprint: topologyFingerprint(memoryDomains),
  }
}

export const withSystemMemoryObservation = (
  snapshot: HardwareSnapshot,
  observation: SystemMemoryObservation,
): HardwareSnapshot => {
  const thresholds = systemMemoryThresholds(observation.physicalCapacityBytes)
  const systemMemory: HardwareSystemMemory = {
    physical_capacity_bytes: BigInt(observation.physicalCapacityBytes),
    physical_available_bytes: BigInt(observation.physicalAvailableBytes),
    allocation_capacity_bytes: BigInt(observation.allocationCapacityBytes),
    allocation_headroom_bytes: BigInt(observation.allocationHeadroomBytes),
    assess_reserve_bytes: BigInt(thresholds.assessReserveBytes),
    abort_reserve_bytes: BigInt(thresholds.abortReserveBytes),
  }
  const memoryDomains = snapshot.memory_domains.map((domain) => {
    if (!memoryDomainIdIsSystem(domain.id)) return domain
    return {
      ...domain,
      total_capacity_bytes: BigInt(observation.physicalCapacityBytes),
      stable_capacity_bytes: saturatingSubtract(
        BigInt(observation.physicalCapacityBytes),
        BigInt(thresholds.assessReserveBytes),
      ),
      current_free_bytes: Option.some(BigInt(observation.physicalAvailableBytes)),
    }
  })
  return {
    ...snapshot,
    system_memory: systemMemory,
    memory_domains: memoryDomains,
    topology_fingerprint: topologyFingerprint(memoryDomains),
  }
}

export interface CpuHardwareSnapshotInput {
  readonly nativeBuild: string
  readonly enabledBackends?: readonly string[]
  readonly platform?: string
  readonly architecture?: string
  readonly systemProductName?: string | null
  readonly logicalCores?: number
  readonly cpuName?: string
  readonly cpuDescription?: string
  readonly policy?: CapacityPolicy
  readonly observation?: SystemMemoryObservation
}

export const buildCpuHardwareSnapshot = (input: CpuHardwareSnapshotInput): HardwareSnapshot => {
  const observation =
    input.observation ?? normalizeSystemMemory(totalmem(), freemem())
  const thresholds = systemMemoryThresholds(observation.physicalCapacityBytes)
  const policy = input.policy ?? defaultCapacityPolicy()
  const environment: HardwareEnvironment = {
    nativeBuild: input.nativeBuild,
    enabledBackends: input.enabledBackends ?? ["cpu"],
    platform: input.platform ?? process.platform,
    architecture: input.architecture ?? process.arch,
    systemProductName: input.systemProductName ?? null,
    logicalCores: input.logicalCores ?? cpus().length,
    systemMemory: {
      physical_capacity_bytes: BigInt(observation.physicalCapacityBytes),
      physical_available_bytes: BigInt(observation.physicalAvailableBytes),
      allocation_capacity_bytes: BigInt(observation.allocationCapacityBytes),
      allocation_headroom_bytes: BigInt(observation.allocationHeadroomBytes),
      assess_reserve_bytes: BigInt(thresholds.assessReserveBytes),
      abort_reserve_bytes: BigInt(thresholds.abortReserveBytes),
    },
  }
  const cpuName = input.cpuName ?? "CPU"
  const cpuDescription = input.cpuDescription ?? cpuName
  const devices: DiscoveredDevice[] = [
    {
      nativeIndex: 0,
      backend: "cpu",
      physicalId: null,
      name: cpuName,
      description: cpuDescription,
      kind: "cpu",
      totalBytes: BigInt(observation.physicalCapacityBytes),
      freeBytes: BigInt(observation.physicalAvailableBytes),
    },
  ]
  return hardwareSnapshotFromDevices(devices, policy, environment)
}
