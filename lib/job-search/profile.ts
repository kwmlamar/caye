/**
 * Job-search operator (#192) — founder profile + canonical answer reads.
 *
 * Centralizes founder-specific facts behind this module rather than
 * scattering them through prompts or per-tool queries, per the dispatch's
 * explicit architecture requirement. Writes to job_search_profile_facts go
 * through job_search_write_profile_fact() (the atomic RPC defined in the
 * migration) so concurrent corrections chain safely — see the migration's
 * doc comment and write_business_fact_atomic, which this mirrors.
 */
import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { ProfileFactCategory, ProfileFactRow } from './types'

export type JobSearchProfile = {
  id: string
  status: 'needs_verification' | 'verified'
  fullName: string | null
  headline: string | null
  summary: string | null
  education: unknown[]
  skills: string[]
  experience: unknown[]
  links: Record<string, string | null>
  workAuthorization: Record<string, unknown>
  locationPreferences: Record<string, unknown>
  targetTitles: string[]
}

export async function getActiveProfile(): Promise<JobSearchProfile | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('job_search_profiles')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error || !data) return null

  return {
    id: data.id,
    status: data.status,
    fullName: data.full_name,
    headline: data.headline,
    summary: data.summary,
    education: Array.isArray(data.education) ? data.education : [],
    skills: Array.isArray(data.skills) ? data.skills : [],
    experience: Array.isArray(data.experience) ? data.experience : [],
    links: data.links ?? {},
    workAuthorization: data.work_authorization ?? {},
    locationPreferences: data.location_preferences ?? {},
    targetTitles: Array.isArray(data.target_titles) ? data.target_titles : [],
  }
}

export async function getActiveFacts(profileId: string): Promise<ProfileFactRow[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('job_search_profile_facts')
    .select('*')
    .eq('profile_id', profileId)
    .is('superseded_at', null)

  if (error || !data) return []
  return data as ProfileFactRow[]
}

export async function findFactByCanonicalKey(profileId: string, canonicalKey: string): Promise<ProfileFactRow | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('job_search_profile_facts')
    .select('*')
    .eq('profile_id', profileId)
    .eq('canonical_key', canonicalKey)
    .is('superseded_at', null)
    .maybeSingle()

  if (error || !data) return null
  return data as ProfileFactRow
}

/**
 * Writes a canonical fact via the atomic RPC. `source: 'founder-direct'` is
 * required for every category in HIGH_RISK_ANSWER_CATEGORIES — callers
 * must never write 'inferred' for those (this is enforced at the call
 * sites that gather answers, e.g. application-executor.ts, not here, since
 * this is a thin RPC wrapper and the categories differ by call site).
 */
export async function writeProfileFact(params: {
  profileId: string
  canonicalKey: string
  category: ProfileFactCategory
  question: string
  answer: string
  source: 'founder-direct' | 'resume-derived' | 'inferred'
  createdBy?: string
}): Promise<{ id: string; supersededId: string | null }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase.rpc('job_search_write_profile_fact', {
    p_profile_id: params.profileId,
    p_canonical_key: params.canonicalKey,
    p_category: params.category,
    p_question: params.question,
    p_answer: params.answer,
    p_source: params.source,
    p_created_by: params.createdBy ?? null,
  })

  if (error || !data || data.length === 0) {
    throw new Error(`Could not write profile fact: ${error?.message ?? 'no row returned'}`)
  }

  const row = data[0] as { id: string; superseded_id: string | null }
  return { id: row.id, supersededId: row.superseded_id }
}
