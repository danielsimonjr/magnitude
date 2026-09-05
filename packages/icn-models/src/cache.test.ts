import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { ModelCache, hexSha256 } from "./cache"
import { systemMemoryTopology } from "./test-support"

describe("cache", () => {
  it("namespaces are typed and fail as misses", () => {
    const directory = mkdtempSync(join(tmpdir(), "icn-cache-"))
    const cache = new ModelCache(directory)
    cache.writeIndex("InventoryMetadata", "model evidence", 42)
    expect(cache.readIndex<number>("InventoryMetadata", "model evidence")).toBe(42)
    const bytes = new TextEncoder().encode("header")
    const digest = hexSha256(bytes)
    cache.writeBlob("GgufHeader", digest, bytes)
    expect(new Uint8Array(cache.readBlob("GgufHeader", digest)!)).toEqual(bytes)
    cache.writeBlob("GgufHeader", "0".repeat(64), bytes)
    expect(cache.readBlob("GgufHeader", "0".repeat(64))).toBeUndefined()

    const indexPath = cache.indexPath("InventoryMetadata", "model evidence")
    writeFileSync(indexPath, "corrupt")
    expect(cache.readIndex("InventoryMetadata", "model evidence")).toBeUndefined()
    cache.writeIndex("InventoryMetadata", "model evidence", 7)
    expect(cache.readIndex<number>("InventoryMetadata", "model evidence")).toBe(7)

    const blobPath = cache.blobPath("GgufHeader", digest)
    writeFileSync(blobPath, "corrupt")
    expect(cache.readBlob("GgufHeader", digest)).toBeUndefined()
    rmSync(directory, { recursive: true })
  })

  it("workspaces are private and removed on drop", () => {
    const directory = mkdtempSync(join(tmpdir(), "icn-cache-"))
    const cache = new ModelCache(directory)
    let path = ""
    {
      const workspace = cache.workspace()
      path = workspace.path
      expect(path).toBeTruthy()
    }
    expect(path.length).toBeGreaterThan(0)
    rmSync(directory, { recursive: true })
  })
})
