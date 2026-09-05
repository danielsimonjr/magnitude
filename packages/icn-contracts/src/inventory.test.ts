import { Option } from "effect"
import { describe, expect, it } from "vitest"
import {
  GenerationPerformanceAssessment,
  hardwareDeviceId,
  memoryDomainId,
  MemoryAccountant,
  memoryBreakdown,
  memoryCharge,
  MemoryTopology,
  NativeDeviceLocator,
  parseContentId,
  parseInventoryEntryId,
  type HardwareAssessment,
  type HardwareMemoryDomain,
} from "./inventory.js"
import { encodeJson, decodeJson } from "./schema/common.js"

const testMemoryTopology = (): MemoryTopology => {
  const topology = MemoryTopology.fromDomains([
    {
      id: memoryDomainId("system"),
      kind: "unified_memory",
      total_capacity_bytes: 64n,
      stable_capacity_bytes: 60n,
      current_free_bytes: Option.some(40n),
      shares_system_memory: true,
      devices: [
        {
          id: hardwareDeviceId("metal-0"),
          native_index: 0,
          backend: "MTL",
          physical_id: Option.some("metal-0"),
          name: "MTL0",
          description: "Test GPU",
          kind: "gpu",
          memory_limit: Option.some({
            kind: "recommended_working_set",
            total_bytes: 54n,
            stable_bytes: 50n,
            current_free_bytes: Option.some(30n),
          }),
        },
      ],
    },
  ])
  if (topology === null) throw new Error("valid topology")
  return topology
}

const fittingAssessment = (): HardwareAssessment => ({
  type: "fits",
  profile: {
    context_length: 8_192,
    acceleration: "gpu",
    device: "system",
  },
  memory: {
    required_bytes: 20n,
    usable_capacity_bytes: 60n,
    headroom_bytes: 40n,
    domains: [
      {
        memory_domain: memoryDomainId("system"),
        model_bytes: 10n,
        context_bytes: 4n,
        compute_bytes: 6n,
        auxiliary_bytes: 0n,
        required_bytes: 20n,
        usable_capacity_bytes: 60n,
        margin_bytes: 40n,
      },
    ],
    device_constraints: [
      {
        device_id: hardwareDeviceId("metal-0"),
        device: "MTL0",
        kind: "recommended_working_set",
        model_bytes: 10n,
        context_bytes: 4n,
        compute_bytes: 6n,
        auxiliary_bytes: 0n,
        required_bytes: 20n,
        usable_capacity_bytes: 50n,
        margin_bytes: 30n,
      },
    ],
  },
  recommendation: "recommended",
})

describe("memory topology", () => {
  it("is the only allocation location resolver", () => {
    const topology = testMemoryTopology()
    const host = topology.resolve({ type: "host" })
    expect(host?.memoryDomain).toBe(memoryDomainId("system"))
    expect(host?.device).toBeNull()

    const metal = topology.resolve({
      type: "native_device",
      locator: NativeDeviceLocator.exact("Metal", "metal-0", 0),
    })
    expect(metal?.memoryDomain).toBe("system")
    expect(metal?.device?.name).toBe("MTL0")

    const backendUnreported = topology.resolve({
      type: "native_device",
      locator: NativeDeviceLocator.observed("", null, 0),
    })
    expect(backendUnreported?.memoryDomain).toBe("system")

    expect(
      topology.resolve({
        type: "native_device",
        locator: NativeDeviceLocator.observed("CUDA", null, 0),
      })
    ).toBeNull()

    expect(
      topology.resolve({
        type: "native_device",
        locator: NativeDeviceLocator.exact("CUDA", "missing", 9),
      })
    ).toBeNull()
  })

  it("owns category aggregation and totals", () => {
    let memory = memoryBreakdown(10n, 20n, 30n, 40n)
    memory = {
      model_bytes: memory.model_bytes + 1n,
      context_bytes: memory.context_bytes + 2n,
      compute_bytes: memory.compute_bytes + 3n,
      auxiliary_bytes: memory.auxiliary_bytes + 4n,
    }
    expect(memory).toEqual(memoryBreakdown(11n, 22n, 33n, 44n))
    expect(memory.model_bytes + memory.context_bytes + memory.compute_bytes + memory.auxiliary_bytes).toBe(110n)
    expect({ ...memory, model_bytes: 0n }).toEqual(memoryBreakdown(0n, 22n, 33n, 44n))
  })

  it("accountant is the single domain and device aggregator", () => {
    const topology = testMemoryTopology()
    const accountant = new MemoryAccountant(topology)
    expect(
      accountant.record(
        memoryCharge("target", { type: "host" }, memoryBreakdown(1n, 2n, 3n, 4n))
      )
    ).toBeNull()
    expect(
      accountant.record(
        memoryCharge(
          "speculative_draft",
          {
            type: "native_device",
            locator: NativeDeviceLocator.exact("Metal", "metal-0", 0),
          },
          memoryBreakdown(10n, 20n, 30n, 40n)
        )
      )
    ).toBeNull()

    const accounting = accountant.finish()
    expect(accounting.domains).toHaveLength(1)
    expect(accounting.domains[0]?.memory).toEqual(memoryBreakdown(11n, 22n, 33n, 44n))
    expect(accounting.device_constraints).toHaveLength(1)
    expect(accounting.device_constraints[0]?.memory).toEqual(memoryBreakdown(10n, 20n, 30n, 40n))
  })

  it("rejects ambiguous native indices", () => {
    const device = (id: string, backend: string): HardwareMemoryDomain["devices"][number] => ({
      id: hardwareDeviceId(id),
      native_index: 0,
      backend,
      physical_id: Option.none(),
      name: id,
      description: id,
      kind: "gpu",
      memory_limit: Option.none(),
    })
    expect(
      MemoryTopology.fromDomains([
        {
          id: memoryDomainId("system"),
          kind: "system",
          total_capacity_bytes: 64n,
          stable_capacity_bytes: 60n,
          current_free_bytes: Option.some(40n),
          shares_system_memory: true,
          devices: [device("cpu-view", "CPU")],
        },
        {
          id: memoryDomainId("gpu"),
          kind: "physical_device",
          total_capacity_bytes: 16n,
          stable_capacity_bytes: 14n,
          current_free_bytes: Option.some(12n),
          shares_system_memory: false,
          devices: [device("gpu-view", "CUDA")],
        },
      ])
    ).toBeNull()
  })

  it("ids require the exact versioned prefix and lowercase digest", () => {
    const digest = "a".repeat(64)
    expect(parseInventoryEntryId(`mdl_${digest}`)).toBe(`mdl_${digest}`)
    expect(parseContentId(`content_${digest}`)).toBe(`content_${digest}`)
    expect(parseInventoryEntryId(`content_${digest}`)).toEqual({ _tag: "InvalidId", value: `content_${digest}` })
    expect(parseInventoryEntryId(`mdl_${"A".repeat(64)}`)).toEqual({
      _tag: "InvalidId",
      value: `mdl_${"A".repeat(64)}`,
    })
    expect(parseInventoryEntryId("mdl_short")).toEqual({ _tag: "InvalidId", value: "mdl_short" })
  })

  it("generation performance contract round trips exact data", () => {
    const assessment: GenerationPerformanceAssessment = {
      confidence: "low",
      workload: "baseline_single_sequence_decode",
      always_active_weight_bytes: 10n,
      routed_expert_weight_bytes: 80n,
      expert_count: 8,
      expert_used_count: 2,
      cross_memory_domain_placement: true,
      context_tokens: 262_144,
      kv_bytes_read_per_token: 4096n,
      lower_tokens_per_second: 10,
      expected_tokens_per_second: 12,
      upper_tokens_per_second: 14,
    }
    const encoded = encodeJson(GenerationPerformanceAssessment, assessment)
    expect(encoded.confidence).toBe("low")
    expect(decodeJson(GenerationPerformanceAssessment, encoded)).toEqual(assessment)
  })

  it("requires exact stable domain capacity", () => {
    const topology = testMemoryTopology()
    const assessment = fittingAssessment()
    expect(assessment.type).toBe("fits")
    if (assessment.type !== "fits") return
    expect(topology.validatesHardwareAssessment(assessment)).toBe(true)

    const corrupted: HardwareAssessment = {
      type: "fits",
      profile: assessment.profile,
      recommendation: assessment.recommendation,
      memory: {
        ...assessment.memory,
        domains: [
          {
            ...assessment.memory.domains[0]!,
            usable_capacity_bytes: 59n,
            margin_bytes: 39n,
          },
        ],
        usable_capacity_bytes: 59n,
        headroom_bytes: 39n,
      },
    }
    expect(topology.validatesHardwareAssessment(corrupted)).toBe(false)
  })

  it("requires exact canonical device limit", () => {
    const topology = testMemoryTopology()
    const assessment = fittingAssessment()
    expect(assessment.type).toBe("fits")
    if (assessment.type !== "fits") return

    const wrongLimit: HardwareAssessment = {
      type: "fits",
      profile: assessment.profile,
      recommendation: assessment.recommendation,
      memory: {
        ...assessment.memory,
        device_constraints: [
          {
            ...assessment.memory.device_constraints[0]!,
            usable_capacity_bytes: 49n,
            margin_bytes: 29n,
          },
        ],
      },
    }
    expect(topology.validatesHardwareAssessment(wrongLimit)).toBe(false)

    const unknownDevice: HardwareAssessment = {
      type: "fits",
      profile: assessment.profile,
      recommendation: assessment.recommendation,
      memory: {
        ...assessment.memory,
        device_constraints: [
          {
            ...assessment.memory.device_constraints[0]!,
            device_id: hardwareDeviceId("unknown"),
          },
        ],
      },
    }
    expect(topology.validatesHardwareAssessment(unknownDevice)).toBe(false)

    const duplicateDevice: HardwareAssessment = {
      type: "fits",
      profile: assessment.profile,
      recommendation: assessment.recommendation,
      memory: {
        ...assessment.memory,
        device_constraints: [
          ...assessment.memory.device_constraints,
          ...assessment.memory.device_constraints,
        ],
      },
    }
    expect(topology.validatesHardwareAssessment(duplicateDevice)).toBe(false)
  })
})
