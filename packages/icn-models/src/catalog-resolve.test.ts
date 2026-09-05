import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { modelPackageId, type ModelPackage } from "@magnitudedev/icn-contracts"
import {
  createHubRepositoryHttpClient,
  refreshHuggingFaceRepository,
  resolvePrimaryGgufFromSnapshot,
  ResolvingRecommendableCatalog,
  retryableHubStatus,
} from "./catalog-resolve"
import { catalogSource, repositorySnapshot, resolveProjectorPath } from "./catalog"

const packageStub = (): ModelPackage => ({
  id: modelPackageId("package_test"),
  source: {
    _tag: "HuggingFace",
    repository: "publisher/model",
    revision: "0123456789abcdef0123456789abcdef01234567",
  },
  files: [],
  relationships: [],
  properties: {
    format: "gguf",
    quantization: "Q4_K_M",
    quantizationName: "4-bit",
    architecture: "test",
    maximumContextLength: Option.some(32_768),
    intrinsicModelId: Option.none(),
    intrinsicQualityId: Option.none(),
  },
})

describe("catalog-resolve", () => {
  it("retries_only_rate_limits_and_server_failures", () => {
    expect(retryableHubStatus(429)).toBe(true)
    expect(retryableHubStatus(502)).toBe(true)
    expect(retryableHubStatus(404)).toBe(false)
    expect(retryableHubStatus(401)).toBe(false)
  })

  it("refreshHuggingFaceRepository uses injectable HTTP and caches snapshots", async () => {
    const commit = "a".repeat(40)
    let calls = 0
    const http = {
      fetchRepositoryMetadata: async () => {
        calls += 1
        return {
          _tag: "Modified" as const,
          model: {
            id: "owner/model",
            sha: commit,
            siblings: [{ rfilename: "model.gguf", size: 10, lfs: { sha256: "b".repeat(64), size: 10 } }],
          },
          etag: '"etag-1"',
        }
      },
    }
    const first = await refreshHuggingFaceRepository({ http }, { repository: "owner/model", revision: commit })
    expect(first.commit).toBe(commit)
    expect(first.gguf_files).toHaveLength(1)
    expect(calls).toBe(1)

    const cache = {
      store: new Map<string, unknown>(),
      readIndex<T>(_kind: string, key: string) {
        return this.store.get(key) as T | undefined
      },
      writeIndex(_kind: string, key: string, value: unknown) {
        this.store.set(key, value)
      },
    }
    await refreshHuggingFaceRepository({ http, cache: cache as never }, { repository: "owner/model", revision: "main" })
    let callsAfterCache = 0
    const cachedHttp = {
      fetchRepositoryMetadata: async () => {
        callsAfterCache += 1
        return { _tag: "NotModified" as const }
      },
    }
    const second = await refreshHuggingFaceRepository(
      { http: cachedHttp, cache: cache as never },
      { repository: "owner/model", revision: "main" },
    )
    expect(second.commit).toBe(commit)
    expect(callsAfterCache).toBe(1)
  })

  it("ResolvingRecommendableCatalog materializes from mocked snapshots", async () => {
    const source = catalogSource()
    const declaration = {
      ...source.models[0]!,
      projector: undefined,
      speculativeDecoding: undefined,
      variants: [source.models[0]!.variants[0]!],
    }
    const lock = {
      [declaration.id]: { target: "0123456789abcdef0123456789abcdef01234567" },
    }
    const snapshot = repositorySnapshot(
      [`model-${declaration.variants[0]!.format}.gguf`],
      declaration.repository,
      lock[declaration.id]!.target,
    )
    const catalog = new ResolvingRecommendableCatalog({
      refreshRepository: async () => snapshot,
      resolvePackages: async () => ({
        target: packageStub(),
        properties: {
          type: "inspected",
          architecture: Option.some("test"),
          quantization: Option.none(),
          quantization_name: Option.none(),
          parameter_count: Option.none(),
          active_parameter_count: Option.none(),
          training_context_length: Option.some(32_768),
          nextn_predict_layers: Option.none(),
          tokenizer: Option.none(),
          modalities: ["text"],
          base_models: [],
          evidence_fingerprint: "test",
        },
      }),
    })
    const generated = await catalog.resolveReleaseCatalog(() => undefined, lock as never, {
      models: [declaration],
    })
    expect(generated.catalog.models.length + generated.catalog.diagnostics.length).toBeGreaterThan(0)
  })

  it("resolvePrimaryGgufFromSnapshot requires an unambiguous format match", () => {
    const source = catalogSource()
    const declaration = source.models[0]!
    const variant = declaration.variants[0]!
    expect(
      resolvePrimaryGgufFromSnapshot(
        declaration,
        variant,
        repositorySnapshot([`weights-${variant.format}.gguf`]),
      ),
    ).toContain(variant.format)
  })

  it("createHubRepositoryHttpClient is constructible", () => {
    expect(createHubRepositoryHttpClient({ endpoint: "https://huggingface.co" })).toBeDefined()
  })
})

describe("catalog projector rejection", () => {
  it("projector_resolution_rejects_invalid_paths_and_mtp", () => {
    const source = catalogSource()
    const declaration = { ...source.models[0]! }
    const snapshot = repositorySnapshot(["model.gguf", "mmproj-BF16.gguf"])
    declaration.projector = { path: "mmproj-missing.gguf" }
    expect(() => resolveProjectorPath(declaration, snapshot)).toThrow(/is not a repository mmproj GGUF/)
    declaration.projector = { path: "mmproj-BF16.gguf" }
    declaration.speculativeDecoding = { method: "mtp", draft: { type: "embedded" } }
    expect(() => resolveProjectorPath(declaration, snapshot)).toThrow(/combines a projector with MTP/)
  })
})
