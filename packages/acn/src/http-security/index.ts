/**
 * HTTP security for the ACN's two loopback listeners.
 *
 * - Coordination listener (random port): admits local and opaque origins, and
 *   requires the RPC bearer token on every route except `/health`.
 * - Public inference listener (fixed port): unauthenticated by contract, so it
 *   admits only local HTTP origins and rejects every other Origin outright.
 *
 * See `design/acn/http-security.md` for the normative contract.
 */
import type * as HttpLayerRouter from "@effect/platform/HttpLayerRouter"
import type { Effect } from "effect"
import { makeAcnRequestAuthorizer, type AcnRequestAuthorizer } from "./authorization"
import { preflightHandler } from "./cors"
import { secureListener } from "./middleware"
import { coordinationOriginPolicy, publicOriginPolicy } from "./origin-policy"

export * from "./authorization"
export * from "./cors"
export * from "./middleware"
export * from "./origin-policy"

export interface AcnHttpSecurity {
  readonly authorizer: AcnRequestAuthorizer
  /** Secures the coordination router; routes must then be wrapped by `authorizer`. */
  readonly secureCoordinationRouter: (router: HttpLayerRouter.HttpRouter) => Effect.Effect<void>
  /** Secures the public inference router. */
  readonly securePublicRouter: (router: HttpLayerRouter.HttpRouter) => Effect.Effect<void>
  /** Preflight responder for handlers that own a wildcard route on the public router. */
  readonly publicPreflight: ReturnType<typeof preflightHandler>
}

export const makeAcnHttpSecurity = (options: {
  readonly rpcToken: string
  readonly instanceId: string
}): AcnHttpSecurity => ({
  authorizer: makeAcnRequestAuthorizer(options),
  secureCoordinationRouter: (router) =>
    secureListener(router, { originPolicy: coordinationOriginPolicy, rejectForeignOrigins: false }),
  securePublicRouter: (router) =>
    secureListener(router, { originPolicy: publicOriginPolicy, rejectForeignOrigins: true }),
  publicPreflight: preflightHandler(publicOriginPolicy),
})
