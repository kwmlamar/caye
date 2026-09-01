import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../../types'

/**
 * The single highest-leverage read in the response loop: a recruiter who
 * reached out with genuine interest and has no scheduled next step yet is
 * exactly the moment sitting on it costs an interview. See
 * lib/job-search/email-correlation.ts, which sets priority='high' the
 * moment a `recruiter_interest` email correlates.
 */
export const listHighPriorityResponses: Tool<Record<string, never>> = {
  name: 'list_high_priority_responses',
  description:
    'List job applications flagged high-priority because a recruiter reached out with genuine interest and no next step is scheduled yet. Use for "anything urgent in job search" / "what needs my attention" type questions.',
  risk: 'read',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: { type: 'object', properties: {} },

  async execute() {
    try {
      const supabase = createServiceClient()
      const { data, error } = await supabase
        .from('job_search_applications')
        .select('id, status, priority, last_response_at, candidate:job_search_candidates(company,title)')
        .eq('priority', 'high')
        .not('status', 'in', '(REJECTED,OFFER)')
        .order('last_response_at', { ascending: false })
        .limit(25)
      if (error) return { ok: false, error: error.message }

      return {
        ok: true,
        data: (data ?? []).map((row) => {
          const candidate = Array.isArray(row.candidate) ? row.candidate[0] : row.candidate
          return {
            application_id: row.id,
            company: candidate?.company ?? null,
            title: candidate?.title ?? null,
            status: row.status,
            last_response_at: row.last_response_at,
          }
        }),
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not list high-priority responses' }
    }
  },
}
