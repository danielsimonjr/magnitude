import type { CommonSamplerConfig } from "../sampling/index.js"

/**
 * Concurrency model (from design/inference/typescript-migration.md):
 *
 * - The persistent ICN process hosts HTTP and spawns one disposable worker per resident model.
 * - Inside each worker, one Bun `Worker` thread owns all FFI (`@magnitudedev/icn-native`).
 * - `llama_decode` blocks only that worker thread.
 * - Requests and results cross the thread boundary as structured messages.
 * - Token streams flow through `MessageChannel`.
 *
 * This module defines the message protocol. Full worker isolation is stubbed until native
 * integration lands; the in-process scheduler uses the same shapes.
 */

export type WorkerRequest =
  | { readonly type: "load_model"; readonly executionIntent: unknown }
  | { readonly type: "complete"; readonly requestId: string; readonly payload: unknown }
  | { readonly type: "cancel"; readonly requestId: string }
  | { readonly type: "shutdown" }

export type WorkerEvent =
  | { readonly type: "loaded" }
  | { readonly type: "admitted"; readonly requestId: string; readonly queuePosition: number }
  | { readonly type: "observation"; readonly requestId: string; readonly payload: unknown }
  | { readonly type: "token"; readonly requestId: string; readonly token: number }
  | { readonly type: "completed"; readonly requestId: string; readonly payload: unknown }
  | { readonly type: "failed"; readonly requestId: string; readonly reason: string }

export interface TokenStreamPorts {
  readonly events: MessagePort
  readonly control: MessagePort
}

export interface WorkerSpawnOptions {
  readonly executionIntent: unknown
}

/**
 * TODO: spawn a dedicated Bun Worker that owns FFI and exposes `MessageChannel` token streams.
 */
export const spawnInferenceWorker = (_options: WorkerSpawnOptions): never => {
  throw new Error(
    "spawnInferenceWorker is not yet implemented — use the in-process scheduler for now"
  )
}

/** Type guard for token stream messages delivered over `MessagePort`. */
export const isWorkerTokenEvent = (
  event: MessageEvent
): event is MessageEvent<Extract<WorkerEvent, { type: "token" }>> =>
  typeof event.data === "object" &&
  event.data !== null &&
  "type" in event.data &&
  (event.data as WorkerEvent).type === "token"

/** Placeholder for wiring sampler config into the worker-owned native context. */
export type NativeSampleCommand = {
  readonly requestId: string
  readonly batchIndex: number
  readonly config: CommonSamplerConfig
}
