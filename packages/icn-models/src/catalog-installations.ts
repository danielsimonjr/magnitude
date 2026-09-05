import { Option } from "effect"
import {
  InventoryError,
  type CatalogInstallationAdmission,
  type CatalogInstallationOperation,
  type CatalogInstallationOperationId,
  type CatalogInstallationProgress,
  type CatalogInstallationRemoval,
  type CatalogPackageRemover,
  type DownloadStage,
  type ModelDownload,
  type ModelDownloadId,
  type ModelId,
  type StartModelDownloadRequest,
} from "@magnitudedev/icn-contracts"
import type { ModelDomainResolver } from "./catalog-models"

export interface ModelDownloadsService {
  start(request: StartModelDownloadRequest): Promise<{ download: ModelDownload | null }>
  list(): Promise<{ downloads: readonly ModelDownload[] }>
  cancel(id: ModelDownloadId): Promise<ModelDownload>
  acknowledgeFailure(id: ModelDownloadId): Promise<ModelDownload>
}

interface OperationBinding {
  operationId: CatalogInstallationOperationId
  modelId: ModelId
  download_id: ModelDownloadId
}

export class ManagedCatalogInstallations {
  private readonly operations: OperationBinding[] = []
  private mutation: Promise<void> = Promise.resolve()

  constructor(
    private readonly resolver: Pick<
      ModelDomainResolver,
      "catalogDefinition" | "catalogRemovalPlan" | "catalogCleanupPackageIds"
    >,
    private readonly downloads: ModelDownloadsService,
    private readonly remover: CatalogPackageRemover,
  ) {}

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(operation)
    this.mutation = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async install(id: ModelId): Promise<CatalogInstallationAdmission> {
    return this.withMutation(async () => {
      const definition = this.resolver.catalogDefinition(id)
      for (const binding of this.operations.filter((entry) => entry.modelId === id)) {
        const operation = await this.operation(binding.operationId)
        if (operation.state._tag === "Pending" || operation.state._tag === "Running") {
          throw InventoryError.ModelOperation({
            code: "catalog_installation_active",
            message: `catalog model ${id} already has an active installation`,
            retryable: true,
          })
        }
      }
      const started = await this.downloads.start({
        bundle: definition.configuration.bundle,
      })
      if (started.download === null) {
        await this.cleanupModel(id)
        return { _tag: "Current" }
      }
      const operationId = started.download.id as unknown as CatalogInstallationOperationId
      this.operations.push({
        operationId: operationId,
        modelId: id,
        download_id: started.download.id,
      })
      return { _tag: "Admitted", operationId: operationId }
    })
  }

  async remove(id: ModelId): Promise<CatalogInstallationRemoval> {
    return this.withMutation(async () => {
      this.resolver.catalogDefinition(id)
      for (const binding of this.operations.filter((entry) => entry.modelId === id)) {
        const operation = await this.operation(binding.operationId)
        if (operation.state._tag === "Pending" || operation.state._tag === "Running") {
          throw InventoryError.ModelOperation({
            code: "catalog_installation_active",
            message: `catalog model ${id} has an active installation; cancel it before removal`,
            retryable: false,
          })
        }
      }
      const plan = this.resolver.catalogRemovalPlan(id)
      if (!plan.installed) {
        throw InventoryError.ModelOperation({
          code: "catalog_model_not_installed",
          message: `catalog model ${id} is not installed`,
          retryable: false,
        })
      }
      if (plan.externally_owned) {
        return { _tag: "Retained", reason: "ExternalOwnership" }
      }
      if (plan.shared) {
        return { _tag: "Retained", reason: "SharedMaterial" }
      }
      const reclaimedBytes = await this.remover.removeCatalogPackages(plan.package_ids)
      if (typeof reclaimedBytes !== "number") {
        throw reclaimedBytes
      }
      return { _tag: "Removed", reclaimedBytes }
    })
  }

  async cleanupModel(id: ModelId): Promise<void> {
    const packageIds = this.resolver.catalogCleanupPackageIds(id)
    if (packageIds.length > 0) {
      await this.remover.removeCatalogPackages(packageIds)
    }
  }

  async listCatalogInstallations(): Promise<{ operations: readonly CatalogInstallationOperation[] }> {
    const operations: CatalogInstallationOperation[] = []
    for (const binding of this.operations) {
      operations.push(await this.operation(binding.operationId))
    }
    return { operations }
  }

  async get(id: CatalogInstallationOperationId): Promise<CatalogInstallationOperation> {
    return this.operation(id)
  }

  async cancel(id: CatalogInstallationOperationId): Promise<CatalogInstallationOperation> {
    const binding = this.binding(id)
    const download = await this.downloads.cancel(binding.download_id)
    return operationFromDownload(id, binding.modelId, download)
  }

  async acknowledgeFailure(
    id: CatalogInstallationOperationId,
  ): Promise<CatalogInstallationOperation> {
    const binding = this.binding(id)
    const download = await this.downloads.acknowledgeFailure(binding.download_id)
    return operationFromDownload(id, binding.modelId, download)
  }

  private binding(id: CatalogInstallationOperationId): OperationBinding {
    const binding = this.operations.find((entry) => entry.operationId === id)
    if (binding === undefined) {
      throw InventoryError.NotFound({ id: String(id) })
    }
    return binding
  }

  private async operation(
    id: CatalogInstallationOperationId,
  ): Promise<CatalogInstallationOperation> {
    const binding = this.binding(id)
    const download = (await this.downloads.list()).downloads.find(
      (entry) => entry.id === binding.download_id,
    )
    if (download === undefined) {
      throw InventoryError.NotFound({ id: String(id) })
    }
    return operationFromDownload(id, binding.modelId, download)
  }
}

const operationFromDownload = (
  operationId: CatalogInstallationOperationId,
  modelId: ModelId,
  download: ModelDownload,
): CatalogInstallationOperation => {
  const progress = (
    stage: DownloadStage,
    completedBytes: number,
    totalBytes: number,
  bytesPerSecond?: Option.Option<number>,
): CatalogInstallationProgress => ({
    stage,
    completedBytes,
    totalBytes,
    bytesPerSecond: bytesPerSecond ?? Option.none(),
  })

  switch (download.state._tag) {
    case "Pending":
      return {
        operationId: operationId,
        modelId: modelId,
        state: {
          _tag: "Pending",
          progress: progress("queued", download.state.completedBytes, download.state.totalBytes),
        },
      }
    case "Downloading":
      return {
        operationId: operationId,
        modelId: modelId,
        state: {
          _tag: "Running",
          progress: progress(
            download.state.stage,
            download.state.completedBytes,
            download.state.totalBytes,
            download.state.bytesPerSecond,
          ),
        },
      }
    case "Completed":
      return { operationId: operationId, modelId: modelId, state: { _tag: "Completed" } }
    case "Failed":
      return {
        operationId: operationId,
        modelId: modelId,
        state: {
          _tag: "Failed",
          progress: progress(
            "downloading",
            download.state.completedBytes,
            download.state.totalBytes,
          ),
          failure: download.state.failure,
          acknowledged: download.state.acknowledged,
        },
      }
    case "Cancelled":
      return {
        operationId: operationId,
        modelId: modelId,
        state: {
          _tag: "Cancelled",
          progress: progress(
            "queued",
            download.state.completedBytes,
            download.state.totalBytes,
          ),
        },
      }
  }
}
