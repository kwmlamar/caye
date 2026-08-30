import 'server-only'

import { getGoogleGrowthAccessToken } from './google-auth'

export type SearchConsoleMetric = {
  metricKey: 'search_console.clicks' | 'search_console.impressions' | 'search_console.ctr' | 'search_console.position'
  value: number
  unit: 'count' | 'ratio' | 'position'
}

export type SearchConsoleReadResult =
  | { status: 'observed'; metrics: SearchConsoleMetric[]; periodStart: string; periodEnd: string; provenance: Record<string, unknown> }
  | { status: 'unavailable'; reason: string; retryable: boolean }

type SearchAnalyticsResponse = {
  rows?: Array<{
    clicks?: number
    impressions?: number
    ctr?: number
    position?: number
  }>
}

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly'

/**
 * Reads a compact 28-day organic-search snapshot from Google Search Console.
 * Search Console data is delayed, so the window ends three completed UTC days ago.
 * `siteUrl` must be the exact Search Console property reference, for example
 * `sc-domain:example.com` or `https://www.example.com/`.
 */
export async function readSearchConsoleSnapshot(siteUrl: string): Promise<SearchConsoleReadResult> {
  const normalizedSiteUrl = siteUrl.trim()
  if (!normalizedSiteUrl || (!normalizedSiteUrl.startsWith('sc-domain:') && !/^https?:\/\//i.test(normalizedSiteUrl))) {
    return { status: 'unavailable', reason: 'invalid_site_url', retryable: false }
  }

  const token = await getGoogleGrowthAccessToken([SCOPE])
  if (!token) return { status: 'unavailable', reason: 'google_credentials_unavailable', retryable: true }

  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const periodEndDate = new Date(todayStart)
  periodEndDate.setUTCDate(periodEndDate.getUTCDate() - 3)
  const periodStartDate = new Date(periodEndDate)
  periodStartDate.setUTCDate(periodStartDate.getUTCDate() - 27)

  const startDate = periodStartDate.toISOString().slice(0, 10)
  const endDate = periodEndDate.toISOString().slice(0, 10)

  try {
    const response = await fetch(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(normalizedSiteUrl)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ startDate, endDate, type: 'web', dataState: 'final' }),
        signal: AbortSignal.timeout(20_000),
      },
    )

    if (!response.ok) {
      return {
        status: 'unavailable',
        reason: `search_console_http_${response.status}`,
        retryable: response.status === 429 || response.status >= 500,
      }
    }

    const body = await response.json() as SearchAnalyticsResponse
    const row = body.rows?.[0]
    if (!row) return { status: 'unavailable', reason: 'search_console_no_rows', retryable: true }

    const values = [row.clicks, row.impressions, row.ctr, row.position]
    if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      return { status: 'unavailable', reason: 'search_console_invalid_metrics', retryable: true }
    }

    return {
      status: 'observed',
      metrics: [
        { metricKey: 'search_console.clicks', value: row.clicks!, unit: 'count' },
        { metricKey: 'search_console.impressions', value: row.impressions!, unit: 'count' },
        { metricKey: 'search_console.ctr', value: row.ctr!, unit: 'ratio' },
        { metricKey: 'search_console.position', value: row.position!, unit: 'position' },
      ],
      periodStart: `${startDate}T00:00:00.000Z`,
      periodEnd: `${endDate}T23:59:59.999Z`,
      provenance: {
        provider: 'search_console',
        api: 'searchconsole.googleapis.com/webmasters/v3',
        siteUrl: normalizedSiteUrl,
        windowDays: 28,
        reportingLagDays: 3,
        dataState: 'final',
      },
    }
  } catch {
    return { status: 'unavailable', reason: 'search_console_request_failed', retryable: true }
  }
}
