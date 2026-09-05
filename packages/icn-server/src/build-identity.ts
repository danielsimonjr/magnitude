import { createHash } from "node:crypto"
import { hostname, platform, arch } from "node:os"
import type { IcnBinaryIdentity } from "@magnitudedev/icn-protocol"

export const PACKAGE_VERSION = "0.0.1"
export const API_VERSION = 1
export const BINDINGS_REVISION = "0000000000000000000000000000000000000000"
export const NATIVE_BACKEND_REVISION = "0000000000000000000000000000000000000000"

export const enabledBackends = (): ReadonlyArray<string> => {
  const backends: Array<string> = ["cpu"]
  if (platform() === "darwin" && arch() === "arm64") {
    backends.push("metal")
  }
  return backends
}

export const nativeBuild = (): string => {
  const digest = createHash("sha256")
  digest.update(BINDINGS_REVISION)
  digest.update("\0")
  digest.update(NATIVE_BACKEND_REVISION)
  return `native_${digest.digest("hex")}`
}

export const backendModuleAbi = (): string => `llama-backend-${BINDINGS_REVISION}`

export const binaryIdentity = (): IcnBinaryIdentity => ({
  version: PACKAGE_VERSION,
  api_version: API_VERSION,
  native_build: nativeBuild(),
  backend_module_abi: backendModuleAbi(),
  capabilities: [
    "hardware",
    "model_catalog",
    "model_installed",
    "model_assessment",
    "model_downloads",
    "model_residency",
    "chat_streaming",
  ],
  target: `${platform()}-${arch()}`,
  profile: "typescript",
  rustc: "bun-typescript",
  backends: [...enabledBackends()],
})
