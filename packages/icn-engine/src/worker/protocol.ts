/**
 * Concurrency model (from design/inference/typescript-migration.md):
 *
 * - The persistent ICN process hosts HTTP and spawns one disposable worker per resident model.
 * - Inside each worker, one Bun `Worker` thread owns all FFI (`@magnitudedev/icn-native`).
 * - `llama_decode` blocks only that worker thread.
 * - Requests and results cross the thread boundary as structured messages.
 * - Token streams flow through `MessageChannel`.
 *
 * See `types.ts` for protocol shapes, `in-process.ts` for a same-thread FFI owner,
 * and `spawn.ts` for the Bun Worker-backed owner.
 */

export type {
  CompletionPayload,
  CompletionRequest,
  CompletionResult,
  InferenceSession,
  ModelLoadIntent,
  NativeSampleCommand,
  TokenStreamPorts,
  WorkerEvent,
  WorkerMainMessage,
  WorkerRequest,
  WorkerSpawnOptions,
} from "./types.js"

export { parseModelLoadIntent } from "./intent.js"
export { createInProcessInferenceSession } from "./in-process.js"
export { collectStream, spawnInferenceWorker } from "./spawn.js"

/** Type guard for token stream messages delivered over `MessagePort`. */
export const isWorkerTokenEvent = (
  event: MessageEvent
): event is MessageEvent<Extract<import("./types.js").WorkerEvent, { type: "token" }>> =>
  typeof event.data === "object" &&
  event.data !== null &&
  "type" in event.data &&
  (event.data as import("./types.js").WorkerEvent).type === "token"
