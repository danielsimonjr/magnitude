import { describe, expect, it } from "vitest"
import {
  BackendEligibilityReport,
  IcnInstallationDeclaration,
  IcnStartupProgressRecord,
  IcnStartupRecord,
} from "./index.js"
import { encodeJson } from "../schema/common.js"

describe("bootstrap protocol", () => {
  it("eligibility uses the state discriminator", () => {
    const report = {
      schemaVersion: 1,
      cuda: { state: "absent" as const, diagnostic: "unavailable" },
      vulkan: { state: "usable" as const, loaderApi: 1 },
      metal: { state: "usable" as const },
    }
    const value = encodeJson(BackendEligibilityReport, report)
    expect(value.cuda.state).toBe("absent")
    expect(value.vulkan.state).toBe("usable")
    expect(value.metal.state).toBe("usable")
    expect((value.cuda as Record<string, unknown>)._tag).toBeUndefined()
  })

  it("startup and installation use their public field names", () => {
    const startup = encodeJson(IcnStartupRecord, {
      type: "icn_ready",
      protocolVersion: 1,
      origin: "http://127.0.0.1:1",
      instanceId: "instance",
      pid: 1,
      apiVersion: 1,
      nativeBuild: "native",
    })
    expect(startup.type).toBe("icn_ready")
    expect(startup.protocolVersion).toBe(1)
    expect(startup.instanceId).toBe("instance")

    const progress = encodeJson(IcnStartupProgressRecord, {
      type: "preparing_backend",
      backend: { type: "cuda", hardwareLabel: "NVIDIA GPU" },
    })
    expect(progress.type).toBe("preparing_backend")
    expect(progress.backend.type).toBe("cuda")
    expect(progress.backend.hardwareLabel).toBe("NVIDIA GPU")

    const installation = encodeJson(IcnInstallationDeclaration, {
      schemaVersion: 1,
      backend: "cpu",
      nativeBuild: "native",
      backendModuleAbi: "abi",
    })
    expect(installation.schemaVersion).toBe(1)
    expect(installation.backend).toBe("cpu")
    expect(installation.backendModuleAbi).toBe("abi")
  })
})
