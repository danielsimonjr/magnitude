import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { BackendEligibilityReport } from "@magnitudedev/icn-protocol"
import {
  classifyVulkanInstanceError,
  probeBackendEligibility,
  probeMetal,
  probeVulkan,
} from "./backend-eligibility.js"

describe("backend eligibility", () => {
  it("reports absent metal off Apple Silicon", () => {
    if (process.platform === "darwin" && process.arch === "arm64") {
      expect(probeMetal()).toEqual({ state: "usable" })
    } else {
      expect(probeMetal()).toMatchObject({ state: "absent" })
    }
  })

  it("classifies incompatible Vulkan drivers as absent", () => {
    expect(classifyVulkanInstanceError("ERROR_INCOMPATIBLE_DRIVER")).toEqual({
      state: "absent",
      diagnostic: "Vulkan driver is unavailable",
    })
    expect(classifyVulkanInstanceError("ERROR_INITIALIZATION_FAILED")).toMatchObject({
      state: "failed",
    })
  })

  it("emits a schema-valid eligibility report", () => {
    const report = probeBackendEligibility()
    const decoded = Schema.decodeUnknownSync(
      Schema.parseJson(BackendEligibilityReport),
    )(JSON.stringify(report))
    expect(decoded.schemaVersion).toBe(1)
    expect(["absent", "failed", "usable"]).toContain(decoded.cuda.state)
    expect(probeVulkan().state).toBe("absent")
  })
})
