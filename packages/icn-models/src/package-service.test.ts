import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { modelPackageId, type ModelPackage } from "@magnitudedev/icn-contracts"
import {
  packageValidationFor,
  packageRelationship,
  shardCount,
  speculativeServableModelBundleKey,
} from "./package-service"

describe("package-service", () => {
  it("shard count uses one-based component indices", () => {
    expect(shardCount([1, 2, 3])).toBe(3)
    expect(shardCount([undefined, undefined])).toBe(0)
  })

  it("speculative bundle identity includes source method and separate draft", () => {
    const target = modelPackageId("target")
    const draft = modelPackageId("draft")
    const embedded = speculativeServableModelBundleKey(target, undefined, { _tag: "Mtp" })
    const dflash = speculativeServableModelBundleKey(target, draft, { _tag: "DFlash" })
    const dspark = speculativeServableModelBundleKey(target, draft, { _tag: "DSpark" })
    expect(embedded.value).not.toBe(dflash.value)
    expect(dflash.value).not.toBe(dspark.value)
  })
})
