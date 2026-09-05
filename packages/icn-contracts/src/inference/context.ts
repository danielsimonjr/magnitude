import { Option, Schema } from "effect"
import { ImageInputSchema } from "../execution.js"
import { NonEmptyTextSchema } from "./primitives.js"
import { ToolExchange } from "./tools.js"

export const UserContentText = Schema.Struct({
  type: Schema.Literal("text"),
  text: NonEmptyTextSchema,
})

export const UserContentImage = Schema.Struct({
  type: Schema.Literal("image"),
  image: ImageInputSchema,
})

export const UserContent = Schema.Union(UserContentText, UserContentImage)
export type UserContent = typeof UserContent.Type

export const UserEntry = Schema.Struct({
  content: Schema.Array(UserContent),
})
export type UserEntry = typeof UserEntry.Type

export const userEntry = (content: readonly UserContent[]): UserEntry => ({ content: [...content] })

export const AssistantEntry = Schema.Struct({
  reasoning: Schema.optionalWith(NonEmptyTextSchema, { as: "Option", exact: true, nullable: true }),
  text: Schema.optionalWith(NonEmptyTextSchema, { as: "Option", exact: true, nullable: true }),
  tool_calls: Schema.Array(ToolExchange),
})
export type AssistantEntry = typeof AssistantEntry.Type

export const assistantEntry = (
  reasoning: AssistantEntry["reasoning"],
  text: AssistantEntry["text"],
  toolCalls: readonly ToolExchange[]
): AssistantEntry => ({
  reasoning,
  text,
  tool_calls: [...toolCalls],
})

export const ContextEntryUser = Schema.Struct({
  type: Schema.Literal("user"),
  entry: UserEntry,
})

export const ContextEntryAssistant = Schema.Struct({
  type: Schema.Literal("assistant"),
  entry: AssistantEntry,
})

export const ContextEntry = Schema.Union(ContextEntryUser, ContextEntryAssistant)
export type ContextEntry = typeof ContextEntry.Type

export const InferenceContext = Schema.Struct({
  system: Schema.optionalWith(NonEmptyTextSchema, { as: "Option", exact: true }),
  entries: Schema.Array(ContextEntry).pipe(Schema.minItems(1)),
})
export type InferenceContext = typeof InferenceContext.Type

export const inferenceContext = (
  system: InferenceContext["system"],
  entries: readonly ContextEntry[]
): InferenceContext => ({ system, entries: [...entries] })
