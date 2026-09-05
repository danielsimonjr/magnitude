import { describe, expect, it } from "vitest"
import {
  assessmentMaterialContext,
  compactAssessmentMaterial,
  plannerStubTestSupport,
} from "./planner-stub"

describe("planner-stub", () => {
  it("compact_material_is_deterministic_and_preserves_assessment_inputs", () => {
    const source = plannerStubTestSupport.primaryHeader()
    const context = assessmentMaterialContext(source)
    expect(context).not.toHaveProperty("_tag")
    if ("_tag" in context) {
      throw new Error("expected assessment context")
    }
    expect(context.architecture).toBe("llama")
    expect(context.vocabulary_size).toBe(3)

    const first = compactAssessmentMaterial(source, context, "Primary")
    const second = compactAssessmentMaterial(source, context, "Primary")
    expect(first).not.toHaveProperty("_tag")
    expect(second).not.toHaveProperty("_tag")
    if (first instanceof Uint8Array && second instanceof Uint8Array) {
      expect(first).toEqual(second)
      expect(first.length).toBeLessThan(source.length)
    }
  })

  it("split_shard_keeps_its_metadata_without_primary_overrides", () => {
    const sourceHeader = plannerStubTestSupport.primaryHeader()
    const context = assessmentMaterialContext(sourceHeader)
    if ("_tag" in context) {
      throw new Error("expected assessment context")
    }
    const source = plannerStubTestSupport.shardHeader()
    const stub = compactAssessmentMaterial(source, context, "Shard")
    expect(stub).toBeInstanceOf(Uint8Array)
  })

  it("rejects_inconsistent_declared_vocabulary_size", () => {
    const result = assessmentMaterialContext(plannerStubTestSupport.inconsistentVocabularyHeader())
    expect(result).toEqual({
      _tag: "Invalid",
      reason: "token count differs from declared vocabulary size",
    })
  })

  // Skipped: compact_projector_preserves_native_modality_capabilities requires llama.cpp mtmd bindings.
})
