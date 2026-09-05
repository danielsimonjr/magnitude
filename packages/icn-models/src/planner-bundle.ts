import { createHash } from "node:crypto"
import { gunzipSync, gzipSync } from "node:zlib"

const MAGIC = new TextEncoder().encode("MAGPLAN3")
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024
const MAX_PLANNER_INPUT_BYTES = 128 * 1024 * 1024

interface PlannerEntry {
  compressedStart: number
  compressedEnd: number
  uncompressedLen: number
}

export class PlannerBundle {
  private readonly bytes: Uint8Array
  private readonly manifestStart: number
  private readonly manifestEnd: number
  private readonly entries: Map<string, PlannerEntry>

  private constructor(
    bytes: Uint8Array,
    manifestStart: number,
    manifestEnd: number,
    entries: Map<string, PlannerEntry>,
  ) {
    this.bytes = bytes
    this.manifestStart = manifestStart
    this.manifestEnd = manifestEnd
    this.entries = entries
  }

  static parse(bytes: Uint8Array): PlannerBundle {
    if (!bytesStartsWith(bytes, MAGIC)) {
      throw new Error("planner bundle has an invalid header")
    }
    let cursor = MAGIC.length
    const manifestLen = readU64(bytes, cursor)
    cursor += 8
    if (manifestLen === 0n || manifestLen > BigInt(MAX_MANIFEST_BYTES)) {
      throw new Error("planner bundle manifest length is outside the supported bound")
    }
    const manifestStart = cursor
    cursor += Number(manifestLen)
    const manifestEnd = cursor
    const count = readU32(bytes, cursor)
    cursor += 4
    const entries = new Map<string, PlannerEntry>()
    for (let index = 0; index < count; index += 1) {
      const digestBytes = readBytes(bytes, cursor, 64)
      cursor += 64
      const digest = new TextDecoder().decode(digestBytes)
      validateDigest(digest)
      const uncompressedLen = Number(readU64(bytes, cursor))
      cursor += 8
      if (uncompressedLen === 0 || uncompressedLen > MAX_PLANNER_INPUT_BYTES) {
        throw new Error("planner input length is outside the supported bound")
      }
      const compressedLen = Number(readU64(bytes, cursor))
      cursor += 8
      const compressedStart = cursor
      cursor += compressedLen
      if (entries.has(digest)) {
        throw new Error("planner bundle contains a duplicate input")
      }
      entries.set(digest, {
        compressedStart,
        compressedEnd: cursor,
        uncompressedLen,
      })
    }
    if (cursor !== bytes.length) {
      throw new Error("planner bundle contains trailing bytes")
    }
    return new PlannerBundle(bytes, manifestStart, manifestEnd, entries)
  }

  manifest(): Uint8Array {
    return this.bytes.slice(this.manifestStart, this.manifestEnd)
  }

  digests(): readonly string[] {
    return [...this.entries.keys()]
  }

  input(digest: string): Uint8Array {
    const entry = this.entries.get(digest)
    if (entry === undefined) {
      throw new Error(`planner bundle is missing input ${digest}`)
    }
    const compressed = this.bytes.slice(entry.compressedStart, entry.compressedEnd)
    const input = gunzipSync(compressed)
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
    if (bytes.length !== entry.uncompressedLen || plannerBundleSha256(bytes) !== digest) {
      throw new Error(`planner input ${digest} failed integrity validation`)
    }
    return new Uint8Array(bytes)
  }
}

export const plannerBundleSha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex")

export const encodePlannerBundle = (
  manifest: Uint8Array,
  inputs: ReadonlyMap<string, Uint8Array>,
  progress: (completed: number, total: number) => void = () => {},
): Uint8Array => {
  if (manifest.length === 0 || manifest.length > MAX_MANIFEST_BYTES) {
    throw new Error("planner bundle manifest length is outside the supported bound")
  }
  const parts: Uint8Array[] = [MAGIC]
  const manifestLen = new Uint8Array(8)
  new DataView(manifestLen.buffer).setBigUint64(0, BigInt(manifest.length), true)
  parts.push(manifestLen, manifest)
  const count = new Uint8Array(4)
  new DataView(count.buffer).setUint32(0, inputs.size, true)
  parts.push(count)
  let index = 0
  for (const [digest, input] of inputs) {
    validateDigest(digest)
    if (plannerBundleSha256(input) !== digest) {
      throw new Error(`planner input ${digest} failed integrity validation`)
    }
    const compressed = gzipSync(input, { level: 1 })
    parts.push(new TextEncoder().encode(digest))
    const uncompressedLen = new Uint8Array(8)
    new DataView(uncompressedLen.buffer).setBigUint64(0, BigInt(input.length), true)
    parts.push(uncompressedLen)
    const compressedLen = new Uint8Array(8)
    new DataView(compressedLen.buffer).setBigUint64(0, BigInt(compressed.length), true)
    parts.push(compressedLen, compressed)
    index += 1
    progress(index, inputs.size)
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const encoded = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    encoded.set(part, offset)
    offset += part.length
  }
  return encoded
}

const validateDigest = (digest: string): void => {
  if (digest.length !== 64 || ![...digest].every((char) => /[0-9a-f]/i.test(char))) {
    throw new Error(`invalid planner input digest ${digest}`)
  }
}

const bytesStartsWith = (bytes: Uint8Array, prefix: Uint8Array): boolean =>
  bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value)

const readBytes = (bytes: Uint8Array, offset: number, length: number): Uint8Array => {
  const end = offset + length
  if (end > bytes.length) {
    throw new Error("planner bundle ended unexpectedly")
  }
  return bytes.slice(offset, end)
}

const readU32 = (bytes: Uint8Array, offset: number): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4)
  return view.getUint32(0, true)
}

const readU64 = (bytes: Uint8Array, offset: number): bigint => {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8)
  return view.getBigUint64(0, true)
}
