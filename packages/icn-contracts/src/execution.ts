import { Option, ParseResult, Schema } from "effect"
import { optional, Path, PositiveInt, U32 } from "./schema/common.js"

export const GpuLayersAuto = Schema.Literal("auto")
export const GpuLayersAll = Schema.Literal("all")
export const GpuLayersCount = Schema.Struct({ count: U32 })
export const GpuLayers = Schema.Union(GpuLayersAuto, GpuLayersAll, GpuLayersCount)
export type GpuLayers = typeof GpuLayers.Type

export const parseGpuLayers = (value: string): GpuLayers | { readonly error: string } => {
  if (value.toLowerCase() === "auto") return "auto"
  if (value.toLowerCase() === "all") return "all"
  const parsed = Number.parseInt(value, 10)
  if (!Number.isNaN(parsed) && parsed >= 0 && String(parsed) === value) {
    return { count: parsed }
  }
  return { error: "GPU layers must be 'auto', 'all', or a non-negative integer" }
}

export const SplitMode = Schema.Literal("none", "layer", "row", "tensor")
export type SplitMode = typeof SplitMode.Type

export const parseSplitMode = (value: string): SplitMode | { readonly error: string } => {
  switch (value) {
    case "none":
    case "layer":
    case "row":
    case "tensor":
      return value
    default:
      return { error: "split mode must be one of: none, layer, row, tensor" }
  }
}

export const CacheType = Schema.Literal(
  "f32",
  "f16",
  "bf16",
  "q8_0",
  "q4_0",
  "q4_1",
  "iq4_nl",
  "q5_0",
  "q5_1"
)
export type CacheType = typeof CacheType.Type

export const parseCacheType = (value: string): CacheType | { readonly error: string } => {
  switch (value) {
    case "f32":
    case "f16":
    case "bf16":
    case "q8_0":
    case "q4_0":
    case "q4_1":
    case "iq4_nl":
    case "q5_0":
    case "q5_1":
      return value
    default:
      return {
        error: `unsupported cache type ${JSON.stringify(value)}; expected f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, or q5_1`,
      }
  }
}

export const FlashAttention = Schema.Literal("auto", "disabled", "enabled")
export type FlashAttention = typeof FlashAttention.Type

export const ExecutionConfig = Schema.Struct({
  gpu_layers: GpuLayers,
  use_mmap: Schema.Boolean,
  use_mlock: Schema.Boolean,
  split_mode: SplitMode,
  tensor_split: optional(Schema.Array(Schema.Number)),
  cache_type_k: CacheType,
  cache_type_v: CacheType,
  offload_kqv: Schema.Boolean,
  operation_offload: Schema.Boolean,
  swa_full: Schema.Boolean,
  kv_unified: Schema.Boolean,
  threads: optional(PositiveInt),
  threads_batch: optional(PositiveInt),
  flash_attention: FlashAttention,
})
export type ExecutionConfig = typeof ExecutionConfig.Type

export const defaultExecutionConfig = (): ExecutionConfig => ({
  gpu_layers: "auto",
  use_mmap: true,
  use_mlock: false,
  split_mode: "layer",
  tensor_split: Option.none(),
  cache_type_k: "f16",
  cache_type_v: "f16",
  offload_kqv: true,
  operation_offload: true,
  swa_full: false,
  kv_unified: true,
  threads: Option.none(),
  threads_batch: Option.none(),
  flash_attention: "auto",
})

export const ExecutionConfigReport = Schema.Struct({
  requested: ExecutionConfig,
  resolved: ExecutionConfig,
})
export type ExecutionConfigReport = typeof ExecutionConfigReport.Type

export const SpeculativeMethodConfigMtp = Schema.Struct({
  method: Schema.Literal("mtp"),
  min_draft_probability: Schema.Number,
})

export const SpeculativeMethodConfigDFlash = Schema.Struct({
  method: Schema.Literal("dflash"),
  min_sample_probability: Schema.Number,
})

export const SpeculativeMethodConfigDSpark = Schema.Struct({
  method: Schema.Literal("dspark"),
  acceptance_threshold: Schema.Number,
})

export const SpeculativeMethodConfig = Schema.Union(
  SpeculativeMethodConfigMtp,
  SpeculativeMethodConfigDFlash,
  SpeculativeMethodConfigDSpark
)
export type SpeculativeMethodConfig = typeof SpeculativeMethodConfig.Type

export const speculativeMethodThreshold = (method: SpeculativeMethodConfig): number => {
  switch (method.method) {
    case "mtp":
      return method.min_draft_probability
    case "dflash":
      return method.min_sample_probability
    case "dspark":
      return method.acceptance_threshold
  }
}

export const ExecutionSpeculativeDraftEmbedded = Schema.Struct({
  type: Schema.Literal("embedded"),
})

export const ExecutionSpeculativeDraftSeparate = Schema.Struct({
  type: Schema.Literal("separate"),
  model_path: Path,
})

export const ExecutionSpeculativeDraftSource = Schema.Union(
  ExecutionSpeculativeDraftEmbedded,
  ExecutionSpeculativeDraftSeparate
)
export type ExecutionSpeculativeDraftSource = typeof ExecutionSpeculativeDraftSource.Type

export const SpeculativeDecodingDisabled = Schema.Struct({
  type: Schema.Literal("disabled"),
  reason: Schema.String,
})

export const SpeculativeDecodingEnabled = Schema.Struct({
  type: Schema.Literal("enabled"),
  source: ExecutionSpeculativeDraftSource,
  method: SpeculativeMethodConfig,
  n_max: U32,
  n_min: U32,
  cache_type_k: CacheType,
  cache_type_v: CacheType,
})

export const SpeculativeDecodingConfig = Schema.Union(
  SpeculativeDecodingDisabled,
  SpeculativeDecodingEnabled
)
export type SpeculativeDecodingConfig = typeof SpeculativeDecodingConfig.Type

export const defaultSpeculativeDecodingConfig = (): SpeculativeDecodingConfig => ({
  type: "disabled",
  reason: "not_supported",
})

export const SpeculativeDecodingSelection = Schema.Union(
  SpeculativeDecodingDisabled,
  Schema.Struct({
    type: Schema.Literal("enabled"),
    method: SpeculativeMethodConfig,
    n_max: U32,
    n_min: U32,
    cache_type_k: CacheType,
    cache_type_v: CacheType,
  })
)
export type SpeculativeDecodingSelection = typeof SpeculativeDecodingSelection.Type

export const speculativeDecodingSelectionFromConfig = (
  config: SpeculativeDecodingConfig
): SpeculativeDecodingSelection => {
  if (config.type === "disabled") {
    return config
  }
  return {
    type: "enabled",
    method: config.method,
    n_max: config.n_max,
    n_min: config.n_min,
    cache_type_k: config.cache_type_k,
    cache_type_v: config.cache_type_v,
  }
}

export const SpeculativeDecodingRuntimeDisabled = Schema.Struct({
  reason: Schema.String,
})

export const SpeculativeDecodingRuntimeEnabled = Schema.Struct({
  source: ExecutionSpeculativeDraftSource,
  method: SpeculativeMethodConfig,
  n_max: U32,
  n_min: U32,
})

export const SpeculativeDecodingRuntimeProperties = Schema.Union(
  SpeculativeDecodingRuntimeDisabled,
  SpeculativeDecodingRuntimeEnabled
)
export type SpeculativeDecodingRuntimeProperties = typeof SpeculativeDecodingRuntimeProperties.Type

export const ImageInputLimits = Schema.Struct({
  max_images: PositiveInt,
  max_input_bytes_per_image: PositiveInt,
  max_decoded_bytes_per_image: PositiveInt,
  max_total_decoded_bytes: PositiveInt,
})
export type ImageInputLimits = typeof ImageInputLimits.Type

export const defaultImageInputLimits = (): ImageInputLimits => ({
  max_images: 4,
  max_input_bytes_per_image: 8 * 1024 * 1024,
  max_decoded_bytes_per_image: 64 * 1024 * 1024,
  max_total_decoded_bytes: 128 * 1024 * 1024,
})

export const ProjectorConfig = Schema.Struct({
  path: Path,
  use_gpu: Schema.Boolean,
  warmup: Schema.Boolean,
  image_min_tokens: optional(PositiveInt),
  image_max_tokens: optional(PositiveInt),
  input_limits: ImageInputLimits,
})
export type ProjectorConfig = typeof ProjectorConfig.Type

export const newProjectorConfig = (path: string): ProjectorConfig => ({
  path,
  use_gpu: true,
  warmup: true,
  image_min_tokens: Option.none(),
  image_max_tokens: Option.none(),
  input_limits: defaultImageInputLimits(),
})

export class ImageInput {
  constructor(
    readonly mediaType: string,
    readonly bytes: Uint8Array
  ) {}

  static new(mediaType: string, bytes: Uint8Array | readonly number[]): ImageInput {
    const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)
    return new ImageInput(mediaType, data)
  }

  media_type(): string {
    return this.mediaType
  }

  byteLength(): number {
    return this.bytes.length
  }

  equals(other: ImageInput): boolean {
    return (
      this.mediaType === other.mediaType &&
      this.bytes.length === other.bytes.length &&
      this.bytes.every((byte, index) => byte === other.bytes[index])
    )
  }
}

const ImageInputWire = Schema.Struct({
  media_type: Schema.String,
  data_base64: Schema.String,
})

export const ImageInputSchema = Schema.transformOrFail(ImageInputWire, Schema.typeSchema(Schema.Any), {
  strict: true,
  decode: (wire, _, ast) => {
    try {
      const bytes = Buffer.from(wire.data_base64, "base64")
      return ParseResult.succeed(ImageInput.new(wire.media_type, bytes))
    } catch {
      return ParseResult.fail(new ParseResult.Type(ast, wire, "invalid base64 image payload"))
    }
  },
  encode: (input) =>
    ParseResult.succeed({
      media_type: input.mediaType,
      data_base64: Buffer.from(input.bytes).toString("base64"),
    }),
})

export const ExecutionIntent = Schema.Struct({
  model_path: Path,
  context_size: U32,
  physical_context_size: U32,
  batch_size: U32,
  ubatch_size: U32,
  max_sequences: U32,
  prefill_quantum: U32,
  execution: ExecutionConfig,
  projector: optional(ProjectorConfig),
  speculative: SpeculativeDecodingConfig,
})
export type ExecutionIntent = typeof ExecutionIntent.Type

export const GenerationMetrics = Schema.Struct({
  queue_ms: Schema.Number,
  prompt_ms: Schema.Number,
  decode_ms: Schema.Number,
  time_to_first_token_ms: Schema.Number,
  prompt_tokens_per_second: Schema.Number,
  decode_tokens_per_second: Schema.Number,
  sampler_ms: Schema.Number,
  parser_ms: Schema.Number,
  draft_tokens: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  accepted_draft_tokens: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  draft_ms: Schema.Number,
  verification_ms: Schema.Number,
})
export type GenerationMetrics = typeof GenerationMetrics.Type

export const defaultGenerationMetrics = (): GenerationMetrics => ({
  queue_ms: 0,
  prompt_ms: 0,
  decode_ms: 0,
  time_to_first_token_ms: 0,
  prompt_tokens_per_second: 0,
  decode_tokens_per_second: 0,
  sampler_ms: 0,
  parser_ms: 0,
  draft_tokens: 0,
  accepted_draft_tokens: 0,
  draft_ms: 0,
  verification_ms: 0,
})

export const GenerationSnapshot = Schema.Struct({
  cached_prompt_tokens: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  prompt_tokens: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  generated_tokens: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  metrics: GenerationMetrics,
})
export type GenerationSnapshot = typeof GenerationSnapshot.Type

export const defaultGenerationSnapshot = (): GenerationSnapshot => ({
  cached_prompt_tokens: 0,
  prompt_tokens: 0,
  generated_tokens: 0,
  metrics: defaultGenerationMetrics(),
})

export const GrammarTrigger = Schema.Union(
  Schema.Struct({
    Token: Schema.Struct({ value: Schema.String, token: Schema.Number.pipe(Schema.int()) }),
  }),
  Schema.Struct({ Word: Schema.String }),
  Schema.Struct({ Pattern: Schema.String }),
  Schema.Struct({ PatternFull: Schema.String })
)
export type GrammarTrigger = typeof GrammarTrigger.Type

export const TemplateCapabilities = Schema.Struct({
  string_content: Schema.Boolean,
  typed_content: Schema.Boolean,
  tools: Schema.Boolean,
  tool_calls: Schema.Boolean,
  parallel_tool_calls: Schema.Boolean,
  system_role: Schema.Boolean,
  preserve_reasoning: Schema.Boolean,
  object_arguments: Schema.Boolean,
  enable_thinking: Schema.Boolean,
})
export type TemplateCapabilities = typeof TemplateCapabilities.Type

export const PreparedChatInfo = Schema.Struct({
  prompt: Schema.String,
  generation_prompt: Schema.String,
  grammar: Schema.String,
  grammar_lazy: Schema.Boolean,
  grammar_triggers: Schema.Array(GrammarTrigger),
  preserved_tokens: Schema.Array(Schema.String),
  additional_stops: Schema.Array(Schema.String),
  supports_thinking: Schema.Boolean,
  thinking_start_tag: optional(Schema.String),
  thinking_end_tag: optional(Schema.String),
  template_fingerprint: Schema.String,
})
export type PreparedChatInfo = typeof PreparedChatInfo.Type

export const ModelModalities = Schema.Struct({
  vision: Schema.Boolean,
  audio: Schema.Boolean,
  video: Schema.Boolean,
})
export type ModelModalities = typeof ModelModalities.Type

export const defaultModelModalities = (): ModelModalities => ({
  vision: false,
  audio: false,
  video: false,
})

import type { ReasoningProfile } from "./inventory.js"
import { ReasoningProfile as ReasoningProfileSchema } from "./inventory.js"

export const ModelProperties = Schema.Struct({
  model_path: Path,
  model_size_bytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  architecture: optional(Schema.String),
  name: optional(Schema.String),
  context_tokens: U32,
  training_context_tokens: U32,
  sliding_window_tokens: Schema.Number.pipe(Schema.int()),
  chat_template: Schema.String,
  capabilities: TemplateCapabilities,
  reasoning: ReasoningProfileSchema,
  modalities: ModelModalities,
  speculative: SpeculativeDecodingRuntimeProperties,
  execution: ExecutionConfigReport,
  template_fingerprint: Schema.String,
})
export type ModelProperties = typeof ModelProperties.Type

export const InferenceProgressQueued = Schema.Struct({ type: Schema.Literal("queued") })
export const InferenceProgressPreparing = Schema.Struct({ type: Schema.Literal("preparing") })
export const InferenceProgressPrefill = Schema.Struct({
  type: Schema.Literal("prefill"),
  completed_tokens: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  total_tokens: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  cached_tokens: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
})
export const InferenceProgressGenerating = Schema.Struct({ type: Schema.Literal("generating") })

export const InferenceProgress = Schema.Union(
  InferenceProgressQueued,
  InferenceProgressPreparing,
  InferenceProgressPrefill,
  InferenceProgressGenerating
)
export type InferenceProgress = typeof InferenceProgress.Type

export type InferenceError =
  | { readonly _tag: "InvalidConfig"; readonly message: string }
  | { readonly _tag: "ContextLengthExceeded"; readonly promptTokens: number; readonly contextCapacity: number }
  | { readonly _tag: "Backend"; readonly message: string }
  | { readonly _tag: "Cancelled" }
  | { readonly _tag: "ModelInstanceStopped" }
  | { readonly _tag: "Overloaded" }
  | { readonly _tag: "ExecutorStopped" }
  | { readonly _tag: "Callback"; readonly message: string }

export const validateInferenceCapacity = (
  promptTokens: number,
  contextCapacity: number
): void | InferenceError => {
  if (promptTokens >= contextCapacity) {
    return {
      _tag: "ContextLengthExceeded",
      promptTokens,
      contextCapacity,
    }
  }
}
