import { Option } from "effect"
import { describe, expect, it } from "vitest"
import {
  catalogBaseId,
  catalogVariantId,
  modelDownloadId,
  modelPackageId,
  modelReleaseDate,
  ModelId,
  type CatalogInstallationOperationId,
  type ModelDownload,
  type ModelPackage,
  type RecommendableModel,
} from "@magnitudedev/icn-contracts"
import { ManagedCatalogInstallations } from "./catalog-installations"
import { ModelDomainResolver } from "./catalog-models"

const package_: ModelPackage = {
  id: modelPackageId("package_target"),
  source: { _tag: "Local", path: "/models" },
  files: [],
  relationships: [],
  properties: {
    format: "gguf",
    quantization: "Q4_K_M",
    quantizationName: "4-bit",
    architecture: "test",
    maximumContextLength: Option.some(4096),
    intrinsicModelId: Option.none(),
    intrinsicQualityId: Option.none(),
  },
}

const definition: RecommendableModel = {
  modelId: catalogBaseId("catalog") as never,
  variantId: catalogVariantId("gguf:q4") as never,
  configuration: {
    bundle: { _tag: "Standalone", package: package_ },
    profile: { contextLength: 4096 },
  },
  displayName: "Catalog",
  variantLabel: "Q4",
  description: "test",
  releaseDate: modelReleaseDate("2026-01-01") as never,
  license: "test",
  parameterization: { architecture: "dense", totalParameters: 1_000_000n },
  intelligence: {
    score: 1,
    provenance: {
      kind: "estimate",
      target: "artificialAnalysisIntelligenceIndex",
      methodologyVersion: "v1",
      asOfDate: "2026-01-01",
      confidence: "high",
      methodology: "test",
      evidenceUrls: ["https://example.com"],
    },
  },
  fidelityRank: 1,
  quantizationAware: true,
}

describe("ManagedCatalogInstallations", () => {
  it("get/cancel/acknowledgeFailure mirror download operations", async () => {
    const downloads = new Map<string, ModelDownload>()
    const pending = (id: string): ModelDownload => ({
      id: modelDownloadId(id),
      bundle: { _tag: "Standalone", package: package_ },
      state: { _tag: "Pending", completedBytes: 0, totalBytes: 10 },
    })
    const service = {
      start: async () => {
        const started = pending("op-1")
        downloads.set(String(started.id), started)
        return { download: started }
      },
      list: async () => ({ downloads: [...downloads.values()] }),
      cancel: async (id: ReturnType<typeof modelDownloadId>) => {
        const cancelled: ModelDownload = {
          id,
          bundle: { _tag: "Standalone", package: package_ },
          state: { _tag: "Cancelled", completedBytes: 0, totalBytes: 10 },
        }
        downloads.set(String(id), cancelled)
        return cancelled
      },
      acknowledgeFailure: async (id: ReturnType<typeof modelDownloadId>) => {
        const failed: ModelDownload = {
          id,
          bundle: { _tag: "Standalone", package: package_ },
          state: {
            _tag: "Failed",
            completedBytes: 0,
            totalBytes: 10,
            failure: { _tag: "Internal", message: "failed" },
            acknowledged: true,
          },
        }
        downloads.set(String(id), failed)
        return failed
      },
    }
    const inventory = {
      installedPackagesResponse: () => ({
        revision: 0,
        reconciliationComplete: true,
        packages: [],
      }),
      catalogAffiliations: () => [],
    }
    const resolver = new ModelDomainResolver(inventory, { models: [definition], diagnostics: [] })
    const installations = new ManagedCatalogInstallations(resolver, service, {
      removeCatalogPackages: async () => 0,
    })
    const admitted = await installations.install(ModelId.catalog(definition.modelId, definition.variantId))
    expect(admitted._tag).toBe("Admitted")
    if (admitted._tag !== "Admitted") return
    const operationId = admitted.operationId as CatalogInstallationOperationId
    expect((await installations.get(operationId)).state._tag).toBe("Pending")
    expect((await installations.cancel(operationId)).state._tag).toBe("Cancelled")
    downloads.set(
      "op-1",
      {
        id: modelDownloadId("op-1"),
        bundle: { _tag: "Standalone", package: package_ },
        state: {
          _tag: "Failed",
          completedBytes: 0,
          totalBytes: 10,
          failure: { _tag: "Internal", message: "failed" },
          acknowledged: false,
        },
      },
    )
    const failed = await installations.acknowledgeFailure(operationId)
    expect(failed.state._tag).toBe("Failed")
    if (failed.state._tag === "Failed") {
      expect(failed.state.acknowledged).toBe(true)
    }
  })
})
