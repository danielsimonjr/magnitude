import { realpathSync } from "node:fs"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import type { ContentId, ContentIdentity, InventoryEntryId, ModelComponent } from "./_contracts-shim"
import { ContentId as ContentIdBrand, InventoryEntryId as InventoryEntryIdBrand } from "./_contracts-shim"

const roleLabel = (role: ModelComponent["role"]): string => {
  switch (role) {
    case "Weights":
      return "Weights"
    case "Shard":
      return "Shard"
    case "Projector":
      return "Projector"
    case "Draft":
      return "Draft"
    case "Mtp":
      return "Mtp"
    case "Auxiliary":
      return "Auxiliary"
  }
}

const contentIdentityBytes = (content: ContentIdentity): Uint8Array => {
  const parts: Uint8Array[] = []
  switch (content._tag) {
    case "Sha256":
      parts.push(new TextEncoder().encode("sha256\0"), new TextEncoder().encode(content.value))
      break
    case "GitOid":
      parts.push(new TextEncoder().encode("git-oid\0"), new TextEncoder().encode(content.value))
      break
    case "Xet":
      parts.push(new TextEncoder().encode("xet\0"), new TextEncoder().encode(content.value))
      break
    case "FileIdentity":
      parts.push(new TextEncoder().encode("file-identity\0"), new TextEncoder().encode(content.value))
      break
    case "Unknown":
      parts.push(new TextEncoder().encode("unknown"))
      break
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    merged.set(part, offset)
    offset += part.length
  }
  return merged
}

export const inventoryEntryId = (
  sourceKind: string,
  sourceLocation: string,
  contentId: ContentId,
): InventoryEntryId => {
  let canonical = sourceLocation
  try {
    canonical = realpathSync(sourceLocation)
  } catch {
    // keep original
  }
  const digest = sha256.create()
  digest.update(new TextEncoder().encode("magnitude-model-id-v1\0"))
  digest.update(new TextEncoder().encode(sourceKind))
  digest.update(new Uint8Array([0]))
  digest.update(new TextEncoder().encode(canonical))
  digest.update(new Uint8Array([0]))
  digest.update(new TextEncoder().encode(contentId))
  return InventoryEntryIdBrand.make(`mdl_${bytesToHex(digest.digest())}`)
}

export const contentId = (components: readonly ModelComponent[]): ContentId => {
  const ordered = [...components].sort((left, right) => left.path.localeCompare(right.path))
  const digest = sha256.create()
  digest.update(new TextEncoder().encode("magnitude-content-id-v1\0"))
  for (const component of ordered) {
    digest.update(new TextEncoder().encode(component.path))
    digest.update(new Uint8Array([0]))
    digest.update(new TextEncoder().encode(roleLabel(component.role)))
    digest.update(new Uint8Array([0]))
    const size = new Uint8Array(8)
    new DataView(size.buffer).setBigUint64(0, BigInt(component.size_bytes), true)
    digest.update(size)
    digest.update(new Uint8Array([0]))
    digest.update(contentIdentityBytes(component.content))
    digest.update(new Uint8Array([0]))
    const shard = new Uint8Array(4)
    new DataView(shard.buffer).setUint32(0, component.shard_index ?? 0xffffffff, true)
    digest.update(shard)
    digest.update(new Uint8Array([0]))
  }
  return ContentIdBrand.make(`content_${bytesToHex(digest.digest())}`)
}

export const fingerprint = (bytes: Uint8Array): string => `sha256:${bytesToHex(sha256(bytes))}`
