/**
 * SSRF guard for outbound agent fetches.
 *
 * - Only http(s) URLs.
 * - Every hostname is resolved (all A/AAAA records) and rejected if any address
 *   is loopback, private, link-local, unique-local, unspecified, or otherwise
 *   non-public, or if the hostname is a known cloud metadata endpoint.
 * - Redirects are followed manually so each hop is re-validated.
 * - Response bodies are streamed with a hard byte cap instead of buffered.
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export const MAX_REDIRECT_HOPS = 5

const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata',
  'instance-data',
  'instance-data.ec2.internal',
  '169.254.169.254',
  '100.100.100.200', // Alibaba Cloud
  'fd00:ec2::254', // AWS IMDS over IPv6
])

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map(p => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  return octets.every(o => Number.isInteger(o) && o >= 0 && o <= 255) ? octets : null
}

function isForbiddenIPv4(octets: number[]): boolean {
  const [a, b] = octets
  if (a === 0) return true // 0.0.0.0/8 (includes 0.0.0.0)
  if (a === 10) return true // 10/8
  if (a === 127) return true // 127/8 loopback
  if (a === 169 && b === 254) return true // 169.254/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 168) return true // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 shared address space
  if (a >= 224) return true // multicast 224/4, reserved 240/4, broadcast
  return false
}

/** Expand an IPv6 textual address into 8 16-bit groups; null when unparsable. */
function parseIPv6(ip: string): number[] | null {
  let s = ip
  const zone = s.indexOf('%')
  if (zone !== -1) s = s.slice(0, zone)

  // Embedded IPv4 tail (e.g. ::ffff:127.0.0.1) → convert to two hextets.
  const lastColon = s.lastIndexOf(':')
  const tail = s.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail)
    if (!v4) return null
    const hi = ((v4[0] << 8) | v4[1]).toString(16)
    const lo = ((v4[2] << 8) | v4[3]).toString(16)
    s = `${s.slice(0, lastColon)}:${hi}:${lo}`
  }

  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const toNums = (parts: string[]) => parts.map(p => (/^[0-9a-f]{1,4}$/i.test(p) ? parseInt(p, 16) : NaN))
  const headN = toNums(head)
  const restN = toNums(rest)
  if ([...headN, ...restN].some(Number.isNaN)) return null

  if (halves.length === 2) {
    const fill = 8 - headN.length - restN.length
    if (fill < 1) return null
    return [...headN, ...new Array<number>(fill).fill(0), ...restN]
  }
  return headN.length === 8 ? headN : null
}

function isForbiddenIPv6(groups: number[]): boolean {
  const allZeroButLast = groups.slice(0, 7).every(g => g === 0)
  if (allZeroButLast && groups[7] === 0) return true // :: unspecified
  if (allZeroButLast && groups[7] === 1) return true // ::1 loopback

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) → classify the v4.
  const v4Prefix = groups.slice(0, 5).every(g => g === 0)
  if (v4Prefix && (groups[5] === 0xffff || groups[5] === 0)) {
    const v4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]
    return isForbiddenIPv4(v4)
  }

  const first = groups[0]
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((first & 0xff00) === 0xff00) return true // ff00::/8 multicast
  // 64:ff9b::/96 (NAT64) and 2002::/16 (6to4) can smuggle v4 addresses.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every(g => g === 0)) {
    return isForbiddenIPv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff])
  }
  if (first === 0x2002) {
    return isForbiddenIPv4([groups[1] >> 8, groups[1] & 0xff, groups[2] >> 8, groups[2] & 0xff])
  }
  return false
}

/**
 * True when `address` must never be contacted: loopback, private, link-local,
 * unique-local, unspecified, multicast/reserved, or an unparsable literal.
 */
export function isForbiddenAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) {
    const v4 = parseIPv4(address)
    return v4 === null || isForbiddenIPv4(v4)
  }
  if (version === 6) {
    const v6 = parseIPv6(address)
    return v6 === null || isForbiddenIPv6(v6)
  }
  return true
}

/** True for well-known cloud metadata hostnames/addresses. */
export function isMetadataHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return METADATA_HOSTS.has(h)
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

export class UnsafeUrlError extends Error {
  readonly _tag = 'UnsafeUrlError'
}

/**
 * Parse and validate a fetch target. Resolves the hostname and rejects it if
 * any resolved address is forbidden. Returns the parsed URL on success.
 */
export async function validateFetchTarget(
  rawUrl: string,
  resolveHost: (hostname: string) => Promise<string[]> = defaultResolve,
): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new UnsafeUrlError(`Invalid URL: ${rawUrl}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError('URL must start with http:// or https://')
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError('URLs with embedded credentials are not allowed')
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (!hostname) throw new UnsafeUrlError('URL has no host')
  if (isMetadataHost(hostname)) {
    throw new UnsafeUrlError('Access to cloud metadata endpoints is not allowed')
  }

  const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname)
  if (addresses.length === 0) {
    throw new UnsafeUrlError(`Could not resolve host: ${hostname}`)
  }
  if (addresses.some(isForbiddenAddress)) {
    throw new UnsafeUrlError(`Refusing to fetch ${hostname}: resolves to a private or reserved address`)
  }
  return url
}

async function defaultResolve(hostname: string): Promise<string[]> {
  try {
    const records = await lookup(hostname, { all: true, verbatim: true })
    return records.map(r => r.address)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Guarded fetch
// ---------------------------------------------------------------------------

export interface GuardedFetchOptions {
  readonly headers?: Record<string, string>
  readonly signal?: AbortSignal
  readonly maxHops?: number
  readonly fetchImpl?: typeof fetch
  readonly resolveHost?: (hostname: string) => Promise<string[]>
}

/**
 * Fetch with manual redirect handling: every hop is validated against the SSRF
 * rules before it is requested. Resolves to the final response and its URL.
 */
export async function guardedFetch(
  rawUrl: string,
  options: GuardedFetchOptions = {},
): Promise<{ response: Response; url: string }> {
  const maxHops = options.maxHops ?? MAX_REDIRECT_HOPS
  const fetchImpl = options.fetchImpl ?? fetch
  let current = rawUrl

  for (let hop = 0; ; hop++) {
    const url = await validateFetchTarget(current, options.resolveHost)
    const response = await fetchImpl(url.toString(), {
      signal: options.signal,
      headers: options.headers,
      redirect: 'manual',
    })

    const isRedirect = response.status >= 300 && response.status < 400 && response.headers.has('location')
    if (!isRedirect) return { response, url: url.toString() }

    // Discard the redirect body before following.
    await response.body?.cancel().catch(() => {})
    if (hop >= maxHops) {
      throw new UnsafeUrlError(`Too many redirects (limit ${maxHops})`)
    }
    const location = response.headers.get('location')!
    try {
      current = new URL(location, url).toString()
    } catch {
      throw new UnsafeUrlError(`Invalid redirect location: ${location}`)
    }
  }
}

/**
 * Read a response body as text, aborting once more than `maxBytes` have been
 * received. Never buffers beyond the cap.
 */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length')
  if (contentLength && Number(contentLength) > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`Response too large (exceeds ${formatBytes(maxBytes)} limit)`)
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maxBytes) {
        throw new Error(`Response too large (exceeds ${formatBytes(maxBytes)} limit)`)
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally {
    reader.cancel().catch(() => {})
  }
}

function formatBytes(n: number): string {
  return n % (1024 * 1024) === 0 ? `${n / (1024 * 1024)} MiB` : `${n} bytes`
}
