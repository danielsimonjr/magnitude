import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { chmodSync } from "node:fs"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import {
  modelAssessmentIsValidFor,
  modelExecutionAssessmentHardware,
  type ContentId,
  type HardwareAssessment,
  type MemoryTopology,
  type ModelExecutionAssessment,
} from "@magnitudedev/icn-contracts"
import type { CachedModelAssessment } from "./models-types"
import { readBytes, readJson, readObject, writeBytesAtomic, writeJsonAtomic } from "./file-cache"

export type { CachedModelAssessment }

const MAX_INDEX_BYTES = 64 * 1024 * 1024
const MAX_BLOB_BYTES = 256 * 1024 * 1024

export type ModelIndexKind =
  | "Artifact"
  | "InventoryMetadata"
  | "GgufInspection"
  | "HuggingFaceRepositorySnapshot"
  | "RecommendableModelCatalog"
  | "ExecutionAssessment"
  | "ModelAssessment"
  | "HardwareCalibration"

const indexRelative = (kind: ModelIndexKind): string => {
  switch (kind) {
    case "Artifact":
      return "artifacts"
    case "InventoryMetadata":
      return "inventory/model-metadata"
    case "GgufInspection":
      return "inspections/gguf"
    case "HuggingFaceRepositorySnapshot":
      return "sources/hugging-face/repositories"
    case "RecommendableModelCatalog":
      return "catalogs/recommendable-models"
    case "ExecutionAssessment":
      return "assessments/execution"
    case "ModelAssessment":
      return "assessments/model-configurations"
    case "HardwareCalibration":
      return "hardware-calibrations"
  }
}

export type ModelBlobKind = "GgufHeader"

const blobRelative = (kind: ModelBlobKind): string => {
  switch (kind) {
    case "GgufHeader":
      return "gguf-headers"
  }
}

export class ModelCache {
  readonly root: string

  constructor(cacheRoot: string) {
    this.root = cacheRoot
  }

  readInventory(): Record<string, unknown> | undefined {
    return readObject(this.inventoryPath(), MAX_INDEX_BYTES)
  }

  writeInventory<T>(value: T): void {
    writeJsonAtomic(this.inventoryPath(), this.lockPath("inventory"), value, MAX_INDEX_BYTES)
  }

  readIndex<T>(kind: ModelIndexKind, evidence: string): T | undefined {
    return readJson<T>(this.indexPath(kind, evidence), MAX_INDEX_BYTES)
  }

  writeIndex<T>(kind: ModelIndexKind, evidence: string, value: T): void {
    const digest = evidenceDigest(evidence)
    writeJsonAtomic(
      this.indexPathForDigest(kind, digest),
      this.lockPath(`index-${digest}`),
      value,
      MAX_INDEX_BYTES,
    )
  }

  readLoadTimingStore<T>(): T | undefined {
    return readJson<T>(this.loadTimingPath(), MAX_INDEX_BYTES)
  }

  writeLoadTimingStore<T>(value: T): void {
    writeJsonAtomic(this.loadTimingPath(), this.lockPath("load-timings"), value, MAX_INDEX_BYTES)
  }

  readExecutionAssessment(
    contentId: ContentId,
    executionEvidence: string,
    topology: MemoryTopology,
  ): ModelExecutionAssessment | undefined {
    const assessment = this.readIndex<ModelExecutionAssessment>(
      "ExecutionAssessment",
      hardwareAssessmentEvidence(contentId, executionEvidence),
    )
    if (assessment === undefined) {
      return undefined
    }
    return topology.validatesHardwareAssessment(modelExecutionAssessmentHardware(assessment))
      ? assessment
      : undefined
  }

  writeExecutionAssessment(
    contentId: ContentId,
    executionEvidence: string,
    assessment: ModelExecutionAssessment,
  ): void {
    if (isTerminalAssessment(modelExecutionAssessmentHardware(assessment))) {
      this.writeIndex(
        "ExecutionAssessment",
        hardwareAssessmentEvidence(contentId, executionEvidence),
        assessment,
      )
    }
  }

  readModelAssessment(
    evidence: string,
    topology: MemoryTopology,
  ): CachedModelAssessment | undefined {
    const assessment = this.readIndex<CachedModelAssessment>("ModelAssessment", evidence)
    if (assessment === undefined) {
      return undefined
    }
    return modelAssessmentIsValidFor(assessment.profile, topology) ? assessment : undefined
  }

  writeModelAssessment(evidence: string, assessment: CachedModelAssessment): void {
    this.writeIndex("ModelAssessment", evidence, assessment)
  }

  readBlob(kind: ModelBlobKind, digest: string): Uint8Array | undefined {
    if (!validDigest(digest)) {
      return undefined
    }
    const bytes = readBytes(this.blobPath(kind, digest), MAX_BLOB_BYTES)
    if (bytes === undefined) {
      return undefined
    }
    return hexSha256(bytes) === digest ? bytes : undefined
  }

  writeBlob(kind: ModelBlobKind, digest: string, bytes: Uint8Array): void {
    if (!validDigest(digest) || hexSha256(bytes) !== digest) {
      return
    }
    writeBytesAtomic(this.blobPath(kind, digest), this.lockPath(`blob-${digest}`), bytes, MAX_BLOB_BYTES)
  }

  workspace(): ModelCacheWorkspace {
    const workRoot = join(this.root, ".work")
    try {
      mkdirSync(workRoot, { recursive: true })
      const random = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
      const path = join(workRoot, random)
      mkdirSync(path, { recursive: true })
      if (process.platform !== "win32") {
        chmodSync(path, 0o700)
      }
      return new ModelCacheWorkspace(path, false)
    } catch {
      const path = mkdtempSync(join(tmpdir(), "magnitude-model-preview-"))
      return new ModelCacheWorkspace(path, true)
    }
  }

  inventoryPath(): string {
    return join(this.root, "indexes/inventory.json")
  }

  loadTimingPath(): string {
    return join(this.root, "indexes/runtime/load-timings.json")
  }

  indexPath(kind: ModelIndexKind, evidence: string): string {
    return this.indexPathForDigest(kind, evidenceDigest(evidence))
  }

  indexPathForDigest(kind: ModelIndexKind, digest: string): string {
    return join(this.root, "indexes", indexRelative(kind), `${digest}.json`)
  }

  blobPath(kind: ModelBlobKind, digest: string): string {
    return join(this.root, "blobs", blobRelative(kind), digest)
  }

  lockPath(name: string): string {
    return join(this.root, ".locks", `${name}.lock`)
  }
}

export class ModelCacheWorkspace {
  readonly path: string
  private readonly temporary: boolean

  constructor(path: string, temporary: boolean) {
    this.path = path
    this.temporary = temporary
  }

  [Symbol.dispose](): void {
    if (!this.temporary) {
      try {
        rmSync(this.path, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }
}

const evidenceDigest = (evidence: string): string => hexSha256(new TextEncoder().encode(evidence))

const hardwareAssessmentEvidence = (contentId: ContentId, hardwareEvidence: string): string =>
  `${contentId}:${hardwareEvidence}`

const isTerminalAssessment = (assessment: HardwareAssessment): boolean =>
  assessment.type === "fits" ||
  assessment.type === "does_not_fit" ||
  assessment.type === "invalid_artifact" ||
  assessment.type === "incompatible_artifact"

export const hexSha256 = (bytes: Uint8Array): string => bytesToHex(sha256(bytes))

const validDigest = (value: string): boolean =>
  value.length === 64 && /^[0-9a-f]+$/.test(value)
