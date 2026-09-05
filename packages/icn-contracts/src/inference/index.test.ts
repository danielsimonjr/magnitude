import { Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { assistantEntry, AssistantEntry, inferenceContext, InferenceContext, UserEntry } from "./context.js"
import { NonEmptyText, NonEmptyVec } from "./primitives.js"
import { OutputJournal } from "./output.js"
import { Temperature, tryToolConfiguration, tryTopP } from "./request.js"
import { toolResult, tryToolCallId, tryToolName } from "./tools.js"
import { decodeJson } from "../schema/common.js"

const text = (value: string) => {
  const parsed = NonEmptyText.tryNew(value, "test text")
  if (typeof parsed === "object" && "_tag" in parsed) throw new Error("invalid text")
  return parsed
}

describe("request", () => {
  it("bounded sampling values reject invalid values", () => {
    expect(Schema.decodeUnknownEither(Temperature)(Number.NaN)._tag).toBe("Left")
    expect(Schema.decodeUnknownEither(Temperature)(2.1)._tag).toBe("Left")
    expect(tryTopP(-0.1)).toEqual({ _tag: "OutOfRange", field: "top_p", minimum: 0, maximum: 1 })
    expect(tryTopP(1)).toBe(1)
  })

  it("tool configuration rejects duplicate names", () => {
    const name = tryToolName("search")
    if (typeof name === "object" && "_tag" in name) throw new Error("invalid name")
    const result = tryToolConfiguration(
      [
        { name, description: Option.none(), input_schema: {} },
        { name, description: Option.none(), input_schema: {} },
      ],
      { type: "auto" },
      "parallel"
    )
    expect(result).toEqual({ _tag: "DuplicateToolName", name: "search" })
  })
})

describe("context", () => {
  it("accepts empty assistant entry", () => {
    const entry = assistantEntry(Option.none(), Option.none(), [])
    expect(Option.isNone(entry.reasoning)).toBe(true)
    expect(Option.isNone(entry.text)).toBe(true)
    expect(entry.tool_calls).toHaveLength(0)
  })

  it("accepts empty user entry", () => {
    const entry: UserEntry = { content: [] }
    expect(entry.content).toHaveLength(0)
  })

  it("rejects empty text inside present fields", () => {
    for (const value of [
      { reasoning: "", text: null, tool_calls: [] },
      { reasoning: null, text: "", tool_calls: [] },
    ]) {
      expect(Schema.decodeUnknownEither(AssistantEntry as unknown as Schema.Schema<any, any, never>)(value)._tag).toBe("Left")
    }
  })

  it("rejects empty context entries during deserialization", () => {
    expect(
      Schema.decodeUnknownEither(InferenceContext as unknown as Schema.Schema<any, any, never>)({
        system: "system",
        entries: [],
      })._tag
    ).toBe("Left")
  })

  it("accepts empty assistant entry during deserialization", () => {
    const entry = decodeJson(AssistantEntry as unknown as Schema.Schema<any, any, never>, {
      reasoning: null,
      text: null,
      tool_calls: [],
    })
    expect(entry.tool_calls).toHaveLength(0)
  })

  it("system is structurally separate from entries", () => {
    const context = inferenceContext(
      Option.some(text("system")),
      [
        {
          type: "user" as const,
          entry: { content: [{ type: "text" as const, text: text("hello") }] },
        },
      ]
    )
    expect(Option.match(context.system, { onNone: () => null, onSome: (value) => value.asStr() })).toBe("system")
    expect(context.entries).toHaveLength(1)
  })
})

describe("output journal", () => {
  it("constructs the fixed output shape", () => {
    const journal = new OutputJournal()
    const callId = tryToolCallId("call_1")
    const toolName = tryToolName("search")
    if (typeof callId === "object" || typeof toolName === "object") throw new Error("invalid tool ids")

    for (const event of [
      { type: "started" as const },
      { type: "reasoning_delta" as const, text: text("think") },
      { type: "text_delta" as const, text: text("answer") },
      { type: "tool_call_started" as const, index: 0, id: callId, name: toolName },
      { type: "tool_input_delta" as const, index: 0, json_fragment: text('{"q":"rust"}') },
      { type: "tool_call_finished" as const, index: 0 },
    ]) {
      expect(journal.push(event)).toBeNull()
    }

    const output = journal.finish()
    if ("_tag" in output) throw new Error("expected output")
    expect(Option.getOrThrow(output.reasoning).asStr()).toBe("think")
    expect(Option.getOrThrow(output.text).asStr()).toBe("answer")
    expect(output.tool_calls[0]?.input.q).toBe("rust")
  })

  it("rejects phase regression and incomplete calls", () => {
    const journal = new OutputJournal()
    expect(journal.push({ type: "started" })).toBeNull()
    expect(journal.push({ type: "text_delta", text: text("answer") })).toBeNull()
    expect(journal.push({ type: "reasoning_delta", text: text("late") })).toEqual({ _tag: "PhaseRegression" })

    const incomplete = new OutputJournal()
    const callId = tryToolCallId("call")
    const toolName = tryToolName("tool")
    if (typeof callId === "object" || typeof toolName === "object") throw new Error("invalid tool ids")
    expect(incomplete.push({ type: "started" })).toBeNull()
    expect(
      incomplete.push({ type: "tool_call_started", index: 0, id: callId, name: toolName })
    ).toBeNull()
    expect(incomplete.finish()).toEqual({ _tag: "OpenToolCall" })
  })
})

describe("tools", () => {
  it("tool result may have no content", () => {
    expect(toolResult("success", []).content).toHaveLength(0)
  })
})
