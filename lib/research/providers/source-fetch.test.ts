import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  assertPublicResearchUrl,
  extractHtmlTitle,
  extractReadableText,
  fetchResearchDocument,
} from './source-fetch'

describe('research source URL guard', () => {
  it('accepts ordinary public sources', () => {
    for (const url of ['https://www.imf.org/report', 'http://example.gov/a', 'https://arxiv.org/abs/1234.5678']) {
      expect(() => assertPublicResearchUrl(url)).not.toThrow()
    }
  })

  // Source URLs come from model output. A hallucinated or injected citation must
  // not be able to turn the research worker into an internal-network probe.
  it.each([
    ['loopback', 'http://127.0.0.1/admin'],
    ['loopback name', 'http://localhost:3000/api'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['private 10/8', 'http://10.0.0.5/'],
    ['private 172.16/12', 'http://172.20.1.1/'],
    ['private 192.168/16', 'http://192.168.1.1/'],
    ['carrier NAT', 'http://100.100.1.1/'],
    ['zero page', 'http://0.0.0.0/'],
    ['ipv6 loopback', 'http://[::1]/'],
    ['ipv6 unique-local', 'http://[fd00::1]/'],
    ['ipv6 link-local', 'http://[fe80::1]/'],
    ['ipv4-mapped ipv6', 'http://[::ffff:10.0.0.1]/'],
    ['ipv4-mapped loopback', 'http://[::ffff:127.0.0.1]/'],
    ['ipv4-mapped metadata', 'http://[::ffff:169.254.169.254]/'],
    ['internal suffix', 'http://vault.internal/secret'],
    ['mdns suffix', 'http://printer.local/'],
    ['gcp metadata', 'http://metadata.google.internal/'],
  ])('refuses a %s destination', (_label, url) => {
    expect(() => assertPublicResearchUrl(url)).toThrow()
  })

  it.each([
    ['file', 'file:///etc/passwd'],
    ['data', 'data:text/html,<h1>x</h1>'],
    ['javascript', 'javascript:alert(1)'],
    ['gopher', 'gopher://example.com/'],
  ])('refuses the %s scheme', (_label, url) => {
    expect(() => assertPublicResearchUrl(url)).toThrow(/http\(s\)|not a valid URL/)
  })

  it('re-validates every redirect hop, not just the first', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://example.gov/start') {
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
      }
      return new Response('should never be reached', { status: 200, headers: { 'content-type': 'text/html' } })
    })

    await expect(fetchResearchDocument('https://example.gov/start', { fetch: fetchMock as any }))
      .rejects.toThrow(/private address/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('durable document extraction', () => {
  it('extracts readable text and drops scripts, styles and markup', () => {
    const html = `<!doctype html><html><head><title>Report</title>
      <style>body{color:red}</style><script>window.x = "tracking"</script></head>
      <body><h1>Tourism Outlook</h1><p>Arrivals rose 12% in 2026.</p>
      <p>Spending fell&nbsp;3%.</p><noscript>enable js</noscript></body></html>`

    const text = extractReadableText(html)

    expect(text).toContain('Tourism Outlook')
    expect(text).toContain('Arrivals rose 12% in 2026.')
    expect(text).toContain('Spending fell 3%.')
    expect(text).not.toContain('tracking')
    expect(text).not.toContain('color:red')
    expect(text).not.toContain('enable js')
    expect(text).not.toContain('<')
  })

  it('keeps block boundaries so separate claims do not run together', () => {
    expect(extractReadableText('<p>First fact.</p><p>Second fact.</p>')).toBe('First fact.\n\nSecond fact.')
  })

  it('decodes named and numeric entities', () => {
    expect(extractReadableText('<p>A&amp;B &#8212; 5&lt;10 &#x2019;s</p>')).toBe('A&B — 5<10 ’s')
  })

  it('reads the document title when the citation supplied none', () => {
    expect(extractHtmlTitle('<html><head><title>  IMF  Outlook </title></head></html>')).toBe('IMF Outlook')
    expect(extractHtmlTitle('<html><head></head></html>')).toBeUndefined()
  })

  it('returns the retrieved text with an observation timestamp', async () => {
    const fetchMock = vi.fn(async () => new Response(
      '<html><head><title>Gov Data</title></head><body><p>GDP grew 2.1%.</p></body></html>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    ))

    const document = await fetchResearchDocument('https://example.gov/data', { fetch: fetchMock as any })

    expect(document.content).toBe('GDP grew 2.1%.')
    expect(document.title).toBe('Gov Data')
    expect(document.finalUrl).toBe('https://example.gov/data')
    expect(Number.isNaN(Date.parse(document.fetchedAt))).toBe(false)
  })

  it('refuses binary documents rather than storing garbage as evidence', async () => {
    const fetchMock = vi.fn(async () => new Response('%PDF-1.7 binary', {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    }))

    await expect(fetchResearchDocument('https://example.gov/a.pdf', { fetch: fetchMock as any }))
      .rejects.toThrow(/not a readable text document/)
  })

  it('marks source failures so the router does not blame the provider', async () => {
    const fetchMock = vi.fn(async () => new Response('gone', { status: 404 }))

    await expect(fetchResearchDocument('https://example.gov/missing', { fetch: fetchMock as any }))
      .rejects.toMatchObject({ researchSourceFailure: true, httpStatus: 404 })
  })

  it('refuses an empty document instead of persisting a contentless source', async () => {
    const fetchMock = vi.fn(async () => new Response('<html><body><script>x=1</script></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }))

    await expect(fetchResearchDocument('https://example.gov/blank', { fetch: fetchMock as any }))
      .rejects.toThrow(/no readable text/)
  })
})
