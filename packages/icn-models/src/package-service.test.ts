import { describe, expect, it } from "vitest"
import { ModelPackageId, type ModelPackage } from "./_contracts-shim"
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
    const target = ModelPackageId("target")
    const draft = ModelPackageId("draft")
    const embedded = speculativeServableModelBundleKey(target, undefined, "mtp")
    const dflash = speculativeServableModelBundleKey(target, draft, "dflash")
    const dspark = speculativeServableModelBundleKey(target, draft, "dspark")
    expect(embedded.value).not.toBe(dflash.value)
    expect(dflash.value).not.toBe(dspark.value)
  })
})
