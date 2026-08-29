/**
 * Job-search operator (#192) — daily founder summary.
 *
 * Feeds Phase 7 founder UX ("How many did you apply to?", the compact
 * daily-summary shape from the issue). Deliberately returns structured
 * counts rather than pre-formatted prose — the admin-shell tool that
 * calls this (get-job-search-summary.ts) lets Caye's own voice render it
 * inline in the founder conversation, matching "fit into Caye's existing
 * founder interaction model" rather than hard-coding wording here.
 */
import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

export type DailySummary = {
  businessDate: string
  sourced: number
  qualified: number
  needsHuman: number
  submitted: number
  rejected: number
  rejectionBreakdown: Record<string, number>
  paused: boolean
}

export async function getDailySummary(): Promise<DailySummary> {
  const supabase = createServiceClient()
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const todayStartISO = todayStart.toISOString()

  const [{ data: candidatesToday }, { data: applicationsToday }, { data: settingsRow }] = await Promise.all([
    supabase
      .from('job_search_candidates')
      .select('status, hard_block_reason')
      .gte('discovered_at', todayStartISO),
    supabase
      .from('job_search_applications')
      .select('status')
      .gte('prepared_at', todayStartISO),
    supabase.from('job_search_settings').select('paused').eq('id', true).maybeSingle(),
  ])

  const candidates = candidatesToday ?? []
  const applications = applicationsToday ?? []

  const rejectionBreakdown: Record<string, number> = {}
  let rejected = 0
  for (const row of candidates) {
    if (row.status === 'REJECTED') {
      rejected += 1
      const key = row.hard_block_reason ?? 'below_fit_threshold'
      rejectionBreakdown[key] = (rejectionBreakdown[key] ?? 0) + 1
    }
  }

  return {
    businessDate: todayStart.toISOString().slice(0, 10),
    sourced: candidates.length,
    qualified: candidates.filter((c) => c.status === 'QUEUED').length,
    needsHuman: applications.filter((a) => a.status === 'NEEDS_HUMAN').length,
    submitted: applications.filter((a) => a.status === 'SUBMITTED').length,
    rejected,
    rejectionBreakdown,
    paused: settingsRow?.paused ?? true,
  }
}
