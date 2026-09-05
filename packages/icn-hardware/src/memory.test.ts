import { describe, expect, it } from "vitest"
import {
  abortReserveBytes,
  memorySample,
  normalizeSystemMemory,
  permitsLoad,
  recovered,
  requiresEviction,
  systemMemoryThresholds,
} from "./memory.js"

describe("system memory thresholds", () => {
  it("uses the larger of floor and fraction", () => {
    const gib = 1024 * 1024 * 1024
    expect(systemMemoryThresholds(16 * gib)).toEqual({
      assessReserveBytes: 2 * gib,
      abortReserveBytes: gib,
    })
    expect(systemMemoryThresholds(64 * gib)).toEqual({
      assessReserveBytes: Math.floor((64 * gib) / 10),
      abortReserveBytes: Math.floor((64 * gib) / 20),
    })
  })

  it("rejects invalid observations", () => {
    expect(() => normalizeSystemMemory(0, 1)).toThrow(/invalid system memory observation/)
    expect(() => normalizeSystemMemory(16, 32)).toThrow(/invalid system memory observation/)
  })

  it("uses allocation headroom for admission and eviction", () => {
    const gib = 1024 * 1024 * 1024
    expect(permitsLoad(memorySample(16 * gib, 8 * gib), 6 * gib)).toBe(true)
    expect(permitsLoad(memorySample(16 * gib, 7 * gib), 6 * gib)).toBe(false)
    expect(requiresEviction(memorySample(16 * gib, gib))).toBe(true)
    expect(requiresEviction(memorySample(16 * gib, gib + 1))).toBe(false)
  })

  it("uses normalized allocation headroom as the admission gate", () => {
    const gib = 1024 * 1024 * 1024
    const sample = memorySample(16 * gib, 12 * gib)
    const constrained = {
      ...sample,
      allocationCapacityBytes: 20 * gib,
      allocationHeadroomBytes: gib,
    }
    expect(requiresEviction(constrained)).toBe(true)
    expect(permitsLoad(constrained, gib)).toBe(false)
    expect(recovered(constrained)).toBe(false)

    const recoveredSample = {
      ...constrained,
      allocationHeadroomBytes: 2 * gib,
    }
    expect(recovered(recoveredSample)).toBe(true)
  })

  it("does not let physical availability override allocation headroom", () => {
    const gib = 1024 * 1024 * 1024
    const sample = {
      ...memorySample(16 * gib, 12 * gib),
      allocationHeadroomBytes: 7 * gib,
    }
    expect(permitsLoad(sample, 6 * gib)).toBe(false)
    expect(permitsLoad({ ...sample, physicalAvailableBytes: 16 * gib }, 6 * gib)).toBe(false)
  })

  it("derives abort reserve from capacity", () => {
    const gib = 1024 * 1024 * 1024
    expect(abortReserveBytes(memorySample(16 * gib, 0))).toBe(gib)
  })
})
