import type {
  BackendEligibilityReport,
  CudaEligibility,
  MetalEligibility,
  VulkanEligibility,
} from "@magnitudedev/icn-contracts"

const bounded = (value: string): string =>
  value.replace(/[\r\n]/g, " ").slice(0, 240)

export const normalizedBackendName = (backend: string): string => {
  const lower = backend.toLowerCase()
  return lower === "mtl" ? "metal" : lower
}

/**
 * CUDA driver probing requires native libraries. The TypeScript ICN stack returns a typed absent
 * result until Bun can load the pinned CUDA backend module.
 */
export const probeCuda = (): CudaEligibility => ({
  state: "absent",
  diagnostic: "CUDA driver probing is not implemented in the TypeScript ICN hardware layer yet",
})

/**
 * Vulkan device enumeration requires native libraries. Headless environments stay absent.
 * Set `ICN_FORCE_VULKAN_USABLE=1` to exercise usable-state handling in tests.
 */
export const probeVulkan = (): VulkanEligibility => {
  if (process.env.ICN_FORCE_VULKAN_USABLE === "1") {
    return { state: "usable", loaderApi: 1_004_000_000 }
  }
  return {
    state: "absent",
    diagnostic: "Vulkan probing is not implemented in the TypeScript ICN hardware layer yet",
  }
}

/**
 * Metal availability is inferred from the host platform until native Metal backends are wired.
 */
export const probeMetal = (): MetalEligibility => {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { state: "usable" }
  }
  return {
    state: "absent",
    diagnostic: "Metal requires Apple Silicon",
  }
}

export const classifyVulkanInstanceError = (message: string): VulkanEligibility =>
  message.includes("INCOMPATIBLE") || message.includes("incompatible")
    ? { state: "absent", diagnostic: "Vulkan driver is unavailable" }
    : { state: "failed", diagnostic: bounded(message) }

export const probeBackendEligibility = (): BackendEligibilityReport => ({
  schemaVersion: 1,
  cuda: probeCuda(),
  vulkan: probeVulkan(),
  metal: probeMetal(),
})

export const stubGpuProbesUnavailable = (): BackendEligibilityReport => ({
  schemaVersion: 1,
  cuda: {
    state: "absent",
    diagnostic: "GPU-backed CUDA probing requires native backend modules",
  },
  vulkan: {
    state: "absent",
    diagnostic: "GPU-backed Vulkan probing requires native backend modules",
  },
  metal: {
    state: "absent",
    diagnostic: "GPU-backed Metal probing requires native backend modules",
  },
})
