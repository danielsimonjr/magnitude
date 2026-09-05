import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { contentIdentity } from "@magnitudedev/icn-contracts"
import { downloadComponentWithRetry } from "./download"
import { resolveDownloadRevision, type HubApiModel, type ModelDownloadHttpClient } from "./download-http"
import { InventoryConfig, ManagedModelStore } from "./inventory"
import { ManagedModelDownloads } from "./download-service"

const commit = "a".repeat(40)

const component = (contents: Uint8Array) => {
  const digest = createHash("sha256").update(contents).digest("hex")
  return {
    path: "model.gguf",
    role: "weights" as const,
    size_bytes: BigInt(contents.length),
    content: contentIdentity.sha256(digest),
    shard_index: Option.none(),
    relationship: Option.none(),
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

describe("download-http", () => {
  it("resolves an immutable revision from mocked metadata", async () => {
    const contents = new TextEncoder().encode("model contents")
    const resolved = await resolveDownloadRevision(
      mockHttp({ "model.gguf": contents }),
      "owner/repository",
      commit,
      [component(contents)],
    )
    expect(resolved).toBe(commit)
  })

  it("downloads and verifies a component through the store", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "icn-download-http-"))
    const storeRoot = join(temporary, "store")
    const contents = new TextEncoder().encode("verified model bytes")
    const http = mockHttp({ "model.gguf": contents })
    const config = InventoryConfig.withRoots(storeRoot, join(temporary, "cache"))
    config.disk_reserve_bytes = 0
    const manager = await ManagedModelStore.open(config, {
      http,
      diskSpace: { availableBytes: () => 1_000_000 },
    })
    const repoRoot = join(storeRoot, "hub", "models--owner--repository")
    await downloadComponentWithRetry(
      http,
      "owner/repository",
      commit,
      component(contents),
      repoRoot,
      () => false,
      () => undefined,
    )
    const digest = createHash("sha256").update(contents).digest("hex")
    const blob = join(repoRoot, "blobs", `lfs-sha256-${digest}`)
    expect(require("node:fs").readFileSync(blob).equals(contents)).toBe(true)
    rmSync(temporary, { recursive: true })
  })
})
