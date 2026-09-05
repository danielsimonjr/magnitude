import { readFileSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CatalogBaseId,
  catalogBaseId,
  catalogVariantId,
  CatalogVariantId,
  contentIdentity,
  InventoryError,
  isValidIsoDate,
  modelReleaseDate,
  type HuggingFaceRepositorySnapshot,
  type IntelligenceProvenance,
  type ModelPackage,
  type ModelPackageSource,
  type ModelParameterization,
  type RecommendableModelCatalog,
  type ServableModelBundle,
} from "@magnitudedev/icn-contracts"
import { Option } from "effect"
import { PlannerBundle } from "./planner-bundle"
import { ServableModelBundleKey, servableModelBundleKeyForBundle } from "./package-service"

const CATALOG_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../inference/catalog")
const CATALOG_SOURCE = readFileSync(join(CATALOG_DIR, "models.json"), "utf8")
const CATALOG_LOCK = readFileSync(join(CATALOG_DIR, "models.lock.json"), "utf8")
const MIN_CATALOG_CONTEXT_LENGTH = 4_096
const MAX_PLANNER_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024

interface CatalogVariant {
  variantId: string
  format: string
  variantLabel: string
  fidelityRank: number
  quantizationAware: boolean
}

interface CatalogProjectorSource {
  path: string
}

type CatalogSpeculativeMethod = "mtp" | "dflash" | "dspark"

type CatalogSpeculativeDraftSource =
  | { readonly type: "embedded" }
  | { readonly type: "file"; repository?: string; path: string }

interface CatalogSpeculativeDecoding {
  method: CatalogSpeculativeMethod
  draft: CatalogSpeculativeDraftSource
}

interface CatalogModelDeclaration {
  id: string
  displayName: string
  description: string
  releaseDate: string
  parameterization: ModelParameterization
  repository: string
  variants: CatalogVariant[]
  contextLength: number
  projector?: CatalogProjectorSource
  speculativeDecoding?: CatalogSpeculativeDecoding
  license: string
  intelligence: {
    score: number
    provenance: IntelligenceProvenance
  }
}

interface CatalogSource {
  models: CatalogModelDeclaration[]
}

export interface ModelCatalogLockEntry {
  target: string
  speculativeDraft?: string
}

export type ModelCatalogLock = Readonly<Record<string, ModelCatalogLockEntry>>

export interface ReleaseCatalog {
  catalog(): RecommendableModelCatalog
}

export const validIdentityComponent = (value: string): boolean =>
  value.length > 0 && value.trim() === value && !value.includes(":")

export const validVariantId = (value: string): boolean => {
  const components = value.split(":")
  return (
    components.length === 2 &&
    validIdentityComponent(components[0] ?? "") &&
    validIdentityComponent(components[1] ?? "")
  )
}

export const validParameterization = (parameterization: ModelParameterization): boolean => {
  switch (parameterization.architecture) {
    case "dense":
      return parameterization.totalParameters > 0
    case "mixtureOfExperts":
      return (
        parameterization.activeParameters > 0 &&
        parameterization.activeParameters < parameterization.totalParameters
      )
  }
}

export const isFirstShard = (name: string): boolean =>
  name.lastIndexOf("-00001-of-") !== -1 &&
  name.endsWith(".gguf") &&
  name.slice(name.lastIndexOf("-00001-of-") + "-00001-of-".length).endsWith(".gguf")

export const isLaterShard = (name: string): boolean => {
  if (!name.endsWith(".gguf")) {
    return false
  }
  const stem = name.slice(0, -".gguf".length)
  const ofIndex = stem.lastIndexOf("-of-")
  if (ofIndex === -1) {
    return false
  }
  const prefix = stem.slice(0, ofIndex)
  const dashIndex = prefix.lastIndexOf("-")
  if (dashIndex === -1) {
    return false
  }
  const index = prefix.slice(dashIndex + 1)
  const count = stem.slice(ofIndex + "-of-".length)
  return (
    index.length === 5 &&
    count.length === 5 &&
    [...index].every((char) => char >= "0" && char <= "9") &&
    [...count].every((char) => char >= "0" && char <= "9") &&
    index !== "00001"
  )
}

export const validCommit = (commit: string): boolean =>
  commit.length === 40 && [...commit].every((char) => /[0-9a-f]/.test(char))

export const packageSourceMatches = (
  source: ModelPackageSource,
  expectedRepository: string,
  expectedCommit: string,
): boolean =>
  source._tag === "HuggingFace" &&
  source.repository === expectedRepository &&
  source.revision === expectedCommit

export const catalogSource = (): CatalogSource => {
  const source = JSON.parse(CATALOG_SOURCE) as CatalogSource
  if (source.models.length === 0) {
    throw InventoryError.Integrity({ message: "catalog source must contain at least one model" })
  }
  const ids = new Set<string>()
  const presentations = new Set<string>()
  const methodologyVersions = new Set<string>()
  for (const model of source.models) {
    const variantIds = new Set(model.variants.map((variant) => variant.variantId))
    const formats = new Set(model.variants.map((variant) => variant.format))
    const labels = new Set(model.variants.map((variant) => variant.variantLabel))
    const duplicateId = ids.has(model.id)
    const duplicatePresentation = model.variants.some((variant) =>
      presentations.has(`${model.displayName}:${variant.variantLabel}`),
    )
    const invalid =
      !validIdentityComponent(model.id) ||
      model.displayName.length === 0 ||
      model.description.length === 0 ||
      !validParameterization(model.parameterization) ||
      model.repository.length === 0 ||
      model.variants.length === 0 ||
      variantIds.size !== model.variants.length ||
      formats.size !== model.variants.length ||
      labels.size !== model.variants.length ||
      model.variants.some(
        (variant) =>
          !validVariantId(variant.variantId) ||
          variant.format.length === 0 ||
          variant.format.trim() !== variant.format ||
          variant.variantLabel.length === 0 ||
          variant.variantLabel.trim() !== variant.variantLabel ||
          variant.variantLabel.includes("(") ||
          variant.variantLabel.includes(")") ||
          variant.fidelityRank === 0,
      ) ||
      model.contextLength < MIN_CATALOG_CONTEXT_LENGTH ||
      (model.projector !== undefined && model.projector.path.length === 0) ||
      (model.speculativeDecoding !== undefined &&
        ((["dflash", "dspark"].includes(model.speculativeDecoding.method) &&
          model.speculativeDecoding.draft.type === "embedded") ||
          (model.speculativeDecoding.draft.type === "file" &&
            ((model.speculativeDecoding.draft.repository !== undefined &&
              model.speculativeDecoding.draft.repository.length === 0) ||
              model.speculativeDecoding.draft.path.length === 0)))) ||
      model.license.length === 0 ||
      !validCatalogIntelligence(model.intelligence) ||
      duplicateId ||
      duplicatePresentation
    if (invalid) {
      throw InventoryError.Integrity({
        message: `invalid or duplicate catalog declaration ${model.id}`,
      })
    }
    ids.add(model.id)
    for (const variant of model.variants) {
      presentations.add(`${model.displayName}:${variant.variantLabel}`)
    }
    methodologyVersions.add(intelligenceMethodologyVersion(model.intelligence))
  }
  if (methodologyVersions.size !== 1) {
    throw InventoryError.Integrity({
      message: "catalog intelligence assessments must use one methodology version",
    })
  }
  return source
}

export const modelCatalogLock = (): ModelCatalogLock => {
  return modelCatalogLockFrom(CATALOG_LOCK, catalogSource())
}

export const modelCatalogLockFrom = (
  lockJson: string,
  source: CatalogSource = catalogSource(),
): ModelCatalogLock => {
  const lock = JSON.parse(lockJson) as ModelCatalogLock
  validateModelCatalogLock(lock, source)
  return lock
}

export const validateModelCatalogLock = (
  lock: ModelCatalogLock,
  source: CatalogSource,
): void => {
  const expected = new Set(source.models.map((model) => model.id))
  const actual = new Set(Object.keys(lock))
  if (expected.size !== actual.size || [...expected].some((id) => !actual.has(id))) {
    throw InventoryError.Integrity({
      message: "model catalog lock does not exactly cover models.json",
    })
  }
  for (const model of source.models) {
    const entry = lock[model.id]
    if (entry === undefined) {
      throw InventoryError.Integrity({
        message: "model catalog lock contains invalid or mismatched package revisions",
      })
    }
    const wantsDraft = model.speculativeDecoding?.draft.type === "file"
    const hasDraft = entry.speculativeDraft !== undefined
    if (
      !validCommit(entry.target) ||
      hasDraft !== wantsDraft ||
      (entry.speculativeDraft !== undefined && !validCommit(entry.speculativeDraft))
    ) {
      throw InventoryError.Integrity({
        message: "model catalog lock contains invalid or mismatched package revisions",
      })
    }
  }
}

export const isProjectorPath = (path: string): boolean => {
  const extension = path.split(".").pop()
  const name = basename(path).toLowerCase()
  return extension?.toLowerCase() === "gguf" && name.includes("mmproj")
}

export const resolveProjectorPath = (
  declaration: CatalogModelDeclaration,
  snapshot: HuggingFaceRepositorySnapshot,
): string | null | never => {
  if (declaration.projector !== undefined) {
    if (
      !isProjectorPath(declaration.projector.path) ||
      !snapshot.gguf_files.some((file) => file.path === declaration.projector!.path)
    ) {
      throw InventoryError.Integrity({
        message: `${declaration.id} projector ${declaration.projector.path} is not a repository mmproj GGUF`,
      })
    }
    if (
      declaration.speculativeDecoding?.method === "mtp" &&
      declaration.speculativeDecoding.draft.type === "embedded"
    ) {
      throw InventoryError.Integrity({
        message: `${declaration.id} combines a projector with MTP, which cannot process projector embedding batches`,
      })
    }
    return declaration.projector.path
  }
  const candidates = snapshot.gguf_files
    .filter((file) => isProjectorPath(file.path))
    .map((file) => file.path)
  if (candidates.length === 1) {
    if (declaration.speculativeDecoding?.method === "mtp") {
      throw InventoryError.Integrity({
        message: `${declaration.id} combines a projector with MTP, which cannot process projector embedding batches`,
      })
    }
    return candidates[0]!
  }
  if (candidates.length === 0) {
    return null
  }
  throw InventoryError.Integrity({
    message: `${declaration.id} has ${candidates.length} projector candidates; declare an exact projector path`,
  })
}

export const loadReleaseCatalog = (plannerBundlePath: string): ReleaseCatalog => {
  const metadata = statSync(plannerBundlePath)
  if (!metadata.isFile() || metadata.size > MAX_PLANNER_BUNDLE_BYTES) {
    throw InventoryError.Integrity({
      message: `${plannerBundlePath} is not a bounded regular release file`,
    })
  }
  const bytes = readFileSync(plannerBundlePath)
  const bundle = PlannerBundle.parse(bytes)
  const manifest = JSON.parse(new TextDecoder().decode(bundle.manifest())) as {
    plannerInputs: Record<string, unknown>
  }
  if (manifest.plannerInputs === undefined) {
    throw InventoryError.Integrity({ message: "invalid planner manifest" })
  }
  catalogSource()
  return {
    catalog: () => ({ models: [], diagnostics: [] }),
  }
}

export const repositorySnapshot = (
  paths: readonly string[],
  repository = "publisher/model",
  commit = "0123456789abcdef0123456789abcdef01234567",
): HuggingFaceRepositorySnapshot => ({
  repository,
  commit,
  last_modified: Option.none(),
  downloads: Option.none(),
  likes: Option.none(),
  gated: false,
  private: false,
  license: Option.none(),
  license_url: Option.none(),
  base_models: [],
  tags: [],
  gguf_files: paths.map((path) => ({
    path,
    size_bytes: 1n,
    content: contentIdentity.unknown(),
  })),
})

const validNonEmpty = (value: string): boolean => value.length > 0 && value.trim() === value

const validHttpsUrl = (value: string): boolean =>
  validNonEmpty(value) && value.startsWith("https://") && !/\s/.test(value)

const validCatalogIntelligence = (intelligence: CatalogModelDeclaration["intelligence"]): boolean => {
  if (!Number.isFinite(intelligence.score) || intelligence.score < 0) {
    return false
  }
  const validReleaseDate = (value: string): boolean => isValidIsoDate(value)
  switch (intelligence.provenance.kind) {
    case "artificialAnalysisIntelligenceIndex":
      return (
        validNonEmpty(intelligence.provenance.methodologyVersion) &&
        validReleaseDate(intelligence.provenance.asOfDate) &&
        validHttpsUrl(intelligence.provenance.url)
      )
    case "estimate":
      return (
        validNonEmpty(intelligence.provenance.methodologyVersion) &&
        validReleaseDate(intelligence.provenance.asOfDate) &&
        validNonEmpty(intelligence.provenance.methodology) &&
        intelligence.provenance.evidenceUrls.length > 0 &&
        intelligence.provenance.evidenceUrls.every((url) => validHttpsUrl(url))
      )
  }
}

const intelligenceMethodologyVersion = (
  intelligence: CatalogModelDeclaration["intelligence"],
): string => intelligence.provenance.methodologyVersion

export const recommendableModelBundleKey = (
  model: { configuration: { bundle: ServableModelBundle } },
): ServableModelBundleKey => servableModelBundleKeyForBundle(model.configuration.bundle)

export type { CatalogModelDeclaration, CatalogSource, CatalogVariant }
