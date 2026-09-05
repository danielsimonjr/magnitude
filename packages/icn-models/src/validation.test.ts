import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { modelFileId, modelPackageId, type ModelPackage } from "@magnitudedev/icn-contracts"
import { ValidatedDownloadPackage } from "./validation"

const package_ = (path: string): ModelPackage => {
  const sha256 = "a".repeat(64)
  return {
    id: modelPackageId("package_test"),
    source: { _tag: "HuggingFace", repository: "owner/repo", revision: "b".repeat(40) },
    files: [
      {
        id: modelFileId(`file_${sha256}`),
        path,
        role: "weights",
        sizeBytes: 1,
        tensorStorageBytes: Option.none(),
        sha256,
      },
    ],
    relationships: [],
    properties: {
      format: "gguf",
      quantization: "test",
      quantizationName: "test",
      architecture: "test",
      maximumContextLength: Option.some(1),
      intrinsicModelId: Option.none(),
      intrinsicQualityId: Option.none(),
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
          id: modelFileId(`file_${"c".repeat(64)}`),
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
