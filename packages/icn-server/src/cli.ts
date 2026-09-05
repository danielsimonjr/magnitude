import { parseArgs } from "node:util"
import { Schema } from "effect"
import { BackendEligibilityReport, IcnBinaryIdentity } from "@magnitudedev/icn-protocol"
import { probeBackendEligibility } from "./backend-eligibility.js"
import { binaryIdentity } from "./build-identity.js"
import { resolveAuthToken, type ServeConfig } from "./config.js"
import { startServer } from "./server.js"

const encodeIdentity = Schema.encodeSync(Schema.parseJson(IcnBinaryIdentity))
const encodeEligibility = Schema.encodeSync(Schema.parseJson(BackendEligibilityReport))

const parseBind = (value: string): { host: string; port: number } => {
  if (value.startsWith("[")) {
    const close = value.indexOf("]")
    if (close < 0) throw new Error(`invalid bind address: ${value}`)
    return {
      host: value.slice(1, close),
      port: Number(value.slice(close + 2)),
    }
  }
  const lastColon = value.lastIndexOf(":")
  if (lastColon <= 0) throw new Error(`invalid bind address: ${value}`)
  return {
    host: value.slice(0, lastColon),
    port: Number(value.slice(lastColon + 1)),
  }
}

const parseServeConfig = (values: Record<string, string | boolean | Array<string>>): ServeConfig => {
  const bind = parseBind(String(values.bind ?? "127.0.0.1:8080"))
  const hfCaches = values["hf-cache"]
  return {
    bindHost: bind.host,
    bindPort: bind.port,
    instanceId: String(values["instance-id"] ?? "standalone"),
    exitOnStdinEof: values["exit-on-stdin-eof"] === true,
    authToken: resolveAuthToken(
      typeof values["auth-token"] === "string" ? values["auth-token"] : undefined,
    ),
    fake: values.fake === true,
    modelStore: typeof values["model-store"] === "string" ? values["model-store"] : undefined,
    cacheRoot: typeof values["cache-root"] === "string" ? values["cache-root"] : undefined,
    hfCaches: Array.isArray(hfCaches)
      ? hfCaches.map(String)
      : typeof hfCaches === "string"
        ? [hfCaches]
        : [],
    installation:
      typeof values.installation === "string" ? values.installation : undefined,
  }
}

export const runCli = async (argv: ReadonlyArray<string>): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      bind: { type: "string" },
      "instance-id": { type: "string" },
      "exit-on-stdin-eof": { type: "boolean" },
      "auth-token": { type: "string" },
      fake: { type: "boolean" },
      "model-store": { type: "string" },
      "cache-root": { type: "string" },
      "hf-cache": { type: "string", multiple: true },
      installation: { type: "string" },
      json: { type: "boolean" },
    },
  })

  const command = positionals[0] ?? "serve"
  switch (command) {
    case "serve": {
      const config = parseServeConfig(values)
      const running = await startServer(config)
      await new Promise<void>((resolve) => {
        const shutdown = async () => {
          await running.stop()
          resolve()
        }
        process.once("SIGINT", () => {
          void shutdown()
        })
        process.once("SIGTERM", () => {
          void shutdown()
        })
      })
      return 0
    }
    case "doctor":
      console.log("ICN inference engine and native backend loaded successfully")
      return 0
    case "backend-eligibility": {
      const report = probeBackendEligibility()
      const encoded = encodeEligibility(report)
      console.log(values.json === true ? encoded : JSON.stringify(JSON.parse(encoded), null, 2))
      return 0
    }
    case "version": {
      if (values.json === true) {
        console.log(encodeIdentity(binaryIdentity()))
      } else {
        console.log(binaryIdentity().version)
      }
      return 0
    }
    case "planning-worker":
    case "inference-worker":
      console.error(`${command} is not implemented in the TypeScript ICN server yet`)
      return 2
    default:
      console.error(`unknown command: ${command}`)
      return 2
  }
}
