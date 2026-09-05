import { describe, expect, it } from "vitest"
import { catalogBaseId, catalogVariantId, ModelIdError } from "@magnitudedev/icn-contracts"
import { type InstalledPackageSnapshot } from "./inventory"
import { discoveredModels, discoveryRecord, ManagedDiscoveredModels, selectedDiscoveredPackages } from "./discovered-models"

describe("discovered-models", () => {
  it("keeps_identical_content_from_different_repositories", () => {
    const first = discoveryRecord(
      "first",
      "owner/first",
      "model.gguf",
      "main",
      "commit-a",
      "same-package",
      { _tag: "NotCatalogTarget" },
    )
    const second = discoveryRecord(
      "second",
      "owner/second",
      "model.gguf",
      "main",
      "commit-b",
      "same-package",
      { _tag: "NotCatalogTarget" },
    )
    const snapshot: InstalledPackageSnapshot = {
      records: new Map([first, second]),
    }
    const ids = discoveredModels(snapshot).map((model) => String(model.id))
    expect(ids).toEqual(["hf:owner/first/model.gguf", "hf:owner/second/model.gguf"])
  })

  it("collapses_identical_revisions_and_prefers_current_selection", () => {
    const stale = discoveryRecord(
      "a-stale",
      "owner/repo",
      "model.gguf",
      "commit-a",
      "commit-a",
      "same-package",
      { _tag: "NotCatalogTarget" },
    )
    const current = discoveryRecord(
      "z-current",
      "owner/repo",
      "model.gguf",
      "main",
      "commit-b",
      "same-package",
      { _tag: "NotCatalogTarget" },
    )
    const selected = selectedDiscoveredPackages({
      records: new Map([stale, current]),
    })
    expect(selected.size).toBe(1)
    const candidate = [...selected.values()][0]!
    expect(candidate.package.source._tag).toBe("HuggingFace")
    if (candidate.package.source._tag === "HuggingFace") {
      expect(candidate.package.source.revision).toBe("commit-b")
    }
  })

  it("excludes_material_attributed_to_an_exact_catalog_variant", () => {
    const attributed = discoveryRecord(
      "catalog",
      "owner/repo",
      "model.gguf",
      "main",
      "commit",
      "package",
      {
        _tag: "Attributed",
        modelId: (catalogBaseId("catalog") as Exclude<ReturnType<typeof catalogBaseId>, import("@magnitudedev/icn-contracts").ModelIdError>),
        variantId: (() => {
          const variant = catalogVariantId("gguf:q4")
          if (variant instanceof ModelIdError) throw variant
          return variant
        })(),
      },
    )
    expect(
      discoveredModels({
        records: new Map([attributed]),
      }),
    ).toHaveLength(0)
  })
})

  it("prefers_the_most_recent_distinct_revision_without_a_current_ref", () => {
    const older = discoveryRecord(
      "older",
      "owner/repo",
      "model.gguf",
      "commit-a",
      "commit-a",
      "package-a",
      { _tag: "NotCatalogTarget" },
    )
    const newerRecord = discoveryRecord(
      "newer",
      "owner/repo",
      "model.gguf",
      "commit-b",
      "commit-b",
      "package-b",
      { _tag: "NotCatalogTarget" },
    )
    const newer = [newerRecord[0], { ...newerRecord[1], model: { ...newerRecord[1].model, updated_at: 2n } }] as const
    const selected = selectedDiscoveredPackages({
      records: new Map([older, newer]),
    })
    expect(selected.size).toBe(1)
    const candidate = [...selected.values()][0]!
    expect(candidate.package.source._tag).toBe("HuggingFace")
    if (candidate.package.source._tag === "HuggingFace") {
      expect(candidate.package.source.revision).toBe("commit-b")
    }
  })

  it("preserves_failed_catalog_attribution_on_a_ready_discovery", () => {
    const failed = discoveryRecord(
      "failed",
      "owner/repo",
      "model.gguf",
      "main",
      "commit",
      "package",
      {
        _tag: "Failed",
        failure: {
          code: "catalog_target_package_ambiguous",
          message: "ambiguous target",
          retryable: false,
        },
      },
    )
    const models = discoveredModels({ records: new Map([failed]) })
    expect(models).toHaveLength(1)
    expect(models[0]?.state._tag).toBe("Ready")
    if (models[0]?.state._tag === "Ready") {
      expect(models[0].state.catalogAttribution._tag).toBe("Failed")
    }
  })

  it("refreshDiscovery reloads inventory before snapshotting", async () => {
    let ensured = 0
    const discovered = new ManagedDiscoveredModels({
      revision: () => 1,
      installedPackageSnapshot: () => ({ records: new Map() }),
      installedPackagesResponse: () => ({ revision: 1, reconciliationComplete: true }),
      ensureModelInventory: async () => {
        ensured += 1
      },
    })
    await discovered.refreshDiscovery()
    expect(ensured).toBe(1)
  })
