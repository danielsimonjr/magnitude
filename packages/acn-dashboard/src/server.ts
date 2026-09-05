import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { BunFileSystem, BunPath } from '@effect/platform-bun'
import { Effect, Layer, Option } from 'effect'
import {
  makeAcnOwnerStore,
  type AcnOwnerRecord,
  acnRpcAuthorizationHeader,
  loadOrCreateAcnRpcToken,
} from '@magnitudedev/acn-protocol/coordination'
import { BunSqliteDriverLayer } from '@magnitudedev/acn-protocol/coordination/bun'
import { ProcessGroupControllerLive } from '@magnitudedev/acn-protocol/coordination/exact-process'
import type { AcnInfo, KillAllAcnResult, RpcTraceSummary } from './lib/types'

const PORT = Number(process.env.ACN_DASH_API_PORT ?? 4886)
const MOTEL_URL = process.env.MAGNITUDE_MOTEL_URL ?? 'http://127.0.0.1:27686'
const DATA_DIR = join(homedir(), '.magnitude')
const DIST_DIR = join(import.meta.dir, '..', 'dist')

const UI_PORT = Number(process.env.ACN_DASH_UI_PORT ?? 4887)
const ALLOWED_ORIGINS = new Set([`http://localhost:${UI_PORT}`, `http://127.0.0.1:${UI_PORT}`])
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/
// Registrations are read from user-writable files; only ever proxy to loopback.
const LOOPBACK_URL = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/

const corsHeaders = {
  'Access-Control-Allow-Origin': `http://localhost:${UI_PORT}`,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Vary': 'Origin',
}

function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, {
    ...init,
    headers: {
      ...corsHeaders,
      ...(init?.headers ?? {}),
    },
  })
}

// The ACN coordination model records exactly one current owner (pid, exact process
// identity, port) in the SQLite owner store under the data directory.
const ownerStoreLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunSqliteDriverLayer)

async function currentOwner(): Promise<AcnOwnerRecord | null> {
  const owner = await Effect.runPromise(
    makeAcnOwnerStore(DATA_DIR).pipe(
      Effect.flatMap((store) => store.current),
      Effect.provide(ownerStoreLayer),
      Effect.catchAll(() => Effect.succeed(Option.none<AcnOwnerRecord>())),
    ),
  )
  if (Option.isNone(owner)) return null
  const url = ownerUrl(owner.value)
  // The owner record is read from a user-writable database; only ever proxy to loopback.
  if (!LOOPBACK_URL.test(url)) return null
  return owner.value
}

const ownerUrl = (owner: AcnOwnerRecord): string => `http://127.0.0.1:${owner.port}`

function isMissingProcess(error: unknown): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ESRCH'
}

// Introspection routes require the daemon's RPC bearer token; the dashboard runs as the
// same user, so it reads the token from the data directory and attaches it.
const rpcAuthorization = (): Record<string, string> => {
  try {
    return acnRpcAuthorizationHeader(loadOrCreateAcnRpcToken(DATA_DIR))
  } catch {
    return {}
  }
}

async function fetchJson(url: string, timeoutMs = 800): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: rpcAuthorization() })
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`)
    }
    return await response.json()
  } finally {
    clearTimeout(timeout)
  }
}

interface MotelTraceSummary {
  readonly traceId?: unknown
  readonly serviceName?: unknown
  readonly rootOperationName?: unknown
  readonly startedAt?: unknown
  readonly isRunning?: unknown
  readonly durationMs?: unknown
  readonly spanCount?: unknown
  readonly errorCount?: unknown
  readonly warnings?: unknown
}

const numberValue = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

const rpcKind = (rpcName: string): RpcTraceSummary['kind'] =>
  rpcName.startsWith('Stream') || rpcName.startsWith('Watch') ? 'stream' : 'command'

function toRpcTraceSummary(trace: MotelTraceSummary): RpcTraceSummary | null {
  if (
    typeof trace.traceId !== 'string' ||
    typeof trace.serviceName !== 'string' ||
    typeof trace.rootOperationName !== 'string' ||
    typeof trace.startedAt !== 'string' ||
    !trace.rootOperationName.startsWith('RpcServer.')
  ) {
    return null
  }

  const rpcName = trace.rootOperationName.slice('RpcServer.'.length)
  return {
    traceId: trace.traceId,
    serviceName: trace.serviceName,
    rootOperationName: trace.rootOperationName,
    startedAt: trace.startedAt,
    isRunning: trace.isRunning === true,
    durationMs: numberValue(trace.durationMs),
    spanCount: numberValue(trace.spanCount),
    errorCount: numberValue(trace.errorCount),
    warnings: Array.isArray(trace.warnings) ? trace.warnings.filter((warning): warning is string => typeof warning === 'string') : [],
    rpcName,
    kind: rpcKind(rpcName),
  }
}

async function listRpcTraces(): Promise<RpcTraceSummary[]> {
  const url = new URL('/api/traces/search', MOTEL_URL)
  url.searchParams.set('service', 'magnitude-acn')
  url.searchParams.set('operation', 'RpcServer.')
  url.searchParams.set('lookback', '4h')
  url.searchParams.set('limit', '40')

  const payload = await fetchJson(url.toString(), 1200) as { data?: MotelTraceSummary[] }
  return (payload.data ?? [])
    .map(toRpcTraceSummary)
    .filter((trace): trace is RpcTraceSummary => trace !== null)
}

async function probeAcn(owner: AcnOwnerRecord): Promise<AcnInfo> {
  const url = ownerUrl(owner)
  let health: AcnInfo['health']
  try {
    const payload = await fetchJson(`${url}/health`)
    const value = payload as {
      service?: string
      version?: string
      pid?: number
      schedulerElapsedMs?: number
    }
    health = {
      ok: value.service === 'magnitude-acn',
      service: value.service,
      version: value.version,
      pid: value.pid,
      schedulerElapsedMs: value.schedulerElapsedMs,
    }
  } catch (error) {
    health = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  let introspection: AcnInfo['introspection']
  try {
    await fetchJson(`${url}/dev/introspection`)
    introspection = { ok: true }
  } catch (error) {
    introspection = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  return {
    // The owner store does not record a version; the daemon reports it on /health.
    version: health.version ?? `pid-${owner.pid}`,
    owner,
    url,
    health,
    introspection,
  }
}

async function listAcns(): Promise<AcnInfo[]> {
  const owner = await currentOwner()
  if (owner === null) return []
  return [await probeAcn(owner)]
}

// Confirms the recorded pid is still occupied by the exact recorded process occurrence
// (not a reused pid) before signalling it.
async function ownerIsAlive(owner: AcnOwnerRecord): Promise<boolean> {
  const observed = await Effect.runPromise(
    ProcessGroupControllerLive.inspect(owner.pid).pipe(
      Effect.catchAll(() => Effect.succeed(Option.none())),
    ),
  )
  return Option.isSome(observed) && observed.value.processStartIdentity === owner.processStartIdentity
}

async function killAllAcns(): Promise<KillAllAcnResult[]> {
  const owner = await currentOwner()
  if (owner === null) return []
  const version = (await probeAcn(owner)).version

  if (owner.pid === process.pid) {
    return [{ version, pid: owner.pid, status: 'skipped_self' }]
  }

  if (!(await ownerIsAlive(owner))) {
    return [{ version, pid: owner.pid, status: 'stale' }]
  }

  try {
    process.kill(owner.pid, 'SIGTERM')
    return [{ version, pid: owner.pid, status: 'killed' }]
  } catch (error) {
    if (isMissingProcess(error)) {
      return [{ version, pid: owner.pid, status: 'stale' }]
    }
    return [{
      version,
      pid: owner.pid,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }]
  }
}

async function findAcn(version: string): Promise<AcnInfo | null> {
  const acns = await listAcns()
  return acns.find((acn) => acn.version === version) ?? null
}

function upstreamUrl(acn: AcnInfo, suffix: string): string {
  return `${acn.url}${suffix}`
}

async function proxyJson(version: string, suffix: string): Promise<Response> {
  const acn = await findAcn(version)
  if (!acn) return json({ error: 'not_found', message: `No ACN registration for ${version}` }, { status: 404 })
  if (!acn.introspection.ok) {
    return json({
      error: 'introspection_unavailable',
      message: acn.introspection.error ?? 'ACN introspection routes are not enabled',
    }, { status: 404 })
  }

  const response = await fetch(upstreamUrl(acn, suffix), { headers: rpcAuthorization() })
  const body = await response.text()
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      ...corsHeaders,
      'Content-Type': response.headers.get('Content-Type') ?? 'application/json',
    },
  })
}

async function proxyStream(version: string, suffix: string): Promise<Response> {
  const acn = await findAcn(version)
  if (!acn) return json({ error: 'not_found', message: `No ACN registration for ${version}` }, { status: 404 })
  if (!acn.introspection.ok) {
    return json({
      error: 'introspection_unavailable',
      message: acn.introspection.error ?? 'ACN introspection routes are not enabled',
    }, { status: 404 })
  }

  const response = await fetch(upstreamUrl(acn, suffix), { headers: rpcAuthorization() })
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      ...corsHeaders,
      'Content-Type': response.headers.get('Content-Type') ?? 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  })
}

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname

    // Loopback-only API: reject DNS-rebinding hosts and cross-site writes.
    const host = req.headers.get('host')
    if (host === null || !LOCAL_HOST.test(host)) return new Response('Invalid Host header', { status: 421 })
    const origin = req.headers.get('origin')
    if (origin !== null && !ALLOWED_ORIGINS.has(origin)) return new Response('Forbidden', { status: 403 })
    if (req.method === 'POST' && origin === null) return new Response('Forbidden', { status: 403 })

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    if (path === '/api/acns') {
      return json({ acns: await listAcns(), timestamp: Date.now() })
    }

    if (path === '/api/acns/kill-all' && req.method === 'POST') {
      const results = await killAllAcns()
      return json({ results, timestamp: Date.now() })
    }

    if (path === '/api/rpc-traces') {
      try {
        return json({ traces: await listRpcTraces(), timestamp: Date.now() })
      } catch (error) {
        return json({
          traces: [],
          timestamp: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const sessionsMatch = path.match(/^\/api\/acns\/([^/]+)\/sessions$/)
    if (sessionsMatch) {
      const version = decodeURIComponent(sessionsMatch[1])
      return proxyJson(version, '/dev/sessions')
    }

    const introspectionMatch = path.match(/^\/api\/acns\/([^/]+)\/sessions\/([^/]+)\/introspection$/)
    if (introspectionMatch) {
      const version = decodeURIComponent(introspectionMatch[1])
      const sessionId = encodeURIComponent(decodeURIComponent(introspectionMatch[2]))
      const forkId = url.searchParams.get('forkId')
      const suffix = `/dev/sessions/${sessionId}${forkId ? `?forkId=${encodeURIComponent(forkId)}` : ''}`
      return proxyJson(version, suffix)
    }

    const streamMatch = path.match(/^\/api\/acns\/([^/]+)\/sessions\/([^/]+)\/stream$/)
    if (streamMatch) {
      const version = decodeURIComponent(streamMatch[1])
      const sessionId = encodeURIComponent(decodeURIComponent(streamMatch[2]))
      const forkId = url.searchParams.get('forkId')
      const suffix = `/dev/sessions/${sessionId}/stream${forkId ? `?forkId=${encodeURIComponent(forkId)}` : ''}`
      return proxyStream(version, suffix)
    }

    try {
      const filePath = path === '/' ? '/index.html' : path
      const resolved = resolve(DIST_DIR, '.' + filePath)
      if (resolved !== DIST_DIR && !resolved.startsWith(DIST_DIR + sep)) return new Response('Forbidden', { status: 403 })
      const file = Bun.file(resolved)
      if (await file.exists()) return new Response(file)
      const index = Bun.file(join(DIST_DIR, 'index.html'))
      if (await index.exists()) return new Response(index)
    } catch {}

    return new Response('Not Found', { status: 404 })
  },
})

console.log(`ACN dashboard API running at http://localhost:${server.port}`)
