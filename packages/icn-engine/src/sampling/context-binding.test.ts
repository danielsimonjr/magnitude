import { describe, expect, it } from "vitest"
import { bindSamplingContext, getSamplingContext, unbindSamplingContext } from "./context-binding.js"

describe("sampling context binding", () => {
  it("requires bind before get", () => {
    unbindSamplingContext()
    expect(() => getSamplingContext()).toThrow(/bindSamplingContext/)
  })

  it("returns the bound context", () => {
    const fake = { sampleGreedy: () => 7 } as never
    bindSamplingContext(fake)
    expect(getSamplingContext()).toBe(fake)
    unbindSamplingContext()
  })
})
