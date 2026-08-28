import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../../types'

interface ExplainRejectionInput {
  company: string
  title_contains?: string
}

/**
 * "Why did you skip this one?" — reads score_explanation/rejection_reasons/
 * hard_block_reason straight off job_search_candidates rather than
 * re-deriving an explanation, so the answer always matches exactly what
 * scoring.ts/policy-gate.ts actually decided (see lib/job-search/scoring.ts).
 */
export const explainJobSearchRejection: Tool<ExplainRejectionInput> = {
  name: 'explain_job_search_rejection',
  description:
    'Explain why a specific job-search candidate was rejected or scored the way it was — company (required) and optionally a title substring to disambiguate multiple roles at the same company.',
  risk: 'read',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      company: { type: 'string', description: 'Company name (or substring) to look up.' },
      title_contains: { type: 'string', description: 'Optional substring to narrow to a specific role title.' },
    },
    required: ['company'],
  },

  async execute(args) {
    const supabase = createServiceClient()
    let query = supabase
      .from('job_search_candidates')
      .select('id, company, title, status, fit_score, score_explanation, rejection_reasons, hard_block_reason')
      .ilike('company', `%${args.company}%`)
      .order('updated_at', { ascending: false })
      .limit(5)

    if (args.title_contains) {
      query = query.ilike('title', `%${args.title_contains}%`)
    }

    const { data, error } = await query
    if (error) return { ok: false, error: error.message }
    if (!data || data.length === 0) return { ok: true, data: { matches: [], note: 'No matching candidate found.' } }

    return { ok: true, data: { matches: data } }
  },
}
