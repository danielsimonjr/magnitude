import { describe, expect, it } from "vitest"
import { Option } from "effect"
import { contentIdentity } from "@magnitudedev/icn-contracts"
import { contentId } from "./identity"

describe("identity", () => {
  const component = (path: string, digest: string) => ({
    path,
    role: "weights" as const,
    size_bytes: 42n,
    content: contentIdentity.sha256(digest),
    shard_index: Option.none(),
    relationship: Option.none(),
  })

  it("content identity is order independent but content sensitive", () => {
    const a = component("a.gguf", "a".repeat(64))
    const b = component("b.gguf", "b".repeat(64))
    expect(contentId([a, b])).toEqual(contentId([b, a]))
    expect(contentId([a, b])).not.toEqual(contentId([component("a.gguf", "different".padEnd(64, "x"))]))
  })
})
