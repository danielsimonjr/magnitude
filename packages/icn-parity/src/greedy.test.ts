import { describe, expect, it } from "vitest"
import { greedyDeterminismHarness, nativeParityAvailable } from "./greedy.js"

describe("greedy determinism harness (CPU)", () => {
  it("reports when native parity inputs are unavailable", () => {
    expect(typeof nativeParityAvailable()).toBe("boolean")
  })

  it.skipIf(!nativeParityAvailable())(
    "produces identical greedy token sequences across resets",
    async () => {
      const result = await greedyDeterminismHarness({
        modelPath: process.env.MAGNITUDE_TEST_GGUF!,
        prompt: "Hello",
        maxTokens: 8,
      })
      expect(result.first.length).toBeGreaterThan(0)
      expect(result.identical).toBe(true)
      expect(result.first).toEqual(result.second)
    }
  )
})
