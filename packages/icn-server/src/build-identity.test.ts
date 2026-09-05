import { describe, expect, it } from "vitest"
import { binaryIdentity, enabledBackends, nativeBuild } from "./build-identity.js"

describe("build identity", () => {
  it("includes cpu and stable native build identity", () => {
    expect(enabledBackends()).toContain("cpu")
    const identity = binaryIdentity()
    expect(identity.native_build).toBe(nativeBuild())
    expect(identity.api_version).toBe(1)
    expect(identity.capabilities).toContain("model_residency")
  })
})
