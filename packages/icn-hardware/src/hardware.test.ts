import { Option } from "effect"
import { describe, expect, it } from "vitest"
import {
  MemoryTopology,
  memoryDomainId,
  systemMemoryDomainId,
  type HardwareDeviceKind,
} from "@magnitudedev/icn-contracts"
import {
  capacitySummaryFromAccounting,
  defaultCapacityPolicy,
  reserveForDomain,
} from "./capacity.js"
import { capacitySummaryFromPlannerDevices } from "./planning.js"
import {
  hardwareSnapshotFromDevices,
  topologyFingerprint,
  withCapacityPolicy,
  withSystemMemoryObservation,
  type DiscoveredDevice,
  type HardwareEnvironment,
} from "./snapshot.js"
import {
  FIT_CALIBRATION_METHOD,
  fixtureCpuHardwareCalibration,
  hardwareCalibrationCoversSnapshot,
  hardwareCalibrationInputIdentity,
  validateCalibration,
} from "./calibration.js"
import { memoryBreakdown, MemoryAccountant, memoryCharge } from "@magnitudedev/icn-contracts"
import { memorySample } from "./memory.js"
import {
  calibrationElapsedMicroseconds,
  collectCudaDriverFiles,
  isCudaDriverFilename,
  probeBackendEligibility,
  startCalibrationTimer,
  stubGpuProbesUnavailable,
} from "./probes.js"
import { mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const gib = 1024n * 1024n * 1024n

const discoveredDevice = (
  backend: string,
  name: string,
  description: string,
  kind: HardwareDeviceKind,
  totalBytes: bigint,
  freeBytes: bigint,
  nativeIndex = 0,
  physicalId: string | null = null,
): DiscoveredDevice => ({
  nativeIndex,
  backend,
  physicalId,
  name,
  description,
  kind,
  totalBytes,
  freeBytes,
})

const testEnvironment = (
  systemMemoryBytes: bigint,
  platform = "linux",
  architecture = "x86_64",
): HardwareEnvironment => ({
  nativeBuild: "test",
  enabledBackends: [],
  platform,
  architecture,
  systemProductName: null,
  logicalCores: 8,
  systemMemory: {
    physical_capacity_bytes: systemMemoryBytes,
    physical_available_bytes: systemMemoryBytes,
    allocation_capacity_bytes: systemMemoryBytes,
    allocation_headroom_bytes: systemMemoryBytes,
    assess_reserve_bytes: 0n,
    abort_reserve_bytes: 0n,
  },
})

const testTopology = (
  devices: DiscoveredDevice[],
  systemMemoryBytes: bigint,
  policy = defaultCapacityPolicy(),
  platform = "linux",
  architecture = "x86_64",
): MemoryTopology => {
  const snapshot = hardwareSnapshotFromDevices(
    devices,
    policy,
    testEnvironment(systemMemoryBytes, platform, architecture),
  )
  const topology = MemoryTopology.fromSnapshot(snapshot)
  if (topology === null) throw new Error("valid test topology")
  return topology
}

describe("capacity policy", () => {
  it("uses a larger system reserve than dedicated domains", () => {
    const policy = {
      reserveBytesPerDomain: 2,
      systemReserveBytes: 10,
    }
    expect(reserveForDomain(policy, systemMemoryDomainId())).toBe(10)
    expect(reserveForDomain(policy, memoryDomainId("device-abc"))).toBe(2)
  })
})

describe("capacity summary", () => {
  it("aggregates domain and device constraint deficits", () => {
    const topology = testTopology(
      [
        discoveredDevice("CPU", "CPU", "host", "cpu", 1_000n, 1n),
      ],
      1_000n,
      { reserveBytesPerDomain: 100, systemReserveBytes: 100 },
    )
    const result = capacitySummaryFromPlannerDevices(
      topology,
      [
        {
          nativeIndex: 0,
          backend: "CPU",
          physicalId: null,
          initial: {
            modelBytes: 300n,
            contextBytes: 50n,
            computeBytes: 50n,
          },
        },
      ],
      "initial",
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.summary.fits).toBe(true)
    expect(result.summary.usableCapacityBytes).toBe(900n)
    expect(result.summary.requiredBytes).toBe(400n)
    expect(result.summary.domains[0]?.memory_domain).toBe(systemMemoryDomainId())
  })

  it("merges exact physical identity across backend views", () => {
    const policy = { reserveBytesPerDomain: 1_000 }
    const cuda = discoveredDevice(
      "CUDA",
      "CUDA0",
      "Example GPU",
      "gpu",
      16_000n,
      12_000n,
      0,
      "0000:01:00.0",
    )
    const vulkan = discoveredDevice(
      "Vulkan",
      "Vulkan0",
      "Example GPU",
      "gpu",
      16_000n,
      12_000n,
      1,
      "0000:01:00.0",
    )
    const cpu = discoveredDevice("CPU", "CPU", "Example CPU", "cpu", 0n, 0n, 2)
    const topology = testTopology([cuda, vulkan, cpu], 0n, policy)
    const result = capacitySummaryFromPlannerDevices(
      topology,
      [
        {
          nativeIndex: 0,
          backend: "CUDA",
          physicalId: "0000:01:00.0",
          initial: { modelBytes: 4_000n, contextBytes: 0n, computeBytes: 0n },
        },
        {
          nativeIndex: 1,
          backend: "Vulkan",
          physicalId: "0000:01:00.0",
          initial: { modelBytes: 3_000n, contextBytes: 0n, computeBytes: 0n },
        },
      ],
      "initial",
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.summary.usableCapacityBytes).toBe(15_000n)
    expect(result.summary.requiredBytes).toBe(7_000n)
    expect(result.summary.domains).toHaveLength(2)
  })

  it("keeps an explicit zero-byte system domain for dedicated-only plans", () => {
    const policy = { reserveBytesPerDomain: 1_000, systemReserveBytes: 2_000 }
    const cuda = discoveredDevice(
      "CUDA",
      "CUDA0",
      "CUDA0",
      "gpu",
      16_000n,
      16_000n,
      0,
      "0000:01:00.0",
    )
    const cpu = discoveredDevice("CPU", "CPU", "CPU", "cpu", 64_000n, 64_000n, 1)
    const topology = testTopology([cuda, cpu], 64_000n, policy)
    const result = capacitySummaryFromPlannerDevices(
      topology,
      [
        {
          nativeIndex: 0,
          backend: "CUDA",
          physicalId: "0000:01:00.0",
          initial: { modelBytes: 8_000n, contextBytes: 0n, computeBytes: 0n },
        },
        {
          nativeIndex: 1,
          backend: "CPU",
          physicalId: null,
          initial: { modelBytes: 0n, contextBytes: 0n, computeBytes: 0n },
        },
      ],
      "initial",
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.summary.domains[0]?.memory_domain).toBe(systemMemoryDomainId())
    expect(result.summary.domains[0]?.required_bytes).toBe(0n)
  })

  it("sums accounting from MemoryAccountant", () => {
    const topology = testTopology(
      [discoveredDevice("CPU", "CPU", "host", "cpu", 2_000n, 1_000n)],
      2_000n,
      { reserveBytesPerDomain: 100 },
    )
    const accountant = new MemoryAccountant(topology)
    accountant.record(
      memoryCharge("target", { type: "host" }, memoryBreakdown(100n, 20n, 10n, 0n)),
    )
    const summary = capacitySummaryFromAccounting(accountant.finish())
    expect(summary.requiredBytes).toBe(130n)
    expect(summary.fits).toBe(true)
  })
})

describe("hardware snapshot", () => {
  it("builds dedicated domains for distinct physical GPUs", () => {
    const cpu = discoveredDevice("CPU", "CPU", "Example CPU", "cpu", 64_000n, 32_000n)
    const gpu = (backend: string, name: string, index: number, ordinal: number) =>
      discoveredDevice(
        backend,
        name,
        "Example GPU",
        "gpu",
        16_000n,
        12_000n,
        index,
        `0000:01:0${ordinal}.0`,
      )
    const snapshot = hardwareSnapshotFromDevices(
      [cpu, gpu("CUDA", "CUDA0", 0, 0), gpu("CUDA", "CUDA1", 1, 1), gpu("Vulkan", "Vulkan0", 2, 0), gpu("Vulkan", "Vulkan1", 3, 1)],
      { reserveBytesPerDomain: 1_000 },
      {
        ...testEnvironment(64_000n),
        enabledBackends: ["vulkan", "cuda"],
      },
    )
    expect(snapshot.memory_domains).toHaveLength(3)
    expect(snapshot.memory_domains[0]?.id).toBe(systemMemoryDomainId())
    for (const domain of snapshot.memory_domains.slice(1)) {
      expect(domain.total_capacity_bytes).toBe(16_000n)
      expect(domain.stable_capacity_bytes).toBe(15_000n)
      expect(domain.devices).toHaveLength(2)
    }
    expect(snapshot.enabled_backends).toEqual(["cuda", "vulkan"])
  })

  it("keeps topology fingerprint stable across free-memory changes", () => {
    const devices = [
      discoveredDevice("CPU", "CPU", "Example CPU", "cpu", 64_000n, 40_000n),
      discoveredDevice("Metal", "MTL0", "Example GPU", "gpu", 48_000n, 20_000n),
    ]
    const first = hardwareSnapshotFromDevices(devices, defaultCapacityPolicy(), testEnvironment(64_000n, "darwin", "arm64"))
    const second = hardwareSnapshotFromDevices(
      devices.map((device) => ({ ...device, freeBytes: 1n })),
      defaultCapacityPolicy(),
      {
        ...testEnvironment(64_000n, "darwin", "arm64"),
        systemMemory: {
          ...testEnvironment(64_000n).systemMemory,
          physical_available_bytes: 1n,
          allocation_headroom_bytes: 1n,
        },
      },
    )
    expect(topologyFingerprint(first.memory_domains)).toBe(topologyFingerprint(second.memory_domains))
  })

  it("applies capacity policy and fresh system-memory observations", () => {
    const snapshot = hardwareSnapshotFromDevices(
      [discoveredDevice("CPU", "CPU", "host", "cpu", 16n * gib, 8n * gib)],
      defaultCapacityPolicy(),
      testEnvironment(16n * gib),
    )
    const reserved = withCapacityPolicy(snapshot, {
      reserveBytesPerDomain: 1_000,
      systemReserveBytes: 2_000,
    })
    expect(reserved.memory_domains[0]?.stable_capacity_bytes).toBe(16n * gib - 2_000n)

    const sample = memorySample(Number(16n * gib), Number(7n * gib))
    const refreshed = withSystemMemoryObservation(snapshot, sample)
    expect(refreshed.system_memory.physical_available_bytes).toBe(7n * gib)
    expect(Option.getOrThrow(refreshed.memory_domains[0]?.current_free_bytes)).toBe(7n * gib)
  })
})

describe("hardware calibration", () => {
  it("validates fixture CPU calibration", () => {
    const calibration = fixtureCpuHardwareCalibration()
    expect(validateCalibration(calibration)).toBeNull()
    expect(calibration.method).toBe(FIT_CALIBRATION_METHOD)
  })

  it("requires dense and routed coverage for each enabled backend device", () => {
    const snapshot = hardwareSnapshotFromDevices(
      [discoveredDevice("CPU", "CPU", "host", "cpu", 16n * gib, 8n * gib)],
      defaultCapacityPolicy(),
      {
        ...testEnvironment(16n * gib),
        enabledBackends: ["cpu"],
      },
    )
    expect(hardwareCalibrationCoversSnapshot(fixtureCpuHardwareCalibration(), snapshot)).toBe(true)
    expect(
      hardwareCalibrationCoversSnapshot(
        {
          ...fixtureCpuHardwareCalibration(),
          metrics: fixtureCpuHardwareCalibration().metrics.filter((metric) => !metric.routed),
        },
        snapshot,
      ),
    ).toBe(false)
  })

  it("derives stable cache input identity", () => {
    const snapshot = hardwareSnapshotFromDevices(
      [discoveredDevice("CPU", "CPU", "host", "cpu", 16n * gib, 8n * gib)],
      defaultCapacityPolicy(),
      testEnvironment(16n * gib),
    )
    const first = hardwareCalibrationInputIdentity({
      cacheMethod: "icn-hardware-calibration-cache-v1",
      calibrationMethod: FIT_CALIBRATION_METHOD,
      backendModuleAbi: "abi",
      snapshot,
    })
    const second = hardwareCalibrationInputIdentity({
      cacheMethod: "icn-hardware-calibration-cache-v1",
      calibrationMethod: FIT_CALIBRATION_METHOD,
      backendModuleAbi: "abi",
      snapshot,
    })
    expect(first).toBe(second)
    expect(first.startsWith("hardware_calibration_input_")).toBe(true)
  })
})

describe("backend probes", () => {
  it("returns typed absent GPU probe results", () => {
    expect(stubGpuProbesUnavailable().cuda.state).toBe("absent")
    expect(stubGpuProbesUnavailable().vulkan.state).toBe("absent")
    expect(stubGpuProbesUnavailable().metal.state).toBe("absent")
  })

  it("emits a schema-compatible eligibility report", () => {
    const report = probeBackendEligibility()
    expect(report.schemaVersion).toBe(1)
    expect(["absent", "failed", "usable"]).toContain(report.cuda.state)
    expect(["absent", "failed", "usable"]).toContain(report.vulkan.state)
    expect(["absent", "usable"]).toContain(report.metal.state)
  })

  it("accepts only versioned cuda driver provider names", () => {
    expect(isCudaDriverFilename("libcuda.so.1")).toBe(true)
    expect(isCudaDriverFilename("libcuda.so.555.42.02")).toBe(true)
    expect(isCudaDriverFilename("libcuda.so")).toBe(false)
    expect(isCudaDriverFilename("libcuda.so.stub")).toBe(false)
  })

  it("discovers sorted cuda driver files from a directory", () => {
    const root = mkdtempSync(join(tmpdir(), "cuda-probe-"))
    for (const name of ["libcuda.so.2", "libcuda.so", "libcuda.so.1", "other.so.1"]) {
      writeFileSync(join(root, name), "fixture")
    }
    expect(collectCudaDriverFiles(root)).toEqual([join(root, "libcuda.so.1"), join(root, "libcuda.so.2")])
  })

  it("measures calibration elapsed microseconds", async () => {
    const stop = startCalibrationTimer()
    await new Promise((resolve) => setTimeout(resolve, 2))
    expect(stop()).toBeGreaterThan(0)
    expect(calibrationElapsedMicroseconds(0n, 2_000n)).toBe(2)
  })
})
