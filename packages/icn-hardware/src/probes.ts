import { existsSync } from "node:fs"
import { createRequire } from "node:module"
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

const require = createRequire(import.meta.url)

const libraryExists = (candidates: readonly string[]): string | undefined => {
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        return candidate
      }
    } catch {
      // ignore permission errors while probing
    }
  }
  return undefined
}

const cudaLibraryCandidates = (): string[] => {
  if (process.platform === "linux") {
    return [
      "/usr/lib/x86_64-linux-gnu/libcuda.so.1",
      "/usr/lib/x86_64-linux-gnu/libcuda.so",
      "/usr/lib64/libcuda.so.1",
      "/usr/lib64/libcuda.so",
      "/usr/local/cuda/lib64/libcuda.so.1",
      "/usr/local/cuda/lib64/libcuda.so",
    ]
  }
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
    return [`${systemRoot}\\System32\\nvcuda.dll`, `${systemRoot}\\SysWOW64\\nvcuda.dll`]
  }
  if (process.platform === "darwin") {
    return []
  }
  return []
}

const vulkanLibraryCandidates = (): string[] => {
  if (process.platform === "linux") {
    return [
      "/usr/lib/x86_64-linux-gnu/libvulkan.so.1",
      "/usr/lib/x86_64-linux-gnu/libvulkan.so",
      "/usr/lib64/libvulkan.so.1",
      "/usr/lib64/libvulkan.so",
      "/usr/local/lib/libvulkan.so.1",
    ]
  }
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
    return [`${systemRoot}\\System32\\vulkan-1.dll`]
  }
  if (process.platform === "darwin") {
    return [
      "/usr/local/lib/libvulkan.1.dylib",
      "/opt/homebrew/lib/libvulkan.1.dylib",
    ]
  }
  return []
}

/**
 * Probe for a CUDA driver library on disk. Presence of the library means the driver is installed;
 * device usability still requires a loaded backend module at runtime.
 */
export const probeCuda = (): CudaEligibility => {
  const found = libraryExists(cudaLibraryCandidates())
  if (found !== undefined) {
    // Library presence is not enough for "usable" (needs driver API + architectures).
    return {
      state: "failed",
      diagnostic: bounded(
        `CUDA driver library found at ${found}, but device enumeration is not yet available in the TypeScript hardware layer`,
      ),
    }
  }
  return {
    state: "absent",
    diagnostic: "CUDA driver library was not found on this host",
  }
}

/**
 * Probe for a Vulkan loader library. Set `ICN_FORCE_VULKAN_USABLE=1` to exercise usable-state handling in tests.
 */
export const probeVulkan = (): VulkanEligibility => {
  if (process.env.ICN_FORCE_VULKAN_USABLE === "1") {
    return { state: "usable", loaderApi: 1_004_000_000 }
  }
  const found = libraryExists(vulkanLibraryCandidates())
  if (found !== undefined) {
    // Loader presence without instance/device enumeration is reported as failed, not usable.
    return {
      state: "failed",
      diagnostic: bounded(
        `Vulkan loader found at ${found}, but instance creation is not yet available in the TypeScript hardware layer`,
      ),
    }
  }
  return {
    state: "absent",
    diagnostic: "Vulkan loader library was not found on this host",
  }
}

/**
 * Metal is available on Apple Silicon macOS hosts.
 */
export const probeMetal = (): MetalEligibility => {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { state: "usable" }
  }
  if (process.platform === "darwin") {
    return {
      state: "absent",
      diagnostic: "Metal requires Apple Silicon",
    }
  }
  return {
    state: "absent",
    diagnostic: "Metal is only available on macOS",
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

/** Intentionally unused helper kept for future dlopen-based probes. */
export const tryRequireNativeBinding = (specifier: string): unknown => {
  try {
    return require(specifier)
  } catch {
    return undefined
  }
}
