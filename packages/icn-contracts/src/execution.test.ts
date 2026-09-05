import { Option } from "effect"
import { describe, expect, it } from "vitest"
import {
  defaultExecutionConfig,
  defaultSpeculativeDecodingConfig,
  ImageInput,
  ImageInputSchema,
  parseCacheType,
  parseGpuLayers,
  parseSplitMode,
  SpeculativeMethodConfig,
  validateInferenceCapacity,
} from "./execution.js"
import { decodeJson, encodeJson } from "./schema/common.js"

describe("execution config", () => {
  it("defaults match pinned native service execution defaults", () => {
    const config = defaultExecutionConfig()
    expect(config.gpu_layers).toBe("auto")
    expect(config.use_mmap).toBe(true)
    expect(config.use_mlock).toBe(false)
    expect(config.split_mode).toBe("layer")
    expect(Option.isNone(config.tensor_split)).toBe(true)
    expect(config.cache_type_k).toBe("f16")
    expect(config.cache_type_v).toBe("f16")
    expect(config.offload_kqv).toBe(true)
    expect(config.operation_offload).toBe(true)
    expect(config.swa_full).toBe(false)
    expect(config.kv_unified).toBe(true)
    expect(Option.isNone(config.threads)).toBe(true)
    expect(Option.isNone(config.threads_batch)).toBe(true)
    expect(config.flash_attention).toBe("auto")
    expect(defaultSpeculativeDecodingConfig()).toEqual({ type: "disabled", reason: "not_supported" })
  })

  it("engine vocabulary uses upstream cli spellings", () => {
    expect(parseGpuLayers("auto")).toBe("auto")
    expect(parseGpuLayers("all")).toBe("all")
    expect(parseGpuLayers("12")).toEqual({ count: 12 })
    expect(parseSplitMode("tensor")).toBe("tensor")
    expect(parseCacheType("iq4_nl")).toBe("iq4_nl")
    expect(parseCacheType("q6_k")).toEqual({ error: expect.any(String) })
  })

  it("image input json uses base64 instead of integer arrays", () => {
    const image = ImageInput.new("image/png", [0, 1, 2, 255])
    const encoded = encodeJson(ImageInputSchema, image)
    expect(encoded.media_type).toBe("image/png")
    expect(encoded.data_base64).toBe("AAEC/w==")
    const decoded = decodeJson(ImageInputSchema, encoded)
    expect(decoded.equals(image)).toBe(true)
  })

  it("speculative methods round trip with method specific thresholds", () => {
    const methods = [
      { method: "mtp" as const, min_draft_probability: 0.1 },
      { method: "dflash" as const, min_sample_probability: 0.2 },
      { method: "dspark" as const, acceptance_threshold: 0.3 },
    ]
    for (const method of methods) {
      const encoded = encodeJson(SpeculativeMethodConfig, method)
      const decoded = decodeJson(SpeculativeMethodConfig, encoded)
      expect(decoded).toEqual(method)
    }
  })
})

describe("validateInferenceCapacity", () => {
  it("prompt must leave at least one generation position", () => {
    expect(validateInferenceCapacity(31, 32)).toBeUndefined()
    expect(validateInferenceCapacity(32, 32)).toEqual({
      _tag: "ContextLengthExceeded",
      promptTokens: 32,
      contextCapacity: 32,
    })
    expect(validateInferenceCapacity(33, 32)).toEqual({
      _tag: "ContextLengthExceeded",
      promptTokens: 33,
      contextCapacity: 32,
    })
  })
})
