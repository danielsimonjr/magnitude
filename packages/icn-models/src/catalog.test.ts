import { describe, expect, it } from "vitest"
import {
  catalogSource,
  isFirstShard,
  isLaterShard,
  packageSourceMatches,
  repositorySnapshot,
  resolveProjectorPath,
  validParameterization,
} from "./catalog"

describe("catalog", () => {
  it("authored_catalog_declares_valid_parameterization_for_every_model", () => {
    const source = catalogSource()
    expect(source.models.every((model) => validParameterization(model.parameterization))).toBe(true)
  })

  it("projector_resolution_is_automatic_only_when_unambiguous", () => {
    const source = catalogSource()
    const declaration = {
      ...source.models[0]!,
      projector: undefined,
      speculativeDecoding: undefined,
    }
    expect(
      resolveProjectorPath(
        declaration,
        repositorySnapshot(["model.gguf", "mmproj-model-F16.gguf"]),
      ),
    ).toBe("mmproj-model-F16.gguf")
    expect(() =>
      resolveProjectorPath(
        declaration,
        repositorySnapshot([
          "model.gguf",
          "mmproj-model-BF16.gguf",
          "mmproj-model-F16.gguf",
        ]),
      ),
    ).toThrow(/2 projector candidates/)
  })

  it("parameterization_requires_meaningful_architecture_counts", () => {
    expect(
      validParameterization({ architecture: "dense", totalParameters: 8_000_000_000n }),
    ).toBe(true)
    expect(validParameterization({ architecture: "dense", totalParameters: 0n })).toBe(false)
    expect(
      validParameterization({
        architecture: "mixtureOfExperts",
        totalParameters: 35_000_000_000n,
        activeParameters: 3_000_000_000n,
      }),
    ).toBe(true)
    expect(
      validParameterization({
        architecture: "mixtureOfExperts",
        totalParameters: 3_000_000_000n,
        activeParameters: 3_000_000_000n,
      }),
    ).toBe(false)
  })

  it("shard_selector_distinguishes_first_and_later_shards", () => {
    expect(isFirstShard("model-00001-of-00003.gguf")).toBe(true)
    expect(isLaterShard("model-00001-of-00003.gguf")).toBe(false)
    expect(isLaterShard("model-00002-of-00003.gguf")).toBe(true)
    expect(isLaterShard("model.gguf")).toBe(false)
  })

  it("package_source_must_match_the_authored_repository_and_locked_commit", () => {
    const repository = "publisher/model"
    const commit = "0123456789abcdef0123456789abcdef01234567"
    expect(
      packageSourceMatches(
        { _tag: "HuggingFace", repository, revision: commit },
        repository,
        commit,
      ),
    ).toBe(true)
    expect(
      packageSourceMatches(
        { _tag: "HuggingFace", repository: "other/repository", revision: commit },
        repository,
        commit,
      ),
    ).toBe(false)
  })
})
