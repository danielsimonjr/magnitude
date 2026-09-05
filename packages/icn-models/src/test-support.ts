import { MemoryDomainId, MemoryTopology, type HardwareSnapshot } from "./_contracts-shim"

export const systemMemoryTopology = (capacityBytes: number): MemoryTopology =>
  MemoryTopology.fromSnapshot({
    captured_at: 1,
    platform: "test",
    architecture: "test",
    system_product_name: null,
    cpu_model: null,
    logical_cores: 1,
    system_memory: {
      physical_capacity_bytes: capacityBytes,
      physical_available_bytes: capacityBytes,
      allocation_capacity_bytes: capacityBytes,
      allocation_headroom_bytes: capacityBytes,
      assess_reserve_bytes: 0,
      abort_reserve_bytes: 0,
    },
    native_build: "test",
    enabled_backends: ["cpu"],
    topology_fingerprint: "test",
    memory_domains: [
      {
        id: MemoryDomainId.system(),
        kind: "system",
        total_capacity_bytes: capacityBytes,
        stable_capacity_bytes: capacityBytes,
        current_free_bytes: capacityBytes,
        shares_system_memory: true,
        devices: [],
      },
    ],
  } as HardwareSnapshot)
