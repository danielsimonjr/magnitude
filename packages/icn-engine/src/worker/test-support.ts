import { existsSync } from "node:fs"
import { resolveNativeLibraryPaths } from "@magnitudedev/icn-native"

/** Path to a GGUF model for integration tests (`MAGNITUDE_TEST_GGUF`). */
export const testGgufPath = (): string | undefined => {
  const path = process.env.MAGNITUDE_TEST_GGUF?.trim()
  return path && path.length > 0 ? path : undefined
}

/** True when native libraries resolve and a test GGUF exists on disk. */
export const nativeIntegrationEnabled = (): boolean => {
  const gguf = testGgufPath()
  if (gguf === undefined || !existsSync(gguf)) return false
  try {
    resolveNativeLibraryPaths()
    return true
  } catch {
    return false
  }
}

export const defaultTestLoadIntent = () => ({
  modelPath: testGgufPath()!,
  nCtx: 256,
  nBatch: 64,
  nThreads: 2,
  nGpuLayers: 0,
})
