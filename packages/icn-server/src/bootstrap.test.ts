import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { IcnStartupProgressRecord, IcnStartupRecord } from "@magnitudedev/icn-protocol"
import { emitProgressLine, emitReadyLine } from "./bootstrap.js"

describe("bootstrap records", () => {
  it("emits progress and ready records on stdout protocol lines", () => {
    const progress = emitProgressLine({
      type: "cpu",
      hardwareLabel: "CPU",
    })
    expect(progress.startsWith("MAGNITUDE_ICN_PROGRESS ")).toBe(true)
    const progressRecord = Schema.decodeUnknownSync(
      Schema.parseJson(IcnStartupProgressRecord),
    )(progress.slice("MAGNITUDE_ICN_PROGRESS ".length))
    expect(progressRecord.type).toBe("preparing_backend")
    expect(progressRecord.backend.type).toBe("cpu")

    const ready = emitReadyLine({
      origin: "http://127.0.0.1:8080",
      instanceId: "instance",
      pid: 42,
    })
    expect(ready.startsWith("MAGNITUDE_ICN_READY ")).toBe(true)
    const readyRecord = Schema.decodeUnknownSync(
      Schema.parseJson(IcnStartupRecord),
    )(ready.slice("MAGNITUDE_ICN_READY ".length))
    expect(readyRecord.type).toBe("icn_ready")
    expect(readyRecord.instanceId).toBe("instance")
    expect(readyRecord.pid).toBe(42)
    expect(readyRecord.protocolVersion).toBe(1)
  })
})
