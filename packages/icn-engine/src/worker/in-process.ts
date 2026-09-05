import { parseModelLoadIntent } from "./intent.js"
import {
  loadNativeSession,
  releaseNativeSession,
  runCompletion,
  type NativeSessionState,
} from "./session-core.js"
import type {
  CompletionRequest,
  InferenceSession,
  TokenStreamPorts,
  WorkerEvent,
  WorkerSpawnOptions,
} from "./types.js"

const pumpEvents = async (
  eventsPort: MessagePort,
  events: AsyncGenerator<WorkerEvent>
): Promise<void> => {
  for await (const event of events) {
    eventsPort.postMessage(event)
  }
}

/**
 * In-process FFI owner using the same protocol types as `spawnInferenceWorker`.
 *
 * Useful when Bun Worker + FFI is unavailable or flaky (e.g. some CI hosts).
 * All native calls run on the caller's thread.
 */
export const createInProcessInferenceSession = (
  options: WorkerSpawnOptions
): InferenceSession => {
  const intent = parseModelLoadIntent(options.executionIntent)
  const abortControllers = new Map<string, AbortController>()
  let state: NativeSessionState | undefined = loadNativeSession(intent)
  const ready = Promise.resolve()

  const requireState = (): NativeSessionState => {
    if (state === undefined) throw new Error("inference session has been shut down")
    return state
  }

  const cancel = (requestId: string): void => {
    abortControllers.get(requestId)?.abort()
  }

  const complete = (request: CompletionRequest): TokenStreamPorts => {
    const eventsChannel = new MessageChannel()
    const controlChannel = new MessageChannel()
    const controller = new AbortController()
    abortControllers.set(request.requestId, controller)

    controlChannel.port1.onmessage = (event: MessageEvent) => {
      if (
        typeof event.data === "object" &&
        event.data !== null &&
        "type" in event.data &&
        (event.data as { type?: string }).type === "cancel"
      ) {
        cancel(request.requestId)
      }
    }

    void pumpEvents(
      eventsChannel.port1,
      runCompletion(
        requireState(),
        request.requestId,
        { prompt: request.prompt, maxTokens: request.maxTokens },
        controller.signal
      )
    ).finally(() => {
      abortControllers.delete(request.requestId)
    })

    return { events: eventsChannel.port2, control: controlChannel.port2 }
  }

  return {
    ready,
    complete,
    cancel,
    shutdown: async () => {
      for (const controller of abortControllers.values()) controller.abort()
      abortControllers.clear()
      releaseNativeSession(state)
      state = undefined
    },
  }
}
