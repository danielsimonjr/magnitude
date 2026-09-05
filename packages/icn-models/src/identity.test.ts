import { describe, expect, it } from "vitest"
import { ContentIdentity } from "./_contracts-shim"
import { contentId, inventoryEntryId } from "./identity"

describe("identity", () => {
  const component = (path: string, digest: string) => ({
    path,
    role: "Weights" as const,
    size_bytes: 42,
    content: ContentIdentity.Sha256(digest),
    shard_index: undefined,
    relationship: undefined,
  })

  it("content identity is order independent but content sensitive", () => {
    const a = component("a.gguf", "a".repeat(64))
    const b = component("b.gguf", "b".repeat(64))
    expect(contentId([a, b])).toEqual(contentId([b, a]))
    expect(contentId([a, b])).not.toEqual(contentId([component("a.gguf", "different".padEnd(64, "x"))]))
  })
})
