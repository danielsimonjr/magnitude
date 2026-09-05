import { Option } from "effect"
import type { ResolvedInferenceRequest } from "@magnitudedev/icn-contracts/inference"

/** Grammar source classification for native sampler construction. */
export type CommonGrammarKind = "tool_calls" | "output_format" | "user"

export interface CommonGrammar {
  readonly kind: CommonGrammarKind
  readonly source: string
}

export type CommonGrammarTrigger =
  | { readonly kind: "token"; readonly token: number; readonly value: string | undefined }
  | { readonly kind: "word"; readonly value: string }
  | { readonly kind: "pattern"; readonly value: string }
  | { readonly kind: "pattern_full"; readonly value: string }

export interface CommonReasoningBudget {
  readonly limit: { readonly kind: "tokens"; readonly tokens: number }
  readonly startTag: string
  readonly endTag: string
  readonly forcedMessage: string
  readonly controllable: boolean
}

/**
 * Configuration passed to llama.cpp's sampling chain.
 *
 * Actual sampling runs inside native code; this type mirrors `CommonSamplerConfig` from the Rust
 * bindings and is assembled by the executor before handing off to `@magnitudedev/icn-native`.
 */
export interface CommonSamplerConfig {
  readonly seed: number | undefined
  readonly ignoreEos: boolean | undefined
  readonly topP: number | undefined
  readonly temperature: number | undefined
  readonly grammar: CommonGrammar | undefined
  readonly grammarLazy: boolean | undefined
  readonly grammarTriggers: readonly CommonGrammarTrigger[] | undefined
  readonly preservedTokens: readonly number[] | undefined
  readonly generationPrompt: string | undefined
  readonly reasoningBudget: CommonReasoningBudget | undefined
}

export interface PreparedChatForSampling {
  readonly grammar: string
  readonly grammarLazy: boolean
  readonly grammarTriggers: readonly {
    readonly kind: "token" | "word" | "pattern" | "pattern_full"
    readonly token?: number
    readonly value: string
  }[]
  readonly preservedTokens: readonly number[]
  readonly generationPrompt: string
  readonly thinkingStartTag: string | undefined
  readonly thinkingEndTag: string | undefined
}

const grammarKind = (
  request: ResolvedInferenceRequest,
  prepared: PreparedChatForSampling
): CommonGrammar | undefined => {
  if (prepared.grammar.length === 0) return undefined
  const toolsEnabled =
    request.tools.definitions.length > 0 && request.tools.choice.type !== "disabled"
  if (toolsEnabled) return { kind: "tool_calls", source: prepared.grammar }
  switch (request.output.type) {
    case "json_object":
    case "json_schema":
      return { kind: "output_format", source: prepared.grammar }
    case "grammar":
    case "text":
      return { kind: "user", source: prepared.grammar }
  }
}

const reasoningBudget = (
  request: ResolvedInferenceRequest,
  prepared: PreparedChatForSampling
): CommonReasoningBudget | undefined => {
  const explicit = request.reasoning.explicit_budget
  const automatic =
    request.reasoning.automatic_budget.type === "fixed_tokens"
      ? request.reasoning.automatic_budget.tokens
      : undefined
  const tokens = Option.isSome(explicit) ? explicit.value : automatic
  if (tokens === undefined) return undefined
  if (prepared.thinkingStartTag === undefined || prepared.thinkingEndTag === undefined) {
    throw new Error(
      "the active template does not expose reasoning tags required for budgeting"
    )
  }
  return {
    limit: { kind: "tokens", tokens },
    startTag: prepared.thinkingStartTag,
    endTag: prepared.thinkingEndTag,
    forcedMessage: "",
    controllable: true,
  }
}

/** Build the native sampling configuration from a resolved request and prepared chat. */
export const buildSamplerConfig = (
  request: ResolvedInferenceRequest,
  prepared: PreparedChatForSampling
): CommonSamplerConfig => {
  const grammar = grammarKind(request, prepared)
  const grammarTriggers =
    grammar === undefined
      ? undefined
      : prepared.grammarTriggers.map((trigger) => {
          switch (trigger.kind) {
            case "token":
              return {
                kind: "token" as const,
                token: trigger.token!,
                value: trigger.value,
              }
            case "word":
              return { kind: "word" as const, value: trigger.value }
            case "pattern":
              return { kind: "pattern" as const, value: trigger.value }
            case "pattern_full":
              return { kind: "pattern_full" as const, value: trigger.value }
          }
        })

  return {
    seed: request.generation.sampling.seed,
    ignoreEos:
      request.generation.end_of_generation === "ignore_model_end" ? true : undefined,
    topP: request.generation.sampling.top_p,
    temperature: request.generation.sampling.temperature,
    grammar,
    grammarLazy: prepared.grammar.length > 0 ? prepared.grammarLazy : undefined,
    grammarTriggers,
    preservedTokens: prepared.grammar.length > 0 ? [...prepared.preservedTokens] : undefined,
    generationPrompt:
      prepared.generationPrompt.length > 0 ? prepared.generationPrompt : undefined,
    reasoningBudget: reasoningBudget(request, prepared),
  }
}

import { getSamplingContext } from "./context-binding.js"
import { sampleTokenFromContext } from "./native.js"

/**
 * Sample one token from logits via `@magnitudedev/icn-native`.
 *
 * The executor calls this on the dedicated worker thread that owns FFI after
 * `bindSamplingContext`. Only greedy decoding is wired; temperature, top-p,
 * grammars, and reasoning budgets require native sampler-chain FFI.
 */
export const sampleToken = async (
  config: CommonSamplerConfig,
  batchIndex: number
): Promise<number> => sampleTokenFromContext(getSamplingContext(), config, batchIndex)
