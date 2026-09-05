import { describe, expect, it } from "vitest"
import { toWireJson } from "./wire.js"

describe("wire projection", () => {
  it("converts snake_case keys to camelCase while preserving tags", () => {
    expect(
      toWireJson({
        reconciliation_complete: true,
        local_state: { _tag: "NotInstalled" },
        source_urls: ["https://example.com"],
      }),
    ).toEqual({
      reconciliationComplete: true,
      localState: { _tag: "NotInstalled" },
      sourceUrls: ["https://example.com"],
    })
  })
})
