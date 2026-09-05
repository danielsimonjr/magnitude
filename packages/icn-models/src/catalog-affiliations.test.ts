import { mkdirSync, writeFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CatalogAffiliations } from "./catalog-affiliations"

describe("catalog-affiliations", () => {
  it("malformed_entries_are_isolated_and_round_trip_deterministically", () => {
    const root = mkdtempSync(join(tmpdir(), "catalog-affiliations-"))
    writeFileSync(
      join(root, "catalog-affiliations.json"),
      `{
        "unknown": true,
        "affiliations": [
          {"modelId":"model","variantId":"gguf:q4","packageId":"package","repository":"owner/repo","role":"Target"},
          {"modelId":"model","variantId":"gguf:q4","packageId":"package","repository":"owner/repo","role":"Target"},
          {"modelId":"bad:id","variantId":"gguf:q8","packageId":"other","repository":"owner/other","role":"Target"},
          {"modelId":"other","variantId":"invalid","packageId":"other","repository":"owner/other","role":"Dependency"}
        ]
      }`,
    )
    const affiliations = CatalogAffiliations.load(root)
    expect(affiliations.entries()).toHaveLength(1)
    affiliations.persist(root)
    expect(CatalogAffiliations.load(root).equals(affiliations)).toBe(true)
    mkdirSync(root, { recursive: true })
  })
})
