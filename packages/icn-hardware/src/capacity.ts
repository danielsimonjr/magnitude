import {
  memoryBreakdownTotalBytes,
  memoryDomainIdAsStr,
  systemMemoryDomainId,
  type HardwareDeviceMemoryAssessment,
  type HardwareMemoryDomainAssessment,
  type MemoryAccounting,
  type MemoryBreakdown,
  type MemoryDomainId,
} from "@magnitudedev/icn-contracts"

const DOMAIN_RESERVE_BYTES = 1536 * 1024 * 1024

export interface CapacityPolicy {
  readonly reserveBytesPerDomain: number
  readonly systemReserveBytes?: number
}

export const defaultCapacityPolicy = (): CapacityPolicy => ({
  reserveBytesPerDomain: DOMAIN_RESERVE_BYTES,
})

export const reserveForDomain = (policy: CapacityPolicy, domain: MemoryDomainId): number =>
  domain === "system"
    ? policy.systemReserveBytes ?? policy.reserveBytesPerDomain
    : policy.reserveBytesPerDomain

export interface CapacitySummary {
  readonly fits: boolean
  readonly requiredBytes: bigint
  readonly usableCapacityBytes: bigint
  readonly deficitBytes: bigint
  readonly limitingResource: string | MemoryDomainId
  readonly device: string
  readonly domains: readonly HardwareMemoryDomainAssessment[]
  readonly deviceConstraints: readonly HardwareDeviceMemoryAssessment[]
}

const clampMarginBytes = (usable: bigint, required: bigint): bigint => {
  const margin = usable - required
  const min = -(2n ** 63n)
  const max = 2n ** 63n - 1n
  if (margin < min) return min
  if (margin > max) return max
  return margin
}

const domainAssessment = (
  memoryDomain: MemoryDomainId,
  breakdown: MemoryBreakdown,
  usableCapacityBytes: bigint,
): HardwareMemoryDomainAssessment => {
  const requiredBytes = memoryBreakdownTotalBytes(breakdown)
  return {
    memory_domain: memoryDomain,
    model_bytes: breakdown.model_bytes,
    context_bytes: breakdown.context_bytes,
    compute_bytes: breakdown.compute_bytes,
    auxiliary_bytes: breakdown.auxiliary_bytes,
    required_bytes: requiredBytes,
    usable_capacity_bytes: usableCapacityBytes,
    margin_bytes: clampMarginBytes(usableCapacityBytes, requiredBytes),
  }
}

const deviceAssessment = (
  deviceId: HardwareDeviceMemoryAssessment["device_id"],
  device: string,
  breakdown: MemoryBreakdown,
  usableCapacityBytes: bigint,
): HardwareDeviceMemoryAssessment => {
  const requiredBytes = memoryBreakdownTotalBytes(breakdown)
  return {
    device_id: deviceId,
    device,
    kind: "recommended_working_set",
    model_bytes: breakdown.model_bytes,
    context_bytes: breakdown.context_bytes,
    compute_bytes: breakdown.compute_bytes,
    auxiliary_bytes: breakdown.auxiliary_bytes,
    required_bytes: requiredBytes,
    usable_capacity_bytes: usableCapacityBytes,
    margin_bytes: clampMarginBytes(usableCapacityBytes, requiredBytes),
  }
}

export const capacitySummaryFromAccounting = (accounting: MemoryAccounting): CapacitySummary => {
  const domains = accounting.domains
  const deviceConstraints = accounting.device_constraints
  let requiredBytes = 0n
  let usableCapacityBytes = 0n
  let limitingResource: string | MemoryDomainId = domains[0]?.id ?? systemMemoryDomainId()
  let largestDeficit = 0n
  let fits = true

  for (const domain of domains) {
    const required = memoryBreakdownTotalBytes(domain.memory)
    const deficit = required > domain.usable_capacity_bytes ? required - domain.usable_capacity_bytes : 0n
    if (deficit > 0n) fits = false
    if (deficit >= largestDeficit) {
      largestDeficit = deficit
      limitingResource = domain.id
    }
    requiredBytes += required
    usableCapacityBytes += domain.usable_capacity_bytes
  }

  for (const constraint of deviceConstraints) {
    const required = memoryBreakdownTotalBytes(constraint.memory)
    const deficit =
      required > constraint.usable_capacity_bytes ? required - constraint.usable_capacity_bytes : 0n
    if (deficit > 0n) fits = false
    if (deficit > largestDeficit) {
      largestDeficit = deficit
      limitingResource = constraint.name
    }
  }

  return {
    fits,
    requiredBytes,
    usableCapacityBytes,
    deficitBytes: largestDeficit,
    limitingResource,
    device: domains.map((domain) => memoryDomainIdAsStr(domain.id)).join(" + "),
    domains: domains.map((domain) =>
      domainAssessment(domain.id, domain.memory, domain.usable_capacity_bytes),
    ),
    deviceConstraints: deviceConstraints.map((constraint) =>
      deviceAssessment(
        constraint.device_id,
        constraint.name,
        constraint.memory,
        constraint.usable_capacity_bytes,
      ),
    ),
  }
}
