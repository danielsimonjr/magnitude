import { describe, expect, it } from "vitest"
import { defaultExecutionConfig, type ExecutionIntent } from "@magnitudedev/icn-contracts"
import { Option } from "effect"
import { preflightSpeculative, validateSpeculativeConfig } from "./index.js"

const basePlan = (speculative: ExecutionIntent["speculative"]): ExecutionIntent => ({
  model_path: "model.gguf",
  context_size: 4096,
  physical_context_size: 4096,
  batch_size: 512,
  ubatch_size: 128,
  max_sequences: 1,
  prefill_quantum: 128,
  execution: defaultExecutionConfig(),
  projector: Option.none(),
  speculative,
})

describe("speculative preflight", () => {
  it("returns disabled configs unchanged", async () => {
    const disabled = { type: "disabled" as const, reason: "standalone_bundle" }
    expect(await preflightSpeculative(basePlan(disabled))).toEqual(disabled)
  })

  it("rejects invalid n_max/n_min without calling native", async () => {
    const result = await preflightSpeculative(
      basePlan({
        type: "enabled",
        source: { type: "embedded" },
        method: { method: "mtp", min_draft_probability: 0.5 },
        n_max: 1,
        n_min: 4,
        cache_type_k: "f16",
        cache_type_v: "f16",
      })
    )
    expect(result).toMatchObject({ _tag: "InvalidExecution" })
  })

  it("returns a typed error when enabled and native speculative is missing", async () => {
    const enabled = {
      type: "enabled" as const,
      source: { type: "embedded" as const },
      method: { method: "mtp" as const, min_draft_probability: 0.5 },
      n_max: 4,
      n_min: 1,
      cache_type_k: "f16" as const,
      cache_type_v: "f16" as const,
    }
    expect(validateSpeculativeConfig(enabled)).toBeUndefined()
    const result = await preflightSpeculative(basePlan(enabled))
    expect(result).toMatchObject({
      _tag: expect.stringMatching(/Incompatible|NativeUnavailable/),
    })
  })
})
