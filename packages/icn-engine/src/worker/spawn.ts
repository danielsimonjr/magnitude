import { parseModelLoadIntent } from "./intent.js"
import type {
  CompletionRequest,
  InferenceSession,
  TokenStreamPorts,
  WorkerEvent,
  WorkerMainMessage,
  WorkerSpawnOptions,
} from "./types.js"

const waitForWorkerEvent = (
  worker: Worker,
  type: WorkerEvent["type"]
): Promise<WorkerEvent> =>
  new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<WorkerEvent>) => {
      if (event.data.type === type) {
        worker.removeEventListener("message", onMessage)
        worker.removeEventListener("error", onError)
        resolve(event.data)
      }
    }
    const onError = (error: ErrorEvent) => {
      worker.removeEventListener("message", onMessage)
      worker.removeEventListener("error", onError)
      reject(error.error ?? new Error(error.message))
    }
    worker.addEventListener("message", onMessage)
    worker.addEventListener("error", onError)
  })

const collectStream = (
  eventsPort: MessagePort,
  requestId: string
): Promise<WorkerEvent[]> =>
  new Promise((resolve, reject) => {
    const collected: WorkerEvent[] = []
    eventsPort.onmessage = (event: MessageEvent<WorkerEvent>) => {
      const data = event.data
      if (data.type !== "loaded" && data.requestId !== requestId) return
      collected.push(data)
      if (data.type === "completed" || data.type === "failed") {
        eventsPort.close()
        resolve(collected)
      }
    }
    eventsPort.onmessageerror = () => {
      reject(new Error("token stream MessagePort error"))
    }
  })

/**
 * Spawn a dedicated Bun Worker that owns FFI and exposes per-request
 * `MessageChannel` token streams.
 */
export const spawnInferenceWorker = (options: WorkerSpawnOptions): InferenceSession => {
  const intent = parseModelLoadIntent(options.executionIntent)
  const worker = new Worker(new URL("./inference-worker-entry.ts", import.meta.url), {
    type: "module",
  })
  const ready = waitForWorkerEvent(worker, "loaded").then(() => undefined)
  worker.postMessage({ type: "init", executionIntent: intent } satisfies WorkerMainMessage)

  const cancel = (requestId: string): void => {
    worker.postMessage({ type: "cancel", requestId } satisfies WorkerMainMessage)
  }

  const complete = (request: CompletionRequest): TokenStreamPorts => {
    const eventsChannel = new MessageChannel()
    const controlChannel = new MessageChannel()

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

    worker.postMessage(
      {
        type: "complete",
        requestId: request.requestId,
        payload: { prompt: request.prompt, maxTokens: request.maxTokens },
      } satisfies WorkerMainMessage,
      [eventsChannel.port1]
    )

    return { events: eventsChannel.port2, control: controlChannel.port2 }
  }

  return {
    ready,
    complete,
    cancel,
    shutdown: async () => {
      worker.postMessage({ type: "shutdown" } satisfies WorkerMainMessage)
      try {
        worker.terminate()
      } catch {
        // already terminated
      }
    },
  }
}

export { collectStream }
