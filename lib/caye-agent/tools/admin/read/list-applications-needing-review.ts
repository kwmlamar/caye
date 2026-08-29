import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../../types'

/**
 * CAY-194 founder UX: "What applications need me?" — the human-review
 * queue for the real ATS execution layer, distinct from
 * list_job_search_queue (CAY-192, pre-application QUEUED candidates).
 */
export const listApplicationsNeedingReview: Tool<Record<string, never>> = {
  name: 'list_applications_needing_review',
  description:
    'List job-search applications that need the founder\'s attention: NEEDS_HUMAN (with the exact blocker) and SUBMISSION_UNCERTAIN. Call this for "what applications need me" / "what needs my attention" type questions.',
  risk: 'read',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: { type: 'object', properties: {} },

  async execute() {
    try {
      const supabase = createServiceClient()
      const { data, error } = await supabase
        .from('job_search_applications')
        .select('id, status, needs_human_reason, updated_at, candidate_id, job_search_candidates(company, title)')
        .in('status', ['NEEDS_HUMAN', 'SUBMISSION_UNCERTAIN'])
        .order('updated_at', { ascending: false })
        .limit(25)
      if (error) return { ok: false, error: error.message }

      const items = (data ?? []).map((row) => {
        const candidate = (row as unknown as { job_search_candidates: { company: string; title: string } | null }).job_search_candidates
        return {
          application_id: row.id,
          status: row.status,
          reason: row.needs_human_reason,
          company: candidate?.company ?? null,
          title: candidate?.title ?? null,
          updated_at: row.updated_at,
        }
      })
      return { ok: true, data: { count: items.length, items } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not read applications needing review' }
    }
  },
}
