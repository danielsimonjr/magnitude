export const WORKER_PROTOCOL_VERSION = 4
export const WORKER_MAX_FRAME_BYTES = 48 * 1024 * 1024

export interface WorkerFrame<T> {
  readonly protocol_version: number
  readonly generation: number
  readonly message: T
}

/** Serde-compatible externally tagged host messages (matches Rust inference_worker.rs). */
export type WorkerHostMessage =
  | { Hello: { expected_build: string } }
  | { Load: Record<string, unknown> }
  | { Infer: { request_id: number } & Record<string, unknown> }
  | { ApplyTemplate: { request_id: number } & Record<string, unknown> }
  | { CountTokens: { request_id: number } & Record<string, unknown> }
  | { ObserveModelInstance: { request_id: number } & Record<string, unknown> }
  | { Cancel: { request_id: number } }
  | { Shutdown: null }

export type WorkerReplyMessage =
  | { Hello: { build: string } }
  | { Prepared: Record<string, unknown> }
  | { LoadPhase: Record<string, unknown> }
  | { Loaded: { properties: Record<string, unknown> } }
  | { LoadFailed: { message: string } }
  | { Admitted: { request_id: number; queue_position: number } }
  | { Observation: { request_id: number } & Record<string, unknown> }
  | { Completed: { request_id: number } & Record<string, unknown> }
  | { Failed: { request_id: number; message: string } }
  | { Token: { request_id: number; token: number } }
  | { Pong: { request_id: number } }
  | { ShutdownAck: null }

export const workerHostMessageTag = (message: WorkerHostMessage): string => Object.keys(message)[0]!

export const workerReplyMessageTag = (message: WorkerReplyMessage): string => Object.keys(message)[0]!
