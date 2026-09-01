/**
 * Job-search response loop — funnel metrics.
 *
 * "confirmation_check" (autoresponder acks) is excluded from `responses`
 * and never touches first_response_at (see email-correlation.ts) — a
 * receipt isn't a human response, and counting it would make the response
 * rate meaningless. Positive responses are every classification except
 * `rejection` and `unknown` (an unrecognized reply is evidence someone
 * wrote back, but not evidence it was a good sign).
 *
 * Aggregation happens in JS over a single bounded read, matching the
 * existing style in lib/job-search/summary.ts rather than hand-rolling SQL
 * aggregate queries through supabase-js's query builder.
 */
import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

const POSITIVE_TYPES = new Set(['recruiter_interest', 'screen_request', 'interview_request', 'assessment', 'scheduling', 'offer'])

export type FunnelBreakdownRow = {
  key: string
  applications: number
  responses: number
  interviews: number
  offers: number
  responseRate: number | null
}

export type FunnelMetrics = {
  applications: number
  responses: number
  positiveResponses: number
  screens: number
  interviews: number
  offers: number
  rejections: number
  ghosted: number
  responseRate: number | null
  positiveResponseRate: number | null
  interviewConversionRate: number | null
  medianResponseHours: number | null
  byTitle: FunnelBreakdownRow[]
  bySource: FunnelBreakdownRow[]
  byStrategy: FunnelBreakdownRow[]
}

export type ApplicationRow = {
  id: string
  status: string
  method: string
  submitted_at: string | null
  first_response_at: string | null
  ghosted_at: string | null
  candidate: { title: string | null; discovered_via: Array<{ source_key?: string }> | null } | { title: string | null; discovered_via: Array<{ source_key?: string }> | null }[] | null
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
}

function breakdownBy(rows: Array<{ key: string; status: string; hasResponse: boolean; hasInterview: boolean; hasOffer: boolean }>): FunnelBreakdownRow[] {
  const groups = new Map<string, { applications: number; responses: number; interviews: number; offers: number }>()
  for (const row of rows) {
    const g = groups.get(row.key) ?? { applications: 0, responses: 0, interviews: 0, offers: 0 }
    g.applications++
    if (row.hasResponse) g.responses++
    if (row.hasInterview) g.interviews++
    if (row.hasOffer) g.offers++
    groups.set(row.key, g)
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, ...g, responseRate: rate(g.responses, g.applications) }))
    .sort((a, b) => b.applications - a.applications)
}

/** since: only count applications prepared/submitted on or after this ISO date. Omit for all-time. */
export async function computeFunnelMetrics(since?: string): Promise<FunnelMetrics> {
  const supabase = createServiceClient()
  let query = supabase
    .from('job_search_applications')
    .select('id, status, method, submitted_at, first_response_at, ghosted_at, candidate:job_search_candidates(title,discovered_via)')
    .neq('status', 'PREPARED') // exclude never-attempted rows from the funnel — an application starts when it's actually applied/attempted
    .limit(2000)
  if (since) query = query.gte('prepared_at', since)
  const { data, error } = await query
  if (error) throw new Error(`Could not load applications for funnel metrics: ${error.message}`)

  const rows = (data ?? []) as ApplicationRow[]

  const { data: followupRows } = await supabase
    .from('job_search_followups')
    .select('application_id, followup_type')
    .eq('direction', 'inbound')
    .in('application_id', rows.map((r) => r.id))
  const typesByApplication = new Map<string, Set<string>>()
  for (const f of followupRows ?? []) {
    const set = typesByApplication.get(f.application_id) ?? new Set<string>()
    set.add(f.followup_type)
    typesByApplication.set(f.application_id, set)
  }

  return aggregateFunnelMetrics(rows, typesByApplication)
}

/** Pure aggregation, split out from the DB fetch above so it's cheap to unit test with plain fixtures. */
export function aggregateFunnelMetrics(rows: ApplicationRow[], typesByApplication: Map<string, Set<string>>): FunnelMetrics {
  const responseHours: number[] = []
  let responses = 0
  let positiveResponses = 0
  let screens = 0
  let interviews = 0
  let offers = 0
  let rejections = 0
  let ghosted = 0

  const enriched = rows.map((row) => {
    const types = typesByApplication.get(row.id) ?? new Set<string>()
    const hasResponse = Boolean(row.first_response_at)
    const hasInterview = row.status === 'INTERVIEW' || types.has('interview_request')
    const hasOffer = row.status === 'OFFER'
    const hasScreen = types.has('screen_request')
    const isRejected = row.status === 'REJECTED'
    const isPositive = [...types].some((t) => POSITIVE_TYPES.has(t)) || hasOffer

    if (hasResponse) {
      responses++
      if (row.submitted_at && row.first_response_at) {
        const hours = (new Date(row.first_response_at).getTime() - new Date(row.submitted_at).getTime()) / 3_600_000
        if (hours >= 0) responseHours.push(hours)
      }
    }
    if (isPositive) positiveResponses++
    if (hasScreen) screens++
    if (hasInterview) interviews++
    if (hasOffer) offers++
    if (isRejected) rejections++
    if (row.ghosted_at) ghosted++

    const candidate = Array.isArray(row.candidate) ? row.candidate[0] : row.candidate
    const source = candidate?.discovered_via?.[0]?.source_key ?? 'unknown'
    return {
      title: candidate?.title ?? 'unknown',
      source,
      strategy: row.method,
      status: row.status,
      hasResponse,
      hasInterview,
      hasOffer,
    }
  })

  return {
    applications: rows.length,
    responses,
    positiveResponses,
    screens,
    interviews,
    offers,
    rejections,
    ghosted,
    responseRate: rate(responses, rows.length),
    positiveResponseRate: rate(positiveResponses, rows.length),
    interviewConversionRate: rate(interviews, rows.length),
    medianResponseHours: median(responseHours),
    byTitle: breakdownBy(enriched.map((e) => ({ key: e.title, status: e.status, hasResponse: e.hasResponse, hasInterview: e.hasInterview, hasOffer: e.hasOffer }))),
    bySource: breakdownBy(enriched.map((e) => ({ key: e.source, status: e.status, hasResponse: e.hasResponse, hasInterview: e.hasInterview, hasOffer: e.hasOffer }))),
    byStrategy: breakdownBy(enriched.map((e) => ({ key: e.strategy, status: e.status, hasResponse: e.hasResponse, hasInterview: e.hasInterview, hasOffer: e.hasOffer }))),
  }
}
