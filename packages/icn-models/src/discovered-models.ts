import { Option } from "effect"
import {
  contentIdentity,
  huggingFaceArtifactSelector,
  huggingFaceRepositoryId,
  makeContentId,
  makeInventoryEntryId,
  modelFileId,
  modelPackageId,
  ModelId,
  ModelIdError,
  type InstalledCatalogAttribution,
  type InstalledModelPackage,
  type InventoryEntryId,
  type InventoryModel,
  type ModelFile,
  type ModelPackage,
  type ModelPackageProperties,
} from "@magnitudedev/icn-contracts"
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
  const selected = new Map<string, DiscoveryCandidate>()
  for (const record of installed.records.values()) {
    if (record.installed.origin !== "HuggingFaceCache") {
      continue
    }
    if (record.model.source.type !== "hugging_face") {
      continue
    }
    const selector = record.installed.package.files
      .filter((file) => file.role === "weights")
      .map((file) => file.path)
      .sort()[0]
    if (selector === undefined) {
      continue
    }
    const artifactSelector = huggingFaceArtifactSelector(selector)
    const repositoryId = huggingFaceRepositoryId(record.model.source.repository)
    if (artifactSelector instanceof ModelIdError || repositoryId instanceof ModelIdError) {
      continue
    }
    const id = ModelId.huggingFace(repositoryId, artifactSelector)
    const candidate: DiscoveryCandidate = {
      package: record.installed,
      commit: record.model.source.commit,
      current: record.model.source.requested_revision === "main",
      modified_at: Number(record.model.updated_at),
    }
    const existing = selected.get(id.value)
    if (existing === undefined || comparePreference(candidate, existing) > 0) {
      selected.set(id.value, candidate)
    }
  }
  return new Map(
    [...selected.entries()].map(([id, candidate]) => [ModelId.fromString(id) as ModelId, candidate.package]),
  )
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
  contextLength: Math.min(
    Option.getOrElse(installed.package.properties.maximumContextLength, () => DEFAULT_EXTERNAL_CONTEXT),
    DEFAULT_EXTERNAL_CONTEXT,
  ),
})

export const discoveredModels = (installed: InstalledPackageSnapshot) =>
  [...selectedDiscoveredPackages(installed).entries()].flatMap(([id, selected]) => {
    const catalogAttribution = matchCatalogAttribution(selected.catalogAttribution)
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
                catalogAttribution,
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
    id: modelFileId(`file-${packageId}`),
    path: selector,
    role: "weights",
    sizeBytes: 10,
    tensorStorageBytes: Option.some(10),
    sha256: "a".repeat(64),
  }
  const package_: ModelPackage = {
    id: modelPackageId(packageId),
    source: { _tag: "HuggingFace", repository, revision: commit },
    files: [modelFile],
    relationships: [],
    properties: {
      format: "gguf",
      quantization: "Q4_K_M",
      quantizationName: "4-bit",
      architecture: "test",
      maximumContextLength: Option.some(32_768),
      intrinsicModelId: Option.none(),
      intrinsicQualityId: Option.none(),
    } satisfies ModelPackageProperties,
  }
  const installed: InstalledModelPackage = {
    path: `/cache/${occurrence}/${selector}`,
    package: package_,
    origin: "HuggingFaceCache",
    validation: { _tag: "Valid" },
    catalogAttribution,
  }
  const id = makeInventoryEntryId(occurrence)
  const model: InventoryModel = {
    id,
    content_id: makeContentId(`content-${occurrence}`),
    created: 1n,
    name: selector,
    supported_parameters: [],
    availability: { type: "available", ready_at: 1n },
    source: {
      type: "hugging_face",
      repository,
      requested_revision: requestedRevision,
      commit,
      metadata: Option.none(),
    },
    location: {
      type: "hugging_face_cache",
      cache_root: `/cache/${occurrence}`,
      repository,
      commit,
      components: [
        {
          path: selector,
          role: "weights",
          size_bytes: 10n,
          content: contentIdentity.sha256("a".repeat(64)),
          shard_index: Option.none(),
          relationship: Option.none(),
        },
      ],
      total_bytes: 10n,
      integrity: { type: "unverified", reason: "test" },
    },
    properties: { type: "pending" },
    operations: [],
    updated_at: 1n,
  }
  return [id, { installed, model }]
}

export class ManagedDiscoveredModels {
  constructor(
    private readonly resolver: {
      revision(): number
      snapshot(): InstalledPackageSnapshot
      ensureInstalledModelInventory?(): Promise<void>
      ensureModelInventory?(): Promise<void>
    },
  ) {}

  snapshot() {
    return {
      revision: BigInt(this.resolver.revision()),
      reconciliationComplete: true,
      models: discoveredModels(this.resolver.snapshot()),
    }
  }

  /** Re-snapshots discovery after optionally ensuring inventory is current. */
  async refreshDiscovery() {
    if (this.resolver.ensureInstalledModelInventory !== undefined) {
      await this.resolver.ensureInstalledModelInventory()
    } else if (this.resolver.ensureModelInventory !== undefined) {
      await this.resolver.ensureModelInventory()
    }
    return this.snapshot()
  }
}
