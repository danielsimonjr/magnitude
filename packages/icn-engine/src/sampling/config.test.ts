import { describe, expect, it } from "vitest"
import { Option } from "effect"
import { buildSamplerConfig } from "./config.js"

const baseRequest = () => ({
  context: { entries: [], system: Option.none() },
  tools: { definitions: [], choice: { type: "disabled" as const }, parallelism: "parallel" as const },
  reasoning: {
    effort: "none" as never,
    controls: { enable_thinking: Option.none(), template_args: {} },
    automatic_budget: { type: "disabled" as const },
    explicit_budget: Option.none(),
    template_fingerprint: "sha256:test",
  },
  output: { type: "text" as const },
  generation: {
    max_output_tokens: Option.none(),
    sampling: { temperature: 0.7 as never, top_p: 0.9 as never, seed: 42 },
    stop_sequences: [],
    end_of_generation: "ignore_model_end" as const,
  },
  prompt_reuse: "allowed" as const,
})

describe("buildSamplerConfig", () => {
  it("maps generation parameters and grammar metadata", () => {
    const config = buildSamplerConfig(baseRequest(), {
      grammar: "root ::= \"ok\"",
      grammarLazy: true,
      grammarTriggers: [{ kind: "word", value: "{" }],
      preservedTokens: [1, 2],
      generationPrompt: "assistant:",
      thinkingStartTag: undefined,
      thinkingEndTag: undefined,
    })

    expect(config.seed).toBe(42)
    expect(config.ignoreEos).toBe(true)
    expect(config.topP).toBe(0.9)
    expect(config.temperature).toBe(0.7)
    expect(config.grammar).toEqual({ kind: "user", source: "root ::= \"ok\"" })
    expect(config.grammarLazy).toBe(true)
    expect(config.grammarTriggers).toEqual([{ kind: "word", value: "{" }])
    expect(config.preservedTokens).toEqual([1, 2])
    expect(config.generationPrompt).toBe("assistant:")
    expect(config.reasoningBudget).toBeUndefined()
  })
})
