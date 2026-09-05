import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { contentIdentity } from "@magnitudedev/icn-contracts"
import {
  DownloadIntegrity,
  atomicJson,
  blobKey,
  componentPaths,
  publishPackageSnapshot,
  recoverCompletedBlob,
  recoverPartial,
  validateEquivalentFile,
} from "./download"

const modelComponent = (contents: Uint8Array) => {
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

describe("download", () => {
  it("streamed integrity matches the complete source digest", () => {
    const contents = new TextEncoder().encode("streamed model contents")
    const component = modelComponent(contents)
    const integrity = DownloadIntegrity.empty(component)
    integrity.update(contents.subarray(0, 8))
    integrity.update(contents.subarray(8))
    expect(integrity.verify(component)).toBeUndefined()
  })

  it("resumed integrity restores the existing prefix without re-reading it", async () => {
    const contents = new TextEncoder().encode("resumed model contents")
    const split = 9
    const component = modelComponent(contents)
    const directory = mkdtempSync(join(tmpdir(), "icn-download-"))
    const paths = componentPaths(directory, blobKey(component.content))
    writeFileSync(paths.partial, contents.subarray(0, split))
    const original = DownloadIntegrity.empty(component)
    original.update(contents.subarray(0, split))
    await atomicJson(paths.checkpoint, original.record(component))

    const integrity = await recoverPartial(paths, component)
    integrity.update(contents.subarray(split))
    expect(integrity.verify(component)).toBeUndefined()
    rmSync(directory, { recursive: true })
  })

  it("publishing the first revision creates the snapshot directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "icn-download-"))
    const repository = join(directory, "repository")
    const published = join(repository, "snapshots/current")
    const component = modelComponent(new TextEncoder().encode("verified"))
    const paths = componentPaths(join(repository, "blobs"), blobKey(component.content))
    mkdirSync(join(repository, "blobs"), { recursive: true })
    writeFileSync(paths.blob, new TextEncoder().encode("verified"))

    await publishPackageSnapshot(repository, published, "current", [component])
    expect(readFileSync(join(published, "model.gguf")).toString()).toBe("verified")
    rmSync(directory, { recursive: true })
  })

  it("equivalent revision requires matching path size and sha256", () => {
    const expected = modelComponent(new TextEncoder().encode("model contents"))
    const sha256 = expected.content.type === "sha256" ? expected.content.value : ""
    const metadata = { size: Number(expected.size_bytes), sha256 }
    expect(
      validateEquivalentFile("owner/repository", "a".repeat(40), "b".repeat(40), expected, metadata),
    ).toBeUndefined()
    expect(
      validateEquivalentFile("owner/repository", "a".repeat(40), "b".repeat(40), expected, {
        size: Number(expected.size_bytes) + 1,
        sha256,
      }),
    ).toBeDefined()
  })
})

import { mkdirSync, readFileSync } from "node:fs"
