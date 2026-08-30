import 'server-only'

import { getGoogleGrowthAccessToken } from './google-auth'

export type Ga4Metric = {
  metricKey: 'sessions' | 'active_users' | 'event_count'
  value: number
  unit: 'count'
}

export type Ga4ReadResult =
  | { status: 'observed'; metrics: Ga4Metric[]; periodStart: string; periodEnd: string; provenance: Record<string, unknown> }
  | { status: 'unavailable'; reason: string; retryable: boolean }

type RunReportResponse = {
  rows?: Array<{ metricValues?: Array<{ value?: string }> }>
}

const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly'

/**
 * Reads a compact 28-day GA4 traffic snapshot. The property id is the numeric
 * GA4 property id (not the public G- measurement id from the website tag).
 */
export async function readGa4Snapshot(propertyId: string): Promise<Ga4ReadResult> {
  if (!/^\d+$/.test(propertyId)) {
    return { status: 'unavailable', reason: 'invalid_property_id', retryable: false }
  }

  const token = await getGoogleGrowthAccessToken([SCOPE])
  if (!token) return { status: 'unavailable', reason: 'google_credentials_unavailable', retryable: true }

  const periodEnd = new Date()
  const periodStart = new Date(periodEnd)
  periodStart.setUTCDate(periodStart.getUTCDate() - 27)
  const startDate = periodStart.toISOString().slice(0, 10)
  const endDate = periodEnd.toISOString().slice(0, 10)

  try {
    const response = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        dateRanges: [{ startDate, endDate }],
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'eventCount' }],
      }),
      signal: AbortSignal.timeout(20_000),
    })

    if (!response.ok) {
      return {
        status: 'unavailable',
        reason: `ga4_http_${response.status}`,
        retryable: response.status === 429 || response.status >= 500,
      }
    }

    const body = await response.json() as RunReportResponse
    const values = body.rows?.[0]?.metricValues ?? []
    if (values.length < 3) return { status: 'unavailable', reason: 'ga4_missing_metrics', retryable: true }

    const parsed = values.slice(0, 3).map((item) => Number(item.value))
    if (parsed.some((value) => !Number.isFinite(value))) {
      return { status: 'unavailable', reason: 'ga4_invalid_metrics', retryable: true }
    }

    return {
      status: 'observed',
      metrics: [
        { metricKey: 'sessions', value: parsed[0], unit: 'count' },
        { metricKey: 'active_users', value: parsed[1], unit: 'count' },
        { metricKey: 'event_count', value: parsed[2], unit: 'count' },
      ],
      periodStart: `${startDate}T00:00:00.000Z`,
      periodEnd: `${endDate}T23:59:59.999Z`,
      provenance: {
        provider: 'ga4',
        api: 'analyticsdata.googleapis.com/v1beta',
        propertyId,
        windowDays: 28,
      },
    }
  } catch {
    return { status: 'unavailable', reason: 'ga4_request_failed', retryable: true }
  }
}
