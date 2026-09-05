import {
  MemoryAccountant,
  memoryBreakdown,
  memoryCharge,
  memoryBreakdownWithoutModel,
  NativeDeviceLocator,
  type MemoryAccountingError,
  type MemoryCharge,
  type MemoryChargeOwner,
  type MemoryTopology,
} from "@magnitudedev/icn-contracts"
import { capacitySummaryFromAccounting, type CapacitySummary } from "./capacity.js"

export type PlannerMeasurement = "initial" | "selected"

export interface PlannerMemoryEstimate {
  readonly modelBytes: bigint
  readonly contextBytes: bigint
  readonly computeBytes: bigint
  readonly auxiliaryBytes?: bigint
}

export interface PlannerDeviceEstimate {
  readonly nativeIndex: number
  readonly backend: string
  readonly physicalId: string | null
  readonly initial?: PlannerMemoryEstimate
  readonly fitted?: PlannerMemoryEstimate
}

export type CapacitySummaryError =
  | MemoryAccountingError
  | { readonly code: "missing_measurements" }

const plannerEstimateToBreakdown = (estimate: PlannerMemoryEstimate) =>
  memoryBreakdown(
    estimate.modelBytes,
    estimate.contextBytes,
    estimate.computeBytes,
    estimate.auxiliaryBytes ?? 0n,
  )

const plannerDeviceCharge = (
  owner: MemoryChargeOwner,
  device: PlannerDeviceEstimate,
  estimate: PlannerMemoryEstimate,
  includeModel: boolean,
): MemoryCharge => {
  const memory = includeModel
    ? plannerEstimateToBreakdown(estimate)
    : memoryBreakdownWithoutModel(plannerEstimateToBreakdown(estimate))
  const location =
    device.backend.toLowerCase() === "cpu" || device.physicalId === null
      ? { type: "host" as const }
      : {
          type: "native_device" as const,
          locator: NativeDeviceLocator.exact(device.backend, device.physicalId, device.nativeIndex),
        }
  return memoryCharge(owner, location, memory)
}

export const capacitySummaryFromCharges = (
  topology: MemoryTopology,
  charges: readonly MemoryCharge[],
): { readonly ok: true; readonly summary: CapacitySummary } | { readonly ok: false; readonly error: CapacitySummaryError } => {
  const accountant = new MemoryAccountant(topology)
  for (const charge of charges) {
    const error = accountant.record(charge)
    if (error !== null) {
      return { ok: false, error }
    }
  }
  return { ok: true, summary: capacitySummaryFromAccounting(accountant.finish()) }
}

export const capacitySummaryFromPlannerDevices = (
  topology: MemoryTopology,
  devices: readonly PlannerDeviceEstimate[],
  measurement: PlannerMeasurement,
  options?: {
    readonly speculativeDevices?: readonly PlannerDeviceEstimate[]
    readonly speculativeIncludesModel?: boolean
  },
): { readonly ok: true; readonly summary: CapacitySummary } | { readonly ok: false; readonly error: CapacitySummaryError } => {
  const charges: MemoryCharge[] = []
  for (const device of devices) {
    const estimate = measurement === "initial" ? device.initial : device.fitted
    if (estimate === undefined) continue
    charges.push(plannerDeviceCharge("target", device, estimate, true))
  }
  if (options?.speculativeDevices !== undefined) {
    for (const device of options.speculativeDevices) {
      const estimate = device.initial
      if (estimate === undefined) continue
      charges.push(
        plannerDeviceCharge(
          "speculative_draft",
          device,
          estimate,
          options.speculativeIncludesModel ?? false,
        ),
      )
    }
  }
  if (charges.length === 0) {
    return { ok: false, error: { code: "missing_measurements" } }
  }
  return capacitySummaryFromCharges(topology, charges)
}
