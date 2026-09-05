import { Option } from "effect"
import { MemoryTopology, systemMemoryDomainId, type HardwareSnapshot } from "@magnitudedev/icn-contracts"

export const systemMemoryTopology = (capacityBytes: number) => {
  const snapshot = {
    captured_at: 1n,
    platform: "test",
    architecture: "test",
    system_product_name: Option.none(),
    cpu_model: Option.none(),
    logical_cores: 1,
    system_memory: {
      physical_capacity_bytes: BigInt(capacityBytes),
      physical_available_bytes: BigInt(capacityBytes),
      allocation_capacity_bytes: BigInt(capacityBytes),
      allocation_headroom_bytes: BigInt(capacityBytes),
      assess_reserve_bytes: 0n,
      abort_reserve_bytes: 0n,
    },
    native_build: "test",
    enabled_backends: ["cpu"],
    topology_fingerprint: "test",
    memory_domains: [
      {
        id: systemMemoryDomainId(),
        kind: "system" as const,
        total_capacity_bytes: BigInt(capacityBytes),
        stable_capacity_bytes: BigInt(capacityBytes),
        current_free_bytes: Option.some(BigInt(capacityBytes)),
        shares_system_memory: true,
        devices: [],
      },
    ],
  } satisfies HardwareSnapshot
  const topology = MemoryTopology.fromSnapshot(snapshot)
  if (topology === null) {
    throw new Error("failed to build system memory topology")
  }
  return topology
}
