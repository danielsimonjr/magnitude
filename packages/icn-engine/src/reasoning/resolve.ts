import { Option } from "effect"
import { createHash } from "node:crypto"
import type {
  NormalizedReasoningEffort,
  ReasoningCapability,
  ReasoningProfile,
  TemplateCapabilities,
} from "@magnitudedev/icn-contracts"
import {
  reasoningProfileMapping,
  type AutomaticReasoningBudget,
  type NativeReasoningControls,
} from "@magnitudedev/icn-contracts"
import type {
  InferenceRequestReasoningIntent,
  ReasoningIntent,
  ResolvedInferenceRequest,
  ResolvedReasoning,
} from "@magnitudedev/icn-contracts/inference"
import { mapInferenceRequestReasoning, resolvedReasoning } from "@magnitudedev/icn-contracts/inference"
import { applyChatTemplate, isNativeAvailable, type ChatMessage } from "@magnitudedev/icn-native"

export type ReasoningResolutionError =
  | { readonly _tag: "InvalidRequest"; readonly message: string }
  | { readonly _tag: "InvalidProfile"; readonly message: string }

export type TemplateInspectionError =
  | { readonly _tag: "InvalidTemplate"; readonly message: string }
  | { readonly _tag: "NativeUnavailable"; readonly message: string }

export interface TemplateInspection {
  readonly templateFingerprint: string
  readonly capabilities: TemplateCapabilities
  readonly reasoning: ReasoningCapability
  readonly profile: ReasoningProfile
  /** Prompt produced by applying the template to the probe messages, when available. */
  readonly probePrompt: string | undefined
}

export const reasoningEffortRank = (effort: NormalizedReasoningEffort): number | undefined => {
  switch (effort) {
    case "minimal":
      return 0
    case "low":
      return 1
    case "medium":
      return 2
    case "high":
      return 3
    case "xhigh":
      return 4
    case "max":
      return 5
    case "none":
    case "adaptive":
      return undefined
    default:
      return undefined
  }
}

export const roundUpOrClampReasoningEffort = (
  requested: NormalizedReasoningEffort,
  profile: ReasoningProfile
): NormalizedReasoningEffort | undefined => {
  const enabled = profile.mappings.filter((mapping) => mapping.effort !== "none")
  const requestedRank = reasoningEffortRank(requested)

  const ranked = () =>
    enabled.flatMap((mapping) => {
      const rank = reasoningEffortRank(mapping.effort)
      return rank === undefined ? [] : [[rank, mapping] as const]
    })

  const rounded =
    requestedRank === undefined
      ? undefined
      : ranked()
          .filter(([rank]) => rank >= requestedRank)
          .sort((left, right) => left[0] - right[0])[0]?.[1] ??
        ranked().sort((left, right) => right[0] - left[0])[0]?.[1]

  if (rounded !== undefined) {
    return rounded.effort
  }

  const defaultEffort = profile.default_effort
  if (
    Option.isSome(defaultEffort) &&
    defaultEffort.value !== "none" &&
    reasoningProfileMapping(profile, defaultEffort.value) !== undefined
  ) {
    return defaultEffort.value
  }

  return enabled[0]?.effort
}

export const reconcileReasoningEffort = (
  request: InferenceRequestReasoningIntent,
  profile: ReasoningProfile
): InferenceRequestReasoningIntent =>
  mapInferenceRequestReasoning(request, (intent) => {
    if (intent.type !== "effort") return intent
    if (reasoningProfileMapping(profile, intent.effort) !== undefined) return intent
    const rounded = roundUpOrClampReasoningEffort(intent.effort, profile)
    return rounded === undefined
      ? intent
      : { ...intent, effort: rounded }
  })

export const resolveReasoningIntent = (
  intent: ReasoningIntent,
  profile: ReasoningProfile
): ResolvedReasoning | ReasoningResolutionError => {
  const invalid = (message: string): ReasoningResolutionError => ({
    _tag: "InvalidRequest",
    message,
  })
  const unsupportedEffort = (effort: NormalizedReasoningEffort): ReasoningResolutionError => {
    const supported = profile.mappings.map((mapping) => mapping.effort).join(", ")
    return invalid(
      `reasoning effort ${effort} is unsupported for this model; supported values: ${supported}`
    )
  }

  let effort: NormalizedReasoningEffort
  let controls: NativeReasoningControls
  let automaticBudget: AutomaticReasoningBudget
  let explicitBudget: ResolvedReasoning["explicit_budget"]
  let templateArgs: Record<string, unknown>

  switch (intent.type) {
    case "disabled": {
      effort = "none" as NormalizedReasoningEffort
      if (profile.mappings.length > 0 && reasoningProfileMapping(profile, effort) === undefined) {
        const supported = profile.mappings.map((mapping) => mapping.effort).join(", ")
        return invalid(
          `reasoning cannot be disabled for this model; supported values: ${supported}`
        )
      }
      controls = {
        enable_thinking: Option.some(false),
        template_args: {},
      }
      automaticBudget = { type: "disabled" }
      explicitBudget = Option.none()
      templateArgs = intent.template_args
      break
    }
    case "model_default": {
      if (Option.isNone(profile.default_effort)) {
        if (Option.isSome(intent.budget)) {
          return invalid(
            "reasoning budget requires a model with a classified reasoning default"
          )
        }
        return resolvedReasoning(
          "none" as NormalizedReasoningEffort,
          { enable_thinking: Option.none(), template_args: intent.template_args },
          { type: "disabled" },
          Option.none(),
          profile.template_fingerprint
        )
      }
      const mapping = reasoningProfileMapping(profile, profile.default_effort.value)
      if (mapping === undefined) {
        return { _tag: "InvalidProfile", message: "reasoning profile default has no compiled mapping" }
      }
      effort = profile.default_effort.value
      controls = mapping.controls
      automaticBudget = mapping.automatic_budget
      explicitBudget = intent.budget
      templateArgs = intent.template_args
      break
    }
    case "enabled": {
      if (Option.isNone(profile.default_effort)) {
        return invalid("model has no resolved reasoning default")
      }
      const mapping = reasoningProfileMapping(profile, profile.default_effort.value)
      if (mapping === undefined) {
        return { _tag: "InvalidProfile", message: "reasoning profile default has no compiled mapping" }
      }
      effort = profile.default_effort.value
      controls = {
        ...mapping.controls,
        enable_thinking: Option.some(true),
      }
      automaticBudget = mapping.automatic_budget
      explicitBudget = intent.budget
      templateArgs = intent.template_args
      break
    }
    case "effort": {
      const mapping = reasoningProfileMapping(profile, intent.effort)
      if (mapping === undefined) return unsupportedEffort(intent.effort)
      effort = intent.effort
      controls = mapping.controls
      automaticBudget = mapping.automatic_budget
      explicitBudget = intent.budget
      templateArgs = intent.template_args
      break
    }
  }

  const mergedTemplateArgs: Record<string, unknown> = { ...controls.template_args }
  for (const [key, value] of Object.entries(templateArgs)) {
    if (key in mergedTemplateArgs) {
      return invalid(`chat_template_kwargs conflicts with resolved reasoning control: ${key}`)
    }
    mergedTemplateArgs[key] = value
  }
  const mergedControls: NativeReasoningControls = {
    enable_thinking: controls.enable_thinking,
    template_args: mergedTemplateArgs,
  }

  return resolvedReasoning(
    effort,
    mergedControls,
    automaticBudget,
    explicitBudget,
    profile.template_fingerprint
  )
}

export const resolveInferenceRequest = (
  request: InferenceRequestReasoningIntent,
  profile: ReasoningProfile
): ResolvedInferenceRequest | ReasoningResolutionError => {
  const reconciled = reconcileReasoningEffort(request, profile)
  const reasoning = resolveReasoningIntent(reconciled.reasoning, profile)
  if ("_tag" in reasoning) return reasoning
  return mapInferenceRequestReasoning(reconciled, () => reasoning)
}

const BASIC_PROBE_MESSAGES: readonly ChatMessage[] = [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "Hello" },
]

const sha256Hex = (text: string): string =>
  `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`

const defaultCapabilities = (): TemplateCapabilities => ({
  string_content: true,
  typed_content: false,
  tools: false,
  tool_calls: false,
  parallel_tool_calls: false,
  system_role: true,
  preserve_reasoning: false,
  object_arguments: false,
  enable_thinking: false,
})

const noneReasoningProfile = (fingerprint: string): ReasoningProfile => ({
  default_effort: Option.some("none" as NormalizedReasoningEffort),
  mappings: [
    {
      effort: "none" as NormalizedReasoningEffort,
      controls: { enable_thinking: Option.some(false), template_args: {} },
      automatic_budget: { type: "disabled" },
    },
  ],
  template_fingerprint: fingerprint,
})

/**
 * Apply a simple role/content Jinja-like template for the common
 * `{% for message in messages %}{{ role }}: {{ content }}` pattern used in tests.
 * Falls back to concatenating messages when the template is unrecognized.
 */
export const applyBasicChatTemplate = (
  template: string,
  messages: readonly ChatMessage[],
  addAssistant = true
): string => {
  const trimmed = template.trim()
  if (trimmed.length === 0) {
    throw new Error("chat template must be a non-empty string")
  }
  // Named llama.cpp templates are handled by native applyChatTemplate.
  if (/^[a-z0-9_-]+$/i.test(trimmed) && !trimmed.includes("{")) {
    if (isNativeAvailable()) {
      return applyChatTemplate(messages, { template: trimmed, addAssistant })
    }
  }
  let out = ""
  for (const message of messages) {
    out += `${message.role}: ${message.content}\n`
  }
  if (addAssistant) {
    if (/<\|im_start\|>assistant/.test(template) || /chatml/i.test(template)) {
      out += "<|im_start|>assistant\n"
    } else {
      out += "assistant:"
    }
  }
  return out
}

/**
 * Inspect a raw chat template without loading model weights.
 *
 * Basic message templates never throw: they receive a fingerprint, string-content
 * capabilities, and a `none` reasoning profile. Named llama.cpp templates use
 * native `llama_chat_apply_template` when available.
 */
export const inspectTemplate = async (
  template: string,
  _bosToken?: string | null,
  _eosToken?: string | null
): Promise<TemplateInspection | TemplateInspectionError> => {
  if (typeof template !== "string" || template.trim().length === 0) {
    return { _tag: "InvalidTemplate", message: "chat template must be a non-empty string" }
  }
  let probePrompt: string | undefined
  try {
    probePrompt = applyBasicChatTemplate(template, BASIC_PROBE_MESSAGES, true)
  } catch (error) {
    return {
      _tag: "InvalidTemplate",
      message: error instanceof Error ? error.message : String(error),
    }
  }
  const fingerprint = sha256Hex(template)
  const enableThinking =
    template.includes("enable_thinking") ||
    template.includes("<think>") ||
    template.includes("reasoning_effort")
  const capabilities: TemplateCapabilities = {
    ...defaultCapabilities(),
    enable_thinking: enableThinking,
    system_role: template.includes("system") || template.includes("messages"),
  }
  const profile = noneReasoningProfile(fingerprint)
  const reasoning: ReasoningCapability = {
    type: "supported",
    control: {
      type: "effort",
      levels: ["none"],
      default: Option.some("none"),
    },
    visibility: "hidden",
    delimiters: { type: "unavailable" },
    evidence: { type: "bounded_template_probe", fingerprint },
  }
  return {
    templateFingerprint: fingerprint,
    capabilities,
    reasoning,
    profile,
    probePrompt,
  }
}

/**
 * Hardware-gated: inspect chat templates from a loaded model.
 *
 * Full template inspection requires native `CommonChatTemplates` via `@magnitudedev/icn-native`.
 */
export const inspectTemplateFromModel = async (): Promise<
  TemplateInspection | TemplateInspectionError
> => ({
  _tag: "NativeUnavailable",
  message:
    "inspectTemplateFromModel requires native CommonChatTemplates integration — not yet wired",
})
