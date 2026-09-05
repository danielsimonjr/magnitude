const MAGIC = new TextEncoder().encode("GGUF")
const MIN_VERSION = 2
const MAX_VERSION = 3
const DEFAULT_ALIGNMENT = 32
const MAX_METADATA_ENTRIES = 1_000_000
const MAX_TENSORS = 10_000_000
const MAX_ARRAY_ELEMENTS = 10_000_000
const MAX_DIMS = 8
const MAX_STRING_BYTES = 128 * 1024 * 1024

const TOKENIZER_MODEL = "tokenizer.ggml.model"
const TOKENIZER_TOKENS = "tokenizer.ggml.tokens"
const TOKENIZER_BOS_TOKEN_ID = "tokenizer.ggml.bos_token_id"
const TOKENIZER_EOS_TOKEN_ID = "tokenizer.ggml.eos_token_id"

const REMOVED_METADATA = [
  TOKENIZER_MODEL,
  TOKENIZER_TOKENS,
  "tokenizer.ggml.merges",
  "tokenizer.ggml.scores",
  "tokenizer.ggml.token_type",
  "tokenizer.ggml.precompiled_charsmap",
  "tokenizer.huggingface.json",
  "tokenizer.rwkv.world",
] as const

export interface AssessmentMaterialContext {
  architecture: string
  vocabulary_size: number
  special_tokens: ReadonlyMap<number, string>
}

export type AssessmentMaterialComponent = "Primary" | "Shard" | "Companion"

export type AssessmentMaterialError =
  | { readonly _tag: "InvalidMagic" }
  | { readonly _tag: "UnsupportedVersion"; version: number }
  | { readonly _tag: "Invalid"; reason: string }
  | { readonly _tag: "Utf8" }

export const assessmentMaterialErrorMessage = (error: AssessmentMaterialError): string => {
  switch (error._tag) {
    case "InvalidMagic":
      return "assessment source is not GGUF"
    case "UnsupportedVersion":
      return `assessment source uses unsupported GGUF version ${error.version}`
    case "Invalid":
      return `assessment source is structurally invalid: ${error.reason}`
    case "Utf8":
      return "assessment source contains non-UTF-8 metadata"
  }
}

interface MetadataEntry {
  key: string
  start: number
  end: number
}

interface ParsedHeader {
  version: number
  tensorCount: number
  entries: MetadataEntry[]
  tensorDirectoryStart: number
  tensorDirectoryEnd: number
  architecture: string | null
  tokenCount: number | null
  declaredVocabularySize: number | null
  alignment: number
}

class Reader {
  private position = 0

  constructor(private readonly bytes: Uint8Array) {}

  get offset(): number {
    return this.position
  }

  readBytes(count: number): Uint8Array {
    const end = this.position + count
    if (end > this.bytes.length) {
      throw invalid("source ended unexpectedly")
    }
    const value = this.bytes.slice(this.position, end)
    this.position = end
    return value
  }

  skip(count: number): void {
    this.readBytes(count)
  }

  u8(): number {
    return this.readBytes(1)[0]!
  }

  u16(): number {
    const bytes = this.readBytes(2)
    return new DataView(bytes.buffer, bytes.byteOffset, 2).getUint16(0, true)
  }

  u32(): number {
    const bytes = this.readBytes(4)
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true)
  }

  u64(): bigint {
    const bytes = this.readBytes(8)
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true)
  }

  string(): string {
    const length = Number(this.u64())
    if (length > MAX_STRING_BYTES) {
      throw invalid("string exceeds bound")
    }
    const bytes = this.readBytes(length)
    try {
      return new TextDecoder().decode(bytes)
    } catch {
      throw utf8()
    }
  }

  value(valueType: number): ValueSummary {
    switch (valueType) {
      case 0:
      case 1:
      case 7:
        this.u8()
        return { kind: "Other" }
      case 2:
      case 3:
        this.u16()
        return { kind: "Other" }
      case 4:
        return { kind: "U32", value: this.u32() }
      case 5:
      case 6:
        this.u32()
        return { kind: "Other" }
      case 8:
        return { kind: "String", value: this.string() }
      case 9: {
        const elementType = this.u32()
        const count = Number(this.u64())
        if (count > MAX_ARRAY_ELEMENTS) {
          throw invalid("array exceeds bound")
        }
        if (elementType === 9) {
          throw invalid("nested arrays are unsupported")
        }
        for (let index = 0; index < count; index += 1) {
          this.value(elementType)
        }
        return { kind: "Array", elementType, count }
      }
      case 10:
      case 11:
      case 12:
        this.u64()
        return { kind: "Other" }
      default:
        throw invalid("unknown GGUF metadata value type")
    }
  }
}

type ValueSummary =
  | { kind: "U32"; value: number }
  | { kind: "String"; value: string }
  | { kind: "Array"; elementType: number; count: number }
  | { kind: "Other" }

const invalid = (reason: string): AssessmentMaterialError => ({ _tag: "Invalid", reason })
const utf8 = (): AssessmentMaterialError => ({ _tag: "Utf8" })

export const assessmentMaterialContext = (
  source: Uint8Array,
): AssessmentMaterialContext | AssessmentMaterialError => {
  const parsed = parseHeader(source)
  if ("_tag" in parsed) {
    return parsed
  }
  if (parsed.architecture === null) {
    return invalid("primary GGUF has no architecture")
  }
  let vocabularySize: number
  if (parsed.tokenCount !== null && parsed.declaredVocabularySize !== null) {
    if (parsed.tokenCount !== parsed.declaredVocabularySize) {
      return invalid("token count differs from declared vocabulary size")
    }
    vocabularySize = parsed.tokenCount
  } else if (parsed.tokenCount !== null) {
    vocabularySize = parsed.tokenCount
  } else if (parsed.declaredVocabularySize !== null) {
    vocabularySize = parsed.declaredVocabularySize
  } else {
    return invalid("primary GGUF has no vocabulary cardinality")
  }
  const specialTokens = specialTokenStrings(source, parsed, vocabularySize)
  if ("_tag" in specialTokens) {
    return specialTokens
  }
  return {
    architecture: parsed.architecture,
    vocabulary_size: vocabularySize,
    special_tokens: specialTokens,
  }
}

export const compactAssessmentMaterial = (
  source: Uint8Array,
  context: AssessmentMaterialContext,
  component: AssessmentMaterialComponent,
): Uint8Array | AssessmentMaterialError => {
  const parsed = parseHeader(source)
  if ("_tag" in parsed) {
    return parsed
  }
  if (component !== "Companion") {
    if (parsed.architecture !== null && parsed.architecture !== context.architecture) {
      return invalid("split GGUF architecture differs from its primary")
    }
    if (parsed.tokenCount !== null && parsed.tokenCount !== context.vocabulary_size) {
      return invalid("split GGUF token count differs from its primary")
    }
    if (
      parsed.declaredVocabularySize !== null &&
      parsed.declaredVocabularySize !== context.vocabulary_size
    ) {
      return invalid("split GGUF vocabulary size differs from its primary")
    }
  }
  if (component === "Primary" && parsed.architecture === null) {
    return invalid("primary GGUF has no architecture")
  }
  const vocabularyKey = `${context.architecture}.vocab_size`
  const kept = parsed.entries.filter(
    (entry) =>
      component !== "Primary" || (!removedMetadata(entry.key) && entry.key !== vocabularyKey),
  )
  const usesSyntheticVocabulary = component === "Primary"
  const added = usesSyntheticVocabulary ? 3 : 0
  const metadataCount = kept.length + added
  const output: number[] = [...MAGIC]
  pushU32(output, parsed.version)
  pushU64(output, parsed.tensorCount)
  pushU64(output, metadataCount)
  for (const entry of kept) {
    output.push(...source.slice(entry.start, entry.end))
  }
  if (component === "Primary") {
    encodeStringEntry(output, TOKENIZER_MODEL, "llama")
    if (usesSyntheticVocabulary) {
      encodeSparseStringArrayEntry(
        output,
        TOKENIZER_TOKENS,
        context.vocabulary_size,
        context.special_tokens,
      )
    }
    encodeU32Entry(output, vocabularyKey, context.vocabulary_size)
  }
  output.push(...source.slice(parsed.tensorDirectoryStart, parsed.tensorDirectoryEnd))
  const aligned = nextMultipleOf(output.length, parsed.alignment)
  while (output.length < aligned) {
    output.push(0)
  }
  return Uint8Array.from(output)
}

const removedMetadata = (key: string): boolean =>
  (REMOVED_METADATA as readonly string[]).includes(key)

const parseHeader = (source: Uint8Array): ParsedHeader | AssessmentMaterialError => {
  const reader = new Reader(source)
  if (!bytesEqual(reader.readBytes(4), MAGIC)) {
    return { _tag: "InvalidMagic" }
  }
  const version = reader.u32()
  if (version < MIN_VERSION || version > MAX_VERSION) {
    return { _tag: "UnsupportedVersion", version }
  }
  const tensorCount = Number(reader.u64())
  const metadataCount = Number(reader.u64())
  if (tensorCount > MAX_TENSORS) {
    return invalid("tensor count exceeds bound")
  }
  if (metadataCount > MAX_METADATA_ENTRIES) {
    return invalid("metadata count exceeds bound")
  }
  const entries: MetadataEntry[] = []
  const keys = new Set<string>()
  let architecture: string | null = null
  let tokenCount: number | null = null
  let alignment = DEFAULT_ALIGNMENT
  for (let index = 0; index < metadataCount; index += 1) {
    const start = reader.offset
    const key = reader.string()
    if (keys.has(key)) {
      return invalid("duplicate metadata key")
    }
    keys.add(key)
    const valueType = reader.u32()
    const summary = reader.value(valueType)
    const end = reader.offset
    switch (key) {
      case "general.architecture":
        if (summary.kind !== "String" || summary.value.length === 0) {
          return invalid("architecture metadata is not a non-empty string")
        }
        architecture = summary.value
        break
      case "general.alignment":
        if (summary.kind !== "U32") {
          return invalid("alignment metadata is not uint32")
        }
        alignment = summary.value
        break
      case TOKENIZER_TOKENS:
        if (summary.kind !== "Array" || summary.elementType !== 8) {
          return invalid("tokenizer tokens are not a string array")
        }
        if (summary.count > Number.MAX_SAFE_INTEGER) {
          return invalid("vocabulary size exceeds uint32")
        }
        tokenCount = summary.count
        break
    }
    entries.push({ key, start, end })
  }
  if (alignment === 0 || (alignment & (alignment - 1)) !== 0) {
    return invalid("alignment is not a power of two")
  }
  let declaredVocabularySize: number | null = null
  if (architecture !== null) {
    const vocabKey = `${architecture}.vocab_size`
    const entry = entries.find((candidate) => candidate.key === vocabKey)
    if (entry !== undefined) {
      const valueReader = new Reader(source.slice(entry.start, entry.end))
      valueReader.string()
      if (valueReader.u32() !== 4) {
        return invalid("vocabulary size metadata is not uint32")
      }
      declaredVocabularySize = valueReader.u32()
    }
  }
  const tensorDirectoryStart = reader.offset
  for (let index = 0; index < tensorCount; index += 1) {
    reader.string()
    const dimensions = reader.u32()
    if (dimensions === 0 || dimensions > MAX_DIMS) {
      return invalid("tensor dimension count is invalid")
    }
    reader.skip(dimensions * 8)
    reader.u32()
    reader.u64()
  }
  const tensorDirectoryEnd = reader.offset
  const aligned = nextMultipleOf(reader.offset, alignment)
  if (aligned !== source.length) {
    return invalid("source is not an exact aligned GGUF header")
  }
  return {
    version,
    tensorCount,
    entries,
    tensorDirectoryStart,
    tensorDirectoryEnd,
    architecture,
    tokenCount,
    declaredVocabularySize,
    alignment,
  }
}

const specialTokenStrings = (
  source: Uint8Array,
  parsed: ParsedHeader,
  vocabularySize: number,
): ReadonlyMap<number, string> | AssessmentMaterialError => {
  const tokenIds = [TOKENIZER_BOS_TOKEN_ID, TOKENIZER_EOS_TOKEN_ID]
    .map((key) => metadataU32(source, parsed, key))
    .filter((value): value is number => value !== undefined)
  if (tokenIds.length === 0) {
    return new Map()
  }
  if (tokenIds.some((index) => index >= vocabularySize)) {
    return invalid("special token id exceeds vocabulary size")
  }
  const entry = parsed.entries.find((candidate) => candidate.key === TOKENIZER_TOKENS)
  if (entry === undefined) {
    return invalid("special token ids require tokenizer tokens")
  }
  const reader = new Reader(source.slice(entry.start, entry.end))
  reader.string()
  if (reader.u32() !== 9 || reader.u32() !== 8) {
    return invalid("tokenizer tokens are not a string array")
  }
  const count = Number(reader.u64())
  const values = new Map<number, string>()
  const wanted = new Set(tokenIds)
  for (let index = 0; index < count; index += 1) {
    const value = reader.string()
    if (wanted.has(index)) {
      values.set(index, value)
    }
  }
  return values
}

const metadataU32 = (source: Uint8Array, parsed: ParsedHeader, key: string): number | undefined => {
  const entry = parsed.entries.find((candidate) => candidate.key === key)
  if (entry === undefined) {
    return undefined
  }
  const reader = new Reader(source.slice(entry.start, entry.end))
  reader.string()
  if (reader.u32() !== 4) {
    throw invalid("special token id metadata is not uint32")
  }
  return reader.u32()
}

const encodeString = (output: number[], value: string): void => {
  const bytes = new TextEncoder().encode(value)
  pushU64(output, bytes.length)
  output.push(...bytes)
}

const encodeStringEntry = (output: number[], key: string, value: string): void => {
  encodeString(output, key)
  pushU32(output, 8)
  encodeString(output, value)
}

const encodeU32Entry = (output: number[], key: string, value: number): void => {
  encodeString(output, key)
  pushU32(output, 4)
  pushU32(output, value)
}

const encodeSparseStringArrayEntry = (
  output: number[],
  key: string,
  count: number,
  values: ReadonlyMap<number, string>,
): void => {
  encodeString(output, key)
  pushU32(output, 9)
  pushU32(output, 8)
  pushU64(output, count)
  for (let index = 0; index < count; index += 1) {
    encodeString(output, values.get(index) ?? "")
  }
}

const pushU32 = (output: number[], value: number): void => {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, true)
  output.push(...bytes)
}

const pushU64 = (output: number[], value: number): void => {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true)
  output.push(...bytes)
}

const nextMultipleOf = (value: number, multiple: number): number => {
  const remainder = value % multiple
  return remainder === 0 ? value : value + (multiple - remainder)
}

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index])

/** Test-only helpers mirroring the Rust planner_stub test module. */
export const plannerStubTestSupport = {
  encodeStringEntry,
  encodeU32Entry,
  encodeString,
  parseHeader,
  specialTokenStrings,
  header(
    metadata: number[],
    metadataCount: number,
    tensors: number[],
    tensorCount: number,
  ): Uint8Array {
    const output: number[] = [...MAGIC]
    pushU32(output, 3)
    pushU64(output, tensorCount)
    pushU64(output, metadataCount)
    output.push(...metadata, ...tensors)
    const aligned = nextMultipleOf(output.length, 32)
    while (output.length < aligned) {
      output.push(0)
    }
    return Uint8Array.from(output)
  },
  shardHeader(): Uint8Array {
    const metadata: number[] = []
    encodeU32Entry(metadata, "split.no", 1)
    encodeU32Entry(metadata, "split.count", 2)
    const tensors: number[] = []
    encodeString(tensors, "blk.0.weight")
    pushU32(tensors, 2)
    pushU64(tensors, 2)
    pushU64(tensors, 2)
    pushU32(tensors, 0)
    pushU64(tensors, 64)
    return plannerStubTestSupport.header(metadata, 2, tensors, 1)
  },
  inconsistentVocabularyHeader(): Uint8Array {
    const source = plannerStubTestSupport.primaryHeader()
    const parsed = parseHeader(source)
    if ("_tag" in parsed) {
      throw new Error("expected parsed primary header")
    }
    const entry: number[] = []
    encodeU32Entry(entry, "llama.vocab_size", 4)
    const mutated = new Uint8Array(source.length + entry.length)
    mutated.set(source.slice(0, parsed.tensorDirectoryStart))
    mutated.set(Uint8Array.from(entry), parsed.tensorDirectoryStart)
    mutated.set(source.slice(parsed.tensorDirectoryStart), parsed.tensorDirectoryStart + entry.length)
    new DataView(mutated.buffer).setBigUint64(16, 17n, true)
    const alignedLength = nextMultipleOf(mutated.length, 32)
    const aligned = new Uint8Array(alignedLength)
    aligned.set(mutated)
    return aligned
  },
  primaryHeader(): Uint8Array {
    const metadata: number[] = []
    encodeStringEntry(metadata, "general.architecture", "llama")
    encodeU32Entry(metadata, "general.alignment", 32)
    encodeU32Entry(metadata, "llama.context_length", 4096)
    encodeStringEntry(metadata, TOKENIZER_MODEL, "gpt2")
    encodeString(metadata, TOKENIZER_TOKENS)
    pushU32(metadata, 9)
    pushU32(metadata, 8)
    pushU64(metadata, 3)
    for (const token of ["one", "two", "three"]) {
      encodeString(metadata, token)
    }
    encodeU32Entry(metadata, TOKENIZER_BOS_TOKEN_ID, 0)
    encodeU32Entry(metadata, TOKENIZER_EOS_TOKEN_ID, 2)
    encodeStringEntry(metadata, "tokenizer.ggml.add_bos_token", "true")
    encodeStringEntry(metadata, "tokenizer.ggml.add_eos_token", "false")
    encodeStringEntry(metadata, "tokenizer.ggml.merges", "o n")
    encodeStringEntry(metadata, "tokenizer.ggml.scores", "1")
    encodeStringEntry(metadata, "tokenizer.ggml.token_type", "1")
    encodeStringEntry(metadata, "tokenizer.ggml.suppress_tokens", "1")
    encodeStringEntry(metadata, "tokenizer.chat_template", "large template")
    encodeStringEntry(metadata, "tokenizer.chat_template.tool_use", "tool template")
    encodeStringEntry(metadata, "vendor.future_metadata", "preserved")
    const tensors: number[] = []
    encodeString(tensors, "token_embd.weight")
    pushU32(tensors, 2)
    pushU64(tensors, 4)
    pushU64(tensors, 3)
    pushU32(tensors, 0)
    pushU64(tensors, 0)
    return plannerStubTestSupport.header(metadata, 16, tensors, 1)
  },
}
