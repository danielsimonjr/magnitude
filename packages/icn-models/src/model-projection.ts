import { join } from "node:path"
import {
  InventoryError,
  type EffectiveModel,
  type InstalledModelPackage,
  type ModelFailure,
  type ModelFileRole,
  type ModelInstallationOwnership,
  type ModelPackage,
  type ModelPackageId,
  type ModelPackageInstallationOrigin,
  type ModelServingConfiguration,
  type PackageValidation,
  type ReadyModel,
  type ResolvedModelInstallation,
  type ServableModelBundle,
  type ServingProfile,
} from "./_contracts-shim"

const MINIMUM_EXTERNAL_CONTEXT = 4_096

export const primaryModelPath = (installed: InstalledModelPackage): string => {
  const weights = installed.package.files
    .filter((file) => file.role === "weights")
    .map((file) => file.path)
    .sort()
  if (weights.length === 0) {
    return installed.path
  }
  return join(installed.path, weights[0]!)
}

export const resolvedInstallation = (
  installed: InstalledModelPackage,
): ResolvedModelInstallation => {
  const installedBytes = installed.package.files.reduce((sum, file) => sum + file.size_bytes, 0)
  const ownership: ModelInstallationOwnership =
    installed.origin === "magnitude" ? "Magnitude" : "ExternalHuggingFace"
  return {
    _tag: "Resolved",
    installed_bytes: installedBytes,
    primary_path: primaryModelPath(installed),
    ownership,
  }
}

const validationFailure = (installed: InstalledModelPackage): ModelFailure | undefined => {
  switch (installed.validation._tag) {
    case "Valid":
      return undefined
    case "Invalid":
    case "Unsupported":
      return installed.validation.failure
    case "Pending":
      return {
        code: "model_inspection_pending",
        message: "The selected target has not been inspected yet",
        retryable: true,
      }
  }
}

export const bundlePackages = (bundle: ServableModelBundle): readonly ModelPackage[] => {
  switch (bundle._tag) {
    case "Standalone":
      return [bundle.package]
    case "SpeculativeDecoding":
      return bundle.draft_source._tag === "Embedded"
        ? [bundle.target]
        : [bundle.target, bundle.draft_source.draft]
  }
}

export const readyModel = (bundle: ServableModelBundle, profile: ServingProfile): ReadyModel => {
  const package_ =
    bundle._tag === "Standalone" ? bundle.package : bundle.target
  return {
    metadata: {
      format: package_.properties.format,
      architecture: package_.properties.architecture,
      quantization: package_.properties.quantization,
      quantization_name: package_.properties.quantization_name,
      storage_bytes: bundlePackages(bundle).flatMap((pkg) => pkg.files).reduce((sum, file) => sum + file.size_bytes, 0),
      maximum_context_length: package_.properties.maximum_context_length ?? undefined,
    },
    profile,
    speculative_method: bundle._tag === "SpeculativeDecoding" ? bundle.method : undefined,
  }
}

export const effectiveConfigurationModel = (
  configuration: ModelServingConfiguration,
  present: ReadonlyMap<ModelPackageId, InstalledModelPackage>,
): EffectiveModel => {
  const target =
    configuration.bundle._tag === "Standalone"
      ? configuration.bundle.package
      : configuration.bundle.target
  const installedTarget = present.get(target.id)
  if (installedTarget === undefined) {
    return {
      _tag: "Unavailable",
      failure: {
        code: "model_material_missing",
        message: "The selected model target is not installed",
        retryable: true,
      },
    }
  }
  for (const package_ of bundlePackages(configuration.bundle)) {
    const installed = present.get(package_.id)
    if (installed === undefined) {
      return {
        _tag: "Unavailable",
        failure: {
          code: "model_dependency_missing",
          message: "Required model material is not installed",
          retryable: true,
        },
      }
    }
    const failure = validationFailure(installed)
    if (failure !== undefined) {
      return { _tag: "Unavailable", failure }
    }
  }
  if (configuration.profile.context_length < MINIMUM_EXTERNAL_CONTEXT) {
    return {
      _tag: "Unavailable",
      failure: {
        code: "model_context_too_small",
        message: "The selected target has no supported serving context",
        retryable: false,
      },
    }
  }
  if (installedTarget.validation._tag !== "Valid") {
    throw InventoryError.Internal({
      message: "inspection failures returned before effective model construction",
    })
  }
  return {
    _tag: "Ready",
    model: readyModel(configuration.bundle, configuration.profile),
  }
}

export const effectiveModel = (
  installed: InstalledModelPackage,
  profile: ServingProfile,
): readonly [EffectiveModel, ResolvedModelInstallation] => {
  const configuration: ModelServingConfiguration = {
    bundle: { _tag: "Standalone", package: installed.package },
    profile,
  }
  return [
    effectiveConfigurationModel(configuration, new Map([[installed.package.id, installed]])),
    resolvedInstallation(installed),
  ]
}
