import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { HttpServerResponse } from "@effect/platform"
import * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import {
  coordinationOriginPolicy,
  corsHeadersFor,
  isLoopbackHost,
  makeAcnHttpSecurity,
  makeAcnRequestAuthorizer,
  makeListenerSecurityMiddleware,
  preflightHandler,
  publicOriginPolicy,
} from "./index"

const TOKEN = "a".repeat(64)
const INSTANCE = "instance-1"

const request = (init: { method?: string; headers?: Record<string, string> } = {}) =>
  HttpServerRequest.fromWeb(new Request("http://127.0.0.1:4000/rpc", {
    method: init.method ?? "POST",
    headers: { host: "127.0.0.1:4000", ...init.headers },
  }))

const ok = HttpServerResponse.text("ok")

const runMiddleware = (
  options: Parameters<typeof makeListenerSecurityMiddleware>[0],
  req: HttpServerRequest.HttpServerRequest,
) => Effect.runSync(
  makeListenerSecurityMiddleware(options)(Effect.succeed(ok)).pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, req),
  ),
)

describe("origin policies", () => {
  it("coordination admits local http origins and opaque origins only", () => {
    for (const origin of ["http://localhost:5173", "http://127.0.0.1", "https://[::1]:8080", "null", "file://"]) {
      expect(coordinationOriginPolicy.allows(origin), origin).toBe(true)
    }
    for (const origin of ["https://evil.example", "http://localhost.evil.example", "http://127.0.0.1.evil", "http://localhost:5173/path", "ftp://localhost"]) {
      expect(coordinationOriginPolicy.allows(origin), origin).toBe(false)
    }
  })

  it("public inference admits local http origins but never opaque ones", () => {
    expect(publicOriginPolicy.allows("http://localhost:3000")).toBe(true)
    expect(publicOriginPolicy.allows("null")).toBe(false)
    expect(publicOriginPolicy.allows("file://")).toBe(false)
    expect(publicOriginPolicy.allows("https://evil.example")).toBe(false)
  })

  it("accepts only loopback Host headers", () => {
    expect(isLoopbackHost("localhost:1234")).toBe(true)
    expect(isLoopbackHost("127.0.0.1")).toBe(true)
    expect(isLoopbackHost("[::1]:10100")).toBe(true)
    expect(isLoopbackHost("rebound.example:10100")).toBe(false)
    expect(isLoopbackHost("127.0.0.1.example")).toBe(false)
    expect(isLoopbackHost(undefined)).toBe(false)
  })
})

describe("CORS", () => {
  it("echoes an allowed origin exactly and never wildcards", () => {
    const headers = corsHeadersFor(request({ headers: { origin: "http://localhost:5173" } }), coordinationOriginPolicy)
    expect(headers?.["access-control-allow-origin"]).toBe("http://localhost:5173")
    expect(headers?.vary).toBe("Origin")
    expect(headers?.["access-control-allow-headers"]).toContain("Authorization")
  })

  it("emits no CORS headers without an Origin or for a rejected one", () => {
    expect(corsHeadersFor(request(), coordinationOriginPolicy)).toBeNull()
    expect(corsHeadersFor(request({ headers: { origin: "https://evil.example" } }), coordinationOriginPolicy)).toBeNull()
  })

  it("answers preflight with 204 for allowed and 403 for rejected origins", () => {
    const preflight = preflightHandler(publicOriginPolicy)
    expect(Effect.runSync(preflight(request({ method: "OPTIONS", headers: { origin: "http://localhost:3000" } }))).status).toBe(204)
    expect(Effect.runSync(preflight(request({ method: "OPTIONS", headers: { origin: "null" } }))).status).toBe(403)
  })
})

describe("listener middleware", () => {
  const coordination = { originPolicy: coordinationOriginPolicy, rejectForeignOrigins: false }
  const publicListener = { originPolicy: publicOriginPolicy, rejectForeignOrigins: true }

  it("refuses a non-loopback Host before running the handler", () => {
    const req = HttpServerRequest.fromWeb(new Request("http://x/rpc", { method: "POST", headers: { host: "rebound.example:4000" } }))
    expect(runMiddleware(coordination, req).status).toBe(421)
  })

  it("lets a foreign-origin request through to the (token-gated) coordination handler without CORS headers", () => {
    const response = runMiddleware(coordination, request({ headers: { origin: "https://evil.example" } }))
    expect(response.status).toBe(200)
    expect(response.headers["access-control-allow-origin"]).toBeUndefined()
  })

  it("rejects a foreign-origin request to the public listener outright", () => {
    expect(runMiddleware(publicListener, request({ headers: { origin: "https://evil.example" } })).status).toBe(403)
    expect(runMiddleware(publicListener, request({ headers: { origin: "null" } })).status).toBe(403)
  })

  it("serves non-browser clients (no Origin) and decorates allowed browser origins", () => {
    expect(runMiddleware(publicListener, request()).status).toBe(200)
    const decorated = runMiddleware(publicListener, request({ headers: { origin: "http://127.0.0.1:5173" } }))
    expect(decorated.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173")
  })
})

describe("request authorizer", () => {
  const authorizer = makeAcnRequestAuthorizer({ rpcToken: TOKEN, instanceId: INSTANCE })
  const run = (
    handler: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse>,
    req: HttpServerRequest.HttpServerRequest,
  ) => Effect.runSync(handler(req))

  it("rejects missing, malformed, and wrong bearer tokens with 401", () => {
    const guarded = authorizer.requireToken<never, never>(ok)
    expect(run(guarded, request()).status).toBe(401)
    expect(run(guarded, request({ headers: { authorization: TOKEN } })).status).toBe(401)
    expect(run(guarded, request({ headers: { authorization: `Bearer ${"b".repeat(64)}` } })).status).toBe(401)
    expect(run(guarded, request({ headers: { authorization: `Bearer ${TOKEN}x` } })).status).toBe(401)
  })

  it("runs the handler for the correct bearer token", () => {
    expect(run(authorizer.requireToken<never, never>(ok), request({ headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200)
  })

  it("checks the token before the instance id so a stale client without the token still gets 401", () => {
    const guarded = authorizer.requireTokenAndInstance<never, never>(() => Effect.succeed(ok))
    expect(run(guarded, request({ headers: { "x-magnitude-acn-id": INSTANCE } })).status).toBe(401)
    expect(run(guarded, request({ headers: { authorization: `Bearer ${TOKEN}`, "x-magnitude-acn-id": "other" } })).status).toBe(409)
    expect(run(guarded, request({ headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(409)
    expect(run(guarded, request({ headers: { authorization: `Bearer ${TOKEN}`, "x-magnitude-acn-id": INSTANCE } })).status).toBe(200)
  })

  it("composes into listener security with the expected policies", () => {
    const security = makeAcnHttpSecurity({ rpcToken: TOKEN, instanceId: INSTANCE })
    expect(security.authorizer.isAuthorized(request({ headers: { authorization: `Bearer ${TOKEN}` } }))).toBe(true)
    expect(Effect.runSync(security.publicPreflight(request({ method: "OPTIONS", headers: { origin: "null" } }))).status).toBe(403)
  })
})
