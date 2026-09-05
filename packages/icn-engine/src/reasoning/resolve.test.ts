import { describe, expect, it } from "vitest"
import { Option } from "effect"
import type { NormalizedReasoningEffort, ReasoningProfile } from "@magnitudedev/icn-contracts"
import {
  reasoningEffortRank,
  reconcileReasoningEffort,
  resolveReasoningIntent,
  roundUpOrClampReasoningEffort,
} from "./resolve.js"

const profile = (mappings: ReasoningProfile["mappings"], defaultEffort?: string): ReasoningProfile => ({
  default_effort: defaultEffort === undefined ? Option.none() : Option.some(defaultEffort as never),
  mappings,
  template_fingerprint: "sha256:test",
})

describe("reasoning effort rank", () => {
  it("orders known effort levels", () => {
    expect(reasoningEffortRank("minimal" as NormalizedReasoningEffort)).toBe(0)
    expect(reasoningEffortRank("high" as NormalizedReasoningEffort)).toBe(3)
    expect(reasoningEffortRank("none" as NormalizedReasoningEffort)).toBeUndefined()
  })
})

describe("round up or clamp reasoning effort", () => {
  it("rounds up to the next supported effort", () => {
    const result = roundUpOrClampReasoningEffort(
      "medium" as never,
      profile([
        {
          effort: "low" as never,
          controls: { enable_thinking: Option.none(), template_args: {} },
          automatic_budget: { type: "disabled" },
        },
        {
          effort: "high" as never,
          controls: { enable_thinking: Option.none(), template_args: {} },
          automatic_budget: { type: "disabled" },
        },
      ])
    )
    expect(result).toBe("high")
  })
})

describe("resolve reasoning intent", () => {
  it("disabled intent maps to none effort controls", () => {
    const resolved = resolveReasoningIntent(
      { type: "disabled", template_args: {} },
      profile([])
    )
    expect(resolved).toMatchObject({
      effort: "none",
      controls: { enable_thinking: Option.some(false) },
    })
  })

  it("rejects conflicting template args", () => {
    const resolved = resolveReasoningIntent(
      {
        type: "effort",
        effort: "high" as never,
        template_args: { reasoning_effort: "low" },
        budget: Option.none(),
      },
      profile([
        {
          effort: "high" as never,
          controls: {
            enable_thinking: Option.none(),
            template_args: { reasoning_effort: "high" },
          },
          automatic_budget: { type: "disabled" },
        },
      ])
    )
    expect(resolved).toEqual({
      _tag: "InvalidRequest",
      message: "chat_template_kwargs conflicts with resolved reasoning control: reasoning_effort",
    })
  })
})

describe("reconcile reasoning effort", () => {
  it("rounds unsupported requested effort before resolution", () => {
    const request = {
      context: { entries: [], system: Option.none() },
      tools: { definitions: [], choice: { type: "disabled" as const }, parallelism: "parallel" as const },
      reasoning: {
        type: "effort" as const,
        effort: "medium" as never,
        template_args: {},
        budget: Option.none(),
      },
      output: { type: "text" as const },
      generation: {
        max_output_tokens: Option.none(),
        sampling: { temperature: 1 as never, top_p: 1 as never, seed: 0 },
        stop_sequences: [],
        end_of_generation: "stop_at_model_end" as const,
      },
      prompt_reuse: "allowed" as const,
    }
    const reconciled = reconcileReasoningEffort(
      request,
      profile([
        {
          effort: "high" as never,
          controls: { enable_thinking: Option.none(), template_args: {} },
          automatic_budget: { type: "disabled" },
        },
      ])
    )
    expect(reconciled.reasoning).toMatchObject({ effort: "high" })
  })
})

const BASIC =
  "{% for message in messages %}{{ message['role'] }}: {{ message['content'] }}\\n{% endfor %}assistant:"

describe("inspectTemplate", () => {
  it("does not throw for basic messages and returns a fingerprint", async () => {
    const { inspectTemplate } = await import("./resolve.js")
    const result = await inspectTemplate(BASIC)
    expect(result).not.toHaveProperty("_tag")
    if ("_tag" in result) throw new Error("unexpected error")
    expect(result.templateFingerprint.startsWith("sha256:")).toBe(true)
    expect(result.capabilities.string_content).toBe(true)
    expect(result.probePrompt).toContain("user: Hello")
    expect(result.probePrompt).toContain("assistant:")
  })
})
