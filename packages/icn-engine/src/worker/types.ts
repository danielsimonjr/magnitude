import type { CommonSamplerConfig } from "../sampling/index.js"

/** Resident model load parameters passed to the inference worker FFI owner. */
export interface ModelLoadIntent {
  readonly modelPath: string
  readonly nCtx?: number
  readonly nBatch?: number
  readonly nThreads?: number
  readonly nGpuLayers?: number
}

export interface CompletionPayload {
  readonly prompt: string
  readonly maxTokens: number
}

export interface CompletionResult {
  readonly tokens: readonly number[]
  readonly text: string
}

export type WorkerRequest =
  | { readonly type: "load_model"; readonly executionIntent: ModelLoadIntent }
  | {
      readonly type: "complete"
      readonly requestId: string
      readonly payload: CompletionPayload
    }
  | { readonly type: "cancel"; readonly requestId: string }
  | { readonly type: "shutdown" }

export type WorkerEvent =
  | { readonly type: "loaded" }
  | { readonly type: "admitted"; readonly requestId: string; readonly queuePosition: number }
  | { readonly type: "observation"; readonly requestId: string; readonly payload: unknown }
  | { readonly type: "token"; readonly requestId: string; readonly token: number }
  | {
      readonly type: "completed"
      readonly requestId: string
      readonly payload: CompletionResult
    }
  | { readonly type: "failed"; readonly requestId: string; readonly reason: string }

export interface TokenStreamPorts {
  readonly events: MessagePort
  readonly control: MessagePort
}

export interface WorkerSpawnOptions {
  readonly executionIntent: ModelLoadIntent
}

export interface CompletionRequest {
  readonly requestId: string
  readonly prompt: string
  readonly maxTokens: number
}

/** Session surface shared by in-process and Worker-backed FFI owners. */
export interface InferenceSession {
  readonly ready: Promise<void>
  complete(request: CompletionRequest): TokenStreamPorts
  cancel(requestId: string): void
  shutdown(): Promise<void>
}

/** Placeholder for wiring sampler config into the worker-owned native context. */
export type NativeSampleCommand = {
  readonly requestId: string
  readonly batchIndex: number
  readonly config: CommonSamplerConfig
}

/** Messages posted from the parent thread to the Bun inference worker. */
export type WorkerMainMessage =
  | { readonly type: "init"; readonly executionIntent: ModelLoadIntent }
  | {
      readonly type: "complete"
      readonly requestId: string
      readonly payload: CompletionPayload
    }
  | { readonly type: "cancel"; readonly requestId: string }
  | { readonly type: "shutdown" }
