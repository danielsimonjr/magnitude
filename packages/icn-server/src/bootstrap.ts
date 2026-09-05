import { Schema } from "effect"
import {
  IcnStartupProgressRecord,
  IcnStartupRecord,
  type IcnStartupBackend,
} from "@magnitudedev/icn-protocol"
import { API_VERSION, nativeBuild } from "./build-identity.js"

const encodeProgress = Schema.encodeSync(Schema.parseJson(IcnStartupProgressRecord))
const encodeReady = Schema.encodeSync(Schema.parseJson(IcnStartupRecord))

export const emitProgressLine = (backend: IcnStartupBackend): string =>
  `MAGNITUDE_ICN_PROGRESS ${encodeProgress({
    type: "preparing_backend",
    backend,
  })}`

export const emitReadyLine = (input: {
  origin: string
  instanceId: string
  pid: number
}): string =>
  `MAGNITUDE_ICN_READY ${encodeReady({
    type: "icn_ready",
    protocolVersion: 1,
    origin: input.origin,
    instanceId: input.instanceId,
    pid: input.pid,
    apiVersion: API_VERSION,
    nativeBuild: nativeBuild(),
  })}`

export const writeBootstrapLine = (line: string): void => {
  process.stdout.write(`${line}\n`)
}
