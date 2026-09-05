import { HttpServerResponse } from "@effect/platform"
import * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import { acnRpcAuthorizationMatches } from "@magnitudedev/acn-protocol/coordination"
import { Effect } from "effect"

/**
 * Per-request authorization for the coordination listener.
 *
 * Two independent credentials gate a request:
 *
 * - The RPC bearer token proves the caller can read the owner-only data
 *   directory. It is the only secret; without it a request is rejected with
 *   401 before any handler runs. Comparison is constant-time.
 * - The instance id (`x-magnitude-acn-id`) is public coordination state. It is
 *   not a secret and grants nothing by itself; it lets a client that raced a
 *   daemon replacement receive 409 instead of silently talking to a different
 *   process occurrence.
 */

export const ACN_INSTANCE_HEADER = "x-magnitude-acn-id"

export type RouteHandler<E, R> =
  | Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
  | ((request: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>)

const runHandler = <E, R>(
  handler: RouteHandler<E, R>,
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> =>
  typeof handler === "function" ? handler(request) : handler

export const unauthorizedResponse = HttpServerResponse.empty({ status: 401 })
export const instanceMismatchResponse = HttpServerResponse.empty({ status: 409 })

export interface AcnRequestAuthorizer {
  /** True when the request presents the RPC bearer token. */
  readonly isAuthorized: (request: HttpServerRequest.HttpServerRequest) => boolean
  /** True when the request names this exact instance. */
  readonly isThisInstance: (request: HttpServerRequest.HttpServerRequest) => boolean
  /** Wraps a handler so it runs only for token-bearing requests; otherwise 401. */
  readonly requireToken: <E, R>(
    handler: RouteHandler<E, R>,
  ) => (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
  /** `requireToken` plus the instance check; a stale instance id yields 409. */
  readonly requireTokenAndInstance: <E, R>(
    handler: RouteHandler<E, R>,
  ) => (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
}

export const makeAcnRequestAuthorizer = (options: {
  readonly rpcToken: string
  readonly instanceId: string
}): AcnRequestAuthorizer => {
  const isAuthorized = (request: HttpServerRequest.HttpServerRequest): boolean =>
    acnRpcAuthorizationMatches(request.headers.authorization, options.rpcToken)
  const isThisInstance = (request: HttpServerRequest.HttpServerRequest): boolean =>
    request.headers[ACN_INSTANCE_HEADER] === options.instanceId

  const requireToken: AcnRequestAuthorizer["requireToken"] = (handler) => (request) =>
    isAuthorized(request) ? runHandler(handler, request) : Effect.succeed(unauthorizedResponse)

  const requireTokenAndInstance: AcnRequestAuthorizer["requireTokenAndInstance"] = (handler) => (request) =>
    !isAuthorized(request)
      ? Effect.succeed(unauthorizedResponse)
      : !isThisInstance(request)
        ? Effect.succeed(instanceMismatchResponse)
        : runHandler(handler, request)

  return { isAuthorized, isThisInstance, requireToken, requireTokenAndInstance }
}
