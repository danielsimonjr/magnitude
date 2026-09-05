import { describe, expect, it } from "vitest"
import { ModelFileId, ModelPackageId, type ModelPackage } from "./_contracts-shim"
import { ValidatedDownloadPackage } from "./validation"

const package_ = (path: string): ModelPackage => {
  const sha256 = "a".repeat(64)
  return {
    id: ModelPackageId("package_test"),
    source: { _tag: "HuggingFace", repository: "owner/repo", revision: "b".repeat(40) },
    files: [
      {
        id: ModelFileId(`file_${sha256}`),
        path,
        role: "weights",
        size_bytes: 1,
        tensor_storage_bytes: null,
        sha256,
      },
    ],
    relationships: [],
    properties: {
      format: "gguf",
      quantization: "test",
      quantization_name: "test",
      architecture: "test",
      maximum_context_length: 1,
      intrinsic_model_id: null,
      intrinsic_quality_id: null,
    },
  }
}

describe("validation", () => {
  it("rejects traversal and absolute package paths", () => {
    expect(() => ValidatedDownloadPackage.new(package_("../model.gguf"))).toThrow()
    expect(() => ValidatedDownloadPackage.new(package_("/tmp/model.gguf"))).toThrow()
    expect(() => ValidatedDownloadPackage.new(package_("models/model.gguf"))).not.toThrow()
  })

  it("rejects duplicate paths and missing weights", () => {
    const duplicateBase = package_("model.gguf")
    const duplicate: ModelPackage = {
      ...duplicateBase,
      files: [
        ...duplicateBase.files,
        {
          ...duplicateBase.files[0],
          id: ModelFileId(`file_${"c".repeat(64)}`),
          sha256: "c".repeat(64),
        },
      ],
    }
    expect(() => ValidatedDownloadPackage.new(duplicate)).toThrow()

    const projectorBase = package_("projector.gguf")
    const projector: ModelPackage = {
      ...projectorBase,
      files: [{ ...projectorBase.files[0], role: "projector" }],
    }
    expect(() => ValidatedDownloadPackage.new(projector)).toThrow()
  })
})
