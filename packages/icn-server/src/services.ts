import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  CatalogInstallationsResponse,
  CatalogModel,
  CatalogModelsResponse,
  DiscoveredModelsResponse,
  ModelInstancesSnapshot,
} from "@magnitudedev/icn-protocol"
import type { CatalogPackageAffiliation, RecommendableModelCatalog } from "@magnitudedev/icn-contracts"
import {
  CatalogAffiliations,
  InventoryConfig,
  ManagedCatalogInstallations,
  ManagedCatalogModels,
  ManagedDiscoveredModels,
  ManagedModelDownloads,
  ManagedModelStore,
  ModelDomainResolver,
  type InstalledPackageSnapshot,
} from "@magnitudedev/icn-models"
import { developmentRecommendableCatalog } from "./catalog-development.js"
import type { ServeConfig } from "./config.js"
import { ManagedStoreInventory, type InventoryPort } from "./inventory-port.js"
import { toWireJson } from "./wire.js"

export interface ServerServices {
  listCatalogModels(): Promise<CatalogModelsResponse>
  getCatalogModel(modelId: string): Promise<CatalogModel | undefined>
  listDiscoveredModels(): Promise<DiscoveredModelsResponse>
  listCatalogInstallations(): Promise<CatalogInstallationsResponse>
  listModelInstances(): Promise<ModelInstancesSnapshot>
}

export interface ServerServicesOptions {
  readonly catalog?: RecommendableModelCatalog
  readonly inventory?: InventoryPort
  readonly installations?: Pick<ManagedCatalogInstallations, "listCatalogInstallations">
}

class InMemoryInventory implements InventoryPort {
  private snapshotState: InstalledPackageSnapshot = { records: new Map() }
  private generation = 0
  private readonly affiliations: CatalogAffiliations

  constructor(root: string) {
    this.affiliations = CatalogAffiliations.load(root)
  }

  installedPackagesResponse() {
    return {
      revision: this.generation,
      reconciliationComplete: true,
      packages: [],
    }
  }

  catalogAffiliations(): readonly CatalogPackageAffiliation[] {
    return this.affiliations.entries()
  }

  snapshot(): InstalledPackageSnapshot {
    return this.snapshotState
  }

  revision(): number {
    return this.generation
  }
}

const wireCatalogModels = (snapshot: {
  revision: number
  reconciliationComplete: boolean
  models: readonly unknown[]
}): CatalogModelsResponse => toWireJson(snapshot) as CatalogModelsResponse

const wireDiscoveredModels = (snapshot: {
  revision: bigint
  reconciliationComplete: boolean
  models: readonly unknown[]
}): DiscoveredModelsResponse => toWireJson(snapshot) as DiscoveredModelsResponse

const wireInstallations = (response: {
  operations: readonly unknown[]
}): CatalogInstallationsResponse => toWireJson(response) as CatalogInstallationsResponse

const emptyDownloads = {
  start: async () => ({ download: null }),
  list: async () => ({ downloads: [] as const }),
  cancel: async () => {
    throw new Error("catalog installation downloads are not configured")
  },
  acknowledgeFailure: async () => {
    throw new Error("catalog installation downloads are not configured")
  },
}

const emptyRemover = {
  removeCatalogPackages: async () => 0,
}

export const createServerServices = (options: ServerServicesOptions = {}): ServerServices => {
  const catalog = options.catalog ?? developmentRecommendableCatalog()
  const inventory = options.inventory ?? new InMemoryInventory(mkdtempSync(join(tmpdir(), "icn-inventory-")))
  const resolver = new ModelDomainResolver(inventory, catalog)
  const catalogModels = new ManagedCatalogModels(resolver)
  const discovered = new ManagedDiscoveredModels({
    revision: () => inventory.revision(),
    snapshot: () => inventory.snapshot(),
  })
  const installations =
    options.installations ??
    new ManagedCatalogInstallations(resolver, emptyDownloads, emptyRemover)

  return {
    async listCatalogModels() {
      return wireCatalogModels(catalogModels.listCatalog())
    },
    async getCatalogModel(modelId) {
      const snapshot = catalogModels.listCatalog()
      const model = snapshot.models.find((entry) => String(entry.id) === modelId)
      if (model === undefined) {
        return undefined
      }
      return toWireJson(model) as CatalogModel
    },
    async listDiscoveredModels() {
      return wireDiscoveredModels(discovered.snapshot())
    },
    async listCatalogInstallations() {
      return wireInstallations(await installations.listCatalogInstallations())
    },
    async listModelInstances() {
      return { revision: 0, instances: [] }
    },
  }
}

export const createServerServicesFromConfig = async (
  config: ServeConfig,
): Promise<ServerServices> => {
  if (config.modelStore === undefined) {
    return createServerServices()
  }

  const store = await ManagedModelStore.open(
    InventoryConfig.withRoots(
      config.modelStore,
      config.cacheRoot ?? join(config.modelStore, "cache"),
    ),
  )
  store.startBackgroundReconciliation()
  const inventory = new ManagedStoreInventory(store)
  const catalog = developmentRecommendableCatalog()
  const resolver = new ModelDomainResolver(inventory, catalog)
  return createServerServices({
    catalog,
    inventory,
    installations: new ManagedCatalogInstallations(
      resolver,
      ManagedModelDownloads.open(store),
      emptyRemover,
    ),
  })
}
