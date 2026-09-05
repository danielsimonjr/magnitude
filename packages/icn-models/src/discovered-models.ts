import {
  CatalogBaseId,
  CatalogVariantId,
  HuggingFaceArtifactSelector,
  HuggingFaceRepositoryId,
  ModelId,
  type ContentId,
  type InstalledCatalogAttribution,
  type InstalledModelPackage,
  type InventoryEntryId,
  type InventoryModel,
  type ModelFile,
  type ModelFileId,
  type ModelPackage,
  type ModelPackageId,
  type ModelPackageProperties,
  type ModelPackageSource,
  type PackageValidation,
  ComponentRole,
  ContentIdentity,
  Integrity,
  ModelAvailability,
  ModelLocation,
  ModelSource,
} from "./_contracts-shim"
import { type InstalledPackageSnapshot } from "./inventory"
import { effectiveModel } from "./model-projection"

const DEFAULT_EXTERNAL_CONTEXT = 100_000

interface DiscoveryCandidate {
  package: InstalledModelPackage
  commit: string
  current: boolean
  modified_at: number
}

const candidatePreference = (
  candidate: DiscoveryCandidate,
): readonly [boolean, number, string] => [candidate.current, candidate.modified_at, candidate.commit]

export const selectedDiscoveredPackages = (
  installed: InstalledPackageSnapshot,
): Map<ModelId, InstalledModelPackage> => {
  const selected = new Map<ModelId, DiscoveryCandidate>()
  for (const record of installed.records.values()) {
    if (record.installed.origin !== "hugging_face_cache") {
      continue
    }
    if (record.model.source._tag !== "HuggingFace") {
      continue
    }
    const selector = record.installed.package.files
      .filter((file) => file.role === "weights")
      .map((file) => file.path)
      .sort()[0]
    if (selector === undefined) {
      continue
    }
    let artifactSelector: ReturnType<typeof HuggingFaceArtifactSelector.new>
    let repositoryId: ReturnType<typeof HuggingFaceRepositoryId.new>
    try {
      artifactSelector = HuggingFaceArtifactSelector.new(selector)
      repositoryId = HuggingFaceRepositoryId.new(record.model.source.repository)
    } catch {
      continue
    }
    const id = ModelId.huggingFace(repositoryId, artifactSelector)
    const candidate: DiscoveryCandidate = {
      package: record.installed,
      commit: record.model.source.commit,
      current: record.model.source.requested_revision === "main",
      modified_at: record.model.updated_at,
    }
    const existing = selected.get(id)
    if (existing === undefined || comparePreference(candidate, existing) > 0) {
      selected.set(id, candidate)
    }
  }
  return new Map([...selected.entries()].map(([id, candidate]) => [id, candidate.package]))
}

const comparePreference = (left: DiscoveryCandidate, right: DiscoveryCandidate): number => {
  const [leftCurrent, leftModified, leftCommit] = candidatePreference(left)
  const [rightCurrent, rightModified, rightCommit] = candidatePreference(right)
  if (leftCurrent !== rightCurrent) {
    return leftCurrent ? 1 : -1
  }
  if (leftModified !== rightModified) {
    return leftModified > rightModified ? 1 : -1
  }
  return leftCommit.localeCompare(rightCommit)
}

export const discoveredProfile = (installed: InstalledModelPackage) => ({
  context_length: Math.min(
    installed.package.properties.maximum_context_length ?? DEFAULT_EXTERNAL_CONTEXT,
    DEFAULT_EXTERNAL_CONTEXT,
  ),
})

export const discoveredModels = (installed: InstalledPackageSnapshot) =>
  [...selectedDiscoveredPackages(installed).entries()].flatMap(([id, selected]) => {
    const catalogAttribution = matchCatalogAttribution(selected.catalog_attribution)
    if (catalogAttribution === null) {
      return []
    }
    const profile = discoveredProfile(selected)
    const [effective, installation] = effectiveModel(selected, profile)
    return [
      {
        id,
        state:
          effective._tag === "Ready"
            ? {
                _tag: "Ready" as const,
                installation,
                model: effective.model,
                catalog_attribution: catalogAttribution,
              }
            : {
                _tag: "Unavailable" as const,
                installation,
                failure: effective.failure,
              },
      },
    ]
  })

const matchCatalogAttribution = (
  attribution: InstalledCatalogAttribution,
): { _tag: "NotInCatalog" } | { _tag: "Failed"; failure: { code: string } } | null => {
  switch (attribution._tag) {
    case "NotCatalogTarget":
      return { _tag: "NotInCatalog" }
    case "Failed":
      return { _tag: "Failed", failure: attribution.failure }
    case "Attributed":
      return null
  }
}

export const discoveryRecord = (
  occurrence: string,
  repository: string,
  selector: string,
  requestedRevision: string,
  commit: string,
  packageId: string,
  catalogAttribution: InstalledCatalogAttribution,
): [InventoryEntryId, { installed: InstalledModelPackage; model: InventoryModel }] => {
  const modelFile: ModelFile = {
    id: `file-${packageId}` as ModelFileId,
    path: selector,
    role: "weights",
    size_bytes: 10,
    tensor_storage_bytes: 10,
    sha256: "a".repeat(64),
  }
  const package_: ModelPackage = {
    id: packageId as ModelPackageId,
    source: { _tag: "HuggingFace", repository, revision: commit },
    files: [modelFile],
    relationships: [],
    properties: {
      format: "gguf",
      quantization: "Q4_K_M",
      quantization_name: "4-bit",
      architecture: "test",
      maximum_context_length: 32_768,
      intrinsic_model_id: null,
      intrinsic_quality_id: null,
    } satisfies ModelPackageProperties,
  }
  const installed: InstalledModelPackage = {
    path: `/cache/${occurrence}/${selector}`,
    package: package_,
    origin: "hugging_face_cache",
    validation: { _tag: "Valid" },
    catalog_attribution: catalogAttribution,
  }
  const id = occurrence as InventoryEntryId
  const model: InventoryModel = {
    id,
    content_id: `content-${occurrence}` as ContentId,
    created: 1,
    name: selector,
    supported_parameters: [],
    availability: { _tag: "Available", ready_at: 1 },
    source: {
      _tag: "HuggingFace",
      repository,
      requested_revision: requestedRevision,
      commit,
      metadata: null,
    } satisfies ModelSource,
    location: {
      _tag: "HuggingFaceCache",
      cache_root: `/cache/${occurrence}`,
      repository,
      commit,
      components: [
        {
          path: selector,
          role: "Weights" satisfies ComponentRole,
          size_bytes: 10,
          content: ContentIdentity.Sha256("a".repeat(64)),
        },
      ],
      total_bytes: 10,
      integrity: { _tag: "Unverified", reason: "test" } satisfies Integrity,
    } satisfies ModelLocation,
    properties: { _tag: "Pending" },
    operations: [],
    updated_at: 1,
  }
  return [id, { installed, model }]
}

export class ManagedDiscoveredModels {
  constructor(
    private readonly resolver: {
      revision(): number
      snapshot(): InstalledPackageSnapshot
    },
  ) {}

  snapshot() {
    return {
      revision: this.resolver.revision(),
      reconciliation_complete: true,
      models: discoveredModels(this.resolver.snapshot()),
    }
  }
}
