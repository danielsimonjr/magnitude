/**
 * Origin and Host policy for the ACN's loopback HTTP listeners.
 *
 * Binding to 127.0.0.1 keeps remote hosts out, but not the user's browser:
 * any page can issue requests to loopback ports, and DNS rebinding can make a
 * foreign hostname resolve to loopback. Two independent checks close that gap:
 *
 * - The Host header must name a loopback host, so a rebound hostname is refused
 *   before any handler runs.
 * - The Origin header, when present, must satisfy the listener's OriginPolicy.
 *   Browsers send it on every cross-origin request, so it identifies which page
 *   is calling; it is absent for non-browser clients such as the SDK.
 */

/** `http(s)://{localhost|127.0.0.1|[::1]}[:port]` with no path. */
const LOCAL_HTTP_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/
const LOCAL_HTTP_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/

/**
 * Opaque origins: `file://` documents (the desktop renderer) are reported by
 * browsers as the literal string "null", and some report the scheme itself.
 * Sandboxed iframes and `data:` documents are also "null", so an opaque origin
 * identifies nothing and must never be trusted on its own.
 */
const OPAQUE_ORIGINS: ReadonlySet<string> = new Set(["null", "file://"])

export interface OriginPolicy {
  /** Stable name used in diagnostics. */
  readonly name: string
  readonly allows: (origin: string) => boolean
}

export const isLoopbackHost = (host: string | undefined): boolean =>
  host !== undefined && LOCAL_HTTP_HOST.test(host)

export const isLocalHttpOrigin = (origin: string): boolean => LOCAL_HTTP_ORIGIN.test(origin)

export const isOpaqueOrigin = (origin: string): boolean => OPAQUE_ORIGINS.has(origin)

/**
 * Coordination listener (health, rpc, shutdown, introspection). Local pages and
 * the desktop renderer's opaque origin may talk to it. Admitting opaque origins
 * is safe only because every route except `/health` also demands the RPC
 * bearer token, which an unrelated page cannot obtain.
 */
export const coordinationOriginPolicy: OriginPolicy = {
  name: "coordination",
  allows: (origin) => isLocalHttpOrigin(origin) || isOpaqueOrigin(origin),
}

/**
 * Public inference listener (fixed port, unauthenticated, used by external
 * tools that send no Origin at all). Nothing legitimate calls it from an opaque
 * origin, so only local HTTP pages are admitted and every other Origin is
 * rejected outright rather than merely denied CORS headers.
 */
export const publicOriginPolicy: OriginPolicy = {
  name: "public-inference",
  allows: isLocalHttpOrigin,
}
