---
applies_to:
  - packages/acn/src/http-security/**
  - packages/acn/src/server.ts
  - packages/acn/src/introspection/routes.ts
  - packages/acn/src/inference-gateway.ts
  - packages/acn-protocol/src/coordination/rpc-token.ts
  - packages/sdk/src/jit-rpc/recovering-protocol.ts
  - packages/sdk/src/acn-jit/acn-daemon-shutdown-supervisor.ts
  - web/scripts/dev-server.ts
---

# ACN HTTP security

The ACN serves two loopback HTTP listeners. Loopback binding excludes remote hosts but not the
user's browser or other local users, so each listener applies an explicit security contract.

## Listeners

| Listener | Port | Callers | Authentication |
|---|---|---|---|
| Coordination | random, published in the owner row | SDK clients, desktop renderer, web dev-server proxy, dashboards | RPC bearer token on every route except `/health` |
| Public inference | fixed `127.0.0.1:10100` | external tools speaking OpenAI/Anthropic/Codex protocols | none; protected by origin policy only |

## Request pipeline

Every request on either listener passes, in order:

1. **Host check.** The Host header must name `localhost`, `127.0.0.1`, or `[::1]` with an optional
   port; otherwise 421. This defeats DNS rebinding before any handler runs.
2. **Origin gate.** When an Origin header is present it is evaluated against the listener's origin
   policy. The public listener answers 403 to any rejected Origin, because unauthenticated simple
   requests execute without preflight. The coordination listener lets the request continue without
   CORS decoration; its routes are protected by the token instead.
3. **Route authorization** (coordination only; see below).
4. **CORS decoration.** An allowed Origin is echoed exactly, never wildcarded, with `Vary: Origin`.
   Preflight (`OPTIONS`) answers 204 for allowed and 403 for rejected origins.

## Origin policies

- `coordination`: local HTTP origins (`http(s)://{localhost|127.0.0.1|[::1]}[:port]`) and opaque
  origins (`null`, `file://`). Opaque origins are admitted solely so the desktop renderer, which
  loads from `file://`, can call the daemon; that is safe only because the token gate follows.
- `public-inference`: local HTTP origins only. Nothing legitimate calls the inference proxy from an
  opaque origin, and opaque origins are unidentifiable, so they are rejected.

## Credentials

**RPC bearer token.** A 32-byte random hex token stored at `<dataDir>/acn/rpc-token` with mode
0600 inside a 0700 directory. Whichever process needs it first mints it with an exclusive create;
racing processes read the winner's token. Possession proves the caller can read the owner-only data
directory, which is the trust boundary: same-user processes are trusted, everything else is not.
It is sent as `Authorization: Bearer <token>` and compared in constant time. A missing or wrong
token yields 401 before the handler runs. `/health` never requires it and never returns it.

**Instance id** (`x-magnitude-acn-id`). Public coordination state returned by `/health`. It is not
a credential and grants nothing; `/rpc` checks it after the token so a client that raced a daemon
replacement receives 409 rather than being served by a different process occurrence.

**Provider credentials on the inference proxy.** Client-supplied `Authorization`/`x-api-key`
headers are stripped and replaced by the ICN's own local authorization for local inference, and
are forwarded unchanged only to the upstream the client explicitly addressed. Stored provider keys
are never attached to proxied requests.

## Route contract

| Route | Listener | Guard |
|---|---|---|
| `GET /health` | both | none |
| `POST /rpc` | coordination | token, then instance id |
| `POST /shutdown` | coordination | token |
| `GET /dev/**` (debug introspection) | coordination | token |
| `/inference/**` | public | origin policy only |

## Client obligations

The SDK reads the token from the data directory and attaches it to the ready `AcnInstance`
(`rpcToken`), so the recovering RPC transport and the shutdown supervisor send it on every request.
A privileged host (CLI, desktop main process, web dev server) is the only party that reads the
file; renderers receive the token through the instance they are handed, never by reading disk.

## Invariants

- No route other than `/health` is reachable on the coordination listener without the token.
- No response ever carries `Access-Control-Allow-Origin: *`.
- The token is never logged, never included in `/health`, and never written with permissions wider
  than the owning user.
- Adding a route to the coordination listener requires wrapping it with the request authorizer;
  the router itself does not authenticate.

## Acceptance criteria

- A request with a non-loopback Host is answered 421 on both listeners before any handler runs.
- `POST /rpc` without a token → 401; with the token but a stale instance id → 409; with both → dispatched.
- `POST /shutdown` and every `/dev/**` route without the token → 401.
- A request to `/inference/**` carrying `Origin: null` or any non-local Origin → 403; without an
  Origin it is served.
- Preflight to either listener from a rejected Origin → 403; from an allowed Origin → 204 with the
  Origin echoed.
