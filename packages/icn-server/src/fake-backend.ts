import type { ChatCompletionRequest, ChatCompletionResponse } from "@magnitudedev/icn-protocol"
import { Option } from "effect"

export interface FakeBackendConfig {
  readonly modelId: string
  readonly response: string
  readonly contextTokens?: number
}

export class FakeBackend {
  readonly modelId: string
  readonly response: string
  readonly contextTokens: number

  constructor(config: FakeBackendConfig) {
    this.modelId = config.modelId
    this.response = config.response
    this.contextTokens = config.contextTokens ?? 4096
  }

  acceptsModel(model: Option.Option<string>): boolean {
    return Option.getOrElse(model, () => "") === this.modelId
  }

  complete(request: ChatCompletionRequest): ChatCompletionResponse {
    const promptTokens = request.messages.length
    const completionTokens = Math.max(1, this.response.split(/\s+/).length)
    const model = Option.getOrElse(request.model, () => this.modelId)
    return {
      id: `chatcmpl-fake-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: Option.some(this.response),
            reasoning_content: Option.none(),
            tool_calls: Option.none(),
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: {
          cached_tokens: 0,
        },
      },
      timings: {
        cache_n: 0,
        draft_n: Option.none(),
        draft_n_accepted: Option.none(),
        parser_ms: 0,
        prompt_n: promptTokens,
        prompt_ms: 0,
        prompt_per_token_ms: 0,
        prompt_per_second: 0,
        predicted_n: completionTokens,
        predicted_ms: 0,
        predicted_per_token_ms: 0,
        predicted_per_second: 0,
        sampler_ms: 0,
        time_to_first_token_ms: 0,
      },
    }
  }

  streamEvents(request: ChatCompletionRequest): ReadonlyArray<string> {
    const completion = this.complete(request)
    const choice = completion.choices[0]!
    const chunkBase = {
      id: completion.id,
      object: "chat.completion.chunk",
      created: completion.created,
      model: completion.model,
    }
    const content = Option.getOrElse(choice.message.content, () => "")
    return [
      `data: ${JSON.stringify({
        ...chunkBase,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        ...chunkBase,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        ...chunkBase,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]
  }

  modelsListEntry() {
    return {
      id: this.modelId,
      object: "model",
      created: 0,
      owned_by: "magnitude",
      name: this.modelId,
      description: "Fake ICN backend for lifecycle tests",
      context_length: this.contextTokens,
      architecture: {
        input_modalities: ["text"],
        output_modalities: ["text"],
      },
      reasoning: null,
      top_provider: {
        context_length: this.contextTokens,
        max_completion_tokens: Math.min(this.contextTokens, 32_768),
      },
      supported_parameters: ["temperature", "max_tokens"],
    }
  }
}

export const defaultFakeBackend = (): FakeBackend =>
  new FakeBackend({
    modelId: "icn-fake",
    response: "Hello from ICN.",
  })
