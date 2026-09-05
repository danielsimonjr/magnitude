export interface ServeConfig {
  readonly bindHost: string
  readonly bindPort: number
  readonly instanceId: string
  readonly exitOnStdinEof: boolean
  readonly authToken?: string
  readonly fake: boolean
  readonly modelStore?: string
  readonly cacheRoot?: string
  readonly hfCaches: ReadonlyArray<string>
  readonly installation?: string
}

export interface ServerIdentity {
  readonly instanceId: string
  readonly apiVersion: number
  readonly nativeBuild: string
}

export const resolveAuthToken = (
  cliToken: string | undefined,
): string | undefined => cliToken ?? process.env.MAGNITUDE_ICN_AUTH_TOKEN

export const validateServeConfig = (config: ServeConfig): void => {
  const bindIsLoopback =
    config.bindHost === "127.0.0.1" ||
    config.bindHost === "::1" ||
    config.bindHost === "localhost"
  if (!bindIsLoopback && config.authToken === undefined) {
    throw new Error(
      `refusing to bind ${config.bindHost}:${config.bindPort} without auth token; non-loopback binds require MAGNITUDE_ICN_AUTH_TOKEN`,
    )
  }
}
