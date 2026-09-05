import { Option, Schema } from "effect"
import {
  CatalogBaseId,
  CatalogVariantId,
  ModelReleaseDate,
  modelFileId,
  modelPackageId,
  type RecommendableModel,
  type RecommendableModelCatalog,
  type ServableModelBundle,
} from "@magnitudedev/icn-contracts"
import { catalogSource, modelCatalogLock } from "@magnitudedev/icn-models"
import { minimalRecommendableCatalog } from "./test-catalog.js"

const stubPackage = (
  declarationId: string,
  variantId: string,
  repository: string,
  revision: string,
  declaration: ReturnType<typeof catalogSource>["models"][number],
  variant: ReturnType<typeof catalogSource>["models"][number]["variants"][number],
) => {
  const packageId = modelPackageId(`package-${declarationId}-${variantId.replaceAll(":", "-")}`)
  return {
    id: packageId,
    source: { _tag: "HuggingFace" as const, repository, revision },
    files: [
      {
        id: modelFileId(`file-${packageId}`),
        path: "model.gguf",
        role: "weights" as const,
        sizeBytes: 1,
        tensorStorageBytes: Option.some(1),
        sha256: "0".repeat(64),
      },
    ],
    relationships: [],
    properties: {
      format: variant.format,
      quantization: variant.variantId.split(":")[1] ?? "unknown",
      quantizationName: variant.variantLabel,
      architecture: "unknown",
      maximumContextLength: Option.some(declaration.contextLength),
      intrinsicModelId: Option.some(declaration.id),
      intrinsicQualityId: Option.some(variant.variantId),
    },
  }
}

/** Builds a catalog snapshot from authored models.json for HTTP listing before planner materialization lands. */
export const developmentRecommendableCatalog = (): RecommendableModelCatalog => {
  try {
    return materializeAuthoredCatalog()
  } catch {
    return minimalRecommendableCatalog()
  }
}

const materializeAuthoredCatalog = (): RecommendableModelCatalog => {
  const source = catalogSource()
  const lock = modelCatalogLock()
  const models: RecommendableModel[] = []

  for (const declaration of source.models) {
    const entry = lock[declaration.id]
    if (entry === undefined) {
      continue
    }
    for (const variant of declaration.variants) {
      const bundle: ServableModelBundle = {
        _tag: "Standalone",
        package: stubPackage(
          declaration.id,
          variant.variantId,
          declaration.repository,
          entry.target,
          declaration,
          variant,
        ),
      }
      models.push({
        modelId: Schema.decodeUnknownSync(CatalogBaseId)(declaration.id),
        variantId: Schema.decodeUnknownSync(CatalogVariantId)(variant.variantId),
        configuration: {
          bundle,
          profile: { contextLength: declaration.contextLength },
        },
        displayName: declaration.displayName,
        variantLabel: variant.variantLabel,
        description: declaration.description,
        releaseDate: Schema.decodeUnknownSync(ModelReleaseDate)(declaration.releaseDate),
        license: declaration.license,
        parameterization: declaration.parameterization,
        intelligence: declaration.intelligence,
        fidelityRank: variant.fidelityRank,
        quantizationAware: variant.quantizationAware,
      })
    }
  }

  return { models, diagnostics: [] }
}
