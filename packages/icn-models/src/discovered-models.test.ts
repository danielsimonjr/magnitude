import { describe, expect, it } from "vitest"
import { CatalogBaseId, CatalogVariantId } from "./_contracts-shim"
import { type InstalledPackageSnapshot } from "./inventory"
import { discoveredModels, discoveryRecord, selectedDiscoveredPackages } from "./discovered-models"

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
        model_id: CatalogBaseId.new("catalog"),
        variant_id: CatalogVariantId.new("gguf:q4"),
      },
    )
    expect(
      discoveredModels({
        records: new Map([attributed]),
      }),
    ).toHaveLength(0)
  })
})
