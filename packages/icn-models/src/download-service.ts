import { Option } from "effect"
import {
  InventoryError,
  modelDownloadId,
  type DownloadFailure,
  type DownloadStage,
  type ModelDownload,
  type ModelDownloadId,
  type ModelDownloadsInvalidation,
  type ModelPackage,
  type ModelPackageId,
  type ModelPackageSource,
  type ServableModelBundle,
  type StartModelDownloadRequest,
} from "@magnitudedev/icn-contracts"
import type { ManagedModelStore } from "./inventory"
import {
  cancelPackageDownload,
  createModelStoreDownloadState,
  startTargetDownloads,
  type ModelStoreDownloadOptions,
  type ModelStoreDownloadState,
} from "./download-store"

type DownloadAttemptId = string

type DownloadAttempt =
  | {
      readonly _tag: "Pending"
      readonly id: DownloadAttemptId
      readonly packageId: ModelPackageId
    }
  | {
      readonly _tag: "Downloading"
      readonly id: DownloadAttemptId
      readonly packageId: ModelPackageId
      readonly stage: DownloadStage
      readonly completedBytes: number
      readonly totalBytes: number
      readonly bytesPerSecond: number | undefined
    }
  | {
      readonly _tag: "Completed"
      readonly id: DownloadAttemptId
      readonly packageId: ModelPackageId
    }
  | {
      readonly _tag: "Failed"
      readonly id: DownloadAttemptId
      readonly packageId: ModelPackageId
      readonly completedBytes: number
      readonly totalBytes: number
      readonly failure: DownloadFailure
    }
  | {
      readonly _tag: "Cancelled"
      readonly id: DownloadAttemptId
      readonly packageId: ModelPackageId
      readonly completedBytes: number
      readonly totalBytes: number
    }

interface AttemptRecord {
  attempt: DownloadAttempt
  package: ModelPackage
  sequence: number
}

interface DownloadRecord {
  id: ModelDownloadId
  bundle: ServableModelBundle
  attemptIds: DownloadAttemptId[]
  cancelled: boolean
  failureAcknowledged: boolean
  sequence: number
}

const randomAttemptId = (): DownloadAttemptId => randomId("download")
const randomDownloadId = (): ModelDownloadId => modelDownloadId(randomId("model_download"))

const randomId = (prefix: string): string => {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return `${prefix}_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

const bundlePackages = (bundle: ServableModelBundle): ModelPackage[] => {
  switch (bundle._tag) {
    case "Standalone":
      return [bundle.package]
    case "SpeculativeDecoding":
      return bundle.draftSource._tag === "Embedded"
        ? [bundle.target]
        : [bundle.target, bundle.draftSource.draft]
  }
}

const validateBundleRepositoryRevisions = (packages: readonly ModelPackage[]): void => {
  const revisions = new Map<string, string>()
  for (const package_ of packages) {
    if (package_.source._tag !== "HuggingFace") {
      continue
    }
    const existing = revisions.get(package_.source.repository)
    if (existing !== undefined && existing !== package_.source.revision) {
      throw InventoryError.InvalidRequest({
        message: `a model bundle cannot require multiple revisions of ${package_.source.repository}`,
      })
    }
    revisions.set(package_.source.repository, package_.source.revision)
  }
}

const packageBytes = (package_: ModelPackage): number =>
  package_.files.reduce((sum, file) => sum + file.sizeBytes, 0)

const attemptProgress = (attempt: DownloadAttempt): [number, number] => {
  switch (attempt._tag) {
    case "Downloading":
    case "Failed":
    case "Cancelled":
      return [attempt.completedBytes, attempt.totalBytes]
    case "Pending":
    case "Completed":
      return [0, 0]
  }
}

const attemptIdentity = (attempt: DownloadAttempt): [DownloadAttemptId, ModelPackageId] => {
  return [attempt.id, attempt.packageId]
}

const modelDownload = (
  record: DownloadRecord,
  attempts: ReadonlyMap<DownloadAttemptId, AttemptRecord>,
): ModelDownload => {
  const admitted = record.attemptIds
    .map((id) => attempts.get(id))
    .filter((entry): entry is AttemptRecord => entry !== undefined)
  const totalBytes = admitted.reduce((sum, entry) => sum + packageBytes(entry.package), 0)
  const attemptedBytes = admitted.reduce((sum, entry) => {
    switch (entry.attempt._tag) {
      case "Completed":
        return sum + packageBytes(entry.package)
      case "Downloading":
      case "Failed":
      case "Cancelled":
        return sum + entry.attempt.completedBytes
      case "Pending":
        return sum
    }
  }, 0)
  const completedBytes = Math.min(attemptedBytes, totalBytes)
  const missingAttempt = admitted.length !== record.attemptIds.length
  const state = (() => {
    if (record.cancelled) {
      return {
        _tag: "Cancelled" as const,
        completedBytes,
        totalBytes,
      }
    }
    if (missingAttempt) {
      return {
        _tag: "Failed" as const,
        completedBytes,
        totalBytes,
        failure: {
          _tag: "Internal" as const,
          message: "model download references missing package-attempt state",
        },
        acknowledged: record.failureAcknowledged,
      }
    }
    const failure = admitted
      .map((entry) => entry.attempt)
      .find((attempt): attempt is Extract<DownloadAttempt, { _tag: "Failed" }> => attempt._tag === "Failed")
    if (failure !== undefined) {
      return {
        _tag: "Failed" as const,
        completedBytes,
        totalBytes,
        failure: failure.failure,
        acknowledged: record.failureAcknowledged,
      }
    }
    if (admitted.some((entry) => entry.attempt._tag === "Cancelled")) {
      return { _tag: "Cancelled" as const, completedBytes, totalBytes }
    }
    if (admitted.some((entry) => entry.attempt._tag === "Downloading")) {
      const active = admitted
        .map((entry) => entry.attempt)
        .filter((attempt): attempt is Extract<DownloadAttempt, { _tag: "Downloading" }> => attempt._tag === "Downloading")
      return {
        _tag: "Downloading" as const,
        stage: active[0]?.stage ?? "queued",
        completedBytes,
        totalBytes,
        bytesPerSecond: active.reduce<Option.Option<number>>((sum, entry) => {
          if (entry.bytesPerSecond === undefined) {
            return sum
          }
          return Option.some(Option.getOrElse(sum, () => 0) + entry.bytesPerSecond)
        }, Option.none()),
      }
    }
    if (admitted.some((entry) => entry.attempt._tag === "Pending")) {
      return { _tag: "Pending" as const, completedBytes, totalBytes }
    }
    return { _tag: "Completed" as const }
  })()
  return {
    id: record.id,
    bundle: record.bundle,
    state,
  }
}

const attemptHasOtherLiveDownload = (
  attemptId: DownloadAttemptId,
  excludedId: ModelDownloadId,
  downloads: ReadonlyMap<ModelDownloadId, DownloadRecord>,
  attempts: ReadonlyMap<DownloadAttemptId, AttemptRecord>,
): boolean =>
  [...downloads.values()].some((other) => {
    if (other.id === excludedId || other.cancelled || !other.attemptIds.includes(attemptId)) {
      return false
    }
    const state = modelDownload(other, attempts).state
    return state._tag === "Pending" || state._tag === "Downloading"
  })

export class ManagedModelDownloads {
  private readonly records = new Map<DownloadAttemptId, AttemptRecord>()
  private readonly downloads = new Map<ModelDownloadId, DownloadRecord>()
  private startGuard: Promise<void> = Promise.resolve()
  private revision = 0
  private readonly listeners = new Set<(event: ModelDownloadsInvalidation) => void>()

  private constructor(
    private readonly manager: ManagedModelStore,
    private readonly storeState: ModelStoreDownloadState,
  ) {}

  static open(
    manager: ManagedModelStore,
    options: ModelStoreDownloadOptions = {},
  ): ManagedModelDownloads {
    const state =
      Object.keys(options).length === 0
        ? manager.downloadState
        : createModelStoreDownloadState(manager.config.max_concurrent_downloads, options)
    return new ManagedModelDownloads(manager, state)
  }

  private invalidate(): void {
    this.revision += 1
    const event = { revision: BigInt(this.revision) }
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  private updateAttempt(id: DownloadAttemptId, attempt: DownloadAttempt): void {
    const record = this.records.get(id)
    if (record === undefined) {
      return
    }
    record.attempt = attempt
    this.invalidate()
  }

  async start(request: StartModelDownloadRequest): Promise<{ download: ModelDownload | null }> {
    const previous = this.startGuard
    let release!: () => void
    this.startGuard = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      const packages = bundlePackages(request.bundle)
      const uniquePackageIds = new Set(packages.map((package_) => package_.id))
      if (uniquePackageIds.size !== packages.length) {
        throw InventoryError.InvalidRequest({
          message: "a separate speculative draft must be distinct from its target",
        })
      }
      validateBundleRepositoryRevisions(packages)

      const active = packages.map((package_) => {
        for (const record of this.records.values()) {
          if (
            record.package.id === package_.id &&
            (record.attempt._tag === "Pending" || record.attempt._tag === "Downloading")
          ) {
            return record.attempt
          }
        }
        return undefined
      })

      const candidates = packages.filter((_, index) => active[index] === undefined)
      const missing: ModelPackage[] = []
      for (const package_ of candidates) {
        try {
          this.manager.installedPackageFromSnapshot(package_.id)
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "_tag" in error &&
            (error as { _tag: string })._tag === "NotFound"
          ) {
            missing.push(package_)
          } else {
            throw error
          }
        }
      }

      const newAttempts = missing.map((package_) => {
        const id = randomAttemptId()
        return {
          id,
          attempt: { _tag: "Pending" as const, id, packageId: package_.id },
        }
      })

      const streams = await startTargetDownloads(this.manager, this.storeState, missing)
      if (streams.length !== missing.length) {
        throw InventoryError.Internal({
          message: "download admission returned an unexpected number of streams",
        })
      }

      const admitted: DownloadAttempt[] = active.filter(
        (attempt): attempt is NonNullable<typeof attempt> => attempt !== undefined,
      )
      let sequence =
        [...this.records.values()].reduce((max, record) => Math.max(max, record.sequence), 0) + 1
      for (const [index, package_] of missing.entries()) {
        const created = newAttempts[index]
        if (created === undefined) {
          continue
        }
        this.records.set(created.id, {
          attempt: created.attempt,
          package: package_,
          sequence,
        })
        sequence += 1
      }

      for (const [index, package_] of missing.entries()) {
        const created = newAttempts[index]
        const stream = streams[index]
        if (created === undefined || stream === undefined) {
          continue
        }
        void this.consume(created.id, package_, stream)
        admitted.push(created.attempt)
      }

      if (admitted.length === 0) {
        return { download: null }
      }

      const id = randomDownloadId()
      const record: DownloadRecord = {
        id,
        bundle: request.bundle,
        attemptIds: admitted.map((attempt) => attemptIdentity(attempt)[0]),
        cancelled: false,
        failureAcknowledged: false,
        sequence: 0,
      }
      const projected = modelDownload(record, this.records)
      record.sequence =
        [...this.downloads.values()].reduce((max, entry) => Math.max(max, entry.sequence), 0) + 1
      this.downloads.set(id, record)
      this.invalidate()
      return { download: projected }
    } finally {
      release()
    }
  }

  async list(): Promise<{ downloads: readonly ModelDownload[] }> {
    return {
      downloads: [...this.downloads.values()]
        .sort((left, right) => left.sequence - right.sequence)
        .map((record) => modelDownload(record, this.records)),
    }
  }

  async cancel(id: ModelDownloadId): Promise<ModelDownload> {
    const current = this.downloads.get(id)
    if (current === undefined) {
      throw InventoryError.NotFound({ id: String(id) })
    }
    const projected = modelDownload(current, this.records)
    if (projected.state._tag !== "Pending" && projected.state._tag !== "Downloading") {
      return projected
    }
    current.cancelled = true
    const unsharedAttemptIds = current.attemptIds.filter(
      (attemptId) => !attemptHasOtherLiveDownload(attemptId, id, this.downloads, this.records),
    )
    for (const attemptId of unsharedAttemptIds) {
      const attempt = this.records.get(attemptId)
      if (attempt === undefined) {
        continue
      }
      if (attempt.attempt._tag !== "Pending" && attempt.attempt._tag !== "Downloading") {
        continue
      }
      try {
        await cancelPackageDownload(this.manager, this.storeState, attempt.package)
        const [completedBytes, totalBytes] = attemptProgress(attempt.attempt)
        this.updateAttempt(attemptId, {
          _tag: "Cancelled",
          id: attemptId,
          packageId: attempt.package.id,
          completedBytes,
          totalBytes,
        })
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          (error as { _tag: string })._tag === "NotFound"
        ) {
          continue
        }
        throw error
      }
    }
    const download = modelDownload(current, this.records)
    this.invalidate()
    return download
  }

  async acknowledgeFailure(id: ModelDownloadId): Promise<ModelDownload> {
    const record = this.downloads.get(id)
    if (record === undefined) {
      throw InventoryError.NotFound({ id: String(id) })
    }
    const projected = modelDownload(record, this.records)
    if (projected.state._tag !== "Failed") {
      throw InventoryError.InvalidRequest({
        message: `model download ${String(id)} has not failed`,
      })
    }
    record.failureAcknowledged = true
    const download = modelDownload(record, this.records)
    this.invalidate()
    return download
  }

  watch(): AsyncIterable<ModelDownloadsInvalidation> {
    const service = this
    return {
      async *[Symbol.asyncIterator]() {
        yield { revision: BigInt(service.revision) }
        while (true) {
          const event = await new Promise<ModelDownloadsInvalidation>((resolve) => {
            const listener = (value: ModelDownloadsInvalidation) => {
              service.listeners.delete(listener)
              resolve(value)
            }
            service.listeners.add(listener)
          })
          yield event
        }
      },
    }
  }

  private async consume(
    id: DownloadAttemptId,
    package_: ModelPackage,
    stream: AsyncIterable<import("@magnitudedev/icn-contracts").ModelDownloadEvent>,
  ): Promise<void> {
    let completedBytes = 0
    let totalBytes = 0
    let terminal = false
    for await (const event of stream) {
      const attempt = (() => {
        switch (event.type) {
          case "resolving":
            return { _tag: "Pending" as const, id, packageId: package_.id }
          case "checking_space":
            return {
              _tag: "Downloading" as const,
              id,
              packageId: package_.id,
              stage: "checking_space" as const,
              completedBytes: Number(event.completed_bytes),
              totalBytes: Number(event.total_bytes),
              bytesPerSecond: undefined,
            }
          case "progress":
            return {
              _tag: "Downloading" as const,
              id,
              packageId: package_.id,
              stage: event.stage,
              completedBytes: Number(event.completed_bytes),
              totalBytes: Number(event.total_bytes),
              bytesPerSecond:
                Option.isSome(event.bytes_per_second) ? Math.round(event.bytes_per_second.value) : undefined,
            }
          case "ready":
            return { _tag: "Completed" as const, id, packageId: package_.id }
          case "cancelled":
            return {
              _tag: "Cancelled" as const,
              id,
              packageId: package_.id,
              completedBytes: Number(event.completed_bytes),
              totalBytes: Number(event.total_bytes),
            }
          case "failed":
            return {
              _tag: "Failed" as const,
              id,
              packageId: package_.id,
              completedBytes: Number(event.completed_bytes),
              totalBytes: Number(event.total_bytes),
              failure: event.error,
            }
        }
      })()
      const isTerminal =
        attempt._tag === "Completed" || attempt._tag === "Failed" || attempt._tag === "Cancelled"
      ;[completedBytes, totalBytes] = attemptProgress(attempt)
      this.updateAttempt(id, attempt)
      if (isTerminal) {
        terminal = true
        break
      }
    }
    if (!terminal) {
      this.updateAttempt(id, {
        _tag: "Failed",
        id,
        packageId: package_.id,
        completedBytes,
        totalBytes,
        failure: { _tag: "Interrupted" },
      })
    }
  }
}

export {
  attemptHasOtherLiveDownload,
  modelDownload as projectModelDownload,
  validateBundleRepositoryRevisions,
}
