import { describe, expect, it } from 'vitest'
import {
  guardedFetch,
  isForbiddenAddress,
  isMetadataHost,
  readBodyCapped,
  validateFetchTarget,
} from '../src/tools/web-fetch-guard'

describe('isForbiddenAddress', () => {
  it('rejects loopback, private, link-local and unspecified IPv4', () => {
    for (const ip of [
      '127.0.0.1', '127.255.255.255',
      '10.0.0.1', '10.255.255.255',
      '172.16.0.1', '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', '169.254.0.1',
      '0.0.0.0', '0.1.2.3',
      '100.64.0.1',
      '224.0.0.1', '255.255.255.255',
    ]) {
      expect(isForbiddenAddress(ip), ip).toBe(true)
    }
  })

  it('allows public IPv4', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.15.0.1', '172.32.0.1', '93.184.216.34', '11.0.0.1']) {
      expect(isForbiddenAddress(ip), ip).toBe(false)
    }
  })

  it('rejects loopback, link-local, unique-local, unspecified and mapped IPv6', () => {
    for (const ip of [
      '::1', '::',
      'fe80::1', 'febf::1', 'fe80::1%eth0',
      'fc00::1', 'fd12:3456::1', 'fd00:ec2::254',
      '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::127.0.0.1',
      '64:ff9b::7f00:1', '2002:7f00:1::',
      'ff02::1',
    ]) {
      expect(isForbiddenAddress(ip), ip).toBe(true)
    }
  })

  it('allows public IPv6', () => {
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
      expect(isForbiddenAddress(ip), ip).toBe(false)
    }
  })

  it('treats unparsable literals as forbidden', () => {
    expect(isForbiddenAddress('not-an-ip')).toBe(true)
    expect(isForbiddenAddress('')).toBe(true)
  })
})

describe('isMetadataHost', () => {
  it('recognises cloud metadata endpoints', () => {
    expect(isMetadataHost('metadata.google.internal')).toBe(true)
    expect(isMetadataHost('METADATA.GOOGLE.INTERNAL.')).toBe(true)
    expect(isMetadataHost('169.254.169.254')).toBe(true)
    expect(isMetadataHost('example.com')).toBe(false)
  })
})

describe('validateFetchTarget', () => {
  const publicDns = async () => ['93.184.216.34']

  it('rejects non-http schemes', async () => {
    await expect(validateFetchTarget('file:///etc/passwd', publicDns)).rejects.toThrow(/http/)
    await expect(validateFetchTarget('ftp://example.com', publicDns)).rejects.toThrow(/http/)
  })

  it('rejects hosts that resolve to any forbidden address', async () => {
    const rebinding = async () => ['93.184.216.34', '127.0.0.1']
    await expect(validateFetchTarget('http://evil.example', rebinding)).rejects.toThrow(/private or reserved/)
    await expect(validateFetchTarget('http://localhost:8080/', async () => ['::1'])).rejects.toThrow(/private or reserved/)
  })

  it('rejects IP literals and metadata hosts without resolving', async () => {
    const neverCalled = async () => { throw new Error('should not resolve') }
    await expect(validateFetchTarget('http://127.0.0.1/', neverCalled)).rejects.toThrow(/private or reserved/)
    await expect(validateFetchTarget('http://[::1]/', neverCalled)).rejects.toThrow(/private or reserved/)
    await expect(validateFetchTarget('http://169.254.169.254/latest/meta-data', neverCalled)).rejects.toThrow(/metadata/)
    await expect(validateFetchTarget('http://metadata.google.internal/', neverCalled)).rejects.toThrow(/metadata/)
  })

  it('accepts public hosts', async () => {
    const url = await validateFetchTarget('https://example.com/page', publicDns)
    expect(url.hostname).toBe('example.com')
  })
})

describe('guardedFetch', () => {
  const publicDns = async () => ['93.184.216.34']

  it('re-validates each redirect hop', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const u = String(input)
      if (u.startsWith('https://public.example/')) {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } })
      }
      return new Response('should never get here')
    }) as unknown as typeof fetch
    await expect(
      guardedFetch('https://public.example/start', { fetchImpl, resolveHost: publicDns }),
    ).rejects.toThrow(/private or reserved/)
  })

  it('caps redirect hops', async () => {
    let n = 0
    const fetchImpl = (async () => {
      n++
      return new Response(null, { status: 301, headers: { location: `https://public.example/${n}` } })
    }) as unknown as typeof fetch
    await expect(
      guardedFetch('https://public.example/0', { fetchImpl, resolveHost: publicDns, maxHops: 5 }),
    ).rejects.toThrow(/Too many redirects/)
    expect(n).toBe(6)
  })

  it('returns the final response and url', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const u = String(input)
      if (u.endsWith('/a')) return new Response(null, { status: 302, headers: { location: '/b' } })
      return new Response('done', { status: 200 })
    }) as unknown as typeof fetch
    const { response, url } = await guardedFetch('https://public.example/a', { fetchImpl, resolveHost: publicDns })
    expect(url).toBe('https://public.example/b')
    expect(await response.text()).toBe('done')
  })
})

describe('readBodyCapped', () => {
  it('reads bodies under the cap', async () => {
    expect(await readBodyCapped(new Response('hello'), 1024)).toBe('hello')
  })

  it('rejects declared oversize bodies without reading', async () => {
    const res = new Response('x', { headers: { 'content-length': '999999999' } })
    await expect(readBodyCapped(res, 1024)).rejects.toThrow(/too large/)
  })

  it('aborts streamed bodies once the cap is exceeded', async () => {
    let pushed = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pushed++
        controller.enqueue(new Uint8Array(1024))
      },
    })
    await expect(readBodyCapped(new Response(stream), 4096)).rejects.toThrow(/too large/)
    expect(pushed).toBeLessThan(20)
  })
})
