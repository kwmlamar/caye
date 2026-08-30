import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getGoogleGrowthAccessToken: vi.fn() }))
vi.mock('./google-auth', () => ({ getGoogleGrowthAccessToken: mocks.getGoogleGrowthAccessToken }))

import { readSearchConsoleSnapshot } from './search-console'

describe('readSearchConsoleSnapshot', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mocks.getGoogleGrowthAccessToken.mockReset()
  })

  it('rejects invalid Search Console property references before auth', async () => {
    expect(await readSearchConsoleSnapshot('example.com')).toEqual({
      status: 'unavailable',
      reason: 'invalid_site_url',
      retryable: false,
    })
    expect(mocks.getGoogleGrowthAccessToken).not.toHaveBeenCalled()
  })

  it('does not convert unavailable Google credentials into zero search demand', async () => {
    mocks.getGoogleGrowthAccessToken.mockResolvedValue(null)
    const result = await readSearchConsoleSnapshot('sc-domain:example.com')
    expect(result).toEqual({
      status: 'unavailable',
      reason: 'google_credentials_unavailable',
      retryable: true,
    })
    expect(JSON.stringify(result)).not.toContain('"value":0')
  })

  it('normalizes successful organic-search evidence', async () => {
    mocks.getGoogleGrowthAccessToken.mockResolvedValue('token')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      rows: [{ clicks: 12, impressions: 400, ctr: 0.03, position: 8.5 }],
    }), { status: 200 })))

    const result = await readSearchConsoleSnapshot('sc-domain:example.com')
    expect(result.status).toBe('observed')
    if (result.status !== 'observed') throw new Error('unexpected')
    expect(result.metrics).toEqual([
      { metricKey: 'search_console.clicks', value: 12, unit: 'count' },
      { metricKey: 'search_console.impressions', value: 400, unit: 'count' },
      { metricKey: 'search_console.ctr', value: 0.03, unit: 'ratio' },
      { metricKey: 'search_console.position', value: 8.5, unit: 'position' },
    ])
  })

  it('treats a successful response with no rows as unavailable, not zero', async () => {
    mocks.getGoogleGrowthAccessToken.mockResolvedValue('token')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })))

    expect(await readSearchConsoleSnapshot('https://www.example.com/')).toEqual({
      status: 'unavailable',
      reason: 'search_console_no_rows',
      retryable: true,
    })
  })
})
