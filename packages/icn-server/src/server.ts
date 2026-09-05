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

const installStdinEofGuard = (): (() => void) | undefined => {
  if (!process.stdin.readable) return undefined
  const onReadable = () => {
    const chunk = process.stdin.read()
    if (chunk === null) {
      process.exit(0)
    }
  }
  process.stdin.on("readable", onReadable)
  return () => {
    process.stdin.off("readable", onReadable)
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
