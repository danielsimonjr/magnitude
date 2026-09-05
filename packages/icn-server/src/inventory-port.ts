import type { CatalogPackageAffiliation, InstalledModelPackage } from "@magnitudedev/icn-contracts"
import type { InstalledPackageSnapshot, ManagedModelStore } from "@magnitudedev/icn-models"

/** Inventory surface required by ModelDomainResolver and discovered-model snapshots. */
export interface InventoryPort {
  installedPackagesResponse(): {
    revision: number
    reconciliationComplete: boolean
    packages: readonly InstalledModelPackage[]
  }
  catalogAffiliations(): readonly CatalogPackageAffiliation[]
  snapshot(): InstalledPackageSnapshot
  revision(): number
}

export class ManagedStoreInventory implements InventoryPort {
  constructor(private readonly store: ManagedModelStore) {}

  installedPackagesResponse() {
    const response = this.store.installedPackagesResponse()
    return {
      revision: Number(response.revision),
      reconciliationComplete: response.reconciliationComplete,
      packages: response.packages,
    }
  }

  catalogAffiliations(): readonly CatalogPackageAffiliation[] {
    return this.store.catalogAffiliations()
  }

  snapshot(): InstalledPackageSnapshot {
    return this.store.installedPackageSnapshot()
  }

  revision(): number {
    return this.store.revision()
  }
}
