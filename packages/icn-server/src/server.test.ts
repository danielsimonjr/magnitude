import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { HealthResponse, IcnStartupRecord } from "@magnitudedev/icn-protocol"
import { startServer } from "./server.js"

describe("icn-server http integration", () => {
  it("starts in fake mode, emits bootstrap, and serves health and chat", async () => {
    const lines: Array<string> = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk))
      return true
    }) as typeof process.stdout.write

    const server = await startServer({
      bindHost: "127.0.0.1",
      bindPort: 0,
      instanceId: "test-instance",
      exitOnStdinEof: false,
      authToken: "test-token",
      fake: true,
      hfCaches: [],
      installation: "/tmp/installation.json",
    })

    try {
      const readyLine = lines.find((line) => line.includes("MAGNITUDE_ICN_READY"))
      expect(readyLine).toBeDefined()
      const ready = Schema.decodeUnknownSync(
        Schema.parseJson(IcnStartupRecord),
      )(readyLine!.trim().slice("MAGNITUDE_ICN_READY ".length))
      expect(ready.origin).toBe(server.origin)
      expect(ready.instanceId).toBe("test-instance")

      const health = await fetch(`${server.origin}/health`)
      expect(health.status).toBe(200)
      const healthBody = Schema.decodeUnknownSync(Schema.parseJson(HealthResponse))(
        await health.text(),
      )
      expect(healthBody.ready).toBe(true)
      expect(healthBody.instanceId).toBe("test-instance")

      const unauthorized = await fetch(`${server.origin}/v1/models`)
      expect(unauthorized.status).toBe(401)

      const models = await fetch(`${server.origin}/v1/models`, {
        headers: { authorization: "Bearer test-token" },
      })
      expect(models.status).toBe(200)
      const modelsBody = await models.json() as { data: Array<{ id: string }> }
      expect(modelsBody.data[0]?.id).toBe("icn-fake")

      const chat = await fetch(`${server.origin}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "icn-fake",
          messages: [{ role: "user", content: "hello" }],
        }),
      })
      expect(chat.status).toBe(200)
      const chatBody = await chat.json() as { choices: Array<{ message: { content: string } }> }
      expect(chatBody.choices[0]?.message.content).toBe("Hello from ICN.")
    } finally {
      process.stdout.write = originalWrite
      await server.stop()
    }
  })
})
