import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const PLACES_TEXT_SEARCH = {
  status: 'OK',
  results: [{ place_id: 'place-1', name: 'Example Tours' }],
}

const PLACE_DETAILS = {
  status: 'OK',
  result: {
    name: 'Example Tours',
    formatted_phone_number: '242-555-0100',
    website: 'https://example-tours.test',
    formatted_address: 'Nassau, Bahamas',
  },
}

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as Response
}

function htmlResponse(html: string) {
  return { ok: true, text: async () => html } as Response
}

describe('sourceLeads', () => {
  const originalKey = process.env.GOOGLE_MAPS_API_KEY

  beforeEach(() => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key'
  })

  afterEach(() => {
    process.env.GOOGLE_MAPS_API_KEY = originalKey
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('captures a meta-description excerpt as evidence alongside the scraped email', async () => {
    const html = `<html><head><meta name="description" content="Family-run snorkeling and reef tours out of Freeport since 1998."></head><body>Contact us: hello@example-tours.test</body></html>`
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('textsearch')) return jsonResponse(PLACES_TEXT_SEARCH)
      if (url.includes('/details/')) return jsonResponse(PLACE_DETAILS)
      return htmlResponse(html)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { sourceLeads } = await import('./outreach-sourcing')
    const [lead] = await sourceLeads('tour operator', 'Nassau, Bahamas', 1)

    expect(lead.email).toBe('hello@example-tours.test')
    expect(lead.evidence).toBe('Family-run snorkeling and reef tours out of Freeport since 1998.')
  })

  it('falls back to og:description when no name="description" tag exists', async () => {
    const html = `<html><head><meta property="og:description" content="Sunset sailing charters for up to twelve guests."></head><body>hello@example-tours.test</body></html>`
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('textsearch')) return jsonResponse(PLACES_TEXT_SEARCH)
      if (url.includes('/details/')) return jsonResponse(PLACE_DETAILS)
      return htmlResponse(html)
    }))

    const { sourceLeads } = await import('./outreach-sourcing')
    const [lead] = await sourceLeads('tour operator', 'Nassau, Bahamas', 1)

    expect(lead.evidence).toBe('Sunset sailing charters for up to twelve guests.')
  })

  it('returns null evidence rather than fabricating anything when no description tag is present', async () => {
    const html = `<html><head><title>Example Tours</title></head><body>hello@example-tours.test</body></html>`
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('textsearch')) return jsonResponse(PLACES_TEXT_SEARCH)
      if (url.includes('/details/')) return jsonResponse(PLACE_DETAILS)
      return htmlResponse(html)
    }))

    const { sourceLeads } = await import('./outreach-sourcing')
    const [lead] = await sourceLeads('tour operator', 'Nassau, Bahamas', 1)

    expect(lead.email).toBe('hello@example-tours.test')
    expect(lead.evidence).toBeNull()
  })

  it('discards a description too short to carry real signal', async () => {
    const html = `<html><head><meta name="description" content="Tours."></head><body>hello@example-tours.test</body></html>`
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('textsearch')) return jsonResponse(PLACES_TEXT_SEARCH)
      if (url.includes('/details/')) return jsonResponse(PLACE_DETAILS)
      return htmlResponse(html)
    }))

    const { sourceLeads } = await import('./outreach-sourcing')
    const [lead] = await sourceLeads('tour operator', 'Nassau, Bahamas', 1)

    expect(lead.evidence).toBeNull()
  })

  it('truncates an overlong description instead of dumping the whole tag into the prompt', async () => {
    const longText = 'A'.repeat(400)
    const html = `<html><head><meta name="description" content="${longText}"></head><body>hello@example-tours.test</body></html>`
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('textsearch')) return jsonResponse(PLACES_TEXT_SEARCH)
      if (url.includes('/details/')) return jsonResponse(PLACE_DETAILS)
      return htmlResponse(html)
    }))

    const { sourceLeads } = await import('./outreach-sourcing')
    const [lead] = await sourceLeads('tour operator', 'Nassau, Bahamas', 1)

    expect(lead.evidence).not.toBeNull()
    expect(lead.evidence!.length).toBeLessThan(320)
    expect(lead.evidence!.endsWith('…')).toBe(true)
  })
})
