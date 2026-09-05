import { Worker } from "node:worker_threads"
import { emitProgressLine, emitReadyLine, writeBootstrapLine } from "./bootstrap.js"
import { nativeBuild, PACKAGE_VERSION } from "./build-identity.js"
import type { ServeConfig, ServerIdentity } from "./config.js"
import { validateServeConfig } from "./config.js"
import { defaultFakeBackend } from "./fake-backend.js"
import { createHttpHandler } from "./http/router.js"
import { MemorySupervisor } from "./memory-supervisor.js"
import { createServerServicesFromConfig, type ServerServices } from "./services.js"
import { WorkerSupervisor } from "./worker/index.js"

export interface RunningServer {
  readonly origin: string
  readonly identity: ServerIdentity
  readonly memorySupervisor: MemorySupervisor
  readonly workerSupervisor: WorkerSupervisor
  readonly services: ServerServices
  stop(): Promise<void>
}

/**
 * Exit when the managed parent closes the private stdin pipe.
 * Bun's Node-compat `readable`/`read()===null` does not observe pipe EOF, and
 * draining `Bun.stdin.stream()` on the main thread can starve startup. Bun
 * `--compile` also does not embed `new Worker(new URL(...))` modules, so the
 * guard is an eval worker with an inlined blocking read on fd 0.
 */
const STDIN_EOF_WORKER_SOURCE = `
const { readSync } = require("node:fs");
const { parentPort } = require("node:worker_threads");
const buffer = Buffer.alloc(1);
try {
  for (;;) {
    const bytesRead = readSync(0, buffer, 0, 1, null);
    if (bytesRead === 0) break;
  }
} catch {
  // Closed or unreadable stdin is treated as parent loss.
}
parentPort.postMessage("eof");
`

const installStdinEofGuard = (): (() => void) => {
  let active = true
  const worker = new Worker(STDIN_EOF_WORKER_SOURCE, { eval: true })
  const exit = () => {
    if (!active) return
    active = false
    process.exit(0)
  }
  worker.on("message", exit)
  // Do not exit on worker launch errors — that would kill a healthy server if
  // the runtime cannot spawn threads; pipe EOF is the only shutdown signal.
  worker.on("error", (error) => {
    console.error("stdin EOF guard worker error:", error)
  })
  return () => {
    active = false
    void worker.terminate()
  }
}

export const startServer = async (config: ServeConfig): Promise<RunningServer> => {
  validateServeConfig(config)
  const memorySupervisor = new MemorySupervisor()
  const workerSupervisor = new WorkerSupervisor()
  const identity: ServerIdentity = {
    instanceId: config.instanceId,
    apiVersion: 1,
    nativeBuild: nativeBuild(),
  }
  const fakeBackend = config.fake ? defaultFakeBackend() : undefined
  const removeStdinGuard = config.exitOnStdinEof ? installStdinEofGuard() : undefined
  const services = await createServerServicesFromConfig(config)

  if (config.installation !== undefined) {
    writeBootstrapLine(
      emitProgressLine({
        type: "cpu",
        hardwareLabel: "TypeScript ICN CPU backend",
      }),
    )
  }

  let server: ReturnType<typeof Bun.serve> | undefined
  const handler = createHttpHandler({
    identity,
    authorization: config.authToken,
    fakeBackend,
    services,
  })

  server = Bun.serve({
    hostname: config.bindHost,
    port: config.bindPort,
    fetch: handler,
  })

  const origin = `http://${server.hostname}:${server.port}`
  writeBootstrapLine(
    emitReadyLine({
      origin,
      instanceId: identity.instanceId,
      pid: process.pid,
    }),
  )

  return {
    origin,
    identity,
    memorySupervisor,
    workerSupervisor,
    services,
    stop: async () => {
      removeStdinGuard?.()
      await workerSupervisor.shutdownAll()
      server?.stop(true)
    },
  }
}

export const serverVersionText = (): string => PACKAGE_VERSION
