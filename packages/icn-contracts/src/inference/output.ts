import { Option, Schema } from "effect"
import { GenerationMetrics, GenerationSnapshot, InferenceProgress } from "../execution.js"
import type { InferenceRequestError } from "./primitives.js"
import { isInferenceRequestError, NonEmptyText, NonEmptyTextSchema } from "./primitives.js"
import { StopSequence } from "./request.js"
import { JsonObject, ToolCall, ToolCallId, ToolName } from "./tools.js"

export const InferenceOutput = Schema.Struct({
  reasoning: Schema.optionalWith(NonEmptyTextSchema, { as: "Option", exact: true }),
  text: Schema.optionalWith(NonEmptyTextSchema, { as: "Option", exact: true }),
  tool_calls: Schema.Array(
    Schema.Struct({
      id: ToolCallId,
      name: ToolName,
      input: JsonObject,
    })
  ),
})
export type InferenceOutput = typeof InferenceOutput.Type

export const inferenceOutput = (
  reasoning: InferenceOutput["reasoning"],
  text: InferenceOutput["text"],
  toolCalls: readonly ToolCall[]
): InferenceOutput => ({
  reasoning,
  text,
  tool_calls: toolCalls.map((call) => ({ id: call.id, name: call.name, input: call.input })),
})

export const TokenUsage = Schema.Struct({
  input_tokens: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  cached_input_tokens: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  output_tokens: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  reasoning_output_tokens: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
})
export type TokenUsage = typeof TokenUsage.Type

export const tokenUsage = (
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  reasoningOutputTokens: number
): TokenUsage => ({
  input_tokens: inputTokens,
  cached_input_tokens: cachedInputTokens,
  output_tokens: outputTokens,
  reasoning_output_tokens: reasoningOutputTokens,
})

export const TerminationNatural = Schema.Struct({ type: Schema.Literal("natural") })
export const TerminationStopSequence = Schema.Struct({
  type: Schema.Literal("stop_sequence"),
  sequence: StopSequence,
})
export const TerminationOutputLimit = Schema.Struct({ type: Schema.Literal("output_limit") })
export const TerminationToolCalls = Schema.Struct({ type: Schema.Literal("tool_calls") })

export const Termination = Schema.Union(
  TerminationNatural,
  TerminationStopSequence,
  TerminationOutputLimit,
  TerminationToolCalls
)
export type Termination = typeof Termination.Type

export const InferenceResult = Schema.Struct({
  output: InferenceOutput,
  usage: TokenUsage,
  termination: Termination,
  metrics: GenerationMetrics,
})
export type InferenceResult = typeof InferenceResult.Type

export const inferenceResult = (
  output: InferenceOutput,
  usage: TokenUsage,
  termination: Termination,
  metrics: GenerationMetrics
): InferenceResult => ({ output, usage, termination, metrics })

export const InferenceCompletion = Schema.Struct({
  usage: TokenUsage,
  termination: Termination,
  metrics: GenerationMetrics,
})
export type InferenceCompletion = typeof InferenceCompletion.Type

export const inferenceCompletion = (
  usage: TokenUsage,
  termination: Termination,
  metrics: GenerationMetrics
): InferenceCompletion => ({ usage, termination, metrics })

export const inferenceCompletionIntoResult = (
  completion: InferenceCompletion,
  output: InferenceOutput
): InferenceResult => inferenceResult(output, completion.usage, completion.termination, completion.metrics)

export const InferenceOutputEventStarted = Schema.Struct({ type: Schema.Literal("started") })
export const InferenceOutputEventReasoningDelta = Schema.Struct({
  type: Schema.Literal("reasoning_delta"),
  text: NonEmptyTextSchema,
})
export const InferenceOutputEventTextDelta = Schema.Struct({
  type: Schema.Literal("text_delta"),
  text: NonEmptyTextSchema,
})
export const InferenceOutputEventToolCallStarted = Schema.Struct({
  type: Schema.Literal("tool_call_started"),
  index: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  id: ToolCallId,
  name: ToolName,
})
export const InferenceOutputEventToolInputDelta = Schema.Struct({
  type: Schema.Literal("tool_input_delta"),
  index: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  json_fragment: NonEmptyTextSchema,
})
export const InferenceOutputEventToolCallFinished = Schema.Struct({
  type: Schema.Literal("tool_call_finished"),
  index: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
})

export const InferenceOutputEvent = Schema.Union(
  InferenceOutputEventStarted,
  InferenceOutputEventReasoningDelta,
  InferenceOutputEventTextDelta,
  InferenceOutputEventToolCallStarted,
  InferenceOutputEventToolInputDelta,
  InferenceOutputEventToolCallFinished
)
export type InferenceOutputEvent = typeof InferenceOutputEvent.Type

export const InferenceObservationEventOutput = Schema.Struct({
  type: Schema.Literal("output"),
  event: InferenceOutputEvent,
})

export const InferenceObservationEventProgress = Schema.Struct({
  type: Schema.Literal("progress"),
  progress: InferenceProgress,
})

export const InferenceObservationEvent = Schema.Union(
  InferenceObservationEventOutput,
  InferenceObservationEventProgress
)
export type InferenceObservationEvent = typeof InferenceObservationEvent.Type

export const InferenceObservation = Schema.Struct({
  event: InferenceObservationEvent,
  timings: Schema.optionalWith(GenerationSnapshot, { as: "Option", exact: true }),
})
export type InferenceObservation = typeof InferenceObservation.Type

export const inferenceObservation = (
  event: InferenceObservationEvent,
  timings: InferenceObservation["timings"]
): InferenceObservation => ({ event, timings })

export type OutputJournalError =
  | { readonly _tag: "DuplicateStart" }
  | { readonly _tag: "NotStarted" }
  | { readonly _tag: "PhaseRegression" }
  | { readonly _tag: "UnexpectedToolIndex"; readonly index: number }
  | { readonly _tag: "ToolCallNotOpen"; readonly index: number }
  | { readonly _tag: "ToolCallAlreadyOpen" }
  | { readonly _tag: "InvalidToolInput"; readonly index: number; readonly message: string }
  | { readonly _tag: "OpenToolCall" }
  | { readonly _tag: "MissingStart" }
  | { readonly _tag: "InvalidOutput"; readonly error: InferenceRequestError }

type OutputPhase = "start" | "reasoning" | "text" | "tools"

interface OpenToolCall {
  id: ToolCallId
  name: ToolName
  input: string
}

const phaseOrder = (phase: OutputPhase): number => {
  switch (phase) {
    case "start":
      return 0
    case "reasoning":
      return 1
    case "text":
      return 2
    case "tools":
      return 3
  }
}

const optionalText = (
  value: string,
  field: string
): Option.Option<NonEmptyText> | InferenceRequestError => {
  if (value.length === 0) return Option.none()
  const parsed = NonEmptyText.tryNew(value, field)
  if (isInferenceRequestError(parsed)) return parsed
  return Option.some(parsed)
}

export class OutputJournal {
  private started = false
  private phase: OutputPhase | null = null
  private reasoning = ""
  private text = ""
  private calls: Array<ToolCall | null> = []
  private openCalls = new Map<number, OpenToolCall>()

  push(event: InferenceOutputEvent): OutputJournalError | null {
    switch (event.type) {
      case "started":
        if (this.started) return { _tag: "DuplicateStart" }
        this.started = true
        this.phase = "start"
        return null
      case "reasoning_delta": {
        const error = this.advance("reasoning")
        if (error !== null) return error
        this.reasoning += event.text.asStr()
        return null
      }
      case "text_delta": {
        const error = this.advance("text")
        if (error !== null) return error
        this.text += event.text.asStr()
        return null
      }
      case "tool_call_started": {
        const error = this.advance("tools")
        if (error !== null) return error
        if (event.index !== this.calls.length) return { _tag: "UnexpectedToolIndex", index: event.index }
        if (this.openCalls.has(event.index)) return { _tag: "ToolCallAlreadyOpen" }
        this.openCalls.set(event.index, { id: event.id, name: event.name, input: "" })
        this.calls.push(null)
        return null
      }
      case "tool_input_delta": {
        const call = this.openCalls.get(event.index)
        if (call === undefined) return { _tag: "ToolCallNotOpen", index: event.index }
        call.input += event.json_fragment.asStr()
        return null
      }
      case "tool_call_finished": {
        const call = this.openCalls.get(event.index)
        if (call === undefined) return { _tag: "ToolCallNotOpen", index: event.index }
        this.openCalls.delete(event.index)
        try {
          const input = JSON.parse(call.input) as JsonObject
          if (input === null || typeof input !== "object" || Array.isArray(input)) {
            return { _tag: "InvalidToolInput", index: event.index, message: "expected JSON object" }
          }
          this.calls[event.index] = { id: call.id, name: call.name, input }
          return null
        } catch (error) {
          return {
            _tag: "InvalidToolInput",
            index: event.index,
            message: error instanceof Error ? error.message : String(error),
          }
        }
      }
    }
  }

  finish(): InferenceOutput | OutputJournalError {
    if (!this.started) return { _tag: "MissingStart" }
    if (this.openCalls.size > 0) return { _tag: "OpenToolCall" }
    const reasoning = optionalText(this.reasoning, "reasoning output")
    if (isInferenceRequestError(reasoning)) return { _tag: "InvalidOutput", error: reasoning }
    const text = optionalText(this.text, "text output")
    if (isInferenceRequestError(text)) return { _tag: "InvalidOutput", error: text }
    if (this.calls.some((call) => call === null)) return { _tag: "OpenToolCall" }
    return inferenceOutput(reasoning, text, this.calls as ToolCall[])
  }

  private advance(next: OutputPhase): OutputJournalError | null {
    if (!this.started) return { _tag: "NotStarted" }
    if (this.phase !== null && phaseOrder(next) < phaseOrder(this.phase)) {
      return { _tag: "PhaseRegression" }
    }
    this.phase = next
    return null
  }
}
