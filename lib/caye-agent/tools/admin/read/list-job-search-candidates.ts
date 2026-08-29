import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../../types'

interface ListJobSearchCandidatesInput {
  limit?: number
  status?: 'DISCOVERED' | 'SCORED' | 'REJECTED' | 'QUEUED' | 'HUMAN_REVIEW'
}

/**
 * Founder observability over the complete scored candidate pool.
 * Unlike list_job_search_queue, this intentionally includes candidates
 * that did not clear the queue threshold so Caye can inspect and explain
 * the quality of a sourcing run before anyone changes scoring policy.
 */
export const listJobSearchCandidates: Tool<ListJobSearchCandidatesInput> = {
  name: 'list_job_search_candidates',
  description:
    'Inspect the best job-search candidates across the entire sourced/scored pool, including rejected and HUMAN_REVIEW roles below the queue threshold. Use this for "show me the closest matches", "show the top jobs from the last run even if they did not qualify", or diagnosing whether sourcing/scoring is too strict.',
  risk: 'read',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum candidates to return, 1-50. Defaults to 20.' },
      status: {
        type: 'string',
        enum: ['DISCOVERED', 'SCORED', 'REJECTED', 'QUEUED', 'HUMAN_REVIEW'],
        description: 'Optional status filter. Omit to inspect the whole candidate pool.',
      },
    },
  },

  async execute(args) {
    const supabase = createServiceClient()
    const limit = Math.max(1, Math.min(50, Math.floor(args.limit ?? 20)))
    let query = supabase
      .from('job_search_candidates')
      .select('id, company, title, location, remote_type, status, fit_score, score_explanation, rejection_reasons, hard_block_reason, apply_url, posted_at, discovered_at, updated_at')
      .not('fit_score', 'is', null)
      .order('fit_score', { ascending: false })
      .order('updated_at', { ascending: false })
      .limit(limit)

    if (args.status) query = query.eq('status', args.status)

    const { data, error } = await query
    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: {
        candidates: data ?? [],
        note: 'These rows are observational only. Being surfaced here does not bypass policy gates or promote a candidate into the application queue.',
      },
    }
  },
}
