import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { join } from "node:path"
import type {
  BackendEligibilityReport,
  CudaEligibility,
  MetalEligibility,
  VulkanEligibility,
} from "@magnitudedev/icn-contracts"

const MAX_CANDIDATES_PER_DIRECTORY = 32
const MAX_CHILD_PROVIDER_DIRECTORIES = 64

const bounded = (value: string): string =>
  value.replace(/[\r\n]/g, " ").slice(0, 240)

export const normalizedBackendName = (backend: string): string => {
  const lower = backend.toLowerCase()
  return lower === "mtl" ? "metal" : lower
}

export const isCudaDriverFilename = (name: string): boolean => {
  const version = name.startsWith("libcuda.so.") ? name.slice("libcuda.so.".length) : undefined
  if (version === undefined) {
    return false
  }
  return version.split(".").every(
    (component) => component.length > 0 && [...component].every((char) => char >= "0" && char <= "9"),
  )
}

export const collectCudaDriverFiles = (
  directory: string,
  limit = MAX_CANDIDATES_PER_DIRECTORY,
): string[] => {
  if (!existsSync(directory)) {
    return []
  }
  try {
    const found = readdirSync(directory)
      .filter(isCudaDriverFilename)
      .map((name) => join(directory, name))
      .sort()
    return found.slice(0, limit)
  } catch {
    return []
  }
}

const collectChildCudaDriverDirectories = (directory: string): string[] => {
  if (!existsSync(directory)) {
    return []
  }
  try {
    const directories = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name))
      .sort()
      .slice(0, MAX_CHILD_PROVIDER_DIRECTORIES)
    return directories.flatMap((child) => collectCudaDriverFiles(child))
  } catch {
    return []
  }
}

const isWsl = (): boolean =>
  process.env.WSL_INTEROP !== undefined ||
  existsSync("/usr/lib/wsl/lib") ||
  (() => {
    try {
      return readFileSync("/proc/sys/kernel/osrelease", "utf8").toLowerCase().includes("microsoft")
    } catch {
      return false
    }
  })()

const linuxCudaCandidates = (): string[] => {
  const candidates: string[] = ["libcuda.so.1"]
  if (isWsl()) {
    candidates.push(...collectCudaDriverFiles("/usr/lib/wsl/lib"))
    candidates.push(...collectChildCudaDriverDirectories("/usr/lib/wsl/drivers"))
  }
  const multiarchName =
    process.arch === "x64"
      ? "x86_64-linux-gnu"
      : process.arch === "arm64"
        ? "aarch64-linux-gnu"
        : undefined
  if (multiarchName !== undefined) {
    const multiarch = join("/usr/lib", multiarchName)
    candidates.push(...collectCudaDriverFiles(multiarch))
    candidates.push(...collectCudaDriverFiles(join("/lib", multiarchName)))
    candidates.push(...collectCudaDriverFiles(join(multiarch, "nvidia", "current")))
    candidates.push(...collectChildCudaDriverDirectories(join(multiarch, "nvidia")))
  }
  for (const directory of [
    "/usr/lib64",
    "/usr/lib",
    "/run/opengl-driver/lib",
    "/usr/local/nvidia/lib",
    "/usr/local/nvidia/lib64",
  ]) {
    candidates.push(...collectCudaDriverFiles(directory))
  }
  const seen = new Set<string>()
  return candidates.filter((path) => {
    let identity = path
    try {
      identity = realpathSync(path)
    } catch {
      // Keep unresolved path identity.
    }
    if (seen.has(identity)) {
      return false
    }
    seen.add(identity)
    return true
  })
}

const libraryExists = (path: string): boolean => {
  try {
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return existsSync(path)
  }
}

const resolveLibraryCandidate = (
  name: string,
  searchPaths: readonly string[],
): string | undefined => {
  if (libraryExists(name)) {
    try {
      return realpathSync(name)
    } catch {
      return name
    }
  }
  for (const directory of searchPaths) {
    const candidate = join(directory, name)
    if (libraryExists(candidate)) {
      try {
        return realpathSync(candidate)
      } catch {
        return candidate
      }
    }
  }
  return undefined
}

/**
 * CUDA driver probing via filesystem discovery of libcuda (mirrors icn-server cuda_driver
 * candidate discovery). Full cuInit enumeration still requires native backends.
 */
export const probeCuda = (): CudaEligibility => {
  if (process.env.ICN_FORCE_CUDA_USABLE === "1") {
    return {
      state: "usable",
      driverApi: 12_000,
      architectures: ["80"],
      driverLibrary: "libcuda.so.1",
    }
  }
  if (process.platform === "darwin") {
    return { state: "absent", diagnostic: "CUDA is unavailable on this platform" }
  }
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
    const candidate = join(systemRoot, "System32", "nvcuda.dll")
    if (libraryExists(candidate)) {
      return {
        state: "usable",
        driverApi: 0,
        architectures: [],
        driverLibrary: candidate,
      }
    }
    return {
      state: "absent",
      diagnostic: bounded(`CUDA driver library is unavailable (${candidate})`),
    }
  }
  if (process.platform !== "linux") {
    return { state: "absent", diagnostic: "CUDA is unavailable on this platform" }
  }
  const candidates = linuxCudaCandidates()
  for (const candidate of candidates) {
    if (candidate === "libcuda.so.1") {
      const resolved = resolveLibraryCandidate("libcuda.so.1", [
        "/usr/lib64",
        "/usr/lib",
        "/usr/lib/x86_64-linux-gnu",
        "/usr/lib/aarch64-linux-gnu",
        "/lib/x86_64-linux-gnu",
        "/lib/aarch64-linux-gnu",
        "/usr/lib/wsl/lib",
      ])
      if (resolved === undefined) continue
      if (resolved.includes("stub")) {
        return { state: "absent", diagnostic: "only the CUDA stub driver is available" }
      }
      return {
        state: "usable",
        driverApi: 0,
        architectures: [],
        driverLibrary: resolved,
      }
    }
    if (!libraryExists(candidate)) continue
    if (candidate.includes("stub")) {
      return { state: "absent", diagnostic: "only the CUDA stub driver is available" }
    }
    return {
      state: "usable",
      driverApi: 0,
      architectures: [],
      driverLibrary: candidate,
    }
  }
  return { state: "absent", diagnostic: "CUDA driver library is unavailable" }
}

const vulkanSearchPaths = (): string[] => {
  const paths = [
    "/usr/lib",
    "/usr/lib64",
    "/usr/local/lib",
    "/usr/local/lib64",
    "/lib",
    "/lib64",
    "/run/opengl-driver/lib",
  ]
  if (process.arch === "x64") {
    paths.push("/usr/lib/x86_64-linux-gnu", "/lib/x86_64-linux-gnu")
  }
  if (process.arch === "arm64") {
    paths.push("/usr/lib/aarch64-linux-gnu", "/lib/aarch64-linux-gnu")
  }
  if (process.platform === "darwin") {
    paths.push("/usr/local/lib", "/opt/homebrew/lib")
  }
  return paths
}

/**
 * Vulkan loader presence via filesystem checks for libvulkan.
 */
export const probeVulkan = (): VulkanEligibility => {
  if (process.env.ICN_FORCE_VULKAN_USABLE === "1") {
    return { state: "usable", loaderApi: 1_004_000_000 }
  }
  if (process.env.ICN_FORCE_VULKAN_ABSENT === "1") {
    return { state: "absent", diagnostic: "Vulkan driver is unavailable" }
  }
  const loaderNames =
    process.platform === "win32"
      ? ["vulkan-1.dll"]
      : process.platform === "darwin"
        ? ["libvulkan.1.dylib", "libvulkan.dylib"]
        : ["libvulkan.so.1", "libvulkan.so"]
  for (const name of loaderNames) {
    const resolved = resolveLibraryCandidate(name, vulkanSearchPaths())
    if (resolved !== undefined) {
      return { state: "usable", loaderApi: 0 }
    }
  }
  return { state: "absent", diagnostic: bounded("Vulkan loader library is unavailable") }
}

/** Metal availability is Apple Silicon only (darwin + arm64). */
export const probeMetal = (): MetalEligibility => {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { state: "usable" }
  }
  return { state: "absent", diagnostic: "Metal requires Apple Silicon" }
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

/** Timing helper for CPU-side calibration measurement windows (microseconds). */
export const calibrationElapsedMicroseconds = (
  startedAtNs: bigint,
  endedAtNs = process.hrtime.bigint(),
): number => {
  const elapsed = endedAtNs - startedAtNs
  if (elapsed <= 0n) return 1
  const micros = elapsed / 1000n
  return micros > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(micros)
}

export const startCalibrationTimer = (): (() => number) => {
  const started = process.hrtime.bigint()
  return () => calibrationElapsedMicroseconds(started)
}

/** Retained for tests that assert typed absent stub shapes. */
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
