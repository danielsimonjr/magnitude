/**
 * CPU-verifiable generation through the engine worker protocol.
 *
 * Gated on `MAGNITUDE_TEST_GGUF` and a built `@magnitudedev/icn-native` install,
 * matching `packages/icn-native/src/integration.test.ts`.
 *
 *   MAGNITUDE_TEST_GGUF=/path/to/model.gguf bunx --bun vitest run src/worker/integration.test.ts
 */
import { describe, expect, it } from "vitest"
import { collectStream, createInProcessInferenceSession, spawnInferenceWorker } from "./index.js"
import { defaultTestLoadIntent, nativeIntegrationEnabled } from "./test-support.js"

const runGreedyCompletion = async (
  session: ReturnType<typeof createInProcessInferenceSession>,
  requestId: string
) => {
  await session.ready
  const { events } = session.complete({
    requestId,
    prompt: "Hello",
    maxTokens: 8,
  })
  const stream = collectStream(events, requestId)
  const workerEvents = await stream
  await session.shutdown()
  return workerEvents
}

describe.skipIf(!nativeIntegrationEnabled())("inference session integration", () => {
  const intent = defaultTestLoadIntent()

  it("generates tokens in-process", async () => {
    const events = await runGreedyCompletion(
      createInProcessInferenceSession({ executionIntent: intent }),
      "in-proc-1"
    )

    const tokens = events.filter((e) => e.type === "token")
    const completed = events.find((e) => e.type === "completed")
    expect(tokens.length).toBeGreaterThan(0)
    expect(tokens.length).toBeLessThanOrEqual(8)
    expect(completed?.type).toBe("completed")
    if (completed?.type === "completed") {
      expect(completed.payload.tokens.length).toBe(tokens.length)
      expect(completed.payload.text.length).toBeGreaterThan(0)
    }
  })

  it("generates tokens through a Bun Worker FFI owner", async () => {
    const session = spawnInferenceWorker({ executionIntent: intent })
    const events = await runGreedyCompletion(session, "worker-1")

    const tokens = events.filter((e) => e.type === "token")
    const completed = events.find((e) => e.type === "completed")
    expect(tokens.length).toBeGreaterThan(0)
    expect(completed?.type).toBe("completed")
  })

  it("greedy decoding is deterministic in-process", async () => {
    const first = await runGreedyCompletion(
      createInProcessInferenceSession({ executionIntent: intent }),
      "det-1"
    )
    const second = await runGreedyCompletion(
      createInProcessInferenceSession({ executionIntent: intent }),
      "det-2"
    )
    const tokenIds = (events: typeof first) =>
      events.filter((e) => e.type === "token").map((e) => (e.type === "token" ? e.token : -1))
    expect(tokenIds(first)).toEqual(tokenIds(second))
  })
})
