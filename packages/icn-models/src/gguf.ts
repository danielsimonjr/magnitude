import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import {
  fileTypeFromU32,
  fileTypeName,
  friendlyQuantizationName,
  tensorStorageBytes,
} from "./gguf-tensor"

const MAGIC = new Uint8Array([0x47, 0x47, 0x55, 0x46])
const MAX_METADATA_ENTRIES = 1_000_000
const MAX_TENSORS = 10_000_000
const MAX_STRING_BYTES = 16 * 1024 * 1024
const MAX_STRING_ARRAY_BYTES = 64 * 1024 * 1024
const MAX_DIMS = 8

export type GgufExecutionRole = "Draft"

export interface GgufInspection {
  version: number
  architecture: string | null
  name: string | null
  quantization: string | null
  quantization_name: string | null
  parameter_count: number | null
  active_parameter_count: number | null
  training_context_length: number | null
  nextn_predict_layers: number | null
  tokenizer: string | null
  chat_template: string | null
  tool_use_template: string | null
  bos_token: string | null
  eos_token: string | null
  base_models: string[]
  modalities: string[]
  tensor_count: number
  tensor_storage_bytes: number
  header_bytes: number
  fingerprint_material: Uint8Array
  execution_role: GgufExecutionRole | null
}

export type GgufError =
  | { readonly _tag: "Io"; message: string }
  | { readonly _tag: "InvalidMagic" }
  | { readonly _tag: "UnsupportedVersion"; version: number }
  | { readonly _tag: "Invalid"; reason: string }
  | { readonly _tag: "Utf8" }

type MetadataValue =
  | { readonly _tag: "U32"; value: number }
  | { readonly _tag: "I32"; value: number }
  | { readonly _tag: "U64"; value: number }
  | { readonly _tag: "I64"; value: number }
  | { readonly _tag: "String"; value: string }
  | { readonly _tag: "StringArray"; value: string[] }
  | { readonly _tag: "Other" }

class CheckedReader {
  private readonly view: DataView
  private readonly bytes: Uint8Array
  position = 0

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get length(): number {
    return this.bytes.length
  }

  private ensureRemaining(amount: number): void {
    if (this.position + amount > this.length) {
      throw { _tag: "Invalid" as const, reason: "header extends beyond end of file" }
    }
  }

  readExact(size: number): Uint8Array {
    this.ensureRemaining(size)
    const slice = this.bytes.subarray(this.position, this.position + size)
    this.position += size
    return slice
  }

  u8(): number {
    this.ensureRemaining(1)
    const value = this.view.getUint8(this.position)
    this.position += 1
    return value
  }

  u16(): number {
    this.ensureRemaining(2)
    const value = this.view.getUint16(this.position, true)
    this.position += 2
    return value
  }

  i16(): number {
    this.ensureRemaining(2)
    const value = this.view.getInt16(this.position, true)
    this.position += 2
    return value
  }

  u32(): number {
    this.ensureRemaining(4)
    const value = this.view.getUint32(this.position, true)
    this.position += 4
    return value
  }

  i32(): number {
    this.ensureRemaining(4)
    const value = this.view.getInt32(this.position, true)
    this.position += 4
    return value
  }

  u64(): number {
    this.ensureRemaining(8)
    const value = Number(this.view.getBigUint64(this.position, true))
    this.position += 8
    return value
  }

  i64(): number {
    this.ensureRemaining(8)
    const value = Number(this.view.getBigInt64(this.position, true))
    this.position += 8
    return value
  }

  string(): string {
    const length = this.u64()
    if (length > MAX_STRING_BYTES) {
      throw { _tag: "Invalid" as const, reason: "metadata string exceeds inspection bound" }
    }
    const bytes = this.readExact(length)
    try {
      return new TextDecoder().decode(bytes)
    } catch {
      throw { _tag: "Utf8" as const }
    }
  }

  value(valueType: number): MetadataValue {
    switch (valueType) {
      case 0:
        return { _tag: "U32", value: this.u8() }
      case 1:
        return { _tag: "I32", value: this.u8() << 24 >> 24 }
      case 2:
        return { _tag: "U32", value: this.u16() }
      case 3:
        return { _tag: "I32", value: this.i16() }
      case 4:
        return { _tag: "U32", value: this.u32() }
      case 5:
        return { _tag: "I32", value: this.i32() }
      case 6:
        this.skip(4)
        return { _tag: "Other" }
      case 7:
        this.u8()
        return { _tag: "Other" }
      case 8:
        return { _tag: "String", value: this.string() }
      case 9: {
        const elementType = this.u32()
        const count = this.u64()
        if (count > MAX_METADATA_ENTRIES) {
          throw { _tag: "Invalid" as const, reason: "metadata array exceeds inspection bound" }
        }
        if (elementType === 8) {
          const values: string[] = []
          let total = 0
          for (let index = 0; index < count; index++) {
            const value = this.string()
            total += value.length
            if (total > MAX_STRING_ARRAY_BYTES) {
              throw { _tag: "Invalid" as const, reason: "metadata string array exceeds inspection bound" }
            }
            values.push(value)
          }
          return { _tag: "StringArray", value: values }
        }
        for (let index = 0; index < count; index++) {
          this.value(elementType)
        }
        return { _tag: "Other" }
      }
      case 10:
        return { _tag: "U64", value: this.u64() }
      case 11:
        return { _tag: "I64", value: this.i64() }
      case 12:
        this.skip(8)
        return { _tag: "Other" }
      default:
        throw { _tag: "Invalid" as const, reason: "unknown metadata value type" }
    }
  }

  skip(amount: number): void {
    this.ensureRemaining(amount)
    this.position += amount
  }
}

const stringValue = (values: Map<string, MetadataValue>, key: string): string | null => {
  const value = values.get(key)
  return value?._tag === "String" ? value.value : null
}

const stringArrayValue = (values: Map<string, MetadataValue>, key: string): string[] | null => {
  const value = values.get(key)
  return value?._tag === "StringArray" ? value.value : null
}

const u32Value = (values: Map<string, MetadataValue>, key: string): number | null => {
  const value = values.get(key)
  if (value === undefined) return null
  switch (value._tag) {
    case "U32":
      return value.value
    case "I32":
      return value.value >= 0 ? value.value : null
    case "U64":
      return value.value <= 0xffffffff ? value.value : null
    case "I64":
      return value.value >= 0 && value.value <= 0xffffffff ? value.value : null
    default:
      return null
  }
}

const u64Value = (values: Map<string, MetadataValue>, key: string): number | null => {
  const value = values.get(key)
  if (value === undefined) return null
  switch (value._tag) {
    case "U32":
      return value.value
    case "I32":
      return value.value >= 0 ? value.value : null
    case "U64":
      return value.value
    case "I64":
      return value.value >= 0 ? value.value : null
    default:
      return null
  }
}

export const inspect = (path: string): GgufInspection => {
  const fd = openSync(path, "r")
  try {
    const stats = fstatSync(fd)
    const fileLen = stats.size
    const bytes = new Uint8Array(fileLen)
    let offset = 0
    while (offset < fileLen) {
      const read = readSync(fd, bytes, offset, fileLen - offset, offset)
      if (read <= 0) break
      offset += read
    }
    const reader = new CheckedReader(bytes)

    const magic = reader.readExact(4)
    if (magic.length !== 4 || magic.some((byte, index) => byte !== MAGIC[index])) {
      throw { _tag: "InvalidMagic" as const }
    }
    const version = reader.u32()
    if (version < 2 || version > 3) {
      throw { _tag: "UnsupportedVersion" as const, version }
    }
    const tensorCount = reader.u64()
    const metadataCount = reader.u64()
    if (tensorCount > MAX_TENSORS) {
      throw { _tag: "Invalid" as const, reason: "tensor count exceeds inspection bound" }
    }
    if (metadataCount > MAX_METADATA_ENTRIES) {
      throw { _tag: "Invalid" as const, reason: "metadata count exceeds inspection bound" }
    }

    const metadata = new Map<string, MetadataValue>()
    for (let index = 0; index < metadataCount; index++) {
      const key = reader.string()
      const valueType = reader.u32()
      metadata.set(key, reader.value(valueType))
    }

    let derivedParameterCount = 0
    let tensorStorageTotal = 0
    for (let index = 0; index < tensorCount; index++) {
      reader.string()
      const dimensions = reader.u32()
      if (dimensions === 0 || dimensions > MAX_DIMS) {
        throw { _tag: "Invalid" as const, reason: "tensor dimension count is invalid" }
      }
      let elements = 1
      const shape: number[] = []
      for (let dim = 0; dim < dimensions; dim++) {
        const dimension = reader.u64()
        shape.push(dimension)
        elements *= dimension
        if (!Number.isFinite(elements)) {
          throw { _tag: "Invalid" as const, reason: "tensor element count overflow" }
        }
      }
      derivedParameterCount += elements
      const tensorType = reader.u32()
      const stored = tensorStorageBytes(tensorType, shape)
      if (stored === undefined) {
        throw { _tag: "Invalid" as const, reason: "tensor storage shape or type is invalid" }
      }
      tensorStorageTotal += stored
      if (!Number.isFinite(tensorStorageTotal)) {
        throw { _tag: "Invalid" as const, reason: "tensor storage bytes overflow" }
      }
      reader.u64()
    }

    const alignment = u32Value(metadata, "general.alignment") ?? 32
    if (alignment === 0 || (alignment & (alignment - 1)) !== 0) {
      throw { _tag: "Invalid" as const, reason: "GGUF alignment is invalid" }
    }
    const headerBytes = Math.ceil(reader.position / alignment) * alignment
    if (headerBytes > fileLen) {
      throw { _tag: "Invalid" as const, reason: "GGUF header extends beyond end of file" }
    }

    const architecture = stringValue(metadata, "general.architecture")
    const executionRole =
      architecture === "eagle3" || stringValue(metadata, "dflash.decoder_arch") !== null
        ? "Draft"
        : null
    const trainingContextLength =
      (architecture !== null
        ? u32Value(metadata, `${architecture}.context_length`)
        : null) ?? u32Value(metadata, "llama.context_length")
    const nextnPredictLayers =
      architecture !== null
        ? u32Value(metadata, `${architecture}.nextn_predict_layers`)
        : null
    const activeParameterCount = u64Value(metadata, "general.active_parameter_count")
    const baseModelCount = u32Value(metadata, "general.base_model.count") ?? 0
    const baseModels: string[] = []
    for (let index = 0; index < baseModelCount; index++) {
      const name = stringValue(metadata, `general.base_model.${index}.name`)
      if (name !== null) baseModels.push(name)
    }
    const modalities = [...metadata.keys()].some(
      (key) => key.includes("vision") || key.includes("clip") || key.includes("projector"),
    )
      ? ["text", "image"]
      : ["text"]

    const fileTypeRaw = u32Value(metadata, "general.file_type")
    const fileType = fileTypeRaw !== null ? fileTypeFromU32(fileTypeRaw) : undefined
    const quantization =
      fileType !== undefined && fileType !== "Unknown" ? fileTypeName(fileType) ?? null : null
    const quantizationName =
      fileType !== undefined && fileType !== "Unknown" ? friendlyQuantizationName(fileType) : null
    const metadataParameterCount = u64Value(metadata, "general.parameter_count")
    const parameterCount =
      metadataParameterCount ?? (derivedParameterCount > 0 ? derivedParameterCount : null)

    const tokens = stringArrayValue(metadata, "tokenizer.ggml.tokens")
    const tokenAt = (key: string): string | null => {
      const index = u32Value(metadata, key)
      if (index === null || tokens === null) return null
      return tokens[index] ?? null
    }

    const fingerprintMaterial = new Uint8Array(
      4 +
        8 +
        8 +
        (architecture?.length ?? 0) +
        (stringValue(metadata, "tokenizer.chat_template")?.length ?? 0) +
        (nextnPredictLayers !== null ? "nextn_predict_layers".length + 4 : 0),
    )
    const fpView = new DataView(fingerprintMaterial.buffer)
    let fpOffset = 0
    fpView.setUint32(fpOffset, version, true)
    fpOffset += 4
    fpView.setBigUint64(fpOffset, BigInt(tensorCount), true)
    fpOffset += 8
    fpView.setBigUint64(fpOffset, BigInt(metadataCount), true)
    fpOffset += 8
    if (architecture !== null) {
      fingerprintMaterial.set(new TextEncoder().encode(architecture), fpOffset)
      fpOffset += architecture.length
    }
    const chatTemplate = stringValue(metadata, "tokenizer.chat_template")
    if (chatTemplate !== null) {
      fingerprintMaterial.set(new TextEncoder().encode(chatTemplate), fpOffset)
      fpOffset += chatTemplate.length
    }
    if (nextnPredictLayers !== null) {
      fingerprintMaterial.set(new TextEncoder().encode("nextn_predict_layers"), fpOffset)
      fpOffset += "nextn_predict_layers".length
      fpView.setUint32(fpOffset, nextnPredictLayers, true)
    }

    return {
      version,
      architecture,
      name: stringValue(metadata, "general.name"),
      quantization,
      quantization_name: quantizationName,
      parameter_count: parameterCount,
      active_parameter_count: activeParameterCount,
      training_context_length: trainingContextLength,
      nextn_predict_layers: nextnPredictLayers,
      tokenizer: stringValue(metadata, "tokenizer.ggml.model"),
      chat_template: stringValue(metadata, "tokenizer.chat_template"),
      tool_use_template: stringValue(metadata, "tokenizer.chat_template.tool_use"),
      bos_token: tokenAt("tokenizer.ggml.bos_token_id"),
      eos_token: tokenAt("tokenizer.ggml.eos_token_id"),
      base_models: baseModels,
      modalities,
      tensor_count: tensorCount,
      tensor_storage_bytes: tensorStorageTotal,
      header_bytes: headerBytes,
      fingerprint_material: fingerprintMaterial,
      execution_role: executionRole,
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "_tag" in error) {
      throw error
    }
    throw { _tag: "Io" as const, message: String(error) }
  } finally {
    closeSync(fd)
  }
}
