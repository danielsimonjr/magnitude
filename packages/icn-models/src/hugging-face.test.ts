import { describe, expect, it } from "vitest"
import { hubSearchUrl, requireRequestedRevision, revisionMetadataUrl } from "./hugging-face"

describe("hugging-face", () => {
  it("metadata_url_addresses_the_immutable_revision", () => {
    const revision = "a".repeat(40)
    const url = revisionMetadataUrl("https://huggingface.co/", "owner/repository", revision)
    expect(url).toBe(`https://huggingface.co/api/models/owner/repository/revision/${revision}`)
  })

  it("resolved_revision_must_equal_the_requested_revision", () => {
    const requested = "a".repeat(40)
    expect(() => requireRequestedRevision(requested, requested)).not.toThrow()
    expect(() => requireRequestedRevision(requested, "b".repeat(40))).toThrow()
    expect(() => requireRequestedRevision(requested, undefined)).toThrow()
  })

  it("search_url_includes_gguf_filter_and_expand_fields", () => {
    const url = hubSearchUrl("https://huggingface.co", "qwen", 5)
    expect(url).toContain("https://huggingface.co/api/models?")
    expect(url).toContain("search=qwen")
    expect(url).toContain("filter=gguf")
    expect(url).toContain("limit=5")
    expect(url).toContain("expand=sha")
  })
})
