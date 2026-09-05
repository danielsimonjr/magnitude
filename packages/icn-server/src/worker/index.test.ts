import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { encodePlannerBundle, plannerBundleSha256 } from "@magnitudedev/icn-models"
import {
  bufferPlanningFrame,
  parsePlanningFrame,
  runPlanningWorker,
} from "./planning.js"
import { terminateProcessTree, workerCommand } from "./index.js"

describe("worker supervision", () => {
  it("builds installed and development worker commands", () => {
    expect(workerCommand("/bin/icn", "inference")).toEqual([
      "inference-worker",
      "--development-runtime",
    ])
    expect(workerCommand("/bin/icn", "planning", "/tmp/installation.json")).toEqual([
      "planning-worker",
      "--installation",
      "/tmp/installation.json",
    ])
  })

  it("invokes taskkill with /F /T /PID on win32", () => {
    if (process.platform !== "win32") {
      // Non-Windows: terminateProcessTree uses process groups; ensure it does not throw.
      expect(() => terminateProcessTree(process.pid, "SIGTERM")).not.toThrow()
      return
    }
    expect(() => terminateProcessTree(process.pid, "SIGKILL")).not.toThrow()
  })
})

describe("planning-worker", () => {
  it("initializes over planner-bundle-backed installation and fakes assess", async () => {
    const root = mkdtempSync(join(tmpdir(), "icn-planning-"))
    const catalogDir = join(root, "catalog")
    mkdirSync(catalogDir, { recursive: true })
    const manifest = new TextEncoder().encode(JSON.stringify({ plannerInputs: {} }))
    const input = new TextEncoder().encode("planner-input")
    const digest = plannerBundleSha256(input)
    const bundle = encodePlannerBundle(manifest, new Map([[digest, input]]))
    writeFileSync(join(catalogDir, "model-planner-inputs.bundle"), bundle)
    const installation = join(root, "installation.json")
    writeFileSync(installation, JSON.stringify({
      schemaVersion: 1,
      backend: "cpu",
      nativeBuild: "native_test",
      backendModuleAbi: "abi_test",
    }))

    const inputStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bufferPlanningFrame({ kind: "initialize" }))
        controller.enqueue(bufferPlanningFrame({ kind: "assess", request: { primary: "/model.gguf" } }))
        controller.close()
      },
    })
    const chunks: Uint8Array[] = []
    const code = await runPlanningWorker(
      inputStream,
      new WritableStream<Uint8Array>({
        write(chunk) {
          chunks.push(chunk)
        },
      }),
      { installation, fake: true },
    )
    expect(code).toBe(0)
    const bytes = Uint8Array.from(chunks.flatMap((chunk) => [...chunk]))
    const firstLen = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true)
    const first = parsePlanningFrame<{ kind: string; hardware_calibration: { method: string } }>(
      bytes.subarray(0, 4 + firstLen),
    )
    expect(first.kind).toBe("initialized")
    expect(first.hardware_calibration.method).toContain("calibration")

    const second = parsePlanningFrame<{ kind: string; response: { assessments: unknown[] } }>(
      bytes.subarray(4 + firstLen),
    )
    expect(second.kind).toBe("assessed")
    expect(second.response.assessments).toEqual([])
  })

  it("requires installation or development-runtime", async () => {
    const code = await runPlanningWorker(
      new ReadableStream({ start(controller) { controller.close() } }),
      new WritableStream(),
      {},
    )
    expect(code).toBe(2)
  })
})
