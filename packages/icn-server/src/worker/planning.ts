import { readFileSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { PlannerBundle, loadReleaseCatalog } from "@magnitudedev/icn-models"
import {
  FIT_CALIBRATION_METHOD,
  type HardwareCalibration,
} from "@magnitudedev/icn-hardware"

const MAX_PLANNING_FRAME_BYTES = 1024 * 1024

export interface PlanningWorkerOptions {
  readonly installation?: string
  readonly developmentRuntime?: boolean
  readonly fake?: boolean
}

type PlanningWorkerCommand =
  | { readonly kind: "initialize"; readonly hardware_calibration?: HardwareCalibration }
  | { readonly kind: "assess"; readonly request: Record<string, unknown> }

type PlanningWorkerReply =
  | { readonly kind: "initialized"; readonly hardware_calibration: HardwareCalibration }
  | { readonly kind: "assessed"; readonly response: Record<string, unknown> }
  | { readonly kind: "defect"; readonly message: string }

const stubCalibration = (): HardwareCalibration => ({
  method: FIT_CALIBRATION_METHOD,
  elapsed_microseconds: 1,
  metrics: [{
    backend_type: 0,
    backend: "CPU",
    tensor_type: 0,
    routed: false,
    bytes_per_second: 1,
    launch_microseconds: 1,
    relative_spread: 0,
    sample_count: 1,
    measured_microseconds: 1,
    stable: true,
  }],
})

const resolvePlannerBundlePath = (installationDeclaration: string): string => {
  const root = dirname(installationDeclaration)
  return resolve(root, "catalog/model-planner-inputs.bundle")
}

export const loadPlannerBundleForInstallation = (
  installationDeclaration: string,
): PlannerBundle => {
  const path = resolvePlannerBundlePath(installationDeclaration)
  if (!existsSync(path)) {
    throw new Error(`planner bundle missing at ${path}`)
  }
  const bytes = new Uint8Array(readFileSync(path))
  const bundle = PlannerBundle.parse(bytes)
  // Ensure the release catalog loader accepts this installation's planner bundle.
  loadReleaseCatalog(path)
  return bundle
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const writePlanningFrame = async (
  stdout: WritableStream<Uint8Array>,
  reply: PlanningWorkerReply,
): Promise<void> => {
  const payload = new TextEncoder().encode(JSON.stringify(reply))
  if (payload.length > MAX_PLANNING_FRAME_BYTES) {
    throw new Error("planning response exceeds its frame bound")
  }
  const header = new Uint8Array(4)
  new DataView(header.buffer).setUint32(0, payload.length, true)
  const writer = stdout.getWriter()
  try {
    await writer.write(header)
    await writer.write(payload)
  } finally {
    writer.releaseLock()
  }
}

export const bufferPlanningFrame = (command: PlanningWorkerCommand): Uint8Array => {
  const payload = new TextEncoder().encode(JSON.stringify(command))
  const header = new Uint8Array(4)
  new DataView(header.buffer).setUint32(0, payload.length, true)
  return concat([header, payload])
}

export const parsePlanningFrame = <T>(bytes: Uint8Array): T => {
  const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true)
  return JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) as T
}

/**
 * Minimal planning-worker loop: validates a release planner bundle when installed,
 * then answers Initialize / Assess frames with stub calibration (full native
 * assessment remains hardware-gated).
 */
export const runPlanningWorker = async (
  stdin: ReadableStream<Uint8Array>,
  stdout: WritableStream<Uint8Array>,
  options: PlanningWorkerOptions,
): Promise<number> => {
  if (options.installation === undefined && options.developmentRuntime !== true) {
    console.error("planning-worker requires --installation or --development-runtime")
    return 2
  }

  let bundleDigests: readonly string[] = []
  if (options.installation !== undefined) {
    try {
      const bundle = loadPlannerBundleForInstallation(options.installation)
      bundleDigests = bundle.digests()
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "object" &&
              error !== null &&
              "message" in error &&
              typeof (error as { message: unknown }).message === "string"
            ? (error as { message: string }).message
            : "failed to load planner bundle"
      console.error(message)
      return 2
    }
  }

  let hardwareCalibration: HardwareCalibration | undefined
  const reader = stdin.getReader()
  const buffer: Uint8Array[] = []
  let closed = false

  const readExact = async (count: number): Promise<Uint8Array | null> => {
    while (!closed) {
      const available = buffer.reduce((sum, part) => sum + part.length, 0)
      if (available >= count) {
        const merged = concat(buffer)
        buffer.length = 0
        const exact = merged.subarray(0, count)
        const rest = merged.subarray(count)
        if (rest.length > 0) buffer.push(rest)
        return exact
      }
      const next = await reader.read()
      if (next.done) {
        closed = true
        if (available === 0) return null
        throw new Error("planning worker stdin ended mid-frame")
      }
      if (next.value !== undefined) buffer.push(next.value)
    }
    return null
  }

  try {
    while (true) {
      const lengthBytes = await readExact(4)
      if (lengthBytes === null) return 0
      const length = new DataView(
        lengthBytes.buffer,
        lengthBytes.byteOffset,
        4,
      ).getUint32(0, true)
      if (length > MAX_PLANNING_FRAME_BYTES) {
        throw new Error(`planning request exceeds its frame bound (${length})`)
      }
      const payload = await readExact(length)
      if (payload === null) throw new Error("planning worker frame payload truncated")
      const command = JSON.parse(new TextDecoder().decode(payload)) as PlanningWorkerCommand

      let reply: PlanningWorkerReply
      switch (command.kind) {
        case "initialize": {
          const established =
            command.hardware_calibration ?? hardwareCalibration ?? stubCalibration()
          hardwareCalibration = established
          reply = { kind: "initialized", hardware_calibration: established }
          break
        }
        case "assess": {
          if (hardwareCalibration === undefined) {
            reply = { kind: "defect", message: "planning worker was not initialized" }
            break
          }
          if (options.fake === true) {
            reply = {
              kind: "assessed",
              response: {
                capabilities: { modalities: ["text"], tools: false },
                template_capabilities: {},
                reasoning: { kind: "none" },
                template_fingerprint: `planner-bundle:${bundleDigests.length}`,
                assessments: [],
              },
            }
            break
          }
          reply = {
            kind: "defect",
            message:
              "native model assessment is not yet available in the TypeScript planning worker",
          }
          break
        }
        default:
          reply = { kind: "defect", message: "unknown planning worker command" }
      }
      await writePlanningFrame(stdout, reply)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    return 1
  } finally {
    reader.releaseLock()
  }
}

export const runPlanningWorkerProcess = async (
  options: PlanningWorkerOptions,
): Promise<number> => {
  const stdout = new WritableStream<Uint8Array>({
    write(chunk) {
      Bun.stdout.write(chunk)
    },
  })
  return runPlanningWorker(Bun.stdin.stream(), stdout, options)
}
