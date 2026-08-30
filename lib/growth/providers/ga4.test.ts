import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getGoogleGrowthAccessToken: vi.fn() }))
vi.mock('./google-auth', () => ({ getGoogleGrowthAccessToken: mocks.getGoogleGrowthAccessToken }))

import { readGa4Snapshot } from './ga4'

describe('readGa4Snapshot', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mocks.getGoogleGrowthAccessToken.mockReset()
  })

  it('fails closed when the numeric GA4 property id is missing or malformed', async () => {
    expect(await readGa4Snapshot('G-Z5FGHHMTJQ')).toEqual({
      status: 'unavailable',
      reason: 'invalid_property_id',
      retryable: false,
    })
    expect(mocks.getGoogleGrowthAccessToken).not.toHaveBeenCalled()
  })

  it('does not turn missing Google credentials into zero traffic', async () => {
    mocks.getGoogleGrowthAccessToken.mockResolvedValue(null)
    const result = await readGa4Snapshot('123456789')
    expect(result).toEqual({
      status: 'unavailable',
      reason: 'google_credentials_unavailable',
      retryable: true,
    })
    expect(JSON.stringify(result)).not.toContain('"value":0')
  })

  it('normalizes a successful GA4 report into namespaced observed evidence', async () => {
    mocks.getGoogleGrowthAccessToken.mockResolvedValue('token')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      rows: [{ metricValues: [{ value: '42' }, { value: '31' }, { value: '117' }] }],
    }), { status: 200 })))

    const result = await readGa4Snapshot('123456789')
    expect(result.status).toBe('observed')
    if (result.status !== 'observed') throw new Error('unexpected')
    expect(result.metrics).toEqual([
      { metricKey: 'ga4.sessions', value: 42, unit: 'count' },
      { metricKey: 'ga4.active_users', value: 31, unit: 'count' },
      { metricKey: 'ga4.event_count', value: 117, unit: 'count' },
    ])
  })
})
