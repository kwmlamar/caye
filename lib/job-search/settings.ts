/**
 * Job-search operator (#192) — pause/resume control.
 *
 * job_search_settings is a singleton row (id is always `true`). Paused
 * defaults to true (set by the seed migration) — the founder must
 * explicitly resume after job_search_profiles/resume_variants are
 * populated with real verified data. Pausing only affects the
 * apply/prepare phase (checked by application-executor.ts before it
 * prepares a new application); sourcing/scoring/queue-building keep
 * running while paused since they have no external side effects.
 */
import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { logJobSearchEvent } from './events'

export type JobSearchSettings = {
  paused: boolean
  pausedReason: string | null
  pausedAt: string | null
  dailyApplicationCap: number
  minimumQueueScore: number
}

export async function getJobSearchSettings(): Promise<JobSearchSettings> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('job_search_settings')
    .select('paused, paused_reason, paused_at, daily_application_cap, minimum_queue_score')
    .eq('id', true)
    .maybeSingle()

  if (error || !data) {
    // Fail closed: if settings can't be read, treat the pipeline as paused
    // rather than defaulting to "running."
    return { paused: true, pausedReason: 'settings unreadable — failing closed', pausedAt: null, dailyApplicationCap: 150, minimumQueueScore: 70 }
  }

  return {
    paused: data.paused,
    pausedReason: data.paused_reason,
    pausedAt: data.paused_at,
    dailyApplicationCap: data.daily_application_cap,
    minimumQueueScore: data.minimum_queue_score,
  }
}

export async function setJobSearchPaused(paused: boolean, reason: string, actor: string): Promise<void> {
  const supabase = createServiceClient()
  const { error } = await supabase
    .from('job_search_settings')
    .update({
      paused,
      paused_reason: reason,
      paused_at: paused ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', true)

  if (error) throw new Error(`Could not update job-search settings: ${error.message}`)

  await logJobSearchEvent({
    eventType: 'settings_changed',
    entityType: 'settings',
    payload: { paused, reason },
    createdBy: actor,
  })
}
