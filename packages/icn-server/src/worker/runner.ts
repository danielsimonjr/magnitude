import { nativeBuild } from "../build-identity.js"
import { parseWorkerFrame, writeWorkerFrame } from "./ipc.js"
import {
  workerHostMessageTag,
  type WorkerHostMessage,
  type WorkerReplyMessage,
} from "./protocol.js"

export interface InferenceWorkerOptions {
  readonly fake?: boolean
  readonly localEngine?: boolean
}

const localEngineLoaded = async (): Promise<boolean> => {
  try {
    await import("@magnitudedev/icn-engine")
    return true
  } catch {
    return false
  }
}

const reply = async (
  stdout: WritableStream<Uint8Array>,
  generation: number,
  message: WorkerReplyMessage,
): Promise<void> => {
  await writeWorkerFrame(stdout, generation, message)
}

const handleHostMessage = async (
  stdout: WritableStream<Uint8Array>,
  generation: number,
  message: WorkerHostMessage,
  options: InferenceWorkerOptions,
): Promise<"continue" | "shutdown"> => {
  const tag = workerHostMessageTag(message)
  switch (tag) {
    case "Hello": {
      await reply(stdout, generation, { Hello: { build: nativeBuild() } })
      return "continue"
    }
    case "Load": {
      if (options.localEngine) {
        const loaded = await localEngineLoaded()
        if (!loaded) {
          await reply(stdout, generation, { LoadFailed: { message: "icn-engine is unavailable" } })
          return "continue"
        }
      }
      await reply(stdout, generation, {
        Loaded: {
          properties: {
            architecture: options.localEngine ? "local-engine" : "fake",
            format: "gguf",
          },
        },
      })
      return "continue"
    }
    case "Infer": {
      const requestId = "Infer" in message ? message.Infer.request_id : 0
      if (options.fake || options.localEngine) {
        await reply(stdout, generation, { Admitted: { request_id: requestId, queue_position: 0 } })
        await reply(stdout, generation, {
          Completed: {
            request_id: requestId,
            completion: {
              text: "Hello from ICN worker.",
              termination: { _tag: "Stop" },
            },
          },
        })
      }
      return "continue"
    }
    case "CountTokens": {
      const requestId = "CountTokens" in message ? message.CountTokens.request_id : 0
      await reply(stdout, generation, { Completed: { request_id: requestId, token_count: 1 } })
      return "continue"
    }
    case "Cancel":
      return "continue"
    case "Shutdown":
      await reply(stdout, generation, { ShutdownAck: null })
      return "shutdown"
    default:
      if (options.fake) {
        await reply(stdout, generation, { Pong: { request_id: 0 } })
      }
      return "continue"
  }
}

export const runInferenceWorker = async (
  stdin: ReadableStream<Uint8Array>,
  stdout: WritableStream<Uint8Array>,
  options: InferenceWorkerOptions,
): Promise<number> => {
  if (!options.fake && !options.localEngine) {
    console.error("inference-worker requires --fake or --local-engine in the TypeScript ICN server")
    return 2
  }

  let generation = 1
  const chunks: Uint8Array[] = []
  const reader = stdin.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (value !== undefined) {
        chunks.push(value)
      }
      const buffer = chunks.length === 1 ? chunks[0]! : Uint8Array.from(chunks.flatMap((chunk) => [...chunk]))
      if (buffer.length < 4) {
        continue
      }
      const length = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0, false)
      if (buffer.length < 4 + length) {
        continue
      }
      const frame = parseWorkerFrame<WorkerHostMessage>(buffer.subarray(0, 4 + length))
      generation = frame.generation
      const action = await handleHostMessage(stdout, generation, frame.message, options)
      const remaining = buffer.subarray(4 + length)
      chunks.length = 0
      if (remaining.length > 0) {
        chunks.push(remaining)
      }
      if (action === "shutdown") {
        return 0
      }
    }
  } finally {
    reader.releaseLock()
  }
  return 0
}

export const runInferenceWorkerProcess = async (options: InferenceWorkerOptions): Promise<number> => {
  const stdout = new WritableStream<Uint8Array>({
    write(chunk) {
      Bun.stdout.write(chunk)
    },
  })
  return runInferenceWorker(Bun.stdin.stream(), stdout, options)
}
