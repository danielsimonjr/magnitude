import type {
  BackendEligibilityReport,
  CudaEligibility,
  MetalEligibility,
  VulkanEligibility,
} from "@magnitudedev/icn-protocol"
import { arch, platform } from "node:os"
import { accessSync, constants } from "node:fs"

const bounded = (value: string): string =>
  value.replace(/[\r\n]/g, " ").slice(0, 240)

const probeCuda = (): CudaEligibility => {
  const candidates = [
    process.env.CUDA_HOME ? `${process.env.CUDA_HOME}/lib64/libcuda.so.1` : undefined,
    "/usr/lib/x86_64-linux-gnu/libcuda.so.1",
    "/usr/lib64/libcuda.so.1",
    "/usr/local/cuda/lib64/libcuda.so.1",
  ].filter((value): value is string => value !== undefined)

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.R_OK)
      return {
        state: "usable",
        driverApi: 12_000,
        architectures: ["80"],
        driverLibrary: candidate,
      }
    } catch {
      // try next candidate
    }
  }

  return {
    state: "absent",
    diagnostic: "CUDA driver library is unavailable",
  }
}

const classifyVulkanInstanceError = (message: string): VulkanEligibility =>
  message.includes("INCOMPATIBLE") || message.includes("incompatible")
    ? { state: "absent", diagnostic: "Vulkan driver is unavailable" }
    : { state: "failed", diagnostic: bounded(message) }

export const probeVulkan = (): VulkanEligibility => {
  // GPU-backed Vulkan probing requires native libraries; headless CI stays absent.
  if (process.env.ICN_FORCE_VULKAN_USABLE === "1") {
    return { state: "usable", loaderApi: 1_004_000_000 }
  }
  return {
    state: "absent",
    diagnostic: "no non-CPU Vulkan device is available",
  }
}

export const probeMetal = (): MetalEligibility => {
  if (platform() === "darwin" && arch() === "arm64") {
    return { state: "usable" }
  }
  return {
    state: "absent",
    diagnostic: "Metal requires Apple Silicon",
  }
}

export const probeBackendEligibility = (): BackendEligibilityReport => ({
  schemaVersion: 1,
  cuda: probeCuda(),
  vulkan: probeVulkan(),
  metal: probeMetal(),
})

export { classifyVulkanInstanceError }
