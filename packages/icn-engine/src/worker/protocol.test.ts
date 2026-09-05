import { describe, expect, it } from "vitest"
import { isWorkerTokenEvent, parseModelLoadIntent } from "./index.js"

describe("worker protocol helpers", () => {
  it("parses model load intent", () => {
    expect(
      parseModelLoadIntent({
        modelPath: "/tmp/model.gguf",
        nCtx: 512,
      })
    ).toEqual({
      modelPath: "/tmp/model.gguf",
      nCtx: 512,
      nBatch: undefined,
      nThreads: undefined,
      nGpuLayers: undefined,
    })
  })

  it("rejects invalid load intent", () => {
    expect(() => parseModelLoadIntent(null)).toThrow(/modelPath/)
    expect(() => parseModelLoadIntent({ modelPath: "" })).toThrow(/modelPath/)
  })

  it("recognizes token stream events", () => {
    const tokenEvent = { data: { type: "token", requestId: "r1", token: 42 } } as MessageEvent
    expect(isWorkerTokenEvent(tokenEvent)).toBe(true)
    expect(isWorkerTokenEvent({ data: { type: "completed" } } as MessageEvent)).toBe(false)
    expect(isWorkerTokenEvent({ data: null } as MessageEvent)).toBe(false)
  })
})
