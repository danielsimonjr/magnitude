import type { ModelDomainInvalidation } from "@magnitudedev/icn-contracts"
import type { CatalogPackageRemover } from "@magnitudedev/icn-contracts"
import type { ModelDownloadsService } from "./catalog-installations"
import { ManagedCatalogInstallations } from "./catalog-installations"
import { ManagedCatalogModels, ModelDomainResolver } from "./catalog-models"
import { ManagedDiscoveredModels } from "./discovered-models"

export { ModelDomainResolver, ManagedCatalogModels, ManagedDiscoveredModels, ManagedCatalogInstallations }

export interface ManagedModelServices {
  catalog: ManagedCatalogModels
  discovered: ManagedDiscoveredModels
  installations: ManagedCatalogInstallations
}

export const domainChanges = (
  initialRevision: number,
  subscribe: (listener: (event: ModelDomainInvalidation) => void) => () => void,
): AsyncIterable<ModelDomainInvalidation> => {
  async function* changes(): AsyncGenerator<ModelDomainInvalidation> {
    yield { revision: BigInt(initialRevision) }
    const queue: ModelDomainInvalidation[] = []
    let resolveNext: ((event: ModelDomainInvalidation) => void) | undefined
    const unsubscribe = subscribe((event) => {
      if (resolveNext !== undefined) {
        resolveNext(event)
        resolveNext = undefined
        return
      }
      queue.push(event)
    })
    try {
      while (true) {
        const queued = queue.shift()
        if (queued !== undefined) {
          yield queued
          continue
        }
        const event = await new Promise<ModelDomainInvalidation>((resolve) => {
          resolveNext = resolve
        })
        yield event
      }
    } finally {
      unsubscribe()
    }
  }
  return changes()
}

export const managedModelServices = (
  resolver: ModelDomainResolver,
  downloads: ModelDownloadsService,
  remover: CatalogPackageRemover,
  inventory?: ConstructorParameters<typeof ManagedDiscoveredModels>[0],
): ManagedModelServices => {
  const installations = new ManagedCatalogInstallations(resolver, downloads, remover)
  const discovered = new ManagedDiscoveredModels(
    inventory ?? {
      revision: () => resolver.revision(),
      installedPackageSnapshot: () => ({ records: new Map() }),
      installedPackagesResponse: () => ({
        revision: resolver.revision(),
        reconciliationComplete: true,
      }),
      ensureModelInventory: async () => undefined,
    },
  )
  const catalog = new ManagedCatalogModels(resolver)
  return { catalog, discovered, installations }
}
