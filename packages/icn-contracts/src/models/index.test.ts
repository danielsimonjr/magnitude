import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  ModelId,
  ModelIdError,
  ModelIdSchema,
  catalogBaseId,
  catalogVariantId,
  modelReleaseDate,
  ModelReleaseDate,
} from "./ids.js"
import { ModelReleaseReason } from "./catalog.js"
import { encodeJson } from "../schema/common.js"

describe("model ids", () => {
  it("parses and round trips standalone and nested artifacts", () => {
    for (const value of [
      "hf:unsloth/Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      "hf:owner/repo/quants/Q4/model-00001-of-00004.gguf",
    ]) {
      const parsed = ModelId.fromString(value)
      expect(parsed).toBeInstanceOf(ModelId)
      if (!(parsed instanceof ModelId)) continue
      expect(parsed.toString()).toBe(value)
      expect(encodeJson(ModelIdSchema as unknown as Schema.Schema<any, any, never>, parsed)).toBe(value)
      expect(ModelId.fromString(value)).toEqual(parsed)
    }
  })

  it("rejects non canonical or non gguf identities", () => {
    for (const value of [
      "HF:owner/repo/model.gguf",
      "hf:owner/repo",
      "hf:owner//model.gguf",
      "hf:/repo/model.gguf",
      "hf:owner/repo//model.gguf",
      "hf:owner/repo/../model.gguf",
      "hf:owner/repo/model.safetensors",
      "hf:owner/repo/Cafe\u0301.gguf",
      "hf:owner/repo/folder\\model.gguf",
      "hf:owner/repo/model\n.gguf",
    ]) {
      expect(ModelId.fromString(value)).toBeInstanceOf(ModelIdError)
    }
  })

  it("composes and parses catalog identity components", () => {
    const base = catalogBaseId("qwen3.5-4b")
    const variant = catalogVariantId("gguf:q4")
    if (base instanceof ModelIdError || variant instanceof ModelIdError) throw new Error("invalid ids")
    const id = ModelId.catalog(base, variant)
    expect(id.asStr()).toBe("qwen3.5-4b:gguf:q4")
    expect(id.parsed()).toEqual({ type: "catalog", baseId: base, variantId: variant })
  })
})

describe("model release date", () => {
  it("accepts real iso calendar dates", () => {
    const result = Schema.decodeUnknownEither(ModelReleaseDate)("2024-02-29")
    expect(result._tag).toBe("Right")
    if (result._tag === "Right") {
      expect(result.right).toBe("2024-02-29")
      expect(encodeJson(ModelReleaseDate, result.right)).toBe("2024-02-29")
    }
  })

  it("rejects malformed and impossible dates", () => {
    for (const value of ["2026-8-13", "2026-02-29", "2026-13-01", "0000-01-01"]) {
      expect(typeof modelReleaseDate(value)).toBe("string")
    }
  })
})

describe("model release reason", () => {
  it("serializes the complete product release vocabulary", () => {
    const cases = [
      ["user_stop", "user_stop"],
      ["idle_timeout", "idle_timeout"],
      ["replacement", "replacement"],
      ["memory_pressure", "memory_pressure"],
    ] as const
    for (const [reason, expected] of cases) {
      expect(encodeJson(ModelReleaseReason, reason)).toBe(expected)
    }
  })
})
