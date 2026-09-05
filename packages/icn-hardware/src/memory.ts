import { freemem, totalmem } from "node:os"

const GIB = 1024 * 1024 * 1024

export interface SystemMemoryThresholds {
  readonly assessReserveBytes: number
  readonly abortReserveBytes: number
}

export interface SystemMemoryObservation {
  readonly physicalCapacityBytes: number
  readonly physicalAvailableBytes: number
  readonly allocationCapacityBytes: number
  readonly allocationHeadroomBytes: number
}

export interface MemorySample extends SystemMemoryObservation {
  readonly capturedAtMs: number
}

export const systemMemoryThresholds = (totalBytes: number): SystemMemoryThresholds => ({
  assessReserveBytes: Math.max(Math.floor(totalBytes / 10), 2 * GIB),
  abortReserveBytes: Math.max(Math.floor(totalBytes / 20), GIB),
})

export const normalizeSystemMemory = (
  physicalCapacityBytes: number,
  physicalAvailableBytes: number,
): SystemMemoryObservation => {
  if (
    physicalCapacityBytes === 0 ||
    physicalAvailableBytes > physicalCapacityBytes
  ) {
    throw new Error(
      `invalid system memory observation: total=${physicalCapacityBytes}, available=${physicalAvailableBytes}`,
    )
  }
  return {
    physicalCapacityBytes,
    physicalAvailableBytes,
    allocationCapacityBytes: physicalCapacityBytes,
    allocationHeadroomBytes: physicalAvailableBytes,
  }
}

export const observeSystemMemory = (): MemorySample => ({
  ...normalizeSystemMemory(totalmem(), freemem()),
  capturedAtMs: Date.now(),
})

export const memorySample = (
  totalBytes: number,
  availableBytes: number,
  capturedAtMs = Date.now(),
): MemorySample => ({
  ...normalizeSystemMemory(totalBytes, availableBytes),
  capturedAtMs,
})

export const abortReserveBytes = (sample: MemorySample): number =>
  systemMemoryThresholds(sample.physicalCapacityBytes).abortReserveBytes

export const permitsLoad = (
  sample: MemorySample,
  requiredSystemMemoryBytes: number,
): boolean => {
  const required = abortReserveBytes(sample) + requiredSystemMemoryBytes
  return sample.allocationHeadroomBytes > required
}

export const requiresEviction = (sample: MemorySample): boolean =>
  sample.allocationHeadroomBytes <= abortReserveBytes(sample)

export const RECOVERY_MARGIN_BYTES = 512 * 1024 * 1024

export const recovered = (sample: MemorySample): boolean => {
  const required = abortReserveBytes(sample) + RECOVERY_MARGIN_BYTES
  return sample.allocationHeadroomBytes > required
}
