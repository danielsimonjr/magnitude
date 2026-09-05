import type { RecommendableModelCatalog, ServableModelBundle } from "@magnitudedev/icn-contracts"
import { testDefinition, testPackage } from "@magnitudedev/icn-models"

export const minimalTestPackage = (id: string, bytes: number) => testPackage(id, bytes)

export const minimalRecommendableModel = (
  bundle: ServableModelBundle,
  profile?: Parameters<typeof testDefinition>[1],
) => testDefinition(bundle, profile)

export const minimalRecommendableCatalog = (): RecommendableModelCatalog => ({
  models: [
    minimalRecommendableModel({
      _tag: "Standalone",
      package: minimalTestPackage("catalog-dev", 1),
    }),
  ],
  diagnostics: [],
})
