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
    const { leads: [lead] } = await sourceLeads('tour operator', 'Nassau, Bahamas', 1)

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
    const { leads: [lead] } = await sourceLeads('tour operator', 'Nassau, Bahamas', 1)

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
    const { leads: [lead] } = await sourceLeads('tour operator', 'Nassau, Bahamas', 1)

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
    const { leads: [lead] } = await sourceLeads('tour operator', 'Nassau, Bahamas', 1)

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
    const { leads: [lead] } = await sourceLeads('tour operator', 'Nassau, Bahamas', 1)

    expect(lead.evidence).not.toBeNull()
    expect(lead.evidence!.length).toBeLessThan(320)
    expect(lead.evidence!.endsWith('…')).toBe(true)
  })

  it('slices the Places result set starting at the given offset instead of always taking the head', async () => {
    const manyResults = {
      status: 'OK',
      results: Array.from({ length: 5 }, (_, i) => ({ place_id: `place-${i}`, name: `Business ${i}` })),
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('textsearch')) return jsonResponse(manyResults)
      if (url.includes('/details/')) {
        const placeId = new URL(url).searchParams.get('place_id')
        return jsonResponse({ status: 'OK', result: { name: `Business ${placeId}`, website: undefined } })
      }
      return htmlResponse('<html></html>')
    }))

    const { sourceLeads } = await import('./outreach-sourcing')
    const result = await sourceLeads('restaurant', 'Nassau, Bahamas', 2, 3)

    // offset 3, maxResults 2 -> should only walk place-3 and place-4.
    expect(result.leads.map((l) => l.business_name)).toEqual(['Business place-3', 'Business place-4'])
    expect(result.consumed).toBe(2)
    expect(result.totalResults).toBe(5)
  })

  it('excludes a business that fails the ICP filter and reports it via rejectedNotIcp, not as a lead', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('textsearch')) return jsonResponse(PLACES_TEXT_SEARCH)
      if (url.includes('/details/')) {
        return jsonResponse({
          status: 'OK',
          result: { ...PLACE_DETAILS.result, user_ratings_total: 50000, business_status: 'OPERATIONAL' },
        })
      }
      return htmlResponse('<html>hello@example-tours.test</html>')
    }))

    const { sourceLeads } = await import('./outreach-sourcing')
    const result = await sourceLeads('resort', 'Nassau, Bahamas', 1)

    expect(result.leads).toHaveLength(0)
    expect(result.rejectedNotIcp).toBe(1)
  })
})

describe('advanceSourcingCursor', () => {
  it('advances the offset within the same variant when the page did not exhaust the result set', async () => {
    const { advanceSourcingCursor } = await import('./outreach-sourcing')
    const next = advanceSourcingCursor({
      cursor: { queryVariantIndex: 0, resultOffset: 0 },
      variantsCount: 8,
      resultsConsumedInThisPage: 20,
      totalResultsForVariant: 60,
    })
    expect(next).toEqual({ queryVariantIndex: 0, resultOffset: 20 })
  })

  it('rolls over to the next variant at offset 0 once the current variant is exhausted', async () => {
    const { advanceSourcingCursor } = await import('./outreach-sourcing')
    const next = advanceSourcingCursor({
      cursor: { queryVariantIndex: 0, resultOffset: 40 },
      variantsCount: 8,
      resultsConsumedInThisPage: 20,
      totalResultsForVariant: 60,
    })
    expect(next).toEqual({ queryVariantIndex: 1, resultOffset: 0 })
  })

  it('wraps back around to variant 0 after the last variant is exhausted', async () => {
    const { advanceSourcingCursor } = await import('./outreach-sourcing')
    const next = advanceSourcingCursor({
      cursor: { queryVariantIndex: 7, resultOffset: 0 },
      variantsCount: 8,
      resultsConsumedInThisPage: 12,
      totalResultsForVariant: 12,
    })
    expect(next).toEqual({ queryVariantIndex: 0, resultOffset: 0 })
  })

  it('rolls over rather than stalling forever when a variant returns zero results', async () => {
    const { advanceSourcingCursor } = await import('./outreach-sourcing')
    const next = advanceSourcingCursor({
      cursor: { queryVariantIndex: 3, resultOffset: 0 },
      variantsCount: 8,
      resultsConsumedInThisPage: 0,
      totalResultsForVariant: 0,
    })
    expect(next).toEqual({ queryVariantIndex: 4, resultOffset: 0 })
  })
})

describe('getQueryVariants', () => {
  it('returns the full rotation list for a known vertical', async () => {
    const { getQueryVariants } = await import('./outreach-sourcing')
    const variants = getQueryVariants('tour operator')
    expect(variants).toContain('tour operator')
    expect(variants.length).toBeGreaterThan(1)
  })

  it('falls back to a single-entry list of the vertical string itself for an unrecognized vertical', async () => {
    const { getQueryVariants } = await import('./outreach-sourcing')
    expect(getQueryVariants('pottery studio')).toEqual(['pottery studio'])
  })
})

describe('failsIcpFilter', () => {
  it('rejects a business with review volume far above a plausible owner-operated SMB', async () => {
    const { failsIcpFilter, ICP_MAX_USER_RATINGS } = await import('./outreach-sourcing')
    expect(failsIcpFilter({ user_ratings_total: ICP_MAX_USER_RATINGS + 1 })).toBe(true)
  })

  it('accepts a business at or below the review-volume threshold', async () => {
    const { failsIcpFilter, ICP_MAX_USER_RATINGS } = await import('./outreach-sourcing')
    expect(failsIcpFilter({ user_ratings_total: ICP_MAX_USER_RATINGS })).toBe(false)
  })

  it('does not reject a business with no review-count data at all', async () => {
    const { failsIcpFilter } = await import('./outreach-sourcing')
    expect(failsIcpFilter({})).toBe(false)
  })

  it('rejects a permanently or temporarily closed business', async () => {
    const { failsIcpFilter } = await import('./outreach-sourcing')
    expect(failsIcpFilter({ business_status: 'CLOSED_PERMANENTLY' })).toBe(true)
    expect(failsIcpFilter({ business_status: 'OPERATIONAL' })).toBe(false)
  })

  it('rejects a resort-tier price level', async () => {
    const { failsIcpFilter, ICP_MAX_PRICE_LEVEL } = await import('./outreach-sourcing')
    expect(failsIcpFilter({ price_level: ICP_MAX_PRICE_LEVEL + 1 })).toBe(true)
    expect(failsIcpFilter({ price_level: ICP_MAX_PRICE_LEVEL })).toBe(false)
  })
})

describe('buildContactCandidateUrls', () => {
  it('includes the root plus a bounded, deduplicated set of contact-bearing paths', async () => {
    const { buildContactCandidateUrls } = await import('./outreach-sourcing')
    const urls = buildContactCandidateUrls('https://example-tours.test')
    expect(urls[0]).toBe('https://example-tours.test')
    expect(new Set(urls).size).toBe(urls.length)
    expect(urls.length).toBeLessThanOrEqual(6)
    expect(urls.length).toBeGreaterThan(3)
  })

  it('resolves paths relative to a website that already has a path/trailing slash', async () => {
    const { buildContactCandidateUrls } = await import('./outreach-sourcing')
    const urls = buildContactCandidateUrls('https://example-tours.test/en/')
    expect(urls.some((u) => u.includes('/contact'))).toBe(true)
  })
})

describe('extractEmailFromHtml', () => {
  it('prefers a mailto href over a bare-text email match elsewhere on the page', async () => {
    const { extractEmailFromHtml } = await import('./outreach-sourcing')
    const html = `<html><body><p>As seen in a testimonial from visitor@gmail.com</p><a href="mailto:hello@example-tours.test">Email us</a></body></html>`
    expect(extractEmailFromHtml(html)).toBe('hello@example-tours.test')
  })

  it('falls back to a bare-text match when no mailto href is present', async () => {
    const { extractEmailFromHtml } = await import('./outreach-sourcing')
    const html = `<html><body>Contact us: hello@example-tours.test</body></html>`
    expect(extractEmailFromHtml(html)).toBe('hello@example-tours.test')
  })

  it('skips a blocklisted mailto target and falls back to a valid bare-text match', async () => {
    const { extractEmailFromHtml } = await import('./outreach-sourcing')
    const html = `<html><body><a href="mailto:noreply@sentry.io">Report a bug</a> hello@example-tours.test</body></html>`
    expect(extractEmailFromHtml(html)).toBe('hello@example-tours.test')
  })

  it('returns null when no valid email is present anywhere', async () => {
    const { extractEmailFromHtml } = await import('./outreach-sourcing')
    expect(extractEmailFromHtml('<html><body>No contact info here.</body></html>')).toBeNull()
  })
})
