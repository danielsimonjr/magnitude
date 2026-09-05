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
} from "./_contracts-shim"
import type { ModelDomainResolver } from "./catalog-models"

export interface ModelDownloadsService {
  start(request: StartModelDownloadRequest): Promise<{ download: ModelDownload | null }>
  list(): Promise<{ downloads: readonly ModelDownload[] }>
  cancel(id: ModelDownloadId): Promise<ModelDownload>
  acknowledgeFailure(id: ModelDownloadId): Promise<ModelDownload>
}

interface OperationBinding {
  operation_id: CatalogInstallationOperationId
  model_id: ModelId
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
      for (const binding of this.operations.filter((entry) => entry.model_id === id)) {
        const operation = await this.operation(binding.operation_id)
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
        operation_id: operationId,
        model_id: id,
        download_id: started.download.id,
      })
      return { _tag: "Admitted", operation_id: operationId }
    })
  }

  async remove(id: ModelId): Promise<CatalogInstallationRemoval> {
    return this.withMutation(async () => {
      this.resolver.catalogDefinition(id)
      for (const binding of this.operations.filter((entry) => entry.model_id === id)) {
        const operation = await this.operation(binding.operation_id)
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
      return { _tag: "Removed", reclaimed_bytes: reclaimedBytes }
    })
  }

  async cleanupModel(id: ModelId): Promise<void> {
    const packageIds = this.resolver.catalogCleanupPackageIds(id)
    if (packageIds.length > 0) {
      await this.remover.removeCatalogPackages(packageIds)
    }
  }

  private async operation(
    id: CatalogInstallationOperationId,
  ): Promise<CatalogInstallationOperation> {
    const binding = this.operations.find((entry) => entry.operation_id === id)
    if (binding === undefined) {
      throw InventoryError.NotFound({ id: String(id) })
    }
    const download = (await this.downloads.list()).downloads.find(
      (entry) => entry.id === binding.download_id,
    )
    if (download === undefined) {
      throw InventoryError.NotFound({ id: String(id) })
    }
    return operationFromDownload(id, binding.model_id, download)
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
    bytesPerSecond?: number,
  ): CatalogInstallationProgress => ({
    stage,
    completed_bytes: completedBytes,
    total_bytes: totalBytes,
    bytes_per_second: bytesPerSecond,
  })

  switch (download.state._tag) {
    case "Pending":
      return {
        operation_id: operationId,
        model_id: modelId,
        state: {
          _tag: "Pending",
          progress: progress("queued", download.state.completed_bytes, download.state.total_bytes),
        },
      }
    case "Downloading":
      return {
        operation_id: operationId,
        model_id: modelId,
        state: {
          _tag: "Running",
          progress: progress(
            download.state.stage,
            download.state.completed_bytes,
            download.state.total_bytes,
            download.state.bytes_per_second ?? undefined,
          ),
        },
      }
    case "Completed":
      return { operation_id: operationId, model_id: modelId, state: { _tag: "Completed" } }
    case "Failed":
      return {
        operation_id: operationId,
        model_id: modelId,
        state: {
          _tag: "Failed",
          progress: progress(
            "downloading",
            download.state.completed_bytes,
            download.state.total_bytes,
          ),
          failure: download.state.failure,
          acknowledged: download.state.acknowledged,
        },
      }
    case "Cancelled":
      return {
        operation_id: operationId,
        model_id: modelId,
        state: {
          _tag: "Cancelled",
          progress: progress(
            "queued",
            download.state.completed_bytes,
            download.state.total_bytes,
          ),
        },
      }
  }
}
