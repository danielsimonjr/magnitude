import { HttpServerResponse } from "@effect/platform"
import type * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import { Effect } from "effect"
import type { OriginPolicy } from "./origin-policy"

/**
 * Request headers a browser client may send. Includes the RPC bearer token
 * (`Authorization`), the instance discriminator, provider auth headers relayed
 * through the inference proxy, and W3C/B3 trace propagation.
 */
export const CORS_ALLOWED_HEADERS =
  "Accept, Authorization, Content-Type, Content-Length, Magnitude-Include-Progress, anthropic-version, anthropic-beta, x-api-key, x-magnitude-acn-id, traceparent, tracestate, baggage, b3, x-b3-traceid, x-b3-spanid, x-b3-parentspanid, x-b3-sampled, x-b3-flags"

export const CORS_ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS"

/**
 * CORS response headers for `request` under `policy`, or `null` when the request
 * carries no Origin (non-browser client) or an Origin the policy rejects. The
 * allowed origin is echoed exactly, never wildcarded, so credentials-bearing
 * responses are scoped to the calling page.
 */
export const corsHeadersFor = (
  request: HttpServerRequest.HttpServerRequest,
  policy: OriginPolicy,
): Record<string, string> | null => {
  const origin = request.headers.origin
  if (origin === undefined || !policy.allows(origin)) return null
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": CORS_ALLOWED_METHODS,
    "access-control-allow-headers": CORS_ALLOWED_HEADERS,
    "access-control-expose-headers": "request-id, x-request-id",
    "access-control-max-age": "86400",
    vary: "Origin",
  }
}

export const withCors = (
  response: HttpServerResponse.HttpServerResponse,
  request: HttpServerRequest.HttpServerRequest,
  policy: OriginPolicy,
): HttpServerResponse.HttpServerResponse => {
  const headers = corsHeadersFor(request, policy)
  return headers === null ? response : HttpServerResponse.setHeaders(response, headers)
}

export const forbiddenOriginResponse = HttpServerResponse.empty({ status: 403 })

/** Answers browser preflight: 204 with CORS headers, or 403 for a rejected Origin. */
export const preflightHandler = (policy: OriginPolicy) =>
  (request: HttpServerRequest.HttpServerRequest): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
    const headers = corsHeadersFor(request, policy)
    return Effect.succeed(
      headers === null
        ? forbiddenOriginResponse
        : HttpServerResponse.setHeaders(HttpServerResponse.empty({ status: 204 }), headers),
    )
  }
