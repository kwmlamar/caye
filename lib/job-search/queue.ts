/**
 * Job-search operator (#192) — ranked queue + remaining daily capacity.
 *
 * Capacity-awareness never lowers the quality bar: this module only
 * decides HOW MANY of the already-QUEUED (score >= 70, policy-gate-clear)
 * candidates to surface/prepare next. It cannot promote a REJECTED or
 * HUMAN_REVIEW candidate into the queue — that gate lives entirely in
 * scoring.ts/policy-gate.ts, upstream of this file.
 */
import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { getJobSearchSettings } from './settings'

export type QueuedCandidate = {
  id: string
  company: string
  title: string
  location: string | null
  fitScore: number | null
  status: string
  applyUrl: string
  postedAt: string | null
}

export async function getRemainingDailyCapacity(): Promise<number> {
  const settings = await getJobSearchSettings()
  const supabase = createServiceClient()
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  const { count, error } = await supabase
    .from('job_search_applications')
    .select('id', { count: 'exact', head: true })
    .gte('prepared_at', todayStart.toISOString())

  if (error) return 0
  const usedToday = count ?? 0
  return Math.max(0, settings.dailyApplicationCap - usedToday)
}

export async function getRankedQueue(limit = 20): Promise<QueuedCandidate[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('job_search_candidates')
    .select('id, company, title, location, fit_score, status, apply_url, posted_at')
    .eq('status', 'QUEUED')
    .order('fit_score', { ascending: false })
    .order('posted_at', { ascending: false })
    .limit(limit)

  if (error || !data) return []
  return data.map((row) => ({
    id: row.id,
    company: row.company,
    title: row.title,
    location: row.location,
    fitScore: row.fit_score,
    status: row.status,
    applyUrl: row.apply_url,
    postedAt: row.posted_at,
  }))
}
