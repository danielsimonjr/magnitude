import { describe, expect, it } from "vitest"
import { bufferWorkerFrame, parseWorkerFrame } from "./ipc.js"
import { WORKER_PROTOCOL_VERSION, type WorkerHostMessage } from "./protocol.js"
import { runInferenceWorker } from "./runner.js"

describe("worker ipc", () => {
  it("round-trips length-prefixed frames", () => {
    const frame = bufferWorkerFrame(3, { Hello: { expected_build: "test" } })
    const parsed = parseWorkerFrame<WorkerHostMessage>(frame)
    expect(parsed.protocol_version).toBe(WORKER_PROTOCOL_VERSION)
    expect(parsed.generation).toBe(3)
    expect(parsed.message).toEqual({ Hello: { expected_build: "test" } })
  })

  it("runs a fake worker over in-memory streams", async () => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bufferWorkerFrame(1, { Hello: { expected_build: "test" } }))
        controller.enqueue(bufferWorkerFrame(1, { Shutdown: null }))
        controller.close()
      },
    })
    const outputChunks: Uint8Array[] = []
    const exitCode = await runInferenceWorker(
      input,
      new WritableStream<Uint8Array>({
        write(chunk) {
          outputChunks.push(chunk)
        },
      }),
      { fake: true },
    )
    expect(exitCode).toBe(0)

    const output = Uint8Array.from(outputChunks.flatMap((chunk) => [...chunk]))
    const hello = parseWorkerFrame(output.subarray(0, output.length))
    expect(hello.message).toHaveProperty("Hello")
  })

  it("exits with code 2 when neither fake nor local-engine is set", async () => {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    await writable.getWriter().close()
    const exitCode = await runInferenceWorker(readable, new WritableStream(), {})
    expect(exitCode).toBe(2)
  })
})
