import { ParseResult, Schema } from "effect"
import { ImageInputSchema } from "../execution.js"
import type { InferenceRequestError } from "./primitives.js"
import { NonEmptyTextSchema } from "./primitives.js"

const nonEmptyStringNewtype = (field: string) =>
  Schema.transformOrFail(Schema.String, Schema.typeSchema(Schema.Any), {
    strict: true,
    decode: (value, _, ast) => {
      if (value.length === 0) {
        return ParseResult.fail(new ParseResult.Type(ast, value, `${field} must not be empty`))
      }
      return ParseResult.succeed(value)
    },
    encode: (value) => value,
  })

export const ToolCallId = nonEmptyStringNewtype("tool call ID").pipe(Schema.brand("ToolCallId"))
export type ToolCallId = typeof ToolCallId.Type

export const ToolName = nonEmptyStringNewtype("tool name").pipe(Schema.brand("ToolName"))
export type ToolName = typeof ToolName.Type

export const tryToolCallId = (value: string): ToolCallId | InferenceRequestError =>
  value.length === 0 ? { _tag: "Empty", field: "tool call ID" } : (value as ToolCallId)

export const tryToolName = (value: string): ToolName | InferenceRequestError =>
  value.length === 0 ? { _tag: "Empty", field: "tool name" } : (value as ToolName)

export const JsonObject = Schema.Record({ key: Schema.String, value: Schema.Unknown })
export type JsonObject = typeof JsonObject.Type

export const ToolCall = Schema.Struct({
  id: ToolCallId,
  name: ToolName,
  input: JsonObject,
})
export type ToolCall = typeof ToolCall.Type

export const toolCall = (id: ToolCallId, name: ToolName, input: JsonObject): ToolCall => ({ id, name, input })

export const ToolOutcome = Schema.Literal("success", "error")
export type ToolOutcome = typeof ToolOutcome.Type

export const ToolResultContentText = Schema.Struct({
  type: Schema.Literal("text"),
  text: NonEmptyTextSchema,
})

export const ToolResultContentImage = Schema.Struct({
  type: Schema.Literal("image"),
  image: ImageInputSchema,
})

export const ToolResultContent = Schema.Union(ToolResultContentText, ToolResultContentImage)
export type ToolResultContent = typeof ToolResultContent.Type

export const ToolResult = Schema.Struct({
  outcome: ToolOutcome,
  content: Schema.Array(ToolResultContent),
})
export type ToolResult = typeof ToolResult.Type

export const toolResult = (outcome: ToolOutcome, content: readonly ToolResultContent[]): ToolResult => ({
  outcome,
  content: [...content],
})

export const ToolExchange = Schema.Struct({
  call: ToolCall,
  result: ToolResult,
})
export type ToolExchange = typeof ToolExchange.Type

export const toolExchange = (call: ToolCall, result: ToolResult): ToolExchange => ({ call, result })
