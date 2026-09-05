import { Option, ParseResult, Schema } from "effect"
import { JsonValue, optional, PositiveInt } from "../schema/common.js"
import { NormalizedReasoningEffort } from "../inventory.js"
import { InferenceContext } from "./context.js"
import type { InferenceRequestError } from "./primitives.js"
import { NonEmptyTextSchema } from "./primitives.js"
import { JsonObject, ToolName } from "./tools.js"

export const InferenceModelSelector = Schema.String.pipe(
  Schema.filter((value) => value.length > 0 || "inference model selector must not be empty"),
  Schema.brand("InferenceModelSelector")
)
export type InferenceModelSelector = typeof InferenceModelSelector.Type

export const tryInferenceModelSelector = (value: string): InferenceModelSelector | InferenceRequestError =>
  value.length === 0 ? { _tag: "Empty", field: "inference model selector" } : (value as InferenceModelSelector)

export const ReasoningIntentModelDefault = Schema.Struct({
  type: Schema.Literal("model_default"),
  template_args: Schema.Record({ key: Schema.String, value: JsonValue }),
  budget: optional(PositiveInt),
})

export const ReasoningIntentDisabled = Schema.Struct({
  type: Schema.Literal("disabled"),
  template_args: Schema.Record({ key: Schema.String, value: JsonValue }),
})

export const ReasoningIntentEnabled = Schema.Struct({
  type: Schema.Literal("enabled"),
  template_args: Schema.Record({ key: Schema.String, value: JsonValue }),
  budget: optional(PositiveInt),
})

export const ReasoningIntentEffort = Schema.Struct({
  type: Schema.Literal("effort"),
  effort: NormalizedReasoningEffort,
  template_args: Schema.Record({ key: Schema.String, value: JsonValue }),
  budget: optional(PositiveInt),
})

export const ReasoningIntent = Schema.Union(
  ReasoningIntentModelDefault,
  ReasoningIntentDisabled,
  ReasoningIntentEnabled,
  ReasoningIntentEffort
)
export type ReasoningIntent = typeof ReasoningIntent.Type

export const ResolvedReasoning = Schema.Struct({
  effort: NormalizedReasoningEffort,
  controls: Schema.Struct({
    enable_thinking: optional(Schema.Boolean),
    template_args: Schema.Record({ key: Schema.String, value: JsonValue }),
  }),
  automatic_budget: Schema.Union(
    Schema.Struct({ type: Schema.Literal("disabled") }),
    Schema.Struct({ type: Schema.Literal("fixed_tokens"), tokens: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)) })
  ),
  explicit_budget: optional(PositiveInt),
  template_fingerprint: Schema.String,
})
export type ResolvedReasoning = typeof ResolvedReasoning.Type

export const resolvedReasoning = (
  effort: ResolvedReasoning["effort"],
  controls: ResolvedReasoning["controls"],
  automaticBudget: ResolvedReasoning["automatic_budget"],
  explicitBudget: ResolvedReasoning["explicit_budget"],
  templateFingerprint: string
): ResolvedReasoning => ({
  effort,
  controls,
  automatic_budget: automaticBudget,
  explicit_budget: explicitBudget,
  template_fingerprint: templateFingerprint,
})

export const ToolDefinitionSchema = Schema.Struct({
  name: ToolName,
  description: optional(Schema.String),
  input_schema: JsonObject,
})
export type ToolDefinition = typeof ToolDefinitionSchema.Type

export const toolDefinition = (
  name: ToolName,
  description: ToolDefinition["description"],
  inputSchema: JsonObject
): ToolDefinition => ({
  name,
  description,
  input_schema: inputSchema,
})

export const ToolChoiceDisabled = Schema.Struct({ type: Schema.Literal("disabled") })
export const ToolChoiceAuto = Schema.Struct({ type: Schema.Literal("auto") })
export const ToolChoiceRequired = Schema.Struct({ type: Schema.Literal("required") })
export const ToolChoiceSpecific = Schema.Struct({
  type: Schema.Literal("specific"),
  name: ToolName,
})
export const ToolChoiceAllowed = Schema.Struct({
  type: Schema.Literal("allowed"),
  names: Schema.Array(ToolName),
  required: Schema.Boolean,
})

export const ToolChoice = Schema.Union(
  ToolChoiceDisabled,
  ToolChoiceAuto,
  ToolChoiceRequired,
  ToolChoiceSpecific,
  ToolChoiceAllowed
)
export type ToolChoice = typeof ToolChoice.Type

export const ToolParallelism = Schema.Literal("sequential", "parallel")
export type ToolParallelism = typeof ToolParallelism.Type

export interface ToolConfiguration {
  readonly definitions: readonly ToolDefinition[]
  readonly choice: ToolChoice
  readonly parallelism: ToolParallelism
}

export const tryToolConfiguration = (
  definitions: readonly ToolDefinition[],
  choice: ToolChoice,
  parallelism: ToolParallelism
): ToolConfiguration | InferenceRequestError => {
  const names = new Set<string>()
  for (const definition of definitions) {
    const name = definition.name
    if (names.has(name)) return { _tag: "DuplicateToolName", name }
    names.add(name)
  }

  switch (choice.type) {
    case "required":
      if (definitions.length === 0) return { _tag: "RequiredToolsWithoutDefinitions" }
      break
    case "specific":
      if (!names.has(choice.name)) return { _tag: "UnknownToolName", name: choice.name }
      break
    case "allowed": {
      if (choice.names.length === 0) return { _tag: "EmptyAllowedTools" }
      const seen = new Set<string>()
      for (const name of choice.names) {
        if (seen.has(name)) return { _tag: "DuplicateAllowedToolName", name }
        seen.add(name)
        if (!names.has(name)) return { _tag: "UnknownToolName", name }
      }
      break
    }
    default:
      break
  }

  return { definitions: [...definitions], choice, parallelism }
}

export const toolConfigurationNone = (): ToolConfiguration => ({
  definitions: [],
  choice: { type: "disabled" },
  parallelism: "sequential",
})

const ToolConfigurationWire = Schema.Struct({
  definitions: Schema.Array(ToolDefinitionSchema),
  choice: ToolChoice,
  parallelism: ToolParallelism,
})

export const ToolConfigurationSchema = Schema.transformOrFail(ToolConfigurationWire, Schema.typeSchema(Schema.Any), {
  strict: true,
  decode: (wire, _, ast) => {
    const parsed = tryToolConfiguration(wire.definitions, wire.choice, wire.parallelism)
    if ("_tag" in parsed) {
      return ParseResult.fail(new ParseResult.Type(ast, wire, parsed._tag))
    }
    return ParseResult.succeed(parsed)
  },
  encode: (value) =>
    ParseResult.succeed({
      definitions: [...value.definitions],
      choice: value.choice,
      parallelism: value.parallelism,
    }),
})

export const OutputConstraintText = Schema.Struct({ type: Schema.Literal("text") })
export const OutputConstraintJsonObject = Schema.Struct({ type: Schema.Literal("json_object") })
export const OutputConstraintJsonSchema = Schema.Struct({
  type: Schema.Literal("json_schema"),
  constraint: Schema.Struct({
    name: Schema.String,
    schema: JsonObject,
    strict: Schema.Boolean,
  }),
})
export const OutputConstraintGrammar = Schema.Struct({
  type: Schema.Literal("grammar"),
  constraint: Schema.String.pipe(
    Schema.filter((value) => value.length > 0 || "grammar must not be empty")
  ),
})

export const OutputConstraint = Schema.Union(
  OutputConstraintText,
  OutputConstraintJsonObject,
  OutputConstraintJsonSchema,
  OutputConstraintGrammar
)
export type OutputConstraint = typeof OutputConstraint.Type

export const JsonSchemaConstraint = Schema.Struct({
  name: Schema.String,
  schema: JsonObject,
  strict: Schema.Boolean,
})
export type JsonSchemaConstraint = typeof JsonSchemaConstraint.Type

export const jsonSchemaConstraint = (name: string, schema: JsonObject, strict: boolean): JsonSchemaConstraint => ({
  name,
  schema,
  strict,
})

export const GrammarConstraint = Schema.String.pipe(
  Schema.filter((value) => value.length > 0 || "grammar must not be empty"),
  Schema.brand("GrammarConstraint")
)
export type GrammarConstraint = typeof GrammarConstraint.Type

export const SamplingParameters = Schema.Struct({
  temperature: Schema.Number,
  top_p: Schema.Number,
  seed: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
})
export type SamplingParameters = typeof SamplingParameters.Type

const boundedFloat = (field: string, minimum: number, maximum: number) =>
  Schema.Number.pipe(
    Schema.filter((value) =>
      Number.isFinite(value) && value >= minimum && value <= maximum
        ? true
        : `${field} must be between ${minimum} and ${maximum}, inclusive`
    )
  )

export const Temperature = boundedFloat("temperature", 0, 2).pipe(Schema.brand("Temperature"))
export type Temperature = typeof Temperature.Type

export const TopP = boundedFloat("top_p", 0, 1).pipe(Schema.brand("TopP"))
export type TopP = typeof TopP.Type

export const tryTemperature = (value: number): Temperature | InferenceRequestError =>
  Number.isFinite(value) && value >= 0 && value <= 2
    ? (value as Temperature)
    : { _tag: "OutOfRange", field: "temperature", minimum: 0, maximum: 2 }

export const tryTopP = (value: number): TopP | InferenceRequestError =>
  Number.isFinite(value) && value >= 0 && value <= 1
    ? (value as TopP)
    : { _tag: "OutOfRange", field: "top_p", minimum: 0, maximum: 1 }

export const StopSequence = Schema.String.pipe(
  Schema.filter((value) => value.length > 0 || "stop sequence must not be empty"),
  Schema.brand("StopSequence")
)
export type StopSequence = typeof StopSequence.Type

export const tryStopSequence = (value: string): StopSequence | InferenceRequestError =>
  value.length === 0 ? { _tag: "Empty", field: "stop sequence" } : (value as StopSequence)

export const EndOfGenerationPolicy = Schema.Literal("stop_at_model_end", "ignore_model_end")
export type EndOfGenerationPolicy = typeof EndOfGenerationPolicy.Type

export const PromptReusePolicy = Schema.Literal("disabled", "allowed")
export type PromptReusePolicy = typeof PromptReusePolicy.Type

export const GenerationParameters = Schema.Struct({
  max_output_tokens: optional(PositiveInt),
  sampling: Schema.Struct({
    temperature: Temperature,
    top_p: TopP,
    seed: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  }),
  stop_sequences: Schema.Array(StopSequence),
  end_of_generation: EndOfGenerationPolicy,
})
export type GenerationParameters = typeof GenerationParameters.Type

export const generationParameters = (
  maxOutputTokens: GenerationParameters["max_output_tokens"],
  sampling: GenerationParameters["sampling"],
  stopSequences: readonly StopSequence[],
  endOfGeneration: EndOfGenerationPolicy
): GenerationParameters => ({
  max_output_tokens: maxOutputTokens,
  sampling,
  stop_sequences: [...stopSequences],
  end_of_generation: endOfGeneration,
})

export const InferenceRequestReasoningIntent = Schema.Struct({
  context: InferenceContext,
  tools: ToolConfigurationSchema,
  reasoning: ReasoningIntent,
  output: OutputConstraint,
  generation: GenerationParameters,
  prompt_reuse: PromptReusePolicy,
})
export type InferenceRequestReasoningIntent = typeof InferenceRequestReasoningIntent.Type

export const ResolvedInferenceRequest = Schema.Struct({
  context: InferenceContext,
  tools: ToolConfigurationSchema,
  reasoning: ResolvedReasoning,
  output: OutputConstraint,
  generation: GenerationParameters,
  prompt_reuse: PromptReusePolicy,
})
export type ResolvedInferenceRequest = typeof ResolvedInferenceRequest.Type

export const InferenceInvocation = Schema.Struct({
  model: InferenceModelSelector,
  request: InferenceRequestReasoningIntent,
})
export type InferenceInvocation = typeof InferenceInvocation.Type

export const inferenceInvocation = (
  model: InferenceModelSelector,
  request: InferenceRequestReasoningIntent
): InferenceInvocation => ({ model, request })

export const mapInferenceRequestReasoning = <R, T>(
  request: {
    context: InferenceContext
    tools: ToolConfiguration
    reasoning: R
    output: OutputConstraint
    generation: GenerationParameters
    prompt_reuse: PromptReusePolicy
  },
  map: (reasoning: R) => T
) => ({
  ...request,
  reasoning: map(request.reasoning),
})

// ToolDefinition schema is defined in this module.
