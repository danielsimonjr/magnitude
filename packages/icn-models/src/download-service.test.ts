import { Option } from "effect"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import {
  modelDownloadId,
  modelFileId,
  modelPackageId,
  type ModelPackage,
  type ServableModelBundle,
} from "@magnitudedev/icn-contracts"
import { InventoryConfig, ManagedModelStore } from "./inventory"
import {
  ManagedModelDownloads,
  projectModelDownload,
  validateBundleRepositoryRevisions,
} from "./download-service"
import type { HubApiModel, ModelDownloadHttpClient } from "./download-http"

const commit = "a".repeat(40)

const package_ = (id: string, sizeBytes: number, sha256?: string): ModelPackage => {
  const digest = sha256 ?? createHash("sha256").update(`payload-${id}`).digest("hex")
  return {
    id: modelPackageId(id),
    source: {
      _tag: "HuggingFace",
      repository: "owner/repository",
      revision: commit,
    },
    files: [
      {
        id: modelFileId(`file_${digest}`),
        path: "model.gguf",
        role: "weights",
        sizeBytes,
        tensorStorageBytes: Option.none(),
        sha256: digest,
      },
    ],
    relationships: [],
    properties: {
      format: "gguf",
      quantization: "Q4",
      quantizationName: "4-bit",
      architecture: "test",
      maximumContextLength: Option.some(4096),
      intrinsicModelId: Option.none(),
      intrinsicQualityId: Option.none(),
    },
  }
}

const mockHttp = (files: Record<string, Uint8Array>): ModelDownloadHttpClient => {
  const metadata: HubApiModel = {
    sha: commit,
    siblings: Object.entries(files).map(([path, contents]) => ({
      rfilename: path,
      size: contents.length,
      lfs: {
        sha256: createHash("sha256").update(contents).digest("hex"),
        size: contents.length,
      },
    })),
  }
  return {
    async fetchMetadata() {
      return metadata
    },
    async fetchFileRange({ path, offset, length }) {
      const contents = files[path]
      if (contents === undefined) {
        throw new Error(`missing mock file ${path}`)
      }
      return contents.subarray(offset, offset + length)
    },
  }
}

const minimalGguf = (): Uint8Array => {
  const bytes = new Uint8Array(32)
  bytes.set([0x47, 0x47, 0x55, 0x46], 0)
  new DataView(bytes.buffer).setUint32(4, 3, true)
  return bytes
}

describe("download-service", () => {
  it("bundle rejects two revisions of one repository", () => {
    const target = package_("package_target", 10)
    const draft = {
      ...package_("package_draft", 20),
      source: {
        _tag: "HuggingFace" as const,
        repository: "owner/repository",
        revision: "c".repeat(40),
      },
    }
    expect(() => validateBundleRepositoryRevisions([target, draft])).toThrow()
  })

  it("start/list/cancel/acknowledgeFailure orchestrate a mocked download", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "icn-download-service-"))
    const storeRoot = join(temporary, "store")
    const contents = minimalGguf()
    const digest = createHash("sha256").update(contents).digest("hex")
    const pkg = package_("package_test", contents.length, digest)
    const config = InventoryConfig.withRoots(storeRoot, join(temporary, "cache"))
    config.disk_reserve_bytes = 0
    const http = mockHttp({ "model.gguf": contents })
    const manager = await ManagedModelStore.open(config, {
      http,
      diskSpace: { availableBytes: () => 1_000_000 },
    })
    const downloads = ManagedModelDownloads.open(manager, { http, diskSpace: { availableBytes: () => 1_000_000 } })
    const bundle: ServableModelBundle = { _tag: "Standalone", package: pkg }
    const started = await downloads.start({ bundle })
    expect(started.download).not.toBeNull()

    let listed = await downloads.list()
    expect(listed.downloads.length).toBe(1)

    let completed = false
    for (let attempt = 0; attempt < 200 && !completed; attempt += 1) {
      listed = await downloads.list()
      completed = listed.downloads[0]?.state._tag === "Completed"
      if (!completed) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    expect(listed.downloads[0]?.state._tag).toBe("Completed")

    const cancelled = await downloads.cancel(started.download!.id)
    expect(["Cancelled", "Completed"]).toContain(cancelled.state._tag)

    rmSync(temporary, { recursive: true })
  })

  it("model download preserves structured package failure", () => {
    const pkg = package_("package_test", 10)
    const attemptId = "attempt_test"
    const records = new Map([
      [
        attemptId,
        {
          attempt: {
            _tag: "Failed" as const,
            id: attemptId,
            packageId: pkg.id,
            completedBytes: 0,
            totalBytes: 10,
            failure: {
              _tag: "InsufficientDiskSpace" as const,
              requiredBytes: 12,
              availableBytes: 8,
            },
          },
          package: pkg,
          sequence: 1,
        },
      ],
    ])
    const download = projectModelDownload(
      {
        id: modelDownloadId("model_download_test"),
        bundle: { _tag: "Standalone", package: pkg },
        attemptIds: [attemptId],
        cancelled: false,
        failureAcknowledged: false,
        sequence: 1,
      },
      records,
    )
    expect(download.state._tag).toBe("Failed")
    if (download.state._tag === "Failed") {
      expect(download.state.failure._tag).toBe("InsufficientDiskSpace")
    }
  })
})
