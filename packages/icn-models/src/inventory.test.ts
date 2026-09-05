import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { InventoryConfig, ManagedModelStore, discoverGroups, isExecutionCompanionName, parseHfRepoDir, splitShardName } from "./inventory"

const writeMinimalGguf = (path: string) => {
  const bytes = new Uint8Array(32)
  bytes.set([0x47, 0x47, 0x55, 0x46], 0)
  new DataView(bytes.buffer).setUint32(4, 3, true)
  writeFileSync(path, bytes)
}

describe("inventory", () => {
  it("configured store does not adopt host hugging face caches", () => {
    const config = InventoryConfig.withRoots("/tmp/store", "/tmp/cache")
    expect(config.hf_cache_dirs).toEqual([])
  })

  it("accepts Windows absolute store and cache roots", () => {
    const config = InventoryConfig.withRoots(
      "D:\\a\\magnitude\\magnitude\\model-store",
      "D:\\a\\magnitude\\magnitude\\cache",
    )
    expect(config.root).toBe("D:\\a\\magnitude\\magnitude\\model-store")
    expect(config.cache_root).toBe("D:\\a\\magnitude\\magnitude\\cache")
  })

  it("rejects relative store and cache roots", () => {
    expect(() => InventoryConfig.withRoots("model-store", "/tmp/cache")).toThrow(
      /must be absolute/,
    )
  })

  it("recognizes only complete split names", () => {
    expect(splitShardName("model-00001-of-00002.gguf")?.index).toBe(1)
    expect(splitShardName("model-1-of-2.gguf")).toBeUndefined()
  })

  it("parses hugging face cache repository directory", () => {
    expect(parseHfRepoDir("models--Qwen--Qwen3")).toBe("Qwen/Qwen3")
    expect(parseHfRepoDir("datasets--owner--name")).toBeUndefined()
  })

  it("excludes execution companions from standalone model groups", () => {
    const temporary = mkdtempSync(join(tmpdir(), "icn-inventory-"))
    writeMinimalGguf(join(temporary, "laguna-s-2.1-Q4_K_M.gguf"))
    writeMinimalGguf(join(temporary, "unlabelled-laguna-companion.gguf"))
    const groups = discoverGroups(temporary, temporary)
    expect(groups.length).toBeGreaterThanOrEqual(1)
    expect(isExecutionCompanionName("qwen-mtp-bf16.gguf")).toBe(true)
    rmSync(temporary, { recursive: true })
  })

  it("installed package listing reports discovered package", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "icn-inventory-"))
    const store = join(temporary, "store")
    const hfCache = join(temporary, "hf-cache")
    const snapshot = join(hfCache, "models--test--model/snapshots/0123456789abcdef")
    mkdirSync(snapshot, { recursive: true })
    writeMinimalGguf(join(snapshot, "model.gguf"))

    const config = InventoryConfig.withRoots(store, join(temporary, "cache"))
    config.hf_cache_dirs.push(hfCache)
    const manager = await ManagedModelStore.open(config)
    await manager.ensureInstalledModelInventory()
    const installed = await manager.listInstalled()
    expect(installed.packages.length).toBe(1)
    expect(installed.packages[0].origin).toBe("HuggingFaceCache")
    const assessed = await manager.list()
    expect(assessed.length).toBe(1)
    rmSync(temporary, { recursive: true })
  })
})
