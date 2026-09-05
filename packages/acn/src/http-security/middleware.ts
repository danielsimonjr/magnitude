import { HttpServerResponse } from "@effect/platform"
import * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import type * as HttpLayerRouter from "@effect/platform/HttpLayerRouter"
import { Effect } from "effect"
import { forbiddenOriginResponse, preflightHandler, withCors } from "./cors"
import { isLoopbackHost, type OriginPolicy } from "./origin-policy"

export const invalidHostResponse = HttpServerResponse.text("Invalid Host header", { status: 421 })

export interface ListenerSecurityOptions {
  readonly originPolicy: OriginPolicy
  /**
   * When true, a request whose Origin the policy rejects is answered 403
   * instead of reaching its handler. Required for unauthenticated listeners:
   * a browser sends "simple" cross-site POSTs without preflight, so denying
   * CORS headers alone would still let the request execute.
   */
  readonly rejectForeignOrigins: boolean
}

/**
 * Global middleware every listener installs first. Order matters: the Host
 * check runs before anything else so a DNS-rebound request never reaches a
 * handler, then the Origin gate, then the handler, then CORS decoration.
 */
export const makeListenerSecurityMiddleware = (options: ListenerSecurityOptions) =>
  <E, R>(
    responseEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest> =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (!isLoopbackHost(request.headers.host)) return invalidHostResponse
      const origin = request.headers.origin
      if (options.rejectForeignOrigins && origin !== undefined && !options.originPolicy.allows(origin)) {
        return forbiddenOriginResponse
      }
      return withCors(yield* responseEffect, request, options.originPolicy)
    })

/** Installs the security middleware and the catch-all preflight route on `router`. */
export const secureListener = (
  router: HttpLayerRouter.HttpRouter,
  options: ListenerSecurityOptions,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* router.addGlobalMiddleware(makeListenerSecurityMiddleware(options))
    yield* router.add("OPTIONS", "/*", preflightHandler(options.originPolicy))
  })
