import { describe, expect, it } from 'vitest'
import { validateDestination } from './ssrf-guard'

describe('validateDestination — SSRF/network-safety guard (#194)', () => {
  it('allows a normal public HTTPS hostname', () => {
    expect(validateDestination('https://boards-api.greenhouse.io/v1/boards/exampleco/jobs/1').allowed).toBe(true)
  })

  it('rejects localhost', () => {
    const r = validateDestination('http://localhost:3000/x')
    expect(r.allowed).toBe(false)
  })

  it('rejects the cloud metadata address', () => {
    const r = validateDestination('http://169.254.169.254/latest/meta-data/')
    expect(r.allowed).toBe(false)
  })

  it('rejects RFC1918 private ranges (10.x, 172.16-31.x, 192.168.x)', () => {
    expect(validateDestination('http://10.0.0.5/x').allowed).toBe(false)
    expect(validateDestination('http://172.16.5.5/x').allowed).toBe(false)
    expect(validateDestination('http://172.31.255.255/x').allowed).toBe(false)
    expect(validateDestination('http://192.168.1.1/x').allowed).toBe(false)
  })

  it('the 172.16-31 RFC1918 boundary is exact — 172.15.x and 172.32.x are blocked as bare-IP-literals, not misclassified as the private range', () => {
    // Every bare IP literal is blocked regardless of range (see the test
    // below) — this test locks in that 172.15.x/172.32.x specifically fail
    // for the "no bare IP literals" reason, not the RFC1918 reason, proving
    // the range boundary math (a===172 && b>=16 && b<=31) is exact rather
    // than off-by-one in either direction.
    const below = validateDestination('http://172.15.0.1/x')
    const above = validateDestination('http://172.32.0.1/x')
    expect(below.allowed).toBe(false)
    expect(above.allowed).toBe(false)
    if (!below.allowed) expect(below.reason).toMatch(/DNS name/i)
    if (!above.allowed) expect(above.reason).toMatch(/DNS name/i)

    const within = validateDestination('http://172.20.0.1/x')
    expect(within.allowed).toBe(false)
    if (!within.allowed) expect(within.reason).toMatch(/private\/reserved/i)
  })

  it('rejects loopback 127.0.0.0/8', () => {
    expect(validateDestination('http://127.0.0.1/x').allowed).toBe(false)
    expect(validateDestination('http://127.5.5.5/x').allowed).toBe(false)
  })

  it('rejects IPv6 loopback and link-local/unique-local', () => {
    expect(validateDestination('http://[::1]/x').allowed).toBe(false)
    expect(validateDestination('http://[fe80::1]/x').allowed).toBe(false)
    expect(validateDestination('http://[fd00::1]/x').allowed).toBe(false)
  })

  it('rejects bare IP literals even when publicly routable — a legitimate ATS host is always a DNS name', () => {
    expect(validateDestination('http://8.8.8.8/x').allowed).toBe(false)
  })

  it('rejects non-http(s) schemes (file, data, ftp)', () => {
    expect(validateDestination('file:///etc/passwd').allowed).toBe(false)
    expect(validateDestination('data:text/plain;base64,aGVsbG8=').allowed).toBe(false)
    expect(validateDestination('ftp://example.com/x').allowed).toBe(false)
  })

  it('fails closed on an unparseable URL', () => {
    const r = validateDestination('not a url at all')
    expect(r.allowed).toBe(false)
  })
})
