import { Context, Model } from "@magnitudedev/icn-native"
import { bindSamplingContext, unbindSamplingContext } from "../sampling/context-binding.js"
import type {
  CompletionPayload,
  ModelLoadIntent,
  WorkerEvent,
} from "./types.js"

export interface NativeSessionState {
  readonly model: Model
  readonly context: Context
}

export const loadNativeSession = (intent: ModelLoadIntent): NativeSessionState => {
  const model = Model.load(intent.modelPath, { nGpuLayers: intent.nGpuLayers ?? 0 })
  const context = new Context(model, {
    nCtx: intent.nCtx ?? 2048,
    nBatch: intent.nBatch ?? 512,
    nThreads: intent.nThreads ?? 0,
  })
  bindSamplingContext(context)
  return { model, context }
}

export const releaseNativeSession = (state: NativeSessionState | undefined): void => {
  if (state === undefined) return
  unbindSamplingContext()
  state.context.free()
  state.model.free()
}

export async function* runCompletion(
  state: NativeSessionState,
  requestId: string,
  payload: CompletionPayload,
  signal?: AbortSignal
): AsyncGenerator<WorkerEvent> {
  yield { type: "admitted", requestId, queuePosition: 0 }
  state.context.reset()
  const tokens: number[] = []
  let text = ""
  try {
    for await (const piece of state.context.generate(payload.prompt, payload.maxTokens)) {
      if (signal?.aborted) {
        yield { type: "failed", requestId, reason: "cancelled" }
        return
      }
      if (piece.token >= 0) {
        tokens.push(piece.token)
        yield { type: "token", requestId, token: piece.token }
      }
      text += piece.text
    }
    yield { type: "completed", requestId, payload: { tokens, text } }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    yield { type: "failed", requestId, reason }
  }
}
