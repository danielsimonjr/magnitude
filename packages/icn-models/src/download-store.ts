import { Option } from "effect"
import { statfsSync } from "node:fs"
import { join } from "node:path"
import {
  InventoryError,
  type DownloadStage,
  type InventoryEntryId,
  type InventoryModel,
  type ModelComponent,
  type ModelDownloadEvent,
  type ModelPackage,
} from "@magnitudedev/icn-contracts"
import {
  DownloadError,
  downloadComponentWithRetry,
  packageDownloadKey,
  publishPackageSnapshot,
  resumableBytes,
} from "./download"
import {
  createHuggingFaceDownloadClient,
  resolveDownloadRevision,
  type ModelDownloadHttpClient,
} from "./download-http"
import { contentId, inventoryEntryId } from "./identity"
import type { ManagedModelStore } from "./inventory"
import { buildModel, now } from "./inventory"
import { hfRepoDir, repositoryLockPath } from "./paths"
import { acquireExclusiveLockSync, ensureOwnedDirectory } from "./store-fs"
import { ValidatedDownloadPackage } from "./validation"

export interface DiskSpaceProvider {
  availableBytes(root: string): number
}

export const defaultDiskSpaceProvider: DiskSpaceProvider = {
  availableBytes(root: string): number {
    try {
      const stats = statfsSync(root)
      return Number(stats.bfree * stats.bsize)
    } catch {
      return Number.MAX_SAFE_INTEGER
    }
  },
}

export interface ModelStoreDownloadOptions {
  http?: ModelDownloadHttpClient
  diskSpace?: DiskSpaceProvider
}

class AsyncSemaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  constructor(permits: number) {
    this.available = permits
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1
      return () => this.release()
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
    this.available -= 1
    return () => this.release()
  }

  private release(): void {
    this.available += 1
    const waiter = this.waiters.shift()
    waiter?.()
  }
}

class DownloadOperation {
  readonly cancelled = { value: false }
  readonly channel: DownloadEventChannel

  constructor(initial: ModelDownloadEvent) {
    this.channel = new DownloadEventChannel(initial)
  }

  subscribe(): AsyncIterable<ModelDownloadEvent> {
    return this.channel.subscribe()
  }

  cancel(): void {
    this.cancelled.value = true
  }

  ensureActive(): void {
    if (this.cancelled.value) {
      throw DownloadError.cancelled()
    }
  }
}

export class DownloadEventChannel {
  private current: ModelDownloadEvent
  private readonly waiters: Array<(event: ModelDownloadEvent) => void> = []

  constructor(initial: ModelDownloadEvent) {
    this.current = initial
  }

  currentEvent(): ModelDownloadEvent {
    return this.current
  }

  sendReplace(event: ModelDownloadEvent): void {
    this.current = event
    const waiters = this.waiters.splice(0)
    for (const waiter of waiters) {
      waiter(event)
    }
  }

  subscribe(): AsyncIterable<ModelDownloadEvent> {
    const channel = this
    let started = false
    let terminal = false
    return {
      async *[Symbol.asyncIterator]() {
        while (!terminal) {
          if (!started) {
            started = true
            yield channel.current
            terminal = isTerminal(channel.current)
            continue
          }
          const event = await new Promise<ModelDownloadEvent>((resolve) => {
            channel.waiters.push(resolve)
          })
          yield event
          terminal = isTerminal(event)
        }
      },
    }
  }
}

const isTerminal = (event: ModelDownloadEvent): boolean =>
  event.type === "ready" || event.type === "cancelled" || event.type === "failed"

const randomId = (prefix: string): string => {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return `${prefix}_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

export interface ModelStoreDownloadState {
  readonly operations: Map<string, DownloadOperation>
  readonly downloadSlots: AsyncSemaphore
  readonly http: ModelDownloadHttpClient
  readonly diskSpace: DiskSpaceProvider
}

export const createModelStoreDownloadState = (
  maxConcurrentDownloads: number,
  options: ModelStoreDownloadOptions = {},
): ModelStoreDownloadState => ({
  operations: new Map(),
  downloadSlots: new AsyncSemaphore(maxConcurrentDownloads),
  http: options.http ?? createHuggingFaceDownloadClient(),
  diskSpace: options.diskSpace ?? defaultDiskSpaceProvider,
})

const progressTotals = (event: ModelDownloadEvent): [number, number] => {
  switch (event.type) {
    case "checking_space":
    case "progress":
    case "failed":
    case "cancelled":
      return [Number(event.completed_bytes), Number(event.total_bytes)]
    case "ready":
      return event.model.location.type === "magnitude_cache" ||
        event.model.location.type === "hugging_face_cache"
        ? [
            event.model.location.components.reduce((sum, item) => sum + Number(item.size_bytes), 0),
            event.model.location.components.reduce((sum, item) => sum + Number(item.size_bytes), 0),
          ]
        : [0, 0]
    case "resolving":
      return [0, 0]
  }
}

const currentModelId = (event: ModelDownloadEvent): InventoryEntryId | undefined => {
  switch (event.type) {
    case "checking_space":
    case "progress":
      return event.model_id
    case "ready":
      return event.model.id
    case "cancelled":
    case "failed":
      return Option.getOrUndefined(event.model_id)
    case "resolving":
      return undefined
  }
}

export const startTargetDownloads = async (
  store: ManagedModelStore,
  state: ModelStoreDownloadState,
  packages: readonly ModelPackage[],
): Promise<AsyncIterable<ModelDownloadEvent>[]> => {
  const validated = packages.map((package_) => {
    const validatedPackage = ValidatedDownloadPackage.new(package_)
    return {
      packageId: package_.id,
      key: packageDownloadKey(package_),
      package: validatedPackage,
    }
  })
  const resolvedPackages: Array<{
    key: string
    package: ValidatedDownloadPackage
    installed: InventoryModel | undefined
  }> = []
  for (const entry of validated) {
    let installed: InventoryModel | undefined
    try {
      const [, model] = store.installedPackageFromSnapshot(entry.packageId)
      installed = model
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        (error as { _tag: string })._tag === "NotFound"
      ) {
        installed = undefined
      } else {
        throw error
      }
    }
    resolvedPackages.push({ key: entry.key, package: entry.package, installed })
  }

  const streams: AsyncIterable<ModelDownloadEvent>[] = []
  const admitted: Array<{
    key: string
    operationId: string
    package: ValidatedDownloadPackage
    operation: DownloadOperation
  }> = []

  for (const entry of resolvedPackages) {
    const existing = state.operations.get(entry.key)
    if (existing !== undefined) {
      streams.push(existing.subscribe())
      continue
    }
    const operationId = randomId("download")
    if (entry.installed !== undefined && entry.installed.availability.type === "available") {
      const channel = new DownloadEventChannel({
        type: "ready",
        operation_id: operationId,
        model: entry.installed,
      })
      streams.push(channel.subscribe())
      continue
    }
    const [repository, revision] = entry.package.repositoryRevision()
    const operation = new DownloadOperation({
      type: "resolving",
      operation_id: operationId,
      repository,
      revision,
    })
    streams.push(operation.subscribe())
    admitted.push({ key: entry.key, operationId, package: entry.package, operation })
    state.operations.set(entry.key, operation)
  }

  for (const entry of admitted) {
    void runDownload(store, state, entry.key, entry.operationId, entry.package, entry.operation)
  }
  return streams
}

export const cancelPackageDownload = async (
  store: ManagedModelStore,
  state: ModelStoreDownloadState,
  package_: ModelPackage,
): Promise<void> => {
  ValidatedDownloadPackage.new(package_)
  const key = packageDownloadKey(package_)
  const operation = state.operations.get(key)
  if (operation === undefined) {
    throw InventoryError.NotFound({ id: "active download" })
  }
  operation.cancel()
}

const runDownload = async (
  store: ManagedModelStore,
  state: ModelStoreDownloadState,
  operationKey: string,
  operationId: string,
  package_: ValidatedDownloadPackage,
  operation: DownloadOperation,
): Promise<void> => {
  try {
    await runDownloadInner(store, state, operationId, package_, operation)
  } catch (error) {
    const failure = error instanceof DownloadError ? error : DownloadError.filesystem(String(error))
    const modelId = currentModelId(operation.channel.currentEvent())
    const [completedBytes, totalBytes] = progressTotals(operation.channel.currentEvent())
    const downloadFailure = failure.toFailure()
    if (downloadFailure === undefined) {
      if (modelId !== undefined) {
        store.getModels().delete(modelId)
      }
      operation.channel.sendReplace({
        type: "cancelled",
        operation_id: operationId,
        model_id: modelId === undefined ? Option.none() : Option.some(modelId),
        completed_bytes: BigInt(completedBytes),
        total_bytes: BigInt(totalBytes),
      })
      state.operations.delete(operationKey)
      return
    }
    const resumable = failure.resumable
    if (modelId !== undefined) {
      const model = store.getModels().get(modelId)
      if (model !== undefined) {
        const updated: InventoryModel = {
          ...model,
          availability: {
            type: "interrupted",
            completed_bytes: BigInt(completedBytes),
            total_bytes: BigInt(totalBytes),
            resumable,
            failure: downloadFailure,
            updated_at: BigInt(now()),
          },
          updated_at: BigInt(now()),
        }
        store.getModels().set(modelId, updated)
      }
    }
    operation.channel.sendReplace({
      type: "failed",
      operation_id: operationId,
      model_id: modelId === undefined ? Option.none() : Option.some(modelId),
      error: downloadFailure,
      completed_bytes: BigInt(completedBytes),
      total_bytes: BigInt(totalBytes),
      resumable,
    })
  }
  state.operations.delete(operationKey)
}

const runDownloadInner = async (
  store: ManagedModelStore,
  state: ModelStoreDownloadState,
  operationId: string,
  package_: ValidatedDownloadPackage,
  operation: DownloadOperation,
): Promise<void> => {
  operation.ensureActive()
  const [repository, revision] = package_.repositoryRevision()
  if (!repository.includes("/")) {
    throw new DownloadError("InvalidRequest", "repository must be owner/name", false, false)
  }
  const lock = acquireExclusiveLockSync(repositoryLockPath(store.root(), repository))
  try {
    let commit: string
    try {
      commit = await resolveDownloadRevision(
        state.http,
        repository,
        revision,
        package_.getComponents(),
      )
    } catch (error) {
      if (error instanceof DownloadError && error.kind === "MissingSource") {
        commit = await resolveDownloadRevision(
          state.http,
          repository,
          "main",
          package_.getComponents(),
          revision,
        )
      } else {
        throw error
      }
    }

    const [resolvedRepository, resolvedRevision, components] = package_.intoParts()
    const content = contentId(components)
    const repoRoot = join(store.config.root, "hub", hfRepoDir(resolvedRepository))
    const snapshot = join(repoRoot, "snapshots", commit)
    const modelId = inventoryEntryId("magnitude-cache", snapshot, content)
    const totalBytes = components.reduce((sum, component) => sum + Number(component.size_bytes), 0)
    const existing = [...store.getModels().values()].find(
      (model) => model.id === modelId && model.availability.type === "available",
    )
    if (existing !== undefined) {
      operation.channel.sendReplace({
        type: "ready",
        operation_id: operationId,
        model: existing,
      })
      return
    }

    const completedBytes = resumableBytes(repoRoot, components)
    const missingBytes = Math.max(0, totalBytes - completedBytes)
    const availableBytes = state.diskSpace.availableBytes(store.config.root)
    const requiredBytes = missingBytes + Number(store.config.disk_reserve_bytes)
    operation.channel.sendReplace({
      type: "checking_space",
      operation_id: operationId,
      model_id: modelId,
      required_bytes: BigInt(requiredBytes),
      available_bytes: BigInt(availableBytes),
      completed_bytes: BigInt(completedBytes),
      total_bytes: BigInt(totalBytes),
    })
    if (requiredBytes > availableBytes) {
      throw DownloadError.insufficientDiskSpace(requiredBytes, availableBytes)
    }

    const startedAt = now()
    const planned: InventoryModel = {
      id: modelId,
      content_id: content,
      created: BigInt(startedAt),
      name: resolvedRepository,
      supported_parameters: [],
      availability: {
        type: "downloading",
        operation_id: operationId,
        stage: "queued",
        completed_bytes: BigInt(completedBytes),
        total_bytes: BigInt(totalBytes),
        current_component: Option.none(),
        started_at: BigInt(startedAt),
        updated_at: BigInt(startedAt),
      },
      source: {
        type: "hugging_face",
        repository: resolvedRepository,
        requested_revision: resolvedRevision,
        commit,
        metadata: Option.none(),
      },
      location: {
        type: "magnitude_cache",
        components: [...components],
        total_bytes: BigInt(totalBytes),
        integrity: { type: "unverified", reason: "download_in_progress" },
      },
      properties: { type: "pending" },
      operations: [],
      updated_at: BigInt(startedAt),
    }
    store.getModels().set(modelId, planned)

    const first = components[0]
    if (first !== undefined) {
      emitProgress(
        operation,
        operationId,
        modelId,
        "queued",
        completedBytes,
        totalBytes,
        first,
        0,
        completedBytes,
        components,
        0,
        startedAt,
        store,
      )
    }

    const releaseSlot = await state.downloadSlots.acquire()
    try {
      await ensureOwnedDirectory(repoRoot)
      await ensureOwnedDirectory(join(repoRoot, "blobs"))
      const started = Date.now()
      const resumedByComponent = components.map((component) => componentPartialLen(repoRoot, component))
      for (let index = 0; index < components.length; index += 1) {
        const component = components[index]!
        operation.ensureActive()
        const resumedFrom = resumedByComponent[index] ?? 0
        let lastProgressEmit = Date.now() - 100
        await downloadComponentWithRetry(
          state.http,
          resolvedRepository,
          commit,
          component,
          repoRoot,
          () => operation.cancelled.value,
          (fileCompleted, stage) => {
            const timestamp = Date.now()
            if (fileCompleted !== Number(component.size_bytes) && timestamp - lastProgressEmit < 100) {
              return
            }
            lastProgressEmit = timestamp
            const previousFiles = components
              .slice(0, index)
              .reduce((sum, item) => sum + Number(item.size_bytes), 0)
            const futureResumed = resumedByComponent
              .slice(index + 1)
              .reduce((sum, value) => sum + value, 0)
            const completed = previousFiles + fileCompleted + futureResumed
            const elapsed = (Date.now() - started) / 1000
            const previousTransferred = components
              .slice(0, index)
              .reduce(
                (sum, item, itemIndex) =>
                  sum + Number(item.size_bytes) - (resumedByComponent[itemIndex] ?? 0),
                0,
              )
            const transferred = previousTransferred + Math.max(0, fileCompleted - resumedFrom)
            const rate = elapsed > 0 && transferred > 0 ? transferred / elapsed : undefined
            emitProgress(
              operation,
              operationId,
              modelId,
              stage,
              completed,
              totalBytes,
              component,
              fileCompleted,
              resumedFrom,
              components,
              rate,
              startedAt,
              store,
            )
          },
        )
      }

      const last = components[components.length - 1]
      if (last !== undefined) {
        operation.channel.sendReplace({
          type: "progress",
          operation_id: operationId,
          model_id: modelId,
          stage: "verifying",
          completed_bytes: BigInt(totalBytes),
          total_bytes: BigInt(totalBytes),
          file: {
            path: last.path,
            completed_bytes: last.size_bytes,
            total_bytes: last.size_bytes,
          },
          bytes_per_second: Option.none(),
          resumed_from_bytes: 0n,
        })
      }

      operation.ensureActive()
      await publishPackageSnapshot(repoRoot, snapshot, commit, components)
      const readyAt = now()
      const primary = components
        .filter((component) => component.role === "weights" || component.role === "shard")
        .sort(
          (left, right) =>
            Option.getOrElse(left.shard_index, () => 0) - Option.getOrElse(right.shard_index, () => 0),
        )[0]
      if (primary === undefined) {
        throw new DownloadError("Internal", "published model has no runnable weight component", false, false)
      }
      const model = buildModel(
        modelId,
        content,
        startedAt,
        readyAt,
        {
          type: "hugging_face",
          repository: resolvedRepository,
          requested_revision: resolvedRevision,
          commit,
          metadata: Option.none(),
        },
        {
          type: "magnitude_cache",
          components: [...components],
          total_bytes: BigInt(totalBytes),
          integrity: { type: "verified", method: "content_identity" },
        },
        join(snapshot, primary.path),
        true,
        store.cache,
      )
      const ready = await store.completeAndPublishModel(model)
      operation.channel.sendReplace({
        type: "ready",
        operation_id: operationId,
        model: ready,
      })
    } finally {
      releaseSlot()
    }
  } finally {
    lock.release()
  }
}

const componentPartialLen = (repoRoot: string, component: ModelComponent): number =>
  resumableBytes(repoRoot, [component])

const emitProgress = (
  operation: DownloadOperation,
  operationId: string,
  modelId: InventoryEntryId,
  stage: DownloadStage,
  completedBytes: number,
  totalBytes: number,
  component: ModelComponent,
  fileCompleted: number,
  resumedFrom: number,
  components: readonly ModelComponent[],
  rate: number | undefined,
  startedAt: number,
  store: ManagedModelStore,
): void => {
  operation.channel.sendReplace({
    type: "progress",
    operation_id: operationId,
    model_id: modelId,
    stage,
    completed_bytes: BigInt(completedBytes),
    total_bytes: BigInt(totalBytes),
    file: {
      path: component.path,
      completed_bytes: BigInt(fileCompleted),
      total_bytes: component.size_bytes,
    },
    bytes_per_second: rate === undefined ? Option.none() : Option.some(rate),
    resumed_from_bytes: BigInt(resumedFrom),
  })
  const model = store.getModels().get(modelId)
  if (model !== undefined) {
    const updatedAt = now()
    store.getModels().set(modelId, {
      ...model,
      availability: {
        type: "downloading",
        operation_id: operationId,
        stage,
        completed_bytes: BigInt(completedBytes),
        total_bytes: BigInt(totalBytes),
        current_component: Option.some(component.path),
        started_at: BigInt(startedAt),
        updated_at: BigInt(updatedAt),
      },
      updated_at: BigInt(updatedAt),
    })
  }
}
