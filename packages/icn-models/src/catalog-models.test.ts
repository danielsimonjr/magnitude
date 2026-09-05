import { describe, expect, it } from "vitest"
import { modelPackageId, type ModelPackageId } from "@magnitudedev/icn-contracts"
import {
  catalogModel,
  catalogResolution,
  removalPlan,
  testAffiliation,
  testDefinition,
  testInstalled,
  testPackage,
} from "./catalog-models"
import { resolvedInstallation } from "./model-projection"

describe("catalog-models", () => {
  it("removal_retains_protected_dependencies_without_blocking_a_managed_target", () => {
    const target = modelPackageId("target") 
    const externalDependency = modelPackageId("external-dependency") 
    const sharedDependency = modelPackageId("shared-dependency") 
    const ids = new Set([target, externalDependency, sharedDependency])
    const plan = removalPlan(
      ids,
      new Set([target]),
      new Set([externalDependency]),
      new Set([sharedDependency]),
    )
    expect(plan.installed).toBe(true)
    expect(plan.externally_owned).toBe(false)
    expect(plan.shared).toBe(false)
    expect(plan.package_ids).toEqual([target])
  })

  it("catalog_resolution_with_no_installed_target_is_not_installed", () => {
    const definition = testDefinition({
      _tag: "Standalone",
      package: testPackage(modelPackageId("target"), 20),
    })
    const resolution = catalogResolution(definition, new Map(), [])
    expect(resolution.state._tag).toBe("NotInstalled")
  })

  it("prior_target_remains_ready_while_desired_material_is_missing", () => {
    const desired = testPackage("desired", 20)
    const prior = testInstalled(testPackage("prior", 10))
    const present = new Map([[prior.package.id, prior]])
    const model = catalogModel(
      testDefinition({ _tag: "Standalone", package: desired }),
      present,
      [testAffiliation(prior.package.id, "Target")],
      new Map(),
    )
    expect(model.localState._tag).toBe("Installed")
    if (model.localState._tag === "Installed") {
      expect(model.localState.effective._tag).toBe("Ready")
      expect(model.localState.updateState).toEqual({
        _tag: "Available",
        requiredDownloadBytes: 20,
      })
    }
  })

  it("desired_target_falls_back_to_standalone_until_separate_draft_is_installed", () => {
    const targetPackage = testPackage(modelPackageId("target"), 20)
    const draftPackage = testPackage("draft", 5)
    const target = testInstalled(targetPackage)
    const definition = testDefinition({
      _tag: "SpeculativeDecoding",
      target: targetPackage,
      draftSource: { _tag: "Separate", draft: draftPackage },
      method: { _tag: "DFlash" },
    })
    const resolution = catalogResolution(definition, new Map([[target.package.id, target]]), [])
    expect(resolution.state._tag).toBe("Installed")
    if (resolution.state._tag === "Installed") {
      expect(resolution.state.configuration?.bundle._tag).toBe("Standalone")
      expect(resolution.requiredDownloadBytes).toBe(5)
    }
  })

  it("resolved_installation_points_to_the_primary_model_file", () => {
    const installed = testInstalled(testPackage(modelPackageId("model"), 20), "HuggingFaceCache")
    const resolved = resolvedInstallation({ ...installed, path: "/tmp/model" })
    expect(resolved._tag).toBe("Resolved")
    if (resolved._tag === "Resolved") {
      expect(resolved.primaryPath).toBe("/tmp/model/model.gguf")
    }
  })
})
