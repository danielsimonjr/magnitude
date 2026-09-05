import {
  CatalogBaseId,
  CatalogVariantId,
  ModelId,
  ModelReleaseDate,
  type CatalogModel,
  type CatalogModelState,
  type CatalogModelUpdate,
  type CatalogPackageAffiliation,
  type CatalogPackageRole,
  type EffectiveModel,
  type InstalledModelPackage,
  type ModelFailure,
  type ModelInstallation,
  type ModelInstallationOwnership,
  type ModelPackage,
  type ModelPackageId,
  type ModelPackageInstallationOrigin,
  type ModelServingConfiguration,
  type PackageValidation,
  type RecommendableModel,
  type RecommendableModelCatalog,
  type ServableModelBundle,
  type ServingProfile,
} from "./_contracts-shim"
import { catalogPackages, catalogTarget, type InstalledPackageSnapshot } from "./inventory"
import {
  bundlePackages,
  effectiveConfigurationModel,
  primaryModelPath,
  readyModel,
  resolvedInstallation,
} from "./model-projection"

export interface CatalogRemovalPlan {
  package_ids: readonly ModelPackageId[]
  installed: boolean
  externally_owned: boolean
  shared: boolean
}

export const removalPlan = (
  ids: ReadonlySet<ModelPackageId>,
  targetIds: ReadonlySet<ModelPackageId>,
  externalIds: ReadonlySet<ModelPackageId>,
  sharedIds: ReadonlySet<ModelPackageId>,
): CatalogRemovalPlan => ({
  package_ids:
    targetIds.size === 0
      ? []
      : [...ids].filter((packageId) => !externalIds.has(packageId) && !sharedIds.has(packageId)),
  installed: targetIds.size > 0,
  externally_owned: [...targetIds].some((packageId) => externalIds.has(packageId)),
  shared: [...targetIds].some((packageId) => sharedIds.has(packageId)),
})

const catalogId = (definition: RecommendableModel): ModelId =>
  ModelId.catalog(definition.model_id, definition.variant_id)

interface InstallationOrigins {
  magnitude: boolean
  external: boolean
}

const includeOrigin = (origins: InstallationOrigins, origin: ModelPackageInstallationOrigin): void => {
  if (origin === "magnitude") {
    origins.magnitude = true
  } else {
    origins.external = true
  }
}

type CatalogMaterialState =
  | { readonly _tag: "NotInstalled" }
  | {
      readonly _tag: "Installed"
      selected_target?: InstalledModelPackage
      configuration?: ModelServingConfiguration
      effective: EffectiveModel
    }

interface CatalogResolution {
  installed_packages: readonly InstalledModelPackage[]
  missing_desired_package_ids: readonly ModelPackageId[]
  superseded_package_ids: readonly ModelPackageId[]
  required_download_bytes: number
  state: CatalogMaterialState
}

export const catalogResolution = (
  definition: RecommendableModel,
  present: ReadonlyMap<ModelPackageId, InstalledModelPackage>,
  affiliations: readonly CatalogPackageAffiliation[],
): CatalogResolution => {
  const desiredPackages = [...catalogPackages(definition)]
  const desiredIds = new Set(desiredPackages.map(([package_]) => package_.id))
  const missingDesiredPackageIds = [...desiredIds].filter((packageId) => !present.has(packageId))
  const requiredDownloadBytes = desiredPackages
    .filter(([package_]) => !present.has(package_.id))
    .flatMap(([package_]) => package_.files)
    .reduce((sum, file) => sum + file.size_bytes, 0)
  const supersededPackageIds = affiliations
    .filter(
      (affiliation) =>
        affiliation.model_id === definition.model_id &&
        affiliation.variant_id === definition.variant_id &&
        !desiredIds.has(affiliation.package_id) &&
        present.has(affiliation.package_id),
    )
    .map((affiliation) => affiliation.package_id)
  const installedPackages = [...present.values()].filter((entry) => {
    if (missingDesiredPackageIds.length === 0) {
      return desiredIds.has(entry.package.id)
    }
    return (
      desiredIds.has(entry.package.id) ||
      (entry.catalog_attribution._tag === "Attributed" &&
        entry.catalog_attribution.model_id === definition.model_id &&
        entry.catalog_attribution.variant_id === definition.variant_id) ||
      affiliations.some(
        (affiliation) =>
          affiliation.model_id === definition.model_id &&
          affiliation.variant_id === definition.variant_id &&
          affiliation.package_id === entry.package.id,
      )
    )
  })
  const targets = [...present.values()].filter(
    (entry) =>
      entry.package.id === catalogTarget(definition).id ||
      (entry.catalog_attribution._tag === "Attributed" &&
        entry.catalog_attribution.model_id === definition.model_id &&
        entry.catalog_attribution.variant_id === definition.variant_id) ||
      affiliations.some(
        (affiliation) =>
          affiliation.model_id === definition.model_id &&
          affiliation.variant_id === definition.variant_id &&
          affiliation.package_id === entry.package.id &&
          affiliation.role === "Target",
      ),
  )
  const desiredTarget = targets.find((entry) => entry.package.id === catalogTarget(definition).id)
  const selectedTarget =
    desiredTarget ?? (targets.length === 1 ? targets[0] : undefined)
  let state: CatalogMaterialState
  if (targets.length === 0) {
    state = { _tag: "NotInstalled" }
  } else if (missingDesiredPackageIds.length === 0) {
    const configuration = definition.configuration
    state = {
      _tag: "Installed",
      selected_target: desiredTarget,
      configuration,
      effective: effectiveConfigurationModel(configuration, present),
    }
  } else if (selectedTarget !== undefined) {
    const configuration: ModelServingConfiguration = {
      bundle: { _tag: "Standalone", package: selectedTarget.package },
      profile: definition.configuration.profile,
    }
    state = {
      _tag: "Installed",
      selected_target: selectedTarget,
      configuration,
      effective: effectiveConfigurationModel(configuration, present),
    }
  } else {
    state = {
      _tag: "Installed",
      effective: {
        _tag: "Unavailable",
        failure: {
          code: "catalog_installed_targets_ambiguous",
          message:
            "Multiple superseded catalog targets are installed and no current target is present",
          retryable: true,
        },
      },
    }
  }
  return {
    installed_packages: installedPackages,
    missing_desired_package_ids: missingDesiredPackageIds,
    superseded_package_ids: supersededPackageIds,
    required_download_bytes: requiredDownloadBytes,
    state,
  }
}

const installation = (
  installed: readonly InstalledModelPackage[],
  selectedTarget: InstalledModelPackage | undefined,
  occurrenceOrigins: ReadonlyMap<ModelPackageId, InstallationOrigins>,
): ModelInstallation => {
  const installedBytes = installed.reduce(
    (sum, entry) => sum + entry.package.files.reduce((fileSum, file) => fileSum + file.size_bytes, 0),
    0,
  )
  const origins = installed.reduce<InstallationOrigins>(
    (accumulator, entry) => {
      const occurrences = occurrenceOrigins.get(entry.package.id)
      if (occurrences !== undefined) {
        accumulator.magnitude ||= occurrences.magnitude
        accumulator.external ||= occurrences.external
      } else {
        includeOrigin(accumulator, entry.origin)
      }
      return accumulator
    },
    { magnitude: false, external: false },
  )
  const ownership: ModelInstallationOwnership =
    origins.magnitude && origins.external
      ? "Mixed"
      : origins.external
        ? "ExternalHuggingFace"
        : "Magnitude"
  if (selectedTarget !== undefined) {
    return {
      _tag: "Resolved",
      installed_bytes: installedBytes,
      primary_path: primaryModelPath(selectedTarget),
      ownership,
    }
  }
  return {
    _tag: "Unresolved",
    installed_bytes: installedBytes,
    ownership,
  }
}

export const catalogModel = (
  definition: RecommendableModel,
  present: ReadonlyMap<ModelPackageId, InstalledModelPackage>,
  affiliations: readonly CatalogPackageAffiliation[],
  occurrenceOrigins: ReadonlyMap<ModelPackageId, InstallationOrigins>,
): CatalogModel => {
  const resolution = catalogResolution(definition, present, affiliations)
  const sourceUrls = [
    ...new Set(
      bundlePackages(definition.configuration.bundle)
        .flatMap((package_) =>
          package_.source._tag === "HuggingFace"
            ? [`https://huggingface.co/${package_.source.repository}`]
            : [],
        ),
    ),
  ]
  const localState: CatalogModelState =
    resolution.state._tag === "NotInstalled"
      ? { _tag: "NotInstalled" }
      : {
          _tag: "Installed",
          effective: resolution.state.effective,
          installation: installation(
            resolution.installed_packages,
            resolution.state._tag === "Installed" ? resolution.state.selected_target : undefined,
            occurrenceOrigins,
          ),
          update_state:
            resolution.required_download_bytes === 0
              ? ({ _tag: "Current" } satisfies CatalogModelUpdate)
              : {
                  _tag: "Available",
                  required_download_bytes: resolution.required_download_bytes,
                },
        }
  return {
    id: catalogId(definition),
    desired: readyModel(definition.configuration.bundle, definition.configuration.profile),
    display_name: definition.display_name,
    variant_label: definition.variant_label,
    description: definition.description,
    release_date: definition.release_date,
    license: definition.license,
    source_urls: sourceUrls,
    parameterization: definition.parameterization,
    intelligence: definition.intelligence,
    fidelity_rank: definition.fidelity_rank,
    quantization_aware: definition.quantization_aware,
    local_state: localState,
  }
}

export class ModelDomainResolver {
  constructor(
    readonly inventory: {
      installedPackagesResponse(): {
        revision: number
        reconciliation_complete: boolean
        packages: readonly InstalledModelPackage[]
      }
      catalogAffiliations(): readonly CatalogPackageAffiliation[]
      installedOrigins?(): ReadonlyMap<ModelPackageId, { magnitude: boolean; external: boolean }>
    },
    readonly catalog: RecommendableModelCatalog,
  ) {}

  catalogDefinition(id: ModelId): RecommendableModel {
    const definition = this.catalog.models.find((candidate) => catalogId(candidate) === id)
    if (definition === undefined) {
      throw new Error(`model not found: ${id}`)
    }
    return definition
  }

  revision(): number {
    return this.inventory.installedPackagesResponse().revision
  }

  catalogSnapshot(): {
    revision: number
    reconciliation_complete: boolean
    models: CatalogModel[]
  } {
    const installed = this.inventory.installedPackagesResponse()
    const present = new Map(installed.packages.map((entry) => [entry.package.id, entry]))
    const affiliations = this.inventory.catalogAffiliations()
    const occurrenceOrigins = this.inventory.installedOrigins?.() ?? new Map()
    return {
      revision: installed.revision,
      reconciliation_complete: installed.reconciliation_complete,
      models: this.catalog.models.map((definition) =>
        catalogModel(definition, present, affiliations, occurrenceOrigins),
      ),
    }
  }

  catalogRemovalPlan(id: ModelId): CatalogRemovalPlan {
    const definition = this.catalogDefinition(id)
    const installed = this.inventory.installedPackagesResponse()
    const affiliations = this.inventory.catalogAffiliations()
    const ids = new Set(
      installed.packages
        .filter(
          (entry) =>
            catalogPackages(definition).some(([package_]) => package_.id === entry.package.id) ||
            affiliations.some(
              (affiliation) =>
                affiliation.model_id === definition.model_id &&
                affiliation.variant_id === definition.variant_id &&
                affiliation.package_id === entry.package.id,
            ),
        )
        .map((entry) => entry.package.id),
    )
    const externalIds = new Set(
      installed.packages
        .filter((entry) => ids.has(entry.package.id) && entry.origin === "hugging_face_cache")
        .map((entry) => entry.package.id),
    )
    const sharedIds = new Set(
      [...ids].filter(
        (packageId) =>
          affiliations.some(
            (affiliation) =>
              affiliation.package_id === packageId &&
              (affiliation.model_id !== definition.model_id ||
                affiliation.variant_id !== definition.variant_id),
          ) ||
          this.catalog.models.some(
            (candidate) =>
              catalogId(candidate) !== id &&
              catalogPackages(candidate).some(([package_]) => package_.id === packageId),
          ),
      ),
    )
    const targetIds = new Set(
      [...ids].filter(
        (packageId) =>
          packageId === catalogTarget(definition).id ||
          affiliations.some(
            (affiliation) =>
              affiliation.model_id === definition.model_id &&
              affiliation.variant_id === definition.variant_id &&
              affiliation.package_id === packageId &&
              affiliation.role === "Target",
          ),
      ),
    )
    return removalPlan(ids, targetIds, externalIds, sharedIds)
  }

  catalogCleanupPackageIds(id: ModelId): readonly ModelPackageId[] {
    const definition = this.catalogDefinition(id)
    const installed = this.inventory.installedPackagesResponse()
    const present = new Map(installed.packages.map((entry) => [entry.package.id, entry]))
    const affiliations = this.inventory.catalogAffiliations()
    const resolution = catalogResolution(definition, present, affiliations)
    if (resolution.missing_desired_package_ids.length > 0) {
      return []
    }
    return resolution.superseded_package_ids.filter(
      (packageId) =>
        present.get(packageId)?.origin === "magnitude" &&
        !this.catalog.models.some(
          (candidate) =>
            catalogId(candidate) !== id &&
            catalogPackages(candidate).some(([package_]) => package_.id === packageId),
        ) &&
        !affiliations.some(
          (affiliation) =>
            affiliation.package_id === packageId &&
            (affiliation.model_id !== definition.model_id ||
              affiliation.variant_id !== definition.variant_id),
        ),
    )
  }
}

export class ManagedCatalogModels {
  constructor(private readonly resolver: ModelDomainResolver) {}

  listCatalog(): { revision: number; reconciliation_complete: boolean; models: CatalogModel[] } {
    const installed = this.resolver.inventory.installedPackagesResponse()
    const present = new Map(installed.packages.map((entry) => [entry.package.id, entry]))
    const affiliations = this.resolver.inventory.catalogAffiliations()
    return {
      revision: installed.revision,
      reconciliation_complete: installed.reconciliation_complete,
      models: this.resolver.catalog.models.map((definition) =>
        catalogModel(definition, present, affiliations, new Map()),
      ),
    }
  }
}

export const testDefinition = (
  bundle: ServableModelBundle,
  profile: ServingProfile = { context_length: 32_768 },
): RecommendableModel => ({
  model_id: CatalogBaseId.new("catalog"),
  variant_id: CatalogVariantId.new("gguf:q4"),
  configuration: { bundle, profile },
  display_name: "Catalog",
  variant_label: "Q4",
  description: "Catalog model",
  release_date: ModelReleaseDate.new("2026-01-01"),
  license: "test",
  parameterization: { architecture: "dense", totalParameters: 1_000_000 },
  intelligence: {
    score: 1,
    provenance: {
      kind: "artificialAnalysisIntelligenceIndex",
      methodologyVersion: "test",
      asOfDate: "2026-01-01",
      url: "https://example.com/model",
    },
  },
  fidelity_rank: 1,
  quantization_aware: false,
})

export const testPackage = (id: string, bytes: number): ModelPackage => ({
  id: id as ModelPackageId,
  source: { _tag: "Local", path: `/${id}.gguf` },
  files: [
    {
      id: `file-${id}` as import("./_contracts-shim").ModelFileId,
      path: `${id}.gguf`,
      role: "weights",
      size_bytes: bytes,
      tensor_storage_bytes: bytes,
      sha256: "a".repeat(64),
    },
  ],
  relationships: [],
  properties: {
    format: "gguf",
    quantization: "Q4_K_M",
    quantization_name: "4-bit",
    architecture: "test",
    maximum_context_length: 32_768,
    intrinsic_model_id: "catalog",
    intrinsic_quality_id: "Q4",
  },
})

export const testInstalled = (
  package_: ModelPackage,
  origin: ModelPackageInstallationOrigin = "magnitude",
): InstalledModelPackage => ({
  path: `/installed/${package_.id}`,
  package: package_,
  origin,
  validation: { _tag: "Valid" },
  catalog_attribution: { _tag: "NotCatalogTarget" },
})

export const testAffiliation = (
  packageId: ModelPackageId,
  role: CatalogPackageRole,
): CatalogPackageAffiliation => ({
  model_id: CatalogBaseId.new("catalog"),
  variant_id: CatalogVariantId.new("gguf:q4"),
  package_id: packageId,
  repository: "owner/repo",
  role,
})
